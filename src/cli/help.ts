/**
 * Help renderers (task 128, spec §5.2; decision D-044).
 *
 * Pure functions from the dispatch table to English help text: general
 * help, command help, and group (`service`) help. All output flows through
 * the caller's {@link CliOutput} seam — these functions only build strings,
 * which keeps the exact wording unit-testable.
 */

import type { Command, CommandGroup, LeafCommand } from './commands';
import type { CliOptions } from './parser';

/** Renders the option list every command help shows, `-h, --help` first. */
function renderOptions(options: CliOptions): string {
  const rows: Array<{ flag: string; description: string }> = [
    { flag: '-h, --help', description: 'Show this help' },
  ];
  for (const [name, option] of Object.entries(options)) {
    const short = option.short === undefined ? '    ' : `-${option.short}, `;
    const value = option.type === 'string' ? ' <value>' : '';
    rows.push({ flag: `${short}--${name}${value}`, description: option.description ?? '' });
  }
  const width = Math.max(...rows.map((row) => row.flag.length)) + 2;
  return rows.map((row) => `  ${row.flag.padEnd(width)}${row.description}`.trimEnd()).join('\n');
}

/** Renders `name  summary` rows aligned to the widest name. */
function renderRows(rows: readonly { name: string; summary: string }[]): string {
  const width = Math.max(...rows.map((row) => row.name.length)) + 2;
  return rows.map((row) => `  ${row.name.padEnd(width)}${row.summary}`).join('\n');
}

/** The general help shown for `quotameter`, `quotameter --help`, or no args. */
export function renderGeneralHelp(commands: readonly Command[]): string {
  const rows = commands.map((command) => ({
    name: command.name,
    summary:
      command.kind === 'group'
        ? `${command.summary} (subcommands: ${command.subcommands
            .map((sub) => sub.name)
            .join(', ')})`
        : command.summary,
  }));
  return [
    'Usage: quotameter <command> [options]',
    '       quotameter service <subcommand> [options]',
    '',
    'Quotameter — self-hosted usage quota monitoring for AI subscriptions.',
    '',
    'Commands:',
    renderRows(rows),
    '',
    'Options:',
    '  -h, --help     Show this help; after a command name, help for that command',
    '  -v, --version  Print the CLI version',
  ].join('\n');
}

/** The help shown for `quotameter <command> --help`. */
export function renderCommandHelp(command: LeafCommand, commandPath: readonly string[]): string {
  return [
    `Usage: quotameter ${commandPath.join(' ')} [options]`,
    '',
    command.summary + '.',
    '',
    'Options:',
    renderOptions(command.options),
  ].join('\n');
}

/** The help shown for `quotameter service --help`. */
export function renderGroupHelp(group: CommandGroup): string {
  return [
    `Usage: quotameter ${group.name} <subcommand> [options]`,
    '',
    group.summary + '.',
    '',
    'Subcommands:',
    renderRows(group.subcommands.map((sub) => ({ name: sub.name, summary: sub.summary }))),
    '',
    'Options:',
    '  -h, --help  Show this help',
  ].join('\n');
}
