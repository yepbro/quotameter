import { inject, ref, type App, type InjectionKey, type Ref } from 'vue';

/**
 * The selected-account store (task 170, spec §14.2; decision D-135): the
 * cross-page selection the account-management page sets and the overview
 * (task 172) and the history charts (174–178) read.
 *
 * A factory + plugin + inject getter, exactly the router (D-131), i18n
 * (D-132), theme (D-133), and API client (D-134) shape: the composition
 * root installs the real controller with the browser storage, component
 * tests install their own per mount — no module singleton, no cross-test
 * state. §3 keeps runtime dependencies minimal, so this is a composable,
 * not a Pinia store (the `ui/src/stores/` reservation stays unused).
 *
 * The store deliberately knows nothing about accounts beyond their ids:
 * which ids exist is list data the consumers already load, so
 * reconciliation lives there (documented in `ui/README.md`): on every
 * accounts-list load, keep the stored id when it is listed, else select
 * the first account, else nothing. A stored id the server no longer
 * lists (removed elsewhere, a stale browser) reads back verbatim and is
 * reconciled away by the first consumer that loads a list — the store
 * cannot validate what it cannot see.
 */

/** The browser-storage key carrying the persisted selection (D-135). */
export const ACCOUNT_SELECTION_STORAGE_KEY = 'quotameter.selected-account';

/** The persistence seam: the `localStorage` surface the controller uses. */
export interface AccountSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The selection controller the plugin provides and the pages consume. */
export interface AccountSelectionController {
  /** Vue plugin installation — provides the controller to the app. */
  install(app: App): void;
  /** The selected account id; `null` when nothing is selected. */
  readonly selectedId: Ref<string | null>;
  /**
   * Selects an account, or clears the selection with `null`. Persists
   * best effort (a cleared selection persists as the empty string, so
   * an explicit "no account" survives a reload too).
   */
  select(id: string | null): void;
}

const selectionInjectionKey: InjectionKey<AccountSelectionController> = Symbol(
  'quotameter-account-selection',
);

/** Storage that persists nothing — the fallback when access throws. */
const nullStorage: AccountSelectionStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

function defaultStorage(): AccountSelectionStorage {
  try {
    return window.localStorage;
  } catch {
    // Reading `window.localStorage` itself throws in locked-down
    // contexts (all cookies blocked): the selection then lives in
    // memory — the D-133 theme persistence stance, applied verbatim.
    return nullStorage;
  }
}

/**
 * Creates the account-selection controller. The composition root passes
 * no options (the browser `localStorage`); component tests pass an
 * in-memory storage so the persisted choice is observable per mount.
 */
export function createAccountSelection(
  options: { storage?: AccountSelectionStorage } = {},
): AccountSelectionController {
  const storage = options.storage ?? defaultStorage();

  let stored: unknown = null;
  try {
    stored = storage.getItem(ACCOUNT_SELECTION_STORAGE_KEY);
  } catch {
    // A failing read degrades to no selection, not to a broken page.
  }
  // Any non-empty string is a candidate id; the id charset and the
  // account universe are the server's knowledge, reconciled by the
  // consumers (see the module docblock).
  const selectedId = ref<string | null>(
    typeof stored === 'string' && stored !== '' ? stored : null,
  );

  function select(id: string | null): void {
    selectedId.value = id;
    try {
      storage.setItem(ACCOUNT_SELECTION_STORAGE_KEY, id ?? '');
    } catch {
      // Best effort (D-133): a blocked or full storage must not break
      // in-session selection.
    }
  }

  const controller: AccountSelectionController = {
    install(app: App): void {
      app.provide(selectionInjectionKey, controller);
    },
    selectedId,
    select,
  };
  return controller;
}

/**
 * The installed selection controller; throws with its remedy when the
 * plugin is missing.
 */
export function useAccountSelection(): AccountSelectionController {
  const controller = inject(selectionInjectionKey);
  if (controller === undefined) {
    throw new Error(
      'useAccountSelection() requires the account-selection plugin (createAccountSelection()) to be installed',
    );
  }
  return controller;
}
