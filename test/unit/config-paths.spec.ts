import * as path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { resolveConfigDir, resolveDataDir, resolvePaths } from '../../src/config/paths';
import type { ResolvedPaths } from '../../src/config/paths';

/**
 * Locks XDG path resolution (spec §6.1): defaults, `XDG_CONFIG_HOME` /
 * `XDG_DATA_HOME`, explicit `QUOTAMETER_CONFIG_DIR` / `QUOTAMETER_DATA_DIR`
 * overrides, their precedence, and the edge semantics pinned in D-011/D-012
 * (empty means unset, relative XDG values are ignored, relative overrides
 * are anchored to cwd, home must resolve to an absolute directory — a
 * relative `HOME` falls through to the OS lookup and a unusable lookup
 * throws — and values are verbatim with no `~` expansion).
 */

/** Environment snapshot containing only the variables under test. */
function env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...vars };
}

/** Home-directory fallback that never touches the real environment. */
const fallbackHome = () => '/fallback/home';

describe('resolveConfigDir', () => {
  it('uses the XDG default under HOME when nothing is overridden', () => {
    expect(resolveConfigDir(env({ HOME: '/home/alice' }))).toBe('/home/alice/.config/quotameter');
  });

  it('appends the application segment to an absolute XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir(env({ XDG_CONFIG_HOME: '/xdg/conf' }))).toBe('/xdg/conf/quotameter');
  });

  it('treats an empty XDG_CONFIG_HOME as unset', () => {
    expect(resolveConfigDir(env({ HOME: '/home/alice', XDG_CONFIG_HOME: '' }))).toBe(
      '/home/alice/.config/quotameter',
    );
  });

  it('ignores a relative XDG_CONFIG_HOME instead of resolving it against cwd', () => {
    expect(resolveConfigDir(env({ HOME: '/home/alice', XDG_CONFIG_HOME: 'rel/conf' }))).toBe(
      '/home/alice/.config/quotameter',
    );
  });

  it('normalizes dot segments and trailing separators in XDG values', () => {
    expect(resolveConfigDir(env({ XDG_CONFIG_HOME: '/xdg/./conf/' }))).toBe('/xdg/conf/quotameter');
  });

  it('uses QUOTAMETER_CONFIG_DIR as the directory itself, ahead of XDG', () => {
    expect(
      resolveConfigDir(env({ XDG_CONFIG_HOME: '/xdg/conf', QUOTAMETER_CONFIG_DIR: '/q/conf' })),
    ).toBe('/q/conf');
  });

  it('treats an empty QUOTAMETER_CONFIG_DIR as unset so XDG applies', () => {
    expect(resolveConfigDir(env({ XDG_CONFIG_HOME: '/xdg/conf', QUOTAMETER_CONFIG_DIR: '' }))).toBe(
      '/xdg/conf/quotameter',
    );
  });

  it('anchors a relative QUOTAMETER_CONFIG_DIR to the working directory', () => {
    expect(resolveConfigDir(env({ QUOTAMETER_CONFIG_DIR: 'rel/qc' }))).toBe(
      path.join(process.cwd(), 'rel/qc'),
    );
  });

  it('strips trailing separators from an override', () => {
    expect(resolveConfigDir(env({ QUOTAMETER_CONFIG_DIR: '/q/conf/' }))).toBe('/q/conf');
  });

  it('falls back to the OS home lookup when HOME is absent', () => {
    expect(resolveConfigDir(env(), fallbackHome)).toBe('/fallback/home/.config/quotameter');
  });

  it('falls back to the OS home lookup when HOME is empty', () => {
    expect(resolveConfigDir(env({ HOME: '' }), fallbackHome)).toBe(
      '/fallback/home/.config/quotameter',
    );
  });

  it('falls back to the OS home lookup when HOME is relative', () => {
    expect(resolveConfigDir(env({ HOME: 'rel/home' }), fallbackHome)).toBe(
      '/fallback/home/.config/quotameter',
    );
  });

  it('prefers a set HOME over the OS home lookup', () => {
    expect(resolveConfigDir(env({ HOME: '/home/alice' }), fallbackHome)).toBe(
      '/home/alice/.config/quotameter',
    );
  });

  it('throws when neither HOME nor the OS lookup yields a directory', () => {
    expect(() => resolveConfigDir(env(), () => '')).toThrow(/home directory/i);
  });

  it('throws when the OS lookup yields only a relative directory', () => {
    expect(() => resolveConfigDir(env({ HOME: 'rel/home' }), () => 'rel/fallback')).toThrow(
      /home directory/i,
    );
  });

  it('uses a tilde-bearing override verbatim without shell expansion', () => {
    expect(resolveConfigDir(env({ QUOTAMETER_CONFIG_DIR: '~/conf' }))).toBe(
      path.join(process.cwd(), '~/conf'),
    );
  });
});

describe('resolveDataDir', () => {
  it('uses the XDG default under HOME when nothing is overridden', () => {
    expect(resolveDataDir(env({ HOME: '/home/alice' }))).toBe(
      '/home/alice/.local/share/quotameter',
    );
  });

  it('appends the application segment to an absolute XDG_DATA_HOME', () => {
    expect(resolveDataDir(env({ XDG_DATA_HOME: '/xdg/data' }))).toBe('/xdg/data/quotameter');
  });

  it('ignores empty and relative XDG_DATA_HOME values', () => {
    expect(resolveDataDir(env({ HOME: '/home/alice', XDG_DATA_HOME: '' }))).toBe(
      '/home/alice/.local/share/quotameter',
    );
    expect(resolveDataDir(env({ HOME: '/home/alice', XDG_DATA_HOME: 'rel/data' }))).toBe(
      '/home/alice/.local/share/quotameter',
    );
  });

  it('uses QUOTAMETER_DATA_DIR as the directory itself, ahead of XDG', () => {
    expect(
      resolveDataDir(env({ XDG_DATA_HOME: '/xdg/data', QUOTAMETER_DATA_DIR: '/q/data' })),
    ).toBe('/q/data');
  });

  it('anchors a relative QUOTAMETER_DATA_DIR to the working directory', () => {
    expect(resolveDataDir(env({ QUOTAMETER_DATA_DIR: 'rel/qd' }))).toBe(
      path.join(process.cwd(), 'rel/qd'),
    );
  });

  it('strips trailing separators from an override', () => {
    expect(resolveDataDir(env({ QUOTAMETER_DATA_DIR: '/q/data/' }))).toBe('/q/data');
  });

  it('treats an empty QUOTAMETER_DATA_DIR as unset so the XDG default applies', () => {
    expect(
      resolveDataDir(env({ HOME: '/home/alice', XDG_DATA_HOME: '', QUOTAMETER_DATA_DIR: '' })),
    ).toBe('/home/alice/.local/share/quotameter');
  });

  it('falls back to the OS home lookup when HOME is absent', () => {
    expect(resolveDataDir(env(), fallbackHome)).toBe('/fallback/home/.local/share/quotameter');
  });

  it('throws when neither HOME nor the OS lookup yields a directory', () => {
    expect(() => resolveDataDir(env(), () => '')).toThrow(/home directory/i);
  });
});

describe('resolvePaths', () => {
  it('resolves both directories independently from one snapshot', () => {
    const paths = resolvePaths(
      env({
        HOME: '/home/alice',
        QUOTAMETER_CONFIG_DIR: '/q/conf',
      }),
      fallbackHome,
    );
    // The config override must not leak into the data directory.
    expect(paths).toEqual({
      configDir: '/q/conf',
      dataDir: '/home/alice/.local/share/quotameter',
    });
  });

  it('applies QUOTAMETER_* ahead of XDG_* for both directories at once', () => {
    expect(
      resolvePaths(
        env({
          XDG_CONFIG_HOME: '/xdg/conf',
          XDG_DATA_HOME: '/xdg/data',
          QUOTAMETER_CONFIG_DIR: '/q/conf',
          QUOTAMETER_DATA_DIR: '/q/data',
        }),
        fallbackHome,
      ),
    ).toEqual({ configDir: '/q/conf', dataDir: '/q/data' });
  });

  it('exposes string fields on the ResolvedPaths shape', () => {
    const paths = resolvePaths(env({ HOME: '/home/alice' }), fallbackHome);
    expectTypeOf(paths).toEqualTypeOf<ResolvedPaths>();
    expectTypeOf(paths.configDir).toBeString();
    expectTypeOf(paths.dataDir).toBeString();
  });

  it('defaults to the process environment when no snapshot is given', () => {
    expect(resolvePaths()).toEqual(resolvePaths(process.env));
  });

  it('returns absolute directories on the default path', () => {
    const paths = resolvePaths();
    expect(path.isAbsolute(paths.configDir)).toBe(true);
    expect(path.isAbsolute(paths.dataDir)).toBe(true);
  });
});
