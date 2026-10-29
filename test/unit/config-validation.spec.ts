import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  type SettingsValidationResult,
  validateSettings,
} from '../../src/services/config-validation';
import { parseConfig } from '../../src/config/load';
import type { Config } from '../../src/schemas/config';
import type { Validated } from '../../src/schemas/boundary';

/**
 * Locks the service settings-validation boundary (task 073, spec §5.3, §6,
 * §7.1; decision D-022): normalization of externally supplied settings
 * (string coercion, blank-means-not-supplied, secret verbatim-ness), the
 * keep-or-change merge over the current configuration, delegation of every
 * structural and cross-field rule to the landed parser, and the plaintext
 * password rules of §15.2. Real I/O belongs to the config layer's own tests.
 */

/** A synthetic API key — a fixture value, never a real secret (spec §15.4). */
const SYNTHETIC_KEY = 'sk-synthetic-fixture-key-not-real';

/** Minimal valid input for the parser; defaults completion makes it canonical. */
function parsed(input: unknown): Validated<Config> {
  const result = parseConfig(input);
  if (!result.ok) throw new Error(`fixture rejected by the parser: ${result.problems.join('; ')}`);
  return result.value;
}

/** A valid current configuration for merge tests (§5.3 re-init). */
function validBase(overrides: Record<string, unknown> = {}): Validated<Config> {
  return parsed({
    server: { host: '127.0.0.1', port: 9000 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 900, historyRetentionDays: 90 },
    auth: { mode: 'auto' },
    logging: { level: 'info' },
    accounts: [
      { id: 'zai-main', providerId: 'zai-coding-plan', label: 'Main', apiKey: SYNTHETIC_KEY },
    ],
    ...overrides,
  });
}

/** Problems of a rejected submission; a passing result fails the test loudly. */
function problemsOf(submission: unknown, base?: Validated<Config>): string[] {
  const result = validateSettings(submission, base);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.problems;
}

/** The config of an accepted submission; a failing result fails the test loudly. */
function configOf(submission: unknown, base?: Validated<Config>): CanonicalConfig {
  const result = validateSettings(submission, base);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  // The parser materializes every section (D-018); the static type cannot say so.
  return result.config as CanonicalConfig;
}

/** `Config` with the sections the parser's defaults completion materializes. */
type CanonicalConfig = Required<
  Pick<Config, 'server' | 'app' | 'auth' | 'logging' | 'providers' | 'accounts'>
> &
  Omit<Config, 'server' | 'app' | 'auth' | 'logging' | 'providers' | 'accounts'>;

describe('validateSettings — first-run init-shaped submissions (spec §5.3)', () => {
  it('accepts string answers and coerces them into the config shape', () => {
    const config = configOf({
      app: { timezone: ' Europe/Berlin ', pollingIntervalSeconds: '300' },
      server: { host: ' 127.0.0.1 ', port: '8787' },
    });
    expect(config.app.timezone).toBe('Europe/Berlin');
    expect(config.app.pollingIntervalSeconds).toBe(300);
    expect(config.server).toEqual({ host: '127.0.0.1', port: 8787 });
    // Everything the prompts do not ask for is completed from the defaults.
    expect(config.app.historyRetentionDays).toBe(180);
    expect(config.auth.mode).toBe('auto');
    expect(config.accounts).toEqual([]);
  });

  it('accepts native JSON types unchanged (the future API path, spec §13)', () => {
    const config = configOf({
      app: { timezone: 'UTC', pollingIntervalSeconds: 120 },
      server: { port: 9000 },
    });
    expect(config.app.pollingIntervalSeconds).toBe(120);
    expect(config.server.port).toBe(9000);
  });

  it('returns a validated config and the exact result shape', () => {
    const result = validateSettings({ app: { timezone: 'UTC' } });
    expect(result).toMatchObject({ ok: true, pendingPassword: undefined });
    expectTypeOf(result).toEqualTypeOf<SettingsValidationResult>();
  });

  it("rejects a non-object submission with the parser's root message", () => {
    expect(problemsOf('nope')).toEqual(['configuration: expected an object, got a string']);
    expect(problemsOf(null)).toEqual(['configuration: expected an object, got null']);
  });
});

describe('allowed intervals (spec §7.1: 60–3600 seconds)', () => {
  it.each([60, 300, 3600])('accepts the boundary/valid value %s', (seconds) => {
    const config = configOf({
      app: { timezone: 'UTC', pollingIntervalSeconds: seconds },
    });
    expect(config.app.pollingIntervalSeconds).toBe(seconds);
  });

  it.each([59, 3601])('rejects %s with a field-specific range problem', (seconds) => {
    expect(problemsOf({ app: { timezone: 'UTC', pollingIntervalSeconds: seconds } })).toEqual([
      `app.pollingIntervalSeconds: must be ${seconds < 60 ? '>= 60' : '<= 3600'}`,
    ]);
  });

  it('coerces numeric strings and rejects non-numeric ones', () => {
    const config = configOf({
      app: { timezone: 'UTC', pollingIntervalSeconds: ' 240 ' },
    });
    expect(config.app.pollingIntervalSeconds).toBe(240);
    expect(problemsOf({ app: { timezone: 'UTC', pollingIntervalSeconds: '5 minutes' } })).toEqual([
      'app.pollingIntervalSeconds: expected an integer',
    ]);
  });
});

describe('allowed timeouts (spec §7.2: 5–60 seconds)', () => {
  // A timeout rides on a provider entry; a submission introducing the
  // provider must carry its mandatory peak-hours schedule.
  const withTimeout = (seconds: number | string): Record<string, unknown> => ({
    app: { timezone: 'UTC' },
    providers: {
      'zai-coding-plan': {
        peakHours: { timezone: 'UTC', windows: [] },
        requestTimeoutSeconds: seconds,
      },
    },
  });

  it.each([5, 15, 60])('accepts the boundary/valid value %s', (seconds) => {
    const config = configOf(withTimeout(seconds));
    expect(config.providers['zai-coding-plan']?.requestTimeoutSeconds).toBe(seconds);
  });

  it.each([4, 61])('rejects %s with a field-specific range problem', (seconds) => {
    expect(problemsOf(withTimeout(seconds))).toEqual([
      `providers.zai-coding-plan.requestTimeoutSeconds: must be ${seconds < 5 ? '>= 5' : '<= 60'}`,
    ]);
  });

  it('reports the provider id and field for a non-numeric string', () => {
    expect(problemsOf(withTimeout('slow'))).toEqual([
      'providers.zai-coding-plan.requestTimeoutSeconds: expected an integer',
    ]);
  });
});

describe('allowed retention (spec §11.3: 7–3650 days)', () => {
  it.each([7, 180, 3650])('accepts the boundary/valid value %s', (days) => {
    const config = configOf({
      app: { timezone: 'UTC', historyRetentionDays: days },
    });
    expect(config.app.historyRetentionDays).toBe(days);
  });

  it.each([6, 3651])('rejects %s with a field-specific range problem', (days) => {
    expect(problemsOf({ app: { timezone: 'UTC', historyRetentionDays: days } })).toEqual([
      `app.historyRetentionDays: must be ${days < 7 ? '>= 7' : '<= 3650'}`,
    ]);
  });
});

describe('allowed host (spec §5.3, §15.1)', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])('accepts %s as a bind address', (host) => {
    const config = configOf({
      app: { timezone: 'UTC' },
      server: { host },
      auth: { passwordHash: `scrypt$${host}` }, // §15.1: non-loopback needs one
    });
    expect(config.server.host).toBe(host);
  });

  it('trims surrounding whitespace from the answer', () => {
    const config = configOf({
      app: { timezone: 'UTC' },
      server: { host: ' 127.0.0.1 ' },
    });
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('rejects an invalid time zone with the landed invariant message', () => {
    expect(problemsOf({ app: { timezone: 'Mars/Olympus' } })).toEqual([
      "app.timezone: 'Mars/Olympus' is not a valid IANA time zone",
    ]);
  });
});

describe('allowed port (spec §5.3: 1–65535)', () => {
  it.each([1, 8787, 65535])('accepts the boundary/valid value %s', (port) => {
    const config = configOf({
      app: { timezone: 'UTC' },
      server: { port },
    });
    expect(config.server.port).toBe(port);
  });

  it.each([0, 65536, -1])('rejects %s with a field-specific range problem', (port) => {
    expect(problemsOf({ app: { timezone: 'UTC' }, server: { port } })).toEqual([
      `server.port: must be ${port < 1 ? '>= 1' : '<= 65535'}`,
    ]);
  });

  it('rejects a non-numeric string with one coercion problem, not two', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, server: { port: 'http' } })).toEqual([
      'server.port: expected an integer',
    ]);
  });

  it('passes a wrong native type through for the parser to type-name', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, server: { port: true } })).toEqual([
      'server.port: expected an integer, got a boolean',
    ]);
  });
});

describe('allowed auth settings (spec §15.1, §15.2)', () => {
  it('rejects an unknown mode with the landed enum message', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, auth: { mode: 'sometimes' } })).toEqual([
      "auth.mode: must be one of: 'auto', 'required'",
    ]);
  });

  it('rejects a non-loopback bind without a password (spec §15.1)', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, server: { host: '0.0.0.0' } })).toEqual([
      'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
    ]);
  });

  it('rejects mode "required" without a password even on loopback', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, auth: { mode: 'required' } })).toEqual([
      'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
    ]);
  });

  it('accepts a non-loopback bind when a stored hash exists', () => {
    const config = configOf({
      app: { timezone: 'UTC' },
      server: { host: '0.0.0.0' },
      auth: { passwordHash: 'scrypt$1' },
    });
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.auth.passwordHash).toBe('scrypt$1');
  });
});

describe('the plaintext password (spec §5.3 step 4, §15.2)', () => {
  const validPassword = 'correct-horse-battery';

  it('accepts a non-loopback setup with a sufficiently long password', () => {
    const result = validateSettings({
      app: { timezone: 'UTC' },
      server: { host: '0.0.0.0' },
      auth: { password: validPassword },
    });
    expect(result).toMatchObject({ ok: true, pendingPassword: validPassword });
    if (!result.ok || result.pendingPassword === undefined) throw new Error('unreachable');
    // The configuration is complete except for the hash the auth service must write.
    expect(result.config.server?.host).toBe('0.0.0.0');
    expect(result.config.auth?.passwordHash).toBeUndefined();
  });

  it(`rejects a password shorter than ${MIN_PASSWORD_LENGTH} characters (spec §15.2)`, () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, auth: { password: 'short' } })).toEqual([
      `auth.password: must be at least ${MIN_PASSWORD_LENGTH} characters long (spec §15.2)`,
    ]);
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('rejects password and passwordHash supplied together', () => {
    expect(
      problemsOf({
        app: { timezone: 'UTC' },
        auth: { password: validPassword, passwordHash: 's$1' },
      }),
    ).toEqual([
      'auth: password and passwordHash are mutually exclusive — supply the plaintext password ' +
        '(to be hashed) or the stored hash, not both (spec §15.2)',
    ]);
  });

  it('treats a blank password as "not supplied"', () => {
    // Loopback + auto needs no password, so a blank answer is simply skipped
    // and nothing is pending…
    const skipped = validateSettings({ app: { timezone: 'UTC' }, auth: { password: '   ' } });
    expect(skipped).toMatchObject({ ok: true, pendingPassword: undefined });
    // …but a non-loopback bind with a blank answer still demands one.
    expect(
      problemsOf({
        app: { timezone: 'UTC' },
        server: { host: '0.0.0.0' },
        auth: { password: '   ' },
      }),
    ).toEqual([
      'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
    ]);
  });

  it('rejects a non-string password with a field-specific problem', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, auth: { password: 123456789012 } })).toEqual([
      'auth.password: expected a string',
    ]);
  });

  it('never leaks the password or the placeholder into any output (spec §15.4)', () => {
    const result = validateSettings({
      app: { timezone: 'UTC' },
      auth: { password: validPassword, mode: 'sometimes' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.join('\n')).not.toContain(validPassword);
    const accepted = validateSettings({
      app: { timezone: 'UTC' },
      server: { host: '0.0.0.0' },
      auth: { password: validPassword },
    });
    if (!accepted.ok || accepted.pendingPassword === undefined) throw new Error('unreachable');
    expect(JSON.stringify(accepted.config)).not.toContain('__quotameter-pending-password-hash__');
  });

  it('replaces the stored hash of the base configuration', () => {
    const base = parsed({
      app: { timezone: 'UTC' },
      auth: { mode: 'auto', passwordHash: 'scrypt$old' },
    });
    const result = validateSettings({ auth: { password: validPassword } }, base);
    expect(result).toMatchObject({ ok: true, pendingPassword: validPassword });
    if (!result.ok || result.pendingPassword === undefined) throw new Error('unreachable');
    expect(result.config.auth?.passwordHash).toBeUndefined();
    expect(result.config.auth?.mode).toBe('auto');
  });
});

describe('merge over the current configuration (spec §5.3 keep-or-change)', () => {
  it('keeps base values for omitted and blank answers', () => {
    const config = configOf(
      { app: { timezone: '   ', pollingIntervalSeconds: '   ' }, server: {} },
      validBase(),
    );
    expect(config.app.timezone).toBe('Europe/Berlin');
    expect(config.app.pollingIntervalSeconds).toBe(900);
    expect(config.server).toEqual({ host: '127.0.0.1', port: 9000 });
    expect(config.app.historyRetentionDays).toBe(90);
  });

  it('applies only the changed field, keeping sibling base values', () => {
    const config = configOf({ server: { port: '8443' }, logging: { level: 'debug' } }, validBase());
    expect(config.server).toEqual({ host: '127.0.0.1', port: 8443 });
    expect(config.logging.level).toBe('debug');
    expect(config.app.timezone).toBe('Europe/Berlin');
  });

  it('replaces the accounts array wholesale and normalizes its fields', () => {
    const config = configOf(
      {
        accounts: [
          {
            id: ' zai-second ',
            providerId: 'zai-coding-plan',
            label: ' Second ',
            apiKey: `  ${SYNTHETIC_KEY}  `,
          },
        ],
      },
      validBase(),
    );
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]).toMatchObject({ id: 'zai-second', label: 'Second' });
    // Secrets are verbatim: never trimmed, never echoed.
    expect(config.accounts[0]?.apiKey).toBe(`  ${SYNTHETIC_KEY}  `);
  });

  it('merges provider settings per id and replaces windows wholesale', () => {
    const base = parsed({
      app: { timezone: 'UTC' },
      providers: {
        'zai-coding-plan': {
          peakHours: {
            timezone: 'Asia/Singapore',
            offPeakMultiplier: 0.5,
            windows: [
              { id: 'peak', name: 'Peak', days: ['mon'], start: '14:00', end: '18:00' },
              { id: 'late', name: 'Late', days: ['tue'], start: '20:00', end: '23:00' },
            ],
          },
          requestTimeoutSeconds: 15,
        },
      },
    });
    const config = configOf(
      {
        providers: {
          'zai-coding-plan': {
            requestTimeoutSeconds: '20',
            peakHours: {
              windows: [{ id: ' w1 ', name: ' W ', days: ['wed '], start: '09:00', end: '12:00' }],
            },
          },
        },
      },
      base,
    );
    const provider = config.providers['zai-coding-plan'];
    expect(provider?.requestTimeoutSeconds).toBe(20);
    expect(provider?.peakHours.timezone).toBe('Asia/Singapore');
    expect(provider?.peakHours.offPeakMultiplier).toBe(0.5);
    expect(provider?.peakHours.windows).toEqual([
      { id: 'w1', name: 'W', days: ['wed'], start: '09:00', end: '12:00', multiplier: 1 },
    ]);
  });

  it('rejects an unknown provider-level key through delegation', () => {
    const base = parsed({
      app: { timezone: 'UTC' },
      providers: { 'zai-coding-plan': { peakHours: { timezone: 'UTC', windows: [] } } },
    });
    expect(problemsOf({ providers: { 'zai-coding-plan': { timeout: 20 } } }, base)).toEqual([
      "providers.zai-coding-plan: unknown property 'timeout'",
    ]);
  });

  it('re-checks the cross-field rules against the merged result', () => {
    // Loopback base, non-loopback answer, no password anywhere: the merged
    // configuration must be rejected even though the submission alone never
    // mentioned auth.
    expect(problemsOf({ server: { host: '0.0.0.0' } }, validBase())).toEqual([
      'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
    ]);
  });
});

describe('delegation to the landed parser (spec §6.2)', () => {
  it('rejects an unknown top-level key with the parser message', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, srv: { port: 1 } })).toEqual([
      "configuration: unknown property 'srv'",
    ]);
  });

  it('rejects an unknown nested key with the parser message', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, server: { hostname: '127.0.0.1' } })).toEqual([
      "server: unknown property 'hostname'",
    ]);
  });

  it('requires the explicit time zone (spec §5.3, §10)', () => {
    expect(problemsOf({})).toEqual(["configuration: missing required property 'app'"]);
    expect(problemsOf({ app: {} })).toEqual(["app: missing required property 'timezone'"]);
  });

  it('requires exactly one secret source per account (spec §6.3)', () => {
    expect(
      problemsOf({
        app: { timezone: 'UTC' },
        accounts: [{ id: 'a1', providerId: 'p', label: 'L' }],
      }),
    ).toEqual(["accounts[0] 'a1': exactly one of apiKey or apiKeyEnv must be set (spec §6.3)"]);
  });

  it('coerces the peak-hours multipliers from strings', () => {
    const config = configOf({
      app: { timezone: 'UTC' },
      providers: {
        'zai-coding-plan': {
          peakHours: {
            timezone: 'UTC',
            offPeakMultiplier: '0.5',
            windows: [
              {
                id: 'w',
                name: 'W',
                days: ['mon'],
                start: '01:00',
                end: '02:00',
                multiplier: '2.5',
              },
            ],
          },
        },
      },
    });
    const peak = config.providers['zai-coding-plan']?.peakHours;
    expect(peak?.offPeakMultiplier).toBe(0.5);
    expect(peak?.windows[0]?.multiplier).toBe(2.5);
  });

  it('reports a non-numeric multiplier with its window index', () => {
    expect(
      problemsOf({
        app: { timezone: 'UTC' },
        providers: {
          'zai-coding-plan': {
            peakHours: {
              timezone: 'UTC',
              windows: [
                {
                  id: 'w',
                  name: 'W',
                  days: ['mon'],
                  start: '01:00',
                  end: '02:00',
                  multiplier: 'high',
                },
              ],
            },
          },
        },
      }),
    ).toEqual(['providers.zai-coding-plan.peakHours.windows[0].multiplier: expected a number']);
  });

  it('accumulates normalization and parser problems together', () => {
    const problems = problemsOf({
      server: { port: 'http' },
      app: { timezone: 'UTC', pollingIntervalSeconds: 10 },
    });
    expect(problems).toContain('server.port: expected an integer');
    expect(problems).toContain('app.pollingIntervalSeconds: must be >= 60');
  });

  it('never echoes a submitted secret in any problem (spec §15.4)', () => {
    const problems = problemsOf({
      app: { timezone: 'UTC' },
      accounts: [{ id: 'a1', providerId: 'p', label: 'L', apiKey: SYNTHETIC_KEY, apiKeyEnv: 'K' }],
    });
    expect(problems.join('\n')).not.toContain(SYNTHETIC_KEY);
    expect(problems.join('\n')).toContain('mutually exclusive');
  });

  it("rejects a JSON-derived own '__proto__' key like any other unknown key", () => {
    // Built with JSON.parse: an object literal would set the prototype
    // instead of creating the own property this test needs to exercise.
    const topLevel = JSON.parse('{"app":{"timezone":"UTC"},"__proto__":5}');
    expect(problemsOf(topLevel)).toEqual(["configuration: unknown property '__proto__'"]);

    const nested = JSON.parse(
      '{"app":{"timezone":"UTC"},"server":{"host":"127.0.0.1","__proto__":"oops"}}',
    );
    expect(problemsOf(nested)).toEqual(["server: unknown property '__proto__'"]);

    const asProviderId = JSON.parse(
      '{"app":{"timezone":"UTC"},"providers":{"__proto__":{"peakHours":{"timezone":"UTC","windows":[]}}}}',
    );
    expect(problemsOf(asProviderId)).toEqual([
      "providers: property name '__proto__' must match the pattern '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'",
    ]);
  });

  it('pins the parser messages for non-object section shapes', () => {
    expect(problemsOf({ app: { timezone: 'UTC' }, server: 5 })).toEqual([
      'server: expected an object, got a number',
    ]);
    expect(problemsOf({ app: { timezone: 'UTC' }, accounts: 'x' })).toEqual([
      'accounts: expected an array, got a string',
    ]);
    expect(
      problemsOf({
        app: { timezone: 'UTC' },
        providers: {
          'zai-coding-plan': { peakHours: { timezone: 'UTC', windows: 3 } },
        },
      }),
    ).toEqual(['providers.zai-coding-plan.peakHours.windows: expected an array, got a number']);
  });

  it('never mutates the submission, accepted or rejected', () => {
    const rejected = JSON.parse('{"app":{"timezone":" UTC "},"server":{"port":"8787"},"nope":1}');
    deepFreeze(rejected);
    expect(validateSettings(rejected).ok).toBe(false); // the unknown 'nope'
    expect(JSON.stringify(rejected)).toBe(
      '{"app":{"timezone":" UTC "},"server":{"port":"8787"},"nope":1}',
    );

    const accepted = JSON.parse(
      '{"app":{"timezone":" UTC "},"server":{"port":"8787"},"auth":{"password":"correct-horse-battery"}}',
    );
    deepFreeze(accepted);
    // Exercises the coercion, merge, placeholder, and strip paths on the
    // frozen object; any mutation throws in strict mode.
    const result = validateSettings(accepted);
    expect(result).toMatchObject({ ok: true, pendingPassword: 'correct-horse-battery' });
    expect(JSON.stringify(accepted)).toBe(
      '{"app":{"timezone":" UTC "},"server":{"port":"8787"},"auth":{"password":"correct-horse-battery"}}',
    );
  });
});

/** Freezes a parsed-JSON structure so any mutation throws in strict mode. */
function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
