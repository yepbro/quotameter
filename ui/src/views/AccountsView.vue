<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AccountView } from '../../../src/schemas/api/accounts';
import type { ProviderView } from '../../../src/schemas/api/providers';
import AccountAddForm from '../components/AccountAddForm.vue';
import AccountManageCard from '../components/AccountManageCard.vue';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
import { useAccountSelection } from '../account-selection';

// The account-management page (task 170, spec §14.2, §8.2; decision
// D-135): the account selector and the management surface — the selected
// account's card plus the add form. The page owns the two loads (the
// accounts list and the available provider types), one `useApiCall` per
// request (D-134); the mutations live in the card, which emits for this
// component to reload the list — the server's list is the single source
// of truth, and the reload is also what keeps the selection coherent.
//
// A load failure is not an empty list (D-135's failed-load rule):
// `useApiCall` nulls its data on failure, so the page keeps its own
// last-good copies — a failed reload leaves the previous list rendered
// beside the failure notice and a retry, and the empty state renders
// only when a completed load actually answered zero accounts.
const { t } = useI18n();
const api = useApi();
const selection = useAccountSelection();

const {
  data: listData,
  error: listError,
  pending: listPending,
  execute: reload,
} = useApiCall(() => api.accounts.list());

// The add form's provider options and the card's provider display name.
const {
  data: providersData,
  error: providersError,
  execute: reloadProviders,
} = useApiCall(() => api.providers.list());

void reload();
void reloadProviders();

/** The last successfully loaded list — the rendered truth (see above). */
const lastAccounts = ref<ReadonlyArray<AccountView>>([]);
/** Whether the accounts list has loaded successfully at least once. */
const listLoaded = ref(false);
/** The last successfully loaded providers (same rule as the list). */
const lastProviders = ref<ReadonlyArray<ProviderView>>([]);
/** Whether the providers list has loaded successfully at least once. */
const providersLoaded = ref(false);

watch(listData, (data) => {
  if (data === null) return;
  lastAccounts.value = data.accounts;
  listLoaded.value = true;
});
watch(providersData, (data) => {
  if (data === null) return;
  lastProviders.value = data.providers;
  providersLoaded.value = true;
});

const accounts = computed(() => lastAccounts.value);
const providers = computed(() => lastProviders.value);

// The selector's option text: the label plus the archived marker — a
// text marker, never color alone (§14.1).
function optionText(account: AccountView): string {
  return account.status === 'archived'
    ? `${account.label} (${t('accounts.card.statusArchived')})`
    : account.label;
}

// Selection reconciliation (the store's documented consumer rule): keep
// the stored id while it is listed, else the first account, else none —
// re-run on every completed list load, so a renamed-away selection
// survives (ids are stable) and a purged one moves on. It runs only
// once the list HAS loaded: reconciling against the empty pre-load (or
// failed-load) state would wipe a stored choice that the arriving list
// would have honored. Persisted through the store, best effort.
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

// The DOM select is a string boundary: any unknown value stays unset
// (the reconciliation owns the state; this handler only forwards).
function onSelect(event: Event): void {
  const { value } = event.target as HTMLSelectElement;
  selection.select(value === '' ? null : value);
}

const providerNameOf = computed(() => {
  const names = new Map(providers.value.map((provider) => [provider.id, provider.name]));
  return (account: AccountView): string => names.get(account.providerId) ?? account.providerId;
});

function onAccountChanged(): void {
  void reload();
}

/** The selector the removed account's focus hand-off targets (task 181). */
const accountSelect = ref<HTMLSelectElement | null>(null);

/**
 * A removed account takes its whole card — and the focused control
 * inside it — out of the DOM: after the list settles, focus moves to
 * the selector (the management surface's stable control) instead of
 * falling to the document body. The last account's removal unmounts
 * the selector too; the honest degradation is the body (the add form
 * below remains the next tab stop's page flow).
 */
async function onAccountRemoved(): Promise<void> {
  await reload();
  await nextTick();
  accountSelect.value?.focus();
}

function onAccountCreated(): void {
  void reload();
}
</script>

<template>
  <section class="page">
    <h2>{{ t('accounts.title') }}</h2>

    <p v-if="listPending && !listLoaded" class="status" data-testid="accounts-loading">
      {{ t('accounts.loading') }}
    </p>

    <!-- One notice per failed request (D-134): the two loads fail
      independently and each failure is presented on its own — beside a
      retry, never as a fake empty state. -->
    <div v-if="listError" class="load-failure">
      <ApiErrorNotice :error="listError" />
      <button type="button" data-testid="accounts-retry" @click="reload">
        {{ t('accounts.retry') }}
      </button>
    </div>
    <ApiErrorNotice v-if="providersError" :error="providersError" />

    <template v-if="accounts.length > 0">
      <div class="selector">
        <label for="account-select">{{ t('accounts.selector.label') }}</label>
        <select
          id="account-select"
          ref="accountSelect"
          data-testid="account-select"
          :value="selection.selectedId.value"
          @change="onSelect"
        >
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ optionText(account) }}
          </option>
        </select>
      </div>

      <AccountManageCard
        v-if="selected !== null"
        :key="selected.id"
        :account="selected"
        :provider-name="providerNameOf(selected)"
        @changed="onAccountChanged"
        @removed="onAccountRemoved"
      />
    </template>

    <div v-else-if="listLoaded" class="empty" data-testid="accounts-empty">
      <h3>{{ t('accounts.empty.title') }}</h3>
      <p>{{ t('accounts.empty.hint') }}</p>
    </div>

    <AccountAddForm
      :providers="providers"
      :providers-loaded="providersLoaded"
      @created="onAccountCreated"
    />
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
</style>
