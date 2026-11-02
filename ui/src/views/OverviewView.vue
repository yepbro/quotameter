<script setup lang="ts">
// Overview page placeholder (spec §14.3): the routed view the shell boots
// into. The account overview content — provider and plan identity, metric
// cards, statuses, and the history charts (§14.3, §14.4) — arrives with
// tasks 172–174; until then this view carries the bootstrap status line
// the smoke contract asserts (D-129's `app-status` testid and text).
</script>

<template>
  <section class="page">
    <h2>Overview</h2>
    <p data-testid="app-status">Setup in progress — the interface is not implemented yet.</p>
  </section>
</template>

<style scoped>
.page p {
  color: var(--qm-color-muted);
}
</style>
