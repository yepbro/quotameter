<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SettingsResponse } from '../../../src/schemas/api/settings';
import type { ProviderView } from '../../../src/schemas/api/providers';
import ApiErrorNotice from '../components/ApiErrorNotice.vue';
import SettingsGeneralForm from '../components/SettingsGeneralForm.vue';
import SettingsPasswordForm from '../components/SettingsPasswordForm.vue';
import SettingsScheduleSection from '../components/SettingsScheduleSection.vue';
import { useApi, useApiCall } from '../api';
import { isTheme, useTheme } from '../theme';
import { createRestartFieldLabels, type RestartField } from '../settings-fields';

// The settings page (task 179, spec §14.5; decision D-156): the two loads
// (the D-130 annotated settings view and the providers listing that
// carries the §9.2 schedules), the read-only server/auth facts with
// their §6.4 annotations, the editable scalars (their forms), the theme
// row, the password change, and the §6.1 paths display. Since FSM-5
// (D-193) the facts section also renders the live §6.4 state the GET
// carries: `pendingRestart` names the restart-requiring fields whose
// values changed and were adopted by a reload — the per-row "restart
// pending" marker and the notice with the `quotameter restart` remedy,
// beside the static class markings (spec §14.5's distinguishing rule).
//
// The failed-load rule is D-135's: a failed reload keeps the last good
// surface rendered beside its notice and a retry — the empty page renders
// only before the first completed load. The providers load degrades the
// schedule section alone (the overview's providers precedent): its
// failure renders a notice without a retry, and everything else stays.
const { t } = useI18n();
const api = useApi();
const themeController = useTheme();

const {
  data: settingsData,
  error: settingsError,
  pending: settingsPending,
  execute: reload,
} = useApiCall(() => api.settings.get());

const {
  data: providersData,
  error: providersError,
  execute: reloadProviders,
} = useApiCall(() => api.providers.list());

// The pending fields' operator-facing names — the shared §6.4 vocabulary
// (the SettingsGeneralForm outcome notice names the same fields the same
// way), built from static catalog literals (the both-directions rule,
// D-132).
const restartFieldLabels = createRestartFieldLabels(t);

void reload();
void reloadProviders();

/** The last successfully loaded settings — the rendered truth. */
const lastSettings = ref<SettingsResponse['settings'] | null>(null);
/** The last successfully loaded paths block (same rule). */
const lastPaths = ref<SettingsResponse['paths'] | null>(null);
/**
 * The retention window the last completed cleanup applied (§11.3, D-178) —
 * the reduce-retention warning's reference; `null` before any cleanup.
 */
const lastAppliedRetentionDays = ref<number | null>(null);
/**
 * The reloader's live restart-pending diff (§6.4, FSM-5/D-193) — which
 * restart-requiring values changed and were adopted, awaiting a process
 * restart; `[]` when nothing is pending. Adopted from every successful
 * load, so the marker appears and disappears with the served state.
 */
const lastPendingRestart = ref<readonly RestartField[]>([]);
/** Whether the settings view has loaded successfully at least once. */
const settingsLoaded = ref(false);
/** The last successfully loaded providers (same rule as the settings). */
const lastProviders = ref<ReadonlyArray<ProviderView>>([]);
/** Whether the providers list has loaded successfully at least once. */
const providersLoaded = ref(false);

watch(settingsData, (data) => {
  if (data === null) return;
  lastSettings.value = data.settings;
  lastPaths.value = data.paths;
  lastAppliedRetentionDays.value = data.appliedRetentionDays;
  lastPendingRestart.value = data.pendingRestart;
  settingsLoaded.value = true;
});

watch(providersData, (data) => {
  if (data === null) return;
  lastProviders.value = data.providers;
  providersLoaded.value = true;
});

function onSaved(): void {
  void reload();
}

// The theme row drives the SAME controller as the header select (D-133's
// hand-off): one source of truth, page-owned strings. The DOM select is
// a string boundary — only the three §14.1 modes pass.
function onThemeSelect(event: Event): void {
  const { value } = event.target as HTMLSelectElement;
  if (isTheme(value)) themeController.setTheme(value);
}
</script>

<template>
  <section class="page">
    <h2>{{ t('settings.title') }}</h2>

    <p v-if="settingsPending && !settingsLoaded" class="status" data-testid="settings-loading">
      {{ t('settings.loading') }}
    </p>

    <div v-if="settingsError" class="load-failure">
      <ApiErrorNotice :error="settingsError" />
      <button type="button" data-testid="settings-retry" @click="reload">
        {{ t('settings.retry') }}
      </button>
    </div>

    <template v-if="settingsLoaded && lastSettings !== null && lastPaths !== null">
      <!-- §6.4's restart-requiring trio: read-only values with the marker
        and the remedy line — the PUT refuses them (D-130), so no edit
        control exists to be refused. -->
      <section class="facts" data-testid="settings-facts">
        <h3>{{ t('settings.facts.heading') }}</h3>
        <dl>
          <div class="row" data-testid="settings-host">
            <dt>{{ t('settings.facts.host') }}</dt>
            <dd>
              {{ lastSettings.server.host.value }}
              <span
                v-if="lastSettings.server.host.restartRequired"
                class="marker"
                data-testid="settings-restart-marker"
              >
                {{ t('settings.facts.restartRequired') }}
              </span>
              <!-- The live state beside the class marking (FSM-5, D-193):
                this value changed and a restart is still owed on it. -->
              <span
                v-if="lastPendingRestart.includes('server.host')"
                class="marker pending"
                data-testid="settings-pending-marker"
              >
                {{ t('settings.facts.restartPending') }}
              </span>
              <span
                v-if="lastSettings.server.host.source === 'environment'"
                class="marker"
                data-testid="settings-env-marker"
              >
                {{ t('settings.facts.environment') }}
              </span>
            </dd>
          </div>
          <div class="row" data-testid="settings-port">
            <dt>{{ t('settings.facts.port') }}</dt>
            <dd>
              {{ lastSettings.server.port.value }}
              <span
                v-if="lastSettings.server.port.restartRequired"
                class="marker"
                data-testid="settings-restart-marker"
              >
                {{ t('settings.facts.restartRequired') }}
              </span>
              <span
                v-if="lastPendingRestart.includes('server.port')"
                class="marker pending"
                data-testid="settings-pending-marker"
              >
                {{ t('settings.facts.restartPending') }}
              </span>
              <span
                v-if="lastSettings.server.port.source === 'environment'"
                class="marker"
                data-testid="settings-env-marker"
              >
                {{ t('settings.facts.environment') }}
              </span>
            </dd>
          </div>
          <div class="row" data-testid="settings-auth-mode">
            <dt>{{ t('settings.facts.authMode') }}</dt>
            <dd>
              {{ lastSettings.auth.mode.value }}
              <span
                v-if="lastSettings.auth.mode.restartRequired"
                class="marker"
                data-testid="settings-restart-marker"
              >
                {{ t('settings.facts.restartRequired') }}
              </span>
              <span
                v-if="lastPendingRestart.includes('auth.mode')"
                class="marker pending"
                data-testid="settings-pending-marker"
              >
                {{ t('settings.facts.restartPending') }}
              </span>
              <span
                v-if="lastSettings.auth.mode.source === 'environment'"
                class="marker"
                data-testid="settings-env-marker"
              >
                {{ t('settings.facts.environment') }}
              </span>
            </dd>
          </div>
        </dl>
        <p class="restart-hint" data-testid="settings-restart-hint">
          {{ t('settings.facts.restartHint') }}
        </p>
        <!-- The live half of §14.5's distinguishing rule (FSM-5, D-193):
          the reloader's own effective-vs-startup diff, served by the GET —
          non-empty exactly while a changed restart-requiring value awaits
          `quotameter restart`, across reloads of the page. -->
        <p
          v-if="lastPendingRestart.length > 0"
          class="restart-hint pending-restart"
          role="status"
          data-testid="settings-pending-restart"
        >
          {{
            t('settings.facts.restartPendingNotice', {
              fields: lastPendingRestart.map((field) => restartFieldLabels[field]).join(', '),
            })
          }}
        </p>
      </section>

      <SettingsGeneralForm
        :settings="lastSettings"
        :applied-retention-days="lastAppliedRetentionDays"
        @saved="onSaved"
      />

      <!-- §14.1's theme choice, one controller with the header select. -->
      <div class="theme-row" data-testid="settings-theme-row">
        <label for="settings-theme">{{ t('settings.theme.label') }}</label>
        <select
          id="settings-theme"
          data-testid="settings-theme"
          :value="themeController.theme.value"
          @change="onThemeSelect"
        >
          <option value="system">{{ t('settings.theme.system') }}</option>
          <option value="light">{{ t('settings.theme.light') }}</option>
          <option value="dark">{{ t('settings.theme.dark') }}</option>
        </select>
      </div>

      <SettingsPasswordForm :password-configured="lastSettings.auth.passwordConfigured" />

      <SettingsScheduleSection v-if="providersLoaded" :providers="lastProviders" />
      <ApiErrorNotice v-if="providersError" :error="providersError" />

      <section class="paths" data-testid="settings-paths">
        <h3>{{ t('settings.paths.heading') }}</h3>
        <dl>
          <div class="row" data-testid="settings-config-path">
            <dt>{{ t('settings.paths.config') }}</dt>
            <dd>{{ lastPaths.configPath }}</dd>
          </div>
          <div class="row" data-testid="settings-data-dir">
            <dt>{{ t('settings.paths.data') }}</dt>
            <dd>{{ lastPaths.dataDir }}</dd>
          </div>
        </dl>
      </section>
    </template>
  </section>
</template>

<style scoped>
.page .status {
  color: var(--qm-color-muted);
}

.load-failure {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.load-failure button,
.theme-row select {
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-background);
  border: 1px solid var(--qm-color-muted);
  border-radius: 4px;
  font: inherit;
  padding: 0.25rem 0.75rem;
}

.facts,
.paths {
  margin-top: 1.5rem;
  max-width: 48rem;
}

.facts h3,
.paths h3 {
  margin: 0.5rem 0;
}

.facts dl,
.paths dl {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
}

.row {
  display: flex;
  gap: 1rem;
}

.row dt {
  color: var(--qm-color-muted);
  min-width: 12rem;
}

.row dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.marker {
  color: var(--qm-color-muted);
  margin-left: 0.5rem;
}

/* The live pending state (FSM-5, D-193) — actionable (a restart is owed),
 * so it carries the attention color the advisory notices use; the text
 * itself names the state, never color alone (§14.1). */
.marker.pending {
  color: var(--qm-color-danger);
}

.restart-hint {
  color: var(--qm-color-muted);
  margin: 0.5rem 0 0;
}

.restart-hint.pending-restart {
  color: var(--qm-color-danger);
}

.theme-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1.5rem;
}

.theme-row label {
  color: var(--qm-color-muted);
}

.theme-row select {
  padding: 0.25rem 0.5rem;
}
</style>
