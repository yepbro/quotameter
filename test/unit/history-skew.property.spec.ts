import { describe, expect, it } from 'vitest';
import type { IntervalChange } from '../../src/services/history-gaps';
import { dropUnjudgeablePoints, projectInvertedRuns } from '../../src/services/history-skew';
import { fc } from '../helpers/property';

/**
 * Property-based coverage of the D-185 gate (task U-057), the standing
 * complement to `history-skew.spec.ts`: Rule 1 is a per-record projection
 * (same length, same order; inverted spans collapse to zero duration at
 * the trusted `startedAt`; non-inverted rows pass through by reference),
 * Rule 2 is an order-preserving partition (the kept set is exactly the
 * input filtered by the coverage predicate), and each rule's single
 * aggregated diagnostic reports exactly the affected set's size and stamp
 * bounds. Clean input is the identity. These shapes are what the §13
 * composition leans on: no row is lost or duplicated by the tolerance,
 * the record's existence survives (it bounds §12.2's stopped silence),
 * and the §16 diagnostic is an honest census of what was tolerated.
 */

/** 2026-11-07T12:00:00Z — the base stamp of every generated record. */
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);

/** Stamps within ±1 day of the base, in whole seconds. */
const stampArb = fc.integer({ min: T0 - 86_400_000, max: T0 + 86_400_000 });

/** One run-shaped record: the two stamps Rule 1 reads. */
const runArb = fc.record({ startedAt: stampArb, endedAt: stampArb });

/** One point-shaped record: the single stamp Rule 2 reads. */
const pointArb = fc.record({ collectedAt: stampArb });

/** An ascending, change-deduped interval timeline (the precondition's shape). */
function ascendingTimeline(stamps: readonly number[]): IntervalChange[] {
  const changes: IntervalChange[] = [];
  for (const effectiveFromEpochMs of [...new Set(stamps)].sort((a, b) => a - b)) {
    changes.push({ effectiveFromEpochMs, intervalSeconds: 300 });
  }
  return changes;
}

describe('projectInvertedRuns projects runs (D-185 Rule 1)', () => {
  it('output = the input with inverted spans collapsed to zero duration; diagnostic = the projected census', () => {
    fc.assert(
      fc.property(fc.array(runArb, { maxLength: 30 }), (runs) => {
        const verdict = projectInvertedRuns(runs, 'acct');
        const inverted = runs.filter((run) => run.endedAt < run.startedAt);
        // Same length, same order: every record survives (it still bounds
        // stopped silence) — only the contradictory span collapses.
        expect(verdict.runs).toHaveLength(runs.length);
        expect(verdict.runs).toEqual(
          runs.map((run) =>
            run.endedAt < run.startedAt ? { ...run, endedAt: run.startedAt } : run,
          ),
        );
        // Non-inverted rows pass through as the caller's own objects.
        for (const [index, run] of runs.entries()) {
          if (run.endedAt >= run.startedAt) expect(verdict.runs[index]).toBe(run);
        }
        if (inverted.length === 0) {
          expect(verdict.diagnostics).toEqual([]);
        } else {
          const stamps = inverted.map((run) => run.startedAt);
          expect(verdict.diagnostics).toEqual([
            {
              kind: 'inverted_run',
              accountId: 'acct',
              count: inverted.length,
              earliestStartedAt: Math.min(...stamps),
              latestStartedAt: Math.max(...stamps),
            },
          ]);
        }
      }),
    );
  });
});

describe('dropUnjudgeablePoints partitions points (D-185 Rule 2)', () => {
  it('kept = the covered input in order; diagnostic = the dropped census', () => {
    fc.assert(
      fc.property(
        fc.array(pointArb, { maxLength: 30 }),
        fc.array(stampArb, { maxLength: 5 }),
        (points, stamps) => {
          const timeline = ascendingTimeline(stamps);
          const verdict = dropUnjudgeablePoints(points, timeline, 'acct');
          const coverage = timeline[0]?.effectiveFromEpochMs;
          const covered = (collectedAt: number): boolean =>
            coverage !== undefined && collectedAt >= coverage;
          expect(verdict.points).toEqual(points.filter((point) => covered(point.collectedAt)));
          const dropped = points.filter((point) => !covered(point.collectedAt));
          if (dropped.length === 0) {
            expect(verdict.diagnostics).toEqual([]);
          } else {
            const stampsDropped = dropped.map((point) => point.collectedAt);
            expect(verdict.diagnostics).toEqual([
              {
                kind: 'unjudgeable_point',
                accountId: 'acct',
                count: dropped.length,
                earliestCollectedAt: Math.min(...stampsDropped),
                latestCollectedAt: Math.max(...stampsDropped),
                coverageFromEpochMs: coverage ?? null,
              },
            ]);
          }
        },
      ),
    );
  });

  it('drops everything against an empty timeline (null coverage)', () => {
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 10 }), (points) => {
        const verdict = dropUnjudgeablePoints(points, [], 'acct');
        expect(verdict.points).toEqual([]);
        if (points.length > 0) {
          expect(verdict.diagnostics).toHaveLength(1);
          expect(verdict.diagnostics[0]).toMatchObject({
            kind: 'unjudgeable_point',
            count: points.length,
            coverageFromEpochMs: null,
          });
        } else {
          expect(verdict.diagnostics).toEqual([]);
        }
      }),
    );
  });
});

describe('the gate is the identity on clean evidence', () => {
  it('no inverted runs and full coverage keep every record, silently', () => {
    fc.assert(
      fc.property(
        fc.array(runArb, { maxLength: 20 }).map((runs) =>
          runs.map((run) => ({
            startedAt: run.startedAt,
            endedAt: Math.max(run.endedAt, run.startedAt),
          })),
        ),
        fc.array(pointArb, { maxLength: 20 }),
        (runs, laterPoints) => {
          const runStarts = runs.map((run) => run.startedAt);
          const coverage = runStarts.length > 0 ? Math.min(...runStarts) : T0;
          const points = laterPoints.map((point) => ({
            collectedAt: Math.max(point.collectedAt, coverage),
          }));
          expect(projectInvertedRuns(runs, 'acct')).toEqual({ runs, diagnostics: [] });
          expect(dropUnjudgeablePoints(points, ascendingTimeline([coverage]), 'acct')).toEqual({
            points,
            diagnostics: [],
          });
        },
      ),
    );
  });
});
