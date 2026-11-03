<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MetricView } from '../../../src/schemas/api/status';
import { formatEpochMs, formatQuotaNumber, formatRelative, windowHours } from '../format';

// One metric of the account overview (task 172, spec §14.3/§8.4; decision
// D-137): the quota type and label, per-field values with their explicit
// unit, and the next reset — rendered from the LAST VALID row of
// `/api/quota` (D-077: each row carries its own collection stamp, which
// the card shows, because rows of one account may come from different
// snapshots).
//
// Honesty rules (the task's done-condition, spec §7.2/§8.4): a missing
// value is an explicit "Unknown" — never zero, never blank, never
// silently dropped; an invalid metric renders its `invalidReason` and no
// numbers (§8.4 stores invalid metrics without numeric values); the
// reset line follows §14.3's own "if available" (absent resetsAt omits
// the line). Per §14.3's "used/remaining/limit OR percentages according
// to available provider data": each field renders its absolute value
// when present, else its percentage (a different unit, labeled as such),
// else Unknown — one value, one unit, never mixed.
const { t } = useI18n();

const props = defineProps<{
  /** The last-valid metric row (D-077 shape). */
  readonly metric: MetricView;
  /** The resolved display label (provider catalog, key fallback — D-137). */
  readonly label: string;
  /** The configured display time zone (§14.1). */
  readonly timeZone: string;
  /** "Now" as epoch ms — captured by the page when data arrived. */
  readonly now: number;
}>();

/** The quota-type phrase: §8.4 `limitType` plus the rolling window. */
const quotaTypeText = computed(() => {
  const hours =
    props.metric.windowSeconds === null ? undefined : windowHours(props.metric.windowSeconds);
  const base =
    props.metric.limitType === 'ROLLING_WINDOW'
      ? t('overview.metric.limitType.rollingWindow')
      : props.metric.limitType === 'DAILY'
        ? t('overview.metric.limitType.daily')
        : props.metric.limitType === 'WEEKLY'
          ? t('overview.metric.limitType.weekly')
          : props.metric.limitType === 'MONTHLY'
            ? t('overview.metric.limitType.monthly')
            : t('overview.metric.limitType.other');
  if (props.metric.limitType !== 'ROLLING_WINDOW' || hours === undefined) return base;
  return `${base} · ${t('overview.metric.windowHours', { count: hours })}`;
});

/** The unit token of the absolute values (§8.4 `unit`). */
const unitToken = computed(() => {
  const unit =
    props.metric.unit === 'TOKENS'
      ? t('overview.metric.unit.tokens')
      : props.metric.unit === 'CREDITS'
        ? t('overview.metric.unit.credits')
        : props.metric.unit === 'REQUESTS'
          ? t('overview.metric.unit.requests')
          : t('overview.metric.unit.percent');
  return unit;
});

/** One field's honest value: absolute, else percentage, else Unknown. */
function fieldValue(absolute: number | null, percent: number | null): string {
  if (absolute !== null) return `${formatQuotaNumber(absolute)} ${unitToken.value}`;
  if (percent !== null) return `${formatQuotaNumber(percent)}%`;
  return t('overview.metric.unknown');
}

const usedText = computed(() => fieldValue(props.metric.used, props.metric.percentUsed));
const remainingText = computed(() =>
  fieldValue(props.metric.remaining, props.metric.percentRemaining),
);
const limitText = computed(() => fieldValue(props.metric.limit, null));

/** The invalid-reading phrase (§8.4 `invalidReason` is trusted server data). */
const invalidText = computed(() =>
  t('overview.metric.invalidValue', {
    reason: props.metric.invalidReason ?? t('overview.metric.unknown'),
  }),
);

/** The reset and collection stamps: absolute in the display zone + relative. */
const resetText = computed(() =>
  props.metric.resetsAt === null
    ? null
    : t('overview.metric.resetsAtValue', {
        absolute: formatEpochMs(props.metric.resetsAt, props.timeZone),
        relative: formatRelative(props.metric.resetsAt, props.now),
      }),
);

const collectedText = computed(() =>
  t('overview.metric.collectedAtValue', {
    absolute: formatEpochMs(props.metric.collectedAt, props.timeZone),
    relative: formatRelative(props.metric.collectedAt, props.now),
  }),
);
</script>

<template>
  <article class="metric-card" :data-metric-key="metric.metricKey" data-testid="metric-card">
    <h4>{{ label }}</h4>
    <p class="quota-type">
      {{ quotaTypeText }}
    </p>

    <!-- An invalid metric carries no numeric values by §8.4: the reason
      (trusted server data, adapter-authored) is the card's value half;
      reset/window metadata may legitimately survive it (D-010). -->
    <p v-if="!metric.isValid" class="invalid" data-testid="metric-invalid">
      {{ invalidText }}
    </p>
    <dl v-else>
      <div>
        <dt>{{ t('overview.metric.used') }}</dt>
        <dd data-testid="metric-used">
          {{ usedText }}
        </dd>
      </div>
      <div>
        <dt>{{ t('overview.metric.remaining') }}</dt>
        <dd data-testid="metric-remaining">
          {{ remainingText }}
        </dd>
      </div>
      <div>
        <dt>{{ t('overview.metric.limit') }}</dt>
        <dd data-testid="metric-limit">
          {{ limitText }}
        </dd>
      </div>
    </dl>

    <p v-if="resetText !== null" class="reset">
      {{ resetText }}
    </p>
    <p class="collected">
      {{ collectedText }}
    </p>
  </article>
</template>

<style scoped>
.metric-card {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--qm-color-muted);
  border-radius: 8px;
  background-color: var(--qm-color-background);
  min-width: 14rem;
}

h4 {
  margin: 0;
  font-size: 1rem;
}

.quota-type {
  margin: 0.15rem 0 0.5rem;
  color: var(--qm-color-muted);
  font-size: 0.875rem;
}

dl {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.25rem;
  margin: 0;
}

dl div {
  display: flex;
  flex-direction: column;
}

dt {
  color: var(--qm-color-muted);
  font-size: 0.8125rem;
}

dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.invalid {
  margin: 0.25rem 0 0;
  color: var(--qm-color-foreground);
  border-left: 3px solid var(--qm-color-danger);
  background-color: var(--qm-color-danger-background);
  padding: 0.35rem 0.6rem;
}

.reset,
.collected {
  margin: 0.5rem 0 0;
  color: var(--qm-color-muted);
  font-size: 0.875rem;
}
</style>
