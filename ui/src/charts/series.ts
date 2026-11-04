/**
 * The §14.4 metric-chart data adapter and option builder (task 175, spec
 * §13, §14.4; decision D-148) — pure functions from the D-139 history wire
 * kinds onto an ECharts option value object.
 *
 * Pinned interpretations:
 *
 * - **One unit per value axis, by construction.** The builder takes exactly
 *   one view mode (`absolute` / `percent`) and one unit label and emits
 *   exactly ONE y-axis with two series — there is no input shape that
 *   could mix units (the task's done-condition). Percentage-only metrics
 *   resolve to the percent view and never gain an absolute axis (§14.4:
 *   "do not use separate axes for incompatible units … do not infer token
 *   counts").
 * - **Wire kinds.** `point` entries map to samples verbatim (invalid rows
 *   arrive value-null per §8.4 — nulls stay null, never zero); `empty`
 *   entries (§12.2's gap markers) map to all-null samples that break the
 *   line (`connectNulls: false`); `bucket` entries (D-081/D-139
 *   downsampling — the common case: the default 7-day window at the
 *   default cadence exceeds the 1500-point budget) render minimally as
 *   their `first` and `last` endpoints — real observed points by
 *   reference, no invented values. Task 176 extends this mapping with the
 *   gap/marker elaborations on the same samples.
 * - **The numeric epoch-ms axis.** §14.4: ECharts' time axis is local or
 *   UTC only, so the x-axis is a `value` axis over epoch milliseconds with
 *   `Intl.DateTimeFormat` labels in the configured display zone. Tick
 *   PLACEMENT (hour/day boundaries, DST days) is task 177's; the window
 *   bounds come from the range report's REQUESTED bounds, which every
 *   per-metric chart of one page load shares — so the charts' axes align
 *   even where retention truncated the data.
 * - **The D-147 residual.** A `truncated` range report whose clamp is a
 *   sub-tolerance sliver (the server anchors the retention horizon to its
 *   own clock while the client's `from` anchors to the browser's) is NOT
 *   surfaced as a truncation — {@link TRUNCATION_NOTICE_MS} thresholds it.
 */

import type {
  HistoryPoint,
  HistoryPointItem,
  HistoryRangeReport,
} from '../../../src/schemas/api/history';
import { formatChartDate, formatQuotaNumber } from '../format';
import type { ChartTokens } from './tokens';

/* ── View modes and availability ───────────────────────────────────────── */

/** §14.4's two renderings of one metric's series. */
export type ChartViewMode = 'absolute' | 'percent';

/**
 * One flattened sample of the series: the §8.4 value vocabulary per
 * instant, nulls preserved (a null is an honest absence or a deliberate
 * line break — never a zero).
 */
export interface ChartSample {
  readonly at: number;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly percentUsed: number | null;
  readonly percentRemaining: number | null;
}

/** The value fields a point and a bucket endpoint share (D-139's encoding). */
type SampleValues = Pick<HistoryPoint, 'used' | 'remaining' | 'percentUsed' | 'percentRemaining'>;

function sampleOf(at: number, values: SampleValues): ChartSample {
  return {
    at,
    used: values.used,
    remaining: values.remaining,
    percentUsed: values.percentUsed,
    percentRemaining: values.percentRemaining,
  };
}

/** The all-null sample of a §12.2 gap marker — the line break, nothing else. */
const NULL_SAMPLE_FIELDS = {
  used: null,
  remaining: null,
  percentUsed: null,
  percentRemaining: null,
} as const;

/**
 * Flattens the wire entries into samples, preserving wire order (D-139
 * serves the series chronological). Buckets contribute their `first` and
 * `last` endpoints — a one-member bucket's endpoints coincide and
 * contribute one sample.
 */
export function chartSamplesOf(points: readonly HistoryPointItem[]): ChartSample[] {
  const samples: ChartSample[] = [];
  for (const entry of points) {
    if (entry.kind === 'point') {
      samples.push(sampleOf(entry.collectedAt, entry));
    } else if (entry.kind === 'bucket') {
      samples.push(sampleOf(entry.fromEpochMs, entry.first));
      if (entry.last.collectedAt !== entry.first.collectedAt) {
        samples.push(sampleOf(entry.toEpochMs, entry.last));
      }
    } else {
      samples.push({ at: entry.collectedAt, ...NULL_SAMPLE_FIELDS });
    }
  }
  return samples;
}

/** Which views the data carries — a view exists only where values do. */
export interface ViewAvailability {
  readonly absolute: boolean;
  readonly percent: boolean;
}

/**
 * Scans the samples for each family's fields: the absolute view needs a
 * `used`/`remaining` value somewhere, the percent view a percentage. The
 * §14.4 toggle renders only when both are true — a percentage-only metric
 * never grows an absolute axis, an absolute-only metric stays absolute.
 */
export function seriesAvailability(samples: readonly ChartSample[]): ViewAvailability {
  let absolute = false;
  let percent = false;
  for (const sample of samples) {
    if (sample.used !== null || sample.remaining !== null) absolute = true;
    if (sample.percentUsed !== null || sample.percentRemaining !== null) percent = true;
  }
  return { absolute, percent };
}

/**
 * The view that renders: the requested one when its data exists, else the
 * available one. An empty series answers `absolute` (nothing renders, and
 * the empty state owns the card).
 */
export function resolveViewMode(
  requested: ChartViewMode,
  availability: ViewAvailability,
): ChartViewMode {
  if (requested === 'percent' && availability.percent) return 'percent';
  if (requested === 'absolute' && availability.absolute) return 'absolute';
  return availability.percent ? 'percent' : 'absolute';
}

/* ── The D-147 residual: the truncation sliver ─────────────────────────── */

/**
 * The sub-tolerance clamp that is clock skew, not truncation: the server
 * anchors the retention horizon to its own clock while the client's `from`
 * anchors to the browser's (D-147's recorded residual). One minute is far
 * above disciplined-clock skew and far below anything visible on any §14.4
 * window (24 h at the smallest).
 */
export const TRUNCATION_NOTICE_MS = 60_000;

/** What the chart surface should say about a range report. */
export type RangeNoticeKind = 'none' | 'truncated' | 'rejected';

/**
 * Classifies the response's range report for presentation: `ok` and
 * sliver-truncated windows stay quiet; a real truncation surfaces its
 * notice; a rejected range (entirely before the retention horizon — a
 * server clock far ahead of the browser's) states that fact instead of an
 * empty chart.
 */
export function rangeNoticeOf(report: HistoryRangeReport): RangeNoticeKind {
  if (report.outcome === 'ok') return 'none';
  if (report.outcome === 'rejected') return 'rejected';
  // A truncated report carries its effective bounds (D-139's contract);
  // the schema-total `??` maps a malformed pair onto "nothing clamped".
  const clampedMs = (report.effectiveFrom ?? report.requestedFrom) - report.requestedFrom;
  return clampedMs > TRUNCATION_NOTICE_MS ? 'truncated' : 'none';
}

/* ── The option builder ────────────────────────────────────────────────── */

/** One `[epochMs, value | null]` data point of a line series. */
export type ChartSeriesDatum = readonly [number, number | null];

/** The axis-trigger tooltip parameters the formatter consumes. */
export interface ChartTooltipParam {
  readonly seriesName: string;
  readonly value: ChartSeriesDatum;
  /** The shared x value (epoch ms) the tooltip anchors on. */
  readonly axisValue: number;
}

/** One line series (a subset of ECharts' series option). */
export interface ChartSeriesOption {
  readonly type: 'line';
  readonly name: string;
  readonly data: readonly ChartSeriesDatum[];
  readonly connectNulls: boolean;
  readonly lineStyle: {
    readonly color: string;
    readonly width: number;
    readonly type: 'solid' | 'dashed';
  };
  readonly itemStyle: { readonly color: string };
  readonly symbol: 'circle';
  readonly showSymbol: boolean;
}

/** The metric chart's ECharts option (the structural subset the builder emits). */
export interface MetricChartOption {
  readonly animation: boolean;
  readonly textStyle: { readonly fontFamily: string };
  readonly grid: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly containLabel: boolean;
  };
  readonly legend: {
    readonly show: boolean;
    readonly data: readonly string[];
    readonly textStyle: { readonly color: string };
  };
  readonly tooltip: {
    readonly trigger: 'axis';
    readonly renderMode: 'richText';
    readonly backgroundColor: string;
    readonly borderColor: string;
    readonly textStyle: { readonly color: string };
    readonly formatter: (params: readonly ChartTooltipParam[]) => string;
  };
  readonly xAxis: {
    readonly type: 'value';
    readonly min: number;
    readonly max: number;
    readonly axisLabel: {
      readonly color: string;
      readonly formatter: (value: number) => string;
    };
    readonly axisLine: { readonly lineStyle: { readonly color: string } };
    readonly splitLine: { readonly show: false };
  };
  readonly yAxis: {
    readonly type: 'value';
    readonly name: string;
    readonly nameTextStyle: { readonly color: string };
    readonly min?: number;
    readonly max?: number;
    readonly axisLabel: { readonly color: string; readonly formatter: (value: number) => string };
    readonly splitLine: { readonly lineStyle: { readonly color: string } };
  };
  readonly series: readonly ChartSeriesOption[];
}

/** The builder's inputs — one mode, one unit, one window (see the header). */
export interface MetricChartOptionInput {
  readonly samples: readonly ChartSample[];
  readonly mode: ChartViewMode;
  /** The catalog word for the metric's §8.4 unit (e.g. "credits"). */
  readonly unitLabel: string;
  readonly tokens: ChartTokens;
  readonly text: { readonly used: string; readonly remaining: string };
  /** The configured display time zone (§14.1) for dates. */
  readonly timeZone: string;
  /** The x window: the range report's requested bounds (shared per page). */
  readonly window: { readonly from: number; readonly to: number };
}

/** The series' density under which point symbols render (sparse series need them). */
const SYMBOL_DENSITY_LIMIT = 80;

function seriesData(
  samples: readonly ChartSample[],
  pick: (sample: ChartSample) => number | null,
): ChartSeriesDatum[] {
  return samples.map((sample): ChartSeriesDatum => [sample.at, pick(sample)]);
}

/**
 * Builds the whole option. The two series differ by MORE than color
 * (§14.1: never color alone) — the legend names them in text and the
 * remaining series draws dashed beside the used series' solid line.
 */
export function buildMetricChartOption(input: MetricChartOptionInput): MetricChartOption {
  const { samples, mode, tokens, text, timeZone, unitLabel } = input;
  const percent = mode === 'percent';
  const unitSuffix = percent ? '%' : ` ${unitLabel}`;
  // One field family per mode — the unit segregation starts here: the
  // percent view never touches the absolute fields and vice versa.
  const pickUsed = percent
    ? (sample: ChartSample) => sample.percentUsed
    : (sample: ChartSample) => sample.used;
  const pickRemaining = percent
    ? (sample: ChartSample) => sample.percentRemaining
    : (sample: ChartSample) => sample.remaining;

  const tooltipFormatter = (params: readonly ChartTooltipParam[]): string => {
    const first = params[0];
    if (first === undefined) return '';
    const header = formatChartDate(first.axisValue, timeZone);
    const lines: string[] = [];
    for (const param of params) {
      const value = param.value[1];
      if (value === null) continue; // a gap sample: no invented value
      lines.push(`${param.seriesName}: ${formatQuotaNumber(value)}${unitSuffix}`);
    }
    return lines.length === 0 ? header : `${header}\n${lines.join('\n')}`;
  };

  return {
    // Deterministic rendering: no animation state to race in tests or e2e.
    animation: false,
    textStyle: { fontFamily: tokens.fontFamily },
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
    legend: {
      show: true,
      data: [text.used, text.remaining],
      textStyle: { color: tokens.axisLabel },
    },
    tooltip: {
      // D-127: richText renders on the canvas — no HTML tooltip DOM, no
      // `style=` attributes the CSP would block.
      trigger: 'axis',
      renderMode: 'richText',
      backgroundColor: tokens.tooltipBackground,
      borderColor: tokens.tooltipBorder,
      textStyle: { color: tokens.tooltipText },
      formatter: tooltipFormatter,
    },
    xAxis: {
      type: 'value',
      min: input.window.from,
      max: input.window.to,
      axisLabel: {
        color: tokens.axisLabel,
        formatter: (value: number) => formatChartDate(value, timeZone),
      },
      axisLine: { lineStyle: { color: tokens.splitLine } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: percent ? '%' : unitLabel,
      nameTextStyle: { color: tokens.axisLabel },
      // Percentages are bounded by definition (§8.4); the absolute axis
      // keeps ECharts' zero-inclusive default — quota amounts from zero.
      ...(percent ? { min: 0, max: 100 } : {}),
      axisLabel: { color: tokens.axisLabel, formatter: formatQuotaNumber },
      splitLine: { lineStyle: { color: tokens.splitLine } },
    },
    series: [
      {
        type: 'line',
        name: text.used,
        data: seriesData(samples, pickUsed),
        connectNulls: false,
        lineStyle: { color: tokens.used, width: 2, type: 'solid' },
        itemStyle: { color: tokens.used },
        symbol: 'circle',
        showSymbol: samples.length <= SYMBOL_DENSITY_LIMIT,
      },
      {
        type: 'line',
        name: text.remaining,
        data: seriesData(samples, pickRemaining),
        connectNulls: false,
        lineStyle: { color: tokens.remaining, width: 2, type: 'dashed' },
        itemStyle: { color: tokens.remaining },
        symbol: 'circle',
        showSymbol: samples.length <= SYMBOL_DENSITY_LIMIT,
      },
    ],
  };
}
