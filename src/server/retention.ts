/**
 * The retention cleanup schedule (spec §11.3, §5.6, §6.4, §16; task U-053,
 * decision D-178).
 *
 * D-063 fixed the boundary this module completes: `runRetentionCleanup` is
 * §11.3's operation — one repeat-safe call over writer-supplied time and
 * window — while "when this runs (startup and daily)" was recorded as the
 * server lifecycle's concern. This module IS that concern, in the shape
 * U-051 established for a lifecycle component feeding from live
 * configuration (`src/server/polling.ts`, D-176):
 * {@link createRetentionSchedule} returns the §5.6 `retention`
 * {@link LifecycleComponent}, registered in the documented order as
 * `[lock, storage, retention, graceful-drain, polling, http-listener]`:
 *
 * - **Startup runs strictly after migrations.** Storage opens, migrates
 *   (§11.4's backup-protected sequence), and completes its config-sync
 *   before this component starts — registration order is startup
 *   dependency order — so the startup cleanup can never meet a database
 *   without its final schema (or delete through anything but the final
 *   cascade graph).
 * - **Teardown cancels the schedule before the database closes.** Reverse
 *   order is `http → polling → drain → retention → storage → lock`: the
 *   daily wait is aborted first, and since the cleanup itself is a
 *   synchronous call, a run can never interleave with the close — the
 *   single-threaded containment needs no in-flight tracker (the cleanup
 *   registers nothing in D-020's tracker by design: it holds no await
 *   between opening its transaction and finishing it).
 *
 * The cadence (D-178): one run at `start()`, then one fixed-duration
 * `DAY_MS` wait re-armed after each completed run — a Node timer is
 * monotonic by construction, so a wall-clock step can neither stall the
 * cadence into never firing nor double-fire it, and wall time enters only
 * as each run's cleanup `now`, read once from the shared clock (D-021).
 * "Daily" is 24 hours after the previous RUN, not zone-aligned midnight:
 * §11.3 names no alignment, and a duration cadence is the one reading
 * with no zone, no DST case, and no drift question to answer.
 *
 * §6.4 reload-awareness is read-at-run-time, deliberately not a reload
 * feed: each run reads the live effective configuration's
 * `app.historyRetentionDays` (the value in force at run time), and §11.3's
 * own reduce-retention sentence — "older records will be removed at the
 * NEXT cleanup" — fixes the application point at the next scheduled run.
 * A retention change therefore takes effect without a restart (§6.4) and
 * without any re-anchoring: the schedule is window-independent.
 *
 * Fault containment (§16, the D-066/polling-settlement precedent): a
 * failed run — startup or daily — is one `warn` record ("contained; the
 * next scheduled run retries") and never rejects `start`, never kills the
 * schedule, and never touches other components. D-063's repeat-safety is
 * what makes the retry the same cleanup over the same rows. A successful
 * run is one `info` record with the removal counts — a §16
 * lifecycle-class event beside migrations and reloads. Storage not being
 * open at run time (a wiring bug — the schedule is dead before storage
 * stops, by teardown order) skips with a `warn` and touches nothing.
 */

import { CONFIG_DEFAULTS, type Config } from '../schemas/config';
import type { StorageConnection } from '../storage/connection';
import type { QuotaRepository } from '../storage/repository';
import {
  runRetentionCleanup,
  type RetentionCleanupInput,
  type RetentionCleanupOptions,
  type RetentionCleanupReport,
} from '../storage/retention-cleanup';
import { DAY_MS } from '../util/rolling-ranges';
import type { Clock } from '../util/clock';
import type { Logger } from '../util/logger';
import type { LifecycleComponent } from './app';

/* ── Options and seams ──────────────────────────────────────────────────── */

/**
 * The schedule's wait seam — the abortable-timer contract the polling
 * scheduler's default sleep also holds: resolve after `ms` milliseconds,
 * reject when `signal` aborts (with {@link RetentionWaitAbortedError}).
 * The composition's `retentionSleep` test seam injects a time-compressed
 * implementation (the `pollingSleep` precedent): §11.3's daily cadence
 * makes a real-time "second cleanup" observation unfit for the test gate.
 */
export type RetentionSleep = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

/** Rejects the wait seam's pending sleep on {@link RetentionSchedule.stop}. */
class RetentionWaitAbortedError extends Error {
  constructor() {
    super('retention schedule wait aborted');
    this.name = 'RetentionWaitAbortedError';
  }
}

/** Options of {@link createRetentionSchedule}; every member is an injection seam. */
export interface RetentionScheduleOptions {
  /** The shared clock (D-021) — one instance across the whole application. */
  readonly clock: Clock;
  /** The redacting logger (§16) — lifecycle records and contained faults. */
  readonly logger: Logger;
  /**
   * The live effective configuration (the reloader's `current().config`) —
   * each run reads `app.historyRetentionDays` at run time (§6.4).
   */
  readonly config: () => Config;
  /**
   * The repository the cleanup deletes through — the composition's lazy
   * facade is fine: a run first touches storage after the storage
   * component has started.
   */
  readonly repository: QuotaRepository;
  /**
   * The storage connection resolver — undefined before the storage
   * component has started and after its stop; every run resolves it fresh
   * (the maintenance half of the cleanup needs the connection's database,
   * which the facade rightly never hands back — D-058/D-063).
   */
  readonly storage: () => StorageConnection | undefined;
  /**
   * The schedule's wait seam — the composition's test seam for
   * time-compressed integration tests; absent means the real abortable
   * timer.
   */
  readonly sleep?: RetentionSleep;
  /**
   * The cleanup call — the unit-test seam (a spy pins the schedule's
   * contract without a database); defaults to the production
   * {@link runRetentionCleanup}.
   */
  readonly runCleanup?: (
    options: RetentionCleanupOptions,
    input: RetentionCleanupInput,
  ) => RetentionCleanupReport;
}

/** The assembled retention schedule {@link createRetentionSchedule} returns. */
export interface RetentionSchedule {
  /**
   * The §5.6 lifecycle component — register between storage and the
   * graceful drain.
   */
  readonly component: LifecycleComponent;
}

/** The real wait: one abortable timer, the scheduler's default-sleep shape. */
function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RetentionWaitAbortedError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RetentionWaitAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The shared error-message shape the polling wiring also uses (§15.4-safe). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── The schedule ───────────────────────────────────────────────────────── */

/**
 * Creates the retention cleanup schedule. The component starts the daily
 * loop only on `start` (inert until then); `stop` aborts the pending wait,
 * after which no further run can be queued — an in-progress run is
 * synchronous and therefore already finished before `stop` can be called.
 */
export function createRetentionSchedule(options: RetentionScheduleOptions): RetentionSchedule {
  const { clock, logger, config, repository, storage } = options;
  const sleep = options.sleep ?? defaultSleep;
  const runCleanup = options.runCleanup ?? runRetentionCleanup;
  let controller: AbortController | undefined;

  /** One §11.3 run — the operation over live inputs, faults contained (§16). */
  const runOnce = (phase: 'startup' | 'daily'): void => {
    const connection = storage();
    if (connection === undefined) {
      // By teardown order the schedule is dead before storage stops, so
      // this arm is a wiring bug — said out loud, touching nothing.
      logger.warn('retention cleanup skipped: storage is not open (no rows were touched)');
      return;
    }
    const retentionDays =
      config().app.historyRetentionDays ?? CONFIG_DEFAULTS.app.historyRetentionDays;
    try {
      const report = runCleanup(
        { repository, database: connection.database },
        { now: clock.now(), retentionDays },
      );
      logger.info('retention cleanup completed', {
        phase,
        retentionDays,
        removed: report.removed,
      });
    } catch (error) {
      // Contained: the schedule re-arms below regardless, and D-063's
      // repeat-safety makes the next run the same cleanup over the same
      // rows — the retry IS the recovery.
      logger.warn(
        'retention cleanup failed; the failure is contained, the next scheduled run retries',
        {
          phase,
          error: messageOf(error),
        },
      );
    }
  };

  const component: LifecycleComponent = {
    name: 'retention',
    async start() {
      // §11.3: "cleanup runs at startup and daily" — the startup run first
      // (after migrations, by registration order), then the daily cadence.
      runOnce('startup');
      controller = new AbortController();
      const signal = controller.signal;
      void (async (): Promise<void> => {
        try {
          for (;;) {
            await sleep(DAY_MS, signal);
            if (signal.aborted) return;
            runOnce('daily');
          }
        } catch (error) {
          // The abort is the designed exit — however the wait seam chose
          // to report it. Anything else is a broken sleep seam: loud,
          // contained, and final for this process (the startup run
          // already happened; the next process's startup run is the
          // retry).
          if (!signal.aborted) {
            logger.error('retention schedule loop failed; daily cleanup will not run again', {
              error: messageOf(error),
            });
          }
        }
      })();
      logger.info('retention schedule started', { dailyIntervalMs: DAY_MS });
    },
    async stop() {
      // Prompt: the abort releases the pending wait, no further run is
      // queued, and storage — still open, by registration order — closes
      // behind this component in the same teardown pass.
      controller?.abort();
      controller = undefined;
    },
  };

  return { component };
}
