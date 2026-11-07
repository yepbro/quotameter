import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import {
  createSessionAuthenticator,
  MAX_LOGIN_DELAY_SLEEP_MS,
} from '../../src/server/api/auth-routes';
import { apiErrorHandler } from '../../src/server/api/error';
import { buildHttpServer, HTTP_BODY_LIMIT_BYTES } from '../../src/server/http';
import { ProviderRegistry } from '../../src/providers/registry';
import { hashPassword } from '../../src/services/password-hash';
import {
  LOGIN_RATE_LIMIT_BASE_DELAY_MS,
  LOGIN_RATE_LIMIT_WINDOW_MS,
} from '../../src/services/login-rate-limit';
import { hashSessionToken } from '../../src/services/sessions';
import { SESSION_COOKIE_NAME } from '../../src/services/session-cookie';
import {
  createMigrationRunner,
  MIGRATIONS,
  SESSION_INACTIVITY_TIMEOUT_MS,
} from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { API_ERROR_DEFINITIONS } from '../../src/schemas/api/error';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The §13 login/logout endpoints on the wire (task U-041, spec §13,
 * §15.1, §15.2, §15.3, §15.4; decision D-146): both routes through the
 * real `/api` scope — the three landed guards included — over a real
 * migrated disposable SQLite database, the real scrypt verifier, and the
 * real cookie plugin, with exactly two seams under test control: the
 * clock (a mutable fake, the D-021 seam the landed §15.2 suites drive)
 * and the login-delay sleep (a recorder, so the fake-clock budget proofs
 * observe the requested delay without waiting it — D-125's "the timer is
 * the endpoint's").
 *
 * The done-condition's four test classes: contract (bodies, cookies, the
 * digest-only storage discipline, the §15.3/§13 error arms),
 * authorization (the §15.1 seam with the sessions-backed authenticator
 * wired — the protected-route 401/200 matrix whose 401 carries the
 * `UNAUTHENTICATED` code the D-134 notice branch keys on), rate limiting
 * (fake clock: the five-failure budget, the doubling delays, the
 * transport-safe delay clamp, the window expiry, the success reset, the
 * per-source isolation, and the strictest-form cadence hold — one
 * in-flight attempt per source, a concurrent same-source newcomer
 * answered without verifying), and the §15.4 marker discipline (the
 * password AND the attempted candidate never in a body or log line, the
 * raw token never in the database, the warn record credential-free with
 * its key set pinned). U-055 adds the session reader's suite (D-182):
 * the exact closed bodies per §15.1 mode, the refreshed-expiry arm with
 * the row's slide pinned, the collapsed invalid-cookie arms, and the
 * public-yet-Host-guarded construction proof.
 */

/** Deterministic §11.1 epoch-millisecond base: 2026-11-04T09:00:00Z. */
const T0 = 1_789_000_000_000;

/** The §15.4 marker password — never a response body, never a log line. */
const MARKER_PASSWORD = 'marker-login-password-4a71c9';

/**
 * The §15.4 marker for the ATTEMPTED (wrong) candidate — the string a
 * handler bug would actually leak into a log line or a body, which a
 * scan for the correct password alone can never catch (the review
 * round's P2: the first draft scanned only for `MARKER_PASSWORD` while
 * every failed attempt presented this string).
 */
const MARKER_WRONG_CANDIDATE = 'marker-wrong-candidate-92db';

/** The §15.3 dedicated mutation header (task 150, D-117). */
const MUTATION_HEADER = { 'x-quotameter-request': 'test-client' } as const;

const JSON_HEADER = { ...MUTATION_HEADER, 'content-type': 'application/json' } as const;

/** The marker hash, computed once (scrypt) and shared by every test. */
let markerHashPromise: Promise<string> | undefined;
function markerHash(): Promise<string> {
  markerHashPromise ??= hashPassword(MARKER_PASSWORD);
  return markerHashPromise;
}

/* ── The two test seams ─────────────────────────────────────────────────── */

/** The mutable fake clock — the D-021 seam, stepped explicitly. */
function createMutableClock(at: number) {
  let value = at;
  return {
    now: () => value,
    advance(ms: number): void {
      value += ms;
    },
  };
}

/** The recording fake sleep — observes the delay, never waits it. */
function createSleepRecorder() {
  const delays: number[] = [];
  return {
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    delays,
  };
}

/** Yields to the event loop until `predicate` holds (bounded). */
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !predicate(); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/* ── The harness ────────────────────────────────────────────────────────── */

interface Harness {
  readonly app: FastifyInstance;
  readonly repository: QuotaRepository;
  readonly database: DatabaseSync;
  readonly clock: ReturnType<typeof createMutableClock>;
  readonly sleep: ReturnType<typeof createSleepRecorder>;
  readonly sink: MemoryLogSink;
  /** The stored-hash holder — mutate to simulate `passwd` (§6.4-live). */
  readonly storedHash: { value: string | undefined };
}

interface HarnessOptions {
  /** §15.1 mode of the guard; defaults to `required` (the demanding cell). */
  readonly mode?: AuthModeGuardOptions['mode'];
  /**
   * §15.1 bind host of the guard (D-121's bind fact); defaults to the
   * loopback `127.0.0.1`. The session reader's matrix needs the
   * non-loopback arm, and the injected facts follow the guard's own.
   */
  readonly bindHost?: string;
  /** Whether a password hash is configured; defaults to the marker hash. */
  readonly withHash?: boolean;
  /** Whether the auth routes are wired (the no-half-wired pin opts out). */
  readonly wireAuthRoutes?: boolean;
  /** The login-delay sleep to inject (defaults to the recorder below). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Boots the real `/api` scope over a migrated disposable database with
 * `@fastify/cookie` and the root error handler — the construction's
 * registration shape minus the layers this suite does not own — plus one
 * protected read route (`GET /api/providers`, wired with an empty
 * registry) as the authorization probe, and the sessions-backed
 * `isAuthenticated` the composition wires in production.
 */
async function withAuthApi(
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
) {
  const hash = options.withHash === false ? undefined : await markerHash();
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    const clock = createMutableClock(T0);
    const sleep = createSleepRecorder();
    const injectedSleep = options.sleep;
    const storedHash = { value: hash };
    const sink = createMemoryLogSink();
    const app = Fastify({
      loggerInstance: createLogger({ level: 'warn', destination: sink }).pino as FastifyBaseLogger,
      // The construction's §15.5 body limit — the 413 class belongs to it,
      // so the harness mirrors the bound the production server enforces.
      bodyLimit: HTTP_BODY_LIMIT_BYTES,
    });
    app.setErrorHandler(apiErrorHandler);
    await app.register(cookie);
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: {
        mode: options.mode ?? 'required',
        bindHost: options.bindHost ?? '127.0.0.1',
        passwordConfigured: () => storedHash.value !== undefined,
        isAuthenticated: createSessionAuthenticator({ repository, now: clock.now }),
      },
      providers: { registry: new ProviderRegistry(), schedules: () => ({}) },
      ...(options.wireAuthRoutes === false
        ? {}
        : {
            authRoutes: {
              repository,
              passwordHash: () => storedHash.value,
              now: clock.now,
              sleep: injectedSleep ?? sleep.sleep,
            },
          }),
    });
    try {
      await body({ app, repository, database, clock, sleep, sink, storedHash });
    } finally {
      await app.close();
      database.close();
    }
  });
}

/** One login POST with the §15.3 mutation header and a JSON body. */
function login(
  app: FastifyInstance,
  password: string,
  headers: Record<string, string> = {},
  remoteAddress?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password },
    headers: { ...JSON_HEADER, ...headers },
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  });
}

/** One logout POST (bodiless — the mutation header is its only extra). */
function logout(app: FastifyInstance, token?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: {
      ...MUTATION_HEADER,
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${token}` }),
    },
  });
}

/**
 * One session-reader GET — a safe method, so no §15.3 mutation leg binds
 * it; the cookie and any extra headers are the whole request surface.
 */
function sessionGet(app: FastifyInstance, headers: Record<string, string> = {}, token?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: {
      ...headers,
      ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${token}` }),
    },
  });
}

/** The `Set-Cookie` lines of one response, normalized to an array. */
function setCookiesOf(response: { headers: Record<string, unknown> }): string[] {
  return [response.headers['set-cookie']].flat().filter((v): v is string => typeof v === 'string');
}

/** The cookie VALUE of the (single) session `Set-Cookie` line. */
function sessionTokenOf(response: { headers: Record<string, unknown> }): string {
  const line = setCookiesOf(response).find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`));
  expect(line, 'a session Set-Cookie header').toBeDefined();
  return line!.split(';')[0]!.slice(SESSION_COOKIE_NAME.length + 1);
}

/** Every cell of every user table as a string — the marker-scan view. */
function allCellStrings(database: DatabaseSync): string[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as ReadonlyArray<{ readonly name: string }>;
  const cells: string[] = [];
  for (const { name } of tables) {
    if (name.startsWith('sqlite_')) continue;
    const rows = database.prepare(`SELECT * FROM "${name}"`).all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    for (const row of rows) {
      for (const value of Object.values(row)) cells.push(String(value));
    }
  }
  return cells;
}

/** The `sessions` row count. */
function sessionCount(database: DatabaseSync): number {
  return (database.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
}

/** Pino's own record fields (plus fastify's request correlation id) — excluded from the warn payload's exact-key pin. */
const PINO_STANDARD_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'name', 'reqId']);

/** The failed-attempt warn records. */
function warnRecords(sink: MemoryLogSink): Record<string, unknown>[] {
  return sink.records().filter((record) => record.msg === 'login attempt failed');
}

/* ── The contract ───────────────────────────────────────────────────────── */

describe('POST /api/auth/login — the §15.2 composition on the wire (D-146)', () => {
  it(
    'establishes the session: 200 with the row expiry, the exact §15.2 cookie, digest-only storage',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, repository, database }) => {
        const response = await login(app, MARKER_PASSWORD);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          session: { expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS },
        });

        // D-126's attribute set, byte-checked as substrings of the one
        // Set-Cookie line: the unconditional trio, the /api path, the
        // mint-time Max-Age (exactly the 7-day inactivity bound), and NO
        // Secure on the plain-HTTP leg.
        const line = setCookiesOf(response)[0]!;
        expect(line.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
        expect(line).toContain('Path=/api');
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=Strict');
        expect(line).toContain(`Max-Age=${SESSION_INACTIVITY_TIMEOUT_MS / 1000}`);
        expect(line).not.toContain('Secure');
        expect(response.headers['cache-control']).toBe('no-store');

        // D-123's storage discipline: the row carries the digest of the
        // wire token, and the raw token appears in no cell of any table.
        const token = sessionTokenOf(response);
        const row = repository.getSession(hashSessionToken(token));
        expect(row).toEqual({
          tokenHash: hashSessionToken(token),
          createdAt: T0,
          lastSeenAt: T0,
          expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
        });
        expect(allCellStrings(database).some((cell) => cell.includes(token))).toBe(false);
      });
    },
  );

  it(
    'stamps Secure on the cookie when the client-facing leg is HTTPS (proxied login)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app }) => {
        const response = await login(app, MARKER_PASSWORD, {
          'x-forwarded-proto': 'https',
          'x-real-ip': '203.0.113.7',
        });
        expect(response.statusCode).toBe(200);
        expect(setCookiesOf(response)[0]).toContain('Secure');
      });
    },
  );

  it(
    'rejects a wrong password with the registry-default UNAUTHENTICATED envelope and one credential-free warn',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, database, sink }) => {
        const response = await login(app, MARKER_WRONG_CANDIDATE);
        expect(response.statusCode).toBe(401);
        const body = response.json() as {
          error: { code: string; message: string; details: unknown };
        };
        expect(body.error.code).toBe('UNAUTHENTICATED');
        // D-146's no-override rule: the registry's own message rides the
        // 401 (an override would drift from the D-144 document's
        // registry-derived descriptions).
        expect(body.error.message).toBe(API_ERROR_DEFINITIONS.UNAUTHENTICATED.message);
        expect(body.error.details).toEqual({ reason: 'invalid-credentials' });
        // Both §15.4 markers stay off the wire — the correct password AND
        // the attempted candidate (the string a handler bug would leak).
        expect(response.body.includes(MARKER_PASSWORD)).toBe(false);
        expect(response.body.includes(MARKER_WRONG_CANDIDATE)).toBe(false);

        // §15.2's logging sentence: exactly one warn per failed attempt,
        // source and outcome only — the payload's key set is pinned
        // exactly (pino's standard fields aside), so a future field
        // cannot smuggle a credential into the record, and BOTH markers
        // stay out of every log line.
        const records = warnRecords(sink);
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(record.level).toBe(40);
        const ownKeys = Object.keys(record)
          .filter((key) => !PINO_STANDARD_KEYS.has(key))
          .sort();
        expect(ownKeys).toEqual(['msg', 'outcome', 'source']);
        expect(record.source).toBe('127.0.0.1');
        expect(record.outcome).toBe('failure');
        expect(sessionCount(database)).toBe(0);
        for (const line of sink.lines()) {
          expect(line.includes(MARKER_PASSWORD)).toBe(false);
          expect(line.includes(MARKER_WRONG_CANDIDATE)).toBe(false);
        }
      });
    },
  );

  it('rejects a login against a passwordless configuration fail-closed (D-122 totality)', async () => {
    await withAuthApi(
      async ({ app, sink }) => {
        const response = await login(app, MARKER_PASSWORD);
        expect(response.statusCode).toBe(401);
        expect((response.json() as { error: { details: unknown } }).error.details).toEqual({
          reason: 'invalid-credentials',
        });
        expect(warnRecords(sink)).toHaveLength(1);
      },
      { mode: 'auto', withHash: false },
    );
  });

  it(
    'applies a live password change to the next attempt (§6.4/D-026 thunk)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, storedHash }) => {
        expect((await login(app, MARKER_PASSWORD)).statusCode).toBe(200);
        // A `passwd` run rewrote the stored hash while the server runs.
        storedHash.value = await hashPassword('replacement-password-2c5e80');
        expect((await login(app, MARKER_PASSWORD)).statusCode).toBe(401);
        expect((await login(app, 'replacement-password-2c5e80')).statusCode).toBe(200);
      });
    },
  );

  it(
    'answers the §13/§15.3 validation arms through the registry classes',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app }) => {
        const missing = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {},
          headers: JSON_HEADER,
        });
        expect(missing.statusCode).toBe(400);
        expect((missing.json() as { error: { code: string } }).error.code).toBe('VALIDATION');

        const empty = await login(app, '');
        expect(empty.statusCode).toBe(400);
        expect((empty.json() as { error: { code: string } }).error.code).toBe('VALIDATION');

        // The strict scope-local compiler: a smuggled field is rejected,
        // never stripped (D-128).
        const smuggled = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: MARKER_PASSWORD, passwordHash: 'scrypt$injected' },
          headers: JSON_HEADER,
        });
        expect(smuggled.statusCode).toBe(400);
        expect((smuggled.json() as { error: { code: string } }).error.code).toBe('VALIDATION');

        const wrongType = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: JSON.stringify({ password: 42 }),
          headers: { ...JSON_HEADER, 'content-type': 'text/plain' },
        });
        expect(wrongType.statusCode).toBe(415);
        expect((wrongType.json() as { error: { code: string } }).error.code).toBe(
          'UNSUPPORTED_MEDIA_TYPE',
        );

        const headerless = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: MARKER_PASSWORD },
          headers: { 'content-type': 'application/json' },
        });
        expect(headerless.statusCode).toBe(403);
        expect((headerless.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');

        const crossOrigin = await login(app, MARKER_PASSWORD, {
          origin: 'http://attacker.example',
        });
        expect(crossOrigin.statusCode).toBe(403);

        const oversized = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { password: `x`.repeat(HTTP_BODY_LIMIT_BYTES) },
          headers: JSON_HEADER,
        });
        expect(oversized.statusCode).toBe(413);
        expect((oversized.json() as { error: { code: string } }).error.code).toBe(
          'PAYLOAD_TOO_LARGE',
        );
      });
    },
  );
});

describe('POST /api/auth/logout — revocation plus the clear twin (D-146)', () => {
  it(
    'revokes the presented session, clears the cookie, and stays idempotent',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, database }) => {
        const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
        expect(sessionCount(database)).toBe(1);

        const first = await logout(app, token);
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ revoked: true });
        const clear = setCookiesOf(first)[0]!;
        expect(clear.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
        expect(clear).toContain('Max-Age=0');
        expect(clear).toContain('Path=/api');
        expect(clear).toContain('HttpOnly');
        expect(clear).toContain('SameSite=Strict');
        expect(first.headers['cache-control']).toBe('no-store');
        expect(sessionCount(database)).toBe(0);

        // The second logout with the now-dead cookie: under `required` the
        // guard answers 401 for it (a revoked row authenticates nothing)
        // — the idempotent 200 arms live in the auto-mode test below.
        const second = await logout(app, token);
        expect(second.statusCode).toBe(401);
      });
    },
  );

  it(
    'stays idempotent under the passwordless verdict: a repeat logout clears again (auto)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(
        async ({ app }) => {
          const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
          expect((await logout(app, token)).json()).toEqual({ revoked: true });
          // The row is gone; the repeat logout answers the honest false and
          // still sends the clear twin (D-124/D-126).
          const second = await logout(app, token);
          expect(second.statusCode).toBe(200);
          expect(second.json()).toEqual({ revoked: false });
          expect(setCookiesOf(second)[0]).toContain('Max-Age=0');
        },
        { mode: 'auto' },
      );
    },
  );

  it(
    'clears even a cookieless logout under the passwordless §15.1 verdict (auto)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(
        async ({ app }) => {
          const response = await logout(app);
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ revoked: false });
          expect(setCookiesOf(response)[0]).toContain('Max-Age=0');
        },
        { mode: 'auto' },
      );
    },
  );
});

/* ── Authorization: the §15.1 seam consumes the sessions (D-146) ───────── */

describe('the sessions-backed §15.1 seam — the protected-route matrix', () => {
  it(
    'enforces the session on protected routes and answers 401 UNAUTHENTICATED (the D-134 signal)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, clock }) => {
        // No cookie: the demanding verdict rejects before any handler,
        // with the code the UI notice branch intercepts (D-134).
        const anonymous = await app.inject({ method: 'GET', url: '/api/providers' });
        expect(anonymous.statusCode).toBe(401);
        expect((anonymous.json() as { error: { code: string } }).error.code).toBe(
          'UNAUTHENTICATED',
        );

        // A garbage cookie value digests to a row no table carries.
        const garbage = await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` },
        });
        expect(garbage.statusCode).toBe(401);

        // The logged-in cookie passes; the sighting refreshed the row and
        // D-146's no-re-issue pin holds — no Set-Cookie on the response.
        const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
        const authed = await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        });
        expect(authed.statusCode).toBe(200);
        expect(setCookiesOf(authed)).toEqual([]);

        // The revoked cookie is dead (logout revoked the row).
        await logout(app, token);
        const revoked = await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        });
        expect(revoked.statusCode).toBe(401);

        // The expired session is dead at the half-open boundary: one
        // clock step to exactly the row's expiry instant rejects (D-124).
        const fresh = sessionTokenOf(await login(app, MARKER_PASSWORD));
        clock.advance(SESSION_INACTIVITY_TIMEOUT_MS);
        const expired = await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${fresh}` },
        });
        expect(expired.statusCode).toBe(401);
      });
    },
  );

  it(
    'refreshes the sighting row without re-issuing the cookie (D-146 resolution)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, repository, clock }) => {
        const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
        clock.advance(60_000);
        const response = await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        });
        expect(response.statusCode).toBe(200);
        // The ROW slid (D-124's sighting refresh) while the COOKIE did not
        // (the response carries no Set-Cookie) — the conservative arm of
        // D-126's documented open point.
        expect(repository.getSession(hashSessionToken(token))).toMatchObject({
          lastSeenAt: T0 + 60_000,
          expiresAt: T0 + 60_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        });
        expect(response.headers['set-cookie']).toBeUndefined();
      });
    },
  );

  it(
    'keeps login reachable without credentials and logout guarded (the §14.6 pair)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app }) => {
        expect((await login(app, MARKER_PASSWORD)).statusCode).toBe(200);
        // Logout is session-bound: cookieless under `required` it answers
        // the guard's 401 before the handler (the never-issued clear costs
        // one dead client cookie — D-126's documented hygiene lag).
        const guarded = await logout(app);
        expect(guarded.statusCode).toBe(401);
        expect((guarded.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
      });
    },
  );

  it(
    'passes passwordless loopback access through in auto mode (§15.1)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(
        async ({ app }) => {
          const open = await app.inject({ method: 'GET', url: '/api/providers' });
          expect(open.statusCode).toBe(200);
          // Login still works there (it merely was never needed).
          const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
          const loggedOut = await logout(app, token);
          expect(loggedOut.statusCode).toBe(200);
          expect(loggedOut.json()).toEqual({ revoked: true });
        },
        { mode: 'auto' },
      );
    },
  );

  it('answers the unwired surface with the catch-all 404 (the no-half-wired rule)', async () => {
    await withAuthApi(
      async ({ app }) => {
        const response = await login(app, MARKER_PASSWORD);
        expect(response.statusCode).toBe(404);
        expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      },
      { mode: 'auto', wireAuthRoutes: false },
    );
  });
});

/* ── The §13 session reader (task U-055, decision D-182) ─────────────────── */

describe('GET /api/auth/session — the §13 session reader (D-182)', () => {
  it(
    'answers the cookieless required-mode request with the honest mode and no session key',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app }) => {
        const response = await sessionGet(app);
        expect(response.statusCode).toBe(200);
        // `toEqual` pins the closed body exactly: no `session` key, no
        // extras (the compiled serializer drops what the schema cannot
        // express — the D-111 guard).
        expect(response.json()).toEqual({ mode: 'required', authenticated: false });
        expect(response.headers['cache-control']).toBe('no-store');
        // The reader never writes a cookie (D-146's no-re-issue holds).
        expect(setCookiesOf(response)).toEqual([]);
      });
    },
  );

  it(
    'reports the refreshed expiry on the valid arm and slides the row (D-124)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, repository, clock }) => {
        const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
        clock.advance(60_000);
        const response = await sessionGet(app, {}, token);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          mode: 'required',
          authenticated: true,
          session: { expiresAt: T0 + 60_000 + SESSION_INACTIVITY_TIMEOUT_MS },
        });
        // The sighting refreshed the ROW while the COOKIE was not
        // re-issued — the reader composes `authenticateSession` verbatim,
        // so it refreshes like any authenticated request.
        expect(repository.getSession(hashSessionToken(token))).toMatchObject({
          lastSeenAt: T0 + 60_000,
          expiresAt: T0 + 60_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        });
        expect(response.headers['set-cookie']).toBeUndefined();
      });
    },
  );

  it(
    'collapses every invalid cookie outcome into authenticated false (D-124)',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, clock }) => {
        // A garbage value digests to a row no table carries.
        const garbage = await sessionGet(app, {}, 'not-a-real-token');
        expect(garbage.json()).toEqual({ mode: 'required', authenticated: false });
        // The empty-string cookie never reaches storage.
        const empty = await sessionGet(app, { cookie: `${SESSION_COOKIE_NAME}=` });
        expect(empty.json()).toEqual({ mode: 'required', authenticated: false });
        // The revoked token is dead (logout won the race).
        const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
        await logout(app, token);
        const revoked = await sessionGet(app, {}, token);
        expect(revoked.json()).toEqual({ mode: 'required', authenticated: false });
        // The expired session is dead at the half-open boundary.
        const fresh = sessionTokenOf(await login(app, MARKER_PASSWORD));
        clock.advance(SESSION_INACTIVITY_TIMEOUT_MS);
        const expired = await sessionGet(app, {}, fresh);
        expect(expired.json()).toEqual({ mode: 'required', authenticated: false });
      });
    },
  );

  it(
    'reports the §15.1 matrix — the verdict a protected probe would reveal, stated',
    { timeout: 20_000 },
    async () => {
      // auto + loopback + no proxy: the not-required default.
      await withAuthApi(
        async ({ app }) => {
          const direct = await sessionGet(app);
          expect(direct.json()).toEqual({ mode: 'not-required', authenticated: false });
        },
        { mode: 'auto' },
      );

      // auto + loopback + proxy indicator, password configured: required —
      // and the protected probe answers 401 in the same world (the guard's
      // own revelation of the same verdict).
      await withAuthApi(async ({ app }) => {
        const headers = { 'x-forwarded-for': '203.0.113.7' };
        const proxied = await sessionGet(app, headers);
        expect(proxied.json()).toEqual({ mode: 'required', authenticated: false });
        const protectedProbe = await app.inject({
          method: 'GET',
          url: '/api/providers',
          headers,
        });
        expect(protectedProbe.statusCode).toBe(401);
      });

      // auto + loopback + proxy indicator, passwordless: the cell a
      // protected route answers with §15.1's 403-instructions envelope,
      // stated as the mode instead of forced on the client.
      await withAuthApi(
        async ({ app }) => {
          const headers = { 'x-forwarded-for': '203.0.113.7' };
          const proxied = await sessionGet(app, headers);
          expect(proxied.json()).toEqual({
            mode: 'proxy-without-password',
            authenticated: false,
          });
          const protectedProbe = await app.inject({
            method: 'GET',
            url: '/api/providers',
            headers,
          });
          expect(protectedProbe.statusCode).toBe(403);
          expect((protectedProbe.json() as { error: { code: string } }).error.code).toBe(
            'FORBIDDEN',
          );
        },
        { mode: 'auto', withHash: false },
      );

      // auto + non-loopback bind: required — the fail-closed passwordless
      // shape included (the startup-refused cell still reports required,
      // never open, exactly as the classifier answers it).
      await withAuthApi(
        async ({ app }) => {
          expect((await sessionGet(app)).json()).toEqual({
            mode: 'required',
            authenticated: false,
          });
        },
        { mode: 'auto', bindHost: '0.0.0.0' },
      );
      await withAuthApi(
        async ({ app }) => {
          expect((await sessionGet(app)).json()).toEqual({
            mode: 'required',
            authenticated: false,
          });
        },
        { mode: 'auto', bindHost: '0.0.0.0', withHash: false },
      );
    },
  );

  it(
    'answers a valid cookie in the not-required world with both facts',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(
        async ({ app, clock }) => {
          const token = sessionTokenOf(await login(app, MARKER_PASSWORD));
          clock.advance(30_000);
          const response = await sessionGet(app, {}, token);
          expect(response.json()).toEqual({
            mode: 'not-required',
            authenticated: true,
            session: { expiresAt: T0 + 30_000 + SESSION_INACTIVITY_TIMEOUT_MS },
          });
        },
        { mode: 'auto' },
      );
    },
  );

  it(
    'binds the root-scope Host guard ahead of the public reader — public is not unguarded',
    { timeout: 20_000 },
    async () => {
      // Through the full construction (`buildHttpServer`): the D-121
      // opt-out answers only the §15.1 auth QUESTION — the root-scope
      // Host allowlist (D-120) still rejects a hostile authority before
      // the handler, exactly as it does for the public health route.
      await withAuthApi(async ({ repository, clock, storedHash, sink }) => {
        const server = buildHttpServer({
          host: '127.0.0.1',
          port: 0,
          logger: createLogger({ level: 'warn', destination: sink }),
          auth: {
            mode: 'required',
            passwordConfigured: () => storedHash.value !== undefined,
            isAuthenticated: createSessionAuthenticator({ repository, now: clock.now }),
          },
          routes: {
            authRoutes: { repository, passwordHash: () => storedHash.value, now: clock.now },
          },
        });
        try {
          const honest = await server.inject({
            method: 'GET',
            url: '/api/auth/session',
            headers: { host: '127.0.0.1:8787' },
          });
          expect(honest.statusCode).toBe(200);
          expect(honest.json()).toEqual({ mode: 'required', authenticated: false });

          const hostile = await server.inject({
            method: 'GET',
            url: '/api/auth/session',
            headers: { host: 'evil.example' },
          });
          expect(hostile.statusCode).toBe(403);
          expect((hostile.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
        } finally {
          await server.close();
        }
      });
    },
  );
});

/* ── The §15.2 budget through the endpoint (fake clock, recorded sleep) ─── */

describe('the D-125 budget composed by the login endpoint', () => {
  it(
    'admits five failures undelayed, then doubles the delay — and the wire never shows it',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, sleep }) => {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const response = await login(app, MARKER_WRONG_CANDIDATE);
          expect(response.statusCode, `attempt ${attempt}`).toBe(401);
        }
        expect(sleep.delays).toEqual([]);

        // The sixth and seventh attempts wait the doubling sequence; each
        // still answers the plain 401 (delays, never rejections).
        expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
        expect(sleep.delays).toEqual([LOGIN_RATE_LIMIT_BASE_DELAY_MS]);
        expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
        expect(sleep.delays).toEqual([
          LOGIN_RATE_LIMIT_BASE_DELAY_MS,
          LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2,
        ]);
      });
    },
  );

  it(
    'releases the budget when the window expires and when a login succeeds',
    { timeout: 20_000 },
    async () => {
      await withAuthApi(async ({ app, clock, sleep }) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await login(app, MARKER_WRONG_CANDIDATE);
        }
        expect(sleep.delays).toEqual([]);

        // The over-budget SUCCESS still logs in — §15.2's own sentence
        // ("delays, never rejections") — and pays its delay first: the
        // check runs before the verify (D-125's honest ordering), so the
        // delay the five failures earned lands on this attempt.
        expect((await login(app, MARKER_PASSWORD)).statusCode).toBe(200);
        expect(sleep.delays).toEqual([LOGIN_RATE_LIMIT_BASE_DELAY_MS]);

        // A verified password reset the source's budget (D-125): the very
        // next failure is undelayed again.
        expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
        expect(sleep.delays).toEqual([LOGIN_RATE_LIMIT_BASE_DELAY_MS]);

        // The window edge (half-open) releases everything exactly one
        // millisecond past it — none of the earlier failures count anymore.
        clock.advance(LOGIN_RATE_LIMIT_WINDOW_MS + 1);
        expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
        expect(sleep.delays).toEqual([LOGIN_RATE_LIMIT_BASE_DELAY_MS]);
      });
    },
  );

  it('budgets each source address independently', { timeout: 20_000 }, async () => {
    await withAuthApi(async ({ app, sleep }) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(app, MARKER_WRONG_CANDIDATE, {}, '127.0.0.1');
      }
      // The second source's first failure is undelayed — the budget is
      // per source address, and the socket-derived address is unforgeable
      // (trustProxy never enabled).
      const other = await login(app, MARKER_WRONG_CANDIDATE, {}, '127.0.0.2');
      expect(other.statusCode).toBe(401);
      expect(sleep.delays).toEqual([]);
    });
  });

  it(
    'excludes a source concurrent burst: the in-flight attempt holds the section, the newcomer answers source-busy without verifying',
    {
      timeout: 20_000,
    },
    async () => {
      // The gated sleep parks the 6th attempt inside its 1 s delay,
      // holding the per-source section. The 7th, fired concurrently,
      // must take the busy arm: answered immediately with the same 401
      // class under `source-busy`, without sleeping (delays stays at one
      // entry) and without VERIFYING — proven by the attempt AFTER the
      // release, whose own delay (2 s: six in-window failures) shows the
      // 7th recorded nothing while the 6th's record landed — D-125's
      // cadence hold in its strictest form (the review round's P1s: the
      // first design queued the 7th instead, making the per-connection
      // hold unbounded against the transport's socket-inactivity bound).
      const delays: number[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gatedSleep = async (ms: number) => {
        delays.push(ms);
        await gate;
      };
      await withAuthApi(
        async ({ app, sink }) => {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
          }
          expect(delays).toEqual([]);

          const sixth = login(app, MARKER_WRONG_CANDIDATE);
          await until(() => delays.length === 1);
          const seventh = await login(app, MARKER_WRONG_CANDIDATE);
          expect(seventh.statusCode).toBe(401);
          expect((seventh.json() as { error: { details: unknown } }).error.details).toEqual({
            reason: 'source-busy',
          });
          // The busy arm never sleeps, never verifies, never records —
          // and logs its own single credential-free warn.
          expect(delays).toEqual([LOGIN_RATE_LIMIT_BASE_DELAY_MS]);
          const busy = sink
            .records()
            .filter((record) => record.msg === 'login attempt not processed');
          expect(busy).toHaveLength(1);
          expect(busy[0]).toMatchObject({ source: '127.0.0.1', outcome: 'source-busy' });

          release();
          const sixthResponse = await sixth;
          expect(sixthResponse.statusCode).toBe(401);
          expect((sixthResponse.json() as { error: { details: unknown } }).error.details).toEqual({
            reason: 'invalid-credentials',
          });

          // The 7th recorded nothing; the 6th's failure did land: the
          // next attempt pays the doubled delay for six in-window
          // failures, and the busy warn count is unchanged.
          expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
          expect(delays).toEqual([
            LOGIN_RATE_LIMIT_BASE_DELAY_MS,
            LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2,
          ]);
          expect(
            sink.records().filter((record) => record.msg === 'login attempt not processed'),
          ).toHaveLength(1);
        },
        { sleep: gatedSleep },
      );
    },
  );

  it(
    'clamps the slept delay to the transport-safe ceiling — the wire answer never changes',
    {
      timeout: 30_000,
    },
    async () => {
      // Thirteen in-window failures put the next attempt's D-125 delay
      // at 1 s × 2^8 = 256 s, past the 240 s ceiling the endpoint clamps
      // to (itself comfortably inside the 300 s socket-inactivity bound
      // that would turn a longer sleep into a connection reset — the
      // review round's first P1). The budget's arithmetic is untouched:
      // the 401 still answers, and the failure still records.
      await withAuthApi(async ({ app, sleep }) => {
        for (let attempt = 0; attempt < 13; attempt += 1) {
          await login(app, MARKER_WRONG_CANDIDATE);
        }
        expect((await login(app, MARKER_WRONG_CANDIDATE)).statusCode).toBe(401);
        expect(sleep.delays).toEqual([
          ...[0, 1, 2, 3, 4, 5, 6, 7].map((step) => LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2 ** step),
          MAX_LOGIN_DELAY_SLEEP_MS,
        ]);
      });
    },
  );
});
