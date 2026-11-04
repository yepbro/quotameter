import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliOutput } from '../../src/cli/output';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import {
  INIT_RESTART_SEC_SECONDS,
  probeServiceCapabilities,
  renderHeldManualSetup,
  renderManualRunSteps,
  renderSystemUnitPlan,
  renderUserUnitCompletionSteps,
  renderUserUnitInstalled,
  resolveServiceSetupRoute,
  runServiceSetupStep,
  serviceExecPaths,
  spawnServiceCommand,
  SYSTEMD_RUN_MARKER_PATH,
  unsafeOwnerNameProblem,
  writeUnitFileToDisk,
  type CommandOutcome,
  type ServiceCapabilities,
  type ServiceCommandRunner,
  type ServiceSetupSeams,
  type ServiceUnitWriter,
} from '../../src/cli/service-setup';
import { userUnitInstallPath, validateUserUnit } from '../../src/cli/systemd-user-unit';
import { createTempDir } from '../helpers/isolation';
import type { CliContext } from '../../src/cli/commands';
import { runInitCommand } from '../../src/cli/init';
import type { PromptHandle } from '../../src/cli/prompts';
import type { QuotaProvider } from '../../src/providers/registry';

/**
 * The `init` service-setup branch layer (task 137, spec §5.3 step 7, decision
 * D-106): the §5.3 step 7 route matrix, the no-sudo user-unit installation,
 * and the manual-steps fallbacks — plus, since task 138 (decision D-107),
 * the detected linger guidance rendered on the user-unit outcomes.
 *
 * Every branch is driven through the injected seams — the development
 * container and the systemd-less CI images the test jobs are pinned to
 * (D-160) ship no systemd and no sudo, so the `user-unit` and `system-unit`
 * routes cannot occur there for real (the branch that does occur, the
 * systemd-less manual route, is additionally pinned end-to-end through the
 * real launcher — piped, `--yes`, and under a real PTY — by
 * `test/integration/cli-init-service.spec.ts`). The done-condition "each
 * branch tested and actionable" is delivered here as: every route's rendered
 * output names the exact commands, each on its own line, copy-pasteable.
 * The machine-probe classification itself (absent, present-but-inert, live
 * — D-160's taxonomy) is pinned in the first describe block through a
 * scripted manager-probe seam, so the inert class is testable on machines
 * that have no systemd at all.
 * The linger matrix (on/off/unknown × user-unit outcome) is the task-138
 * done-condition: the exact enable-linger command with the logout/reboot
 * consequence unless linger is detected enabled; the probe itself is pinned
 * separately in `test/unit/cli-service-linger.spec.ts`.
 */

/** Representative owner; a regular account, never root (D-105 guarantees it). */
const OWNER: PasswdEntry = { name: 'alice', uid: 1001, gid: 1001, home: '/home/alice' };

/** A regular-user invocation (the no-sudo side of the matrix). */
const REGULAR: ServiceOwnerContext = { kind: 'regular-user', privileges: 'none', user: OWNER };

/** A `sudo quotameter init` invocation (privileges held in-process). */
const HELD: ServiceOwnerContext = { kind: 'sudo', privileges: 'held', user: OWNER };

/** Capabilities fixed per test; `systemd`/`userManager` are the only inputs. */
function caps(systemd: boolean, userManager: boolean): ServiceCapabilities {
  return { systemd, userManager };
}

describe('probeServiceCapabilities — the §5.3 step 1 machine probe (D-160)', () => {
  /** The outcome of a probe whose manager answered with a healthy state. */
  const ANSWERED: CommandOutcome = { ok: true, detail: '' };

  /**
   * A scripted manager-probe seam: answers the canned outcomes in order and
   * records every command it was asked to run, so the tests pin both the
   * classification and the exact read-only queries (never a mutation).
   */
  function scriptedManager(outcomes: readonly CommandOutcome[]): {
    probeCommand: ServiceCommandRunner;
    commands(): readonly string[][];
  } {
    const commands: string[][] = [];
    return {
      probeCommand: (command) => {
        commands.push([...command]);
        return Promise.resolve(outcomes[commands.length - 1] ?? ANSWERED);
      },
      commands: () => commands,
    };
  }

  /** The filesystem facts of a machine claiming full systemd presence. */
  const FULL_SYSTEMD_PATHS = new Set([SYSTEMD_RUN_MARKER_PATH, '/run/user/1001/systemd']);
  const FULL_SYSTEMD_ENV = { XDG_RUNTIME_DIR: '/run/user/1001' };

  it('no run marker means systemd absent, and no probe command ever spawns', async () => {
    const manager = scriptedManager([]);
    const result = await probeServiceCapabilities({
      env: FULL_SYSTEMD_ENV,
      exists: (path) => path === '/run/user/1001/systemd',
      probeCommand: manager.probeCommand,
    });
    expect(result).toEqual(caps(false, false));
    expect(manager.commands()).toEqual([]);
  });

  it('a marker whose system manager is inert routes to the systemd-absent class', async () => {
    // The machine claims everything — marker, runtime dir, session env — but
    // `systemctl` answers with systemd's own not-booted diagnostic: the
    // D-160 class (chroot, WSL without systemd, a container seeing the
    // host's /run marker) must take the graceful fallbacks, and the user
    // probe never even runs.
    const manager = scriptedManager([
      { ok: false, detail: 'System has not been booted with systemd (PID 1)' },
    ]);
    const result = await probeServiceCapabilities({
      env: FULL_SYSTEMD_ENV,
      exists: (path) => FULL_SYSTEMD_PATHS.has(path),
      probeCommand: manager.probeCommand,
    });
    expect(result).toEqual(caps(false, false));
    expect(manager.commands()).toEqual([['systemctl', 'is-system-running']]);
  });

  it('a dead bus or a missing systemctl binary is inert the same way', async () => {
    const inertAnswers: readonly CommandOutcome[] = [
      // systemd ≤256 wording (the Ubuntu 24.04 image's client).
      { ok: false, detail: 'Failed to connect to bus: No such file or directory' },
      // systemd ≥257 wording (Ubuntu 26.04 / Debian 13 clients) — the
      // review round's live-verified regression: the phrase "connect to
      // bus" is no longer contiguous.
      {
        ok: false,
        detail:
          'Failed to connect to system scope bus via local transport: No such file or directory',
      },
      {
        ok: false,
        detail: 'Failed to connect to user scope bus via local transport: No medium found',
      },
      // Node's spawn-failure message shape: the binary is missing or
      // unrunnable — no manager command could ever run (review round:
      // every errno alike, not just ENOENT).
      { ok: false, detail: 'spawn systemctl ENOENT' },
      { ok: false, detail: 'spawn systemctl EACCES' },
    ];
    for (const inert of inertAnswers) {
      const manager = scriptedManager([inert]);
      const result = await probeServiceCapabilities({
        env: FULL_SYSTEMD_ENV,
        exists: (path) => FULL_SYSTEMD_PATHS.has(path),
        probeCommand: manager.probeCommand,
      });
      expect(result, JSON.stringify(inert)).toEqual(caps(false, false));
    }
  });

  it('a probe that cannot answer within the bound is the not-answering class', async () => {
    // Review round P2: a wedged bus must not hang the CLI and must not be
    // misread as live — the system-scope timeout routes the whole machine
    // to the graceful fallbacks, a timed-out user probe to caps(true,false).
    const never: ServiceCommandRunner = () => new Promise(() => {});
    expect(
      await probeServiceCapabilities({
        env: FULL_SYSTEMD_ENV,
        exists: (path) => FULL_SYSTEMD_PATHS.has(path),
        probeCommand: never,
        probeTimeoutMs: 20,
      }),
    ).toEqual(caps(false, false));
    const answeredThenStuck = scriptedManager([ANSWERED]);
    const stuckUser: ServiceCommandRunner = (command) =>
      command.includes('--user') ? never(command) : answeredThenStuck.probeCommand(command);
    expect(
      await probeServiceCapabilities({
        env: FULL_SYSTEMD_ENV,
        exists: (path) => FULL_SYSTEMD_PATHS.has(path),
        probeCommand: stuckUser,
        probeTimeoutMs: 20,
      }),
    ).toEqual(caps(true, false));
  });

  it('a live-but-degraded system manager is live — exit codes never classify', async () => {
    // `is-system-running` exits 1 with `degraded` on stdout (ignored): a
    // manager answering with a non-success state is still a manager.
    const manager = scriptedManager([{ ok: false, detail: 'exit status 1' }]);
    const result = await probeServiceCapabilities({
      env: {},
      exists: (path) => FULL_SYSTEMD_PATHS.has(path),
      probeCommand: manager.probeCommand,
    });
    expect(result).toEqual(caps(true, false));
  });

  it('a live system with a reachable user manager answers caps(true, true)', async () => {
    const manager = scriptedManager([ANSWERED, ANSWERED]);
    const result = await probeServiceCapabilities({
      env: FULL_SYSTEMD_ENV,
      exists: (path) => FULL_SYSTEMD_PATHS.has(path),
      probeCommand: manager.probeCommand,
    });
    expect(result).toEqual(caps(true, true));
    expect(manager.commands()).toEqual([
      ['systemctl', 'is-system-running'],
      ['systemctl', '--user', 'is-active', 'default.target'],
    ]);
  });

  it('a non-success user-probe state still proves the manager answered', async () => {
    // `is-active` exits 3 for an inactive target with empty stderr — the
    // review round's arm: exit codes never classify, so caps(true, true).
    const manager = scriptedManager([ANSWERED, { ok: false, detail: 'exit status 3' }]);
    const result = await probeServiceCapabilities({
      env: FULL_SYSTEMD_ENV,
      exists: (path) => FULL_SYSTEMD_PATHS.has(path),
      probeCommand: manager.probeCommand,
    });
    expect(result).toEqual(caps(true, true));
  });

  it('the user manager needs an own, non-empty runtime dir with a systemd dir', async () => {
    const liveSystem = scriptedManager([ANSWERED]);
    const withRuntimeDir = (env: Record<string, string>): Promise<ServiceCapabilities> =>
      probeServiceCapabilities({
        env,
        exists: (path) => path === SYSTEMD_RUN_MARKER_PATH || path.endsWith('/systemd'),
        probeCommand: liveSystem.probeCommand,
      });
    // Unset and empty runtime dirs: no session facts to build on, and the
    // user probe never runs — every recorded command is the system probe.
    expect(await withRuntimeDir({})).toEqual(caps(true, false));
    expect(await withRuntimeDir({ XDG_RUNTIME_DIR: '' })).toEqual(caps(true, false));
    // An inherited name never counts (the own-property discipline).
    const inherited = Object.create({ XDG_RUNTIME_DIR: '/run/user/1001' }) as Record<
      string,
      string
    >;
    expect(await withRuntimeDir(inherited)).toEqual(caps(true, false));
    expect(liveSystem.commands()).toEqual([
      ['systemctl', 'is-system-running'],
      ['systemctl', 'is-system-running'],
      ['systemctl', 'is-system-running'],
    ]);
    // Set but the runtime dir carries no systemd entry: unreachable manager.
    const noSystemdDir = scriptedManager([ANSWERED]);
    expect(
      await probeServiceCapabilities({
        env: FULL_SYSTEMD_ENV,
        exists: (path) => path === SYSTEMD_RUN_MARKER_PATH,
        probeCommand: noSystemdDir.probeCommand,
      }),
    ).toEqual(caps(true, false));
    expect(noSystemdDir.commands()).toEqual([['systemctl', 'is-system-running']]);
  });

  it('a live system with an inert user bus reports the user manager unreachable', async () => {
    // The runtime-dir facts exist, but the session bus is dead (stale
    // XDG_RUNTIME_DIR, cron leftovers): caps(true, false), never a
    // user-unit route that would fail with raw bus errors.
    const manager = scriptedManager([
      ANSWERED,
      { ok: false, detail: 'Failed to connect to bus: No medium found' },
    ]);
    const result = await probeServiceCapabilities({
      env: FULL_SYSTEMD_ENV,
      exists: (path) => FULL_SYSTEMD_PATHS.has(path),
      probeCommand: manager.probeCommand,
    });
    expect(result).toEqual(caps(true, false));
    expect(manager.commands()).toHaveLength(2);
  });
});

describe('resolveServiceSetupRoute — the §5.3 step 7 route matrix', () => {
  it('privileges held on systemd: the system-unit route', () => {
    expect(resolveServiceSetupRoute(HELD, caps(true, true)).path).toBe('system-unit');
    expect(resolveServiceSetupRoute(HELD, caps(true, false)).path).toBe('system-unit');
  });

  it('no systemd: the manual route with the systemd-absent reason, privilege aside', () => {
    // `caps(false, false)` is the only systemd-absent shape the D-160 probe
    // produces (userManager implies systemd), for the absent and the inert
    // class alike — both route to the same graceful fallback.
    expect(resolveServiceSetupRoute(REGULAR, caps(false, false))).toEqual({
      path: 'manual',
      reason: 'systemd-absent',
    });
    expect(resolveServiceSetupRoute(HELD, caps(false, false))).toEqual({
      path: 'manual',
      reason: 'systemd-absent',
    });
  });

  it('no sudo with systemd and a reachable user manager: the user-unit route', () => {
    expect(resolveServiceSetupRoute(REGULAR, caps(true, true))).toEqual({ path: 'user-unit' });
  });

  it('no sudo with systemd but no reachable user manager: manual completion steps', () => {
    expect(resolveServiceSetupRoute(REGULAR, caps(true, false))).toEqual({
      path: 'manual',
      reason: 'user-manager-unavailable',
    });
  });
});

describe('renderers — every branch names exact, own-line commands', () => {
  it('the system-unit plan names the target, the owner, the verification, and the command', () => {
    const text = renderSystemUnitPlan('alice');
    expect(text).toContain('the system service can be installed for alice');
    expect(text).toContain('/etc/systemd/system/quotameter.service');
    expect(text).toContain('User=alice');
    expect(text).toContain('systemctl is-active');
    expect(text).toContain('/api/health');
    expect(text).toContain('\n  sudo quotameter service install');
  });

  it('the installed-user-unit output names the file, the enable command, and linger', () => {
    const text = renderUserUnitInstalled(
      'alice',
      '/home/alice/.config/systemd/user/quotameter.service',
      'disabled',
    );
    expect(text).toContain('no sudo needed');
    expect(text).toContain('Unit file: /home/alice/.config/systemd/user/quotameter.service');
    expect(text).toContain('systemctl --user enable --now quotameter.service');
    expect(text).toContain('sudo loginctl enable-linger alice');
    // The §5.3 linger sentence explains the logout/reboot consequence.
    expect(text).toContain('logout or reboot');
  });

  it('the linger guidance follows the detected state on both user-unit renderers (task 138)', () => {
    // Installed outcome: enabled confirms with no command; unknown still
    // prints the exact command, honestly led — never silently treated as on.
    const installedEnabled = renderUserUnitInstalled('alice', '/unit/path', 'enabled');
    expect(installedEnabled).toContain('Linger is already enabled for alice');
    expect(installedEnabled).not.toContain('loginctl');
    const installedUnknown = renderUserUnitInstalled('alice', '/unit/path', 'unknown');
    expect(installedUnknown).toContain('could not be determined');
    expect(installedUnknown).toContain('\n  sudo loginctl enable-linger alice');
    // The completion steps carry the same state-driven guidance.
    const completionEnabled = renderUserUnitCompletionSteps(
      'alice',
      '/unit/path',
      'the lead',
      'enabled',
    );
    expect(completionEnabled).toContain('Linger is already enabled for alice');
    expect(completionEnabled).not.toContain('loginctl');
    const completionUnknown = renderUserUnitCompletionSteps(
      'alice',
      '/unit/path',
      'the lead',
      'unknown',
    );
    expect(completionUnknown).toContain('could not be determined');
    expect(completionUnknown).toContain('\n  sudo loginctl enable-linger alice\n');
  });

  it('the completion steps give the exact session commands and the foreground alternative', () => {
    const text = renderUserUnitCompletionSteps(
      'alice',
      '/home/alice/.config/systemd/user/quotameter.service',
      'the systemd user manager is not reachable',
      'disabled',
    );
    expect(text).toContain('\n  systemctl --user daemon-reload\n');
    expect(text).toContain('\n  systemctl --user enable --now quotameter.service\n');
    expect(text).toContain('\n  sudo loginctl enable-linger alice\n');
    expect(text).toContain('\n  quotameter run');
  });

  it('the manual-run steps name the exact foreground command, led by the real reason', () => {
    const text = renderManualRunSteps(
      'systemd is not available on this machine, so the service cannot be installed here',
    );
    expect(text).toContain(
      'Service setup: systemd is not available on this machine, so the service cannot be installed here',
    );
    expect(text).toContain('\n  quotameter run\n');
    expect(text).toContain('foreground');
  });

  it('the privileged systemd-less fallback directs to the owner account, never to a root run', () => {
    const text = renderHeldManualSetup('alice');
    // Honest about the root-owned configuration and §5.1's never-root.
    expect(text).toContain('not readable by a regular account');
    expect(text).toContain('must never run as root');
    expect(text).toContain("Initialize and run from alice's regular account instead:");
    // Two exact, own-line commands — the owner's own initialization places
    // the configuration where the owner's service reads it.
    expect(text).toContain('\n  quotameter init\n');
    expect(text).toContain('\n  quotameter run');
    expect(text).not.toContain('sudo -u');
  });
});

describe('unsafeOwnerNameProblem — the interpolation guard (review round)', () => {
  it('accepts plain POSIX account names', () => {
    expect(unsafeOwnerNameProblem('alice')).toBeNull();
    expect(unsafeOwnerNameProblem('a-b_c1')).toBeNull();
    expect(unsafeOwnerNameProblem('A_')).toBeNull();
  });

  it('refuses names that could break or inject into copy-paste commands', () => {
    for (const name of ['alice;rm -rf /', 'bad name', '-option', '123', '', 'name$k', 'a\tb']) {
      expect(unsafeOwnerNameProblem(name), name).not.toBeNull();
    }
    // The message quotes the offending name safely instead of pasting it raw.
    expect(unsafeOwnerNameProblem('alice;rm -rf /')).toContain('"alice;rm -rf /"');
    expect(unsafeOwnerNameProblem('alice;rm -rf /')).toContain('no commands are printed');
  });
});

/**
 * A seam recorder: output lines, executed commands, and written unit files.
 * `failAt` marks the first command (by joined argv) that fails.
 */
function recorder(failAt?: string): {
  output: CliOutput;
  out(): string;
  err(): string;
  commands(): readonly string[][];
  writes(): readonly { installPath: string; content: string }[];
  runCommand: ServiceCommandRunner;
  writeUnitFile: ServiceUnitWriter;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const commands: string[][] = [];
  const writes: Array<{ installPath: string; content: string }> = [];
  return {
    output: {
      out: (text: string) => void outLines.push(text),
      err: (text: string) => void errLines.push(text),
    },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
    commands: () => commands,
    writes: () => writes,
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
    },
  };
}

/** Seams fixed to a runnable environment: deterministic absolute paths. */
const EXEC_PATHS: ServiceSetupSeams = {
  execPaths: () => ({
    nodePath: '/usr/bin/node',
    cliPath: '/usr/local/lib/node_modules/quotameter/bin/quotameter.mjs',
  }),
};

const ENABLE_COMMAND = 'systemctl --user enable --now quotameter.service';

describe('runServiceSetupStep — the no-sudo user-unit installation', () => {
  it('writes the D-104 unit under the owner home and enables it without sudo', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    const installPath = userUnitInstallPath('/home/alice');
    expect(rec.writes()).toHaveLength(1);
    expect(rec.writes()[0]?.installPath).toBe(installPath);
    // The written content is exactly the task-135 generator's output, with
    // init's restart seconds and the pinned absolute paths.
    const written = rec.writes()[0];
    expect(written?.content).toContain(
      'ExecStart=/usr/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run',
    );
    expect(written?.content).toContain(`RestartSec=${INIT_RESTART_SEC_SECONDS}s`);
    expect(validateUserUnit(written?.content ?? '')).toEqual([]);
    expect(rec.commands()).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'quotameter.service'],
    ]);
    expect(rec.out()).toContain('installed the user service for alice');
    expect(rec.out()).toContain(`Unit file: ${installPath}`);
    expect(rec.err()).toBe('');
  });

  it('a failing daemon-reload falls back to the exact completion steps', async () => {
    const rec = recorder('systemctl --user daemon-reload');
    await runServiceSetupStep(rec.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
      errorPrefix: 'quotameter test',
    });
    expect(rec.err()).toContain(
      'quotameter test: the user service could not be enabled automatically — ' +
        '`systemctl --user daemon-reload` failed (mock systemctl failure)',
    );
    // The file is on disk; the steps are the session commands, not a re-run.
    expect(rec.writes()).toHaveLength(1);
    expect(rec.commands()).toEqual([['systemctl', '--user', 'daemon-reload']]);
    expect(rec.out()).toContain('\n  systemctl --user daemon-reload\n');
    expect(rec.out()).toContain(`\n  ${ENABLE_COMMAND}\n`);
    expect(rec.out()).toContain('\n  quotameter run');
  });

  it('a failing enable falls back to the same completion steps', async () => {
    const rec = recorder(ENABLE_COMMAND);
    await runServiceSetupStep(rec.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    expect(rec.err()).toContain(`\`${ENABLE_COMMAND}\` failed`);
    expect(rec.writes()).toHaveLength(1);
    expect(rec.commands()).toHaveLength(2);
    expect(rec.out()).toContain('could not be enabled automatically');
    expect(rec.out()).toContain(`\n  ${ENABLE_COMMAND}\n`);
  });

  it('a failing unit write runs no commands and falls back to foreground steps', async () => {
    const rec = recorder();
    const seams: ServiceSetupSeams = {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: async () => {
        throw new Error('EACCES: permission denied');
      },
    };
    await runServiceSetupStep(rec.output, REGULAR, caps(true, true), seams);
    expect(rec.commands()).toEqual([]);
    expect(rec.err()).toContain(
      'quotameter init: installing the user unit failed — falling back to manual-run instructions (EACCES: permission denied)',
    );
    expect(rec.out()).toContain('\n  quotameter run\n');
    expect(rec.out()).not.toContain('systemctl --user');
    // The fallback lead states the real reason — not a false claim that
    // systemd is unavailable (review-round P2).
    expect(rec.out()).toContain('the user unit could not be installed on this machine');
    expect(rec.out()).not.toContain('systemd is not available');
  });

  it('an invalid owner home is a fallback, not a crash out of the step (review round)', async () => {
    // parsePasswdFile accepts an empty home; userUnitInstallPath refuses it.
    // The preparation must not escape the step's failure domain.
    const brokenHome: ServiceOwnerContext = {
      kind: 'regular-user',
      privileges: 'none',
      user: { ...OWNER, home: '' },
    };
    const rec = recorder();
    await runServiceSetupStep(rec.output, brokenHome, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    expect(rec.commands()).toEqual([]);
    expect(rec.writes()).toEqual([]);
    expect(rec.err()).toContain('installing the user unit failed');
    expect(rec.out()).toContain('\n  quotameter run\n');
  });

  it('an unsafe owner name is refused before anything renders or runs', async () => {
    const hostile: ServiceOwnerContext = {
      kind: 'regular-user',
      privileges: 'none',
      user: { ...OWNER, name: 'alice;systemctl poweroff' },
    };
    const rec = recorder();
    await runServiceSetupStep(rec.output, hostile, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(rec.out()).toBe('');
    expect(rec.err()).toContain('quotameter init: the service owner');
    expect(rec.err()).toContain('no commands are printed');
    // The raw name never reaches command text.
    expect(rec.err() + rec.out()).not.toContain('  alice;systemctl poweroff');
  });

  it('failure diagnostics stay honest for detail-free commands and non-Error throws', async () => {
    // A command failure with no stderr detail still names the command.
    const silent = recorder();
    const silentFail: ServiceCommandRunner = async (command) => {
      void command;
      return { ok: false, detail: '' };
    };
    await runServiceSetupStep(silent.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: silentFail,
      writeUnitFile: silent.writeUnitFile,
    });
    expect(silent.err()).toContain(
      'quotameter init: the user service could not be enabled automatically — ' +
        '`systemctl --user daemon-reload` failed',
    );
    expect(silent.err()).not.toContain('failed ()');
    // A thrown non-Error value stringifies instead of crashing the step.
    const strange = recorder();
    const strangeSeams: ServiceSetupSeams = {
      ...EXEC_PATHS,
      runCommand: strange.runCommand,
      writeUnitFile: async () => {
        throw 'disk on fire';
      },
    };
    await runServiceSetupStep(strange.output, REGULAR, caps(true, true), strangeSeams);
    expect(strange.err()).toContain('installing the user unit failed');
    expect(strange.err()).toContain('(disk on fire)');
  });

  it('the production exec-path default feeds the generator when no seam is injected', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, REGULAR, caps(true, true), {
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    // The written unit must still be the valid D-104 content — built from
    // the running node and the resolved argv[1], whatever they are here.
    const written = rec.writes()[0];
    expect(validateUserUnit(written?.content ?? '')).toEqual([]);
    expect(written?.content).toContain(`RestartSec=${INIT_RESTART_SEC_SECONDS}s`);
  });

  it('an unreachable user manager writes the unit and prints the session commands', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, REGULAR, caps(true, false), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    // The write needs no manager; nothing is enabled.
    expect(rec.writes()).toHaveLength(1);
    expect(rec.commands()).toEqual([]);
    expect(rec.out()).toContain('user manager is not reachable');
    expect(rec.out()).toContain(
      `The unit file is written to ${userUnitInstallPath('/home/alice')}`,
    );
    expect(rec.out()).toContain('\n  systemctl --user daemon-reload\n');
    expect(rec.out()).toContain(`\n  ${ENABLE_COMMAND}\n`);
    expect(rec.out()).toContain('\n  sudo loginctl enable-linger alice\n');
    expect(rec.err()).toBe('');
  });
});

describe('runServiceSetupStep — the detected linger guidance (task 138, D-107)', () => {
  it('the installed outcome renders per the probed state: enabled confirms, unknown commands', async () => {
    const enabled = recorder();
    await runServiceSetupStep(enabled.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: enabled.runCommand,
      writeUnitFile: enabled.writeUnitFile,
      probeLinger: () => 'enabled',
    });
    expect(enabled.out()).toContain('Linger is already enabled for alice');
    expect(enabled.out()).toContain('keeps running after logout and reboot');
    expect(enabled.out()).not.toContain('sudo loginctl enable-linger');
    // The install itself is untouched by the linger state.
    expect(enabled.commands()).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'quotameter.service'],
    ]);
    expect(enabled.err()).toBe('');

    // Unknown is never silently treated as enabled: the exact command
    // prints, led by the could-not-determine sentence.
    const unknown = recorder();
    await runServiceSetupStep(unknown.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: unknown.runCommand,
      writeUnitFile: unknown.writeUnitFile,
      probeLinger: () => 'unknown',
    });
    expect(unknown.out()).toContain('could not be determined');
    expect(unknown.out()).toContain('User services stop when their owner logs out');
    expect(unknown.out()).toContain('\n  sudo loginctl enable-linger alice');
  });

  it('the default probe renders disabled on the systemd-less container', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    // No seam injected: the production probe stats the flag file, gets
    // ENOENT (no /var/lib/systemd/linger exists here), and the guidance
    // prints the exact command with the logout/reboot consequence.
    expect(rec.out()).toContain('User services stop when their owner logs out');
    expect(rec.out()).toContain('\n  sudo loginctl enable-linger alice');
  });

  it('the completion-steps fallbacks render per the probed state too', async () => {
    const unreachable = recorder();
    await runServiceSetupStep(unreachable.output, REGULAR, caps(true, false), {
      ...EXEC_PATHS,
      runCommand: unreachable.runCommand,
      writeUnitFile: unreachable.writeUnitFile,
      probeLinger: () => 'enabled',
    });
    expect(unreachable.out()).toContain('Linger is already enabled for alice');
    expect(unreachable.out()).not.toContain('sudo loginctl enable-linger');

    const failedEnable = recorder(ENABLE_COMMAND);
    await runServiceSetupStep(failedEnable.output, REGULAR, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: failedEnable.runCommand,
      writeUnitFile: failedEnable.writeUnitFile,
      probeLinger: () => 'unknown',
    });
    expect(failedEnable.out()).toContain('could not be determined');
    expect(failedEnable.out()).toContain('\n  sudo loginctl enable-linger alice\n');
  });

  it('no linger guidance where no user service exists — and the probe never runs there', async () => {
    // A throwing probe makes a would-be call fail the test loudly.
    const absent = recorder();
    await runServiceSetupStep(absent.output, REGULAR, caps(false, false), {
      ...EXEC_PATHS,
      runCommand: absent.runCommand,
      writeUnitFile: absent.writeUnitFile,
      probeLinger: () => {
        throw new Error('the linger probe must not run on the systemd-absent route');
      },
    });
    expect(absent.out()).toContain('\n  quotameter run\n');
    expect(absent.out()).not.toContain('loginctl');

    const failedWrite = recorder();
    const seams: ServiceSetupSeams = {
      ...EXEC_PATHS,
      runCommand: failedWrite.runCommand,
      writeUnitFile: async () => {
        throw new Error('EACCES: permission denied');
      },
      probeLinger: () => {
        throw new Error('the linger probe must not run when the unit was not written');
      },
    };
    await runServiceSetupStep(failedWrite.output, REGULAR, caps(true, true), seams);
    expect(failedWrite.out()).toContain('\n  quotameter run\n');
    expect(failedWrite.out()).not.toContain('loginctl');
  });
});

describe('runServiceSetupStep — the manual and system-unit branches', () => {
  it('no systemd, no sudo: manual-run steps only, zero side effects', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, REGULAR, caps(false, false), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(rec.out()).toContain('systemd is not available on this machine');
    expect(rec.out()).toContain('\n  quotameter run\n');
    expect(rec.err()).toBe('');
  });

  it('no systemd, privileges held: the owner re-initializes and runs — never a root run (review round)', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, HELD, caps(false, false), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
    });
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(rec.out()).toContain('not readable by a regular account');
    expect(rec.out()).toContain('\n  quotameter init\n');
    expect(rec.out()).toContain('\n  quotameter run');
    // The old `sudo -u <owner> quotameter run` shape would have pointed at
    // a root-owned 0600 configuration the owner cannot read.
    expect(rec.out()).not.toContain('sudo -u');
  });

  it('privileges held on systemd: the plan renders and nothing executes (139 owns the machinery)', async () => {
    const rec = recorder();
    await runServiceSetupStep(rec.output, HELD, caps(true, true), {
      ...EXEC_PATHS,
      runCommand: rec.runCommand,
      writeUnitFile: rec.writeUnitFile,
      probeLinger: () => {
        throw new Error('the linger probe must not run on the system-unit route');
      },
    });
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(rec.out()).toContain('/etc/systemd/system/quotameter.service');
    expect(rec.out()).toContain('User=alice');
    expect(rec.out()).toContain('sudo quotameter service install');
    // System units do not linger — no enable-linger guidance on this route.
    expect(rec.out()).not.toContain('loginctl');
    expect(rec.err()).toBe('');
  });
});

describe('production seams', () => {
  it('writeUnitFileToDisk creates the unit directory and writes idempotently', async () => {
    const dir = await createTempDir('qm-service-setup-');
    try {
      const installPath = join(dir.path, 'home/.config/systemd/user/quotameter.service');
      await writeUnitFileToDisk(installPath, '[Unit]\n');
      expect(await readFile(installPath, 'utf8')).toBe('[Unit]\n');
      const mode = (await stat(installPath)).mode & 0o777;
      expect(mode & 0o111).toBe(0); // never executable
      await writeUnitFileToDisk(installPath, '[Service]\n');
      expect(await readFile(installPath, 'utf8')).toBe('[Service]\n');
    } finally {
      await dir.remove();
    }
  });

  it('spawnServiceCommand resolves ok, exit statuses, stderr detail, and spawn errors', async () => {
    const node = process.execPath;
    expect(await spawnServiceCommand([node, '-e', ''])).toEqual({ ok: true, detail: '' });
    expect(await spawnServiceCommand([node, '-e', 'process.exit(3)'])).toEqual({
      ok: false,
      detail: 'exit status 3',
    });
    const noisy = await spawnServiceCommand([
      node,
      '-e',
      "process.stderr.write(' \\nfirst line\\nsecond line\\n'); process.exit(1)",
    ]);
    expect(noisy).toEqual({ ok: false, detail: 'first line' });
    const terminated = await spawnServiceCommand([
      node,
      '-e',
      'process.kill(process.pid, "SIGKILL")',
    ]);
    expect(terminated).toEqual({ ok: false, detail: 'the command was terminated' });
    const missing = await spawnServiceCommand([join(tmpdir(), 'quotameter-missing-binary')]);
    expect(missing.ok).toBe(false);
    expect(missing.detail).not.toBe('');
  });

  it('spawnServiceCommand caps the stderr detail at one bounded line', async () => {
    const long = 'x'.repeat(300);
    const outcome = await spawnServiceCommand([
      process.execPath,
      '-e',
      `process.stderr.write(${JSON.stringify(long)} + "\\n"); process.exit(1)`,
    ]);
    expect(outcome.detail).toHaveLength(200);
  });

  it('spawnServiceCommand bounds the stderr buffer while streaming (review round)', async () => {
    // A child streaming far past the capture cap (flood generated inside
    // the child, not through argv): the outcome stays one bounded line and
    // the command still resolves normally.
    const outcome = await spawnServiceCommand([
      process.execPath,
      '-e',
      "for (let i = 0; i < 512; i++) process.stderr.write('y'.repeat(512) + '\\n'); process.exit(1)",
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toHaveLength(200);
    expect(outcome.detail).toMatch(/^y+$/);
  });

  it('serviceExecPaths pins the running node and an absolute CLI entry', () => {
    const paths = serviceExecPaths();
    expect(paths.nodePath).toBe(process.execPath);
    expect(isAbsolute(paths.cliPath)).toBe(true);
  });
});

describe('runInitCommand wiring — §5.3 step 1 fail-fast, step 7 output', () => {
  /** A provider whose connection test always accepts (never contacted here). */
  const provider: QuotaProvider = {
    id: 'zai-coding-plan',
    name: 'Fake Z.ai Coding Plan',
    async validateCredentials(): Promise<void> {},
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not part of the service-setup tests');
    },
  };

  function context(flags: Record<string, boolean | string> = {}): {
    ctx: CliContext;
    out(): string;
    err(): string;
  } {
    const outText: string[] = [];
    const errText: string[] = [];
    return {
      ctx: {
        output: {
          out: (text: string) => void outText.push(`${text}\n`),
          err: (text: string) => void errText.push(`${text}\n`),
        },
        version: 'test',
        commandPath: ['init'],
        flags,
        positionals: [],
      },
      out: () => outText.join(''),
      err: () => errText.join(''),
    };
  }

  /** A prompter answering everything from a script; null = input closed. */
  function prompterWith(answers: readonly string[]): PromptHandle {
    const remaining = [...answers];
    const step = (): Promise<string | null> => {
      const value = remaining.shift();
      return Promise.resolve(value === undefined ? null : value);
    };
    return { ask: step, askSecret: step, close: () => undefined, interrupted: () => false };
  }

  it('owner problems abort before any detection, questions, or writes', async () => {
    const h = context();
    let prompterBuilt = false;
    const code = await runInitCommand({
      resolveOwner: () => ({
        state: 'problems',
        problems: [
          'the process is running as root without SUDO_USER — the service owner cannot be determined; run "sudo quotameter init" from your regular account',
          'a second problem line',
        ],
      }),
      createPrompter: () => {
        prompterBuilt = true;
        return prompterWith([]);
      },
      readExisting: async () => {
        throw new Error('readExisting must not run after owner problems');
      },
      persistConfig: async () => {
        throw new Error('persistConfig must not run after owner problems');
      },
      provider,
      env: {},
    })(h.ctx);
    expect(code).toBe(1);
    expect(prompterBuilt).toBe(false);
    // Every problem verbatim, one prefixed stderr line each (D-105).
    expect(h.err()).toContain(
      'quotameter init: the process is running as root without SUDO_USER — the service owner cannot be determined; run "sudo quotameter init" from your regular account\n',
    );
    expect(h.err()).toContain('quotameter init: a second problem line\n');
    expect(h.out()).toBe('');
  });

  it('owner problems abort the --yes flow the same way', async () => {
    const h = context({ yes: true, timezone: 'UTC' });
    const code = await runInitCommand({
      resolveOwner: () => ({ state: 'problems', problems: ['SUDO_USER is set but empty'] }),
      readExisting: async () => {
        throw new Error('readExisting must not run after owner problems');
      },
      provider,
      env: {},
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('quotameter init: SUDO_USER is set but empty\n');
  });

  it('a broken owner home falls back inside the handler with exit 0 (review round)', async () => {
    const h = context();
    const rec = recorder();
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['UTC', '', '', '', '', '']),
      readExisting: async () => ({ state: 'none' }),
      persistConfig: async () => {},
      provider,
      env: {},
      resolveOwner: () => ({
        state: 'ok',
        context: { kind: 'regular-user', privileges: 'none', user: { ...OWNER, home: '' } },
      }),
      probeCapabilities: () => caps(true, true),
      runServiceCommand: rec.runCommand,
      writeServiceUnitFile: rec.writeUnitFile,
      serviceExecPaths: EXEC_PATHS.execPaths,
    })(h.ctx);
    // The configuration is written; the failed unit preparation is a
    // rendered fallback, never a crash out of the handler (D-106).
    expect(code).toBe(0);
    expect(rec.commands()).toEqual([]);
    expect(h.err()).toContain('installing the user unit failed');
    expect(h.out()).toContain('\n  quotameter run\n');
  });

  it('a fresh run performs the routed step after the write, once', async () => {
    const h = context();
    const rec = recorder();
    const writes: unknown[] = [];
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['UTC', '', '', '', '', '']),
      readExisting: async () => ({ state: 'none' }),
      persistConfig: async (options) => {
        writes.push(options);
      },
      provider,
      env: {},
      resolveOwner: () => ({ state: 'ok', context: REGULAR }),
      probeCapabilities: () => caps(true, true),
      runServiceCommand: rec.runCommand,
      writeServiceUnitFile: rec.writeUnitFile,
      serviceExecPaths: EXEC_PATHS.execPaths,
    })(h.ctx);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(rec.writes()).toHaveLength(1);
    expect(rec.commands()).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'quotameter.service'],
    ]);
    // The step's output lands after the write trailer.
    const out = h.out();
    expect(out.indexOf('Configuration written to')).toBeGreaterThanOrEqual(0);
    expect(out).toContain('installed the user service for alice');
    expect(out.indexOf('Configuration written to')).toBeLessThan(
      out.indexOf('installed the user service'),
    );
  });

  it('a fresh run renders the detected linger guidance through the init seam', async () => {
    const h = context();
    const rec = recorder();
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['UTC', '', '', '', '', '']),
      readExisting: async () => ({ state: 'none' }),
      persistConfig: async () => {},
      provider,
      env: {},
      resolveOwner: () => ({ state: 'ok', context: REGULAR }),
      probeCapabilities: () => caps(true, true),
      runServiceCommand: rec.runCommand,
      writeServiceUnitFile: rec.writeUnitFile,
      serviceExecPaths: EXEC_PATHS.execPaths,
      probeUserLinger: () => 'enabled',
    })(h.ctx);
    expect(code).toBe(0);
    expect(rec.writes()).toHaveLength(1);
    // The injected state reaches the rendered step: confirmation, no command.
    expect(h.out()).toContain('Linger is already enabled for alice');
    expect(h.out()).not.toContain('sudo loginctl enable-linger');
  });
});
