/**
 * The application composition root (spec §5.6, §6.2–§6.4, §13, §7.2; task
 * U-040, decision D-140).
 *
 * This module is the assembly point the task-060 shell always anticipated:
 * it owns the startup order the spec fixes and the seams the landed route
 * families defined at their consumers (D-121's auth projection, D-128's
 * `AccountConfigStore`, D-130's `SettingsStore`, D-139's history options,
 * D-142's peak-hours options).
 * The sequence, each step refusing loudly when its contract is broken:
 *
 * 1. resolve the §6.1 directories from the environment snapshot;
 * 2. enforce the §6.3 permissions EAGERLY, before the file's content is
 *    ever read (an unverified secret-bearing file must not be parsed);
 * 3. load and validate through `loadConfigWithEnv` — §6.2's
 *    refuse-to-start on problems (the caller, `runServer`, reports and
 *    exits 1);
 * 4. build the shared clock (D-021: one instance, injected everywhere) and
 *    the redacting logger (§16 level from the configuration, the startup
 *    account keys pre-registered as known secret values — §15.4
 *    defense-in-depth);
 * 5. construct the reloader (D-026) from the successful load, the §7.2
 *    suspension holder (D-064), and the provider registry (§8.1) with each
 *    adapter wrapped for manual-test observation;
 * 6. assemble the components in §5.6's startup dependency order —
 *    `[single-instance-lock, storage, http-listener]` (the graceful drain
 *    and the polling engine register between storage and http when their
 *    tasks land; the holder is the suspension seam the engine will take
 *    over). The data directory is created by the LOCK's start (D-017), so
 *    storage opens inside its own component — the repository the routes
 *    receive is a lazy facade that resolves from the holder on first use
 *    and answers a clear wiring error before the app has started.
 *
 * Not wired here, on purpose (D-140 records them): SIGHUP → reload (the
 * D-024 readiness seam owns process-signal wiring) and the polling
 * engine itself (its task owns polled-cycle dispatch; manual tests and
 * status reads keep working through this holder meanwhile). The
 * sessions-backed `isAuthenticated` IS wired since task U-041 (D-146):
 * `createSessionAuthenticator` over the lazy repository and the shared
 * clock, beside the login/logout routes it pairs with.
 */

import { loadConfigWithEnv } from '../config/env';
import { configFilePath } from '../config/load';
import { enforceConfigPermissions } from '../config/permissions';
import { resolvePaths } from '../config/paths';
import { createConfigReloader, type ReloadResult } from '../config/reload';
import { ProviderRegistry, type QuotaProvider } from '../providers/registry';
import { createAccountSuspensions, keyIdentityOfSecret } from '../services/account-suspensions';
import { MIGRATIONS } from '../storage/migrations';
import { runStorageMaintenance } from '../storage/maintenance';
import { createQuotaRepository, type QuotaRepository } from '../storage/repository';
import { runStartupMigrations } from '../storage/startup-migrations';
import { openStorageConnection, type StorageConnection } from '../storage/connection';
import { CONFIG_DEFAULTS, type AccountConfig, type Config } from '../schemas/config';
import { createSystemClock, type Clock } from '../util/clock';
import { createLogger, type Logger } from '../util/logger';
import type { LifecycleComponent } from './app';
import { createSessionAuthenticator } from './api/auth-routes';
import {
  createConfigFileAccountStore,
  createConfigFileOwner,
  createConfigFileSettingsStore,
} from './config-stores';
import {
  type HttpServerComponent,
  createHttpServerComponent,
  type HttpServerOptions,
} from './http';
import { createInitialAccountProvider, observingManualTests } from './providers';
import { createSingleInstanceLock } from './single-instance';

/* ── Inputs and results ─────────────────────────────────────────────────── */

/** Options of {@link composeApplication}; every member is an injection seam. */
export interface ComposeApplicationOptions {
  /**
   * Environment snapshot the §6.1 directories and the D-023 overrides read
   * from; defaults to `process.env`. Tests inject a literal with
   * `QUOTAMETER_CONFIG_DIR`/`QUOTAMETER_DATA_DIR` pointing at temp
   * directories — the same channel production operators use.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** The shared clock (D-021); defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * The redacting logger; defaults to one built from the configuration's
   * §16 level with the startup account keys as known secret values.
   */
  readonly logger?: Logger;
  /**
   * The provider adapters to register, each wrapped for manual-test
   * observation; defaults to v1.0's one supported provider (§8.3) with its
   * production defaults. Integration tests substitute a controllable double
   * — the external boundary the no-network guard requires them to own.
   */
  readonly providers?: readonly QuotaProvider[];
  /**
   * Overrides the configured `server.port` — the composition's test seam
   * for ephemeral binds (`0`), which the configuration schema itself
   * (minimum 1) deliberately cannot express.
   */
  readonly port?: number;
  /**
   * Overrides the served built-UI directory — the composition's test seam
   * for environments whose frontend build lands outside the package tree
   * (the container `DIST_DIR` volume; spec §14.1's `ui/dist` stays the
   * production default the listener resolves on its own).
   */
  readonly staticRoot?: string;
}

/** The assembled application {@link composeApplication} returns. */
export interface ComposedApplication {
  /** Components in §5.6 startup dependency order (stop runs reversed). */
  readonly components: readonly LifecycleComponent[];
  /** The HTTP listener component — `server` is the injection surface. */
  readonly httpServer: HttpServerComponent;
  /**
   * The storage facade the routes serve from (the lazy bridge over the
   * holder; resolves once the storage component has started).
   */
  readonly repository: QuotaRepository;
}

/* ── The config-sync (D-128's pre-sync gap) ─────────────────────────────── */

/**
 * The opaque D-064 identity of one configured account's key, in the same
 * vocabulary {@link keyIdentityOfSecret} gives the manual-test observation:
 * the resolved secret's SHA-256 — with a distinct per-source identity when
 * no value resolves (`apiKeyEnv` unset in this environment, or the §5.3
 * keyless skip path), because "the key changed to something else" is a
 * release either way.
 */
function resolvedKeyIdentity(account: AccountConfig, env: NodeJS.ProcessEnv): string {
  if (account.apiKey !== undefined) return keyIdentityOfSecret(account.apiKey);
  if (account.apiKeyEnv !== undefined) {
    const value = env[account.apiKeyEnv];
    if (typeof value === 'string' && value !== '') return keyIdentityOfSecret(value);
    return keyIdentityOfSecret(`unresolved:${account.apiKeyEnv}`);
  }
  return keyIdentityOfSecret('unresolved:none');
}

/**
 * Mirrors the configured accounts into storage rows: a configured account
 * without a row gets one (createdAt from the shared clock), label drift is
 * copied into the row's denormalized mirror, and an archived row is never
 * touched — §8.2's archive is terminal (D-061), so re-adding an archived id
 * by hand-editing the file does not resurrect it. Rows without a configured
 * entry (archived accounts, §8.2-retained history) keep their history.
 */
function syncAccountsFromConfig(
  repository: QuotaRepository,
  config: Config,
  createdAt: number,
): void {
  for (const account of config.accounts ?? []) {
    const record = repository.getAccount(account.id);
    if (record === null) {
      repository.insertAccount({
        id: account.id,
        providerId: account.providerId,
        label: account.label,
        createdAt,
      });
      continue;
    }
    if (record.status === 'archived') continue;
    if (record.label !== account.label) {
      repository.updateAccountDetails(account.id, { label: account.label });
    }
  }
}

/* ── The lazy repository bridge ─────────────────────────────────────────── */

/**
 * The repository the route families receive at registration time. The data
 * directory does not exist until the lock's `start` creates it (D-017), so
 * the connection and repository can only open inside the storage component
 * — after the lock, per §5.6's order — while route registration is eager.
 * The facade resolves the real facade on first use; before the app has
 * started it answers a clear wiring error instead of a stale handle.
 * Requests only flow once the listener is up, i.e. after every component
 * has started.
 */
function createLazyRepository(holder: { repository?: QuotaRepository }): QuotaRepository {
  return new Proxy({} as QuotaRepository, {
    get(_target, property) {
      const repository = holder.repository;
      if (repository === undefined) {
        throw new Error(
          'storage is not started: the repository becomes available when the storage ' +
            'component starts (a request before that is a wiring bug)',
        );
      }
      const value = Reflect.get(repository, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(repository)
        : value;
    },
  });
}

/* ── The composition ────────────────────────────────────────────────────── */

/**
 * Assembles the running application from the resolved environment: loads
 * and validates the configuration (refusing to start on problems, §6.2),
 * builds the shared services and stores, and returns the §5.6 component
 * list with the HTTP listener wired to every landed route family.
 */
export async function composeApplication(
  options: ComposeApplicationOptions = {},
): Promise<ComposedApplication> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? createSystemClock();
  const paths = resolvePaths(env);
  const targetPath = configFilePath(paths.configDir);

  // §6.3, eagerly and before the load: verify (and where possible fix) the
  // configuration directory's `0700` and the file's `0600` — the loader
  // must not read a secret-bearing file the permissions have not vetted.
  await enforceConfigPermissions({ configDir: paths.configDir, configFile: targetPath });

  // §6.2: an invalid startup configuration refuses to start, with the
  // pipeline's field-addressed, value-free problems as the explanation.
  const loaded = await loadConfigWithEnv(targetPath, env);
  if (!loaded.ok) {
    throw new Error(`refusing to start: invalid configuration:\n- ${loaded.problems.join('\n- ')}`);
  }
  const config = loaded.config;

  // §16's level; the startup accounts' RESOLVED keys (file values and
  // `apiKeyEnv` reads alike — both are process-memory secrets) join the
  // logger's known secret values (§15.4 defense-in-depth — keys added at
  // runtime after this point rely on the structural no-leak guards of the
  // route contracts, recorded as D-140's residual).
  const startupSecrets = (config.accounts ?? []).flatMap((account) => {
    if (account.apiKey !== undefined) return [account.apiKey];
    if (account.apiKeyEnv !== undefined) {
      const value = env[account.apiKeyEnv];
      if (typeof value === 'string' && value !== '') return [value];
    }
    return [];
  });
  const logger =
    options.logger ??
    createLogger({
      level: config.logging?.level ?? CONFIG_DEFAULTS.logging.level,
      secrets: startupSecrets,
    });

  // D-026's reloader: the effective-configuration holder and §6.4's
  // application, judged against the startup environment snapshot.
  const reloader = createConfigReloader({
    initial: { config: loaded.config, sources: loaded.sources, fileAbsent: loaded.fileAbsent },
    targetPath,
    env,
    logger,
  });

  // D-064's holder and the registry with observation-wrapped adapters.
  const suspensions = createAccountSuspensions({ clock });
  const registry = new ProviderRegistry();
  for (const provider of options.providers ?? [createInitialAccountProvider()]) {
    registry.register(observingManualTests(provider, { suspensions }));
  }

  // The storage component's mutable holder plus the lazy bridge the route
  // options capture now and resolve after start.
  const storageState: { connection?: StorageConnection; repository?: QuotaRepository } = {};
  const repository = createLazyRepository(storageState);

  // §6.4's application for every API-driven mutation: the reload itself,
  // then the config-sync whenever the account list changed. The stores
  // never call the bare reloader — the mirror would lag a write otherwise.
  // §7.2's second release condition rides the same observation: every
  // configured account's current key identity is reported (idempotent by
  // D-064's design), so a key rotation releases an episode that began under
  // the old key even with no polling engine in the composition.
  const applyReload = async (): Promise<ReloadResult> => {
    const result = await reloader.reload();
    if (result.ok && result.applied.includes('accounts')) {
      syncAccountsFromConfig(repository, result.effective.config, clock.now());
      for (const account of result.effective.config.accounts ?? []) {
        suspensions.reportKeyIdentity(account.id, resolvedKeyIdentity(account, env));
      }
    }
    return result;
  };

  // The two configuration stores over one serialized file owner.
  const owner = createConfigFileOwner({
    targetPath,
    env,
    effective: () => reloader.current(),
    reload: applyReload,
    logger,
  });
  const accountStore = createConfigFileAccountStore(owner);
  const settingsStore = createConfigFileSettingsStore(owner, {
    repository,
    dataDir: paths.dataDir,
  });

  const now = (): number => clock.now();
  const currentConfig = (): Config => reloader.current().config;

  // §5.6 component 1: the single-instance lock — creates the data directory
  // and refuses a second process on it (D-017).
  const lock = createSingleInstanceLock({ dataDir: paths.dataDir });

  // §5.6 component 2: storage — open, migrate (§11.4's backup-protected
  // sequence), build the repository, and run the startup config-sync. A
  // failure anywhere after the open closes the connection again: `stop`
  // only runs for a component that started, so `start` must not leak the
  // handle it opened on its own failure path.
  const storage: LifecycleComponent = {
    name: 'storage',
    async start() {
      const connection = openStorageConnection({ dataDir: paths.dataDir });
      try {
        await runStartupMigrations({
          database: connection.database,
          dataDir: paths.dataDir,
          migrations: MIGRATIONS,
          clock,
        });
        const repositoryNow = createQuotaRepository({ database: connection.database });
        syncAccountsFromConfig(repositoryNow, reloader.current().config, clock.now());
        storageState.connection = connection;
        storageState.repository = repositoryNow;
      } catch (error) {
        connection.close();
        throw error;
      }
    },
    async stop() {
      const connection = storageState.connection;
      if (connection === undefined) return;
      // Cleared only once the release is attempted: a throwing checkpoint
      // must leave the component retryable (U-018's contract — the app's
      // `stop()` from `'failed'` re-calls exactly the failed component), so
      // the handle stays addressable until close() actually ran.
      try {
        // §5.6: checkpoint WAL on the way down, then close (idempotent close
        // is the connection wrapper's own contract).
        runStorageMaintenance(connection.database);
      } finally {
        storageState.connection = undefined;
        storageState.repository = undefined;
        connection.close();
      }
    },
  };

  // §5.6's last component: the HTTP listener with every landed route family
  // wired (the `auth` projection is D-121's documented 1:1 mapping; the
  // sessions-backed `isAuthenticated` is D-146's wiring — the §15.1 seam
  // finally sees `authenticateSession`'s verdict, so protected routes
  // enforce sessions behind it, and the login/logout routes answer through
  // the same lazy repository and shared clock).
  const httpServer = createHttpServerComponent({
    host: config.server?.host ?? CONFIG_DEFAULTS.server.host,
    port: options.port ?? config.server?.port ?? CONFIG_DEFAULTS.server.port,
    ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot }),
    auth: {
      mode: config.auth?.mode ?? CONFIG_DEFAULTS.auth.mode,
      passwordConfigured: () => reloader.current().config.auth?.passwordHash !== undefined,
      isAuthenticated: createSessionAuthenticator({ repository, now }),
    },
    logger,
    routes: {
      accounts: { store: accountStore, repository, registry, now },
      status: {
        store: accountStore,
        repository,
        pollingIntervalSeconds: () =>
          currentConfig().app.pollingIntervalSeconds ?? CONFIG_DEFAULTS.app.pollingIntervalSeconds,
        suspensionOf: (accountId) => suspensions.suspensionOf(accountId),
        now,
      },
      providers: {
        registry,
        schedules: () => currentConfig().providers ?? {},
      },
      settings: { store: settingsStore },
      history: {
        store: accountStore,
        repository,
        historyRetentionDays: () =>
          currentConfig().app.historyRetentionDays ?? CONFIG_DEFAULTS.app.historyRetentionDays,
        now,
      },
      peakHours: {
        store: accountStore,
        repository,
        schedules: () => currentConfig().providers ?? {},
        historyRetentionDays: () =>
          currentConfig().app.historyRetentionDays ?? CONFIG_DEFAULTS.app.historyRetentionDays,
        now,
      },
      authRoutes: {
        repository,
        // §6.4/D-026: the hash is live — a `passwd` run or a settings PUT
        // that changes it applies to the next login attempt, no restart.
        passwordHash: () => reloader.current().config.auth?.passwordHash,
        now,
      },
    },
  } satisfies HttpServerOptions);

  const components: readonly LifecycleComponent[] = [lock, storage, httpServer];
  return { components, httpServer, repository };
}
