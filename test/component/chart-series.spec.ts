import { describe, expect, it } from 'vitest';
import type {
  EventsResponse,
  HistoryBucket,
  HistoryEmptyPoint,
  HistoryPoint,
  HistoryPointItem,
  HistoryRangeReport,
} from '../../src/schemas/api/history';
import type { PeakHoursResponse } from '../../src/schemas/api/peak-hours';
import { formatChartDate, formatQuotaNumber } from '../../ui/src/format';
import {
  annotationsOf,
  errorSymbolOf,
  peakBandsOf,
  scheduleZoneOf,
  type ChartWindow,
} from '../../ui/src/charts/annotations';
import {
  buildMetricChartOption,
  chartSamplesOf,
  CHART_X_ZOOM_ID,
  DEFAULT_CHART_WIDTH_PX,
  MIN_ZOOM_SPAN_MS,
  rangeNoticeOf,
  resolveViewMode,
  seriesAvailability,
  TRUNCATION_NOTICE_MS,
  type ChartBandRenderApi,
  type ChartSample,
  type ChartSeriesOption,
  type MetricChartOption,
  type MetricChartText,
} from '../../ui/src/charts/series';
import type { ChartTokens } from '../../ui/src/charts/tokens';

/**
 * The §14.4 chart data adapter and option builder (task 175; decision
 * D-148), pure: the D-139 wire kinds flatten onto samples, the §14.4 view
 * semantics (toggle availability, percentage-only metrics, unit
 * segregation) resolve, the D-147 truncation sliver stays quiet, and the
 * built option carries exactly one unit per value axis with the token
 * colors, catalog labels, and zone-formatted dates wired. Task 176
 * (D-149) extends the same suite over the annotation mapping (§12.2's
 * per-metric/account-level split, §9.3's served bands) and the rendered
 * marks: reset markLines, hatched/gap bands, the strip's per-outcome
 * symbols, and the single-channel tooltip's composed facts.
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

/** The card's x window fixture — the requested-bounds pair. */
const WINDOW: ChartWindow = { from: T0, to: T2 };

/** An events response fixture over the wire's four §12.2 kinds. */
function eventsBody(
  events: EventsResponse['events'],
  range: HistoryRangeReport = rangeReport({ requestedFrom: T0, requestedTo: T2 }),
): EventsResponse {
  return { accountId: 'acc-1', metric: null, range, events };
}

/** A peak-hours response fixture (D-142's wire shape). */
function peaksBody(
  intervals: PeakHoursResponse['intervals'],
  timezone: string | null = 'Asia/Shanghai',
): PeakHoursResponse {
  return {
    accountId: 'acc-1',
    providerId: 'zai-coding-plan',
    timezone,
    offPeakMultiplier: timezone === null ? null : 0.75,
    range: rangeReport({ requestedFrom: T0, requestedTo: T2 }),
    intervals,
  };
}

/** The full token set, with values chosen to be tellable apart in pins. */
const TOKENS: ChartTokens = {
  used: '#used-color',
  remaining: '#remaining-color',
  peak: '#peak-color',
  reset: '#reset-color',
  gap: '#gap-color',
  stopped: '#stopped-color',
  danger: '#danger-color',
  axisLabel: '#axis-color',
  splitLine: '#split-color',
  tooltipBackground: '#tip-bg',
  tooltipBorder: '#tip-border',
  tooltipText: '#tip-text',
  fontFamily: 'test-stack',
};

/** The catalog vocabulary fixture — the `en` values the builder composes. */
const TEXT: MetricChartText = {
  used: 'Used',
  remaining: 'Remaining',
  peakHead: 'Peak · {name} ×{multiplier}',
  offPeakHead: 'Off-peak ×{multiplier}',
  bandTimes: '{start} – {end} ({zone})',
  gapHead: 'Collection gap',
  gapBody: 'No successful collection for {duration}',
  stoppedHead: 'Service stopped',
  stoppedBody: 'No collection records for {duration}',
  stoppedLabel: 'Service stopped',
  resetTooltip: 'Quota reset at {time}',
  resetLabel: 'Reset',
  bandsSeries: 'Schedule areas',
  errorsSeries: 'Failed collections',
  errorAttempts: 'attempts: {count}',
  errorStatus: 'HTTP {status}',
  errorRetryAfter: 'retry after {seconds} s',
  errorOutcomes: {
    auth_error: 'Authentication error',
    rate_limited: 'Rate limited',
    network_error: 'Network error',
    timeout: 'Timeout',
    server_error: 'Server error',
    parse_error: 'Response format error',
  },
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
    text: TEXT,
    timeZone: 'UTC',
    window: { from: T0, to: T2 },
    // A desktop-wide canvas by default: the two-hour UTC window carries
    // hourly ticks; the density arms below override it.
    widthPx: 900,
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

/** The line series at `index` — narrowed from the series union for pins. */
function lineSeriesOf(option: MetricChartOption, index: 0 | 1): ChartSeriesOption {
  return option.series[index] as ChartSeriesOption;
}

describe('buildMetricChartOption (one unit per axis, by construction)', () => {
  it('absolute view: one value y-axis named by the unit, data from the absolute fields only', () => {
    const option = buildOption({ mode: 'absolute' });
    // ONE value axis — with no annotations the yAxis array holds exactly
    // the main axis (a second would exist only for bands/strip scaffolding).
    expect(option.yAxis).toHaveLength(1);
    expect(option.yAxis[0]!.name).toBe('credits');
    expect(option.yAxis[0]!.min).toBeUndefined();
    expect(option.yAxis[0]!.max).toBeUndefined();
    expect(option.series).toHaveLength(2);
    // The used series plots the ABSOLUTE values — the percent fields of
    // the same samples (80 / 66.67) must not leak into the axis.
    expect(lineSeriesOf(option, 0).data).toEqual([
      [T0, 120_000],
      [T1, 100_000],
    ]);
    expect(lineSeriesOf(option, 1).data).toEqual([
      [T0, 30_000],
      [T1, 50_000],
    ]);
  });

  it('percent view: the % axis is bounded 0–100 and plots only the percent fields', () => {
    const option = buildOption({ mode: 'percent' });
    expect(option.yAxis[0]!.name).toBe('%');
    expect(option.yAxis[0]!.min).toBe(0);
    expect(option.yAxis[0]!.max).toBe(100);
    expect(lineSeriesOf(option, 0).data).toEqual([
      [T0, 80],
      [T1, 66.67],
    ]);
    expect(lineSeriesOf(option, 1).data).toEqual([
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
    expect(option.yAxis[0]!.name).toBe('%');
    expect(lineSeriesOf(option, 0).data).toEqual([[T0, 42]]);
  });

  it('preserves nulls as line breaks (connectNulls: false, empty entries stay null)', () => {
    const samples = chartSamplesOf([
      point({ collectedAt: T0 }),
      emptyPoint(T1),
      point({ collectedAt: T2 }),
    ]);
    const option = buildOption({ samples });
    expect(lineSeriesOf(option, 0).connectNulls).toBe(false);
    expect(lineSeriesOf(option, 0).data).toEqual([
      [T0, 120_000],
      [T1, null],
      [T2, 120_000],
    ]);
  });

  it('binds the x window to the requested bounds on a numeric epoch-ms axis', () => {
    const option = buildOption({ window: { from: T0, to: T2 } });
    expect(option.xAxis[0]!.type).toBe('value');
    expect(option.xAxis[0]!.min).toBe(T0);
    expect(option.xAxis[0]!.max).toBe(T2);
    expect(option.xAxis[0]!.splitLine.show).toBe(false);
  });

  it('places ticks on local hour boundaries in the zone and formats each (D-150)', () => {
    // The default fixture: a two-hour UTC window on a 900 px canvas —
    // hourly ticks at whole local (UTC) hours, half-open [from, to).
    const option = buildOption();
    expect(option.xAxis[0]!.axisLabel.customValues).toEqual([T0, T1]);
    expect(option.xAxis[0]!.axisTick!.customValues).toBe(option.xAxis[0]!.axisLabel.customValues);
    expect(option.xAxis[0]!.axisLabel.formatter!(T0)).toBe('12 PM');
    expect(option.xAxis[0]!.axisLabel.formatter!(T1)).toBe('1 PM');
  });

  it("aligns a non-whole-hour zone to ITS hour boundaries, not UTC's", () => {
    // Asia/Kathmandu (+05:45): local hours sit at :15 UTC-minutes — a
    // uniform epoch ladder can never hit them.
    const option = buildOption({ timeZone: 'Asia/Kathmandu' });
    expect(option.xAxis[0]!.axisLabel.customValues).toEqual([
      Date.UTC(2026, 10, 4, 12, 15),
      Date.UTC(2026, 10, 4, 13, 15),
    ]);
    expect(option.xAxis[0]!.axisLabel.formatter!(Date.UTC(2026, 10, 4, 12, 15))).toBe('6 PM');
  });

  it('coarsens the ladder to the measured canvas width', () => {
    const from = Date.UTC(2026, 10, 4, 0);
    const window = { from, to: from + 24 * 3_600_000 };
    // 900 px → an 824 px plot → 3-hour ticks (00/03/06/… local).
    expect(buildOption({ window }).xAxis[0]!.axisLabel.customValues).toEqual(
      Array.from({ length: 8 }, (_unused, index) => from + index * 3 * 3_600_000),
    );
    // §14.1's 360 px floor → a 284 px plot → 12-hour ticks.
    expect(buildOption({ window, widthPx: 360 }).xAxis[0]!.axisLabel.customValues).toEqual([
      from,
      from + 12 * 3_600_000,
    ]);
  });

  it('treats an unmeasured canvas as the 360 px floor', () => {
    const from = Date.UTC(2026, 10, 4, 0);
    const window = { from, to: from + 24 * 3_600_000 };
    // Whole-option equality is function-identity-blocked (each build owns
    // its formatter closures); the tick output is the observable surface.
    const unmeasured = buildOption({ window, widthPx: 0 }).xAxis[0]!.axisLabel.customValues;
    expect(unmeasured).toEqual(
      buildOption({ window, widthPx: DEFAULT_CHART_WIDTH_PX }).xAxis[0]!.axisLabel.customValues,
    );
    expect(unmeasured).toEqual([from, from + 12 * 3_600_000]);
  });

  it('keeps the strip x-axis on the same tick instants (the D-149 pair)', () => {
    const option = annotatedOption();
    expect(option.xAxis[1]!.axisLabel.customValues).toEqual(
      option.xAxis[0]!.axisLabel.customValues,
    );
    expect(option.xAxis[1]!.axisTick!.customValues).toEqual(
      option.xAxis[0]!.axisTick!.customValues,
    );
    // The hidden main axis carries the instants too — its tick marks.
    expect(option.xAxis[0]!.axisLabel.customValues).toEqual([T0, T1]);
  });

  it('falls back to the full chart date for a value outside the tick set', () => {
    // Not a rendered tick (mid-hour): the fallback keeps a racing
    // re-format of outgoing ticks honest instead of blank.
    const option = buildOption();
    const offTick = T0 + 60_000;
    expect(option.xAxis[0]!.axisLabel.formatter!(offTick)).toBe(formatChartDate(offTick, 'UTC'));
  });

  it('formats axis ticks and tooltip dates in the configured display zone', () => {
    const option = buildOption({ timeZone: 'Asia/Kathmandu' });
    // A real tick instant (local 18:00 = 12:15Z in +05:45) renders the
    // hour word, not the full fallback date.
    expect(option.xAxis[0]!.axisLabel.formatter!(Date.UTC(2026, 10, 4, 12, 15))).toBe('6 PM');
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
    expect(lineSeriesOf(option, 0).lineStyle).toMatchObject({
      color: '#used-color',
      type: 'solid',
    });
    expect(lineSeriesOf(option, 1).lineStyle).toMatchObject({
      color: '#remaining-color',
      // Never color alone (§14.1): the remaining line is dashed beside
      // the used line's solid.
      type: 'dashed',
    });
    expect(lineSeriesOf(option, 0).itemStyle.color).toBe('#used-color');
    expect(option.legend.data).toEqual(['Used', 'Remaining']);
    expect(option.legend.textStyle.color).toBe('#axis-color');
    expect(option.tooltip.backgroundColor).toBe('#tip-bg');
    expect(option.tooltip.borderColor).toBe('#tip-border');
    expect(option.tooltip.textStyle.color).toBe('#tip-text');
    expect(option.textStyle.fontFamily).toBe('test-stack');
    expect(option.yAxis[0]!.splitLine!.lineStyle.color).toBe('#split-color');
    expect(option.yAxis[0]!.axisLabel.color).toBe('#axis-color');
  });

  it('renders point symbols on sparse series and none on dense ones', () => {
    const dense = Array.from({ length: 81 }, (_unused, index): HistoryPointItem =>
      point({ collectedAt: T0 + index * 60_000 }),
    );
    expect(lineSeriesOf(buildOption(), 0).showSymbol).toBe(true);
    expect(lineSeriesOf(buildOption({ samples: chartSamplesOf(dense) }), 0).showSymbol).toBe(false);
  });

  it('renders deterministically (animation off, richText tooltip per D-127)', () => {
    const option = buildOption();
    expect(option.animation).toBe(false);
    expect(option.tooltip.renderMode).toBe('richText');
    expect(option.tooltip.trigger).toBe('axis');
  });
});

/* ── Task 176: the annotation mapping (D-149) ─────────────────────────── */

describe('annotationsOf (§12.2: per-metric vs account-level)', () => {
  it('keeps this metric’s resets and gaps, and every account-level fact', () => {
    const annotations = annotationsOf(
      eventsBody([
        {
          kind: 'reset',
          metricKey: 'tokens-5h',
          eventAt: T1,
          runId: null,
          details: {},
        },
        {
          kind: 'reset',
          metricKey: 'other-metric',
          eventAt: T1,
          runId: null,
          details: {},
        },
        {
          kind: 'gap',
          metricKey: 'tokens-5h',
          fromEpochMs: T0,
          toEpochMs: T1,
          elapsedMs: 3_600_000,
          intervalSeconds: 300,
          thresholdMs: 900_000,
        },
        {
          kind: 'gap',
          metricKey: 'another-metric',
          fromEpochMs: T0,
          toEpochMs: T1,
          elapsedMs: 3_600_000,
          intervalSeconds: 300,
          thresholdMs: 900_000,
        },
        {
          kind: 'collection_error',
          outcome: 'network_error',
          fromEpochMs: T1,
          toEpochMs: T1 + 5_000,
          durationMs: 5_000,
          httpStatus: null,
          message: 'socket hang up',
          attempts: 2,
          retryAfterSeconds: null,
        },
        {
          kind: 'stopped_service',
          fromEpochMs: T1,
          toEpochMs: T2,
          elapsedMs: 3_600_000,
          intervalSeconds: 300,
          thresholdMs: 900_000,
        },
      ]),
      'tokens-5h',
      WINDOW,
    );
    expect(annotations.resets).toEqual([{ at: T1 }]);
    expect(annotations.gaps).toEqual([
      {
        from: T0,
        to: T1,
        elapsedMs: 3_600_000,
        thresholdMs: 900_000,
      },
    ]);
    // Account-level facts arrive on every metric chart (D-149).
    expect(annotations.stopped).toEqual([{ from: T1, to: T2, elapsedMs: 3_600_000 }]);
    expect(annotations.errors).toHaveLength(1);
    expect(annotations.errors[0]).toMatchObject({
      at: T1,
      outcome: 'network_error',
      attempts: 2,
      message: 'socket hang up',
    });
  });

  it('clamps bands to the window and drops the emptied ones (D-149)', () => {
    const annotations = annotationsOf(
      eventsBody([
        {
          kind: 'gap',
          metricKey: 'tokens-5h',
          fromEpochMs: T0 - 3_600_000,
          toEpochMs: T0 + 600_000,
          elapsedMs: 4_200_000,
          intervalSeconds: 300,
          thresholdMs: 900_000,
        },
        {
          kind: 'stopped_service',
          fromEpochMs: T0 - 3_600_000,
          toEpochMs: T0,
          elapsedMs: 3_600_000,
          intervalSeconds: 300,
          thresholdMs: 900_000,
        },
      ]),
      'tokens-5h',
      WINDOW,
    );
    // The straddling band clamps to the window edge; the outside one drops.
    expect(annotations.gaps).toEqual([
      {
        from: T0,
        to: T0 + 600_000,
        elapsedMs: 4_200_000,
        thresholdMs: 900_000,
      },
    ]);
    expect(annotations.stopped).toEqual([]);
  });

  it('drops marks outside the window and answers nothing for null events', () => {
    const outside = annotationsOf(
      eventsBody([
        {
          kind: 'reset',
          metricKey: 'tokens-5h',
          eventAt: T0 - 1,
          runId: null,
          details: {},
        },
        {
          kind: 'collection_error',
          outcome: 'timeout',
          fromEpochMs: T2 + 1,
          toEpochMs: T2 + 2,
          durationMs: 1,
          httpStatus: null,
          message: '',
          attempts: 1,
          retryAfterSeconds: null,
        },
      ]),
      'tokens-5h',
      WINDOW,
    );
    expect(outside.resets).toEqual([]);
    expect(outside.errors).toEqual([]);
    expect(annotationsOf(null, 'tokens-5h', WINDOW)).toEqual({
      resets: [],
      gaps: [],
      stopped: [],
      errors: [],
    });
  });
});

describe('peakBandsOf / scheduleZoneOf (§9.3: served intervals, verbatim)', () => {
  it('maps the served peak/off-peak partition with the §9.3 facts', () => {
    const bands = peakBandsOf(
      peaksBody([
        {
          kind: 'peak',
          start: T0,
          end: T1,
          multiplier: 1.5,
          windowId: 'evening',
          name: 'Evening',
          localStart: '2026-11-04T17:00',
          localEnd: '2026-11-04T20:00',
        },
        {
          kind: 'off-peak',
          start: T1,
          end: T2,
          multiplier: 0.75,
          localStart: '2026-11-04T20:00',
          localEnd: '2026-11-04T21:00',
        },
      ]),
      WINDOW,
    );
    expect(bands).toEqual([
      {
        kind: 'peak',
        from: T0,
        to: T1,
        start: T0,
        end: T1,
        name: 'Evening',
        multiplier: 1.5,
        localStart: '2026-11-04T17:00',
        localEnd: '2026-11-04T20:00',
      },
      {
        kind: 'offPeak',
        from: T1,
        to: T2,
        start: T1,
        end: T2,
        name: null,
        multiplier: 0.75,
        localStart: '2026-11-04T20:00',
        localEnd: '2026-11-04T21:00',
      },
    ]);
    expect(scheduleZoneOf(peaksBody([], 'Asia/Shanghai'))).toBe('Asia/Shanghai');
  });

  it('no schedule, rejected range, or null response maps to no bands — never invented', () => {
    expect(peakBandsOf(peaksBody([], null), WINDOW)).toEqual([]);
    expect(peakBandsOf(peaksBody([], 'Asia/Shanghai'), WINDOW)).toEqual([]);
    expect(peakBandsOf(null, WINDOW)).toEqual([]);
    expect(scheduleZoneOf(null)).toBeNull();
    expect(scheduleZoneOf(peaksBody([], null))).toBeNull();
  });

  it('clamps the served intervals to the card window', () => {
    const bands = peakBandsOf(
      peaksBody([
        {
          kind: 'peak',
          start: T0 - 3_600_000,
          end: T0 + 600_000,
          multiplier: 1.5,
          windowId: 'w',
          name: 'W',
          localStart: '2026-11-04T16:00',
          localEnd: '2026-11-04T17:10',
        },
      ]),
      WINDOW,
    );
    expect(bands).toEqual([
      {
        kind: 'peak',
        from: T0,
        to: T0 + 600_000,
        // The served bounds ride along: the tooltip's both-zone times
        // state the real window, not the clamp (§14.4/§9.3 honesty).
        start: T0 - 3_600_000,
        end: T0 + 600_000,
        name: 'W',
        multiplier: 1.5,
        localStart: '2026-11-04T16:00',
        localEnd: '2026-11-04T17:10',
      },
    ]);
  });
});

describe('errorSymbolOf (§12.2: a distinct shape per outcome)', () => {
  it('maps the six §11.2 classes onto six distinct symbols', () => {
    const symbols = [
      errorSymbolOf('auth_error'),
      errorSymbolOf('rate_limited'),
      errorSymbolOf('network_error'),
      errorSymbolOf('timeout'),
      errorSymbolOf('server_error'),
      errorSymbolOf('parse_error'),
    ];
    expect(symbols).toEqual(['diamond', 'triangle', 'circle', 'rect', 'roundRect', 'pin']);
    expect(new Set(symbols).size).toBe(6);
  });
});

/* ── Task 176: the annotated option (D-149) ───────────────────────────── */

/** The line-series fixture samples reused by the annotation builder tests. */
const ANNOTATION_SAMPLES: ChartSample[] = chartSamplesOf([
  point({ collectedAt: T0 }),
  point({ collectedAt: T1, used: 100_000, remaining: 50_000 }),
  point({ collectedAt: T2, used: 140_000, remaining: 10_000 }),
]);

/** The full annotation fixture: one of each §12.2 kind plus one peak band. */
function annotatedOption(): MetricChartOption {
  return buildOption({
    samples: ANNOTATION_SAMPLES,
    annotations: {
      resets: [{ at: T1 }],
      gaps: [
        { from: T0 + 900_000, to: T0 + 2_700_000, elapsedMs: 1_800_000, thresholdMs: 900_000 },
      ],
      stopped: [{ from: T1, to: T2, elapsedMs: 3_600_000 }],
      errors: [
        {
          at: T0 + 300_000,
          outcome: 'rate_limited',
          httpStatus: 429,
          message: 'slow down',
          attempts: 3,
          retryAfterSeconds: 30,
        },
        {
          at: T1 + 300_000,
          outcome: 'auth_error',
          httpStatus: 401,
          message: '',
          attempts: 1,
          retryAfterSeconds: null,
        },
      ],
    },
    peak: {
      bands: [
        {
          kind: 'peak',
          from: T0,
          to: T0 + 1_800_000,
          start: T0,
          end: T0 + 1_800_000,
          name: 'Evening',
          multiplier: 1.5,
          localStart: '2026-11-04T17:00',
          localEnd: '2026-11-04T19:30',
        },
        {
          kind: 'offPeak',
          from: T0 + 1_800_000,
          to: T2,
          start: T0 + 1_800_000,
          end: T2,
          name: null,
          multiplier: 0.75,
          localStart: '2026-11-04T19:30',
          localEnd: '2026-11-04T21:00',
        },
      ],
      scheduleZone: 'Asia/Shanghai',
    },
  });
}

/** The series of a given id from the built option. */
function seriesOfId(option: MetricChartOption, id: string): MetricChartOption['series'][number] {
  return option.series.find((series) => 'id' in series && series.id === id)!;
}

describe('buildMetricChartOption: reset markers (§14.4 vertical labeled)', () => {
  it('renders one dashed vertical markLine per reset with the label and silence', () => {
    const option = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: { resets: [{ at: T1 }], gaps: [], stopped: [], errors: [] },
    });
    const used = lineSeriesOf(option, 0);
    expect(used.markLine).toMatchObject({
      silent: true,
      symbol: ['none', 'none'],
      lineStyle: { color: '#reset-color', type: 'dashed' },
      label: { show: true, formatter: 'Reset', position: 'insideEndTop' },
      data: [{ xAxis: T1 }],
    });
  });

  it('emits no markLine without resets (the 175 shape keeps)', () => {
    expect(lineSeriesOf(buildOption(), 0).markLine).toBeUndefined();
  });
});

describe('buildMetricChartOption: bands (§14.4/§12.2 areas)', () => {
  it('renders the peak/off-peak/gap/stopped spans as one silent custom series', () => {
    const option = annotatedOption();
    const bands = seriesOfId(option, 'qm-chart-bands');
    expect(bands).toMatchObject({ type: 'custom', silent: true, z: 0, clip: true });
    // The exclusion flag is the mechanism `collectSeriesInfo` honors —
    // without it the band series joins the axis tooltip's collection and
    // its span datum replaces quota params at band edges (the review
    // round's P1; pinned here because ECharts never boots in the suite).
    expect(bands).toMatchObject({ tooltip: { show: false } });
    expect(bands).toHaveProperty('xAxisIndex', 0);
    expect(bands).toHaveProperty('yAxisIndex', 1);
    if (!('data' in bands)) throw new Error('unreachable');
    expect(bands.data).toHaveLength(4);
    // Peak: tinted solid border; off-peak: unfilled dashed border — the
    // fill-presence and border-style distinctions carry the difference
    // with color off the table (§14.1). The tint is fillOpacity, so the
    // border stays at full strength beside a faded fill (the review
    // round's P1: element opacity fades stroke and decal together).
    expect(bands.data[0]).toMatchObject({
      value: [T0, T0 + 1_800_000],
      itemStyle: {
        color: '#peak-color',
        fillOpacity: 0.12,
        borderColor: '#peak-color',
        lineDash: null,
        decal: null,
      },
    });
    expect(bands.data[1]).toMatchObject({
      value: [T0 + 1_800_000, T2],
      itemStyle: { color: 'transparent', lineDash: [4, 3], decal: null },
    });
    // Gap: transparent fill, dashed border, 45° hatch.
    expect(bands.data[2]).toMatchObject({
      itemStyle: {
        color: 'transparent',
        borderColor: '#gap-color',
        lineDash: [4, 3],
        decal: { color: '#gap-color', rotation: Math.PI / 4 },
      },
      label: null,
    });
    // Stopped: tinted (fillOpacity only), solid border at full strength,
    // counter-angle hatch, labeled.
    expect(bands.data[3]).toMatchObject({
      itemStyle: {
        color: '#stopped-color',
        fillOpacity: 0.08,
        lineDash: null,
        decal: { color: '#stopped-color', rotation: -Math.PI / 4 },
      },
      label: 'Service stopped',
    });
    // The bands' own hidden 0..1 axis exists beside the main value axis.
    expect(option.yAxis[1]).toMatchObject({ show: false, min: 0, max: 1 });
  });

  it('emits no bands series and no second axis without annotations', () => {
    const option = buildOption();
    expect(
      option.series.find((series) => 'id' in series && series.id === 'qm-chart-bands'),
    ).toBeUndefined();
    expect(option.yAxis).toHaveLength(1);
    expect(option.grid).toHaveLength(1);
    expect(option.xAxis).toHaveLength(1);
  });
});

describe('buildMetricChartOption: the error strip (§14.4/§12.2)', () => {
  it('renders the failed cycles on a lower strip with per-outcome symbols', () => {
    const option = annotatedOption();
    const strip = seriesOfId(option, 'qm-chart-errors');
    expect(strip).toMatchObject({ type: 'scatter', symbolSize: 9 });
    expect(strip).toHaveProperty('xAxisIndex', 1);
    // Bands exist in this fixture, so the strip's y-axis follows them.
    expect(strip).toHaveProperty('yAxisIndex', 2);
    if (strip.type !== 'scatter') throw new Error('expected the error strip');
    expect(strip.itemStyle.color).toBe('#danger-color');
    expect(strip.data.map((datum) => datum.symbol)).toEqual(['triangle', 'diamond']);
    expect(strip.data[0]!.value).toEqual([T0 + 300_000, 0.5]);
    // The prebuilt tooltip lines: outcome word, meta fragments, message.
    expect(strip.data[0]!.tooltipLines).toEqual([
      formatChartDate(T0 + 300_000, 'UTC'),
      'Rate limited',
      'attempts: 3 · HTTP 429 · retry after 30 s',
      'slow down',
    ]);
    expect(strip.data[1]!.tooltipLines).toEqual([
      formatChartDate(T1 + 300_000, 'UTC'),
      'Authentication error',
      'attempts: 1 · HTTP 401',
    ]);
  });

  it('the strip grids align with the main grid and own the date labels', () => {
    const option = annotatedOption();
    expect(option.grid).toHaveLength(2);
    const [main, strip] = option.grid as [
      MetricChartOption['grid'][number],
      MetricChartOption['grid'][number],
    ];
    expect(main).toMatchObject({ left: 60, right: 16, top: 32 });
    expect(strip).toMatchObject({ left: 60, right: 16, height: 28 });
    // Identical left/right insets — the plots align by construction.
    expect(main.left).toBe(strip.left);
    expect(main.right).toBe(strip.right);
    // The strip's axes bind to the strip's grid — without the explicit
    // gridIndex every axis attaches to grid 0 and the strip renders
    // inside the main plot (the review round's P1).
    expect(option.xAxis).toHaveLength(2);
    expect(option.xAxis[0]!.gridIndex).toBeUndefined();
    expect(option.xAxis[1]).toMatchObject({
      gridIndex: 1,
      min: T0,
      max: T2,
      name: 'Failed collections',
    });
    expect(option.xAxis[1]!.axisLabel.show).toBeUndefined();
    expect(option.yAxis[option.yAxis.length - 1]).toMatchObject({ gridIndex: 1 });
    // With the strip present its x-axis carries the labels; the main
    // x-axis hides its own (no stacked duplicate).
    expect(option.xAxis[0]!.axisLabel.show).toBe(false);
    // The strip's series joins the legend by name — the text signal.
    expect(option.legend.data).toEqual(['Used', 'Remaining', 'Failed collections']);
  });

  it('no errors: no strip, no second grid, the main x-axis labels stay', () => {
    const option = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: {
        resets: [],
        gaps: [],
        stopped: [],
        errors: [],
      },
      peak: { bands: peakBandsOf(peaksBody([], null), WINDOW), scheduleZone: null },
    });
    expect(
      option.series.find((series) => 'id' in series && series.id === 'qm-chart-errors'),
    ).toBeUndefined();
    expect(option.grid).toHaveLength(1);
    expect(option.xAxis[0]!.axisLabel.show).toBeUndefined();
    expect(option.legend.data).toEqual(['Used', 'Remaining']);
  });
});

describe('buildMetricChartOption: the single-channel tooltip (D-149)', () => {
  it('states the covering peak band: name, multiplier, and times in BOTH zones (§14.4)', () => {
    const option = annotatedOption();
    const text = option.tooltip.formatter([
      { seriesName: 'Used', value: [T0 + 600_000, 120_000], axisValue: T0 + 600_000 },
    ]);
    expect(text).toContain('Peak · Evening ×1.5');
    expect(text).toContain(
      `${formatChartDate(T0, 'UTC')} – ${formatChartDate(T0 + 1_800_000, 'UTC')} (UTC)`,
    );
    expect(text).toContain('2026-11-04T17:00 – 2026-11-04T19:30 (Asia/Shanghai)');
  });

  it('states the covering off-peak band with its multiplier', () => {
    const option = annotatedOption();
    const text = option.tooltip.formatter([
      { seriesName: 'Used', value: [T2 - 60_000, 140_000], axisValue: T2 - 60_000 },
    ]);
    expect(text).toContain('Off-peak ×0.75');
    expect(text).not.toContain('Peak ·');
  });

  it('states the covering gap and stopped regions with their durations', () => {
    const option = annotatedOption();
    const text = option.tooltip.formatter([
      { seriesName: 'Used', value: [T0 + 1_000_000, null], axisValue: T0 + 1_000_000 },
    ]);
    expect(text).toContain('Collection gap');
    expect(text).toContain('No successful collection for 30m');
    const stoppedText = option.tooltip.formatter([
      { seriesName: 'Used', value: [T1 + 600_000, 100_000], axisValue: T1 + 600_000 },
    ]);
    expect(stoppedText).toContain('Service stopped');
    expect(stoppedText).toContain('No collection records for 1h');
  });

  it('states a reset whose instant lies inside the snapped sample interval', () => {
    const option = annotatedOption();
    // The reset at T1 IS the second sample's instant — the (prev, cur]
    // interval contains it at the snap.
    const atSnap = option.tooltip.formatter([
      { seriesName: 'Used', value: [T1, 100_000], axisValue: T1 },
    ]);
    expect(atSnap).toContain(`Quota reset at ${formatChartDate(T1, 'UTC')}`);
    // Hovering the FIRST sample's interval — the reset belongs to the
    // next interval, not this one.
    const before = option.tooltip.formatter([
      { seriesName: 'Used', value: [T0, 120_000], axisValue: T0 },
    ]);
    expect(before).not.toContain('Quota reset');
  });

  it('renders the strip marker’s prebuilt lines for its own series params', () => {
    const option = annotatedOption();
    const text = option.tooltip.formatter([
      {
        seriesName: 'Failed collections',
        value: [T0 + 300_000, 0.5],
        axisValue: T0 + 300_000,
        data: { tooltipLines: ['line-one', 'line-two'] },
      },
    ]);
    expect(text).toBe('line-one\nline-two');
    // A strip param without prebuilt lines answers empty — no invented text.
    expect(
      option.tooltip.formatter([
        { seriesName: 'Failed collections', value: [T0, 0.5], axisValue: T0 },
      ]),
    ).toBe('');
  });

  it('ignores the bands series’ params — its values are spans, not quotas', async () => {
    const option = annotatedOption();
    // `silent` does not keep the custom bands series out of the axis
    // tooltip's collection (verified against the 6.1.0 source, the
    // review round's P1): its datum would render as a quota value.
    const text = option.tooltip.formatter([
      { seriesName: 'Used', value: [T0, 120_000], axisValue: T0 },
      { seriesName: 'Schedule areas', value: [T0, T0 + 1_800_000], axisValue: T0 },
    ]);
    expect(text).toContain('Used: 120,000 credits');
    expect(text).not.toContain('Schedule areas:');
  });

  it('truncates the y-axis labels inside the fixed left inset (grid alignment)', () => {
    const option = buildOption();
    expect(option.yAxis[0]!.axisLabel).toMatchObject({
      overflow: 'truncate',
      margin: 6,
    });
    expect(option.yAxis[0]!.axisLabel.width).toBeGreaterThan(0);
    expect(option.yAxis[0]!.axisLabel.width!).toBeLessThan(60);
  });
});

describe('bandRenderItem (the custom-series element, stubbed api)', () => {
  /** A linear stub api: x → x, y → 100 − y·100 (the plot box). */
  const api: ChartBandRenderApi = {
    coord: (point) => [point[0], 100 - point[1] * 100],
  };

  it('draws one full-height rect per band from the data index', () => {
    const option = annotatedOption();
    const bands = seriesOfId(option, 'qm-chart-bands');
    if (!('renderItem' in bands)) throw new Error('unreachable');
    const element = bands.renderItem({ dataIndex: 0 }, api);
    expect(element).toEqual({
      type: 'rect',
      shape: { x: T0, y: 0, width: 1_800_000, height: 100 },
      style: expect.objectContaining({ fill: '#peak-color', fillOpacity: 0.12 }),
    });
  });

  it('labels the stopped band when it is wide enough, and never the narrow one', () => {
    const option = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: {
        resets: [],
        gaps: [],
        stopped: [{ from: 100, to: 300, elapsedMs: 200 }],
        errors: [],
      },
    });
    const bands = seriesOfId(option, 'qm-chart-bands');
    if (!('renderItem' in bands) || !('data' in bands)) throw new Error('unreachable');
    const wide = bands.renderItem({ dataIndex: 0 }, api);
    expect(wide?.style.text).toBe('Service stopped');
    expect(wide?.style.textFill).toBe('#stopped-color');
    const narrow = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: {
        resets: [],
        gaps: [],
        stopped: [{ from: 100, to: 120, elapsedMs: 20 }],
        errors: [],
      },
    });
    const narrowBands = seriesOfId(narrow, 'qm-chart-bands');
    if (!('renderItem' in narrowBands)) throw new Error('unreachable');
    expect(narrowBands.renderItem({ dataIndex: 0 }, api)?.style.text).toBeUndefined();
  });

  it('draws nothing for a degenerate band width', () => {
    const option = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: {
        resets: [],
        gaps: [],
        stopped: [{ from: 100, to: 100, elapsedMs: 0 }],
        errors: [],
      },
    });
    const bands = seriesOfId(option, 'qm-chart-bands');
    if (!('renderItem' in bands)) throw new Error('unreachable');
    expect(bands.renderItem({ dataIndex: 0 }, api)).toBeNull();
  });
});

/* ── Task 178: the cursor/zoom option surface (D-153) ─────────────────── */

describe('buildMetricChartOption: the §14.4 zoom and cursor (task 178, D-153)', () => {
  it('declares one inside zoom over every x-axis, percent-based and span-floored', () => {
    const plain = buildOption();
    expect(plain.dataZoom).toEqual([
      {
        type: 'inside',
        id: CHART_X_ZOOM_ID,
        xAxisIndex: [0],
        filterMode: 'weakFilter',
        minValueSpan: MIN_ZOOM_SPAN_MS,
        zoomOnMouseWheel: 'shift',
      },
    ]);
    // With the strip present the zoom covers BOTH x-axes (the strip rides
    // the window); the y-axis count grows by the strip's hidden pair.
    const withStrip = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: {
        resets: [],
        gaps: [],
        stopped: [],
        errors: [
          {
            at: T1,
            outcome: 'timeout',
            httpStatus: null,
            message: '',
            attempts: 1,
            retryAfterSeconds: null,
          },
        ],
      },
    });
    expect(withStrip.dataZoom[0]!.xAxisIndex).toEqual([0, 1]);
  });

  it('formats the cursor label in the display zone and colors it through the tokens', () => {
    const option = buildOption({ timeZone: 'UTC' });
    expect(option.axisPointer.label.formatter({ value: T0 })).toBe(formatChartDate(T0, 'UTC'));
    expect(option.axisPointer.label.color).toBe('#tip-text');
    expect(option.axisPointer.label.backgroundColor).toBe('#tip-bg');
  });

  it('walks the tick ladder over the zoom span while the axes keep the requested bounds', () => {
    // A six-hour window at a desktop width: hourly ticks throughout.
    const window = { from: T0, to: T0 + 6 * 3_600_000 };
    const full = buildOption({ window });
    const fullTicks = full.xAxis[0]!.axisLabel.customValues!;
    expect(full.xAxis[0]!.min).toBe(window.from);
    expect(full.xAxis[0]!.max).toBe(window.to);
    expect(fullTicks.length).toBeGreaterThanOrEqual(6);

    // A zoom window over the middle two hours.
    const zoom = buildOption({
      window,
      zoom: { from: T0 + 3_600_000, to: T0 + 3 * 3_600_000 },
    });
    // The percent base is untouched — the axes still bound the requested
    // window (the relay's arithmetic, D-153).
    expect(zoom.xAxis[0]!.min).toBe(window.from);
    expect(zoom.xAxis[0]!.max).toBe(window.to);
    // The ticks walked the zoom span: every instant inside it — an
    // unrecomputed full-window set would carry T0's midnight-hour
    // neighbors outside the zoom span.
    const zoomTicks = zoom.xAxis[0]!.axisLabel.customValues!;
    expect(zoomTicks.length).toBeGreaterThanOrEqual(2);
    for (const tick of zoomTicks) {
      expect(tick).toBeGreaterThanOrEqual(T0 + 3_600_000);
      expect(tick).toBeLessThanOrEqual(T0 + 3 * 3_600_000);
    }
    expect(zoomTicks).not.toEqual(fullTicks);
  });

  it('carries the stable ids merge-mode matching relies on, across shapes', () => {
    const plain = buildOption();
    expect(plain.series.map((series) => series.id)).toEqual([
      'qm-series-used',
      'qm-series-remaining',
    ]);
    expect(plain.xAxis.map((axis) => axis.id)).toEqual(['qm-x-main']);
    expect(plain.yAxis.map((axis) => axis.id)).toEqual(['qm-y-main']);
    expect(plain.grid.map((grid) => grid.id)).toEqual(['qm-grid-main']);

    const full = buildOption({
      samples: ANNOTATION_SAMPLES,
      annotations: {
        resets: [],
        gaps: [{ from: T0, to: T1, elapsedMs: 3_600_000, thresholdMs: 900_000 }],
        stopped: [],
        errors: [
          {
            at: T1,
            outcome: 'timeout',
            httpStatus: null,
            message: '',
            attempts: 1,
            retryAfterSeconds: null,
          },
        ],
      },
    });
    // Every shape names the same families: the counts differ, the ids do
    // not — an annotation disappearing removes its component, never a
    // neighbor's identity (the y-axis index shift bands used to cause).
    expect(full.series.map((series) => series.id)).toEqual([
      'qm-series-used',
      'qm-series-remaining',
      'qm-chart-bands',
      'qm-chart-errors',
    ]);
    expect(full.xAxis.map((axis) => axis.id)).toEqual(['qm-x-main', 'qm-x-strip']);
    expect(full.yAxis.map((axis) => axis.id)).toEqual(['qm-y-main', 'qm-y-bands', 'qm-y-strip']);
    expect(full.grid.map((grid) => grid.id)).toEqual(['qm-grid-main', 'qm-grid-strip']);
  });
});
