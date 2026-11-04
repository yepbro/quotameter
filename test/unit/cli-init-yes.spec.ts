import { describe, expect, it } from 'vitest';
import { parseConfig, type CanonicalConfig } from '../../src/config/load';
import type { CliContext } from '../../src/cli/commands';
import { buildCommandTable } from '../../src/cli/commands';
import { renderInitSummary, runInitCommand, type InitDeps } from '../../src/cli/init';
import type { WriteInitConfigOptions } from '../../src/cli/init-persist';
import type { InitAnswers } from '../../src/cli/init-questions';
import { buildYesAnswers, INIT_VALUE_OPTIONS } from '../../src/cli/init-yes';
import { runCli } from '../../src/cli/main';
import type { CliOutput } from '../../src/cli/output';
import type { QuotaProvider } from '../../src/providers/registry';
import { MIN_PASSWORD_LENGTH } from '../../src/services/config-validation';

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

/** The environment holding the marker password (§15.2 minimum met). */
const MARKER_PASSWORD = 'unit-password-marker-42';
const ENV_WITH_PASSWORD = { QM_TEST_PASSWORD: MARKER_PASSWORD } as const;

/** A validated canonical fixture through the real parser. */
function canonical(input: unknown): CanonicalConfig {
  const parsed = parseConfig(input);
  if (!parsed.ok) throw new Error(`fixture configuration rejected: ${parsed.problems.join('; ')}`);
  return parsed.value as CanonicalConfig;
}

/** The current configuration the retain-mode scenarios run against. */
const EXISTING: CanonicalConfig = canonical({
  server: { host: '127.0.0.1', port: 9000 },
  app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120, historyRetentionDays: 90 },
  accounts: [{ id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-configured-key' }],
});

/** `--yes` deps with detection and persistence seams: fresh or existing. */
function yesDeps(
  existing?: CanonicalConfig,
  provider?: QuotaProvider,
): {
  deps: InitDeps;
  writes(): readonly WriteInitConfigOptions[];
} {
  const writes: WriteInitConfigOptions[] = [];
  return {
    deps: {
      createPrompter: forbiddenPrompter(),
      env: ENV_WITH_KEY,
      readExisting: async () =>
        existing === undefined
          ? { state: 'none' }
          : { state: 'existing', config: existing, passwordPending: false },
      persistConfig: async (options) => {
        writes.push(options);
      },
      // The connection test's provider seam: a fake by default (no network
      // in unit tests), rejecting when a case needs the failure path.
      provider: provider ?? acceptingProvider(),
      // The service-setup seams (D-160 hermeticity): this suite pins the
      // `--yes` layer, not the machine — a fixed systemd-less capability
      // answer keeps the step on its manual route (which performs no I/O)
      // on any host, and the forbidden service seams below turn a regressed
      // route into a visible test failure: a forbidden command throws out
      // of the handler, a forbidden write lands in the step's failure
      // fallback's stderr line — and every fresh-run test asserts stderr
      // stays empty.
      probeCapabilities: () => ({ systemd: false, userManager: false }),
      runServiceCommand: forbiddenServiceCommand(),
      writeServiceUnitFile: forbiddenUnitWriter(),
    },
    writes: () => writes,
  };
}

/** A service-command seam that must never run in this suite's manual route. */
function forbiddenServiceCommand(): () => never {
  return () => {
    throw new Error('a service command must not run in the init --yes unit tests');
  };
}

/** A unit-writer seam that must never run in this suite's manual route. */
function forbiddenUnitWriter(): () => never {
  return () => {
    throw new Error('a unit file must not be written in the init --yes unit tests');
  };
}

/** A provider-shaped error carrying the provider-neutral `kind` field. */
function kindError(kind: string, message: string): Error {
  return Object.assign(new Error(message), { kind });
}

/** A connection-test provider that accepts every key. */
function acceptingProvider(): QuotaProvider {
  return rejectingProvider(undefined);
}

/** A connection-test provider that rejects with a provider-neutral kind. */
function rejectingProvider(rejectWith: Error | undefined): QuotaProvider {
  return {
    id: 'zai-coding-plan',
    name: 'Fake Z.ai Coding Plan',
    async validateCredentials(): Promise<void> {
      if (rejectWith !== undefined) throw rejectWith;
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not part of the init --yes tests');
    },
  };
}

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
          'this environment (an empty or blank value counts as unset). ' +
          'Export the API key there and run init again.',
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

  it('a whitespace-only variable value counts as unset too (review P1)', () => {
    // Blank is never a credential: accepting it here would hand the account
    // step a secret its own context factory rejects, outside the guarded
    // connection test — an abort instead of the explained failure.
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'account-label': 'work', 'api-key-env': 'QM_BLANK' },
      { QM_BLANK: '   ' },
    );
    expect(result).toEqual({
      problems: [
        expect.stringContaining(
          'an environment variable that is not set in this environment ' +
            '(an empty or blank value counts as unset)',
        ),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('   ');
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

  /* ── the password channel (task U-042, spec §15.2, decision D-141) ───── */

  it('a set --password-env yields the password beside the answers', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': 'QM_TEST_PASSWORD' },
      ENV_WITH_PASSWORD,
    );
    expect(result).toEqual({
      answers: {
        timezone: 'UTC',
        host: '127.0.0.1',
        port: 8787,
        pollingIntervalSeconds: 300,
      },
      password: MARKER_PASSWORD,
    });
  });

  it('the §15.2 minimum is exact: 12 characters accepted, 11 rejected', () => {
    // Derived from the boundary's own constant, like the settings
    // boundary's suite — an off-by-one cannot hide behind a literal.
    const atMinimum = 'c'.repeat(MIN_PASSWORD_LENGTH);
    const accepted = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': 'QM_BOUNDARY_PASSWORD' },
      { QM_BOUNDARY_PASSWORD: atMinimum },
    );
    expect(accepted).toEqual({
      answers: expect.objectContaining({ timezone: 'UTC' }),
      password: atMinimum,
    });
    const belowMinimum = 'd'.repeat(MIN_PASSWORD_LENGTH - 1);
    const rejected = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': 'QM_BOUNDARY_PASSWORD' },
      { QM_BOUNDARY_PASSWORD: belowMinimum },
    );
    expect(rejected).toEqual({
      problems: [expect.stringContaining('--password-env holds a password shorter')],
    });
  });

  it('the environment value is taken untrimmed (secrets are never trimmed)', () => {
    const padded = `  ${MARKER_PASSWORD}  `;
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': 'QM_PADDED_PASSWORD' },
      { QM_PADDED_PASSWORD: padded },
    );
    expect(result).toEqual({
      answers: expect.objectContaining({ timezone: 'UTC' }),
      password: padded,
    });
  });

  it('an absent --password-env keeps the result shape password-free', () => {
    const result = buildYesAnswers({ yes: true, timezone: 'UTC' }, ENV_WITH_PASSWORD);
    expect(result).toEqual({
      answers: {
        timezone: 'UTC',
        host: '127.0.0.1',
        port: 8787,
        pollingIntervalSeconds: 300,
      },
    });
  });

  it('a password shorter than the §15.2 minimum is a problem that never names the value', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': 'QM_SHORT_PASSWORD' },
      { QM_SHORT_PASSWORD: 'tiny-pw-x1' },
    );
    expect(result).toEqual({
      problems: [
        '--password-env holds a password shorter than the spec §15.2 minimum ' +
          'of 12 characters — the value is not echoed. Export a longer ' +
          'password there and run init again.',
      ],
    });
    expect(JSON.stringify(result)).not.toContain('tiny-pw-x1');
  });

  it('an unset password variable is a problem (blank counts as unset, D-011)', () => {
    for (const env of [{}, { QM_TEST_PASSWORD: '' }, { QM_TEST_PASSWORD: '   ' }]) {
      const result = buildYesAnswers(
        { yes: true, timezone: 'UTC', 'password-env': 'QM_TEST_PASSWORD' },
        env,
      );
      expect(result).toEqual({
        problems: [
          expect.stringContaining(
            '--password-env names an environment variable that is not set in this environment',
          ),
        ],
      });
    }
  });

  it('a malformed or reserved name is rejected without echoing the argument', () => {
    for (const name of ['bad name!', 'QUOTAMETER_PASSWORD']) {
      const result = buildYesAnswers(
        { yes: true, timezone: 'UTC', 'password-env': name },
        ENV_WITH_PASSWORD,
      );
      expect(result).toEqual({ problems: [expect.stringContaining('--password-env')] });
      expect(JSON.stringify(result)).not.toContain(name);
    }
  });

  it('a password-shaped argument (a mistyped password as the name) never reaches output', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': 'typed_out_password_42' },
      ENV_WITH_PASSWORD,
    );
    expect(result).toEqual({ problems: [expect.stringContaining('--password-env')] });
    expect(JSON.stringify(result)).not.toContain('typed_out_password_42');
  });

  it('a blank --password-env is a complaint, not a skip', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'UTC', 'password-env': '' },
      ENV_WITH_PASSWORD,
    );
    expect(result).toEqual({
      problems: ['--password-env cannot be blank — pass a variable name or omit the option.'],
    });
  });
});

describe('buildYesAnswers (retain mode — task 132, decision D-101)', () => {
  it('absent optional flags keep the current values, not the spec defaults', () => {
    const result = buildYesAnswers({ yes: true, timezone: 'Europe/Berlin' }, {}, EXISTING);
    expect(result).toEqual({
      answers: {
        timezone: 'Europe/Berlin',
        host: '127.0.0.1',
        port: 9000,
        pollingIntervalSeconds: 120,
      },
    });
  });

  it('a blank flag value keeps the current value too (blank is not supplied)', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'Europe/Berlin', port: '   ' },
      {},
      EXISTING,
    );
    expect(result).toEqual({
      answers: {
        timezone: 'Europe/Berlin',
        host: '127.0.0.1',
        port: 9000,
        pollingIntervalSeconds: 120,
      },
    });
  });

  it('an explicit flag is the consent to change that setting', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'Europe/Berlin', port: '9001' },
      {},
      EXISTING,
    );
    expect(result).toEqual({
      answers: {
        timezone: 'Europe/Berlin',
        host: '127.0.0.1',
        port: 9001,
        pollingIntervalSeconds: 120,
      },
    });
  });

  it('--timezone stays mandatory against an existing configuration', () => {
    const result = buildYesAnswers({ yes: true }, {}, EXISTING);
    expect(result).toEqual({
      problems: [expect.stringContaining('--timezone is required with --yes')],
    });
  });

  it('the account flags apply only to a fresh initialization', () => {
    const withLabel = buildYesAnswers(
      { yes: true, timezone: 'Europe/Berlin', 'account-label': 'work' },
      ENV_WITH_KEY,
      EXISTING,
    );
    expect(withLabel).toEqual({
      problems: [expect.stringContaining('apply only to a fresh initialization')],
    });

    const withEnv = buildYesAnswers(
      { yes: true, timezone: 'Europe/Berlin', 'api-key-env': 'ZAI_TEST_KEY' },
      ENV_WITH_KEY,
      EXISTING,
    );
    expect(withEnv).toEqual({
      problems: [expect.stringContaining('apply only to a fresh initialization')],
    });
    // Neither the key value nor its variable leaks into the problem.
    expect(JSON.stringify(withEnv)).not.toContain('sk-unit-secret-value');
  });

  it('--password-env applies only to a fresh initialization (D-141)', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'Europe/Berlin', 'password-env': 'QM_TEST_PASSWORD' },
      ENV_WITH_PASSWORD,
      EXISTING,
    );
    expect(result).toEqual({
      problems: [expect.stringContaining('--password-env applies only to a fresh initialization')],
    });
    expect(JSON.stringify(result)).not.toContain(MARKER_PASSWORD);
  });

  it('invalid explicit values fail exactly like the fresh flow', () => {
    const result = buildYesAnswers(
      { yes: true, timezone: 'Europe/Berlin', port: 'abc' },
      {},
      EXISTING,
    );
    expect(result).toEqual({
      problems: ["Port must be a whole number (got 'abc')."],
    });
  });
});

describe('runInitCommand (--yes mode)', () => {
  it('exits 0 with the summary, writes the config, and constructs no prompter', async () => {
    const h = context({
      yes: true,
      timezone: 'Europe/Berlin',
      host: '0.0.0.0',
      port: '9000',
      'polling-interval': '120',
      'account-label': 'work',
      'api-key-env': 'ZAI_TEST_KEY',
    });
    const { deps, writes } = yesDeps();
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toContain('Time zone:         Europe/Berlin');
    expect(h.out()).toContain('Bind host:         0.0.0.0');
    expect(h.out()).toContain('Port:              9000');
    expect(h.out()).toContain('Polling interval:  120 seconds');
    expect(h.out()).toContain('Connection test passed');
    expect(h.out()).toContain(
      "'work' (API key from environment variable 'ZAI_TEST_KEY', value never " +
        'stored or printed; connection test passed)',
    );
    expect(h.out() + h.err()).not.toContain('sk-unit-secret-value');
    expect(h.out()).toContain('Configuration written to');
    // Task 137: the routed service-setup step follows the write trailer.
    expect(h.out()).toContain('Service setup:');
    expect(writes()).toHaveLength(1);
    // The account is real (task 133): persisted with the variable-name
    // secret source — the value itself exists only in the environment.
    const written = writes()[0];
    expect(written?.config.accounts).toEqual([
      {
        id: 'work',
        providerId: 'zai-coding-plan',
        label: 'work',
        enabled: true,
        apiKeyEnv: 'ZAI_TEST_KEY',
      },
    ]);
    expect(JSON.stringify(written?.config)).not.toContain('sk-unit-secret-value');
  });

  it('a failed connection test is explained and the account kept — no prompter exists', async () => {
    const h = context({
      yes: true,
      timezone: 'UTC',
      'account-label': 'work',
      'api-key-env': 'ZAI_TEST_KEY',
    });
    const { deps, writes } = yesDeps(
      undefined,
      rejectingProvider(
        kindError(
          'credentials-rejected',
          'the provider rejected the account credentials (HTTP 401)',
        ),
      ),
    );
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.err()).toContain("the initial connection test for 'work' failed:");
    expect(h.err()).toContain('the provider refused the key');
    expect(h.out()).toContain(
      'connection test failed: credentials-rejected — stored in error state',
    );
    expect(h.out()).toContain('Configuration written to');
    expect(writes()[0]?.config.accounts).toHaveLength(1);
    expect(h.out() + h.err()).not.toContain('sk-unit-secret-value');
  });

  it('warns about the password requirement for non-loopback hosts too', async () => {
    const h = context({ yes: true, timezone: 'UTC', host: '192.168.1.10' });
    const { deps, writes } = yesDeps();
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.out()).toContain('requires a password before the service');
    // §15.1 pending (D-101): the hash-less remote bind is written with the
    // remedy; the service refuses to start on it until passwd completes it.
    expect(h.out()).toContain('set one with quotameter passwd');
    expect(h.out()).toContain('Password:          none');
    expect(writes()).toHaveLength(1);
  });

  it('--password-env hashes and stores the password — never the plaintext (U-042)', async () => {
    const h = context({ yes: true, timezone: 'UTC', 'password-env': 'QM_TEST_PASSWORD' });
    const writes: Array<{ config: { auth?: { passwordHash?: string } } }> = [];
    const hashed: string[] = [];
    const revoked: string[] = [];
    const deps: InitDeps = {
      createPrompter: forbiddenPrompter(),
      env: ENV_WITH_PASSWORD,
      readExisting: async () => ({ state: 'none' }),
      provider: acceptingProvider(),
      hash: async (password) => {
        hashed.push(password);
        return 'scrypt$unit-fake-hash';
      },
      revokeSessions: async (dataDir) => {
        revoked.push(dataDir);
        return { state: 'none' };
      },
      persistConfig: async (options) => {
        writes.push(options as { config: { auth?: { passwordHash?: string } } });
      },
    };
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(hashed).toEqual([MARKER_PASSWORD]);
    expect(writes[0]?.config.auth?.passwordHash).toBe('scrypt$unit-fake-hash');
    expect(h.out()).toContain('Password:          set (only a scrypt hash is stored)');
    expect(h.out() + h.err()).not.toContain(MARKER_PASSWORD);
    expect(JSON.stringify(writes)).not.toContain(MARKER_PASSWORD);
    // The §15.2 revocation probe ran for the stored hash (fresh machine:
    // silent absence).
    expect(revoked).toHaveLength(1);
  });

  it('a missing --timezone fails on stderr with exit 1 and prints no summary', async () => {
    const h = context({ yes: true });
    const { deps } = yesDeps();
    const code = await runInitCommand(deps)(h.ctx);
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
    const { deps } = yesDeps();
    const code = await runInitCommand(deps)(h.ctx);
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
    const { deps } = yesDeps();
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('--timezone requires --yes (non-interactive mode)');
    expect(h.out()).toBe('');
  });
});

describe('runInitCommand --yes (existing configuration, decision D-101)', () => {
  it('displays current settings, retains absent options, and writes nothing', async () => {
    const h = context({ yes: true, timezone: 'Europe/Berlin' });
    const { deps, writes } = yesDeps(EXISTING);
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.out()).toContain('Existing configuration found at');
    expect(h.out()).toContain('Options that are not passed keep the current values.');
    expect(h.out()).toContain("Accounts:          'work' (API key configured, hidden)");
    expect(h.out()).toContain('No changes — the existing configuration is kept');
    expect(writes()).toHaveLength(0);
  });

  it('an explicit option changes that setting and writes the merged config', async () => {
    const h = context({ yes: true, timezone: 'Europe/Berlin', port: '9001' });
    const { deps, writes } = yesDeps(EXISTING);
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(writes()).toHaveLength(1);
    const written = writes()[0];
    if (written !== undefined) {
      expect(written.config.server.port).toBe(9001);
      expect(written.config.server.host).toBe('127.0.0.1');
      expect(written.config.app.historyRetentionDays).toBe(90);
      expect(written.config.accounts).toEqual(EXISTING.accounts);
    }
    expect(h.out()).toContain('Configuration updated at');
  });

  it('the account flags fail against an existing configuration', async () => {
    const h = context({ yes: true, timezone: 'Europe/Berlin', 'account-label': 'work' });
    const { deps, writes } = yesDeps(EXISTING);
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain(
      'quotameter init: --account-label and --api-key-env apply only to a fresh initialization',
    );
    expect(writes()).toHaveLength(0);
  });
});

describe('renderInitSummary (environment key source)', () => {
  const base: InitAnswers = {
    timezone: 'UTC',
    host: '127.0.0.1',
    port: 8787,
    pollingIntervalSeconds: 300,
  };

  it('an environment-sourced key names the variable and never a value', () => {
    const summary = renderInitSummary(
      { ...base, accountLabel: 'work', accountApiKeyEnv: 'ZAI_KEY' },
      {
        kind: 'stored',
        account: {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'work',
          enabled: true,
          apiKeyEnv: 'ZAI_KEY',
        },
        test: { outcome: 'passed' },
      },
      false,
    );
    expect(summary).toContain(
      "'work' (API key from environment variable 'ZAI_KEY', value never stored or printed; connection test passed)",
    );
    expect(summary).not.toContain('Nothing has been written');
  });

  it('a label without any key source states the skip outcome', () => {
    expect(
      renderInitSummary(
        { ...base, accountLabel: 'work' },
        { kind: 'no-key', label: 'work' },
        false,
      ),
    ).toContain("none ('work' was named without an API key — add the account in the web UI)");
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
