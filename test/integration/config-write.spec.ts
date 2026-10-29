import { chmod, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE_MODE, writeConfigFile } from '../../src/config/write';
import type { WriteFilesystem } from '../../src/config/write';
import { withTempDir } from '../helpers/isolation';

/**
 * Locks the atomic configuration write mechanism (spec §6.3, §15.4; decision
 * D-016) against the real filesystem: only the final rename may change the
 * active file, so every failure before it — rejected serializer, refused
 * temp-file creation, failed fsync, failed rename, or a hard crash that
 * leaves a stale temp behind — must leave the previous configuration
 * intact. The mode contract is exactly 0600 on every write, umask
 * notwithstanding, and permissive drift on an existing file is corrected.
 *
 * Observation and failure injection run through the injectable filesystem
 * (wrappers delegate to the real `node:fs/promises`) and per-instance
 * FileHandle method shadowing — every test performs real I/O.
 */

/** A small configuration value that round-trips through the file. */
function sampleConfig(label: string): Record<string, unknown> {
  return { app: { timezone: 'UTC', pollingIntervalSeconds: 300 }, label };
}

/** Reads a file's mode reduced to the permission bits. */
async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

/** Hooks the injected filesystem offers for observation and failure injection. */
interface FilesystemHooks {
  onOpen?: (target: string, flags: string, mode: number) => void;
  wrapHandle?: (handle: FileHandle) => FileHandle;
  renameImpl?: (oldPath: string, newPath: string) => Promise<void>;
}

/**
 * Real-filesystem primitives wrapped for observation: every call still
 * performs real I/O; `events` receives one label per call.
 */
function trackingFilesystem(events: string[], hooks: FilesystemHooks = {}): WriteFilesystem {
  return {
    async open(target, flags, mode) {
      events.push('open');
      hooks.onOpen?.(target, flags, mode);
      const handle = await open(target, flags, mode);
      return hooks.wrapHandle ? hooks.wrapHandle(handle) : handle;
    },
    async rename(oldPath, newPath) {
      if (hooks.renameImpl) {
        await hooks.renameImpl(oldPath, newPath);
        return;
      }
      events.push('rename');
      await rename(oldPath, newPath);
    },
    async unlink(target) {
      events.push('unlink');
      await unlink(target);
    },
  };
}

/**
 * Shadows the handle's methods with order-recording own properties that
 * delegate to the originals.
 */
function orderedHandle(handle: FileHandle, events: string[]): FileHandle {
  const writeFile = handle.writeFile.bind(handle);
  const chmod = handle.chmod.bind(handle);
  const sync = handle.sync.bind(handle);
  const close = handle.close.bind(handle);
  handle.writeFile = (data, options) => {
    events.push('write');
    return writeFile(data, options);
  };
  handle.chmod = (mode) => {
    events.push('chmod');
    return chmod(mode);
  };
  handle.sync = () => {
    events.push('sync');
    return sync();
  };
  handle.close = () => {
    events.push('close');
    return close();
  };
  return handle;
}

/** Shadows only `sync`, rejecting once — interruption before durability. */
function syncRejectingHandle(handle: FileHandle, failure: Error): FileHandle {
  handle.sync = () => Promise.reject(failure);
  return handle;
}

/**
 * Shadows only `writeFile`: writes half the payload, then rejects — an
 * interruption in the middle of producing the content.
 */
function writeRejectingHandle(handle: FileHandle, failure: Error): FileHandle {
  const writeFile = handle.writeFile.bind(handle);
  handle.writeFile = (data, options) =>
    writeFile((data as string).slice(0, Math.floor((data as string).length / 2)), options).then(
      () => Promise.reject(failure),
    );
  return handle;
}

/** Seeds an existing target file with the given content and mode. */
async function seedTarget(target: string, text: string, mode: number): Promise<void> {
  await writeFile(target, text, 'utf8');
  await chmod(target, mode);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeConfigFile — happy path', () => {
  it('writes pretty-printed JSON with a trailing newline', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const config = sampleConfig('first');

      await writeConfigFile(target, config, trackingFilesystem([]));

      await expect(readFile(target, 'utf8')).resolves.toBe(`${JSON.stringify(config, null, 2)}\n`);
    });
  });

  it('creates the target with mode exactly 0600 via an exclusive temp file', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const opened: Array<{ temp: string; flags: string; mode: number }> = [];

      await writeConfigFile(
        target,
        sampleConfig('modes'),
        trackingFilesystem([], {
          onOpen: (temp, flags, mode) => opened.push({ temp, flags, mode }),
        }),
      );

      expect(opened).toHaveLength(1);
      expect(opened[0]?.flags).toBe('wx');
      expect(opened[0]?.mode).toBe(CONFIG_FILE_MODE);
      expect(opened[0]?.temp.startsWith(join(dir.path, '.config.json.tmp-'))).toBe(true);
      expect(await modeOf(target)).toBe(0o600);
    });
  });

  it('leaves no temporary file behind after a successful write', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');

      await writeConfigFile(target, sampleConfig('clean'), trackingFilesystem([]));

      // readdir includes dot-files: only the target may remain.
      await expect(readdir(dir.path)).resolves.toEqual(['config.json']);
    });
  });

  it('renames a hidden same-directory temp file onto the target', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const renames: Array<{ oldPath: string; newPath: string }> = [];
      let tempPath = '';

      await writeConfigFile(
        target,
        sampleConfig('atomic'),
        trackingFilesystem([], {
          onOpen: (temp) => {
            tempPath = temp;
          },
          renameImpl: async (oldPath, newPath) => {
            renames.push({ oldPath, newPath });
            await rename(oldPath, newPath);
          },
        }),
      );

      expect(renames).toEqual([{ oldPath: tempPath, newPath: target }]);
      // Same directory (so the rename stays on one filesystem) and hidden.
      expect(tempPath.startsWith(join(dir.path, '.config.json.tmp-'))).toBe(true);
    });
  });
});

describe('writeConfigFile — fsync ordering', () => {
  it('writes, pins the mode, fsyncs, and closes before the rename', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const events: string[] = [];

      await writeConfigFile(
        target,
        sampleConfig('ordered'),
        trackingFilesystem(events, { wrapHandle: (handle) => orderedHandle(handle, events) }),
      );

      // One successful pass; no cleanup unlink is ever needed.
      expect(events).toEqual(['open', 'write', 'chmod', 'sync', 'close', 'rename']);
      await expect(readFile(target, 'utf8')).resolves.toContain('"ordered"');
    });
  });
});

describe('writeConfigFile — interrupted writes', () => {
  it('keeps the previous file when the rename fails, and cleans the temp', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const previous = `${JSON.stringify(sampleConfig('previous'), null, 2)}\n`;
      await seedTarget(target, previous, 0o600);
      const failure = new Error('simulated interruption before activation');

      await expect(
        writeConfigFile(
          target,
          sampleConfig('never-activated'),
          trackingFilesystem([], {
            renameImpl: async () => {
              throw failure;
            },
          }),
        ),
      ).rejects.toMatchObject({ cause: failure });

      await expect(readFile(target, 'utf8')).resolves.toBe(previous);
      expect(await modeOf(target)).toBe(0o600);
      await expect(readdir(dir.path)).resolves.toEqual(['config.json']);
    });
  });

  it('keeps the previous file when fsync fails, and cleans the temp', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const previous = `${JSON.stringify(sampleConfig('previous'), null, 2)}\n`;
      await seedTarget(target, previous, 0o600);
      const failure = new Error('simulated interruption before fsync completed');

      await expect(
        writeConfigFile(
          target,
          sampleConfig('lost'),
          trackingFilesystem([], { wrapHandle: (handle) => syncRejectingHandle(handle, failure) }),
        ),
      ).rejects.toMatchObject({ cause: failure });

      await expect(readFile(target, 'utf8')).resolves.toBe(previous);
      expect(await modeOf(target)).toBe(0o600);
      await expect(readdir(dir.path)).resolves.toEqual(['config.json']);
    });
  });

  it('keeps the previous file when the write fails mid-payload, and cleans the temp', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const previous = `${JSON.stringify(sampleConfig('previous'), null, 2)}\n`;
      await seedTarget(target, previous, 0o600);
      const failure = new Error('simulated interruption mid-write');

      await expect(
        writeConfigFile(
          target,
          sampleConfig('half-written'),
          trackingFilesystem([], {
            wrapHandle: (handle) => writeRejectingHandle(handle, failure),
          }),
        ),
      ).rejects.toMatchObject({ cause: failure });

      await expect(readFile(target, 'utf8')).resolves.toBe(previous);
      expect(await modeOf(target)).toBe(0o600);
      await expect(readdir(dir.path)).resolves.toEqual(['config.json']);
    });
  });

  it('touches no file at all when serialization fails', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const circular: Record<string, unknown> = { app: { timezone: 'UTC' } };
      circular.app = circular;
      const events: string[] = [];

      await expect(writeConfigFile(target, circular, trackingFilesystem(events))).rejects.toThrow(
        TypeError,
      );

      expect(events).toEqual([]);
      await expect(readdir(dir.path)).resolves.toEqual([]);
    });
  });

  it('touches no file at all for a value with no JSON representation', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const events: string[] = [];

      // JSON.stringify(undefined) returns undefined instead of throwing;
      // templating it would activate the literal string "undefined" as the
      // new config, destroying the previous file (review finding P2).
      await expect(writeConfigFile(target, undefined, trackingFilesystem(events))).rejects.toThrow(
        /no JSON representation/,
      );

      expect(events).toEqual([]);
      await expect(readdir(dir.path)).resolves.toEqual([]);
    });
  });

  it('fails loudly when the generated temp name already exists', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
      const suffix = (0.123456789).toString(36).slice(2, 10);
      const staleName = `.config.json.tmp-${process.pid}-${suffix}`;
      const staleForeign = join(dir.path, staleName);
      await writeFile(staleForeign, 'not ours', 'utf8');

      await expect(
        writeConfigFile(target, sampleConfig('blocked'), trackingFilesystem([])),
      ).rejects.toMatchObject({ cause: { code: 'EEXIST' } });

      // The target was never created, and the foreign file is left alone.
      await expect(readdir(dir.path)).resolves.toEqual([staleName]);
      await expect(readFile(staleForeign, 'utf8')).resolves.toBe('not ours');
    });
  });

  it('never activates a stale temp file left by a crashed writer', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      const stale = join(dir.path, '.config.json.tmp-1-crashed42');
      await writeFile(stale, '{"partial": tru', 'utf8');

      await writeConfigFile(target, sampleConfig('after-crash'), trackingFilesystem([]));

      const config = sampleConfig('after-crash');
      await expect(readFile(target, 'utf8')).resolves.toBe(`${JSON.stringify(config, null, 2)}\n`);
      // The crashed writer's leftover is inert garbage: untouched, never renamed.
      await expect(readFile(stale, 'utf8')).resolves.toBe('{"partial": tru');
      // readdir order is filesystem-defined; sort for determinism.
      await expect(readdir(dir.path).then((entries) => entries.sort())).resolves.toEqual([
        '.config.json.tmp-1-crashed42',
        'config.json',
      ]);
    });
  });
});

describe('writeConfigFile — directory behavior', () => {
  it('fails loudly when the target directory does not exist', async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir.path, 'missing');
      const target = join(nested, 'config.json');

      await expect(
        writeConfigFile(target, sampleConfig('nope'), trackingFilesystem([])),
      ).rejects.toMatchObject({ cause: { code: 'ENOENT' } });

      // Directory creation belongs to the startup path (task 066).
      await expect(stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('fails loudly when the directory is not writable', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      await chmod(dir.path, 0o500);
      try {
        await expect(
          writeConfigFile(target, sampleConfig('denied'), trackingFilesystem([])),
        ).rejects.toMatchObject({ cause: { code: 'EACCES' } });

        await expect(readdir(dir.path)).resolves.toEqual([]);
      } finally {
        // withTempDir's cleanup needs write access to remove the directory.
        await chmod(dir.path, 0o700);
      }
    });
  });
});

describe('writeConfigFile — permission preservation', () => {
  it('keeps mode 0600 when overwriting an existing 0600 file', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      await seedTarget(target, '{\n  "old": true\n}\n', 0o600);

      await writeConfigFile(target, sampleConfig('overwrite'), trackingFilesystem([]));

      expect(await modeOf(target)).toBe(0o600);
    });
  });

  it('corrects a drifted 0644 file back to 0600', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      await seedTarget(target, '{\n  "drifted": true\n}\n', 0o644);
      expect(await modeOf(target)).toBe(0o644);

      await writeConfigFile(target, sampleConfig('normalized'), trackingFilesystem([]));

      expect(await modeOf(target)).toBe(0o600);
    });
  });

  it('produces mode 0600 even under a hostile umask', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir.path, 'config.json');
      // A kernel applies `mode & ~umask` on open(2) while chmod(2) is exempt —
      // that is exactly what the explicit fchmod in writeConfigFile defeats.
      // The hostile 0o477 umask is simulated inside the injected filesystem:
      // process.umask() throws in worker threads (Stryker's vitest runner),
      // and the simulation keeps the real I/O of every other test.
      const umaskedFilesystem: WriteFilesystem = {
        async open(path, flags, mode) {
          return open(path, flags, mode & ~0o477);
        },
        async rename(oldPath, newPath) {
          await rename(oldPath, newPath);
        },
        async unlink(path) {
          await unlink(path);
        },
      };

      await writeConfigFile(target, sampleConfig('umasked'), umaskedFilesystem);

      expect(await modeOf(target)).toBe(0o600);
    });
  });
});
