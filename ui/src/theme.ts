import {
  computed,
  inject,
  ref,
  watchEffect,
  type App,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue';

/**
 * Theme selection (spec §14.1; decision D-133): the `system`/`light`/
 * `dark` preference, its browser-storage persistence, and the live
 * application mechanism — a `data-theme` attribute on the document
 * element that the token stylesheet (`src/assets/base.css`) maps onto
 * the `--qm-*` design tokens. `system` removes the attribute so the
 * `prefers-color-scheme` block governs; an explicit mode sets it and
 * outspecifies that block, so `light` overrides an OS dark preference.
 *
 * The attribute flip re-cascades the tokens with no reload and no
 * inline style (D-127), which is also what makes the mechanism
 * chart-consumable: charts (tasks 175/176) read their colors through
 * `getComputedStyle` token lookups and re-render on `resolvedTheme`,
 * never through hardcoded values.
 *
 * A factory, not a singleton, mirrors `createAppRouter` (D-131) and
 * `createAppI18n` (D-132): the composition root installs the real
 * controller, component tests install their own per mount with the
 * injectable seams below.
 */

/** The §14.1 modes; `system` tracks the OS preference. */
export const THEMES = ['system', 'light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

/** The mode actually displayed: `system` resolved through the media seam. */
export type ResolvedTheme = Exclude<Theme, 'system'>;

/** The browser-storage key carrying the persisted choice (§14.1). */
export const THEME_STORAGE_KEY = 'quotameter.theme';

/** The single validation point for theme values — storage and DOM alike. */
export function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

/** The persistence seam: the `localStorage` surface the controller uses. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The system-preference seam: the `(prefers-color-scheme: dark)` query. */
export interface ThemeMedia {
  matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeController {
  /** Vue plugin installation — provides the controller to the app. */
  install(app: App): void;
  /** The stored preference; `system` when nothing valid is stored. */
  theme: Ref<Theme>;
  /** The mode in effect — `theme` with `system` resolved. */
  resolvedTheme: ComputedRef<ResolvedTheme>;
  /** Selects a mode: applies it live and persists it (best effort). */
  setTheme(theme: Theme): void;
}

const themeInjectionKey: InjectionKey<ThemeController> = Symbol('quotameter-theme');

/** Storage that persists nothing — the fallback when access throws. */
const nullStorage: ThemeStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

function defaultStorage(): ThemeStorage {
  try {
    return window.localStorage;
  } catch {
    // Reading `window.localStorage` itself throws in locked-down
    // contexts (all cookies blocked): the choice then lives in memory.
    return nullStorage;
  }
}

function defaultMedia(): ThemeMedia | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia('(prefers-color-scheme: dark)');
}

export function createAppTheme(
  options: { storage?: ThemeStorage; media?: ThemeMedia | null } = {},
): ThemeController {
  const storage = options.storage ?? defaultStorage();
  const media = options.media === undefined ? defaultMedia() : options.media;

  let stored: unknown = null;
  try {
    stored = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    // A failing read degrades to the default mode, not to a broken shell.
  }
  const theme = ref<Theme>(isTheme(stored) ? stored : 'system');

  // The media query's `matches` flips before the `change` event fires,
  // so the listener can read it back from the seam itself.
  const prefersDark = ref(media?.matches ?? false);
  function onMediaChange(): void {
    prefersDark.value = media?.matches ?? false;
  }

  const resolvedTheme = computed<ResolvedTheme>(() =>
    theme.value === 'system' ? (prefersDark.value ? 'dark' : 'light') : theme.value,
  );

  function setTheme(next: Theme): void {
    theme.value = next;
    try {
      storage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Persistence is best effort: a full or blocked storage must not
      // break in-session switching — §14.1's persistence holds wherever
      // the browser allows writing, and nowhere else is it possible.
    }
  }

  const controller: ThemeController = {
    install(app: App): void {
      app.provide(themeInjectionKey, controller);
      // The live-application mechanism: map the preference onto the
      // document element (see base.css for the selector contract). The
      // effect and the media listener are app-scoped — `app.use()` runs
      // outside any effect scope, so a detached effect would otherwise
      // survive `app.unmount()` (harmless for the single long-lived
      // production app, a leak for every test mount since).
      media?.addEventListener('change', onMediaChange);
      const stopEffect = watchEffect(() => {
        const root = document.documentElement;
        if (theme.value === 'system') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', theme.value);
      });
      app.onUnmount(() => {
        stopEffect();
        media?.removeEventListener('change', onMediaChange);
      });
    },
    theme,
    resolvedTheme,
    setTheme,
  };
  return controller;
}

/** The installed theme controller; throws when `createAppTheme` is missing. */
export function useTheme(): ThemeController {
  const controller = inject(themeInjectionKey);
  if (controller === undefined) {
    throw new Error('useTheme() requires the theme plugin (createAppTheme()) to be installed');
  }
  return controller;
}
