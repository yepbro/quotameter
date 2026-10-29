import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_DIR_MODE,
  createPermissionsCheck,
  enforceConfigPermissions,
} from '../../src/config/permissions';
import type { PermissionsFilesystem } from '../../src/config/permissions';
import { CONFIG_FILE_MODE, writeConfigFile } from '../../src/config/write';
import { QuotameterApp } from '../../src/server/app';
import type { LifecycleComponent } from '../../src/server/app';
import { runServer } from '../../src/server/main';
import { withTempDir } from '../helpers/isolation';

/**
 * Configuration permission enforcement against the real filesystem (task
 * 066, spec §6.3, §15.4; decision D-019): the config directory is created
 * `0700` (umask-proof via an explicit chmod, mirroring D-016), drifted
 * modes of directory and file are corrected to `0700`/`0600`, and every
 * uncorrectable state — foreign ownership, a symlinked object, a wrong
 * type, a failed or ineffective chmod — refuses startup through the
 * task-060 lifecycle seam.
 *
 * Real I/O runs everywhere; the injectable filesystem only simulates what
 * the kernel cannot be asked to do deterministically here (a hostile umask
 * on mkdir, a rejecting or no-op chmod, a vanishing path). `process.umask`
 * is never used — it throws in Stryker's worker threads (task 065).
 */

/** Reads a path's mode reduced to permission and special bits. */
async function modeOf(target: string): Promise<number> {
  return (await lstat(target)).mode & 0o7777;
}

/** The uid every test-owned path has; the running process created it. */
function ownerUid(target: string): Promise<number> {
  return lstat(target).then((stats) => stats.uid);
}

/** A filesystem errno error, as the kernel would raise it. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/**
 * The same stats with a different owner uid — a Stats clone keeping its
 * prototype, so the kind predicates (`isSymbolicLink`, …) still work.
 * Real chown needs root, which tests never have.
 */
function withUid(stats: Stats, uid: number): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid });
}

/**
 * Real-filesystem seam that records chmod calls; any method can be
 * overridden to simulate conditions the kernel will not produce on demand.
 */
function seam(overrides: Partial<PermissionsFilesystem> = {}): PermissionsFilesystem & {
  chmodCalls: Array<{ target: string; mode: number }>;
} {
  const chmodCalls: Array<{ target: string; mode: number }> = [];
  const base: PermissionsFilesystem = {
    lstat: (target) => lstat(target),
    mkdir: (target, options) => mkdir(target, options),
    chmod: async (target, mode) => {
      chmodCalls.push({ target, mode });
      await chmod(target, mode);
    },
  };
  return Object.assign(base, overrides, { chmodCalls });
}

/** Asserts that enforcement refuses with a message matching `pattern`. */
async function expectRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected enforcement to refuse, but it resolved');
    },
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
  return error as Error;
}

/** A minimal configuration file content for seeds. */
const CONFIG_TEXT = '{\n  "app": { "timezone": "UTC" }\n}\n';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enforceConfigPermissions — directory creation', () => {
  it('creates a missing config directory with mode 0700; a missing file passes as absent', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');

      const result = await enforceConfigPermissions({ configDir, configFile });

      expect(result).toEqual({ configDir: 'created', configFile: 'absent' });
      expect(await modeOf(configDir)).toBe(CONFIG_DIR_MODE);
    });
  });

  it('creates missing ancestors and enforces exactly 0700 on every level it creates', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'a', 'b', 'quotameter');

      await enforceConfigPermissions({ configDir, configFile: join(configDir, 'config.json') });

      // Every level this module created is exactly 0700 — umask-independent
      // (group/other stripped, owner rwx) — and the pre-existing ancestor
      // (dir.path) is untouched.
      for (const level of [join(dir.path, 'a'), join(dir.path, 'a', 'b'), configDir]) {
        expect(await modeOf(level)).toBe(CONFIG_DIR_MODE);
      }
    });
  });

  it('defeats a hostile umask — even one clearing the owner-execute bit — at every depth', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'deep', 'nested', 'quotameter');
      // mkdir(2) applies `mode & ~umask` while chmod(2) is exempt —
      // simulated on the seam, because process.umask() is unusable in
      // worker threads. 0700 & ~0o177 = 0o600: without the per-level
      // chmod, the first ancestor would be untraversable and the next
      // level's creation would fail EACCES (review finding P2-1).
      const umasked = seam({
        mkdir: (target, options) => mkdir(target, { ...options, mode: options.mode & ~0o177 }),
      });

      const result = await enforceConfigPermissions({
        configDir,
        configFile: join(configDir, 'config.json'),
        filesystem: umasked,
      });

      expect(result.configDir).toBe('created');
      for (const level of [join(dir.path, 'deep'), join(dir.path, 'deep', 'nested'), configDir]) {
        expect(await modeOf(level)).toBe(CONFIG_DIR_MODE);
      }
    });
  });

  it('tolerates a level that appears concurrently and verifies the outcome', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'raced', 'quotameter');
      const parent = join(dir.path, 'raced');
      // The final level already exists (a concurrent creator won it), but
      // the walk's first lstat misses it — the mkdir then hits EEXIST and
      // must fall through to verification, not refuse.
      await mkdir(parent, { mode: 0o700 });
      await mkdir(configDir, { mode: 0o700 });
      let hiddenOnce = true;
      const raced = seam({
        lstat: async (target) => {
          if (hiddenOnce && target === configDir) {
            hiddenOnce = false;
            throw errnoError('ENOENT', 'no such file or directory');
          }
          return lstat(target);
        },
      });

      const result = await enforceConfigPermissions({
        configDir,
        configFile: join(configDir, 'config.json'),
        filesystem: raced,
      });

      // The racing creator's level is left to it; ours is chmod-ed; the
      // final checks verify whatever actually exists now.
      expect(result.configDir).toBe('created');
      expect(await modeOf(parent)).toBe(CONFIG_DIR_MODE);
      expect(await modeOf(configDir)).toBe(CONFIG_DIR_MODE);
    });
  });

  it('refuses when the directory cannot be created', async () => {
    await withTempDir(async (dir) => {
      const locked = join(dir.path, 'locked');
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        await expectRefusal(
          enforceConfigPermissions({
            configDir: join(locked, 'quotameter'),
            configFile: join(locked, 'quotameter', 'config.json'),
          }),
          /refusing to start: cannot create configuration directory .* \(EACCES\)/,
        );
      } finally {
        // withTempDir's cleanup needs write access to remove the directory.
        await chmod(locked, 0o700);
      }
    });
  });
});

describe('enforceConfigPermissions — correction of drifted modes', () => {
  it('corrects a permissive 0755 directory to 0700', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      await mkdir(configDir);
      await chmod(configDir, 0o755);

      const result = await enforceConfigPermissions({
        configDir,
        configFile: join(configDir, 'config.json'),
      });

      expect(result.configDir).toBe('corrected');
      expect(await modeOf(configDir)).toBe(CONFIG_DIR_MODE);
    });
  });

  it('corrects a permissive 0644 file to 0600', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      await chmod(configFile, 0o644);

      const result = await enforceConfigPermissions({ configDir, configFile });

      expect(result.configFile).toBe('corrected');
      expect(await modeOf(configFile)).toBe(CONFIG_FILE_MODE);
      // The written content is never touched by enforcement.
      await expect(readFile(configFile, 'utf8')).resolves.toBe(CONFIG_TEXT);
    });
  });

  it('clears special bits: a 1777 directory is corrected to plain 0700', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      await mkdir(configDir);
      await chmod(configDir, 0o1777);

      await enforceConfigPermissions({
        configDir,
        configFile: join(configDir, 'config.json'),
      });

      expect(await modeOf(configDir)).toBe(CONFIG_DIR_MODE);
    });
  });

  it('normalizes a stricter-than-required 0400 file back to 0600', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      await chmod(configFile, 0o400);

      const result = await enforceConfigPermissions({ configDir, configFile });

      // Stricter-than-spec is itself non-compliant (D-019, following
      // D-016's exact-0600 policy for writes).
      expect(result.configFile).toBe('corrected');
      expect(await modeOf(configFile)).toBe(CONFIG_FILE_MODE);
    });
  });
});

describe('enforceConfigPermissions — already secure', () => {
  it('passes a 0700 directory and 0600 file through without chmod calls', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      await chmod(configFile, 0o600);
      const filesystem = seam();

      const result = await enforceConfigPermissions({ configDir, configFile, filesystem });

      expect(result).toEqual({ configDir: 'secure', configFile: 'secure' });
      expect(filesystem.chmodCalls).toEqual([]);
      expect(await modeOf(configDir)).toBe(CONFIG_DIR_MODE);
      expect(await modeOf(configFile)).toBe(CONFIG_FILE_MODE);
    });
  });

  it('reports secure for a write-path-created file (D-016 interplay)', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeConfigFile(configFile, { app: { timezone: 'UTC' } });
      const filesystem = seam();

      const result = await enforceConfigPermissions({ configDir, configFile, filesystem });

      // The write path pins 0600 by construction; the startup check is the
      // verifier of last resort and must confirm, not rewrite.
      expect(result.configFile).toBe('secure');
      expect(filesystem.chmodCalls).toEqual([]);
      expect(await modeOf(configFile)).toBe(CONFIG_FILE_MODE);
    });
  });
});

describe('enforceConfigPermissions — uncorrectable refusals', () => {
  it('refuses when the directory is owned by another user', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      await mkdir(configDir, { mode: 0o700 });
      const owner = await ownerUid(configDir);

      const error = await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile: join(configDir, 'config.json'),
          getuid: () => owner + 1234,
        }),
        new RegExp(
          `refusing to start: configuration directory .* is owned by uid ${owner}, ` +
            `but the service runs as uid ${owner + 1234}; chown it to the running user`,
        ),
      );
      expect(error.cause).toBeUndefined();
    });
  });

  it('refuses when the file is owned by another user', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      const owner = await ownerUid(configFile);
      const foreignUid = owner + 555;

      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile,
          // Ownership is process-wide, so a fake getuid would trip the
          // directory first; the seam instead reports a foreign owner for
          // the file only, leaving every other call on the real fs.
          filesystem: seam({
            lstat: async (target) => {
              const stats = await lstat(target);
              return target === configFile ? withUid(stats, foreignUid) : stats;
            },
          }),
        }),
        new RegExp(
          `refusing to start: configuration file .* is owned by uid ${foreignUid}, ` +
            `but the service runs as uid ${owner}`,
        ),
      );
    });
  });

  it('refuses when the config directory is a symbolic link', async () => {
    await withTempDir(async (dir) => {
      const elsewhere = join(dir.path, 'elsewhere');
      await mkdir(elsewhere, { mode: 0o755 });
      const configDir = join(dir.path, 'quotameter');
      await symlink(elsewhere, configDir);

      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile: join(configDir, 'config.json'),
        }),
        /refusing to start: configuration directory .* is a symbolic link; replace it with a real directory/,
      );
      // Nothing was followed or fixed through the link.
      expect(await modeOf(elsewhere)).toBe(0o755);
    });
  });

  it('refuses when the config file is a symbolic link, even to a secure file', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      const target = join(dir.path, 'real-config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(target, CONFIG_TEXT, 'utf8');
      await chmod(target, 0o600);
      await symlink(target, configFile);

      await expectRefusal(
        enforceConfigPermissions({ configDir, configFile }),
        /refusing to start: configuration file .* is a symbolic link; replace it with a real file/,
      );
      expect(await modeOf(target)).toBe(0o600);
    });
  });

  it('refuses when a regular file sits at the config directory path', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      await writeFile(configDir, 'not a directory', 'utf8');

      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile: join(configDir, 'config.json'),
        }),
        /refusing to start: configuration directory .* is not a directory/,
      );
    });
  });

  it('refuses when a directory sits at the config file path', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await mkdir(configFile);

      await expectRefusal(
        enforceConfigPermissions({ configDir, configFile }),
        /refusing to start: configuration file .* is not a regular file/,
      );
    });
  });

  it('refuses when the correcting chmod fails, preserving the errno cause', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      await mkdir(configDir);
      await chmod(configDir, 0o755);

      const error = await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile: join(configDir, 'config.json'),
          filesystem: seam({
            chmod: async () => {
              throw errnoError('EPERM', 'operation not permitted');
            },
          }),
        }),
        /refusing to start: cannot correct permissions of configuration directory .* from 0o755 to 0o700: \(EPERM\) operation not permitted/,
      );
      expect((error.cause as NodeJS.ErrnoException).code).toBe('EPERM');
    });
  });

  it('renders chmod failures without an errno code, and non-Error throws, readably', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      await chmod(configFile, 0o642);

      // A plain Error without an errno code still names the failure.
      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile,
          filesystem: seam({
            chmod: async () => {
              throw new Error('quota of inodes exhausted');
            },
          }),
        }),
        /refusing to start: cannot correct permissions of configuration file .* from 0o642 to 0o600: quota of inodes exhausted$/,
      );
      // A thrown non-Error value is rendered, never swallowed.
      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile,
          filesystem: seam({
            chmod: async () => {
              throw 'kaputt';
            },
          }),
        }),
        /refusing to start: cannot correct permissions of configuration file .* from 0o642 to 0o600: kaputt$/,
      );
      // Both refusals left the drifted mode untouched.
      expect(await modeOf(configFile)).toBe(0o642);
    });
  });

  it('refuses when the filesystem accepts but does not apply the correction', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      await mkdir(configDir);
      await chmod(configDir, 0o777);

      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile: join(configDir, 'config.json'),
          filesystem: seam({ chmod: async () => {} }),
        }),
        /refusing to start: configuration directory .* still reports mode 0o777 after the correction to 0o700/,
      );
      // The drifted mode is untouched: the refusal is honest.
      expect(await modeOf(configDir)).toBe(0o777);
    });
  });

  it('refuses when the uid of the running process cannot be determined', async () => {
    await withTempDir(async (dir) => {
      await expectRefusal(
        enforceConfigPermissions({
          configDir: join(dir.path, 'quotameter'),
          configFile: join(dir.path, 'quotameter', 'config.json'),
          getuid: () => undefined,
        }),
        /refusing to start: cannot determine the uid of the running process to verify configuration permissions/,
      );
    });
  });

  it('refuses when a freshly created directory cannot be inspected again', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'vanishing');

      await expectRefusal(
        enforceConfigPermissions({
          configDir,
          configFile: join(configDir, 'config.json'),
          filesystem: seam({
            lstat: async () => {
              throw errnoError('ENOENT', 'no such file or directory');
            },
          }),
        }),
        /refusing to start: configuration directory .* cannot be inspected after the change: \(ENOENT\)/,
      );
    });
  });

  it('refuses when inspecting the path fails for a non-ENOENT reason', async () => {
    await withTempDir(async (dir) => {
      await expectRefusal(
        enforceConfigPermissions({
          configDir: join(dir.path, 'quotameter'),
          configFile: join(dir.path, 'quotameter', 'config.json'),
          filesystem: seam({
            lstat: async () => {
              throw errnoError('EACCES', 'permission denied');
            },
          }),
        }),
        /refusing to start: cannot inspect configuration directory .*: \(EACCES\) permission denied/,
      );
    });
  });
});

describe('createPermissionsCheck — task 060 seam', () => {
  it('starts cleanly when permissions are compliant and stops as a no-op', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const check = createPermissionsCheck({
        configDir,
        configFile: join(configDir, 'config.json'),
      });
      const events: string[] = [];
      const app = new QuotameterApp({
        components: [
          check,
          {
            name: 'witness',
            async start() {
              events.push('started-witness');
            },
            async stop() {
              events.push('stopped-witness');
            },
          },
        ],
      });

      await app.start();

      expect(app.running).toBe(true);
      expect(await modeOf(configDir)).toBe(CONFIG_DIR_MODE);

      await app.stop();

      expect(app.state).toBe('stopped');
      expect(events).toEqual(['started-witness', 'stopped-witness']);
    });
  });

  it('aborts startup through the app rollback when enforcement refuses', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      await chmod(configFile, 0o666);
      const owner = await ownerUid(configFile);
      const foreignUid = owner + 555;
      const stopped: string[] = [];
      const witness = (name: string): LifecycleComponent => ({
        name,
        async start() {},
        async stop() {
          stopped.push(name);
        },
      });
      const app = new QuotameterApp({
        components: [
          witness('early'),
          createPermissionsCheck({
            configDir,
            configFile,
            // Foreign ownership of the file only (see the refusal suite):
            // uncorrectable by design, so `start` must throw.
            filesystem: seam({
              lstat: async (target) => {
                const stats = await lstat(target);
                return target === configFile ? withUid(stats, foreignUid) : stats;
              },
            }),
          }),
          witness('late'),
        ],
      });

      await expect(app.start()).rejects.toThrow(
        /refusing to start: configuration file .* is owned by uid \d+/,
      );

      expect(app.state).toBe('failed');
      // Components that had started were rolled back; the refuser itself
      // holds nothing, so only 'early' needs stopping.
      expect(stopped).toEqual(['early']);
      // The unsafe mode was left exactly as found.
      expect(await modeOf(configFile)).toBe(0o666);
    });
  });
});

describe('runServer integration', () => {
  /** Captures fatal diagnostics written to stderr; restores on `restore()`. */
  function captureStderr(): { lines(): string; restore(): void } {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      lines: () => spy.mock.calls.map((call) => String(call[0])).join(''),
      restore: () => spy.mockRestore(),
    };
  }

  it('exits 1 and explains the refusal when permissions cannot be corrected', async () => {
    await withTempDir(async (dir) => {
      const configDir = join(dir.path, 'quotameter');
      const configFile = join(configDir, 'config.json');
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(configFile, CONFIG_TEXT, 'utf8');
      await chmod(configFile, 0o644);
      const stderr = captureStderr();
      try {
        const code = await runServer({
          components: [
            createPermissionsCheck({
              configDir,
              configFile,
              // chmod resolves but changes nothing: the correction cannot
              // be applied, so startup must refuse. The directory is
              // already compliant, isolating the refusal to the file.
              filesystem: seam({ chmod: async () => {} }),
            }),
          ],
        });

        expect(code).toBe(1);
        expect(stderr.lines()).toMatch(
          /quotameter: refusing to start: configuration file .* still reports mode 0o644 after the correction to 0o600/,
        );
      } finally {
        stderr.restore();
      }
    });
  });
});
