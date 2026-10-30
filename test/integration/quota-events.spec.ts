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
 * Task 085's done-condition (spec §11.2): event queries are indexed and
 * deletion behavior is tested. The schema is exercised directly at the SQL
 * level — the typed repository is task 088, reset detection is 117/118 —
 * against disposable databases migrated by the 078 runner with the
 * canonical set (D-031/D-046). Event rows are inserted only after their
 * account (and, when present, its snapshot) exist and with
 * `PRAGMA foreign_keys = ON`, matching the §11.1 connection production uses
 * (task 079); raw `DatabaseSync` handles default to SQLite's off (D-034's
 * pinned note for storage tests). The `node:sqlite` ExperimentalWarning is
 * expected here, as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the row helpers. */
const T0 = 1_761_000_000_000;

/** The `collected_at` of the base snapshot the base event refers to. */
const SNAPSHOT_AT = T0 + 1_500;

/**
 * The exact column contract of `quota_events` (D-046) — name, declared
 * STRICT type, and required flag. §11.2's row (account, metric key, type,
 * event time, optional snapshot id, JSON details) with names refined per
 * §11.2's "may refine physical details": `event_type` for the spec's
 * "type", `event_at` for the house `_at` epoch-ms suffix, and `run_id` —
 * the snapshot identity D-036 pinned — for the optional snapshot id.
 */
const EXPECTED_COLUMNS = [
  { name: 'account_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'metric_key', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'event_type', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'event_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'run_id', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'details', type: 'TEXT', notnull: 1, pk: 0 },
] as const;

/**
 * The index `quota_events` carries: §11.2's named events index, and nothing
 * else — no UNIQUE constraint exists to add an autoindex (no query
 * references an event id, and §12.1 states no per-snapshot event
 * uniqueness; both are D-046 rejections).
 */
const EXPECTED_INDEXES = [
  { name: 'quota_events_account_metric_time', unique: 0, origin: 'c' },
] as const;

/** One `quota_events` row exactly as INSERTed — every field explicit. */
interface EventRow {
  readonly accountId: string | null;
  readonly metricKey: string | null;
  readonly eventType: string | null;
  readonly eventAt: number | null;
  readonly runId: number | null;
  readonly details: string | null;
}

/**
 * §12.1's evidence shape (D-046): condition 1 fired on `usage_5h` — the
 * used value dropped between the compared points — with the event time
 * taken from the previous point's `resetsAt` (it lay between the two
 * snapshots). The SQL-enforced audit minimum is `reason` (non-empty text)
 * plus the `previous`/`current` evidence objects; the point fields,
 * `tolerance`, and `eventTimeSource` are the writer contract.
 */
function fullDetails(): string {
  return JSON.stringify({
    reason: 'usage-decrease',
    previous: { runId: 1, collectedAt: SNAPSHOT_AT, used: 120.5, resetsAt: T0 + 3_600_000 },
    current: { runId: 2, collectedAt: T0 + 300_000, used: 0, resetsAt: T0 + 3_900_000 },
    tolerance: 0.5,
    eventTimeSource: 'previous_resets_at',
  });
}

/** A §12.1-shaped RESET event of the base snapshot's metric. */
function resetEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    accountId: 'work',
    metricKey: 'usage_5h',
    eventType: 'RESET',
    eventAt: T0 + 3_600_000,
    runId: 1,
    details: fullDetails(),
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertRawEventValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO quota_events (account_id, metric_key, event_type, event_at, run_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed event row. */
function insertEvent(database: DatabaseSync, row: EventRow): void {
  insertRawEventValues(
    database,
    row.accountId,
    row.metricKey,
    row.eventType,
    row.eventAt,
    row.runId,
    row.details,
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
 * id — the run the snapshot (and through it the event) keys on.
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

/** Inserts the `snapshots` header row an event's evidence refers to. */
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
 * A migrated database ready for event inserts: full canonical set applied,
 * the §11.1 foreign-keys setting switched on (079's connection applies it in
 * production; raw handles default to off), and the `work` account present
 * with one successful run (id 1) and its snapshot at {@link SNAPSHOT_AT}.
 */
async function openEventsDatabase(dbPath: string): Promise<DatabaseSync> {
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

/** One stored `quota_events` row, in SELECT * column order. */
interface StoredEvent {
  readonly account_id: string;
  readonly metric_key: string;
  readonly event_type: string;
  readonly event_at: number;
  readonly run_id: number | null;
  readonly details: string;
}

/** All `quota_events` rows, ordered for deterministic assertions. */
function allEvents(database: DatabaseSync): StoredEvent[] {
  return database
    .prepare('SELECT * FROM quota_events ORDER BY account_id ASC, metric_key ASC, event_at ASC')
    .all() as unknown as StoredEvent[];
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

describe('quota_events table (task 085, spec §11.2, §12.1, decision D-046)', () => {
  it('migrates a schema-4 database forward to up-to-date version 5', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('quota-events-forward.sqlite');

      // §11.4's forward test from the previous supported schema: a database
      // at schema 4 — migrated by the task-084 canonical set (0001–0004);
      // every later migration is excluded, or 0005 would run ahead of the
      // version order the set defines.
      const schemaFourSet = MIGRATIONS.filter(
        (migration) => migration.name !== '0005-quota-events',
      );
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: schemaFourSet,
      }).up();
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 5,
        appliedVersion: 4,
        relation: 'behind',
        newerThanSupported: [],
      });

      // The one new migration completes it.
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 + 1),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual(['0005-quota-events']);
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 5,
        appliedVersion: 5,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      db.close();

      // Journal proven through an independent connection: all five entries
      // with their own §11.1 epoch-ms timestamps.
      const reader = new DatabaseSync(dbPath);
      const journal = reader
        .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
        .all() as Array<{ name: string; applied_at: number }>;
      expect(journal).toEqual([
        { name: '0001-accounts', applied_at: T0 },
        { name: '0002-collection-runs', applied_at: T0 },
        { name: '0003-snapshots', applied_at: T0 },
        { name: '0004-metric-values', applied_at: T0 },
        { name: '0005-quota-events', applied_at: T0 + 1 },
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

  it('pins the exact column set: STRICT types, no defaults, the events index, the parent key', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('quota-events-columns.sqlite');
      const db = await openEventsDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(quota_events)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list exactly: names, declared types (STRICT makes
      // them per-value), and required columns — the optional snapshot id is
      // the one nullable reference.
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_COLUMNS,
      );

      // No SQL-side defaults: every value is writer-supplied (D-021 supplies
      // clock timestamps) — never a database time function or generated value.
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );

      // §11.2 "strict tables where feasible": the declaration carries STRICT
      // (the per-value enforcement is pinned by the test below).
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota_events'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      // §11.2's named events index — and nothing else: no UNIQUE constraint
      // exists to add an autoindex. `index_list` reports reverse-creation
      // order, so sort for the pin.
      const indexes = reader.prepare('PRAGMA index_list(quota_events)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_INDEXES);

      // The parent key this migration adds to snapshots for the
      // account-pinning composite FK — unique, and one more entry than task
      // 084 left.
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
        name: 'snapshots_account_run',
        unique: 1,
        origin: 'c',
      });
      reader.close();
    });
  });

  it('stores one row per recorded reset with the §12.1 evidence round-tripping', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-happy.sqlite'));

      // The full §12.1 shape: the event time is the previous point's
      // resetsAt (it lay between the two snapshots), and `details` carries
      // the comparison evidence verbatim.
      insertEvent(db, resetEvent());

      // A later event of the same metric — the new snapshot time as the
      // event time — plus another account's event.
      const secondRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, secondRun, 'work', T0 + 600_000);
      insertEvent(
        db,
        resetEvent({
          eventAt: T0 + 600_000,
          runId: secondRun,
          details: JSON.stringify({
            reason: 'resets-at-passed',
            previous: { runId: 2, collectedAt: T0 + 300_000, resetsAt: T0 + 3_900_000 },
            current: { runId: secondRun, collectedAt: T0 + 600_000, resetsAt: T0 + 7_200_000 },
            eventTimeSource: 'current_collected_at',
          }),
        }),
      );
      insertAccount(db, 'personal');
      const personalRun = insertSuccessRun(db, 'personal');
      insertSnapshot(db, personalRun, 'personal', SNAPSHOT_AT);
      insertEvent(
        db,
        resetEvent({
          accountId: 'personal',
          runId: personalRun,
          metricKey: 'requests_weekly',
          eventAt: T0 + 3_600_000,
        }),
      );

      const events = allEvents(db);
      expect(events).toHaveLength(3);
      // The base work row (the later of the account's two events) stores
      // every column exactly as INSERTed.
      const workRows = events.filter((row) => row.account_id === 'work');
      expect(workRows.map((row) => row.event_at)).toEqual([T0 + 600_000, T0 + 3_600_000]);
      expect(workRows[1]).toEqual({
        account_id: 'work',
        metric_key: 'usage_5h',
        event_type: 'RESET',
        event_at: T0 + 3_600_000,
        run_id: 1,
        details: fullDetails(),
      });
      // The evidence is JSON that parses back into the recorded comparison.
      const stored = db.prepare('SELECT details FROM quota_events WHERE run_id = ?').get(1) as {
        details: string;
      };
      const details = JSON.parse(stored.details) as {
        reason: string;
        previous: { used: number };
        current: { used: number };
        tolerance: number;
      };
      expect(details.previous.used).toBeGreaterThan(details.current.used);
      expect(details.reason).toBe('usage-decrease');
      expect(details.tolerance).toBe(0.5);
      // Ordering by account/metric/time is deterministic across accounts.
      expect(events.map((row) => [row.account_id, row.metric_key])).toEqual([
        ['personal', 'requests_weekly'],
        ['work', 'usage_5h'],
        ['work', 'usage_5h'],
      ]);
      db.close();
    });
  });

  it('constrains the event type to the §11.2 version-1 set', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-type.sqlite'));

      // §11.2 "type (`RESET` in version 1)": the closed version-1 set.
      insertEvent(db, resetEvent());

      // Anything outside it is rejected — case-sensitively: a lowercase
      // member, an invented value (the §12.2 gap/failure markers are API
      // vocabulary computed from runs, not stored event types), and the
      // empty string all fail the named enum CHECK.
      for (const eventType of ['reset', 'GAP', '']) {
        expect(() => insertEvent(db, resetEvent({ eventType })), `type '${eventType}'`).toThrow(
          /CHECK constraint failed: quota_events_type/,
        );
      }

      expect(allEvents(db)).toHaveLength(1);
      db.close();
    });
  });

  it('rejects account ids outside the D-014 charset and blank metric keys', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-bad-ids.sqlite'));

      // The same boundaries as accounts, runs, snapshots, and metrics
      // (D-032/D-034/D-036/D-039): event rows may only key on ids the
      // accounts table can hold.
      const badIds = [
        '', // empty
        '-lead', // leading '-' — the first character must be alphanumeric
        'sp ace', // spaces anywhere
        `${'a'.repeat(64)}x`, // 65 characters — one past the bound
        'a\0b', // embedded NUL: GLOB/length stop at NUL, the stored bytes do not
      ];
      for (const accountId of badIds) {
        expect(() => insertEvent(db, resetEvent({ accountId })), `id '${accountId}'`).toThrow(
          /CHECK constraint failed: quota_events_account_charset/,
        );
      }

      // The metric key shares metric_values' non-empty-string semantics
      // (§8.4's stable adapter-defined identifier).
      expect(() => insertEvent(db, resetEvent({ metricKey: '' }))).toThrow(
        /CHECK constraint failed: quota_events_metric_key_nonempty/,
      );

      expect(allEvents(db)).toEqual([]);
      db.close();
    });
  });

  it('rejects NULL in every required column; the snapshot reference stays optional', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-required.sqlite'));

      // §11.2's row: the account, metric key, type, event time, and JSON
      // details are required; the snapshot id is the spec's "optional" —
      // a NULL run_id is storable.
      const nullRejections: Array<[Partial<EventRow>, RegExp]> = [
        [{ accountId: null }, /NOT NULL constraint failed: quota_events.account_id/],
        [{ metricKey: null }, /NOT NULL constraint failed: quota_events.metric_key/],
        [{ eventType: null }, /NOT NULL constraint failed: quota_events.event_type/],
        [{ eventAt: null }, /NOT NULL constraint failed: quota_events.event_at/],
        [{ details: null }, /NOT NULL constraint failed: quota_events.details/],
      ];
      for (const [overrides, pattern] of nullRejections) {
        expect(() => insertEvent(db, resetEvent(overrides))).toThrow(pattern);
      }

      // The optional reference: an event with no snapshot id is exactly the
      // §11.2 "optional snapshot id" state, and it satisfies the composite
      // FK (SQLite treats any NULL child key as satisfied).
      insertEvent(db, resetEvent({ runId: null }));
      expect(allEvents(db)).toHaveLength(1);
      db.close();
    });
  });

  it('enforces the details JSON contract: valid JSON object with reason and both evidence points', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-details.sqlite'));

      // The audit minimum (D-046): every §12.1 reset event carries a
      // non-empty reason and the compared points. Malformed JSON fails the
      // first-declared json_valid CHECK by name (the shape checks'
      // json_type would otherwise throw un-named).
      const rejections: Array<[string | null, RegExp]> = [
        ['{', /CHECK constraint failed: quota_events_details_json/],
        ['not json at all', /CHECK constraint failed: quota_events_details_json/],
        // Valid JSON that is not an object: scalars, strings, arrays.
        ['42', /CHECK constraint failed: quota_events_details_object/],
        ['"usage-decrease"', /CHECK constraint failed: quota_events_details_object/],
        ['[1, 2]', /CHECK constraint failed: quota_events_details_object/],
        ['null', /CHECK constraint failed: quota_events_details_object/],
        // Reason present in the wrong shape, blank, or missing — a NULL
        // json_type (absent key) is coalesced to a mismatch because a NULL
        // CHECK result passes in SQLite (verified on the pinned runtime).
        [
          JSON.stringify({ previous: {}, current: {} }),
          /CHECK constraint failed: quota_events_details_reason/,
        ],
        [
          JSON.stringify({ reason: '', previous: {}, current: {} }),
          /CHECK constraint failed: quota_events_details_reason/,
        ],
        [
          JSON.stringify({ reason: 5, previous: {}, current: {} }),
          /CHECK constraint failed: quota_events_details_reason/,
        ],
        [
          JSON.stringify({ reason: null, previous: {}, current: {} }),
          /CHECK constraint failed: quota_events_details_reason/,
        ],
        // The compared points are objects and both are present.
        [
          JSON.stringify({ reason: 'r', current: {} }),
          /CHECK constraint failed: quota_events_details_points/,
        ],
        [
          JSON.stringify({ reason: 'r', previous: {} }),
          /CHECK constraint failed: quota_events_details_points/,
        ],
        [
          JSON.stringify({ reason: 'r', previous: {}, current: [1] }),
          /CHECK constraint failed: quota_events_details_points/,
        ],
        [
          JSON.stringify({ reason: 'r', previous: {}, current: 'x' }),
          /CHECK constraint failed: quota_events_details_points/,
        ],
      ];
      for (const [details, pattern] of rejections) {
        expect(() => insertEvent(db, resetEvent({ details })), `details '${details}'`).toThrow(
          pattern,
        );
      }

      // The minimal contract-conforming object passes; optional keys
      // (tolerance, eventTimeSource) are the writer's vocabulary, not SQL's.
      insertEvent(
        db,
        resetEvent({
          details: JSON.stringify({ reason: 'usage-decrease', previous: {}, current: {} }),
        }),
      );
      expect(allEvents(db)).toHaveLength(1);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-strict.sqlite'));

      // §11.2 "strict tables where feasible", per value: blobs cannot enter
      // TEXT columns, text cannot enter the INTEGER columns.
      expect(() =>
        insertRawEventValues(db, new Uint8Array([0x61]), 'usage_5h', 'RESET', T0, 1, fullDetails()),
      ).toThrow(/cannot store BLOB value in TEXT column quota_events.account_id/);
      expect(() =>
        insertRawEventValues(db, 'work', 'usage_5h', 'RESET', 'now', 1, fullDetails()),
      ).toThrow(/cannot store TEXT value in INTEGER column quota_events.event_at/);
      expect(() =>
        insertRawEventValues(db, 'work', 'usage_5h', 'RESET', T0, 'one', fullDetails()),
      ).toThrow(/cannot store TEXT value in INTEGER column quota_events.run_id/);
      expect(() =>
        insertRawEventValues(db, 'work', 'usage_5h', 'RESET', T0, 1, new Uint8Array([0x7b])),
      ).toThrow(/cannot store BLOB value in TEXT column quota_events.details/);

      expect(allEvents(db)).toEqual([]);
      db.close();
    });
  });

  it('pins the event account to the referenced snapshot', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-fk.sqlite'));

      // A run id nothing recorded a snapshot for.
      expect(() => insertEvent(db, resetEvent({ runId: 999 }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // A snapshot of another account: the composite FK matches
      // (account, run) as one key, so an event may not mix the account's
      // timeline with another account's snapshot — the drift would corrupt
      // exactly the account/metric/time index this table exists to serve.
      insertAccount(db, 'other');
      const otherRun = insertSuccessRun(db, 'other');
      insertSnapshot(db, otherRun, 'other', SNAPSHOT_AT);
      expect(() => insertEvent(db, resetEvent({ runId: otherRun }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // An event may also reference no snapshot at all: the composite FK
      // passes on the NULL child key while the direct account FK alone
      // proves the account exists.
      insertEvent(db, resetEvent({ accountId: 'other', runId: null }));
      expect(allEvents(db).map((row) => row.account_id)).toEqual(['other']);

      // The honest row — the exact snapshot key — passes.
      insertEvent(db, resetEvent());
      expect(allEvents(db)).toHaveLength(2);

      // Child-side UPDATE path: re-pointing a stored event at another
      // account while it still cites this account's snapshot fails the same
      // composite FK — the pinning holds on writes, not just inserts.
      expect(() =>
        db.prepare("UPDATE quota_events SET account_id = 'other' WHERE run_id = ?").run(1),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(allEvents(db)).toHaveLength(2);
      db.close();
    });
  });

  it("freezes a referenced snapshot's identity against post-hoc UPDATEs", async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-parent-freeze.sqlite'));
      insertAccount(db, 'other');
      insertEvent(db, resetEvent());

      // Rewriting the snapshot's account under existing events would orphan
      // the composite FK — the parent-side default (NO ACTION on UPDATE)
      // rejects it: recorded history stays interpretable.
      expect(() =>
        db.prepare('UPDATE snapshots SET account_id = ? WHERE run_id = ?').run('other', 1),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Unrelated columns of the same snapshot stay writable.
      db.prepare('UPDATE snapshots SET plan_name = ? WHERE run_id = ?').run('Pro 2026', 1);

      // And snapshots without events are unaffected by the same update —
      // the freeze is the event reference's doing, not a blanket UPDATE ban.
      const freeRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, freeRun, 'work', SNAPSHOT_AT);
      db.prepare('UPDATE snapshots SET account_id = ? WHERE run_id = ?').run('work', freeRun);
      expect(allEvents(db)).toHaveLength(1);
      db.close();
    });
  });

  it('cascades: snapshot/run deletion removes its events, account purge removes all, archive retains', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-cascade.sqlite'));
      insertAccount(db, 'other');
      const otherRun = insertSuccessRun(db, 'other');
      insertSnapshot(db, otherRun, 'other', SNAPSHOT_AT);
      insertEvent(db, resetEvent()); // work, run 1
      insertEvent(db, resetEvent({ runId: null, metricKey: 'requests_daily' })); // work, no snapshot
      insertEvent(db, resetEvent({ accountId: 'other', runId: otherRun, metricKey: 'usage_5h' }));

      // §8.2 archive keeps history: archiving is an UPDATE, and the
      // account's events (snapshot-referenced or not) all survive.
      db.prepare("UPDATE accounts SET status = 'archived', archived_at = ? WHERE id = 'work'").run(
        T0 + 10,
      );
      expect(allEvents(db)).toHaveLength(3);

      // Run-side cascade: deleting a run removes its snapshot and with it
      // the events that referenced it — the NULL-run event of the same
      // account survives (it belongs to the series, not the snapshot).
      db.prepare('DELETE FROM collection_runs WHERE id = ?').run(1);
      expect(allEvents(db).map((row) => [row.account_id, row.metric_key])).toEqual([
        ['other', 'usage_5h'],
        ['work', 'requests_daily'],
      ]);

      // Account-side purge (§8.2's separate explicit action): both FK paths
      // (direct account reference and through the snapshot) remove the
      // account's events; the other account's history stays.
      const workRun = insertSuccessRun(db, 'work');
      insertSnapshot(db, workRun, 'work', SNAPSHOT_AT);
      insertEvent(db, resetEvent({ runId: workRun }));
      db.prepare("DELETE FROM accounts WHERE id = 'work'").run();
      expect(allEvents(db).map((row) => row.account_id)).toEqual(['other']);
      db.close();
    });
  });

  it('serves the §11.2 event queries from the named index', async () => {
    await withTempDir(async (dir) => {
      const db = await openEventsDatabase(dir.sqlitePath('quota-events-indexes.sqlite'));

      // A small event history: two metrics across three times of `work`,
      // one of `other` — enough for range and ordering queries. Each event
      // takes its snapshot's collection time (§12.1's "otherwise use the
      // new snapshot timestamp" branch).
      const times = [SNAPSHOT_AT, T0 + 300_000, T0 + 600_000];
      const runs: Array<number> = [];
      for (const at of times) {
        const runId = insertSuccessRun(db, 'work');
        insertSnapshot(db, runId, 'work', at);
        insertEvent(db, resetEvent({ runId, metricKey: 'usage_5h', eventAt: at }));
        insertEvent(db, resetEvent({ runId, metricKey: 'requests_weekly', eventAt: at }));
        runs.push(runId);
      }
      insertAccount(db, 'other');
      const otherRun = insertSuccessRun(db, 'other');
      insertSnapshot(db, otherRun, 'other', SNAPSHOT_AT);
      insertEvent(db, resetEvent({ accountId: 'other', runId: otherRun, eventAt: T0 + 3_600_000 }));

      // §11.2's events-by-account/metric/time access — one account's metric
      // over time, newest first (§13's event list shape): searched and
      // ordered through the named index, no temp sort.
      const series = queryPlan(
        db,
        'SELECT event_at FROM quota_events WHERE account_id = ? AND metric_key = ? ORDER BY event_at DESC',
        'work',
        'usage_5h',
      );
      expect(series).toMatch(/USING (COVERING )?INDEX quota_events_account_metric_time/);
      expect(series).not.toContain('TEMP B-TREE');

      // The time-window shape (§13 GET /api/events' account/time/metric
      // filters): an account's metric within a time range — an index range
      // scan.
      const window = queryPlan(
        db,
        'SELECT event_at FROM quota_events WHERE account_id = ? AND metric_key = ? AND event_at >= ? AND event_at < ?',
        'work',
        'usage_5h',
        T0 + 300_000,
        T0 + 2_400_000,
      );
      expect(window).toMatch(/USING (COVERING )?INDEX quota_events_account_metric_time/);

      // The account-only prefix of the index serves the metric-unfiltered
      // timeline scan (§12.2's event stream).
      const accountOnly = queryPlan(
        db,
        'SELECT metric_key, event_at FROM quota_events WHERE account_id = ?',
        'work',
      );
      expect(accountOnly).toMatch(/USING (COVERING )?INDEX quota_events_account_metric_time/);

      // And the queries return the right rows — the index serves §11.3's
      // "history queries must be indexed and should remain usable at that
      // scale" for the event stream too.
      const newest = db
        .prepare(
          'SELECT run_id FROM quota_events WHERE account_id = ? AND metric_key = ? ORDER BY event_at DESC LIMIT 1',
        )
        .all('work', 'usage_5h') as Array<{ run_id: number }>;
      expect(newest).toEqual([{ run_id: runs[2] }]);
      const inWindow = db
        .prepare(
          'SELECT run_id FROM quota_events WHERE account_id = ? AND metric_key = ? AND event_at >= ? AND event_at < ? ORDER BY event_at ASC',
        )
        .all('work', 'usage_5h', T0 + 300_000, T0 + 2_400_000) as Array<{ run_id: number }>;
      expect(inWindow).toEqual([{ run_id: runs[1] }, { run_id: runs[2] }]);
      db.close();
    });
  });
});
