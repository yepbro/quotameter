import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuotameterApp } from '../../src/server/app';
import { composeApplication } from '../../src/server/composition';
import type { ComposedApplication } from '../../src/server/composition';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import { hashPassword } from '../../src/services/password-hash';
import { SESSION_COOKIE_NAME } from '../../src/services/session-cookie';
import { createFixedClock } from '../../src/util/clock';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The composition half of task U-041's done-condition (spec §13, §15.1,
 * §15.2; decision D-146): the production construction —
 * `composeApplication`, the same assembly `runServer` starts — wires the
 * sessions-backed `isAuthenticated` (D-140's deliberately-unwired seam,
 * closed here) beside the login/logout routes over the real config file,
 * the real migrated SQLite, and the shared clock, so a password-mode
 * deployment actually authenticates: login mints the session through the
 * D-140 lazy repository, protected routes enforce the cookie behind the
 * §15.1 seam, and logout revokes. No store is doubled; the only test
 * double is the clock (fixed, D-021) and the logger (a memory sink).
 */

/** Deterministic §11.1 epoch base: 2026-11-04T11:00:00Z. */
const T0 = Date.UTC(2026, 10, 4, 11, 0, 0);

/** The §15.4 marker password — never a response body, never a log line. */
const MARKER_PASSWORD = 'marker-composition-login-8b31e6';

/** The §15.3 dedicated mutation header (task 150, D-117). */
const MUTATION_HEADER = { 'x-quotameter-request': 'test-client' } as const;

const JSON_HEADER = { ...MUTATION_HEADER, 'content-type': 'application/json' } as const;

/** The marker hash, computed once (scrypt). */
let markerHashPromise: Promise<string> | undefined;
function markerHash(): Promise<string> {
  markerHashPromise ??= hashPassword(MARKER_PASSWORD);
  return markerHashPromise;
}

/** Extracts the session token from a login response's `Set-Cookie`. */
function sessionTokenOf(response: { headers: Record<string, unknown> }): string {
  const line = [response.headers['set-cookie']]
    .flat()
    .find(
      (entry): entry is string =>
        typeof entry === 'string' && entry.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
  expect(line, 'a session Set-Cookie header').toBeDefined();
  return line!.split(';')[0]!.slice(SESSION_COOKIE_NAME.length + 1);
}

describe('the production composition authenticates sessions (task U-041, D-146)', () => {
  it(
    'logins through the real construction, enforces the cookie on protected routes, and revokes on logout',
    { timeout: 20_000 },
    async () => {
      const passwordHash = await markerHash();
      await withTempDir(async (dir) => {
        const configDir = join(dir.path, 'config');
        const dataDir = join(dir.path, 'data');
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        const configPath = configFilePath(configDir);
        await writeConfigFile(configPath, {
          server: { host: '127.0.0.1', port: 8787 },
          app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
          auth: { mode: 'required', passwordHash },
          logging: { level: 'warn' },
          accounts: [],
        });

        const sink = createMemoryLogSink();
        const composed: ComposedApplication = await composeApplication({
          env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: dataDir },
          clock: createFixedClock(T0),
          logger: createLogger({ level: 'warn', destination: sink }),
          port: 0,
        });
        const app = new QuotameterApp({ components: composed.components });
        await app.start();
        try {
          const server = composed.httpServer.server;

          // The demanding verdict holds for a cookieless request: the
          // sessions-backed seam is wired (the fail-closed default would
          // look identical HERE, but the cookie arm below distinguishes).
          const anonymous = await server.inject({ method: 'GET', url: '/api/providers' });
          expect(anonymous.statusCode).toBe(401);
          expect((anonymous.json() as { error: { code: string } }).error.code).toBe(
            'UNAUTHENTICATED',
          );

          // A wrong password answers the invalid-credentials envelope with
          // the §15.2 warn — through the real reloader-read hash thunk.
          const wrong = await server.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { password: 'marker-wrong-candidate-compose-5ac0' },
            headers: JSON_HEADER,
          });
          expect(wrong.statusCode).toBe(401);
          expect((wrong.json() as { error: { details: unknown } }).error.details).toEqual({
            reason: 'invalid-credentials',
          });

          // The marker login mints the session…
          const login = await server.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { password: MARKER_PASSWORD },
            headers: JSON_HEADER,
          });
          expect(login.statusCode).toBe(200);
          const token = sessionTokenOf(login);
          const cookie = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

          // …and the SAME cookie now passes the §15.1 seam the composition
          // wired — the proof the wiring is `createSessionAuthenticator`
          // (the fail-closed default would have kept this arm at 401).
          const authed = await server.inject({
            method: 'GET',
            url: '/api/providers',
            headers: cookie,
          });
          expect(authed.statusCode).toBe(200);

          // Logout revokes through the real repository and clears the
          // cookie; the dead cookie answers 401 again.
          const logout = await server.inject({
            method: 'POST',
            url: '/api/auth/logout',
            headers: { ...MUTATION_HEADER, ...cookie },
          });
          expect(logout.statusCode).toBe(200);
          expect(logout.json()).toEqual({ revoked: true });
          const dead = await server.inject({
            method: 'GET',
            url: '/api/providers',
            headers: cookie,
          });
          expect(dead.statusCode).toBe(401);

          // §15.4: BOTH markers — the correct password and the attempted
          // candidate (the string a handler bug would leak) — appear in
          // no response body and no log line; the hash in the config
          // file is the only artifact.
          for (const line of sink.lines()) {
            expect(line.includes(MARKER_PASSWORD)).toBe(false);
            expect(line.includes('marker-wrong-candidate-compose-5ac0')).toBe(false);
          }
          for (const body of [
            wrong.body,
            login.body,
            logout.body,
            dead.body,
            anonymous.body,
            authed.body,
          ]) {
            expect(body.includes(MARKER_PASSWORD)).toBe(false);
            expect(body.includes('marker-wrong-candidate-compose-5ac0')).toBe(false);
          }
        } finally {
          await app.stop();
        }
      });
    },
  );
});
