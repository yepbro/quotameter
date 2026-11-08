import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfigWithEnv } from '../../src/config/env';
import { type CanonicalConfig } from '../../src/config/load';
import { openStorageConnection } from '../../src/storage/connection';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository } from '../../src/storage/repository';
import { createTempDir, type TempDir } from '../helpers/isolation';
import { CLI_ENTRY_SOURCE } from '../helpers/hermetic-child-env';

/**
 * The `quotameter passwd` command end-to-end through the real launcher
 * (task 144, spec §5.2/§15.2; decision D-118).
 *
 * Every route below is the real thing: the launcher resolves the owner,
 * reads the configuration of `QUOTAMETER_CONFIG_DIR` through the D-101
 * detection, asks the password pair through the real readline prompter
 * over piped stdin (the muted-echo line-queue machinery of task 130),
 * hashes with the real scrypt module, revokes the sessions of the real
 * migrated SQLite database in `QUOTAMETER_DATA_DIR`, and rewrites the
 * configuration file atomically through the §6.3 path.
 *
 * The done-condition is the marker discipline: the typed password is a
 * distinctive marker string, asserted absent from stdout, stderr, and the
 * written configuration file — only the scrypt hash (`scrypt$…`) is
 * stored. Every value is synthetic, never a secret; the no-network guard
 * is preloaded exactly as in the sibling launcher suites.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every launcher child. */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;

/** The marker password every no-leak assertion hunts for (§15.2 minimum). */
const MARKER_PASSWORD = 'marker-launcher-0123456789';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Collects a child's output; resolves on close with the exit code. */
function collect(child: ChildProcess): Promise<RunResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.once('error', reject);
  });
}

/**
 * Runs the real launcher's `passwd` against one temporary home. `stdin`
 * is piped and fed `input` (an empty string closes it immediately).
 */
function runPasswd(
  dir: TempDir,
  input: string,
  args: readonly string[] = ['passwd'],
): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, ...args],
    {
      env: {
        ...process.env,
        ...CLI_ENTRY_SOURCE,
        QUOTAMETER_CONFIG_DIR: join(dir.path, 'config'),
        QUOTAMETER_DATA_DIR: join(dir.path, 'data'),
        HOME: dir.path,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin?.end(input, 'utf8');
  return collect(child);
}

/** A valid loopback configuration file body, optionally with a hash. */
function configBody(withHash = false): string {
  const auth = withHash ? `, "auth": { "passwordHash": "previous-placeholder-hash" }` : '';
  const retention = `, "historyRetentionDays": 90`;
  return `{"server":{"host":"127.0.0.1","port":8787},"app":{"timezone":"Europe/Berlin","pollingIntervalSeconds":300${retention}}${auth}}`;
}

/** Writes the configuration fixture at `0600` inside a `0700` directory. */
async function writeConfig(configDir: string, body: string): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configFile = join(configDir, 'config.json');
  await writeFile(configFile, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  return configFile;
}

/** Two seeded session digests (SHA-256-shaped hex, synthetic). */
const SESSION_HASHES = [
  'aa11111111111111111111111111111111111111111111111111111111111111',
  'bb22222222222222222222222222222222222222222222222222222222222222',
] as const;

/** Seeds a real migrated database with two sessions. */
async function seedSessions(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const connection = openStorageConnection({ dataDir });
  try {
    await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database: connection.database });
    const now = Date.now();
    for (const [index, tokenHash] of SESSION_HASHES.entries()) {
      repository.insertSession({
        tokenHash,
        createdAt: now - 1000,
        lastSeenAt: now - 1000,
        expiresAt: now + 60_000 + index,
      });
    }
  } finally {
    connection.close();
  }
}

/** How many of the seeded sessions survive in the database. */
function survivingSessions(dataDir: string): number {
  const connection = openStorageConnection({ dataDir });
  try {
    const repository = createQuotaRepository({ database: connection.database });
    return SESSION_HASHES.filter((tokenHash) => repository.getSession(tokenHash) !== null).length;
  } finally {
    connection.close();
  }
}

describe('quotameter passwd (real launcher)', () => {
  it(
    'sets the password: real scrypt hash in the file, sessions revoked, no leak',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-passwd-set-');
      try {
        const configFile = await writeConfig(join(dir.path, 'config'), configBody());
        await seedSessions(join(dir.path, 'data'));
        const result = await runPasswd(dir, `${MARKER_PASSWORD}\n${MARKER_PASSWORD}\n`);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Web password set.');
        expect(result.stdout).toContain(`Only the scrypt hash is stored — in ${configFile}.`);
        expect(result.stdout).toContain('All 2 stored sessions were revoked');
        // The done-condition: the raw password never reaches any output.
        expect(result.stdout).not.toContain(MARKER_PASSWORD);
        expect(result.stderr).not.toContain(MARKER_PASSWORD);

        const text = await readFile(configFile, 'utf8');
        expect(text).not.toContain(MARKER_PASSWORD);
        const stored = JSON.parse(text) as {
          auth: { passwordHash?: string };
          app: { historyRetentionDays?: number };
        };
        expect(stored.auth.passwordHash).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+,keylen=\d+\$/);
        // A non-default field the flow never asks about survives the write
        // (review P2): a passwd run must never reset unrelated settings.
        expect(stored.app.historyRetentionDays).toBe(90);
        expect(survivingSessions(join(dir.path, 'data'))).toBe(0);
      } finally {
        await dir.remove();
      }
    },
  );

  it('changes a stored password and replaces the hash', { timeout: 30_000 }, async () => {
    const dir = await createTempDir('qm-passwd-change-');
    try {
      const configFile = await writeConfig(join(dir.path, 'config'), configBody(true));
      const result = await runPasswd(dir, `${MARKER_PASSWORD}\n${MARKER_PASSWORD}\n`);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Web password changed.');
      expect(result.stdout).not.toContain(MARKER_PASSWORD);
      expect(result.stderr).not.toContain(MARKER_PASSWORD);
      const text = await readFile(configFile, 'utf8');
      expect(text).toContain('scrypt$');
      expect(text).not.toContain('previous-placeholder-hash');
      expect(text).not.toContain(MARKER_PASSWORD);
    } finally {
      await dir.remove();
    }
  });

  it(
    'completes a password-pending configuration so the service can start',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-passwd-pending-');
      try {
        // The §15.1 state init leaves behind: a non-loopback bind without
        // a hash — the service refuses to start on exactly this file.
        const configFile = await writeConfig(
          join(dir.path, 'config'),
          '{"server":{"host":"0.0.0.0","port":8787},"app":{"timezone":"Europe/Berlin"}}',
        );
        const before = await loadConfigWithEnv(configFile, {});
        expect(before.ok).toBe(false);

        const result = await runPasswd(dir, `${MARKER_PASSWORD}\n${MARKER_PASSWORD}\n`);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Web password set.');

        const after = await loadConfigWithEnv(configFile, {});
        expect(after.ok).toBe(true);
        // The non-loopback bind survives the write (review P2): completing
        // the pending state must not silently reset the security-relevant
        // fields the flow never asks about. The cast states D-018's
        // canonical invariant (defaults completion materialized every
        // section).
        if (after.ok) {
          const canonical = after.config as CanonicalConfig;
          expect(canonical.server.host).toBe('0.0.0.0');
          expect(canonical.server.port).toBe(8787);
        }
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'rejects a too-short first answer through the real piped prompter, then succeeds',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-passwd-short-');
      try {
        const configFile = await writeConfig(join(dir.path, 'config'), configBody());
        const result = await runPasswd(dir, `short\n${MARKER_PASSWORD}\n${MARKER_PASSWORD}\n`);

        expect(result.code).toBe(0);
        expect(result.stderr).toContain('the password must be at least 12 characters long');
        expect(result.stdout).toContain('Web password set.');
        expect(result.stdout).not.toContain(MARKER_PASSWORD);
        expect(result.stderr).not.toContain(MARKER_PASSWORD);
        const text = await readFile(configFile, 'utf8');
        expect(text).not.toContain(MARKER_PASSWORD);
      } finally {
        await dir.remove();
      }
    },
  );

  it('cancels honestly when stdin is already closed', { timeout: 30_000 }, async () => {
    const dir = await createTempDir('qm-passwd-closed-');
    try {
      const configFile = await writeConfig(join(dir.path, 'config'), configBody());
      const result = await runPasswd(dir, '');

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('input closed before the password was confirmed');
      // Nothing was written: the file still has no hash.
      const text = await readFile(configFile, 'utf8');
      expect(text).not.toContain('passwordHash');
    } finally {
      await dir.remove();
    }
  });

  it('refuses without a configuration and points at init', { timeout: 30_000 }, async () => {
    const dir = await createTempDir('qm-passwd-noconfig-');
    try {
      const result = await runPasswd(dir, `${MARKER_PASSWORD}\n${MARKER_PASSWORD}\n`);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('there is no configuration file at');
      expect(result.stdout).toContain('quotameter init');
      expect(result.stderr).not.toContain(MARKER_PASSWORD);
    } finally {
      await dir.remove();
    }
  });

  it('exposes the empty option surface through --help', { timeout: 30_000 }, async () => {
    const dir = await createTempDir('qm-passwd-help-');
    try {
      const result = await runPasswd(dir, '', ['passwd', '--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Set or change the web password');
      expect(result.stdout).toContain('--help');
    } finally {
      await dir.remove();
    }
  });
});
