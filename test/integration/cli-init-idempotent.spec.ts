import { spawn } from 'node:child_process';
import { readFile, stat, symlink, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import { runInitCommand, type InitDeps } from '../../src/cli/init';
import { configFilePath } from '../../src/config/load';
import { readExistingConfig } from '../../src/cli/init-persist';
import type { PromptHandle } from '../../src/cli/prompts';
import { createTempDir } from '../helpers/isolation';

/**
 * The idempotent-`init` done-condition end-to-end (task 132, spec §5.3,
 * decision D-101): "running `init` twice does not overwrite settings without
 * consent". Real filesystem, real permission enforcement, real atomic
 * writes — the in-process cases against temporary configuration directories
 * through the handler's real default wiring, and the double-init sequence
 * through the real launcher in a child process (the same pattern as
 * `cli-init.spec.ts`).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');

/* ── In-process harness (real fs, real seams, injected temp paths) ─────── */

interface Recorded {
  code: number;
  out: string;
  err: string;
}

/** Runs the handler with a recording output and a temp config directory. */
async function runHandler(
  configDir: string,
  flags: Record<string, boolean | string>,
  answers: readonly string[],
  depsOverride: Partial<InitDeps> = {},
): Promise<Recorded> {
  const outText: string[] = [];
  const errText: string[] = [];
  const remaining = [...answers];
  const step = (): Promise<string | null> => {
    const value = remaining.shift();
    return Promise.resolve(value === undefined ? null : value);
  };
  const prompter: PromptHandle = {
    ask: step,
    askSecret: step,
    close: () => undefined,
    interrupted: () => false,
  };
  const ctx: CliContext = {
    output: {
      out: (text: string) => void outText.push(`${text}\n`),
      err: (text: string) => void errText.push(`${text}\n`),
    },
    version: 'test',
    commandPath: ['init'],
    flags,
    positionals: [],
  };
  try {
    const code = await runInitCommand({
      pathEnv: { QUOTAMETER_CONFIG_DIR: configDir },
      createPrompter: () => prompter,
      ...depsOverride,
    })(ctx);
    return { code, out: outText.join(''), err: errText.join('') };
  } catch (error) {
    // The dispatcher renders handler throws as exit 1; surface them the
    // same way so refusal cases assert on the message.
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, out: outText.join(''), err: `quotameter init: ${message}\n` };
  }
}

/** Reads the config file of `configDir` as parsed JSON. */
async function readConfig(configDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configFilePath(configDir), 'utf8')) as Record<string, unknown>;
}

const FULL_FRESH = ['Europe/Berlin', '0.0.0.0', '9000', '120', 'work', 'sk-e2e-key-value', 'y'];
const KEEP_ALL = ['', '', '', ''];

describe('init idempotency (in-process, real filesystem)', () => {
  it('first run creates the configuration: 0700 directory, 0600 file, key inside', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      // The connection test runs through the real default provider under
      // the suite's no-network guard: the deterministic unavailable failure
      // is explained, the scripted `y` keeps the account (task 133).
      const run = await runHandler(dir.path, {}, FULL_FRESH);
      expect(run.code).toBe(0);
      expect(run.err).toContain("the initial connection test for 'work' failed:");
      expect(run.err).toContain('the check was inconclusive');
      expect(run.out).toContain(
        'connection test failed: provider-unavailable — stored in error state',
      );
      expect(run.out).toContain('Configuration written to');
      // Task 137: the routed service-setup step follows the write trailer
      // (the systemd-less container takes the manual route).
      expect(run.out).toContain('Service setup:');

      const dirStat = await stat(dir.path);
      expect(dirStat.mode & 0o777).toBe(0o700);
      const file = configFilePath(dir.path);
      const fileStat = await stat(file);
      expect(fileStat.mode & 0o777).toBe(0o600);

      const config = await readConfig(dir.path);
      expect(config.server).toEqual({ host: '0.0.0.0', port: 9000 });
      expect(config.app).toMatchObject({ timezone: 'Europe/Berlin', pollingIntervalSeconds: 120 });
      // Task 133: the account is real — the key lives in the 0600 file
      // (§6.3, D-004) and never in any output line (§15.4).
      expect(config.accounts).toEqual([
        {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'work',
          enabled: true,
          apiKey: 'sk-e2e-key-value',
        },
      ]);
      expect(JSON.stringify(config)).toContain('sk-e2e-key-value');
      expect(run.out + run.err).not.toContain('sk-e2e-key-value');
      // §15.1 pending (D-101): the remote bind is written hash-less, with
      // the passwd remedy — the service refuses to start on it until then.
      expect(config.auth).toEqual({ mode: 'auto' });
      expect(run.out).toContain('A password is required before the service starts');
    } finally {
      await dir.remove();
    }
  });

  it('second run keeps every setting on Enter and does not rewrite the file', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      // A loopback first run keeps the double-run sequence independent of
      // the §15.1 pending state (covered by its own case below).
      await runHandler(dir.path, {}, ['Europe/Berlin', '127.0.0.1', '9000', '120', '', '']);
      const file = configFilePath(dir.path);
      const before = await readFile(file, 'utf8');

      const run = await runHandler(dir.path, {}, KEEP_ALL);
      expect(run.code).toBe(0);
      expect(run.out).toContain('Existing configuration found at');
      expect(run.out).toContain('Press Enter at a question to keep the current value.');
      // The prompt texts themselves are pinned by the unit suite and the
      // launcher cases below (the scripted prompter here is silent).
      expect(run.out).toContain('No changes — the existing configuration is kept');
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      await dir.remove();
    }
  });

  it('a password-pending (remote bind) configuration re-runs as existing and is kept', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const first = await runHandler(dir.path, {}, FULL_FRESH);
      expect(first.code).toBe(0);
      expect(first.out).toContain('A password is required before the service starts');
      const file = configFilePath(dir.path);
      const created = await readFile(file, 'utf8');

      const second = await runHandler(dir.path, {}, KEEP_ALL);
      expect(second.code).toBe(0);
      expect(second.out).toContain('Existing configuration found at');
      expect(second.out).toContain(
        'No password is configured yet — the service will not start until quotameter passwd sets one.',
      );
      expect(second.out).toContain('No changes — the existing configuration is kept');
      expect(await readFile(file, 'utf8')).toBe(created);
    } finally {
      await dir.remove();
    }
  });

  it('second run changes only the typed setting and preserves the rest of the file', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      // Seed a hand-edited file: settings init never asks about must survive.
      const file = configFilePath(dir.path);
      const seeded = {
        server: { host: '127.0.0.1', port: 8787 },
        app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 90 },
        logging: { level: 'info' },
        accounts: [{ id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-seeded-key' }],
      };
      await writeFile(file, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });

      const run = await runHandler(dir.path, {}, ['', '', '9001', '']);
      expect(run.code).toBe(0);
      expect(run.out).toContain('Configuration updated at');

      const config = await readConfig(dir.path);
      expect(config.server).toEqual({ host: '127.0.0.1', port: 9001 });
      expect(config.app).toMatchObject({ timezone: 'UTC', pollingIntervalSeconds: 300 });
      // Untouched settings and accounts survive the consented change.
      expect(config.app).toMatchObject({ historyRetentionDays: 90 });
      expect(config.logging).toEqual({ level: 'info' });
      expect(config.accounts).toEqual([
        { id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-seeded-key', enabled: true },
      ]);
    } finally {
      await dir.remove();
    }
  });

  it('an existing-but-invalid configuration is refused and left byte-identical', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const file = configFilePath(dir.path);
      const garbage = '{ "app": { "timezone": "UTC" }, "server": { "port": 70000 } }\n';
      await writeFile(file, garbage, { mode: 0o600 });

      const run = await runHandler(dir.path, {}, KEEP_ALL);
      expect(run.code).toBe(1);
      expect(run.err).toContain('but it is invalid — nothing was changed:');
      expect(run.err).toContain('server.port');
      expect(run.err).toContain('fix or remove the file, then run init again.');
      expect(await readFile(file, 'utf8')).toBe(garbage);
    } finally {
      await dir.remove();
    }
  });

  it('a malformed auth section is invalid, never password-pending — even on a change attempt', async () => {
    // Review-round regression (P1 on the first version): the §15.1 probe
    // once replaced whatever `auth` it found, "repairing" corrupt data
    // into the pending state and letting a change rewrite it. These files
    // must classify as invalid — an explicit --yes change attempt is
    // refused and the bytes stay identical.
    const dir = await createTempDir('qm-init-132-');
    try {
      const file = configFilePath(dir.path);
      const shapes = [
        '{"app":{"timezone":"UTC"},"auth":{"passwordHash":""}}',
        '{"app":{"timezone":"UTC"},"auth":{"passwordHash":123}}',
        '{"app":{"timezone":"UTC"},"auth":[]}',
      ];
      for (const text of shapes) {
        await writeFile(file, text, { mode: 0o600 });
        const run = await runHandler(
          dir.path,
          { yes: true, timezone: 'Europe/Berlin', port: '9001' },
          [],
        );
        expect(run.code, text).toBe(1);
        expect(run.err, text).toContain('but it is invalid — nothing was changed:');
        expect(await readFile(file, 'utf8'), text).toBe(text);
      }
    } finally {
      await dir.remove();
    }
  });

  it('a configuration changed between display and write is preserved — the run refuses', async () => {
    // Review-round regression (P1 on the first version): the write used to
    // trust the detection taken before the questions. The interleaving is
    // deterministic — the detection seam writes a foreign configuration
    // exactly between the handler's two reads (display and the
    // stale-detection re-read) — and the refusal must leave the foreign
    // bytes untouched (no real write happens: persistConfig is not
    // injected, so a missing guard would clobber the file and fail this).
    const dir = await createTempDir('qm-init-132-');
    try {
      const file = configFilePath(dir.path);
      await writeFile(file, '{"app":{"timezone":"UTC"}}\n', { mode: 0o600 });
      const foreign = `${JSON.stringify(
        { app: { timezone: 'Asia/Tokyo' }, server: { host: '127.0.0.1', port: 4242 } },
        null,
        2,
      )}\n`;
      let reads = 0;
      const readExisting: InitDeps['readExisting'] = async (target) => {
        reads += 1;
        if (reads === 2) await writeFile(target, foreign, { mode: 0o600 });
        return readExistingConfig(target);
      };

      const run = await runHandler(dir.path, {}, ['', '', '9001', ''], { readExisting });
      expect(run.code).toBe(1);
      expect(run.err).toContain('the configuration changed while init was running');
      expect(run.err).toContain('nothing was written');
      expect(run.out).not.toContain('Configuration updated at');
      expect(await readFile(file, 'utf8')).toBe(foreign);
    } finally {
      await dir.remove();
    }
  });

  it('a fresh run never clobbers a file created while the questions were answered', async () => {
    // The no-clobber half of the same guard: detection saw no file, a
    // foreign writer created one before the re-read — the run must refuse
    // and the foreign configuration must survive byte-identical.
    const dir = await createTempDir('qm-init-132-');
    try {
      const file = configFilePath(dir.path);
      const foreign = `${JSON.stringify(
        { app: { timezone: 'Asia/Tokyo' }, server: { host: '127.0.0.1', port: 4242 } },
        null,
        2,
      )}\n`;
      let reads = 0;
      const readExisting: InitDeps['readExisting'] = async (target) => {
        reads += 1;
        if (reads === 2) await writeFile(target, foreign, { mode: 0o600 });
        return readExistingConfig(target);
      };

      const run = await runHandler(dir.path, {}, ['UTC', '', '', '', ''], { readExisting });
      expect(run.code).toBe(1);
      expect(run.err).toContain('the configuration changed while init was running');
      expect(run.out).not.toContain('Configuration written to');
      expect(await readFile(file, 'utf8')).toBe(foreign);
    } finally {
      await dir.remove();
    }
  });

  it('displayed current settings never contain the stored secret (§6.3)', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const file = configFilePath(dir.path);
      await writeFile(
        file,
        JSON.stringify(
          {
            app: { timezone: 'UTC' },
            accounts: [
              { id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-stored-secret-xyz' },
              { id: 'ci', providerId: 'zai', label: 'ci', apiKeyEnv: 'ZAI_KEY' },
            ],
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      const run = await runHandler(dir.path, {}, KEEP_ALL);
      expect(run.code).toBe(0);
      expect(run.out).toContain("'work' (API key configured, hidden)");
      expect(run.out).toContain("'ci' (API key from environment variable 'ZAI_KEY')");
      expect(run.out + run.err).not.toContain('sk-stored-secret-xyz');
    } finally {
      await dir.remove();
    }
  });

  it('a symlinked configuration directory is refused without writing anything', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const target = join(dir.path, 'real-config');
      await mkdir(target, { mode: 0o700 });
      const link = join(dir.path, 'config-link');
      await symlink(target, link);

      const run = await runHandler(link, {}, FULL_FRESH);
      expect(run.code).toBe(1);
      expect(run.err).toContain('symbolic link');
      expect(run.err).not.toContain('refusing to start');
      // The refusal wrote nothing through the symlink.
      await expect(readFile(configFilePath(target))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await dir.remove();
    }
  });
});

describe('init idempotency — --yes against an existing configuration', () => {
  it('absent options retain current values: no silent revert to the defaults', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const first = await runHandler(dir.path, { yes: true, timezone: 'UTC', port: '9000' }, []);
      expect(first.code).toBe(0);
      expect((await readConfig(dir.path)).server).toEqual({ host: '127.0.0.1', port: 9000 });

      const file = configFilePath(dir.path);
      const before = await readFile(file, 'utf8');
      const second = await runHandler(dir.path, { yes: true, timezone: 'UTC' }, []);
      expect(second.code).toBe(0);
      expect(second.out).toContain('Existing configuration found at');
      expect(second.out).toContain('Options that are not passed keep the current values.');
      expect(second.out).toContain('No changes — the existing configuration is kept');
      // The customized port survived an invocation without --port.
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      await dir.remove();
    }
  });

  it('an explicit option is the consent: only that setting changes', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      await runHandler(dir.path, { yes: true, timezone: 'UTC', port: '9000' }, []);
      const run = await runHandler(dir.path, { yes: true, timezone: 'UTC', port: '9001' }, []);
      expect(run.code).toBe(0);
      expect(run.out).toContain('Configuration updated at');
      expect((await readConfig(dir.path)).server).toEqual({ host: '127.0.0.1', port: 9001 });
    } finally {
      await dir.remove();
    }
  });

  it('the account options fail against an existing configuration', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      await runHandler(dir.path, { yes: true, timezone: 'UTC' }, []);
      const file = configFilePath(dir.path);
      const before = await readFile(file, 'utf8');

      const run = await runHandler(
        dir.path,
        { yes: true, timezone: 'UTC', 'account-label': 'work' },
        [],
      );
      expect(run.code).toBe(1);
      expect(run.err).toContain('apply only to a fresh initialization');
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      await dir.remove();
    }
  });
});

/* ── Child process (the real launcher, twice in one directory) ─────────── */

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `quotameter init <args>` in `configDir` with `stdinData` piped in. */
function runLauncher(
  configDir: string,
  args: readonly string[],
  stdinData: string,
): Promise<RunResult> {
  const child = spawn(process.execPath, ['--import', 'jiti/register', BIN, 'init', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QUOTAMETER_CONFIG_DIR: configDir },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.on('error', () => undefined);
  child.stdin?.write(stdinData);
  child.stdin?.end();
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

describe('init idempotency (real launcher, double run)', () => {
  it('interactive: first run creates the config, second offers keep and preserves it', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const first = await runLauncher(dir.path, [], 'Europe/Berlin\n127.0.0.1\n9000\n120\n\n');
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('Configuration written to');
      const file = configFilePath(dir.path);
      const created = await readFile(file, 'utf8');
      expect(JSON.parse(created)).toMatchObject({
        server: { host: '127.0.0.1', port: 9000 },
        app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120 },
      });

      const second = await runLauncher(dir.path, [], '\n\n\n\n');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Existing configuration found at');
      expect(second.stdout).toContain('Enter to keep Europe/Berlin');
      expect(second.stdout).toContain('No changes — the existing configuration is kept');
      expect(await readFile(file, 'utf8')).toBe(created);
    } finally {
      await dir.remove();
    }
  }, 40_000);

  it('--yes: a repeat without --port keeps the customized port (no consent, no overwrite)', async () => {
    const dir = await createTempDir('qm-init-132-');
    try {
      const first = await runLauncher(
        dir.path,
        ['--yes', '--timezone', 'Europe/Berlin', '--port', '9100'],
        '',
      );
      expect(first.code).toBe(0);
      const file = configFilePath(dir.path);

      const second = await runLauncher(dir.path, ['--yes', '--timezone', 'Europe/Berlin'], '');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Existing configuration found at');
      expect(second.stdout).toContain('No changes — the existing configuration is kept');
      const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      expect(config.server).toEqual({ host: '127.0.0.1', port: 9100 });
    } finally {
      await dir.remove();
    }
  }, 40_000);
});
