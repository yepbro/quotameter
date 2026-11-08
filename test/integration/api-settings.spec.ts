import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import { apiErrorHandler } from '../../src/server/api/error';
import type {
  SettingsApplyOutcome,
  SettingsSnapshot,
  SettingsStore,
} from '../../src/server/api/settings';
import { findReloadChanges } from '../../src/config/reload';
import type { LiveReloadField, RestartRequiredField } from '../../src/config/reload';
import type { EnvironmentSources, EnvOverrideField } from '../../src/config/env';
import { parseConfig } from '../../src/config/load';
import type { Validated } from '../../src/schemas/boundary';
import type { Config } from '../../src/schemas/config';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * The §13 settings endpoints on the wire (task 160, spec §13, §6.2–§6.4,
 * §14.5, §15.2, §15.5; decision D-130): both routes through the real `/api`
 * scope — the three landed guards included — against an in-memory
 * {@link SettingsStore} double that mirrors exactly what the composition
 * root will do: it holds the effective and startup configurations, hashes a
 * pending password into `auth.passwordHash`, and classifies the outcome
 * with the real D-026 diff (`findReloadChanges`) — the same function the
 * reloader applies, so the wire vocabulary the tests pin is the reload
 * vocabulary, not a parallel one.
 *
 * The done-condition's three test classes per route — contract (the safe
 * view's annotations, the apply outcome), authorization (the §15.1 seam as
 * it exists, plus §15.5's "settings must not be writable without
 * authentication" via the same method-blind guard), and error (the three
 * §6.3/§6.4/D-022 refusals, validation problems through the D-022
 * boundary, INTERNAL on a store failure) — plus the §15.4 marker
 * discipline: the stored password hash and an account's configured key
 * never appear in any response body, and the plaintext password reaches
 * only the seam's `pendingPassword`.
 */

/** The §15.4 markers — nothing they touch may ever reach a response body. */
const MARKER_HASH = 'scrypt$N=65536,r=8,p=1,keylen=64$bWFya2VyLXNhbHQ$marker-hash-value';
const MARKER_ACCOUNT_KEY = 'sk-marker-account-key-77c1';
const MARKER_PASSWORD = 'marker-password-9f3d1b';

/** The §15.3 dedicated mutation header (task 150, D-117). */
const MUTATION_HEADER = { 'x-quotameter-request': 'test-client' } as const;

/* ── The settings-store double (the composition's mirror) ───────────────── */

interface StoreSeed {
  /** Configuration-file input, parsed through the real loader seam. */
  readonly input: unknown;
  readonly sources?: ReadonlyArray<EnvOverrideField>;
  readonly paths?: { readonly configPath: string; readonly dataDir: string };
  /** The applied-retention marker's value (default: null — no cleanup yet). */
  readonly appliedRetentionDays?: number | null;
}

class MemorySettingsStore implements SettingsStore {
  private current: Validated<Config>;
  private readonly startup: Validated<Config>;
  private readonly sources: EnvironmentSources;
  private readonly paths: SettingsSnapshot['paths'];
  /**
   * §11.3's applied-retention reference (U-053/D-178) — the marker the
   * production store reads from storage; the double serves it verbatim.
   */
  appliedRetentionDays: number | null;
  /** The last apply's payload — the write-path proof, secrets included. */
  lastApply:
    | {
        config: Config;
        pendingPassword: string | undefined;
        sources: EnvironmentSources;
        attempted: readonly EnvOverrideField[];
      }
    | undefined;
  failNextApply = false;

  constructor(seed: StoreSeed) {
    const parsed = parseConfig(seed.input);
    if (!parsed.ok) throw new Error(`fixture config invalid: ${parsed.problems.join('; ')}`);
    this.current = parsed.value;
    this.startup = parsed.value;
    this.sources = Object.freeze({
      fields: Object.freeze([...(seed.sources ?? [])]),
      accountSecrets: Object.freeze([]),
    });
    this.paths = seed.paths ?? {
      configPath: '/home/unit/.config/quotameter/config.json',
      dataDir: '/home/unit/.local/share/quotameter',
    };
    this.appliedRetentionDays = seed.appliedRetentionDays ?? null;
  }

  async read(): Promise<SettingsSnapshot> {
    return {
      config: this.current,
      sources: this.sources,
      paths: this.paths,
      appliedRetentionDays: this.appliedRetentionDays,
      // The composition's mirror (FSM-5, D-193): the reloader's own live
      // diff over its two baselines, computed with the same function the
      // reloader applies — the double never invents a vocabulary.
      pendingRestart: findReloadChanges(this.startup, this.current).restart,
    };
  }

  async apply(change: {
    config: Config;
    pendingPassword: string | undefined;
    sources: EnvironmentSources;
    attempted: readonly EnvOverrideField[];
  }): Promise<SettingsApplyOutcome> {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error('config write failed (injected)');
    }
    this.lastApply = {
      config: change.config,
      pendingPassword: change.pendingPassword,
      sources: change.sources,
      attempted: change.attempted,
    };
    // The composition's own steps: hash the pending password (D-022's
    // boundary — the endpoint never saw a hash), classify with the
    // reloader's own diff against the previous and startup configurations,
    // then re-adopt the next configuration through the parser — the same
    // re-validation a real reload performs on the written file.
    const next =
      change.pendingPassword === undefined
        ? change.config
        : {
            ...change.config,
            auth: {
              ...change.config.auth,
              passwordHash: `scrypt$hashed$${change.pendingPassword.length}`,
            },
          };
    const applied = findReloadChanges(this.current, next).live as readonly LiveReloadField[];
    const restartRequired = findReloadChanges(this.startup, next)
      .restart as readonly RestartRequiredField[];
    const reparsed = parseConfig(next);
    if (reparsed.ok) this.current = reparsed.value;
    return { applied, restartRequired };
  }

  /** Simulates a hand-edited file picked up by a reload (the D-026 pending case). */
  handEdit(mutate: (config: Config) => Config): void {
    const edited = mutate(this.current);
    const reparsed = parseConfig(edited);
    if (reparsed.ok) this.current = reparsed.value;
  }

  /** The double's effective configuration, for direct assertions. */
  effective(): Config {
    return this.current;
  }
}

/* ── The harness ────────────────────────────────────────────────────────── */

interface Harness {
  readonly app: FastifyInstance;
  readonly store: MemorySettingsStore;
  readonly sink: MemoryLogSink;
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
  readonly sources?: ReadonlyArray<EnvOverrideField>;
  readonly input?: unknown;
  /** The applied-retention marker the double serves (§11.3, D-178). */
  readonly appliedRetentionDays?: number | null;
}

async function withSettingsApi(
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const store = new MemorySettingsStore({
    input: options.input ?? {
      server: { host: '127.0.0.1', port: 8787 },
      app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
      auth: { mode: 'auto' },
      logging: { level: 'warn' },
      accounts: [
        {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'Work plan',
          apiKey: MARKER_ACCOUNT_KEY,
        },
      ],
    },
    sources: options.sources,
    appliedRetentionDays: options.appliedRetentionDays,
  });
  const sink = createMemoryLogSink();
  const app = Fastify({
    loggerInstance: createLogger({ level: 'warn', destination: sink }).pino as FastifyBaseLogger,
  });
  app.setErrorHandler(apiErrorHandler);
  await app.register(apiRoutes, {
    prefix: '/api',
    auth: options.auth ?? { mode: 'auto', bindHost: '127.0.0.1' },
    settings: { store },
  });
  try {
    await body({ app, store, sink });
  } finally {
    await app.close();
  }
}

/** One §13 mutation call: the dedicated header, a JSON body. */
async function putSettings(
  app: FastifyInstance,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { ...MUTATION_HEADER, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload),
  });
}

/* ── Contract: GET /api/settings ────────────────────────────────────────── */

describe('GET /api/settings — the safe view (§13/§14.5)', () => {
  it('answers the fully annotated view with the read-only paths, §15.5 no-store', async () => {
    await withSettingsApi(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        settings: {
          server: {
            host: { value: '127.0.0.1', source: 'file', restartRequired: true },
            port: { value: 8787, source: 'file', restartRequired: true },
          },
          app: {
            timezone: { value: 'Europe/Berlin', source: 'file', restartRequired: false },
            pollingIntervalSeconds: { value: 300, source: 'file', restartRequired: false },
            historyRetentionDays: { value: 180, source: 'file', restartRequired: false },
          },
          auth: {
            mode: { value: 'auto', source: 'file', restartRequired: true },
            passwordConfigured: false,
          },
          logging: {
            level: { value: 'warn', source: 'file', restartRequired: false },
          },
        },
        paths: {
          configPath: '/home/unit/.config/quotameter/config.json',
          dataDir: '/home/unit/.local/share/quotameter',
        },
        // §11.3/D-178: the applied-retention reference rides the response
        // — null when no cleanup has completed (the double's default).
        appliedRetentionDays: null,
        // FSM-5/D-193: the live restart-pending diff — empty here because
        // the double's startup configuration IS its effective one (the
        // fresh-process state).
        pendingRestart: [],
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    });
  });

  it('serves the retention window the last completed cleanup applied (§11.3, D-178)', async () => {
    await withSettingsApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(response.statusCode).toBe(200);
        expect(
          (response.json() as { appliedRetentionDays: number | null }).appliedRetentionDays,
        ).toBe(180);
      },
      { appliedRetentionDays: 180 },
    );
  });

  it('serves the live restart-pending diff (FSM-5, D-193)', async () => {
    // The three acceptance scenarios of the live list: a fresh process
    // answers empty; a hand-edited host adopted by a reload answers
    // ["server.host"] persisting across GETs (until a restart, which a
    // test process never performs); and a live-field PUT adds nothing.
    await withSettingsApi(async ({ app, store }) => {
      const pendingOf = async (): Promise<string[]> => {
        const response = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(response.statusCode).toBe(200);
        return (response.json() as { pendingRestart: string[] }).pendingRestart;
      };

      // (a) Fresh process: the startup configuration is the effective one.
      expect(await pendingOf()).toEqual([]);

      // (b) The hand-edited-file-plus-reload shape: the file's host change
      // is adopted (the double's handEdit IS the adopted reload), and the
      // state persists across repeated GETs — only a restart clears it.
      // (The changed host stays loopback: a non-loopback bind without a
      // password is refused by §15.1's own parse-time rule.)
      store.handEdit((config) => ({ ...config, server: { host: 'localhost', port: 8787 } }));
      expect(await pendingOf()).toEqual(['server.host']);
      expect(await pendingOf()).toEqual(['server.host']);

      // (c) A live-field PUT neither adds to nor clears the live list: the
      // PUT refuses restart-requiring fields (D-130), so its reload adopts
      // live changes only — the pending host change stands untouched.
      const put = await putSettings(app, { app: { pollingIntervalSeconds: 600 } });
      expect(put.statusCode).toBe(200);
      expect((put.json() as { restartRequired: string[] }).restartRequired).toEqual([
        'server.host',
      ]);
      expect(await pendingOf()).toEqual(['server.host']);
    });
  });

  it('a live-field PUT adds nothing to the live restart-pending list', async () => {
    await withSettingsApi(async ({ app }) => {
      const put = await putSettings(app, {
        app: { pollingIntervalSeconds: 600 },
        logging: { level: 'debug' },
      });
      expect(put.statusCode).toBe(200);
      expect((put.json() as { restartRequired: string[] }).restartRequired).toEqual([]);
      const response = await app.inject({ method: 'GET', url: '/api/settings' });
      expect((response.json() as { pendingRestart: string[] }).pendingRestart).toEqual([]);
    });
  });

  it('identifies restart-required settings and environment-overridden read-only fields (§6.4/§6.3)', async () => {
    await withSettingsApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(response.statusCode).toBe(200);
        const view = (
          response.json() as {
            settings: {
              server: { host: { restartRequired: boolean }; port: { restartRequired: boolean } };
              auth: { mode: { source: string; restartRequired: boolean } };
              app: { timezone: { source: string } };
              logging: { level: { source: string; restartRequired: boolean } };
            };
          }
        ).settings;
        // The done-condition's identification half: exactly §6.4's closed
        // restart list is flagged, and the environment marking is the
        // read-only marking.
        expect(view.server.host.restartRequired).toBe(true);
        expect(view.server.port.restartRequired).toBe(true);
        expect(view.auth.mode.restartRequired).toBe(true);
        expect(view.logging.level.restartRequired).toBe(false);
        expect(view.auth.mode.source).toBe('environment');
        expect(view.logging.level.source).toBe('environment');
        expect(view.app.timezone.source).toBe('file');
      },
      { sources: ['auth.mode', 'logging.level'] },
    );
  });

  it('reports the password as configured presence — the hash never rides (§13/§15.4)', async () => {
    await withSettingsApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(response.statusCode).toBe(200);
        const view = response.json() as { settings: { auth: { passwordConfigured: boolean } } };
        expect(view.settings.auth.passwordConfigured).toBe(true);
        expect(response.body).not.toContain(MARKER_HASH);
      },
      {
        input: {
          app: { timezone: 'UTC' },
          auth: { passwordHash: MARKER_HASH },
          accounts: [
            {
              id: 'work',
              providerId: 'zai-coding-plan',
              label: 'Work plan',
              apiKey: MARKER_ACCOUNT_KEY,
            },
          ],
        },
      },
    );
  });

  it('carries neither the account key nor the hash anywhere in the body — no accounts copy', async () => {
    await withSettingsApi(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(MARKER_ACCOUNT_KEY);
      expect(response.body).not.toContain(MARKER_HASH);
      expect(response.body).not.toContain('accounts');
      expect(response.body).not.toContain('providers');
    });
  });
});

/* ── Contract: PUT /api/settings ────────────────────────────────────────── */

describe('PUT /api/settings — the runtime-modifiable update (§13/§6.4)', () => {
  it('applies a live change and answers in D-026 vocabulary', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const response = await putSettings(app, { app: { pollingIntervalSeconds: 600 } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        applied: ['app.pollingIntervalSeconds'],
        restartRequired: [],
      });
      // The write path: the seam received the validated, merged config —
      // the interval changed, everything else (including the stored account
      // secret, D-022's warning) survived — plus the environment marking
      // the file write must honor (the review round's P2: env-merged fields
      // are the composition's to exclude from config.json).
      expect(store.lastApply?.pendingPassword).toBeUndefined();
      expect(store.lastApply?.sources.fields).toEqual([]);
      expect(store.effective().app.pollingIntervalSeconds).toBe(600);
      expect(store.effective().accounts?.[0]?.apiKey).toBe(MARKER_ACCOUNT_KEY);
      // And the next GET reflects it.
      const view = await app.inject({ method: 'GET', url: '/api/settings' });
      const parsed = view.json() as {
        settings: { app: { pollingIntervalSeconds: { value: number } } };
      };
      expect(parsed.settings.app.pollingIntervalSeconds.value).toBe(600);
    });
  });

  it('applies a password change through pendingPassword — hashed by the seam, never echoed', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const response = await putSettings(app, { auth: { password: MARKER_PASSWORD } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ applied: ['auth.passwordHash'], restartRequired: [] });
      // §15.4: the plaintext reached only the seam (D-022's boundary)…
      expect(store.lastApply?.pendingPassword).toBe(MARKER_PASSWORD);
      // …and the effective configuration carries a hash, never the password.
      expect(store.effective().auth?.passwordHash).toMatch(/^scrypt\$/);
      expect(store.effective().auth?.passwordHash).not.toContain(MARKER_PASSWORD);
      expect(response.body).not.toContain(MARKER_PASSWORD);
      const view = await app.inject({ method: 'GET', url: '/api/settings' });
      const parsed = view.json() as { settings: { auth: { passwordConfigured: boolean } } };
      expect(parsed.settings.auth.passwordConfigured).toBe(true);
      expect(view.body).not.toContain(MARKER_PASSWORD);
    });
  });

  it('applies several live fields at once, and an empty-section body is the idempotent no-op', async () => {
    await withSettingsApi(async ({ app }) => {
      const both = await putSettings(app, {
        app: { timezone: 'UTC' },
        logging: { level: 'info' },
      });
      expect(both.statusCode).toBe(200);
      expect(both.json()).toEqual({
        applied: ['app.timezone', 'logging.level'],
        restartRequired: [],
      });
      const noop = await putSettings(app, { app: {} });
      expect(noop.statusCode).toBe(200);
      expect(noop.json()).toEqual({ applied: [], restartRequired: [] });
    });
  });

  it('carries the environment marking to the apply payload — the write-side obligation', async () => {
    await withSettingsApi(
      async ({ app, store }) => {
        const response = await putSettings(app, { logging: { level: 'info' } });
        expect(response.statusCode).toBe(200);
        // The seam's file write must skip the env-merged fields; the
        // payload says which (review round P2).
        expect(store.lastApply?.sources.fields).toEqual(['app.timezone']);
      },
      { sources: ['app.timezone'] },
    );
  });

  it('carries the attempted fields to the apply payload — the write candidates (D-140)', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const response = await putSettings(app, {
        app: { pollingIntervalSeconds: 600, historyRetentionDays: 30 },
        logging: { level: 'info' },
      });
      expect(response.statusCode).toBe(200);
      // Only the body-supplied fields are write candidates: a change
      // validated against an older snapshot must not revert fields a
      // concurrent request already applied (the `sources` payload's
      // write-side twin, D-140).
      expect(store.lastApply?.attempted).toEqual([
        'app.pollingIntervalSeconds',
        'app.historyRetentionDays',
        'logging.level',
      ]);
    });
  });

  it('reports pending restart changes the reload carries — never this request’s doing', async () => {
    await withSettingsApi(async ({ app, store }) => {
      // A hand-edited file the reload picks up beside the API change.
      store.handEdit((config) => ({ ...config, server: { ...config.server, port: 9999 } }));
      const response = await putSettings(app, { logging: { level: 'debug' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        applied: ['logging.level'],
        restartRequired: ['server.port'],
      });
    });
  });
});

/* ── Authorization: the §15.1 seam as it exists ─────────────────────────── */

describe('the settings routes behind the §15.1 auth-mode guard', () => {
  const REQUIRED_WITH_PASSWORD: AuthModeGuardOptions = {
    mode: 'required',
    bindHost: '127.0.0.1',
    passwordConfigured: () => true,
  };

  it('required mode with the fail-closed seam rejects the read and the write (§15.5)', async () => {
    await withSettingsApi(
      async ({ app }) => {
        const get = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(get.statusCode).toBe(401);
        expect(get.json()).toEqual({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
            details: { reason: 'authentication-required' },
          },
        });
        const put = await putSettings(app, { logging: { level: 'info' } });
        expect(put.statusCode).toBe(401);
      },
      { auth: REQUIRED_WITH_PASSWORD },
    );
  });

  it('a succeeding seam composes — required mode answers once authenticated', async () => {
    await withSettingsApi(
      async ({ app }) => {
        const get = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(get.statusCode).toBe(200);
        const put = await putSettings(app, { logging: { level: 'info' } });
        expect(put.statusCode).toBe(200);
      },
      { auth: { ...REQUIRED_WITH_PASSWORD, isAuthenticated: () => true } },
    );
  });

  it('binds the §15.3 mutation guards to the PUT (D-117)', async () => {
    await withSettingsApi(async ({ app }) => {
      const noHeader = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { 'content-type': 'application/json' },
        payload: '{"logging":{"level":"info"}}',
      });
      expect(noHeader.statusCode).toBe(403);
      expect(noHeader.json()).toMatchObject({
        error: { details: { reason: 'missing-custom-header' } },
      });
      const formType = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { ...MUTATION_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'level=info',
      });
      expect(formType.statusCode).toBe(415);
      expect(formType.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    });
  });

  it("answers §15.1's 403 with instructions for a proxied passwordless request", async () => {
    await withSettingsApi(async ({ app }) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { details: { reason: 'proxy-without-password' } },
      });
    });
  });
});

/* ── Errors: the three refusals (§6.3, §6.4, D-022) ─────────────────────── */

describe('PUT /api/settings — the stable refusals', () => {
  it('refuses environment-overridden fields read-only (§6.3) — per field, not wholesale', async () => {
    await withSettingsApi(
      async ({ app, store }) => {
        const refused = await putSettings(app, { app: { timezone: 'UTC' } });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({
          error: {
            code: 'FORBIDDEN',
            message:
              'These settings are supplied by environment variables and cannot be changed here; ' +
              'change them in the service environment',
            details: { reason: 'environment-overridden-read-only', fields: ['app.timezone'] },
          },
        });
        // The read-only rule is field-scoped: an unmarked field still lands.
        const allowed = await putSettings(app, { logging: { level: 'info' } });
        expect(allowed.statusCode).toBe(200);
        expect(store.lastApply).toBeDefined();
      },
      { sources: ['app.timezone'] },
    );
  });

  it('refuses the restart-requiring trio with the file+restart remedy (§6.4, D-130)', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const port = await putSettings(app, { server: { port: 9999 } });
      expect(port.statusCode).toBe(403);
      expect(port.json()).toEqual({
        error: {
          code: 'FORBIDDEN',
          message:
            'These settings take effect only after a process restart; edit the configuration file ' +
            'and run quotameter restart',
          details: { reason: 'restart-required-field', fields: ['server.port'] },
        },
      });
      const hostAndMode = await putSettings(app, {
        server: { host: '0.0.0.0' },
        auth: { mode: 'required' },
      });
      expect(hostAndMode.statusCode).toBe(403);
      expect(hostAndMode.json()).toMatchObject({
        error: {
          details: { reason: 'restart-required-field', fields: ['server.host', 'auth.mode'] },
        },
      });
      // Nothing was written.
      expect(store.lastApply).toBeUndefined();
    });
  });

  it('prefers the §6.3 refusal when a field is both environment-supplied and restart-requiring', async () => {
    await withSettingsApi(
      async ({ app }) => {
        const response = await putSettings(app, { auth: { mode: 'required' } });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error: { details: { reason: 'environment-overridden-read-only', fields: ['auth.mode'] } },
        });
      },
      { sources: ['auth.mode'] },
    );
  });

  it('refuses a supplied passwordHash — the password is the channel (D-022)', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const response = await putSettings(app, { auth: { passwordHash: 'scrypt$attacker-chosen' } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'FORBIDDEN',
          message:
            'The stored password hash is never accepted or returned; supply auth.password instead',
          details: { reason: 'password-hash-not-settable' },
        },
      });
      expect(store.lastApply).toBeUndefined();
    });
  });

  it('refuses supplied-but-blank values — a blank is a client mistake, never a silent no-op (D-011, review P2)', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const password = await putSettings(app, { auth: { password: '   ' } });
      expect(password.statusCode).toBe(400);
      expect(password.json()).toEqual({
        error: {
          code: 'VALIDATION',
          message: 'Blank values are not valid settings',
          details: { reason: 'blank-value', fields: ['auth.password'] },
        },
      });
      // The blank guard runs before the policy refusals: a blank host is a
      // blank, not a restart-required attempt.
      const host = await putSettings(app, { server: { host: ' ' }, app: { timezone: '  ' } });
      expect(host.statusCode).toBe(400);
      expect(host.json()).toMatchObject({
        error: { details: { reason: 'blank-value', fields: ['server.host', 'app.timezone'] } },
      });
      expect(store.lastApply).toBeUndefined();
    });
  });
});

/* ── Errors: validation and transport ───────────────────────────────────── */

describe('PUT /api/settings — validation classes', () => {
  it('answers the parser’s field-addressed problems for out-of-range and invalid values', async () => {
    await withSettingsApi(async ({ app, store }) => {
      const cases: Array<{ payload: unknown; problem: string; why: string }> = [
        {
          payload: { app: { pollingIntervalSeconds: 1 } },
          problem: 'app.pollingIntervalSeconds',
          why: '§7.1 range',
        },
        {
          payload: { app: { historyRetentionDays: 3 } },
          problem: 'app.historyRetentionDays',
          why: '§11.3 range',
        },
        { payload: { app: { timezone: 'Not/AZone' } }, problem: 'app.timezone', why: 'IANA' },
        {
          payload: { auth: { password: 'short' } },
          problem: 'auth.password',
          why: '§15.2 minimum length',
        },
      ];
      for (const testCase of cases) {
        const response = await putSettings(app, testCase.payload);
        expect(response.statusCode, testCase.why).toBe(400);
        const details = (
          response.json() as {
            error: { code: string; details: { reason: string; problems: string[] } };
          }
        ).error.details;
        expect(details.reason, testCase.why).toBe('invalid-settings');
        expect(
          details.problems.some((problem) => problem.startsWith(testCase.problem)),
          testCase.why,
        ).toBe(true);
        // Value-free problems (§15.4): the rejected values never ride.
        expect(response.body).not.toContain('short');
      }
      expect(store.lastApply).toBeUndefined();
    });
  });

  it('rejects smuggled file-only sections and the empty body at the schema layer', async () => {
    await withSettingsApi(async ({ app }) => {
      const cases: Array<{ payload: unknown; why: string }> = [
        { payload: { accounts: [] }, why: 'accounts have their own §13 surface' },
        {
          payload: {
            providers: { 'zai-coding-plan': { peakHours: { timezone: 'UTC', windows: [] } } },
          },
          why: '§9.2 keeps the schedule file-only',
        },
        { payload: {}, why: 'the empty body' },
        { payload: { logging: { level: 'trace' } }, why: 'closed enum' },
        { payload: { app: { pollingIntervalSeconds: 'not-a-number' } }, why: 'non-numeric string' },
      ];
      for (const testCase of cases) {
        const response = await putSettings(app, testCase.payload);
        expect(response.statusCode, testCase.why).toBe(400);
        expect(response.json(), testCase.why).toMatchObject({ error: { code: 'VALIDATION' } });
      }
    });
  });

  it('accepts a numeric string as the framework coerces it — the same coercion the D-022 boundary applies', async () => {
    await withSettingsApi(async ({ app, store }) => {
      // The scope-local strict Ajv re-asserts fastify's own
      // `coerceTypes: 'array'` (D-128), so '600' lands as 600 — exactly
      // what validateSettings' numeric-string coercion would do with the
      // same input; one behavior, not two.
      const response = await putSettings(app, { app: { pollingIntervalSeconds: '600' } });
      expect(response.statusCode).toBe(200);
      expect(store.effective().app.pollingIntervalSeconds).toBe(600);
    });
  });

  it('keeps GET/PUT only — other methods answer the §13 envelope', async () => {
    await withSettingsApi(async ({ app }) => {
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
        const response = await app.inject({
          method,
          url: '/api/settings',
          headers: { ...MUTATION_HEADER, 'content-type': 'application/json' },
          payload: '{}',
        });
        expect(response.statusCode, method).toBe(404);
        expect(response.json(), method).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    });
  });

  it('escalates a store failure to the generic INTERNAL envelope, cause logged (D-113)', async () => {
    await withSettingsApi(async ({ app, store, sink }) => {
      store.failNextApply = true;
      const response = await putSettings(app, { logging: { level: 'info' } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Internal server error', details: null },
      });
      expect(response.body).not.toContain('config write failed');
      expect(sink.records().some((record) => String(record.msg).includes('internal error'))).toBe(
        true,
      );
    });
  });
});

/* ── The unwired construction keeps the catch-all answer ────────────────── */

describe('the task-146 construction without settings dependencies', () => {
  it('answers /api/settings with the scope catch-all 404 envelope — no half-wired surface', async () => {
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
      const get = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(get.statusCode).toBe(404);
      expect(get.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method: 'GET', path: '/api/settings' },
        },
      });
      const put = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { ...MUTATION_HEADER, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(put.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
