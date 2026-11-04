/**
 * The `quotameter start` / `stop` / `restart` command handlers (task 140,
 * spec §5.2; decision D-110).
 *
 * §5.2: "`quotameter start`, `stop`, `restart` — Control an installed
 * service through systemd", and "If service control is requested before
 * installation, display a helpful next step instead of failing cryptically."
 * These handlers control the **currently installed** unit: the scope comes
 * from what is on disk (task 139's exists-probe over the two install paths),
 * not from re-deriving the install route — a regular user facing an
 * installed system unit gets system-scope guidance, and a `sudo` run facing
 * an installed user unit is told to use the regular account. Only when both
 * units exist (a state task 139 warns is a mistake) do the invocation's
 * privileges select, per D-108's "privileges-select-unit-kind rule" — with
 * the same cross-unit warning install prints.
 *
 * Execution follows the landed vocabulary (D-105): the system unit's
 * `systemctl <verb>` is a privileged operation, so it runs in-process only
 * under held privileges (`sudo quotameter start`, the shape task 137's plan
 * and task 139's completion steps direct users to) and is otherwise rendered
 * as the exact `sudo`-prefixed commands; the user unit's `systemctl --user
 * <verb>` is unprivileged and runs as the owner — but never from a
 * privileged run, whose user manager would be root's, not the owner's
 * (D-105: a privileged run does not reach into the user manager).
 *
 * Unavailable managers are honest failures with exact steps, reusing task
 * 137's capability facts: a unit file on a systemd-less machine cannot be
 * controlled at all (the foreground alternative is printed, with the
 * owner-account note for privileged runs — the service must never run as
 * root), and an unreachable user manager gets the verb's exact session
 * command for the next login. No `is-active` verification runs after the
 * verb: the manager command's own exit status is the contract (install's
 * `is-active` is §5.3 step 7's prescribed privileged-flow check, and `stop`
 * would need it inverted), recorded in D-110.
 *
 * Exit codes: 0 exactly when the verb command ran and exited 0; every other
 * outcome — owner problems, nothing installed, missing privileges,
 * manager unavailable, or a failed manager command — exits 1 with the
 * failure on stderr and actionable steps on stdout. The handlers never
 * throw (the owner resolution's broken-system throw included).
 */

import type { CliContext, CliHandler } from './commands';
import { resolveOwnerForCommand, unitFileExistsOnDisk } from './service-install';
import type { ServiceOwnerContext, ServiceOwnerResolution } from './service-owner';
import {
  failureLine,
  probeServiceCapabilities,
  spawnServiceCommand,
  thrownMessage,
  type CapabilityProbe,
  type ServiceCommandRunner,
} from './service-setup';
import { SYSTEM_UNIT_INSTALL_PATH, SYSTEM_UNIT_NAME } from './systemd-unit';
import { userUnitInstallPath, USER_UNIT_NAME } from './systemd-user-unit';

/** The §5.2 service-control verbs these handlers serve. */
export type ServiceControlVerb = 'start' | 'stop' | 'restart';

/** The verbs' past tense for the success outcomes. */
const VERB_PAST: Readonly<Record<ServiceControlVerb, string>> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};

/** Injectable collaborators; every one has a production default. */
export interface ServiceControlDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /** The §5.3 step 1 capability probe (task 137); production `probeServiceCapabilities`. */
  readonly probeCapabilities?: CapabilityProbe;
  /** The service-command executor; production `spawnServiceCommand`. */
  readonly runCommand?: ServiceCommandRunner;
  /** Whether a unit file is on disk; production `unitFileExistsOnDisk` (task 139). */
  readonly unitFileExists?: (installPath: string) => boolean;
}

/** The manager command one verb runs against the system unit (privileged, D-105). */
function systemVerbCommand(verb: ServiceControlVerb): readonly string[] {
  return ['systemctl', verb, SYSTEM_UNIT_NAME];
}

/** The manager command one verb runs against the user unit (unprivileged). */
function userVerbCommand(verb: ServiceControlVerb): readonly string[] {
  return ['systemctl', '--user', verb, USER_UNIT_NAME];
}

/**
 * §5.2's helpful next step when control is requested before installation:
 * the exact install commands for both §5.3 step 7 modes, the one-step
 * alternative, and the foreground escape.
 */
export function renderNotInstalledGuidance(verb: ServiceControlVerb): string {
  return [
    `Service control: the quotameter service is not installed as a systemd service — there is nothing to ${verb}.`,
    'Install it first:',
    '  sudo quotameter service install   (system service)',
    '  quotameter service install        (user service, no sudo needed)',
    'Or set everything up in one step: quotameter init',
    'To run in the foreground without installing: quotameter run',
  ].join('\n');
}

/**
 * The exact commands when the system unit is installed but this run holds
 * no privileges: the `sudo`-prefixed forms pasteable from the regular
 * account's shell (D-108's review-round rule for prescriptive system
 * commands).
 */
export function renderSystemUnitPrivilegesSteps(verb: ServiceControlVerb): string {
  return [
    'Service control: the system service is installed, but controlling it requires root privileges — this run does not hold them.',
    'Re-run the command with sudo:',
    `  sudo quotameter ${verb}`,
    'Or control the system service directly:',
    `  sudo systemctl ${verb} ${SYSTEM_UNIT_NAME}`,
  ].join('\n');
}

/**
 * The guidance when a privileged run meets an installed user unit: the user
 * manager belongs to the owner's login session (D-105 — a privileged run
 * does not reach into it), so the command must come from the regular
 * account, without sudo.
 */
export function renderUserUnitFromRegularAccountSteps(
  verb: ServiceControlVerb,
  ownerName: string,
): string {
  return [
    `Service control: a user service is installed for ${ownerName}, but this run holds root privileges — the user service manager belongs to ${ownerName}'s regular account.`,
    'Run the command from the regular account without sudo:',
    `  quotameter ${verb}`,
  ].join('\n');
}

/**
 * The systemd-less outcome for an installed unit: the file names which
 * service exists, and the foreground alternative runs it now. A privileged
 * run is additionally told to run it from the owner's account — the service
 * must never run as root (§5.1), and task 137's identical note explains why.
 */
export function renderManagerlessSteps(
  kind: 'system' | 'user',
  installPath: string,
  ownerName?: string,
): string {
  const where =
    ownerName === undefined
      ? ''
      : ` This run holds root privileges — run it from ${ownerName}'s regular account (the service must never run as root).`;
  return [
    `Service control: systemd is not available on this machine, so the installed ${kind} service cannot be controlled here.`,
    `The unit file is ${installPath}.${where}`,
    'To run the service in the foreground instead:',
    '  quotameter run',
  ].join('\n');
}

/**
 * The exact session commands when the user unit is installed but the user
 * manager is unreachable in this session (cron, some ssh setups): the
 * verb's command for the next login, task 137's manual-steps shape.
 */
export function renderUserUnitSessionSteps(verb: ServiceControlVerb, installPath: string): string {
  return [
    'Service control: the systemd user manager is not reachable in this session, so the user service cannot be controlled here.',
    `The unit file is ${installPath}. Once you have a login session, run:`,
    `  systemctl --user ${verb} ${USER_UNIT_NAME}`,
  ].join('\n');
}

/** The next steps after a failed manager command: the manager's own status view and the logs. */
export function renderCommandFailedSteps(
  verb: ServiceControlVerb,
  kind: 'system' | 'user',
): string {
  const status =
    kind === 'system'
      ? `systemctl status ${SYSTEM_UNIT_NAME}`
      : `systemctl --user status ${USER_UNIT_NAME}`;
  return [
    `Service control: could not ${verb} the ${kind} service — the service manager reported an error.`,
    'Check what happened with:',
    `  ${status}`,
    '  quotameter logs',
  ].join('\n');
}

/** The successful system-unit outcome. */
export function renderControlledSystemUnit(verb: ServiceControlVerb): string {
  return [
    `Service control: ${VERB_PAST[verb]} the system service.`,
    `Ran: ${systemVerbCommand(verb).join(' ')}`,
    'Service status and logs: quotameter status, quotameter logs',
  ].join('\n');
}

/** The successful user-unit outcome. */
export function renderControlledUserUnit(verb: ServiceControlVerb, ownerName: string): string {
  return [
    `Service control: ${VERB_PAST[verb]} the user service for ${ownerName}.`,
    `Ran: ${userVerbCommand(verb).join(' ')}`,
    'Service status and logs: quotameter status, quotameter logs',
  ].join('\n');
}

/**
 * The cross-unit stderr note when both unit kinds are installed (task 139's
 * warning shape): the privileges-selected unit is used and the other one
 * named, because two installed units is the mistake install already warns
 * about, not a supported state.
 *
 * Shared with the `logs` handler (task 143, D-116), which prints it before
 * streaming instead of after acting — the `resolveOwnerForCommand`
 * additive-export precedent.
 */
export function otherUnitWarning(controlled: 'system' | 'user', ownerName: string): string {
  const where =
    controlled === 'system'
      ? `a user unit is also installed for ${ownerName}`
      : `a system unit is also installed (${SYSTEM_UNIT_INSTALL_PATH})`;
  return (
    `note: ${where} — a system unit and a user unit are two independent services ` +
    'for the same data; only one should be installed'
  );
}

/**
 * Builds one of the §5.2 service-control handlers (task 140, D-110):
 * resolves the owner, discovers the installed unit, and either runs the
 * verb against the right manager scope or prints the exact steps that make
 * the invocation possible. Never throws; returns the process exit code.
 */
export function runServiceControlCommand(
  verb: ServiceControlVerb,
  deps: ServiceControlDeps = {},
): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const owner = resolveOwnerForCommand(ctx.output, deps, errorPrefix);
    if (owner === null) {
      return 1;
    }
    const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
    const systemUnit = unitFileExists(SYSTEM_UNIT_INSTALL_PATH);
    // The user unit lives under the owner's home; an unusable passwd home
    // cannot name that path. With a system unit installed that only costs
    // the cross-kind warning (139's best-effort hint); without one, no
    // installed unit could be established at all — a failure, not a
    // silent "nothing installed".
    let userUnitPath: string | undefined;
    try {
      userUnitPath = userUnitInstallPath(owner.user.home);
    } catch (error) {
      if (systemUnit) {
        userUnitPath = undefined;
      } else {
        ctx.output.err(
          failureLine(errorPrefix, 'resolving the user unit path failed', thrownMessage(error)),
        );
        return 1;
      }
    }
    const userUnit = userUnitPath !== undefined && unitFileExists(userUnitPath);

    if (!systemUnit && !userUnit) {
      ctx.output.err(`${errorPrefix}: no systemd service is installed — nothing to ${verb}`);
      ctx.output.out(renderNotInstalledGuidance(verb));
      return 1;
    }
    // Both units installed: privileges select (D-108's rule), and the
    // outcome carries the cross-unit warning. One unit installed: that is
    // the scope, whatever this invocation's privileges are.
    const kind: 'system' | 'user' =
      systemUnit && userUnit
        ? owner.privileges === 'held'
          ? 'system'
          : 'user'
        : systemUnit
          ? 'system'
          : 'user';
    if (kind === 'system') {
      return controlSystemUnit(ctx, deps, owner, verb, errorPrefix, userUnit);
    }
    // userUnit implies userUnitPath was resolved (the probe needed it).
    return controlUserUnit(ctx, deps, owner, verb, errorPrefix, userUnitPath!, systemUnit);
  };
}

/** The system-unit control: privileged execution in-process (D-105's vocabulary). */
async function controlSystemUnit(
  ctx: CliContext,
  deps: ServiceControlDeps,
  owner: ServiceOwnerContext,
  verb: ServiceControlVerb,
  errorPrefix: string,
  crossUnitInstalled: boolean,
): Promise<number> {
  // The seam consts evaluate on entry (task 139's shape): the default
  // executor arm is selected the moment the route is entered, before any
  // capability gate decides whether a command actually runs.
  const runCommand = deps.runCommand ?? spawnServiceCommand;
  const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
  if (!capabilities.systemd) {
    ctx.output.err(
      `${errorPrefix}: systemd is not available on this machine, so the installed system service cannot be controlled here`,
    );
    ctx.output.out(
      renderManagerlessSteps(
        'system',
        SYSTEM_UNIT_INSTALL_PATH,
        owner.privileges === 'held' ? owner.user.name : undefined,
      ),
    );
    return 1;
  }
  if (owner.privileges !== 'held') {
    ctx.output.err(
      `${errorPrefix}: the system service is installed, but this run does not hold the privileges to control it`,
    );
    ctx.output.out(renderSystemUnitPrivilegesSteps(verb));
    return 1;
  }
  const command = systemVerbCommand(verb);
  const outcome = await runCommand(command);
  if (!outcome.ok) {
    ctx.output.err(failureLine(errorPrefix, `\`${command.join(' ')}\` failed`, outcome.detail));
    ctx.output.out(renderCommandFailedSteps(verb, 'system'));
    return 1;
  }
  if (crossUnitInstalled) {
    ctx.output.err(`${errorPrefix}: ${otherUnitWarning('system', owner.user.name)}`);
  }
  ctx.output.out(renderControlledSystemUnit(verb));
  return 0;
}

/**
 * The user-unit control: unprivileged, and only from a regular account — a
 * privileged run's `--user` manager would be root's, not the owner's
 * (D-105), so it is guided to the regular account before anything else.
 */
async function controlUserUnit(
  ctx: CliContext,
  deps: ServiceControlDeps,
  owner: ServiceOwnerContext,
  verb: ServiceControlVerb,
  errorPrefix: string,
  installPath: string,
  crossUnitInstalled: boolean,
): Promise<number> {
  // Entry-evaluated seam const, the same entry shape as controlSystemUnit.
  const runCommand = deps.runCommand ?? spawnServiceCommand;
  if (owner.privileges === 'held') {
    ctx.output.err(
      `${errorPrefix}: a user service is installed, but this run holds root privileges — the user service manager belongs to the regular account`,
    );
    ctx.output.out(renderUserUnitFromRegularAccountSteps(verb, owner.user.name));
    return 1;
  }
  const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
  if (!capabilities.systemd) {
    ctx.output.err(
      `${errorPrefix}: systemd is not available on this machine, so the installed user service cannot be controlled here`,
    );
    ctx.output.out(renderManagerlessSteps('user', installPath));
    return 1;
  }
  if (!capabilities.userManager) {
    ctx.output.err(
      `${errorPrefix}: the systemd user manager is not reachable in this session, so the user service cannot be controlled here`,
    );
    ctx.output.out(renderUserUnitSessionSteps(verb, installPath));
    return 1;
  }
  const command = userVerbCommand(verb);
  const outcome = await runCommand(command);
  if (!outcome.ok) {
    ctx.output.err(failureLine(errorPrefix, `\`${command.join(' ')}\` failed`, outcome.detail));
    ctx.output.out(renderCommandFailedSteps(verb, 'user'));
    return 1;
  }
  if (crossUnitInstalled) {
    ctx.output.err(`${errorPrefix}: ${otherUnitWarning('user', owner.user.name)}`);
  }
  ctx.output.out(renderControlledUserUnit(verb, owner.user.name));
  return 0;
}
