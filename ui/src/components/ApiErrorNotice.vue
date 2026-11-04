<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ApiClientError } from '../api/error';

// The shared error surface (task 169, spec §13/§14, decision D-134): the
// one component every page renders an API failure through — the inline
// `role="alert"` region with the stable `api-error` testid. Message
// selection is explicit branches over the taxonomy, each rendering a
// static catalog literal: the envelope's own `serverMessage` and
// `serverDetails` NEVER reach the DOM (the client cannot vouch for what
// actually answered — a hostile or misrouted responder must not get a
// text channel into the page), so the worst a hostile payload can do is
// pick which CATALOG sentence shows. The branch structure is what keeps
// every `t()` key static (the both-directions catalog rule, D-132).
const { t } = useI18n();

defineProps<{
  /** The taxonomy error to present (from `useApiCall`'s `error` ref). */
  error: ApiClientError;
}>();
</script>

<template>
  <p
    class="api-error"
    role="alert"
    data-testid="api-error"
    :data-error-kind="error.kind"
    :data-error-code="error.kind === 'rejected' ? error.code : undefined"
  >
    <template v-if="error.kind === 'rejected'">
      <template v-if="error.code === 'VALIDATION'">{{ t('errors.codes.validation') }}</template>
      <!-- Task 180 (D-159): this branch is the PRESENTATION an
        UNAUTHENTICATED answer keeps while the session layer's redirect
        (installed by the client's `onUnauthenticated` hook — the one
        path every request takes, so an error whose notice never mounts
        still redirects) takes the page to the named `login` route with
        the destination preserved. -->
      <template v-else-if="error.code === 'UNAUTHENTICATED'">{{
        t('errors.codes.unauthenticated')
      }}</template>
      <template v-else-if="error.code === 'FORBIDDEN'">{{ t('errors.codes.forbidden') }}</template>
      <template v-else-if="error.code === 'NOT_FOUND'">{{ t('errors.codes.notFound') }}</template>
      <template v-else-if="error.code === 'PAYLOAD_TOO_LARGE'">{{
        t('errors.codes.payloadTooLarge')
      }}</template>
      <template v-else-if="error.code === 'URI_TOO_LONG'">{{
        t('errors.codes.uriTooLong')
      }}</template>
      <template v-else-if="error.code === 'UNSUPPORTED_MEDIA_TYPE'">
        {{ t('errors.codes.unsupportedMediaType') }}
      </template>
      <template v-else-if="error.code === 'INTERNAL'">{{ t('errors.codes.internal') }}</template>
      <template v-else>{{ t('errors.codes.unknown') }}</template>
    </template>
    <template v-else-if="error.kind === 'network'">{{ t('errors.network') }}</template>
    <template v-else-if="error.kind === 'timeout'">{{ t('errors.timeout') }}</template>
    <template v-else-if="error.kind === 'unexpected'">{{ t('errors.unexpected') }}</template>
    <template v-else>{{ t('errors.aborted') }}</template>
  </p>
</template>

<style scoped>
.api-error {
  /* The tokens are the only color source (D-133); the text itself carries
   * the meaning, the border is emphasis — never color alone (§14.1). */
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--qm-color-danger);
  color: var(--qm-color-foreground);
  background-color: var(--qm-color-danger-background);
  max-width: 48rem;
}
</style>
