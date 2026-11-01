/**
 * The `init` service-setup branch layer (task 137, spec §5.3 step 7; decision
 * D-106) — the routing between §5.3 step 7's three install outcomes.
 *
 * §5.3 step 7: "Install and enable a service when possible": with privileges
 * the system unit is installed for the owner; **without sudo** a user unit is
 * installed under `~/.config/systemd/user/` and enabled through
 * `systemctl --user enable --now`; **if systemd is unavailable or the
 * installation fails, provide exact manual-run instructions**. This module
 * decides which of those paths applies and carries it out for the two
 * fallback paths it owns:
 *
 * - **`user-unit`** (no sudo, systemd reachable): the user service is
 *   installed **without any privileged operation** — the unit content comes
 *   from task 135's generator, the file lands under the owner's home, and
 *   `systemctl --user daemon-reload` + `enable --now` run as the regular
 *   owner (everything a service setup touches outside D-105's frozen
 *   privileged vocabulary). A failure anywhere in the install falls back to
 *   the exact manual completion steps (§5.3's "or installation fails"
 *   clause).
 * - **`manual`** (systemd absent, or the user manager unreachable without
 *   sudo): rendered exact commands only — zero side effects. A privileged
 *   run on a systemd-less machine is told to initialize and run from the
 *   owner's regular account instead: this sudo run's configuration file is
 *   root-owned `0600` wherever the privileged environment placed it, so no
 *   regular account — the only kind §5.1 allows to run the service — can
 *   use it (making the owner's writes owner-readable is the privileged
 *   flow's path/ownership machinery, task 139's).
 *
 * The **`system-unit`** route (privileges held, systemd present) is routed
 * and its plan rendered, but the privileged operations themselves —
 * installing `/etc/systemd/system/quotameter.service`, `daemon-reload`,
 * enable/start, the `systemctl is-active` and `/api/health` verification —
 * are **not executed here**: they belong to the install machinery of task
 * 139 (`quotameter service install`, §5.2), and this task's scope is the
 * fallback decision paths. The plan therefore names the §5.2 command that
 * performs them.
 *
 * The owner's account name reaches rendered command text (the linger and
 * manual-run commands), so the step refuses a name outside the POSIX
 * account-name grammar — a whitespace- or metacharacter-carrying `/etc/
 * passwd` row would make the printed commands non-copy-pasteable or worse
 * (review-round P1): one stderr problem, no commands rendered, no side
 * effects.
 *
 * The linger guidance is **detected, not unconditional** (task 138,
 * `service-linger.ts`, decision D-107): on the paths where a user unit
 * exists to keep alive — the installed outcome and the manual completion
 * steps — the step probes the owner's linger state once through the
 * injectable seam and renders per state: the exact `sudo loginctl
 * enable-linger <user>` command with the logout/reboot consequence when
 * linger is disabled (or undeterminable — unknown never silently counts
 * as enabled), a plain confirmation with no command when it is already
 * enabled. The outputs where no user service can linger (systemd absent,
 * the foreground fallback, the system-unit route) carry no linger note.
 *
 * Everything with side effects is an injectable seam with a production
 * default: the capability probes read two well-known paths (no systemd
 * needed to test), and the development container and CI images — which ship
 * no systemd and no sudo — deterministically take the `manual` route, whose
 * rendering performs no I/O at all.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CliOutput } from './output';
import type { EnvSnapshot, ServiceOwnerContext } from './service-owner';
import { probeUserLinger, renderLingerGuidance, type LingerState } from './service-linger';
import type { UserLingerProbe } from './service-linger';
import { SYSTEM_UNIT_INSTALL_PATH } from './systemd-unit';
import { buildUserUnit, userUnitInstallPath, USER_UNIT_NAME } from './systemd-user-unit';

/**
 * The marker systemd itself creates when it runs as the init system
 * (`systemctl` consults the same directory): its presence is the canonical
 * "a system service manager exists" fact §5.3 step 1 asks init to check.
 */
export const SYSTEMD_RUN_MARKER_PATH = '/run/systemd/system';

/** The capabilities the route decision needs (spec §5.3 steps 1 and 7). */
export interface ServiceCapabilities {
  /** A system service manager is running (init is systemd). */
  readonly systemd: boolean;
  /**
   * The owner's per-user service manager is reachable: an own, non-empty
   * `XDG_RUNTIME_DIR` whose `systemd` runtime directory exists — the same
   * reachability signal `systemctl --user` itself uses. Without a runtime
   * directory (cron, some ssh setups) no user unit can be enabled.
   */
  readonly userManager: boolean;
}

/** Injectable collaborators of {@link probeServiceCapabilities}. */
export interface CapabilitySeams {
  /** The environment `XDG_RUNTIME_DIR` is read from; production `process.env`. */
  readonly env?: EnvSnapshot;
  /** Path-existence check; production `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Probes the machine's service-management capabilities (spec §5.3 step 1).
 * Pure over the seams, so every combination is testable on the systemd-less
 * container and CI images.
 */
export function probeServiceCapabilities(seams: CapabilitySeams = {}): ServiceCapabilities {
  const exists = seams.exists ?? existsSync;
  const env = seams.env ?? process.env;
  // Own-property read (the init-yes.ts / service-owner.ts discipline): an
  // inherited `XDG_RUNTIME_DIR` must not masquerade as a login session.
  const runtimeDir = Object.hasOwn(env, 'XDG_RUNTIME_DIR') ? env.XDG_RUNTIME_DIR : undefined;
  return {
    systemd: exists(SYSTEMD_RUN_MARKER_PATH),
    userManager:
      runtimeDir !== undefined && runtimeDir !== '' && exists(join(runtimeDir, 'systemd')),
  };
}

/** Why service installation is unavailable on the manual route. */
export type ManualSetupReason =
  /** No system service manager at all — nothing to install into. */
  | 'systemd-absent'
  /** systemd runs, but without sudo only a user unit is possible and its manager is unreachable. */
  | 'user-manager-unavailable';

/** The §5.3 step 7 route this machine and invocation take. */
export type ServiceSetupRoute =
  /** Privileges held and systemd present — the system-unit flow (task 139's machinery). */
  | { readonly path: 'system-unit' }
  /** No privileges, systemd present, user manager reachable — install without sudo here. */
  | { readonly path: 'user-unit' }
  /** Installation unavailable — render the exact manual steps. */
  | { readonly path: 'manual'; readonly reason: ManualSetupReason };

/**
 * Decides the §5.3 step 7 route from the resolved owner context and the
 * probed capabilities. Privileges beat the user manager: a `sudo quotameter
 * init` on a systemd machine installs the system unit even where a user
 * manager also exists (§5.3 step 7 lists the privileged route first); the
 * user manager only matters on the no-sudo route, where it is the difference
 * between installing the user unit and printing manual steps.
 */
export function resolveServiceSetupRoute(
  context: ServiceOwnerContext,
  capabilities: ServiceCapabilities,
): ServiceSetupRoute {
  if (!capabilities.systemd) return { path: 'manual', reason: 'systemd-absent' };
  if (context.privileges === 'held') return { path: 'system-unit' };
  if (!capabilities.userManager) return { path: 'manual', reason: 'user-manager-unavailable' };
  return { path: 'user-unit' };
}

/**
 * The restart delay `init`'s inline user-unit install pins (decision D-106).
 * D-103 deliberately keeps no default inside the generator — the value is a
 * CLI-level choice, and the configurable flag surface belongs to task 139,
 * which should align its default here rather than grow a second one.
 */
export const INIT_RESTART_SEC_SECONDS = 5;

/**
 * How much stderr {@link spawnServiceCommand} ever buffers: the failure
 * detail is one trimmed line capped far below this, so a few kilobytes
 * preserve full lines while a malfunctioning child streaming megabytes
 * cannot grow the buffer (review-round P2).
 */
const STDERR_CAPTURE_CAP = 8192;

/**
 * The POSIX account-name grammar the rendered commands interpolate
 * (review-round P1): `/etc/passwd` rows only promise a non-empty name, but
 * `sudo loginctl enable-linger <name>` and friends are copy-paste shell
 * text — a whitespace, leading-dash, or metacharacter name would make them
 * non-copy-pasteable or inject additional syntax when pasted. The step
 * refuses such a name with one stderr problem instead of rendering it.
 */
const OWNER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The guard behind {@link OWNER_NAME_PATTERN}: the problem string for an
 * unsafe owner name (JSON-quoted, so the offending name cannot smuggle
 * control characters into the message), or null when the name is safe.
 */
export function unsafeOwnerNameProblem(name: string): string | null {
  if (OWNER_NAME_PATTERN.test(name)) return null;
  return (
    `the service owner's account name ${JSON.stringify(name)} is not a plain POSIX account name ` +
    '(letters, digits, underscore, hyphen, not starting with a digit or hyphen) — fix the user ' +
    'database entry before setting up the service; no commands are printed for it'
  );
}

/** The outcome of one service command, as the step needs it for messages. */
export interface CommandOutcome {
  readonly ok: boolean;
  /**
   * One bounded diagnostic line (first non-empty stderr line, capped) for
   * failure messages; empty on success. Commands here carry no secrets
   * (§5.4 holds by construction), but stderr is still trimmed to a single
   * line so a failing `systemctl` cannot flood the terminal.
   */
  readonly detail: string;
}

/** Runs one service command; production spawns the real binary. */
export type ServiceCommandRunner = (command: readonly string[]) => Promise<CommandOutcome>;

/** Writes one unit file; production creates the directory and the file. */
export type ServiceUnitWriter = (installPath: string, content: string) => Promise<void>;

/** The absolute paths §5.4 pins into the generated unit's `ExecStart`. */
export interface ServiceExecPaths {
  readonly nodePath: string;
  readonly cliPath: string;
}

/**
 * The production execution paths: the running Node binary and the CLI entry
 * the launcher was started from. `process.argv[1]` is always the launcher
 * path when a command handler runs (`bin/quotameter.mjs`, under jiti in
 * development and as the published entry after the build) — the non-null
 * assertion states that invariant (the U-009 house pattern, no defensive
 * fallback arm).
 */
export function serviceExecPaths(): ServiceExecPaths {
  return { nodePath: process.execPath, cliPath: resolve(process.argv[1]!) };
}

/** Injectable collaborators of {@link runServiceSetupStep}. */
export interface ServiceSetupSeams {
  readonly runCommand?: ServiceCommandRunner;
  readonly writeUnitFile?: ServiceUnitWriter;
  readonly execPaths?: () => ServiceExecPaths;
  /**
   * The §5.3 step 7 linger-state probe (task 138, D-107); production
   * `probeUserLinger` — the flag-file stat under `/var/lib/systemd/linger`.
   */
  readonly probeLinger?: UserLingerProbe;
  /** The stderr-line prefix for this step's failures; init passes its own. */
  readonly errorPrefix?: string;
}

/**
 * The bounded first diagnostic line of `stderr`-shaped text: the first
 * non-empty line, trimmed and capped, so a failing command contributes one
 * readable line to the explanation instead of its whole output.
 */
function firstDiagnosticLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, 200);
  }
  return '';
}

/**
 * The production command runner: spawns the command, ignores its stdout
 * (the caller renders what happened, not the command's chatter), and keeps
 * stderr for the failure detail — captured only up to a small cap while
 * streaming, so a malfunctioning child cannot buffer unbounded output in
 * memory (review-round P2). A spawn error (missing binary, closed runtime)
 * resolves as a normal failure — the step's fallback handles it like any
 * other installation failure, exactly §5.3's "installation fails".
 */
export function spawnServiceCommand(command: readonly string[]): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let buffered = 0;
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep at most the first cap worth of stderr; the detail line is a
      // single trimmed line anyway.
      if (buffered < STDERR_CAPTURE_CAP) {
        stderr.push(chunk);
        buffered += chunk.length;
      }
    });
    child.once('error', (error: Error) => {
      resolve({ ok: false, detail: firstDiagnosticLine(error.message) });
    });
    child.once('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ok: true, detail: '' });
        return;
      }
      const detail =
        firstDiagnosticLine(Buffer.concat(stderr).toString('utf8')) ||
        (code === null ? 'the command was terminated' : `exit status ${code}`);
      resolve({ ok: false, detail });
    });
  });
}

/**
 * The production unit-file writer: creates the unit directory (the owner's
 * `~/.config/systemd/user/` — `userUnitInstallPath` composes it) and writes
 * the content. Unit files carry no secrets (§5.4, by construction of the
 * D-103/D-104 inputs), so the conventional world-readable `0644` is right;
 * rewriting an existing file keeps its mode, which task 139's idempotent
 * install owns.
 */
export async function writeUnitFileToDisk(installPath: string, content: string): Promise<void> {
  await mkdir(dirname(installPath), { recursive: true });
  await writeFile(installPath, content, { mode: 0o644 });
}

/**
 * Renders the `system-unit` plan: what the privileged flow does and which
 * §5.2 command performs it. The operations are deliberately not executed by
 * this task — they are task 139's install machinery; the plan names the
 * target path, the owner the unit runs as, and the verification §5.3
 * prescribes, and directs to the completing command from the regular
 * account (the privileged operations need sudo again, and §5.1 forbids the
 * service itself from ever running as root).
 */
export function renderSystemUnitPlan(ownerName: string): string {
  return [
    `Service setup: this run holds root privileges, so the system service can be installed for ${ownerName}.`,
    `The privileged flow installs ${SYSTEM_UNIT_INSTALL_PATH} with User=${ownerName}, reloads systemd,`,
    'enables and starts the service, and verifies it (systemctl is-active and /api/health).',
    'From your regular account, run:',
    '  sudo quotameter service install',
  ].join('\n');
}

/**
 * Renders the successful no-sudo outcome: the installed unit's location, the
 * command that enabled and started it, and the detected linger guidance
 * (task 138: the exact enable-linger command with the logout/reboot
 * consequence unless linger is already on).
 */
export function renderUserUnitInstalled(
  ownerName: string,
  installPath: string,
  linger: LingerState,
): string {
  return [
    `Service setup: installed the user service for ${ownerName} — no sudo needed.`,
    `Unit file: ${installPath}`,
    `Enabled and started with: systemctl --user enable --now ${USER_UNIT_NAME}`,
    renderLingerGuidance(ownerName, linger),
  ].join('\n');
}

/**
 * Renders the manual completion steps when the unit file exists on disk but
 * could not be enabled now (manager unreachable without sudo, or an enable
 * command failed): the exact commands for a logged-in session, the
 * detected linger guidance (task 138), and the foreground alternative.
 * `lead` states why — the two callers (unreachable manager, failed
 * command) explain themselves differently.
 */
export function renderUserUnitCompletionSteps(
  ownerName: string,
  installPath: string,
  lead: string,
  linger: LingerState,
): string {
  return [
    `Service setup: ${lead}`,
    `The unit file is written to ${installPath}. Once you have a login session, run:`,
    '  systemctl --user daemon-reload',
    `  systemctl --user enable --now ${USER_UNIT_NAME}`,
    renderLingerGuidance(ownerName, linger),
    'To run the service in the foreground in the meantime:',
    '  quotameter run',
  ].join('\n');
}

/**
 * Renders the manual foreground steps for a regular user: why no service
 * is installed (`lead`) and the exact foreground command. Only regular-user
 * invocations reach the write-failure fallback that shares this renderer —
 * a privileged run renders {@link renderHeldManualSetup} instead — so the
 * command is always the plain owner-typed one.
 */
export function renderManualRunSteps(lead: string): string {
  return [
    `Service setup: ${lead}`,
    'Run it manually with:',
    '  quotameter run',
    'This runs in the foreground and stops when its session ends.',
  ].join('\n');
}

/**
 * Renders the systemd-less fallback for a privileged run (review-round P1):
 * this run wrote its configuration as root — the file is root-owned `0600`
 * wherever the privileged environment placed it, so no regular account can
 * read it, and §5.1 forbids the service from ever running as root. The
 * honest, actionable steps therefore re-initialize from the owner's own
 * account (which places the configuration where the owner's service reads
 * it, owned by the owner) and run there; making a privileged run's writes
 * owner-readable is the privileged flow's path/ownership machinery, task
 * 139's.
 */
export function renderHeldManualSetup(ownerName: string): string {
  return [
    'Service setup: systemd is not available on this machine, so the service cannot be installed here.',
    `This run used root privileges, and the configuration it wrote is not readable by a regular account — the service itself must never run as root.`,
    `Initialize and run from ${ownerName}'s regular account instead:`,
    '  quotameter init',
    '  quotameter run',
  ].join('\n');
}

/** A failure line for stderr, one bounded diagnostic included. */
function failureLine(errorPrefix: string, what: string, detail: string): string {
  return detail === '' ? `${errorPrefix}: ${what}` : `${errorPrefix}: ${what} (${detail})`;
}

/** The message of a thrown value, type-honestly (the init-account.ts pattern). */
function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the §5.3 step 7 service-setup branch for a resolved owner context:
 * routes, then installs the user unit without sudo (falling back to the
 * exact manual steps on any failure) or renders the route's output. The
 * step asks no questions and never throws — unit preparation (path
 * validation included) and the installation itself are one failure domain:
 * any throw or failed command is a rendered fallback, not a failed init
 * (the configuration is already written; §5.3 treats the manual
 * instructions as the designed outcome).
 *
 * Owner-context problems never reach this function: `init` resolves the
 * owner first and reports problems itself (D-105's contract). An owner
 * name outside the POSIX account grammar is refused here — it would be
 * interpolated into copy-paste command text (and into the linger probe's
 * flag-file path).
 */
export async function runServiceSetupStep(
  output: CliOutput,
  context: ServiceOwnerContext,
  capabilities: ServiceCapabilities,
  seams: ServiceSetupSeams = {},
): Promise<void> {
  const runCommand = seams.runCommand ?? spawnServiceCommand;
  const writeUnitFile = seams.writeUnitFile ?? writeUnitFileToDisk;
  const errorPrefix = seams.errorPrefix ?? 'quotameter init';
  const nameProblem = unsafeOwnerNameProblem(context.user.name);
  if (nameProblem !== null) {
    output.err(`${errorPrefix}: ${nameProblem}`);
    return;
  }
  const route = resolveServiceSetupRoute(context, capabilities);

  if (route.path === 'system-unit') {
    output.out(renderSystemUnitPlan(context.user.name));
    return;
  }
  if (route.path === 'manual' && route.reason === 'systemd-absent') {
    output.out(
      context.privileges === 'held'
        ? renderHeldManualSetup(context.user.name)
        : renderManualRunSteps(
            'systemd is not available on this machine, so the service cannot be installed here',
          ),
    );
    return;
  }

  // The remaining routes both write the user unit under the owner's home
  // (no sudo, no manager needed for the write itself): the unreachable
  // manager renders the enable commands as manual steps, the `user-unit`
  // route goes on to enable the service as the owner. Every operation here
  // is unprivileged; any failure — preparing the content and its paths
  // included, so a hostile home directory cannot crash the step — falls
  // back to exact manual steps.
  let installPath: string;
  try {
    const { nodePath, cliPath } = (seams.execPaths ?? serviceExecPaths)();
    const content = buildUserUnit({
      nodePath,
      cliPath,
      restartSecSeconds: INIT_RESTART_SEC_SECONDS,
    });
    installPath = userUnitInstallPath(context.user.home);
    await writeUnitFile(installPath, content);
  } catch (error) {
    output.err(
      failureLine(
        errorPrefix,
        'installing the user unit failed — falling back to manual-run instructions',
        thrownMessage(error),
      ),
    );
    output.out(renderManualRunSteps('the user unit could not be installed on this machine'));
    return;
  }
  // §5.3 step 7's linger clause (task 138, D-107): every branch that
  // remains renders the state-driven linger guidance — the unit file is on
  // disk and will run under the user manager, whose survival past the
  // owner's logout is exactly the linger question — so the state is probed
  // once here. The write-failure fallback above renders no linger note:
  // with no unit installed there is nothing for linger to keep alive, and
  // the probe never runs there.
  const linger = (seams.probeLinger ?? probeUserLinger)(context.user.name);
  if (route.path === 'manual') {
    // The manager is unreachable, but writing the unit file needs no
    // manager — the owner gets the exact enable commands for their next
    // login session instead of an installation that did half of nothing.
    output.out(
      renderUserUnitCompletionSteps(
        context.user.name,
        installPath,
        'the systemd user manager is not reachable in this session, so the user service could not be enabled automatically',
        linger,
      ),
    );
    return;
  }
  for (const command of [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', USER_UNIT_NAME],
  ] as const) {
    const outcome = await runCommand(command);
    if (!outcome.ok) {
      output.err(
        failureLine(
          errorPrefix,
          `the user service could not be enabled automatically — \`${command.join(' ')}\` failed`,
          outcome.detail,
        ),
      );
      output.out(
        renderUserUnitCompletionSteps(
          context.user.name,
          installPath,
          'the user service could not be enabled automatically',
          linger,
        ),
      );
      return;
    }
  }
  output.out(renderUserUnitInstalled(context.user.name, installPath, linger));
}
