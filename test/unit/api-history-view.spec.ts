import { describe, expect, it } from 'vitest';
import type {
  CollectionRunRecord,
  MetricValueRecord,
  QuotaEventRecord,
  RunOutcome,
} from '../../src/storage/repository';
import {
  EVIDENCE_MARGIN_MS,
  collectionErrorItemView,
  emptyPointView,
  gapEventItemView,
  historyBucketView,
  historyPointInput,
  historyPointView,
  insertInvalidPointItems,
  intervalTimelineFromRuns,
  mergeEmptyPoints,
  parseEpochMsParam,
  parseRequestedRange,
  rangeReportOf,
  resetEventItemView,
  sortEventItems,
  stoppedServiceItemView,
  type HistoryPointInput,
} from '../../src/server/api/history';
import { ApiError } from '../../src/server/api/error';
import { gapThresholdMs } from '../../src/services/history-gaps';
import type {
  CollectionErrorIndicator,
  StoppedServiceIndicator,
} from '../../src/services/history-timeline';
import type { MetricBucket } from '../../src/services/history-downsample';
import type { EventItem, HistoryBucket, HistoryPoint } from '../../src/schemas/api/history';

/**
 * The pure compositions of the history/events endpoints (task 161, D-139):
 * the §13 ISO-parameter parsing (the request half of the timestamp rule),
 * the run-stamp interval timeline, the point/bucket/empty wire views, the
 * retention report mapping, the §7.4 message redaction, and the unified
 * timeline's deterministic order.
 */

const NOW = 1_761_000_000_000;

/* ── §13 range parsing ─────────────────────────────────────────────────── */

describe('parseEpochMsParam / parseRequestedRange (§13 ISO parameters)', () => {
  it('accepts Z, numeric offsets, and fractional seconds', () => {
    expect(parseEpochMsParam('2026-10-20T12:00:00.000Z', 'from')).toBe(
      Date.parse('2026-10-20T12:00:00.000Z'),
    );
    expect(parseEpochMsParam('2026-10-20T12:00:00+00:00', 'to')).toBe(
      Date.parse('2026-10-20T12:00:00Z'),
    );
    expect(parseEpochMsParam('2026-10-20T07:30:00-05:00', 'from')).toBe(
      Date.parse('2026-10-20T12:30:00Z'),
    );
  });

  it('rejects offset-less strings and non-timestamps with the stable reason', () => {
    for (const raw of [
      '2026-10-20T12:00:00', // no offset — §10's implicit-zone hole
      '2026-10-20', // bare date
      'yesterday',
      '',
    ]) {
      try {
        parseEpochMsParam(raw, 'from');
        expect.unreachable(`'${raw}' should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.code).toBe('VALIDATION');
        expect(apiError.statusCode).toBe(400);
        expect(apiError.details).toEqual({ reason: 'invalid-timestamp', param: 'from' });
      }
    }
  });

  it('orders the pair: inverted is VALIDATION/inverted-range, equal passes', () => {
    const from = '2026-10-20T00:00:00Z';
    expect(parseRequestedRange(from, '2026-10-21T00:00:00Z')).toEqual({
      from: Date.parse(from),
      to: Date.parse('2026-10-21T00:00:00Z'),
    });
    expect(parseRequestedRange(from, from)).toEqual({
      from: Date.parse(from),
      to: Date.parse(from),
    });
    try {
      parseRequestedRange('2026-10-21T00:00:00Z', from);
      expect.unreachable('the inverted range should have been rejected');
    } catch (error) {
      expect((error as ApiError).details).toEqual({ reason: 'inverted-range' });
    }
  });
});

/* ── The run-stamp interval timeline ───────────────────────────────────── */

function run(at: number, intervalSeconds: number, id = at): CollectionRunRecord {
  return {
    id,
    accountId: 'acc-main',
    startedAt: at,
    endedAt: at + 1_000,
    intervalSeconds,
    outcome: 'success' as RunOutcome,
    httpStatus: 200,
    errorMessage: null,
    attempts: 1,
    retryAfterSeconds: null,
  };
}

/** One run with an explicit (possibly inverted) end stamp — the D-185 cells. */
function skewedRun(
  at: number,
  endedAt: number,
  intervalSeconds: number,
  id = at,
): CollectionRunRecord {
  return { ...run(at, intervalSeconds, id), endedAt };
}

describe('intervalTimelineFromRuns (§12.2 interval_s stamps)', () => {
  it('collapses a constant cadence to the first run’s entry', () => {
    expect(intervalTimelineFromRuns([run(NOW, 300), run(NOW + 300_000, 300)])).toEqual([
      { effectiveFromEpochMs: NOW, intervalSeconds: 300 },
    ]);
  });

  it('emits one change per cadence shift, wherever the run sits', () => {
    const changes = intervalTimelineFromRuns([
      run(NOW, 300),
      run(NOW + 300_000, 300),
      run(NOW + 660_000, 3600),
      run(NOW + 4_660_000, 3600),
      run(NOW + 8_660_000, 60),
    ]);
    expect(changes).toEqual([
      { effectiveFromEpochMs: NOW, intervalSeconds: 300 },
      { effectiveFromEpochMs: NOW + 660_000, intervalSeconds: 3600 },
      { effectiveFromEpochMs: NOW + 8_660_000, intervalSeconds: 60 },
    ]);
  });

  it('is order-independent and keeps the first cadence on equal stamps', () => {
    const ordered = intervalTimelineFromRuns([run(NOW, 300), run(NOW + 300_000, 3600)]);
    expect(intervalTimelineFromRuns([run(NOW + 300_000, 3600), run(NOW, 300)])).toEqual(ordered);
    // Equal startedAt cannot happen for one account's §7.1 cycles; the guard
    // keeps the detector's unique-stamp contract on degenerate data anyway.
    expect(intervalTimelineFromRuns([run(NOW, 300, 1), run(NOW, 3600, 2)])).toEqual([
      { effectiveFromEpochMs: NOW, intervalSeconds: 300 },
    ]);
    expect(intervalTimelineFromRuns([])).toEqual([]);
  });

  it('anchors a skewed change at min(startedAt, endedAt), never at the late-biased start (D-185)', () => {
    // An inverted change-run: `startedAt` is the pre-correction (late-biased)
    // read; trusting it would judge the straddling pairs by the old, tighter
    // cadence and mint false gaps. The post-correction end read anchors the
    // change no later than the first new-cadence snapshot.
    expect(
      intervalTimelineFromRuns([
        run(NOW, 60),
        skewedRun(NOW + 500_000, NOW + 400_000, 3600),
        run(NOW + 760_000, 3600),
      ]),
    ).toEqual([
      { effectiveFromEpochMs: NOW, intervalSeconds: 60 },
      { effectiveFromEpochMs: NOW + 400_000, intervalSeconds: 3600 },
    ]);
  });

  it('keeps the output ascending under an extreme step-back (D-185)', () => {
    // The skewed change stamp can land below an earlier entry's stamp; the
    // ascending-timeline contract (Rule 2's coverage read) must hold.
    const changes = intervalTimelineFromRuns([
      run(NOW + 2_000_000, 300),
      skewedRun(NOW + 2_500_000, NOW + 1_000_000, 3600),
    ]);
    expect(changes).toEqual([
      { effectiveFromEpochMs: NOW + 1_000_000, intervalSeconds: 3600 },
      { effectiveFromEpochMs: NOW + 2_000_000, intervalSeconds: 300 },
    ]);
    for (const [index, change] of changes.entries()) {
      if (index > 0)
        expect(change.effectiveFromEpochMs).toBeGreaterThan(
          changes[index - 1]!.effectiveFromEpochMs,
        );
    }
  });
});

it('the evidence margin covers the widest §12.2 judgment plus one cycle span', () => {
  // gapThresholdMs(3600) = 3 × 1.1 × 3_600_000 = 11_880_000; +300_000 for the
  // §7.2 worst-case run span (255.5 s hang bound, rounded up).
  expect(EVIDENCE_MARGIN_MS).toBe(gapThresholdMs(3600) + 300_000);
});

/* ── Point/bucket/empty wire views ─────────────────────────────────────── */

function metricRow(overrides: Partial<MetricValueRecord> = {}): MetricValueRecord {
  return {
    accountId: 'acc-main',
    runId: 1,
    collectedAt: NOW,
    metricKey: 'mcp-monthly',
    limitType: 'MONTHLY',
    unit: 'CREDITS',
    windowSeconds: null,
    used: 80,
    remaining: 20,
    limit: 100,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: NOW + 86_400_000,
    isValid: true,
    invalidReason: null,
    derivedFields: null,
    ...overrides,
  };
}

describe('historyPointInput / historyPointView', () => {
  it('round-trips a valid row with its values intact', () => {
    const view = historyPointView(historyPointInput(metricRow()));
    expect(view).toEqual({
      kind: 'point',
      collectedAt: NOW,
      used: 80,
      remaining: 20,
      limit: 100,
      percentUsed: 80,
      percentRemaining: 20,
      resetsAt: NOW + 86_400_000,
      isValid: true,
      invalidReason: null,
    });
  });

  it('restores honest nulls for an invalid row (never zeros)', () => {
    const row = metricRow({
      used: null,
      remaining: null,
      limit: null,
      percentUsed: null,
      percentRemaining: null,
      resetsAt: null,
      isValid: false,
      invalidReason: 'provider field missing',
    });
    const input: HistoryPointInput = historyPointInput(row);
    // The downsampler-facing point carries the absent fields as undefined
    // (D-090 validates carried fields as finite numbers).
    expect(input.used).toBeUndefined();
    const view = historyPointView(input);
    expect(view.used).toBeNull();
    expect(view.limit).toBeNull();
    expect(view.isValid).toBe(false);
    expect(view.invalidReason).toBe('provider field missing');
  });
});

describe('historyBucketView', () => {
  it('maps one bucket: extrema nulls for uncovered fields, kind-less endpoints', () => {
    const first: HistoryPointInput = historyPointInput(metricRow({ collectedAt: NOW }));
    const last: HistoryPointInput = historyPointInput(
      metricRow({
        collectedAt: NOW + 600_000,
        used: 10,
        remaining: 90,
        percentUsed: 10,
        percentRemaining: 90,
      }),
    );
    const bucket: MetricBucket = {
      fromEpochMs: NOW,
      toEpochMs: NOW + 600_000,
      count: 7,
      first,
      last,
      min: { used: 10, remaining: 20 },
      max: { used: 80, remaining: 90, percentUsed: 80, percentRemaining: 90 },
    };
    const view: HistoryBucket = historyBucketView(bucket);
    // The endpoint views carry no `kind` discriminator — only points-array
    // entries do (the closed contract drops it, and so does the view).
    const firstExpected = historyPointView(first) as Partial<HistoryPoint>;
    delete firstExpected.kind;
    const lastExpected = historyPointView(last) as Partial<HistoryPoint>;
    delete lastExpected.kind;
    expect(view).toEqual({
      kind: 'bucket',
      fromEpochMs: NOW,
      toEpochMs: NOW + 600_000,
      count: 7,
      min: { used: 10, remaining: 20, percentUsed: null, percentRemaining: null },
      max: { used: 80, remaining: 90, percentUsed: 80, percentRemaining: 90 },
      first: firstExpected,
      last: lastExpected,
    });
  });
});

describe('emptyPointView / mergeEmptyPoints (§12.2 empty points)', () => {
  it('positions the empty point at the gap midpoint (floored)', () => {
    expect(emptyPointView({ fromEpochMs: 100, toEpochMs: 200 })).toEqual({
      kind: 'empty',
      collectedAt: 150,
    });
    expect(emptyPointView({ fromEpochMs: 100, toEpochMs: 102 })).toEqual({
      kind: 'empty',
      collectedAt: 101,
    });
  });

  it('splices each empty point between the gap’s edge entries', () => {
    const points: HistoryPoint[] = [
      historyPointView(historyPointInput(metricRow({ collectedAt: 0 }))),
      historyPointView(historyPointInput(metricRow({ collectedAt: 100 }))),
      historyPointView(historyPointInput(metricRow({ collectedAt: 1_000 }))),
    ];
    const merged = mergeEmptyPoints(points, [{ fromEpochMs: 100, toEpochMs: 1_000 }]);
    expect(merged.map((item) => item.kind)).toEqual(['point', 'point', 'empty', 'point']);
    expect(merged[2]).toEqual({ kind: 'empty', collectedAt: 550 });
  });

  it('positions against bucket edges and handles multiple gaps in order', () => {
    const bucket = (fromEpochMs: number, toEpochMs: number): HistoryBucket => ({
      kind: 'bucket',
      fromEpochMs,
      toEpochMs,
      count: 2,
      min: { used: null, remaining: null, percentUsed: null, percentRemaining: null },
      max: { used: null, remaining: null, percentUsed: null, percentRemaining: null },
      first: historyPointView(historyPointInput(metricRow({ collectedAt: fromEpochMs }))),
      last: historyPointView(historyPointInput(metricRow({ collectedAt: toEpochMs }))),
    });
    const merged = mergeEmptyPoints(
      [bucket(0, 100), bucket(400, 500), bucket(900, 1_000)],
      [
        { fromEpochMs: 100, toEpochMs: 400 },
        { fromEpochMs: 500, toEpochMs: 900 },
      ],
    );
    expect(merged.map((item) => item.kind)).toEqual([
      'bucket',
      'empty',
      'bucket',
      'empty',
      'bucket',
    ]);
    expect(merged[3]).toEqual({ kind: 'empty', collectedAt: 700 });
    // No gaps: the identity splice.
    expect(mergeEmptyPoints([bucket(0, 100)], [])).toHaveLength(1);
  });

  it('keeps the array timestamp-ordered when an entry inside the gap passes the midpoint', () => {
    // The review round's P1 fold: an invalid point at 900 sits inside the
    // gap (100, 1000) whose midpoint is 550 — the empty point must precede
    // it, not merely precede the post-edge entry.
    const points: HistoryPoint[] = [
      historyPointView(historyPointInput(metricRow({ collectedAt: 100 }))),
      historyPointView(
        historyPointInput(
          metricRow({
            collectedAt: 900,
            used: null,
            remaining: null,
            limit: null,
            percentUsed: null,
            percentRemaining: null,
            resetsAt: null,
            isValid: false,
            invalidReason: 'x',
          }),
        ),
      ),
      historyPointView(historyPointInput(metricRow({ collectedAt: 1_000 }))),
    ];
    const merged = mergeEmptyPoints(points, [{ fromEpochMs: 100, toEpochMs: 1_000 }]);
    expect(merged.map((item) => item.kind)).toEqual(['point', 'empty', 'point', 'point']);
    expect(merged[1]).toEqual({ kind: 'empty', collectedAt: 550 });
    // The degenerate 1 ms gap (midpoint == start edge): the pre-edge entry
    // still comes first — the strict gap-start guard.
    const degenerate = mergeEmptyPoints(
      [
        historyPointView(historyPointInput(metricRow({ collectedAt: 100 }))),
        historyPointView(historyPointInput(metricRow({ collectedAt: 101 }))),
      ],
      [{ fromEpochMs: 100, toEpochMs: 101 }],
    );
    expect(degenerate.map((item) => item.kind)).toEqual(['point', 'empty', 'point']);
    expect(degenerate[1]).toEqual({ kind: 'empty', collectedAt: 100 });
  });

  describe('insertInvalidPointItems (the invalid rows re-enter the buckets)', () => {
    const invalidPoint = (collectedAt: number): HistoryPoint =>
      historyPointView(
        historyPointInput(
          metricRow({
            collectedAt,
            used: null,
            remaining: null,
            limit: null,
            percentUsed: null,
            percentRemaining: null,
            resetsAt: null,
            isValid: false,
            invalidReason: 'provider field missing',
          }),
        ),
      );

    it('places each invalid entry before the first bucket starting later', () => {
      const bucket = (fromEpochMs: number, toEpochMs: number): HistoryBucket => ({
        kind: 'bucket',
        fromEpochMs,
        toEpochMs,
        count: 2,
        min: { used: null, remaining: null, percentUsed: null, percentRemaining: null },
        max: { used: null, remaining: null, percentUsed: null, percentRemaining: null },
        first: historyPointView(historyPointInput(metricRow({ collectedAt: fromEpochMs }))),
        last: historyPointView(historyPointInput(metricRow({ collectedAt: toEpochMs }))),
      });
      const merged = insertInvalidPointItems(
        [bucket(0, 90), bucket(400, 500)],
        [invalidPoint(150), invalidPoint(200)],
      );
      // Both entries fall inside the first bucket's span but before the
      // second bucket's start: they ride between the buckets, chronological.
      expect(merged.map((item) => item.kind)).toEqual(['bucket', 'point', 'point', 'bucket']);
      expect(merged[1]).toMatchObject({ collectedAt: 150, isValid: false });
      expect(merged[2]).toMatchObject({ collectedAt: 200, isValid: false });
      // No invalid rows: the identity.
      expect(insertInvalidPointItems([bucket(0, 90)], [])).toHaveLength(1);
      // Only invalid rows: they stand alone.
      expect(insertInvalidPointItems([], [invalidPoint(5)])).toHaveLength(1);
    });
  });
});

/* ── The retention report ──────────────────────────────────────────────── */

describe('rangeReportOf (task 123’s vocabulary on the wire)', () => {
  it('maps each outcome with its exact fields', () => {
    expect(rangeReportOf({ outcome: 'ok', effectiveFrom: 10, effectiveTo: 20 })).toEqual({
      outcome: 'ok',
      requestedFrom: 10,
      requestedTo: 20,
      effectiveFrom: 10,
      effectiveTo: 20,
      retentionHorizon: null,
    });
    expect(
      rangeReportOf({
        outcome: 'truncated',
        effectiveFrom: 40,
        effectiveTo: 100,
        requestedFrom: 0,
      }),
    ).toEqual({
      outcome: 'truncated',
      requestedFrom: 0,
      requestedTo: 100,
      effectiveFrom: 40,
      effectiveTo: 100,
      retentionHorizon: 40,
    });
    expect(
      rangeReportOf({ outcome: 'rejected', horizon: 40, requestedFrom: 0, requestedTo: 10 }),
    ).toEqual({
      outcome: 'rejected',
      requestedFrom: 0,
      requestedTo: 10,
      effectiveFrom: null,
      effectiveTo: null,
      retentionHorizon: 40,
    });
  });
});

/* ── Events wire views ─────────────────────────────────────────────────── */

describe('the events item views', () => {
  it('serves a stored reset verbatim with its evidence', () => {
    const record: QuotaEventRecord = {
      accountId: 'acc-main',
      metricKey: 'mcp-monthly',
      eventType: 'RESET',
      eventAt: NOW,
      runId: 7,
      details: {
        reason: 'usage_decreased',
        previous: { collectedAt: NOW - 300_000, used: 90 },
        current: { collectedAt: NOW, used: 10 },
      },
    };
    expect(resetEventItemView(record)).toEqual({
      kind: 'reset',
      metricKey: 'mcp-monthly',
      eventAt: NOW,
      runId: 7,
      details: record.details,
    });
  });

  it('maps a detected gap field-for-field', () => {
    expect(
      gapEventItemView({
        accountId: 'acc-main',
        metricKey: 'mcp-monthly',
        fromEpochMs: 0,
        toEpochMs: 1_000,
        elapsedMs: 1_000,
        intervalSeconds: 300,
        thresholdMs: 990_000,
      }),
    ).toEqual({
      kind: 'gap',
      metricKey: 'mcp-monthly',
      fromEpochMs: 0,
      toEpochMs: 1_000,
      elapsedMs: 1_000,
      intervalSeconds: 300,
      thresholdMs: 990_000,
    });
  });

  it('redacts the failed-cycle message and nulls the absent evidence (§7.4)', () => {
    const indicator: CollectionErrorIndicator = {
      kind: 'collection_error',
      accountId: 'acc-main',
      outcome: 'network_error',
      fromEpochMs: NOW,
      toEpochMs: NOW + 2_000,
      durationMs: 2_000,
      httpStatus: undefined,
      errorMessage: 'fetch failed for sk-marker-secret-4f7a1c9e2b',
      attempts: 3,
      retryAfterSeconds: undefined,
    };
    expect(collectionErrorItemView(indicator, 'sk-marker-secret-4f7a1c9e2b')).toEqual({
      kind: 'collection_error',
      outcome: 'network_error',
      fromEpochMs: NOW,
      toEpochMs: NOW + 2_000,
      durationMs: 2_000,
      httpStatus: null,
      message: 'fetch failed for [REDACTED]',
      attempts: 3,
      retryAfterSeconds: null,
    });
    // A null secret (no configured source) leaves the text untouched, and a
    // stored-null message renders as the empty string.
    expect(collectionErrorItemView({ ...indicator, errorMessage: undefined }, null).message).toBe(
      '',
    );
  });

  it('maps a stopped-service region field-for-field', () => {
    const indicator: StoppedServiceIndicator = {
      kind: 'stopped_service',
      accountId: 'acc-main',
      fromEpochMs: NOW,
      toEpochMs: NOW + 4_000_000,
      elapsedMs: 4_000_000,
      intervalSeconds: 300,
      thresholdMs: 990_000,
    };
    expect(stoppedServiceItemView(indicator)).toEqual({
      kind: 'stopped_service',
      fromEpochMs: NOW,
      toEpochMs: NOW + 4_000_000,
      elapsedMs: 4_000_000,
      intervalSeconds: 300,
      thresholdMs: 990_000,
    });
  });
});

describe('sortEventItems (the unified timeline order)', () => {
  const reset = (eventAt: number, metricKey = 'a'): EventItem => ({
    kind: 'reset',
    metricKey,
    eventAt,
    runId: null,
    details: {},
  });
  const gap = (fromEpochMs: number, metricKey = 'a'): EventItem => ({
    kind: 'gap',
    metricKey,
    fromEpochMs,
    toEpochMs: fromEpochMs + 1,
    elapsedMs: 1,
    intervalSeconds: 300,
    thresholdMs: 990_000,
  });
  const failure = (fromEpochMs: number): EventItem => ({
    kind: 'collection_error',
    outcome: 'timeout',
    fromEpochMs,
    toEpochMs: fromEpochMs + 1,
    durationMs: 1,
    httpStatus: null,
    message: '',
    attempts: 1,
    retryAfterSeconds: null,
  });
  const stopped = (fromEpochMs: number): EventItem => ({
    kind: 'stopped_service',
    fromEpochMs,
    toEpochMs: fromEpochMs + 1,
    elapsedMs: 1,
    intervalSeconds: 300,
    thresholdMs: 990_000,
  });

  it('orders by instant, then the frozen kind rank, then metric key', () => {
    expect(sortEventItems([stopped(3), failure(3), gap(3), reset(3)])).toEqual([
      reset(3),
      gap(3),
      failure(3),
      stopped(3),
    ]);
    expect(sortEventItems([reset(10), gap(5)])).toEqual([gap(5), reset(10)]);
    expect(sortEventItems([gap(3, 'zzz-metric'), gap(3, 'aaa-metric')])).toEqual([
      gap(3, 'aaa-metric'),
      gap(3, 'zzz-metric'),
    ]);
    // The account-level classes tie empty and keep input order (stable sort).
    expect(sortEventItems([failure(3), stopped(3), failure(3)])).toEqual([
      failure(3),
      failure(3),
      stopped(3),
    ]);
  });
});
