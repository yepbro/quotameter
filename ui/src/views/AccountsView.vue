<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
// Account management page placeholder (spec §14.2): the selector and the
// add/rename/enable/disable/replace-key/test/archive/purge forms arrive
// with tasks 170+. Routed as a placeholder so the shell's navigation
// surface exists from the start.
//
// Task 169's canonical error wiring (D-134), identical to every other
// page's: the health probe rides along until task 170's real calls
// (accounts list/create/update/remove/test) replace it.
const { t } = useI18n();
const api = useApi();
const { error: healthError, execute: loadHealth } = useApiCall(() => api.health.get());
void loadHealth();
</script>

<template>
  <section class="page">
    <h2>{{ t('accounts.title') }}</h2>
    <p data-testid="page-status">{{ t('accounts.status') }}</p>
    <ApiErrorNotice v-if="healthError" :error="healthError" />
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
