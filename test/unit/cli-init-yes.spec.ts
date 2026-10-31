import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import { buildCommandTable } from '../../src/cli/commands';
import { renderInitSummary, runInitCommand } from '../../src/cli/init';
import { buildYesAnswers, INIT_VALUE_OPTIONS } from '../../src/cli/init-yes';
import { runCli } from '../../src/cli/main';
import type { CliOutput } from '../../src/cli/output';

/**
 * The non-interactive `init --yes` layer (task 131, spec §5.3; decision
 * D-100): the flag→answers assembly (with every problem class, the
 * environment secret channel, and reproducibility), the handler branches
 * (no prompter is ever constructed in `--yes` mode), and the dispatch-level
 * usage errors (unknown options — including a key-carrying value flag).
 */

/** Flags as `parseArgs` would produce them for the declared `init` options. */
type Flags = Record<string, boolean | string>;

/** A recording context; `flags` fully controls the mode under test. */
function context(flags: Flags): { ctx: CliContext; out(): string; err(): string } {
  const outText: string[] = [];
  const errText: string[] = [];
  const output: CliOutput = {
    out: (text: string) => void outText.push(`${text}\n`),
    err: (text: string) => void errText.push(`${text}\n`),
  };
  return {
    ctx: { output, version: 'test', commandPath: ['init'], flags, positionals: [] },
    out: () => outText.join(''),
    err: () => errText.join(''),
  };
}

/** A createPrompter seam that must never run in `--yes` mode. */
function forbiddenPrompter(): () => never {
  return () => {
    throw new Error('a prompter must not be constructed in --yes mode');
  };
}

const ENV_WITH_KEY = { ZAI_TEST_KEY: 'sk-unit-secret-value' } as const;

describe('buildYesAnswers', () => {
  it('assembles every explicit value (happy path)', () => {
    const result = buildYesAnswers(
      {
        yes: true,
        timezone: 'Europe/Berlin',
        host: '0.0.0.0',
        port: '9000',
        'polling-interval': '120',
        'account-label': 'work',
        'api-key-env': 'ZAI_TEST_KEY',
      },
      ENV_WITH_KEY,
    );
    expect(result).toEqual({
      answers: {
        timezone: 'Europe/Berlin',
        host: '0.0.0.0',
        port: 9000,
        pollingIntervalSeconds: 120,
        accountLabel: 'work',
        accountApiKeyEnv: 'ZAI_TEST_KEY',
      },
    });
  });

  it('absent optional flags take the spec defaults and add no account', () => {
    const result = buildYesAnswers({ yes: true, timezone: 'UTC' }, {});
    expect(result).toEqual({
      answers: {
        timezone: 'UTC',
        host: '127.0.0.1',
        port: 8787,
        pollingIntervalSeconds: 300,
      },
    });
  });

  it('canonicalizes the time zone through the shared parser', () => {
    const result = buildYesAnswers({ yes: true, timezone: 'utc' }, {});
    expect(result).toEqual({
      answers: {
        timezone: 'UTC',
        host: '127.0.0.1',
        port: 8787,
        pollingIntervalSeconds: 300,
      },
    });
  });

  it('is reproducible: same flags and environment, same result', () => {
    const flags: Flags = {
      yes: true,
      timezone: 'Europe/Berlin',
      'account-label': 'work',
      'api-key-env': 'ZAI_TEST_KEY',
    };
    expect(buildYesAnswers(flags, ENV_WITH_KEY)).toEqual(buildYesAnswers(flags, ENV_WITH_KEY));
  });

  it('never lets the key value into the result', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'ZAI_TEST_KEY' },
      ENV_WITH_KEY,
    );
    expect(JSON.stringify(result)).not.toContain('sk-unit-secret-value');
  });

  /* ── the mandatory time zone (spec §5.3: absence is an error) ─────────── */

  it('a missing --timezone is one clear problem, never a default', () => {
    const result = buildYesAnswers({ yes: true }, {});
    expect(result).toEqual({
      problems: [
        '--timezone is required with --yes: Quotameter never applies the ' +
          'system time zone automatically. Pass an explicit IANA name, for ' +
          'example --timezone Europe/Berlin.',
      ],
    });
  });

  it('an empty or blank --timezone is the same missing-value failure', () => {
    for (const value of ['', '   ']) {
      expect(buildYesAnswers({ yes: true, timezone: value }, {})).toEqual({
        problems: [expect.stringContaining('--timezone is required with --yes')],
      });
    }
  });

  it('a service environment override does not satisfy the missing flag', () => {
    // QUOTAMETER_APP_TIMEZONE wins at service config load, not at init
    // collection — init writes explicit values only (decision D-100).
    const result = buildYesAnswers({ yes: true }, { QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' });
    expect(result).toEqual({
      problems: [expect.stringContaining('--timezone is required with --yes')],
    });
  });

  it('an invalid value fails exactly like the interactive answer', () => {
    const result = buildYesAnswers({ yes: true, timezone: 'Nope/Zone' }, {});
    expect(result).toEqual({
      problems: [
        "'Nope/Zone' is not a valid IANA time zone name. Use an Area/Locality " +
          'name such as Europe/Berlin or America/New_York, or UTC.',
      ],
    });
  });

  /* ── the reused per-value parsers ─────────────────────────────────────── */

  it('rejects values the shared parsers reject', () => {
    expect(buildYesAnswers({ yes: true, timezone: 'UTC', host: '0.0.0.0 x' }, {})).toEqual({
      problems: ["Bind host cannot contain whitespace (got '0.0.0.0 x')."],
    });
    expect(buildYesAnswers({ yes: true, timezone: 'UTC', port: 'abc' }, {})).toEqual({
      problems: ["Port must be a whole number (got 'abc')."],
    });
    expect(buildYesAnswers({ yes: true, timezone: 'UTC', port: '70000' }, {})).toEqual({
      problems: ["Port must be between 1 and 65535 (got '70000')."],
    });
    expect(buildYesAnswers({ yes: true, timezone: 'UTC', 'polling-interval': '10' }, {})).toEqual({
      problems: ["Polling interval must be between 60 and 3600 (got '10')."],
    });
    expect(buildYesAnswers({ yes: true, timezone: 'UTC', 'account-label': '   ' }, {})).toEqual({
      problems: ['Account label cannot be blank — type a value or leave the line empty to skip.'],
    });
  });

  it('collects every problem in one pass instead of failing on the first', () => {
    const result = buildYesAnswers(
      { yes: true, port: 'abc', 'api-key-env': 'QM_DEFINITELY_UNSET' },
      {},
    );
    expect(result).toEqual({
      problems: [
        expect.stringContaining('--timezone is required with --yes'),
        "Port must be a whole number (got 'abc').",
        expect.stringContaining('--api-key-env requires --account-label'),
        expect.stringContaining('--api-key-env names an environment variable that is not set'),
      ],
    });
  });

  /* ── the environment secret channel (spec §6.3, §15.4) ────────────────── */

  it('records the variable name only — the value is never retained', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'ZAI_TEST_KEY' },
      ENV_WITH_KEY,
    );
    expect(result).toEqual({
      answers: {
        timezone: 'UTC',
        host: '127.0.0.1',
        port: 8787,
        pollingIntervalSeconds: 300,
        accountLabel: 'work',
        accountApiKeyEnv: 'ZAI_TEST_KEY',
      },
    });
  });

  it('an unset variable is a problem that never names the argument', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'QM_UNSET' },
      {},
    );
    expect(result).toEqual({
      problems: [
        '--api-key-env names an environment variable that is not set in ' +
          'this environment (an empty value counts as unset). Export the ' +
          'API key there and run init again.',
      ],
    });
    expect(JSON.stringify(result)).not.toContain('QM_UNSET');
  });

  it('an empty variable value counts as unset (the D-011 uniform rule)', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'QM_EMPTY' },
      { QM_EMPTY: '' },
    );
    expect(result).toEqual({
      problems: [
        expect.stringContaining('--api-key-env names an environment variable that is not set'),
      ],
    });
  });

  it('an own property holding undefined counts as unset', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'QM_NIL' },
      { QM_NIL: undefined },
    );
    expect(result).toEqual({
      problems: [
        expect.stringContaining('--api-key-env names an environment variable that is not set'),
      ],
    });
  });

  it('inherited object properties are not set variables', () => {
    // `process.env.toString` resolves through the prototype on the pinned
    // runtime (verified); `Object.hasOwn` must keep such names out.
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'toString' },
      {},
    );
    expect(result).toEqual({
      problems: [
        expect.stringContaining('--api-key-env names an environment variable that is not set'),
      ],
    });
  });

  it('a malformed variable name is rejected without echoing the argument', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'sk-live-abc-def' },
      {},
    );
    expect(result).toEqual({
      problems: [
        '--api-key-env expects an environment variable name such as ' +
          'ZAI_API_KEY. The given argument is not echoed — a mistyped key ' +
          'must never reach output.',
      ],
    });
  });

  it('a key-shaped argument never reaches any problem (review-round pin)', () => {
    // The misuse this guards against: the operator pastes the KEY where the
    // variable NAME belongs. An underscore-only key is a syntactically valid
    // name, so the shape check and the unset check may both see it —
    // neither may echo it (spec §15.4).
    for (const argument of ['sk_live_abc123', 'sk-live-abc123', 'QUOTAMETER_sk_live']) {
      const result = buildYesAnswers(
        { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': argument },
        {},
      );
      expect(result).toEqual({ problems: [expect.any(String)] });
      expect(JSON.stringify(result)).not.toContain(argument);
    }
  });

  it('the reserved QUOTAMETER_ prefix is rejected at the input boundary', () => {
    const result = buildYesAnswers(
      {
        yes: true,
        timezone: 'UTC',
        'account-label': 'work',
        'api-key-env': 'QUOTAMETER_TEST_KEY',
      },
      { QUOTAMETER_TEST_KEY: 'sk-x' },
    );
    expect(result).toEqual({
      problems: [expect.stringContaining('must not use the reserved QUOTAMETER_ prefix')],
    });
  });

  it('a blank --api-key-env is a complaint, not a skip', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': '  ' },
      {},
    );
    expect(result).toEqual({
      problems: ['--api-key-env cannot be blank — pass a variable name or omit the option.'],
    });
  });

  it('a key source without an account label has no account to belong to', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'api-key-env': 'ZAI_TEST_KEY' },
      ENV_WITH_KEY,
    );
    expect(result).toEqual({
      problems: [
        '--api-key-env requires --account-label: the key belongs to the ' +
          'initial account, and an account needs a name.',
      ],
    });
  });
});

describe('runInitCommand (--yes mode)', () => {
  it('exits 0 with the summary and constructs no prompter', async () => {
    const h = context({
      yes: true,
      timezone: 'Europe/Berlin',
      host: '0.0.0.0',
      port: '9000',
      'polling-interval': '120',
      'account-label': 'work',
      'api-key-env': 'ZAI_TEST_KEY',
    });
    const code = await runInitCommand({
      createPrompter: forbiddenPrompter(),
      env: ENV_WITH_KEY,
    })(h.ctx);
    expect(code).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toContain('Time zone:         Europe/Berlin');
    expect(h.out()).toContain('Bind host:         0.0.0.0');
    expect(h.out()).toContain('Port:              9000');
    expect(h.out()).toContain('Polling interval:  120 seconds');
    expect(h.out()).toContain(
      "'work' (API key from environment variable 'ZAI_TEST_KEY', value never stored or printed)",
    );
    expect(h.out() + h.err()).not.toContain('sk-unit-secret-value');
    expect(h.out()).toContain('Nothing has been written yet');
  });

  it('warns about the password requirement for non-loopback hosts too', async () => {
    const h = context({ yes: true, timezone: 'UTC', host: '192.168.1.10' });
    const code = await runInitCommand({ createPrompter: forbiddenPrompter(), env: {} })(h.ctx);
    expect(code).toBe(0);
    expect(h.out()).toContain('requires a password before the service');
  });

  it('a missing --timezone fails on stderr with exit 1 and prints no summary', async () => {
    const h = context({ yes: true });
    const code = await runInitCommand({ createPrompter: forbiddenPrompter(), env: {} })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toBe(
      'quotameter init: --timezone is required with --yes: Quotameter never ' +
        'applies the system time zone automatically. Pass an explicit IANA ' +
        'name, for example --timezone Europe/Berlin.\n',
    );
    expect(h.out()).toBe('');
  });

  it('every problem is its own prefixed stderr line', async () => {
    const h = context({ yes: true, port: 'abc' });
    const code = await runInitCommand({ createPrompter: forbiddenPrompter(), env: {} })(h.ctx);
    expect(code).toBe(1);
    expect(
      h
        .err()
        .split('\n')
        .filter((line) => line !== ''),
    ).toHaveLength(2);
    expect(h.err()).toContain('quotameter init: --timezone is required with --yes');
    expect(h.err()).toContain("quotameter init: Port must be a whole number (got 'abc')");
  });

  it('a value option without --yes is a clear failure, not a silent ignore', async () => {
    const h = context({ timezone: 'Europe/Berlin' });
    const code = await runInitCommand({ createPrompter: forbiddenPrompter(), env: {} })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('--timezone requires --yes (non-interactive mode)');
    expect(h.out()).toBe('');
  });
});

describe('renderInitSummary (environment key source)', () => {
  const base = {
    timezone: 'UTC',
    host: '127.0.0.1',
    port: 8787,
    pollingIntervalSeconds: 300,
  } as const;

  it('an environment-sourced key names the variable and never a value', () => {
    const summary = renderInitSummary({
      ...base,
      accountLabel: 'work',
      accountApiKeyEnv: 'ZAI_KEY',
    });
    expect(summary).toContain(
      "'work' (API key from environment variable 'ZAI_KEY', value never stored or printed)",
    );
    expect(summary).toContain('Nothing has been written yet');
  });

  it('a label without any key source still says skipped', () => {
    expect(renderInitSummary({ ...base, accountLabel: 'work' })).toContain(
      "'work' (API key skipped — add it later in the UI)",
    );
  });
});

describe('runCli dispatch (usage errors of init --yes)', () => {
  /** Runs the real table with a recording output seam. */
  async function dispatch(
    args: readonly string[],
  ): Promise<{ code: number; err(): string; out(): string }> {
    const outText: string[] = [];
    const errText: string[] = [];
    const output: CliOutput = {
      out: (text: string) => void outText.push(`${text}\n`),
      err: (text: string) => void errText.push(`${text}\n`),
    };
    const code = await runCli(['init', ...args], {
      version: 'test',
      output,
      commands: buildCommandTable(),
    });
    return { code, out: () => outText.join(''), err: () => errText.join('') };
  }

  it('an unknown option is a usage error (exit 2)', async () => {
    const result = await dispatch(['--yes', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.err()).toContain("unknown option '--bogus'");
    expect(result.err()).toContain("Try 'quotameter init --help'");
  });

  it('a key-carrying value flag is rejected without echoing the value', async () => {
    const result = await dispatch(['--yes', '--api-key=sk-secret-on-argv']);
    expect(result.code).toBe(2);
    expect(result.err()).toContain("unknown option '--api-key'");
    expect(result.err() + result.out()).not.toContain('sk-secret-on-argv');
  });

  it('a positional argument is a usage error (init takes none)', async () => {
    const result = await dispatch(['--yes', '--timezone', 'UTC', 'extra']);
    expect(result.code).toBe(2);
    expect(result.err()).toContain("unexpected argument 'extra'");
  });

  it('INIT_VALUE_OPTIONS stays in lockstep with the declared options', () => {
    // The without---yes guard covers exactly INIT_VALUE_OPTIONS; an option
    // added to the table but not to the list would silently escape it
    // (review-round drift guard).
    const init = buildCommandTable().find((command) => command.name === 'init');
    expect(init?.kind).toBe('leaf');
    if (init?.kind === 'leaf') {
      const declared = Object.keys(init.options).filter((name) => name !== 'yes');
      expect([...declared].sort()).toEqual([...INIT_VALUE_OPTIONS].sort());
    }
  });

  it('init --help lists the --yes option surface', async () => {
    const result = await dispatch(['--help']);
    expect(result.code).toBe(0);
    for (const flag of [
      '-y, --yes',
      '--timezone <value>',
      '--host <value>',
      '--port <value>',
      '--polling-interval <value>',
      '--account-label <value>',
      '--api-key-env <value>',
    ]) {
      expect(result.out()).toContain(flag);
    }
  });
});
