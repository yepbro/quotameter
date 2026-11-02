<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
// Login page placeholder (spec §14.6): shown when the active
// authentication mode requires a password (§15.1). The form, the
// auth-mode awareness, and the navigation guards are task 180's; this
// routed placeholder keeps the URL stable while the shell lands.
//
// Task 169's canonical error wiring (D-134), identical to every other
// page's: the health probe rides along until task 180's real calls
// (session state, login/logout) replace it.
const { t } = useI18n();
const api = useApi();
const { error: healthError, execute: loadHealth } = useApiCall(() => api.health.get());
void loadHealth();
</script>

<template>
  <section class="page">
    <h2>{{ t('login.title') }}</h2>
    <p data-testid="page-status">{{ t('login.status') }}</p>
    <ApiErrorNotice v-if="healthError" :error="healthError" />
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
