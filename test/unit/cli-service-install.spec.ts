import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CliContext } from '../../src/cli/commands';
import type { CliOutput } from '../../src/cli/output';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import {
  parseRestartSecSeconds,
  removeUnitFileFromDisk,
  renderNothingInstalled,
  renderNotActiveSteps,
  renderOtherUnitInstalledHint,
  renderSystemUnitCompletionSteps,
  renderSystemUnitInstalled,
  renderSystemUnitUninstalled,
  renderUserUnitCompletionSteps,
  renderUserUnitInstalled,
  renderUserUnitUninstalled,
  runServiceInstallCommand,
  runServiceUninstallCommand,
  unitFileExistsOnDisk,
  type ServiceCommandDeps,
} from '../../src/cli/service-install';
import type {
  CommandOutcome,
  ServiceCommandRunner,
  ServiceSetupSeams,
} from '../../src/cli/service-setup';
import { INIT_RESTART_SEC_SECONDS } from '../../src/cli/service-setup';
import { SYSTEM_UNIT_INSTALL_PATH, validateSystemUnit } from '../../src/cli/systemd-unit';
import { userUnitInstallPath, validateUserUnit } from '../../src/cli/systemd-user-unit';
import { createTempDir } from '../helpers/isolation';

/**
 * The `service install` / `service uninstall` command handlers (task 139,
 * spec §5.2/§5.4, decision D-108) — the done-condition's four-corner
 * idempotency matrix (install/uninstall × absent/present) on both unit
 * kinds, the D-105 privileged routing, and every failure path rendered
 * actionable.
 *
 * Every branch is seam-driven like task 137's suite: the container and CI
 * images ship no systemd and no sudo, so the system-unit and user-unit
 * routes cannot occur there for real. The one route the container does
 * produce — the systemd-less refusal / manager-less removal — is
 * additionally pinned through the real launcher in
 * `test/integration/cli-service-install.spec.ts`.
 */

/** Representative owner; a regular account, never root (D-105 guarantees it). */
const OWNER: PasswdEntry = { name: 'alice', uid: 1001, gid: 1001, home: '/home/alice' };

/** A regular-user invocation (the unprivileged side of the matrix). */
const REGULAR: ServiceOwnerContext = { kind: 'regular-user', privileges: 'none', user: OWNER };

/** A `sudo quotameter service …` invocation (privileges held in-process). */
const HELD: ServiceOwnerContext = { kind: 'sudo', privileges: 'held', user: OWNER };

/** Capabilities fixed per test; `systemd`/`userManager` are the only inputs. */
function caps(systemd: boolean, userManager: boolean) {
  return { systemd, userManager };
}

/** The user unit's install path under the representative owner home. */
const USER_UNIT_PATH = userUnitInstallPath('/home/alice');

/** Seams fixed to a runnable environment: deterministic absolute paths. */
const EXEC_PATHS: Pick<ServiceSetupSeams, 'execPaths'> = {
  execPaths: () => ({
    nodePath: '/usr/bin/node',
    cliPath: '/usr/local/lib/node_modules/quotameter/bin/quotameter.mjs',
  }),
};

/**
 * A seam recorder whose `unitFileExists` models the disk: seeded paths
 * exist, writes add, removals delete — so the idempotency branches observe
 * the same before/after states a real filesystem would show.
 */
function recorder(
  disk: readonly string[] = [],
  failAt?: string,
): {
  output: CliOutput;
  out(): string;
  err(): string;
  commands(): readonly string[][];
  writes(): readonly { installPath: string; content: string }[];
  removals(): readonly string[];
  runCommand: ServiceCommandRunner;
  writeUnitFile: ServiceCommandDeps['writeUnitFile'];
  removeUnitFile: ServiceCommandDeps['removeUnitFile'];
  unitFileExists: ServiceCommandDeps['unitFileExists'];
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const commands: string[][] = [];
  const writes: Array<{ installPath: string; content: string }> = [];
  const removals: string[] = [];
  const files = new Set(disk);
  return {
    output: {
      out: (text: string) => void outLines.push(text),
      err: (text: string) => void errLines.push(text),
    },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
    commands: () => commands,
    writes: () => writes,
    removals: () => removals,
    runCommand: async (command) => {
      commands.push([...command]);
      const failed = failAt !== undefined && command.join(' ') === failAt;
      const outcome: CommandOutcome = failed
        ? { ok: false, detail: 'mock systemctl failure' }
        : { ok: true, detail: '' };
      return outcome;
    },
    writeUnitFile: async (installPath, content) => {
      writes.push({ installPath, content });
      files.add(installPath);
    },
    removeUnitFile: async (installPath) => {
      removals.push(installPath);
      files.delete(installPath);
    },
    unitFileExists: (installPath) => files.has(installPath),
  };
}

/** Builds a CliContext for one of the two command paths. */
function context(
  commandPath: readonly string[],
  flags: Record<string, boolean | string> = {},
): { ctx: CliContext; out(): string; err(): string } {
  const outText: string[] = [];
  const errText: string[] = [];
  return {
    ctx: {
      output: {
        out: (text: string) => void outText.push(`${text}\n`),
        err: (text: string) => void errText.push(`${text}\n`),
      },
      version: 'test',
      commandPath,
      flags,
      positionals: [],
    },
    out: () => outText.join(''),
    err: () => errText.join(''),
  };
}

/** Runs `service install` with fixed routing seams; owner/caps per test. */
async function install(
  owner: ServiceOwnerContext,
  capabilities: { systemd: boolean; userManager: boolean },
  rec: ReturnType<typeof recorder>,
  flags: Record<string, boolean | string> = {},
  extra: ServiceCommandDeps = {},
): Promise<{ code: number; out: string; err: string }> {
  const h = context(['service', 'install'], flags);
  const code = await runServiceInstallCommand({
    ...EXEC_PATHS,
    resolveOwner: () => ({ state: 'ok', context: owner }),
    probeCapabilities: () => capabilities,
    runCommand: rec.runCommand,
    writeUnitFile: rec.writeUnitFile,
    removeUnitFile: rec.removeUnitFile,
    unitFileExists: rec.unitFileExists,
    ...extra,
  })(h.ctx);
  return { code, out: h.out(), err: h.err() };
}

/** Runs `service uninstall` with fixed routing seams; owner/caps per test. */
async function uninstall(
  owner: ServiceOwnerContext,
  capabilities: { systemd: boolean; userManager: boolean },
  rec: ReturnType<typeof recorder>,
  extra: ServiceCommandDeps = {},
): Promise<{ code: number; out: string; err: string }> {
  const h = context(['service', 'uninstall']);
  const code = await runServiceUninstallCommand({
    ...EXEC_PATHS,
    resolveOwner: () => ({ state: 'ok', context: owner }),
    probeCapabilities: () => capabilities,
    runCommand: rec.runCommand,
    writeUnitFile: rec.writeUnitFile,
    removeUnitFile: rec.removeUnitFile,
    unitFileExists: rec.unitFileExists,
    ...extra,
  })(h.ctx);
  return { code, out: h.out(), err: h.err() };
}

/** The exact manager-command sequences, pinned once for every test below. */
const SYSTEM_INSTALL_SEQUENCE = [
  ['systemctl', 'daemon-reload'],
  ['systemctl', 'enable', '--now', 'quotameter.service'],
  ['systemctl', 'is-active', 'quotameter.service'],
];
const USER_INSTALL_SEQUENCE = [
  ['systemctl', '--user', 'daemon-reload'],
  ['systemctl', '--user', 'enable', '--now', 'quotameter.service'],
];
const SYSTEM_UNINSTALL_SEQUENCE = [
  ['systemctl', 'disable', '--now', 'quotameter.service'],
  ['systemctl', 'daemon-reload'],
];
const USER_UNINSTALL_SEQUENCE = [
  ['systemctl', '--user', 'disable', '--now', 'quotameter.service'],
  ['systemctl', '--user', 'daemon-reload'],
];

describe('parseRestartSecSeconds — the --restart-sec flag (§5.4 configurable RestartSec)', () => {
  it('accepts plain decimal whole seconds', () => {
    expect(parseRestartSecSeconds('1')).toEqual({ ok: true, seconds: 1 });
    expect(parseRestartSecSeconds('5')).toEqual({ ok: true, seconds: 5 });
    expect(parseRestartSecSeconds('60')).toEqual({ ok: true, seconds: 60 });
    // Leading zeros are decimal whole seconds, not a second grammar.
    expect(parseRestartSecSeconds('05')).toEqual({ ok: true, seconds: 5 });
  });

  it('refuses non-decimal, sub-unit, zero, and unsafe-integer values', () => {
    for (const value of ['abc', '1.5', '-1', '', '1e3', ' 5', '5 ']) {
      expect(parseRestartSecSeconds(value), value).toEqual({
        ok: false,
        problem: expect.stringContaining('--restart-sec must be a whole number of seconds'),
      });
    }
    // In-range grammar but out-of-range value: the >= 1 problem.
    expect(parseRestartSecSeconds('0')).toEqual({
      ok: false,
      problem: expect.stringContaining('>= 1'),
    });
    // Number("999999999999999999999") loses precision past 2^53 — refused,
    // the same bound the generator's own assert enforces.
    expect(parseRestartSecSeconds('999999999999999999999')).toEqual({
      ok: false,
      problem: expect.stringContaining('>= 1'),
    });
    // The offending value is JSON-quoted, never pasted raw.
    const hostile = parseRestartSecSeconds('5;rm -rf /');
    expect(hostile.ok).toBe(false);
    if (!hostile.ok) expect(hostile.problem).toContain('"5;rm -rf /"');
  });
});

describe('install — the owner resolution gate (D-105, D-106)', () => {
  it('owner problems fail fast, one prefixed stderr line each, nothing runs', async () => {
    const rec = recorder();
    const h = context(['service', 'install']);
    const code = await runServiceInstallCommand({
      resolveOwner: () => ({
        state: 'problems',
        problems: [
          'the process is running as root without SUDO_USER — the service owner cannot be determined',
          'a second problem line',
        ],
      }),
      probeCapabilities: () => {
        throw new Error('capabilities must not be probed after owner problems');
      },
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toBe(
      'quotameter service install: the process is running as root without SUDO_USER — the service owner cannot be determined\n' +
        'quotameter service install: a second problem line\n',
    );
    expect(rec.commands()).toEqual([]);
    expect(rec.writes()).toEqual([]);
  });

  it('the same gate holds for uninstall, with its own prefix', async () => {
    const rec = recorder();
    const h = context(['service', 'uninstall']);
    const code = await runServiceUninstallCommand({
      resolveOwner: () => ({ state: 'problems', problems: ['SUDO_USER is set but empty'] }),
      probeCapabilities: () => {
        throw new Error('capabilities must not be probed after owner problems');
      },
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toBe('quotameter service uninstall: SUDO_USER is set but empty\n');
  });

  it('an unsafe owner name is refused before anything renders or runs', async () => {
    const hostile: ServiceOwnerContext = {
      kind: 'regular-user',
      privileges: 'none',
      user: { ...OWNER, name: 'alice;systemctl poweroff' },
    };
    const rec = recorder();
    const result = await install(hostile, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(result.out).toBe('');
    expect(result.err).toContain('quotameter service install: the service owner');
    expect(result.err).toContain('no commands are printed');
    expect(result.err).not.toContain('  alice;systemctl poweroff');
  });

  it('an invalid --restart-sec value is a clear failure before any side effect', async () => {
    const rec = recorder();
    const result = await install(REGULAR, caps(true, true), rec, { 'restart-sec': '0' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('quotameter service install: --restart-sec must be');
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
  });
});

describe('install — the system-unit route (privileged, §5.3 step 7 / §5.4)', () => {
  it('installs when absent: the D-103 unit, the full sequence, exit 0', async () => {
    const rec = recorder();
    const result = await install(HELD, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(rec.writes()).toHaveLength(1);
    const written = rec.writes()[0]!;
    expect(written.installPath).toBe(SYSTEM_UNIT_INSTALL_PATH);
    // The content is exactly the task-134 generator's output, with the
    // owner's §6.1 directories and the default restart seconds.
    expect(written.content).toContain('User=alice');
    expect(written.content).toContain(
      'ExecStart=/usr/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run',
    );
    expect(written.content).toContain(`RestartSec=${INIT_RESTART_SEC_SECONDS}s`);
    expect(written.content).toContain(
      'ReadWritePaths=/home/alice/.config/quotameter /home/alice/.local/share/quotameter',
    );
    expect(
      validateSystemUnit(written.content, {
        configDir: '/home/alice/.config/quotameter',
        dataDir: '/home/alice/.local/share/quotameter',
      }),
    ).toEqual([]);
    expect(rec.commands()).toEqual(SYSTEM_INSTALL_SEQUENCE);
    expect(result.out).toContain('installed the system service for alice');
    expect(result.out).toContain(`Unit file: ${SYSTEM_UNIT_INSTALL_PATH}`);
    expect(result.out).toContain('User=alice');
    expect(result.out).toContain('quotameter status');
    expect(result.out).not.toContain('regenerated');
  });

  it('installs when present: the same sequence, plus the regenerated note (§5.4)', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await install(HELD, caps(true, false), rec, {}, { pathEnv: {} });
    // Privileges beat the user manager (D-106): still the system-unit route.
    expect(result.code).toBe(0);
    expect(rec.commands()).toEqual(SYSTEM_INSTALL_SEQUENCE);
    expect(rec.writes()).toHaveLength(1);
    expect(result.out).toContain('Unit file: /etc/systemd/system/quotameter.service (regenerated)');
    expect(result.out).toContain('keeps the previous unit until it is restarted');
    // Prescriptive commands carry the sudo prefix: the normal invocation is
    // the one-shot `sudo quotameter service install`, whose shell is the
    // regular account (review round).
    expect(result.out).toContain('sudo systemctl restart quotameter.service');
  });

  it('--restart-sec reaches the generated RestartSec', async () => {
    const rec = recorder();
    const result = await install(
      HELD,
      caps(true, true),
      rec,
      { 'restart-sec': '9' },
      { pathEnv: {} },
    );
    expect(result.code).toBe(0);
    expect(rec.writes()[0]?.content).toContain('RestartSec=9s');
  });

  it("the ReadWritePaths follow operator-declared §6.1 overrides, HOME stays the owner's", async () => {
    const rec = recorder();
    const result = await install(
      HELD,
      caps(true, true),
      rec,
      {},
      {
        pathEnv: {
          HOME: '/root',
          QUOTAMETER_CONFIG_DIR: '/srv/quotameter/config',
          QUOTAMETER_DATA_DIR: '/srv/quotameter/data',
        },
      },
    );
    expect(result.code).toBe(0);
    const content = rec.writes()[0]?.content ?? '';
    expect(content).toContain('ReadWritePaths=/srv/quotameter/config /srv/quotameter/data');
    expect(content).not.toContain('/root');
    expect(
      validateSystemUnit(content, {
        configDir: '/srv/quotameter/config',
        dataDir: '/srv/quotameter/data',
      }),
    ).toEqual([]);
  });

  it('a failing daemon-reload leaves the unit on disk with the exact completion commands', async () => {
    const rec = recorder([], 'systemctl daemon-reload');
    const result = await install(HELD, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'quotameter service install: `systemctl daemon-reload` failed (mock systemctl failure)',
    );
    expect(rec.writes()).toHaveLength(1);
    expect(rec.commands()).toEqual([SYSTEM_INSTALL_SEQUENCE[0]]);
    expect(result.out).toContain(`The unit file is written to ${SYSTEM_UNIT_INSTALL_PATH}`);
    // The commands are copy-pasteable from the regular account's shell —
    // the one-shot sudo invocation leaves that shell unprivileged.
    expect(result.out).toContain('\n  sudo systemctl daemon-reload\n');
    expect(result.out).toContain('\n  sudo systemctl enable --now quotameter.service\n');
    expect(result.out).toContain('\n  sudo systemctl is-active quotameter.service\n');
  });

  it('a failing enable falls back to the same completion steps', async () => {
    const rec = recorder([], 'systemctl enable --now quotameter.service');
    const result = await install(HELD, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(1);
    expect(result.err).toContain('`systemctl enable --now quotameter.service` failed');
    expect(rec.commands()).toEqual(SYSTEM_INSTALL_SEQUENCE.slice(0, 2));
    expect(result.out).toContain('\n  sudo systemctl enable --now quotameter.service\n');
  });

  it('a failing is-active reports honestly: installed and enabled, but not active', async () => {
    const rec = recorder([], 'systemctl is-active quotameter.service');
    const result = await install(HELD, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'the service was installed and enabled but `systemctl is-active` does not report it active',
    );
    expect(rec.commands()).toEqual(SYSTEM_INSTALL_SEQUENCE);
    expect(result.out).toContain(
      'installed and enabled, but the service did not reach the active state',
    );
    expect(result.out).toContain('\n  quotameter status\n');
    expect(result.out).toContain('\n  quotameter logs\n');
    expect(result.out).toContain('\n  quotameter init\n');
  });

  it('a failing unit write runs no commands and offers the foreground alternative', async () => {
    const rec = recorder();
    const result = await install(
      HELD,
      caps(true, true),
      rec,
      {},
      {
        pathEnv: {},
        writeUnitFile: async () => {
          throw new Error('EACCES: permission denied');
        },
      },
    );
    expect(result.code).toBe(1);
    expect(rec.commands()).toEqual([]);
    expect(rec.writes()).toEqual([]);
    expect(result.err).toContain('installing the system unit failed (EACCES: permission denied)');
    expect(result.out).toContain('\n  quotameter run\n');
    // The privileged foreground alternative names the owner's account —
    // the service must never run as root (§5.1).
    expect(result.out).toContain("alice's regular account");
  });

  it('an unusable owner home fails the preparation loudly, nothing runs', async () => {
    const brokenHome: ServiceOwnerContext = {
      kind: 'sudo',
      privileges: 'held',
      user: { ...OWNER, home: '' },
    };
    const rec = recorder();
    const result = await install(brokenHome, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(1);
    expect(result.err).toContain('preparing the system unit failed');
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
  });

  it('a pre-existing user unit draws a both-units warning; the install still succeeds', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await install(HELD, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(0);
    expect(result.err).toContain('quotameter service install: note: a user unit is installed');
    expect(result.err).toContain('only one should be installed');
  });

  it('without a configuration the health verification is skipped honestly, exit 0 (U-059)', async () => {
    const rec = recorder();
    const result = await install(HELD, caps(true, true), rec, {}, { pathEnv: {} });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      'Health check skipped: no configuration exists at /home/alice/.config/quotameter/config.json, ' +
        'so the endpoint is unknown',
    );
  });

  it('an invalid configuration skips with its own reason — the detection problems are not dropped (review P3)', async () => {
    const dir = await createTempDir('qm-install-health-');
    try {
      await writeFile(join(dir.path, 'config.json'), JSON.stringify({ server: 'not-an-object' }));
      const rec = recorder();
      const result = await install(
        HELD,
        caps(true, true),
        rec,
        {},
        {
          pathEnv: { QUOTAMETER_CONFIG_DIR: dir.path },
          checkServiceHealth: () => {
            throw new Error('an invalid configuration must not be probed');
          },
        },
      );
      expect(result.code).toBe(0);
      expect(result.out).toContain('Health check skipped: the configuration at');
      expect(result.out).toContain('is not readable as a valid configuration');
      expect(result.out).toContain('so the endpoint is unknown');
    } finally {
      await dir.remove();
    }
  });

  it('a readable configuration gets the /api/health verification after is-active (U-059, D-187)', async () => {
    const dir = await createTempDir('qm-install-health-');
    try {
      await writeFile(
        join(dir.path, 'config.json'),
        JSON.stringify({
          server: { host: '127.0.0.1', port: 9123 },
          app: {
            timezone: 'Europe/Berlin',
            pollingIntervalSeconds: 120,
            historyRetentionDays: 90,
          },
          accounts: [],
        }),
      );
      const rec = recorder();
      const probed: Array<{ host: string; port: number }> = [];
      const result = await install(
        HELD,
        caps(true, true),
        rec,
        {},
        {
          pathEnv: { QUOTAMETER_CONFIG_DIR: dir.path },
          checkServiceHealth: async (host, port) => {
            probed.push({ host, port });
            return { state: 'healthy' };
          },
        },
      );
      expect(result.code).toBe(0);
      // The probe targets the owner's configured endpoint, resolved through
      // the same §6.1 precedence as the unit's ReadWritePaths.
      expect(probed).toEqual([{ host: '127.0.0.1', port: 9123 }]);
      expect(result.out).toContain('Health check passed: GET http://127.0.0.1:9123/api/health');
      expect(result.out).not.toContain('Health check skipped');
    } finally {
      await dir.remove();
    }
  });

  it('a failed /api/health verification fails the install with the honest guidance (U-059)', async () => {
    const dir = await createTempDir('qm-install-health-');
    try {
      await writeFile(
        join(dir.path, 'config.json'),
        JSON.stringify({
          server: { host: '127.0.0.1', port: 9123 },
          app: {
            timezone: 'Europe/Berlin',
            pollingIntervalSeconds: 120,
            historyRetentionDays: 90,
          },
          accounts: [],
        }),
      );
      const rec = recorder();
      const result = await install(
        HELD,
        caps(true, true),
        rec,
        {},
        {
          pathEnv: { QUOTAMETER_CONFIG_DIR: dir.path },
          checkServiceHealth: async () => ({
            state: 'failed',
            detail: 'the endpoint answered HTTP 503',
          }),
        },
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        'quotameter service install: the installed service did not pass the /api/health ' +
          'verification (the endpoint answered HTTP 503)',
      );
      expect(result.out).toContain(
        'The health check GET http://127.0.0.1:9123/api/health did not pass within 30 seconds',
      );
      expect(result.out).toContain('\n  quotameter status\n');
      expect(result.out).toContain('\n  quotameter logs\n');
      // The full manager sequence ran — the failure is verification's, not
      // installation's.
      expect(rec.commands()).toEqual(SYSTEM_INSTALL_SEQUENCE);
    } finally {
      await dir.remove();
    }
  });
});

describe('install — the user-unit route (unprivileged, §5.3 step 7)', () => {
  it('installs when absent: the D-104 unit, enable without sudo, linger guidance, exit 0', async () => {
    const rec = recorder();
    const result = await install(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(rec.writes()).toHaveLength(1);
    const written = rec.writes()[0]!;
    expect(written.installPath).toBe(USER_UNIT_PATH);
    expect(written.content).toContain(
      'ExecStart=/usr/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run',
    );
    expect(written.content).toContain(`RestartSec=${INIT_RESTART_SEC_SECONDS}s`);
    expect(validateUserUnit(written.content)).toEqual([]);
    expect(rec.commands()).toEqual(USER_INSTALL_SEQUENCE);
    expect(result.out).toContain('installed the user service for alice — no sudo needed');
    expect(result.out).toContain(`Unit file: ${USER_UNIT_PATH}`);
    // The default linger probe reads the flag file: absent on the test
    // container → disabled → the exact enable-linger command (D-107).
    expect(result.out).toContain('\n  sudo loginctl enable-linger alice\n');
    expect(result.out).not.toContain('regenerated');
  });

  it('installs when present: same sequence plus the regenerated note', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await install(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(rec.commands()).toEqual(USER_INSTALL_SEQUENCE);
    expect(rec.writes()).toHaveLength(1);
    expect(result.out).toContain(`Unit file: ${USER_UNIT_PATH} (regenerated)`);
    expect(result.out).toContain('systemctl --user restart quotameter.service');
  });

  it('the user route never probes health — §5.3 prescribes verification for the privileged leg (U-059, D-187)', async () => {
    // A throwing probe makes a would-be call a visible test failure.
    const rec = recorder();
    const result = await install(
      REGULAR,
      caps(true, true),
      rec,
      {},
      {
        checkServiceHealth: () => {
          throw new Error('the user route must not run the health verification');
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Health check');
  });

  it('--restart-sec reaches the generated user unit too', async () => {
    const rec = recorder();
    const result = await install(REGULAR, caps(true, true), rec, { 'restart-sec': '30' });
    expect(result.code).toBe(0);
    expect(rec.writes()[0]?.content).toContain('RestartSec=30s');
  });

  it('the linger guidance follows the probed state (D-107)', async () => {
    const enabled = recorder();
    const enabledResult = await install(
      REGULAR,
      caps(true, true),
      enabled,
      {},
      { probeLinger: () => 'enabled' },
    );
    expect(enabledResult.code).toBe(0);
    expect(enabledResult.out).toContain('Linger is already enabled for alice');
    expect(enabledResult.out).not.toContain('loginctl');

    const unknown = recorder();
    const unknownResult = await install(
      REGULAR,
      caps(true, true),
      unknown,
      {},
      { probeLinger: () => 'unknown' },
    );
    expect(unknownResult.code).toBe(0);
    expect(unknownResult.out).toContain('could not be determined');
    expect(unknownResult.out).toContain('\n  sudo loginctl enable-linger alice\n');
  });

  it('a failing daemon-reload or enable leaves the unit on disk with the session commands', async () => {
    const reload = recorder([], 'systemctl --user daemon-reload');
    const reloadResult = await install(REGULAR, caps(true, true), reload);
    expect(reloadResult.code).toBe(1);
    expect(reloadResult.err).toContain(
      'quotameter service install: `systemctl --user daemon-reload` failed (mock systemctl failure)',
    );
    expect(reload.writes()).toHaveLength(1);
    expect(reloadResult.out).toContain(`The unit file is written to ${USER_UNIT_PATH}`);
    expect(reloadResult.out).toContain('\n  systemctl --user daemon-reload\n');
    expect(reloadResult.out).toContain('\n  systemctl --user enable --now quotameter.service\n');
    expect(reloadResult.out).toContain('\n  sudo loginctl enable-linger alice\n');
    expect(reloadResult.out).toContain('\n  quotameter run\n');

    const enable = recorder([], 'systemctl --user enable --now quotameter.service');
    const enableResult = await install(REGULAR, caps(true, true), enable);
    expect(enableResult.code).toBe(1);
    expect(enableResult.err).toContain('`systemctl --user enable --now quotameter.service` failed');
    expect(enableResult.out).toContain('could not be enabled automatically');
  });

  it('a failing unit write runs no commands and offers the plain foreground alternative', async () => {
    const rec = recorder();
    const result = await install(
      REGULAR,
      caps(true, true),
      rec,
      {},
      {
        writeUnitFile: async () => {
          throw new Error('EACCES: permission denied');
        },
      },
    );
    expect(result.code).toBe(1);
    expect(rec.commands()).toEqual([]);
    expect(rec.writes()).toEqual([]);
    expect(result.err).toContain('installing the user unit failed (EACCES: permission denied)');
    expect(result.out).toContain('\n  quotameter run\n');
    // The unprivileged alternative is typed by the owner themselves.
    expect(result.out).not.toContain('regular account');
  });

  it('a pre-existing system unit draws a both-units warning; the install still succeeds', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await install(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      `quotameter service install: note: a system unit is installed at ${SYSTEM_UNIT_INSTALL_PATH}`,
    );
    expect(result.err).toContain('only one should be installed');
  });

  it('an unusable owner home fails loudly, nothing written', async () => {
    const brokenHome: ServiceOwnerContext = {
      kind: 'regular-user',
      privileges: 'none',
      user: { ...OWNER, home: 'not absolute' },
    };
    const rec = recorder();
    const result = await install(brokenHome, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(result.err).toContain('installing the user unit failed');
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
  });
});

describe('install — the unavailable routes', () => {
  it('no systemd, no sudo: refused with the foreground alternative, exit 1, zero side effects', async () => {
    const rec = recorder();
    const result = await install(REGULAR, caps(false, false), rec);
    expect(result.code).toBe(1);
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(result.err).toContain(
      'quotameter service install: systemd is not available on this machine, so the service cannot be installed here',
    );
    expect(result.out).toContain('\n  quotameter run\n');
    expect(result.out).not.toContain('regular account');
  });

  it('no systemd, privileges held: the alternative names the owner account (§5.1 never-root)', async () => {
    const rec = recorder();
    const result = await install(HELD, caps(false, false), rec);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "from alice's regular account (the service must never run as root)",
    );
    expect(result.out).toContain('\n  quotameter run\n');
  });

  it('user manager unreachable: the unit is still written, the session commands print, exit 1', async () => {
    const rec = recorder();
    const result = await install(REGULAR, caps(true, false), rec);
    expect(result.code).toBe(1);
    expect(rec.writes()).toHaveLength(1);
    // No manager commands are attempted — they cannot succeed here.
    expect(rec.commands()).toEqual([]);
    expect(result.err).toContain('the systemd user manager is not reachable in this session');
    expect(result.out).toContain(`The unit file is written to ${USER_UNIT_PATH}`);
    expect(result.out).toContain('\n  systemctl --user daemon-reload\n');
    expect(result.out).toContain('\n  systemctl --user enable --now quotameter.service\n');
    expect(result.out).toContain('\n  sudo loginctl enable-linger alice\n');
    expect(result.out).toContain('\n  quotameter run\n');
  });
});

describe('uninstall — the system-unit route (privileged)', () => {
  it('uninstalls when present: disable, remove, reload, exit 0', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await uninstall(HELD, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(rec.commands()).toEqual(SYSTEM_UNINSTALL_SEQUENCE);
    expect(rec.removals()).toEqual([SYSTEM_UNIT_INSTALL_PATH]);
    expect(result.out).toContain('removed the system service');
    expect(result.out).toContain(`Removed unit file: ${SYSTEM_UNIT_INSTALL_PATH}`);
    expect(result.out).toContain('systemctl disable --now quotameter.service');
    expect(result.out).toContain('\n  quotameter run\n');
  });

  it('uninstall when absent: nothing to do, exit 0, zero side effects', async () => {
    const rec = recorder();
    const result = await uninstall(HELD, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(rec.commands()).toEqual([]);
    expect(rec.removals()).toEqual([]);
    expect(result.out).toContain('no system service is installed — nothing to do');
  });

  it('uninstall when absent with a user unit installed: the exact other-kind hint', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await uninstall(HELD, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.out).toContain('nothing to do');
    expect(result.out).toContain('A user service is installed for alice');
    expect(result.out).toContain('\n  quotameter service uninstall\n');
    expect(rec.removals()).toEqual([]);
  });

  it('a failing disable is reported but the file is still removed and systemd reloaded', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH], 'systemctl disable --now quotameter.service');
    const result = await uninstall(HELD, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      '`systemctl disable --now quotameter.service` failed (mock systemctl failure)',
    );
    expect(rec.commands()).toEqual(SYSTEM_UNINSTALL_SEQUENCE);
    expect(rec.removals()).toEqual([SYSTEM_UNIT_INSTALL_PATH]);
    // Honest partial outcome: the file is gone and the exact cleanup prints
    // (a failed disable cannot be re-run against a removed file — one
    // daemon-reload makes the manager forget the unit; review round).
    expect(result.out).toContain('not every manager command succeeded');
    expect(result.out).toContain(`Removed unit file: ${SYSTEM_UNIT_INSTALL_PATH}`);
    expect(result.out).toContain('\n  sudo systemctl daemon-reload\n');
    expect(result.out).not.toContain('Disabled and stopped with');
  });

  it('a failing removal aborts before daemon-reload and exits 1', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await uninstall(HELD, caps(true, true), rec, {
      removeUnitFile: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('removing the system unit failed (EACCES: permission denied)');
    expect(rec.commands()).toEqual([SYSTEM_UNINSTALL_SEQUENCE[0]]);
  });

  it('a failing daemon-reload is reported; the file is gone, exit 1', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH], 'systemctl daemon-reload');
    const result = await uninstall(HELD, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(result.err).toContain('`systemctl daemon-reload` failed');
    expect(rec.removals()).toEqual([SYSTEM_UNIT_INSTALL_PATH]);
    expect(result.out).toContain('not every manager command succeeded');
    expect(result.out).toContain('\n  sudo systemctl daemon-reload\n');
  });

  it('no systemd at all: the file is removed without any manager commands, exit 0', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await uninstall(HELD, caps(false, false), rec);
    expect(result.code).toBe(0);
    expect(rec.commands()).toEqual([]);
    expect(rec.removals()).toEqual([SYSTEM_UNIT_INSTALL_PATH]);
    // The managerless outcome never claims commands that were never run
    // (review round P1).
    expect(result.out).toContain('removed the system service');
    expect(result.out).toContain('no systemctl commands were needed');
    expect(result.out).not.toContain('Disabled and stopped with');
    expect(result.out).not.toContain('Reloaded systemd with');
  });
});

describe('uninstall — the user-unit route (unprivileged)', () => {
  it('uninstalls when present: disable, remove, reload, exit 0', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await uninstall(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(rec.commands()).toEqual(USER_UNINSTALL_SEQUENCE);
    expect(rec.removals()).toEqual([USER_UNIT_PATH]);
    expect(result.out).toContain('removed the user service');
    expect(result.out).toContain(`Removed unit file: ${USER_UNIT_PATH}`);
    expect(result.out).toContain('systemctl --user disable --now quotameter.service');
  });

  it('uninstall when absent: nothing to do, exit 0', async () => {
    const rec = recorder();
    const result = await uninstall(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(rec.commands()).toEqual([]);
    expect(rec.removals()).toEqual([]);
    expect(result.out).toContain('no user service is installed — nothing to do');
  });

  it('uninstall when absent with a system unit installed: the sudo hint', async () => {
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await uninstall(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.out).toContain('A system service is installed');
    expect(result.out).toContain('\n  sudo quotameter service uninstall\n');
    expect(rec.removals()).toEqual([]);
  });

  it('a failing disable is reported; removal and reload still run, exit 1', async () => {
    const rec = recorder([USER_UNIT_PATH], 'systemctl --user disable --now quotameter.service');
    const result = await uninstall(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(result.err).toContain('`systemctl --user disable --now quotameter.service` failed');
    expect(rec.commands()).toEqual(USER_UNINSTALL_SEQUENCE);
    expect(rec.removals()).toEqual([USER_UNIT_PATH]);
    // The partial outcome names the owner-typed cleanup command.
    expect(result.out).toContain('not every manager command succeeded');
    expect(result.out).toContain('\n  systemctl --user daemon-reload\n');
  });

  it('a broken user database never escapes the handler as a throw (review round)', async () => {
    // D-105 documents an unreadable /etc/passwd as a thrown error from the
    // production resolver — the handlers render it as the standard failure
    // line instead of letting the dispatcher catch it.
    const h = context(['service', 'uninstall']);
    const code = await runServiceUninstallCommand({
      resolveOwner: () => {
        throw new Error("EACCES: permission denied, open '/etc/passwd'");
      },
      probeCapabilities: () => {
        throw new Error('capabilities must not be probed after a failed owner resolution');
      },
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('quotameter service uninstall: resolving the service owner failed');
    expect(h.err()).toContain('EACCES');

    const installHandle = context(['service', 'install']);
    const installCode = await runServiceInstallCommand({
      resolveOwner: () => {
        throw new Error("EACCES: permission denied, open '/etc/passwd'");
      },
    })(installHandle.ctx);
    expect(installCode).toBe(1);
    expect(installHandle.err()).toContain(
      'quotameter service install: resolving the service owner failed',
    );
  });

  it('an unsafe owner name is refused on uninstall too, before anything runs', async () => {
    const hostile: ServiceOwnerContext = {
      kind: 'sudo',
      privileges: 'held',
      user: { ...OWNER, name: 'bad name' },
    };
    const rec = recorder([SYSTEM_UNIT_INSTALL_PATH]);
    const result = await uninstall(hostile, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(rec.commands()).toEqual([]);
    expect(rec.removals()).toEqual([]);
    expect(result.out).toBe('');
    expect(result.err).toContain('quotameter service uninstall: the service owner');
  });

  it('an unusable owner home fails the path resolution loudly (user route)', async () => {
    const brokenHome: ServiceOwnerContext = {
      kind: 'regular-user',
      privileges: 'none',
      user: { ...OWNER, home: '' },
    };
    const rec = recorder([USER_UNIT_PATH]);
    const result = await uninstall(brokenHome, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(result.err).toContain('resolving the user unit path failed');
    expect(rec.removals()).toEqual([]);
  });

  it('a broken home cannot name a user unit for the no-op hint — still nothing to do', async () => {
    // A held uninstall with no system unit probes the owner's user unit for
    // the cross-kind hint; a passwd home that cannot name a path simply
    // yields no hint, never a failed uninstall.
    const brokenHome: ServiceOwnerContext = {
      kind: 'sudo',
      privileges: 'held',
      user: { ...OWNER, home: 'relative home' },
    };
    const rec = recorder();
    const result = await uninstall(brokenHome, caps(true, true), rec);
    expect(result.code).toBe(0);
    expect(result.out).toContain('no system service is installed — nothing to do');
    expect(result.out).not.toContain('user service is installed');
  });

  it('a failing removal aborts before the user-manager reload and exits 1', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await uninstall(REGULAR, caps(true, true), rec, {
      removeUnitFile: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('removing the user unit failed (EACCES: permission denied)');
    expect(rec.commands()).toEqual([USER_UNINSTALL_SEQUENCE[0]]);
  });

  it('a failing user-manager daemon-reload is reported; the file is gone, exit 1', async () => {
    const rec = recorder([USER_UNIT_PATH], 'systemctl --user daemon-reload');
    const result = await uninstall(REGULAR, caps(true, true), rec);
    expect(result.code).toBe(1);
    expect(result.err).toContain('`systemctl --user daemon-reload` failed');
    expect(rec.removals()).toEqual([USER_UNIT_PATH]);
  });

  it('user manager unreachable: the file is removed without commands, honestly noted, exit 0', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await uninstall(REGULAR, caps(true, false), rec);
    expect(result.code).toBe(0);
    expect(rec.commands()).toEqual([]);
    expect(rec.removals()).toEqual([USER_UNIT_PATH]);
    expect(result.out).toContain('removed the user service');
    expect(result.out).toContain('could not be disabled here');
    expect(result.out).toContain('ignores enablement links to removed units');
  });

  it('no systemd at all: the file is removed without commands, exit 0', async () => {
    const rec = recorder([USER_UNIT_PATH]);
    const result = await uninstall(REGULAR, caps(false, false), rec);
    expect(result.code).toBe(0);
    expect(rec.commands()).toEqual([]);
    expect(rec.removals()).toEqual([USER_UNIT_PATH]);
  });
});

describe('renderers — every outcome names exact, own-line commands', () => {
  it('the system completion steps list all three commands, sudo-prefixed', () => {
    const text = renderSystemUnitCompletionSteps('the lead', SYSTEM_UNIT_INSTALL_PATH);
    expect(text).toContain('Service install: the lead');
    expect(text).toContain(`The unit file is written to ${SYSTEM_UNIT_INSTALL_PATH}`);
    expect(text).toContain('\n  sudo systemctl daemon-reload\n');
    expect(text).toContain('\n  sudo systemctl enable --now quotameter.service\n');
    expect(text).toContain('\n  sudo systemctl is-active quotameter.service');
  });

  it('the user completion steps carry the session commands, linger, and the foreground alternative', () => {
    const text = renderUserUnitCompletionSteps('alice', USER_UNIT_PATH, 'the lead', 'disabled');
    expect(text).toContain('\n  systemctl --user daemon-reload\n');
    expect(text).toContain('\n  systemctl --user enable --now quotameter.service\n');
    expect(text).toContain('\n  sudo loginctl enable-linger alice\n');
    expect(text).toContain('\n  quotameter run');
  });

  it('the installed renderers state the file, the enable command, and the next steps', () => {
    const system = renderSystemUnitInstalled('alice', SYSTEM_UNIT_INSTALL_PATH, false);
    expect(system).toContain('installed the system service for alice');
    expect(system).toContain('Verified active with: systemctl is-active quotameter.service');
    expect(system).not.toContain('regenerated');
    const user = renderUserUnitInstalled('alice', USER_UNIT_PATH, true, 'enabled');
    expect(user).toContain('no sudo needed');
    expect(user).toContain('(regenerated)');
    expect(user).toContain('Linger is already enabled for alice');
  });

  it('the not-active guidance names the three next steps', () => {
    const text = renderNotActiveSteps();
    expect(text).toContain('\n  quotameter status\n');
    expect(text).toContain('\n  quotameter logs\n');
    expect(text).toContain('\n  quotameter init');
  });

  it('the uninstalled renderers name the removed file and stay honest per outcome', () => {
    const clean = renderSystemUnitUninstalled(SYSTEM_UNIT_INSTALL_PATH, {
      managerless: false,
      failedCommands: [],
    });
    expect(clean).toContain(`Removed unit file: ${SYSTEM_UNIT_INSTALL_PATH}`);
    expect(clean).toContain(
      'Disabled and stopped with: systemctl disable --now quotameter.service',
    );
    expect(clean).toContain('\n  quotameter run');
    const managerless = renderSystemUnitUninstalled(SYSTEM_UNIT_INSTALL_PATH, {
      managerless: true,
      failedCommands: [],
    });
    expect(managerless).toContain('no systemctl commands were needed');
    expect(managerless).not.toContain('Disabled and stopped');
    expect(managerless).not.toContain('Reloaded systemd');
    const partial = renderSystemUnitUninstalled(SYSTEM_UNIT_INSTALL_PATH, {
      managerless: false,
      failedCommands: ['systemctl disable --now quotameter.service'],
    });
    expect(partial).toContain('not every manager command succeeded');
    expect(partial).toContain('\n  sudo systemctl daemon-reload\n');

    const userClean = renderUserUnitUninstalled(USER_UNIT_PATH, {
      managerless: false,
      failedCommands: [],
    });
    expect(userClean).toContain(`Removed unit file: ${USER_UNIT_PATH}`);
    expect(userClean).toContain('systemctl --user daemon-reload');
    const userManagerless = renderUserUnitUninstalled(USER_UNIT_PATH, {
      managerless: true,
      failedCommands: [],
    });
    expect(userManagerless).toContain('could not be disabled here');
    expect(userManagerless).not.toContain('systemctl --user disable');
    const userPartial = renderUserUnitUninstalled(USER_UNIT_PATH, {
      managerless: false,
      failedCommands: ['systemctl --user disable --now quotameter.service'],
    });
    expect(userPartial).toContain('\n  systemctl --user daemon-reload\n');
  });

  it('the nothing-installed and cross-kind hints', () => {
    expect(renderNothingInstalled('system')).toContain('no system service is installed');
    expect(renderNothingInstalled('user')).toContain('no user service is installed');
    const systemHint = renderOtherUnitInstalledHint('system', 'alice');
    expect(systemHint).toContain('\n  sudo quotameter service uninstall');
    const userHint = renderOtherUnitInstalledHint('user', 'alice');
    expect(userHint).toContain('\n  quotameter service uninstall');
  });
});

describe('production seams', () => {
  it('removeUnitFileFromDisk removes and tolerates an already-absent file; unitFileExistsOnDisk reads the disk', async () => {
    const dir = await createTempDir('qm-service-install-');
    try {
      const path = join(dir.path, 'unit.service');
      await writeFile(path, '[Unit]\n');
      expect(unitFileExistsOnDisk(path)).toBe(true);
      await removeUnitFileFromDisk(path);
      expect(unitFileExistsOnDisk(path)).toBe(false);
      // force: an absent file is the end state uninstall wants, not an error.
      await removeUnitFileFromDisk(path);
      expect(unitFileExistsOnDisk(join(dir.path, 'never-there'))).toBe(false);
    } finally {
      await dir.remove();
    }
  });

  it('install runs on the production default seams over a real temp home (task-137 pattern)', async () => {
    // Only the owner and the capabilities are scripted (they select the
    // managerless route, where no manager command ever runs): execPaths,
    // writeUnitFile, unitFileExists, runCommand, probeLinger, and pathEnv
    // are the production defaults. The unit really lands under the temp
    // home; the default linger probe reads the absent flag file (disabled).
    const dir = await createTempDir('qm-service-install-defaults-');
    try {
      const owner: ServiceOwnerContext = {
        kind: 'regular-user',
        privileges: 'none',
        user: { ...OWNER, home: dir.path },
      };
      const h = context(['service', 'install']);
      const code = await runServiceInstallCommand({
        resolveOwner: () => ({ state: 'ok', context: owner }),
        probeCapabilities: () => caps(true, false),
      })(h.ctx);
      expect(code).toBe(1); // managerless: written, not enabled
      const installPath = userUnitInstallPath(dir.path);
      expect(unitFileExistsOnDisk(installPath)).toBe(true);
      expect(validateUserUnit(await readFile(installPath, 'utf8'))).toEqual([]);
      expect(h.out()).toContain(`The unit file is written to ${installPath}`);
      expect(h.out()).toContain('\n  sudo loginctl enable-linger alice\n');
    } finally {
      await dir.remove();
    }
  });

  it('a privileged install on the default seams fails honestly at the unwritable system path', async () => {
    // The system route's own seam defaults (execPaths, unitFileExists,
    // writeUnitFile, runCommand) evaluate for real: under the unprivileged
    // test container the write to /etc/systemd/system/ is refused, and the
    // refusal renders exactly like any write failure — never a crash.
    const h = context(['service', 'install']);
    const code = await runServiceInstallCommand({
      resolveOwner: () => ({ state: 'ok', context: HELD }),
      probeCapabilities: () => caps(true, true),
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('quotameter service install: installing the system unit failed');
    expect(h.out()).toContain("from alice's regular account");
    expect(h.out()).toContain('\n  quotameter run');
  });

  it('both handlers resolve the owner from its production default (probe pinned absent)', async () => {
    // The owner seam is the real production default (uid/user
    // database/environment); the capability probe is pinned to the absent
    // class — no hosted CI environment deterministically produces it since
    // the runner-image migration (D-160), and the real probe's live
    // behavior is the integration suite's territory. On that route
    // install refuses and uninstall no-ops without side effects.
    const installHandle = context(['service', 'install']);
    const installCode = await runServiceInstallCommand({
      probeCapabilities: async () => caps(false, false),
    })(installHandle.ctx);
    expect(installCode).toBe(1);
    expect(installHandle.err()).toContain('quotameter service install: systemd is not available');

    const uninstallHandle = context(['service', 'uninstall']);
    const uninstallCode = await runServiceUninstallCommand({
      probeCapabilities: async () => caps(false, false),
    })(uninstallHandle.ctx);
    expect(uninstallCode).toBe(0);
    expect(uninstallHandle.out()).toContain('nothing to do');
  });

  it('a privileged uninstall evaluates its system-route seams against the real disk', async () => {
    // Only the routing facts are scripted (systemd absent → no manager
    // commands, no removal of anything): the system route's own seam
    // defaults evaluate for real, the container's /etc/systemd/system
    // carries no unit, and the result is the side-effect-free no-op.
    const h = context(['service', 'uninstall']);
    const code = await runServiceUninstallCommand({
      resolveOwner: () => ({ state: 'ok', context: HELD }),
      probeCapabilities: () => caps(false, false),
    })(h.ctx);
    expect(code).toBe(0);
    expect(h.out()).toContain('no system service is installed — nothing to do');
  });

  it('uninstall removes through the production default seams over a real temp home', async () => {
    const dir = await createTempDir('qm-service-uninstall-defaults-');
    try {
      const owner: ServiceOwnerContext = {
        kind: 'regular-user',
        privileges: 'none',
        user: { ...OWNER, home: dir.path },
      };
      const installPath = userUnitInstallPath(dir.path);
      await mkdir(dirname(installPath), { recursive: true });
      await writeFile(installPath, '[Unit]\n');
      const h = context(['service', 'uninstall']);
      const code = await runServiceUninstallCommand({
        resolveOwner: () => ({ state: 'ok', context: owner }),
        probeCapabilities: () => caps(false, false), // no systemd: file-only removal
      })(h.ctx);
      expect(code).toBe(0);
      expect(unitFileExistsOnDisk(installPath)).toBe(false);
      expect(h.out()).toContain('removed the user service');
      expect(h.out()).toContain('could not be disabled here');
    } finally {
      await dir.remove();
    }
  });
});
