<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from './ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
import { MIN_PASSWORD_LENGTH } from '../settings-fields';

// The §15.2 password change (task 179, spec §14.5; decision D-156): the
// PUT's `auth.password` channel — the UI's only sanctioned password
// setter beside the CLI (`passwd` owns the terminal; D-118). Rendered in
// BOTH auth modes: `auto` uses a password on the non-loopback/proxied
// paths (§15.1), so the section must not vanish for an operator who set
// one — the state line states the configured fact instead.
//
// The §15.2/§15.4 write-only discipline is the accounts key field's
// (D-136): a masked input that is never prefilled and is cleared after
// EVERY submit attempt, success and refusal alike. The §15.2 minimum is
// guarded client-side on the raw untrimmed value (the server re-owns the
// rule); the D-124/D-126 consequence — a change revokes every session,
// including the one that made it — is stated before the change and again
// as the success notice.
const { t } = useI18n();
const api = useApi();

const props = defineProps<{
  /** Whether a password hash is stored (§13's mask-and-boolean). */
  readonly passwordConfigured: boolean;
}>();

const password = ref('');
const lengthError = ref(false);
/** The change took effect — the revocation consequence rides it. */
const changed = ref(false);

const { error, pending, execute } = useApiCall(() =>
  api.settings.update({ auth: { password: password.value } }),
);

// The configured fact is local-or-served: a successful change flipped it
// (the PUT's own success is the freshest evidence — the parent's next
// settings reload would say the same, and this form does not trigger
// one), and a stale "No password is set." beside the success notice
// would contradict the change the operator just made.
const configured = computed(() => props.passwordConfigured || changed.value);

async function submit(): Promise<void> {
  // Whitespace is never a value (D-011) and the §15.2 minimum binds the
  // raw value — both refuse here, before any request.
  lengthError.value = password.value.trim() === '' || password.value.length < MIN_PASSWORD_LENGTH;
  if (lengthError.value) return;
  const outcome = await execute();
  // Write-only: a submitted password never survives the attempt.
  password.value = '';
  if (outcome !== null) changed.value = true;
}
</script>

<template>
  <form class="password" data-testid="settings-password" novalidate @submit.prevent="submit">
    <h3>{{ t('settings.password.heading') }}</h3>

    <p class="state" data-testid="settings-password-configured">
      {{ configured ? t('settings.password.configured') : t('settings.password.notSet') }}
    </p>

    <div class="field">
      <label for="settings-password-input">{{ t('settings.password.field') }}</label>
      <!-- Write-only by construction: masked, never prefilled, and
        cleared after every attempt (§15.4). -->
      <input
        id="settings-password-input"
        v-model="password"
        data-testid="settings-password-input"
        type="password"
        autocomplete="new-password"
        :disabled="pending"
        :aria-invalid="lengthError || undefined"
      />
      <p class="hint">{{ t('settings.password.hint', { min: MIN_PASSWORD_LENGTH }) }}</p>
      <p v-if="lengthError" class="field-error" role="alert">
        {{ t('settings.password.errorShort', { min: MIN_PASSWORD_LENGTH }) }}
      </p>
    </div>

    <button type="submit" data-testid="settings-password-submit" :disabled="pending">
      {{ pending ? t('settings.password.pending') : t('settings.password.submit') }}
    </button>

    <p v-if="changed" class="status" role="status" data-testid="settings-password-changed">
      {{ t('settings.password.changed') }}
    </p>

    <ApiErrorNotice v-if="error" :error="error" />
  </form>
</template>

<style scoped>
.password {
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 1rem;
  max-width: 32rem;
  padding: 1rem;
}

.state,
.hint,
.field-error,
.status {
  margin: 0;
}

.state,
.hint {
  color: var(--qm-color-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  color: var(--qm-color-muted);
}

.field input {
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

.field-error {
  color: var(--qm-color-danger);
}

.status {
  color: var(--qm-color-foreground);
}
</style>
