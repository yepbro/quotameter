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

/**
 * The §5.2 command set, in spec order. Service control (`start`, `stop`,
 * `restart`) and unit management (`service install`/`uninstall`) are
 * separate rows because the spec lists them as distinct commands.
 */
export function buildCommandTable(): Command[] {
  return [
    stub('init', 'First-time configuration and service setup', ['init']),
    stub('run', 'Foreground execution for systemd and debugging', ['run']),
    stub('start', 'Start an installed service through systemd', ['start']),
    stub('stop', 'Stop an installed service through systemd', ['stop']),
    stub('restart', 'Restart an installed service through systemd', ['restart']),
    stub('reload', 'Reload configuration on SIGHUP without restarting where supported', ['reload']),
    stub('status', 'Show service status, latest collection, and last error for each account', [
      'status',
    ]),
    stub('logs', 'Convenient journalctl wrapper for system or user service', ['logs']),
    {
      kind: 'group',
      name: 'service',
      summary: 'Install or remove the service independently of init',
      subcommands: [
        stub('install', 'Install the systemd service unit', ['service', 'install']),
        stub('uninstall', 'Remove the installed systemd service unit', ['service', 'uninstall']),
      ],
    },
    stub('passwd', 'Set or change the web password', ['passwd']),
    stub(
      'doctor',
      'Diagnose runtime, configuration, database, network, credentials, and service issues',
      ['doctor'],
    ),
  ];
}
