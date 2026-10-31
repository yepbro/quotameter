import { describe, expect, it } from 'vitest';
import {
  buildTimelineIndicators,
  type CollectionErrorIndicator,
  type CollectionRunInput,
  type StoppedServiceIndicator,
  type TimelineIndicator,
  type TimelineQueryRange,
} from '../../src/services/history-timeline';
import { gapThresholdMs } from '../../src/services/history-gaps';
import { COLLECTION_OUTCOMES } from '../../src/services/polling-outcomes';

/**
 * Deterministic coverage of the §12.2 timeline indicators (task 120,
 * decision D-080): one error indicator per failed cycle typed by the §11.2
 * outcome, stopped-service regions for record silence beyond the shared
 * three-effective-interval threshold (D-075's vocabulary, imported — 990 000
 * ms at the 300 s default), the range edges, the boundary-cadence widening,
 * the per-account partitioning with deterministic order, and the fail-fast
 * input contract. The closing block makes the done-condition executable:
 * failure-type indicators and no-activity indicators are structurally
 * distinguishable. Property-based complements live in
 * `history-timeline.property.spec.ts`.
 */

/** 2026-10-31T12:00:00Z — the base collection timestamp of every timeline. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

const ACCOUNT = 'zai-main';

/** The §7.1 default interval (300 s): silence threshold 990 000 ms. */
const INTERVAL = 300;
const THRESHOLD_MS = gapThresholdMs(INTERVAL);

/** One run record, defaulting to a failed cycle at the base timestamp. */
function run(overrides: Partial<CollectionRunInput> = {}): CollectionRunInput {
  return {
    accountId: ACCOUNT,
    startedAt: T0,
    endedAt: T0 + 15_000,
    intervalSeconds: INTERVAL,
    outcome: 'network_error',
    attempts: 1,
    ...overrides,
  };
}

/** One success cycle — the §12.2 aliveness marker that bounds silence. */
function success(startedAt: number, endedAt = startedAt + 5_000): CollectionRunInput {
  return run({ outcome: 'success', startedAt, endedAt });
}

/** A query range tight enough around `T0` to keep the edges silent. */
function tightRange(): TimelineQueryRange {
  return { from: T0 - 60_000, to: T0 + 60_000 };
}

describe('buildTimelineIndicators: error indicators from failed cycles', () => {
  it('derives one full indicator per failed cycle', () => {
    const failed = run({
      startedAt: T0 + 300_000,
      endedAt: T0 + 322_000,
      attempts: 3,
      httpStatus: 503,
      errorMessage: 'HTTP 503 after 3 attempts',
    });
    expect(
      buildTimelineIndicators([success(T0), failed, success(T0 + 600_000)], {
        from: T0 - 60_000,
        to: T0 + 700_000,
      }),
    ).toEqual([
      {
        kind: 'collection_error',
        accountId: ACCOUNT,
        outcome: 'network_error',
        fromEpochMs: T0 + 300_000,
        toEpochMs: T0 + 322_000,
        durationMs: 22_000,
        httpStatus: 503,
        errorMessage: 'HTTP 503 after 3 attempts',
        attempts: 3,
        retryAfterSeconds: undefined,
      },
    ]);
  });

  it.each(COLLECTION_OUTCOMES.filter((outcome) => outcome !== 'success'))(
    'types a %s cycle distinctly',
    (outcome) => {
      const [indicator] = buildTimelineIndicators([run({ outcome })], tightRange());
      expect(indicator?.kind).toBe('collection_error');
      expect((indicator as CollectionErrorIndicator).outcome).toBe(outcome);
    },
  );

  it('keeps adjacent cycles of distinct failure types separate — no merging', () => {
    const indicators = buildTimelineIndicators(
      [
        run({ outcome: 'network_error', startedAt: T0, endedAt: T0 + 30_000, attempts: 4 }),
        run({
          outcome: 'auth_error',
          startedAt: T0 + 330_000,
          endedAt: T0 + 331_000,
          httpStatus: 401,
        }),
      ],
      { from: T0 - 60_000, to: T0 + 400_000 },
    );
    expect(indicators).toHaveLength(2);
    expect(indicators.map((indicator) => (indicator as CollectionErrorIndicator).outcome)).toEqual([
      'network_error',
      'auth_error',
    ]);
  });

  it('emits nothing for successful cycles', () => {
    expect(buildTimelineIndicators([success(T0), success(T0 + 330_000)], tightRange())).toEqual([]);
  });

  it('carries the deferred-429 evidence a tooltip needs', () => {
    const [indicator] = buildTimelineIndicators(
      [
        run({
          outcome: 'rate_limited',
          httpStatus: 429,
          retryAfterSeconds: 1800,
          errorMessage: 'HTTP 429',
        }),
      ],
      tightRange(),
    );
    expect(indicator).toMatchObject({
      kind: 'collection_error',
      outcome: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: 1800,
    });
  });

  it('accepts the persisted-legal retry-after boundary of 0 seconds (D-062)', () => {
    // An elapsed `Retry-After` HTTP-date (or a literal `Retry-After: 0`) is
    // a valid parse whose wait is zero; the `collection_runs` CHECK admits
    // it, so the row reader must not reject what the writer persists.
    const [indicator] = buildTimelineIndicators(
      [run({ outcome: 'rate_limited', httpStatus: 429, retryAfterSeconds: 0 })],
      tightRange(),
    );
    expect(indicator).toMatchObject({ kind: 'collection_error', retryAfterSeconds: 0 });
  });

  it.each([
    ['a cycle starting exactly at range.from', T0 - 60_000, T0 - 45_000],
    ['a cycle starting exactly at range.to', T0 + 60_000, T0 + 75_000],
  ])('shows %s', (_label, startedAt, endedAt) => {
    const [indicator] = buildTimelineIndicators([run({ startedAt, endedAt })], tightRange());
    expect(indicator?.kind).toBe('collection_error');
    expect(indicator?.fromEpochMs).toBe(startedAt);
  });

  it('hides failed cycles that start outside the range, while they still bound silence', () => {
    // The failed cycle ran entirely before range.from; its record still
    // anchors the leading silence (clamped to from), but no marker shows.
    const indicators = buildTimelineIndicators(
      [run({ startedAt: T0 - 2_000_000, endedAt: T0 - 1_990_000 }), success(T0)],
      { from: T0 - 1_000_000, to: T0 + 60_000 },
    );
    expect(indicators).toEqual([
      {
        kind: 'stopped_service',
        accountId: ACCOUNT,
        fromEpochMs: T0 - 1_000_000,
        toEpochMs: T0,
        elapsedMs: 1_000_000,
        intervalSeconds: INTERVAL,
        thresholdMs: THRESHOLD_MS,
      },
    ]);
  });
});

describe('buildTimelineIndicators: stopped-service regions from record silence', () => {
  it('derives one region for a clear outage, judged by the boundary cadence', () => {
    const indicators = buildTimelineIndicators(
      [success(T0, T0 + 15_000), success(T0 + 2_015_000, T0 + 2_030_000)],
      { from: T0 - 60_000, to: T0 + 3_000_000 },
    );
    expect(indicators).toEqual([
      {
        kind: 'stopped_service',
        accountId: ACCOUNT,
        fromEpochMs: T0 + 15_000,
        toEpochMs: T0 + 2_015_000,
        elapsedMs: 2_000_000,
        intervalSeconds: INTERVAL,
        thresholdMs: THRESHOLD_MS,
      },
    ]);
  });

  it.each([
    ['a live §7.1 cadence at interval + jitter', 330_000],
    ['a jittered silence between cycles', 315_000],
    ['exactly three effective intervals — the boundary, "exceeds" is strict', THRESHOLD_MS],
  ])('%s between cycles is not downtime', (_label, silenceMs) => {
    expect(
      buildTimelineIndicators([success(T0), success(T0 + 5_000 + silenceMs)], {
        from: T0 - 60_000,
        to: T0 + 10_000 + silenceMs + 60_000,
      }),
    ).toEqual([]);
  });

  it('reports the silence one millisecond past the boundary', () => {
    const indicators = buildTimelineIndicators(
      [success(T0), success(T0 + 5_000 + THRESHOLD_MS + 1)],
      { from: T0 - 60_000, to: T0 + 10_000 + THRESHOLD_MS + 60_000 },
    );
    expect(indicators).toEqual([
      {
        kind: 'stopped_service',
        accountId: ACCOUNT,
        fromEpochMs: T0 + 5_000,
        toEpochMs: T0 + 5_000 + THRESHOLD_MS + 1,
        elapsedMs: THRESHOLD_MS + 1,
        intervalSeconds: INTERVAL,
        thresholdMs: THRESHOLD_MS,
      },
    ]);
  });

  it('an interleaved record splits one long outage into two regions', () => {
    const failed = run({
      outcome: 'timeout',
      startedAt: T0 + 1_505_000,
      endedAt: T0 + 1_515_000,
      attempts: 2,
    });
    const indicators = buildTimelineIndicators(
      [success(T0, T0 + 5_000), failed, success(T0 + 3_005_000, T0 + 3_010_000)],
      { from: T0 - 60_000, to: T0 + 3_100_000 },
    );
    expect(indicators.map((indicator) => indicator.kind)).toEqual([
      'stopped_service',
      'collection_error',
      'stopped_service',
    ]);
    const regions = indicators.filter(
      (indicator): indicator is StoppedServiceIndicator => indicator.kind === 'stopped_service',
    );
    expect(regions[0]).toMatchObject({ fromEpochMs: T0 + 5_000, toEpochMs: T0 + 1_505_000 });
    expect(regions[1]).toMatchObject({ fromEpochMs: T0 + 1_515_000, toEpochMs: T0 + 3_005_000 });
  });

  it('covers the leading range edge when no earlier record exists', () => {
    const [leading] = buildTimelineIndicators([success(T0, T0 + 15_000)], {
      from: T0 - 1_000_000,
      to: T0 + 500_000,
    });
    expect(leading).toMatchObject({
      kind: 'stopped_service',
      fromEpochMs: T0 - 1_000_000,
      toEpochMs: T0,
      elapsedMs: 1_000_000,
    });
  });

  it('covers the trailing range edge after the last record', () => {
    const [trailing] = buildTimelineIndicators([success(T0, T0 + 15_000)], {
      from: T0 - 500_000,
      to: T0 + 1_100_000,
    });
    expect(trailing).toMatchObject({
      kind: 'stopped_service',
      fromEpochMs: T0 + 15_000,
      toEpochMs: T0 + 1_100_000,
      elapsedMs: 1_085_000,
    });
  });

  it('reports both edges around a lone record in a wide range', () => {
    const regions = buildTimelineIndicators([success(T0, T0 + 15_000)], {
      from: T0 - 1_000_000,
      to: T0 + 1_100_000,
    });
    expect(regions.map((region) => (region as StoppedServiceIndicator).elapsedMs)).toEqual([
      1_000_000, 1_085_000,
    ]);
  });

  it('clamps a leading silence to range.from and widens by the outside anchor cadence', () => {
    // Same geometry twice; only the pre-range record's cadence differs. A
    // 3600 s anchor widens the judge cadence past the silence — no region —
    // while a 300 s anchor reports it, clamped to `from`.
    const geometry = {
      preRange: success(T0 - 10_000_000, T0 - 9_995_000),
      first: success(T0, T0 + 5_000),
    };
    const range = { from: T0 - 4_000_000, to: T0 + 500_000 };
    expect(
      buildTimelineIndicators(
        [{ ...geometry.preRange, intervalSeconds: 3600 }, geometry.first],
        range,
      ),
    ).toEqual([]);
    expect(buildTimelineIndicators([geometry.preRange, geometry.first], range)).toEqual([
      {
        kind: 'stopped_service',
        accountId: ACCOUNT,
        fromEpochMs: T0 - 4_000_000,
        toEpochMs: T0,
        elapsedMs: 4_000_000,
        intervalSeconds: INTERVAL,
        thresholdMs: THRESHOLD_MS,
      },
    ]);
  });

  it.each([
    ['a grow (60 s → 3600 s) across the silence', 60, 3600],
    ['a shrink (3600 s → 60 s) across the silence', 3600, 60],
  ])('judges a boundary cadence change by the more permissive side: %s', (_label, a, b) => {
    // 7_200_000 ms of silence: far beyond the 60 s threshold (198 000 ms),
    // below the 3600 s one (11_880_000 ms) — the widened judge says healthy.
    const silence = 7_200_000;
    expect(
      buildTimelineIndicators(
        [
          run({ outcome: 'success', startedAt: T0, endedAt: T0 + 5_000, intervalSeconds: a }),
          run({
            outcome: 'success',
            startedAt: T0 + silence + 5_000,
            endedAt: T0 + silence + 10_000,
            intervalSeconds: b,
          }),
        ],
        { from: T0 - 60_000, to: T0 + silence + 100_000 },
      ),
    ).toEqual([]);
  });

  it('reports the same silence when both boundaries ran the tight cadence', () => {
    const silence = 7_200_000;
    const [region] = buildTimelineIndicators(
      [success(T0, T0 + 5_000), success(T0 + silence + 5_000, T0 + silence + 10_000)],
      { from: T0 - 60_000, to: T0 + silence + 100_000 },
    );
    expect(region).toMatchObject({
      kind: 'stopped_service',
      fromEpochMs: T0 + 5_000,
      toEpochMs: T0 + silence + 5_000,
      intervalSeconds: INTERVAL,
      thresholdMs: THRESHOLD_MS,
    });
  });

  it('measures silence from the aliveness frontier when records overlap', () => {
    // B runs inside A's span (impossible under §7.1's no-overlap rule, but
    // data is data): the frontier stays A's end, so the silence before C
    // starts there — not at B's earlier end.
    const indicators = buildTimelineIndicators(
      [
        success(T0, T0 + 300_000),
        run({ outcome: 'parse_error', startedAt: T0 + 100_000, endedAt: T0 + 150_000 }),
        success(T0 + 2_300_000, T0 + 2_305_000),
      ],
      { from: T0 - 60_000, to: T0 + 2_400_000 },
    );
    expect(indicators).toEqual([
      {
        kind: 'collection_error',
        accountId: ACCOUNT,
        outcome: 'parse_error',
        fromEpochMs: T0 + 100_000,
        toEpochMs: T0 + 150_000,
        durationMs: 50_000,
        httpStatus: undefined,
        errorMessage: undefined,
        attempts: 1,
        retryAfterSeconds: undefined,
      },
      {
        kind: 'stopped_service',
        accountId: ACCOUNT,
        fromEpochMs: T0 + 300_000,
        toEpochMs: T0 + 2_300_000,
        elapsedMs: 2_000_000,
        intervalSeconds: INTERVAL,
        thresholdMs: THRESHOLD_MS,
      },
    ]);
  });

  it('judges the trailing silence by the frontier owner’s cadence', () => {
    // Two long records overlap; the frontier — the later end — belongs to
    // one of them at 3600 s and the other at 300 s. The trailing silence
    // (5 000 000 ms: beyond the 300 s threshold, inside the 3600 s one) is
    // judged by whoever owns the frontier, proving the owner pairing.
    const range = { from: T0 - 60_000, to: T0 + 5_900_000 };
    const ownerAt3600 = [
      run({ outcome: 'success', startedAt: T0, endedAt: T0 + 900_000, intervalSeconds: 3600 }),
      run({ outcome: 'success', startedAt: T0 + 100_000, endedAt: T0 + 110_000 }),
    ];
    const ownerAt300 = [
      run({ outcome: 'success', startedAt: T0, endedAt: T0 + 900_000 }),
      run({
        outcome: 'success',
        startedAt: T0 + 100_000,
        endedAt: T0 + 110_000,
        intervalSeconds: 3600,
      }),
    ];
    expect(buildTimelineIndicators(ownerAt3600, range)).toEqual([]);
    expect(buildTimelineIndicators(ownerAt300, range)).toEqual([
      {
        kind: 'stopped_service',
        accountId: ACCOUNT,
        fromEpochMs: T0 + 900_000,
        toEpochMs: T0 + 5_900_000,
        elapsedMs: 5_000_000,
        intervalSeconds: INTERVAL,
        thresholdMs: THRESHOLD_MS,
      },
    ]);
  });
});

describe('buildTimelineIndicators: degenerate inputs', () => {
  it('returns an empty timeline for no records — no cadence evidence to judge silence by', () => {
    expect(buildTimelineIndicators([], { from: T0 - 10_000_000, to: T0 + 10_000_000 })).toEqual([]);
  });

  it('a zero-width range shows only a cycle starting exactly on it', () => {
    const indicators = buildTimelineIndicators([run({ startedAt: T0, endedAt: T0 + 5_000 })], {
      from: T0,
      to: T0,
    });
    expect(indicators).toEqual([
      expect.objectContaining({ kind: 'collection_error', fromEpochMs: T0 }),
    ]);
    expect(buildTimelineIndicators([success(T0 + 5_000)], { from: T0, to: T0 })).toEqual([]);
  });
});

describe('buildTimelineIndicators: partitioning and determinism', () => {
  it('keeps accounts separate, in first-appearance order, each chronological', () => {
    // Account A (zai-main) holds an outage closed by a failed cycle; account
    // B holds one marker and no silence of its own — A's outage is not B's.
    const indicators = buildTimelineIndicators(
      [
        success(T0, T0 + 5_000),
        run({
          accountId: 'b-account',
          outcome: 'success',
          startedAt: T0 + 500_000,
          endedAt: T0 + 505_000,
        }),
        run({
          accountId: 'b-account',
          outcome: 'rate_limited',
          startedAt: T0 + 1_200_000,
          endedAt: T0 + 1_201_000,
          httpStatus: 429,
        }),
        run({
          outcome: 'server_error',
          startedAt: T0 + 2_000_000,
          endedAt: T0 + 2_010_000,
        }),
        run({
          accountId: 'b-account',
          outcome: 'success',
          startedAt: T0 + 1_900_000,
          endedAt: T0 + 1_905_000,
        }),
        success(T0 + 2_310_000, T0 + 2_315_000),
      ],
      { from: T0 - 60_000, to: T0 + 2_400_000 },
    );
    expect(indicators.map((indicator) => indicator.accountId)).toEqual([
      'zai-main',
      'zai-main',
      'b-account',
    ]);
    expect(indicators.map((indicator) => indicator.kind)).toEqual([
      'stopped_service',
      'collection_error',
      'collection_error',
    ]);
    const [aRegion] = indicators;
    expect(aRegion).toMatchObject({ fromEpochMs: T0 + 5_000, toEpochMs: T0 + 2_000_000 });
  });

  it('orders by account first appearance regardless of interleaving', () => {
    const indicators = buildTimelineIndicators(
      [
        run({ accountId: 'b-account', outcome: 'auth_error', startedAt: T0 + 10_000 }),
        run({ accountId: 'a-account', outcome: 'timeout', startedAt: T0 }),
      ],
      tightRange(),
    );
    expect(indicators.map((indicator) => indicator.accountId)).toEqual(['b-account', 'a-account']);
  });

  it('is independent of input order within an account', () => {
    const ordered = [
      success(T0, T0 + 5_000),
      run({ outcome: 'network_error', startedAt: T0 + 2_000_000, endedAt: T0 + 2_010_000 }),
      success(T0 + 2_310_000, T0 + 2_315_000),
    ];
    const range = { from: T0 - 60_000, to: T0 + 2_400_000 };
    expect(buildTimelineIndicators([...ordered].reverse(), range)).toEqual(
      buildTimelineIndicators(ordered, range),
    );
  });

  it('keeps input order for equal startedAt timestamps', () => {
    const indicators = buildTimelineIndicators(
      [
        run({ outcome: 'auth_error', startedAt: T0, endedAt: T0 + 1_000 }),
        run({ outcome: 'parse_error', startedAt: T0, endedAt: T0 + 2_000 }),
      ],
      tightRange(),
    );
    expect(indicators.map((indicator) => (indicator as CollectionErrorIndicator).outcome)).toEqual([
      'auth_error',
      'parse_error',
    ]);
  });
});

describe('buildTimelineIndicators: fail-fast validation', () => {
  it.each([
    [
      'range is not an object',
      'x' as unknown as TimelineQueryRange,
      'range must be a TimelineQueryRange',
    ],
    [
      'a non-finite from',
      { from: Number.NaN, to: T0 },
      'range.from must be a finite UTC epoch-milliseconds timestamp',
    ],
    [
      'a non-finite to',
      { from: T0, to: Number.POSITIVE_INFINITY },
      'range.to must be a finite UTC epoch-milliseconds timestamp',
    ],
    ['an inverted range', { from: T0 + 1, to: T0 }, 'range.from must not exceed range.to'],
  ])('rejects %s', (_label, badRange, message) => {
    expect(() => buildTimelineIndicators([], badRange as TimelineQueryRange)).toThrow(
      `buildTimelineIndicators: ${message}`,
    );
  });

  it('rejects a non-array runs argument', () => {
    expect(() =>
      buildTimelineIndicators('nope' as unknown as CollectionRunInput[], tightRange()),
    ).toThrow('buildTimelineIndicators: runs must be an array of CollectionRunInput');
  });

  it.each([
    ['a non-object run', null, 'runs[0] must be a CollectionRunInput'],
    [
      'a blank account id',
      run({ accountId: '  ' }),
      'runs[0].accountId must be a non-blank string',
    ],
    [
      'a non-finite startedAt',
      run({ startedAt: Number.NaN }),
      'runs[0].startedAt must be a finite UTC epoch-milliseconds timestamp',
    ],
    [
      'a non-finite endedAt',
      run({ endedAt: Number.POSITIVE_INFINITY }),
      'runs[0].endedAt must be a finite UTC epoch-milliseconds timestamp',
    ],
    [
      'an inverted cycle',
      run({ startedAt: T0 + 5_000, endedAt: T0 }),
      'runs[0].endedAt must not precede runs[0].startedAt',
    ],
    [
      'an interval below the §7.1 floor',
      run({ intervalSeconds: 59 }),
      'runs[0]: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    ],
    [
      'an interval above the §7.1 ceiling',
      run({ intervalSeconds: 3601 }),
      'runs[0]: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    ],
    [
      'a non-integer interval',
      run({ intervalSeconds: 300.5 }),
      'runs[0]: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    ],
    [
      'an unknown outcome',
      { ...run(), outcome: 'cancelled' } as unknown as CollectionRunInput,
      'runs[0].outcome must be one of the §11.2 collection outcomes (success, auth_error, rate_limited, network_error, timeout, server_error, parse_error)',
    ],
    [
      'a zero attempt count',
      run({ attempts: 0 }),
      'runs[0].attempts must be an integer >= 1 (spec §7.2 attempt count)',
    ],
    [
      'a fractional attempt count',
      run({ attempts: 1.5 }),
      'runs[0].attempts must be an integer >= 1 (spec §7.2 attempt count)',
    ],
    [
      'an http status below 100',
      run({ httpStatus: 99 }),
      'runs[0].httpStatus must be an integer in [100, 599]',
    ],
    [
      'an http status above 599',
      run({ httpStatus: 600 }),
      'runs[0].httpStatus must be an integer in [100, 599]',
    ],
    [
      'a retry-after above the §7.2 cap',
      run({ retryAfterSeconds: 3601 }),
      'runs[0].retryAfterSeconds must be an integer in [0, 3600] (spec §7.2 one-hour cap; 0 is the D-062 elapsed boundary)',
    ],
    [
      'a negative retry-after',
      run({ retryAfterSeconds: -1 }),
      'runs[0].retryAfterSeconds must be an integer in [0, 3600] (spec §7.2 one-hour cap; 0 is the D-062 elapsed boundary)',
    ],
    [
      'a non-string error message',
      { ...run(), errorMessage: 42 } as unknown as CollectionRunInput,
      'runs[0].errorMessage must be a string when present',
    ],
  ])('rejects %s', (_label, badRun, message) => {
    expect(() => buildTimelineIndicators([badRun as CollectionRunInput], tightRange())).toThrow(
      `buildTimelineIndicators: ${message}`,
    );
  });

  it('names the offending index', () => {
    expect(() =>
      buildTimelineIndicators([success(T0), success(T0 + 1), run({ attempts: 0 })], tightRange()),
    ).toThrow('runs[2].attempts must be an integer >= 1');
  });
});

describe('the §12.2 done-condition: failure types vs no collection activity', () => {
  // One scenario holding both classes: a failed cycle between healthy
  // records inside a range whose edges are silent past the threshold —
  // leading [T0-2_000_000, T0-900_000) and trailing [T0+305_000, T0+2_000_000]
  // regions around one auth_error marker, with the interior silences inside
  // the threshold.
  const scenario: TimelineIndicator[] = buildTimelineIndicators(
    [
      success(T0 - 900_000, T0 - 895_000),
      run({
        outcome: 'auth_error',
        startedAt: T0 - 450_000,
        endedAt: T0 - 449_000,
        httpStatus: 401,
      }),
      success(T0 + 300_000, T0 + 305_000),
    ],
    { from: T0 - 2_000_000, to: T0 + 2_000_000 },
  );

  it('separates the classes by the kind discriminant', () => {
    expect(scenario.map((indicator) => indicator.kind)).toEqual([
      'stopped_service',
      'collection_error',
      'stopped_service',
    ]);
  });

  it('gives every error indicator a §11.2 failure type', () => {
    for (const indicator of scenario) {
      if (indicator.kind === 'collection_error') {
        // Type narrowing is load-bearing: `outcome` exists only on this
        // class, and it is never `success`.
        expect(COLLECTION_OUTCOMES).toContain(indicator.outcome);
        expect(indicator.outcome).not.toBe('success');
        expect(indicator.attempts).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('gives every stopped-service indicator no failure type at all', () => {
    for (const indicator of scenario) {
      if (indicator.kind === 'stopped_service') {
        // Narrowing again: `elapsedMs` exists only on this class.
        expect(indicator.elapsedMs).toBeGreaterThan(indicator.thresholdMs);
        expect('outcome' in indicator).toBe(false);
        expect(Object.keys(indicator)).not.toContain('outcome');
      }
    }
  });

  it('makes the classes structurally distinguishable at the type level', () => {
    const failures: CollectionErrorIndicator[] = scenario.filter(
      (indicator): indicator is CollectionErrorIndicator => indicator.kind === 'collection_error',
    );
    const downtime: StoppedServiceIndicator[] = scenario.filter(
      (indicator): indicator is StoppedServiceIndicator => indicator.kind === 'stopped_service',
    );
    expect(failures).toHaveLength(1);
    expect(downtime).toHaveLength(2);
    expect(failures[0]!.outcome).toBe('auth_error');
    expect(downtime.every((region) => region.elapsedMs > 0)).toBe(true);
  });
});
