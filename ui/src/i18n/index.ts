import { createI18n } from 'vue-i18n';
import { en } from './en';

/**
 * Creates the application i18n instance (spec §14.1, decision D-132):
 * English only — `locale` and `fallbackLocale` are both `en` — in
 * Composition mode (`legacy: false`), so components translate through
 * `useI18n()`'s `t()`.
 *
 * A factory, not a singleton, mirrors `createAppRouter` (D-131): the
 * composition root installs the real instance, component tests install
 * their own per mount. Messages are runtime-only lookups over the typed
 * catalog module — no compilation, no CSP surface (D-127). The return
 * type stays inferred: annotating it as the generic `I18n` would widen
 * `global` to the legacy/composition union and hide the Composer.
 */
export function createAppI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en },
  });
}
