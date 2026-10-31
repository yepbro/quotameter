import { describe, expect, it } from 'vitest';
import {
  createConfigReloader,
  findReloadChanges,
  RELOAD_FIELDS,
  RESTART_REQUIRED_FIELDS,
  type EffectiveConfig,
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

  it('treats an absent accounts section as equal to an explicit empty list (U-008)', () => {
    // The row's read falls back to [] on both sides — a missing section
    // and an explicit empty list are the same "no accounts" state (the
    // parser materializes exactly this shape).
    const withAccounts = (accounts: AccountConfig[] | undefined): Config => ({
      ...baseConfig(),
      accounts,
    });
    expect(findReloadChanges(withAccounts(undefined), withAccounts([]))).toEqual({
      live: [],
      restart: [],
    });
  });

  it('reports a provider key the baseline did not have (U-008)', () => {
    // Key sets are part of the comparison, not just the shared keys'
    // values: adding a provider is a change even when the existing one is
    // untouched.
    const next = baseConfig();
    (next.providers as Record<string, ProviderConfig>).other = {
      ...next.providers.zai!,
      peakHours: { ...next.providers.zai!.peakHours, windows: [] },
    };
    expect(findReloadChanges(baseConfig(), next)).toEqual({ live: ['providers'], restart: [] });
  });
});

describe('findReloadChanges — structural comparator type discipline (U-008)', () => {
  // The comparator's guards decide malformed inputs a validated pipeline
  // never produces (hand-built configurations) without throwing; the pairs
  // below pin each guard through the public diff. Casts widen only the
  // value under diff — every other field stays at its baseline.
  const withPasswordHash = (passwordHash: unknown): Config =>
    ({ ...baseConfig(), auth: { ...baseConfig().auth, passwordHash } }) as Config;
  const withAccounts = (accounts: unknown): Config => ({ ...baseConfig(), accounts }) as Config;

  it('classifies null against an object, either side, as changed without throwing', () => {
    expect(findReloadChanges(withPasswordHash(null), withPasswordHash({}))).toEqual({
      live: ['auth.passwordHash'],
      restart: [],
    });
    expect(findReloadChanges(withPasswordHash({}), withPasswordHash(null))).toEqual({
      live: ['auth.passwordHash'],
      restart: [],
    });
  });

  it('classifies a primitive against an object, either side, as changed', () => {
    expect(findReloadChanges(withPasswordHash(5), withPasswordHash({}))).toEqual({
      live: ['auth.passwordHash'],
      restart: [],
    });
    expect(findReloadChanges(withPasswordHash({}), withPasswordHash(5))).toEqual({
      live: ['auth.passwordHash'],
      restart: [],
    });
  });

  it('classifies an array against a record, and empty against empty, as changed', () => {
    expect(findReloadChanges(withAccounts(['x']), withAccounts({ 0: 'x' }))).toEqual({
      live: ['accounts'],
      restart: [],
    });
    expect(findReloadChanges(withAccounts([]), withAccounts({}))).toEqual({
      live: ['accounts'],
      restart: [],
    });
  });

  it('classifies an array-like record against an equal array as changed, without throwing', () => {
    // Duck-typed length/indices must not pass for a real array.
    const arrayLike = { length: 2, 0: 'x', 1: 'y' };
    expect(findReloadChanges(withAccounts(arrayLike), withAccounts(['x', 'y']))).toEqual({
      live: ['accounts'],
      restart: [],
    });
  });
});

describe('createConfigReloader — adoption freezes without assuming clean data (U-008)', () => {
  it('skips null children while deep-freezing the startup configuration', () => {
    // Validated pipeline output never carries null, but adoption must not
    // crash on one either: the freeze walks objects and arrays only.
    // (The brand is cast on: this input deliberately never ran the parser.)
    const initial: EffectiveConfig = {
      config: { ...baseConfig(), providers: { zai: null } } as unknown as EffectiveConfig['config'],
      sources: { fields: [], accountSecrets: [] },
      fileAbsent: false,
    };
    expect(() =>
      createConfigReloader({ initial, targetPath: '/unused/config.json' }),
    ).not.toThrow();
  });
});
