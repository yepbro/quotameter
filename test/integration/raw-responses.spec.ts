import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD_BYTES } from '../../src/providers/sanitize';
import {
  createMigrationRunner,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  RAW_RESPONSE_MAX_PAYLOAD_BYTES,
  schemaVersionStatus,
} from '../../src/storage/migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 086's done-condition (spec §11.2): the schema cannot store multiple
 * raw records for a single run — and, per §7.4's "only when parsing/schema
 * validation fails", a successful run can never have one at all. The schema
 * is exercised directly at the SQL level (the typed repository is task 088,
 * sanitization is task 102, retention execution is task 103) against
 * disposable databases migrated by the 078 runner with the canonical set
 * (D-031/D-051). Rows are inserted only after their account and run exist
 * and with `PRAGMA foreign_keys = ON`, matching the §11.1 connection
 * production uses (task 079); raw `DatabaseSync` handles default to
 * SQLite's off (D-034's pinned note for storage tests). The `node:sqlite`
 * ExperimentalWarning is expected here, as in every storage test
 * (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the row helpers. */
const T0 = 1_761_000_000_000;

/**
 * The exact column contract of `raw_responses` (D-051) — name, declared
 * STRICT type, and required flag. §11.2's row (run reference, timestamp,
 * HTTP status, content type, body) with names refined per §11.2's "may
 * refine physical details" (`captured_at` for the house `_at` epoch-ms
 * suffix), plus the two D-036 FK carriers `account_id` and `run_outcome`.
 */
const EXPECTED_COLUMNS = [
  { name: 'run_id', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'account_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'captured_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'http_status', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'content_type', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'body', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'run_outcome', type: 'TEXT', notnull: 1, pk: 0 },
] as const;

/**
 * The indexes `raw_responses` carries: the retention index and the
 * autoindex of the `run_id UNIQUE` constraint — the structural
 * one-record-per-run key (the `snapshots.spec.ts` precedent for pinning
 * autoindexes).
 */
const EXPECTED_INDEXES = [
  { name: 'raw_responses_account_time', unique: 0, origin: 'c' },
  { name: 'sqlite_autoindex_raw_responses_1', unique: 1, origin: 'u' },
] as const;

/** One `raw_responses` row exactly as INSERTed — every field explicit. */
interface RawResponseRow {
  readonly runId: number | null;
  readonly accountId: string | null;
  readonly capturedAt: number | null;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly body: string | null;
  readonly runOutcome: string | null;
}

/**
 * A §7.4-shaped parse-failure payload: the sanitizer's (task 102, D-041)
 * output for a 2xx body whose envelope broke. Multibyte on purpose, so the
 * happy-path round-trip also pins byte-faithful TEXT storage.
 */
const SANITIZED_BODY = '{"code": 200, "msg": "oké", "data": {"level": "[REDACTED]"}}';

/** A §7.4-shaped raw response for the base parse-error run. */
function rawResponse(overrides: Partial<RawResponseRow> = {}): RawResponseRow {
  return {
    runId: 1,
    accountId: 'work',
    capturedAt: T0 + 1_200,
    httpStatus: 200,
    contentType: 'application/json',
    body: SANITIZED_BODY,
    runOutcome: 'parse_error',
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertRawResponseValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO raw_responses
         (run_id, account_id, captured_at, http_status, content_type, body, run_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed raw-response row. */
function insertRawResponse(database: DatabaseSync, row: RawResponseRow): void {
  insertRawResponseValues(
    database,
    row.runId,
    row.accountId,
    row.capturedAt,
    row.httpStatus,
    row.contentType,
    row.body,
    row.runOutcome,
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
 * Inserts one `collection_runs` row of the given outcome and answers its
 * auto-assigned id. Parse-error runs carry a 2xx status and a sanitized
 * error message (§7.2's shape); other outcomes get the minimal row their
 * CHECKs accept.
 */
function insertRun(
  database: DatabaseSync,
  accountId: string,
  outcome: string,
  httpStatus: number | null = outcome === 'parse_error' ? 200 : null,
): number {
  const result = database
    .prepare(
      `INSERT INTO collection_runs
         (account_id, started_at, ended_at, interval_seconds, outcome, http_status,
          error_message, attempts, retry_after_seconds)
       VALUES (?, ?, ?, 300, ?, ?, ?, 1, NULL)`,
    )
    .run(
      accountId,
      T0,
      T0 + 1_000,
      outcome,
      httpStatus,
      outcome === 'success' ? null : 'collection failed',
    ) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/**
 * A migrated database ready for raw-response inserts: full canonical set
 * applied, the §11.1 foreign-keys setting switched on (079's connection
 * applies it in production; raw handles default to off), and the `work`
 * account present with one parse-error run (id 1).
 */
async function openRawResponsesDatabase(dbPath: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(dbPath);
  await createMigrationRunner({
    database,
    clock: createFixedClock(T0),
    migrations: MIGRATIONS,
  }).up();
  database.exec('PRAGMA foreign_keys = ON');
  insertAccount(database, 'work');
  insertRun(database, 'work', 'parse_error'); // run id 1
  return database;
}

/** One stored `raw_responses` row, in SELECT * column order. */
interface StoredRawResponse {
  readonly run_id: number;
  readonly account_id: string;
  readonly captured_at: number;
  readonly http_status: number | null;
  readonly content_type: string | null;
  readonly body: string;
  readonly run_outcome: string;
}

/** All `raw_responses` rows, ordered for deterministic assertions. */
function allRawResponses(database: DatabaseSync): StoredRawResponse[] {
  return database
    .prepare('SELECT * FROM raw_responses ORDER BY account_id ASC, captured_at ASC, run_id ASC')
    .all() as unknown as StoredRawResponse[];
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

describe('raw_responses table (task 086, spec §7.4, §11.2, decision D-051)', () => {
  it('migrates a schema-5 database forward to up-to-date version 6', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('raw-responses-forward.sqlite');

      // §11.4's forward test from the previous supported schema: a database
      // at schema 5 — migrated by the task-085 canonical set (0001–0005);
      // every later migration is excluded, or 0006 would run ahead of the
      // version order the set defines.
      const schemaFiveSet = MIGRATIONS.filter(
        (migration) => migration.name !== '0006-raw-responses',
      );
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: schemaFiveSet,
      }).up();
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 6,
        appliedVersion: 5,
        relation: 'behind',
        newerThanSupported: [],
      });

      // The one new migration completes it.
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 + 1),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual(['0006-raw-responses']);
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
        { name: '0004-metric-values', applied_at: T0 },
        { name: '0005-quota-events', applied_at: T0 },
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

  it('pins the exact column set: STRICT types, no defaults, the retention and UNIQUE indexes', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('raw-responses-columns.sqlite');
      const db = await openRawResponsesDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(raw_responses)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list plus the two FK carriers exactly: names,
      // declared types (STRICT makes them per-value), and required columns
      // — the HTTP status and content type are the nullable evidence.
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
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'raw_responses'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      // The retention index and the run_id UNIQUE autoindex — and nothing
      // else. `index_list` reports reverse-creation order, so sort for the
      // pin.
      const indexes = reader.prepare('PRAGMA index_list(raw_responses)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_INDEXES);

      // This migration adds no new parent key: the task-083
      // `collection_runs_account_id_outcome` index the parse-error linkage
      // references is already there (verified count — no drift).
      const runIndexes = reader.prepare('PRAGMA index_list(collection_runs)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      expect(runIndexes).toHaveLength(3); // account_start, account_outcome_start, account_id_outcome
      reader.close();
    });
  });

  it('stores one sanitized payload per parse-error run with the body round-tripping exactly', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-happy.sqlite'));

      insertRawResponse(db, rawResponse());

      // A later parse-error run of the same account, and another account's.
      const secondRun = insertRun(db, 'work', 'parse_error');
      insertRawResponse(
        db,
        rawResponse({
          runId: secondRun,
          capturedAt: T0 + 301_000,
          httpStatus: null,
          contentType: null,
          body: '',
        }),
      );
      insertAccount(db, 'personal');
      const personalRun = insertRun(db, 'personal', 'parse_error', 502);
      insertRawResponse(
        db,
        rawResponse({
          runId: personalRun,
          accountId: 'personal',
          capturedAt: T0 + 2_400,
          httpStatus: 502,
          body: '<html>interleaved error page</html>',
        }),
      );

      const rows = allRawResponses(db);
      expect(rows).toHaveLength(3);
      // The base row stores every column exactly as INSERTed — the
      // multibyte body byte-faithful.
      expect(rows[1]).toEqual({
        run_id: 1,
        account_id: 'work',
        captured_at: T0 + 1_200,
        http_status: 200,
        content_type: 'application/json',
        body: SANITIZED_BODY,
        run_outcome: 'parse_error',
      });
      // The empty body is storable: an empty response is itself a parse
      // failure, and absent evidence columns survive as NULL.
      expect(rows[2]).toEqual({
        run_id: secondRun,
        account_id: 'work',
        captured_at: T0 + 301_000,
        http_status: null,
        content_type: null,
        body: '',
        run_outcome: 'parse_error',
      });
      // Ordering by account/time is deterministic across accounts.
      expect(rows.map((row) => [row.account_id, row.captured_at])).toEqual([
        ['personal', T0 + 2_400],
        ['work', T0 + 1_200],
        ['work', T0 + 301_000],
      ]);
      db.close();
    });
  });

  it('cannot store a second raw record for one run — the done-condition, structurally', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-unique.sqlite'));
      insertRawResponse(db, rawResponse());

      // The same run again — even with a different payload and captured-at —
      // fails the run_id UNIQUE constraint: §11.2's "one per run" is the
      // schema, not the writer's discipline.
      expect(() =>
        insertRawResponse(
          db,
          rawResponse({ capturedAt: T0 + 9_999, body: '{"code": 200, "data": {}}' }),
        ),
      ).toThrow(/UNIQUE constraint failed: raw_responses\.run_id/);

      expect(allRawResponses(db)).toHaveLength(1);
      db.close();
    });
  });

  it('rejects raw records for every non-parse outcome — a success run can never have one', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-outcome.sqlite'));

      // §7.4: "store a provider response only when parsing/schema
      // validation fails". The composite FK over the run's outcome admits
      // exactly `parse_error` — success and every other §7.2 failure class
      // (auth, rate-limit, network, timeout, server) are unrepresentable,
      // whichever carrier value the writer tries.
      for (const outcome of [
        'success',
        'auth_error',
        'rate_limited',
        'network_error',
        'timeout',
        'server_error',
      ]) {
        const runId = insertRun(db, 'work', outcome);
        expect(() => insertRawResponse(db, rawResponse({ runId })), `outcome '${outcome}'`).toThrow(
          /FOREIGN KEY constraint failed/,
        );
      }

      // Forging the carrier does not help: the CHECK pins it to exactly
      // 'parse_error', and the one carrier the CHECK permits against the
      // non-parse runs of the loop above still fails the FK.
      expect(() =>
        insertRawResponse(db, rawResponse({ runId: 1, runOutcome: 'parse_error'.toUpperCase() })),
      ).toThrow(/CHECK constraint failed: raw_responses_parse_error_only/);

      expect(allRawResponses(db)).toEqual([]);
      db.close();
    });
  });

  it('pins the record to the run it cites, and freezes the run against outcome rewrites', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-fk.sqlite'));

      // A run id nothing recorded.
      expect(() => insertRawResponse(db, rawResponse({ runId: 999 }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // A parse-error run of another account: the composite FK matches
      // (account, run, outcome) as one key, so a payload can never be filed
      // under an account whose run it was not.
      insertAccount(db, 'other');
      const otherRun = insertRun(db, 'other', 'parse_error');
      expect(() =>
        insertRawResponse(db, rawResponse({ runId: otherRun, accountId: 'work' })),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // The honest rows — each account's own run — pass.
      insertRawResponse(db, rawResponse());
      insertRawResponse(
        db,
        rawResponse({ runId: otherRun, accountId: 'other', capturedAt: T0 + 1_300 }),
      );
      expect(allRawResponses(db)).toHaveLength(2);

      // Child-side UPDATE path: re-filing a stored payload under another
      // account fails the same composite FK — the pinning holds on writes.
      expect(() =>
        db.prepare('UPDATE raw_responses SET account_id = ? WHERE run_id = ?').run('other', 1),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Parent-side: rewriting the referenced run into any other outcome
      // would orphan the composite FK — the NO ACTION default rejects it,
      // so a run whose payload was kept cannot be reclassified after the
      // fact. (`auth_error` isolates the FK: a `success` rewrite would
      // first trip `collection_runs_success_clean` on this fixture's
      // error_message, masking the freeze with an unrelated constraint.)
      expect(() =>
        db.prepare('UPDATE collection_runs SET outcome = ? WHERE id = ?').run('auth_error', 1),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Unrelated columns of the same run stay writable.
      db.prepare('UPDATE collection_runs SET attempts = ? WHERE id = ?').run(3, 1);
      expect(allRawResponses(db)).toHaveLength(2);
      db.close();
    });
  });

  it('enforces the D-041 byte cap: at-cap passes, over is rejected, bytes not characters', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-size.sqlite'));

      // Exactly the cap — the D-041 sanitizer can emit exactly 65536 bytes
      // (marker included) — is storable in both ASCII and multibyte.
      insertRawResponse(db, rawResponse({ body: 'x'.repeat(65_536) }));
      const multiRun = insertRun(db, 'work', 'parse_error');
      insertRawResponse(
        db,
        rawResponse({ runId: multiRun, capturedAt: T0 + 2_000, body: '😀'.repeat(16_384) }),
      );
      expect(allRawResponses(db)).toHaveLength(2);

      // One byte over — rejected by name.
      const overRun = insertRun(db, 'work', 'parse_error');
      expect(() =>
        insertRawResponse(
          db,
          rawResponse({ runId: overRun, capturedAt: T0 + 3_000, body: 'x'.repeat(65_537) }),
        ),
      ).toThrow(/CHECK constraint failed: raw_responses_body_size/);
      expect(() =>
        insertRawResponse(
          db,
          rawResponse({ runId: overRun, capturedAt: T0 + 3_000, body: '😀'.repeat(16_385) }),
        ),
      ).toThrow(/CHECK constraint failed: raw_responses_body_size/);

      // The bytes-not-characters pin: 30 000 characters of 3-byte text is
      // 90 000 bytes — far under the cap as `length()` counts characters,
      // far over as UTF-8. A character-based CHECK would store it.
      expect(() =>
        insertRawResponse(
          db,
          rawResponse({ runId: overRun, capturedAt: T0 + 3_000, body: '€'.repeat(30_000) }),
        ),
      ).toThrow(/CHECK constraint failed: raw_responses_body_size/);

      // And the NUL-bearing pin: `length()` stops at the embedded NUL (it
      // would count 100 characters, well under the cap) while
      // `octet_length()` counts all 65 601 bytes — over. A NUL-blind bound
      // would store this body.
      expect(() =>
        insertRawResponse(
          db,
          rawResponse({
            runId: overRun,
            capturedAt: T0 + 3_000,
            body: 'x'.repeat(100) + '\0' + 'x'.repeat(65_500),
          }),
        ),
      ).toThrow(/CHECK constraint failed: raw_responses_body_size/);

      expect(allRawResponses(db)).toHaveLength(2);
      db.close();
    });
  });

  it('keeps the SQL bound aligned with the D-041 sanitizer cap', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('raw-responses-drift.sqlite');
      const db = await openRawResponsesDatabase(dbPath);
      db.close();

      // The layout DAG forbids storage importing providers, so the cap is
      // re-declared in `migrations.ts` — this drift test is what keeps the
      // twin constants one contract: a D-041 change without a successor
      // migration fails here instead of silently diverging.
      expect(RAW_RESPONSE_MAX_PAYLOAD_BYTES).toBe(MAX_PAYLOAD_BYTES);

      // And the shipped schema carries the bound: the on-disk CHECK carries
      // the numeric literal the migrated database actually enforces. The
      // literal is hardcoded here on purpose — interpolating the constant
      // would let a coordinated change of both constants pass CI while
      // already-migrated databases keep enforcing the old bound; moving the
      // pinned number must require touching this test, as part of the
      // successor migration a cap change needs.
      const reader = new DatabaseSync(dbPath);
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'raw_responses'")
        .get() as { sql: string };
      expect(created.sql).toContain('octet_length(body) <= 65536');
      reader.close();
    });
  });

  it('rejects account ids outside the D-014 charset and malformed evidence columns', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-bad-values.sqlite'));

      // The same boundaries as accounts, runs, snapshots, metrics, and
      // events (D-032/D-034/D-036/D-039/D-046): raw rows may only key on
      // ids the accounts table can hold.
      const badIds = [
        '', // empty
        '-lead', // leading '-' — the first character must be alphanumeric
        'sp ace', // spaces anywhere
        `${'a'.repeat(64)}x`, // 65 characters — one past the bound
        'a\0b', // embedded NUL: GLOB/length stop at NUL, the stored bytes do not
      ];
      for (const accountId of badIds) {
        expect(
          () => insertRawResponse(db, rawResponse({ accountId })),
          `id '${accountId}'`,
        ).toThrow(/CHECK constraint failed: raw_responses_account_charset/);
      }

      // Evidence shapes: HTTP status NULL or a real 100–599 (D-034's
      // range), content type absent-or-non-blank.
      for (const httpStatus of [99, 600]) {
        expect(() => insertRawResponse(db, rawResponse({ httpStatus })), `${httpStatus}`).toThrow(
          /CHECK constraint failed: raw_responses_http_status_range/,
        );
      }
      expect(() => insertRawResponse(db, rawResponse({ contentType: '' }))).toThrow(
        /CHECK constraint failed: raw_responses_content_type_nonempty/,
      );

      expect(allRawResponses(db)).toEqual([]);
      db.close();
    });
  });

  it('rejects NULL in every required column; the evidence columns stay optional', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-required.sqlite'));

      // §11.2's row: the run reference, timestamp, body, and both FK
      // carriers are required; HTTP status and content type are the spec's
      // optional evidence.
      const nullRejections: Array<[Partial<RawResponseRow>, RegExp]> = [
        [{ runId: null }, /NOT NULL constraint failed: raw_responses.run_id/],
        [{ accountId: null }, /NOT NULL constraint failed: raw_responses.account_id/],
        [{ capturedAt: null }, /NOT NULL constraint failed: raw_responses.captured_at/],
        [{ body: null }, /NOT NULL constraint failed: raw_responses.body/],
        [{ runOutcome: null }, /NOT NULL constraint failed: raw_responses.run_outcome/],
      ];
      for (const [overrides, pattern] of nullRejections) {
        expect(() => insertRawResponse(db, rawResponse(overrides))).toThrow(pattern);
      }

      insertRawResponse(db, rawResponse({ httpStatus: null, contentType: null }));
      expect(allRawResponses(db)).toHaveLength(1);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-strict.sqlite'));

      // §11.2 "strict tables where feasible", per value: blobs cannot enter
      // TEXT columns, text cannot enter the INTEGER columns.
      expect(() =>
        insertRawResponseValues(
          db,
          1,
          new Uint8Array([0x77]),
          T0 + 1_200,
          200,
          'a',
          '{}',
          'parse_error',
        ),
      ).toThrow(/cannot store BLOB value in TEXT column raw_responses.account_id/);
      expect(() =>
        insertRawResponseValues(db, 1, 'work', 'now', 200, 'a', '{}', 'parse_error'),
      ).toThrow(/cannot store TEXT value in INTEGER column raw_responses.captured_at/);
      expect(() =>
        insertRawResponseValues(db, 1, 'work', T0 + 1_200, 'ok', 'a', '{}', 'parse_error'),
      ).toThrow(/cannot store TEXT value in INTEGER column raw_responses.http_status/);
      expect(() =>
        insertRawResponseValues(
          db,
          1,
          'work',
          T0 + 1_200,
          200,
          new Uint8Array([0x61]),
          '{}',
          'parse_error',
        ),
      ).toThrow(/cannot store BLOB value in TEXT column raw_responses.content_type/);
      expect(() =>
        insertRawResponseValues(
          db,
          1,
          'work',
          T0 + 1_200,
          200,
          'a',
          new Uint8Array([0x7b]),
          'parse_error',
        ),
      ).toThrow(/cannot store BLOB value in TEXT column raw_responses.body/);

      expect(allRawResponses(db)).toEqual([]);
      db.close();
    });
  });

  it('serves task 103 retention scans from the named index', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-indexes.sqlite'));

      // A small parse-failure history: five kept payloads for `work` at
      // staggered times, one for `other` — enough for both §7.4 policy
      // scans (20 newest per account; 30-day expiry).
      const times = [T0, T0 + 300_000, T0 + 600_000, T0 + 900_000, T0 + 1_200_000];
      for (const [index, at] of times.entries()) {
        const runId = insertRun(db, 'work', 'parse_error');
        insertRawResponse(
          db,
          rawResponse({ runId, capturedAt: at + 1_200, body: `{"seq": ${index}}` }),
        );
      }
      insertAccount(db, 'other');
      const otherRun = insertRun(db, 'other', 'parse_error');
      insertRawResponse(
        db,
        rawResponse({ runId: otherRun, accountId: 'other', capturedAt: T0 + 5_000 }),
      );

      // The per-account 20-record cap scan: newest first, bounded —
      // searched and ordered through the named index, no temp sort.
      const newest = queryPlan(
        db,
        'SELECT run_id, captured_at FROM raw_responses WHERE account_id = ? ORDER BY captured_at DESC LIMIT 20',
        'work',
      );
      expect(newest).toMatch(/USING (COVERING )?INDEX raw_responses_account_time/);
      expect(newest).not.toContain('TEMP B-TREE');

      // The 30-day expiry scan: an account's payloads older than a bound —
      // an index range scan.
      const expired = queryPlan(
        db,
        'SELECT run_id FROM raw_responses WHERE account_id = ? AND captured_at < ?',
        'work',
        T0 + 450_000,
      );
      expect(expired).toMatch(/USING (COVERING )?INDEX raw_responses_account_time/);

      // The account-only prefix serves the unbounded timeline scan (the
      // doctor --raw listing shape, task 103).
      const accountOnly = queryPlan(
        db,
        'SELECT captured_at FROM raw_responses WHERE account_id = ?',
        'work',
      );
      expect(accountOnly).toMatch(/USING (COVERING )?INDEX raw_responses_account_time/);

      // And the scans return the right rows — the cap keeps the newest 20,
      // the expiry window the old ones only.
      const keepList = db
        .prepare(
          'SELECT run_id FROM raw_responses WHERE account_id = ? ORDER BY captured_at DESC LIMIT 20',
        )
        .all('work') as Array<{ run_id: number }>;
      expect(keepList).toHaveLength(5);
      const expiredList = db
        .prepare('SELECT run_id FROM raw_responses WHERE account_id = ? AND captured_at < ?')
        .all('work', T0 + 450_000) as Array<{ run_id: number }>;
      expect(expiredList).toHaveLength(2);
      db.close();
    });
  });

  it('cascades: run deletion removes its payload, account purge removes all, archive retains', async () => {
    await withTempDir(async (dir) => {
      const db = await openRawResponsesDatabase(dir.sqlitePath('raw-responses-cascade.sqlite'));
      insertAccount(db, 'other');
      const otherRun = insertRun(db, 'other', 'parse_error');
      insertRawResponse(db, rawResponse()); // work, run 1
      insertRawResponse(
        db,
        rawResponse({ runId: otherRun, accountId: 'other', capturedAt: T0 + 1_300 }),
      );

      // §8.2 archive keeps history: archiving is an UPDATE, and both
      // accounts' payloads survive.
      db.prepare("UPDATE accounts SET status = 'archived', archived_at = ? WHERE id = 'work'").run(
        T0 + 10,
      );
      expect(allRawResponses(db)).toHaveLength(2);

      // Run-side cascade: deleting a run removes its payload — §11.3's
      // cleanup deletes expired runs, and payloads are older still.
      db.prepare('DELETE FROM collection_runs WHERE id = ?').run(1);
      expect(allRawResponses(db).map((row) => row.account_id)).toEqual(['other']);

      // Account-side purge (§8.2's separate explicit action): both FK paths
      // remove the account's payloads; the other account's stay.
      const workRun = insertRun(db, 'work', 'parse_error');
      insertRawResponse(db, rawResponse({ runId: workRun, capturedAt: T0 + 2_000 }));
      db.prepare("DELETE FROM accounts WHERE id = 'work'").run();
      expect(allRawResponses(db).map((row) => row.account_id)).toEqual(['other']);
      db.close();
    });
  });
});
