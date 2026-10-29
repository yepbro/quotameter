/**
 * XDG base-directory resolution for the configuration and data directories
 * (spec §6.1).
 *
 * Pure functions: given an environment snapshot they return absolute,
 * normalized directory paths. Creating the directories and enforcing their
 * permissions is owned by the startup path (task 066); naming and loading
 * files inside them is owned by config loading (task 064).
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** Application segment appended under the XDG base directories (§6.1). */
const APP_DIR = 'quotameter';

/** Environment snapshot read by the resolvers; injectable for deterministic tests. */
export type PathEnv = NodeJS.ProcessEnv;

/** Both resolved directories, for consumers that need them together. */
export interface ResolvedPaths {
  /** Directory that holds the configuration file (§6.1). */
  configDir: string;
  /** Directory that holds the database and other state (§6.1). */
  dataDir: string;
}

/**
 * Resolves the configuration directory (spec §6.1).
 *
 * Precedence, highest first:
 *
 * 1. `QUOTAMETER_CONFIG_DIR` — the value is the directory itself (no
 *    `quotameter` segment appended); a relative value is anchored to the
 *    current working directory rather than silently discarded, because an
 *    explicit override must never redirect secrets back to the default.
 * 2. `XDG_CONFIG_HOME` + `quotameter` — honored only when absolute: the XDG
 *    Base Directory Specification requires absolute paths and leaves relative
 *    values undefined, so they fall through instead of making the result
 *    depend on the working directory.
 * 3. Default `<home>/.config/quotameter`, where `<home>` is an absolute
 *    `HOME` from the snapshot, else `os.homedir()` (also required absolute);
 *    resolution throws when neither yields a usable directory (D-012).
 *
 * An empty string counts as unset at every level, matching the XDG wording
 * "either not set or empty".
 */
export function resolveConfigDir(
  env: PathEnv = process.env,
  getHomeDir: () => string = os.homedir,
): string {
  const override = overrideDir(env.QUOTAMETER_CONFIG_DIR);
  if (override !== null) return override;
  const xdg = xdgAppDir(env.XDG_CONFIG_HOME);
  if (xdg !== null) return xdg;
  return path.join(homeDir(env, getHomeDir), '.config', APP_DIR);
}

/**
 * Resolves the data directory (spec §6.1).
 *
 * Same precedence as {@link resolveConfigDir} with `QUOTAMETER_DATA_DIR`,
 * `XDG_DATA_HOME`, and the default `<home>/.local/share/quotameter`.
 */
export function resolveDataDir(
  env: PathEnv = process.env,
  getHomeDir: () => string = os.homedir,
): string {
  const override = overrideDir(env.QUOTAMETER_DATA_DIR);
  if (override !== null) return override;
  const xdg = xdgAppDir(env.XDG_DATA_HOME);
  if (xdg !== null) return xdg;
  return path.join(homeDir(env, getHomeDir), '.local', 'share', APP_DIR);
}

/**
 * Resolves both directories from one environment snapshot; see
 * {@link resolveConfigDir} and {@link resolveDataDir} for the precedence
 * rules. Both directories are resolved independently — a variable affecting
 * one never affects the other.
 *
 * All values are used verbatim: a leading `~` is not expanded (decision
 * D-012), matching the XDG Base Directory Specification's lack of shell
 * expansion.
 */
export function resolvePaths(
  env: PathEnv = process.env,
  getHomeDir: () => string = os.homedir,
): ResolvedPaths {
  return {
    configDir: resolveConfigDir(env, getHomeDir),
    dataDir: resolveDataDir(env, getHomeDir),
  };
}

/** Explicit override: the value is the directory itself, relative to cwd. */
function overrideDir(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return path.resolve(value);
}

/** XDG base directory: honored only when non-empty and absolute. */
function xdgAppDir(value: string | undefined): string | null {
  if (value === undefined || !isAbsoluteDir(value)) return null;
  return path.resolve(value, APP_DIR);
}

/**
 * Home directory for the XDG defaults: an absolute `HOME` from the snapshot,
 * else the OS lookup — which must be absolute too (decision D-012).
 */
function homeDir(env: PathEnv, getHomeDir: () => string): string {
  const fromEnv = env.HOME;
  if (fromEnv !== undefined && isAbsoluteDir(fromEnv)) return fromEnv;
  const fallback = getHomeDir();
  if (!isAbsoluteDir(fallback)) {
    throw new Error(
      'Cannot determine an absolute home directory for the XDG default paths: ' +
        'HOME is unset or relative and the operating-system lookup returned nothing usable',
    );
  }
  return fallback;
}

/** The only values honored as base directories: non-empty and absolute. */
function isAbsoluteDir(value: string): boolean {
  return value !== '' && path.isAbsolute(value);
}
