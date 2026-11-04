<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { HistoryRangeId } from '../history-range';
import { HISTORY_RANGE_IDS, isHistoryRangeWithinRetention } from '../history-range';

// The §14.4 rolling-range control (task 174; decision D-147): a radio
// group — one native group (fieldset + legend, one shared `name`), so
// keyboard support is native (Tab reaches the group, arrow keys move
// the selection, §14.1) and every disabled option carries its
// explanation as REAL TEXT beside the label — §14.4's "disable ranges
// that exceed the configured retention period and explain why", with
// the disabled state and the sentence together (§14.1: never color
// alone).
//
// Retention-awareness is a pure prop: `retentionDays: null` (the
// settings load is still pending or has failed) disables NOTHING — an
// unknown fact asserts nothing, and the server's own range report
// (D-139's 200-with-report) stays the authority on what is actually
// queryable. The selected range's value lives in the page (v-model);
// this component holds no state of its own.
const { t } = useI18n();

const props = defineProps<{
  /** The selected range id (v-model; the §14.4 default is `7d`). */
  readonly modelValue: HistoryRangeId;
  /** The configured history retention in days, or null while unknown. */
  readonly retentionDays: number | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [range: HistoryRangeId];
}>();

/** One rendered option — `disabled` and `reason` are one fact, single-sourced. */
interface RangeOption {
  readonly id: HistoryRangeId;
  readonly label: string;
  readonly disabled: boolean;
  /** Why the option is disabled; null exactly when it is not. */
  readonly reason: string | null;
}

/** The label — an explicit switch with static keys (D-132's rule). */
function labelOf(id: HistoryRangeId): string {
  switch (id) {
    case '24h':
      return t('overview.range.hours24');
    case '3d':
      return t('overview.range.days3');
    case '7d':
      return t('overview.range.days7');
    case '14d':
      return t('overview.range.days14');
    case '30d':
      return t('overview.range.days30');
    default: {
      // Exhaustiveness (the drift pin grows the union with the
      // server's): a future range id must fail to compile here, not
      // silently render "30 days".
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

const options = computed<readonly RangeOption[]>(() =>
  HISTORY_RANGE_IDS.map((id): RangeOption => {
    const exceeds =
      props.retentionDays !== null && !isHistoryRangeWithinRetention(id, props.retentionDays);
    return {
      id,
      label: labelOf(id),
      disabled: exceeds,
      reason: exceeds ? t('overview.range.disabledReason', { days: props.retentionDays }) : null,
    };
  }),
);

// The DOM boundary is a string (the account selector's rule): only a
// known id forwards, and a disabled option never forwards — native
// browsers never fire `change` on a disabled input, and the guard makes
// that hold under every DOM implementation the tests run on.
function onSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.disabled) return;
  if ((HISTORY_RANGE_IDS as readonly string[]).includes(input.value)) {
    emit('update:modelValue', input.value as HistoryRangeId);
  }
}
</script>

<template>
  <fieldset class="history-range" data-testid="history-range">
    <legend>{{ t('overview.range.label') }}</legend>
    <label
      v-for="option in options"
      :key="option.id"
      class="option"
      :data-range-id="option.id"
      data-testid="history-range-option"
    >
      <input
        type="radio"
        name="history-range"
        :value="option.id"
        :checked="option.id === modelValue"
        :disabled="option.disabled"
        @change="onSelect"
      />
      <span class="option-label">{{ option.label }}</span>
      <!-- The §14.4 "explain why": the sentence is real text beside the
        disabled option — the signal, with the disabled state. -->
      <span v-if="option.reason !== null" class="option-reason" data-testid="history-range-reason">
        {{ option.reason }}
      </span>
    </label>
  </fieldset>
</template>

<style scoped>
/* The tokens are the only color source (D-133): the option's state is
 * carried by the disabled input and the reason text, never by color. */
.history-range {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1rem;
  margin: 0;
  padding: 0;
  border: 0;
}

.history-range legend {
  color: var(--qm-color-muted);
  padding: 0;
}

.option {
  display: inline-flex;
  align-items: baseline;
  gap: 0.35rem;
  color: var(--qm-color-foreground);
}

.option input {
  /* The native radio is a UA widget: it follows the mode through the
   * `color-scheme` the theme blocks set (D-133) — no color is set here. */
  margin: 0;
}

.option-reason {
  color: var(--qm-color-muted);
  font-style: italic;
}
</style>
