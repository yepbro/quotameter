<script setup lang="ts">
// Application shell root (spec §14.1): the mount-level document
// structure — main landmark, heading, status line. The routed layout
// (overview, accounts, settings, login) arrives with task 166, the
// string catalog with 167, the theme controls with 168; until the
// catalog exists the two strings below remain the documented lint
// exception (task 036's eslint ignore list).
</script>

<template>
  <main class="app">
    <h1>Quotameter</h1>
    <p data-testid="app-status">Setup in progress — the interface is not implemented yet.</p>
  </main>
</template>

<style scoped>
.app {
  margin: 2rem;
}

.app p {
  color: var(--qm-color-muted);
}
</style>
