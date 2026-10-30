import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  MIGRATIONS,
  migrationVersion,
  MIGRATIONS_TABLE,
  schemaVersionStatus,
  supportedSchemaVersion,
} from '../../src/storage/migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 081's done-condition (spec §11.2): the `accounts` table exists, its
 * constraints hold, and the account lifecycle archives instead of deleting
 * (spec §8.2). The schema is exercised directly at the SQL level — the typed
 * repository is task 088 — against disposable databases migrated by the 078
 * runner with the canonical set (D-031/D-032). Structural claims are proven
 * through a second, independent connection where durability matters, as in
 * test/integration/migrations.spec.ts. The `node:sqlite` ExperimentalWarning
 * is expected here, as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for lifecycle rows. */
const T0 = 1_761_000_000_000;

/**
 * The exact §11.2 column contract of `accounts` (D-032) — name, declared
 * STRICT type, required flag, and primary-key membership. An exact-set
 * assertion is the structural no-secrets guarantee: no column outside this
 * list, credential-named or otherwise, can exist.
 */
const EXPECTED_COLUMNS = [
  { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'provider_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'label', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'plan_name', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'archived_at', type: 'INTEGER', notnull: 0, pk: 0 },
] as const;

/**
 * Fragments no `accounts` column name may contain — the §11.2 "credentials
 * are not stored here" rule (also §11.1, §15.4) stated explicitly so a future
 * migration cannot add a secret column without breaking this test.
 */
const FORBIDDEN_COLUMN_FRAGMENTS = ['key', 'secret', 'token', 'password', 'credential'] as const;

/** One `accounts` row exactly as INSERTed — every field explicit. */
interface AccountRow {
  readonly id: string | null;
  readonly providerId: string | null;
  readonly label: string | null;
  readonly planName: string | null;
  readonly status: string | null;
  readonly createdAt: number | null;
  readonly archivedAt: number | null;
}

/** A valid active account — the base every overriding test spreads. */
function activeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work account',
    planName: null,
    status: 'active',
    createdAt: T0,
    archivedAt: null,
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertRawValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed account row. */
function insertAccount(database: DatabaseSync, row: AccountRow): void {
  insertRawValues(
    database,
    row.id,
    row.providerId,
    row.label,
    row.planName,
    row.status,
    row.createdAt,
    row.archivedAt,
  );
}

/** One stored `accounts` row, in SELECT * column order. */
interface StoredAccount {
  readonly id: string;
  readonly provider_id: string;
  readonly label: string;
  readonly plan_name: string | null;
  readonly status: string;
  readonly created_at: number;
  readonly archived_at: number | null;
}

/** All `accounts` rows, ordered for deterministic assertions. */
function allAccounts(database: DatabaseSync): StoredAccount[] {
  // `as unknown as`: node:sqlite's row type cannot prove the nullable
  // columns, unlike the all-required rows migrations.spec.ts casts.
  return database
    .prepare('SELECT * FROM accounts ORDER BY id ASC')
    .all() as unknown as StoredAccount[];
}

describe('accounts table (task 081, spec §11.2, decision D-032)', () => {
  it('is the first canonical migration: schema 0 applies the full canonical set forward', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('accounts-migration.sqlite');
      const db = new DatabaseSync(dbPath);

      // The canonical set, grown by task 087: accounts remains the first
      // migration; the newest version is now 7.
      expect(MIGRATIONS.map((migration) => migration.name)).toEqual([
        '0001-accounts',
        '0002-collection-runs',
        '0003-snapshots',
        '0004-metric-values',
        '0005-quota-events',
        '0006-raw-responses',
        '0007-sessions-meta',
      ]);
      expect(migrationVersion('0001-accounts')).toBe(1);
      expect(supportedSchemaVersion(MIGRATIONS)).toBe(7);

      // §11.4's forward test: a database at schema 0 (the pre-081 state —
      // an empty journal) is behind, and applying the set brings it
      // up-to-date at the newest version.
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 7,
        appliedVersion: 0,
        relation: 'behind',
        newerThanSupported: [],
      });
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual([
        '0001-accounts',
        '0002-collection-runs',
        '0003-snapshots',
        '0004-metric-values',
        '0005-quota-events',
        '0006-raw-responses',
        '0007-sessions-meta',
      ]);
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 7,
        appliedVersion: 7,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      db.close();

      // Schema and journal proven through an independent connection, with
      // the §11.1 epoch-ms journal timestamp.
      const reader = new DatabaseSync(dbPath);
      const tables = reader
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual([
        'accounts',
        'collection_runs',
        'meta',
        'metric_values',
        'quota_events',
        'raw_responses',
        MIGRATIONS_TABLE,
        'sessions',
        'snapshots',
      ]);
      const journal = reader
        .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
        .all() as Array<{ name: string; applied_at: number }>;
      expect(journal).toEqual([
        { name: '0001-accounts', applied_at: T0 },
        { name: '0002-collection-runs', applied_at: T0 },
        { name: '0003-snapshots', applied_at: T0 },
        { name: '0004-metric-values', applied_at: T0 },
        { name: '0005-quota-events', applied_at: T0 },
        { name: '0006-raw-responses', applied_at: T0 },
        { name: '0007-sessions-meta', applied_at: T0 },
      ]);
      reader.close();

      // The recorded state is respected: a re-run is a no-op.
      const reopened = new DatabaseSync(dbPath);
      const rerun = await createMigrationRunner({
        database: reopened,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();
      expect(rerun).toEqual([]);
      reopened.close();
    });
  });

  it('pins the exact column set: STRICT types, no defaults, no credential columns', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('accounts-columns.sqlite');
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(accounts)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list, exactly: names, declared types (STRICT makes
      // them per-value), required columns, and the single stable-id key.
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_COLUMNS,
      );

      // No SQL-side defaults: timestamps come from the injected clock (D-021),
      // never from database time functions.
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );

      // §11.2 "Credentials are not stored here" as an explicit structural
      // check that survives future column additions.
      const suspicious = info
        .map((column) => column.name.toLowerCase())
        .filter((name) => FORBIDDEN_COLUMN_FRAGMENTS.some((fragment) => name.includes(fragment)));
      expect(suspicious).toEqual([]);

      // §11.2 "strict tables where feasible": the declaration carries STRICT
      // (the per-value type enforcement is pinned by the test below).
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
        .get() as { sql: string };
      // sqlite_master stores the normalized DDL without the trailing ';'.
      expect(created.sql).toMatch(/\)\s*STRICT$/);
      reader.close();
    });
  });

  it('accepts ids across the full D-014 charset and several accounts per provider', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-charset.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      // Length bounds (1 and 64), every allowed character class after the
      // first position, mixed case, and the optional plan (§11.2).
      const id64 = `a${'-_zZ9'.repeat(12)}bcd`;
      expect(id64.length).toBe(64);
      insertAccount(db, activeAccount({ id: 'a' }));
      insertAccount(db, activeAccount({ id: id64 }));
      insertAccount(db, activeAccount({ id: 'Zai-main', planName: 'Max Plan' }));
      insertAccount(db, activeAccount({ id: 'zai_2nd' }));

      // §8.2: multiple accounts per provider, each with its own state.
      expect(allAccounts(db).filter((row) => row.provider_id === 'zai-coding-plan')).toHaveLength(
        4,
      );
      expect(allAccounts(db)).toContainEqual({
        id: 'Zai-main',
        provider_id: 'zai-coding-plan',
        label: 'Work account',
        plan_name: 'Max Plan',
        status: 'active',
        created_at: T0,
        archived_at: null,
      });
      db.close();
    });
  });

  it('rejects ids and provider ids outside the D-014 charset or length range', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-bad-ids.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      const badIds = [
        '', // empty
        '-lead', // leading '-' — the first character must be alphanumeric
        '_lead', // leading '_'
        'has space', // spaces anywhere
        'slash/way', // path separators — ids surface in API paths (§13)
        'dot.id', // '.' is not in the charset
        'ümlaut', // non-ASCII
        `${'a'.repeat(64)}x`, // 65 characters — one past the bound
        'a\0b', // embedded NUL: GLOB/length stop at NUL, the stored bytes do not
      ];
      for (const id of badIds) {
        expect(() => insertAccount(db, activeAccount({ id })), `id '${id}'`).toThrow(
          /CHECK constraint failed: accounts_id_charset/,
        );
      }

      // The storage CHECK is the charset gate for provider ids: the
      // configuration field that lands here (`accounts[].providerId`) is only
      // `minLength: 1` (D-014 binds record keys, a different surface).
      for (const providerId of ['', '-p', 'sp ace', `${'p'.repeat(65)}`, 'p\0q']) {
        expect(
          () => insertAccount(db, activeAccount({ providerId })),
          `providerId '${providerId}'`,
        ).toThrow(/CHECK constraint failed: accounts_provider_charset/);
      }

      // NULL ids are rejected by the explicit NOT NULL — SQLite's rowid
      // tables would otherwise accept a NULL text primary key.
      expect(() => insertAccount(db, activeAccount({ id: null }))).toThrow(
        /NOT NULL constraint failed: accounts.id/,
      );
      expect(() => insertAccount(db, activeAccount({ providerId: null }))).toThrow(
        /NOT NULL constraint failed: accounts.provider_id/,
      );

      expect(allAccounts(db)).toEqual([]);
      db.close();
    });
  });

  it('rejects NULL or blank required metadata', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-required.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      expect(() => insertAccount(db, activeAccount({ label: null }))).toThrow(
        /NOT NULL constraint failed: accounts.label/,
      );
      // The configuration contract requires a non-empty label (D-014).
      expect(() => insertAccount(db, activeAccount({ label: '' }))).toThrow(
        /CHECK constraint failed: accounts_label_nonempty/,
      );
      expect(() => insertAccount(db, activeAccount({ status: null }))).toThrow(
        /NOT NULL constraint failed: accounts.status/,
      );
      expect(() => insertAccount(db, activeAccount({ createdAt: null }))).toThrow(
        /NOT NULL constraint failed: accounts.created_at/,
      );
      // §8.4's planName is absent-or-non-blank; the empty string is not a
      // third state the table may invent.
      expect(() => insertAccount(db, activeAccount({ planName: '' }))).toThrow(
        /CHECK constraint failed: accounts_plan_nonempty/,
      );

      expect(allAccounts(db)).toEqual([]);
      db.close();
    });
  });

  it('constrains status to the active/archived enum, tied to archived_at', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-status.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      // §11.2's closed enum — case-sensitive, and "enabled"/"deleted" are
      // different concepts (enable/disable is configuration state, §6.2).
      for (const status of ['enabled', 'disabled', 'deleted', 'ACTIVE', 'Archived', '']) {
        expect(() => insertAccount(db, activeAccount({ status })), `status '${status}'`).toThrow(
          /CHECK constraint failed: accounts_status/,
        );
      }

      // Drift is impossible in both directions: an active account cannot
      // claim an archive time, an archived one cannot omit it.
      expect(() => insertAccount(db, activeAccount({ archivedAt: T0 + 1 }))).toThrow(
        /CHECK constraint failed: accounts_archive_state/,
      );
      expect(() =>
        insertAccount(db, activeAccount({ status: 'archived', archivedAt: null })),
      ).toThrow(/CHECK constraint failed: accounts_archive_state/);

      // The consistent archived row is exactly what §8.2's delete produces.
      insertAccount(db, activeAccount({ id: 'gone', status: 'archived', archivedAt: T0 + 2_000 }));
      expect(allAccounts(db)).toHaveLength(1);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-strict.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      // §11.2 "strict tables where feasible", per value: a blob cannot enter
      // a TEXT column and text cannot enter an INTEGER timestamp.
      expect(() =>
        insertRawValues(db, new Uint8Array([0x61]), 'p', 'l', null, 'active', T0, null),
      ).toThrow(/cannot store BLOB value in TEXT column accounts.id/);
      expect(() =>
        insertRawValues(db, 'work', 'p', 'l', null, 'active', 'yesterday', null),
      ).toThrow(/cannot store TEXT value in INTEGER column accounts.created_at/);

      // Numbers never reach a TEXT id either: column affinity renders them
      // with a decimal point ('123.0'), which the charset CHECK rejects —
      // account ids are always the D-014 string form.
      expect(() => insertRawValues(db, 123, 'p', 'l', null, 'active', T0, null)).toThrow(
        /CHECK constraint failed: accounts_id_charset/,
      );

      expect(allAccounts(db)).toEqual([]);
      db.close();
    });
  });

  it('rejects duplicate account ids: the stable id is the primary key', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-duplicate.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      insertAccount(db, activeAccount({ id: 'zai-main' }));
      expect(() => insertAccount(db, activeAccount({ id: 'zai-main', label: 'Other' }))).toThrow(
        /UNIQUE constraint failed: accounts.id/,
      );
      expect(allAccounts(db)).toHaveLength(1);
      db.close();
    });
  });

  it('lives the §8.2 lifecycle: create → rename → archive, still queryable, per account', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(dir.sqlitePath('accounts-lifecycle.sqlite'));
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: MIGRATIONS,
      }).up();

      // Two accounts on one provider (§8.2): archiving one must leave the
      // other's state untouched.
      insertAccount(db, activeAccount({ id: 'zai-main', planName: 'Pro' }));
      insertAccount(db, activeAccount({ id: 'zai-second' }));

      // Rename (§8.2 "rename"): a plain metadata update.
      db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run('Main plan', 'zai-main');

      // Archive (§8.2 "deleting an account archives it while retaining
      // history"): the row is updated, never removed. The constraints bind
      // the UPDATE path too — an archive without its timestamp is exactly
      // the drift the composite CHECK exists for.
      expect(() =>
        db.prepare(`UPDATE accounts SET status = 'archived' WHERE id = ?`).run('zai-main'),
      ).toThrow(/CHECK constraint failed: accounts_archive_state/);
      db.prepare(`UPDATE accounts SET status = 'archived', archived_at = ? WHERE id = ?`).run(
        T0 + 3_600_000,
        'zai-main',
      );

      const rows = allAccounts(db);
      expect(rows).toHaveLength(2); // archive ≠ delete
      expect(rows).toContainEqual({
        id: 'zai-main',
        provider_id: 'zai-coding-plan',
        label: 'Main plan',
        plan_name: 'Pro',
        status: 'archived',
        created_at: T0,
        archived_at: T0 + 3_600_000,
      });

      // §11.1: timestamps stay integers.
      const archived = rows.find((row) => row.id === 'zai-main');
      expect(Number.isInteger(archived?.created_at)).toBe(true);
      expect(Number.isInteger(archived?.archived_at)).toBe(true);

      // The archived account remains queryable like any other row, and the
      // sibling keeps its own active state (§8.2).
      const active = db
        .prepare(`SELECT id FROM accounts WHERE status = 'active' ORDER BY id ASC`)
        .all() as Array<{ id: string }>;
      expect(active).toEqual([{ id: 'zai-second' }]);
      expect(db.prepare('SELECT id, status FROM accounts WHERE id = ?').get('zai-main')).toEqual({
        id: 'zai-main',
        status: 'archived',
      });
      db.close();
    });
  });
});
