<script setup lang="ts">
import { useI18n } from 'vue-i18n';
// Settings page placeholder (spec §14.5): polling interval, time-zone
// search, retention, theme, password change, the read-only peak schedule,
// and the paths display arrive with task 179.
const { t } = useI18n();
</script>

<template>
  <section class="page">
    <h2>{{ t('settings.title') }}</h2>
    <p data-testid="page-status">{{ t('settings.status') }}</p>
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
