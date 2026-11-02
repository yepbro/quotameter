<script setup lang="ts">
import { useI18n } from 'vue-i18n';
// Account management page placeholder (spec §14.2): the selector and the
// add/rename/enable/disable/replace-key/test/archive/purge forms arrive
// with tasks 170+. Routed as a placeholder so the shell's navigation
// surface exists from the start.
const { t } = useI18n();
</script>

<template>
  <section class="page">
    <h2>{{ t('accounts.title') }}</h2>
    <p data-testid="page-status">{{ t('accounts.status') }}</p>
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
