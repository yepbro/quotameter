/**
 * The §15.2 login rate limiter (task 156, decision D-125) — the third of
 * the §15.2 primitives inside the future `AuthService` the services README
 * pins, beside `password-hash.ts` (D-118/D-122: the credential format and
 * its verification) and `sessions.ts` (D-123/D-124: the session token's
 * minting, verdict, and revocation). Spec §15.2: "Rate-limit authentication
 * to no more than five failed attempts per source address within 15
 * minutes, then apply increasing delays. Log failed attempts at `warn`
 * without logging passwords."
 *
 * Like its siblings this is the primitive the future login endpoint
 * composes, not HTTP surface: the endpoint resolves the source address
 * from the request, asks {@link LoginRateLimiter.delayBeforeAttempt} how
 * long this attempt must wait, sleeps that long (the timer is the
 * endpoint's — a service-layer sleep would be untestable without fake
 * timers and would block the event loop if implemented naively), verifies
 * the password with `verifyPassword`, and reports the outcome through
 * {@link LoginRateLimiter.recordAttempt}. No endpoint exists yet; nothing
 * here imports `src/server/`.
 *
 * Pinned interpretations (D-125):
 *
 * - **The window slides and expires half-open.** "within 15 minutes"
 *   counts the failures in any 15-minute span, not an aligned fixed
 *   bucket (a fixed bucket lets five failures at a bucket's end and five
 *   at the next bucket's start pass as neighbors). A failure exactly
 *   {@link LOGIN_RATE_LIMIT_WINDOW_MS} old is outside the window — the
 *   D-124 half-open discipline — so the counted set is the half-open
 *   interval `(now − window, now]`.
 * - **Five failures are admitted undelayed; then delays, never
 *   rejections.** With `n` in-window failures for the source, the next
 *   attempt waits `0` while `n < 5`, and `BASE × 2^(n−5)` (capped at the
 *   window length) once the budget is spent — the §7.2 doubling family
 *   (D-059's `RETRY_BASE_DELAYS_MS` precedent) at login scale. §15.2
 *   says "apply increasing delays", not "lock out": an over-budget
 *   attempt is answered slowly, never refused, so a legitimate user who
 *   mistypes five times still logs in — later — and a serially
 *   attacking source's guessing rate collapses to the delay cadence
 *   (concurrent requests can race the check-then-record window and each
 *   wait the same delay; holding the cadence under concurrency is the
 *   endpoint's composition — serialize per source — recorded in D-125's
 *   consequences).
 * - **A successful login resets the source's budget.** The budget exists
 *   to slow credential guessing; a verified password ends the guessing.
 *   The reset is deletion of the source's entry, so the next failure
 *   starts from an empty history.
 * - **The delay is computed from history, before verification.** The
 *   budget is spent by *failed* attempts (§15.2's own word), so an
 *   attempt is delayed for the failures before it and counted once its
 *   outcome is known; the endpoint's check-then-record composition is
 *   the honest ordering, and concurrent attempts racing inside it can
 *   only ever under-delay a burst whose failures have not landed yet —
 *   the next attempt sees the full count.
 * - **Memory is bounded with behaviorally exact counting.** Per source
 *   only the newest {@link LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES}
 *   failure timestamps are retained, and the retention trim sorts by
 *   stamp value first, so the retained set is always the largest
 *   stamps by value whatever the clock did (an insertion-order trim
 *   would drop a still-in-window stamp instead of an expired one after
 *   a regressed record — the review round's catch). Because
 *   in-window-ness is monotone in stamp value, the bounded count is
 *   exactly `min(k, bound)` of the unbounded history's `k` for every
 *   clock reading, and counts at or above the delay formula's
 *   saturation point (the smallest `n` whose delay equals the cap) all
 *   produce the capped delay — so the bounded history answers
 *   identically to an unbounded one, under the same sweep, for every
 *   count and every clock reading (pinned executably against the raw
 *   formula, including a regressed-clock trim case).
 *   Map-wide, a sweep at most once per window drops sources whose
 *   failures have all expired: the map never holds more than the
 *   sources active in roughly the last two windows. The sweep's
 *   deletion decision is identical to an unbounded history's would be
 *   (the largest stamp is always retained, so an all-expired retained
 *   set means every dropped stamp was expired no later), which keeps
 *   the bounded and unbounded systems aligned; the deletion side is
 *   behaviorally invisible under a non-regressing clock — an entry
 *   whose failures have all expired answers zero and counts from zero
 *   at the next record whether deleted or retained — so that side's
 *   contract is memory, stated here and in D-125; the keep side
 *   (entries with live failures survive the sweep) is pinned
 *   observably by the tests.
 *   State is in-memory only: a restart clears every budget (§15.2
 *   assigns no persistence to rate-limit state, and restart rights are
 *   operator privileges, not attacker ones).
 * - **No credentials, no logger, no clocks of its own.** The module's
 *   inputs are an opaque source key (never parsed — the endpoint owns
 *   what "source address" means on the wire), the outcome label, and an
 *   explicit `now` (the D-021 house seam; fake-clock tests pass
 *   readings directly). A non-integer `now` fails fast with a
 *   field-naming `TypeError` before any state changes (the D-090
 *   safe-integer family), and a regressed wall reading is trusted like
 *   every other wall stamp — it can only widen the counted window, the
 *   fail-closed direction. The module holds no logger: §15.2's
 *   "log failed attempts at `warn` without logging passwords" belongs
 *   to the endpoint layer, which sees the attempt; the contract for
 *   that layer is one `warn` record per failed attempt carrying the
 *   source address and outcome only — never the candidate password,
 *   the stored hash, or any session token (§15.4; the endpoint's own
 *   marker-secret test owns that pin).
 */

/**
 * The §15.2 failure budget — how many failed attempts a source address
 * makes before delays begin. Frozen as an exported literal so the tests
 * pin the spec number executably against the module's own arithmetic.
 */
export const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;

/**
 * The §15.2 window in epoch milliseconds — fifteen minutes. Failures
 * older than this (half-open: exactly this old counts as older) leave
 * the source's budget.
 */
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60_000;

/**
 * The first over-budget delay, in epoch milliseconds — one second. Each
 * further in-window failure doubles the delay (the D-059 doubling
 * family), so the sequence from the sixth failure is 1 s, 2 s, 4 s, …
 */
export const LOGIN_RATE_LIMIT_BASE_DELAY_MS = 1_000;

/**
 * The ceiling over-budget delays grow to — the window length itself. A
 * delay longer than the window would outlive the failures that caused
 * it, and pegging the cadence at one attempt per window is already the
 * strongest throttle this budget implies.
 */
export const LOGIN_RATE_LIMIT_MAX_DELAY_MS = LOGIN_RATE_LIMIT_WINDOW_MS;

/**
 * How many failure timestamps one source's entry retains (the largest
 * stamps by value — the trim sorts before cutting, so a regressed
 * clock cannot change which stamp drops). Equals the delay formula's saturation count — the smallest `n`
 * at which `BASE × 2^(n−5)` reaches the cap — so truncating the list
 * here cannot change any answer: for `n` in-window failures the counted
 * value is `min(n, this bound)`, and both sides of that `min` map to
 * the capped delay at and above saturation. A unit test derives the
 * saturation count from the exported constants and pins it against this
 * bound, so a future constant change that breaks the equality fails the
 * suite.
 */
export const LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES = 15;

/** The outcome of one processed login attempt, as the endpoint reports it. */
export type LoginAttemptOutcome =
  /** The presented password verified — resets the source's budget. */
  | 'success'
  /** The presented password failed — consumes one unit of the budget. */
  | 'failure';

/** The per-source §15.2 budget the future login endpoint composes. */
export interface LoginRateLimiter {
  /**
   * How many milliseconds this attempt from `source` must wait before
   * being processed — `0` while the source's in-window failure count is
   * under {@link LOGIN_RATE_LIMIT_MAX_FAILURES}, otherwise the growing
   * (and capped) §15.2 delay. Read-only: the query never changes any
   * answer the limiter would give, for this source or any other (the
   * map, and every entry in it, is touched only by
   * {@link recordAttempt}). The caller sleeps; this module never does.
   */
  delayBeforeAttempt(source: string, now: number): number;
  /**
   * Reports one processed attempt's outcome. A failure appends `now` to
   * the source's retained history (pruning what the window has already
   * expired); a success deletes the history — the budget resets. Also
   * the only place the periodic sweep of fully-expired sources runs, so
   * the map's growth contract holds under record-bearing traffic.
   */
  recordAttempt(source: string, outcome: LoginAttemptOutcome, now: number): void;
}

/** One source address's retained failure history. */
interface SourceFailures {
  /** Failure timestamps, ascending by value (largest last), at most the retention bound. */
  timestamps: number[];
}

/** The §15.2 delay for `recentFailures` in-window failures — the whole formula. */
function delayForFailureCount(recentFailures: number): number {
  if (recentFailures < LOGIN_RATE_LIMIT_MAX_FAILURES) {
    return 0;
  }
  const raw =
    LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2 ** (recentFailures - LOGIN_RATE_LIMIT_MAX_FAILURES);
  // `Math.min` is total over the `2 **` overflow (Infinity), so any
  // count the caller can name lands inside the cap.
  return Math.min(raw, LOGIN_RATE_LIMIT_MAX_DELAY_MS);
}

/**
 * The half-open window test: a failure is counted exactly while it is
 * strictly newer than `now − window` — at the window edge it is out
 * (D-124's boundary discipline; see the module header).
 */
function isWithinWindow(failedAtMs: number, now: number): boolean {
  return failedAtMs > now - LOGIN_RATE_LIMIT_WINDOW_MS;
}

/** How many of an entry's retained failures the window still counts. */
function countRecentFailures(entry: SourceFailures, now: number): number {
  let count = 0;
  for (const failedAtMs of entry.timestamps) {
    if (isWithinWindow(failedAtMs, now)) {
      count += 1;
    }
  }
  return count;
}

/**
 * The safe-integer fail-fast of the D-090 family: §11.1-style timestamps
 * are integer epoch milliseconds, and a fractional or non-finite `now`
 * is a caller bug this names before any state changes.
 */
function requireEpochMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `login rate limiter timestamp 'now' must be an integer epoch-milliseconds value, got ${value}`,
    );
  }
}

/**
 * Builds the §15.2 per-source failure budget — a closure like the
 * scheduler factories (`createPollingScheduler`, D-066), because the
 * state is per-process shared mutable memory that no caller should hold
 * or corrupt. One instance serves the whole login surface (every source
 * address keys its own budget inside it); create it once at composition
 * time and hand it to the login endpoint.
 */
export function createLoginRateLimiter(): LoginRateLimiter {
  const failuresBySource = new Map<string, SourceFailures>();
  let lastSweepAtMs: number | null = null;

  /** Drops sources whose retained failures have all left the window. */
  function sweepExpiredSources(now: number): void {
    for (const [source, entry] of failuresBySource) {
      if (countRecentFailures(entry, now) === 0) {
        failuresBySource.delete(source);
      }
    }
  }

  /** Runs the sweep at most once per window (the growth contract). */
  function sweepIfDue(now: number): void {
    if (lastSweepAtMs === null || now - lastSweepAtMs >= LOGIN_RATE_LIMIT_WINDOW_MS) {
      lastSweepAtMs = now;
      sweepExpiredSources(now);
    }
  }

  return {
    delayBeforeAttempt(source: string, now: number): number {
      requireEpochMilliseconds(now);
      const entry = failuresBySource.get(source);
      if (entry === undefined) {
        return 0;
      }
      return delayForFailureCount(countRecentFailures(entry, now));
    },

    recordAttempt(source: string, outcome: LoginAttemptOutcome, now: number): void {
      requireEpochMilliseconds(now);
      sweepIfDue(now);
      if (outcome === 'success') {
        // A verified password ends the guessing: the budget resets.
        failuresBySource.delete(source);
        return;
      }
      let entry = failuresBySource.get(source);
      if (entry === undefined) {
        entry = { timestamps: [] };
        failuresBySource.set(source, entry);
      }
      // The window's survivors first, the new failure on top, then the
      // value sort and the retention trim — keep the largest stamps by
      // value, drop the smallest. The sort keeps the trim exact under a
      // regressed clock too: insertion order would otherwise let the
      // trim drop a small still-in-window stamp while keeping a larger
      // expired one, under-counting against the unbounded history.
      entry.timestamps = entry.timestamps.filter((failedAtMs) => isWithinWindow(failedAtMs, now));
      entry.timestamps.push(now);
      entry.timestamps.sort((a, b) => a - b);
      if (entry.timestamps.length > LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES) {
        entry.timestamps.splice(
          0,
          entry.timestamps.length - LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES,
        );
      }
    },
  };
}
