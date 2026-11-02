<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { isTheme, useTheme } from './theme';
// Application shell (spec §14.1): the persistent layout around the routed
// pages — the site header with the application title and the primary
// navigation, and the single main landmark the router renders into.
// The nav carries the three always-present sections; the login entry is
// auth-state dependent (§14.6) and arrives with task 180 as a seam on
// this layout. Every string renders through the English catalog
// (§14.1, D-132).
const { t } = useI18n();
// Theme selection (§14.1, D-133): the shell-level control; the settings
// page (task 179) reuses the same controller seam.
const { theme, setTheme } = useTheme();

// The select is a DOM string boundary — validate before the typed setter.
function onThemeSelect(event: Event): void {
  const { value } = event.target as HTMLSelectElement;
  if (isTheme(value)) setTheme(value);
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
</style>
