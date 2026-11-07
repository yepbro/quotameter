/**
 * The `quotameter service install` / `service uninstall` command handlers
 * (task 139, spec §5.2/§5.4; decision D-108).
 *
 * §5.2: "Install or remove the service independently of `init`" — these two
 * handlers are the command surface for exactly the machinery task 137 routed
 * and named: its system-unit route renders the plan whose completing command
 * is `sudo quotameter service install`, and this module makes that command
 * real. Independence of init is structural: no configuration is read,
 * written, or required anywhere here — the unit content comes from the
 * landed generators (tasks 134/135), the owner context from task 136's
 * resolver, the route and the spawn/write seams from task 137, and the
 * linger guidance from task 138.
 *
 * Idempotency (§5.4: "`quotameter service install` must regenerate the
 * unit"): install-when-absent and install-when-present run the **same**
 * sequence — the deterministic generator rewrite (fresh absolute Node/CLI
 * paths after an upgrade), `daemon-reload`, `enable --now` (a no-op on an
 * enabled service) — so re-running install is the §5.4 stale-path remedy. A
 * pre-existing unit file only adds a regenerated note (a running service
 * keeps the previous unit until it is restarted). Uninstall-when-absent is
 * a "nothing to do" success with zero side effects.
 *
 * Routing reuses §5.3 step 7's matrix (task 137's `resolveServiceSetupRoute`)
 * unchanged: privileges held on a systemd machine install/uninstall the
 * **system** unit with the privileged operations running in-process (D-105's
 * vocabulary — install/remove system unit, `daemon-reload`, enable/disable,
 * and the start/stop `--now` implies); a regular user installs/uninstalls
 * the **user** unit entirely unprivileged. The unavailable routes are honest
 * failures with exact steps: install on a systemd-less machine refuses with
 * the foreground alternative (exit 1 — unlike init, whose configuration
 * write has already succeeded by its service step, install's whole job is
 * the service), and an unreachable user manager still writes the unit file
 * (the write needs no manager) and prints the exact session commands.
 *
 * Exit codes: install exits 0 exactly when the unit was written, systemd
 * was reloaded, and the service was enabled/started — on the system route
 * additionally confirmed by `systemctl is-active` and, when a readable
 * configuration names the endpoint, by the bounded loopback
 * `GET /api/health` verification (§5.3 step 7's privileged leg, U-059,
 * D-187; no readable configuration skips the probe honestly instead of
 * failing — D-108's no-configuration-required independence); every lesser
 * outcome exits 1 with the failure on stderr and actionable steps on
 * stdout. The user route keeps §5.3's user-unit bullet scope — enable
 * without a prescribed verification (recorded in D-187).
 * Uninstall exits 0 exactly when the unit file is gone (or was absent) and
 * every executed manager command succeeded; a failed manager command is
 * reported even though the file removal went ahead, because the manager
 * keeps holding state — the outcome then names the exact cleanup command.
 * Neither handler throws, the owner resolution's broken-system throw
 * included (it is rendered as the standard failure line).
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { configFilePath } from '../config/load';
import { resolvePaths, type PathEnv } from '../config/paths';
import type { CliContext, CliHandler } from './commands';
import type { CliOutput } from './output';
import { readExistingConfig } from './init-persist';
import {
  probeUserLinger,
  renderLingerGuidance,
  type LingerState,
  type UserLingerProbe,
} from './service-linger';
import {
  resolveServiceOwner,
  type PasswdEntry,
  type ServiceOwnerContext,
  type ServiceOwnerResolution,
} from './service-owner';
import {
  failureLine,
  HEALTH_CHECK_DEADLINE_MS,
  healthProbeTarget,
  INIT_RESTART_SEC_SECONDS,
  probeServiceCapabilities,
  renderHealthCheckGuidance,
  renderHealthCheckSkipped,
  renderHealthVerificationPassed,
  resolveServiceSetupRoute,
  serviceExecPaths,
  spawnServiceCommand,
  thrownMessage,
  unsafeOwnerNameProblem,
  verifyServiceHealth,
  writeUnitFileToDisk,
  type CapabilityProbe,
  type ServiceCommandRunner,
  type ServiceHealthCheck,
  type ServiceSetupRoute,
  type ServiceUnitWriter,
  type ServiceExecPaths,
} from './service-setup';
import {
  assertUnitPathInput,
  buildSystemUnit,
  SYSTEM_UNIT_INSTALL_PATH,
  SYSTEM_UNIT_NAME,
} from './systemd-unit';
import { buildUserUnit, USER_UNIT_NAME, userUnitInstallPath } from './systemd-user-unit';

/** The manager commands of the system-unit install, in execution order. */
const SYSTEM_RELOAD_COMMAND = ['systemctl', 'daemon-reload'] as const;
const SYSTEM_ENABLE_COMMAND = ['systemctl', 'enable', '--now', SYSTEM_UNIT_NAME] as const;
const SYSTEM_IS_ACTIVE_COMMAND = ['systemctl', 'is-active', SYSTEM_UNIT_NAME] as const;

/** The manager commands of the user-unit install, in execution order (D-106's set). */
const USER_RELOAD_COMMAND = ['systemctl', '--user', 'daemon-reload'] as const;
const USER_ENABLE_COMMAND = ['systemctl', '--user', 'enable', '--now', USER_UNIT_NAME] as const;

/** The manager commands of the uninstalls. */
const SYSTEM_DISABLE_COMMAND = ['systemctl', 'disable', '--now', SYSTEM_UNIT_NAME] as const;
const USER_DISABLE_COMMAND = ['systemctl', '--user', 'disable', '--now', USER_UNIT_NAME] as const;
const USER_RELOAD_AFTER_REMOVE_COMMAND = ['systemctl', '--user', 'daemon-reload'] as const;

/** Injectable collaborators; every one has a production default. */
export interface ServiceCommandDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /** The §5.3 step 1 capability probe (task 137); production `probeServiceCapabilities`. */
  readonly probeCapabilities?: CapabilityProbe;
  /** The service-command executor; production `spawnServiceCommand`. */
  readonly runCommand?: ServiceCommandRunner;
  /** The unit-file writer; production `writeUnitFileToDisk`. */
  readonly writeUnitFile?: ServiceUnitWriter;
  /** Removes one unit file; production {@link removeUnitFileFromDisk}. */
  readonly removeUnitFile?: (installPath: string) => Promise<void>;
  /** Whether a unit file is on disk; production {@link unitFileExistsOnDisk}. */
  readonly unitFileExists?: (installPath: string) => boolean;
  /** The absolute paths pinned into the generated unit; production `serviceExecPaths`. */
  readonly execPaths?: () => ServiceExecPaths;
  /** The §5.3 linger probe (task 138, D-107); production `probeUserLinger`. */
  readonly probeLinger?: UserLingerProbe;
  /**
   * The §5.3 step-7 health verification of the system route (U-059,
   * D-187); production `verifyServiceHealth` — a bounded loopback
   * `GET /api/health` poll over the owner's configured endpoint.
   */
  readonly checkServiceHealth?: ServiceHealthCheck;
  /**
   * The environment the system unit's §6.1 `ReadWritePaths` directories
   * resolve from; production `process.env`. `HOME` is always overridden to
   * the owner's home (a privileged run must not pin root's paths into a
   * unit that runs as the owner).
   */
  readonly pathEnv?: PathEnv;
}

/**
 * The production unit-file remover. Removing an absent file is not an error
 * here (`force: true`): uninstall's exists-probe and the removal are two
 * looks at the disk, and a file that vanished between them is exactly the
 * end state uninstall wants.
 */
export function removeUnitFileFromDisk(installPath: string): Promise<void> {
  return rm(installPath, { force: true });
}

/** The production on-disk check behind the idempotency branches. */
export function unitFileExistsOnDisk(installPath: string): boolean {
  return existsSync(installPath);
}

/** The `--restart-sec` flag's parse result: seconds, or one problem line. */
export type RestartSecParse =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly problem: string };

/**
 * Parses `--restart-sec` (§5.4's configurable `RestartSec`): a plain decimal
 * string of whole seconds >= 1 within the exactly-comparable safe-integer
 * range — the same bound the generators' own `assertUnitRestartSecSeconds`
 * enforces, so no flag value can pass here and fail there (the default,
 * {@link INIT_RESTART_SEC_SECONDS}, is D-106's alignment instruction made
 * literal: one value, imported, not a second constant).
 */
export function parseRestartSecSeconds(value: string): RestartSecParse {
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      problem: `--restart-sec must be a whole number of seconds (got ${JSON.stringify(value)})`,
    };
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    return {
      ok: false,
      problem: `--restart-sec must be a whole number of seconds >= 1 (got ${JSON.stringify(value)})`,
    };
  }
  return { ok: true, seconds };
}

/**
 * Resolves the owner's §6.1 directories for the system unit's
 * `ReadWritePaths` (§5.4): the same `resolvePaths` precedence the service
 * itself uses, over the process environment with `HOME` replaced by the
 * owner's home directory — the unit runs as the owner, so its writable
 * paths must be the owner's, never the privileged environment's root home.
 * sudo strips `XDG_*`/`QUOTAMETER_*` by default, so the owner's XDG
 * defaults result; an operator-declared override (`sudo -E`, or
 * `sudo QUOTAMETER_CONFIG_DIR=… quotameter service install`) is honored as
 * the explicit declaration of the owner's paths it is. The owner's home is
 * validated by the shared injection guard first: a passwd row with an
 * unusable home must fail the install loudly, not pin a bogus path into
 * `ReadWritePaths` (the generator re-validates every interpolated value).
 *
 * Shared with the `reload` handler (task 141, D-112), which resolves the
 * owner's data directory (the §5.6 lock lives there) and the configuration
 * path the same way — additive export, D-110's `resolveOwnerForCommand`
 * precedent.
 */
export function ownerUnitDirectories(
  owner: PasswdEntry,
  env: PathEnv,
): { readonly configDir: string; readonly dataDir: string } {
  assertUnitPathInput('homeDir', owner.home);
  const paths = resolvePaths({ ...env, HOME: owner.home });
  return { configDir: paths.configDir, dataDir: paths.dataDir };
}

/** The foreground alternative when installation is impossible or failed. */
function renderManualRunAlternative(ownerName?: string): string {
  const where =
    ownerName === undefined
      ? ''
      : ` from ${ownerName}'s regular account (the service must never run as root)`;
  return [
    'Service install: the service can still run without installation.',
    `Run it in the foreground${where}:`,
    '  quotameter run',
    'This runs in the foreground and stops when its session ends.',
  ].join('\n');
}

/**
 * The stderr lead of the systemd-absent refusal: there is no service
 * manager to install into, and §5.2 asks for the helpful next step rather
 * than a cryptic failure.
 */
const SYSTEMD_ABSENT_LEAD =
  'systemd is not available on this machine, so the service cannot be installed here';

/**
 * The exact completion commands when the system unit is on disk but not
 * enabled. The commands carry the `sudo` prefix: the normal invocation is
 * the one-shot `sudo quotameter service install`, whose shell is the
 * regular account — a `sudo -s` root shell simply types past the redundant
 * sudo (review-round P1).
 */
export function renderSystemUnitCompletionSteps(lead: string, installPath: string): string {
  return [
    `Service install: ${lead}`,
    `The unit file is written to ${installPath}. Complete the installation with:`,
    `  sudo ${SYSTEM_RELOAD_COMMAND.join(' ')}`,
    `  sudo ${SYSTEM_ENABLE_COMMAND.join(' ')}`,
    `  sudo ${SYSTEM_IS_ACTIVE_COMMAND.join(' ')}`,
  ].join('\n');
}

/** The exact completion commands when the user unit is on disk but not enabled. */
export function renderUserUnitCompletionSteps(
  ownerName: string,
  installPath: string,
  lead: string,
  linger: LingerState,
): string {
  return [
    `Service install: ${lead}`,
    `The unit file is written to ${installPath}. Once the systemd user manager is reachable, run:`,
    `  ${USER_RELOAD_COMMAND.join(' ')}`,
    `  ${USER_ENABLE_COMMAND.join(' ')}`,
    renderLingerGuidance(ownerName, linger),
    'To run the service in the foreground in the meantime:',
    '  quotameter run',
  ].join('\n');
}

/** The successful system-unit install outcome (§5.3 step 7's privileged leg). */
export function renderSystemUnitInstalled(
  ownerName: string,
  installPath: string,
  regenerated: boolean,
): string {
  const lines = [
    `Service install: installed the system service for ${ownerName}.`,
    `Unit file: ${installPath}${regenerated ? ' (regenerated)' : ''}`,
    `Runs as User=${ownerName}.`,
    `Enabled and started with: ${SYSTEM_ENABLE_COMMAND.join(' ')}`,
    `Verified active with: ${SYSTEM_IS_ACTIVE_COMMAND.join(' ')}`,
  ];
  if (regenerated) {
    lines.push(
      `The unit file was regenerated; a running service keeps the previous unit until it is restarted (sudo systemctl restart ${SYSTEM_UNIT_NAME}).`,
    );
  }
  lines.push('Service status and logs: quotameter status, quotameter logs');
  return lines.join('\n');
}

/** The successful user-unit install outcome, with the detected linger guidance (D-107). */
export function renderUserUnitInstalled(
  ownerName: string,
  installPath: string,
  regenerated: boolean,
  linger: LingerState,
): string {
  const lines = [
    `Service install: installed the user service for ${ownerName} — no sudo needed.`,
    `Unit file: ${installPath}${regenerated ? ' (regenerated)' : ''}`,
    `Enabled and started with: ${USER_ENABLE_COMMAND.join(' ')}`,
    renderLingerGuidance(ownerName, linger),
  ];
  if (regenerated) {
    lines.push(
      `The unit file was regenerated; a running service keeps the previous unit until it is restarted (systemctl --user restart ${USER_UNIT_NAME}).`,
    );
  }
  lines.push('Service status and logs: quotameter status, quotameter logs');
  return lines.join('\n');
}

/** The is-active failure guidance: installed and enabled, but not active. */
export function renderNotActiveSteps(): string {
  return [
    'Service install: the unit is installed and enabled, but the service did not reach the active state.',
    'Check what happened with:',
    '  quotameter status',
    '  quotameter logs',
    'If no configuration exists yet, create one first:',
    '  quotameter init',
  ].join('\n');
}

/** Which parts of an uninstall completed, for the outcome renderers. */
export interface UninstallOutcome {
  /** No service manager to talk to — no manager commands were attempted. */
  readonly managerless: boolean;
  /** Manager commands that failed, joined for display — empty when clean. */
  readonly failedCommands: readonly string[];
}

/**
 * The system-unit uninstall outcome. Honest by construction (review round
 * P1/P2): the managerless variant never claims commands that were never
 * run, and a partially failed uninstall says what is left to do — the file
 * is gone, and one `sudo systemctl daemon-reload` makes the manager forget
 * the unit (a failed `disable` cannot be re-run against a removed file;
 * enablement links to removed units are ignored by systemd).
 */
export function renderSystemUnitUninstalled(
  installPath: string,
  outcome: UninstallOutcome,
): string {
  const lines = [
    outcome.failedCommands.length > 0
      ? 'Service uninstall: removed the system service unit file, but not every manager command succeeded.'
      : 'Service uninstall: removed the system service.',
    `Removed unit file: ${installPath}`,
  ];
  if (outcome.failedCommands.length > 0) {
    lines.push(
      'Systemd may still hold state for the unit — finish the cleanup with:',
      `  sudo ${SYSTEM_RELOAD_COMMAND.join(' ')}`,
    );
  } else if (outcome.managerless) {
    lines.push(
      'No service manager is running, so no systemctl commands were needed; ' +
        'a manager that appears later forgets a removed unit on its first daemon-reload.',
    );
  } else {
    lines.push(
      `Disabled and stopped with: ${SYSTEM_DISABLE_COMMAND.join(' ')}`,
      `Reloaded systemd with: ${SYSTEM_RELOAD_COMMAND.join(' ')}`,
    );
  }
  lines.push('To run the service in the foreground instead:', '  quotameter run');
  return lines.join('\n');
}

/** The user-unit uninstall outcome, with the same honesty contract. */
export function renderUserUnitUninstalled(installPath: string, outcome: UninstallOutcome): string {
  const lines = [
    outcome.failedCommands.length > 0
      ? 'Service uninstall: removed the user service unit file, but not every manager command succeeded.'
      : 'Service uninstall: removed the user service.',
    `Removed unit file: ${installPath}`,
  ];
  if (outcome.failedCommands.length > 0) {
    lines.push(
      'The user manager may still hold state for the unit — finish the cleanup with:',
      `  ${USER_RELOAD_AFTER_REMOVE_COMMAND.join(' ')}`,
    );
  } else if (outcome.managerless) {
    lines.push(
      'The systemd user manager is not reachable in this session, so the unit could not be disabled here; ' +
        'systemd ignores enablement links to removed units.',
    );
  } else {
    lines.push(
      `Disabled and stopped with: ${USER_DISABLE_COMMAND.join(' ')}`,
      `Reloaded the user manager with: ${USER_RELOAD_AFTER_REMOVE_COMMAND.join(' ')}`,
    );
  }
  lines.push('To run the service in the foreground instead:', '  quotameter run');
  return lines.join('\n');
}

/** The uninstall no-op outcome: nothing is installed, nothing was touched. */
export function renderNothingInstalled(kind: 'system' | 'user'): string {
  return `Service uninstall: no ${kind} service is installed — nothing to do.`;
}

/**
 * The cross-unit hint on the uninstall no-op: the other kind of unit IS on
 * disk, and §5.2's helpful-next-step rule says so with the exact command.
 */
export function renderOtherUnitInstalledHint(
  installedKind: 'system' | 'user',
  ownerName: string,
): string {
  if (installedKind === 'system') {
    return [
      `A system service is installed (${SYSTEM_UNIT_INSTALL_PATH}) — remove it with:`,
      '  sudo quotameter service uninstall',
    ].join('\n');
  }
  return [
    `A user service is installed for ${ownerName} — remove it from the regular account with:`,
    '  quotameter service uninstall',
  ].join('\n');
}

/**
 * The stderr warning when install would create a second, independent unit
 * beside an existing one: the §5.6 single-instance lock keeps two services
 * from corrupting anything, but two installed units is a mistake, not a
 * supported state — a warning, not a refusal (uninstalling one unit is the
 * user's next step, and `doctor`'s service checks can flag it later).
 */
function otherUnitWarning(existingKind: 'system' | 'user'): string {
  const where =
    existingKind === 'system'
      ? `a system unit is installed at ${SYSTEM_UNIT_INSTALL_PATH}`
      : "a user unit is installed under the owner's home";
  return (
    `note: ${where} — a system unit and a user unit are two independent services ` +
    'for the same data; only one should be installed'
  );
}

/**
 * Resolves the owner for a handler and reports every outcome itself: D-105's
 * problems as prefixed stderr lines, and a broken system's thrown read error
 * (an unreadable user database is D-105's documented throw) as one failure
 * line — so the handlers keep their never-throw promise (review round P2).
 * Returns null when the command must stop with exit 1.
 *
 * Shared with the `start`/`stop`/`restart` handlers (task 140), the same way
 * `failureLine`/`thrownMessage` are shared with this module — the deps
 * parameter takes any seam set carrying `resolveOwner`.
 */
export function resolveOwnerForCommand(
  output: CliOutput,
  deps: Pick<ServiceCommandDeps, 'resolveOwner'>,
  errorPrefix: string,
): ServiceOwnerContext | null {
  let resolution: ServiceOwnerResolution;
  try {
    resolution = (deps.resolveOwner ?? resolveServiceOwner)();
  } catch (error) {
    output.err(
      failureLine(errorPrefix, 'resolving the service owner failed', thrownMessage(error)),
    );
    return null;
  }
  if (resolution.state === 'problems') {
    for (const problem of resolution.problems) {
      output.err(`${errorPrefix}: ${problem}`);
    }
    return null;
  }
  return resolution.context;
}

/** Builds the `service install` handler (§5.2, §5.4; D-108). */
export function runServiceInstallCommand(deps: ServiceCommandDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const owner = resolveOwnerForCommand(ctx.output, deps, errorPrefix);
    if (owner === null) {
      return 1;
    }
    const nameProblem = unsafeOwnerNameProblem(owner.user.name);
    if (nameProblem !== null) {
      ctx.output.err(`${errorPrefix}: ${nameProblem}`);
      return 1;
    }
    const flagValue = ctx.flags['restart-sec'];
    const restart =
      flagValue === undefined
        ? { ok: true as const, seconds: INIT_RESTART_SEC_SECONDS }
        : parseRestartSecSeconds(String(flagValue));
    if (!restart.ok) {
      ctx.output.err(`${errorPrefix}: ${restart.problem}`);
      return 1;
    }
    const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
    const route = resolveServiceSetupRoute(owner, capabilities);

    if (route.path === 'manual' && route.reason === 'systemd-absent') {
      ctx.output.err(`${errorPrefix}: ${SYSTEMD_ABSENT_LEAD}`);
      ctx.output.out(
        renderManualRunAlternative(owner.privileges === 'held' ? owner.user.name : undefined),
      );
      return 1;
    }
    if (route.path === 'system-unit') {
      return installSystemUnit(ctx, deps, owner, restart.seconds, errorPrefix);
    }
    return installUserUnit(ctx, deps, owner, restart.seconds, errorPrefix, route.path === 'manual');
  };
}

/** The system-unit install: privileged operations in-process (D-105 vocabulary). */
async function installSystemUnit(
  ctx: CliContext,
  deps: ServiceCommandDeps,
  owner: ServiceOwnerContext,
  restartSecSeconds: number,
  errorPrefix: string,
): Promise<number> {
  const runCommand = deps.runCommand ?? spawnServiceCommand;
  const writeUnitFile = deps.writeUnitFile ?? writeUnitFileToDisk;
  const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
  let content: string;
  try {
    const { nodePath, cliPath } = (deps.execPaths ?? serviceExecPaths)();
    const directories = ownerUnitDirectories(owner.user, deps.pathEnv ?? process.env);
    content = buildSystemUnit({
      nodePath,
      cliPath,
      user: owner.user.name,
      restartSecSeconds,
      configDir: directories.configDir,
      dataDir: directories.dataDir,
    });
  } catch (error) {
    ctx.output.err(
      failureLine(errorPrefix, 'preparing the system unit failed', thrownMessage(error)),
    );
    ctx.output.out(renderManualRunAlternative(owner.user.name));
    return 1;
  }
  const regenerated = unitFileExists(SYSTEM_UNIT_INSTALL_PATH);
  try {
    await writeUnitFile(SYSTEM_UNIT_INSTALL_PATH, content);
  } catch (error) {
    ctx.output.err(
      failureLine(errorPrefix, 'installing the system unit failed', thrownMessage(error)),
    );
    ctx.output.out(renderManualRunAlternative(owner.user.name));
    return 1;
  }
  // daemon-reload makes the (re)written unit visible to the manager;
  // enable --now is a no-op on an already-enabled service, which is the
  // idempotent re-run; is-active is §5.3 step 7's verification, prescribed
  // for the privileged route.
  const reload = await runCommand(SYSTEM_RELOAD_COMMAND);
  if (!reload.ok) {
    ctx.output.err(failureLine(errorPrefix, '`systemctl daemon-reload` failed', reload.detail));
    ctx.output.out(
      renderSystemUnitCompletionSteps(
        'the system unit could not be enabled automatically',
        SYSTEM_UNIT_INSTALL_PATH,
      ),
    );
    return 1;
  }
  const enable = await runCommand(SYSTEM_ENABLE_COMMAND);
  if (!enable.ok) {
    ctx.output.err(
      failureLine(errorPrefix, '`systemctl enable --now quotameter.service` failed', enable.detail),
    );
    ctx.output.out(
      renderSystemUnitCompletionSteps(
        'the system unit could not be enabled automatically',
        SYSTEM_UNIT_INSTALL_PATH,
      ),
    );
    return 1;
  }
  const active = await runCommand(SYSTEM_IS_ACTIVE_COMMAND);
  if (!active.ok) {
    ctx.output.err(
      failureLine(
        errorPrefix,
        'the service was installed and enabled but `systemctl is-active` does not report it active',
        active.detail,
      ),
    );
    ctx.output.out(renderNotActiveSteps());
    return 1;
  }
  // §5.3 step 7's privileged verification, second half (U-059, D-187):
  // after `is-active`, `GET /api/health`. The probe target comes from the
  // owner's configuration — the same §6.1 resolution whose directories are
  // pinned into the unit, read best-effort through init's detection
  // pipeline (one validator, no drift): install's structural independence
  // (D-108 — no configuration is required anywhere here) survives, because
  // a missing or unusable configuration skips the probe with one honest
  // line instead of failing the command — the `is-active` gate above
  // already proved the start. A probe that runs and does not pass within
  // its bound IS a failure of this command's own contract (§5.3's verify).
  const health = await verifyInstalledServiceHealth(ctx, deps, owner, errorPrefix);
  if (health.outcome === 'failed') {
    return 1;
  }
  // The cross-unit check runs after success so a warning never masks a
  // failure. owner.user.home is valid here by construction: the preparation
  // block above validated it through ownerUnitDirectories.
  if (unitFileExists(userUnitInstallPath(owner.user.home))) {
    ctx.output.err(`${errorPrefix}: ${otherUnitWarning('user')}`);
  }
  ctx.output.out(renderSystemUnitInstalled(owner.user.name, SYSTEM_UNIT_INSTALL_PATH, regenerated));
  if (health.outcome === 'passed') {
    const { url } = healthProbeTarget(health.server.host, health.server.port);
    ctx.output.out(renderHealthVerificationPassed(url));
  }
  return 0;
}

/**
 * The system route's §5.3 step-7 health verification (U-059, D-187):
 * resolves the owner's configured endpoint best-effort and probes it.
 * `'skipped'` — no usable configuration — is an honest outcome line, not
 * a failure (D-108's independence: the command never required a
 * configuration, and `is-active` already passed), naming which of absent
 * and invalid it was (review round P3 — the invalid arm carries the
 * detection's own first problem); `'failed'` is the command's failure
 * (stderr + guidance, rendered here); `'passed'` carries the resolved
 * endpoint so the caller can render the URL without a second read.
 */
async function verifyInstalledServiceHealth(
  ctx: CliContext,
  deps: ServiceCommandDeps,
  owner: ServiceOwnerContext,
  errorPrefix: string,
): Promise<
  | { readonly outcome: 'passed'; readonly server: ServerEndpoint }
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'failed' }
> {
  const read = await ownerConfiguration(deps.pathEnv ?? process.env, owner);
  if (read.server === null) {
    ctx.output.out(renderHealthCheckSkipped(read.skipReason));
    return { outcome: 'skipped' };
  }
  const { url } = healthProbeTarget(read.server.host, read.server.port);
  const outcome = await (deps.checkServiceHealth ?? verifyServiceHealth)(
    read.server.host,
    read.server.port,
  );
  if (outcome.state === 'healthy') {
    return { outcome: 'passed', server: read.server };
  }
  ctx.output.err(
    failureLine(
      errorPrefix,
      'the installed service did not pass the /api/health verification',
      outcome.detail,
    ),
  );
  ctx.output.out(renderHealthCheckGuidance(url, HEALTH_CHECK_DEADLINE_MS));
  return { outcome: 'failed' };
}

/** A configured server endpoint (§6.2's `server` section). */
interface ServerEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * The owner's configuration, best-effort, for the system route's health
 * probe (the unit runs as the owner, so the owner's §6.1 paths and
 * configuration are the effective ones; `readExistingConfig` is the same
 * loader pipeline the service and init use — one validator, no drift).
 * `server` is null when no usable configuration exists, with
 * `skipReason` naming which of absent and invalid it was.
 */
async function ownerConfiguration(
  env: PathEnv,
  owner: ServiceOwnerContext,
): Promise<
  | { readonly server: ServerEndpoint; readonly skipReason?: undefined }
  | { readonly server: null; readonly skipReason: string }
> {
  const directories = ownerUnitDirectories(owner.user, env);
  const configFile = configFilePath(directories.configDir);
  const existing = await readExistingConfig(configFile);
  if (existing.state === 'existing') {
    return {
      server: { host: existing.config.server.host, port: existing.config.server.port },
    };
  }
  if (existing.state === 'none') {
    return {
      server: null,
      skipReason: `no configuration exists at ${configFile}, so the endpoint is unknown`,
    };
  }
  return {
    server: null,
    skipReason:
      `the configuration at ${configFile} is not readable as a valid configuration ` +
      `(${existing.problems[0] ?? 'invalid'}), so the endpoint is unknown`,
  };
}

/**
 * The user-unit install: every operation unprivileged (writing under the
 * owner's home and talking to the user manager are owner-identity
 * operations, D-105). `managerless` marks the unreachable-manager route,
 * where the file is still written and the session commands are printed.
 */
async function installUserUnit(
  ctx: CliContext,
  deps: ServiceCommandDeps,
  owner: ServiceOwnerContext,
  restartSecSeconds: number,
  errorPrefix: string,
  managerless: boolean,
): Promise<number> {
  const runCommand = deps.runCommand ?? spawnServiceCommand;
  const writeUnitFile = deps.writeUnitFile ?? writeUnitFileToDisk;
  const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
  let installPath: string;
  let content: string;
  try {
    const { nodePath, cliPath } = (deps.execPaths ?? serviceExecPaths)();
    content = buildUserUnit({ nodePath, cliPath, restartSecSeconds });
    installPath = userUnitInstallPath(owner.user.home);
  } catch (error) {
    ctx.output.err(
      failureLine(errorPrefix, 'installing the user unit failed', thrownMessage(error)),
    );
    ctx.output.out(renderManualRunAlternative());
    return 1;
  }
  // Probed before the write: this run's own file must not count as prior.
  const regenerated = unitFileExists(installPath);
  try {
    await writeUnitFile(installPath, content);
  } catch (error) {
    ctx.output.err(
      failureLine(errorPrefix, 'installing the user unit failed', thrownMessage(error)),
    );
    ctx.output.out(renderManualRunAlternative());
    return 1;
  }
  // §5.3 step 7's linger clause (D-107): a user unit now exists on disk, so
  // the state-driven guidance belongs on every remaining outcome.
  const linger = (deps.probeLinger ?? probeUserLinger)(owner.user.name);
  if (managerless) {
    ctx.output.err(
      `${errorPrefix}: the systemd user manager is not reachable in this session, ` +
        'so the user service could not be enabled automatically',
    );
    ctx.output.out(
      renderUserUnitCompletionSteps(
        owner.user.name,
        installPath,
        'the systemd user manager is not reachable in this session',
        linger,
      ),
    );
    return 1;
  }
  for (const command of [USER_RELOAD_COMMAND, USER_ENABLE_COMMAND]) {
    const outcome = await runCommand(command);
    if (!outcome.ok) {
      ctx.output.err(failureLine(errorPrefix, `\`${command.join(' ')}\` failed`, outcome.detail));
      ctx.output.out(
        renderUserUnitCompletionSteps(
          owner.user.name,
          installPath,
          'the user service could not be enabled automatically',
          linger,
        ),
      );
      return 1;
    }
  }
  if (unitFileExists(SYSTEM_UNIT_INSTALL_PATH)) {
    ctx.output.err(`${errorPrefix}: ${otherUnitWarning('system')}`);
  }
  ctx.output.out(renderUserUnitInstalled(owner.user.name, installPath, regenerated, linger));
  return 0;
}

/** Builds the `service uninstall` handler (§5.2; D-108). */
export function runServiceUninstallCommand(deps: ServiceCommandDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const owner = resolveOwnerForCommand(ctx.output, deps, errorPrefix);
    if (owner === null) {
      return 1;
    }
    const nameProblem = unsafeOwnerNameProblem(owner.user.name);
    if (nameProblem !== null) {
      ctx.output.err(`${errorPrefix}: ${nameProblem}`);
      return 1;
    }
    const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
    const route = resolveServiceSetupRoute(owner, capabilities);
    // The unit kind an invocation owns follows the privileges alone: a
    // privileged run manages the system unit, a regular user their own user
    // unit (D-105 — the regular user cannot reach the system manager, and a
    // privileged run must not reach into the user manager).
    if (owner.privileges === 'held') {
      return uninstallSystemUnit(ctx, deps, owner, route.path, errorPrefix);
    }
    return uninstallUserUnit(ctx, deps, owner, route.path, errorPrefix);
  };
}

/**
 * The system-unit uninstall: disable --now, remove the file, daemon-reload.
 * `routePath === 'manual'` means no system manager is running (systemd
 * absent): the file removal is then the whole uninstall — there is nothing
 * to disable or reload, and a manager that appears later forgets a removed
 * unit on its first daemon-reload anyway.
 */
async function uninstallSystemUnit(
  ctx: CliContext,
  deps: ServiceCommandDeps,
  owner: ServiceOwnerContext,
  routePath: ServiceSetupRoute['path'],
  errorPrefix: string,
): Promise<number> {
  const runCommand = deps.runCommand ?? spawnServiceCommand;
  const removeUnitFile = deps.removeUnitFile ?? removeUnitFileFromDisk;
  const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
  if (!unitFileExists(SYSTEM_UNIT_INSTALL_PATH)) {
    ctx.output.out(renderNothingInstalled('system'));
    // Best-effort cross-unit hint (the system paths above needed nothing
    // from the owner's home, which this one look may not even resolve): an
    // unusable passwd home simply yields no hint, never a failed uninstall.
    try {
      if (unitFileExists(userUnitInstallPath(owner.user.home))) {
        ctx.output.out(renderOtherUnitInstalledHint('user', owner.user.name));
      }
    } catch {
      // no hint — the home directory cannot name a user-unit path
    }
    return 0;
  }
  const managerless = routePath === 'manual';
  const failedCommands: string[] = [];
  if (!managerless) {
    const disable = await runCommand(SYSTEM_DISABLE_COMMAND);
    if (!disable.ok) {
      ctx.output.err(
        failureLine(
          errorPrefix,
          '`systemctl disable --now quotameter.service` failed',
          disable.detail,
        ),
      );
      failedCommands.push(SYSTEM_DISABLE_COMMAND.join(' '));
    }
  }
  try {
    await removeUnitFile(SYSTEM_UNIT_INSTALL_PATH);
  } catch (error) {
    ctx.output.err(
      failureLine(errorPrefix, 'removing the system unit failed', thrownMessage(error)),
    );
    return 1;
  }
  if (!managerless) {
    const reload = await runCommand(SYSTEM_RELOAD_COMMAND);
    if (!reload.ok) {
      ctx.output.err(failureLine(errorPrefix, '`systemctl daemon-reload` failed', reload.detail));
      failedCommands.push(SYSTEM_RELOAD_COMMAND.join(' '));
    }
  }
  ctx.output.out(
    renderSystemUnitUninstalled(SYSTEM_UNIT_INSTALL_PATH, { managerless, failedCommands }),
  );
  return failedCommands.length > 0 ? 1 : 0;
}

/**
 * The user-unit uninstall: the mirror of the user install. On the
 * managerless routes (user manager unreachable, or no systemd at all) the
 * file is removed without manager commands and the outcome says so.
 */
async function uninstallUserUnit(
  ctx: CliContext,
  deps: ServiceCommandDeps,
  owner: ServiceOwnerContext,
  routePath: ServiceSetupRoute['path'],
  errorPrefix: string,
): Promise<number> {
  const runCommand = deps.runCommand ?? spawnServiceCommand;
  const removeUnitFile = deps.removeUnitFile ?? removeUnitFileFromDisk;
  const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
  let installPath: string;
  try {
    installPath = userUnitInstallPath(owner.user.home);
  } catch (error) {
    ctx.output.err(
      failureLine(errorPrefix, 'resolving the user unit path failed', thrownMessage(error)),
    );
    return 1;
  }
  if (!unitFileExists(installPath)) {
    ctx.output.out(renderNothingInstalled('user'));
    if (unitFileExists(SYSTEM_UNIT_INSTALL_PATH)) {
      ctx.output.out(renderOtherUnitInstalledHint('system', owner.user.name));
    }
    return 0;
  }
  const managerless = routePath === 'manual';
  const failedCommands: string[] = [];
  if (!managerless) {
    const disable = await runCommand(USER_DISABLE_COMMAND);
    if (!disable.ok) {
      ctx.output.err(
        failureLine(
          errorPrefix,
          '`systemctl --user disable --now quotameter.service` failed',
          disable.detail,
        ),
      );
      failedCommands.push(USER_DISABLE_COMMAND.join(' '));
    }
  }
  try {
    await removeUnitFile(installPath);
  } catch (error) {
    ctx.output.err(failureLine(errorPrefix, 'removing the user unit failed', thrownMessage(error)));
    return 1;
  }
  if (!managerless) {
    const reload = await runCommand(USER_RELOAD_AFTER_REMOVE_COMMAND);
    if (!reload.ok) {
      ctx.output.err(
        failureLine(errorPrefix, '`systemctl --user daemon-reload` failed', reload.detail),
      );
      failedCommands.push(USER_RELOAD_AFTER_REMOVE_COMMAND.join(' '));
    }
  }
  ctx.output.out(renderUserUnitUninstalled(installPath, { managerless, failedCommands }));
  return failedCommands.length > 0 ? 1 : 0;
}
