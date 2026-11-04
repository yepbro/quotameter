<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { AccountView } from '../../../src/schemas/api/accounts';
import type { EventsResponse } from '../../../src/schemas/api/history';
import type { PeakHoursResponse } from '../../../src/schemas/api/peak-hours';
import type { ProviderView } from '../../../src/schemas/api/providers';
import type { QuotaResponse, StatusResponse } from '../../../src/schemas/api/status';
import { accountAttentionOf } from '../account-attention';
import AccountAttentionNotice from '../components/AccountAttentionNotice.vue';
import AccountOverviewCard from '../components/AccountOverviewCard.vue';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import HistoryRangeControls from '../components/HistoryRangeControls.vue';
import MetricCard from '../components/MetricCard.vue';
import MetricHistoryChart from '../components/MetricHistoryChart.vue';
import { useApi, useApiCall } from '../api';
import { useAccountSelection } from '../account-selection';
import { createChartSync } from '../charts/sync';
import { formatChartDate } from '../format';
import {
  HISTORY_RANGE_DEFAULT,
  historyRangeIsoBounds,
  isHistoryRangeWithinRetention,
  type HistoryRangeId,
} from '../history-range';

// The account overview page (task 172, spec §14.3/§14.6; decision D-137):
// the selected account's identity card (provider, label, plan, §7.3
// status, §7.2 last success/last error) plus one card per metric of its
// last-valid quota row set (D-077) — the §14.3 surface. The card follows
// the shared selection store (D-135): this page is the store's second
// consumer and re-runs the documented reconciliation rule against its own
// accounts-list load.
//
// Task 173 (D-138) adds the empty/initial guidance: the page-level
// no-accounts block with its link to the accounts page, the
// account-level attention notice (which fact keeps collection from
// running and what to do about it), and the blocked-vs-waiting
// no-snapshot wording.
//
// The five data-defining loads, one `useApiCall` each (D-134): the
// accounts list (selector + identity), the providers list (provider
// names AND the metric-label catalog, D-137), the §7.3 status rows,
// the settings view (the configured display time zone §14.1 AND the
// history retention §14.4), and the selected account's quota (re-run
// on every selection change). A failed load is never a fake empty
// state (D-135's rule): each of these keeps its own last-good copy —
// a failed reload leaves the previous surface rendered beside the
// failure notice — and the quota copy is cleared on a selection switch
// so one account's values can never render as another's.
//
// Task 174 (D-147) adds the §14.4 rolling-range controls at the seam
// below and the account-level §12.2 timeline load beside the quota.
// Task 175 (D-148) renders the §14.4 metric charts: one card per quota
// metric below the metric cards, each owning its per-metric range-keyed
// series load. Task 176 (D-149) adds the §9.3 peak-hours load and feeds
// both annotation loads into the chart cards as props.
const { t } = useI18n();
const api = useApi();
const selection = useAccountSelection();

const {
  data: listData,
  error: listError,
  pending: listPending,
  execute: reloadList,
} = useApiCall(() => api.accounts.list());
const {
  data: providersData,
  error: providersError,
  execute: reloadProviders,
} = useApiCall(() => api.providers.list());
const {
  data: statusData,
  error: statusError,
  execute: reloadStatus,
} = useApiCall(() => api.status.get());
const {
  data: settingsData,
  error: settingsError,
  execute: reloadSettings,
} = useApiCall(() => api.settings.get());
/**
 * The selection-keyed quota target: the selected account id, set only by
 * the validated-target watcher below (never a stale unvalidated id).
 */
const quotaAccountId = ref<string | null>(null);
const {
  data: quotaData,
  error: quotaError,
  pending: quotaPending,
  execute: loadQuota,
  reset: resetQuota,
} = useApiCall(() => api.quota.get(quotaAccountId.value ?? ''));

void reloadList();
void reloadProviders();
void reloadStatus();
void reloadSettings();

/** The last successfully loaded list — the rendered truth (see above). */
const lastAccounts = ref<ReadonlyArray<AccountView>>([]);
/** Whether the accounts list has loaded successfully at least once. */
const listLoaded = ref(false);
/** The last successfully loaded providers (same rule as the list). */
const lastProviders = ref<ReadonlyArray<ProviderView>>([]);
/** The last successfully loaded status response (same rule). */
const lastStatus = ref<StatusResponse | null>(null);
/** The selected account's last successfully loaded quota (cleared on switch). */
const lastQuota = ref<QuotaResponse | null>(null);
/** "Now" as epoch ms, captured when data arrives — the relative-time base. */
const nowMs = ref(Date.now());

watch(listData, (data) => {
  if (data === null) return;
  lastAccounts.value = data.accounts;
  listLoaded.value = true;
  nowMs.value = Date.now();
});
watch(providersData, (data) => {
  if (data === null) return;
  lastProviders.value = data.providers;
});
watch(statusData, (data) => {
  if (data === null) return;
  lastStatus.value = data;
  nowMs.value = Date.now();
});
watch(quotaData, (data) => {
  if (data === null) return;
  lastQuota.value = data;
  nowMs.value = Date.now();
});

const accounts = computed(() => lastAccounts.value);

/**
 * The validated quota target: the selected id only once a completed
 * list load vouches for it — the list's own membership is the only
 * proof an id is requestable.
 */
const quotaTarget = computed((): string | null => {
  const id = selection.selectedId.value;
  if (id === null || !listLoaded.value) return null;
  return lastAccounts.value.some((account) => account.id === id) ? id : null;
});

/** Re-runs the current target's quota load (the retry affordance). */
function retryQuota(): void {
  if (quotaAccountId.value !== null) void loadQuota();
}

// Selection reconciliation — the store's documented consumer rule
// (D-135), identical to the accounts page's: keep the stored id while it
// is listed, else the first account, else none; runs only once the list
// HAS loaded so an arriving list can still honor a stored choice.
watch(
  accounts,
  (list) => {
    if (!listLoaded.value) return;
    const ids = new Set(list.map((account) => account.id));
    const current = selection.selectedId.value;
    if (current !== null && ids.has(current)) return;
    selection.select(list[0]?.id ?? null);
  },
  { immediate: true },
);

const selected = computed(
  () => accounts.value.find((account) => account.id === selection.selectedId.value) ?? null,
);

/**
 * The selected account's attention kind — which account-level fact
 * keeps collection from running (task 173, D-138): `null` when
 * nothing does. Single-sourced in `account-attention.ts`; the notice
 * presents it and the no-snapshot wording below re-reads it. The
 * §7.3 row rides along because `hasKey` is declaration-level: only
 * the status row can say an environment-sourced key does not resolve.
 */
const attention = computed(() =>
  selected.value === null
    ? null
    : accountAttentionOf(selected.value, statusRowOf.value(selected.value.id)),
);

/**
 * The no-snapshot line's wording: under an attention blocker the
 * waiting sentence's "values appear after the first successful poll"
 * would promise a poll that never runs — the blocked line states the
 * fact instead, and the notice above carries the remedy.
 */
const noSnapshotText = computed(() =>
  attention.value === null ? t('overview.empty.noSnapshot') : t('overview.empty.noSnapshotBlocked'),
);

// The quota load is target-keyed: the watcher below fires on every
// change of the VALIDATED target (a stale stored id dispatches nothing,
// so the honest 404 it would earn never flashes beside the real surface
// — the review round's P2; reconciliation landing on a listed id is
// what arms the first load). A target switch resets the call (a
// settling answer for the previous account is superseded) and clears
// the previous account's values before loading — no cross-account
// staleness, and no request at all while nothing is selected.
watch(
  quotaTarget,
  (accountId) => {
    lastQuota.value = null;
    resetQuota();
    if (accountId !== null) {
      quotaAccountId.value = accountId;
      void loadQuota();
    }
  },
  { immediate: true },
);

/* ── Task 174: the §14.4 rolling-range controls (decision D-147) ──────── */

/**
 * The selected range — page-local state (§14.4 names no persistence,
 * and unlike the account id it is a query parameter of this page's
 * history surface alone): default 7 days, never the selection store.
 */
const selectedRange = ref<HistoryRangeId>(HISTORY_RANGE_DEFAULT);

/**
 * The configured retention from the settings view this page already
 * loads (§13's annotated `app.historyRetentionDays`); `null` while the
 * load is pending or has failed. Unknown retention disables nothing —
 * an unknown fact asserts nothing — and the server's own range report
 * (D-139's 200-with-report) stays the authority on what is queryable.
 */
const retentionDays = computed(
  (): number | null => settingsData.value?.settings.app.historyRetentionDays.value ?? null,
);

/**
 * Whether the selection was auto-fell-back to the default (the notice
 * below announces the change — a screen-reader user who just chose a
 * longer range must hear that it moved, §14.1); the notice lives until
 * the next manual pick.
 */
const rangeFellBack = ref(false);

// A selected range that becomes disabled once retention is known falls
// back to the default — always selectable, because §11.3's accepted
// retention minimum (7 days) equals the default's duration.
watch(
  () => [selectedRange.value, retentionDays.value] as const,
  ([range, retention]) => {
    if (retention !== null && !isHistoryRangeWithinRetention(range, retention)) {
      selectedRange.value = HISTORY_RANGE_DEFAULT;
      rangeFellBack.value = true;
    }
  },
);

/** A manual pick: the range changes and any fallback notice retires. */
function onRangeChange(range: HistoryRangeId): void {
  selectedRange.value = range;
  rangeFellBack.value = false;
}

/**
 * The history loads' target vocabulary: the validated account plus its
 * quota metric keys — one §14.4 chart per metric (task 175, D-147's
 * per-metric extension). No snapshot ⇒ no keys ⇒ no series requests (the
 * timeline below still loads, it states account-level facts).
 */
const chartTargets = computed((): readonly { accountId: string; metricKey: string }[] => {
  const accountId = quotaTarget.value;
  if (accountId === null) return [];
  const metrics = lastQuota.value?.metrics ?? [];
  return metrics.map((metric) => ({ accountId, metricKey: metric.metricKey }));
});

/* ── Task 178: the §14.4 cursor/zoom sync (decision D-153) ─────────────── */

/**
 * The charts' shared cursor/zoom coordinator: its `groupId` joins every
 * chart card's ECharts instance to one `connect` group (cursor moves and
 * zoom windows relay between them), and its zoom state is what this page
 * renders — the reset affordance and the announcement below.
 */
const chartSync = createChartSync();
/** Top-level bindings so the template unwraps them (`chartsZoomed`). */
const chartsZoomed = chartSync.zoomed;

/**
 * The last zoom TRANSITION's announcement — `null` renders nothing. The
 * sentence is SNAPSHOTTED at the transition (a plain string, not a
 * computed over the live window): a polite live region re-announces on
 * every text change, so the applied window is stated once per zoom-in —
 * never per wheel tick (§14.1), and never again when the zone changes
 * mid-zoom.
 */
const zoomStatusText = ref<string | null>(null);
watch(chartsZoomed, (zoomed) => {
  const window = chartSync.zoomWindow.value;
  zoomStatusText.value =
    zoomed && window !== null
      ? t('overview.chart.zoomApplied', {
          from: formatChartDate(window.from, timeZone.value),
          to: formatChartDate(window.to, timeZone.value),
        })
      : t('overview.chart.zoomReset');
});

/** The shared zoom reset — every live chart, one dispatch each (D-153). */
function resetChartZoom(): void {
  chartSync.reset();
}

/**
 * The refresh epoch: bumped by the refresh affordance, watched by every
 * chart card (and nothing else) — each card re-anchors its own rolling
 * window with fresh bounds while keeping its last-good chart rendered
 * until the fresh data arrives (D-135's rule).
 */
const historyRefreshToken = ref(0);

// The account-level §12.2 timeline load (D-147): the range-keyed request
// whose consumer is task 176's annotations (the chart cards render the
// timeline's facts). Boundaries recompute on every dispatch — a rolling
// range ends "now" (§10); the per-metric series loads live inside the
// chart cards below.
const {
  data: eventsData,
  error: eventsError,
  execute: loadEvents,
  reset: resetEvents,
} = useApiCall(() => {
  const accountId = quotaTarget.value;
  if (accountId === null) {
    throw new Error('events load dispatched without a target');
  }
  const { from, to } = historyRangeIsoBounds(selectedRange.value, Date.now());
  return api.events.list({ accountId, from, to });
});

// The account-level §9.3 peak-hours load (task 176, D-149): the served
// intervals every metric chart renders as bands — the browser never
// calculates windows independently (§9.3). Same trigger shape as the
// timeline: the validated target × the range, fresh bounds per dispatch.
const {
  data: peakData,
  error: peakError,
  execute: loadPeakHours,
  reset: resetPeakHours,
} = useApiCall(() => {
  const accountId = quotaTarget.value;
  if (accountId === null) {
    throw new Error('peak-hours load dispatched without a target');
  }
  const { from, to } = historyRangeIsoBounds(selectedRange.value, Date.now());
  return api.peakHours.get({ accountId, from, to });
});

/**
 * The last-good copies of the two annotation loads (D-135's rule, the
 * cards' own `lastGood` precedent): a failed refresh must leave the
 * previous annotations rendering beside the chart cards' kept charts.
 * Cleared with the query identity — one window's timeline (or schedule)
 * must never render for another.
 */
const lastEvents = ref<EventsResponse | null>(null);
const lastPeaks = ref<PeakHoursResponse | null>(null);
watch(eventsData, (data) => {
  if (data !== null) lastEvents.value = data;
});
watch(peakData, (data) => {
  if (data !== null) lastPeaks.value = data;
});

/** What the chart cards receive: the live responses, else the kept copies. */
const displayEvents = computed(() => eventsData.value ?? lastEvents.value);
const displayPeaks = computed(() => peakData.value ?? lastPeaks.value);

// The annotation loads re-run on exactly their own dependencies: the
// validated target and the range.
watch(
  [quotaTarget, selectedRange],
  ([accountId]) => {
    lastEvents.value = null;
    lastPeaks.value = null;
    resetEvents();
    resetPeakHours();
    if (accountId !== null) {
      void loadEvents();
      void loadPeakHours();
    }
  },
  { immediate: true },
);

/**
 * Re-runs the selected account's data loads with a fresh "now" — the
 * refresh affordance D-137 handed to this task: it re-anchors the
 * rolling window (the chart cards re-dispatch through the token) and
 * exercises the keep-last-good quota reload beyond the retry path.
 */
function refreshAccountData(): void {
  if (quotaAccountId.value !== null) void loadQuota();
  if (quotaTarget.value !== null) {
    void loadEvents();
    void loadPeakHours();
  }
  historyRefreshToken.value += 1;
}

/** Re-runs the timeline load (the retry affordance, target-guarded). */
function retryEvents(): void {
  if (quotaTarget.value !== null) void loadEvents();
}

/** Re-runs the peak-hours load (the retry affordance, target-guarded). */
function retryPeakHours(): void {
  if (quotaTarget.value !== null) void loadPeakHours();
}

const statusRowOf = computed(() => {
  const rows = lastStatus.value?.accounts ?? [];
  return (accountId: string) => rows.find((row) => row.id === accountId) ?? null;
});

const providerNameOf = computed(() => {
  const names = new Map(lastProviders.value.map((provider) => [provider.id, provider.name]));
  return (account: AccountView): string => names.get(account.providerId) ?? account.providerId;
});

// The metric-label resolution (D-137): the provider's declared catalog,
// keyed by metric key — with the raw key as the documented fallback (a
// stable adapter-defined identifier, rendered verbatim) when the
// provider declares no catalog or no entry for the key.
const metricLabelOf = computed(() => {
  const catalogs = new Map(
    lastProviders.value.map((provider) => [
      provider.id,
      new Map(provider.metrics.map((entry) => [entry.metricKey, entry.label])),
    ]),
  );
  return (providerId: string, metricKey: string): string =>
    catalogs.get(providerId)?.get(metricKey) ?? metricKey;
});

// §14.1: dates format in the CONFIGURED display time zone; a failed
// settings load degrades to the browser's zone beside its own notice —
// never to a silent wrong zone and never to a blocked card.
const timeZone = computed(
  () =>
    settingsData.value?.settings.app.timezone.value ??
    Intl.DateTimeFormat().resolvedOptions().timeZone,
);

// The DOM select is a string boundary (the accounts page's rule): an
// unknown value stays unset; the handler only forwards.
function onSelect(event: Event): void {
  const { value } = event.target as HTMLSelectElement;
  selection.select(value === '' ? null : value);
}

function optionText(account: AccountView): string {
  return account.status === 'archived'
    ? `${account.label} (${t('overview.selector.archivedOption')})`
    : account.label;
}
</script>

<template>
  <section class="page">
    <h2>{{ t('overview.title') }}</h2>

    <p v-if="listPending && !listLoaded" class="status" data-testid="overview-loading">
      {{ t('overview.loading') }}
    </p>

    <!-- One notice per failed request (D-134); the data-defining loads
      carry a retry with its own accessible name, the gracefully-degrading
      ones (provider names → raw ids, configured zone → browser zone)
      render their notice alone. -->
    <div v-if="listError" class="load-failure">
      <ApiErrorNotice :error="listError" />
      <button type="button" data-testid="overview-retry-list" @click="reloadList">
        {{ t('overview.retryList') }}
      </button>
    </div>
    <div v-if="statusError" class="load-failure">
      <ApiErrorNotice :error="statusError" />
      <button type="button" data-testid="overview-retry-status" @click="reloadStatus">
        {{ t('overview.retryStatus') }}
      </button>
    </div>
    <div v-if="quotaError" class="load-failure">
      <ApiErrorNotice :error="quotaError" />
      <button
        type="button"
        data-testid="overview-retry-quota"
        :disabled="quotaAccountId === null"
        @click="retryQuota"
      >
        {{ t('overview.retryQuota') }}
      </button>
    </div>
    <!-- The range-keyed loads' failures: the timeline's and the schedule's
      notices + retries (task 174/176; the per-metric series failures
      render inside their chart cards below). -->
    <div v-if="eventsError" class="load-failure">
      <ApiErrorNotice :error="eventsError" />
      <button
        type="button"
        data-testid="overview-retry-events"
        :disabled="quotaTarget === null"
        @click="retryEvents"
      >
        {{ t('overview.retryEvents') }}
      </button>
    </div>
    <div v-if="peakError" class="load-failure">
      <ApiErrorNotice :error="peakError" />
      <button
        type="button"
        data-testid="overview-retry-peak-hours"
        :disabled="quotaTarget === null"
        @click="retryPeakHours"
      >
        {{ t('overview.retryPeakHours') }}
      </button>
    </div>
    <ApiErrorNotice v-if="providersError" :error="providersError" />
    <ApiErrorNotice v-if="settingsError" :error="settingsError" />

    <template v-if="accounts.length > 0">
      <div class="selector">
        <label for="overview-account-select">{{ t('overview.selector.label') }}</label>
        <select
          id="overview-account-select"
          data-testid="overview-account-select"
          :value="selection.selectedId.value"
          @change="onSelect"
        >
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ optionText(account) }}
          </option>
        </select>
      </div>

      <template v-if="selected !== null">
        <AccountOverviewCard
          :key="selected.id"
          :account="selected"
          :provider-name="providerNameOf(selected)"
          :plan-name="lastQuota?.planName ?? null"
          :status-row="statusRowOf(selected.id)"
          :time-zone="timeZone"
          :now="nowMs"
        />

        <!-- AccountAttentionNotice rendered when a blocker exists (task
          173, D-138). -->
        <AccountAttentionNotice v-if="attention !== null" :attention="attention" />

        <!-- Task 174 (§14.4, D-147): the rolling-range controls at the
          D-137 seam — between the identity card (and its attention
          notice) and the metrics region. The refresh beside them
          re-anchors the rolling window (a range ends "now") and re-runs
          the account's data loads. -->
        <div class="history-controls">
          <HistoryRangeControls
            :model-value="selectedRange"
            :retention-days="retentionDays"
            @update:model-value="onRangeChange"
          />
          <button
            type="button"
            data-testid="overview-refresh"
            :disabled="quotaTarget === null"
            @click="refreshAccountData"
          >
            {{ t('overview.range.refresh') }}
          </button>
        </div>
        <!-- The auto-fallback's announcement (a polite live region): a
          changed selection must be heard, not only seen. -->
        <p v-if="rangeFellBack" class="status" role="status" data-testid="history-range-fallback">
          {{ t('overview.range.fallbackNotice') }}
        </p>

        <!-- The metric cards are the §14.3 surface; the §14.4 charts
          (task 175/176) render from the range-keyed loads below this
          region. -->
        <div class="metrics" data-testid="overview-metrics">
          <MetricCard
            v-for="metric in lastQuota?.metrics ?? []"
            :key="metric.metricKey"
            :metric="metric"
            :label="metricLabelOf(selected.providerId, metric.metricKey)"
            :time-zone="timeZone"
            :now="nowMs"
          />
        </div>
        <!-- Task 175 (§14.4, D-148): one history chart per quota metric,
          each owning its range-keyed series load — one compatible unit
          per chart, the percent/absolute toggle where the data carries
          both views. Keyed by account + metric so a selection switch is
          a fresh card set (no per-account state leaks across). Task 178
          (D-153): every card joins the shared cursor/zoom group; the
          header's reset appears exactly while a zoom window is live and
          the live region below announces the transitions. -->
        <section
          v-if="chartTargets.length > 0"
          class="charts"
          data-testid="overview-charts"
          aria-labelledby="overview-charts-title"
        >
          <div class="charts-header">
            <h3 id="overview-charts-title">{{ t('overview.chart.regionTitle') }}</h3>
            <button
              v-if="chartsZoomed"
              type="button"
              data-testid="chart-zoom-reset"
              @click="resetChartZoom"
            >
              {{ t('overview.chart.resetZoom') }}
            </button>
          </div>
          <!-- The zoom announcement (a polite live region): one sentence
            per transition, never per wheel tick (§14.1). -->
          <p
            v-if="zoomStatusText !== null"
            class="status zoom-status"
            role="status"
            data-testid="chart-zoom-status"
          >
            {{ zoomStatusText }}
          </p>
          <MetricHistoryChart
            v-for="target in chartTargets"
            :key="`${target.accountId}\u0000${target.metricKey}`"
            :account-id="target.accountId"
            :metric-key="target.metricKey"
            :label="metricLabelOf(selected.providerId, target.metricKey)"
            :range-id="selectedRange"
            :time-zone="timeZone"
            :refresh-token="historyRefreshToken"
            :sync="chartSync"
            :events="displayEvents"
            :peaks="displayPeaks"
          />
        </section>
        <p v-if="quotaPending" class="status" data-testid="overview-quota-loading">
          {{ t('overview.loading') }}
        </p>
        <!-- The honest absence states (§14.3/§7.2: absence is never
          zero), told apart by the snapshot header: no snapshot at all
          (`collectedAt` null) versus a snapshot that recognized no
          metric rows — two different facts, never conflated (the review
          round's P2). The no-snapshot wording adapts to the attention
          notice: a blocked account gets the honest line, a healthy one
          the waiting sentence. -->
        <p
          v-else-if="lastQuota !== null && lastQuota.collectedAt === null"
          class="status"
          data-testid="overview-no-snapshot"
        >
          {{ noSnapshotText }}
        </p>
        <p
          v-else-if="lastQuota !== null && lastQuota.metrics.length === 0"
          class="status"
          data-testid="overview-no-metrics"
        >
          {{ t('overview.empty.noMetrics') }}
        </p>
      </template>
    </template>

    <!-- The page-level no-accounts guidance (task 173, §14.3): the
      actionable next step is the link — the wording harmonizes with
      the accounts page's own empty state (task 170). -->
    <div v-else-if="listLoaded" class="empty" data-testid="overview-empty">
      <h3>{{ t('overview.empty.noAccountsTitle') }}</h3>
      <p>{{ t('overview.empty.noAccountsHint') }}</p>
      <RouterLink to="/accounts" data-testid="overview-empty-cta">
        {{ t('overview.empty.cta') }}
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.page .status,
.page .empty p {
  color: var(--qm-color-muted);
}

.load-failure {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.load-failure button,
.history-controls button,
.selector select {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
}

.history-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin-top: 0.75rem;
}

.history-controls button:disabled,
.load-failure button:disabled {
  color: var(--qm-color-muted);
  cursor: not-allowed;
}

.selector {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
}

.selector label {
  color: var(--qm-color-muted);
}

.selector select {
  padding: 0.25rem 0.5rem;
}

.empty h3 {
  margin: 1rem 0 0;
}

.empty a {
  display: inline-block;
  margin-top: 0.35rem;
  color: var(--qm-color-foreground);
}

/* The metric cards flow as a responsive grid; the range controls sit
  between the account card and this region (§14.4). */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.75rem;
  margin-top: 0.75rem;
}

/* The §14.4 charts (task 175): one chart per metric, one compatible unit
   per chart; the grid reflows cards beside each other where the viewport
   allows. The `min(100%, …)` floor keeps the track from exceeding the
   content width — §14.1's 360 px viewport (296 px of content beside the
   shell margins) must never gain horizontal overflow. */
.charts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.charts-header {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 1rem;
}

.charts-header h3 {
  margin: 0;
  font-size: 1.125rem;
}

.charts-header button {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.125rem 0.625rem;
}

.zoom-status {
  grid-column: 1 / -1;
  margin: 0;
}
</style>
