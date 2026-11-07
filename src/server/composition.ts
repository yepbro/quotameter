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
 *    `[single-instance-lock, storage, retention, graceful-drain,
 *    polling, http-listener]` (the documented order of `shutdown.ts`:
 *    scheduling
 *    stops first, the drain's bounded wait covers aborted cycles' actual
 *    settlement while the database is still open, storage checkpoints and
 *    closes behind it, the lock releases last). The data directory is
 *    created by the LOCK's start (D-017), so storage opens inside its own
 *    component — the repository the routes and the polling recorders
 *    receive is a lazy facade that resolves from the holder on first use
 *    and answers a clear wiring error before the app has started. The
 *    retention schedule (U-053, D-178) runs §11.3's cleanup once after
 *    migrations and then daily, reading the live retention window at each
 *    run. The
 *    polling engine (U-051, D-176) builds one scheduler over the shared
 *    clock and the shared in-flight tracker, one cycle recorder per
 *    pollable account, feeds account/interval changes through the
 *    reload wrapper, and bridges manual-test requests into the engine —
 *    D-140's polling deferral is discharged.
 *
 * Process signals stay out of here on purpose (D-140's record, discharged
 * by D-177): the composition owns the reload OPERATION — the wrapper
 * below, published on the composed result as `applyReload` and
 * `reloadOnSighup` — while `src/server/main.ts` owns
 * `process.on('SIGHUP', …)` through the D-024 readiness seam. The
 * sessions-backed `isAuthenticated` IS wired since task U-041 (D-146):
 * `createSessionAuthenticator` over the lazy repository and the shared
 * clock, beside the login/logout routes it pairs with.
 */

import { loadConfigWithEnv } from '../config/env';
import { configFilePath } from '../config/load';
import { enforceConfigPermissions } from '../config/permissions';
import { resolvePaths } from '../config/paths';
import { createConfigReloader, type ReloadResult, type ReloadSuccess } from '../config/reload';
import { ProviderRegistry, type QuotaProvider } from '../providers/registry';
import {
  createAccountSuspensions,
  keyIdentityOfSecret,
  type AccountSuspensions,
} from '../services/account-suspensions';
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
import { createConfiguredZaiProvider, observingManualTests } from './providers';
import { createPollingEngine, type PollingEngine } from './polling';
import type { PollingSleep } from '../services/polling-scheduler';
import { createRetentionSchedule } from './retention';
import type { RetentionSleep } from './retention';
import { createSingleInstanceLock } from './single-instance';
import { createGracefulDrain, createInFlightTracker } from './shutdown';

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
   * observation; defaults to v1.0's one supported provider (§8.3)
   * constructed from the live effective configuration — the §7.2 request
   * deadline re-read per request (§6.4-live, D-026/D-179), the shared clock
   * (D-021), and the shared logger. Integration tests substitute a
   * controllable double — the external boundary the no-network guard
   * requires them to own.
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
  /**
   * Overrides the polling engine's wait seam — the composition's test seam
   * for time-compressed integration tests: §7.1's 60-second interval floor
   * makes a real-time "scheduled subsequent poll" observation unfit for the
   * test gate, so the polling suite injects a scaled clock plus a sleep
   * that divides by the same factor (the `port`/`staticRoot` precedent —
   * production runs the scheduler's real abortable timer).
   */
  readonly pollingSleep?: PollingSleep;
  /**
   * Overrides the retention schedule's wait seam — the composition's test
   * seam for time-compressed integration tests: §11.3's daily cadence
   * makes a real-time "second cleanup" observation unfit for the test
   * gate, so the retention suite injects a scaled clock plus a sleep that
   * divides by the same factor (the `pollingSleep` precedent — production
   * runs the schedule's real abortable timer).
   */
  readonly retentionSleep?: RetentionSleep;
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
  /**
   * The composition-wrapped §6.4 reload — the operation behind every
   * configuration mutation (the stores' owner) and behind SIGHUP: the bare
   * reloader plus the D-128 config-sync, the D-064 key-identity reports,
   * and the D-176 polling feeds. Published since U-052 (D-177) so the
   * server runtime and tests reach the same wrapped reload the stores
   * flow through — never a bare `reloader.reload()`.
   */
  readonly applyReload: () => Promise<ReloadResult>;
  /**
   * The runtime's SIGHUP face of {@link ComposedApplication.applyReload}
   * (U-052, D-177): one fire-and-forget call that contains every fault at
   * `error` through the shared logger — a signal handler must never throw
   * synchronously and never leave an unhandled rejection. The containment
   * distinguishes the two fault worlds: a fault before the reloader adopts
   * keeps the last valid configuration effective (§6.2, D-026), while a
   * fault in the follow-up application (after adoption) is recorded as
   * what it is — the new configuration effective, storage/polling
   * possibly lagging. The §16 outcome records are the reloader's own
   * (`info` on success, `warn` on rejection); this face adds only the
   * `debug` arrival note and the fault arms.
   */
  readonly reloadOnSighup: () => void;
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

/* ── §6.4's follow-up application (the D-189 order) ────────────────────── */

/** Options of {@link createReloadFollowUps}; every member is a seam. */
export interface ReloadFollowUpsOptions {
  /** The lazy repository facade — the config-sync's mirror target. */
  readonly repository: QuotaRepository;
  /**
   * The startup environment snapshot `resolvedKeyIdentity` reads unresolved
   * `apiKeyEnv` names against (the D-023 snapshot, not the live process).
   */
  readonly env: NodeJS.ProcessEnv;
  /** The polling engine's reload feed — ordered before the report loop. */
  readonly pollingEngine: Pick<PollingEngine, 'applyReloadChanges'>;
  /** The shared D-064 store the key-identity reports land on. */
  readonly suspensions: Pick<AccountSuspensions, 'reportKeyIdentity'>;
  /** The shared clock (D-021) — the config-sync's `createdAt` stamps. */
  readonly clock: Pick<Clock, 'now'>;
}

/**
 * §6.4's follow-up application — one definition of "applying a reload",
 * extracted so its ORDER is pinned by test (FSM-3, D-189): config-sync →
 * polling-engine feed → key-identity report loop.
 *
 * The order between the last two is load-bearing on the single store: the
 * scheduler's `setAccounts` applies each kept account's identity through
 * the shared store itself and re-anchors a released account's schedule on
 * its own observation (`reportKeyIdentity`'s boolean), so the loop's
 * earlier application would pre-empt it — a report-first regression leaves
 * the release re-anchor lost while the store still releases, silently
 * resuming suspended accounts at a stale future due instead of immediately.
 * After the engine feed the loop is the idempotent no-op D-064 designed
 * `reportKeyIdentity` to be; it stays because its durable effect is for
 * accounts OUTSIDE the polled set (§7.2's "until the key changes" releases
 * a disabled account's episode too). The config-sync stays first: the
 * account row lands before any settle can write a run against it (D-069's
 * foreign-key requirement). One reload, one channel — storage rows,
 * suspension state, and the polling schedule can never disagree about one
 * configuration (D-128's pre-sync seam).
 */
export function createReloadFollowUps(
  options: ReloadFollowUpsOptions,
): (result: ReloadSuccess) => void {
  return (result) => {
    if (result.applied.includes('accounts')) {
      syncAccountsFromConfig(options.repository, result.effective.config, options.clock.now());
    }
    options.pollingEngine.applyReloadChanges(result);
    if (result.applied.includes('accounts')) {
      for (const account of result.effective.config.accounts ?? []) {
        options.suspensions.reportKeyIdentity(
          account.id,
          resolvedKeyIdentity(account, options.env),
        );
      }
    }
  };
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

  // D-064's holder — THE suspension store (FSM-3, D-189): one instance per
  // process, shared by the polling engine's dispatch gates, the status
  // routes' `suspensionOf` seam, and the manual-test observation below —
  // plus the registry and the shared in-flight tracker. The engine is
  // constructed BEFORE the adapters register: it reads the registry only
  // when its component starts (the wiring build), by which time
  // registration has happened — so the observation wrapper can bridge
  // manual-test requests into the engine from the start.
  const suspensions = createAccountSuspensions({ clock });
  const registry = new ProviderRegistry();
  const inFlight = createInFlightTracker();

  // The storage component's mutable holder plus the lazy bridge the route
  // options capture now and resolve after start.
  const storageState: { connection?: StorageConnection; repository?: QuotaRepository } = {};
  const repository = createLazyRepository(storageState);

  const now = (): number => clock.now();
  const currentConfig = (): Config => reloader.current().config;

  const pollingEngine = createPollingEngine({
    clock,
    logger,
    env,
    registry,
    suspensions,
    repository,
    config: currentConfig,
    inFlight,
    ...(options.pollingSleep === undefined ? {} : { sleep: options.pollingSleep }),
  });

  for (const provider of options.providers ?? [
    // U-054/D-179: the production default derives its §7.2 deadline from
    // the LIVE effective configuration (§6.4-live per D-026) and rides the
    // shared clock (D-021) and shared logger — not the D-052 defaults
    // factory the CLI's pre-configuration paths use.
    createConfiguredZaiProvider({ config: currentConfig, clock, logger }),
  ]) {
    registry.register(
      observingManualTests(provider, {
        suspensions,
        onManualTestRequested: pollingEngine.requestManualTest,
        onManualTestRejected: pollingEngine.manualTestRejected,
      }),
    );
  }

  // §6.4's application for every API-driven mutation: the reload itself,
  // then the shared follow-up applier below. The stores never call the bare
  // reloader — the mirror would lag a write otherwise.
  const applyReloadFollowUps = createReloadFollowUps({
    repository,
    env,
    pollingEngine,
    suspensions,
    clock,
  });

  const applyReload = async (): Promise<ReloadResult> => {
    const result = await reloader.reload();
    if (result.ok) applyReloadFollowUps(result);
    return result;
  };

  /**
   * The runtime's SIGHUP face (U-052, D-177): the same reload the stores
   * flow through, fired once and fire-and-forget, with every fault
   * contained at `error`. The containment distinguishes the two fault
   * worlds, whose consequences are OPPOSITE: a fault before the reloader
   * adopts (an injected dependency inside the load pipeline) keeps the
   * last valid configuration effective (D-026's contract), while a fault
   * in the follow-up application happens AFTER the adoption — the new
   * configuration is already effective and storage rows or the polling
   * wiring may lag it, which the record must not misreport as "kept the
   * old one". A rejected configuration is neither: the reloader answers
   * it as the `rejected` result with its own §16 `warn` record, and the
   * follow-ups never run.
   */
  const reloadOnSighup = (): void => {
    void (async (): Promise<void> => {
      logger.debug('reloading configuration (SIGHUP)');
      const result = await reloader.reload();
      if (!result.ok) return;
      try {
        applyReloadFollowUps(result);
      } catch (error) {
        logger.error(
          'configuration reload applied but its follow-up application failed; ' +
            'storage and polling may lag the effective configuration',
          { error },
        );
      }
    })().catch((error: unknown) => {
      logger.error('configuration reload failed; keeping the last valid configuration', {
        error,
      });
    });
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

  // §5.6 component 3: the retention schedule (U-053, D-178) — §11.3's
  // cleanup once after storage has opened and migrated, then daily over
  // the shared clock. Registered directly after storage so the startup
  // run meets the final schema and the teardown cancels the daily wait
  // before the database closes (the cleanup itself is synchronous, so it
  // can never interleave with the close). Reload-aware by read-at-run-time:
  // each run takes the live `historyRetentionDays` (§6.4), per §11.3's own
  // "removed at the next cleanup" application point.
  const retention = createRetentionSchedule({
    clock,
    logger,
    config: currentConfig,
    repository,
    storage: () => storageState.connection,
    ...(options.retentionSleep === undefined ? {} : { sleep: options.retentionSleep }),
  });

  // §5.6 component 4: the graceful drain (task 075, D-020) — a passive
  // component until shutdown, when (after the scheduler and the listener
  // have stopped) it waits — bounded at §5.6's ten seconds — for the
  // in-flight polling work the scheduler registered in the shared tracker,
  // so an aborted cycle's settlement races no database close.
  const gracefulDrain = createGracefulDrain({
    inFlight,
    onEvent: (event) => {
      if (event.type === 'drain-timeout') {
        logger.warn('graceful drain timed out with polling work still in flight', {
          inFlight: event.inFlight,
          timeoutMs: event.timeoutMs,
        });
        return;
      }
      logger.debug('graceful drain', { ...event });
    },
  });

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

  // §5.6's order (the `shutdown.ts` docblock's documented list): the lock,
  // storage, the retention schedule, the drain, the polling engine, the
  // listener — so teardown is listener → engine (stop scheduling, abort
  // flights) → drain (bounded settlement wait, database still open) →
  // retention (cancel the daily cleanup wait) → storage (checkpoint,
  // close) → lock.
  const components: readonly LifecycleComponent[] = [
    lock,
    storage,
    retention.component,
    gracefulDrain,
    pollingEngine.component,
    httpServer,
  ];
  return { components, httpServer, repository, applyReload, reloadOnSighup };
}
