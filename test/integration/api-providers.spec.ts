import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import { apiErrorHandler } from '../../src/server/api/error';
import { ProviderRegistry, type QuotaProvider } from '../../src/providers/registry';
import type { PeakHoursConfig, ProvidersConfig } from '../../src/schemas/config';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink } from '../helpers/logSink';

/**
 * The §13 providers endpoint on the wire (task 160, spec §13, §9.2; decision
 * D-130): the registry listing joined with the live configuration's
 * schedules, through the real `/api` scope — the three landed guards
 * included — against a real `ProviderRegistry` carrying test doubles. The
 * schedule half is exercised through a mutable reader: the per-request seam
 * exists because §6.4 makes the schedules live (a reload swaps them), and
 * the wire pin proves a reload-shaped change is visible on the next call.
 */

/** The §15.3 dedicated mutation header (task 150, D-117). */
const MUTATION_HEADER = { 'x-quotameter-request': 'test-client' } as const;

/** A registry double entry — §8.1's contract surface, unimplemented bodies. */
function providerDouble(id: string, name: string): QuotaProvider {
  return {
    id,
    name,
    async validateCredentials(): Promise<void> {
      throw new Error('not under test in this suite');
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('not under test in this suite');
    },
  };
}

/** A double that declares the D-137 static metric catalog. */
function catalogDouble(id: string, name: string): QuotaProvider {
  return {
    ...providerDouble(id, name),
    metricCatalog: [
      { metricKey: 'tokens-5h', label: '5-hour token quota' },
      { metricKey: 'weekly-quota', label: 'Weekly quota' },
    ],
  };
}

/** The spec's own §9.2 sample schedule. */
const ZAI_SCHEDULE: PeakHoursConfig = {
  timezone: 'Asia/Singapore',
  offPeakMultiplier: 0.5,
  windows: [
    {
      id: 'zai-weekday-peak',
      name: 'Z.ai Coding Plan peak hours',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '14:00',
      end: '18:00',
      multiplier: 1,
    },
  ],
};

interface Harness {
  app: FastifyInstance;
  readonly registry: ProviderRegistry;
  /** The mutable schedule table — §6.4-live, read per request. */
  schedules: ProvidersConfig;
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
}

async function withProvidersApi(
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const registry = new ProviderRegistry();
  registry.register(providerDouble('zai-coding-plan', 'Z.ai Coding Plan'));
  const harness: Harness = {
    app: undefined as unknown as Harness['app'],
    registry,
    schedules: {
      'zai-coding-plan': { peakHours: ZAI_SCHEDULE, requestTimeoutSeconds: 15 },
    },
  };
  const app = Fastify({
    loggerInstance: createLogger({
      level: 'warn',
      destination: createMemoryLogSink(),
    }).pino as FastifyBaseLogger,
  });
  harness.app = app;
  app.setErrorHandler(apiErrorHandler);
  await app.register(apiRoutes, {
    prefix: '/api',
    auth: options.auth ?? { mode: 'auto', bindHost: '127.0.0.1' },
    providers: { registry, schedules: () => harness.schedules },
  });
  try {
    await body(harness);
  } finally {
    await app.close();
  }
}

describe('GET /api/providers — available types and read-only schedules (§13/§9.2)', () => {
  it('answers the populated registry with the configured schedule, §15.5 no-store', async () => {
    await withProvidersApi(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        providers: [
          // The double declares no metric catalog: the honest empty
          // array, never invented labels (D-137).
          {
            id: 'zai-coding-plan',
            name: 'Z.ai Coding Plan',
            peakHours: ZAI_SCHEDULE,
            metrics: [],
          },
        ],
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    });
  });

  it('serves a declared metric catalog verbatim (D-137)', async () => {
    const app = Fastify({
      loggerInstance: createLogger({
        level: 'warn',
        destination: createMemoryLogSink(),
      }).pino as FastifyBaseLogger,
    });
    app.setErrorHandler(apiErrorHandler);
    const registry = new ProviderRegistry();
    registry.register(catalogDouble('zai-coding-plan', 'Z.ai Coding Plan'));
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: { mode: 'auto', bindHost: '127.0.0.1' },
      providers: { registry, schedules: () => ({}) },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { providers: Array<{ metrics: unknown }> }).providers[0]).toEqual({
        id: 'zai-coding-plan',
        name: 'Z.ai Coding Plan',
        peakHours: null,
        metrics: [
          { metricKey: 'tokens-5h', label: '5-hour token quota' },
          { metricKey: 'weekly-quota', label: 'Weekly quota' },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('answers an empty registry with an empty list', async () => {
    const app = Fastify({
      loggerInstance: createLogger({
        level: 'warn',
        destination: createMemoryLogSink(),
      }).pino as FastifyBaseLogger,
    });
    app.setErrorHandler(apiErrorHandler);
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: { mode: 'auto', bindHost: '127.0.0.1' },
      providers: { registry: new ProviderRegistry(), schedules: () => ({}) },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ providers: [] });
    } finally {
      await app.close();
    }
  });

  it('answers peakHours null when no schedule is configured — never an invented one', async () => {
    await withProvidersApi(async ({ app, schedules }) => {
      schedules['zai-coding-plan'] = { peakHours: { timezone: 'UTC', windows: [] } };
      const first = await app.inject({ method: 'GET', url: '/api/providers' });
      // The serializer materializes the config contract's own defaults
      // (offPeakMultiplier 1) — the effective configuration's value, the
      // same one the parser applies at load.
      expect(
        (first.json() as { providers: Array<{ peakHours: unknown }> }).providers[0]?.peakHours,
      ).toEqual({
        timezone: 'UTC',
        windows: [],
        offPeakMultiplier: 1,
      });
      delete schedules['zai-coding-plan'];
      const second = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(
        (second.json() as { providers: Array<{ peakHours: unknown }> }).providers[0]?.peakHours,
      ).toBeNull();
    });
  });

  it('does not list schedule-only providers — the registry defines availability', async () => {
    await withProvidersApi(async ({ app, schedules }) => {
      schedules['ghost-plan'] = { peakHours: { timezone: 'UTC', windows: [] } };
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      const providers = (response.json() as { providers: Array<{ id: string }> }).providers;
      expect(providers.map((provider) => provider.id)).toEqual(['zai-coding-plan']);
    });
  });

  it('reads the schedule table per request — a §6.4 live change is visible immediately', async () => {
    await withProvidersApi(async ({ app, schedules }) => {
      schedules['zai-coding-plan'] = { peakHours: { timezone: 'Europe/Berlin', windows: [] } };
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(
        (response.json() as { providers: Array<{ peakHours: unknown }> }).providers[0]?.peakHours,
      ).toEqual({ timezone: 'Europe/Berlin', windows: [], offPeakMultiplier: 1 });
    });
  });

  it('keeps the route GET-only — other methods answer the §13 envelope', async () => {
    await withProvidersApi(async ({ app }) => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/providers',
        headers: MUTATION_HEADER,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });
  });
});

describe('the providers route behind the §15.1 auth-mode guard', () => {
  const REQUIRED_WITH_PASSWORD: AuthModeGuardOptions = {
    mode: 'required',
    bindHost: '127.0.0.1',
    passwordConfigured: () => true,
  };

  it('required mode with the fail-closed seam rejects the endpoint with 401', async () => {
    await withProvidersApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/providers' });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
            details: { reason: 'authentication-required' },
          },
        });
      },
      { auth: REQUIRED_WITH_PASSWORD },
    );
  });

  it('a succeeding seam composes, and a proxied passwordless request is refused', async () => {
    await withProvidersApi(
      async ({ app }) => {
        const authenticated = await app.inject({ method: 'GET', url: '/api/providers' });
        expect(authenticated.statusCode).toBe(200);
      },
      { auth: { ...REQUIRED_WITH_PASSWORD, isAuthenticated: () => true } },
    );
    await withProvidersApi(async ({ app }) => {
      const proxied = await app.inject({
        method: 'GET',
        url: '/api/providers',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(proxied.statusCode).toBe(403);
      expect(proxied.json()).toMatchObject({
        error: { details: { reason: 'proxy-without-password' } },
      });
    });
  });
});

describe('the task-146 construction without providers dependencies', () => {
  it('answers /api/providers with the scope catch-all 404 envelope — no half-wired surface', async () => {
    const app = Fastify({
      loggerInstance: createLogger({
        level: 'warn',
        destination: createMemoryLogSink(),
      }).pino as FastifyBaseLogger,
    });
    app.setErrorHandler(apiErrorHandler);
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: { mode: 'auto', bindHost: '127.0.0.1' },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method: 'GET', path: '/api/providers' },
        },
      });
    } finally {
      await app.close();
    }
  });
});
