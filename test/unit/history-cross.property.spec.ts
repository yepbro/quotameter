import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { detectSeriesResetEvents, type ResetPointInput } from '../../src/services/events-detection';
import {
  detectCollectionGaps,
  gapThresholdMs,
  type SuccessfulMetricPoint,
} from '../../src/services/history-gaps';
import {
  downsampleHistorySeries,
  type DownsampleBoundaries,
} from '../../src/services/history-downsample';
import {
  buildTimelineIndicators,
  type CollectionErrorIndicator,
  type CollectionRunInput,
  type StoppedServiceIndicator,
} from '../../src/services/history-timeline';
import { COLLECTION_OUTCOMES } from '../../src/services/polling-outcomes';

/**
 * Cross-module §12 properties (task 124): the landed suites prove each
 * module against its own oracle; these properties prove the modules
 * **compose** — that the boundaries one module emits are exactly the
 * boundaries another must respect, over deterministic generated scenarios
 * the whole pipeline could really produce.
 *
 * - **Detector output survives downsampling (§13 "must not be lost").** A
 *   generated fixed-period series is run through the actual D-074 detector
 *   (reset events) and the actual D-075 detector (collection gaps), and
 *   their outputs are fed to the D-081 downsampler as data: every gap's edge
 *   points must come back as bucket endpoints (the pre-side edge closes a
 *   bucket, the post-side edge opens one), and every reset instant must fall
 *   strictly between two consecutive buckets — no bucket swallows it.
 * - **Gaps and timeline indicators agree on shared silence (§12.2).** One
 *   generated run history drives both D-075 (metric points at the successful
 *   runs' starts) and D-080 (run records + range): every stopped-service
 *   region straddled by successful points is covered by a collection gap,
 *   and every collection gap is *explained* — it contains a stopped region
 *   or at least one failed-cycle error indicator. That is the §12.2 consumer
 *   promise: a chart line never breaks where the timeline shows nothing.
 *   Cycle durations are bounded well below the silence margin, keeping the
 *   two thresholds' different inputs (snapshot instants vs run end-to-start)
 *   from skewing past each other — the one deliberate divergence this
 *   generator bounds away, recorded as decision D-084.
 *
 * Determinism: `fc` from the shared helper (100 runs, `FC_SEED` pinning);
 * every timestamp is generated data anchored at a fixed `T0` (D-021) — no
 * clock, no wall time, no `TZ` dependence.
 */

/** 2026-10-31T12:00:00Z — the anchor of every generated scenario. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

/**
 * The detector-boundaries property runs ~100 generated 110–160-point
 * series through the actual D-074/D-075 detectors and the D-081
 * downsampler with brute-force boundary checks: 0.4–0.5 s clean, worst
 * measured 5.9 s in a full v8-coverage run under the six-hog starvation
 * rig (U-020; docs/agents/gotchas.md) — past Vitest's 5 s default, the
 * U-012 flake family. 20 s ≈ 3× that worst case (the peak-hours-dst
 * house margin), so parallel-wave load cannot trip the default while a
 * stuck run still fails fast.
 */
const COMPUTE_BOUND_TIMEOUT_MS = 20_000;

/** The §7.1 cadences the scenarios run under (the landed suites' pick). */
const cadenceArb = fc.constantFrom(60, 300, 3600);

/** The failure outcomes a generated failed cycle can carry. */
const failureOutcomeArb = fc.constantFrom(
  ...COLLECTION_OUTCOMES.filter((outcome) => outcome !== 'success'),
);

/* ── Detector boundaries survive downsampling ──────────────────────────── */

/**
 * One series step: a scheduler-producible delta or a stretched silence, a
 * biased-down usage walk (strict decreases are the §12.1 condition-1
 * evidence for the fixed-period quota), and a strictly advancing resetsAt
 * walk (the condition-2 declaration evidence, sometimes stale, sometimes
 * between the two snapshots).
 */
const resetWalkStepArb = fc.record({
  healthy: fc.boolean(),
  jitterUnits: fc.nat(100),
  extraMs: fc.integer({ min: 1, max: 20_000_000 }),
  usedStep: fc.integer({ min: -40, max: 10 }),
  resetsAdvanceMs: fc.integer({ min: 1, max: 2_500_000 }),
});

/**
 * A generated fixed-period series with its cadence: points carry exactly the
 * fields all three modules read (identity + `collectedAt` for D-075, quota
 * fields and declarations for D-074, `collectedAt` + `used` for D-081 —
 * extra fields ride along untouched).
 */
const detectorScenarioArb = fc
  .tuple(cadenceArb, fc.array(resetWalkStepArb, { minLength: 110, maxLength: 160, size: 'max' }))
  .map(([intervalSeconds, steps]) => {
    const points: ResetPointInput[] = [];
    let collectedAt = T0;
    let used = 500_000;
    let resetsAt = T0;
    for (const step of steps) {
      // Healthy: the §7.1 interval plus up to 10% jitter (units of
      // intervalSeconds ms each, the D-075 bounds). Stretched: past the gap
      // threshold by a generated margin.
      collectedAt += step.healthy
        ? intervalSeconds * 1000 + step.jitterUnits * intervalSeconds
        : gapThresholdMs(intervalSeconds) + step.extraMs;
      used = Math.min(1_000_000, Math.max(0, used + step.usedStep));
      resetsAt += step.resetsAdvanceMs;
      points.push({
        accountId: 'zai-main',
        metricKey: 'credits_month',
        collectedAt,
        limitType: 'MONTHLY',
        unit: 'REQUESTS',
        isValid: true,
        used,
        resetsAt,
      });
    }
    return { intervalSeconds, points } as const;
  });

describe('detector boundaries survive downsampling (§13, cross-module)', () => {
  it(
    'preserves every emitted gap edge and reset instant through aggregation',
    { timeout: COMPUTE_BOUND_TIMEOUT_MS },
    () => {
      let sawEvent = 0;
      let sawGap = 0;
      let sawBothKinds = 0;
      let sawDeclaredEventTime = 0; // events stamped previous_resets_at
      fc.assert(
        fc.property(
          detectorScenarioArb,
          fc.double({ min: 0.1, max: 0.99, noNaN: true }),
          ({ intervalSeconds, points }, budgetFraction) => {
            const events = detectSeriesResetEvents(points);
            const gaps = detectCollectionGaps(points, intervalSeconds);
            sawEvent += events.length;
            sawGap += gaps.length;
            if (events.length > 0 && gaps.length > 0) sawBothKinds += 1;
            sawDeclaredEventTime += events.filter(
              (event) => event.details.eventTimeSource === 'previous_resets_at',
            ).length;

            // Always over budget: ≥110 points against at most 99% of them.
            const maxPoints = Math.max(100, Math.floor(points.length * budgetFraction));
            const boundaries: DownsampleBoundaries = { resetEvents: events, gaps };
            const result = downsampleHistorySeries(points, maxPoints, boundaries);
            expect(result.kind).toBe('downsampled');
            if (result.kind !== 'downsampled') throw new Error('unreachable');
            const { buckets } = result;
            expect(buckets.length).toBeGreaterThan(0);

            // The pre-side gap edge closes a bucket and the post-side edge
            // opens one: both silence edges stay visible after aggregation.
            for (const gap of gaps) {
              expect(buckets.some((bucket) => bucket.toEpochMs === gap.fromEpochMs)).toBe(true);
              expect(buckets.some((bucket) => bucket.fromEpochMs === gap.toEpochMs)).toBe(true);
            }
            // Every reset instant falls strictly between consecutive buckets —
            // the D-074 event never lands inside an aggregating bucket.
            for (const event of events) {
              const at = event.eventAt;
              const straddled = buckets.some((bucket, index) => {
                const next = buckets[index + 1];
                return next !== undefined && bucket.toEpochMs < at && at <= next.fromEpochMs;
              });
              expect(straddled).toBe(true);
            }
          },
        ),
      );
      // Vacuity tripwires: events, gaps, both together, and both event-time
      // sources must all have occurred across the generated scenarios.
      expect(sawEvent).toBeGreaterThan(0);
      expect(sawGap).toBeGreaterThan(0);
      expect(sawBothKinds).toBeGreaterThan(0);
      expect(sawDeclaredEventTime).toBeGreaterThan(0);
    },
  );
});

/* ── Gaps and timeline indicators agree on shared silence ──────────────── */

/**
 * One run step: a healthy or stretched silence, a bounded cycle duration
 * (≤ 30 s — far inside the silence margin, so run end-to-start distances
 * cannot skew more than the margin the gap threshold exceeded by), and an
 * outcome (failures carry a generated §11.2 type).
 */
const runStepArb = fc.record({
  healthy: fc.boolean(),
  jitterUnits: fc.nat(100),
  extraMs: fc.integer({ min: 1, max: 20_000_000 }),
  durationMs: fc.integer({ min: 0, max: 30_000 }),
  successful: fc.boolean(),
  failedOutcome: failureOutcomeArb,
});

/**
 * A generated single-account run history plus a covering range and the
 * metric points of its successful cycles (collected at the run start — the
 * scenario's own placement of §8.4 `collectedAt`), all under one constant
 * cadence so both modules judge silence by the identical threshold.
 */
const silenceScenarioArb = fc
  .tuple(
    cadenceArb,
    fc.array(runStepArb, { minLength: 1, maxLength: 24, size: 'max' }),
    fc.integer({ min: 0, max: 2_000_000 }),
    fc.integer({ min: 0, max: 2_000_000 }),
  )
  .map(([intervalSeconds, steps, leadingSlack, trailingSlack]) => {
    const runs: CollectionRunInput[] = [];
    let startedAt = T0;
    for (const step of steps) {
      startedAt += step.healthy
        ? intervalSeconds * 1000 + step.jitterUnits * intervalSeconds
        : gapThresholdMs(intervalSeconds) + 90_000 + 1 + step.extraMs;
      runs.push({
        accountId: 'zai-main',
        startedAt,
        endedAt: startedAt + step.durationMs,
        intervalSeconds,
        outcome: step.successful ? 'success' : step.failedOutcome,
        attempts: 1,
      });
    }
    const lastEnd = Math.max(...runs.map((run) => run.endedAt));
    const points: SuccessfulMetricPoint[] = runs
      .filter((run) => run.outcome === 'success')
      .map((run) => ({
        accountId: run.accountId,
        metricKey: 'credits_month',
        collectedAt: run.startedAt,
      }));
    return {
      intervalSeconds,
      runs,
      points,
      range: { from: T0 - leadingSlack, to: lastEnd + trailingSlack },
    } as const;
  });

describe('gaps and timeline indicators agree on shared silence (§12.2, cross-module)', () => {
  it('covers every bounded stopped region with a gap and explains every gap with an indicator', () => {
    let sawRegion = 0;
    let sawGap = 0;
    let sawGapWithRegion = 0;
    let sawGapWithErrors = 0;

    function checkSilence(scenario: {
      readonly intervalSeconds: number;
      readonly runs: readonly CollectionRunInput[];
      readonly points: readonly SuccessfulMetricPoint[];
      readonly range: { readonly from: number; readonly to: number };
    }): void {
      const { intervalSeconds, runs, points, range } = scenario;
      const gaps = detectCollectionGaps(points, intervalSeconds);
      const indicators = buildTimelineIndicators(runs, range);
      const regions = indicators.filter(
        (indicator): indicator is StoppedServiceIndicator => indicator.kind === 'stopped_service',
      );
      const errors = indicators.filter(
        (indicator): indicator is CollectionErrorIndicator => indicator.kind === 'collection_error',
      );
      sawRegion += regions.length;
      sawGap += gaps.length;

      // Every stopped region straddled by observed successful points on
      // both sides is covered by a collection gap: the silence the run
      // timeline reports is a silence the point series reports too.
      for (const region of regions) {
        expect(region.thresholdMs).toBe(gapThresholdMs(intervalSeconds));
        const hasPointBefore = points.some((p) => p.collectedAt < region.fromEpochMs);
        const hasPointFrom = points.some((p) => p.collectedAt >= region.toEpochMs);
        if (!hasPointBefore || !hasPointFrom) continue; // range-edge silence
        const covered = gaps.some(
          (gap) => gap.fromEpochMs <= region.fromEpochMs && gap.toEpochMs >= region.toEpochMs,
        );
        expect(covered).toBe(true);
      }

      // Every gap is explained: within its span lies either a period with
      // no run records at all (the stopped service) or at least one failed
      // collection cycle. A chart line never breaks invisibly.
      for (const gap of gaps) {
        const region = regions.find(
          (candidate) =>
            gap.fromEpochMs <= candidate.fromEpochMs && candidate.toEpochMs <= gap.toEpochMs,
        );
        const error = errors.find(
          (candidate) =>
            gap.fromEpochMs < candidate.fromEpochMs && candidate.fromEpochMs < gap.toEpochMs,
        );
        if (region !== undefined) sawGapWithRegion += 1;
        if (error !== undefined) sawGapWithErrors += 1;
        expect(region !== undefined || error !== undefined).toBe(true);
      }
    }

    fc.assert(
      fc.property(silenceScenarioArb, (scenario) => {
        checkSilence(scenario);
        // Standing exemplars, checked on every run: the two explanation
        // classes the random generator reaches only probabilistically (the
        // review of task 124 demanded tripwires that cannot be starved).
        // Three failed cycles at the maximally-jittered 60 s cadence bridge
        // two successes 330 s apart — past the 198 s threshold, with every
        // inter-run silence below it: a gap explained purely by errors.
        const at = (offset: number) => T0 + offset;
        checkSilence({
          intervalSeconds: 60,
          runs: [
            {
              accountId: 'zai-main',
              startedAt: at(66_000),
              endedAt: at(66_000),
              intervalSeconds: 60,
              outcome: 'success',
              attempts: 1,
            },
            {
              accountId: 'zai-main',
              startedAt: at(132_000),
              endedAt: at(132_000),
              intervalSeconds: 60,
              outcome: 'network_error',
              attempts: 1,
            },
            {
              accountId: 'zai-main',
              startedAt: at(198_000),
              endedAt: at(198_000),
              intervalSeconds: 60,
              outcome: 'auth_error',
              attempts: 1,
            },
            {
              accountId: 'zai-main',
              startedAt: at(264_000),
              endedAt: at(264_000),
              intervalSeconds: 60,
              outcome: 'timeout',
              attempts: 1,
            },
            {
              accountId: 'zai-main',
              startedAt: at(330_000),
              endedAt: at(330_000),
              intervalSeconds: 60,
              outcome: 'success',
              attempts: 1,
            },
          ],
          points: [
            { accountId: 'zai-main', metricKey: 'credits_month', collectedAt: at(66_000) },
            { accountId: 'zai-main', metricKey: 'credits_month', collectedAt: at(330_000) },
          ],
          range: { from: T0, to: at(400_000) },
        });
        // One clear outage between two successes: a stopped region covered
        // by the collection gap that spans it.
        checkSilence({
          intervalSeconds: 60,
          runs: [
            {
              accountId: 'zai-main',
              startedAt: at(66_000),
              endedAt: at(96_000),
              intervalSeconds: 60,
              outcome: 'success',
              attempts: 1,
            },
            {
              accountId: 'zai-main',
              startedAt: at(566_000),
              endedAt: at(566_000),
              intervalSeconds: 60,
              outcome: 'success',
              attempts: 1,
            },
          ],
          points: [
            { accountId: 'zai-main', metricKey: 'credits_month', collectedAt: at(66_000) },
            { accountId: 'zai-main', metricKey: 'credits_month', collectedAt: at(566_000) },
          ],
          range: { from: T0, to: at(700_000) },
        });
      }),
    );
    // Vacuity tripwires, guaranteed by the exemplars: regions, gaps, and
    // both explanation classes.
    expect(sawRegion).toBeGreaterThanOrEqual(100);
    expect(sawGap).toBeGreaterThanOrEqual(100);
    expect(sawGapWithRegion).toBeGreaterThanOrEqual(100);
    expect(sawGapWithErrors).toBeGreaterThanOrEqual(100);
  });
});
