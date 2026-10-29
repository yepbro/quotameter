/**
 * Atomic configuration file writes (spec §6.3, §15.4; decision D-016).
 *
 * The only operation that ever changes the active file is the final
 * `rename` from a fully written, `fsync`-ed temporary file in the same
 * directory. An interrupted write — a rejected promise at any step, or a
 * hard process crash — therefore can never leave a partially written
 * configuration as the active file: it either leaves the previous file
 * untouched or, after a crash, an inert hidden temp file next to it.
 *
 * File naming (`config.json`) is owned by config loading (task 064); the
 * target path is a parameter. Directory creation and permission enforcement
 * (`0700`) are owned by the startup path (task 066) — a missing target
 * directory fails loudly here instead of being created silently.
 */

import type { FileHandle } from 'node:fs/promises';
import { open, rename, unlink } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Mode required for the configuration file by spec §6.3/§15.4. The file
 * carries API keys and the password hash, so no group or other access is
 * ever permitted (decision D-004).
 */
export const CONFIG_FILE_MODE = 0o600;

/**
 * The filesystem primitives the write path needs, injectable so integration
 * tests can observe ordering and inject failures while real I/O still runs.
 * Production callers never pass it.
 */
export interface WriteFilesystem {
  open(target: string, flags: string, mode: number): Promise<FileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

const realFilesystem: WriteFilesystem = { open, rename, unlink };

/**
 * Writes `config` as JSON to `targetPath` atomically.
 *
 * Steps: serialize, create a same-directory hidden temp file with `O_EXCL`
 * and mode `0600`, write the bytes, re-assert the mode (an explicit `fchmod`
 * defeats any process umask), `fsync`, close, then rename onto the target.
 * Any failure after the temp file exists removes it again and rethrows with
 * the original error as `cause`; the active file is untouched throughout.
 *
 * The resulting file always has mode exactly `0600`: `rename` replaces the
 * inode, so the replaced file's mode is not inherited — copying it would
 * propagate permissive drift, while pinning the spec mode corrects it
 * (decision D-016). Startup enforcement (task 066) remains the verifier of
 * last resort.
 *
 * A missing target directory is an error (`ENOENT` as `cause`), not
 * something to create: directory creation and `0700` enforcement belong to
 * the startup path (task 066).
 */
export async function writeConfigFile(
  targetPath: string,
  config: unknown,
  filesystem: WriteFilesystem = realFilesystem,
): Promise<void> {
  const text = serializeConfig(config);
  const tempPath = tempPathFor(targetPath);
  let handle: FileHandle | undefined;
  try {
    handle = await filesystem.open(tempPath, 'wx', CONFIG_FILE_MODE);
    await handle.writeFile(text, 'utf8');
    await handle.chmod(CONFIG_FILE_MODE);
    await handle.sync();
    await handle.close();
    await filesystem.rename(tempPath, targetPath);
  } catch (error) {
    // Close may or may not have run; FileHandle#close is idempotent. The
    // temp file was created by this call, so removing it is always safe —
    // unlike a name that already existed, which open('wx') would refuse.
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await filesystem.unlink(tempPath).catch(() => undefined);
    }
    throw new Error(`Failed to atomically write configuration file ${targetPath}`, {
      cause: error,
    });
  }
}

/**
 * Hand-editable representation (spec §6.2): pretty-printed JSON with a
 * trailing newline. Runs before any filesystem effect, so an unserializable
 * value — a circular structure, or a top-level value with no JSON
 * representation such as `undefined` or a function — aborts the write
 * without touching anything.
 */
function serializeConfig(config: unknown): string {
  const json = JSON.stringify(config, null, 2);
  if (typeof json !== 'string') {
    throw new TypeError('Configuration value has no JSON representation');
  }
  return `${json}\n`;
}

/**
 * Hidden sibling of the target: same directory (same filesystem, so the
 * final rename is atomic), name derived from the target so a crashed
 * writer's leftovers are recognizable — `.<basename>.tmp-<pid>-<random>`.
 * `O_EXCL` at creation refuses to follow or clobber anything already at the
 * name, so a predictable suffix cannot be abused.
 */
function tempPathFor(targetPath: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${suffix}`,
  );
}
