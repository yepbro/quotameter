<script setup lang="ts">
import { useI18n } from 'vue-i18n';
// Login page placeholder (spec §14.6): shown when the active
// authentication mode requires a password (§15.1). The form, the
// auth-mode awareness, and the navigation guards are task 180's; this
// routed placeholder keeps the URL stable while the shell lands.
const { t } = useI18n();
</script>

<template>
  <section class="page">
    <h2>{{ t('login.title') }}</h2>
    <p data-testid="page-status">{{ t('login.status') }}</p>
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
