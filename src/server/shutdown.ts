/**
 * Graceful-shutdown coordination (task 075, spec §5.6).
 *
 * Spec §5.6 fixes the shutdown sequence: on SIGTERM, stop scheduling new
 * polls, wait up to 10 seconds for an in-progress request, close the database,
 * and checkpoint WAL (the single-instance lock of task 074 is released last).
 * The reverse-order teardown of `QuotameterApp` (task 060) already produces
 * that order by construction for one registration choice: the components that
 * schedule work (the future polling service and HTTP listener) stop first,
 * the drain component introduced here waits for their in-flight work in the
 * middle, storage closes behind it, and the lock is released last:
 *
 * ```text
 *     registration: [lock, storage, graceful-drain, polling, http]
 *     stop order:   http → polling → graceful-drain → storage → lock
 *                                        └─ bounded in-flight wait
 * ```
 *
 * The polling service (109+) and HTTP listener (146) register their active
 * operations in the shared {@link createInFlightTracker} counter and stop
 * scheduling in their own `stop` — so the single wait covers every kind of
 * in-flight work (provider polls and HTTP requests alike) instead of each
 * subsystem duplicating timing semantics.
 *
 * Timing is injectable (`scheduleTimeout`, `now`): the §17.1 requirement
 * "clean SIGTERM shutdown" is tested deterministically without fake-timer
 * patching of process globals (Stryker runs tests in worker threads), and the
 * structured logger of task 072 will subscribe through the `onEvent` seam,
 * which follows the `onLifecycle` contract of `app.ts`: synchronous, errors
 * swallowed — diagnostics must never take down a shutdown.
 */

import { performance } from 'node:perf_hooks';
import type { LifecycleComponent } from './app';

/** The §5.6 bound: the in-flight wait never exceeds ten seconds. */
export const MAX_DRAIN_TIMEOUT_MS = 10_000;

/** A handle marking one in-flight operation as complete. */
export interface InFlightOperation {
  /**
   * Marks the operation complete. Idempotent: calling it again after the
   * first call has no effect, so a late completion after an abandoned drain
   * (or a defensive double `done()` in a component) can never corrupt the
   * count.
   */
  done(): void;
}

/**
 * The shared count of in-flight operations. The future polling service and
 * HTTP listener call {@link InFlightTracker.begin} when work starts and
 * `done()` when it settles; the drain component waits for the count to reach
 * zero.
 *
 * The tracker is deliberately dumb: refusing to start new work ("stop
 * scheduling", §5.6) is each scheduler's own `stop`, which runs before the
 * drain by registration order. Work in flight when the drain starts delays
 * the shutdown by at most the ten-second bound; work begun after the count
 * has reached zero is outside the wait entirely — schedulers must not begin
 * work after their `stop` (the tasks that build them, 109+ and 146, own that
 * contract).
 */
export interface InFlightTracker {
  /** Registers the start of one in-flight operation. */
  begin(): InFlightOperation;
  /**
   * Resolves once no operation is in flight — immediately when the count is
   * already zero, otherwise on the next transition to zero.
   */
  whenIdle(): Promise<void>;
  /** Number of operations currently in flight (diagnostics). */
  readonly count: number;
}

/** Creates a tracker shared by the schedulers and the drain component. */
export function createInFlightTracker(): InFlightTracker {
  let active = 0;
  const idleWaiters = new Set<() => void>();
  return {
    get count() {
      return active;
    },
    begin() {
      active += 1;
      let finished = false;
      return {
        done() {
          if (finished) return;
          finished = true;
          active -= 1;
          if (active === 0) {
            const waiters = [...idleWaiters];
            idleWaiters.clear();
            for (const waiter of waiters) waiter();
          }
        },
      };
    },
    whenIdle() {
      if (active === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
    },
  };
}

/** Emitted through {@link GracefulDrainOptions.onEvent} for diagnostics. */
export type ShutdownEvent =
  | { readonly type: 'drain-started'; readonly inFlight: number; readonly timeoutMs: number }
  | { readonly type: 'drain-completed'; readonly waitedMs: number }
  | {
      /** Forced completion: the bound expired with work still in flight. */
      readonly type: 'drain-timeout';
      readonly inFlight: number;
      readonly timeoutMs: number;
    };

/**
 * Schedules `callback` after `ms` and returns its cancellation — an
 * injectable timeout clock so tests drive the §5.6 bound deterministically.
 */
export type ScheduleTimeout = (callback: () => void, ms: number) => () => void;

/**
 * The default timeout clock: schedules `callback` with the global
 * `setTimeout` and returns its canceller (`clearTimeout`).
 */
function defaultScheduleTimeout(callback: () => void, ms: number): () => void {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
}

export interface GracefulDrainOptions {
  /** The tracker whose in-flight work the drain waits for. */
  readonly inFlight: InFlightTracker;
  /**
   * Bound of the in-flight wait in milliseconds; defaults to
   * {@link MAX_DRAIN_TIMEOUT_MS} (spec §5.6: "wait up to 10 seconds"). The
   * bound is a validated invariant, not a tuning knob: values above ten
   * seconds would weaken the §5.6 contract and are refused at assembly.
   */
  readonly timeoutMs?: number;
  /** Timeout clock; defaults to the global `setTimeout`. */
  readonly scheduleTimeout?: ScheduleTimeout;
  /**
   * Monotonic clock for the `drain-completed` duration; defaults to
   * `performance.now()` (the §7.1 principle of measuring durations
   * monotonically).
   */
  readonly now?: () => number;
  /**
   * Diagnostic sink for the structured logger (task 072). Synchronous; its
   * errors are swallowed — the same contract as `QuotameterAppOptions`
   * `onLifecycle`.
   */
  readonly onEvent?: (event: ShutdownEvent) => void;
}

/**
 * The graceful-shutdown drain as a lifecycle component (task 060 seam).
 *
 * Register it between storage and the schedulers (see the module comment):
 * by the time its `stop` runs, the schedulers have already stopped scheduling,
 * so it waits — at most {@link GracefulDrainOptions.timeoutMs} — for the
 * operations they left in flight, and only then lets teardown reach storage
 * (database close, WAL checkpoint) and the single-instance lock.
 *
 * When the bound expires, the wait is abandoned (forced completion, emitted
 * as `drain-timeout`): teardown proceeds, and operations completing later are
 * harmless. An idle application shuts down silently — there is nothing to
 * report when there was nothing to wait for.
 */
export function createGracefulDrain(options: GracefulDrainOptions): LifecycleComponent {
  const timeoutMs = options.timeoutMs ?? MAX_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DRAIN_TIMEOUT_MS) {
    throw new Error(
      `graceful-drain timeoutMs must be a finite number greater than 0 and at most ` +
        `${MAX_DRAIN_TIMEOUT_MS} (spec §5.6 bounds the in-flight wait at 10 seconds); ` +
        `got ${String(timeoutMs)}`,
    );
  }
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const now = options.now ?? ((): number => performance.now());
  const emit = (event: ShutdownEvent): void => {
    if (options.onEvent === undefined) return;
    try {
      options.onEvent(event);
    } catch {
      // Diagnostics must never affect the shutdown.
    }
  };

  return {
    name: 'graceful-drain',
    async start() {
      // Nothing to acquire: the drain is a passive component until shutdown.
    },
    async stop() {
      const waitingFor = options.inFlight.count;
      if (waitingFor === 0) return;
      emit({ type: 'drain-started', inFlight: waitingFor, timeoutMs });
      const startedAt = now();
      const outcome = await new Promise<'idle' | 'timeout'>((resolve) => {
        const cancelTimeout = scheduleTimeout(() => resolve('timeout'), timeoutMs);
        void options.inFlight.whenIdle().then(() => {
          // Settle before cancelling: the drain's guarantee that it always
          // completes within the bound must not depend on an injected
          // clock's canceller, so a throwing cancel is swallowed here.
          resolve('idle');
          try {
            // An uncancelled ten-second timer would hold the event loop
            // open past the completed shutdown.
            cancelTimeout();
          } catch {
            // A broken injected clock must not affect the settled drain.
          }
        });
      });
      if (outcome === 'idle') {
        emit({ type: 'drain-completed', waitedMs: now() - startedAt });
      } else {
        emit({ type: 'drain-timeout', inFlight: options.inFlight.count, timeoutMs });
      }
    },
  };
}
