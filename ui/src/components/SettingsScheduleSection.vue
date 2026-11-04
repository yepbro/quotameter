<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ProviderView } from '../../../src/schemas/api/providers';
import { formatQuotaNumber } from '../format';

// The §9.2 peak-hours schedule, read-only (task 179, spec §14.5; decision
// D-156): the served provider configuration rendered as data — schedule
// time zone (its OWN zone, independent of the display zone, §9.2), the
// off-peak rate, and the windows with their days, local times, and
// multipliers, all verbatim trusted server data. A null schedule and an
// empty windows array render §9.2's exact "not configured" sentence —
// never an invented schedule. The remedy for changes stays §9.2's own:
// edit the file, run `quotameter reload`.
const { t } = useI18n();

defineProps<{
  /** The registered provider types with their schedules (§13). */
  readonly providers: ReadonlyArray<ProviderView>;
}>();

/** §9.2: an omitted multiplier is 1.0 — a rate message, not a secret. */
function rate(multiplier: number | undefined): string {
  return t('settings.schedule.rateValue', { rate: formatQuotaNumber(multiplier ?? 1) });
}
</script>

<template>
  <section class="schedule" data-testid="settings-schedule">
    <h3>{{ t('settings.schedule.heading') }}</h3>
    <p class="read-only">{{ t('settings.schedule.readOnly') }}</p>

    <p v-if="providers.length === 0" class="none" data-testid="settings-schedule-none">
      {{ t('settings.schedule.noProviders') }}
    </p>

    <section
      v-for="provider in providers"
      :key="provider.id"
      class="provider"
      data-testid="settings-schedule-provider"
    >
      <h4>{{ provider.name }}</h4>
      <template v-if="provider.peakHours !== null && provider.peakHours.windows.length > 0">
        <dl class="facts">
          <div class="fact">
            <dt>{{ t('settings.schedule.providerZone') }}</dt>
            <dd>{{ provider.peakHours.timezone }}</dd>
          </div>
          <div class="fact">
            <dt>{{ t('settings.schedule.offPeak') }}</dt>
            <dd>{{ rate(provider.peakHours.offPeakMultiplier) }}</dd>
          </div>
        </dl>
        <table>
          <thead>
            <tr>
              <th scope="col">{{ t('settings.schedule.windowName') }}</th>
              <th scope="col">{{ t('settings.schedule.windowDays') }}</th>
              <th scope="col">{{ t('settings.schedule.windowTime') }}</th>
              <th scope="col">{{ t('settings.schedule.windowRate') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="window in provider.peakHours.windows"
              :key="window.id"
              data-testid="settings-schedule-window"
            >
              <td>{{ window.name }}</td>
              <td>{{ window.days.join(', ') }}</td>
              <td>
                {{
                  t('settings.schedule.windowTimeValue', { start: window.start, end: window.end })
                }}
              </td>
              <td>{{ rate(window.multiplier) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <p v-else class="none" data-testid="settings-schedule-empty">
        {{ t('settings.schedule.notConfigured') }}
      </p>
    </section>
  </section>
</template>

<style scoped>
.schedule {
  margin-top: 2rem;
  max-width: 48rem;
}

.read-only,
.none {
  color: var(--qm-color-muted);
  margin: 0;
}

.provider {
  margin-top: 1rem;
}

.provider h4 {
  margin: 0.5rem 0 0;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 2rem;
  margin: 0.5rem 0;
}

.fact {
  display: flex;
  gap: 0.5rem;
}

.fact dt {
  color: var(--qm-color-muted);
}

.fact dd {
  margin: 0;
}

table {
  border-collapse: collapse;
  margin-top: 0.5rem;
  max-width: 100%;
}

th,
td {
  border: 1px solid var(--qm-color-muted);
  color: var(--qm-color-foreground);
  padding: 0.25rem 0.5rem;
  text-align: left;
}

th {
  color: var(--qm-color-muted);
}
</style>
