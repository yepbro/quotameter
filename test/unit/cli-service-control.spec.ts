import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import {
  renderCommandFailedSteps,
  renderControlledSystemUnit,
  renderControlledUserUnit,
  renderManagerlessSteps,
  renderNotInstalledGuidance,
  renderSystemUnitPrivilegesSteps,
  renderUserUnitFromRegularAccountSteps,
  renderUserUnitSessionSteps,
  runServiceControlCommand,
  type ServiceControlDeps,
  type ServiceControlVerb,
} from '../../src/cli/service-control';
import type { CommandOutcome, ServiceCommandRunner } from '../../src/cli/service-setup';
import { writeUnitFileToDisk } from '../../src/cli/service-setup';
import { SYSTEM_UNIT_INSTALL_PATH } from '../../src/cli/systemd-unit';
import { userUnitInstallPath } from '../../src/cli/systemd-user-unit';
import { createTempDir } from '../helpers/isolation';

/**
 * The `quotameter start` / `stop` / `restart` command handlers (task 140,
 * spec §5.2, decision D-110) — the done-condition's matrix: the manager
 * scope follows the installed unit (system file → `systemctl`, user file →
 * `systemctl --user`), privileges only decide whether this invocation may
 * execute the verb itself, and every unavailable branch renders §5.2's
 * helpful next step.
 *
 * Every branch is seam-driven like tasks 137/139's suites: the container
 * and CI images ship no systemd and no sudo, so the installed-unit
 * discovery and the manager commands are driven through the injected
 * seams. The one route the container does produce — nothing installed — is
 * additionally pinned through the real launcher in
 * `test/integration/cli-service-control.spec.ts`.
 */

/** Representative owner; a regular account, never root (D-105 guarantees it). */
const OWNER: PasswdEntry = { name: 'alice', uid: 1001, gid: 1001, home: '/home/alice' };

/** A regular-user invocation (the unprivileged side of the matrix). */
const REGULAR: ServiceOwnerContext = { kind: 'regular-user', privileges: 'none', user: OWNER };

/** A `sudo quotameter …` invocation (privileges held in-process). */
const HELD: ServiceOwnerContext = { kind: 'sudo', privileges: 'held', user: OWNER };

/** The user unit's install path under the representative owner home. */
const USER_UNIT_PATH = userUnitInstallPath('/home/alice');

/** Capabilities fixed per test; `systemd`/`userManager` are the only inputs. */
function caps(systemd: boolean, userManager: boolean) {
  return { systemd, userManager };
}

/**
 * The harness: a disk seeded with installed unit paths, a command runner
 * that records and can fail one command, and the captured CliContext.
 */
function harness(options?: {
  readonly owner?: ServiceOwnerContext;
  readonly ownerProblems?: readonly string[];
  readonly ownerThrows?: Error;
  readonly capabilities?: { readonly systemd: boolean; readonly userManager: boolean };
  readonly disk?: readonly string[];
  readonly failAt?: string;
}): {
  readonly ctx: CliContext;
  out(): string;
  err(): string;
  commands(): readonly string[][];
  readonly deps: ServiceControlDeps;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const commands: string[][] = [];
  const files = new Set(options?.disk ?? []);
  const runCommand: ServiceCommandRunner = async (command) => {
    commands.push([...command]);
    const failed = options?.failAt !== undefined && command.join(' ') === options.failAt;
    const outcome: CommandOutcome = failed
      ? { ok: false, detail: 'mock systemctl failure' }
      : { ok: true, detail: '' };
    return outcome;
  };
  const deps: ServiceControlDeps = {
    resolveOwner: () => {
      if (options?.ownerThrows !== undefined) throw options.ownerThrows;
      if (options?.ownerProblems !== undefined) {
        return { state: 'problems', problems: options.ownerProblems };
      }
      return { state: 'ok', context: options?.owner ?? REGULAR };
    },
    probeCapabilities: () => options?.capabilities ?? caps(true, true),
    runCommand,
    unitFileExists: (installPath) => files.has(installPath),
  };
  return {
    ctx: {
      output: {
        out: (text: string) => void outLines.push(`${text}\n`),
        err: (text: string) => void errLines.push(`${text}\n`),
      },
      version: 'test',
      commandPath: ['start'],
      flags: {},
      positionals: [],
    },
    out: () => outLines.join(''),
    err: () => errLines.join(''),
    commands: () => commands,
    deps,
  };
}

/** Runs one verb against a harness; the command path carries the verb. */
async function control(
  verb: ServiceControlVerb,
  h: ReturnType<typeof harness>,
): Promise<{ code: number; out: string; err: string; commands: readonly string[][] }> {
  const ctx: CliContext = { ...h.ctx, commandPath: [verb] };
  const code = await runServiceControlCommand(verb, h.deps)(ctx);
  return { code, out: h.out(), err: h.err(), commands: h.commands() };
}

describe('owner resolution gate (D-105)', () => {
  it('renders every owner problem as its own prefixed stderr line and exits 1', async () => {
    const h = harness({ ownerProblems: ['problem one', 'problem two'] });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter start: problem one\nquotameter start: problem two\n');
    expect(result.out).toBe('');
    expect(result.commands).toEqual([]);
  });

  it('renders a broken user-database throw as the standard failure line (never throws)', async () => {
    const h = harness({ ownerThrows: new Error('EACCES: /etc/passwd') });
    const result = await control('restart', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter restart: resolving the service owner failed (EACCES: /etc/passwd)\n',
    );
    expect(result.out).toBe('');
    expect(result.commands).toEqual([]);
  });
});

describe('not installed (§5.2 helpful next step)', () => {
  it('names the install command for both install modes, for every verb', async () => {
    for (const verb of ['start', 'stop', 'restart'] as const) {
      const h = harness({ owner: REGULAR, disk: [] });
      const result = await control(verb, h);
      expect(result.code, `exit 1 for ${verb}`).toBe(1);
      expect(result.err).toBe(
        `quotameter ${verb}: no systemd service is installed — nothing to ${verb}\n`,
      );
      expect(result.out).toContain('sudo quotameter service install   (system service)');
      expect(result.out).toContain(
        'quotameter service install        (user service, no sudo needed)',
      );
      expect(result.out).toContain('quotameter init');
      expect(result.out).toContain('quotameter run');
      expect(result.commands).toEqual([]);
    }
  });

  it('pins the exact guidance text', () => {
    expect(renderNotInstalledGuidance('stop')).toBe(
      [
        'Service control: the quotameter service is not installed as a systemd service — there is nothing to stop.',
        'Install it first:',
        '  sudo quotameter service install   (system service)',
        '  quotameter service install        (user service, no sudo needed)',
        'Or set everything up in one step: quotameter init',
        'To run in the foreground without installing: quotameter run',
      ].join('\n'),
    );
  });

  it('an unusable owner home with nothing installed is a failure, not a silent "nothing installed"', async () => {
    const brokenHome: ServiceOwnerContext = {
      kind: 'regular-user',
      privileges: 'none',
      user: { name: 'bob', uid: 1002, gid: 1002, home: '' },
    };
    const h = harness({ owner: brokenHome, disk: [] });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('quotameter start: resolving the user unit path failed');
    expect(result.commands).toEqual([]);
  });
});

describe('installed system unit — system scope', () => {
  it('held privileges on a systemd machine run the verb in-process, every verb', async () => {
    for (const verb of ['start', 'stop', 'restart'] as const) {
      const h = harness({
        owner: HELD,
        capabilities: caps(true, true),
        disk: [SYSTEM_UNIT_INSTALL_PATH],
      });
      const result = await control(verb, h);
      expect(result.code, `exit 0 for ${verb}`).toBe(0);
      expect(result.commands).toEqual([['systemctl', verb, 'quotameter.service']]);
      expect(result.out).toBe(renderControlledSystemUnit(verb) + '\n');
      expect(result.err).toBe('');
    }
  });

  it('pins the exact success outcome', () => {
    expect(renderControlledSystemUnit('restart')).toBe(
      [
        'Service control: restarted the system service.',
        'Ran: systemctl restart quotameter.service',
        'Service status and logs: quotameter status, quotameter logs',
      ].join('\n'),
    );
  });

  it('a regular user gets the sudo-prefixed steps and no command runs', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH],
    });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter start: the system service is installed, but this run does not hold the privileges to control it\n',
    );
    expect(result.out).toBe(renderSystemUnitPrivilegesSteps('start') + '\n');
    expect(result.commands).toEqual([]);
  });

  it('pins the exact sudo steps (pasteable from the regular account)', () => {
    expect(renderSystemUnitPrivilegesSteps('stop')).toBe(
      [
        'Service control: the system service is installed, but controlling it requires root privileges — this run does not hold them.',
        'Re-run the command with sudo:',
        '  sudo quotameter stop',
        'Or control the system service directly:',
        '  sudo systemctl stop quotameter.service',
      ].join('\n'),
    );
  });

  it('no systemd at all is an honest failure with the foreground alternative', async () => {
    const h = harness({
      owner: HELD,
      capabilities: caps(false, false),
      disk: [SYSTEM_UNIT_INSTALL_PATH],
    });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter start: systemd is not available on this machine, so the installed system service cannot be controlled here\n',
    );
    expect(result.out).toBe(
      renderManagerlessSteps('system', SYSTEM_UNIT_INSTALL_PATH, 'alice') + '\n',
    );
    expect(result.commands).toEqual([]);
  });

  it('a regular user on the systemd-less machine gets the same failure without the owner note', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(false, false),
      disk: [SYSTEM_UNIT_INSTALL_PATH],
    });
    const result = await control('stop', h);
    expect(result.code).toBe(1);
    expect(result.out).toBe(renderManagerlessSteps('system', SYSTEM_UNIT_INSTALL_PATH) + '\n');
    expect(result.out).not.toContain("alice's regular account");
    expect(result.commands).toEqual([]);
  });

  it('the managerless renderer carries the owner-account note only for privileged runs', () => {
    expect(renderManagerlessSteps('system', SYSTEM_UNIT_INSTALL_PATH, 'alice')).toBe(
      [
        'Service control: systemd is not available on this machine, so the installed system service cannot be controlled here.',
        `The unit file is ${SYSTEM_UNIT_INSTALL_PATH}. This run holds root privileges — run it from alice's regular account (the service must never run as root).`,
        'To run the service in the foreground instead:',
        '  quotameter run',
      ].join('\n'),
    );
    expect(renderManagerlessSteps('system', SYSTEM_UNIT_INSTALL_PATH)).toBe(
      [
        'Service control: systemd is not available on this machine, so the installed system service cannot be controlled here.',
        `The unit file is ${SYSTEM_UNIT_INSTALL_PATH}.`,
        'To run the service in the foreground instead:',
        '  quotameter run',
      ].join('\n'),
    );
    // The user kind's literal pin (mutation hardening): the handler-level
    // tests compare against this renderer, so only an independent literal
    // catches a kind-interpolation mutation here.
    expect(
      renderManagerlessSteps('user', '/home/alice/.config/systemd/user/quotameter.service'),
    ).toBe(
      [
        'Service control: systemd is not available on this machine, so the installed user service cannot be controlled here.',
        'The unit file is /home/alice/.config/systemd/user/quotameter.service.',
        'To run the service in the foreground instead:',
        '  quotameter run',
      ].join('\n'),
    );
  });

  it('a failed manager command renders the failure line and the manager-status steps', async () => {
    const h = harness({
      owner: HELD,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH],
      failAt: 'systemctl start quotameter.service',
    });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter start: `systemctl start quotameter.service` failed (mock systemctl failure)\n',
    );
    expect(result.out).toBe(renderCommandFailedSteps('start', 'system') + '\n');
  });

  it('pins the exact failed-command steps for both kinds', () => {
    expect(renderCommandFailedSteps('start', 'system')).toBe(
      [
        'Service control: could not start the system service — the service manager reported an error.',
        'Check what happened with:',
        '  systemctl status quotameter.service',
        '  quotameter logs',
      ].join('\n'),
    );
    expect(renderCommandFailedSteps('restart', 'user')).toBe(
      [
        'Service control: could not restart the user service — the service manager reported an error.',
        'Check what happened with:',
        '  systemctl --user status quotameter.service',
        '  quotameter logs',
      ].join('\n'),
    );
  });
});

describe('installed user unit — user scope', () => {
  it('a regular user with a reachable user manager runs the --user verb, every verb', async () => {
    for (const verb of ['start', 'stop', 'restart'] as const) {
      const h = harness({
        owner: REGULAR,
        capabilities: caps(true, true),
        disk: [USER_UNIT_PATH],
      });
      const result = await control(verb, h);
      expect(result.code, `exit 0 for ${verb}`).toBe(0);
      expect(result.commands).toEqual([['systemctl', '--user', verb, 'quotameter.service']]);
      expect(result.out).toBe(renderControlledUserUnit(verb, 'alice') + '\n');
      expect(result.err).toBe('');
    }
  });

  it('pins the exact success outcome', () => {
    expect(renderControlledUserUnit('stop', 'alice')).toBe(
      [
        'Service control: stopped the user service for alice.',
        'Ran: systemctl --user stop quotameter.service',
        'Service status and logs: quotameter status, quotameter logs',
      ].join('\n'),
    );
  });

  it('a privileged run never reaches into the user manager — regular-account steps, no command', async () => {
    const h = harness({
      owner: HELD,
      capabilities: caps(true, true),
      disk: [USER_UNIT_PATH],
    });
    const result = await control('stop', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter stop: a user service is installed, but this run holds root privileges — the user service manager belongs to the regular account\n',
    );
    expect(result.out).toBe(renderUserUnitFromRegularAccountSteps('stop', 'alice') + '\n');
    expect(result.commands).toEqual([]);
  });

  it('pins the exact regular-account steps', () => {
    expect(renderUserUnitFromRegularAccountSteps('restart', 'alice')).toBe(
      [
        "Service control: a user service is installed for alice, but this run holds root privileges — the user service manager belongs to alice's regular account.",
        'Run the command from the regular account without sudo:',
        '  quotameter restart',
      ].join('\n'),
    );
  });

  it('an unreachable user manager prints the exact session commands', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(true, false),
      disk: [USER_UNIT_PATH],
    });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter start: the systemd user manager is not reachable in this session, so the user service cannot be controlled here\n',
    );
    expect(result.out).toBe(renderUserUnitSessionSteps('start', USER_UNIT_PATH) + '\n');
    expect(result.commands).toEqual([]);
  });

  it('pins the exact session steps', () => {
    expect(renderUserUnitSessionSteps('stop', USER_UNIT_PATH)).toBe(
      [
        'Service control: the systemd user manager is not reachable in this session, so the user service cannot be controlled here.',
        `The unit file is ${USER_UNIT_PATH}. Once you have a login session, run:`,
        '  systemctl --user stop quotameter.service',
      ].join('\n'),
    );
  });

  it('no systemd at all is an honest failure naming the unit file', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(false, false),
      disk: [USER_UNIT_PATH],
    });
    const result = await control('restart', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter restart: systemd is not available on this machine, so the installed user service cannot be controlled here\n',
    );
    expect(result.out).toBe(renderManagerlessSteps('user', USER_UNIT_PATH) + '\n');
    expect(result.commands).toEqual([]);
  });

  it('a failed --user command renders the failure line and the --user status steps', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(true, true),
      disk: [USER_UNIT_PATH],
      failAt: 'systemctl --user start quotameter.service',
    });
    const result = await control('start', h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter start: `systemctl --user start quotameter.service` failed (mock systemctl failure)\n',
    );
    expect(result.out).toBe(renderCommandFailedSteps('start', 'user') + '\n');
  });
});

describe('both units installed — privileges select, the other is warned about', () => {
  it('a privileged run controls the system unit and warns about the user unit', async () => {
    const h = harness({
      owner: HELD,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH, USER_UNIT_PATH],
    });
    const result = await control('start', h);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([['systemctl', 'start', 'quotameter.service']]);
    expect(result.err).toBe(
      'quotameter start: note: a user unit is also installed for alice — a system unit and a user ' +
        'unit are two independent services for the same data; only one should be installed\n',
    );
    expect(result.out).toBe(renderControlledSystemUnit('start') + '\n');
  });

  it('a regular user controls the user unit and warns about the system unit', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH, USER_UNIT_PATH],
    });
    const result = await control('stop', h);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([['systemctl', '--user', 'stop', 'quotameter.service']]);
    expect(result.err).toBe(
      `quotameter stop: note: a system unit is also installed (${SYSTEM_UNIT_INSTALL_PATH}) — a system unit and a user ` +
        'unit are two independent services for the same data; only one should be installed\n',
    );
    expect(result.out).toBe(renderControlledUserUnit('stop', 'alice') + '\n');
  });

  it('no cross-unit warning after a failed command — the failure is the story', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH, USER_UNIT_PATH],
      failAt: 'systemctl --user stop quotameter.service',
    });
    const result = await control('stop', h);
    expect(result.code).toBe(1);
    expect(result.err).not.toContain('note:');
  });

  it('an unusable owner home with a system unit installed still controls the system unit', async () => {
    const brokenHome: ServiceOwnerContext = {
      kind: 'sudo',
      privileges: 'held',
      user: { name: 'bob', uid: 1002, gid: 1002, home: '' },
    };
    const h = harness({
      owner: brokenHome,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH],
    });
    const result = await control('start', h);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([['systemctl', 'start', 'quotameter.service']]);
    expect(result.err).toBe('');
    expect(result.out).toContain('started the system service');
  });
});

describe('scope follows the installed unit, not the invocation alone', () => {
  it('a regular user facing only the system unit gets system-scope guidance', async () => {
    const h = harness({
      owner: REGULAR,
      capabilities: caps(true, true),
      disk: [SYSTEM_UNIT_INSTALL_PATH],
    });
    const result = await control('start', h);
    expect(result.commands).toEqual([]);
    expect(result.out).toContain('sudo systemctl start quotameter.service');
    expect(result.out).not.toContain('--user');
  });

  it('a privileged run facing only the user unit gets user-scope guidance', async () => {
    const h = harness({
      owner: HELD,
      capabilities: caps(true, true),
      disk: [USER_UNIT_PATH],
    });
    const result = await control('start', h);
    expect(result.commands).toEqual([]);
    expect(result.out).toContain('quotameter start');
    expect(result.out).toContain('regular account');
  });
});

describe('production default seams (task-137/139 pattern)', () => {
  /**
   * The container and the CI runners ship no systemd and no quotameter
   * installation, so the default seams are exercised on the branches those
   * environments deterministically produce — the entry-evaluated seam
   * consts (139's shape) cover the `??` default arms the moment a route is
   * entered, before any gate decides whether a command actually runs.
   */

  it('no injection at all resolves the real owner and probes the real disk', async () => {
    const h = harness();
    // Drop every injected seam: the production defaults must carry the run.
    const code = await runServiceControlCommand('start')(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toBe('quotameter start: no systemd service is installed — nothing to start\n');
    expect(h.out()).toContain('quotameter service install');
  });

  it('a real user unit under a temp home runs on the default seams (managerless outcome)', async () => {
    const dir = await createTempDir('qm-control-defaults-user-');
    try {
      const owner: ServiceOwnerContext = {
        kind: 'regular-user',
        privileges: 'none',
        user: { ...OWNER, home: dir.path },
      };
      const installPath = userUnitInstallPath(dir.path);
      await writeUnitFileToDisk(installPath, '# installed by an earlier quotameter\n');
      const h = harness();
      const code = await runServiceControlCommand('stop', {
        resolveOwner: () => ({ state: 'ok', context: owner }),
      })({ ...h.ctx, commandPath: ['stop'] });
      expect(code).toBe(1); // the systemd-less test environments
      expect(h.err()).toBe(
        'quotameter stop: systemd is not available on this machine, so the installed user service cannot be controlled here\n',
      );
      expect(h.out()).toBe(renderManagerlessSteps('user', installPath) + '\n');
    } finally {
      await dir.remove();
    }
  });

  it('the system route evaluates its default seams and renders the privileged managerless note', async () => {
    // The system install path cannot be written for real; its existence is
    // the one scripted fact. Everything else — owner probe aside — is the
    // production default, and the systemd-less environments take the
    // managerless branch before any command could run.
    const h = harness();
    const code = await runServiceControlCommand('restart', {
      resolveOwner: () => ({ state: 'ok', context: HELD }),
      unitFileExists: (installPath) => installPath === SYSTEM_UNIT_INSTALL_PATH,
    })({ ...h.ctx, commandPath: ['restart'] });
    expect(code).toBe(1);
    expect(h.err()).toBe(
      'quotameter restart: systemd is not available on this machine, so the installed system service cannot be controlled here\n',
    );
    expect(h.out()).toBe(
      renderManagerlessSteps('system', SYSTEM_UNIT_INSTALL_PATH, 'alice') + '\n',
    );
  });
});
