<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EventsResponse, HistoryResponse } from '../../../src/schemas/api/history';
import type { PeakHoursResponse } from '../../../src/schemas/api/peak-hours';
import ApiErrorNotice from './ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
import { formatEpochMs, formatQuotaNumber } from '../format';
import { historyRangeIsoBounds, type HistoryRangeId } from '../history-range';
import { useChartRuntime, type ChartDataZoomEvent, type ChartHandle } from '../charts/runtime';
import {
  annotationsOf,
  peakBandsOf,
  scheduleZoneOf,
  type ChartWindow,
} from '../charts/annotations';
import {
  buildMetricChartOption,
  chartPlotWidthOf,
  chartSamplesOf,
  CHART_X_ZOOM_ID,
  rangeNoticeOf,
  resolveViewMode,
  seriesAvailability,
  type ChartViewMode,
  type MetricChartOption,
  type MetricChartText,
} from '../charts/series';
import { zoomPercentOf, type ChartSync, type ChartZoomPercent } from '../charts/sync';
import { chartTokensOf } from '../charts/tokens';
import { chooseTickStep } from '../charts/ticks';
import { useTheme } from '../theme';

// One metric's §14.4 history chart (task 175; decision D-148): the card
// owns its per-metric range-keyed load (D-147's per-metric extension of
// the page's trigger shape — bounds recomputed on every dispatch, a
// rolling range ends now), renders the used/remaining line pair in ONE
// unit, and offers the percent/absolute toggle exactly when the data
// carries both views (§14.4). A percentage-only metric stays percentages:
// the toggle never renders for it and no absolute axis is inferred.
//
// Unit segregation is structural, not checked: the option builder takes
// one view mode and one unit and emits one y-axis — incompatible units
// cannot share an axis by construction.
//
// Task 176 (D-149) renders the §12.2/§9.3 annotations: the account-level
// events timeline and peak-hours intervals arrive as PROPS from the page's
// own range-keyed loads (D-147's single timeline load was always 176's
// source); resets/gaps filter to this metric, errors/stopped render on
// every metric chart (account-level facts — D-149's consistent mapping).
//
// The card re-styles live with the theme (D-133): the option computed
// reads `resolvedTheme`, re-reads the `--qm-*` token cascade, and the
// chart re-sets its option — no reload, no hardcoded colors.
//
// Task 178 (D-153) synchronizes the cursor and zoom across the page's
// charts: the card joins its ECharts instance to the page's `connect`
// group (the `sync` prop — cursor moves and zoom windows relay between
// the group's instances by value/percent), feeds its own `dataZoom` events
// back into the option (the tick ladder re-densifies over the zoom span
// while the axes keep the requested bounds), and reports the zoom state
// the page's reset affordance renders from.
const { t } = useI18n();
const api = useApi();
const runtime = useChartRuntime();
const theme = useTheme();

const props = defineProps<{
  /** The validated target account (the page's `quotaTarget`). */
  readonly accountId: string;
  /** The metric this chart renders — the card's identity. */
  readonly metricKey: string;
  /** The resolved display label (provider catalog, key fallback — D-137). */
  readonly label: string;
  /** The selected §14.4 rolling range (D-147). */
  readonly rangeId: HistoryRangeId;
  /** The configured display time zone (§14.1). */
  readonly timeZone: string;
  /** Bumped by the page's refresh affordance: re-anchor the rolling window. */
  readonly refreshToken: number;
  /**
   * The page's cursor/zoom coordinator (task 178, D-153): carries the
   * connect group id and receives this chart's zoom reports.
   */
  readonly sync: ChartSync;
  /**
   * The account-level §12.2 timeline (the page's range-keyed load, task
   * 176): resets/gaps filter to this metric, error/stopped facts render
   * here as account-level marks. `null` while pending/failed/absent.
   */
  readonly events?: EventsResponse | null;
  /** The account's served §9.3 intervals (task 176): the peak bands. */
  readonly peaks?: PeakHoursResponse | null;
}>();

const { data, error, pending, execute, reset } = useApiCall(() => {
  const { from, to } = historyRangeIsoBounds(props.rangeId, Date.now());
  return api.history.get({ accountId: props.accountId, metric: props.metricKey, from, to });
});

/**
 * The last successful response — the keep-last-good copy (D-135's rule,
 * the page's `lastQuota` precedent): `useApiCall` nulls `data` on a
 * failed call, but a failed refresh must leave the previous chart
 * rendered beside its notice, not wipe it. Cleared exactly where the
 * query identity changes (below) — one window's response must never
 * render for another.
 */
const lastGood = ref<HistoryResponse | null>(null);
watch(data, (value) => {
  if (value !== null) lastGood.value = value;
});

/** What renders: the live response, else the kept copy of the same query. */
const displayData = computed(() => data.value ?? lastGood.value);

/* ── The §14.4 zoom window (task 178, D-153) ───────────────────────────── */

/**
 * The active zoom as percent of the requested-bounds extent — `null` is
 * the full range. Set by this chart's own `dataZoom` events (the user's
 * gesture AND every window the connect group relayed onto this instance
 * both fire here).
 */
const zoomPercent = ref<ChartZoomPercent | null>(null);

/** Scales one percent window onto the card's requested bounds. */
function zoomWindowOf(
  percent: ChartZoomPercent,
  window: ChartWindow,
): { from: number; to: number } | null {
  const span = window.to - window.from;
  const from = window.from + (span * percent.start) / 100;
  const to = window.from + (span * percent.end) / 100;
  return from < to ? { from, to } : null;
}

/**
 * The zoom window in instants — the span the tick ladder walks while the
 * axes keep the requested bounds (the zoom relay's percent base).
 */
const zoomWindow = computed(() => {
  const percent = zoomPercent.value;
  const window = chartWindow.value;
  if (percent === null || window === null) return null;
  return zoomWindowOf(percent, window);
});

/**
 * The chart's `dataZoom` event: normalize the percent window, keep it for
 * the option's tick span, and report it to the page's coordinator (the
 * reset affordance and the announcement state).
 */
function onDataZoom(payload: ChartDataZoomEvent): void {
  const percent = zoomPercentOf(payload);
  zoomPercent.value = percent;
  const window = chartWindow.value;
  const scaled = percent !== null && window !== null ? zoomWindowOf(percent, window) : null;
  props.sync.reportZoom(percent === null || scaled === null ? null : { percent, window: scaled });
}

/** Resets this chart's zoom (the refresh re-anchor; see the watcher below). */
function resetZoom(): void {
  // An unzoomed card has nothing to reset — and its `null` report would
  // claim the group is full-range while other cards still hold a window.
  if (zoomPercent.value === null) return;
  zoomPercent.value = null;
  props.sync.reportZoom(null);
  chart?.dispatchAction({ type: 'dataZoom', dataZoomId: CHART_X_ZOOM_ID, start: 0, end: 100 });
}

// Identity and range changes are fresh queries: the previous response
// belongs to another window (or metric) and must not render for an
// instant beside the new one — so the kept copy goes with the reset. The
// zoom clears locally with the same identity (the next window's chart
// starts unzoomed); the GROUP report happens only where this card held a
// zoom — a fresh mount reporting `null` would wipe a window the other
// cards still hold (the late-joiner case).
watch(
  () => [props.accountId, props.metricKey, props.rangeId] as const,
  () => {
    if (zoomPercent.value !== null) {
      zoomPercent.value = null;
      props.sync.reportZoom(null);
    }
    lastGood.value = null;
    reset();
    void execute();
  },
  { immediate: true },
);

// A refresh is the same query with fresh bounds: the last-good chart
// stays rendered (D-135's keep-last-good rule) — on success until the
// fresh data replaces it, on failure beside the notice. The bounds moved,
// so the previous zoom's percent would name DIFFERENT instants on the new
// window — a zoomed card resets its own zoom before re-loading (every
// zoomed card of the page runs the same reset through the same token; an
// unzoomed card has nothing to reset and nothing to report).
watch(
  () => props.refreshToken,
  () => {
    resetZoom();
    void execute();
  },
);

/* ── View mode: the §14.4 toggle ──────────────────────────────────────── */

/** The user's standing preference; defaults to absolute (§14.3's ladder). */
const requestedMode = ref<ChartViewMode>('absolute');

const samples = computed(() => chartSamplesOf(displayData.value?.points ?? []));
const availability = computed(() => seriesAvailability(samples.value));

/** §14.4: the toggle exists only where BOTH views have data. */
const canToggle = computed(() => availability.value.absolute && availability.value.percent);

/** The view that renders — the requested one whenever its data exists. */
const effectiveMode = computed(() => resolveViewMode(requestedMode.value, availability.value));

/** The radio group's name: one group per card, never across cards. */
const radioName = computed(() => `chart-view-${props.metricKey}`);

function onViewChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  requestedMode.value = input.value === 'percent' ? 'percent' : 'absolute';
}

/* ── The rendered option ───────────────────────────────────────────────── */

/**
 * The unit word of the absolute view (§8.4 `unit`). Exhaustive over the
 * `MetricUnit` union: a future unit fails the `never` assignment at
 * compile time instead of silently rendering as "percent".
 */
const unitLabel = computed(() => {
  switch (displayData.value?.unit) {
    case 'TOKENS':
      return t('overview.metric.unit.tokens');
    case 'CREDITS':
      return t('overview.metric.unit.credits');
    case 'REQUESTS':
      return t('overview.metric.unit.requests');
    case 'PERCENT':
      return t('overview.metric.unit.percent');
    default: {
      const unit = displayData.value?.unit;
      // An empty series carries no unit — nothing renders from this
      // label (no samples means no chart).
      if (unit === null || unit === undefined) return '';
      const exhaustive: never = unit;
      return exhaustive;
    }
  }
});

/**
 * The chart's x window — the card's own response's requested bounds: the
 * annotations clamp to it (the page's events/peaks loads bound their own
 * `Date.now()`, so the edges can differ by milliseconds; D-149).
 */
const chartWindow = computed<ChartWindow | null>(() => {
  const response = displayData.value;
  if (response === null) return null;
  return { from: response.range.requestedFrom, to: response.range.requestedTo };
});

/** The §12.2 timeline mapped onto this metric (task 176, D-149). */
const annotations = computed(() =>
  chartWindow.value === null
    ? null
    : annotationsOf(props.events ?? null, props.metricKey, chartWindow.value),
);

/** The §9.3 bands and schedule zone of the account's served schedule. */
const peak = computed(() => {
  const window = chartWindow.value;
  if (window === null) return null;
  const peaks = props.peaks ?? null;
  return { bands: peakBandsOf(peaks, window), scheduleZone: scheduleZoneOf(peaks) };
});

/** The catalog vocabulary the pure builder composes (D-148/D-149). */
const chartText = computed<MetricChartText>(() => ({
  used: t('overview.chart.seriesUsed'),
  remaining: t('overview.chart.seriesRemaining'),
  peakHead: t('overview.chart.peakHead'),
  offPeakHead: t('overview.chart.offPeakHead'),
  bandTimes: t('overview.chart.bandTimes'),
  gapHead: t('overview.chart.gapHead'),
  gapBody: t('overview.chart.gapBody'),
  stoppedHead: t('overview.chart.stoppedHead'),
  stoppedBody: t('overview.chart.stoppedBody'),
  stoppedLabel: t('overview.chart.stoppedLabel'),
  resetTooltip: t('overview.chart.resetTooltip'),
  resetLabel: t('overview.chart.resetLabel'),
  bandsSeries: t('overview.chart.bandsSeries'),
  errorsSeries: t('overview.chart.errorsSeries'),
  errorAttempts: t('overview.chart.errorAttempts'),
  errorStatus: t('overview.chart.errorStatus'),
  errorRetryAfter: t('overview.chart.errorRetryAfter'),
  errorOutcomes: {
    auth_error: t('overview.error.outcome.authError'),
    rate_limited: t('overview.error.outcome.rateLimited'),
    network_error: t('overview.error.outcome.networkError'),
    timeout: t('overview.error.outcome.timeout'),
    server_error: t('overview.error.outcome.serverError'),
    parse_error: t('overview.error.outcome.parseError'),
  },
}));

const option = computed<MetricChartOption | null>(() => {
  const response = displayData.value;
  if (response === null || samples.value.length === 0 || annotations.value === null) {
    return null;
  }
  // Reading the resolved mode registers the dependency: a theme flip
  // re-runs this computed, the tokens re-read the cascade, and the chart
  // below re-sets its option — the live restyle D-133 pinned.
  void theme.resolvedTheme.value;
  return buildMetricChartOption({
    samples: samples.value,
    mode: effectiveMode.value,
    unitLabel: unitLabel.value,
    tokens: chartTokensOf((name) => runtime.readToken(name)),
    text: chartText.value,
    timeZone: props.timeZone,
    // The requested bounds: identical across one page-load's per-metric
    // charts, so the axes align even where retention truncated the data.
    window: {
      from: response.range.requestedFrom,
      to: response.range.requestedTo,
    },
    // The active zoom span (D-153): the tick ladder re-densifies over it
    // inside the builder; absent when the window is full-range.
    ...(zoomWindow.value === null ? {} : { zoom: zoomWindow.value }),
    // The measured canvas width — the tick-density input (0 ⇒ the §14.1
    // floor inside the builder, until the host reports its real size).
    widthPx: chartWidth.value,
    annotations: annotations.value,
    peak: peak.value ?? undefined,
  });
});

/** The newest sample the effective view can state — the aria summary's source. */
const latestStatableSample = computed(() => {
  for (const sample of [...samples.value].reverse()) {
    if (effectiveMode.value === 'percent') {
      if (sample.percentUsed !== null || sample.percentRemaining !== null) return sample;
    } else if (sample.used !== null || sample.remaining !== null) {
      return sample;
    }
  }
  return null;
});

function statableValue(value: number | null): string {
  return value === null ? t('overview.metric.unknown') : formatQuotaNumber(value);
}

/** A percent value with its symbol — "42%" — or the honest Unknown. */
function statablePercent(value: number | null): string {
  return value === null ? t('overview.metric.unknown') : `${formatQuotaNumber(value)}%`;
}

/**
 * The annotation counts of the range as text — the markers are facts, so
 * the chart's accessible name states them (§14.1: never color alone).
 */
const ariaMarks = computed(() => {
  const marks = annotations.value;
  if (marks === null) return '';
  const parts: string[] = [];
  if (marks.resets.length > 0) {
    parts.push(t('overview.chart.marksResets', { count: marks.resets.length }));
  }
  if (marks.gaps.length > 0) {
    parts.push(t('overview.chart.marksGaps', { count: marks.gaps.length }));
  }
  if (marks.stopped.length > 0) {
    parts.push(t('overview.chart.marksStopped', { count: marks.stopped.length }));
  }
  if (marks.errors.length > 0) {
    parts.push(t('overview.chart.marksErrors', { count: marks.errors.length }));
  }
  return parts.join(', ');
});

/** The chart's text alternative (§14.1): the metric and its latest values. */
const ariaSummary = computed(() => {
  const sample = latestStatableSample.value;
  const base =
    sample === null
      ? props.label
      : effectiveMode.value === 'percent'
        ? t('overview.chart.summaryPercent', {
            metric: props.label,
            used: statablePercent(sample.percentUsed),
            remaining: statablePercent(sample.percentRemaining),
            time: formatEpochMs(sample.at, props.timeZone),
          })
        : t('overview.chart.summaryAbsolute', {
            metric: props.label,
            used: statableValue(sample.used),
            remaining: statableValue(sample.remaining),
            unit: unitLabel.value,
            time: formatEpochMs(sample.at, props.timeZone),
          });
  const marks = ariaMarks.value;
  return marks === '' ? base : `${base} ${t('overview.chart.summaryMarks', { marks })}`;
});

/** The D-147 residual, classified (a sliver clamp stays quiet). */
const notice = computed(() =>
  displayData.value === null ? 'none' : rangeNoticeOf(displayData.value.range),
);
const truncatedFromText = computed(() => {
  const from = displayData.value?.range.effectiveFrom;
  return from === null || from === undefined ? '' : formatEpochMs(from, props.timeZone);
});

/**
 * A series that exists but carries NO plottable values anywhere (only
 * invalid rows and gap markers): a stated fact, not a blank chart — the
 * empty-range wording would promise values that a working collector
 * would have delivered, so this state says what actually happened.
 */
const noPlottableValues = computed(
  () => samples.value.length > 0 && !availability.value.absolute && !availability.value.percent,
);

/* ── The chart instance's lifecycle ───────────────────────────────────── */

const canvasHost = ref<HTMLDivElement | null>(null);
let chart: ChartHandle | null = null;
let resizeObserver: ResizeObserver | null = null;

/**
 * The measured canvas width — the tick-density input (task 177, D-150):
 * 0 until the host exists (the builder then assumes §14.1's 360 px floor),
 * the real CSS width at chart creation, and on container resize only when
 * the change moves the ladder to a different step (within a step the same
 * instants just stretch — `resize()` alone covers that).
 */
const chartWidth = ref(0);

function releaseChart(): void {
  if (chart !== null) {
    // The detach precedes the dispose: an empty group forgets the shared
    // zoom (D-153) while the instance is still a valid handle.
    props.sync.detach(chart);
    chart.off('dataZoom', onDataZoom);
  }
  syncAttached = false;
  resizeObserver?.disconnect();
  resizeObserver = null;
  chart?.dispose();
  chart = null;
}

/** Whether this card's live instance has joined the page's sync group. */
let syncAttached = false;

/**
 * The option-update discipline (D-148's deferred follow-through, D-153):
 * merge-mode `setOption` with `replaceMerge` over the four families whose
 * COUNT varies (series, xAxis, yAxis, grid — annotation series and strip
 * axes appear and disappear with the events/peaks props). Everything the
 * option declares is re-set on every update, so no stale configuration
 * survives (the old `notMerge` guarantee), while ECharts' own interaction
 * state — the dataZoom window this task adds, a legend series toggle —
 * persists across data, view, theme, and tick updates instead of being
 * wiped by a full replace.
 */
const MERGE_REPLACE_FAMILIES = ['series', 'xAxis', 'yAxis', 'grid'] as const;

// One effect owns the instance: it initializes when a host and an option
// exist together, then re-sets the option on every change — new data, a
// view switch, or a theme flip all arrive here as a new option value.
watchEffect(() => {
  const element = canvasHost.value;
  // Measured BEFORE the option read: an effect does not re-run on its own
  // write (Vue 3.5), so a creation-time measure taken after `option.value`
  // would be discarded until the observer's first callback.
  if (element !== null && chart === null && element.clientWidth > 0) {
    chartWidth.value = element.clientWidth;
  }
  const optionValue = option.value;
  if (element === null || optionValue === null) return;
  if (chart === null) {
    chart = runtime.createChart(element, { syncGroup: props.sync.groupId });
    chart.on('dataZoom', onDataZoom);
    resizeObserver = new ResizeObserver(() => {
      chart?.resize();
      const width = element.clientWidth;
      if (width <= 0) return;
      // The tick content depends on the width only through the chosen
      // ladder step, and the ladder walks the ACTIVE tick window — the
      // zoom span when one is live, else the requested window: while the
      // step holds, a width change stretches the same instants (the
      // resize above) and re-setting the whole option per observer frame
      // would be wasted work.
      const tickWindow = zoomWindow.value ?? chartWindow.value;
      const span = tickWindow === null ? 0 : tickWindow.to - tickWindow.from;
      if (
        span <= 0 ||
        chooseTickStep(span, chartPlotWidthOf(chartWidth.value)) !==
          chooseTickStep(span, chartPlotWidthOf(width))
      ) {
        chartWidth.value = width;
      }
    });
    resizeObserver.observe(element);
  }
  chart.setOption(optionValue, { replaceMerge: MERGE_REPLACE_FAMILIES });
  // The group join follows the first `setOption`: a late joiner's
  // catch-up dispatch must find the dataZoom id in the live option.
  if (!syncAttached) {
    syncAttached = true;
    props.sync.attach(chart);
  }
});

// The host unmounting (the card switched states) releases the instance —
// a later re-render creates a fresh chart on the new element instead of
// drawing into a detached one.
watch(canvasHost, (element) => {
  if (element === null) releaseChart();
});
onBeforeUnmount(releaseChart);

/** The retry affordance — the card always holds its own target. */
function retry(): void {
  void execute();
}
</script>

<template>
  <article class="chart-card" :data-metric-key="metricKey" data-testid="metric-chart">
    <h4>{{ label }}</h4>

    <!-- §14.4's toggle: only where the data carries BOTH views. Native
      radios (fieldset + legend, one group per card) — keyboard support is
      the platform's, §14.1. -->
    <fieldset v-if="canToggle" class="view-toggle" data-testid="chart-view-toggle">
      <legend>{{ t('overview.chart.viewLabel') }}</legend>
      <label class="option">
        <input
          type="radio"
          :name="radioName"
          value="absolute"
          :checked="effectiveMode === 'absolute'"
          data-testid="chart-view-absolute"
          @change="onViewChange"
        />
        <span>{{ t('overview.chart.viewAbsolute') }}</span>
      </label>
      <label class="option">
        <input
          type="radio"
          :name="radioName"
          value="percent"
          :checked="effectiveMode === 'percent'"
          data-testid="chart-view-percent"
          @change="onViewChange"
        />
        <span>{{ t('overview.chart.viewPercent') }}</span>
      </label>
    </fieldset>

    <p v-if="pending && displayData === null" class="status" data-testid="chart-loading">
      {{ t('overview.chart.loading') }}
    </p>
    <!-- A failed (re)load renders its notice beside the last-good chart
      when one exists (D-135's rule) — never a fake empty state. -->
    <div v-if="error !== null" class="load-failure">
      <ApiErrorNotice :error="error" />
      <button type="button" data-testid="chart-retry" @click="retry">
        {{ t('overview.chart.retry', { metric: label }) }}
      </button>
    </div>

    <template v-if="displayData !== null">
      <p v-if="notice === 'rejected'" class="status" data-testid="chart-rejected">
        {{ t('overview.chart.rejected') }}
      </p>
      <template v-else>
        <p v-if="samples.length === 0" class="status" data-testid="chart-empty">
          {{ t('overview.chart.empty') }}
        </p>
        <p v-else-if="noPlottableValues" class="status" data-testid="chart-no-valid-values">
          {{ t('overview.chart.noValidValues') }}
        </p>
        <template v-else>
          <p v-if="notice === 'truncated'" class="status" data-testid="chart-truncated">
            {{ t('overview.chart.truncatedNotice', { time: truncatedFromText }) }}
          </p>
          <!-- role="img": the lines are an image of the data; the summary
            is the textual statement of the same facts (§14.1). -->
          <div
            ref="canvasHost"
            class="chart-canvas"
            role="img"
            :aria-label="ariaSummary"
            data-testid="chart-canvas"
          />
        </template>
      </template>
    </template>
  </article>
</template>

<style scoped>
/* The tokens are the only color source (D-133); the card's signals are
 * text (labels, notices) beside any color. */
.chart-card {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--qm-color-muted);
  border-radius: 8px;
  background-color: var(--qm-color-background);
  min-width: 14rem;
}

h4 {
  margin: 0;
  font-size: 1rem;
}

.view-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1rem;
  margin: 0.35rem 0 0;
  padding: 0;
  border: 0;
}

.view-toggle legend {
  color: var(--qm-color-muted);
  padding: 0;
  font-size: 0.875rem;
}

.option {
  display: inline-flex;
  align-items: baseline;
  gap: 0.35rem;
  color: var(--qm-color-foreground);
  font-size: 0.875rem;
}

.option input {
  margin: 0;
}

.status {
  margin: 0.5rem 0 0;
  color: var(--qm-color-muted);
  font-size: 0.875rem;
}

.load-failure {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.load-failure button {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
}

.chart-canvas {
  height: 16rem;
  width: 100%;
  margin-top: 0.5rem;
}
</style>
