<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AccountStatusToken } from '../../../src/schemas/api/status';

// One §7.3/§14.6 status as a badge (task 172, spec §14.1/§14.6; decision
// D-137): the LABEL is the signal — color and shape only supplement it
// (§14.1's "never rely on color alone", met by real text plus a per-tone
// CSS-drawn shape marker). The label branch is an explicit chain with
// static catalog keys (the both-directions completeness rule, D-132 — a
// Record of keys would be a dynamic t() the catalog scans cannot see);
// the tone/shape class comes from the parallel map below.
const { t } = useI18n();

const props = defineProps<{
  /** The §7.3 primary displayed status (§14.6 vocabulary). */
  readonly status: AccountStatusToken;
}>();

/** The visual tone groups: shape + color families, never meaning alone. */
const TONES: Record<AccountStatusToken, 'ok' | 'pending' | 'warn' | 'error' | 'neutral'> = {
  fresh: 'ok',
  collecting: 'pending',
  stale: 'warn',
  unreachable: 'error',
  'auth-rejected': 'error',
  'format-changed': 'error',
  disabled: 'neutral',
  'not-configured': 'neutral',
};

const tone = computed(() => TONES[props.status]);

/**
 * The label text — an explicit switch with static catalog keys (the
 * both-directions completeness rule, D-132: a Record of keys would be a
 * dynamic t() the catalog scans cannot see).
 */
const label = computed(() => {
  switch (props.status) {
    case 'fresh':
      return t('overview.status.fresh');
    case 'collecting':
      return t('overview.status.collecting');
    case 'unreachable':
      return t('overview.status.unreachable');
    case 'auth-rejected':
      return t('overview.status.authRejected');
    case 'stale':
      return t('overview.status.stale');
    case 'format-changed':
      return t('overview.status.formatChanged');
    case 'disabled':
      return t('overview.status.disabled');
    default:
      return t('overview.status.notConfigured');
  }
});
</script>

<template>
  <!-- The marker is decorative (aria-hidden): the text carries the
    status; shape and color are the §14.1 supplements, not the signal. -->
  <span class="badge" :class="`tone-${tone}`" :data-status="status" data-testid="status-badge">
    <span class="marker" aria-hidden="true" />
    <!-- The label is real text — the signal; shape and color are the
      §14.1 supplements, never the carrier. -->
    <span class="label">{{ label }}</span>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.15rem 0.6rem 0.15rem 0.5rem;
  border-radius: 999px;
  /* The tokens are the only color source (D-133); the text stays
   * --qm-color-foreground in every tone, so contrast never depends on
   * the tone. */
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-muted-background);
  font-weight: 500;
}

.tone-ok {
  background-color: var(--qm-color-ok-background);
}

.tone-pending,
.tone-warn {
  background-color: var(--qm-color-warn-background);
}

.tone-error {
  background-color: var(--qm-color-danger-background);
}

/* Shape markers (§14.1: color + shape + text — three signals, none
 * alone): filled circle, hollow circle, diamond, triangle, hollow square
 * per tone. All are CSS-drawn (no images, CSP-neutral, D-127). */
.marker {
  display: inline-block;
  width: 0.55em;
  height: 0.55em;
  flex: none;
}

.tone-ok .marker {
  border-radius: 50%;
  background-color: var(--qm-color-ok);
}

.tone-pending .marker {
  border-radius: 50%;
  border: 0.14em solid var(--qm-color-warn);
}

.tone-warn .marker {
  transform: rotate(45deg);
  background-color: var(--qm-color-warn);
}

.tone-error .marker {
  width: 0;
  height: 0;
  border-left: 0.3em solid transparent;
  border-right: 0.3em solid transparent;
  border-bottom: 0.55em solid var(--qm-color-danger);
}

.tone-neutral .marker {
  border: 0.14em solid var(--qm-color-muted);
}
</style>
