import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DAY_MS,
  SWEEP_NOW,
  expectJsonContentType,
  expectMaskedKey,
  expectNoStore,
  expectSecurityHeaders,
  failedCycle,
  seedCycles,
  startComposedApi,
  successfulCycle,
  sweepIso,
  withComposedApi,
  type ComposedApi,
  type StartedComposedApi,
} from '../helpers/composedApi';

/**
 * Task 164's cross-endpoint contract sweep (spec §13, §17.1): every
 * endpoint of §13's route table answered through the PRODUCTION
 * composition — `composeApplication` over a real temp `config.json`, a
 * real migrated `node:sqlite` database, and the real `/api` scope with
 * all its guards — through `fastify.inject`. Each per-family suite
 * already pins its own route's domain contract against store doubles;
 * this suite proves the families answer TOGETHER, wired exactly as
 * `runServer` wires them, with the §13/§15 cross-cutting invariants on
 * every response: the JSON transport, §15.5's header set, and the
 * §13 status codes of the happy path.
 *
 * Order independence (the testing rule): the shared lifecycle serves
 * ONLY read-only requests; every mutating test (create, patch, archive,
 * connection test, settings PUT) runs its own lifecycle so no test can
 * read state another test wrote. The §13 table's auth rows
 * (`/api/auth/login`, `/api/auth/logout`, `/api/auth/session`) are the
 * recorded plan gap (U-041, decisions D-125/D-126): pinned here at
 * today's boundary — the scope catch-all's 404 envelope once the §15.3
 * mutation legs pass, exactly like every other unbuilt path.
 */

/** The §15.4 marker key the seed account stores (never a response body). */
const MARKER_FILE_KEY = 'sk-sweep-file-key-3d1f8a';

/** A second account id: the §11.2 history lives on it. */
const HIST = 'hist';

/** The read-only shared lifecycle (its assertions never see mutations). */
let api: ComposedApi;
let teardown: StartedComposedApi | undefined;

beforeAll(async () => {
  teardown = await startComposedApi({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        {
          id: 'seed',
          providerId: 'zai-coding-plan',
          label: 'Seed account',
          apiKey: MARKER_FILE_KEY,
        },
        { id: HIST, providerId: 'zai-coding-plan', label: 'History account' },
      ],
    },
    seed: (repository) => {
      seedCycles(repository, [
        successfulCycle(HIST, SWEEP_NOW - 3 * DAY_MS),
        successfulCycle(HIST, SWEEP_NOW - 3 * DAY_MS + 300_000),
        failedCycle(HIST, SWEEP_NOW - 3 * DAY_MS + 600_000, 'provider unreachable (sweep seed)'),
      ]);
    },
  });
  api = teardown;
}, 30_000);

afterAll(async () => {
  // Undefined when beforeAll failed before the assignment — nothing started.
  await teardown?.stop();
});

/** The shared §13 range `[now - 4d, now]` as ISO request parameters. */
const FROM = sweepIso(SWEEP_NOW - 4 * DAY_MS);
const TO = sweepIso(SWEEP_NOW);

/** The seed configuration the mutating tests rebuild per lifecycle. */
function seededConfig(): unknown {
  return {
    app: { timezone: 'UTC' },
    accounts: [
      {
        id: 'seed',
        providerId: 'zai-coding-plan',
        label: 'Seed account',
        apiKey: MARKER_FILE_KEY,
      },
    ],
  };
}

describe('the §13 endpoint inventory through the production composition', () => {
  it('answers the public health route with the byte-exact literal (§13)', async () => {
    const response = await api.call('GET', '/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
    expectJsonContentType(response, 'health');
  });

  it('answers GET /api/status with the service state and per-account rows', async () => {
    const response = await api.call('GET', '/api/status');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      pollingIntervalSeconds: number;
      accounts: Array<{ id: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.pollingIntervalSeconds).toBe(300);
    expect(body.accounts.map((account) => account.id)).toEqual(['hist', 'seed']);
  });

  it('answers GET /api/providers with the registry listing and null schedules', async () => {
    const response = await api.call('GET', '/api/providers');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        {
          id: 'zai-coding-plan',
          name: 'Z.ai Coding Plan (sweep double)',
          peakHours: null,
          metrics: [{ metricKey: 'sweep-monthly', label: 'Sweep monthly quota' }],
        },
      ],
    });
  });

  it('answers GET /api/accounts with the merged view and the constant mask (§13)', async () => {
    const response = await api.call('GET', '/api/accounts');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts).toHaveLength(2);
    const byId = new Map(body.accounts.map((view) => [view.id as string, view]));
    expectMaskedKey(byId.get('seed')!, true);
    expectMaskedKey(byId.get(HIST)!, false);
    expect(response.body).not.toContain(MARKER_FILE_KEY);
  });

  it(
    'answers POST /api/accounts with 201, the created view, and no key echo (write-only)',
    { timeout: 10_000 },
    async () => {
      await withComposedApi({ config: seededConfig() }, async (own) => {
        const response = await own.call('POST', '/api/accounts', {
          providerId: 'zai-coding-plan',
          label: 'Sweep created',
          id: 'sweep-created',
          apiKey: MARKER_FILE_KEY,
        });
        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({
          id: 'sweep-created',
          label: 'Sweep created',
          hasKey: true,
        });
        expect(response.body).not.toContain(MARKER_FILE_KEY);
        expectJsonContentType(response, 'create');
      });
    },
  );

  it(
    'answers PATCH /api/accounts/:id with 200 and the updated view',
    { timeout: 10_000 },
    async () => {
      await withComposedApi({ config: seededConfig() }, async (own) => {
        const response = await own.call('PATCH', '/api/accounts/seed', { label: 'After rename' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: 'seed', label: 'After rename' });
      });
    },
  );

  it(
    'answers DELETE /api/accounts/:id with 200 and the archive outcome',
    { timeout: 10_000 },
    async () => {
      await withComposedApi({ config: seededConfig() }, async (own) => {
        const response = await own.call('DELETE', '/api/accounts/seed');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          result: 'archived',
          account: { id: 'seed', status: 'archived' },
        });
      });
    },
  );

  it(
    'answers POST /api/accounts/:id/test with 200 and the ok outcome',
    { timeout: 10_000 },
    async () => {
      await withComposedApi({ config: seededConfig() }, async (own) => {
        const response = await own.call('POST', '/api/accounts/seed/test');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ outcome: 'ok' });
      });
    },
  );

  it('answers GET /api/quota with the last-valid metric rows for the account', async () => {
    const response = await api.call('GET', `/api/quota?accountId=${HIST}`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { accountId: string; metrics: Array<{ metricKey: string }> };
    expect(body.accountId).toBe(HIST);
    expect(body.metrics.map((metric) => metric.metricKey)).toEqual(['sweep-monthly']);
  });

  it('answers GET /api/history with the seeded series points and the range report', async () => {
    const response = await api.call(
      'GET',
      `/api/history?accountId=${HIST}&metric=sweep-monthly&from=${FROM}&to=${TO}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { accountId: string; metric: string; points: unknown[] };
    expect(body.accountId).toBe(HIST);
    expect(body.metric).toBe('sweep-monthly');
    expect(body.points.length).toBeGreaterThanOrEqual(2);
  });

  it('answers GET /api/events with the failed cycle on the unified timeline', async () => {
    const response = await api.call('GET', `/api/events?accountId=${HIST}&from=${FROM}&to=${TO}`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { accountId: string; events: Array<{ kind: string }> };
    expect(body.accountId).toBe(HIST);
    expect(body.events.map((event) => event.kind)).toContain('collection_error');
  });

  it('answers GET /api/peak-hours with the no-schedule arm for an unconfigured provider', async () => {
    const response = await api.call('GET', `/api/peak-hours?accountId=seed&from=${FROM}&to=${TO}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId: 'seed',
      providerId: 'zai-coding-plan',
      timezone: null,
      intervals: [],
    });
  });

  it('answers GET /api/settings with the annotated view and the real paths', async () => {
    const response = await api.call('GET', '/api/settings');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      settings: Record<string, unknown>;
      paths: Record<string, string>;
    };
    expect(body.paths).toEqual({ configPath: api.configPath, dataDir: api.dataDir });
    expect(body.settings.app).toMatchObject({
      timezone: { value: 'UTC', source: 'file' },
    });
  });

  it(
    'answers PUT /api/settings with the applied/restart outcome (§6.4 vocabulary)',
    { timeout: 10_000 },
    async () => {
      await withComposedApi({ config: seededConfig() }, async (own) => {
        const response = await own.call('PUT', '/api/settings', {
          app: { pollingIntervalSeconds: 600 },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          applied: ['app.pollingIntervalSeconds'],
          restartRequired: [],
        });
      });
    },
  );

  it('carries §15.5 headers and the JSON transport on every endpoint response', async () => {
    const responses: Array<[string, Awaited<ReturnType<ComposedApi['call']>>]> = [
      ['health', await api.call('GET', '/api/health')],
      ['status', await api.call('GET', '/api/status')],
      ['providers', await api.call('GET', '/api/providers')],
      ['accounts', await api.call('GET', '/api/accounts')],
      ['quota', await api.call('GET', `/api/quota?accountId=${HIST}`)],
      [
        'history',
        await api.call(
          'GET',
          `/api/history?accountId=${HIST}&metric=sweep-monthly&from=${FROM}&to=${TO}`,
        ),
      ],
      ['events', await api.call('GET', `/api/events?accountId=${HIST}&from=${FROM}&to=${TO}`)],
      ['peak-hours', await api.call('GET', `/api/peak-hours?accountId=seed&from=${FROM}&to=${TO}`)],
      ['settings', await api.call('GET', '/api/settings')],
    ];
    expect(responses.length).toBe(9);
    for (const [label, response] of responses) {
      expectSecurityHeaders(response, label);
      expectNoStore(response, label);
      expectJsonContentType(response, label);
    }
  });

  it('serves the landed §13 auth endpoints through the composition — the U-041 boundary, updated', async () => {
    // U-041 landed `POST /api/auth/login` and `POST /auth/logout` behind
    // `ApiRoutesOptions.authRoutes` and the composition wires them: this
    // composition carries no password, so D-122's totality guard answers
    // every login attempt with the registry-default UNAUTHENTICATED 401
    // (the D-134 notice signal), and a cookieless logout under the
    // not-required §15.1 mode reaches the idempotent handler (`revoked:
    // false`, D-126's clear twin still set). U-055 (D-182) completed the
    // family with the public session reader: this auto/loopback/no-proxy
    // composition answers its honest mode with no cookie to judge.
    const login = await api.call('POST', '/api/auth/login', { password: 'not-built-yet-123' });
    expect(login.statusCode).toBe(401);
    expect(login.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const logout = await api.call('POST', '/api/auth/logout');
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toMatchObject({ revoked: false });

    // A safe method needs no mutation legs at all — and the third §13 auth
    // operation now exists: the reader answers the composition's §15.1
    // verdict with nothing authenticated.
    const session = await api.probe('GET', '/api/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ mode: 'not-required', authenticated: false });
  });
});
