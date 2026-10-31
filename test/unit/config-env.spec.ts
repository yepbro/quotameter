import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ENV_OVERRIDES,
  type ConfigEnvLoadResult,
  type ConfigEnvResult,
  type EnvironmentSources,
  type EnvOverrideField,
  loadConfigWithEnv,
  parseConfigWithEnv,
} from '../../src/config/env';
import type { ConfigReadFilesystem } from '../../src/config/load';
import type { Config } from '../../src/schemas/config';
import type { Validated } from '../../src/schemas/boundary';

/**
 * Locks the environment-override layer (spec §6.3, §6.4; decision D-023):
 * precedence of every supported variable over the file value, env-only
 * configuration for an absent file, coercion of integer strings, rejection
 * of unknown `QUOTAMETER_*` names, invalid values failing through the task
 * 064 parser, and the read-only marking of effective settings. The
 * environment is always an injected object literal — `process.env` is never
 * mutated (the Stryker worker-threads constraint).
 */

/** A valid file configuration; every value is synthetic, never a secret. */
function fileConfig(): Record<string, unknown> {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto', passwordHash: 'synthetic-scrypt-hash' },
    logging: { level: 'warn' },
    accounts: [{ id: 'zai-main', providerId: 'zai', label: 'Main', apiKey: 'synthetic-key' }],
  };
}

/** Reads one field of the effective configuration, e.g. `server.port`. */
function fieldOf(config: Validated<Config>, field: EnvOverrideField): unknown {
  const [section, key] = field.split('.') as [string, string];
  const sections = config as unknown as Record<string, Record<string, unknown>>;
  return sections[section]?.[key];
}

describe('ENV_OVERRIDES — the supported variable table (decision D-023)', () => {
  it('pins all seven mappings with their coercions', () => {
    expect(ENV_OVERRIDES).toEqual([
      { variable: 'QUOTAMETER_SERVER_HOST', field: 'server.host', kind: 'string' },
      { variable: 'QUOTAMETER_SERVER_PORT', field: 'server.port', kind: 'integer' },
      { variable: 'QUOTAMETER_APP_TIMEZONE', field: 'app.timezone', kind: 'string' },
      {
        variable: 'QUOTAMETER_APP_POLLING_INTERVAL_SECONDS',
        field: 'app.pollingIntervalSeconds',
        kind: 'integer',
      },
      {
        variable: 'QUOTAMETER_APP_HISTORY_RETENTION_DAYS',
        field: 'app.historyRetentionDays',
        kind: 'integer',
      },
      { variable: 'QUOTAMETER_AUTH_MODE', field: 'auth.mode', kind: 'string' },
      { variable: 'QUOTAMETER_LOGGING_LEVEL', field: 'logging.level', kind: 'string' },
    ]);
  });

  it('names every variable as the mechanical mirror of its field path', () => {
    for (const { variable, field } of ENV_OVERRIDES) {
      const mirror =
        'QUOTAMETER_' +
        field
          .split('.')
          .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))
          .join('_')
          .toUpperCase();
      expect(variable).toBe(mirror);
    }
  });

  it('is frozen with unique variables and fields', () => {
    expect(Object.isFrozen(ENV_OVERRIDES)).toBe(true);
    for (const spec of ENV_OVERRIDES) expect(Object.isFrozen(spec)).toBe(true);
    expect(new Set(ENV_OVERRIDES.map((s) => s.variable)).size).toBe(ENV_OVERRIDES.length);
    expect(new Set(ENV_OVERRIDES.map((s) => s.field)).size).toBe(ENV_OVERRIDES.length);
  });
});

describe('parseConfigWithEnv — precedence (spec §6.3)', () => {
  // One row per supported override: the done-condition is precedence for each.
  it.each<
    Record<'variable' | 'envValue', string> &
      Record<'field', EnvOverrideField> &
      Record<'expected', string | number>
  >([
    {
      variable: 'QUOTAMETER_SERVER_HOST',
      field: 'server.host',
      envValue: 'localhost',
      expected: 'localhost',
    },
    { variable: 'QUOTAMETER_SERVER_PORT', field: 'server.port', envValue: '9000', expected: 9000 },
    {
      variable: 'QUOTAMETER_APP_TIMEZONE',
      field: 'app.timezone',
      envValue: 'Asia/Tokyo',
      expected: 'Asia/Tokyo',
    },
    {
      variable: 'QUOTAMETER_APP_POLLING_INTERVAL_SECONDS',
      field: 'app.pollingIntervalSeconds',
      envValue: '120',
      expected: 120,
    },
    {
      variable: 'QUOTAMETER_APP_HISTORY_RETENTION_DAYS',
      field: 'app.historyRetentionDays',
      envValue: '90',
      expected: 90,
    },
    {
      variable: 'QUOTAMETER_AUTH_MODE',
      field: 'auth.mode',
      envValue: 'required',
      expected: 'required',
    },
    {
      variable: 'QUOTAMETER_LOGGING_LEVEL',
      field: 'logging.level',
      envValue: 'debug',
      expected: 'debug',
    },
  ])(
    '$variable overrides $field and marks it environment-sourced',
    ({ variable, field, envValue, expected }) => {
      const result = parseConfigWithEnv(fileConfig(), { [variable]: envValue });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fieldOf(result.config, field)).toBe(expected);
      expect(result.sources.fields).toContain(field);
    },
  );

  it('keeps the file value when no variable is set', () => {
    const result = parseConfigWithEnv(fileConfig(), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fieldOf(result.config, 'server.port')).toBe(8787);
      expect(result.config.app.timezone).toBe('Europe/Berlin');
      expect(result.sources.fields).toEqual([]);
    }
  });

  it('falls back to the spec defaults when neither file nor environment sets a field', () => {
    const result = parseConfigWithEnv(
      { app: { timezone: 'UTC' } },
      { QUOTAMETER_APP_TIMEZONE: 'UTC' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fieldOf(result.config, 'server.port')).toBe(8787);
      expect(result.config.app.pollingIntervalSeconds).toBe(300);
      expect(fieldOf(result.config, 'logging.level')).toBe('warn');
    }
  });

  it('treats an empty variable as unset, so the file value stands (decision D-011)', () => {
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_SERVER_PORT: '',
      QUOTAMETER_LOGGING_LEVEL: '',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fieldOf(result.config, 'server.port')).toBe(8787);
      expect(fieldOf(result.config, 'logging.level')).toBe('warn');
      expect(result.sources.fields).toEqual([]);
    }
  });

  it('coerces integer variables from decimal strings into numbers', () => {
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_SERVER_PORT: '9000',
      QUOTAMETER_APP_POLLING_INTERVAL_SECONDS: '120',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fieldOf(result.config, 'server.port')).toBe(9000);
      expect(result.config.app.pollingIntervalSeconds).toBe(120);
    }
  });

  it('reads leading zeros as decimal, not octal', () => {
    const result = parseConfigWithEnv(fileConfig(), { QUOTAMETER_SERVER_PORT: '09000' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(fieldOf(result.config, 'server.port')).toBe(9000);
  });

  it('rejects an overlong digit string that coerces to Infinity, via the parser', () => {
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_SERVER_PORT: '9'.repeat(400),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        'server.port: expected an integer, got a non-finite number',
      ]);
    }
  });
});

describe('parseConfigWithEnv — env-only configuration (spec §6.3, file absent)', () => {
  it('builds a complete valid configuration from the environment alone', () => {
    const result = parseConfigWithEnv(
      {},
      {
        QUOTAMETER_APP_TIMEZONE: 'Asia/Tokyo',
        QUOTAMETER_SERVER_PORT: '9000',
        QUOTAMETER_LOGGING_LEVEL: 'info',
      },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.config).toEqual({
      server: { host: '127.0.0.1', port: 9000 },
      app: { timezone: 'Asia/Tokyo', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
      auth: { mode: 'auto' },
      logging: { level: 'info' },
      providers: {},
      accounts: [],
    });
    expect(result.sources.fields).toEqual(['server.port', 'app.timezone', 'logging.level']);
  });

  it('still demands the mandatory time zone in env-only mode (spec §10)', () => {
    const result = parseConfigWithEnv({}, { QUOTAMETER_LOGGING_LEVEL: 'info' });
    expect(result).toEqual({
      ok: false,
      problems: ["configuration: missing required property 'app'"],
    });
  });
});

describe('parseConfigWithEnv — unknown QUOTAMETER_* variables', () => {
  it('rejects a typo with one problem naming the variable', () => {
    expect(parseConfigWithEnv(fileConfig(), { QUOTAMETER_SEVER_PORT: '9000' })).toEqual({
      ok: false,
      problems: ['QUOTAMETER_SEVER_PORT: unsupported environment variable'],
    });
  });

  it('sorts multiple unknown names deterministically', () => {
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_ZZZ: 'x',
      QUOTAMETER_AAA: 'x',
      QUOTAMETER_MMM: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        'QUOTAMETER_AAA: unsupported environment variable',
        'QUOTAMETER_MMM: unsupported environment variable',
        'QUOTAMETER_ZZZ: unsupported environment variable',
      ]);
    }
  });

  it('accepts the directory variables owned by paths.ts without touching the config', () => {
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_CONFIG_DIR: '/elsewhere/conf',
      QUOTAMETER_DATA_DIR: '/elsewhere/data',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sources.fields).toEqual([]);
  });

  it('reports unknown names alongside parser problems, unknown names first', () => {
    const result = parseConfigWithEnv(
      { ...fileConfig(), server: { host: '127.0.0.1', port: 0 } },
      { QUOTAMETER_TYPO: 'x', QUOTAMETER_SERVER_PORT: '70000' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        'QUOTAMETER_TYPO: unsupported environment variable',
        'server.port: must be <= 65535',
      ]);
    }
  });

  it('treats an empty unknown variable as unset, not a rejection', () => {
    expect(parseConfigWithEnv(fileConfig(), { QUOTAMETER_TYPO: '' }).ok).toBe(true);
  });
});

describe('parseConfigWithEnv — invalid env values flow through the parser', () => {
  const rejectsWith = (env: NodeJS.ProcessEnv, ...problems: string[]): void => {
    expect(parseConfigWithEnv(fileConfig(), env)).toEqual({ ok: false, problems });
  };

  it('rejects a non-integer string with the parser type message', () => {
    rejectsWith(
      { QUOTAMETER_SERVER_PORT: 'eight-thousand' },
      'server.port: expected an integer, got a string',
    );
  });

  it('rejects whitespace-padded numbers the same way', () => {
    rejectsWith(
      { QUOTAMETER_SERVER_PORT: ' 9000' },
      'server.port: expected an integer, got a string',
    );
  });

  it('applies the range checks of the contract (spec §5.3, §7.1, §11.3)', () => {
    rejectsWith({ QUOTAMETER_SERVER_PORT: '70000' }, 'server.port: must be <= 65535');
    rejectsWith({ QUOTAMETER_SERVER_PORT: '0' }, 'server.port: must be >= 1');
    rejectsWith(
      { QUOTAMETER_APP_POLLING_INTERVAL_SECONDS: '30' },
      'app.pollingIntervalSeconds: must be >= 60',
    );
    rejectsWith(
      { QUOTAMETER_APP_POLLING_INTERVAL_SECONDS: '3601' },
      'app.pollingIntervalSeconds: must be <= 3600',
    );
    rejectsWith(
      { QUOTAMETER_APP_HISTORY_RETENTION_DAYS: '6' },
      'app.historyRetentionDays: must be >= 7',
    );
  });

  it('applies the closed enums of the contract (spec §15.1, §16)', () => {
    rejectsWith(
      { QUOTAMETER_AUTH_MODE: 'sometimes' },
      "auth.mode: must be one of: 'auto', 'required'",
    );
    rejectsWith(
      { QUOTAMETER_LOGGING_LEVEL: 'verbose' },
      "logging.level: must be one of: 'error', 'warn', 'info', 'debug'",
    );
  });

  it('applies the semantic IANA check to an overridden time zone (spec §10)', () => {
    rejectsWith(
      { QUOTAMETER_APP_TIMEZONE: 'Not/AZone' },
      "app.timezone: 'Not/AZone' is not a valid IANA time zone",
    );
  });

  it('applies the cross-field password rule to an overridden auth mode (spec §15.1)', () => {
    const withoutPassword = fileConfig();
    withoutPassword.auth = { mode: 'auto' };
    expect(parseConfigWithEnv(withoutPassword, { QUOTAMETER_AUTH_MODE: 'required' })).toEqual({
      ok: false,
      problems: [
        'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
      ],
    });
  });

  it('applies the cross-field password rule to an overridden host (spec §15.1)', () => {
    const withoutPassword = fileConfig();
    withoutPassword.auth = { mode: 'auto' };
    expect(parseConfigWithEnv(withoutPassword, { QUOTAMETER_SERVER_HOST: '0.0.0.0' })).toEqual({
      ok: false,
      problems: [
        'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
      ],
    });
  });
});

describe('parseConfigWithEnv — sources marking (spec §6.3, §14.5)', () => {
  it('lists exactly the set variables, in table order', () => {
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_LOGGING_LEVEL: 'debug',
      QUOTAMETER_SERVER_PORT: '9000',
      QUOTAMETER_APP_TIMEZONE: 'Asia/Tokyo',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sources.fields).toEqual(['server.port', 'app.timezone', 'logging.level']);
    }
  });

  it('marks a field even when the value coincides with the file value', () => {
    const result = parseConfigWithEnv(fileConfig(), { QUOTAMETER_SERVER_PORT: '8787' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fieldOf(result.config, 'server.port')).toBe(8787);
      expect(result.sources.fields).toEqual(['server.port']);
    }
  });

  it('lists account ids whose secret source is apiKeyEnv, in accounts order', () => {
    const result = parseConfigWithEnv(
      {
        app: { timezone: 'UTC' },
        accounts: [
          { id: 'a1', providerId: 'zai', label: 'A', apiKeyEnv: 'KEY_ONE' },
          { id: 'a2', providerId: 'zai', label: 'B', apiKey: 'synthetic-key' },
          { id: 'a3', providerId: 'zai', label: 'C', apiKeyEnv: 'KEY_THREE' },
        ],
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sources.accountSecrets).toEqual(['a1', 'a3']);
      expect(result.sources.fields).toEqual([]);
    }
  });

  it('freezes the marking', () => {
    const result = parseConfigWithEnv(fileConfig(), { QUOTAMETER_SERVER_PORT: '9000' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.sources)).toBe(true);
      expect(Object.isFrozen(result.sources.fields)).toBe(true);
      expect(Object.isFrozen(result.sources.accountSecrets)).toBe(true);
    }
  });

  it('satisfies the exported result and marking types', () => {
    const result = parseConfigWithEnv(fileConfig(), {});
    expectTypeOf(result).toEqualTypeOf<ConfigEnvResult>();
    if (result.ok) {
      expectTypeOf(result.config).toEqualTypeOf<Validated<Config>>();
      expectTypeOf(result.sources).toEqualTypeOf<EnvironmentSources>();
    }
  });
});

describe('parseConfigWithEnv — safety properties', () => {
  it('never mutates the file input or the environment snapshot', () => {
    const input = fileConfig();
    const env = { QUOTAMETER_SERVER_PORT: '9000', QUOTAMETER_TYPO: 'x' };
    parseConfigWithEnv(input, env);
    expect(input).toEqual(fileConfig());
    expect(env).toEqual({ QUOTAMETER_SERVER_PORT: '9000', QUOTAMETER_TYPO: 'x' });
  });

  it('is deterministic: the same inputs yield the same result twice', () => {
    const input = { ...fileConfig(), server: { host: '127.0.0.1', port: 0 } };
    const env = { QUOTAMETER_TYPO: 'x', QUOTAMETER_LOGGING_LEVEL: 'verbose' };
    expect(parseConfigWithEnv(input, env)).toEqual(parseConfigWithEnv(input, env));
  });

  it('never echoes environment values into problems (spec §15.4)', () => {
    const sentinel = 'synthetic-secret-looking-garbage-999';
    const result = parseConfigWithEnv(fileConfig(), {
      QUOTAMETER_SERVER_PORT: sentinel,
      QUOTAMETER_TYPO: sentinel,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join('\n')).not.toContain(sentinel);
  });

  it('still reports a non-object base through the parser, but scans variables', () => {
    expect(parseConfigWithEnv(42, { QUOTAMETER_LOGGING_LEVEL: 'info' })).toEqual({
      ok: false,
      problems: ['configuration: expected an object, got a number'],
    });
    expect(parseConfigWithEnv(42, { QUOTAMETER_TYPO: 'x' })).toEqual({
      ok: false,
      problems: [
        'QUOTAMETER_TYPO: unsupported environment variable',
        'configuration: expected an object, got a number',
      ],
    });
  });

  it('does not silently repair a malformed file section (spec §6.2)', () => {
    const input = { ...fileConfig(), server: 42 };
    expect(parseConfigWithEnv(input, { QUOTAMETER_SERVER_PORT: '9000' })).toEqual({
      ok: false,
      problems: ['server: expected an object, got a number'],
    });
  });
});

describe('loadConfigWithEnv — composed with loadConfigFile (task 064)', () => {
  const fsWith = (text: string): ConfigReadFilesystem => ({
    readFile: () => Promise.resolve(text),
  });
  const rejecting = (error: unknown): ConfigReadFilesystem => ({
    readFile: () => Promise.reject(error),
  });
  const errno = (code: string): Error => Object.assign(new Error(`${code}: failure`), { code });

  it('merges overrides over a valid file and reports fileAbsent: false', async () => {
    const result = await loadConfigWithEnv(
      '/x/config.json',
      { QUOTAMETER_SERVER_PORT: '9000' },
      fsWith(JSON.stringify(fileConfig())),
    );
    expectTypeOf(result).toEqualTypeOf<ConfigEnvLoadResult>();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fieldOf(result.config, 'server.port')).toBe(9000);
    expect(result.config.app.timezone).toBe('Europe/Berlin');
    expect(result.fileAbsent).toBe(false);
    expect(result.sources.fields).toEqual(['server.port']);
  });

  it('returns the plain file configuration when no variable is set', async () => {
    const result = await loadConfigWithEnv(
      '/x/config.json',
      {},
      fsWith('{"app":{"timezone":"UTC"}}'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fieldOf(result.config, 'server.port')).toBe(8787);
      expect(result.fileAbsent).toBe(false);
      expect(result.sources.fields).toEqual([]);
    }
  });

  it('builds env-only configuration when the file is missing (spec §6.3)', async () => {
    const result = await loadConfigWithEnv(
      '/x/config.json',
      { QUOTAMETER_APP_TIMEZONE: 'Asia/Tokyo' },
      rejecting(errno('ENOENT')),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileAbsent).toBe(true);
    expect(result.config.app.timezone).toBe('Asia/Tokyo');
    expect(result.config.accounts ?? []).toEqual([]);
  });

  it('reports the missing file as-is when no variable is set', async () => {
    await expect(
      loadConfigWithEnv('/x/config.json', {}, rejecting(errno('ENOENT'))),
    ).resolves.toEqual({
      ok: false,
      problems: ['configuration file not found: /x/config.json'],
    });
  });

  it('still reports typo variables beside the missing file when nothing valid is set', async () => {
    await expect(
      loadConfigWithEnv(
        '/x/config.json',
        { QUOTAMETER_SEVER_PORT: '9000' },
        rejecting(errno('ENOENT')),
      ),
    ).resolves.toEqual({
      ok: false,
      problems: [
        'configuration file not found: /x/config.json',
        'QUOTAMETER_SEVER_PORT: unsupported environment variable',
      ],
    });
  });

  it('explains both facts when the file is missing and the env-only config is incomplete', async () => {
    await expect(
      loadConfigWithEnv(
        '/x/config.json',
        { QUOTAMETER_LOGGING_LEVEL: 'info' },
        rejecting(errno('ENOENT')),
      ),
    ).resolves.toEqual({
      ok: false,
      problems: [
        'configuration file not found: /x/config.json',
        "configuration: missing required property 'app'",
      ],
    });
  });

  it('passes unreadable-file problems through verbatim', async () => {
    await expect(
      loadConfigWithEnv(
        '/x/config.json',
        { QUOTAMETER_APP_TIMEZONE: 'UTC' },
        rejecting(errno('EACCES')),
      ),
    ).resolves.toEqual({
      ok: false,
      problems: ['cannot read configuration file /x/config.json: EACCES'],
    });
  });

  it('passes invalid-JSON problems through verbatim (spec §15.4 snippet stripping)', async () => {
    const result = await loadConfigWithEnv(
      '/x/config.json',
      { QUOTAMETER_SERVER_PORT: '9000' },
      fsWith('{'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/^invalid JSON: /);
  });

  it('does not let overrides rescue an invalid file (spec §6.2)', async () => {
    const broken = { ...fileConfig(), server: { host: '127.0.0.1', port: 0 } };
    const result = await loadConfigWithEnv(
      '/x/config.json',
      { QUOTAMETER_SERVER_PORT: '9000' },
      fsWith(JSON.stringify(broken)),
    );
    expect(result).toEqual({ ok: false, problems: ['server.port: must be >= 1'] });
  });

  it('returns the composed rejection when a valid file meets a broken environment', async () => {
    // The file stage succeeded; the environment composition fails — the
    // pipeline reports the composition's own problems verbatim.
    await expect(
      loadConfigWithEnv(
        '/x/config.json',
        { QUOTAMETER_TYPO: 'x' },
        fsWith(JSON.stringify(fileConfig())),
      ),
    ).resolves.toEqual({
      ok: false,
      problems: ['QUOTAMETER_TYPO: unsupported environment variable'],
    });
    await expect(
      loadConfigWithEnv(
        '/x/config.json',
        { QUOTAMETER_SERVER_PORT: '70000' },
        fsWith(JSON.stringify(fileConfig())),
      ),
    ).resolves.toEqual({ ok: false, problems: ['server.port: must be <= 65535'] });
  });
});
