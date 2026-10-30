/**
 * CLI dispatch (task 128, spec §5.2; decision D-044).
 *
 * `runCli` is the callable behind `bin/quotameter.mjs`: it resolves the
 * global flags (`--version`, `--help`), dispatches through the command
 * table, and returns the process exit code — never calling `process.exit`
 * itself (the launcher owns the process, the same contract `runServer`
 * established for the server entry point). Version, output, and the whole
 * command table are injectable, so the dispatch logic is testable
 * in-process and tasks 129–145 plug their real handlers into the same
 * seams without touching this file.
 *
 * Exit codes (decision D-044): 0 success — including help and version
 * output; 1 command failure — a handler error or a not-yet-implemented
 * command; 2 usage error — unknown command, subcommand, or option, a
 * missing subcommand, or an unexpected argument.
 */

import { buildCommandTable, type Command, type LeafCommand } from './commands';
import { renderCommandHelp, renderGeneralHelp, renderGroupHelp } from './help';
import { systemOutput, type CliOutput } from './output';
import { parseCommandArgs, UsageError, type ParsedArgs } from './parser';

/** Everything `runCli` accepts; only `version` is mandatory. */
export interface CliDeps {
  /** Package version, read from `package.json` by the launcher. */
  readonly version: string;
  /** Output seam; defaults to the real process streams. */
  readonly output?: CliOutput;
  /** Command table; defaults to {@link buildCommandTable}. */
  readonly commands?: readonly Command[];
}

/** Renders a usage error (prefix, message, `--help` hint) and returns 2. */
function reportUsageError(output: CliOutput, error: UsageError): number {
  const where = error.commandPath.join(' ');
  const prefix = where === '' ? 'quotameter:' : `quotameter ${where}:`;
  output.err(`${prefix} ${error.message}`);
  output.err(
    where === ''
      ? "Try 'quotameter --help' to list the available commands."
      : `Try 'quotameter ${where} --help'.`,
  );
  return 2;
}

/**
 * Normalizes a thrown value for the `quotameter <path>: <message>` line —
 * the same shape as the server's fatal diagnostics (`AggregateError`s list
 * their causes; the private helper there cannot be imported without
 * modifying a landed module).
 */
function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map((inner) => describeError(inner)).join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Runs one leaf command: parse, help, execute, and report failures as 1. */
async function runLeaf(
  command: LeafCommand,
  commandPath: readonly string[],
  args: readonly string[],
  deps: CliDeps,
  output: CliOutput,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(args, command.options, commandPath, command.maxPositionals);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return reportUsageError(output, error);
  }
  if (parsed.flags.help === true) {
    output.out(renderCommandHelp(command, commandPath));
    return 0;
  }
  try {
    return await command.run({
      output,
      version: deps.version,
      commandPath,
      flags: parsed.flags,
      positionals: parsed.positionals,
    });
  } catch (error) {
    output.err(`quotameter ${commandPath.join(' ')}: ${describeError(error)}`);
    return 1;
  }
}

/**
 * Dispatches `argv` (the arguments after `quotameter`) and returns the exit
 * code. Global flags are checked before command lookup; `--version` wins
 * over `--help` so the launcher's fast path and this dispatch agree on
 * mixed invocations. No arguments at all prints the general help and
 * succeeds — an empty invocation is a question, not an error.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const output = deps.output ?? systemOutput();
  const commands = deps.commands ?? buildCommandTable();

  const first = argv[0];
  if (first === '--version' || first === '-v') {
    output.out(deps.version);
    return 0;
  }
  if (first === undefined || first === '--help' || first === '-h') {
    output.out(renderGeneralHelp(commands));
    return 0;
  }
  if (first.startsWith('-')) {
    // The end-of-options marker is not an option; say what it actually is.
    const problem = first === '--' ? `unexpected argument '${first}'` : `unknown option '${first}'`;
    return reportUsageError(output, new UsageError([], problem));
  }

  const command = commands.find((entry) => entry.name === first);
  if (command === undefined) {
    return reportUsageError(output, new UsageError([], `unknown command '${first}'`));
  }

  if (command.kind === 'group') {
    const rest = argv.slice(1);
    const subName = rest[0];
    if (subName === '--help' || subName === '-h') {
      output.out(renderGroupHelp(command));
      return 0;
    }
    if (subName === undefined) {
      const names = command.subcommands.map((sub) => sub.name).join(', ');
      return reportUsageError(
        output,
        new UsageError([command.name], `a subcommand is required (${names})`),
      );
    }
    if (subName.startsWith('-')) {
      const problem =
        subName === '--' ? `unexpected argument '${subName}'` : `unknown option '${subName}'`;
      return reportUsageError(output, new UsageError([command.name], problem));
    }
    const sub = command.subcommands.find((entry) => entry.name === subName);
    if (sub === undefined) {
      return reportUsageError(
        output,
        new UsageError([command.name], `unknown subcommand '${subName}'`),
      );
    }
    return runLeaf(sub, [command.name, sub.name], rest.slice(1), deps, output);
  }

  return runLeaf(command, [command.name], argv.slice(1), deps, output);
}
