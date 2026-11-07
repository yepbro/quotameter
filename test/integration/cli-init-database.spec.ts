import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInitDatabase } from '../../src/cli/init-database';
import { lockFilePath } from '../../src/server/single-instance';
import { createTempDir } from '../helpers/isolation';

/**
 * The §5.3 step-5 database leg (task U-059, spec §5.3/§11.4; decision
 * D-187): the module's own contract over the real filesystem and the real
 * storage seam — the fresh create-and-migrate, the idempotent re-run, the
 * umask-exempt `0700` chmod (review round P2: `mkdir`'s mode is masked by
 * the invoking shell's umask), and the §5.6 live-holder refusal (review
 * round P2: init must never run backup or DDL under a running service).
 * The `node:sqlite` ExperimentalWarning on stderr is the documented noise
 * of a suite that actually opens databases (D-116).
 */

describe('createInitDatabase (real filesystem, real storage seam)', () => {
  it('creates the data directory at 0700 even under a hostile umask, and migrates', async () => {
    const dir = await createTempDir('qm-init-db-');
    const dataDir = join(dir.path, 'deep/data');
    const previousUmask = process.umask();
    try {
      // umask 0177 would mask a recursive mkdir's 0700 down to 0600 on
      // EVERY level it creates — untraversable; the level-by-level
      // mkdir+chmod walk must keep creation working and every created
      // level at 0700 (the configuration path's own discipline).
      process.umask(0o177);
      const outcome = await createInitDatabase(dataDir);
      expect(outcome).toEqual({
        state: 'ready',
        databasePath: join(dataDir, 'quotameter.sqlite'),
      });
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir.path, 'deep'))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      await dir.remove();
    }
  });

  it('a pre-existing drifted data directory is corrected to 0700', async () => {
    const dir = await createTempDir('qm-init-db-');
    try {
      await mkdir(dir.path, { recursive: true, mode: 0o755 });
      await chmod(dir.path, 0o755);
      const outcome = await createInitDatabase(dir.path);
      expect(outcome.state).toBe('ready');
      expect((await stat(dir.path)).mode & 0o777).toBe(0o700);
    } finally {
      await dir.remove();
    }
  });

  it('an existing database is brought to the schema idempotently (the journal, read back)', async () => {
    const dir = await createTempDir('qm-init-db-');
    try {
      const first = await createInitDatabase(dir.path);
      expect(first.state).toBe('ready');
      const second = await createInitDatabase(dir.path);
      expect(second.state).toBe('ready');
      if (first.state !== 'ready') return;
      const database = new DatabaseSync(first.databasePath, { readOnly: true });
      try {
        const rows = database
          .prepare('SELECT name FROM schema_migrations ORDER BY name')
          .all() as Array<{ name: string }>;
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        database.close();
      }
    } finally {
      await dir.remove();
    }
  }, 10_000);

  it('a live §5.6 lock holder refuses the step before anything opens (review P2)', async () => {
    const dir = await createTempDir('qm-init-db-');
    try {
      // A lock naming THIS process: alive by construction, exactly what a
      // running service's lock looks like.
      await mkdir(dir.path, { recursive: true });
      await writeFile(
        lockFilePath(dir.path),
        JSON.stringify({ pid: process.pid, id: 'test-token' }),
      );
      const outcome = await createInitDatabase(dir.path);
      expect(outcome).toEqual({
        state: 'failed',
        detail:
          `the data directory is in use by a running quotameter service (pid ${process.pid}) — ` +
          'stop it before initializing',
      });
      // Nothing was created: no database behind the lock.
      await expect(stat(join(dir.path, 'quotameter.sqlite'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await dir.remove();
    }
  });

  it('a dead holder is a stale lock — the step proceeds (§5.6 clears it at the next start)', async () => {
    const dir = await createTempDir('qm-init-db-');
    try {
      await mkdir(dir.path, { recursive: true });
      // Pid 1 on the container is alive… so name a pid that cannot be:
      // a large, implausible pid no kernel will hand out this boot.
      await writeFile(
        lockFilePath(dir.path),
        JSON.stringify({ pid: 2_000_000_000, id: 'stale-token' }),
      );
      const outcome = await createInitDatabase(dir.path);
      expect(outcome.state).toBe('ready');
    } finally {
      await dir.remove();
    }
  }, 10_000);

  it('an invalid lock payload refuses fail-closed (review P2)', async () => {
    const dir = await createTempDir('qm-init-db-');
    try {
      await mkdir(dir.path, { recursive: true });
      await writeFile(lockFilePath(dir.path), 'not a lock');
      const outcome = await createInitDatabase(dir.path);
      expect(outcome).toEqual({
        state: 'failed',
        detail:
          'the single-instance lock of the data directory is not a valid quotameter lock — ' +
          'verify that no quotameter process is running, then remove the lock file and run init again',
      });
    } finally {
      await dir.remove();
    }
  });

  it('a squatter file on the data-directory path fails with the filesystem error', async () => {
    const dir = await createTempDir('qm-init-db-');
    try {
      const squatter = join(dir.path, 'occupied');
      await writeFile(squatter, 'not a directory');
      const outcome = await createInitDatabase(squatter);
      expect(outcome.state).toBe('failed');
      if (outcome.state === 'failed') {
        expect(outcome.detail).toMatch(/EEXIST|ENOTDIR/);
      }
    } finally {
      await dir.remove();
    }
  });
});
