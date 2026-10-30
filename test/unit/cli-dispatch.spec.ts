import { describe, expect, it } from 'vitest';
import {
  buildCommandTable,
  type CliContext,
  type Command,
  type LeafCommand,
} from '../../src/cli/commands';
import { renderCommandHelp, renderGeneralHelp, renderGroupHelp } from '../../src/cli/help';
import { runCli } from '../../src/cli/main';
import type { CliOutput } from '../../src/cli/output';

/**
 * CLI dispatch (task 128, spec §5.2; decision D-044), in-process: every
 * invocation runs against an injected output recorder and the real command
 * table (or an injected fake one), because `runCli` never touches the
 * process itself — the child-process behavior of the launcher is covered by
 * `test/integration/cli-bin.spec.ts`.
 */

const VERSION = '9.9.9-unit';

/** The §5.2 command names the general help must list. */
const SPEC_COMMANDS = [
  'init',
  'run',
  'start',
  'stop',
  'restart',
  'reload',
  'status',
  'logs',
  'service',
  'passwd',
  'doctor',
] as const;

/** Records writes exactly the way `systemOutput` would emit them. */
function recorder(): { output: CliOutput; out(): string; err(): string } {
  const outText: string[] = [];
  const errText: string[] = [];
  return {
    output: {
      out: (text: string) => void outText.push(`${text}\n`),
      err: (text: string) => void errText.push(`${text}\n`),
    },
    out: () => outText.join(''),
    err: () => errText.join(''),
  };
}

/** Runs the CLI in-process and returns code plus captured output. */
async function cli(
  argv: readonly string[],
  commands?: readonly Command[],
): Promise<{ code: number; out: string; err: string }> {
  const sink = recorder();
  const code = await runCli(argv, { version: VERSION, output: sink.output, commands });
  return { code, out: sink.out(), err: sink.err() };
}

describe('general help (spec §5.2)', () => {
  it('lists every §5.2 command for --help, -h, and no arguments', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const result = await cli(argv);
      expect(result.code, `exit 0 for [${argv.join(' ')}]`).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toContain('Usage: quotameter <command> [options]');
      for (const name of SPEC_COMMANDS) {
        expect(result.out, `help must mention '${name}'`).toContain(name);
      }
    }
  });

  it('names the service subcommands in the service row', async () => {
    const result = await cli(['--help']);
    expect(result.out).toMatch(/service\s+.*\(subcommands: install, uninstall\)/);
  });

  it('shows the global options', async () => {
    const result = await cli(['--help']);
    expect(result.out).toContain('-h, --help');
    expect(result.out).toContain('-v, --version');
  });
});

describe('--version', () => {
  it('prints exactly the injected version for --version and -v', async () => {
    for (const flag of ['--version', '-v']) {
      const result = await cli([flag]);
      expect(result.code).toBe(0);
      expect(result.out).toBe(`${VERSION}\n`);
      expect(result.err).toBe('');
    }
  });

  it('wins over --help on mixed global invocations', async () => {
    const result = await cli(['--version', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${VERSION}\n`);
  });
});

describe('usage errors (exit 2)', () => {
  it('rejects an unknown command with a clear message and a help hint', async () => {
    const result = await cli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toBe(
      "quotameter: unknown command 'frobnicate'\n" +
        "Try 'quotameter --help' to list the available commands.\n",
    );
  });

  it('rejects an unknown leading option globally', async () => {
    const result = await cli(['--bogus']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("quotameter: unknown option '--bogus'");
  });

  it('rejects an unknown long option for a command (parseArgs wording, first sentence only)', async () => {
    const result = await cli(['status', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toBe(
      "quotameter status: unknown option '--bogus'\n" + "Try 'quotameter status --help'.\n",
    );
  });

  it('rejects an unknown short option for a command', async () => {
    const result = await cli(['status', '-x']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown option '-x'");
  });

  it('reports a bare end-of-options marker as an unexpected argument, not an option', async () => {
    const global = await cli(['--']);
    expect(global.code).toBe(2);
    expect(global.err).toContain("quotameter: unexpected argument '--'");

    const group = await cli(['service', '--']);
    expect(group.code).toBe(2);
    expect(group.err).toContain("quotameter service: unexpected argument '--'");
  });

  it('rejects a positional argument the command does not take', async () => {
    const result = await cli(['status', 'extra']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("quotameter status: unexpected argument 'extra'");
  });

  it('treats command names case-sensitively', async () => {
    const result = await cli(['INIT']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command 'INIT'");
  });
});

describe('service subcommands (spec §5.2)', () => {
  it('requires a subcommand and names the choices', async () => {
    const result = await cli(['service']);
    expect(result.code).toBe(2);
    expect(result.err).toBe(
      'quotameter service: a subcommand is required (install, uninstall)\n' +
        "Try 'quotameter service --help'.\n",
    );
  });

  it('rejects an unknown subcommand', async () => {
    const result = await cli(['service', 'rotate']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("quotameter service: unknown subcommand 'rotate'");
  });

  it('rejects an unknown option in place of a subcommand', async () => {
    const result = await cli(['service', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("quotameter service: unknown option '--bogus'");
  });

  it('shows group help for "service --help"', async () => {
    const result = await cli(['service', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: quotameter service <subcommand> [options]');
    expect(result.out).toContain('install');
    expect(result.out).toContain('uninstall');
  });

  it('shows command help for "service install --help"', async () => {
    const result = await cli(['service', 'install', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: quotameter service install [options]');
  });
});

describe('command help', () => {
  it('shows usage, summary, and the help option for every command', async () => {
    for (const command of buildCommandTable()) {
      const path = command.kind === 'group' ? ['service', 'install'] : [command.name];
      const result = await cli([...path, '--help']);
      expect(result.code, `exit 0 for ${path.join(' ')} --help`).toBe(0);
      expect(result.out).toContain(`Usage: quotameter ${path.join(' ')} [options]`);
      expect(result.out).toContain('-h, --help');
    }
  });

  it('validates flags before showing help', async () => {
    const result = await cli(['status', '--bogus', '--help']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown option '--bogus'");
  });

  it('renders declared options with their value placeholders aligned', () => {
    const serve: LeafCommand = {
      kind: 'leaf',
      name: 'serve',
      summary: 'Serve something',
      options: { port: { type: 'string', short: 'p' }, verbose: { type: 'boolean' } },
      maxPositionals: 0,
      run: async () => 0,
    };
    const text = renderCommandHelp(serve, ['serve']);
    expect(text).toContain('-h, --help');
    expect(text).toContain('-p, --port <value>');
    expect(text).toContain('--verbose');
  });

  it('documents described options and emits no trailing padding on undocumented ones', () => {
    const serve: LeafCommand = {
      kind: 'leaf',
      name: 'serve',
      summary: 'Serve something',
      options: {
        port: { type: 'string', short: 'p', description: 'Port to listen on' },
        verbose: { type: 'boolean' },
      },
      maxPositionals: 0,
      run: async () => 0,
    };
    const text = renderCommandHelp(serve, ['serve']);
    expect(text).toContain('-p, --port <value>  Port to listen on');
    for (const line of text.split('\n')) {
      expect(line === line.trimEnd(), `no trailing whitespace: ${JSON.stringify(line)}`).toBe(true);
    }
  });
});

describe('stub dispatch (tasks 129–145 replace these)', () => {
  it('reports a top-level command as not implemented and exits 1', async () => {
    const result = await cli(['doctor']);
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('quotameter doctor: not implemented yet\n');
  });

  it('reports a subcommand with its full path', async () => {
    const result = await cli(['service', 'uninstall']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter service uninstall: not implemented yet\n');
  });
});

describe('injected command table (pluggable dispatch)', () => {
  /** A fake command capturing its context and returning a fixed code. */
  function probe(
    name: string,
    options: LeafCommand['options'] = {},
    maxPositionals = 0,
  ): { command: LeafCommand; calls: CliContext[] } {
    const calls: CliContext[] = [];
    const command: LeafCommand = {
      kind: 'leaf',
      name,
      summary: `Probe ${name}`,
      options,
      maxPositionals,
      run: async (ctx) => {
        calls.push(ctx);
        return 7;
      },
    };
    return { command, calls };
  }

  it('dispatches to the handler and returns its exit code', async () => {
    const { command, calls } = probe('serve');
    const result = await cli(['serve'], [command]);
    expect(result.code).toBe(7);
    expect(calls.map((ctx) => ctx.commandPath)).toEqual([['serve']]);
  });

  it('passes the version, parsed flags, and positionals to the handler', async () => {
    const { command, calls } = probe('serve', { port: { type: 'string', short: 'p' } }, 1);
    const result = await cli(['serve', '--port', '8787', '-p', '9', 'tail'], [command]);
    expect(result.code).toBe(7);
    const ctx = calls[0];
    expect(ctx?.version).toBe(VERSION);
    expect(ctx?.flags.port).toBe('9'); // last occurrence wins, parseArgs semantics
    expect(ctx?.flags.help).toBeUndefined();
    expect(ctx?.positionals).toEqual(['tail']);
  });

  it('rejects flags the injected command did not declare', async () => {
    const { command } = probe('serve');
    const result = await cli(['serve', '--port', '8787'], [command]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("quotameter serve: unknown option '--port'");
  });

  it('reports a string option invoked without its value', async () => {
    const { command } = probe('serve', { port: { type: 'string', short: 'p' } });
    const result = await cli(['serve', '--port'], [command]);
    expect(result.code).toBe(2);
    // parseArgs messages without a second sentence pass through decapitalized.
    expect(result.err).toContain("quotameter serve: option '-p, --port <value>' argument missing");
  });

  it('rejects a command table that shadows the reserved help option', async () => {
    const { command } = probe('serve', { help: { type: 'boolean' } });
    await expect(cli(['serve'], [command])).rejects.toThrow(
      "option name 'help' is reserved for the automatic -h, --help (command 'serve')",
    );
  });

  it('reports a throwing handler as a command failure (exit 1)', async () => {
    const broken: LeafCommand = {
      kind: 'leaf',
      name: 'broken',
      summary: 'Throws',
      options: {},
      maxPositionals: 0,
      run: async () => {
        throw new Error('boom');
      },
    };
    const result = await cli(['broken'], [broken]);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter broken: boom\n');
  });

  it('unrolls aggregate errors like the server entry point', async () => {
    const broken: LeafCommand = {
      kind: 'leaf',
      name: 'broken',
      summary: 'Throws',
      options: {},
      maxPositionals: 0,
      run: async () => {
        throw new AggregateError([new Error('first'), new Error('second')], 'both failed');
      },
    };
    const result = await cli(['broken'], [broken]);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter broken: both failed: first; second\n');
  });
});

describe('help renderers (pure)', () => {
  it('derives the general help entirely from the table', () => {
    const text = renderGeneralHelp(buildCommandTable());
    expect(text.startsWith('Usage: quotameter <command> [options]')).toBe(true);
    expect(text).toContain('Quotameter — self-hosted usage quota monitoring');
    for (const command of buildCommandTable()) {
      expect(text).toContain(command.summary);
    }
  });

  it('derives the group help from the group entry', () => {
    const table = buildCommandTable();
    const group = table.find((entry) => entry.kind === 'group');
    expect(group?.kind).toBe('group');
    if (group?.kind === 'group') {
      const text = renderGroupHelp(group);
      expect(text).toContain('Usage: quotameter service <subcommand> [options]');
      expect(text).toContain(group.summary + '.');
    }
  });
});

describe('dispatch-table pinning (U-006 mutation triage)', () => {
  /**
   * The table is the CLI's public shape: `toContain`-style checks derived
   * from the table itself cannot catch a mutated name or summary, because
   * the expected value mutates with it. These tests pin the literals.
   */
  it('pins every command kind, name, and summary of the §5.2 table', () => {
    const rows = buildCommandTable().map((command) =>
      command.kind === 'group'
        ? [
            command.kind,
            command.name,
            command.summary,
            command.subcommands.map((sub) => [sub.name, sub.summary]),
          ]
        : [command.kind, command.name, command.summary],
    );
    expect(rows).toEqual([
      ['leaf', 'init', 'First-time configuration and service setup'],
      ['leaf', 'run', 'Foreground execution for systemd and debugging'],
      ['leaf', 'start', 'Start an installed service through systemd'],
      ['leaf', 'stop', 'Stop an installed service through systemd'],
      ['leaf', 'restart', 'Restart an installed service through systemd'],
      ['leaf', 'reload', 'Reload configuration on SIGHUP without restarting where supported'],
      ['leaf', 'status', 'Show service status, latest collection, and last error for each account'],
      ['leaf', 'logs', 'Convenient journalctl wrapper for system or user service'],
      [
        'group',
        'service',
        'Install or remove the service independently of init',
        [
          ['install', 'Install the systemd service unit'],
          ['uninstall', 'Remove the installed systemd service unit'],
        ],
      ],
      ['leaf', 'passwd', 'Set or change the web password'],
      [
        'leaf',
        'doctor',
        'Diagnose runtime, configuration, database, network, credentials, and service issues',
      ],
    ]);
  });

  it('reports every stubbed command with its exact full command path', async () => {
    for (const path of [
      ['init'],
      ['run'],
      ['start'],
      ['stop'],
      ['restart'],
      ['reload'],
      ['status'],
      ['logs'],
      ['service', 'install'],
      ['service', 'uninstall'],
      ['passwd'],
      ['doctor'],
    ] as const) {
      const result = await cli([...path]);
      expect(result.code, `exit 1 for ${path.join(' ')}`).toBe(1);
      expect(result.err).toBe(`quotameter ${path.join(' ')}: not implemented yet\n`);
    }
  });
});

describe('help renderer exact output (U-006 mutation triage)', () => {
  /** A leaf with one short option, one string option, and one undocumented. */
  function optionedLeaf(): LeafCommand {
    return {
      kind: 'leaf',
      name: 'serve',
      summary: 'Serve something',
      options: {
        port: { type: 'string', short: 'p', description: 'Port to listen on' },
        verbose: { type: 'boolean' },
      },
      maxPositionals: 0,
      run: async () => 0,
    };
  }

  it('pins the exact command help, alignment included', () => {
    expect(renderCommandHelp(optionedLeaf(), ['serve'])).toBe(
      [
        'Usage: quotameter serve [options]',
        '',
        'Serve something.',
        '',
        'Options:',
        '  -h, --help          Show this help',
        '  -p, --port <value>  Port to listen on',
        '      --verbose',
      ].join('\n'),
    );
  });

  it('pins the exact general help for a synthetic table', () => {
    const leaf = (name: string, summary: string): LeafCommand => ({
      kind: 'leaf',
      name,
      summary,
      options: {},
      maxPositionals: 0,
      run: async () => 0,
    });
    const text = renderGeneralHelp([
      leaf('probe', 'Short probe'),
      leaf('longer-name', 'A longer one'),
      {
        kind: 'group',
        name: 'service',
        summary: 'Grouped things',
        subcommands: [leaf('install', 'Install it'), leaf('uninstall', 'Remove it')],
      },
    ]);
    expect(text).toBe(
      [
        'Usage: quotameter <command> [options]',
        '       quotameter service <subcommand> [options]',
        '',
        'Quotameter — self-hosted usage quota monitoring for AI subscriptions.',
        '',
        'Commands:',
        '  probe        Short probe',
        '  longer-name  A longer one',
        '  service      Grouped things (subcommands: install, uninstall)',
        '',
        'Options:',
        '  -h, --help     Show this help; after a command name, help for that command',
        '  -v, --version  Print the CLI version',
      ].join('\n'),
    );
  });

  it('pins the exact group help', () => {
    const text = renderGroupHelp({
      kind: 'group',
      name: 'service',
      summary: 'Grouped things',
      subcommands: [
        {
          kind: 'leaf',
          name: 'install',
          summary: 'Install it',
          options: {},
          maxPositionals: 0,
          run: async () => 0,
        },
        {
          kind: 'leaf',
          name: 'uninstall',
          summary: 'Remove it',
          options: {},
          maxPositionals: 0,
          run: async () => 0,
        },
      ],
    });
    expect(text).toBe(
      [
        'Usage: quotameter service <subcommand> [options]',
        '',
        'Grouped things.',
        '',
        'Subcommands:',
        '  install    Install it',
        '  uninstall  Remove it',
        '',
        'Options:',
        '  -h, --help  Show this help',
      ].join('\n'),
    );
  });
});
