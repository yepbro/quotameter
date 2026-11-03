import { createApp } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SELECTION_STORAGE_KEY,
  createAccountSelection,
  useAccountSelection,
} from '../../ui/src/account-selection';
import { MemoryThemeStorage } from '../helpers/theme';

/**
 * The selected-account store (task 170, decision D-135): the persisted
 * choice, its null semantics, and the provide/inject seam — driven
 * through the injectable storage so no test touches a browser global.
 * `MemoryThemeStorage` is structurally the storage seam (getItem/
 * setItem), the D-133 precedent reused.
 */

describe('account selection store (task 170, D-135)', () => {
  it('reads a stored id back verbatim', () => {
    const storage = new MemoryThemeStorage({ [ACCOUNT_SELECTION_STORAGE_KEY]: 'acc-main' });
    const selection = createAccountSelection({ storage });
    expect(selection.selectedId.value).toBe('acc-main');
  });

  it('reads absent, empty, and non-string stored values as null', () => {
    expect(createAccountSelection({ storage: new MemoryThemeStorage() }).selectedId.value).toBe(
      null,
    );
    const empty = new MemoryThemeStorage({ [ACCOUNT_SELECTION_STORAGE_KEY]: '' });
    expect(createAccountSelection({ storage: empty }).selectedId.value).toBe(null);
  });

  it('a throwing storage read degrades to no selection, not a broken page', () => {
    const storage = new MemoryThemeStorage();
    storage.getItem = () => {
      throw new Error('storage blocked');
    };
    expect(createAccountSelection({ storage }).selectedId.value).toBe(null);
  });

  it('select() updates the ref and persists', () => {
    const storage = new MemoryThemeStorage();
    const selection = createAccountSelection({ storage });
    selection.select('acc-2');
    expect(selection.selectedId.value).toBe('acc-2');
    expect(storage.getItem(ACCOUNT_SELECTION_STORAGE_KEY)).toBe('acc-2');
  });

  it('select(null) clears the ref and persists the empty spelling', () => {
    const storage = new MemoryThemeStorage({ [ACCOUNT_SELECTION_STORAGE_KEY]: 'acc-main' });
    const selection = createAccountSelection({ storage });
    selection.select(null);
    expect(selection.selectedId.value).toBe(null);
    expect(storage.getItem(ACCOUNT_SELECTION_STORAGE_KEY)).toBe('');
  });

  it('a failing write never breaks in-session selection (best effort)', () => {
    const storage = new MemoryThemeStorage();
    storage.setItem = () => {
      throw new Error('quota full');
    };
    const selection = createAccountSelection({ storage });
    selection.select('acc-9');
    expect(selection.selectedId.value).toBe('acc-9');
  });

  it('reads `window.localStorage` by default (the composition-root wiring)', () => {
    window.localStorage.setItem(ACCOUNT_SELECTION_STORAGE_KEY, 'acc-default');
    try {
      expect(createAccountSelection().selectedId.value).toBe('acc-default');
    } finally {
      window.localStorage.removeItem(ACCOUNT_SELECTION_STORAGE_KEY);
    }
  });

  it('is installed as a plugin and consumed through useAccountSelection()', () => {
    const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
    const app = createApp({
      setup() {
        const injected = useAccountSelection();
        expect(injected).toBe(selection);
        expect(injected.selectedId.value).toBe(null);
      },
      render: () => null,
    });
    app.use(selection);
    app.mount(document.createElement('div'));
    app.unmount();
  });

  it('useAccountSelection() throws with its remedy when the plugin is missing', () => {
    const app = createApp({
      setup() {
        expect(() => useAccountSelection()).toThrow(/createAccountSelection/s);
      },
      render: () => null,
    });
    app.mount(document.createElement('div'));
    app.unmount();
  });

  it("an invalid stored value stays as-is — reconciliation is the consumer's rule", () => {
    // The store cannot know the account universe: a stale id (the
    // account purged elsewhere) reads back verbatim for the consumer's
    // list load to reconcile away.
    const storage = new MemoryThemeStorage({ [ACCOUNT_SELECTION_STORAGE_KEY]: 'gone' });
    const selection = createAccountSelection({ storage });
    selection.select('still-just-a-string');
    expect(selection.selectedId.value).toBe('still-just-a-string');
  });
});
