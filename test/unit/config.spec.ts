import { describe, expect, expectTypeOf, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { fc } from '../helpers/property';
import {
  AUTH_MODES,
  CONFIG_DEFAULTS,
  LOG_LEVELS,
  WEEK_DAYS,
  AccountConfigSchema,
  AppConfigSchema,
  AuthConfigSchema,
  ConfigSchema,
  LoggingConfigSchema,
  PeakHoursConfigSchema,
  PeakWindowSchema,
  ProviderConfigSchema,
  ServerConfigSchema,
  findConfigProblems,
  isLoopbackHost,
  isValidTimeZoneName,
} from '../../src/schemas/config';
import type {
  AccountConfig,
  AuthConfig,
  AuthMode,
  Config,
  LogLevel,
  PeakHoursConfig,
  PeakWindow,
  ServerConfig,
  WeekDay,
} from '../../src/schemas/config';

/**
 * Locks the central configuration contract (spec §6.2): the TypeBox schema
 * (structural rules: types, ranges, patterns, closed enums, no unknown keys)
 * and the semantic invariants of `findConfigProblems` (cross-field rules the
 * schema cannot express). Runtime loading and validation are task 064; here
 * the contract itself is under test, checked with TypeBox's own Value module.
 */

/** The peak-hours sample from spec §9.2, verbatim; fresh object per call. */
const zaiPeakHours = (): PeakHoursConfig => ({
  timezone: 'Asia/Singapore',
  offPeakMultiplier: 0.5,
  windows: [
    {
      id: 'zai-weekday-peak',
      name: 'Z.ai Coding Plan peak hours',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '14:00',
      end: '18:00',
      multiplier: 1.0,
    },
  ],
});

/** A fully populated, valid configuration. Values are synthetic, not secrets. */
function validConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto' },
    logging: { level: 'warn' },
    providers: {
      'zai-coding-plan': { peakHours: zaiPeakHours(), requestTimeoutSeconds: 15 },
    },
    accounts: [
      {
        id: 'zai-main',
        providerId: 'zai-coding-plan',
        label: 'Main subscription',
        enabled: true,
        apiKey: 'synthetic-test-key-not-a-real-secret',
      },
    ],
    ...overrides,
  };
}

/** Literal values of a TypeBox union schema, in declared order. */
function literalsOf(schema: { anyOf: { const: unknown }[] }): string[] {
  return schema.anyOf.map((member) => String(member.const));
}

describe('closed enums (spec §15.1, §16, §9.2)', () => {
  it('holds exactly the spec value sets', () => {
    expect([...AUTH_MODES]).toEqual(['auto', 'required']);
    expect([...LOG_LEVELS]).toEqual(['error', 'warn', 'info', 'debug']);
    expect([...WEEK_DAYS]).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('mirrors the enum arrays in the schemas', () => {
    expect(literalsOf(AuthConfigSchema.properties.mode)).toEqual([...AUTH_MODES]);
    expect(literalsOf(LoggingConfigSchema.properties.level)).toEqual([...LOG_LEVELS]);
    expect(literalsOf(PeakWindowSchema.properties.days.items)).toEqual([...WEEK_DAYS]);
    expectTypeOf<AuthMode>().toEqualTypeOf<'auto' | 'required'>();
    expectTypeOf<LogLevel>().toEqualTypeOf<'error' | 'warn' | 'info' | 'debug'>();
    expectTypeOf<WeekDay>().toEqualTypeOf<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>();
  });
});

describe('schema structure (spec §6.2)', () => {
  it('accepts the complete configuration, including the §9.2 sample schedule', () => {
    const config = validConfig();
    expect(Value.Check(ConfigSchema, config)).toBe(true);
    expect(findConfigProblems(config)).toEqual([]);
  });

  it('accepts a minimal configuration with only the mandatory app.timezone', () => {
    const minimal: Config = { app: { timezone: 'UTC' } };
    expect(Value.Check(ConfigSchema, minimal)).toBe(true);
    expect(findConfigProblems(minimal)).toEqual([]);
  });

  it('requires the app section and its timezone, and nothing else', () => {
    expect(ConfigSchema.required).toEqual(['app']);
    expect(AppConfigSchema.required).toEqual(['timezone']);
  });

  it('rejects unknown keys at every level (hand-edited file, spec §9.2)', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['top level', { app: { timezone: 'UTC' }, timezone: 'Europe/Berlin' }],
      ['server', { app: { timezone: 'UTC' }, server: { hosts: '127.0.0.1' } }],
      ['app', { app: { timezone: 'UTC', tz: 'UTC' } }],
      ['auth', { app: { timezone: 'UTC' }, auth: { modes: 'auto' } }],
      ['logging', { app: { timezone: 'UTC' }, logging: { lvl: 'warn' } }],
      ['provider', { app: { timezone: 'UTC' }, providers: { zai: { timeout: 15 } } }],
      [
        'peakHours',
        {
          app: { timezone: 'UTC' },
          providers: { zai: { peakHours: { timezone: 'UTC', windows: [], hrs: 1 } } },
        },
      ],
      [
        'window',
        {
          app: { timezone: 'UTC' },
          providers: {
            zai: {
              peakHours: {
                timezone: 'UTC',
                windows: [
                  {
                    id: 'w',
                    name: 'W',
                    days: ['mon'],
                    start: '01:00',
                    end: '02:00',
                    from: '01:00',
                  },
                ],
              },
            },
          },
        },
      ],
      [
        'account',
        {
          app: { timezone: 'UTC' },
          accounts: [{ id: 'a', providerId: 'zai', label: 'A', key: 'x' }],
        },
      ],
    ];
    for (const [label, value] of cases) {
      expect(Value.Check(ConfigSchema, value), `unknown key must fail: ${label}`).toBe(false);
    }
  });
});

describe('per-field validation ranges', () => {
  it('rejects invalid server values (spec §5.3)', () => {
    for (const server of [
      { host: '' },
      { port: 0 },
      { port: 65536 },
      { port: -1 },
      { port: '8787' },
      { port: 8787.5 },
    ]) {
      expect(Value.Check(ServerConfigSchema, server), JSON.stringify(server)).toBe(false);
    }
    expect(Value.Check(ServerConfigSchema, {})).toBe(true);
  });

  it('rejects invalid app values (spec §7.1, §11.3, §10)', () => {
    for (const app of [
      {},
      { timezone: '' },
      { timezone: 'UTC', pollingIntervalSeconds: 59 },
      { timezone: 'UTC', pollingIntervalSeconds: 3601 },
      { timezone: 'UTC', pollingIntervalSeconds: 300.5 },
      { timezone: 'UTC', historyRetentionDays: 6 },
      { timezone: 'UTC', historyRetentionDays: 3651 },
    ]) {
      expect(Value.Check(AppConfigSchema, app), JSON.stringify(app)).toBe(false);
    }
    expect(Value.Check(AppConfigSchema, { timezone: 'UTC' })).toBe(true);
  });

  it('rejects invalid auth and logging values (spec §15.1, §16)', () => {
    expect(Value.Check(AuthConfigSchema, { mode: 'open' })).toBe(false);
    expect(Value.Check(AuthConfigSchema, { passwordHash: '' })).toBe(false);
    expect(Value.Check(AuthConfigSchema, {})).toBe(true);
    expect(Value.Check(LoggingConfigSchema, { level: 'trace' })).toBe(false);
    expect(Value.Check(LoggingConfigSchema, { level: 'WARN' })).toBe(false);
    expect(Value.Check(LoggingConfigSchema, {})).toBe(true);
  });

  it('rejects invalid peak-window values (spec §9.2)', () => {
    const window = { id: 'w', name: 'W', days: ['mon'], start: '01:00', end: '02:00' };
    for (const overrides of [
      { id: '' },
      { name: '' },
      { days: [] },
      { days: ['mon', 'mon'] },
      { days: ['monday'] },
      { days: ['MON'] },
      { start: '9:00' },
      { start: '24:00' },
      { end: '24:01' },
      { end: '25:00' },
      { end: '2:00' },
      { multiplier: 0 },
      { multiplier: -0.5 },
      { multiplier: 'high' },
    ]) {
      const candidate = { ...window, ...overrides };
      expect(Value.Check(PeakWindowSchema, candidate), JSON.stringify(candidate)).toBe(false);
    }
    // `24:00` is a legal end, and `multiplier` is optional.
    expect(Value.Check(PeakWindowSchema, { ...window, end: '24:00' })).toBe(true);
    expect(Value.Check(PeakWindowSchema, window)).toBe(true);
  });

  it('requires peakHours with windows and a timezone per provider (spec §9.2)', () => {
    expect(Value.Check(ProviderConfigSchema, {})).toBe(false);
    expect(Value.Check(ProviderConfigSchema, { requestTimeoutSeconds: 15 })).toBe(false);
    expect(Value.Check(PeakHoursConfigSchema, { timezone: 'UTC' })).toBe(false);
    expect(Value.Check(PeakHoursConfigSchema, { timezone: 'UTC', windows: [] })).toBe(true);
    expect(Value.Check(ProviderConfigSchema, { peakHours: { timezone: 'UTC', windows: [] } })).toBe(
      true,
    );
    expect(
      Value.Check(ProviderConfigSchema, {
        peakHours: { timezone: 'UTC', windows: [] },
        requestTimeoutSeconds: 4,
      }),
    ).toBe(false);
    expect(
      Value.Check(ProviderConfigSchema, {
        peakHours: { timezone: 'UTC', windows: [] },
        requestTimeoutSeconds: 61,
      }),
    ).toBe(false);
  });

  it('rejects invalid provider configuration (spec §9.2)', () => {
    const provider = { peakHours: { timezone: 'UTC', windows: [] } };
    // Provider keys outside the URL-safe id charset would match no
    // patternProperties entry and skip validation entirely; the closed
    // record rejects them (found in review).
    for (const key of ['za\ni', 'za i', '', 'не-id']) {
      const config: Config = { app: { timezone: 'UTC' }, providers: { [key]: provider } };
      expect(Value.Check(ConfigSchema, config), JSON.stringify(key)).toBe(false);
    }
    // Values are still validated, not just keys.
    expect(Value.Check(ConfigSchema, { app: { timezone: 'UTC' }, providers: { zai: 42 } })).toBe(
      false,
    );
    expect(
      Value.Check(ConfigSchema, { app: { timezone: 'UTC' }, providers: { zai: provider } }),
    ).toBe(true);
    expect(Value.Check(ConfigSchema, { app: { timezone: 'UTC' }, providers: {} })).toBe(true);
  });

  it('rejects invalid account values (spec §6.2)', () => {
    for (const overrides of [
      { id: '' },
      { id: '-leading-dash' },
      { id: 'has space' },
      { id: 'a'.repeat(65) },
      { providerId: '' },
      { label: '' },
      { apiKey: '' },
      { apiKeyEnv: '' },
      { apiKeyEnv: 'lower-case' },
      { apiKeyEnv: '1STARTS_WITH_DIGIT' },
      { enabled: 'yes' },
    ]) {
      const candidate = { id: 'a1', providerId: 'zai', label: 'A', ...overrides };
      expect(Value.Check(AccountConfigSchema, candidate), JSON.stringify(candidate)).toBe(false);
    }
    expect(Value.Check(AccountConfigSchema, { id: 'a1', providerId: 'zai', label: 'A' })).toBe(
      true,
    );
  });
});

describe('defaults (spec §5.3, §7.1, §7.2, §11.3, §15.1, §16)', () => {
  it('annotates the schema with the spec defaults', () => {
    expect((ServerConfigSchema.properties.host as { default?: string }).default).toBe(
      CONFIG_DEFAULTS.server.host,
    );
    expect((ServerConfigSchema.properties.port as { default?: number }).default).toBe(
      CONFIG_DEFAULTS.server.port,
    );
    expect(
      (AppConfigSchema.properties.pollingIntervalSeconds as { default?: number }).default,
    ).toBe(CONFIG_DEFAULTS.app.pollingIntervalSeconds);
    expect((AppConfigSchema.properties.historyRetentionDays as { default?: number }).default).toBe(
      CONFIG_DEFAULTS.app.historyRetentionDays,
    );
    expect((AuthConfigSchema.properties.mode as { default?: AuthMode }).default).toBe(
      CONFIG_DEFAULTS.auth.mode,
    );
    expect((LoggingConfigSchema.properties.level as { default?: LogLevel }).default).toBe(
      CONFIG_DEFAULTS.logging.level,
    );
    expect(
      (ProviderConfigSchema.properties.requestTimeoutSeconds as { default?: number }).default,
    ).toBe(CONFIG_DEFAULTS.provider.requestTimeoutSeconds);
    expect(
      (PeakHoursConfigSchema.properties.offPeakMultiplier as { default?: number }).default,
    ).toBe(CONFIG_DEFAULTS.peakHours.offPeakMultiplier);
    expect((PeakWindowSchema.properties.multiplier as { default?: number }).default).toBe(
      CONFIG_DEFAULTS.peakHours.windowMultiplier,
    );
  });

  it('documents every spec default in CONFIG_DEFAULTS', () => {
    expect(CONFIG_DEFAULTS.server).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(CONFIG_DEFAULTS.app).toEqual({
      pollingIntervalSeconds: 300,
      historyRetentionDays: 180,
    });
    expect(CONFIG_DEFAULTS.auth).toEqual({ mode: 'auto' });
    expect(CONFIG_DEFAULTS.logging).toEqual({ level: 'warn' });
    expect(CONFIG_DEFAULTS.provider).toEqual({ requestTimeoutSeconds: 15 });
    expect(CONFIG_DEFAULTS.peakHours).toEqual({ offPeakMultiplier: 1, windowMultiplier: 1 });
  });
});

describe('time zone validation (spec §5.3, §10, §9.2)', () => {
  it('accepts IANA zones, aliases, and UTC', () => {
    for (const zone of [
      'UTC',
      'utc', // V8 resolves IANA names case-insensitively; same resolver the display path uses
      'Europe/Berlin',
      'Asia/Singapore',
      'Asia/Calcutta',
      'Etc/GMT+8',
    ]) {
      expect(isValidTimeZoneName(zone), zone).toBe(true);
    }
  });

  it('rejects non-IANA and offset identifiers', () => {
    for (const zone of ['', 'Not/AZone', 'localtime', 'UTC+3', '+03:00', '-05:00']) {
      expect(isValidTimeZoneName(zone), zone).toBe(false);
    }
  });

  it('rejects invalid time zones in both timezone settings', () => {
    expect(findConfigProblems({ app: { timezone: 'Not/AZone' } })).toContain(
      "app.timezone: 'Not/AZone' is not a valid IANA time zone",
    );
    const config: Config = {
      ...validConfig(),
      providers: { zai: { peakHours: { timezone: '+03:00', windows: [] } } },
    };
    expect(findConfigProblems(config)).toContain(
      "providers.zai.peakHours.timezone: '+03:00' is not a valid IANA time zone",
    );
  });
});

describe('loopback classification (spec §15.1)', () => {
  it('classifies loopback and non-loopback hosts', () => {
    for (const host of ['127.0.0.1', '127.5.5.5', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '192.168.1.5', 'example.com', '::', '[::]', '128.0.0.1', '']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('account secret sources (spec §6.3)', () => {
  const base = { id: 'a1', providerId: 'zai', label: 'A' };

  it('accepts exactly one source: apiKey or apiKeyEnv', () => {
    const withKey: Config = {
      app: { timezone: 'UTC' },
      accounts: [{ ...base, apiKey: 'synthetic-key' }],
    };
    const withEnv: Config = {
      app: { timezone: 'UTC' },
      accounts: [{ ...base, apiKeyEnv: 'QUOTAMETER_TEST_KEY' }],
    };
    expect(findConfigProblems(withKey)).toEqual([]);
    expect(findConfigProblems(withEnv)).toEqual([]);
  });

  it('rejects both sources at once and neither source at all', () => {
    const both: Config = {
      app: { timezone: 'UTC' },
      accounts: [{ ...base, apiKey: 'synthetic-key', apiKeyEnv: 'QUOTAMETER_TEST_KEY' }],
    };
    const neither: Config = { app: { timezone: 'UTC' }, accounts: [{ ...base }] };
    expect(findConfigProblems(both)).toEqual([
      "accounts[0] 'a1': apiKey and apiKeyEnv are mutually exclusive (spec §6.3)",
    ]);
    expect(findConfigProblems(neither)).toEqual([
      "accounts[0] 'a1': exactly one of apiKey or apiKeyEnv must be set (spec §6.3)",
    ]);
  });

  it('rejects duplicate account ids', () => {
    const config: Config = {
      app: { timezone: 'UTC' },
      accounts: [
        { ...base, apiKey: 'synthetic-key-1' },
        { ...base, apiKey: 'synthetic-key-2' },
      ],
    };
    expect(findConfigProblems(config)).toEqual(["accounts[1]: duplicate account id 'a1'"]);
  });

  it('keeps secrets opaque: any non-empty string validates, no pattern constrains them', () => {
    const exotic = '🔑 not-a-real-secret — with spaces & symbols!';
    const account = Value.Cast(AccountConfigSchema, { ...base, apiKey: exotic });
    expect(account.apiKey).toBe(exotic);
    expect(AccountConfigSchema.properties.apiKey.pattern).toBeUndefined();
    expect(AuthConfigSchema.properties.passwordHash.pattern).toBeUndefined();
    // Env-var *names* stay identifiers; the key value itself never does.
    expect(AccountConfigSchema.properties.apiKeyEnv.pattern).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
  });
});

describe('peak-hours invariants (spec §9.2)', () => {
  const window = (overrides: Partial<PeakWindow> = {}): PeakWindow => ({
    id: 'w1',
    name: 'W1',
    days: ['mon'],
    start: '14:00',
    end: '18:00',
    ...overrides,
  });

  /** A valid base configuration whose single provider schedule is replaced. */
  const withWindows = (...windows: PeakWindow[]): Config => ({
    ...validConfig(),
    providers: { zai: { peakHours: { timezone: 'UTC', windows } } },
  });

  it('accepts adjacent windows on the same day and identical times on different days', () => {
    expect(
      findConfigProblems(
        withWindows(
          window({ id: 'am', start: '10:00', end: '14:00' }),
          window({ id: 'pm', start: '14:00', end: '18:00' }),
        ),
      ),
    ).toEqual([]);
    expect(
      findConfigProblems(
        withWindows(window({ id: 'mon-w', days: ['mon'] }), window({ id: 'tue-w', days: ['tue'] })),
      ),
    ).toEqual([]);
  });

  it('rejects start not earlier than end, which also covers midnight crossing', () => {
    expect(findConfigProblems(withWindows(window({ start: '18:00', end: '14:00' })))).toEqual([
      "providers.zai.peakHours.windows[0] 'w1': start '18:00' must be earlier than end '14:00'",
    ]);
    expect(findConfigProblems(withWindows(window({ start: '22:00', end: '02:00' })))).toHaveLength(
      1,
    );
    expect(findConfigProblems(withWindows(window({ start: '14:00', end: '14:00' })))).toHaveLength(
      1,
    );
    // The maximal legal window ends at midnight; `00:00` as an end is impossible.
    expect(findConfigProblems(withWindows(window({ start: '00:00', end: '24:00' })))).toEqual([]);
    expect(findConfigProblems(withWindows(window({ start: '10:00', end: '00:00' })))).toHaveLength(
      1,
    );
  });

  it('rejects overlapping windows on the same day only', () => {
    expect(
      findConfigProblems(
        withWindows(window({ id: 'early', end: '16:00' }), window({ id: 'late', start: '15:00' })),
      ),
    ).toEqual(["providers.zai.peakHours: windows 'early' and 'late' overlap on 'mon'"]);
    // The same times on disjoint days do not overlap.
    expect(
      findConfigProblems(
        withWindows(
          window({ id: 'early', end: '16:00', days: ['mon', 'wed'] }),
          window({ id: 'late', start: '15:00', days: ['tue'] }),
        ),
      ),
    ).toEqual([]);
    // A window nested inside an earlier one is containment, still an overlap.
    expect(
      findConfigProblems(
        withWindows(
          window({ id: 'all-day', start: '08:00', end: '20:00' }),
          window({ id: 'inner', start: '10:00', end: '12:00' }),
          window({ id: 'after', start: '21:00', end: '22:00' }),
        ),
      ),
    ).toEqual(["providers.zai.peakHours: windows 'all-day' and 'inner' overlap on 'mon'"]);
  });

  it('rejects duplicate window ids within one schedule', () => {
    expect(
      findConfigProblems(withWindows(window({ days: ['mon'] }), window({ days: ['tue'] }))),
    ).toEqual(["providers.zai.peakHours.windows[1]: duplicate window id 'w1'"]);
  });

  it('checks each provider independently', () => {
    const config: Config = {
      ...validConfig(),
      providers: {
        zai: { peakHours: { timezone: 'Asia/Singapore', windows: [] } },
        other: {
          peakHours: {
            timezone: 'UTC',
            windows: [{ id: 'bad', name: 'Bad', days: ['mon'], start: '18:00', end: '09:00' }],
          },
        },
      },
    };
    expect(findConfigProblems(config)).toEqual([
      "providers.other.peakHours.windows[0] 'bad': start '18:00' must be earlier than end '09:00'",
    ]);
  });
});

describe('authentication/network consistency (spec §15.1)', () => {
  /** A minimal config with optional server/auth sections overlaid. */
  const configWith = (server?: ServerConfig, auth?: AuthConfig): Config => ({
    app: { timezone: 'UTC' },
    ...(server ? { server } : {}),
    ...(auth ? { auth } : {}),
  });

  it('allows passwordless loopback access in auto mode', () => {
    expect(findConfigProblems(configWith({ host: '127.0.0.1' }))).toEqual([]);
    expect(findConfigProblems(configWith({ host: 'localhost' }))).toEqual([]);
    expect(findConfigProblems(configWith({ host: '::1' }))).toEqual([]);
  });

  it('demands a password for non-loopback binds or required mode', () => {
    const expected = [
      'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
    ];
    expect(findConfigProblems(configWith({ host: '0.0.0.0' }))).toEqual(expected);
    expect(findConfigProblems(configWith({ host: '192.168.1.5' }))).toEqual(expected);
    expect(findConfigProblems(configWith({ host: '127.0.0.1' }, { mode: 'required' }))).toEqual(
      expected,
    );
    // Defaults are consulted: no server/auth section means 127.0.0.1 + auto.
    expect(findConfigProblems(configWith())).toEqual([]);
  });

  it('accepts a configured password hash in every mode', () => {
    expect(
      findConfigProblems(configWith({ host: '0.0.0.0' }, { passwordHash: 'synthetic-hash' })),
    ).toEqual([]);
    expect(
      findConfigProblems(
        configWith({ host: '127.0.0.1' }, { mode: 'required', passwordHash: 'synthetic-hash' }),
      ),
    ).toEqual([]);
  });
});

describe('property: window ordering mirrors start < end (spec §9.2)', () => {
  const hhmm = fc
    .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
    .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);

  it('flags a window exactly when start >= end', () => {
    fc.assert(
      fc.property(hhmm, hhmm, (start, end) => {
        const config: Config = {
          app: { timezone: 'UTC' },
          providers: {
            zai: {
              peakHours: {
                timezone: 'UTC',
                windows: [{ id: 'w', name: 'W', days: ['mon'], start, end }],
              },
            },
          },
        };
        const flagged = findConfigProblems(config).some((problem) =>
          problem.includes('must be earlier than end'),
        );
        const toMinutes = (value: string) =>
          Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
        expect(flagged).toBe(toMinutes(start) >= toMinutes(end));
      }),
    );
  });
});

describe('derived types stay ergonomic (compile-time pins)', () => {
  it('derives optional and required fields as the contract states', () => {
    expectTypeOf<Config['server']>().toEqualTypeOf<ServerConfig | undefined>();
    expectTypeOf<Config['app']['timezone']>().toEqualTypeOf<string>();
    expectTypeOf<Config['accounts']>().toEqualTypeOf<AccountConfig[] | undefined>();
    expectTypeOf<AccountConfig['apiKey']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AccountConfig['apiKeyEnv']>().toEqualTypeOf<string | undefined>();
  });
});
