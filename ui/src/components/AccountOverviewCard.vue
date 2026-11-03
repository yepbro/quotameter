<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AccountView } from '../../../src/schemas/api/accounts';
import type { AccountErrorOutcome, StatusAccountView } from '../../../src/schemas/api/status';
import AccountStatusBadge from './AccountStatusBadge.vue';
import { formatEpochMs, formatRelative } from '../format';

// The selected account's overview facts (task 172, spec §14.3/§14.6;
// decision D-137): provider name, account label, plan name, the §7.3
// status, §7.2's two most-recents (last successful collection, last
// error). Absence stays explicit — a null plan renders "Unknown", no
// successful collection renders "Never …", a null last-error renders
// "None" — the §7.2 never-zero discipline at the identity layer. A
// status row that is absent (the §7.3 load still in flight, or failed)
// is NOT those facts: its slots render "Unknown" until a row exists —
// "Never"/"None" assert collection history only a loaded row vouches
// for (the review round's P1).
const { t } = useI18n();

const props = defineProps<{
  /** The selected account (the §13 accounts surface's merged view). */
  readonly account: AccountView;
  /** The provider's display name (registry-driven, `/api/providers`). */
  readonly providerName: string;
  /** Plan name of the latest snapshot; `null` when none exists. */
  readonly planName: string | null;
  /** The account's §7.3 status row; `null` before the status load. */
  readonly statusRow: StatusAccountView | null;
  /** The configured display time zone (§14.1). */
  readonly timeZone: string;
  /** "Now" as epoch ms — captured by the page when data arrived. */
  readonly now: number;
}>();

/** The error outcome's catalog phrase — explicit branches, static keys. */
function outcomeText(outcome: AccountErrorOutcome): string {
  switch (outcome) {
    case 'auth_error':
      return t('overview.error.outcome.authError');
    case 'rate_limited':
      return t('overview.error.outcome.rateLimited');
    case 'network_error':
      return t('overview.error.outcome.networkError');
    case 'timeout':
      return t('overview.error.outcome.timeout');
    case 'server_error':
      return t('overview.error.outcome.serverError');
    default:
      return t('overview.error.outcome.parseError');
  }
}

/** The §7.2 facts, null-normalized for template branching. */
const lastSuccessAt = computed(() => props.statusRow?.lastSuccessAt ?? null);
const lastError = computed(() => props.statusRow?.lastError ?? null);
/** Whether a §7.3 row vouches for the status facts at all. */
const statusKnown = computed(() => props.statusRow !== null);

/** The rendered fact phrases (punctuation lives in the catalog, D-132). */
const lastSuccessText = computed(() => {
  if (!statusKnown.value) return t('overview.card.unknown');
  return lastSuccessAt.value === null
    ? t('overview.card.never')
    : t('overview.card.lastSuccessValue', {
        absolute: formatEpochMs(lastSuccessAt.value, props.timeZone),
        relative: formatRelative(lastSuccessAt.value, props.now),
      });
});

const lastErrorText = computed(() => {
  if (!statusKnown.value) return t('overview.card.unknown');
  if (lastError.value === null) return t('overview.card.noError');
  const stamps = {
    absolute: formatEpochMs(lastError.value.at, props.timeZone),
    relative: formatRelative(lastError.value.at, props.now),
    outcome: outcomeText(lastError.value.outcome),
  };
  // The message segment renders only when one exists (§11.2 permits an
  // empty `error_message`; a dangling separator tail is not honest).
  return lastError.value.message === ''
    ? t('overview.card.lastErrorValueNoMessage', stamps)
    : t('overview.card.lastErrorValue', { ...stamps, message: lastError.value.message });
});
</script>

<template>
  <section class="account-card" data-testid="account-overview-card">
    <h3>{{ account.label }}</h3>

    <dl class="facts">
      <div>
        <dt>{{ t('overview.card.provider') }}</dt>
        <dd data-testid="overview-provider">
          {{ providerName }}
        </dd>
      </div>
      <div>
        <dt>{{ t('overview.card.plan') }}</dt>
        <!-- null is the honest "no snapshot carried a plan name" —
          rendered as an explicit Unknown, never a fabricated value. -->
        <dd data-testid="overview-plan">
          {{ planName ?? t('overview.card.planUnknown') }}
        </dd>
      </div>
      <div>
        <dt>{{ t('overview.card.status') }}</dt>
        <dd>
          <AccountStatusBadge v-if="statusRow !== null" :status="statusRow.status" />
          <span v-else>{{ t('overview.card.unknown') }}</span>
        </dd>
      </div>
      <div>
        <dt>{{ t('overview.card.lastSuccess') }}</dt>
        <dd data-testid="overview-last-success">
          {{ lastSuccessText }}
        </dd>
      </div>
      <div>
        <dt>{{ t('overview.card.lastError') }}</dt>
        <dd data-testid="overview-last-error">
          {{ lastErrorText }}
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.account-card {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--qm-color-muted);
  border-radius: 8px;
}

h3 {
  margin: 0;
  font-size: 1.125rem;
}

.facts {
  display: grid;
  /* 360 px-min responsive (§14.1): one column on narrow viewports,
   * two from ~40rem via the container query-less max-width below. */
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.5rem 1.5rem;
  margin: 0.5rem 0 0;
}

dt {
  color: var(--qm-color-muted);
  font-size: 0.875rem;
}

dd {
  margin: 0;
}
</style>
