<script setup lang="ts">
import { useI18n } from 'vue-i18n';
// Overview page placeholder (spec §14.3): the routed view the shell boots
// into. The account overview content — provider and plan identity, metric
// cards, statuses, and the history charts (§14.3, §14.4) — arrives with
// tasks 172–174; until then this view carries the bootstrap status line
// the smoke contract asserts (D-129's `app-status` testid and text).
const { t } = useI18n();
</script>

<template>
  <section class="page">
    <h2>{{ t('overview.title') }}</h2>
    <p data-testid="app-status">{{ t('overview.status') }}</p>
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
