/**
 * Timeline indicators for collection errors and downtime (spec §12.2; task
 * 120, decision D-080).
 *
 * The second half of §12.2 as one pure function, complementary to task 119:
 * `history-gaps.ts` (D-075) finds the intervals between adjacent
 * **successful metric points** whose silence exceeds three effective polling
 * intervals — this module derives the two indicator classes §12.2 asks the
 * timeline to show **from the run records themselves**:
 *
 * - **(a) failed collection cycles** — `collection_runs` rows with a
 *   non-success outcome, one {@link CollectionErrorIndicator} per cycle,
 *   typed by the §11.2 outcome (D-034/D-048 vocabulary, imported — never
 *   redefined) so the chart can give each error class "a distinct
 *   symbol/tooltip" (§12.2) on its "lower timeline strip" (§14.4);
 * - **(b) stopped-service periods** — maximal sub-intervals of the query
 *   range holding **no run record at all** (success or failure), shown as the
 *   hatched "service was stopped" area (§12.2). A run row is written for
 *   every executed cycle whatever its outcome (§11.1), so record silence is
 *   exactly "no collection activity"; D-069 pinned the same boundary from
 *   the write side — a `stop()` abort is deliberately unpersisted and thus
 *   lands in this class, not among the failed cycles.
 *
 * The two classes stay structurally distinguishable — the task's
 * done-condition — through the `kind` discriminant: error indicators carry
 * an `outcome`, stopped-service indicators carry none. `GET /api/events`
 * (§13 serves "resets, gaps, and collection failures") can serialize the
 * union as-is.
 *
 * Interpretations pinned in D-080 (highlights; the full reasoning lives
 * there):
 *
 * - **One indicator per failed cycle, no merging.** §12.2's symbols and
 *   §14.4's markers are per-cycle; merging would erase adjacent distinct
 *   failure types and §7.2's per-cycle attempt count.
 * - **The stopped threshold is §12.2's own silence vocabulary** — the same
 *   three jitter-expanded effective intervals D-075 defined
 *   ({@link gapThresholdMs}, imported: one source of truth, the D-070
 *   precedent), strict "exceeds". A live service writes a run row every
 *   cycle, so record silence beyond three stretched intervals is the
 *   stopped class; below it lies the legitimate inter-poll cadence
 *   (§7.1's interval + jitter). `Retry-After` deferrals (§7.2) and
 *   auth-suspension probe gaps are deliberately **not** subtracted: D-075's
 *   precedent keeps scheduler policy gates out of the §12.2 history view,
 *   and the class is record-based — the deferral evidence
 *   (`retryAfterSeconds`, `outcome`) travels on the boundary runs for
 *   consumers to refine tooltips.
 * - **Silence is judged by the boundary runs' own cadence stamps**, widened
 *   to the more permissive of the two — D-075's span-widening with the
 *   per-run `interval_seconds` (D-069) as the evidence; a mid-silence §6.4
 *   interval change re-anchors the schedule (D-066), and the fail-safe
 *   direction is no region.
 *
 * Run records plus an explicit query range go in, indicators come out —
 * nothing here reads storage, knows the clock (D-021: timestamps are data),
 * or decides what a chart does with an indicator.
 */

import type { EpochMs } from '../util/clock';
import { compareEpochMs } from '../util/compare-epoch-ms';
import { gapThresholdMs } from './history-gaps';
import {
  COLLECTION_OUTCOMES,
  isCollectionOutcome,
  type CollectionOutcome,
} from './polling-outcomes';
import { RETRY_AFTER_MAX_SECONDS } from './polling-retry-after';
import { MAX_POLLING_INTERVAL_MS, MIN_POLLING_INTERVAL_MS } from './polling-scheduler';

/* ── The input model (§11.2 `collection_runs` vocabulary) ───────────────── */

/**
 * The query range the timeline covers, §13's required `from`/`to` pair: UTC
 * epoch-millisecond bounds. `from === to` is a degenerate range — it can
 * yield at most the error indicators whose cycle started exactly at that
 * instant, never a stopped region (a region needs a span beyond the
 * threshold); `from > to` is a caller mistake and fails fast.
 */
export interface TimelineQueryRange {
  /** Inclusive lower bound, UTC epoch milliseconds. */
  readonly from: EpochMs;
  /** Inclusive upper bound, UTC epoch milliseconds. */
  readonly to: EpochMs;
}

/**
 * One `collection_runs` row as this service consumes it (spec §11.2): the
 * account, the cycle's wall-clock start/end, the §7.1 interval in effect
 * stamped per run (D-069), the §11.2 outcome, and §7.2's evidence — the
 * total attempt count plus the optional sanitized error fields the writer
 * persisted. All outcomes belong in the input: successes emit no indicator
 * but still bound stopped-service silence ("no run records **at all**",
 * §12.2). The §13 caller supplies the runs intersecting the range — the
 * records immediately outside it, when available, give the edge silences
 * their exact causal cadence anchor.
 */
export interface CollectionRunInput {
  /** The account the cycle ran for. */
  readonly accountId: string;
  /** §11.2 cycle start, UTC epoch milliseconds. */
  readonly startedAt: EpochMs;
  /** §11.2 cycle end, UTC epoch milliseconds; never before `startedAt`. */
  readonly endedAt: EpochMs;
  /** The §7.1 configured interval in effect for this cycle (60–3600 s). */
  readonly intervalSeconds: number;
  /** The §11.2 outcome (D-034/D-048 vocabulary). */
  readonly outcome: CollectionOutcome;
  /** §7.2's total attempt count for the cycle (1–4 at write time). */
  readonly attempts: number;
  /** §11.2 `http_status`, retained whenever a response arrived. */
  readonly httpStatus?: number;
  /** §11.2 sanitized `error_message`; absent on a clean success. */
  readonly errorMessage?: string;
  /** §7.2 `retry_after_seconds` — D-062's deferral decision, persisted by
   * D-069: present only on a deferred 429, `0` being the elapsed-HTTP-date
   * or literal `Retry-After: 0` boundary the `collection_runs` CHECK admits. */
  readonly retryAfterSeconds?: number;
}

/** The §11.2 failure outcomes — the error vocabulary minus `success`. */
export type FailedOutcome = Exclude<CollectionOutcome, 'success'>;

/* ── The output model (§12.2's two indicator classes) ──────────────────── */

/**
 * §12.2 class (a): one failed collection cycle, positioned at the cycle's
 * own `[startedAt, endedAt]` span — the marker sits at the cycle start, the
 * scheduled position on the timeline strip. Carries the run's evidence so
 * the §13 route and the §14.4 tooltip need no second lookup: the typed
 * outcome drives the distinct symbol, the rest fills the tooltip.
 */
export interface CollectionErrorIndicator {
  readonly kind: 'collection_error';
  /** The account the failed cycle ran for. */
  readonly accountId: string;
  /** The §11.2 failure outcome — never `success`. */
  readonly outcome: FailedOutcome;
  /** The cycle's `startedAt` — the marker position. */
  readonly fromEpochMs: number;
  /** The cycle's `endedAt`. */
  readonly toEpochMs: number;
  /** `toEpochMs − fromEpochMs` — the cycle's wall-clock duration. */
  readonly durationMs: number;
  /** §11.2 `http_status`, or `undefined` when no response arrived. */
  readonly httpStatus: number | undefined;
  /** §11.2 sanitized `error_message`, or `undefined` on a clean success. */
  readonly errorMessage: string | undefined;
  /** §7.2's total attempt count. */
  readonly attempts: number;
  /** §7.2 `retry_after_seconds`, or `undefined` outside a deferred 429. */
  readonly retryAfterSeconds: number | undefined;
}

/**
 * §12.2 class (b): one maximal interval of the query range with no
 * collection-run record at all — the hatched "service was stopped" area.
 * Deliberately carries **no** `outcome`: nothing was collected here, so
 * there is no failure type to report — the structural absence the
 * done-condition pins.
 */
export interface StoppedServiceIndicator {
  readonly kind: 'stopped_service';
  /** The account whose timeline holds the silence. */
  readonly accountId: string;
  /** The silence's start edge: the previous record's `endedAt`, or the
   * range's `from` when no earlier record exists. Clamped to the range. */
  readonly fromEpochMs: number;
  /** The silence's end edge: the next record's `startedAt`, or the range's
   * `to` when no later record exists. Clamped to the range. */
  readonly toEpochMs: number;
  /** `toEpochMs − fromEpochMs`. */
  readonly elapsedMs: number;
  /**
   * The cadence the silence was judged by: the more permissive of the two
   * boundary records' `intervalSeconds` (D-075's span-widening over the
   * per-run stamps), or the single bounding record's cadence at the range
   * edges.
   */
  readonly intervalSeconds: number;
  /** The threshold the silence exceeded: {@link gapThresholdMs}. */
  readonly thresholdMs: number;
}

/** One §12.2 timeline indicator — the `kind` discriminant separates the two
 * §12.2 classes an API consumer switches on. */
export type TimelineIndicator = CollectionErrorIndicator | StoppedServiceIndicator;

/* ── Validation (fail-fast, the D-059/D-064/D-075 convention) ──────────── */

/**
 * §7.1's configured-interval bounds in seconds — the scheduler's millisecond
 * constants are the one source of truth (D-070's precedent, the same import
 * `history-gaps.ts` uses); this module speaks seconds because the run rows
 * carry `interval_seconds` (D-069).
 */
const MIN_INTERVAL_SECONDS = MIN_POLLING_INTERVAL_MS / 1000;

/** {@link MIN_INTERVAL_SECONDS}'s ceiling twin: 3600 s. */
const MAX_INTERVAL_SECONDS = MAX_POLLING_INTERVAL_MS / 1000;

/**
 * Validates a per-run interval in seconds against §7.1's 60–3600 range —
 * the same bounds `history-gaps.ts` enforces, so a seconds/milliseconds
 * confusion in the wiring fails here instead of producing a nine-fold-off
 * threshold.
 */
function requireIntervalSeconds(intervalSeconds: number, caller: string): void {
  if (
    typeof intervalSeconds !== 'number' ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    throw new RangeError(
      `${caller}: intervalSeconds must be an integer in [${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}] (spec §7.1)`,
    );
  }
}

/**
 * Validates the query range: finite bounds in `from ≤ to` order. `from ===
 * to` is accepted (the degenerate range above).
 */
function requireRange(range: TimelineQueryRange, caller: string): void {
  if (typeof range !== 'object' || range === null) {
    throw new TypeError(`${caller}: range must be a TimelineQueryRange`);
  }
  if (typeof range.from !== 'number' || !Number.isFinite(range.from)) {
    throw new TypeError(`${caller}: range.from must be a finite UTC epoch-milliseconds timestamp`);
  }
  if (typeof range.to !== 'number' || !Number.isFinite(range.to)) {
    throw new TypeError(`${caller}: range.to must be a finite UTC epoch-milliseconds timestamp`);
  }
  if (range.from > range.to) {
    throw new RangeError(`${caller}: range.from must not exceed range.to`);
  }
}

/**
 * Validates the runs. Blank ids, non-finite timestamps, inverted cycles,
 * out-of-range cadences, unknown outcomes, and non-objects are caller
 * wiring mistakes (the §13 adapter translating `CollectionRunRecord`s, or a
 * test) and fail loudly with the offending index.
 */
function requireRuns(runs: readonly CollectionRunInput[], caller: string): void {
  if (!Array.isArray(runs)) {
    throw new TypeError(`${caller}: runs must be an array of CollectionRunInput`);
  }
  for (const [index, run] of runs.entries()) {
    const at = `${caller}: runs[${index}]`;
    if (typeof run !== 'object' || run === null) {
      throw new TypeError(`${at} must be a CollectionRunInput`);
    }
    if (typeof run.accountId !== 'string' || run.accountId.trim() === '') {
      throw new TypeError(`${at}.accountId must be a non-blank string`);
    }
    if (typeof run.startedAt !== 'number' || !Number.isFinite(run.startedAt)) {
      throw new TypeError(`${at}.startedAt must be a finite UTC epoch-milliseconds timestamp`);
    }
    if (typeof run.endedAt !== 'number' || !Number.isFinite(run.endedAt)) {
      throw new TypeError(`${at}.endedAt must be a finite UTC epoch-milliseconds timestamp`);
    }
    if (run.endedAt < run.startedAt) {
      throw new RangeError(`${at}.endedAt must not precede runs[${index}].startedAt`);
    }
    requireIntervalSeconds(run.intervalSeconds, at);
    if (!isCollectionOutcome(run.outcome)) {
      throw new TypeError(
        `${at}.outcome must be one of the §11.2 collection outcomes (${COLLECTION_OUTCOMES.join(', ')})`,
      );
    }
    if (typeof run.attempts !== 'number' || !Number.isInteger(run.attempts) || run.attempts < 1) {
      throw new TypeError(`${at}.attempts must be an integer >= 1 (spec §7.2 attempt count)`);
    }
    if (
      run.httpStatus !== undefined &&
      (!Number.isInteger(run.httpStatus) || run.httpStatus < 100 || run.httpStatus > 599)
    ) {
      throw new TypeError(`${at}.httpStatus must be an integer in [100, 599]`);
    }
    if (typeof run.errorMessage !== 'string' && run.errorMessage !== undefined) {
      throw new TypeError(`${at}.errorMessage must be a string when present`);
    }
    if (
      run.retryAfterSeconds !== undefined &&
      (!Number.isInteger(run.retryAfterSeconds) ||
        run.retryAfterSeconds < 0 ||
        run.retryAfterSeconds > RETRY_AFTER_MAX_SECONDS)
    ) {
      throw new TypeError(
        `${at}.retryAfterSeconds must be an integer in [0, ${RETRY_AFTER_MAX_SECONDS}] (spec §7.2 one-hour cap; 0 is the D-062 elapsed boundary)`,
      );
    }
  }
}

/* ── Derivation ────────────────────────────────────────────────────────── */

/** Pushes the stopped-service indicator for one silence, when it qualifies. */
function pushStoppedIndicator(
  indicators: TimelineIndicator[],
  accountId: string,
  fromEpochMs: number,
  toEpochMs: number,
  intervalSeconds: number,
): void {
  const thresholdMs = gapThresholdMs(intervalSeconds);
  const elapsedMs = toEpochMs - fromEpochMs;
  if (elapsedMs > thresholdMs) {
    indicators.push({
      kind: 'stopped_service',
      accountId,
      fromEpochMs,
      toEpochMs,
      elapsedMs,
      intervalSeconds,
      thresholdMs,
    });
  }
}

/**
 * Builds the §12.2 timeline indicators — the failed-cycle error markers and
 * the stopped-service silence regions — from a set of run records and an
 * explicit query range.
 *
 * The runs are partitioned by `accountId` (accounts never share indicators)
 * and each account is walked chronologically regardless of input order
 * (stable sort; equal `startedAt` keep input order). Per account:
 *
 * - every run with a non-`success` outcome whose `startedAt` falls inside
 *   the range (inclusive both ends — the marker position decides) yields one
 *   {@link CollectionErrorIndicator}; runs outside the range still bound
 *   silence but never display;
 * - the silence between the aliveness frontier (the maximum `endedAt` so
 *   far, clamped to the range) and the next record's `startedAt` — or the
 *   range edge, before the first and after the last record — yields a
 *   {@link StoppedServiceIndicator} when it strictly exceeds three
 *   effective intervals ({@link gapThresholdMs}) of the more permissive
 *   boundary cadence; a zero or negative span can never qualify.
 *
 * The result order is deterministic: accounts in the order their first run
 * appears in the input, and indicators within an account chronologically by
 * start — a region always starts strictly before the record that closes
 * it, so the single walk emits regions before their closing record's error
 * marker with no final sort. Empty input returns `[]` (no records, no
 * cadence evidence to judge silence by); a range with zero records but
 * records bounding it outside expresses its full-range downtime through
 * those bounding records.
 */
export function buildTimelineIndicators(
  runs: readonly CollectionRunInput[],
  range: TimelineQueryRange,
): TimelineIndicator[] {
  const caller = 'buildTimelineIndicators';
  requireRange(range, caller);
  requireRuns(runs, caller);

  // A Map partitions without composite-string keys (an id containing a
  // joiner character must never alias two timelines) and preserves
  // first-appearance order, which fixes the result order below.
  const byAccount = new Map<string, CollectionRunInput[]>();
  for (const run of runs) {
    const group = byAccount.get(run.accountId);
    if (group === undefined) byAccount.set(run.accountId, [run]);
    else group.push(run);
  }

  const indicators: TimelineIndicator[] = [];
  for (const [accountId, accountRuns] of byAccount) {
    // Array#sort is stable; the fresh array leaves the input untouched.
    const ordered = [...accountRuns].sort((a, b) => compareEpochMs(a.startedAt, b.startedAt));

    // The aliveness frontier: the record owning the latest cycle end
    // observed so far. During a cycle the service is up, so silence starts
    // at the frontier's end, never at a cycle's start — and the frontier's
    // own cadence stamp is the silence's left anchor. Ties (an equal end)
    // hand ownership to the record walked later: deterministic under the
    // stable sort.
    let frontier: CollectionRunInput | undefined;
    for (const run of ordered) {
      // The silence this record closes: from the frontier (or the range's
      // leading edge) up to the record's start, clamped to the range.
      const silenceFrom =
        frontier === undefined ? range.from : Math.max(frontier.endedAt, range.from);
      const silenceTo = Math.min(run.startedAt, range.to);
      const judgeSeconds =
        frontier === undefined
          ? run.intervalSeconds
          : Math.max(frontier.intervalSeconds, run.intervalSeconds);
      pushStoppedIndicator(indicators, accountId, silenceFrom, silenceTo, judgeSeconds);

      if (run.outcome !== 'success' && run.startedAt >= range.from && run.startedAt <= range.to) {
        indicators.push({
          kind: 'collection_error',
          accountId,
          outcome: run.outcome,
          fromEpochMs: run.startedAt,
          toEpochMs: run.endedAt,
          durationMs: run.endedAt - run.startedAt,
          httpStatus: run.httpStatus,
          errorMessage: run.errorMessage,
          attempts: run.attempts,
          retryAfterSeconds: run.retryAfterSeconds,
        });
      }

      if (frontier === undefined || run.endedAt >= frontier.endedAt) frontier = run;
    }

    // The trailing silence: from the frontier to the range's end, judged by
    // the frontier owner's own cadence.
    if (frontier !== undefined) {
      pushStoppedIndicator(
        indicators,
        accountId,
        Math.max(frontier.endedAt, range.from),
        range.to,
        frontier.intervalSeconds,
      );
    }
  }
  return indicators;
}
