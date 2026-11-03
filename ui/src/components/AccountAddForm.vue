<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProviderView } from '../../../src/schemas/api/providers';
import ApiErrorNotice from './ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';

// The add-account form (task 170, spec §14.2, §5.3; decision D-135): the
// create half of the management surface. The provider options come from
// `GET /api/providers` (§13's available types — the parent loads them
// beside the accounts list); the key is optional per §5.3's "skip the
// key, add it later in the UI", and write-only: a masked input that is
// never prefilled and never echoed (only its presence travels, in the
// POST body). Client-side guards refuse a blank label or a blank key
// without a request (the server would answer VALIDATION — D-011's blank
// rule — but the field error is cheaper and keeps the form honest).
const { t } = useI18n();
const api = useApi();

const props = defineProps<{
  /** The available provider types (§13), in registration order. */
  readonly providers: ReadonlyArray<ProviderView>;
  /**
   * Whether the providers list has loaded successfully — distinguishes
   * the honest "this build has no providers" (loaded and empty) from a
   * failed load (the parent renders that failure's own notice; the form
   * stays disabled without claiming anything about the build).
   */
  readonly providersLoaded: boolean;
}>();

const emit = defineEmits<{
  /** A create succeeded; the parent reloads the accounts list. */
  created: [];
}>();

const providerId = ref('');
const label = ref('');
// The write-only key: bound to a password input, cleared after every
// submit attempt (success and failure alike) so nothing lingers.
const apiKey = ref('');
const labelError = ref(false);
const keyError = ref(false);

const { error, pending, execute } = useApiCall(() =>
  api.accounts.create({
    providerId: providerId.value,
    // Trimmed: the label the server stores is canonical, so no surface
    // downstream (the purge gate's typed compare included) ever meets a
    // padded label this form created.
    label: label.value.trim(),
    // Omitted entirely when empty — the §5.3 keyless account.
    ...(apiKey.value === '' ? {} : { apiKey: apiKey.value }),
  }),
);

// The provider default: the first available type, (re)applied only
// while no valid choice is present — an explicit user pick survives a
// reload of the list, a stale pick (its type gone from the build) is
// corrected rather than left to fail server validation.
watch(
  () => props.providers,
  (providers) => {
    if (providers.length === 0 || providers.some((p) => p.id === providerId.value)) return;
    providerId.value = providers[0]!.id;
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  // Field guards first (trim-only: the server owns every other rule).
  labelError.value = label.value.trim() === '';
  keyError.value = apiKey.value !== '' && apiKey.value.trim() === '';
  if (labelError.value || keyError.value) return;
  const created = await execute();
  // One-shot either way: a submitted key never survives the attempt.
  apiKey.value = '';
  if (created !== null) {
    label.value = '';
    labelError.value = false;
    emit('created');
  }
}
</script>

<template>
  <form class="add-form" data-testid="add-account-form" novalidate @submit.prevent="submit">
    <h3>{{ t('accounts.add.title') }}</h3>
    <fieldset :disabled="providers.length === 0">
      <div class="field">
        <label for="add-provider">{{ t('accounts.add.provider') }}</label>
        <select id="add-provider" v-model="providerId" data-testid="add-provider">
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">
            {{ provider.name }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="add-label">{{ t('accounts.add.label') }}</label>
        <input
          id="add-label"
          v-model="label"
          data-testid="add-label"
          type="text"
          :aria-invalid="labelError || undefined"
        />
        <p v-if="labelError" class="field-error" role="alert">
          {{ t('accounts.form.errorLabelRequired') }}
        </p>
      </div>
      <div class="field">
        <label for="add-key">{{ t('accounts.add.key') }}</label>
        <!-- Write-only by construction (§14.2): a password input that
          starts empty, carries autocomplete="new-password" so browsers
          stop offering logins, and is cleared after every attempt. -->
        <input
          id="add-key"
          v-model="apiKey"
          data-testid="add-key"
          type="password"
          autocomplete="new-password"
          :aria-invalid="keyError || undefined"
        />
        <p class="hint">{{ t('accounts.add.keyHint') }}</p>
        <p v-if="keyError" class="field-error" role="alert">
          {{ t('accounts.form.errorKeyBlank') }}
        </p>
      </div>
      <button type="submit" :disabled="pending || providers.length === 0">
        {{ pending ? t('accounts.add.pending') : t('accounts.add.submit') }}
      </button>
      <p v-if="providersLoaded && providers.length === 0" class="hint">
        {{ t('accounts.add.noProviders') }}
      </p>
    </fieldset>
    <ApiErrorNotice v-if="error" :error="error" />
  </form>
</template>

<style scoped>
.add-form {
  margin-top: 2rem;
  max-width: 32rem;
}

.add-form fieldset {
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0;
  padding: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  color: var(--qm-color-muted);
}

.field input,
.field select {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.5rem;
}

button {
  align-self: flex-start;
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

.hint {
  color: var(--qm-color-muted);
  margin: 0;
}

.field-error {
  color: var(--qm-color-danger);
  margin: 0;
}
</style>
