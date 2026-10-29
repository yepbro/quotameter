<script setup lang="ts">
// Placeholder application shell. The real interface (accounts, charts,
// history) arrives with the UI implementation stages; this component exists
// so that the component-test and E2E foundations exercise a real mount.
</script>

<template>
  <main class="app">
    <h1>Quotameter</h1>
    <p data-testid="app-status">Setup in progress — the interface is not implemented yet.</p>
  </main>
</template>

<style scoped>
.app {
  font-family: system-ui, sans-serif;
  margin: 2rem;
}
</style>
