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
 * and the manual-steps fallbacks.
 *
 * Every branch is driven through the injected seams — the container and CI
 * images ship no systemd and no sudo, so the `user-unit` and `system-unit`
 * routes cannot occur there for real (the branch that does occur, the
 * systemd-less manual route, is additionally pinned end-to-end through the
 * real launcher — piped, `--yes`, and under a real PTY — by
 * `test/integration/cli-init-service.spec.ts`). The done-condition "each
 * branch tested and actionable" is delivered here as: every route's rendered
 * output names the exact commands, each on its own line, copy-pasteable.
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

describe('probeServiceCapabilities — the §5.3 step 1 machine probe', () => {
  it('reports systemd by the run marker and the user manager by the runtime dir', () => {
    const existing = new Set([SYSTEMD_RUN_MARKER_PATH, '/run/user/1001/systemd']);
    const result = probeServiceCapabilities({
      env: { XDG_RUNTIME_DIR: '/run/user/1001' },
      exists: (path) => existing.has(path),
    });
    expect(result).toEqual(caps(true, true));
  });

  it('no run marker means no systemd, whatever the user manager state', () => {
    const result = probeServiceCapabilities({
      env: { XDG_RUNTIME_DIR: '/run/user/1001' },
      exists: (path) => path === '/run/user/1001/systemd',
    });
    expect(result).toEqual(caps(false, true));
  });

  it('the user manager needs an own, non-empty runtime dir with a systemd dir', () => {
    const withSystemdDir = (env: Record<string, string>): ServiceCapabilities =>
      probeServiceCapabilities({
        env,
        exists: (path) => path.endsWith('/systemd'),
      });
    // Unset and empty runtime dirs: no session facts to build on.
    expect(withSystemdDir({}).userManager).toBe(false);
    expect(withSystemdDir({ XDG_RUNTIME_DIR: '' }).userManager).toBe(false);
    // An inherited name never counts (the own-property discipline).
    const inherited = Object.create({ XDG_RUNTIME_DIR: '/run/user/1001' }) as Record<
      string,
      string
    >;
    expect(withSystemdDir(inherited).userManager).toBe(false);
    // Set but the runtime dir carries no systemd entry: unreachable manager.
    expect(
      probeServiceCapabilities({
        env: { XDG_RUNTIME_DIR: '/run/user/1001' },
        exists: () => false,
      }),
    ).toEqual(caps(false, false));
  });
});

describe('resolveServiceSetupRoute — the §5.3 step 7 route matrix', () => {
  it('privileges held on systemd: the system-unit route', () => {
    expect(resolveServiceSetupRoute(HELD, caps(true, true)).path).toBe('system-unit');
    expect(resolveServiceSetupRoute(HELD, caps(true, false)).path).toBe('system-unit');
  });

  it('no systemd: the manual route with the systemd-absent reason, privilege aside', () => {
    expect(resolveServiceSetupRoute(REGULAR, caps(false, true))).toEqual({
      path: 'manual',
      reason: 'systemd-absent',
    });
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
    );
    expect(text).toContain('no sudo needed');
    expect(text).toContain('Unit file: /home/alice/.config/systemd/user/quotameter.service');
    expect(text).toContain('systemctl --user enable --now quotameter.service');
    expect(text).toContain('sudo loginctl enable-linger alice');
    // The §5.3 linger sentence explains the logout/reboot consequence.
    expect(text).toContain('logout or reboot');
  });

  it('the completion steps give the exact session commands and the foreground alternative', () => {
    const text = renderUserUnitCompletionSteps(
      'alice',
      '/home/alice/.config/systemd/user/quotameter.service',
      'the systemd user manager is not reachable',
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
    });
    expect(rec.writes()).toEqual([]);
    expect(rec.commands()).toEqual([]);
    expect(rec.out()).toContain('/etc/systemd/system/quotameter.service');
    expect(rec.out()).toContain('User=alice');
    expect(rec.out()).toContain('sudo quotameter service install');
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
});
