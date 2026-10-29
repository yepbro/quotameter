/**
 * Configuration permission enforcement (task 066, spec §6.3, §15.4; decision
 * D-019).
 *
 * The configuration file carries API keys and the password hash (D-004), so
 * spec §6.3 fixes its mode at `0600` and its directory's at `0700`, and
 * requires startup to verify the permissions — fixing them when possible,
 * refusing to continue otherwise. This module is that startup verifier: it
 * creates the configuration directory when absent (level by level, each
 * `mkdir` followed by an explicit `chmod`, so creation is umask-proof at
 * every depth), checks ownership and type of both objects, corrects
 * drifted modes with an explicit `chmod` (which, like the write path's
 * `fchmod` in decision D-016, is exempt from the process umask), and
 * re-reads the mode afterwards so a "fix" that the filesystem silently did
 * not apply still refuses startup.
 *
 * The module never creates the configuration file: file creation with
 * `0600` by construction belongs to the atomic write path (`write.ts`,
 * D-016), and an empty placeholder would be invalid JSON for the loader
 * (task 064). An absent file has no permissions to verify and passes.
 *
 * The check is exposed as a lifecycle component for the task-060 seam, in
 * the shape 074 established: `start` enforces and throws an actionable
 * English error on refusal — `QuotameterApp` turns that into an aborted
 * startup through its rollback — and `stop` is a no-op, because the check
 * holds no resources. The component type is structural on purpose: the
 * config layer may not import server code (package layout), so the
 * assignability to `LifecycleComponent` is proven by the composition root
 * and tests, not by an import.
 */

import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_FILE_MODE } from './write';

/**
 * Mode required for the configuration directory by spec §6.3/§15.4. The
 * directory is the outer wall around the secret-bearing file, so no group
 * or other access is ever permitted (decision D-004).
 */
export const CONFIG_DIR_MODE = 0o700;

/** Outcome of enforcing one filesystem object. */
export type PermissionState = 'created' | 'absent' | 'secure' | 'corrected';

/** What {@link enforceConfigPermissions} found and did, per object. */
export interface PermissionsResult {
  /** Directory state: `created` (was absent), `secure`, or `corrected`. */
  readonly configDir: Exclude<PermissionState, 'absent'>;
  /**
   * File state: `absent` (nothing to verify — creation belongs to the write
   * path), `secure`, or `corrected`.
   */
  readonly configFile: Exclude<PermissionState, 'created'>;
}

/**
 * The filesystem primitives enforcement needs, injectable so integration
 * tests can simulate a hostile umask on creation and failed or ineffective
 * `chmod` calls while real I/O still runs. Production callers never pass it.
 */
export interface PermissionsFilesystem {
  lstat(target: string): Promise<Stats>;
  /** Creates one directory level (non-recursive; walking is the module's). */
  mkdir(target: string, options: { mode: number }): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
}

const realFilesystem: PermissionsFilesystem = {
  lstat: (target) => lstat(target),
  mkdir: (target, options) => mkdir(target, options),
  chmod: (target, mode) => chmod(target, mode),
};

/** Options of {@link enforceConfigPermissions}; the optional ones are seams. */
export interface EnforcePermissionsOptions {
  /** Configuration directory (spec §6.1 resolution is the caller's, task 063). */
  readonly configDir: string;
  /** Configuration file path; naming is the loader's (task 064). */
  readonly configFile: string;
  /** Filesystem primitives; defaults to the real `node:fs/promises`. */
  readonly filesystem?: PermissionsFilesystem;
  /** Running user id; defaults to `process.getuid`. */
  readonly getuid?: () => number | undefined;
}

/**
 * The permission check as a lifecycle component (task 060 seam, 074 shape).
 *
 * Structurally the `LifecycleComponent` of `src/server/app.ts`: `start`
 * enforces and throws on refusal, aborting startup through the app's
 * rollback; `stop` is a no-op — enforcement holds nothing to release.
 */
export interface PermissionsCheckComponent {
  /** Stable identifier used in lifecycle events and diagnostics. */
  readonly name: string;
  /** Enforce permissions. Throwing aborts startup and rolls back predecessors. */
  start(): Promise<void>;
  /** Release resources. Infallible by the component contract; here nothing. */
  stop(): Promise<void>;
}

/** Component name reported through lifecycle events. */
const COMPONENT_NAME = 'config-permissions';

/**
 * Wraps {@link enforceConfigPermissions} as a lifecycle component: `start`
 * runs the check once, `stop` does nothing.
 */
export function createPermissionsCheck(
  options: EnforcePermissionsOptions,
): PermissionsCheckComponent {
  return {
    name: COMPONENT_NAME,
    async start() {
      await enforceConfigPermissions(options);
    },
    async stop() {},
  };
}

/**
 * Verifies and, where possible, corrects the permissions of the
 * configuration directory (`0700`) and configuration file (`0600`).
 *
 * Creates the directory when absent (level by level, each level chmod-ed
 * to the required mode, so the result is umask-proof at every depth). An absent file passes: creation with the
 * pinned mode belongs to the atomic write path (D-016). Anything not
 * correctable — a symlinked object, a wrong type, foreign ownership, a
 * failed or ineffective `chmod`, an undeterminable uid — throws an
 * actionable English error, which the lifecycle seam turns into a startup
 * refusal.
 */
export async function enforceConfigPermissions(
  options: EnforcePermissionsOptions,
): Promise<PermissionsResult> {
  const deps = {
    filesystem: options.filesystem ?? realFilesystem,
    getuid: options.getuid ?? (() => process.getuid?.()),
    configDir: options.configDir,
    configFile: options.configFile,
  };
  const uid = deps.getuid();
  if (uid === undefined) {
    throw refusal(
      'cannot determine the uid of the running process to verify configuration permissions',
    );
  }
  return {
    configDir: await ensureDirectory(deps, uid),
    configFile: await ensureFile(deps, uid),
  };
}

/** Resolved dependencies shared by the per-object enforcement steps. */
interface PermissionDeps {
  readonly filesystem: PermissionsFilesystem;
  readonly getuid: () => number | undefined;
  readonly configDir: string;
  readonly configFile: string;
}

/** The kind of object an enforcement step expects at its path. */
type ObjectKind = 'directory' | 'file';

/**
 * Ensures the configuration directory exists with mode exactly `0700`.
 *
 * An absent directory is created level by level (see {@link createLevels});
 * only the final directory carries the enforced checks, because spec §6.3
 * pins the configuration directory itself and the ancestors hold no
 * secrets — pre-existing ancestors are never touched. Whether the
 * directory existed or was just created, the same checks then apply: real
 * directory, owned by the running user, exact mode.
 */
async function ensureDirectory(
  deps: PermissionDeps,
  uid: number,
): Promise<'created' | 'secure' | 'corrected'> {
  const existing = await tryLstat(deps, deps.configDir, 'configuration directory');
  if (existing !== null) {
    return checkAndFix(deps, existing, 'directory', CONFIG_DIR_MODE, uid);
  }
  await createLevels(deps, deps.configDir);
  const created = await mustLstat(deps, deps.configDir, 'configuration directory');
  await checkAndFix(deps, created, 'directory', CONFIG_DIR_MODE, uid);
  return 'created';
}

/**
 * Creates the missing levels of the directory path one at a time, each
 * `mkdir` followed by an explicit `chmod` to `CONFIG_DIR_MODE`.
 *
 * A recursive `mkdir` applies `mode & ~umask` to every level it creates,
 * so a umask containing the owner-execute bit (e.g. `0177`) would leave
 * the first new ancestor at `0600` — untraversable — and the next level's
 * creation would fail `EACCES`, with a refusal pointing at the final path
 * while this module's own ancestor is the obstacle. Creating stepwise and
 * chmod-ing each level before descending keeps creation working under any
 * umask (the per-level counterpart of the write path's `fchmod`,
 * decision D-016). A level that appears concurrently (`EEXIST`) is left to
 * its creator and not chmod'd — the final checks verify the outcome.
 */
async function createLevels(deps: PermissionDeps, dirPath: string): Promise<void> {
  const missing: string[] = [];
  for (let current = dirPath; ;) {
    const stats = await tryLstat(deps, current, 'configuration directory');
    if (stats !== null) break;
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const level of missing.reverse()) {
    try {
      await deps.filesystem.mkdir(level, { mode: CONFIG_DIR_MODE });
      await deps.filesystem.chmod(level, CONFIG_DIR_MODE);
    } catch (error) {
      if (errnoIs(error, 'EEXIST')) continue;
      throw refusal(`cannot create configuration directory ${dirPath}: ${describeCause(error)}`, {
        cause: error,
      });
    }
  }
}

/**
 * Verifies the configuration file: an absent file passes (`'absent'` —
 * creation with mode `0600` by construction is the write path's, D-016); a
 * present one must be a regular file owned by the running user with mode
 * exactly `0600`.
 */
async function ensureFile(
  deps: PermissionDeps,
  uid: number,
): Promise<'absent' | 'secure' | 'corrected'> {
  const stats = await tryLstat(deps, deps.configFile, 'configuration file');
  if (stats === null) return 'absent';
  return checkAndFix(deps, stats, 'file', CONFIG_FILE_MODE, uid);
}

/**
 * Checks one existing object and corrects its mode when drifted.
 *
 * Refuses (never attempts to fix) when the object is a symbolic link, is of
 * the wrong type, or belongs to another user — none of those is correctable
 * by `chmod`, and a symlink would silently redirect where the fix lands. A
 * drifted mode is corrected with an explicit `chmod` (umask-exempt, like
 * the write path's `fchmod`, decision D-016) and verified by re-reading the
 * mode, so a filesystem that accepts but does not apply the change still
 * refuses startup. The check covers the permission and special bits
 * (`mode & 0o7777`): setuid/setgid/sticky are not part of the spec modes
 * and are cleared by the same `chmod`.
 */
async function checkAndFix(
  deps: PermissionDeps,
  stats: Stats,
  kind: ObjectKind,
  requiredMode: number,
  uid: number,
): Promise<'secure' | 'corrected'> {
  const target = kind === 'directory' ? deps.configDir : deps.configFile;
  const noun = kind === 'directory' ? 'configuration directory' : 'configuration file';
  if (stats.isSymbolicLink()) {
    throw refusal(
      `${noun} ${target} is a symbolic link; replace it with a real ` +
        `${kind} so the secrets stay on the operator-controlled path`,
    );
  }
  if (!hasKind(stats, kind)) {
    throw refusal(`${noun} ${target} is not a ${expectedTypeOf(kind)}`);
  }
  if (stats.uid !== uid) {
    throw refusal(
      `${noun} ${target} is owned by uid ${stats.uid}, but the service runs as ` +
        `uid ${uid}; chown it to the running user and start again`,
    );
  }
  const currentMode = stats.mode & 0o7777;
  if (currentMode === requiredMode) return 'secure';
  try {
    await deps.filesystem.chmod(target, requiredMode);
  } catch (error) {
    throw refusal(
      `cannot correct permissions of ${noun} ${target} from ${octal(currentMode)} ` +
        `to ${octal(requiredMode)}: ${describeCause(error)}`,
      { cause: error },
    );
  }
  const after = await mustLstat(deps, target, noun);
  const afterMode = after.mode & 0o7777;
  if (afterMode !== requiredMode) {
    throw refusal(
      `${noun} ${target} still reports mode ${octal(afterMode)} after the correction ` +
        `to ${octal(requiredMode)}; the filesystem did not apply the change`,
    );
  }
  return 'corrected';
}

/** `lstat` that maps `ENOENT` to `null`; other failures refuse with context. */
async function tryLstat(deps: PermissionDeps, target: string, noun: string): Promise<Stats | null> {
  try {
    return await deps.filesystem.lstat(target);
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null;
    throw refusal(`cannot inspect ${noun} ${target}: ${describeCause(error)}`, { cause: error });
  }
}

/** `lstat` for a path that must exist; any failure refuses with context. */
async function mustLstat(deps: PermissionDeps, target: string, noun: string): Promise<Stats> {
  try {
    return await deps.filesystem.lstat(target);
  } catch (error) {
    throw refusal(
      `${noun} ${target} cannot be inspected after the change: ${describeCause(error)}`,
      {
        cause: error,
      },
    );
  }
}

/** True when `stats` is of the expected filesystem object kind. */
function hasKind(stats: Stats, kind: ObjectKind): boolean {
  return kind === 'directory' ? stats.isDirectory() : stats.isFile();
}

/** Human phrase for the expected type, used in type-mismatch refusals. */
function expectedTypeOf(kind: ObjectKind): string {
  return kind === 'directory' ? 'directory' : 'regular file';
}

/** A deliberate startup refusal: actionable English, never wrapped again. */
class PermissionsRefusedError extends Error {}

/** Builds a refusal error; the lifecycle seam turns it into aborted startup. */
function refusal(message: string, options?: { cause: unknown }): PermissionsRefusedError {
  return new PermissionsRefusedError(`refusing to start: ${message}`, options);
}

/** True when the thrown value carries the given filesystem error code. */
function errnoIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/** Renders a filesystem failure for an error message, with its errno code. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `(${code}) ${error.message}`;
  }
  return String(error);
}

/** Formats a mode as an octal literal, e.g. `0o644`, for error messages. */
function octal(mode: number): string {
  return `0o${mode.toString(8)}`;
}
