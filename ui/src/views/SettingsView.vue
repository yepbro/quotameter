<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
// Settings page placeholder (spec §14.5): polling interval, time-zone
// search, retention, theme, password change, the read-only peak schedule,
// and the paths display arrive with task 179.
//
// Task 169's canonical error wiring (D-134), identical to every other
// page's: the health probe rides along until task 179's real calls
// (settings get/update) replace it.
const { t } = useI18n();
const api = useApi();
const { error: healthError, execute: loadHealth } = useApiCall(() => api.health.get());
void loadHealth();
</script>

<template>
  <section class="page">
    <h2>{{ t('settings.title') }}</h2>
    <p data-testid="page-status">{{ t('settings.status') }}</p>
    <ApiErrorNotice v-if="healthError" :error="healthError" />
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
