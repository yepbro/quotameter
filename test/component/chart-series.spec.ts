import { describe, expect, it } from 'vitest';
import type {
  HistoryBucket,
  HistoryEmptyPoint,
  HistoryPoint,
  HistoryPointItem,
  HistoryRangeReport,
} from '../../src/schemas/api/history';
import { formatChartDate, formatQuotaNumber } from '../../ui/src/format';
import {
  buildMetricChartOption,
  chartSamplesOf,
  rangeNoticeOf,
  resolveViewMode,
  seriesAvailability,
  TRUNCATION_NOTICE_MS,
  type ChartSample,
  type MetricChartOption,
} from '../../ui/src/charts/series';
import type { ChartTokens } from '../../ui/src/charts/tokens';

/**
 * The §14.4 chart data adapter and option builder (task 175; decision
 * D-148), pure: the D-139 wire kinds flatten onto samples, the §14.4 view
 * semantics (toggle availability, percentage-only metrics, unit
 * segregation) resolve, the D-147 truncation sliver stays quiet, and the
 * built option carries exactly one unit per value axis with the token
 * colors, catalog labels, and zone-formatted dates wired.
 */

/* ── Fixture builders ──────────────────────────────────────────────────── */

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const T1 = T0 + 3_600_000;
const T2 = T1 + 3_600_000;

function point(overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    kind: 'point',
    collectedAt: T0,
    used: 120_000,
    remaining: 30_000,
    limit: 150_000,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: null,
    isValid: true,
    invalidReason: null,
    ...overrides,
  };
}

function bucket(overrides: Partial<HistoryBucket> = {}): HistoryBucket {
  const first = point({ collectedAt: T0 });
  const last = point({ collectedAt: T2, used: 100_000, remaining: 50_000 });
  return {
    kind: 'bucket',
    fromEpochMs: first.collectedAt,
    toEpochMs: last.collectedAt,
    count: 12,
    min: { used: 90_000, remaining: 20_000, percentUsed: 60, percentRemaining: 13 },
    max: { used: 130_000, remaining: 60_000, percentUsed: 87, percentRemaining: 40 },
    first,
    last,
    ...overrides,
  };
}

function emptyPoint(at: number): HistoryEmptyPoint {
  return { kind: 'empty', collectedAt: at };
}

function rangeReport(overrides: Partial<HistoryRangeReport> = {}): HistoryRangeReport {
  return {
    outcome: 'ok',
    requestedFrom: T0,
    requestedTo: T2,
    effectiveFrom: T0,
    effectiveTo: T2,
    retentionHorizon: null,
    ...overrides,
  };
}

/** The full token set, with values chosen to be tellable apart in pins. */
const TOKENS: ChartTokens = {
  used: '#used-color',
  remaining: '#remaining-color',
  axisLabel: '#axis-color',
  splitLine: '#split-color',
  tooltipBackground: '#tip-bg',
  tooltipBorder: '#tip-border',
  tooltipText: '#tip-text',
  fontFamily: 'test-stack',
};

function buildOption(
  overrides: Partial<Parameters<typeof buildMetricChartOption>[0]> = {},
): MetricChartOption {
  const samples: ChartSample[] = chartSamplesOf([
    point({ collectedAt: T0 }),
    point({
      collectedAt: T1,
      used: 100_000,
      remaining: 50_000,
      percentUsed: 66.67,
      percentRemaining: 33.33,
    }),
  ]);
  return buildMetricChartOption({
    samples,
    mode: 'absolute',
    unitLabel: 'credits',
    tokens: TOKENS,
    text: { used: 'Used', remaining: 'Remaining' },
    timeZone: 'UTC',
    window: { from: T0, to: T2 },
    ...overrides,
  });
}

/* ── The wire kinds → samples ──────────────────────────────────────────── */

describe('chartSamplesOf (the D-139 kinds)', () => {
  it('maps raw points verbatim, nulls preserved, wire order kept', () => {
    const samples = chartSamplesOf([
      point({ collectedAt: T0, used: null, percentUsed: null }),
      point({ collectedAt: T1 }),
    ]);
    expect(samples).toEqual([
      {
        at: T0,
        used: null,
        remaining: 30_000,
        percentUsed: null,
        percentRemaining: 20,
      },
      {
        at: T1,
        used: 120_000,
        remaining: 30_000,
        percentUsed: 80,
        percentRemaining: 20,
      },
    ]);
  });

  it('maps an invalid row to its honest all-null sample (§8.4 values are null)', () => {
    const samples = chartSamplesOf([
      point({
        collectedAt: T0,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: null,
        percentRemaining: null,
        isValid: false,
        invalidReason: 'currentValue is not a number',
      }),
    ]);
    expect(samples).toEqual([
      { at: T0, used: null, remaining: null, percentUsed: null, percentRemaining: null },
    ]);
  });

  it('maps a gap empty point to an all-null sample at the gap midpoint', () => {
    const samples = chartSamplesOf([emptyPoint(T1)]);
    expect(samples).toEqual([
      { at: T1, used: null, remaining: null, percentUsed: null, percentRemaining: null },
    ]);
  });

  it('renders a bucket as its first and last endpoints (real observed points)', () => {
    const samples = chartSamplesOf([bucket()]);
    expect(samples.map((sample) => sample.at)).toEqual([T0, T2]);
    expect(samples.map((sample) => sample.used)).toEqual([120_000, 100_000]);
  });

  it('collapses a one-member bucket to a single sample', () => {
    // first and last share the collection stamp when one point is the
    // bucket's whole membership — one sample, not a duplicated instant.
    const first = point({ collectedAt: T0 });
    const samples = chartSamplesOf([
      bucket({ first, last: first, fromEpochMs: T0, toEpochMs: T0, count: 1 }),
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.at).toBe(T0);
  });

  it('flattens a mixed series in wire order', () => {
    const samples = chartSamplesOf([
      point({ collectedAt: T0 }),
      emptyPoint(T0 + 1_800_000),
      point({ collectedAt: T1 }),
      bucket(),
    ]);
    expect(samples.map((sample) => sample.at)).toEqual([
      T0,
      T0 + 1_800_000,
      T1,
      bucket().fromEpochMs,
      bucket().toEpochMs,
    ]);
  });
});

/* ── Availability and the §14.4 view semantics ─────────────────────────── */

describe('seriesAvailability / resolveViewMode (§14.4 toggle semantics)', () => {
  const absoluteSample: ChartSample = {
    at: T0,
    used: 1,
    remaining: 2,
    percentUsed: null,
    percentRemaining: null,
  };
  const percentSample: ChartSample = {
    at: T0,
    used: null,
    remaining: null,
    percentUsed: 50,
    percentRemaining: 50,
  };
  const bothSample: ChartSample = {
    at: T0,
    used: 1,
    remaining: 2,
    percentUsed: 33,
    percentRemaining: 67,
  };

  it('detects each family from the data', () => {
    expect(seriesAvailability([])).toEqual({ absolute: false, percent: false });
    expect(seriesAvailability([absoluteSample])).toEqual({ absolute: true, percent: false });
    expect(seriesAvailability([percentSample])).toEqual({ absolute: false, percent: true });
    expect(seriesAvailability([bothSample])).toEqual({ absolute: true, percent: true });
    // A remaining-only absolute sample still carries the absolute view.
    expect(seriesAvailability([{ ...absoluteSample, used: null }])).toEqual({
      absolute: true,
      percent: false,
    });
  });

  it('keeps a requested view that has data', () => {
    const both = { absolute: true, percent: true };
    expect(resolveViewMode('absolute', both)).toBe('absolute');
    expect(resolveViewMode('percent', both)).toBe('percent');
  });

  it('falls back to the available view when the requested one has no data', () => {
    expect(resolveViewMode('percent', { absolute: true, percent: false })).toBe('absolute');
    expect(resolveViewMode('absolute', { absolute: false, percent: true })).toBe('percent');
  });

  it('a percentage-only metric stays percentages — never an absolute axis (§14.4)', () => {
    expect(resolveViewMode('absolute', { absolute: false, percent: true })).toBe('percent');
  });

  it('an empty series answers absolute (nothing renders)', () => {
    expect(resolveViewMode('percent', { absolute: false, percent: false })).toBe('absolute');
  });
});

/* ── The D-147 residual: the truncation sliver ─────────────────────────── */

describe('rangeNoticeOf (the D-147 residual, thresholded)', () => {
  it('stays quiet on ok and on a sub-tolerance truncated sliver', () => {
    expect(rangeNoticeOf(rangeReport())).toBe('none');
    expect(
      rangeNoticeOf(
        rangeReport({
          outcome: 'truncated',
          requestedFrom: T0,
          effectiveFrom: T0 + 30_000,
          retentionHorizon: T0 + 30_000,
        }),
      ),
    ).toBe('none');
    // The tolerance boundary itself stays quiet (strict excess).
    expect(
      rangeNoticeOf(
        rangeReport({
          outcome: 'truncated',
          requestedFrom: T0,
          effectiveFrom: T0 + TRUNCATION_NOTICE_MS,
          retentionHorizon: T0 + TRUNCATION_NOTICE_MS,
        }),
      ),
    ).toBe('none');
  });

  it('surfaces a real truncation and a rejected range', () => {
    expect(
      rangeNoticeOf(
        rangeReport({
          outcome: 'truncated',
          requestedFrom: T0,
          effectiveFrom: T0 + TRUNCATION_NOTICE_MS + 1,
          retentionHorizon: T0 + TRUNCATION_NOTICE_MS + 1,
        }),
      ),
    ).toBe('truncated');
    expect(
      rangeNoticeOf(rangeReport({ outcome: 'rejected', effectiveFrom: null, effectiveTo: null })),
    ).toBe('rejected');
  });
});

/* ── The option builder ────────────────────────────────────────────────── */

describe('buildMetricChartOption (one unit per axis, by construction)', () => {
  it('absolute view: one y-axis named by the unit, data from the absolute fields only', () => {
    const option = buildOption({ mode: 'absolute' });
    // ONE axis — an array here would mean multiple (unit-mixing) axes.
    expect(Array.isArray(option.yAxis)).toBe(false);
    expect(option.yAxis.name).toBe('credits');
    expect(option.yAxis.min).toBeUndefined();
    expect(option.yAxis.max).toBeUndefined();
    expect(option.series).toHaveLength(2);
    // The used series plots the ABSOLUTE values — the percent fields of
    // the same samples (80 / 66.67) must not leak into the axis.
    expect(option.series[0]?.data).toEqual([
      [T0, 120_000],
      [T1, 100_000],
    ]);
    expect(option.series[1]?.data).toEqual([
      [T0, 30_000],
      [T1, 50_000],
    ]);
  });

  it('percent view: the % axis is bounded 0–100 and plots only the percent fields', () => {
    const option = buildOption({ mode: 'percent' });
    expect(option.yAxis.name).toBe('%');
    expect(option.yAxis.min).toBe(0);
    expect(option.yAxis.max).toBe(100);
    expect(option.series[0]?.data).toEqual([
      [T0, 80],
      [T1, 66.67],
    ]);
    expect(option.series[1]?.data).toEqual([
      [T0, 20],
      [T1, 33.33],
    ]);
  });

  it('a percentage-only metric renders through the same percent axis (no absolute axis)', () => {
    const samples = chartSamplesOf([
      point({
        collectedAt: T0,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: 42,
        percentRemaining: 58,
      }),
    ]);
    const option = buildOption({
      samples,
      mode: resolveViewMode('absolute', seriesAvailability(samples)),
      unitLabel: 'percent',
    });
    expect(option.yAxis.name).toBe('%');
    expect(option.series[0]?.data).toEqual([[T0, 42]]);
  });

  it('preserves nulls as line breaks (connectNulls: false, empty entries stay null)', () => {
    const samples = chartSamplesOf([
      point({ collectedAt: T0 }),
      emptyPoint(T1),
      point({ collectedAt: T2 }),
    ]);
    const option = buildOption({ samples });
    expect(option.series[0]?.connectNulls).toBe(false);
    expect(option.series[0]?.data).toEqual([
      [T0, 120_000],
      [T1, null],
      [T2, 120_000],
    ]);
  });

  it('binds the x window to the requested bounds on a numeric epoch-ms axis', () => {
    const option = buildOption({ window: { from: T0, to: T2 } });
    expect(option.xAxis.type).toBe('value');
    expect(option.xAxis.min).toBe(T0);
    expect(option.xAxis.max).toBe(T2);
    expect(option.xAxis.splitLine.show).toBe(false);
  });

  it('formats axis ticks and tooltip dates in the configured display zone', () => {
    const option = buildOption({ timeZone: 'Asia/Kathmandu' });
    expect(option.xAxis.axisLabel.formatter(T0)).toBe(formatChartDate(T0, 'Asia/Kathmandu'));
    expect(option.tooltip.formatter([])).toBe('');
    const text = option.tooltip.formatter([
      { seriesName: 'Used', value: [T0, 120_000], axisValue: T0 },
      { seriesName: 'Remaining', value: [T0, null], axisValue: T0 },
    ]);
    // The date header leads; the gap series contributes no invented value.
    expect(text.startsWith(formatChartDate(T0, 'Asia/Kathmandu'))).toBe(true);
    expect(text).toContain(`Used: ${formatQuotaNumber(120_000)} credits`);
    expect(text).not.toContain('Remaining');
  });

  it('suffixes percent tooltips with % and absolute tooltips with the unit word', () => {
    const params = [{ seriesName: 'Used', value: [T0, 42.5], axisValue: T0 }] as const;
    expect(buildOption({ mode: 'percent' }).tooltip.formatter([...params])).toContain(
      'Used: 42.5%',
    );
    expect(buildOption({ mode: 'absolute' }).tooltip.formatter([...params])).toContain(
      'Used: 42.5 credits',
    );
  });

  it('wires the tokens into the series, axes, legend, and tooltip (D-133)', () => {
    const option = buildOption();
    expect(option.series[0]?.lineStyle).toMatchObject({ color: '#used-color', type: 'solid' });
    expect(option.series[1]?.lineStyle).toMatchObject({
      color: '#remaining-color',
      // Never color alone (§14.1): the remaining line is dashed beside
      // the used line's solid.
      type: 'dashed',
    });
    expect(option.series[0]?.itemStyle.color).toBe('#used-color');
    expect(option.legend.data).toEqual(['Used', 'Remaining']);
    expect(option.legend.textStyle.color).toBe('#axis-color');
    expect(option.tooltip.backgroundColor).toBe('#tip-bg');
    expect(option.tooltip.borderColor).toBe('#tip-border');
    expect(option.tooltip.textStyle.color).toBe('#tip-text');
    expect(option.textStyle.fontFamily).toBe('test-stack');
    expect(option.yAxis.splitLine.lineStyle.color).toBe('#split-color');
    expect(option.yAxis.axisLabel.color).toBe('#axis-color');
  });

  it('renders point symbols on sparse series and none on dense ones', () => {
    const dense = Array.from({ length: 81 }, (_unused, index): HistoryPointItem =>
      point({ collectedAt: T0 + index * 60_000 }),
    );
    expect(buildOption().series[0]?.showSymbol).toBe(true);
    expect(buildOption({ samples: chartSamplesOf(dense) }).series[0]?.showSymbol).toBe(false);
  });

  it('renders deterministically (animation off, richText tooltip per D-127)', () => {
    const option = buildOption();
    expect(option.animation).toBe(false);
    expect(option.tooltip.renderMode).toBe('richText');
    expect(option.tooltip.trigger).toBe('axis');
  });
});
