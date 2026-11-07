/**
 * The polling scheduler (spec §7.1, §7.2; task 109, decision D-066; the
 * explicit phase model FSM-1/D-190).
 *
 * The engine behind the §7.1 collection loop: it runs each account's first
 * poll immediately, polls accounts sequentially with a random jitter of up
 * to 10% of the configured interval, and never starts a second cycle for an
 * account while one is in flight — the overlap prohibition is structural
 * (a single dispatch loop owns every start decision). Intervals are
 * measured on the monotonic clock (§7.1); the wall clock is read only for
 * the gates other decisions express in epoch form — task 107's
 * `Retry-After` deferral (D-062's `notBeforeEpochMs`) and task 108's
 * suspension cadence (D-064) — and for the settle context task 110 will
 * timestamp. Nothing here persists anything or classifies providers: each
 * account arrives as injectable closures, and the run writer (110)
 * is the seam that turns a retried cycle into a classified, stored run.
 *
 * Since FSM-1 the per-account schedule is an explicit state machine
 * (`polling-phase.ts`, D-190): the entry holds exactly one {@link PollPlan}
 * (what the dispatcher owes the account next), every mutation goes through
 * the pure transition table `nextPlan`, and each scheduling pass derives
 * the observed {@link PollPhase} per account (`pollPhaseOf`) and switches
 * over it exhaustively — a future phase variant without a dispatcher arm
 * is a compile error, not a missed gate (the U-028/P2-3 bug class). Kind
 * transitions log at `debug` through the optional injected logger.
 *
 * Composition of the landed seams:
 *
 * - {@link runCycleWithRetries} (D-059) wraps every cycle attempt — the
 *   §7.2 within-cycle 2/4/8 s backoff is the wrapper's, and the scheduler
 *   passes its own `random`/`sleep` seams through so one injection point
 *   drives both the retry jitter and the polling jitter;
 * - {@link deferNextPoll} (D-062) is the only source of the 429
 *   `notBeforeEpochMs` gate — a non-deferred outcome leaves the gate open;
 * - the D-064 state machine gates normal polling (`!suspended`), grants
 *   hourly verification attempts, and receives every classified outcome —
 *   all through the injected `AccountSuspensions` store (FSM-3, D-189):
 *   the engine holds no suspension state of its own, so its dispatch gates
 *   and the status surfaces read one value per account, and the phase model
 *   references that value without copying it. Key-change releases ride on
 *   `setAccounts` (the configuration observation) and a manual test is
 *   {@link PollingScheduler.requestManualTest};
 * - a failure for one account never stops the others (§7.2): provider
 *   failures arrive as `CycleRetryResult` values, and even a **throwing**
 *   `settleCycle` seam is contained — the account simply reschedules on
 *   the plain interval (the `contained-failure` transition). A **throwing**
 *   wrapper (a broken sleep seam, an invalid random roll) gets the same
 *   containment plus the optional `abandonCycle` notification, so a cycle
 *   that can never settle leaves no per-cycle state behind (U-035/D-169).
 *
 * The one interplay the spec leaves open is decided in D-066: what
 * "sequential" means when a cycle hangs. The dispatcher is strictly
 * sequential while the in-flight cycle is within `cycleHangThresholdMs`
 * (the worst legitimate §7.2 cycle: four attempts at the 60 s ceiling plus
 * the 15.5 s worst backoff) — accounts are then non-concurrent, pinned by
 * test. Past the threshold the hung account is *skipped for dispatch*
 * (its own next cycle still cannot start — the overlap prohibition is
 * untouched) and other accounts proceed, so one broken closure cannot
 * starve the rest.
 *
 * Shutdown (§5.6, D-020): {@link PollingScheduler.stop} stops scheduling,
 * aborts every live cycle (a cooperating attempt surfaces as
 * `TransportAbortError`, classified `'cancelled'` by D-048), and resolves
 * promptly — cycle tasks are detached from the loop, and the optional
 * structural `inFlight` tracker lets the server's graceful drain wait for
 * the aborted cycles' actual settlement.
 */

import type { Clock } from '../util/clock';
import type { Logger } from '../util/logger';
import { TransportAbortError } from '../providers/transport';
import { type AccountSuspensions } from './account-suspensions';
import type { CycleOutcome } from './polling-outcomes';
import {
  initialPlan,
  nextPlan,
  pollPhaseOf,
  type PhaseFlight,
  type PollPlan,
  type PollPlanEvent,
} from './polling-phase';
import { runCycleWithRetries, type CycleRetryResult } from './polling-retry';
import { deferNextPoll } from './polling-retry-after';
import { isSuspended } from './polling-suspension';

/* ── The §7.1 interval contract ────────────────────────────────────────── */

/**
 * §7.1's configured-interval floor: 60 seconds. The configuration contract
 * (`src/schemas/config.ts`, `pollingIntervalSeconds`) validates the same
 * range at load; this engine re-validates its wiring so a seconds/milliseconds
 * confusion fails at assembly rather than silently polling nine times too
 * fast. A unit test pins the two constants against the schema's bounds.
 */
export const MIN_POLLING_INTERVAL_MS = 60_000;

/** §7.1's configured-interval ceiling: 3600 seconds. */
export const MAX_POLLING_INTERVAL_MS = 3_600_000;

/** §7.1: "random jitter up to 10% of the configured interval". */
export const POLLING_JITTER_FRACTION = 0.1;

/**
 * One inter-poll delay: the configured interval plus a uniform integer
 * jitter of 0 to 10% of it, both ends included — the additive-bounded shape
 * of D-059's retry jitter, so a delay is never *below* the configured
 * interval and never more than 10% above it. `random` must return a finite
 * number in `[0, 1)`; a roll outside that range would break the bound, so
 * it fails fast instead of being clamped silently.
 */
export function pollingDelayMs(intervalMs: number, random: () => number): number {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError('pollingDelayMs: intervalMs must be a positive integer');
  }
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new TypeError('pollingDelayMs: random() must return a finite number in [0, 1)');
  }
  // Intervals are whole milliseconds divisible by 1000 in practice, so
  // intervalMs / 10 is an exact integer there; floor keeps the bound exact
  // for any positive integer. floor(roll × (max + 1)) is uniform over the
  // integers 0…max, both ends included.
  const maxJitterMs = Math.floor(intervalMs * POLLING_JITTER_FRACTION);
  return intervalMs + Math.floor(roll * (maxJitterMs + 1));
}

/* ── The hang threshold (D-066) ────────────────────────────────────────── */

/**
 * The default point past which an unsettled cycle stops holding other
 * accounts back: the worst cycle §7.2 itself can produce — four attempts
 * at the 60 s request-timeout ceiling plus the 15.5 s worst-case backoff
 * (D-059). A cycle beyond it is either hung or configured past §7.2's
 * envelope; either way the other accounts must not starve.
 */
export const DEFAULT_CYCLE_HANG_THRESHOLD_MS = 4 * 60_000 + 15_500; // 255 500 ms

/**
 * The largest delay handed to one timer — a **re-evaluation slice**, not
 * just Node's `setTimeout` ceiling (which clamps oversized delays to 1 ms,
 * turning a multi-week wait into a busy-spin, review P2-1). The loop
 * recomputes after every wake, so slicing long waits is always correct;
 * one hour (§7.2's own longest gate horizon) bounds both the wakeup rate
 * and the detection latency of a wall-clock correction to an hour — a
 * gate computed from a regressed wall reading resumes within one slice of
 * the clock being fixed.
 */
export const MAX_WAKE_MS = 3_600_000;

/* ── The account seam ──────────────────────────────────────────────────── */

/**
 * One account's wiring — everything the engine knows about a provider
 * account. Task 110 fills `settleCycle` with classify+persist; the engine
 * never imports storage, adapters, or the registry.
 */
export interface PollingAccount {
  /** The stable account id (configuration's `accounts[].id`). */
  readonly accountId: string;
  /**
   * The opaque identity of the account's current key — a generation counter
   * or hash, never key material (D-064). A changed identity reported through
   * `setAccounts` is the machine's key-change release event.
   */
  readonly keyIdentity: string;
  /**
   * One raw cycle attempt — the single `fetchSnapshot` call of §8.1. The
   * engine wraps this in `runCycleWithRetries` (D-059) and hands it the
   * cycle's abort signal; per-attempt timeouts stay with the transport.
   */
  readonly attempt: (signal: AbortSignal) => Promise<unknown>;
  /**
   * Task 110's seam: receives the retried cycle's final result (value or
   * error plus the total attempt count §11.2 persists) and returns the
   * classification (task 105's vocabulary) the engine gates on —
   * suspension transitions, `Retry-After` deferral, and the next schedule
   * all read it. Throwing is contained per §7.2 isolation: the account
   * reschedules on the plain interval and the engine keeps serving the
   * others.
   */
  readonly settleCycle: (result: CycleRetryResult<unknown>) => CycleOutcome | Promise<CycleOutcome>;
  /**
   * Optional notification that a cycle will never settle: the engine calls
   * it exactly when D-059's wrapper itself threw (a broken sleep seam, an
   * invalid random roll — contained per §7.2 like a throwing settle), so the
   * account closure can drop per-cycle state that would otherwise leak into
   * the next cycle. Task 110's recorder drops its cycle-start stamp here
   * (U-035/D-169: without this, a thrown wrapper's stamp bled into the next
   * run row's `started_at`). A throwing `abandonCycle` is contained the same
   * way; absent means the engine simply proceeds.
   */
  readonly abandonCycle?: () => void;
}

/* ── Options ───────────────────────────────────────────────────────────── */

/**
 * The engine's wait: the same seam D-059's backoff uses, so one injection
 * point drives every timer. Contract: resolve after `ms`, and reject with
 * `TransportAbortError` when `signal` aborts. The default is a real
 * abortable timer.
 */
export type PollingSleep = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

/**
 * The structural shape of D-020's `InFlightTracker` as this layer may see
 * it — a local type, because `services` may not import `src/server/`. The
 * composition root passes the real tracker so the graceful drain can wait
 * for aborted cycles to settle.
 */
export interface PollingInFlightTracker {
  /** Registers the start of one in-flight operation. */
  begin(): { done(): void };
}

/** Options adjusting {@link createPollingScheduler}. */
export interface PollingSchedulerOptions {
  /** The initial account set; may be empty or omitted. */
  readonly accounts?: readonly PollingAccount[];
  /**
   * The configured §7.1 interval in milliseconds (60–3600 s). Validated
   * fail-fast: the configuration contract already enforces the range, and a
   * unit mismatch here must surface at assembly, not as a nine-times-too-fast
   * poll loop.
   */
  readonly intervalMs: number;
  /** The injected clock (D-021) — both readings are used. */
  readonly clock: Clock;
  /** The jitter randomness source (default `Math.random`), D-059's contract. */
  readonly random?: () => number;
  /** The wait seam (default: a real abortable timer). */
  readonly sleep?: PollingSleep;
  /**
   * How long an in-flight cycle holds other accounts back before the engine
   * dispatches around it (default {@link DEFAULT_CYCLE_HANG_THRESHOLD_MS}).
   */
  readonly cycleHangThresholdMs?: number;
  /**
   * D-020's in-flight tracker, if the composition root wires the drain.
   */
  readonly inFlight?: PollingInFlightTracker;
  /**
   * Optional diagnostics channel (R6, D-190): held-plan kind transitions
   * log at `debug` — accountId, the event, and the from/to kinds, never a
   * secret. Absent means silent (a standalone embedding needs no logger);
   * the composition passes the shared redacting logger.
   */
  readonly logger?: Pick<Logger, 'debug'>;
  /**
   * The D-064 suspension store (FSM-3, D-189) — the ONE per-account state
   * holder this engine reads its gates from and writes its transitions
   * into. The composition injects the same instance the status routes and
   * the manual-test observation use, constructed over the same shared
   * clock (D-021); the engine deliberately holds no suspension state of
   * its own, so dispatch gating and `/api/status` cannot diverge.
   */
  readonly suspensions: AccountSuspensions;
}

/** The running scheduler. */
export interface PollingScheduler {
  /**
   * Starts the dispatch loop; each account's first poll is immediately due
   * (§7.1). Throws if already started or stopped.
   */
  start(): void;
  /**
   * Replaces the account set (a configuration observation). Added accounts
   * get an immediate first poll; removed accounts drop their state (an
   * in-flight cycle settles in the background and its outcome is
   * discarded); a kept account whose `keyIdentity` changed is reported to
   * the D-064 machine — a release there makes the next normal poll
   * immediately due. Duplicate ids and malformed entries fail fast.
   */
  setAccounts(accounts: readonly PollingAccount[]): void;
  /**
   * Changes the configured interval at runtime (validated against §7.1).
   * Not-suspended accounts are re-anchored to `now + newInterval + jitter` —
   * a shrunken interval never leaves an hour-long pending wait in place;
   * suspended accounts keep the 60-minute probe cadence §7.2 fixes; an
   * account whose cycle is in flight picks the new interval up when its
   * cycle completes.
   */
  setIntervalMs(intervalMs: number): void;
  /**
   * Requests a manual test (§7.2's second release condition): applies the
   * D-064 release through the shared store (idempotent beside the manual-test
   * observation's own application — a release on a released state is a
   * no-op) and owes the account one attempt — a manual test of a healthy
   * account is just a cycle. The owed attempt dispatches immediately,
   * through the dispatch loop (sequential and overlap rules hold); while
   * the account's cycle is in flight it runs when that cycle settles, and
   * it survives a concurrent interval change. The `Retry-After` gate still
   * applies ("do not poll before that time" is unconditional). Returns
   * false for an unknown account.
   */
  requestManualTest(accountId: string): boolean;
  /**
   * A manual connection test refused the account's key (§7.2's 401/403 row
   * reached from the manual-test path — the composition's bridge, D-176):
   * the D-064 re-entry is the observation wrapper's single application to
   * the shared store (`src/server/providers.ts`, under the tested key's
   * identity); the engine-side half drops any still-owed manual attempt —
   * a key the provider just refused has nothing left to try, and the probe
   * cadence owns the next attempt. A cycle already in flight settles
   * normally (its own outcome decides). Returns false for an unknown
   * account.
   */
  manualTestRejected(accountId: string): boolean;
  /**
   * Stops scheduling (§5.6): aborts every live cycle and resolves once the
   * loop has exited — promptly, because cycle tasks are detached. The
   * aborted cycles' settlement (and task 110's recording of it) happens in
   * the background; the server's graceful drain waits for it through the
   * `inFlight` tracker. Idempotent; safe to call before `start`.
   */
  stop(): Promise<void>;
  /**
   * True between `start` and `stop` while the dispatch loop is alive —
   * false after `stop` and also after the loop died of a wiring failure
   * (a non-finite clock reading, a throwing tracker seam), so a
   * silently-dead engine cannot report itself healthy.
   */
  readonly running: boolean;
}

/* ── Internal state ────────────────────────────────────────────────────── */

/**
 * The engine's per-account state (D-066; the phase model D-190): the wiring
 * plus exactly one held {@link PollPlan} — the field scatter (the monotonic
 * due, the D-062 gate, the owed-attempt flag) is gone; every mutation goes
 * through the pure transition table (`nextPlan`) and the dispatcher decides
 * exclusively through the observed phase (`pollPhaseOf`).
 */
interface AccountEntry {
  account: PollingAccount;
  /** What the dispatcher owes this account next (FSM-1, D-190). */
  plan: PollPlan;
}

/** One dispatched cycle, live until its post-processing completes. */
interface Flight {
  readonly accountId: string;
  readonly startedMonotonicMs: number;
  readonly controller: AbortController;
  /** Sticky: once a flight crosses the hang threshold it stays skippable. */
  hung: boolean;
}

/**
 * The default wait — D-059's backoff-sleep contract (reject with
 * `TransportAbortError` on abort), shared by the engine's wake waits: an
 * aborted wake is caught and treated as "wake now", so both uses ride one
 * seam without either semantic contaminating the other.
 */
function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new TransportAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TransportAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ── Validation (fail-fast, the D-059/D-064 convention) ───────────────── */

function requireIntervalMs(intervalMs: number, caller: string): number {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_POLLING_INTERVAL_MS ||
    intervalMs > MAX_POLLING_INTERVAL_MS
  ) {
    throw new RangeError(
      `${caller}: intervalMs must be an integer in [${MIN_POLLING_INTERVAL_MS}, ${MAX_POLLING_INTERVAL_MS}] (spec §7.1)`,
    );
  }
  return intervalMs;
}

function requireAccounts(accounts: readonly PollingAccount[], caller: string): void {
  if (!Array.isArray(accounts)) {
    throw new TypeError(`${caller}: accounts must be an array of PollingAccount`);
  }
  const seen = new Set<string>();
  for (const account of accounts) {
    if (typeof account !== 'object' || account === null) {
      throw new TypeError(`${caller}: each account must be a PollingAccount`);
    }
    if (typeof account.accountId !== 'string' || account.accountId.trim() === '') {
      throw new TypeError(`${caller}: accountId must be a non-blank string`);
    }
    if (typeof account.keyIdentity !== 'string' || account.keyIdentity.trim() === '') {
      throw new TypeError(`${caller}: keyIdentity must be a non-blank string`);
    }
    if (typeof account.attempt !== 'function') {
      throw new TypeError(`${caller}: attempt must be a function`);
    }
    if (typeof account.settleCycle !== 'function') {
      throw new TypeError(`${caller}: settleCycle must be a function`);
    }
    if (account.abandonCycle !== undefined && typeof account.abandonCycle !== 'function') {
      throw new TypeError(`${caller}: abandonCycle must be a function when present`);
    }
    if (seen.has(account.accountId)) {
      throw new TypeError(`${caller}: duplicate account id '${account.accountId}'`);
    }
    seen.add(account.accountId);
  }
}

/* ── The engine ────────────────────────────────────────────────────────── */

/**
 * Creates the polling scheduler. The returned engine is inert until
 * {@link PollingScheduler.start}; `stop` is its §5.6 "stop scheduling"
 * hook. All seams are injectable (clock per D-021, random and sleep per
 * D-059) so the fake-timer suite drives the production defaults while the
 * gate suites can script wall-clock behavior.
 */
export function createPollingScheduler(options: PollingSchedulerOptions): PollingScheduler {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createPollingScheduler: options must be a PollingSchedulerOptions');
  }
  let intervalMs = requireIntervalMs(options.intervalMs, 'createPollingScheduler');
  const clock = options.clock;
  if (
    typeof clock !== 'object' ||
    clock === null ||
    typeof clock.now !== 'function' ||
    typeof clock.monotonicMs !== 'function'
  ) {
    throw new TypeError('createPollingScheduler: clock must be a Clock (D-021)');
  }
  const random = options.random ?? Math.random;
  if (typeof random !== 'function') {
    throw new TypeError('createPollingScheduler: random must be a function');
  }
  const sleep = options.sleep ?? defaultSleep;
  if (typeof sleep !== 'function') {
    throw new TypeError('createPollingScheduler: sleep must be a function');
  }
  const hangThresholdMs = options.cycleHangThresholdMs ?? DEFAULT_CYCLE_HANG_THRESHOLD_MS;
  if (
    typeof hangThresholdMs !== 'number' ||
    !Number.isFinite(hangThresholdMs) ||
    hangThresholdMs <= 0
  ) {
    throw new RangeError(
      'createPollingScheduler: cycleHangThresholdMs must be a finite positive number',
    );
  }
  const inFlightTracker = options.inFlight;
  if (inFlightTracker !== undefined && typeof inFlightTracker.begin !== 'function') {
    throw new TypeError('createPollingScheduler: inFlight must expose begin()');
  }
  const logger = options.logger ?? { debug: () => undefined };
  if (typeof logger.debug !== 'function') {
    throw new TypeError('createPollingScheduler: logger must expose debug()');
  }
  const suspensions = options.suspensions;
  if (typeof suspensions !== 'object' || suspensions === null) {
    throw new TypeError('createPollingScheduler: suspensions must be an AccountSuspensions');
  }
  for (const method of [
    'suspensionOf',
    'manualTestRequested',
    'manualTestRejected',
    'reportKeyIdentity',
    'polledCycleOutcome',
    'admitVerification',
    'dropAccount',
  ] as const) {
    if (typeof suspensions[method] !== 'function') {
      throw new TypeError(
        `createPollingScheduler: suspensions must expose ${method}() (the D-064 store, D-189)`,
      );
    }
  }
  if (options.accounts !== undefined) requireAccounts(options.accounts, 'createPollingScheduler');

  /** A guarded monotonic reading — the schedule's time base (§7.1). */
  function monotonicNow(): number {
    const value = clock.monotonicMs();
    if (!Number.isFinite(value))
      throw new TypeError('polling scheduler: monotonicMs() must be finite');
    return value;
  }

  /** A guarded wall reading — gates and D-064 events only. */
  function wallNow(): number {
    const value = clock.now();
    if (!Number.isFinite(value)) throw new TypeError('polling scheduler: now() must be finite');
    return value;
  }

  const entries = new Map<string, AccountEntry>();
  const flights = new Set<Flight>();
  let latestFlight: Flight | undefined;
  let started = false;
  let stopped = false;

  /* ── The kick/wake plumbing ────────────────────────────────────────── */

  let kickResolve: (() => void) | undefined;
  let kickPromise = new Promise<void>((resolve) => {
    kickResolve = resolve;
  });
  let wakeController: AbortController | undefined;

  /** Wakes the loop: resolves the kick and cuts any pending wake short. */
  function kick(): void {
    kickResolve?.();
    kickPromise = new Promise<void>((resolve) => {
      kickResolve = resolve;
    });
    wakeController?.abort();
  }

  /**
   * Waits `ms` or until kicked, whichever comes first. An aborted wait just
   * returns — the loop recomputes its next step from live state after every
   * wakeup, so a spurious wake is harmless. Two guards (review P2-1/P3-2):
   * the delay is sliced to {@link MAX_WAKE_MS} — Node clamps oversized
   * `setTimeout` delays to 1 ms, so a wall-regressed gate wait of weeks
   * would otherwise busy-spin — and a sleep rejection other than the
   * documented abort rejection propagates, killing the loop loudly
   * (D-059's broken-seam convention) instead of spinning silently.
   */
  async function wake(ms: number): Promise<void> {
    const controller = new AbortController();
    wakeController = controller;
    try {
      await Promise.race([
        sleep(Math.min(ms, MAX_WAKE_MS), controller.signal).catch((error: unknown) => {
          if (!(error instanceof TransportAbortError)) throw error;
        }),
        kickPromise.then(() => controller.abort()),
      ]);
    } finally {
      if (wakeController === controller) wakeController = undefined;
    }
  }

  /* ── Account-set management ────────────────────────────────────────── */

  /**
   * Applies one transition-table event to the entry's held plan, logging
   * the kind change at `debug` (R6): accountId, the event, from → to —
   * never a secret (the plan holds timestamps only). Log calls never throw
   * (the logger's own contract), so the transition is unconditional.
   */
  function setPlan(entry: AccountEntry, event: PollPlanEvent): void {
    const from = entry.plan;
    const to = nextPlan(from, event);
    if (to.kind !== from.kind) {
      logger.debug('polling scheduler: account plan transitioned', {
        accountId: entry.account.accountId,
        event: event.kind,
        from: from.kind,
        to: to.kind,
      });
    }
    entry.plan = to;
  }

  function freshEntry(account: PollingAccount, nowMonotonicMs: number): AccountEntry {
    // §7.1: the first collection runs immediately — also for an account
    // added mid-run, which mirrors a startup for that account (D-066). The
    // account's D-064 state is whatever the shared store holds: usually
    // nothing (a leaving setAccounts dropped it), except an episode a
    // manual test planted while the account was unpolled — which the pause
    // then honors (D-189's corner: the probe cadence, not a normal poll,
    // verifies a key the provider already refused).
    return { account, plan: initialPlan(nowMonotonicMs) };
  }

  function applyAccounts(next: readonly PollingAccount[]): void {
    const mono = monotonicNow();
    const nextEntries = new Map<string, AccountEntry>();
    for (const account of next) {
      const existing = entries.get(account.accountId);
      if (existing === undefined) {
        nextEntries.set(account.accountId, freshEntry(account, mono));
        continue;
      }
      // A kept account: swap in the new closures (labels etc. may differ)
      // and report the observed key identity to the D-064 store — the
      // idempotent observation D-064 recommends for every configuration
      // reload. A release there resumes normal polling immediately.
      if (suspensions.reportKeyIdentity(account.accountId, account.keyIdentity)) {
        // Released by the key change: normal polling resumes immediately
        // (the stale schedule was paused mid-air, D-066).
        setPlan(existing, { kind: 'key-released', nowMonotonicMs: mono });
      }
      existing.account = account;
      nextEntries.set(account.accountId, existing);
    }
    for (const id of entries.keys()) {
      // An account that left the polled set drops its D-064 episode beside
      // its engine entry (D-066's removal semantics; suspension is process
      // memory, D-064's restart consequence — the D-070 run-evidence arm
      // covers the §7.3 display for the first post-return cycle).
      if (!nextEntries.has(id)) suspensions.dropAccount(id);
    }
    entries.clear();
    for (const [id, entry] of nextEntries) entries.set(id, entry);
    // Removed accounts' in-flight cycles settle in the background and
    // discard their outcomes (the identity check in the settle path),
    // because the state they would update is gone.
    kick();
  }

  /* ── Cycle execution ───────────────────────────────────────────────── */

  /**
   * Runs one full cycle for the account, detached from the loop: the
   * D-059 wrapper around the raw attempt, the settle seam, and every
   * schedule/state consequence. Never rejects — a broken seam is contained
   * to this flight (§7.2 isolation), with a plain-interval fallback so the
   * account cannot stall.
   *
   * The account wiring is **snapshotted** at dispatch (review P1-1): a
   * `setAccounts` swap that lands while the cycle is in flight must not
   * make one cycle mix keys (old closures on retries, new identity on the
   * verdict) — and an old key's 401 must never suspend a brand-new key
   * that was never tried. The settle outcome is therefore discarded as
   * stale when the entry was removed or re-keyed mid-flight: task 110's
   * seam has still recorded the run (history is per-account), but the
   * engine consumes no gate from a cycle that no longer describes the
   * configured key — no store feed, no plan transition.
   */
  function startFlight(entry: AccountEntry): void {
    // The dispatch consumes whatever the account was owed (the table's
    // single consume site): an owed manual attempt becomes a live cycle,
    // and the dormant schedule stands ready for the settle to rewrite.
    setPlan(entry, { kind: 'dispatched' });
    const account = entry.account; // the wiring this cycle runs with
    const flight: Flight = {
      accountId: account.accountId,
      startedMonotonicMs: monotonicNow(),
      controller: new AbortController(),
      hung: false,
    };
    flights.add(flight);
    latestFlight = flight;
    const operation = inFlightTracker?.begin();
    const settled = (async (): Promise<void> => {
      try {
        let result: CycleRetryResult<unknown>;
        try {
          result = await runCycleWithRetries(() => account.attempt(flight.controller.signal), {
            signal: flight.controller.signal,
            random,
            sleep,
          });
        } catch {
          // The wrapper itself threw (a broken sleep seam, an invalid random
          // roll — D-059's programming-mistake throws): this cycle can never
          // settle, so the account closure is told before per-cycle state can
          // outlive it (U-035, D-169 — the recorder's start stamp would
          // otherwise bleed into the next run row's `started_at`). A throwing
          // abandon hook is one more programming mistake on this already-
          // contained path: it propagates to the outer catch below, which
          // makes the same plain-interval fallback — no separate containment.
          account.abandonCycle?.();
          rescheduleBestEffort(entry);
          return;
        }
        let classified: CycleOutcome;
        try {
          classified = await account.settleCycle(result);
        } catch {
          // A throwing settle seam is a broken consumer (D-059's sleep
          // precedent): contained, diagnostics deferred to the server's
          // logger wiring. The account reschedules on the plain interval.
          rescheduleBestEffort(entry);
          return;
        }
        if (
          entries.get(account.accountId) !== entry ||
          entry.account.keyIdentity !== account.keyIdentity
        ) {
          return; // removed or re-keyed mid-flight: the outcome is stale
        }
        const wall = wallNow();
        // D-064: every non-stale classified outcome feeds the suspension
        // store — the one application the outcome gets (the status seam
        // reads the same store, so the feed needs no mirror).
        suspensions.polledCycleOutcome(account.accountId, classified, account.keyIdentity);
        // D-062: the 429 gate — replaced by this cycle's own decision; a
        // non-deferred reason falls back to the plain interval below. The
        // re-anchor pair (the monotonic reading and the jitter roll) is
        // drawn only when the schedule will consume it — the suspended row
        // keeps the probe cadence, so it takes no reading and draws no roll
        // (D-066's read/roll-consumption order preserved bit for bit).
        const defer = deferNextPoll(classified, wall);
        const suspended = isSuspended(suspensions.suspensionOf(account.accountId));
        setPlan(entry, {
          kind: 'cycle-settled',
          suspended,
          notBeforeEpochMs: defer.deferred ? defer.notBeforeEpochMs : Number.NEGATIVE_INFINITY,
          ...(suspended
            ? {}
            : { nowMonotonicMs: monotonicNow(), nextDelayMs: pollingDelayMs(intervalMs, random) }),
        });
      } catch {
        // Programming mistakes only (a fail-fast random roll, a broken sleep
        // seam, a throwing abandon hook): same containment, same
        // plain-interval fallback.
        rescheduleBestEffort(entry);
      } finally {
        // Cleanup first, third-party seams last: a throwing tracker must
        // not leave the flight live (which would brick the account's
        // dispatch forever), and nothing from a flight may surface as an
        // unhandled rejection — the loop's own error retention (see
        // start) is the observable channel for wiring failures.
        flights.delete(flight);
        if (latestFlight === flight) latestFlight = undefined;
        kick();
        operation?.done();
      }
    })().catch(() => undefined);
    // The flight's own promise cannot reject (see above); the void cast
    // documents that nobody awaits it here — stop() waits for the *loop*,
    // and the drain waits through the tracker.
    void settled;
  }

  /**
   * The contained-failure fallback (the `contained-failure` transition):
   * next poll one plain interval out, gate untouched — unless the account
   * is owed (the attempt dispatches anyway) or suspended (the armed
   * instant governs). Best effort by construction — it runs inside
   * containment, where the seam that just failed (a broken clock, a
   * throwing random) may fail again, and a second escape would become an
   * unhandled rejection.
   */
  function rescheduleBestEffort(entry: AccountEntry): void {
    try {
      if (entries.get(entry.account.accountId) !== entry) return;
      const suspended = isSuspended(suspensions.suspensionOf(entry.account.accountId));
      // The monotonic reading is taken only on the plain-interval row — the
      // suspended and owed rows reschedule nothing (and the old code read
      // no clock on them either).
      setPlan(entry, {
        kind: 'contained-failure',
        suspended,
        intervalMs,
        ...(suspended || entry.plan.kind === 'manual-owed'
          ? {}
          : { nowMonotonicMs: monotonicNow() }),
      });
    } catch {
      // The clock itself is broken: the loop's next scheduling pass will
      // hit the same failure and retain it as its own error (running
      // turns false) rather than crashing the process here.
    }
  }

  /* ── The dispatch loop ─────────────────────────────────────────────── */

  /**
   * Whether the latest flight is holding the queue: a flight within the
   * hang threshold blocks dispatch entirely (strict sequential); past it,
   * the flight is marked hung and other accounts may proceed around it.
   */
  function isBlockedByFlight(): boolean {
    const flight = latestFlight;
    if (flight === undefined) return false;
    if (!flight.hung && monotonicNow() - flight.startedMonotonicMs >= hangThresholdMs) {
      flight.hung = true;
    }
    return !flight.hung;
  }

  /**
   * One pass's flight view: the per-account presences built once (an account
   * with a live flight is never dispatchable, hung included — at most one
   * flight per account exists, so the first hit is the answer).
   */
  function flightPresenceMap(): Map<string, PhaseFlight> {
    const presence = new Map<string, PhaseFlight>();
    for (const flight of flights) {
      if (!presence.has(flight.accountId)) {
        presence.set(flight.accountId, flight.hung ? 'hung' : 'flying');
      }
    }
    return presence;
  }

  /** One account's decision for a single scheduling pass. */
  type DispatchDecision =
    | { readonly kind: 'skip' }
    | { readonly kind: 'wait'; readonly ms: number }
    | { readonly kind: 'dispatch'; readonly entry: AccountEntry };

  const SKIP: DispatchDecision = Object.freeze({ kind: 'skip' });

  /**
   * Derives the account's observed phase and maps it to this pass's
   * decision — the exhaustive dispatcher switch of the phase model (R3,
   * D-190): every {@link PollPhase} variant has exactly one arm, and a
   * future variant without one is a compile error here (TS2366, the
   * `classifyTransportError` totality pattern), never a missed gate.
   *
   * The wait-vs-blocked placement of each arm is the parity contract:
   * a gated account contributes its wait even while the queue is held
   * (the gate opens on its own clock), while cadence-due and plain-due
   * shapes are re-examined after the hold lifts.
   */
  function decide(
    entry: AccountEntry,
    presence: ReadonlyMap<string, PhaseFlight>,
    blocked: boolean,
    wallEpochMs: number,
    monotonicMs: number,
  ): DispatchDecision {
    const accountId = entry.account.accountId;
    const phase = pollPhaseOf({
      plan: entry.plan,
      flight: presence.get(accountId) ?? 'none',
      suspension: suspensions.suspensionOf(accountId),
      wallEpochMs,
      monotonicMs,
    });
    switch (phase.kind) {
      case 'absent':
        // Unreachable through the loop (the entry exists) — the arm keeps
        // the switch total over the phase vocabulary.
        return SKIP;
      case 'in-flight':
      case 'hung':
        // §7.1's overlap prohibition: an account with a live flight is
        // never dispatchable — including flights already declared hung
        // (D-066: hung skips dispatch, it does not free the account).
        return SKIP;
      case 'manual-gated':
        // §7.2's "do not poll before that time" binds the owed attempt
        // (U-028) — even while the queue is held, the gate's opening must
        // end the wait.
        return { kind: 'wait', ms: phase.untilEpochMs - wallEpochMs };
      case 'manual-owed':
        // Due now, suspension bypassed (the request already released the
        // store, D-064); consumed by the dispatch itself (`dispatched`).
        if (blocked) return SKIP;
        return { kind: 'dispatch', entry };
      case 'probe-waiting':
      case 'probe-gated':
        // The D-064 cadence (the machine's own boundary predicate, never
        // a hand-rolled twin) — with the U-028 order: the gate is checked
        // after the cadence predicate, so an admission is never consumed
        // behind a shut gate and a deferral opening first adds no wake.
        if (blocked) return SKIP; // the queue is held; re-examine after the wake
        return { kind: 'wait', ms: phase.untilEpochMs - wallEpochMs };
      case 'probe-due': {
        if (blocked) return SKIP;
        // The single admission path (D-064/D-189): the store re-arms at
        // admission, so the pacing survives a lost outcome by construction.
        const admission = suspensions.admitVerification(accountId);
        if (admission.admitted) return { kind: 'dispatch', entry };
        // Unreachable through this engine's own math (the phase derivation
        // used the same wall reading); wait a tick and recompute from a
        // fresh reading rather than trusting the disagreement.
        return {
          kind: 'wait',
          ms:
            admission.reason === 'too-early'
              ? Math.max(1, admission.nextVerificationAtEpochMs - wallEpochMs)
              : 1,
        };
      }
      case 'waiting':
        return { kind: 'wait', ms: phase.untilMonotonicMs - monotonicMs };
      case 'due':
        if (blocked) return SKIP;
        return { kind: 'dispatch', entry };
    }
  }

  /**
   * One scheduling pass: admit the next due account, or report how long to
   * wait. Every per-account decision comes from {@link decide} — the
   * observed-phase switch above; this loop only folds the decisions.
   */
  function nextAction():
    | { readonly action: 'dispatch'; readonly entry: AccountEntry }
    | { readonly action: 'wait'; readonly delayMs: number | undefined } {
    let waitMs: number | undefined;
    const blocked = isBlockedByFlight();
    const wall = wallNow();
    const mono = monotonicNow();
    const presence = flightPresenceMap();
    for (const entry of entries.values()) {
      const decision = decide(entry, presence, blocked, wall, mono);
      if (decision.kind === 'dispatch') return { action: 'dispatch', entry: decision.entry };
      if (decision.kind === 'wait') waitMs = minDelay(waitMs, decision.ms);
    }
    // While blocked, the wait must also end when the holding flight crosses
    // the hang threshold, so the skip can engage without an external kick.
    if (blocked && latestFlight !== undefined) {
      const hangInMs = hangThresholdMs - (monotonicNow() - latestFlight.startedMonotonicMs);
      waitMs = minDelay(waitMs, Math.max(0, hangInMs));
    }
    return { action: 'wait', delayMs: waitMs };
  }

  function minDelay(current: number | undefined, candidate: number): number {
    if (current === undefined || candidate < current) return candidate;
    return current;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const next = nextAction();
      if (next.action === 'dispatch') {
        startFlight(next.entry);
        continue;
      }
      if (next.delayMs === undefined) {
        await kickPromise; // nothing scheduled: wait for a kick (set/stop/…)
        continue;
      }
      await wake(next.delayMs);
    }
  }

  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let loopError: unknown; // retained so a dead engine is observable (P2-2)

  // The initial account set lands here, not in start(): a `setAccounts`
  // call before start must diff against it, not be clobbered by it. The
  // fresh entries' immediate dues simply carry into the first loop pass.
  if (options.accounts !== undefined) applyAccounts(options.accounts);

  /* ── The public surface ────────────────────────────────────────────── */

  const scheduler: PollingScheduler = {
    start() {
      if (stopped) throw new Error('polling scheduler: cannot start a stopped scheduler');
      if (started) throw new Error('polling scheduler: already started');
      started = true;
      loopPromise = loop();
      // Retain a wiring-level rejection (a non-finite clock reading, a
      // throwing tracker) instead of only silencing it: `running` turns
      // false so the composition root can see the engine died, and stop()
      // re-surfaces the error to its caller (review P2-2).
      loopPromise.catch((error: unknown) => {
        loopError = error;
      });
    },

    setAccounts(accounts) {
      if (stopped) throw new Error('polling scheduler: the scheduler is stopped');
      requireAccounts(accounts, 'setAccounts');
      applyAccounts(accounts);
    },

    setIntervalMs(nextIntervalMs) {
      if (stopped) throw new Error('polling scheduler: the scheduler is stopped');
      intervalMs = requireIntervalMs(nextIntervalMs, 'setIntervalMs');
      const mono = monotonicNow();
      for (const entry of entries.values()) {
        const suspended = isSuspended(suspensions.suspensionOf(entry.account.accountId));
        // Re-anchor from now: an interval change must never leave a stale
        // long wait pending, and never fire earlier than one new interval.
        // The jitter roll is drawn per entry, only when the re-anchoring row
        // consumes it (the suspended row keeps §7.2's fixed cadence — the
        // mono reading itself was already taken once, as before).
        setPlan(entry, {
          kind: 'interval-changed',
          suspended,
          ...(suspended
            ? {}
            : { nowMonotonicMs: mono, nextDelayMs: pollingDelayMs(intervalMs, random) }),
        });
      }
      kick();
    },

    requestManualTest(accountId) {
      if (stopped) throw new Error('polling scheduler: the scheduler is stopped');
      const entry = entries.get(accountId);
      if (entry === undefined) return false;
      // D-064's unconditional release through the shared store. The
      // manual-test observation (src/server/providers.ts) applies the same
      // transition just before this bridge; the second application is a
      // no-op on the released state, and the engine's standalone coherence
      // (its own tests, a non-composed embedding) requires it.
      suspensions.manualTestRequested(accountId);
      // The owed attempt is a plan variant, not a due timestamp: it survives
      // an in-flight cycle (whose settle rescheduling would overwrite a due,
      // review P2-3) and an interval change, and is consumed at dispatch —
      // through the loop, so the sequential and overlap rules hold (D-066).
      setPlan(entry, { kind: 'manual-test-requested' });
      kick();
      return true;
    },

    manualTestRejected(accountId) {
      if (stopped) throw new Error('polling scheduler: the scheduler is stopped');
      const entry = entries.get(accountId);
      if (entry === undefined) return false;
      // The D-064 re-entry is the observation wrapper's single application
      // to the shared store (under the tested key's identity); the
      // engine-side half drops the owed attempt (if never dispatched) — a
      // key the provider just refused has nothing left to try, and the
      // probe cadence owns the next attempt.
      setPlan(entry, { kind: 'manual-test-rejected' });
      kick();
      return true;
    },

    stop() {
      stopPromise ??= (async (): Promise<void> => {
        stopped = true;
        for (const flight of flights) flight.controller.abort();
        kick();
        if (loopPromise !== undefined) await loopPromise;
      })();
      return stopPromise;
    },

    get running() {
      // False once the loop has died of a wiring failure too — a scheduler
      // that stopped scheduling must not report itself healthy.
      return started && !stopped && loopError === undefined;
    },
  };

  return scheduler;
}
