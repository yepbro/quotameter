<script setup lang="ts">
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from './components/ApiErrorNotice.vue';
import { useApi, useApiCall } from './api';
import { LOGIN_ROUTE_NAME } from './router';
import { useSession } from './session';
import { isTheme, useTheme } from './theme';
// Application shell (spec §14.1): the persistent layout around the routed
// pages — the site header with the application title and the primary
// navigation, and the single main landmark the router renders into.
// The nav carries the three always-present sections (§14.6 asks for a
// login PAGE, not a nav entry: the session redirect and the URL reach
// it); the header's sign-out button (task 180, D-159) is §14.6's
// session control. Every string renders through the English catalog
// (§14.1, D-132).
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
// Theme selection (§14.1, D-133): the shell-level control; the settings
// page (task 179) reuses the same controller seam.
const { theme, setTheme } = useTheme();

// The session control (§14.6, task 180, D-159): visible unless the wire
// said "unauthenticated" — 'unknown' honestly covers both a cookie this
// SPA lifetime never observed and the passwordless `auto`-loopback
// world (§15.1), where signing out still clears whatever session the
// browser carried. The login route hides it too (the review round's
// P3-4): an authenticated visitor never sits there (the guard bounces
// them to the preserved destination), so on that page the control is
// noise about a session that has not been proven.
const session = useSession();
const api = useApi();
const {
  error: signOutError,
  pending: signOutPending,
  execute: runSignOut,
  reset: resetSignOut,
} = useApiCall(() => api.auth.logout());
const showSignOut = computed(
  () => session.state.value !== 'unauthenticated' && route.name !== LOGIN_ROUTE_NAME,
);
// A failed sign-out is presented exactly when it did not already
// redirect: a 401 answer means "there was no session to end" and the
// session layer's watcher navigates (a notice would talk over it);
// every other failure (the service unreachable mid-sign-out) earns the
// shared notice in the shell. The computed carries the error itself so
// the template's v-if and binding narrow the same reference.
const signOutFailure = computed(() =>
  signOutError.value !== null && session.state.value !== 'unauthenticated'
    ? signOutError.value
    : null,
);
// The notice belongs to the sign-out interaction: any completed
// navigation abandons it (the review round's P3-3 — the shell persists
// across routes, and a stale "unreachable" line must not ride along);
// a retry re-presents the failure if the condition still holds.
router.afterEach(() => {
  if (!signOutPending.value) resetSignOut();
});

// The select is a DOM string boundary — validate before the typed setter.
function onThemeSelect(event: Event): void {
  const { value } = event.target as HTMLSelectElement;
  if (isTheme(value)) setTheme(value);
}

async function onSignOut(): Promise<void> {
  if (signOutPending.value) return;
  const result = await runSignOut();
  if (result !== null) {
    // Back to knowing nothing — through a DOCUMENT reload, not a router
    // push: the push would be deduped when the current route already IS
    // `/` (no remount, no fresh loads, and under `required` no 401 to
    // drive the redirect), while the reload restarts the SPA honestly
    // at 'unknown' and the next wire answers decide the world — under
    // `required` the fresh overview load's 401 redirects to the login
    // page with `/` preserved; under `auto`-loopback the overview
    // simply renders. Mode-correct routing without mode knowledge, and
    // every in-memory artifact of the authenticated session dies with
    // the document.
    session.signOut();
    window.location.assign('/');
  }
}
</script>

<template>
  <div class="shell">
    <header class="shell-header">
      <h1>{{ t('app.title') }}</h1>
      <nav :aria-label="t('nav.ariaLabel')">
        <ul>
          <li>
            <RouterLink to="/">{{ t('nav.overview') }}</RouterLink>
          </li>
          <li>
            <RouterLink to="/accounts">{{ t('nav.accounts') }}</RouterLink>
          </li>
          <li>
            <RouterLink to="/settings">{{ t('nav.settings') }}</RouterLink>
          </li>
        </ul>
      </nav>
      <div class="theme-control">
        <label for="theme-select">{{ t('app.theme.label') }}</label>
        <select id="theme-select" data-testid="theme-select" :value="theme" @change="onThemeSelect">
          <option value="system">{{ t('app.theme.system') }}</option>
          <option value="light">{{ t('app.theme.light') }}</option>
          <option value="dark">{{ t('app.theme.dark') }}</option>
        </select>
      </div>
      <div v-if="showSignOut" class="session-control">
        <button
          type="button"
          data-testid="session-signout"
          :disabled="signOutPending"
          @click="onSignOut"
        >
          {{ signOutPending ? t('app.session.signOutPending') : t('app.session.signOut') }}
        </button>
      </div>
    </header>
    <ApiErrorNotice v-if="signOutFailure" :error="signOutFailure" />
    <main class="shell-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  margin: 2rem;
}

.shell-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.5rem;
  margin-bottom: 1.5rem;
}

.shell-header h1 {
  margin: 0;
}

.shell-header nav ul {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.shell-header nav a {
  color: var(--qm-color-foreground);
}

.shell-header nav a[aria-current='page'] {
  color: var(--qm-color-muted);
  font-weight: 600;
}

.theme-control {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-left: auto;
}

.theme-control label {
  color: var(--qm-color-muted);
}

.theme-control select {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.125rem 0.25rem;
}

.session-control button {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.125rem 0.5rem;
}

.session-control button:disabled {
  color: var(--qm-color-muted);
}
</style>
