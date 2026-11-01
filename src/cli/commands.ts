/**
 * The command dispatch table (task 128, spec §5.2; decision D-044).
 *
 * Every `quotameter` command of spec §5.2 is registered here with its
 * summary line, its option declarations, and a handler. The handler bodies
 * are tasks 129–145: until they land, every entry points at the shared
 * {@link notImplemented} stub, which reports through the same output
 * contract as a real command and exits 1. A task replaces exactly one
 * stub with a real `run` (and adds its options) — the dispatch layer never
 * changes shape.
 *
 * Handlers are plain data in a table so tests and embedders can inject a
 * whole table of fakes into `runCli` without touching the process.
 */

import type { CliOutput } from './output';
import type { CliOptions } from './parser';
import { runInitCommand } from './init';
import { runServiceControlCommand, type ServiceControlVerb } from './service-control';
import { runServiceInstallCommand, runServiceUninstallCommand } from './service-install';
import { runReloadCommand } from './service-reload';
import { runStatusCommand } from './service-status';
import { INIT_RESTART_SEC_SECONDS } from './service-setup';

/** Everything a command handler receives; injected by the dispatcher. */
export interface CliContext {
  /** The output seam — the only way a handler reaches the terminal. */
  readonly output: CliOutput;
  /** Package version, supplied by the launcher (`bin/quotameter.mjs`). */
  readonly version: string;
  /** Full command path, for example `['service', 'install']`. */
  readonly commandPath: readonly string[];
  /** Parsed option values by long name. */
  readonly flags: Readonly<Record<string, boolean | string>>;
  /** Positional arguments the command accepted. */
  readonly positionals: readonly string[];
}

/** A command handler: returns the process exit code. */
export type CliHandler = (ctx: CliContext) => Promise<number>;

/** A command invoked directly, for example `quotameter status`. */
export interface LeafCommand {
  readonly kind: 'leaf';
  readonly name: string;
  /** One-line purpose shown in help; wording follows spec §5.2. */
  readonly summary: string;
  /** Options beyond the automatic `-h, --help`. */
  readonly options: CliOptions;
  /** How many positional arguments the command accepts. */
  readonly maxPositionals: number;
  readonly run: CliHandler;
}

/**
 * A command that only dispatches to subcommands (`quotameter service
 * install`); spec §5.2 defines exactly one nesting level.
 */
export interface CommandGroup {
  readonly kind: 'group';
  readonly name: string;
  readonly summary: string;
  readonly subcommands: readonly LeafCommand[];
}

/** One row of the dispatch table. */
export type Command = LeafCommand | CommandGroup;

/**
 * The stub every command starts with: the invocation is valid usage, the
 * feature is simply not built yet, so the message goes to stderr with the
 * standard prefix and the exit code is 1 (not the usage-error 2).
 */
export function notImplemented(commandPath: readonly string[]): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    ctx.output.err(`quotameter ${commandPath.join(' ')}: not implemented yet`);
    return 1;
  };
}

/** Builds a stub-backed leaf command; helper for the table below. */
function stub(name: string, summary: string, commandPath: readonly string[]): LeafCommand {
  return {
    kind: 'leaf',
    name,
    summary,
    options: {},
    maxPositionals: 0,
    run: notImplemented(commandPath),
  };
}

/** The §5.2 summaries of the three service-control verbs, pinned per verb. */
const CONTROL_SUMMARIES: Readonly<Record<ServiceControlVerb, string>> = {
  start: 'Start an installed service through systemd',
  stop: 'Stop an installed service through systemd',
  restart: 'Restart an installed service through systemd',
};

/** Builds one of the §5.2 service-control leaves (task 140, D-110). */
function serviceControlLeaf(verb: ServiceControlVerb): LeafCommand {
  return {
    kind: 'leaf',
    name: verb,
    summary: CONTROL_SUMMARIES[verb],
    options: {},
    maxPositionals: 0,
    run: runServiceControlCommand(verb),
  };
}

/**
 * The §5.2 command set, in spec order. Service control (`start`, `stop`,
 * `restart`) and unit management (`service install`/`uninstall`) are
 * separate rows because the spec lists them as distinct commands.
 */
export function buildCommandTable(): Command[] {
  return [
    // Tasks 130–131 (spec §5.3): the interactive question flow and the
    // non-interactive --yes layer (decision D-100). --yes is required for
    // any of the value options; --timezone is mandatory in that mode.
    {
      kind: 'leaf',
      name: 'init',
      summary: 'First-time configuration and service setup',
      options: {
        yes: {
          type: 'boolean',
          short: 'y',
          description: 'Non-interactive mode: take every value from the options below',
        },
        timezone: {
          type: 'string',
          description: 'IANA time zone, required with --yes (e.g. Europe/Berlin)',
        },
        host: { type: 'string', description: 'Bind host (default 127.0.0.1)' },
        port: { type: 'string', description: 'Bind port, 1-65535 (default 8787)' },
        'polling-interval': {
          type: 'string',
          description: 'Polling interval in seconds, 60-3600 (default 300)',
        },
        'account-label': {
          type: 'string',
          description: 'Label of the optional initial Z.ai account',
        },
        'api-key-env': {
          type: 'string',
          description:
            'Environment variable supplying the initial account key (by name, never a value)',
        },
      },
      maxPositionals: 0,
      run: runInitCommand(),
    },
    stub('run', 'Foreground execution for systemd and debugging', ['run']),
    // Task 140 (spec §5.2, decision D-110): start/stop/restart control the
    // currently installed unit — the manager scope (system vs --user) comes
    // from which unit file is on disk, not from this invocation's
    // privileges; §5.2's helpful next step covers the not-installed case.
    serviceControlLeaf('start'),
    serviceControlLeaf('stop'),
    serviceControlLeaf('restart'),
    // Task 141 (spec §5.2, §6.4; decision D-112): pre-flight validation plus
    // SIGHUP to the RUNNING service, discovered through the §5.6 lock —
    // run-mode-independent (systemd or foreground), unlike the manager-
    // scoped verbs above.
    {
      kind: 'leaf',
      name: 'reload',
      summary: 'Reload configuration on SIGHUP without restarting where supported',
      options: {},
      maxPositionals: 0,
      run: runReloadCommand(),
    },
    // Task 142 (spec §5.2/§7.3; decision D-114): the status report — the
    // installed scope (139/140's disk discovery), the manager view, the
    // running state through the §5.6 lock (141's reader), and every
    // account's §7.3 status, last collection, and last error; §5.2 defines
    // no options for the command.
    {
      kind: 'leaf',
      name: 'status',
      summary: 'Show service status, latest collection, and last error for each account',
      options: {},
      maxPositionals: 0,
      run: runStatusCommand(),
    },
    stub('logs', 'Convenient journalctl wrapper for system or user service', ['logs']),
    {
      kind: 'group',
      name: 'service',
      summary: 'Install or remove the service independently of init',
      subcommands: [
        // Task 139 (spec §5.2/§5.4, decision D-108): idempotent install that
        // regenerates the unit on re-run (§5.4's stale-path remedy) and its
        // uninstall twin; both route system vs user unit through the landed
        // owner/capability layers, independently of `init`.
        {
          kind: 'leaf',
          name: 'install',
          summary: 'Install the systemd service unit',
          options: {
            'restart-sec': {
              type: 'string',
              description: `Restart delay in seconds, >= 1 (default ${INIT_RESTART_SEC_SECONDS})`,
            },
          },
          maxPositionals: 0,
          run: runServiceInstallCommand(),
        },
        {
          kind: 'leaf',
          name: 'uninstall',
          summary: 'Remove the installed systemd service unit',
          options: {},
          maxPositionals: 0,
          run: runServiceUninstallCommand(),
        },
      ],
    },
    stub('passwd', 'Set or change the web password', ['passwd']),
    // Doctor's option surface is declared now because spec §5.5/§7.4 fix it
    // (`quotameter doctor --raw <account>` — the CLI-only raw-payload
    // diagnostic, fed by `src/cli/raw-diagnostics.ts`, task 103); the
    // handler itself stays a stub until task 145 implements the checks.
    {
      kind: 'leaf',
      name: 'doctor',
      summary:
        'Diagnose runtime, configuration, database, network, credentials, and service issues',
      options: {
        raw: {
          type: 'string',
          description: 'Show sanitized provider responses stored for parse failures of <account>',
        },
      },
      maxPositionals: 0,
      run: notImplemented(['doctor']),
    },
  ];
}
