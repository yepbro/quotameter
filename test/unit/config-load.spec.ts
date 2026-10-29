import { describe, expect, expectTypeOf, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CONFIG_FILE_NAME,
  type ConfigReadFilesystem,
  configBoundaryParser,
  configFilePath,
  formatSchemaError,
  loadConfigFile,
  parseConfig,
  parseJson,
} from '../../src/config/load';
import { ConfigSchema, findConfigProblems } from '../../src/schemas/config';
import type { Config } from '../../src/schemas/config';
import type { BoundaryParser, Validated } from '../../src/schemas/boundary';
import type { ErrorObject } from 'ajv/dist/2020';

/**
 * Locks the pure half of configuration loading (spec §6.2; decision D-018):
 * JSON parsing with secret-safe errors, the composed boundary parser
 * (Ajv structural errors + `findConfigProblems`), defaults completion into
 * a canonical configuration, and the field-addressed problems vocabulary.
 * Real file reads live in `test/integration/config-load.spec.ts`.
 */

/** A fully populated, valid configuration; values are synthetic, not secrets. */
function validConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto' },
    logging: { level: 'warn' },
    providers: {
      'zai-coding-plan': {
        peakHours: {
          timezone: 'Asia/Singapore',
          offPeakMultiplier: 0.5,
          windows: [
            {
              id: 'zai-weekday-peak',
              name: 'Z.ai Coding Plan peak hours',
              days: ['mon', 'tue', 'wed', 'thu', 'fri'],
              start: '14:00',
              end: '18:00',
              multiplier: 1,
            },
          ],
        },
        requestTimeoutSeconds: 15,
      },
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

/** A structurally valid provider entry with only the mandatory fields. */
const minimalProvider = {
  peakHours: {
    timezone: 'UTC',
    windows: [{ id: 'w', name: 'W', days: ['mon'], start: '01:00', end: '02:00' }],
  },
};

describe('file naming (spec §6.1, decision D-011 deferred it here)', () => {
  it('pins the file name and composes it with the resolved config directory', () => {
    expect(CONFIG_FILE_NAME).toBe('config.json');
    expect(configFilePath('/home/user/.config/quotameter')).toBe(
      '/home/user/.config/quotameter/config.json',
    );
  });
});

describe('parseJson', () => {
  it('parses valid JSON of any type', () => {
    expect(parseJson('{"app":{"timezone":"UTC"}}')).toEqual({
      ok: true,
      value: { app: { timezone: 'UTC' } },
    });
    expect(parseJson('123')).toEqual({ ok: true, value: 123 });
  });

  it('reports malformed JSON with one readable problem', () => {
    const result = parseJson('{"app": }');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.problems[0]).toMatch(/^invalid JSON: /);
    expect(result.ok === false && result.problems).toHaveLength(1);
  });

  it('reports trailing garbage instead of silently accepting it', () => {
    const result = parseJson('{"app":{"timezone":"UTC"}} extra');
    expect(result.ok).toBe(false);
  });

  it('never echoes the V8 error snippet, so secrets stay out of problems (spec §15.4)', () => {
    const secret = 'sk-synthetic-secret-value-12345';
    const result = parseJson(`{"apiKey": "${secret}",}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatch(/^invalid JSON: /);
      expect(result.problems.join('\n')).not.toContain(secret);
    }
  });
});

describe('parseConfig — valid input (spec §6.2)', () => {
  it('accepts the complete configuration unchanged and returns a validated value', () => {
    const result = parseConfig(validConfig());
    expect(result).toEqual({ ok: true, value: validConfig() });
    expectTypeOf(result).toEqualTypeOf<
      { ok: true; value: Validated<Config> } | { ok: false; problems: string[] }
    >();
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<Validated<Config>>();
    }
  });

  it('completes a minimal configuration into the canonical one (defaults, spec §5.3, §7.1, §7.2, §11.3, §15.1, §16)', () => {
    const result = parseConfig({ app: { timezone: 'UTC' } });
    expect(result).toEqual({
      ok: true,
      value: {
        server: { host: '127.0.0.1', port: 8787 },
        app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
        auth: { mode: 'auto' },
        logging: { level: 'warn' },
        providers: {},
        accounts: [],
      },
    });
  });

  it('fills provider, schedule, window, and account defaults (spec §7.2, §9.2)', () => {
    const result = parseConfig({
      app: { timezone: 'UTC' },
      providers: { zai: minimalProvider },
      accounts: [{ id: 'a1', providerId: 'zai', label: 'A', apiKey: 'synthetic-key' }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        server: { host: '127.0.0.1', port: 8787 },
        app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
        auth: { mode: 'auto' },
        logging: { level: 'warn' },
        providers: {
          zai: {
            peakHours: {
              timezone: 'UTC',
              offPeakMultiplier: 1,
              windows: [
                {
                  id: 'w',
                  name: 'W',
                  days: ['mon'],
                  start: '01:00',
                  end: '02:00',
                  multiplier: 1,
                },
              ],
            },
            requestTimeoutSeconds: 15,
          },
        },
        accounts: [
          { id: 'a1', providerId: 'zai', label: 'A', enabled: true, apiKey: 'synthetic-key' },
        ],
      },
    });
  });

  it('keeps absent secrets absent instead of materializing undefined keys', () => {
    const result = parseConfig({ app: { timezone: 'UTC' } });
    if (result.ok) {
      // toStrictEqual also fails on keys present with an `undefined` value.
      expect(result.value.auth).toStrictEqual({ mode: 'auto' });
    }
  });

  it('treats the input as read-only', () => {
    const input = { app: { timezone: 'UTC' } };
    parseConfig(input);
    expect(input).toEqual({ app: { timezone: 'UTC' } });
  });

  it('is deterministic: the same broken input yields the same problems twice', () => {
    const input = { app: { timezone: 'UTC' }, server: { port: 0 }, auth: { mode: 'sometimes' } };
    expect(parseConfig(input)).toEqual(parseConfig(input));
  });
});

describe('parseConfig — structural problems are field-specific and readable', () => {
  const rejectsWith = (input: unknown, ...problems: string[]): void => {
    const result = parseConfig(input);
    expect(result).toEqual({ ok: false, problems });
  };

  it('rejects non-object roots naming the actual JSON type', () => {
    rejectsWith(42, 'configuration: expected an object, got a number');
    rejectsWith([1], 'configuration: expected an object, got an array');
    rejectsWith(null, 'configuration: expected an object, got null');
  });

  it('names missing required properties at every level', () => {
    rejectsWith({}, "configuration: missing required property 'app'");
    rejectsWith({ app: {} }, "app: missing required property 'timezone'");
  });

  it('names unknown properties at every level (hand-edited file, spec §9.2)', () => {
    rejectsWith(
      { app: { timezone: 'UTC' }, ap: { timezone: 'UTC' } },
      "configuration: unknown property 'ap'",
    );
    rejectsWith(
      { app: { timezone: 'UTC' }, server: { hosts: '127.0.0.1' } },
      "server: unknown property 'hosts'",
    );
  });

  it('reports bad record keys as pattern violations, not unknown properties', () => {
    rejectsWith(
      { app: { timezone: 'UTC' }, providers: { 'za i': minimalProvider } },
      "providers: property name 'za i' must match the pattern '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'",
    );
  });

  it('expands failed literal unions into one "must be one of" line', () => {
    rejectsWith(
      { app: { timezone: 'UTC' }, auth: { mode: 'sometimes' } },
      "auth.mode: must be one of: 'auto', 'required'",
    );
    rejectsWith(
      {
        app: { timezone: 'UTC' },
        providers: {
          zai: {
            peakHours: {
              timezone: 'UTC',
              windows: [{ id: 'w', name: 'W', days: ['funday'], start: '01:00', end: '02:00' }],
            },
          },
        },
      },
      "providers.zai.peakHours.windows[0].days[0]: must be one of: 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'",
    );
  });

  it('reports type, range, length, count, and pattern violations with their limits', () => {
    rejectsWith(
      { app: { timezone: 'UTC' }, server: { port: '8787' } },
      'server.port: expected an integer, got a string',
    );
    rejectsWith({ app: { timezone: 'UTC' }, server: { port: 0 } }, 'server.port: must be >= 1');
    rejectsWith(
      { app: { timezone: 'UTC' }, server: { port: 65536 } },
      'server.port: must be <= 65535',
    );
    rejectsWith(
      { app: { timezone: 'UTC', pollingIntervalSeconds: 59 } },
      'app.pollingIntervalSeconds: must be >= 60',
    );
    rejectsWith({ app: { timezone: 5 } }, 'app.timezone: expected a string, got a number');
    rejectsWith(
      { app: { timezone: 'UTC' }, providers: { z: 42 } },
      'providers.z: expected an object, got a number',
    );
    rejectsWith(
      { app: { timezone: 'UTC' }, accounts: [{ id: 'a1', providerId: 'zai', label: '' }] },
      'accounts[0].label: must be at least 1 character long',
    );
    rejectsWith(
      { app: { timezone: 'UTC' }, accounts: [{ id: '-bad', providerId: 'zai', label: 'A' }] },
      "accounts[0].id: must match the pattern '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'",
    );
  });

  it('reports peak-window violations with their limits (spec §9.2)', () => {
    const withWindow = (window: Record<string, unknown>) => ({
      app: { timezone: 'UTC' },
      providers: { zai: { peakHours: { timezone: 'UTC', windows: [window] } } },
    });
    rejectsWith(
      withWindow({ id: 'w', name: 'W', days: [], start: '01:00', end: '02:00' }),
      'providers.zai.peakHours.windows[0].days: must contain at least 1 item',
    );
    rejectsWith(
      withWindow({ id: 'w', name: 'W', days: ['mon', 'mon'], start: '01:00', end: '02:00' }),
      'providers.zai.peakHours.windows[0].days: must not contain duplicate items',
    );
    rejectsWith(
      withWindow({ id: 'w', name: 'W', days: ['mon'], start: '9:00', end: '02:00' }),
      "providers.zai.peakHours.windows[0].start: must match the pattern '^([01][0-9]|2[0-3]):[0-5][0-9]$'",
    );
    rejectsWith(
      withWindow({
        id: 'w',
        name: 'W',
        days: ['mon'],
        start: '01:00',
        end: '02:00',
        multiplier: 0,
      }),
      'providers.zai.peakHours.windows[0].multiplier: must be > 0',
    );
    rejectsWith(
      withWindow({ id: 'w', name: 'W', days: ['mon'], start: '01:00' }),
      "providers.zai.peakHours.windows[0]: missing required property 'end'",
    );
  });

  it('reports every structural problem, not just the first', () => {
    const result = parseConfig({
      app: { timezone: 'UTC' },
      server: { port: 0 },
      auth: { mode: 'sometimes' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        'server.port: must be >= 1',
        "auth.mode: must be one of: 'auto', 'required'",
      ]);
    }
  });

  it('never echoes secret values into structural problems (spec §15.4)', () => {
    const secret = 'sk-synthetic-secret-value-67890';
    const result = parseConfig({
      app: { timezone: 'UTC' },
      accounts: [{ id: 'a1', providerId: 'zai', label: 'A', apiKeyEnv: secret }],
      server: { port: 0 },
    });
    if (!result.ok) {
      expect(result.problems.join('\n')).not.toContain(secret);
      expect(result.problems).toContain('server.port: must be >= 1');
    }
  });
});

describe('parseConfig — cross-field problems come from findConfigProblems (D-014)', () => {
  it('reports semantic violations verbatim after structural validation passes', () => {
    const overlapping: Config = {
      app: { timezone: 'UTC' },
      providers: {
        zai: {
          peakHours: {
            timezone: 'UTC',
            windows: [
              { id: 'early', name: 'E', days: ['mon'], start: '10:00', end: '16:00' },
              { id: 'late', name: 'L', days: ['mon'], start: '15:00', end: '18:00' },
            ],
          },
        },
      },
    };
    expect(parseConfig(overlapping)).toEqual({
      ok: false,
      problems: findConfigProblems(overlapping),
    });

    const bothSecrets: Config = {
      app: { timezone: 'UTC' },
      accounts: [
        { id: 'a1', providerId: 'zai', label: 'A', apiKey: 'k1', apiKeyEnv: 'QUOTAMETER_K' },
      ],
    };
    expect(parseConfig(bothSecrets)).toEqual({
      ok: false,
      problems: findConfigProblems(bothSecrets),
    });
  });

  it('stops at the structural stage: broken structure hides nothing semantic', () => {
    const result = parseConfig({
      app: { timezone: 'Not/AZone' }, // semantic problem…
      server: { port: 0 }, // …but the structure is broken first
    });
    expect(result).toEqual({ ok: false, problems: ['server.port: must be >= 1'] });
  });
});

describe('parseConfig agrees with the TypeBox contract (Ajv compilation guard)', () => {
  it('accepts and rejects the same inputs as Value.Check on the schema', () => {
    const cases: unknown[] = [
      validConfig(),
      { app: { timezone: 'UTC' } },
      { app: { timezone: 'UTC' }, server: { port: 0 } },
      { app: { timezone: 'UTC' }, server: { port: 65536 } },
      { app: { timezone: 'UTC' }, auth: { mode: 'sometimes' } },
      { app: { timezone: 'UTC' }, providers: { 'za i': minimalProvider } },
      { app: { timezone: 'UTC' }, providers: { z: 42 } },
      { app: { timezone: 'UTC', pollingIntervalSeconds: 300.5 } },
      {},
      42,
    ];
    for (const input of cases) {
      const structurallyValid = Value.Check(ConfigSchema, input);
      const parsed = parseConfig(input);
      // Structurally invalid input must be rejected by the parser with
      // structural problems; structurally valid input passes the Ajv stage
      // (its result then depends only on the semantic stage).
      if (!structurallyValid) expect(parsed.ok).toBe(false);
      if (structurallyValid && parsed.ok) {
        expect(Value.Check(ConfigSchema, parsed.value)).toBe(true);
      }
    }
  });
});

describe('configBoundaryParser (src/schemas/boundary.ts contract)', () => {
  it('satisfies the BoundaryParser type and delegates to parseConfig', () => {
    expectTypeOf(configBoundaryParser).toEqualTypeOf<BoundaryParser<Config>>();
    expect(configBoundaryParser.parse({ app: { timezone: 'UTC' } })).toEqual(
      parseConfig({ app: { timezone: 'UTC' } }),
    );
    expect(configBoundaryParser.parse({})).toEqual(parseConfig({}));
  });
});

describe('loadConfigFile — error shaping (injected filesystem)', () => {
  const rejecting = (error: unknown): ConfigReadFilesystem => ({
    readFile: () => Promise.reject(error),
  });

  it('reports a missing file distinctly (spec §6.2: refuse and explain)', async () => {
    const errno = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    await expect(loadConfigFile('/x/config.json', rejecting(errno))).resolves.toEqual({
      ok: false,
      problems: ['configuration file not found: /x/config.json'],
    });
  });

  it('reports coded read failures by their errno', async () => {
    const errno = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    await expect(loadConfigFile('/x/config.json', rejecting(errno))).resolves.toEqual({
      ok: false,
      problems: ['cannot read configuration file /x/config.json: EACCES'],
    });
  });

  it('reports uncoded errors by message and non-errors by string form', async () => {
    await expect(loadConfigFile('/x', rejecting(new Error('boom')))).resolves.toEqual({
      ok: false,
      problems: ['cannot read configuration file /x: boom'],
    });
    await expect(loadConfigFile('/x', rejecting('nope'))).resolves.toEqual({
      ok: false,
      problems: ['cannot read configuration file /x: nope'],
    });
  });

  it('validates the file content end to end (read → parse → validate)', async () => {
    const filesystem: ConfigReadFilesystem = {
      readFile: () => Promise.resolve('{"app":{"timezone":"UTC"}}'),
    };
    const result = await loadConfigFile('/x/config.json', filesystem);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.app.timezone).toBe('UTC');

    const broken: ConfigReadFilesystem = {
      readFile: () => Promise.resolve('{"app":{"timezone":"UTC"},"ap":1}'),
    };
    await expect(loadConfigFile('/x/config.json', broken)).resolves.toEqual({
      ok: false,
      problems: ["configuration: unknown property 'ap'"],
    });
  });
});

describe('formatSchemaError — total over any Ajv error (doctor reuse)', () => {
  const at = (partial: Partial<ErrorObject>): ErrorObject =>
    ({
      keyword: 'type',
      instancePath: '',
      schemaPath: '#/type',
      params: {},
      message: 'must be type',
      ...partial,
    }) as ErrorObject;

  it('renders standalone const and union fallbacks', () => {
    expect(
      formatSchemaError(at({ keyword: 'const', params: { allowedValue: 'auto' } }), ConfigSchema),
    ).toBe("configuration: must be 'auto'");
    expect(formatSchemaError(at({ keyword: 'anyOf' }), ConfigSchema)).toBe(
      'configuration: must be one of the allowed values',
    );
  });

  it('passes unknown keywords through, with a fallback when Ajv has no message', () => {
    expect(
      formatSchemaError(
        at({ keyword: 'weird', params: {}, message: 'must be weird' }),
        ConfigSchema,
      ),
    ).toBe('configuration: must be weird');
    expect(
      formatSchemaError(at({ keyword: 'weird', params: {}, message: undefined }), ConfigSchema),
    ).toBe("configuration: failed the 'weird' check");
  });

  it('omits the actual type when no data is supplied', () => {
    expect(
      formatSchemaError(at({ keyword: 'type', params: { type: 'object' } }), ConfigSchema),
    ).toBe('configuration: expected an object');
  });

  it('treats a bare slash instance path as the root label', () => {
    expect(formatSchemaError(at({ instancePath: '/', keyword: 'uniqueItems' }), ConfigSchema)).toBe(
      'configuration: must not contain duplicate items',
    );
  });

  it('never throws on malformed percent escapes in hand-built schema paths', () => {
    // Ajv always encodes correctly (`%` → `%25`), but the exported formatter
    // promises totality for any error object; a stray `%` must not throw and
    // the segment must still resolve verbatim (found in review).
    const root: Record<string, unknown> = {
      definitions: {
        'x%zz': { patternProperties: { '^id$': {} }, additionalProperties: false },
      },
    };
    const error = at({
      keyword: 'additionalProperties',
      schemaPath: '#/definitions/x%zz/additionalProperties',
      params: { additionalProperty: 'za i' },
    });
    expect(formatSchemaError(error, root)).toBe(
      "configuration: property name 'za i' must match the pattern '^id$'",
    );
  });
});
