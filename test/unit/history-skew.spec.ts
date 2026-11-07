import { describe, expect, it } from 'vitest';
import type { IntervalChange } from '../../src/services/history-gaps';
import {
  dropUnjudgeablePoints,
  mergeSkewDiagnostics,
  projectInvertedRuns,
  type InvertedRunDiagnostic,
  type SkewDiagnostic,
  type UnjudgeablePointDiagnostic,
} from '../../src/services/history-skew';

/**
 * The D-185 gate's deterministic table (task U-057): the tolerance rules
 * the §13 history/events composition applies to clock-skewed evidence —
 * inverted runs (`ended_at < started_at`, the D-034-legal skew a rejected
 * CHECK would have turned into data loss) projected to zero-duration
 * cycles at their trusted `startedAt` (the record still bounds
 * §12.2's record-based stopped silence — dropping it could merge two
 * legal neighbor silences into a fabricated outage, the review round's
 * P1), points preceding the interval timeline's coverage left unjudgeable
 * by the gap detector, and the per-request §16 aggregation of the
 * diagnostics. The properties (`history-skew.property.spec.ts`) prove the
 * shapes over generated input; this suite pins the boundaries: the
 * inclusive coverage edge, the zero-duration projection, aggregation
 * bounds, the empty-timeline arm, and the merge keys.
 */

/** Deterministic §11.1 epoch-millisecond base. */
const NOW = 1_761_000_000_000;

/** One run-shaped record carrying exactly the stamps Rule 1 reads. */
interface RunStub {
  readonly startedAt: number;
  readonly endedAt: number;
}

/** One point-shaped record carrying exactly the stamp Rule 2 reads. */
interface PointStub {
  readonly collectedAt: number;
}

/** One ascending interval timeline entry (the single-cadence shape). */
function change(effectiveFromEpochMs: number): IntervalChange {
  return { effectiveFromEpochMs, intervalSeconds: 300 };
}

describe('projectInvertedRuns (Rule 1: the span is skipped, the record kept)', () => {
  it('returns clean input unchanged, as the same object references', () => {
    const first: RunStub = { startedAt: NOW, endedAt: NOW + 1_200 };
    const second: RunStub = { startedAt: NOW + 300_000, endedAt: NOW + 301_200 };
    const verdict = projectInvertedRuns([first, second], 'work');
    expect(verdict.runs).toEqual([first, second]);
    // Non-inverted rows pass through untouched — the caller's own objects.
    expect(verdict.runs[0]).toBe(first);
    expect(verdict.runs[1]).toBe(second);
    expect(verdict.diagnostics).toEqual([]);
  });

  it('keeps a zero-duration run as-is: endedAt === startedAt is legal, not skew', () => {
    const runs: RunStub[] = [{ startedAt: NOW, endedAt: NOW }];
    expect(projectInvertedRuns(runs, 'work')).toEqual({ runs, diagnostics: [] });
  });

  it('projects an inverted run to zero duration at its trusted start stamp', () => {
    const clean: RunStub = { startedAt: NOW, endedAt: NOW + 1_200 };
    const inverted: RunStub = { startedAt: NOW + 300_000, endedAt: NOW + 240_000 };
    const verdict = projectInvertedRuns([clean, inverted], 'work');
    // The record survives (it still bounds stopped silence and can still
    // mark a failed cycle); only the contradictory span collapses.
    expect(verdict.runs).toEqual([clean, { startedAt: NOW + 300_000, endedAt: NOW + 300_000 }]);
    expect(verdict.diagnostics).toEqual([
      {
        kind: 'inverted_run',
        accountId: 'work',
        count: 1,
        earliestStartedAt: NOW + 300_000,
        latestStartedAt: NOW + 300_000,
      },
    ] satisfies InvertedRunDiagnostic[]);
  });

  it('aggregates multiple inverted runs with earliest/latest stamp bounds', () => {
    const verdict = projectInvertedRuns(
      [
        { startedAt: NOW + 900_000, endedAt: NOW + 840_000 },
        { startedAt: NOW + 300_000, endedAt: NOW + 240_000 },
        { startedAt: NOW + 600_000, endedAt: NOW + 540_000 },
      ],
      'work',
    );
    expect(verdict.runs).toEqual([
      { startedAt: NOW + 900_000, endedAt: NOW + 900_000 },
      { startedAt: NOW + 300_000, endedAt: NOW + 300_000 },
      { startedAt: NOW + 600_000, endedAt: NOW + 600_000 },
    ]);
    expect(verdict.diagnostics).toEqual([
      {
        kind: 'inverted_run',
        accountId: 'work',
        count: 3,
        earliestStartedAt: NOW + 300_000,
        latestStartedAt: NOW + 900_000,
      },
    ]);
  });

  it('leaves the input array untouched and answers a fresh array', () => {
    const runs: RunStub[] = [
      { startedAt: NOW, endedAt: NOW - 1 },
      { startedAt: NOW + 300_000, endedAt: NOW + 301_200 },
    ];
    const verdict = projectInvertedRuns(runs, 'work');
    expect(verdict.runs).not.toBe(runs);
    expect(runs).toEqual([
      { startedAt: NOW, endedAt: NOW - 1 },
      { startedAt: NOW + 300_000, endedAt: NOW + 301_200 },
    ]);
  });

  it('answers empty for empty input, with no diagnostic', () => {
    expect(projectInvertedRuns([], 'work')).toEqual({ runs: [], diagnostics: [] });
  });
});

describe('dropUnjudgeablePoints (Rule 2: pre-coverage points are unjudgeable)', () => {
  it('returns fully covered input unchanged with no diagnostics', () => {
    const points: PointStub[] = [{ collectedAt: NOW }, { collectedAt: NOW + 300_000 }];
    const verdict = dropUnjudgeablePoints(points, [change(NOW)], 'work');
    expect(verdict.points).toEqual(points);
    expect(verdict.diagnostics).toEqual([]);
  });

  it('keeps a point exactly at the coverage start: the change applies to it', () => {
    // intervalSecondsAt resolves a change at a point's own stamp inclusively
    // (D-075), so the coverage bound is inclusive.
    const atStart: PointStub = { collectedAt: NOW + 300_000 };
    const verdict = dropUnjudgeablePoints(
      [atStart, { collectedAt: NOW + 600_000 }],
      [change(NOW + 300_000)],
      'work',
    );
    expect(verdict.points).toEqual([atStart, { collectedAt: NOW + 600_000 }]);
    expect(verdict.diagnostics).toEqual([]);
  });

  it('drops a point 1 ms before the first change and reports the bounds', () => {
    const verdict = dropUnjudgeablePoints(
      [{ collectedAt: NOW + 299_999 }, { collectedAt: NOW + 600_000 }],
      [change(NOW + 300_000)],
      'work',
    );
    expect(verdict.points).toEqual([{ collectedAt: NOW + 600_000 }]);
    expect(verdict.diagnostics).toEqual([
      {
        kind: 'unjudgeable_point',
        accountId: 'work',
        count: 1,
        earliestCollectedAt: NOW + 299_999,
        latestCollectedAt: NOW + 299_999,
        coverageFromEpochMs: NOW + 300_000,
      },
    ] satisfies UnjudgeablePointDiagnostic[]);
  });

  it('aggregates unsorted dropped points with earliest/latest bounds', () => {
    // The dropped set arrives later-stamp first: bounds are min/max over the
    // stamps, independent of input order.
    const verdict = dropUnjudgeablePoints(
      [{ collectedAt: NOW + 200_000 }, { collectedAt: NOW }, { collectedAt: NOW + 100_000 }],
      [change(NOW + 300_000)],
      'work',
    );
    expect(verdict.points).toEqual([]);
    expect(verdict.diagnostics).toEqual([
      {
        kind: 'unjudgeable_point',
        accountId: 'work',
        count: 3,
        earliestCollectedAt: NOW,
        latestCollectedAt: NOW + 200_000,
        coverageFromEpochMs: NOW + 300_000,
      },
    ]);
  });

  it('judges coverage by the FIRST change of a multi-change timeline', () => {
    const verdict = dropUnjudgeablePoints(
      [{ collectedAt: NOW }, { collectedAt: NOW + 450_000 }],
      [change(NOW + 300_000), change(NOW + 600_000)],
      'work',
    );
    expect(verdict.points).toEqual([{ collectedAt: NOW + 450_000 }]);
    expect(verdict.diagnostics[0]).toMatchObject({ count: 1, coverageFromEpochMs: NOW + 300_000 });
  });

  it('drops every point against an empty timeline, reporting null coverage', () => {
    // No runs in the evidence set ⇒ no cadence anywhere ⇒ nothing is
    // judgeable; the null coverage bound says "the timeline is empty", not
    // "coverage starts at zero".
    const points: PointStub[] = [{ collectedAt: NOW }, { collectedAt: NOW + 300_000 }];
    const verdict = dropUnjudgeablePoints(points, [], 'work');
    expect(verdict.points).toEqual([]);
    expect(verdict.diagnostics).toEqual([
      {
        kind: 'unjudgeable_point',
        accountId: 'work',
        count: 2,
        earliestCollectedAt: NOW,
        latestCollectedAt: NOW + 300_000,
        coverageFromEpochMs: null,
      },
    ]);
  });

  it('answers empty for empty input, with no diagnostic', () => {
    expect(dropUnjudgeablePoints([], [change(NOW)], 'work')).toEqual({
      points: [],
      diagnostics: [],
    });
  });

  it('leaves the input arrays untouched and answers a fresh array', () => {
    const points: PointStub[] = [{ collectedAt: NOW }, { collectedAt: NOW + 300_000 }];
    const timeline: IntervalChange[] = [change(NOW + 150_000)];
    const verdict = dropUnjudgeablePoints(points, timeline, 'work');
    expect(verdict.points).not.toBe(points);
    expect(points).toEqual([{ collectedAt: NOW }, { collectedAt: NOW + 300_000 }]);
    expect(timeline).toEqual([change(NOW + 150_000)]);
  });
});

describe('mergeSkewDiagnostics (the per-request §16 aggregation)', () => {
  /** One unjudgeable diagnostic with explicit bounds. */
  function unjudgeable(
    count: number,
    earliest: number,
    latest: number,
    coverage: number | null = NOW,
  ): UnjudgeablePointDiagnostic {
    return {
      kind: 'unjudgeable_point',
      accountId: 'work',
      count,
      earliestCollectedAt: earliest,
      latestCollectedAt: latest,
      coverageFromEpochMs: coverage,
    };
  }

  it('sums counts and widens bounds within one judgment key, keeping first-appearance order', () => {
    const inverted: InvertedRunDiagnostic = {
      kind: 'inverted_run',
      accountId: 'work',
      count: 1,
      earliestStartedAt: NOW,
      latestStartedAt: NOW,
    };
    const merged = mergeSkewDiagnostics([
      inverted,
      unjudgeable(1, NOW, NOW),
      unjudgeable(2, NOW - 500, NOW + 100),
    ]);
    expect(merged).toEqual([
      inverted,
      {
        kind: 'unjudgeable_point',
        accountId: 'work',
        count: 3,
        earliestCollectedAt: NOW - 500,
        latestCollectedAt: NOW + 100,
        coverageFromEpochMs: NOW,
      },
    ]);
  });

  it('merges inverted-run diagnostics of one account the same way', () => {
    const merged = mergeSkewDiagnostics([
      {
        kind: 'inverted_run',
        accountId: 'work',
        count: 1,
        earliestStartedAt: NOW + 100,
        latestStartedAt: NOW + 100,
      },
      {
        kind: 'inverted_run',
        accountId: 'work',
        count: 2,
        earliestStartedAt: NOW - 300,
        latestStartedAt: NOW + 900,
      },
    ]);
    expect(merged).toEqual([
      {
        kind: 'inverted_run',
        accountId: 'work',
        count: 3,
        earliestStartedAt: NOW - 300,
        latestStartedAt: NOW + 900,
      },
    ]);
  });

  it('never merges across coverage bounds: different judgments stay apart', () => {
    // A null-coverage (empty-timeline) report and a bounded-coverage report
    // describe different evidence states; collapsing them would lie about
    // the bound.
    const merged = mergeSkewDiagnostics([unjudgeable(1, NOW, NOW), unjudgeable(1, NOW, NOW, null)]);
    expect(merged).toHaveLength(2);
  });

  it('passes a single diagnostic of each kind through as the merged shape', () => {
    const diagnostics: SkewDiagnostic[] = [
      {
        kind: 'inverted_run',
        accountId: 'work',
        count: 1,
        earliestStartedAt: NOW,
        latestStartedAt: NOW + 1,
      },
      unjudgeable(1, NOW, NOW),
    ];
    expect(mergeSkewDiagnostics(diagnostics)).toEqual(diagnostics);
  });

  it('answers empty for empty input', () => {
    expect(mergeSkewDiagnostics([])).toEqual([]);
  });
});
