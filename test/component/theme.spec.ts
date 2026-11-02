import { mount } from '@vue/test-utils';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  createAppTheme,
  isTheme,
  THEME_STORAGE_KEY,
  THEMES,
  useTheme,
  type ThemeController,
} from '../../ui/src/theme';
import { FakeThemeMedia, MemoryThemeStorage } from '../helpers/theme';

/**
 * The theme controller (spec §14.1; decision D-133): default mode,
 * persistence round-trip with invalid-value handling, the live
 * `data-theme` application mechanism, and `system`-mode reactivity to
 * the OS preference. Every case installs a fresh controller with
 * in-memory seams — no happy-dom globals, no cross-test state.
 */

/** Renders the controller state through a component: the reactivity pin. */
const Probe = defineComponent({
  setup() {
    const { theme, resolvedTheme } = useTheme();
    return () => h('output', `${theme.value}:${resolvedTheme.value}`);
  },
});

async function mountProbe(controller: ThemeController) {
  const wrapper = mount(Probe, { global: { plugins: [controller] } });
  await nextTick();
  return wrapper;
}

function controllerWith(
  initial: Record<string, string> = {},
  media: FakeThemeMedia = new FakeThemeMedia(),
): { controller: ThemeController; storage: MemoryThemeStorage; media: FakeThemeMedia } {
  const storage = new MemoryThemeStorage(initial);
  return { controller: createAppTheme({ storage, media }), storage, media };
}

describe('theme controller (spec §14.1)', () => {
  it('defaults to system with nothing stored, resolving light on a light OS', async () => {
    const { controller } = controllerWith();
    const wrapper = await mountProbe(controller);
    expect(controller.theme.value).toBe('system');
    expect(controller.resolvedTheme.value).toBe('light');
    expect(wrapper.text()).toBe('system:light');
  });

  it.each([...THEMES])('reads the persisted value %s', async (mode) => {
    const { controller } = controllerWith({ [THEME_STORAGE_KEY]: mode });
    await mountProbe(controller);
    expect(controller.theme.value).toBe(mode);
  });

  it.each(['banana', '', 'SYSTEM', 'light dark', 'null'])(
    'falls back to system for the invalid stored value %j',
    async (stored) => {
      const { controller } = controllerWith({ [THEME_STORAGE_KEY]: stored });
      await mountProbe(controller);
      expect(controller.theme.value).toBe('system');
    },
  );

  it('falls back to system when the storage read throws', async () => {
    const controller = createAppTheme({
      storage: {
        getItem: () => {
          throw new Error('storage unavailable');
        },
        setItem: () => undefined,
      },
      media: new FakeThemeMedia(),
    });
    await mountProbe(controller);
    expect(controller.theme.value).toBe('system');
  });

  it('persists each selection under the storage key', async () => {
    const { controller, storage } = controllerWith();
    await mountProbe(controller);
    for (const mode of ['dark', 'light', 'system'] as const) {
      controller.setTheme(mode);
      expect(storage.getItem(THEME_STORAGE_KEY)).toBe(mode);
    }
  });

  it('applies the data-theme attribute live, removing it for system', async () => {
    const { controller } = controllerWith();
    await mountProbe(controller);
    const root = document.documentElement;
    expect(root.hasAttribute('data-theme')).toBe(false); // system default

    controller.setTheme('dark');
    await nextTick();
    expect(root.getAttribute('data-theme')).toBe('dark');

    controller.setTheme('light');
    await nextTick();
    expect(root.getAttribute('data-theme')).toBe('light');

    controller.setTheme('system');
    await nextTick();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps switching when persistence fails (best-effort storage)', async () => {
    const controller = createAppTheme({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
      media: new FakeThemeMedia(),
    });
    await mountProbe(controller);
    expect(() => controller.setTheme('dark')).not.toThrow();
    await nextTick();
    expect(controller.theme.value).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('system mode tracks OS preference flips live', async () => {
    const media = new FakeThemeMedia();
    const { controller } = controllerWith({}, media);
    const wrapper = await mountProbe(controller);

    media.setPrefersDark(true);
    await nextTick();
    expect(controller.resolvedTheme.value).toBe('dark');
    expect(wrapper.text()).toBe('system:dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    media.setPrefersDark(false);
    await nextTick();
    expect(controller.resolvedTheme.value).toBe('light');
    expect(wrapper.text()).toBe('system:light');
  });

  it('resolves light by default when no media seam exists', async () => {
    const controller = createAppTheme({ storage: new MemoryThemeStorage(), media: null });
    await mountProbe(controller);
    expect(controller.resolvedTheme.value).toBe('light');
  });

  it.each([
    { mode: 'light', osDark: true },
    { mode: 'dark', osDark: false },
  ] as const)(
    'explicit $mode ignores the OS preference (OS dark: $osDark)',
    async ({ mode, osDark }) => {
      const media = new FakeThemeMedia();
      media.setPrefersDark(osDark); // before install: the initial read sees it too
      const { controller } = controllerWith({ [THEME_STORAGE_KEY]: mode }, media);
      const wrapper = await mountProbe(controller);

      expect(controller.resolvedTheme.value).toBe(mode);
      expect(document.documentElement.getAttribute('data-theme')).toBe(mode);

      media.setPrefersDark(!osDark); // flips must not move an explicit mode
      await nextTick();
      expect(controller.resolvedTheme.value).toBe(mode);
      expect(document.documentElement.getAttribute('data-theme')).toBe(mode);
      expect(wrapper.text()).toBe(`${mode}:${mode}`);
    },
  );

  it('isTheme accepts exactly the three modes', () => {
    for (const mode of THEMES) expect(isTheme(mode)).toBe(true);
    for (const value of ['banana', '', null, undefined, 1, {}, 'System']) {
      expect(isTheme(value)).toBe(false);
    }
  });

  it('useTheme() throws when the plugin is not installed', () => {
    // Mounted through a component so inject() runs inside setup() — the
    // documented contract — and the error is captured through the app's
    // error handler instead of Vue's dev-time stderr warning.
    const failures: Error[] = [];
    const app = createApp(
      defineComponent({
        setup() {
          useTheme();
          return () => null;
        },
      }),
    );
    app.config.errorHandler = (error) => {
      failures.push(error as Error);
    };
    app.mount(document.createElement('div'));
    expect(failures.map((error) => error.message).join('\n')).toMatch(/createAppTheme/);
  });

  it('stops the attribute effect and the media listener on app unmount', async () => {
    const media = new FakeThemeMedia();
    const { controller } = controllerWith({}, media);
    const wrapper = await mountProbe(controller);
    expect(media.listenerCount).toBe(1);

    controller.setTheme('dark');
    await nextTick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    wrapper.unmount();
    expect(media.listenerCount).toBe(0);

    // The detached-app contract: no further DOM writes, no media updates.
    controller.setTheme('light');
    await nextTick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    const resolvedBefore = controller.resolvedTheme.value;
    media.setPrefersDark(true);
    await nextTick();
    expect(controller.resolvedTheme.value).toBe(resolvedBefore);

    // Leave the shared document clean for the next test.
    document.documentElement.removeAttribute('data-theme');
  });
});
