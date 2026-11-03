import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuotameterApp } from '../../src/server/app';
import { composeApplication } from '../../src/server/composition';
import type { ComposedApplication } from '../../src/server/composition';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import {
  CredentialCheckError,
  CredentialsRejectedError,
} from '../../src/providers/zai-coding-plan/validate';
import type { QuotaProvider, AccountContext } from '../../src/providers/registry';
import type { AccountsListResponse } from '../../src/schemas/api/accounts';
import type { StatusResponse } from '../../src/schemas/api/status';
import type { SettingsResponse } from '../../src/schemas/api/settings';
import { createFixedClock } from '../../src/util/clock';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The U-040 done-condition, executable end to end: the production
 * composition — `composeApplication`, the same construction `runServer`
 * assembles through `buildComponents()` — implements the D-128
 * `AccountConfigStore` and the D-130 `SettingsStore` over a real temp
 * `config.json`, config-syncs configured accounts into real migrated
 * SQLite rows, holds the D-064 suspension state lifted by a successful
 * manual test, and serves every previously-404 route family. No store is
 * doubled: the only test double is the provider adapter (the external
 * boundary the no-network guard requires tests to own), registered through
 * the production wrapper the composition itself applies.
 */

/** Deterministic §11.1 epoch base: 2026-11-03T10:00:00Z. */
const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);

/** The §15.4 marker secret — never a response body, never a log line. */
const MARKER_KEY = 'sk-marker-composition-5e91ab';

/** A second marker for key rotation. */
const MARKER_KEY_2 = 'sk-rotated-composition-0d4c7f';

/** The §15.3 dedicated mutation header (task 150, D-117). */
const MUTATION_HEADER = { 'x-quotameter-request': 'test-client' } as const;

const JSON_HEADER = { ...MUTATION_HEADER, 'content-type': 'application/json' } as const;

/** ISO-8601 UTC for the §13 range parameters (D-139's request half). */
function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/* ── The provider double (the external boundary; the D-052 vocabulary) ──── */

type ProviderMode = 'ok' | 'rejected' | 'unavailable';

interface ProviderBehavior {
  mode: ProviderMode;
  readonly contexts: AccountContext[];
}

function createBehavior(): ProviderBehavior {
  return { mode: 'ok', contexts: [] };
}

function providerOf(behavior: ProviderBehavior): QuotaProvider {
  return {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan (test double)',
    metricCatalog: [{ metricKey: 'five_hour.quota', label: 'Rolling 5-hour quota' }],
    async validateCredentials(account: AccountContext): Promise<void> {
      behavior.contexts.push(account);
      if (behavior.mode === 'rejected') throw new CredentialsRejectedError(401);
      if (behavior.mode === 'unavailable') {
        throw new CredentialCheckError(
          'provider-unavailable',
          'the credential check could not be completed (test double)',
        );
      }
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not under test');
    },
  };
}

/* ── The composition harness (production construction throughout) ───────── */

interface ComposeOptions {
  /** The configuration file's JSON content. */
  readonly config: unknown;
  /** Extra environment beside the directory overrides. */
  readonly env?: Readonly<Record<string, string>>;
  readonly behavior?: ProviderBehavior;
}

/** What {@link compose} hands the test body. */
interface Harness {
  readonly composed: ComposedApplication;
  readonly app: QuotameterApp;
  readonly sink: MemoryLogSink;
  readonly configPath: string;
  readonly dataDir: string;
  /** Injects against the real Fastify instance (no sockets). */
  inject(
    method: string,
    url: string,
    payload?: string | Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string; json(): unknown }>;
}

/**
 * Composes, starts, runs the body, and stops the application over fresh
 * temp directories — the full §5.6 lifecycle through the production path.
 */
async function withComposedApp(options: ComposeOptions, body: (h: Harness) => Promise<void>) {
  await withTempDir(async (dir) => {
    const configDir = join(dir.path, 'config');
    const dataDir = join(dir.path, 'data');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const configPath = configFilePath(configDir);
    await writeConfigFile(configPath, options.config);

    const sink = createMemoryLogSink();
    const behavior = options.behavior ?? createBehavior();
    const composed = await composeApplication({
      env: {
        QUOTAMETER_CONFIG_DIR: configDir,
        QUOTAMETER_DATA_DIR: dataDir,
        ...options.env,
      },
      clock: createFixedClock(T0),
      // 'info' captures the lifecycle records the §15.4 scan must cover;
      // §16's request-logging gate keeps per-request noise out regardless.
      logger: createLogger({ level: 'info', destination: sink }),
      providers: [providerOf(behavior)],
      port: 0,
    });
    const app = new QuotameterApp({ components: composed.components });
    await app.start();
    try {
      await body({
        composed,
        app,
        sink,
        configPath,
        dataDir,
        inject: (method, url, payload, headers = { ...MUTATION_HEADER }) =>
          composed.httpServer.server.inject({
            method,
            url,
            headers: payload === undefined ? headers : { ...JSON_HEADER, ...headers },
            payload,
          }),
      });
    } finally {
      await app.stop();
    }
  });
}

/** Reads the current config file as parsed JSON. */
async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** A minimal valid configuration with one seeded account. */
function seededConfig(): unknown {
  return {
    app: { timezone: 'UTC' },
    accounts: [
      {
        id: 'seed',
        providerId: 'zai-coding-plan',
        label: 'Seed account',
        apiKey: MARKER_KEY,
      },
    ],
  };
}

/** The status token of one account id, through the wire. */
async function statusTokenOf(h: Harness, accountId: string): Promise<string | undefined> {
  const response = await h.inject('GET', '/api/status');
  const body = response.json() as StatusResponse;
  return body.accounts.find((account) => account.id === accountId)?.status;
}

describe('composeApplication — the previously-404 families answer', () => {
  it(
    'serves every landed route family through the real construction',
    { timeout: 20_000 },
    async () => {
      await withComposedApp({ config: seededConfig() }, async (h) => {
        // `/api/accounts` (159): the merged view of the synced row.
        const accounts = await h.inject('GET', '/api/accounts');
        expect(accounts.statusCode).toBe(200);
        const accountsBody = accounts.json() as AccountsListResponse;
        expect(accountsBody.accounts).toHaveLength(1);
        expect(accountsBody.accounts[0]).toMatchObject({
          id: 'seed',
          label: 'Seed account',
          status: 'active',
          hasKey: true,
          keySource: 'file',
          createdAt: T0,
        });
        expect(accounts.body).not.toContain(MARKER_KEY);

        // `/api/status` (160): the §7.3 rows over the synced storage.
        const status = await h.inject('GET', '/api/status');
        expect(status.statusCode).toBe(200);
        const statusBody = status.json() as StatusResponse;
        expect(statusBody.status).toBe('ok');
        expect(statusBody.pollingIntervalSeconds).toBe(300);
        expect(statusBody.accounts).toEqual([
          expect.objectContaining({ id: 'seed', status: 'collecting' }),
        ]);

        // `/api/providers` (160): the registry through the observation wrapper.
        const providers = await h.inject('GET', '/api/providers');
        expect(providers.statusCode).toBe(200);
        expect(providers.json()).toEqual({
          providers: [
            {
              id: 'zai-coding-plan',
              name: 'Z.ai Coding Plan (test double)',
              peakHours: null,
              metrics: [{ metricKey: 'five_hour.quota', label: 'Rolling 5-hour quota' }],
            },
          ],
        });

        // `/api/settings` (160): the file-backed view with the real paths.
        const settings = await h.inject('GET', '/api/settings');
        expect(settings.statusCode).toBe(200);
        const settingsBody = settings.json() as SettingsResponse;
        expect(settingsBody.settings.app.timezone).toMatchObject({
          value: 'UTC',
          source: 'file',
        });
        expect(settingsBody.paths).toEqual({ configPath: h.configPath, dataDir: h.dataDir });
        expect(settings.body).not.toContain(MARKER_KEY);

        // `/api/quota` (160): honest absence over the real storage.
        const quota = await h.inject('GET', '/api/quota?accountId=seed');
        expect(quota.statusCode).toBe(200);
        expect(quota.json()).toMatchObject({ accountId: 'seed', metrics: [] });

        // `/api/history` (161): the empty series with its range report.
        const history = await h.inject(
          'GET',
          `/api/history?accountId=seed&metric=five_hour.used&from=${isoOf(T0 - 3_600_000)}&to=${isoOf(T0)}`,
        );
        expect(history.statusCode).toBe(200);
        expect(history.json()).toMatchObject({
          accountId: 'seed',
          metric: 'five_hour.used',
          unit: null,
          points: [],
        });

        // `/api/events` (161): the empty unified timeline.
        const events = await h.inject(
          'GET',
          `/api/events?accountId=seed&from=${isoOf(T0 - 3_600_000)}&to=${isoOf(T0)}`,
        );
        expect(events.statusCode).toBe(200);
        expect(events.json()).toMatchObject({ accountId: 'seed', events: [] });

        // `/api/accounts/:id/test` (159): the provider double through the
        // production observation wrapper.
        const test = await h.inject('POST', '/api/accounts/seed/test');
        expect(test.statusCode).toBe(200);
        expect(test.json()).toEqual({ outcome: 'ok' });
        expect(h.composed.repository.getAccount('seed')).not.toBeNull();
      });
    },
  );
});

describe('composeApplication — the config-sync (D-128)', () => {
  it(
    'inserts missing rows at startup and follows label drift across lifecycles',
    { timeout: 20_000 },
    async () => {
      await withTempDir(async (dir) => {
        const configDir = join(dir.path, 'config');
        const dataDir = join(dir.path, 'data');
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        const configPath = configFilePath(configDir);
        const env = { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: dataDir };
        const behavior = createBehavior();

        // First lifecycle: the configured account is mirrored into a row.
        await writeConfigFile(configPath, {
          app: { timezone: 'UTC' },
          accounts: [
            {
              id: 'seed',
              providerId: 'zai-coding-plan',
              label: 'Old label',
              apiKey: MARKER_KEY,
            },
          ],
        });
        const first = await composeApplication({
          env,
          clock: createFixedClock(T0),
          logger: createLogger({ level: 'warn', destination: createMemoryLogSink() }),
          providers: [providerOf(behavior)],
          port: 0,
        });
        const firstApp = new QuotameterApp({ components: first.components });
        await firstApp.start();
        expect(first.repository.getAccount('seed')).toMatchObject({
          id: 'seed',
          label: 'Old label',
          status: 'active',
          createdAt: T0,
        });
        await firstApp.stop();

        // The lock released on stop: a second lifecycle acquires it, and the
        // startup sync copies the hand-edited label drift into the row.
        await writeConfigFile(configPath, {
          app: { timezone: 'UTC' },
          accounts: [
            {
              id: 'seed',
              providerId: 'zai-coding-plan',
              label: 'New label',
              apiKey: MARKER_KEY,
            },
          ],
        });
        const second = await composeApplication({
          env,
          clock: createFixedClock(T0),
          logger: createLogger({ level: 'warn', destination: createMemoryLogSink() }),
          providers: [providerOf(behavior)],
          port: 0,
        });
        const secondApp = new QuotameterApp({ components: second.components });
        await secondApp.start();
        expect(second.repository.getAccount('seed')).toMatchObject({
          label: 'New label',
          createdAt: T0, // the row survived; the sync updated, not re-created
        });
        await secondApp.stop();
      });
    },
  );
});

describe('composeApplication — the account store over the real file', () => {
  it(
    'persists create/update/archive through atomic writes and §6.4 reloads',
    { timeout: 20_000 },
    async () => {
      await withComposedApp({ config: seededConfig() }, async (h) => {
        // Create: the file gains the entry with the write-only key…
        const created = await h.inject('POST', '/api/accounts', {
          providerId: 'zai-coding-plan',
          label: 'Created account',
          apiKey: MARKER_KEY_2,
          id: 'created',
        });
        expect(created.statusCode).toBe(201);
        expect(created.body).not.toContain(MARKER_KEY_2);
        const file = await readConfigFile(h.configPath);
        expect(file.accounts).toEqual([
          expect.objectContaining({ id: 'seed' }),
          expect.objectContaining({
            id: 'created',
            label: 'Created account',
            enabled: true,
            apiKey: MARKER_KEY_2,
          }),
        ]);
        // …the storage row landed with it (the config-sync rode the reload)…
        expect(h.composed.repository.getAccount('created')).toMatchObject({
          label: 'Created account',
          createdAt: T0,
        });
        // …and the duplicate refusal is backed by the real file.
        const duplicate = await h.inject('POST', '/api/accounts', {
          providerId: 'zai-coding-plan',
          label: 'Dup',
          id: 'created',
        });
        expect(duplicate.statusCode).toBe(400);
        expect(duplicate.json()).toMatchObject({
          error: { code: 'VALIDATION', details: { reason: 'duplicate-account-id' } },
        });

        // Update: label and key rotation land in the file…
        const renamed = await h.inject('PATCH', '/api/accounts/created', {
          label: 'Renamed account',
          apiKey: MARKER_KEY,
        });
        expect(renamed.statusCode).toBe(200);
        const updatedFile = await readConfigFile(h.configPath);
        expect(updatedFile.accounts).toEqual([
          expect.objectContaining({ id: 'seed', apiKey: MARKER_KEY }),
          expect.objectContaining({
            id: 'created',
            label: 'Renamed account',
            apiKey: MARKER_KEY,
          }),
        ]);
        // …and the row's denormalized label mirror follows.
        expect(h.composed.repository.getAccount('created')).toMatchObject({
          label: 'Renamed account',
        });

        // Archive: the entry leaves the file, the row keeps the history.
        const archived = await h.inject('DELETE', '/api/accounts/created');
        expect(archived.statusCode).toBe(200);
        expect(archived.json()).toMatchObject({ result: 'archived' });
        const archivedFile = await readConfigFile(h.configPath);
        expect(archivedFile.accounts).toEqual([expect.objectContaining({ id: 'seed' })]);
        expect(h.composed.repository.getAccount('created')).toMatchObject({
          status: 'archived',
        });

        // The §15.4 marker never reached a log line through the whole flow.
        expect(h.sink.lines().join('\n')).not.toContain(MARKER_KEY);
        expect(h.sink.lines().join('\n')).not.toContain(MARKER_KEY_2);
      });
    },
  );
});

describe('composeApplication — the settings store over the real file', () => {
  it(
    'persists changed live settings, skips environment-owned fields, and never rewrites secrets',
    { timeout: 20_000 },
    async () => {
      await withComposedApp(
        {
          config: seededConfig(),
          env: { QUOTAMETER_LOGGING_LEVEL: 'debug' },
        },
        async (h) => {
          // The environment-owned field reads as such on the wire…
          const before = await h.inject('GET', '/api/settings');
          const beforeBody = before.json() as SettingsResponse;
          expect(beforeBody.settings.logging.level).toEqual({
            value: 'debug',
            source: 'environment',
            restartRequired: false,
          });

          // …a PUT changing the interval does not bake it into the file…
          const put = await h.inject('PUT', '/api/settings', {
            app: { pollingIntervalSeconds: 600 },
          });
          expect(put.statusCode).toBe(200);
          expect(put.json()).toEqual({
            applied: ['app.pollingIntervalSeconds'],
            restartRequired: [],
          });
          const file = await readConfigFile(h.configPath);
          expect(file.app).toEqual({ timezone: 'UTC', pollingIntervalSeconds: 600 });
          expect(file.logging).toBeUndefined(); // stays the environment's
          // …the account secret and the sibling account survived the write.
          expect(file.accounts).toEqual([
            expect.objectContaining({ id: 'seed', apiKey: MARKER_KEY }),
          ]);

          // …and the effective configuration adopted the change live.
          const after = await h.inject('GET', '/api/status');
          expect(after.json()).toMatchObject({ pollingIntervalSeconds: 600 });
        },
      );
    },
  );

  it(
    'hashes a supplied password into the file and revokes every session',
    { timeout: 20_000 },
    async () => {
      await withComposedApp({ config: seededConfig() }, async (h) => {
        // One live session minted directly through the repository facade.
        const tokenHash = createHash('sha256').update('session-token-under-test').digest('hex');
        h.composed.repository.insertSession({
          tokenHash,
          createdAt: T0,
          lastSeenAt: T0,
          expiresAt: T0 + 86_400_000,
        });
        expect(h.composed.repository.getSession(tokenHash)).not.toBeNull();

        const put = await h.inject('PUT', '/api/settings', {
          auth: { password: 'correct-horse-battery' },
        });
        expect(put.statusCode).toBe(200);
        expect(put.json()).toMatchObject({ applied: ['auth.passwordHash'] });

        // §15.2/D-118: only the scrypt encoding is stored — never the
        // plaintext — and §15.2/D-124: the password change revoked sessions.
        const file = await readConfigFile(h.configPath);
        const hash = (file.auth as Record<string, unknown> | undefined)?.passwordHash;
        expect(typeof hash).toBe('string');
        expect(hash as string).toMatch(/^scrypt\$N=/);
        expect(JSON.stringify(file)).not.toContain('correct-horse-battery');
        expect(h.composed.repository.getSession(tokenHash)).toBeNull();

        // A later password-less PUT must not rewrite the stored hash.
        const again = await h.inject('PUT', '/api/settings', {
          app: { pollingIntervalSeconds: 120 },
        });
        expect(again.statusCode).toBe(200);
        const fileAgain = await readConfigFile(h.configPath);
        expect((fileAgain.auth as Record<string, unknown>).passwordHash).toBe(hash);
      });
    },
  );
});

describe('composeApplication — the §7.2 suspension over the wire', () => {
  it(
    'shows Auth rejected after a refused manual test and lifts it on success',
    { timeout: 20_000 },
    async () => {
      const behavior = createBehavior();
      await withComposedApp({ config: seededConfig(), behavior }, async (h) => {
        // A refused manual test re-enters suspension: §7.3's rank-1 token.
        behavior.mode = 'rejected';
        const refused = await h.inject('POST', '/api/accounts/seed/test');
        expect(refused.statusCode).toBe(200);
        expect(refused.json()).toMatchObject({ outcome: 'rejected' });
        expect(await statusTokenOf(h, 'seed')).toBe('auth-rejected');

        // A successful manual test lifts it — the U-040 done-condition.
        behavior.mode = 'ok';
        const accepted = await h.inject('POST', '/api/accounts/seed/test');
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ outcome: 'ok' });
        expect(await statusTokenOf(h, 'seed')).not.toBe('auth-rejected');

        // The tested credential reached the provider through the branded
        // context (server-side process memory, §15.4).
        expect(behavior.contexts).toHaveLength(2);
        expect(behavior.contexts[0]?.accountId).toBe('seed');
      });
    },
  );

  it(
    "releases the suspension when the configured key rotates — §7.2's other release condition",
    { timeout: 20_000 },
    async () => {
      const behavior = createBehavior();
      await withComposedApp({ config: seededConfig(), behavior }, async (h) => {
        behavior.mode = 'rejected';
        await h.inject('POST', '/api/accounts/seed/test');
        expect(await statusTokenOf(h, 'seed')).toBe('auth-rejected');

        // Rotating the key through the API changes the accounts section;
        // the composition-wrapped reload reports the new key identity and
        // D-064 releases the episode — no manual test needed.
        behavior.mode = 'ok';
        const rotated = await h.inject('PATCH', '/api/accounts/seed', {
          apiKey: 'sk-rotated-release-91b3c7',
        });
        expect(rotated.statusCode).toBe(200);
        expect(await statusTokenOf(h, 'seed')).not.toBe('auth-rejected');
      });
    },
  );
});

describe('composeApplication — the §5.3 keyless skip path (D-140)', () => {
  it(
    'creates a keyless account, stores no key field, and reports Not configured',
    { timeout: 20_000 },
    async () => {
      await withComposedApp({ config: seededConfig() }, async (h) => {
        const created = await h.inject('POST', '/api/accounts', {
          providerId: 'zai-coding-plan',
          label: 'Keyless account',
          id: 'keyless',
        });
        // The landed endpoint contract (D-128): `apiKey` optional, the
        // account keyed later in the UI (§5.3 step 3). Before D-140 the
        // configuration invariant ("exactly one source") turned this into a
        // 500 through the production store — the review round's P1.
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({
          id: 'keyless',
          hasKey: false,
          keySource: 'none',
        });

        const file = await readConfigFile(h.configPath);
        const entries = file.accounts as Array<Record<string, unknown>>;
        expect(entries).toHaveLength(2);
        expect(entries[1]).toMatchObject({
          id: 'keyless',
          label: 'Keyless account',
          enabled: true,
        });
        expect('apiKey' in entries[1]!).toBe(false);

        expect(await statusTokenOf(h, 'keyless')).toBe('not-configured');
      });
    },
  );
});

describe('composeApplication — environment-sourced keys (spec §6.3)', () => {
  it(
    'resolves apiKeyEnv for status and tests, and never logs the resolved marker',
    { timeout: 20_000 },
    async () => {
      const behavior = createBehavior();
      await withComposedApp(
        {
          config: {
            app: { timezone: 'UTC' },
            accounts: [
              {
                id: 'envseed',
                providerId: 'zai-coding-plan',
                label: 'Environment account',
                apiKeyEnv: 'QM_IT_ACCOUNT_KEY',
              },
            ],
          },
          env: { QM_IT_ACCOUNT_KEY: MARKER_KEY_2 },
          behavior,
        },
        async (h) => {
          const accounts = await h.inject('GET', '/api/accounts');
          expect(accounts.json()).toMatchObject({
            accounts: [{ id: 'envseed', hasKey: true, keySource: 'environment' }],
          });
          // The resolved key configures the account (§7.3's gate)…
          expect(await statusTokenOf(h, 'envseed')).toBe('collecting');
          // …reaches the provider through the context's sealed secret…
          const test = await h.inject('POST', '/api/accounts/envseed/test');
          expect(test.json()).toEqual({ outcome: 'ok' });
          expect(behavior.contexts[0]?.secret).toBe(MARKER_KEY_2);
          // …and never appears on the wire or in a log line (§15.4 — the
          // env-resolved key joined the logger's startup secret list).
          expect(accounts.body).not.toContain(MARKER_KEY_2);
          expect(h.sink.lines().join('\n')).not.toContain(MARKER_KEY_2);
        },
      );
    },
  );
});

describe('composeApplication — §6.2 startup refusals', () => {
  it('refuses to start without a configuration file', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await expect(
        composeApplication({
          env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
          clock: createFixedClock(T0),
          logger: createLogger({ level: 'warn', destination: createMemoryLogSink() }),
          providers: [providerOf(createBehavior())],
        }),
      ).rejects.toThrow(/configuration file not found/);
    });
  });

  it('refuses to start on an invalid configuration with the pipeline problems', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeConfigFile(configFilePath(configDir), {
        app: { timezone: 'UTC', pollingIntervalSeconds: 5 }, // below §7.1's 60
      });
      await expect(
        composeApplication({
          env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
          clock: createFixedClock(T0),
          logger: createLogger({ level: 'warn', destination: createMemoryLogSink() }),
          providers: [providerOf(createBehavior())],
        }),
      ).rejects.toThrow(/refusing to start[\s\S]*app\.pollingIntervalSeconds/);
    });
  });
});
