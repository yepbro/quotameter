<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { AccountAttention } from '../account-attention';

// The account-level attention notice (task 173, spec §14.3/§14.6;
// decision D-138): why collection is not running for the selected
// account and what to do about it — the §14.6 status badge names the
// state, this notice adds the remedy. The link renders exactly where
// the remedy is a UI action; an environment-sourced key is read-only
// through the API (§6.3), so its wording names the server-side step
// and carries no link. Ordinary content, not an alert: it reads in
// document order and nothing announces it (the error surface's
// `role="alert"` is for failures).
const { t } = useI18n();

const props = defineProps<{
  /** The attention kind (the classifier's verdict for the account). */
  readonly attention: AccountAttention;
}>();

/** Whether the remedy is reachable from this UI (a link renders). */
const linked = computed(() => props.attention !== 'keyless-environment');

/**
 * The notice sentence — an explicit branch chain with static catalog
 * keys (the both-directions completeness rule, D-132).
 */
const text = computed(() => {
  switch (props.attention) {
    case 'archived':
      return t('overview.attention.archived');
    case 'disabled':
      return t('overview.attention.disabled');
    case 'keyless-environment':
      return t('overview.attention.keylessEnvironment');
    default:
      return t('overview.attention.keyless');
  }
});
</script>

<template>
  <!-- The kind rides as data for tests and review; the visible text
    carries the meaning (§14.1). -->
  <div class="attention" :data-attention="attention" data-testid="overview-attention">
    <p>{{ text }}</p>
    <RouterLink v-if="linked" to="/accounts" data-testid="overview-attention-cta">
      {{ t('overview.attention.cta') }}
    </RouterLink>
  </div>
</template>

<style scoped>
/* Tokens only (D-133); deliberately neutral — the badge beside this
 * notice already carries the tone, and the text carries the meaning. */
.attention {
  margin-top: 0.75rem;
  padding: 0.5rem 0.9rem;
  border: 1px solid var(--qm-color-muted);
  border-radius: 8px;
  background-color: var(--qm-color-muted-background);
}

.attention p {
  margin: 0;
}

.attention a {
  display: inline-block;
  margin-top: 0.35rem;
  color: var(--qm-color-foreground);
}
</style>
