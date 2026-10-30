import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  schemaVersionStatus,
} from '../../src/storage/migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 084's done-condition (spec §11.2): the `metric_values` table exists
 * and "constraints prevent invalid enum values and valid empty
 * measurements". The schema is exercised directly at the SQL level — the
 * typed repository is task 088 — against disposable databases migrated by
 * the 078 runner with the canonical set (D-031/D-039). Metric rows are
 * inserted only after their account, run, and snapshot exist and with
 * `PRAGMA foreign_keys = ON`, matching the §11.1 connection production uses
 * (task 079); raw `DatabaseSync` handles default to SQLite's off (D-034's
 * pinned note for storage tests). The `node:sqlite` ExperimentalWarning is
 * expected here, as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the row helpers. */
const T0 = 1_761_000_000_000;

/** The `collected_at` of the base snapshot every base metric row refers to. */
const SNAPSHOT_AT = T0 + 1_500;

/**
 * The exact column contract of `metric_values` (D-039) — name, declared
 * STRICT type, and required flag. §11.2's row (snapshot reference,
 * denormalized account/time, metric key, limit type, unit, window size,
 * used/remaining/limit, percentages, reset time, validity, invalid reason,
 * derived fields) with `limit` stored as `limit_value` (bare `limit` is an
 * SQL keyword). No `label` column: §11.2's row does not list it (D-032
 * exact-set rule).
 */
const EXPECTED_COLUMNS = [
  { name: 'run_id', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'account_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'collected_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'metric_key', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'limit_type', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'unit', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'window_seconds', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'used', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'remaining', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'limit_value', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'percent_used', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'percent_remaining', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'resets_at', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'is_valid', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'invalid_reason', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'derived_fields', type: 'INTEGER', notnull: 0, pk: 0 },
] as const;

/**
 * The indexes `metric_values` carries, in name order, as `PRAGMA index_list`
 * reports them: §11.2's named series-access index (created by the migration)
 * and the autoindex of the `UNIQUE (run_id, metric_key)` constraint — the
 * structural one-metric-per-key-per-snapshot enforcement (origin 'u' =
 * UNIQUE constraint), whose leading `run_id` also serves the snapshot
 * cascade scan.
 */
const EXPECTED_INDEXES = [
  { name: 'metric_values_series_access', unique: 0, origin: 'c' },
  { name: 'sqlite_autoindex_metric_values_1', unique: 1, origin: 'u' },
] as const;

/** One `metric_values` row exactly as INSERTed — every field explicit. */
interface MetricRow {
  readonly runId: number | null;
  readonly accountId: string | null;
  readonly collectedAt: number | null;
  readonly metricKey: string | null;
  readonly limitType: string | null;
  readonly unit: string | null;
  readonly windowSeconds: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limitValue: number | null;
  readonly percentUsed: number | null;
  readonly percentRemaining: number | null;
  readonly resetsAt: number | null;
  readonly isValid: number | null;
  readonly invalidReason: string | null;
  readonly derivedFields: number | null;
}

/**
 * A valid, fully populated metric of the base snapshot — §8.4's shape with
 * every optional field set, fractional quota values included (the REAL
 * columns must accept them). `derivedFields: 2` marks `remaining` as derived
 * (`limit - used`) per D-010's bit order.
 */
function fullMetric(overrides: Partial<MetricRow> = {}): MetricRow {
  return {
    runId: 1,
    accountId: 'work',
    collectedAt: SNAPSHOT_AT,
    metricKey: 'usage_5h',
    limitType: 'ROLLING_WINDOW',
    unit: 'CREDITS',
    windowSeconds: 18_000,
    used: 120.5,
    remaining: 879.5,
    limitValue: 1000,
    percentUsed: 12.05,
    percentRemaining: 87.95,
    resetsAt: T0 + 3_600_000,
    isValid: 1,
    invalidReason: null,
    derivedFields: 2,
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertRawMetricValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO metric_values (
         run_id, account_id, collected_at, metric_key, limit_type, unit,
         window_seconds, used, remaining, limit_value, percent_used,
         percent_remaining, resets_at, is_valid, invalid_reason, derived_fields
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed metric row. */
function insertMetric(database: DatabaseSync, row: MetricRow): void {
  insertRawMetricValues(
    database,
    row.runId,
    row.accountId,
    row.collectedAt,
    row.metricKey,
    row.limitType,
    row.unit,
    row.windowSeconds,
    row.used,
    row.remaining,
    row.limitValue,
    row.percentUsed,
    row.percentRemaining,
    row.resetsAt,
    row.isValid,
    row.invalidReason,
    row.derivedFields,
  );
}

/** Inserts one `accounts` row the helpers' `work` default refers to. */
function insertAccount(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
       VALUES (?, 'zai-coding-plan', 'Work account', NULL, 'active', ?, NULL)`,
    )
    .run(id, T0);
}

/**
 * Inserts one successful `collection_runs` row and answers its auto-assigned
 * id — the run the snapshot (and through it the metric rows) keys on.
 */
function insertSuccessRun(database: DatabaseSync, accountId: string): number {
  const result = database
    .prepare(
      `INSERT INTO collection_runs
         (account_id, started_at, ended_at, interval_seconds, outcome, http_status,
          error_message, attempts, retry_after_seconds)
       VALUES (?, ?, ?, 300, 'success', 200, NULL, 1, NULL)`,
    )
    .run(accountId, T0, T0 + 1_200) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/** Inserts the `snapshots` header row a metric row must refer to. */
function insertSnapshot(
  database: DatabaseSync,
  runId: number,
  accountId: string,
  collectedAt: number,
): void {
  database
    .prepare(
      `INSERT INTO snapshots (run_id, account_id, collected_at, plan_name, run_outcome)
       VALUES (?, ?, ?, NULL, 'success')`,
    )
    .run(runId, accountId, collectedAt);
}

/**
 * A migrated database ready for metric inserts: full canonical set applied,
 * the §11.1 foreign-keys setting switched on (079's connection applies it in
 * production; raw handles default to off), and the `work` account present
 * with one successful run (id 1) and its snapshot at {@link SNAPSHOT_AT}.
 */
async function openMetricsDatabase(dbPath: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(dbPath);
  await createMigrationRunner({
    database,
    clock: createFixedClock(T0),
    migrations: MIGRATIONS,
  }).up();
  database.exec('PRAGMA foreign_keys = ON');
  insertAccount(database, 'work');
  insertSuccessRun(database, 'work'); // run id 1
  insertSnapshot(database, 1, 'work', SNAPSHOT_AT);
  return database;
}

/** One stored `metric_values` row, in SELECT * column order. */
interface StoredMetric {
  readonly run_id: number;
  readonly account_id: string;
  readonly collected_at: number;
  readonly metric_key: string;
  readonly limit_type: string;
  readonly unit: string;
  readonly window_seconds: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limit_value: number | null;
  readonly percent_used: number | null;
  readonly percent_remaining: number | null;
  readonly resets_at: number | null;
  readonly is_valid: number;
  readonly invalid_reason: string | null;
  readonly derived_fields: number | null;
}

/** All `metric_values` rows, ordered for deterministic assertions. */
function allMetrics(database: DatabaseSync): StoredMetric[] {
  return database
    .prepare('SELECT * FROM metric_values ORDER BY run_id ASC, metric_key ASC')
    .all() as unknown as StoredMetric[];
}

/** The `EXPLAIN QUERY PLAN` details for a statement, joined for matching. */
function queryPlan(database: DatabaseSync, sql: string, ...params: Array<string | number>): string {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join(' | ');
}

describe('metric_values table (task 084, spec §11.2, decision D-039)', () => {
  it('migrates a schema-3 database forward to up-to-date version 4', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('metric-values-forward.sqlite');

      // §11.4's forward test from the previous supported schema: a database
      // at schema 3 — migrated by the task-083 canonical set (0001–0003).
      // Every later migration is excluded so the pass leaves exactly the
      // schema-3 state the task-084/085/086 migrations must complete (the
      // snapshots.spec.ts precedent for excluding successors).
      const schemaThreeSet = MIGRATIONS.filter(
        (migration) =>
          migration.name !== '0004-metric-values' &&
          migration.name !== '0005-quota-events' &&
          migration.name !== '0006-raw-responses',
      );
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: schemaThreeSet,
      }).up();
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 6,
        appliedVersion: 3,
        relation: 'behind',
        newerThanSupported: [],
      });

      // The task-084/085/086 migrations complete it, in order.
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 + 1),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual(['0004-metric-values', '0005-quota-events', '0006-raw-responses']);
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 6,
        appliedVersion: 6,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      db.close();

      // Journal proven through an independent connection: all six entries
      // with their own §11.1 epoch-ms timestamps.
      const reader = new DatabaseSync(dbPath);
      const journal = reader
        .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
        .all() as Array<{ name: string; applied_at: number }>;
      expect(journal).toEqual([
        { name: '0001-accounts', applied_at: T0 },
        { name: '0002-collection-runs', applied_at: T0 },
        { name: '0003-snapshots', applied_at: T0 },
        { name: '0004-metric-values', applied_at: T0 + 1 },
        { name: '0005-quota-events', applied_at: T0 + 1 },
        { name: '0006-raw-responses', applied_at: T0 + 1 },
      ]);
      reader.close();

      // The recorded state is respected: a re-run is a no-op.
      const reopened = new DatabaseSync(dbPath);
      const rerun = await createMigrationRunner({
        database: reopened,
        clock: createFixedClock(T0 + 2),
        migrations: MIGRATIONS,
      }).up();
      expect(rerun).toEqual([]);
      reopened.close();
    });
  });

  it('pins the exact column set: STRICT types, no defaults, the series index, the unique metric key', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('metric-values-columns.sqlite');
      const db = await openMetricsDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(metric_values)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list exactly: names, declared types (STRICT makes
      // them per-value), and required columns.
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_COLUMNS,
      );

      // No SQL-side defaults: every value is writer-supplied from validated
      // normalized data (D-021 supplies clock timestamps) — never a
      // database time function or generated value.
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );

      // §11.2 "strict tables where feasible": the declaration carries STRICT
      // (the per-value enforcement is pinned by the test below).
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'metric_values'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      // §11.2's named series-access index plus the UNIQUE autoindex — the
      // structural one-metric-per-key-per-snapshot key. `index_list`
      // reports reverse-creation order, so sort for the pin.
      const indexes = reader.prepare('PRAGMA index_list(metric_values)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_INDEXES);

      // The parent key this migration adds to snapshots for the
      // denormalization-pinning composite FK — unique, and one more entry
      // than task 083 left.
      const parentIndexes = reader.prepare('PRAGMA index_list(snapshots)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const parentNamed = parentIndexes.map(({ name, unique, origin }) => ({
        name,
        unique,
        origin,
      }));
      expect(parentNamed).toContainEqual({
        name: 'snapshots_account_run_time',
        unique: 1,
        origin: 'c',
      });
      reader.close();
    });
  });

  it('stores one row per metric per snapshot with the §8.4 fields', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-happy.sqlite'));

      // The full §8.4 shape — fractional quota values included (REAL), the
      // derived-remaining bitmask, reset timestamp, rolling window.
      insertMetric(db, fullMetric());

      // A second metric of the same snapshot: a different key, DAILY tokens
      // with only percentages (§8.4 "if only percentage values are
      // returned… leave absolute fields empty"), no derivations.
      insertMetric(
        db,
        fullMetric({
          metricKey: 'requests_daily',
          limitType: 'DAILY',
          unit: 'PERCENT',
          windowSeconds: null,
          used: null,
          remaining: null,
          limitValue: null,
          percentUsed: 64.2,
          percentRemaining: 35.8,
          resetsAt: null,
          derivedFields: null,
        }),
      );

      // Another snapshot of the same account carries the same key again —
      // one row per metric *per snapshot* — plus another account's series.
      const secondRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, secondRun, 'work', T0 + 300_000);
      insertMetric(
        db,
        fullMetric({
          runId: secondRun,
          collectedAt: T0 + 300_000,
          used: 20,
          remaining: null,
          derivedFields: 0, // remaining not reported — no derivation claimed
        }),
      );
      insertAccount(db, 'personal');
      const personalRun = insertSuccessRun(db, 'personal');
      insertSnapshot(db, personalRun, 'personal', SNAPSHOT_AT);
      insertMetric(db, fullMetric({ runId: personalRun, accountId: 'personal', unit: 'TOKENS' }));

      expect(allMetrics(db)).toEqual([
        {
          run_id: 1,
          account_id: 'work',
          collected_at: SNAPSHOT_AT,
          metric_key: 'requests_daily',
          limit_type: 'DAILY',
          unit: 'PERCENT',
          window_seconds: null,
          used: null,
          remaining: null,
          limit_value: null,
          percent_used: 64.2,
          percent_remaining: 35.8,
          resets_at: null,
          is_valid: 1,
          invalid_reason: null,
          derived_fields: null,
        },
        {
          run_id: 1,
          account_id: 'work',
          collected_at: SNAPSHOT_AT,
          metric_key: 'usage_5h',
          limit_type: 'ROLLING_WINDOW',
          unit: 'CREDITS',
          window_seconds: 18_000,
          used: 120.5,
          remaining: 879.5,
          limit_value: 1000,
          percent_used: 12.05,
          percent_remaining: 87.95,
          resets_at: T0 + 3_600_000,
          is_valid: 1,
          invalid_reason: null,
          derived_fields: 2,
        },
        {
          run_id: secondRun,
          account_id: 'work',
          collected_at: T0 + 300_000,
          metric_key: 'usage_5h',
          limit_type: 'ROLLING_WINDOW',
          unit: 'CREDITS',
          window_seconds: 18_000,
          used: 20,
          remaining: null,
          limit_value: 1000,
          percent_used: 12.05,
          percent_remaining: 87.95,
          resets_at: T0 + 3_600_000,
          is_valid: 1,
          invalid_reason: null,
          derived_fields: 0,
        },
        {
          run_id: personalRun,
          account_id: 'personal',
          collected_at: SNAPSHOT_AT,
          metric_key: 'usage_5h',
          limit_type: 'ROLLING_WINDOW',
          unit: 'TOKENS',
          window_seconds: 18_000,
          used: 120.5,
          remaining: 879.5,
          limit_value: 1000,
          percent_used: 12.05,
          percent_remaining: 87.95,
          resets_at: T0 + 3_600_000,
          is_valid: 1,
          invalid_reason: null,
          derived_fields: 2,
        },
      ]);
      db.close();
    });
  });

  it('accepts every limit_type and unit value and rejects bogus ones', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-enums.sqlite'));

      // The §8.4 closed enums, mirrored exactly from
      // src/schemas/metrics.ts (D-010): every member is storable.
      const limitTypes = ['ROLLING_WINDOW', 'DAILY', 'WEEKLY', 'MONTHLY', 'OTHER'];
      const units = ['TOKENS', 'CREDITS', 'REQUESTS', 'PERCENT'];
      for (const [index, limitType] of limitTypes.entries()) {
        insertMetric(db, fullMetric({ metricKey: `metric_${index}`, limitType }));
      }
      for (const [index, unit] of units.entries()) {
        insertMetric(db, fullMetric({ metricKey: `unit_metric_${index}`, unit }));
      }
      expect(allMetrics(db)).toHaveLength(limitTypes.length + units.length);

      // Anything outside the closed sets is rejected — case-sensitively:
      // a lowercase member, an invented value, and the empty string all
      // fail the named enum CHECK.
      for (const limitType of ['daily', 'YEARLY', '']) {
        expect(
          () => insertMetric(db, fullMetric({ limitType })),
          `limit_type '${limitType}'`,
        ).toThrow(/CHECK constraint failed: metric_values_limit_type/);
      }
      for (const unit of ['tokens', 'SECONDS', '']) {
        expect(() => insertMetric(db, fullMetric({ unit })), `unit '${unit}'`).toThrow(
          /CHECK constraint failed: metric_values_unit/,
        );
      }

      expect(allMetrics(db)).toHaveLength(limitTypes.length + units.length);
      db.close();
    });
  });

  it('rejects a valid metric with no usable numeric value', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-valid-empty.sqlite'));

      // §11.2: "a valid metric row must include at least one usable numeric
      // metric value" — the done-condition's "valid empty measurement".
      expect(() =>
        insertMetric(
          db,
          fullMetric({
            used: null,
            remaining: null,
            limitValue: null,
            percentUsed: null,
            percentRemaining: null,
            derivedFields: null,
          }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_valid_has_value/);

      // Each single quota value alone makes the row valid — including a
      // percentage-only row (§8.4's percentage-only providers) and a lone
      // zero, which is a real measurement on a valid row. Each row's mask
      // claims exactly its present field as derived.
      const singleValueRows: Array<Partial<MetricRow>> = [
        {
          metricKey: 'only_used',
          remaining: null,
          limitValue: null,
          percentUsed: null,
          percentRemaining: null,
          derivedFields: 1,
        },
        {
          metricKey: 'only_remaining',
          used: null,
          limitValue: null,
          percentUsed: null,
          percentRemaining: null,
          derivedFields: 2,
        },
        {
          metricKey: 'only_limit',
          used: null,
          remaining: null,
          percentUsed: null,
          percentRemaining: null,
          derivedFields: 4,
        },
        {
          metricKey: 'only_percent_used',
          used: null,
          remaining: null,
          limitValue: null,
          percentRemaining: null,
          derivedFields: 8,
        },
        {
          metricKey: 'only_percent_remaining',
          used: null,
          remaining: null,
          limitValue: null,
          percentUsed: null,
          derivedFields: 16,
        },
        {
          metricKey: 'only_zero_used',
          used: 0,
          remaining: null,
          limitValue: null,
          percentUsed: null,
          percentRemaining: null,
          derivedFields: 1,
        },
      ];
      for (const overrides of singleValueRows) {
        insertMetric(db, fullMetric(overrides));
      }
      expect(allMetrics(db).map((row) => row.metric_key)).toEqual([
        'only_limit',
        'only_percent_remaining',
        'only_percent_used',
        'only_remaining',
        'only_used',
        'only_zero_used',
      ]);
      db.close();
    });
  });

  it('stores invalid metrics without numerics, with a reason, keeping window and reset metadata', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-invalid.sqlite'));

      // §8.4/§11.2's invalid shape: the five quota columns NULL, a
      // non-empty reason — and D-010(2)'s metadata retention: the window
      // length and reset schedule may stay known when a reading fails.
      insertMetric(
        db,
        fullMetric({
          used: null,
          remaining: null,
          limitValue: null,
          percentUsed: null,
          percentRemaining: null,
          isValid: 0,
          invalidReason: 'Quota endpoint returned no usage block',
          derivedFields: null,
        }),
      );
      expect(allMetrics(db)).toEqual([
        {
          run_id: 1,
          account_id: 'work',
          collected_at: SNAPSHOT_AT,
          metric_key: 'usage_5h',
          limit_type: 'ROLLING_WINDOW',
          unit: 'CREDITS',
          window_seconds: 18_000,
          used: null,
          remaining: null,
          limit_value: null,
          percent_used: null,
          percent_remaining: null,
          resets_at: T0 + 3_600_000,
          is_valid: 0,
          invalid_reason: 'Quota endpoint returned no usage block',
          derived_fields: null,
        },
      ]);

      // An invalid row without a reason is the other half of the
      // done-condition's invariant ("an invalid row needs a reason").
      expect(() =>
        insertMetric(
          db,
          fullMetric({
            metricKey: 'no_reason',
            used: null,
            remaining: null,
            limitValue: null,
            percentUsed: null,
            percentRemaining: null,
            isValid: 0,
            invalidReason: null,
            derivedFields: null,
          }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_invalid_reason/);

      // A blank reason is not a reason (the D-034 error_message shape).
      expect(() =>
        insertMetric(
          db,
          fullMetric({
            metricKey: 'blank_reason',
            used: null,
            remaining: null,
            limitValue: null,
            percentUsed: null,
            percentRemaining: null,
            isValid: 0,
            invalidReason: '',
            derivedFields: null,
          }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_invalid_reason_nonempty/);

      // The permissive direction of the one-directional coupling (the
      // D-034 precedent's failed-run-without-message): a valid row may
      // legally carry a reason — §8.4 never forbids it.
      insertMetric(
        db,
        fullMetric({
          metricKey: 'valid_with_stale_reason',
          invalidReason: 'previous attempt failed',
        }),
      );

      expect(allMetrics(db).map((row) => row.metric_key)).toEqual([
        'usage_5h',
        'valid_with_stale_reason',
      ]);
      db.close();
    });
  });

  it('rejects invalid metrics carrying any quota value, zero placeholders included', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-invalid-clean.sqlite'));

      // §11.2: "invalid metric rows must store NULL numeric fields … never
      // zero placeholders" — each of the five quota columns must be absent,
      // and a literal zero is a stored value, not an absent one.
      const quotaValues: Array<Partial<MetricRow>> = [
        { metricKey: 'with_used', used: 120.5 },
        { metricKey: 'with_remaining', remaining: 879.5 },
        { metricKey: 'with_limit', limitValue: 1000 },
        { metricKey: 'with_percent_used', percentUsed: 12.05 },
        { metricKey: 'with_percent_remaining', percentRemaining: 87.95 },
        { metricKey: 'with_zero', used: 0 },
      ];
      for (const { metricKey, ...present } of quotaValues) {
        expect(
          () =>
            insertMetric(
              db,
              fullMetric({
                metricKey,
                used: null,
                remaining: null,
                limitValue: null,
                percentUsed: null,
                percentRemaining: null,
                isValid: 0,
                invalidReason: 'Format changed',
                derivedFields: 0,
                ...present,
              }),
            ),
          `invalid row with '${metricKey}'`,
        ).toThrow(/CHECK constraint failed: metric_values_invalid_clean/);
      }

      expect(allMetrics(db)).toEqual([]);
      db.close();
    });
  });

  it('keeps derived_fields inside the D-010 closed set', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-derived.sqlite'));

      // The bitmask's whole domain: NULL = absent, 0 = empty set, 31 = all
      // five fields derived (used=1 | remaining=2 | limit=4 |
      // percentUsed=8 | percentRemaining=16, D-010's order).
      insertMetric(db, fullMetric({ metricKey: 'absent', derivedFields: null }));
      insertMetric(db, fullMetric({ metricKey: 'empty', derivedFields: 0 }));
      insertMetric(db, fullMetric({ metricKey: 'all_five', derivedFields: 31 }));
      // Alphabetical key order: absent → null, all_five → 31, empty → 0.
      expect(allMetrics(db).map((row) => row.derived_fields)).toEqual([null, 31, 0]);

      // Outside the power set of the closed five names: bit 6 and negative
      // are not derivable-field sets and are rejected by name.
      expect(() => insertMetric(db, fullMetric({ derivedFields: 32 }))).toThrow(
        /CHECK constraint failed: metric_values_derived_fields_range/,
      );
      expect(() => insertMetric(db, fullMetric({ derivedFields: -1 }))).toThrow(
        /CHECK constraint failed: metric_values_derived_fields_range/,
      );

      // The coupling to presence (D-010's "listed as derived but the field
      // is not set" record invariant): a set bit claims a derivation, so
      // the field itself must be stored — a derived-but-absent field is
      // unrepresentable.
      expect(() =>
        insertMetric(
          db,
          fullMetric({ metricKey: 'derived_used_absent', used: null, derivedFields: 1 }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_derived_present/);
      expect(() =>
        insertMetric(
          db,
          fullMetric({ metricKey: 'derived_remaining_absent', remaining: null, derivedFields: 2 }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_derived_present/);

      // A real zero is presence: a derived zero value is a derivation, not
      // an absence.
      insertMetric(
        db,
        fullMetric({
          metricKey: 'derived_zero_percent',
          used: null,
          remaining: null,
          limitValue: null,
          percentUsed: 0,
          percentRemaining: null,
          derivedFields: 8,
        }),
      );

      // An invalid row (all five quota columns NULL) can therefore carry
      // only the NULL or 0 mask — claiming derivations for values it must
      // not store is rejected.
      expect(() =>
        insertMetric(
          db,
          fullMetric({
            metricKey: 'invalid_derived',
            used: null,
            remaining: null,
            limitValue: null,
            percentUsed: null,
            percentRemaining: null,
            isValid: 0,
            invalidReason: 'Format changed',
            derivedFields: 5,
          }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_derived_present/);
      insertMetric(
        db,
        fullMetric({
          metricKey: 'invalid_empty_mask',
          used: null,
          remaining: null,
          limitValue: null,
          percentUsed: null,
          percentRemaining: null,
          isValid: 0,
          invalidReason: 'Format changed',
          derivedFields: 0,
        }),
      );

      expect(allMetrics(db).map((row) => row.metric_key)).toEqual([
        'absent',
        'all_five',
        'derived_zero_percent',
        'empty',
        'invalid_empty_mask',
      ]);
      db.close();
    });
  });

  it('rejects NULL in every required column and non-flag validity values', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-required.sqlite'));

      // §8.4/§11.2 required columns: the snapshot reference, the
      // denormalized account/time, the metric key, both enums, validity.
      const nullRejections: Array<[Partial<MetricRow>, RegExp]> = [
        [{ runId: null }, /NOT NULL constraint failed: metric_values.run_id/],
        [{ accountId: null }, /NOT NULL constraint failed: metric_values.account_id/],
        [{ collectedAt: null }, /NOT NULL constraint failed: metric_values.collected_at/],
        [{ metricKey: null }, /NOT NULL constraint failed: metric_values.metric_key/],
        [{ limitType: null }, /NOT NULL constraint failed: metric_values.limit_type/],
        [{ unit: null }, /NOT NULL constraint failed: metric_values.unit/],
        [{ isValid: null }, /NOT NULL constraint failed: metric_values.is_valid/],
        [{ isValid: 2 }, /CHECK constraint failed: metric_values_valid_flag/],
      ];
      for (const [overrides, pattern] of nullRejections) {
        expect(() => insertMetric(db, fullMetric(overrides))).toThrow(pattern);
      }

      expect(allMetrics(db)).toEqual([]);
      db.close();
    });
  });

  it('rejects account ids outside the D-014 charset and blank metric keys', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-bad-ids.sqlite'));

      // The same boundaries as accounts, runs, and snapshots
      // (D-032/D-034/D-036): history rows may only key on ids the accounts
      // table can hold.
      const badIds = [
        '', // empty
        '-lead', // leading '-' — the first character must be alphanumeric
        'sp ace', // spaces anywhere
        `${'a'.repeat(64)}x`, // 65 characters — one past the bound
        'a\0b', // embedded NUL: GLOB/length stop at NUL, the stored bytes do not
      ];
      for (const accountId of badIds) {
        expect(() => insertMetric(db, fullMetric({ accountId })), `id '${accountId}'`).toThrow(
          /CHECK constraint failed: metric_values_account_charset/,
        );
      }

      // The §8.4 metric key is a non-empty string; the empty one is not.
      expect(() => insertMetric(db, fullMetric({ metricKey: '' }))).toThrow(
        /CHECK constraint failed: metric_values_metric_key_nonempty/,
      );

      expect(allMetrics(db)).toEqual([]);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-strict.sqlite'));

      // §11.2 "strict tables where feasible", per value: blobs cannot enter
      // TEXT columns, text cannot enter the INTEGER or REAL columns.
      expect(() =>
        insertRawMetricValues(
          db,
          1,
          new Uint8Array([0x61]),
          SNAPSHOT_AT,
          'usage_5h',
          'ROLLING_WINDOW',
          'CREDITS',
          18_000,
          120.5,
          879.5,
          1000,
          12.05,
          87.95,
          T0 + 3_600_000,
          1,
          null,
          null,
        ),
      ).toThrow(/cannot store BLOB value in TEXT column metric_values.account_id/);
      expect(() =>
        insertRawMetricValues(
          db,
          'one',
          'work',
          SNAPSHOT_AT,
          'usage_5h',
          'ROLLING_WINDOW',
          'CREDITS',
          18_000,
          120.5,
          879.5,
          1000,
          12.05,
          87.95,
          T0 + 3_600_000,
          1,
          null,
          null,
        ),
      ).toThrow(/cannot store TEXT value in INTEGER column metric_values.run_id/);
      expect(() =>
        insertRawMetricValues(
          db,
          1,
          'work',
          SNAPSHOT_AT,
          'usage_5h',
          'ROLLING_WINDOW',
          'CREDITS',
          18_000,
          'many',
          879.5,
          1000,
          12.05,
          87.95,
          T0 + 3_600_000,
          1,
          null,
          null,
        ),
      ).toThrow(/cannot store TEXT value in REAL column metric_values.used/);
      expect(() =>
        insertRawMetricValues(
          db,
          1,
          'work',
          SNAPSHOT_AT,
          'usage_5h',
          'ROLLING_WINDOW',
          'CREDITS',
          18_000,
          120.5,
          879.5,
          1000,
          12.05,
          87.95,
          T0 + 3_600_000,
          'yes',
          null,
          null,
        ),
      ).toThrow(/cannot store TEXT value in INTEGER column metric_values.is_valid/);

      expect(allMetrics(db)).toEqual([]);
      db.close();
    });
  });

  it('allows one row per metric key per snapshot', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-unique.sqlite'));

      insertMetric(db, fullMetric({ used: 100 }));

      // §8.4 "keys are unique within a snapshot": a second row for the same
      // (run, key) — whatever its values — cannot exist…
      expect(() => insertMetric(db, fullMetric({ used: 200 }))).toThrow(
        /UNIQUE constraint failed: metric_values.run_id, metric_values.metric_key/,
      );

      // …while the same key in another snapshot, and another key in the
      // same snapshot, are exactly the rows the table exists for.
      const secondRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, secondRun, 'work', T0 + 300_000);
      insertMetric(db, fullMetric({ runId: secondRun, collectedAt: T0 + 300_000 }));
      insertMetric(db, fullMetric({ metricKey: 'requests_daily' }));
      expect(allMetrics(db).map((row) => [row.run_id, row.metric_key])).toEqual([
        [1, 'requests_daily'],
        [1, 'usage_5h'],
        [secondRun, 'usage_5h'],
      ]);
      db.close();
    });
  });

  it('pins the denormalized account and collection time to the snapshot', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-fk.sqlite'));

      // A run id nothing recorded a snapshot for.
      expect(() => insertMetric(db, fullMetric({ runId: 999 }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // A snapshot of another account: the composite FK matches
      // (account, run, time) as one key, so a metric row may not claim it.
      insertAccount(db, 'other');
      const otherRun = insertSuccessRun(db, 'other');
      insertSnapshot(db, otherRun, 'other', SNAPSHOT_AT);
      expect(() => insertMetric(db, fullMetric({ runId: otherRun, accountId: 'work' }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // The denormalized time must be the snapshot's: a drift would corrupt
      // the series index, and the composite FK makes it unrepresentable.
      expect(() => insertMetric(db, fullMetric({ collectedAt: SNAPSHOT_AT + 1 }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // The honest row — the exact snapshot key — passes.
      insertMetric(db, fullMetric());
      expect(allMetrics(db)).toHaveLength(1);
      db.close();
    });
  });

  it("freezes a referenced snapshot's identity against post-hoc UPDATEs", async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-parent-freeze.sqlite'));
      insertMetric(db, fullMetric());
      insertAccount(db, 'other');

      // Rewriting the snapshot's account or time under existing metric rows
      // would orphan the composite FK — the parent-side default (NO ACTION
      // on UPDATE) rejects it: recorded history stays interpretable.
      expect(() =>
        db.prepare('UPDATE snapshots SET account_id = ? WHERE run_id = ?').run('other', 1),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(() =>
        db.prepare('UPDATE snapshots SET collected_at = ? WHERE run_id = ?').run(T0 + 5_000, 1),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Unrelated columns of the same snapshot stay writable.
      db.prepare('UPDATE snapshots SET plan_name = ? WHERE run_id = ?').run('Pro 2026', 1);

      // And snapshots without metric rows are unaffected by the same
      // updates — the freeze is the metric reference's doing, not a
      // blanket UPDATE ban.
      const freeRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, freeRun, 'work', SNAPSHOT_AT);
      db.prepare('UPDATE snapshots SET collected_at = ? WHERE run_id = ?').run(T0 + 9_999, freeRun);
      expect(allMetrics(db)).toHaveLength(1);
      db.close();
    });
  });

  it('cascades: run deletion removes its metrics, account deletion removes all history', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-cascade.sqlite'));
      insertAccount(db, 'other');
      const otherRun = insertSuccessRun(db, 'other');
      insertSnapshot(db, otherRun, 'other', SNAPSHOT_AT);
      insertMetric(db, fullMetric({ metricKey: 'usage_5h' }));
      insertMetric(db, fullMetric({ metricKey: 'requests_daily' }));
      insertMetric(db, fullMetric({ runId: otherRun, accountId: 'other', metricKey: 'usage_5h' }));

      // §11.2 cascading deletion, run side: the snapshot dies with its run
      // and takes its metric rows along.
      db.prepare('DELETE FROM collection_runs WHERE id = ?').run(1);
      expect(allMetrics(db).map((row) => row.account_id)).toEqual(['other']);

      // Account side: both FK paths (direct account reference and through
      // the snapshot) remove the account's metric rows; the other
      // account's history stays. The work account re-collects first so the
      // purge has rows to remove on both paths.
      const workRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, workRun, 'work', SNAPSHOT_AT);
      insertMetric(db, fullMetric({ runId: workRun, metricKey: 'usage_5h', used: 7 }));
      db.prepare("DELETE FROM accounts WHERE id = 'work'").run();
      expect(allMetrics(db).map((row) => row.account_id)).toEqual(['other']);
      const remainingRuns = db
        .prepare('SELECT account_id FROM collection_runs ORDER BY id ASC')
        .all() as Array<{ account_id: string }>;
      expect(remainingRuns.map((row) => row.account_id)).toEqual(['other']);
      db.close();
    });
  });

  it('serves the §11.2 series queries from the named index', async () => {
    await withTempDir(async (dir) => {
      const db = await openMetricsDatabase(dir.sqlitePath('metric-values-indexes.sqlite'));

      // A small history: two metrics across three snapshots of `work`, one
      // of `other` — enough for range and ordering queries.
      const runs: Array<[string, number]> = [
        ['work', SNAPSHOT_AT],
        ['work', SNAPSHOT_AT + 300_000],
        ['work', SNAPSHOT_AT + 600_000],
      ];
      const runIds = runs.map(([accountId, collectedAt]) => {
        const runId = insertSuccessRun(db, accountId);
        insertSnapshot(db, runId, accountId, collectedAt);
        insertMetric(
          db,
          fullMetric({ runId, accountId, collectedAt, metricKey: 'usage_5h', used: 100 }),
        );
        insertMetric(
          db,
          fullMetric({
            runId,
            accountId,
            collectedAt,
            metricKey: 'requests_daily',
            limitType: 'DAILY',
            used: 5,
          }),
        );
        return runId;
      });
      insertAccount(db, 'other');
      const otherRun = insertSuccessRun(db, 'other');
      insertSnapshot(db, otherRun, 'other', SNAPSHOT_AT);
      insertMetric(
        db,
        fullMetric({
          runId: otherRun,
          accountId: 'other',
          metricKey: 'usage_5h',
          used: 42,
        }),
      );

      // §11.2's series access — one account's metric over time, newest
      // first (§13's chart shape): searched and ordered through the named
      // index, no temp sort.
      const series = queryPlan(
        db,
        'SELECT used FROM metric_values WHERE account_id = ? AND metric_key = ? ORDER BY collected_at DESC',
        'work',
        'usage_5h',
      );
      expect(series).toMatch(/USING (COVERING )?INDEX metric_values_series_access/);
      expect(series).not.toContain('TEMP B-TREE');

      // The history-window shape (§13 GET /api/history's from/to): an
      // account's metric within a time range — an index range scan.
      const window = queryPlan(
        db,
        'SELECT used FROM metric_values WHERE account_id = ? AND metric_key = ? AND collected_at >= ? AND collected_at < ?',
        'work',
        'usage_5h',
        SNAPSHOT_AT + 150_000,
        SNAPSHOT_AT + 450_000,
      );
      expect(window).toMatch(/USING (COVERING )?INDEX metric_values_series_access/);

      // And the queries return the right rows — the index serves §11.3's
      // "history queries must be indexed and should remain usable at that
      // scale" (one metric row per metric per snapshot at ≈52k snapshots
      // per account per 180 days).
      const newest = db
        .prepare(
          'SELECT run_id FROM metric_values WHERE account_id = ? AND metric_key = ? ORDER BY collected_at DESC LIMIT 1',
        )
        .all('work', 'usage_5h') as Array<{ run_id: number }>;
      expect(newest).toEqual([{ run_id: runIds[2] }]);
      const inWindow = db
        .prepare(
          'SELECT run_id FROM metric_values WHERE account_id = ? AND metric_key = ? AND collected_at >= ? AND collected_at < ? ORDER BY collected_at ASC',
        )
        .all('work', 'usage_5h', SNAPSHOT_AT + 150_000, SNAPSHOT_AT + 450_000) as Array<{
        run_id: number;
      }>;
      expect(inWindow).toEqual([{ run_id: runIds[1] }]);
      db.close();
    });
  });
});
