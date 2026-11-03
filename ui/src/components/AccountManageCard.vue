<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AccountView } from '../../../src/schemas/api/accounts';
import ApiErrorNotice from './ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';

// The selected account's management card (task 170, spec §14.2, §8.2;
// decision D-135): the identity facts and one action group per §14.2
// verb — test, rename, enable/disable, replace key, archive, purge.
// Every action is its own `useApiCall` (the D-134 page contract: one
// composable per request, failures through the shared notice), and a
// successful mutation emits for the parent to reload the list — the
// server's responses are the truth, the card never patches its props
// from them.
//
// §8.2's lifecycle semantics shape the affordances (D-135): an archived
// account is terminal — every PATCH and the test are refused by the
// server (`account-archived`) — so the card renders no rename, polling,
// replace-key, or archive controls for one (the notice states the
// retained-history state), renders the test button disabled, and keeps
// only the purge available (the §8.2 follow-up that removes the
// retained history). The environment-sourced key is read-only (§6.3,
// `environment-key-read-only`): the replace-key form is simply not
// offered — the facts row states the source instead.
const { t } = useI18n();
const api = useApi();

const props = defineProps<{
  /** The account being managed (one row of `GET /api/accounts`). */
  readonly account: AccountView;
  /** The provider's display name (the parent's id→name map, id fallback). */
  readonly providerName: string;
}>();

const emit = defineEmits<{
  /** A mutation succeeded; the parent reloads the accounts list. */
  changed: [];
  /** The account was archived or purged; the parent reloads the list. */
  removed: [];
}>();

const archived = computed(() => props.account.status === 'archived');
const statusLabel = computed(() =>
  archived.value ? t('accounts.card.statusArchived') : t('accounts.card.statusActive'),
);
const keyState = computed(() => {
  if (props.account.keySource === 'environment') return t('accounts.card.keyEnvironment');
  // The §13 mask is content-free by construction (D-128) — rendering it
  // verbatim is the whole point; no key material exists on this side.
  return props.account.hasKey ? (props.account.keyMask ?? '') : t('accounts.card.keyNone');
});

/* ── Connection test (§14.2: the result shows immediately) ───────────── */

const {
  data: testData,
  error: testError,
  pending: testPending,
  execute: runTest,
  reset: resetTest,
} = useApiCall(() => api.accounts.test(props.account.id));
// The §13 outcome vocabulary is a discriminated union; the message rides
// only the non-ok outcomes and is provider-authored sanitized English
// (D-052) — a schema-validated success body, inside D-134's trusted-cast
// boundary, so it renders beside the catalog sentence.
const testOutcome = computed(() => testData.value?.outcome ?? null);
const testMessage = computed(() => {
  const result = testData.value;
  return result !== null && 'message' in result ? result.message : null;
});

/* ── Rename ──────────────────────────────────────────────────────────── */

const renaming = ref(false);
const renameLabel = ref('');
const renameFieldError = ref(false);
const renameInput = ref<HTMLInputElement | null>(null);
const {
  error: renameError,
  pending: renamePending,
  execute: executeRename,
  reset: resetRename,
} = useApiCall(() => api.accounts.update(props.account.id, { label: renameLabel.value.trim() }));

async function startRename(): Promise<void> {
  // A fresh open carries no previous attempt's failure (D-135: a stale
  // role="alert" must not re-announce itself on re-open).
  resetRename();
  renameLabel.value = props.account.label;
  renameFieldError.value = false;
  renaming.value = true;
  await nextTick();
  renameInput.value?.focus();
}

function cancelRename(): void {
  renaming.value = false;
  renameFieldError.value = false;
  resetRename();
}

async function saveRename(): Promise<void> {
  renameFieldError.value = renameLabel.value.trim() === '';
  if (renameFieldError.value) return;
  const updated = await executeRename();
  if (updated !== null) {
    renaming.value = false;
    emit('changed');
  }
}

/* ── Enable/disable polling ─────────────────────────────────────────── */

const {
  error: toggleError,
  pending: togglePending,
  execute: executeToggle,
} = useApiCall(() => api.accounts.update(props.account.id, { enabled: !props.account.enabled }));

async function togglePolling(): Promise<void> {
  if ((await executeToggle()) !== null) emit('changed');
}

/* ── Replace key (write-only, §14.2) ────────────────────────────────── */

const replacingKey = ref(false);
const newKey = ref('');
const keyFieldError = ref(false);
const keyInput = ref<HTMLInputElement | null>(null);
const {
  error: replaceKeyError,
  pending: replaceKeyPending,
  execute: executeReplaceKey,
  reset: resetReplaceKey,
} = useApiCall(() => api.accounts.update(props.account.id, { apiKey: newKey.value }));

async function startReplaceKey(): Promise<void> {
  // Never prefilled (§14.2 write-only): the field starts empty every time.
  resetReplaceKey();
  newKey.value = '';
  keyFieldError.value = false;
  replacingKey.value = true;
  await nextTick();
  keyInput.value?.focus();
}

function cancelReplaceKey(): void {
  replacingKey.value = false;
  keyFieldError.value = false;
  newKey.value = '';
  resetReplaceKey();
}

async function saveReplaceKey(): Promise<void> {
  keyFieldError.value = newKey.value.trim() === '';
  if (keyFieldError.value) return;
  const updated = await executeReplaceKey();
  // The typed key never survives the attempt, success or failure.
  newKey.value = '';
  if (updated !== null) {
    replacingKey.value = false;
    // A test verdict describes the credential it ran against: the old
    // key's result does not survive its replacement.
    resetTest();
    emit('changed');
  }
}

/* ── Archive (§8.2 default: history kept; terminal per D-061) ────────── */

const confirmingArchive = ref(false);
const archiveCancelButton = ref<HTMLButtonElement | null>(null);
const {
  error: archiveError,
  pending: archivePending,
  execute: executeArchive,
  reset: resetArchive,
} = useApiCall(() => api.accounts.remove(props.account.id));

async function openArchiveConfirm(): Promise<void> {
  resetArchive();
  confirmingArchive.value = true;
  // Focus lands on the safe control first (keyboard users reach the
  // destructive button only deliberately).
  await nextTick();
  archiveCancelButton.value?.focus();
}

function cancelArchive(): void {
  confirmingArchive.value = false;
  resetArchive();
}

async function confirmArchive(): Promise<void> {
  if ((await executeArchive()) !== null) {
    confirmingArchive.value = false;
    emit('removed');
  }
}

/* ── Purge (§8.2's separate explicit action; typed confirmation) ─────── */

const confirmingPurge = ref(false);
const purgeTyped = ref('');
const purgeInput = ref<HTMLInputElement | null>(null);
const {
  error: purgeError,
  pending: purgePending,
  execute: executePurge,
  reset: resetPurge,
} = useApiCall(() => api.accounts.remove(props.account.id, { purgeHistory: true }));

// The gate: the exact current label, typed — compared trimmed on BOTH
// sides, because a label with surrounding whitespace (however created)
// must never make the confirmation unsatisfiable and the account
// unpurgeable from the UI. The destructive flag leaves the client only
// behind this match (the task-170 confirmation the §13
// `?purgeHistory=true` spelling was waiting for).
const purgeReady = computed(() => purgeTyped.value.trim() === props.account.label.trim());

async function openPurgeConfirm(): Promise<void> {
  resetPurge();
  purgeTyped.value = '';
  confirmingPurge.value = true;
  await nextTick();
  purgeInput.value?.focus();
}

function cancelPurge(): void {
  confirmingPurge.value = false;
  purgeTyped.value = '';
  resetPurge();
}

async function confirmPurge(): Promise<void> {
  if (!purgeReady.value) return;
  if ((await executePurge()) !== null) {
    confirmingPurge.value = false;
    emit('removed');
  }
}
</script>

<template>
  <article class="manage-card" data-testid="account-card">
    <h3>{{ account.label }}</h3>
    <dl class="facts">
      <div>
        <dt>{{ t('accounts.card.provider') }}</dt>
        <dd>{{ providerName }}</dd>
      </div>
      <div>
        <dt>{{ t('accounts.card.status') }}</dt>
        <dd>{{ statusLabel }}</dd>
      </div>
      <div>
        <dt>{{ t('accounts.card.polling') }}</dt>
        <dd>
          {{ account.enabled ? t('accounts.card.pollingOn') : t('accounts.card.pollingOff') }}
        </dd>
      </div>
      <div>
        <dt>{{ t('accounts.card.key') }}</dt>
        <dd>{{ keyState }}</dd>
      </div>
    </dl>
    <p v-if="archived" class="notice" data-testid="archived-notice">
      {{ t('accounts.card.archivedNotice') }}
    </p>

    <!-- Connection test: the outcome renders immediately in a polite
      status region (§14.2); disabled without a key — the server would
      only refuse (`no-key-configured`). -->
    <div class="action-block">
      <button
        type="button"
        data-testid="test-button"
        :disabled="archived || !account.hasKey || testPending"
        @click="runTest"
      >
        {{ testPending ? t('accounts.actions.testPending') : t('accounts.actions.test') }}
      </button>
      <p
        v-if="testOutcome !== null"
        class="test-result"
        :class="{ rejected: testOutcome === 'rejected' }"
        role="status"
        data-testid="test-result"
        :data-outcome="testOutcome"
      >
        <!-- Explicit branches keep every t() key a static literal (the
          both-directions catalog rule, D-132). -->
        <template v-if="testOutcome === 'ok'">{{ t('accounts.test.ok') }}</template>
        <template v-else-if="testOutcome === 'rejected'">{{
          t('accounts.test.rejected')
        }}</template>
        <template v-else>{{ t('accounts.test.unavailable') }}</template>
        <!-- The separating dash is decorative punctuation, rendered
          through CSS (a text node here would be raw text, D-132). -->
        <span v-if="testMessage" class="detail">{{ testMessage }}</span>
      </p>
      <ApiErrorNotice v-if="testError" :error="testError" />
    </div>

    <template v-if="!archived">
      <!-- Rename: an inline form prefilled with the current label (the
        label is not a secret — prefilling is the point). -->
      <div class="action-block">
        <form v-if="renaming" class="inline-form" novalidate @submit.prevent="saveRename">
          <label for="rename-label">{{ t('accounts.actions.renameField') }}</label>
          <input
            id="rename-label"
            ref="renameInput"
            v-model="renameLabel"
            data-testid="rename-input"
            type="text"
            :aria-invalid="renameFieldError || undefined"
          />
          <button type="submit" data-testid="rename-save" :disabled="renamePending">
            {{ t('accounts.actions.save') }}
          </button>
          <button type="button" data-testid="rename-cancel" @click="cancelRename">
            {{ t('accounts.actions.cancel') }}
          </button>
          <p v-if="renameFieldError" class="field-error" role="alert">
            {{ t('accounts.form.errorLabelRequired') }}
          </p>
          <ApiErrorNotice v-if="renameError" :error="renameError" />
        </form>
        <button v-else type="button" data-testid="rename-button" @click="startRename">
          {{ t('accounts.actions.rename') }}
        </button>
      </div>

      <!-- Polling toggle: an explicit action, not a checkbox — the
        state change is a server mutation either way. -->
      <div class="action-block">
        <button
          type="button"
          data-testid="toggle-polling"
          :disabled="togglePending"
          @click="togglePolling"
        >
          {{
            account.enabled
              ? t('accounts.actions.disablePolling')
              : t('accounts.actions.enablePolling')
          }}
        </button>
        <ApiErrorNotice v-if="toggleError" :error="toggleError" />
      </div>

      <!-- Replace key: only for file-sourced keys — the environment is
        the operator's channel (§6.3), the facts row already says so. -->
      <div v-if="account.keySource === 'file'" class="action-block">
        <form v-if="replacingKey" class="inline-form" novalidate @submit.prevent="saveReplaceKey">
          <label for="replace-key">{{ t('accounts.actions.keyField') }}</label>
          <input
            id="replace-key"
            ref="keyInput"
            v-model="newKey"
            data-testid="replace-key-input"
            type="password"
            autocomplete="new-password"
            :aria-invalid="keyFieldError || undefined"
          />
          <p class="hint">{{ t('accounts.actions.keyHint') }}</p>
          <button type="submit" data-testid="replace-key-save" :disabled="replaceKeyPending">
            {{ t('accounts.actions.save') }}
          </button>
          <button type="button" data-testid="replace-key-cancel" @click="cancelReplaceKey">
            {{ t('accounts.actions.cancel') }}
          </button>
          <p v-if="keyFieldError" class="field-error" role="alert">
            {{ t('accounts.form.errorKeyBlank') }}
          </p>
          <ApiErrorNotice v-if="replaceKeyError" :error="replaceKeyError" />
        </form>
        <button v-else type="button" data-testid="replace-key-button" @click="startReplaceKey">
          {{ t('accounts.actions.replaceKey') }}
        </button>
      </div>

      <!-- Archive: a two-step inline confirm (terminal per D-061 — the
        body says so); the DELETE carries no purge flag at all. -->
      <div class="action-block">
        <button
          v-if="!confirmingArchive"
          type="button"
          data-testid="archive-button"
          @click="openArchiveConfirm"
        >
          {{ t('accounts.actions.archive') }}
        </button>
        <div v-else class="confirm-panel" data-testid="archive-confirm">
          <h4>{{ t('accounts.archive.title') }}</h4>
          <p>{{ t('accounts.archive.body') }}</p>
          <button
            type="button"
            ref="archiveCancelButton"
            data-testid="archive-cancel"
            @click="cancelArchive"
          >
            {{ t('accounts.actions.cancel') }}
          </button>
          <button
            type="button"
            class="danger"
            data-testid="archive-confirm-button"
            :disabled="archivePending"
            @click="confirmArchive"
          >
            {{ t('accounts.archive.confirm') }}
          </button>
          <ApiErrorNotice v-if="archiveError" :error="archiveError" />
        </div>
      </div>
    </template>

    <!-- Purge: available for active and archived accounts alike (§8.2's
      separate explicit action over the retained history). The typed
      label is the confirmation; the destructive flag never leaves the
      client before it matches. -->
    <div class="action-block">
      <button
        v-if="!confirmingPurge"
        type="button"
        class="danger"
        data-testid="purge-button"
        @click="openPurgeConfirm"
      >
        {{ t('accounts.purge.action') }}
      </button>
      <div v-else class="confirm-panel danger-panel" data-testid="purge-confirm">
        <h4>{{ t('accounts.purge.title') }}</h4>
        <p>{{ t('accounts.purge.body') }}</p>
        <label for="purge-confirm-input">
          {{ t('accounts.purge.typeLabel', { label: account.label }) }}
        </label>
        <input
          id="purge-confirm-input"
          ref="purgeInput"
          v-model="purgeTyped"
          data-testid="purge-confirm-input"
          type="text"
          autocomplete="off"
        />
        <div class="confirm-buttons">
          <button type="button" data-testid="purge-cancel" @click="cancelPurge">
            {{ t('accounts.actions.cancel') }}
          </button>
          <button
            type="button"
            class="danger"
            data-testid="purge-confirm-button"
            :disabled="!purgeReady || purgePending"
            @click="confirmPurge"
          >
            {{ t('accounts.purge.confirm') }}
          </button>
        </div>
        <ApiErrorNotice v-if="purgeError" :error="purgeError" />
      </div>
    </div>
  </article>
</template>

<style scoped>
.manage-card {
  border: 1px solid var(--qm-color-muted);
  border-radius: 6px;
  margin-top: 1.5rem;
  max-width: 40rem;
  padding: 1rem 1.25rem;
}

.manage-card h3 {
  margin: 0 0 0.75rem;
}

.facts {
  display: grid;
  gap: 0.25rem;
  margin: 0 0 1rem;
}

.facts > div {
  display: grid;
  grid-template-columns: 8rem 1fr;
  gap: 0.5rem;
}

.facts dt {
  color: var(--qm-color-muted);
}

.facts dd {
  margin: 0;
}

.notice {
  color: var(--qm-color-muted);
  font-style: italic;
  margin: 0 0 1rem;
}

.action-block {
  border-top: 1px solid var(--qm-color-muted);
  margin-top: 0.75rem;
  padding-top: 0.75rem;
}

.inline-form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
}

.inline-form label {
  color: var(--qm-color-muted);
}

.inline-form input {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.5rem;
}

button {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
}

button:disabled {
  color: var(--qm-color-muted);
}

/* The destructive actions keep the token palette (D-133) and pair the
  color with their words (§14.1 never-color-alone). */
button.danger {
  border-color: var(--qm-color-danger);
}

.confirm-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.confirm-panel.danger-panel {
  border: 1px solid var(--qm-color-danger);
  background-color: var(--qm-color-danger-background);
  border-radius: 6px;
  padding: 0.75rem;
}

.confirm-panel h4 {
  margin: 0;
}

.confirm-panel p {
  margin: 0;
  max-width: 36rem;
}

.confirm-panel label {
  color: var(--qm-color-foreground);
}

.confirm-panel input {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.5rem;
}

.confirm-buttons {
  display: flex;
  gap: 0.5rem;
}

.test-result {
  margin: 0.5rem 0 0;
}

/* Only the provider-rejected outcome borrows the danger tint — the
  inconclusive one is not a failure verdict (§7.2 keeps them apart). */
.test-result.rejected {
  color: var(--qm-color-danger);
}

/* The decorative dash between the catalog sentence and the provider's
  own detail (kept out of the text nodes, D-132). */
.test-result .detail::before {
  content: '— ';
}

.hint {
  color: var(--qm-color-muted);
  margin: 0;
}

.field-error {
  color: var(--qm-color-danger);
  margin: 0;
}
</style>
