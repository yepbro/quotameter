<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import { useI18n } from 'vue-i18n';
// Application shell (spec §14.1): the persistent layout around the routed
// pages — the site header with the application title and the primary
// navigation, and the single main landmark the router renders into.
// The nav carries the three always-present sections; the login entry is
// auth-state dependent (§14.6) and arrives with task 180 as a seam on
// this layout. Every string renders through the English catalog
// (§14.1, D-132).
const { t } = useI18n();
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
    </header>
    <main class="shell-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  margin: 2rem;
}

.shell-header h1 {
  margin: 0 0 0.5rem;
}

.shell-header nav ul {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
  list-style: none;
  margin: 0 0 1.5rem;
  padding: 0;
}

.shell-header nav a {
  color: var(--qm-color-foreground);
}

.shell-header nav a[aria-current='page'] {
  color: var(--qm-color-muted);
  font-weight: 600;
}
</style>
