/**
 * Command-level argument parsing (task 128, spec §5.2; decision D-044).
 *
 * Built on `node:util` `parseArgs` in strict mode — a standard-library
 * parser, so the CLI adds no dependency and no hand-rolled flag grammar.
 * Every command automatically receives a `-h, --help` boolean; commands
 * declare their own options in the dispatch table (spec §5.2 commands grow
 * theirs in tasks 129–145).
 *
 * `parseArgs` failures become {@link UsageError}s whose message keeps only
 * the first sentence of the Node message (the rest is generic `--`
 * placement advice that would drown the actual problem) with a lowercased
 * first letter, so every usage error reads `quotameter <path>: <message>`.
 */

import { parseArgs } from 'node:util';

/**
 * A usage error: the invocation itself is wrong. Rendered on stderr with a
 * `Try '… --help'` hint and exits with code 2 (decision D-044).
 */
export class UsageError extends Error {
  /** The command path the error belongs to; `[]` for global invocations. */
  readonly commandPath: readonly string[];

  constructor(commandPath: readonly string[], message: string) {
    super(message);
    this.name = 'UsageError';
    this.commandPath = commandPath;
  }
}

/** One option a command accepts (a subset of what `parseArgs` supports). */
export interface CliOption {
  /** `boolean` flags take no value; `string` options consume one. */
  readonly type: 'boolean' | 'string';
  /** Optional short form without the leading dash (for example `p`). */
  readonly short?: string;
  /** One-line explanation shown in the command's help. */
  readonly description?: string;
}

/** Options as the dispatch table declares them. */
export type CliOptions = Readonly<Record<string, CliOption>>;

/** What {@link parseCommandArgs} hands a command handler. */
export interface ParsedArgs {
  /** Option values by long name; absent options are simply missing. */
  readonly flags: Readonly<Record<string, boolean | string>>;
  /** Positional arguments, in order. */
  readonly positionals: readonly string[];
}

/** The option every command gets for free; commands must not reuse `help`. */
const HELP_OPTION: CliOption = { type: 'boolean', short: 'h' };

/** First sentence of `message`, decapitalized — the shared error wording. */
function firstSentence(message: string): string {
  const cut = message.indexOf('. ');
  const first = cut === -1 ? message : message.slice(0, cut);
  return first === '' ? message : first.charAt(0).toLowerCase() + first.slice(1);
}

function describeParseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return firstSentence(message);
}

/**
 * Parses command arguments after the command (and any subcommand) names.
 *
 * Throws {@link UsageError} on an unknown option or on more positionals
 * than the command accepts. The `--help` flag is reported through
 * `flags.help`; the dispatcher decides what to do with it, so a broken flag
 * elsewhere in the same invocation still fails loudly instead of being
 * masked by help output.
 */
export function parseCommandArgs(
  args: readonly string[],
  options: CliOptions,
  commandPath: readonly string[],
  maxPositionals: number,
): ParsedArgs {
  if ('help' in options) {
    // A wiring mistake, not a usage error: fail loudly instead of letting a
    // command silently break the automatic -h/--help.
    throw new Error(
      `option name 'help' is reserved for the automatic -h, --help (command '${commandPath.join(' ')}')`,
    );
  }
  const withHelp: Record<string, CliOption> = { help: HELP_OPTION, ...options };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: withHelp,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError(commandPath, describeParseFailure(error));
  }
  const flags = parsed.values as Record<string, boolean | string>;
  const positionals = [...parsed.positionals];
  if (positionals.length > maxPositionals) {
    // The length guard makes the indexed access total for the
    // non-negative counts the dispatch table declares; no fallback
    // exists to mutate or to hide an impossible `undefined`.
    const extra = positionals[maxPositionals]!;
    throw new UsageError(commandPath, `unexpected argument '${extra}'`);
  }
  return { flags, positionals };
}
