<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { AccountView } from '../../../src/schemas/api/accounts';
import type { ProviderView } from '../../../src/schemas/api/providers';
import type { QuotaResponse, StatusResponse } from '../../../src/schemas/api/status';
import { accountAttentionOf } from '../account-attention';
import AccountAttentionNotice from '../components/AccountAttentionNotice.vue';
import AccountOverviewCard from '../components/AccountOverviewCard.vue';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import MetricCard from '../components/MetricCard.vue';
import { useApi, useApiCall } from '../api';
import { useAccountSelection } from '../account-selection';

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
// Five loads, one `useApiCall` each (D-134): the accounts list (selector
// + identity), the providers list (provider names AND the metric-label
// catalog, D-137), the §7.3 status rows, the settings view (exactly the
// configured display time zone, §14.1), and the selected account's quota
// (re-run on every selection change). A failed load is never a fake
// empty state (D-135's rule): each call keeps its own last-good copy —
// a failed reload leaves the previous surface rendered beside the
// failure notice — and the quota copy is cleared on a selection switch
// so one account's values can never render as another's.
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
function validatedQuotaTarget(): string | null {
  const id = selection.selectedId.value;
  if (id === null || !listLoaded.value) return null;
  return lastAccounts.value.some((account) => account.id === id) ? id : null;
}

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
  validatedQuotaTarget,
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

        <!-- The account-level attention notice (task 173, D-138):
          rendered only when a blocker exists — a healthy account sees
          nothing here. -->
        <AccountAttentionNotice v-if="attention !== null" :attention="attention" />

        <!-- Task 174's seam: the rolling-range controls mount above this
          region (spec §14.4); the metric cards are the §14.3 surface. -->
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
.selector select {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
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

/* Task 174's layout seam: the cards flow as a responsive grid today;
  the range controls will sit between the account card and this region. */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.75rem;
  margin-top: 0.75rem;
}
</style>
