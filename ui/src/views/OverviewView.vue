<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
// Overview page placeholder (spec §14.3): the routed view the shell boots
// into. The account overview content — provider and plan identity, metric
// cards, statuses, and the history charts (§14.3, §14.4) — arrives with
// tasks 172–174; until then this view carries the bootstrap status line
// the smoke contract asserts (D-129's `app-status` testid and text).
//
// Task 169's canonical error wiring (D-134): call through the shared
// client, catch into the shared state, present through the shared
// notice — the same three lines every page reuses, proven here against
// the one route that exists in every deployment (the public health
// probe, §13). Tasks 172–174 replace the probe with the page's real
// calls; the wiring pattern stays.
const { t } = useI18n();
const api = useApi();
const { error: healthError, execute: loadHealth } = useApiCall(() => api.health.get());
void loadHealth();
</script>

<template>
  <section class="page">
    <h2>{{ t('overview.title') }}</h2>
    <p data-testid="app-status">{{ t('overview.status') }}</p>
    <ApiErrorNotice v-if="healthError" :error="healthError" />
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
