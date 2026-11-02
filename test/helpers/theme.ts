import type { ThemeMedia, ThemeStorage } from '../../ui/src/theme';

/**
 * Deterministic fakes for the theme controller's injectable seams
 * (task 168; decision D-133): component tests install per-mount
 * `MemoryThemeStorage` / `FakeThemeMedia` instead of the browser's
 * `localStorage` and `matchMedia`, so reads, writes, and system-
 * preference flips are observable and isolated from happy-dom globals.
 */

/** An in-memory `localStorage` surface with an inspectable map. */
export class MemoryThemeStorage implements ThemeStorage {
  private readonly entries = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.entries.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

/** A `(prefers-color-scheme: dark)` query whose state tests drive. */
export class FakeThemeMedia implements ThemeMedia {
  matches = false;

  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Flips the preference and notifies the listeners, browser order:
   * `matches` reads the new value by the time `change` handlers run. */
  setPrefersDark(dark: boolean): void {
    this.matches = dark;
    for (const listener of this.listeners) listener();
  }
}
