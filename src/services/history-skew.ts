/**
 * Clock-skew tolerance for the §12.2/§13 history reads (task U-057,
 * decision D-185).
 *
 * The schema deliberately admits clock-skewed rows: D-034 rejected an
 * `ended_at >= started_at` CHECK on `collection_runs` because both stamps
 * are wall-clock reads (§7.1) around one HTTP cycle — a clock correction
 * between them is possible, and a rejected INSERT would lose the run record
 * permanently ("history tables must not turn skew into data loss"). The
 * write side therefore tolerates skew; these pure rules are the read
 * side's matching tolerance, applied where ordinary database rows enter the
 * §12.2 consumers — the API composition (`src/server/api/history.ts`), not
 * the detector services, whose fail-fast validation (D-075's
 * timeline-coverage throw, D-080's inverted-cycle throw) stays intact for
 * genuine wiring mistakes. One NTP step-back must not turn a valid database
 * into a 500 for the affected range.
 *
 * The rules (the explicit model — a fixed classification of evidence,
 * not scattered conditions):
 *
 * | Evidence                                       | Disposition                                    | Consumer-visible effect                                                                                       | Diagnostic            |
 * | ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- |
 * | Run with `endedAt < startedAt`                 | Span skipped: projected to zero duration at `startedAt` | The record still bounds silence (no fabricated stopped region across a cycle that ran) and a failed cycle still marks — at the trusted start stamp, `durationMs: 0`; the unreliable `endedAt` read never positions anything | `inverted_run`        |
 * | Point with `collectedAt` before the interval timeline's first change (or an empty timeline) | Unjudgeable — dropped from the gap detector's input only | No gap is minted from or to that point; the point itself still serves as series data (`/api/history` renders it — only the §12.2 judgment skips it) | `unjudgeable_point`   |
 *
 * - **Why an inverted run is projected, not dropped.** §12.2's stopped
 *   class is record-based ("periods with no collection-run records at
 *   all"): the row's EXISTENCE is the aliveness evidence, and existence
 *   does not depend on stamp ordering — dropping the row from the
 *   indicator walk lets two sub-threshold neighbor silences merge into one
 *   beyond-threshold span and fabricates a hatched outage across a cycle
 *   that demonstrably ran (the review round's P1: legs of 800 000 ms
 *   merging into a 1 600 000 ms region at the 300 s cadence's 990 000 ms
 *   threshold). The contradictory SPAN is what cannot be trusted: under a
 *   step-back, `startedAt` is the pre-correction (positionally anchored)
 *   read and `endedAt` the post-correction one, so the honest projection
 *   is a zero-duration cycle at `startedAt` — it never extends aliveness
 *   beyond the trusted stamp and never hides a failed cycle (the §14.4
 *   chart places markers on the start stamp alone and renders a
 *   non-positive duration as `0s`). Clamping the span is not "repairing
 *   evidence into shapes that never occurred": no duration is asserted
 *   (zero is the explicit "unknown-but-bounded" value), only the record's
 *   existence and start anchor are kept.
 * - **Why pre-coverage points are unjudgeable, not judged by a seeded
 *   timeline.** Extending the first interval change to cover all earlier
 *   instants would fabricate cadence coverage: after a 3600→60 interval
 *   change, pre-coverage points ten minutes apart would be judged by the
 *   seeded 60 s cadence (threshold 198 s) and mint a false gap, while the
 *   cadence actually in effect (threshold 11,880 s) says none — fabricating
 *   an outage is exactly what §12.2's honest-indicators purpose forbids.
 *   Leaving the pair unjudged follows D-075's fail-safe precedent
 *   (ambiguous schedule evidence resolves to no gap; §12.1's "do not create
 *   an event when evidence is ambiguous" spirit) and the timestamps
 *   themselves are untrustworthy in a skew-corrupted stretch.
 *
 * Diagnostics are data (the module is pure — no logger, no clock, no
 * storage): the caller aggregates them (`mergeSkewDiagnostics`) and
 * surfaces the result through §16 logging. Sanitized by construction —
 * kind, account, count, and epoch-millisecond bounds; never a row payload,
 * error message, or key — so they can never carry a secret (§7.4/§15.4).
 */

import type { IntervalChange } from './history-gaps';

/* ── Diagnostics (§16 vocabulary, sanitized by construction) ────────────── */

/** One tolerated inverted run: `count` rows, the affected set's stamp bounds. */
export interface InvertedRunDiagnostic {
  readonly kind: 'inverted_run';
  /** The account whose evidence contained the inverted rows. */
  readonly accountId: string;
  /** How many rows were projected. */
  readonly count: number;
  /** The earliest `startedAt` among the projected rows. */
  readonly earliestStartedAt: number;
  /** The latest `startedAt` among the projected rows. */
  readonly latestStartedAt: number;
}

/**
 * One unjudgeable-point report: `count` points precede the interval
 * timeline's coverage (`coverageFromEpochMs`; `null` when the timeline is
 * empty and therefore covers nothing), bounded by their stamps.
 */
export interface UnjudgeablePointDiagnostic {
  readonly kind: 'unjudgeable_point';
  /** The account whose series contained the unjudgeable points. */
  readonly accountId: string;
  /** How many points were dropped from gap judgment. */
  readonly count: number;
  /** The earliest `collectedAt` among the dropped points. */
  readonly earliestCollectedAt: number;
  /** The latest `collectedAt` among the dropped points. */
  readonly latestCollectedAt: number;
  /** The timeline's first change — the coverage bound — or `null` iff the timeline is empty. */
  readonly coverageFromEpochMs: number | null;
}

/** What the caller logs through §16 when the gate tolerates skew (D-185). */
export type SkewDiagnostic = InvertedRunDiagnostic | UnjudgeablePointDiagnostic;

/* ── Rule 1: inverted runs ──────────────────────────────────────────────── */

/** The stamps Rule 1 reads — any run shape carrying the §11.2 cycle pair. */
interface RunStamps {
  readonly startedAt: number;
  readonly endedAt: number;
}

/** {@link projectInvertedRuns}'s verdict: the indicator-safe runs plus the record of the projected. */
export interface InvertedRunVerdict<Run extends RunStamps> {
  /** The runs with a trustworthy span: inverted ones projected to zero
   * duration at their `startedAt`, in input order (a fresh array;
   * non-inverted runs pass through as the caller's own objects). */
  readonly runs: readonly Run[];
  /** Empty when nothing was projected; otherwise exactly one aggregated diagnostic. */
  readonly diagnostics: readonly SkewDiagnostic[];
}

/**
 * Projects inverted run records (`endedAt < startedAt`, the D-034-legal
 * clock skew a rejected CHECK would have turned into data loss) into
 * indicator-safe spans: the record is kept — its existence bounds
 * §12.2's record-based stopped silence, and a failed cycle still emits
 * its error marker — but its contradictory span collapses to zero
 * duration at the trusted `startedAt` read, so the unreliable `endedAt`
 * never positions a marker or an aliveness frontier. `endedAt ===
 * startedAt` is a legal zero-duration cycle and passes through
 * untouched, as does every non-inverted run (by reference). Generic over
 * any run shape carrying the two stamps, so the adapter layer
 * (`CollectionRunRecord` → `CollectionRunInput`) is untouched by the
 * tolerance; the input array is left untouched.
 */
export function projectInvertedRuns<Run extends RunStamps>(
  runs: readonly Run[],
  accountId: string,
): InvertedRunVerdict<Run> {
  const projected: Run[] = [];
  let count = 0;
  let earliestStartedAt = Number.POSITIVE_INFINITY;
  let latestStartedAt = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (run.endedAt >= run.startedAt) {
      projected.push(run);
      continue;
    }
    projected.push({ ...run, endedAt: run.startedAt });
    count++;
    if (run.startedAt < earliestStartedAt) earliestStartedAt = run.startedAt;
    if (run.startedAt > latestStartedAt) latestStartedAt = run.startedAt;
  }
  const diagnostics: SkewDiagnostic[] =
    count === 0
      ? []
      : [{ kind: 'inverted_run', accountId, count, earliestStartedAt, latestStartedAt }];
  return { runs: projected, diagnostics };
}

/* ── Rule 2: unjudgeable points ────────────────────────────────────────── */

/** The stamp Rule 2 reads — any point shape carrying §8.4's `collectedAt`. */
interface PointStamp {
  readonly collectedAt: number;
}

/** {@link dropUnjudgeablePoints}'s verdict: the judgeable points plus the record of the rest. */
export interface UnjudgeablePointVerdict<Point extends PointStamp> {
  /** The points inside the timeline's coverage, in input order (a fresh array). */
  readonly points: readonly Point[];
  /** Empty when nothing was dropped; otherwise exactly one aggregated diagnostic. */
  readonly diagnostics: readonly SkewDiagnostic[];
}

/**
 * Splits metric points into the gap-detector-consumable subset and a
 * sanitized record of the rest: a point whose `collectedAt` precedes the
 * interval timeline's first change has no cadence in effect to be judged by
 * (`intervalSecondsAt`'s coverage rule, D-075) — under clock skew a
 * snapshot's stamp can precede its own run's start — and is left
 * **unjudgeable**: no gap is minted from or to it (the fail-safe direction;
 * seeding the timeline with the first run's cadence would fabricate
 * coverage and can mint false gaps, D-185). The bound is inclusive — a
 * change exactly at a point's stamp applies to that point — and an empty
 * timeline covers nothing, so every point is dropped. The timeline must be
 * ascending by `effectiveFromEpochMs` (`intervalTimelineFromRuns`'s
 * contract); the input points and timeline are left untouched.
 */
export function dropUnjudgeablePoints<Point extends PointStamp>(
  points: readonly Point[],
  timeline: readonly IntervalChange[],
  accountId: string,
): UnjudgeablePointVerdict<Point> {
  const coverageFromEpochMs = timeline[0]?.effectiveFromEpochMs ?? null;
  const kept: Point[] = [];
  let count = 0;
  let earliestCollectedAt = Number.POSITIVE_INFINITY;
  let latestCollectedAt = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (coverageFromEpochMs !== null && point.collectedAt >= coverageFromEpochMs) {
      kept.push(point);
      continue;
    }
    count++;
    if (point.collectedAt < earliestCollectedAt) earliestCollectedAt = point.collectedAt;
    if (point.collectedAt > latestCollectedAt) latestCollectedAt = point.collectedAt;
  }
  const diagnostics: SkewDiagnostic[] =
    count === 0
      ? []
      : [
          {
            kind: 'unjudgeable_point',
            accountId,
            count,
            earliestCollectedAt,
            latestCollectedAt,
            coverageFromEpochMs,
          },
        ];
  return { points: kept, diagnostics };
}

/* ── The §16 aggregation ────────────────────────────────────────────────── */

/** The identity a diagnostic merges by: its judgment, account, and coverage bound. */
function diagnosticKey(diagnostic: SkewDiagnostic): string {
  return diagnostic.kind === 'inverted_run'
    ? `inverted_run|${diagnostic.accountId}`
    : `unjudgeable_point|${diagnostic.accountId}|${diagnostic.coverageFromEpochMs ?? 'empty'}`;
}

/**
 * Aggregates same-judgment diagnostics into one per key: counts sum and
 * the stamp bounds widen to the union, in first-appearance order — the
 * per-request §16 shape (one `warn` per rule per account), so a skewed
 * snapshot under a three-metric account logs one unjudgeable report, not
 * three. Diagnostics of different keys (different rules, accounts, or
 * coverage bounds) never merge — they describe different judgments.
 */
export function mergeSkewDiagnostics(diagnostics: readonly SkewDiagnostic[]): SkewDiagnostic[] {
  const merged: SkewDiagnostic[] = [];
  const indexByKey = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(diagnostic);
      continue;
    }
    // The key carries the kind, so the accumulated entry is same-kind.
    merged[index] =
      diagnostic.kind === 'inverted_run'
        ? mergeInvertedRuns(merged[index] as InvertedRunDiagnostic, diagnostic)
        : mergeUnjudgeablePoints(merged[index] as UnjudgeablePointDiagnostic, diagnostic);
  }
  return merged;
}

/** Merges two {@link InvertedRunDiagnostic}s of one account into one census. */
function mergeInvertedRuns(
  accumulator: InvertedRunDiagnostic,
  diagnostic: InvertedRunDiagnostic,
): InvertedRunDiagnostic {
  return {
    kind: 'inverted_run',
    accountId: accumulator.accountId,
    count: accumulator.count + diagnostic.count,
    earliestStartedAt: Math.min(accumulator.earliestStartedAt, diagnostic.earliestStartedAt),
    latestStartedAt: Math.max(accumulator.latestStartedAt, diagnostic.latestStartedAt),
  };
}

/** Merges two {@link UnjudgeablePointDiagnostic}s of one judgment into one census. */
function mergeUnjudgeablePoints(
  accumulator: UnjudgeablePointDiagnostic,
  diagnostic: UnjudgeablePointDiagnostic,
): UnjudgeablePointDiagnostic {
  return {
    kind: 'unjudgeable_point',
    accountId: accumulator.accountId,
    count: accumulator.count + diagnostic.count,
    earliestCollectedAt: Math.min(accumulator.earliestCollectedAt, diagnostic.earliestCollectedAt),
    latestCollectedAt: Math.max(accumulator.latestCollectedAt, diagnostic.latestCollectedAt),
    coverageFromEpochMs: accumulator.coverageFromEpochMs,
  };
}
