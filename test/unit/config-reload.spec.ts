import { describe, expect, it } from 'vitest';
import {
  findReloadChanges,
  RELOAD_FIELDS,
  RESTART_REQUIRED_FIELDS,
  type LiveReloadField,
  type RestartRequiredField,
} from '../../src/config/reload';
import {
  ConfigSchema,
  type AccountConfig,
  type AuthMode,
  type Config,
  type ProviderConfig,
} from '../../src/schemas/config';

/**
 * Locks the pure half of task 068 — the §6.4 classification (decision
 * D-026): the table that maps every configuration setting to live or
 * restart-requiring, its completeness against the contract's sections, and
 * the deep structural diff that turns two configurations into changed field
 * paths. The stateful reloader over real files is covered by
 * `test/integration/config-reload.spec.ts`.
 */

/**
 * The concrete fixture type — every section present and mutable with widened
 * literal unions, assignable to `Config` (the comparator's parameter).
 */
type Fixture = Required<Pick<Config, 'server' | 'app' | 'logging'>> & {
  auth: { mode: AuthMode; passwordHash?: string };
  providers: { zai: ProviderConfig };
  accounts: [AccountConfig, ...AccountConfig[]];
};

/** A canonical configuration; every value is synthetic, never a secret. */
function baseConfig(): Fixture {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto', passwordHash: 'synthetic-scrypt-hash' },
    logging: { level: 'warn' },
    providers: {
      zai: {
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
        providerId: 'zai',
        label: 'Main subscription',
        enabled: true,
        apiKey: 'synthetic-test-key-not-a-real-secret',
      },
    ],
  };
}

/** A mutation of the base fixture, named by the field it changes. */
type Mutation = readonly [
  field: LiveReloadField | RestartRequiredField,
  mutate: (config: Fixture) => void,
];

describe('RELOAD_FIELDS — the §6.4 classification table (decision D-026)', () => {
  it('pins every classified field with its §6.4 class, in canonical order', () => {
    expect(RELOAD_FIELDS.map((spec) => [spec.field, spec.applies])).toEqual([
      ['server.host', 'restart'],
      ['server.port', 'restart'],
      ['auth.mode', 'restart'],
      ['app.timezone', 'live'],
      ['app.pollingIntervalSeconds', 'live'],
      ['app.historyRetentionDays', 'live'],
      ['accounts', 'live'],
      ['providers', 'live'],
      ['logging.level', 'live'],
      ['auth.passwordHash', 'live'],
    ]);
  });

  it('classifies every field of the contract at leaf granularity', () => {
    // Section coverage alone would let a new leaf inside an already
    // classified section (a future `server.tls`) pass silently unreported —
    // D-026 promises a row per configuration field. Scalar-leaf sections
    // need one row per leaf; structured sections (`providers` is a keyed
    // record, `accounts` an array) have no enumerable leaves and take a
    // wholesale row. Every row must also name a real section.
    const sections = ConfigSchema.properties as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    const rows = new Set<string>(RELOAD_FIELDS.map((spec) => spec.field));
    for (const spec of RELOAD_FIELDS) {
      expect(
        Object.hasOwn(sections, spec.field.split('.')[0]!),
        `row '${spec.field}' names a real section`,
      ).toBe(true);
    }
    for (const [section, schema] of Object.entries(sections)) {
      const leaves = Object.keys(schema.properties ?? {});
      if (leaves.length === 0) {
        expect(rows.has(section), `section '${section}' has a wholesale row`).toBe(true);
        continue;
      }
      for (const leaf of leaves) {
        expect(rows.has(`${section}.${leaf}`), `field '${section}.${leaf}' is classified`).toBe(
          true,
        );
      }
    }
  });

  it('keeps RESTART_REQUIRED_FIELDS consistent with the table', () => {
    const fromTable = RELOAD_FIELDS.filter((spec) => spec.applies === 'restart').map(
      (spec) => spec.field,
    );
    expect([...RESTART_REQUIRED_FIELDS]).toEqual(fromTable);
    expect(RESTART_REQUIRED_FIELDS).toEqual(['server.host', 'server.port', 'auth.mode']);
  });
});

describe('findReloadChanges — the §6.4 diff', () => {
  it('reports nothing for identical configurations', () => {
    expect(findReloadChanges(baseConfig(), baseConfig())).toEqual({ live: [], restart: [] });
  });

  it('compares structurally: a re-parsed equal configuration is unchanged', () => {
    // A reload re-parses the file, so every unchanged setting arrives as a
    // brand-new object; only structural equality reports "no change".
    const reparsed = JSON.parse(JSON.stringify(baseConfig())) as Config;
    expect(findReloadChanges(baseConfig(), reparsed)).toEqual({ live: [], restart: [] });
  });

  it.each([
    ['app.timezone', (c) => (c.app.timezone = 'Asia/Singapore')],
    ['app.pollingIntervalSeconds', (c) => (c.app.pollingIntervalSeconds = 120)],
    ['app.historyRetentionDays', (c) => (c.app.historyRetentionDays = 90)],
    ['logging.level', (c) => (c.logging.level = 'debug')],
    ['auth.passwordHash', (c) => (c.auth.passwordHash = 'another-synthetic-hash')],
    ['accounts', (c) => (c.accounts[0]!.label = 'Relabeled subscription')],
    ['accounts', (c) => c.accounts.push({ ...c.accounts[0]!, id: 'zai-second' })],
    ['accounts', (c) => (c.accounts.length = 0)],
    ['accounts', (c) => (c.accounts[0]!.enabled = false)],
    ['providers', (c) => (c.providers.zai!.peakHours.windows[0]!.start = '15:00')],
    ['providers', (c) => (c.providers.zai!.requestTimeoutSeconds = 30)],
  ] satisfies Mutation[])('classifies a change of %s as live', (field, mutate) => {
    const next = baseConfig();
    mutate(next);
    expect(findReloadChanges(baseConfig(), next)).toEqual({ live: [field], restart: [] });
  });

  it.each([
    ['server.host', (c) => (c.server.host = '192.0.2.10')],
    ['server.port', (c) => (c.server.port = 9400)],
    ['auth.mode', (c) => (c.auth.mode = 'required')],
  ] satisfies Mutation[])('classifies a change of %s as restart-requiring', (field, mutate) => {
    const next = baseConfig();
    mutate(next);
    expect(findReloadChanges(baseConfig(), next)).toEqual({ live: [], restart: [field] });
  });

  it('reports mixed changes in table order', () => {
    const next = baseConfig();
    next.server.port = 9400;
    next.auth.mode = 'required';
    next.app.pollingIntervalSeconds = 120;
    next.accounts.length = 0;
    expect(findReloadChanges(baseConfig(), next)).toEqual({
      live: ['app.pollingIntervalSeconds', 'accounts'],
      restart: ['server.port', 'auth.mode'],
    });
  });

  it('treats absent optional sections as their empty shapes', () => {
    // Non-canonical inputs (sections the parser would materialize are
    // missing): the optional reads resolve to undefined / the fallback on
    // both sides and compare equal — nothing is reported as changed.
    const minimal = (): Config => ({ app: { timezone: 'UTC' } });
    expect(findReloadChanges(minimal(), minimal())).toEqual({ live: [], restart: [] });
    const withServer = minimal();
    withServer.server = { host: '127.0.0.1', port: 8787 };
    expect(findReloadChanges(minimal(), withServer)).toEqual({
      live: [],
      restart: ['server.host', 'server.port'],
    });
  });
});
