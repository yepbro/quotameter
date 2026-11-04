<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import type { HistoryResponse } from '../../../src/schemas/api/history';
import ApiErrorNotice from './ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
import { formatEpochMs, formatQuotaNumber } from '../format';
import { historyRangeIsoBounds, type HistoryRangeId } from '../history-range';
import { useChartRuntime, type ChartHandle } from '../charts/runtime';
import {
  buildMetricChartOption,
  chartSamplesOf,
  rangeNoticeOf,
  resolveViewMode,
  seriesAvailability,
  type ChartViewMode,
  type MetricChartOption,
} from '../charts/series';
import { chartTokensOf } from '../charts/tokens';
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
// The card re-styles live with the theme (D-133): the option computed
// reads `resolvedTheme`, re-reads the `--qm-*` token cascade, and the
// chart re-sets its option — no reload, no hardcoded colors.
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

// Identity and range changes are fresh queries: the previous response
// belongs to another window (or metric) and must not render for an
// instant beside the new one — so the kept copy goes with the reset.
watch(
  () => [props.accountId, props.metricKey, props.rangeId] as const,
  () => {
    lastGood.value = null;
    reset();
    void execute();
  },
  { immediate: true },
);

// A refresh is the same query with fresh bounds: the last-good chart
// stays rendered (D-135's keep-last-good rule) — on success until the
// fresh data replaces it, on failure beside the notice.
watch(
  () => props.refreshToken,
  () => {
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

const option = computed<MetricChartOption | null>(() => {
  const response = displayData.value;
  if (response === null || samples.value.length === 0) return null;
  // Reading the resolved mode registers the dependency: a theme flip
  // re-runs this computed, the tokens re-read the cascade, and the chart
  // below re-sets its option — the live restyle D-133 pinned.
  void theme.resolvedTheme.value;
  return buildMetricChartOption({
    samples: samples.value,
    mode: effectiveMode.value,
    unitLabel: unitLabel.value,
    tokens: chartTokensOf((name) => runtime.readToken(name)),
    text: {
      used: t('overview.chart.seriesUsed'),
      remaining: t('overview.chart.seriesRemaining'),
    },
    timeZone: props.timeZone,
    // The requested bounds: identical across one page-load's per-metric
    // charts, so the axes align even where retention truncated the data.
    window: {
      from: response.range.requestedFrom,
      to: response.range.requestedTo,
    },
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

/** The chart's text alternative (§14.1): the metric and its latest values. */
const ariaSummary = computed(() => {
  const sample = latestStatableSample.value;
  if (sample === null) return props.label;
  if (effectiveMode.value === 'percent') {
    return t('overview.chart.summaryPercent', {
      metric: props.label,
      used: statablePercent(sample.percentUsed),
      remaining: statablePercent(sample.percentRemaining),
      time: formatEpochMs(sample.at, props.timeZone),
    });
  }
  return t('overview.chart.summaryAbsolute', {
    metric: props.label,
    used: statableValue(sample.used),
    remaining: statableValue(sample.remaining),
    unit: unitLabel.value,
    time: formatEpochMs(sample.at, props.timeZone),
  });
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

function releaseChart(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  chart?.dispose();
  chart = null;
}

// One effect owns the instance: it initializes when a host and an option
// exist together, then re-sets the option on every change — new data, a
// view switch, or a theme flip all arrive here as a new option value.
watchEffect(() => {
  const element = canvasHost.value;
  const optionValue = option.value;
  if (element === null || optionValue === null) return;
  if (chart === null) {
    chart = runtime.createChart(element);
    resizeObserver = new ResizeObserver(() => {
      chart?.resize();
    });
    resizeObserver.observe(element);
  }
  // `notMerge` is deliberate: the option is rebuilt whole every time
  // (data, view, theme), so no stale configuration can survive an
  // update — at the cost of resetting ECharts' own interaction state
  // (a legend-series toggle), which task 178's cursor/zoom work owns
  // and will reconcile with its state-preserving updates.
  chart.setOption(optionValue, { notMerge: true });
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
