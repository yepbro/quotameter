/**
 * The polling engine composition (spec §7.1, §7.2, §5.6, §6.4; task U-051,
 * decision D-176 — the successor to D-140's recorded deferral).
 *
 * This module is the lifecycle-shaped wiring between the landed §7 engines
 * and the running service: {@link createPollingEngine} builds one
 * {@link PollingScheduler} (D-066) over the shared clock (D-021) and the
 * shared in-flight tracker (D-020 — the graceful drain waits on it), plus
 * one {@link CycleRecorder} (D-069) per pollable account, and exposes them
 * as the §5.6 `polling` component registered in the documented order
 * `[lock, storage, retention, graceful-drain, polling, http]`: startup opens storage
 * before the first cycle can settle, and shutdown stops scheduling
 * (aborting live flights) before the drain's bounded wait, so an aborted
 * cycle's settlement — which D-069 deliberately leaves unpersisted — races
 * no database close.
 *
 * Which accounts poll: the configured set filtered to accounts that are
 * `enabled`, whose secret RESOLVES (`apiKey`, or `apiKeyEnv` naming a
 * variable the startup environment provides — §6.3), and whose provider is
 * registered (§8.1). §7.3 owns the display of the excluded states
 * (`Disabled`, `Not configured`); §7.2's isolation owns the exclusion's
 * shape — one unresolvable or foreign account is skipped (logged), never
 * allowed to stop the others or the startup. Secrets resolve into the
 * registry's branded `AccountContext` (non-enumerable, D-013) and never
 * reach a log line.
 *
 * The D-064 seam, closed per D-140's plan and unified by FSM-3 (D-189): the
 * composition's {@link AccountSuspensions} holder is THE suspension store —
 * the same instance is injected here (and forwarded to the scheduler), read
 * by `/api/status` through `suspensionOf`, and fed by the manual-test
 * observation. The engine's dispatch gates read and write that one store
 * (its settle path applies every non-stale cycle outcome to it, behind its
 * own mid-flight staleness rule: an outcome whose flight's wiring was
 * removed or re-keyed is discarded), so a polled 401 shows `Auth rejected`
 * even after a later inconclusive probe run (the §7.3 no-downgrade rule
 * D-064 pinned) and a polled success lifts the pause — with no second
 * machine to keep in step. An account that leaves the polled set drops its
 * episode through the engine's own `setAccounts` diff. The manual-test half
 * rides the observation wrapper's bridges into {@link
 * PollingScheduler.requestManualTest} and {@link
 * PollingScheduler.manualTestRejected}: the engine releases and owes one
 * attempt on the request, and drops the owed attempt when the provider
 * refuses the key (the re-entry itself is the wrapper's application to the
 * store) — §7.2's pause holds on both sides of a manual test, and the
 * sequential and overlap rules of D-066 hold for every owed attempt.
 *
 * §6.4 reloads arrive through {@link PollingEngine.applyReloadChanges} —
 * the composition's `applyReload` calls it beside the D-128 config-sync, so
 * an account mutation and its polling consequence can never diverge: an
 * `accounts` change rebuilds the wiring (the engine diffs: an added account
 * polls immediately, a removed or disabled one drops out, a re-keyed one
 * releases and is immediately due), and a `pollingIntervalSeconds` change
 * re-anchors every not-suspended account (§7.1's floor re-validated by the
 * engine itself).
 */

import type { ReloadSuccess } from '../config/reload';
import { createAccountContext, type ProviderRegistry } from '../providers/registry';
import { keyIdentityOfSecret, type AccountSuspensions } from '../services/account-suspensions';
import type { CycleOutcome } from '../services/polling-outcomes';
import {
  createCycleRecorder,
  type CycleRecorder,
  type CycleRecorderOptions,
} from '../services/polling-persist';
import type { CycleRetryResult } from '../services/polling-retry';
import {
  createPollingScheduler,
  type PollingAccount,
  type PollingScheduler,
  type PollingSchedulerOptions,
  type PollingSleep,
} from '../services/polling-scheduler';
import { CONFIG_DEFAULTS, type AccountConfig, type Config } from '../schemas/config';
import type { QuotaRepository } from '../storage/repository';
import type { Clock } from '../util/clock';
import type { Logger } from '../util/logger';
import type { LifecycleComponent } from './app';
import type { InFlightTracker } from './shutdown';

/* ── Options and the engine ─────────────────────────────────────────────── */

/** Options of {@link createPollingEngine}; every member is an injection seam. */
export interface PollingEngineOptions {
  /** The shared clock (D-021) — one instance across the whole application. */
  readonly clock: Clock;
  /** The redacting logger (§16) — skip reasons and lifecycle records; never secrets. */
  readonly logger: Logger;
  /**
   * The startup environment snapshot `apiKeyEnv` names resolve against —
   * the same snapshot the reloader judges reloads by (D-023), so a polled
   * secret and `secretOf` never disagree.
   */
  readonly env: NodeJS.ProcessEnv;
  /** The registry the wiring resolves each account's adapter through (§8.1). */
  readonly registry: ProviderRegistry;
  /**
   * The D-064 suspension store (FSM-3, D-189) — the ONE holder the
   * composition wires: forwarded to the scheduler (whose dispatch gates
   * read/write it), read by the status routes (`suspensionOf`), and fed by
   * the manual-test observation. One instance per process per account.
   */
  readonly suspensions: AccountSuspensions;
  /**
   * The repository the recorders settle through — the composition's lazy
   * facade is fine: a recorder first touches storage at settle time, which
   * only happens after the storage component has started.
   */
  readonly repository: QuotaRepository;
  /** The live effective configuration (the reloader's `current().config`). */
  readonly config: () => Config;
  /** D-020's tracker, shared with the graceful-drain component. */
  readonly inFlight: InFlightTracker;
  /**
   * The engine's wait seam, passed through to the scheduler — the
   * composition's test seam for time-compressed integration tests (§7.1's
   * 60 s floor makes a real-time second poll unfit for the test gate);
   * absent means the scheduler's real abortable timer.
   */
  readonly sleep?: PollingSleep;
  /**
   * The cycle-recorder constructor — the unit-test seam beside
   * `schedulerFactory` (a double recorder pins the settle wrapper's holder
   * feed without persistence); defaults to the production
   * {@link createCycleRecorder}.
   */
  readonly recorderFactory?: (options: CycleRecorderOptions) => CycleRecorder;
  /**
   * The scheduler constructor — the unit-test seam (a spy scheduler pins
   * the delegation contract); defaults to the production
   * {@link createPollingScheduler}.
   */
  readonly schedulerFactory?: (options: PollingSchedulerOptions) => PollingScheduler;
}

/** The assembled polling engine {@link createPollingEngine} returns. */
export interface PollingEngine {
  /** The §5.6 lifecycle component — register between the drain and the listener. */
  readonly component: LifecycleComponent;
  /**
   * §6.4's feed from the composition's reload wrapper (beside the D-128
   * config-sync). A no-op before the component has started — `start` reads
   * the current configuration itself, and no reload can precede it (the
   * listener starts last).
   */
  applyReloadChanges(result: ReloadSuccess): void;
  /**
   * The manual-test bridge (§7.2): applies the D-064 release through the
   * shared store (the idempotent no-op after the observation wrapper's own
   * application) and owes the account one attempt through the dispatch
   * loop. Wired from the observation wrapper's `onManualTestRequested`.
   */
  requestManualTest(accountId: string): void;
  /**
   * The rejection half of the bridge (§7.2): a manual test refused the key;
   * the D-064 re-entry is the observation wrapper's single application to
   * the shared store (under the tested key's identity) — this engine-side
   * half drops any still-owed manual attempt, leaving the next attempt to
   * the probe cadence. Wired from the observation wrapper's
   * `onManualTestRejected`.
   */
  manualTestRejected(accountId: string): void;
}

/* ── Secret resolution (§6.3 — the store's `secretOf` vocabulary) ───────── */

/**
 * Resolves one configured account's secret: the file value, or the
 * `apiKeyEnv` variable read against the startup environment snapshot (an
 * unset or empty name resolves nothing — the D-011 empty-is-unset rule). A
 * trim-blank value resolves nothing either: the configuration schema admits
 * any non-empty string, but the registry's context construction rejects
 * blank-after-trim secrets — the wiring must skip such an account (the
 * documented never-throw selection), never abort startup over it.
 */
function resolveSecret(account: AccountConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (account.apiKey !== undefined && account.apiKey.trim() !== '') return account.apiKey;
  if (account.apiKeyEnv !== undefined) {
    const value = env[account.apiKeyEnv];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** The live §7.1 interval in seconds — the recorder's settle-time reader. */
function intervalSecondsOf(config: () => Config): () => number {
  return () => config().app.pollingIntervalSeconds ?? CONFIG_DEFAULTS.app.pollingIntervalSeconds;
}

/* ── The engine ─────────────────────────────────────────────────────────── */

/**
 * Creates the polling engine. The scheduler is constructed eagerly (inert
 * until the component starts); the account wiring is (re)built from the
 * live configuration at every start and every `accounts`-applied reload.
 */
export function createPollingEngine(options: PollingEngineOptions): PollingEngine {
  const { clock, logger, env, registry, suspensions, repository, config, inFlight } = options;
  const createRecorder = options.recorderFactory ?? createCycleRecorder;
  const intervalMsOf = (current: Config): number =>
    (current.app.pollingIntervalSeconds ?? CONFIG_DEFAULTS.app.pollingIntervalSeconds) * 1000;

  const scheduler = (options.schedulerFactory ?? createPollingScheduler)({
    intervalMs: intervalMsOf(config()),
    clock,
    suspensions,
    inFlight,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  let started = false;

  /**
   * Wraps one recorder's settle seam with the server's diagnostics channel
   * (D-066 deferred the engine's contained-failure visibility to this
   * wiring): a throwing settlement is logged before the engine's own §7.2
   * containment reschedules the account on the plain interval. The D-064
   * feed is NOT here — the engine's settle path applies every non-stale
   * outcome to the shared store itself (one application, one holder).
   */
  const settleWithDiagnostics =
    (
      accountId: string,
      recorder: CycleRecorder,
    ): ((result: CycleRetryResult<unknown>) => CycleOutcome) =>
    (result) => {
      try {
        return recorder.settleCycle(result);
      } catch (error) {
        logger.warn('polling: cycle settlement failed; the failure is contained', {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

  /**
   * Builds the pollable wiring from a configuration: the enabled,
   * secret-resolvable, registered accounts. Skips are logged with their
   * reason (never their secret); the pollable count rides the caller's
   * lifecycle record. Accounts that LEFT the polled set (removed,
   * disabled, key lost) drop their D-064 episode through the engine's own
   * `setAccounts` diff (the shared store's drop beside the dropped entry)
   * — suspension is process memory (D-064's restart consequence), so a
   * disable/re-enable or remove/re-add cycle starts the machine fresh and
   * the D-070 run-evidence arm covers the display for the first
   * post-return cycle.
   */
  const buildWiring = (current: Config): PollingAccount[] => {
    const wiring: PollingAccount[] = [];
    for (const account of current.accounts ?? []) {
      const skip = (level: 'debug' | 'warn', reason: string): void => {
        logger[level](`polling: account '${account.id}' is not polled (${reason})`, {
          accountId: account.id,
          reason,
        });
      };
      if (account.enabled === false) {
        skip('debug', 'disabled');
        continue;
      }
      if (account.label.trim() === '') {
        // Schema-valid (minLength 1) but rejected by the context gate — the
        // never-throw selection skips it instead of aborting startup.
        skip('debug', 'blank label');
        continue;
      }
      const secret = resolveSecret(account, env);
      if (secret === undefined) {
        skip('debug', 'no resolved secret');
        continue;
      }
      if (!registry.has(account.providerId)) {
        // A schema-valid configuration may name an adapter this build lacks
        // (§8.2); the doctor reports it (D-119) — polling skips it.
        skip('warn', `unknown provider '${account.providerId}'`);
        continue;
      }
      const keyIdentity = keyIdentityOfSecret(secret);
      const recorder = createRecorder({
        account: createAccountContext(account.id, account.label, secret),
        provider: registry.get(account.providerId),
        repository,
        clock,
        intervalSeconds: intervalSecondsOf(config),
      });
      wiring.push({
        accountId: account.id,
        keyIdentity,
        attempt: recorder.attempt,
        settleCycle: settleWithDiagnostics(account.id, recorder),
        abandonCycle: recorder.abandonCycle,
      });
    }
    return wiring;
  };

  const component: LifecycleComponent = {
    name: 'polling',
    async start() {
      // §7.1: the first collection runs immediately after startup — the
      // wiring lands before the loop starts, so the fresh entries' immediate
      // dues carry into the first dispatch pass (D-066).
      const wiring = buildWiring(config());
      scheduler.setAccounts(wiring);
      scheduler.start();
      started = true;
      logger.info('polling engine started', { accounts: wiring.length });
    },
    async stop() {
      // Prompt by D-066's design: the loop exits, live flights are aborted
      // (their settlement — deliberately unpersisted, D-069 — is waited on
      // by the graceful drain through the shared tracker, while storage is
      // still open by registration order). A retained loop error rethrows
      // here: the app aggregates it but still closes storage and the lock.
      await scheduler.stop();
      logger.info('polling engine stopped');
    },
  };

  return {
    component,
    applyReloadChanges(result) {
      if (!started) return;
      // §6.4's live vocabulary drives exactly two feeds; the engine's own
      // diff decides the consequences (immediate polls, drops, releases,
      // re-anchoring).
      if (result.applied.includes('accounts')) {
        scheduler.setAccounts(buildWiring(result.effective.config));
      }
      if (result.applied.includes('app.pollingIntervalSeconds')) {
        scheduler.setIntervalMs(intervalMsOf(result.effective.config));
      }
    },
    requestManualTest(accountId) {
      scheduler.requestManualTest(accountId);
    },
    manualTestRejected(accountId) {
      scheduler.manualTestRejected(accountId);
    },
  };
}
