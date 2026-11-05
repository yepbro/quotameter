<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  SettingsView,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from '../../../src/schemas/api/settings';
import ApiErrorNotice from './ApiErrorNotice.vue';
import { useApi, useApiCall } from '../api';
import { browserTimeZones, isValidTimeZone, zoneSuggestions } from '../timezones';
import {
  isIntegerInRange,
  LOG_LEVELS,
  POLLING_INTERVAL_MAX_SECONDS,
  POLLING_INTERVAL_MIN_SECONDS,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
} from '../settings-fields';

// The §6.4-live editable scalars (task 179, spec §14.5; decision D-156):
// the PUT's runtime-modification set over the D-130 annotated view. Each
// field renders disabled with the §6.3 annotation exactly when its
// `source` is the environment — the served marking, never re-derived
// precedence knowledge. The PUT body carries ONLY the fields whose draft
// differs from the served values (D-130/D-140's minimal-write semantics:
// the store persists exactly the attempted fields, so an unchanged value
// sent anyway would be a wasted write against a possibly newer file).
//
// §5.3's explicit-choice rule mirrored: no silent defaults anywhere — a
// blank or non-IANA zone is a field error, never a submitted guess.
const { t } = useI18n();
const api = useApi();

const props = defineProps<{
  /** The last successfully loaded annotated settings view. */
  readonly settings: SettingsView;
}>();

const emit = defineEmits<{
  /** A save succeeded; the parent reloads the served truth. */
  saved: [];
}>();

// The browser's IANA list, read once — the same resolver that formats
// every date in the UI (see ui/src/timezones.ts).
const zones = browserTimeZones();

// Task 181 (D-164): the suggestion list's keyboard seams — the input
// keeps native typing and Tab order; ArrowDown hands focus to the first
// suggestion button (real focusable buttons, no aria-activedescendant
// combobox — D-156's native-controls stance, now with linkage), and
// Escape abandons the edit (the draft reverts to the served truth, the
// list collapses with it).
const timezoneInput = ref<HTMLInputElement | null>(null);
const timezoneList = ref<HTMLUListElement | null>(null);

const timezone = ref(props.settings.app.timezone.value);
const interval = ref(String(props.settings.app.pollingIntervalSeconds.value));
const retention = ref(String(props.settings.app.historyRetentionDays.value));
const level = ref<SettingsView['logging']['level']['value']>(props.settings.logging.level.value);

/** The timezone guard's two honest refusals. */
const timezoneError = ref<'blank' | 'invalid' | null>(null);
const intervalError = ref(false);
const retentionError = ref(false);
/** The last successful PUT's outcome — the saved and restart notices. */
const savedOutcome = ref<UpdateSettingsResponse | null>(null);

// Drafts adopt the served truth whenever it changes: the parent reloads
// after a save (this form's `saved` emit) and on its own retry, and the
// server's view is the single truth. A failed save keeps the drafts (the
// operator's edit survives beside the failure notice).
watch(
  () => props.settings,
  (next) => {
    timezone.value = next.app.timezone.value;
    interval.value = String(next.app.pollingIntervalSeconds.value);
    retention.value = String(next.app.historyRetentionDays.value);
    level.value = next.logging.level.value;
    timezoneError.value = null;
    intervalError.value = false;
    retentionError.value = false;
  },
  { immediate: true },
);

/** The §14.5 search affordance: matches for the typed query, capped. */
const suggestions = computed(() => {
  const query = timezone.value.trim();
  // Nothing to narrow (untouched field), or an exact known zone picked —
  // the list is a narrowing aid, never a catalog dump.
  if (query === '' || query === props.settings.app.timezone.value) return [];
  if (zones.includes(query)) return [];
  return zoneSuggestions(query, zones);
});

/** Whether any draft differs from the served values (the save gate). */
const hasChanges = computed(() => {
  const { settings } = props;
  return (
    timezone.value.trim() !== settings.app.timezone.value ||
    interval.value.trim() !== String(settings.app.pollingIntervalSeconds.value) ||
    retention.value.trim() !== String(settings.app.historyRetentionDays.value) ||
    level.value !== settings.logging.level.value
  );
});

const { error, pending, execute } = useApiCall(() => {
  const body: UpdateSettingsBody = {};
  const { settings } = props;
  const app: NonNullable<UpdateSettingsBody['app']> = {};
  if (timezone.value.trim() !== settings.app.timezone.value) {
    app.timezone = timezone.value.trim();
  }
  if (interval.value.trim() !== String(settings.app.pollingIntervalSeconds.value)) {
    app.pollingIntervalSeconds = Number(interval.value.trim());
  }
  if (retention.value.trim() !== String(settings.app.historyRetentionDays.value)) {
    app.historyRetentionDays = Number(retention.value.trim());
  }
  if (Object.keys(app).length > 0) body.app = app;
  if (level.value !== settings.logging.level.value) body.logging = { level: level.value };
  return api.settings.update(body);
});

// The PUT outcome's restartRequired list speaks in field paths; the
// operator-facing names come from static catalog lookups (every t()
// argument a literal — the both-directions rule, D-132).
const restartFieldLabels: Record<'server.host' | 'server.port' | 'auth.mode', string> = {
  'server.host': t('settings.facts.host'),
  'server.port': t('settings.facts.port'),
  'auth.mode': t('settings.facts.authMode'),
};

async function submit(): Promise<void> {
  const { settings } = props;
  const zone = timezone.value.trim();
  // Only what will be SENT is validated: the body carries exactly the
  // changed drafts, so a served value the browser's own Intl cannot
  // confirm (an ICU skew, an environment-supplied zone this engine does
  // not know) never blocks an unrelated save — the guard would point at
  // a field the request does not touch (or an input the page has
  // disabled, §6.3). The served values passed the server's own check;
  // the guards own the operator's edits alone.
  const zoneChanged = zone !== settings.app.timezone.value;
  timezoneError.value = !zoneChanged
    ? null
    : zone === ''
      ? 'blank'
      : isValidTimeZone(zone)
        ? null
        : 'invalid';
  const intervalChanged =
    interval.value.trim() !== String(settings.app.pollingIntervalSeconds.value);
  intervalError.value =
    intervalChanged &&
    !isIntegerInRange(interval.value, POLLING_INTERVAL_MIN_SECONDS, POLLING_INTERVAL_MAX_SECONDS);
  const retentionChanged =
    retention.value.trim() !== String(settings.app.historyRetentionDays.value);
  retentionError.value =
    retentionChanged && !isIntegerInRange(retention.value, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS);
  if (timezoneError.value !== null || intervalError.value || retentionError.value) return;
  // The previous outcome retires exactly when a new request dispatches —
  // a refused submit (the guards above) keeps a still-true pending-
  // restart notice on screen.
  savedOutcome.value = null;
  const outcome = await execute();
  if (outcome !== null) {
    savedOutcome.value = outcome;
    emit('saved');
  }
}

function onLevelChange(event: Event): void {
  const { value } = event.target as HTMLSelectElement;
  // The DOM select is a string boundary; only served enum members pass.
  if ((LOG_LEVELS as readonly string[]).includes(value)) {
    level.value = value as SettingsView['logging']['level']['value'];
  }
}

// The number inputs read their element value explicitly instead of
// v-model: Vue auto-casts `type="number"` model updates through its
// loose number conversion, and the drafts are deliberately strings (the
// raw operator input) so validation judges exactly what was typed.
function onIntervalInput(event: Event): void {
  interval.value = (event.target as HTMLInputElement).value;
}

function onRetentionInput(event: Event): void {
  retention.value = (event.target as HTMLInputElement).value;
}

/**
 * Applies a picked suggestion — a known-valid zone clears any stale
 * error — and returns focus to the field: the picked button unmounts
 * with the collapsing list, so without this the keyboard user's focus
 * falls to the document body (the review round's P1).
 */
async function pickZone(zone: string): Promise<void> {
  timezone.value = zone;
  timezoneError.value = null;
  await nextTick();
  timezoneInput.value?.focus();
}

/**
 * Abandons the time-zone edit: the draft returns to the served truth and
 * the suggestion list collapses with it (the list is a pure function of
 * the draft). Keyboard dismissal, §14.1; also clears a stale field error
 * — the reverted value is the served one the guards never judge.
 */
function revertTimezone(): void {
  timezone.value = props.settings.app.timezone.value;
  timezoneError.value = null;
}

/** The input's keyboard seams (see the task-181 block above). */
function onTimezoneKeydown(event: KeyboardEvent): void {
  // Escape is also the IME composition-cancel key — a composing user
  // means to cancel the composition, not the edit.
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    revertTimezone();
    return;
  }
  if (event.key === 'ArrowDown') {
    const first = timezoneList.value?.querySelector('button') ?? null;
    if (first !== null) {
      // ArrowDown would only shuffle the caret; the list is the reason
      // the key matters here.
      event.preventDefault();
      first.focus();
    }
  }
}

/** A suggestion button's Escape: revert and hand focus back to the field. */
function onSuggestionKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key !== 'Escape') return;
  revertTimezone();
  timezoneInput.value?.focus();
}
</script>

<template>
  <form class="general" data-testid="settings-general" novalidate @submit.prevent="submit">
    <h3>{{ t('settings.general.heading') }}</h3>

    <div class="field">
      <label for="settings-timezone">{{ t('settings.general.timezone') }}</label>
      <input
        id="settings-timezone"
        ref="timezoneInput"
        v-model="timezone"
        data-testid="settings-timezone"
        type="text"
        autocomplete="off"
        :disabled="settings.app.timezone.source === 'environment'"
        :aria-invalid="timezoneError !== null || undefined"
        aria-describedby="settings-timezone-hint"
        :aria-controls="suggestions.length > 0 ? 'settings-timezone-suggestions' : undefined"
        aria-autocomplete="list"
        @keydown="onTimezoneKeydown"
      />
      <p id="settings-timezone-hint" class="hint">
        {{ t('settings.general.timezoneHint') }}
      </p>
      <p
        v-if="settings.app.timezone.source === 'environment'"
        class="env-note"
        data-testid="settings-env-note"
      >
        {{ t('settings.facts.environment') }}
      </p>
      <ul
        v-if="suggestions.length > 0"
        id="settings-timezone-suggestions"
        ref="timezoneList"
        class="suggestions"
        :aria-label="t('settings.general.timezoneSuggestions')"
        data-testid="settings-timezone-suggestions"
        @keydown="onSuggestionKeydown"
      >
        <li v-for="zone in suggestions" :key="zone">
          <button type="button" data-testid="settings-timezone-option" @click="pickZone(zone)">
            {{ zone }}
          </button>
        </li>
      </ul>
      <p v-if="timezoneError === 'blank'" class="field-error" role="alert">
        {{ t('settings.general.timezoneBlank') }}
      </p>
      <p v-else-if="timezoneError === 'invalid'" class="field-error" role="alert">
        {{ t('settings.general.timezoneInvalid') }}
      </p>
    </div>

    <div class="field">
      <label for="settings-interval">{{ t('settings.general.interval') }}</label>
      <input
        id="settings-interval"
        :value="interval"
        data-testid="settings-interval"
        type="number"
        :min="POLLING_INTERVAL_MIN_SECONDS"
        :max="POLLING_INTERVAL_MAX_SECONDS"
        :disabled="settings.app.pollingIntervalSeconds.source === 'environment'"
        :aria-invalid="intervalError || undefined"
        @input="onIntervalInput"
      />
      <p
        v-if="settings.app.pollingIntervalSeconds.source === 'environment'"
        class="env-note"
        data-testid="settings-env-note"
      >
        {{ t('settings.facts.environment') }}
      </p>
      <p v-if="intervalError" class="field-error" role="alert">
        {{
          t('settings.general.intervalInvalid', {
            min: POLLING_INTERVAL_MIN_SECONDS,
            max: POLLING_INTERVAL_MAX_SECONDS,
          })
        }}
      </p>
    </div>

    <div class="field">
      <label for="settings-retention">{{ t('settings.general.retention') }}</label>
      <input
        id="settings-retention"
        :value="retention"
        data-testid="settings-retention"
        type="number"
        :min="RETENTION_MIN_DAYS"
        :max="RETENTION_MAX_DAYS"
        :disabled="settings.app.historyRetentionDays.source === 'environment'"
        :aria-invalid="retentionError || undefined"
        @input="onRetentionInput"
      />
      <p class="hint">{{ t('settings.general.retentionHint') }}</p>
      <p
        v-if="settings.app.historyRetentionDays.source === 'environment'"
        class="env-note"
        data-testid="settings-env-note"
      >
        {{ t('settings.facts.environment') }}
      </p>
      <p v-if="retentionError" class="field-error" role="alert">
        {{
          t('settings.general.retentionInvalid', {
            min: RETENTION_MIN_DAYS,
            max: RETENTION_MAX_DAYS,
          })
        }}
      </p>
    </div>

    <div class="field">
      <label for="settings-level">{{ t('settings.general.level') }}</label>
      <select
        id="settings-level"
        data-testid="settings-level"
        :value="level"
        :disabled="settings.logging.level.source === 'environment'"
        @change="onLevelChange"
      >
        <option v-for="choice in LOG_LEVELS" :key="choice" :value="choice">
          {{ choice }}
        </option>
      </select>
      <p
        v-if="settings.logging.level.source === 'environment'"
        class="env-note"
        data-testid="settings-env-note"
      >
        {{ t('settings.facts.environment') }}
      </p>
    </div>

    <button type="submit" data-testid="settings-save" :disabled="pending || !hasChanges">
      {{ pending ? t('settings.general.saving') : t('settings.general.save') }}
    </button>

    <p v-if="savedOutcome" class="status" role="status" data-testid="settings-saved">
      {{ t('settings.general.saved') }}
    </p>
    <p
      v-if="savedOutcome !== null && savedOutcome.restartRequired.length > 0"
      class="status restart"
      role="status"
      data-testid="settings-restart-pending"
    >
      {{
        t('settings.general.restartPending', {
          fields: savedOutcome.restartRequired.map((field) => restartFieldLabels[field]).join(', '),
        })
      }}
    </p>

    <ApiErrorNotice v-if="error" :error="error" />
  </form>
</template>

<style scoped>
.general {
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 1rem;
  max-width: 32rem;
  padding: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  color: var(--qm-color-muted);
}

.field input,
.field select,
.suggestions button {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.5rem;
}

.suggestions {
  list-style: none;
  margin: 0;
  max-height: 12rem;
  overflow-y: auto;
  /* Room for the suggestion buttons' :focus-visible ring on all sides —
   * the scroll container clips outlines that reach past its padding
   * box (task 181): 0.25rem covers the 2px ring plus its 2px offset. */
  padding: 0.25rem;
}

.suggestions button {
  text-align: left;
  width: 100%;
}

button[type='submit'] {
  align-self: flex-start;
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
}

button:disabled,
input:disabled,
select:disabled {
  color: var(--qm-color-muted);
}

.hint,
.env-note,
.field-error,
.status {
  margin: 0;
}

.hint,
.env-note {
  color: var(--qm-color-muted);
}

.field-error {
  color: var(--qm-color-danger);
}

.status {
  color: var(--qm-color-foreground);
}
</style>
