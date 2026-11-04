<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
import { loginReturnTarget, useSession } from '../session';

// The §14.6 login page (task 180, spec §15.1/§15.2; decision D-159):
// the password form for the modes that require one. It is deliberately
// MODE-AGNOSTIC and LOAD-FREE — no request fires on mount, because the
// only mode facts the wire exposes (the settings view) are themselves
// protected in `required` mode (chicken-and-egg for the visitor this
// page exists for), and §15.1's other shape (`auto` + loopback) never
// redirects here anyway: the page stays reachable by URL with nothing
// forcing it, exactly §14.6/§15.1's semantics. The csp-shell e2e cells
// rely on the zero-fetch property — keep it that way.
const { t } = useI18n();
const api = useApi();
const route = useRoute();
const router = useRouter();
const session = useSession();

// §15.1's one credential. Write-only like every secret field (§15.4):
// masked, never prefilled, cleared after every dispatched attempt —
// success and refusal alike. The blank guard is the only client-side
// rule: §15.2's 12-character minimum binds whoever SETS a password
// (init/passwd/the settings page), never the verifier — a shorter or
// padded candidate is simply a failed attempt (D-122), sent verbatim
// and never trimmed (a leading space may be someone's password).
const password = ref('');
const blankError = ref(false);

const { error, pending, execute } = useApiCall(() => api.auth.login({ password: password.value }));

/**
 * The three sentences the login form owns (D-146's wire arms, presented
 * through the D-134 discipline: the envelope's `details.reason` picks a
 * CATALOG sentence and never renders itself — a hostile payload's worst
 * case is choosing which canned sentence shows). Everything else —
 * transport failures, other envelope codes — is the shared notice's
 * business, like every page.
 */
const failure = computed<'incorrect' | 'busy' | 'failed' | null>(() => {
  const thrown = error.value;
  if (thrown === null) return null;
  if (thrown.kind !== 'rejected' || thrown.code !== 'UNAUTHENTICATED') return null;
  const details = thrown.serverDetails as { readonly reason?: unknown } | null | undefined;
  if (details?.reason === 'source-busy') return 'busy';
  if (details?.reason === 'invalid-credentials') return 'incorrect';
  // An absent or unknown reason (a hostile proxy, a future server
  // vocabulary): the generic failure — never a guess about which
  // credential step went wrong.
  return 'failed';
});

async function onSubmit(): Promise<void> {
  if (pending.value) return;
  if (password.value === '') {
    blankError.value = true;
    return;
  }
  blankError.value = false;
  // The call runs under the login family's long deadline: §15.2's
  // budget delays answer slowly by design, and the honest verdict is
  // waited out (see LOGIN_TIMEOUT_MS).
  const running = execute();
  // The write-only clear runs at DISPATCH, on every arm — `execute()`
  // builds the body synchronously, so the attempted candidate is
  // already on the wire and never lingers in the field through the
  // (possibly minutes-long) pending window.
  password.value = '';
  const result = await running;
  if (result !== null) {
    session.markAuthenticated();
    await router.push(loginReturnTarget(route.query.redirect));
  }
}
</script>

<template>
  <section class="page">
    <h2>{{ t('login.title') }}</h2>
    <form data-testid="login-form" class="login-form" novalidate @submit.prevent="onSubmit">
      <div class="login-field">
        <label for="login-password">{{ t('login.field') }}</label>
        <input
          id="login-password"
          v-model="password"
          data-testid="login-password"
          type="password"
          autocomplete="current-password"
          :disabled="pending"
          :aria-invalid="blankError || failure !== null"
        />
      </div>
      <p v-if="blankError" class="login-blank" role="alert" data-testid="login-blank">
        {{ t('login.errorBlank') }}
      </p>
      <p
        v-else-if="failure === 'incorrect'"
        class="login-failure"
        role="alert"
        data-testid="login-failure"
      >
        {{ t('login.errors.incorrect') }}
      </p>
      <p
        v-else-if="failure === 'busy'"
        class="login-failure"
        role="alert"
        data-testid="login-failure"
      >
        {{ t('login.errors.busy') }}
      </p>
      <p
        v-else-if="failure === 'failed'"
        class="login-failure"
        role="alert"
        data-testid="login-failure"
      >
        {{ t('login.errors.failed') }}
      </p>
      <ApiErrorNotice v-else-if="error" :error="error" />
      <p class="login-hint">{{ t('login.delayHint') }}</p>
      <button type="submit" data-testid="login-submit" :disabled="pending">
        {{ pending ? t('login.pending') : t('login.submit') }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.login-form {
  display: grid;
  gap: 0.75rem;
  max-width: 24rem;
}

.login-field {
  display: grid;
  gap: 0.25rem;
}

.login-field label {
  color: var(--qm-color-muted);
}

.login-field input {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.5rem;
}

.login-blank,
.login-failure {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--qm-color-danger);
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-danger-background);
}

.login-hint {
  margin: 0;
  color: var(--qm-color-muted);
}

.login-form button {
  justify-self: start;
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
}

.login-form button:disabled {
  color: var(--qm-color-muted);
}
</style>
