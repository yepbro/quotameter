import { mkdir, readFile } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { expect } from 'vitest';
import { QuotameterApp } from '../../src/server/app';
import { composeApplication } from '../../src/server/composition';
import type { ComposedApplication } from '../../src/server/composition';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import { persistCollectionCycle } from '../../src/storage/collection-cycles';
import type { CollectionCycleWrite, CycleMetricInput } from '../../src/storage/collection-cycles';
import type { QuotaRepository } from '../../src/storage/repository';
import type { QuotaProvider } from '../../src/providers/registry';
import { CredentialsRejectedError } from '../../src/providers/zai-coding-plan/validate';
import type { ApiErrorCode } from '../../src/schemas/api/error';
import { isApiErrorCode } from '../../src/schemas/api/error';
import { ACCOUNT_KEY_MASK } from '../../src/schemas/api/accounts';
import { createFixedClock } from '../../src/util/clock';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from './logSink';
import { createTempDir } from './isolation';

/**
 * The task-164 cross-endpoint harness: the PRODUCTION composition
 * (`composeApplication`, decision D-140 — the same construction
 * `runServer` assembles through `buildApplication()`) over fresh temp
 * directories, so every sweep spec drives the real `/api` scope, the
 * real guards, the real config file, and a real migrated `node:sqlite`
 * database through `fastify.inject`. The only double is the provider
 * adapter — the external boundary the no-network guard requires tests
 * to own, registered through the production observation wrapper the
 * composition itself applies (the composition.spec pattern).
 *
 * Beside the lifecycle, this module owns the three assertion helpers
 * every sweep reuses — the §13 error-envelope shape, the §15.5 header
 * set, and the mutation-leg request defaults — and the §11.2 history
 * seeding helpers (through the real write path, `persistCollectionCycle`,
 * per the testing conventions).
 */

/** Deterministic §11.1 epoch base: 2026-11-04T10:00:00Z (a Wednesday). */
export const SWEEP_NOW = Date.UTC(2026, 10, 4, 10, 0, 0);

/** One day of absolute time. */
export const DAY_MS = 86_400_000;

/** The §15.3 dedicated mutation header (task 150, D-117). */
export const MUTATION_HEADERS = { 'x-quotameter-request': 'sweep-client' } as const;

/** The full legitimate mutation header set for a bodied request. */
export const JSON_MUTATION_HEADERS = {
  ...MUTATION_HEADERS,
  'content-type': 'application/json',
} as const;

/**
 * The exact §15.5 CSP byte string (D-127) — the same literal
 * `security-headers.spec.ts` pins; the sweeps assert it on every
 * endpoint's responses, so the value must not drift from the pinned one.
 */
export const CSP_WIRE_VALUE =
  "default-src 'none';" +
  "script-src 'self';" +
  "style-src 'self';" +
  "img-src 'self';" +
  "font-src 'self';" +
  "connect-src 'self';" +
  "base-uri 'none';" +
  "form-action 'none';" +
  "frame-ancestors 'none';" +
  "object-src 'none'";

/* ── The provider double (the external boundary) ───────────────────────── */

/** What the seeded double does with the next credential check. */
export type ProviderDoubleMode = 'ok' | 'rejected';

/**
 * A `zai-coding-plan` test double: `validateCredentials` follows
 * {@link ProviderDoubleMode.mode} (the accounts-test endpoint's outcome
 * vocabulary depends on it); `fetchSnapshot` is never reached by any
 * route (history is seeded through the repository directly).
 */
export function providerDouble(options: { mode?: ProviderDoubleMode } = {}): QuotaProvider {
  const mode = options.mode ?? 'ok';
  return {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan (sweep double)',
    metricCatalog: [{ metricKey: 'sweep-monthly', label: 'Sweep monthly quota' }],
    async validateCredentials(): Promise<void> {
      if (mode === 'rejected') throw new CredentialsRejectedError(401);
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not under test in the sweep suites');
    },
  };
}

/* ── The lifecycle harness ─────────────────────────────────────────────── */

/** What {@link withComposedApi} hands the caller. */
export interface ComposedApi {
  readonly composed: ComposedApplication;
  /** The §16 log sink — every sweep scans it for markers. */
  readonly sink: MemoryLogSink;
  readonly configPath: string;
  readonly dataDir: string;
  /** The temp root — error messages must never contain it (§13). */
  readonly tempRoot: string;
  /**
   * The legitimate client: a mutation gains the §15.3 dedicated header,
   * a bodied request gains the JSON content type; caller headers win.
   */
  call(
    method: string,
    url: string,
    payload?: string | Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<SweepResponse>;
  /** Exact-headers injection — the guard-violation shape, no defaults. */
  probe(
    method: string,
    url: string,
    payload?: string | Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<SweepResponse>;
}

/** Options of {@link withComposedApi}. */
export interface ComposedApiOptions {
  /** The configuration file's JSON content (written through the atomic writer). */
  readonly config: unknown;
  /** Extra environment beside the directory overrides. */
  readonly env?: Readonly<Record<string, string>>;
  readonly provider?: QuotaProvider;
  /** Mutations to seed through the repository before the body runs. */
  readonly seed?: (repository: QuotaRepository) => void;
}

/** The injected-response surface the sweep assertions read. */
export interface SweepResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: OutgoingHttpHeaders;
  json(): unknown;
}

/** What a started harness adds: the teardown of the §5.6 lifecycle. */
export interface StartedComposedApi extends ComposedApi {
  stop(): Promise<void>;
}

/**
 * The startup secret values the composition itself would register when no
 * logger is injected (`composeApplication`'s `startupSecrets` arm — §15.4
 * defense-in-depth). The harness must inject a logger to capture records
 * in a sink, which bypasses that arm, so it mirrors the registration from
 * the same inputs (the configuration's accounts and the environment) —
 * keep the two in step when either changes.
 */
function startupSecretValuesOf(config: unknown, env: Readonly<Record<string, string>>): string[] {
  const accounts = (config as { accounts?: Array<Record<string, unknown>> }).accounts ?? [];
  const secrets: string[] = [];
  for (const account of accounts) {
    const apiKey = account.apiKey;
    if (typeof apiKey === 'string') secrets.push(apiKey);
    const apiKeyEnv = account.apiKeyEnv;
    if (typeof apiKeyEnv === 'string') {
      const value = env[apiKeyEnv];
      if (typeof value === 'string' && value !== '') secrets.push(value);
    }
  }
  return secrets;
}

/**
 * Composes and starts the production application over fresh temp
 * directories, leaving it running until the caller calls `stop` — the
 * `beforeAll`/`afterAll` shape for suites that share one lifecycle
 * across order-independent tests. A failure anywhere after the temp
 * directory exists cleans up after itself (best-effort app stop, then
 * directory removal) so a failed `beforeAll` leaks nothing.
 */
export async function startComposedApi(options: ComposedApiOptions): Promise<StartedComposedApi> {
  const dir = await createTempDir('sweep-api-');
  let app: QuotameterApp | undefined;
  try {
    const configDir = join(dir.path, 'config');
    const dataDir = join(dir.path, 'data');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const configPath = configFilePath(configDir);
    await writeConfigFile(configPath, options.config);

    const env = {
      QUOTAMETER_CONFIG_DIR: configDir,
      QUOTAMETER_DATA_DIR: dataDir,
      ...options.env,
    };
    const sink = createMemoryLogSink();
    const composed = await composeApplication({
      env,
      clock: createFixedClock(SWEEP_NOW),
      // 'info' captures lifecycle records the marker scans must cover; the
      // startup keys join the known-secret list exactly as the production
      // logger construction would register them (see above).
      logger: createLogger({
        level: 'info',
        destination: sink,
        secrets: startupSecretValuesOf(options.config, options.env ?? {}),
      }),
      providers: [options.provider ?? providerDouble()],
      port: 0,
    });
    app = new QuotameterApp({ components: composed.components });
    await app.start();
    options.seed?.(composed.repository);
    const inject = (
      defaults: boolean,
      method: string,
      url: string,
      payload?: string | Record<string, unknown>,
      headers?: Record<string, string>,
    ): Promise<SweepResponse> => {
      const merged: Record<string, string> = { ...(headers ?? {}) };
      if (defaults) {
        if (payload !== undefined && merged['content-type'] === undefined) {
          merged['content-type'] = 'application/json';
        }
        if (method !== 'GET' && method !== 'HEAD' && merged['x-quotameter-request'] === undefined) {
          merged['x-quotameter-request'] = 'sweep-client';
        }
      }
      return composed.httpServer.server.inject({
        method,
        url,
        headers: merged,
        ...(payload === undefined ? {} : { payload }),
      });
    };
    return {
      composed,
      sink,
      configPath,
      dataDir,
      tempRoot: dir.path,
      call: (method, url, payload, headers) => inject(true, method, url, payload, headers),
      probe: (method, url, payload, headers) => inject(false, method, url, payload, headers),
      async stop(): Promise<void> {
        try {
          await app!.stop();
        } finally {
          await dir.remove();
        }
      },
    };
  } catch (error) {
    // A failed composition/start must not leak the temp directory or a
    // half-started app (the caller has no teardown handle yet).
    await app?.stop().catch(() => undefined);
    await dir.remove();
    throw error;
  }
}

/**
 * Composes, starts, runs the body, and stops the production application
 * over fresh temp directories — one full §5.6 lifecycle per call.
 */
export async function withComposedApi(
  options: ComposedApiOptions,
  body: (api: ComposedApi) => Promise<void>,
): Promise<void> {
  const api = await startComposedApi(options);
  try {
    await body(api);
  } finally {
    await api.stop();
  }
}

/** Reads the current config file as parsed JSON. */
export async function readConfigJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/* ── History seeding through the real write path ───────────────────────── */

/** The one metric every seeded cycle carries (`sweep-monthly`). */
const SEEDED_METRIC: CycleMetricInput = {
  metricKey: 'sweep-monthly',
  limitType: 'MONTHLY',
  unit: 'CREDITS',
  windowSeconds: null,
  used: 40,
  remaining: 60,
  limit: 100,
  percentUsed: 40,
  percentRemaining: 60,
  resetsAt: SWEEP_NOW + DAY_MS,
  isValid: true,
  invalidReason: null,
  derivedFields: null,
};

/** A successful cycle with the seeded metric — the base seeding shape. */
export function successfulCycle(
  accountId: string,
  startedAt: number,
  overrides: { planName?: string } = {},
): CollectionCycleWrite {
  return {
    accountId,
    startedAt,
    endedAt: startedAt + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt: startedAt + 1_200,
      planName: overrides.planName ?? 'Sweep Pro',
      metrics: [SEEDED_METRIC],
      events: [],
    },
  };
}

/** A failed cycle carrying `errorMessage` — the §12.2 failure evidence. */
export function failedCycle(
  accountId: string,
  startedAt: number,
  errorMessage: string,
): CollectionCycleWrite {
  return {
    accountId,
    startedAt,
    endedAt: startedAt + 1_200,
    intervalSeconds: 300,
    attempts: 2,
    httpStatus: 503,
    outcome: 'server_error',
    errorMessage,
    retryAfterSeconds: null,
  };
}

/** Persists the given cycles through the real write path, in order. */
export function seedCycles(
  repository: QuotaRepository,
  cycles: readonly CollectionCycleWrite[],
): void {
  for (const cycle of cycles) persistCollectionCycle(repository, cycle);
}

/* ── The shared sweep assertions ───────────────────────────────────────── */

/**
 * Asserts the full §13 error envelope on a response: the closed
 * `{error: {code, message, details}}` shape (exactly those keys, no
 * more), a registry code matching `expected.code`, the matching HTTP
 * status, a non-empty message, and — when `expected.reason` is given —
 * the stable `details.reason` value. `forbidden` strings (markers, the
 * temp root) must appear nowhere in the serialized body (§13/§15.4).
 * `label` names the case in assertion messages (loop failure reporting).
 */
export function expectApiError(
  response: SweepResponse,
  expected: { status: number; code: ApiErrorCode; reason?: string },
  forbidden: readonly string[] = [],
  label = '',
): void {
  const name = label === '' ? `${expected.code}` : `${label} (${expected.code})`;
  expect(response.statusCode, `${name} status`).toBe(expected.status);
  const body = response.json() as { error: Record<string, unknown> };
  expect(Object.keys(body), `${name}: the envelope is the only root key`).toEqual(['error']);
  expect(Object.keys(body.error!).sort(), `${name}: the envelope error keys`).toEqual([
    'code',
    'details',
    'message',
  ]);
  expect(body.error!.code, `${name}: registry code`).toBe(expected.code);
  expect(isApiErrorCode(body.error!.code as string), `${name}: code is a registry member`).toBe(
    true,
  );
  expect(typeof body.error!.message, `${name}: message is a string`).toBe('string');
  expect((body.error!.message as string).length, `${name}: message is non-empty`).toBeGreaterThan(
    0,
  );
  expect('details' in body.error!, `${name}: the details key is always present`).toBe(true);
  if (expected.reason !== undefined) {
    expect(body.error!.details, `${name}: details.reason`).toMatchObject({
      reason: expected.reason,
    });
  }
  for (const marker of forbidden) {
    expect(response.body, `${name}: body must not contain ${marker}`).not.toContain(marker);
  }
}

/**
 * Asserts the three positive §15.5 header values (D-127's exact CSP
 * byte string, nosniff, no-referrer). The complete header-name allowlist
 * tripwire (every unlisted helmet header asserted absent) stays with
 * `security-headers.spec.ts`, which owns that pin on representative
 * responses.
 */
export function expectSecurityHeaders(response: SweepResponse, label = ''): void {
  expect(response.headers['content-security-policy'], `${label} CSP`).toBe(CSP_WIRE_VALUE);
  expect(response.headers['x-content-type-options'], `${label} nosniff`).toBe('nosniff');
  expect(response.headers['referrer-policy'], `${label} no-referrer`).toBe('no-referrer');
}

/** Asserts §15.5's API-only cache rule on a response. */
export function expectNoStore(response: SweepResponse, label = ''): void {
  expect(response.headers['cache-control'], `${label} no-store`).toBe('no-store');
}

/** Asserts the JSON transport content type on a response. */
export function expectJsonContentType(response: SweepResponse, label = ''): void {
  expect(response.headers['content-type'], `${label} content-type`).toBe(
    'application/json; charset=utf-8',
  );
}

/**
 * Asserts §13's key-masking pair on one account view: the constant
 * content-free mask when a key is configured, `null` when none is, and
 * the boolean — never the key itself.
 */
export function expectMaskedKey(view: Record<string, unknown>, hasKey: boolean): void {
  expect(view.hasKey).toBe(hasKey);
  expect(view.keyMask).toBe(hasKey ? ACCOUNT_KEY_MASK : null);
}

/** `t` as the §13 ISO-8601 UTC request parameter (the D-139 request half). */
export function sweepIso(t: number): string {
  return new Date(t).toISOString();
}

/**
 * A JSON body of exactly `bytes` ASCII bytes: one unknown `pad` field,
 * sized so the serialized body hits the requested length precisely (the
 * §15.5 body-limit boundary cases — the unknown field makes the schema,
 * never the transport, the responder at and under the bound).
 */
export function paddedJsonOfExactLength(bytes: number): string {
  const skeleton = JSON.stringify({ pad: '' });
  return JSON.stringify({ pad: 'x'.repeat(bytes - skeleton.length) });
}
