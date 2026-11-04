/**
 * The §14.4 metric-chart data adapter and option builder (task 175, spec
 * §13, §14.4; decision D-148; extended by task 176, decision D-149) — pure
 * functions from the D-139 history wire kinds and the D-139/D-142
 * annotation sources onto an ECharts option value object.
 *
 * Pinned interpretations:
 *
 * - **One unit per value axis, by construction.** The builder takes exactly
 *   one view mode (`absolute` / `percent`) and one unit label and emits its
 *   MAIN y-axis with two series — there is no input shape that could mix
 *   units (the task-175 done-condition). Percentage-only metrics resolve to
 *   the percent view and never gain an absolute axis (§14.4: "do not use
 *   separate axes for incompatible units … do not infer token counts").
 * - **Wire kinds.** `point` entries map to samples verbatim (invalid rows
 *   arrive value-null per §8.4 — nulls stay null, never zero); `empty`
 *   entries (§12.2's gap markers) map to all-null samples that break the
 *   line (`connectNulls: false`); `bucket` entries (D-081/D-139
 *   downsampling — the common case) render as their `first` and `last`
 *   endpoints — real observed points by reference, no invented values.
 * - **The numeric epoch-ms axis.** §14.4: ECharts' time axis is local or
 *   UTC only, so the x-axis is a `value` axis over epoch milliseconds with
 *   `Intl.DateTimeFormat` labels in the configured display zone. Tick
 *   PLACEMENT is task 177's (D-150): the instants come from the pure
 *   `./ticks` engine — local hour/day/month boundaries in the display zone,
 *   DST-transition days included — delivered through ECharts'
 *   `customValues` on BOTH the main and the strip x-axis; the window
 *   bounds come from the range report's REQUESTED bounds, which every
 *   per-metric chart of one page load shares — so the charts' axes align
 *   even where retention truncated the data.
 * - **The task-176 annotations (D-149).** Reset instants render as vertical
 *   labeled markLines on the used series; peak/off-peak/gap/stopped spans
 *   render as rect bands of ONE custom series (the only ECharts primitive
 *   whose `decal` hatching actually renders — marker components never pass
 *   through the decal visual stage, verified against the 6.1.0 source);
 *   failed cycles render as a scatter series on a lower strip grid with a
 *   distinct symbol per §11.2 outcome. All bands/markers are `silent` and
 *   ALL tooltips flow through the one axis-trigger richText formatter,
 *   which states — for the hovered instant — the values, the covering
 *   schedule band (§14.4: name, times in BOTH zones, multiplier), the
 *   covering gap/stopped region, and the resets inside the snapped sample
 *   interval: per-element item tooltips race the axis channel (the axis
 *   flow replaces them on every move), so the single channel is the robust
 *   one under the canvas+richText CSP constraint (D-127/D-148).
 * - **Never color alone (§14.1).** The two lines differ by legend text and
 *   solid/dashed style (175); the bands differ by fill presence, border
 *   style, and hatch direction; the reset markers carry an on-line "Reset"
 *   label; the error markers differ by symbol shape and join the legend by
 *   name.
 * - **The D-147 residual.** A `truncated` range report whose clamp is a
 *   sub-tolerance sliver is NOT surfaced as a truncation —
 *   {@link TRUNCATION_NOTICE_MS} thresholds it.
 */

import type {
  HistoryPoint,
  HistoryPointItem,
  HistoryRangeReport,
} from '../../../src/schemas/api/history';
import type { AccountErrorOutcome } from '../../../src/schemas/api/status';
import { formatChartDate, formatChartDuration, formatQuotaNumber } from '../format';
import {
  errorSymbolOf,
  type ChartWindow,
  type ErrorMark,
  type GapMark,
  type MetricAnnotations,
  type PeakBand,
  type ResetMark,
  type StoppedMark,
} from './annotations';
import { chartTicks } from './ticks';
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
  /** The hovered data item — the strip's markers carry their tooltip lines. */
  readonly data?: { readonly tooltipLines?: readonly string[] };
}

/** One vertical §14.4 reset markLine (the structural subset emitted). */
export interface ChartMarkLineOption {
  readonly silent: boolean;
  readonly symbol: readonly ['none', 'none'];
  readonly lineStyle: { readonly color: string; readonly width: number; readonly type: 'dashed' };
  readonly label: {
    readonly show: boolean;
    readonly formatter: string;
    readonly position: 'insideEndTop';
    readonly color: string;
  };
  readonly data: readonly { readonly xAxis: number }[];
}

/** One line series (a subset of ECharts' series option). */
export interface ChartSeriesOption {
  readonly type: 'line';
  readonly name: string;
  readonly xAxisIndex: number;
  readonly yAxisIndex: number;
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
  readonly markLine?: ChartMarkLineOption;
}

/** One hatch pattern of a band (the structural subset of ECharts' decal). */
export interface ChartBandDecal {
  readonly color: string;
  readonly dashArrayX: readonly number[];
  readonly dashArrayY: readonly number[];
  readonly rotation: number;
}

/** One band rect's data item: the span, its style, and its on-band label. */
export interface ChartBandDatum {
  readonly value: readonly [number, number];
  readonly itemStyle: {
    readonly color: string;
    readonly fillOpacity: number;
    readonly borderColor: string;
    readonly borderWidth: number;
    readonly lineDash: readonly number[] | null;
    readonly decal: ChartBandDecal | null;
  };
  readonly label: string | null;
}

/** The custom-series `renderItem` seam — stubbed in unit tests. */
export interface ChartBandRenderApi {
  coord(point: readonly [number, number]): [number, number];
}

/** The structural subset of the render-item params the bands consume. */
export interface ChartBandRenderParams {
  readonly dataIndex: number;
}

/** One rendered band element (a zrender rect's structural subset). */
export interface ChartBandElement {
  readonly type: 'rect';
  readonly shape: { x: number; y: number; width: number; height: number };
  readonly style: {
    readonly fill: string;
    readonly fillOpacity: number;
    readonly stroke: string;
    readonly lineWidth: number;
    readonly lineDash?: readonly number[];
    readonly decal?: ChartBandDecal;
    readonly text?: string;
    readonly textFill?: string;
  };
}

export type ChartBandRenderItem = (
  params: ChartBandRenderParams,
  api: ChartBandRenderApi,
) => ChartBandElement | null;

/** The bands series (a subset of ECharts' custom series option). */
export interface ChartBandSeriesOption {
  readonly type: 'custom';
  readonly id: 'qm-chart-bands';
  readonly name: string;
  readonly xAxisIndex: number;
  readonly yAxisIndex: number;
  readonly silent: boolean;
  /**
   * Excludes the series from the axis tooltip's collection: `silent`
   * only disables pointer events, while a band's epoch-ms span datum
   * would otherwise join (and, at band edges, REPLACE) the line series'
   * quota params — `collectSeriesInfo` skips exactly this shape
   * (verified against the 6.1.0 source; the review round's P1).
   */
  readonly tooltip: { readonly show: false };
  readonly z: number;
  readonly clip: boolean;
  readonly renderItem: ChartBandRenderItem;
  readonly data: readonly ChartBandDatum[];
}

/** One failed-cycle marker of the strip: the instant, shape, and tooltip. */
export interface ChartErrorDatum {
  readonly value: readonly [number, number];
  readonly symbol: string;
  readonly tooltipLines: readonly string[];
}

/** The strip's marker series (a subset of ECharts' scatter option). */
export interface ChartErrorSeriesOption {
  readonly type: 'scatter';
  readonly id: 'qm-chart-errors';
  readonly name: string;
  readonly xAxisIndex: number;
  readonly yAxisIndex: number;
  readonly z: number;
  readonly symbolSize: number;
  readonly itemStyle: { readonly color: string };
  readonly data: readonly ChartErrorDatum[];
}

/** One x-axis of the chart (the main plot, or the strip). */
export interface ChartXAxisOption {
  readonly type: 'value';
  /** Which grid the axis belongs to — the strip's pair carries `1`. */
  readonly gridIndex?: number;
  readonly min: number;
  readonly max: number;
  readonly name?: string;
  readonly axisLabel: {
    readonly show?: boolean;
    readonly color: string;
    readonly formatter: (value: number) => string;
    /** The task-177 tick instants — ECharts renders exactly these (D-150). */
    readonly customValues?: readonly number[];
  };
  /**
   * The tick marks, aligned to the same instants as the labels — without
   * this the marks would stay on ECharts' own uniform ladder while the
   * labels moved to the local boundaries.
   */
  readonly axisTick?: { readonly customValues: readonly number[] };
  readonly axisLine: { readonly lineStyle: { readonly color: string } };
  readonly splitLine: { readonly show: false };
}

/** One y-axis of the chart (the value axis, or a hidden band/strip axis). */
export interface ChartYAxisOption {
  readonly type: 'value';
  /** Which grid the axis belongs to — the strip's pair carries `1`. */
  readonly gridIndex?: number;
  readonly name: string;
  readonly nameTextStyle: { readonly color: string };
  readonly show?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly axisLabel: {
    readonly color: string;
    readonly formatter: (value: number) => string;
    readonly margin?: number;
    readonly width?: number;
    readonly overflow?: 'truncate' | 'break' | 'breakAll';
  };
  readonly splitLine?: { readonly lineStyle: { readonly color: string } };
}

/** The metric chart's ECharts option (the structural subset the builder emits). */
export interface MetricChartOption {
  readonly animation: boolean;
  readonly textStyle: { readonly fontFamily: string };
  readonly grid: readonly {
    readonly left: number;
    readonly right: number;
    readonly top?: number;
    readonly bottom: number;
    readonly height?: number;
  }[];
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
  readonly xAxis: readonly ChartXAxisOption[];
  readonly yAxis: readonly ChartYAxisOption[];
  readonly series: readonly (ChartSeriesOption | ChartBandSeriesOption | ChartErrorSeriesOption)[];
}

/**
 * The catalog word templates and vocabulary fragments the builder composes
 * (the component passes the `en` catalog values; the builder interpolates
 * `{param}` placeholders exactly like vue-i18n so the templates stay
 * translator-shaped).
 */
export interface MetricChartText {
  readonly used: string;
  readonly remaining: string;
  readonly peakHead: string;
  readonly offPeakHead: string;
  readonly bandTimes: string;
  readonly gapHead: string;
  readonly gapBody: string;
  readonly stoppedHead: string;
  readonly stoppedBody: string;
  readonly stoppedLabel: string;
  readonly resetTooltip: string;
  readonly resetLabel: string;
  readonly bandsSeries: string;
  readonly errorsSeries: string;
  readonly errorAttempts: string;
  readonly errorStatus: string;
  readonly errorRetryAfter: string;
  readonly errorOutcomes: Readonly<Record<AccountErrorOutcome, string>>;
}

/** The builder's inputs — one mode, one unit, one window, the annotations. */
export interface MetricChartOptionInput {
  readonly samples: readonly ChartSample[];
  readonly mode: ChartViewMode;
  /** The catalog word for the metric's §8.4 unit (e.g. "credits"). */
  readonly unitLabel: string;
  readonly tokens: ChartTokens;
  readonly text: MetricChartText;
  /** The configured display time zone (§14.1) for dates. */
  readonly timeZone: string;
  /** The x window: the range report's requested bounds (shared per page). */
  readonly window: ChartWindow;
  /**
   * The chart canvas's width in CSS pixels — the tick density input (the
   * component measures its host; §14.1's 360 px viewport is the floor for
   * an unmeasured mount).
   */
  readonly widthPx: number;
  /** The §12.2 events mapped onto this metric (task 176; default: none). */
  readonly annotations?: MetricAnnotations;
  /** The §9.3 peak bands and the schedule zone name (task 176; default: none). */
  readonly peak?: {
    readonly bands: readonly PeakBand[];
    readonly scheduleZone: string | null;
  };
}

/** The series' density under which point symbols render (sparse series need them). */
const SYMBOL_DENSITY_LIMIT = 80;

/* ── Geometry constants (the two grids must align deterministically) ───── */

/**
 * The fixed left inset of every grid: without `containLabel` the main and
 * strip grids share their plot x-range by construction, and the y-axis
 * labels truncate inside the margin instead of shifting the plot.
 */
const AXIS_LEFT = 60;
const AXIS_RIGHT = 16;
/** The main plot's top inset (the legend row above). */
const MAIN_TOP = 32;
/** The bottom band: the x-axis date labels' height. */
const LABEL_HEIGHT = 28;
/** The strip grid's plot height. */
const STRIP_HEIGHT = 28;
/** The gap between the main plot and the strip. */
const STRIP_GAP = 6;

/**
 * The canvas width assumed before the host is measured (§14.1's minimum
 * viewport): the honest worst case for tick density — a wider measurement
 * replaces it on the first resize callback.
 */
export const DEFAULT_CHART_WIDTH_PX = 360;

/**
 * The plot width a canvas measurement leaves for the x-axis — the one
 * geometry source for the builder's density choice and the component's
 * resize gate (they must agree on the floor and the insets).
 */
export function chartPlotWidthOf(widthPx: number): number {
  const canvas = widthPx > 0 ? widthPx : DEFAULT_CHART_WIDTH_PX;
  return Math.max(canvas - AXIS_LEFT - AXIS_RIGHT, 1);
}

/** The width under which a band's on-band label would be unreadable. */
const BAND_LABEL_MIN_WIDTH = 64;

/** Fills one catalog template's `{param}` placeholders. */
function fill(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => String(params[key]));
}

/* ── Band composition (§14.4 peak/gap/stopped areas) ──────────────────── */

/** One band with its presentation style and tooltip lines — builder-internal. */
interface StyledBand {
  readonly from: number;
  readonly to: number;
  readonly style: ChartBandDatum['itemStyle'];
  readonly label: string | null;
  readonly tooltipLines: readonly string[];
}

function bandTimesLines(
  from: number,
  to: number,
  localStart: string,
  localEnd: string,
  scheduleZone: string | null,
  timeZone: string,
  text: MetricChartText,
): readonly string[] {
  const lines = [
    fill(text.bandTimes, {
      start: formatChartDate(from, timeZone),
      end: formatChartDate(to, timeZone),
      zone: timeZone,
    }),
  ];
  if (scheduleZone !== null) {
    lines.push(fill(text.bandTimes, { start: localStart, end: localEnd, zone: scheduleZone }));
  }
  return lines;
}

function peakBands(
  bands: readonly PeakBand[],
  scheduleZone: string | null,
  timeZone: string,
  tokens: ChartTokens,
  text: MetricChartText,
): StyledBand[] {
  return bands.map((band): StyledBand => {
    const head =
      band.kind === 'peak'
        ? fill(text.peakHead, {
            name: band.name ?? '',
            multiplier: formatQuotaNumber(band.multiplier),
          })
        : fill(text.offPeakHead, { multiplier: formatQuotaNumber(band.multiplier) });
    return {
      from: band.from,
      to: band.to,
      // Peak windows tint solid; the off-peak complement stays unfilled
      // with a dashed border — fill presence and border style carry the
      // distinction with color off the table (§14.1). The tint is
      // `fillOpacity`, NOT element opacity: zrender's element-level
      // opacity fades the border (and any decal) together with the fill.
      style: {
        color: band.kind === 'peak' ? tokens.peak : 'transparent',
        fillOpacity: band.kind === 'peak' ? 0.12 : 1,
        borderColor: band.kind === 'peak' ? tokens.peak : tokens.axisLabel,
        borderWidth: 1,
        lineDash: band.kind === 'peak' ? null : [4, 3],
        decal: null,
      },
      label: null,
      tooltipLines: [
        head,
        // The SERVED bounds render in both zones — a window-clamped edge
        // would disagree with the schedule zone's verbatim local times.
        ...bandTimesLines(
          band.start,
          band.end,
          band.localStart,
          band.localEnd,
          scheduleZone,
          timeZone,
          text,
        ),
      ],
    };
  });
}

function gapBands(
  gaps: readonly GapMark[],
  tokens: ChartTokens,
  text: MetricChartText,
): StyledBand[] {
  return gaps.map((gap): StyledBand => {
    return {
      from: gap.from,
      to: gap.to,
      // §14.4: a gap is the line break (175's empty point) AND a hatched
      // region — a 45° hatch, dashed border, transparent fill.
      style: {
        color: 'transparent',
        fillOpacity: 1,
        borderColor: tokens.gap,
        borderWidth: 1,
        lineDash: [4, 3],
        decal: {
          color: tokens.gap,
          dashArrayX: [1, 3],
          dashArrayY: [1, 3],
          rotation: Math.PI / 4,
        },
      },
      label: null,
      tooltipLines: [
        text.gapHead,
        fill(text.gapBody, { duration: formatChartDuration(gap.elapsedMs) }),
      ],
    };
  });
}

function stoppedBands(
  stopped: readonly StoppedMark[],
  tokens: ChartTokens,
  text: MetricChartText,
): StyledBand[] {
  return stopped.map((region): StyledBand => {
    return {
      from: region.from,
      to: region.to,
      // §12.2: the stopped period is a hatched area indicating the service
      // was stopped — the counter-angle hatch and solid border distinguish
      // it from a gap beyond color, and the band carries its label text.
      // The tint is fillOpacity only, so the hatch and border stay full.
      style: {
        color: tokens.stopped,
        fillOpacity: 0.08,
        borderColor: tokens.stopped,
        borderWidth: 1,
        lineDash: null,
        decal: {
          color: tokens.stopped,
          dashArrayX: [1, 3],
          dashArrayY: [1, 3],
          rotation: -Math.PI / 4,
        },
      },
      label: text.stoppedLabel,
      tooltipLines: [
        text.stoppedHead,
        fill(text.stoppedBody, { duration: formatChartDuration(region.elapsedMs) }),
      ],
    };
  });
}

/**
 * The custom series' `renderItem`: one full-height rect per band, styled
 * from the data item, with the stopped label rendered on the band when it
 * is wide enough to hold it. Pure — the api seam is stubbed in unit tests.
 */
export function bandRenderItem(bands: readonly StyledBand[]): ChartBandRenderItem {
  return (params, api) => {
    const band = bands[params.dataIndex];
    if (band === undefined) return null;
    const bottom = api.coord([band.from, 0]);
    const top = api.coord([band.to, 1]);
    const width = top[0] - bottom[0];
    const height = bottom[1] - top[1];
    if (width <= 0 || height <= 0) return null;
    const style: ChartBandElement['style'] = {
      fill: band.style.color,
      fillOpacity: band.style.fillOpacity,
      stroke: band.style.borderColor,
      lineWidth: band.style.borderWidth,
      ...(band.style.lineDash === null ? {} : { lineDash: band.style.lineDash }),
      ...(band.style.decal === null ? {} : { decal: band.style.decal }),
    };
    if (band.label !== null && width >= BAND_LABEL_MIN_WIDTH) {
      return {
        type: 'rect',
        shape: { x: bottom[0], y: top[1], width, height },
        style: { ...style, text: band.label, textFill: band.style.borderColor },
      };
    }
    return { type: 'rect', shape: { x: bottom[0], y: top[1], width, height }, style };
  };
}

/* ── The strip's error markers (§12.2's lower timeline) ────────────────── */

function errorTooltipLines(
  error: ErrorMark,
  timeZone: string,
  text: MetricChartText,
): readonly string[] {
  const meta: string[] = [fill(text.errorAttempts, { count: error.attempts })];
  if (error.httpStatus !== null) {
    meta.push(fill(text.errorStatus, { status: error.httpStatus }));
  }
  if (error.retryAfterSeconds !== null) {
    meta.push(fill(text.errorRetryAfter, { seconds: error.retryAfterSeconds }));
  }
  const lines = [
    formatChartDate(error.at, timeZone),
    text.errorOutcomes[error.outcome],
    meta.join(' · '),
  ];
  if (error.message !== '') lines.push(error.message);
  return lines;
}

/* ── The tooltip formatter (the single hover channel, D-149) ───────────── */

/** The index of the first sample at or after `at` (samples chronological). */
function sampleIndexAt(samples: readonly ChartSample[], at: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (samples[mid]!.at < at) low = mid + 1;
    else high = mid;
  }
  return low;
}

/* ── The builder ───────────────────────────────────────────────────────── */

function seriesData(
  samples: readonly ChartSample[],
  pick: (sample: ChartSample) => number | null,
): ChartSeriesDatum[] {
  return samples.map((sample): ChartSeriesDatum => [sample.at, pick(sample)]);
}

/**
 * Builds the whole option. The two series differ by MORE than color
 * (§14.1: never color alone) — the legend names them in text and the
 * remaining series draws dashed beside the used series' solid line; the
 * annotations follow the same rule (the header's task-176 paragraph).
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

  const annotations = input.annotations ?? {
    resets: [],
    gaps: [],
    stopped: [],
    errors: [],
  };
  const peak = input.peak ?? { bands: [], scheduleZone: null };

  const bands: StyledBand[] = [
    ...peakBands(peak.bands, peak.scheduleZone, timeZone, tokens, text),
    ...gapBands(annotations.gaps, tokens, text),
    ...stoppedBands(annotations.stopped, tokens, text),
  ];
  const hasBands = bands.length > 0;
  const hasStrip = annotations.errors.length > 0;

  // The axes: the main pair always first; the bands' hidden 0..1 axis and
  // the strip's pair join in that order when their content exists.
  const bandsAxisIndex = 1;
  const stripAxisBase = hasBands ? 2 : 1;
  const stripXAxisIndex = 1;
  const stripYAxisIndex = stripAxisBase;

  const dateLabel = (value: number): string => formatChartDate(value, timeZone);

  // The task-177 ticks (D-150): local hour/day/month boundary instants in
  // the display zone at a density the measured canvas carries. Both x-axes
  // share the SAME instants — D-149's fixed insets keep the grids aligned,
  // the shared customValues keep the axes' labels aligned with them.
  const ticks = chartTicks(input.window, timeZone, chartPlotWidthOf(input.widthPx));
  const tickValues = ticks.map((tick) => tick.at);
  const tickLabels = new Map(ticks.map((tick) => [tick.at, tick.label] as const));
  const tickLabel = (value: number): string =>
    // The map holds every customValue this option renders; the fallback
    // covers a re-format racing an option swap (ECharts may format the
    // outgoing ticks once more mid-transition) — a full date, never blank.
    tickLabels.get(value) ?? dateLabel(value);

  const tooltipFormatter = (params: readonly ChartTooltipParam[]): string => {
    const first = params[0];
    if (first === undefined) return '';
    // The strip's markers carry their prebuilt lines on the datum — the
    // outcome vocabulary belongs to the marker, not the x position.
    if (first.seriesName === text.errorsSeries) {
      const lines = first.data?.tooltipLines ?? [];
      return lines.length === 0 ? '' : lines.join('\n');
    }
    const x = first.axisValue;
    const lines: string[] = [];
    for (const param of params) {
      // Only the two line series carry quota values: `silent` does NOT
      // keep the bands series out of the axis tooltip's collection, and
      // its datum value is an epoch-ms span — never a quota number.
      if (param.seriesName !== text.used && param.seriesName !== text.remaining) {
        continue;
      }
      const value = param.value[1];
      if (value === null) continue; // a gap sample: no invented value
      lines.push(`${param.seriesName}: ${formatQuotaNumber(value)}${unitSuffix}`);
    }
    // The bands covering the hovered instant state their facts (§14.4's
    // peak tooltip: name, both-zone times, multiplier).
    for (const band of bands) {
      if (band.from <= x && x < band.to) lines.push(...band.tooltipLines);
    }
    // A reset is an instant between samples: it belongs to the tooltip of
    // the sample interval that contains it — (previous, snapped].
    const index = sampleIndexAt(samples, x);
    const intervalStart = index === 0 ? Number.NEGATIVE_INFINITY : samples[index - 1]!.at;
    const intervalEnd = index === samples.length ? Number.POSITIVE_INFINITY : samples[index]!.at;
    for (const reset of annotations.resets) {
      if (reset.at > intervalStart && reset.at <= intervalEnd) {
        lines.push(fill(text.resetTooltip, { time: formatChartDate(reset.at, timeZone) }));
      }
    }
    return lines.length === 0 ? dateLabel(x) : `${dateLabel(x)}\n${lines.join('\n')}`;
  };

  const yAxis: ChartYAxisOption[] = [
    {
      type: 'value',
      name: percent ? '%' : unitLabel,
      nameTextStyle: { color: tokens.axisLabel },
      // Percentages are bounded by definition (§8.4); the absolute axis
      // keeps ECharts' zero-inclusive default — quota amounts from zero.
      ...(percent ? { min: 0, max: 100 } : {}),
      axisLabel: {
        color: tokens.axisLabel,
        formatter: formatQuotaNumber,
        // The fixed left inset (no `containLabel`) is what keeps both
        // grids aligned; wide quota labels truncate inside the margin
        // instead of shifting the plot — the tooltip always states the
        // exact value.
        margin: 6,
        width: AXIS_LEFT - 16,
        overflow: 'truncate',
      },
      splitLine: { lineStyle: { color: tokens.splitLine } },
    },
    ...(hasBands
      ? [
          {
            type: 'value',
            name: '',
            nameTextStyle: { color: tokens.axisLabel },
            show: false,
            min: 0,
            max: 1,
            axisLabel: { color: tokens.axisLabel, formatter: formatQuotaNumber },
          } satisfies ChartYAxisOption,
        ]
      : []),
    ...(hasStrip
      ? [
          {
            type: 'value',
            // The strip's own grid — without the explicit binding every
            // axis would attach to grid 0 and the strip would render
            // inside the main plot.
            gridIndex: 1,
            name: '',
            nameTextStyle: { color: tokens.axisLabel },
            show: false,
            min: 0,
            max: 1,
            axisLabel: { color: tokens.axisLabel, formatter: formatQuotaNumber },
          } satisfies ChartYAxisOption,
        ]
      : []),
  ];

  const xAxis: ChartXAxisOption[] = [
    {
      type: 'value',
      min: input.window.from,
      max: input.window.to,
      // With the strip present its x-axis carries the date labels — a
      // stacked pair of label rows would double the same axis.
      axisLabel: hasStrip
        ? { show: false, color: tokens.axisLabel, formatter: tickLabel, customValues: tickValues }
        : { color: tokens.axisLabel, formatter: tickLabel, customValues: tickValues },
      axisTick: { customValues: tickValues },
      axisLine: { lineStyle: { color: tokens.splitLine } },
      splitLine: { show: false },
    },
    ...(hasStrip
      ? [
          {
            type: 'value',
            // The strip's own grid (see the strip y-axis above).
            gridIndex: 1,
            min: input.window.from,
            max: input.window.to,
            name: text.errorsSeries,
            axisLabel: { color: tokens.axisLabel, formatter: tickLabel, customValues: tickValues },
            axisTick: { customValues: tickValues },
            axisLine: { lineStyle: { color: tokens.splitLine } },
            splitLine: { show: false },
          } satisfies ChartXAxisOption,
        ]
      : []),
  ];

  const legendData = hasStrip
    ? [text.used, text.remaining, text.errorsSeries]
    : [text.used, text.remaining];

  const series: (ChartSeriesOption | ChartBandSeriesOption | ChartErrorSeriesOption)[] = [
    {
      type: 'line',
      name: text.used,
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: seriesData(samples, pickUsed),
      connectNulls: false,
      lineStyle: { color: tokens.used, width: 2, type: 'solid' },
      itemStyle: { color: tokens.used },
      symbol: 'circle',
      showSymbol: samples.length <= SYMBOL_DENSITY_LIMIT,
      // §14.4's vertical labeled reset markers — on the used series, one
      // per reset instant of THIS metric.
      ...(annotations.resets.length === 0
        ? {}
        : {
            markLine: {
              silent: true,
              symbol: ['none', 'none'],
              lineStyle: { color: tokens.reset, width: 1, type: 'dashed' },
              label: {
                show: true,
                formatter: text.resetLabel,
                position: 'insideEndTop',
                color: tokens.axisLabel,
              },
              data: annotations.resets.map((reset: ResetMark) => ({ xAxis: reset.at })),
            } satisfies ChartMarkLineOption,
          }),
    },
    {
      type: 'line',
      name: text.remaining,
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: seriesData(samples, pickRemaining),
      connectNulls: false,
      lineStyle: { color: tokens.remaining, width: 2, type: 'dashed' },
      itemStyle: { color: tokens.remaining },
      symbol: 'circle',
      showSymbol: samples.length <= SYMBOL_DENSITY_LIMIT,
    },
  ];
  if (hasBands) {
    series.push({
      type: 'custom',
      id: 'qm-chart-bands',
      name: text.bandsSeries,
      xAxisIndex: 0,
      yAxisIndex: bandsAxisIndex,
      // Bands never intercept the pointer: their facts ride the axis
      // tooltip at the hovered instant (the single channel, D-149). And
      // the series stays OUT of the tooltip's collection: `silent` alone
      // leaves it collectable, and a band's span datum would render (or
      // replace) quota values — `tooltip.show: false` is the exclusion
      // `collectSeriesInfo` honors.
      silent: true,
      tooltip: { show: false },
      z: 0,
      clip: true,
      renderItem: bandRenderItem(bands),
      data: bands.map((band): ChartBandDatum => ({
        value: [band.from, band.to],
        itemStyle: band.style,
        label: band.label,
      })),
    });
  }
  if (hasStrip) {
    series.push({
      type: 'scatter',
      id: 'qm-chart-errors',
      name: text.errorsSeries,
      xAxisIndex: stripXAxisIndex,
      yAxisIndex: stripYAxisIndex,
      z: 3,
      symbolSize: 9,
      itemStyle: { color: tokens.danger },
      data: annotations.errors.map((error): ChartErrorDatum => ({
        value: [error.at, 0.5],
        symbol: errorSymbolOf(error.outcome),
        tooltipLines: errorTooltipLines(error, timeZone, text),
      })),
    });
  }

  return {
    // Deterministic rendering: no animation state to race in tests or e2e.
    animation: false,
    textStyle: { fontFamily: tokens.fontFamily },
    // The grids share their left/right insets and never contain labels, so
    // the main plot and the strip align by construction.
    grid: [
      {
        left: AXIS_LEFT,
        right: AXIS_RIGHT,
        top: MAIN_TOP,
        // The strip's box sits `LABEL_HEIGHT` above the canvas bottom
        // (its date labels render below it), so the main plot's bottom
        // is that box plus its own height and the gap — LABEL_HEIGHT
        // once, not twice.
        bottom: hasStrip ? LABEL_HEIGHT + STRIP_HEIGHT + STRIP_GAP : LABEL_HEIGHT,
      },
      ...(hasStrip
        ? [{ left: AXIS_LEFT, right: AXIS_RIGHT, height: STRIP_HEIGHT, bottom: LABEL_HEIGHT }]
        : []),
    ],
    legend: {
      show: true,
      data: legendData,
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
    xAxis,
    yAxis,
    series,
  };
}
