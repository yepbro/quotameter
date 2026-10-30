import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  schemaVersionStatus,
  SESSION_INACTIVITY_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
} from '../../src/storage/migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 087's done-condition (spec §11.2, §15.2): schema tests verify that no
 * raw session token column exists — the exact pinned column set carries
 * only the §11.2 hash column, the credential-fragment pin keeps any
 * raw/cookie/secret column out of future migrations, and the hex-shape
 * CHECK makes `token_hash` incapable of holding the raw 256-bit cookie
 * token's wire forms (the one wire form no schema can exclude — a
 * lowercase-hex cookie encoding, shape-identical to the digest — is a
 * recorded task-154 precondition in D-056). The schema is exercised directly at the SQL level
 * (the typed repository is task 088; the session layer that mints and
 * refreshes rows is tasks 154–157) against disposable databases migrated
 * by the 078 runner with the canonical set (D-031/D-056). Rows are
 * inserted with `PRAGMA foreign_keys = ON`, matching the §11.1 connection
 * production uses (task 079); raw `DatabaseSync` handles default to
 * SQLite's off (D-034's pinned note for storage tests). The `node:sqlite`
 * ExperimentalWarning is expected here, as in every storage test
 * (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the row helpers. */
const T0 = 1_761_000_000_000;

/**
 * The exact column contract of `sessions` (D-056) — name, declared STRICT
 * type, and required flag. §11.2's row: the token hash plus the three
 * times. This is the done-condition's positive half: nothing beyond these
 * four columns can exist.
 */
const EXPECTED_SESSIONS_COLUMNS = [
  { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'last_seen_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
] as const;

/**
 * The exact column contract of `meta` (D-056): §11.2's "key/value" and
 * nothing else.
 */
const EXPECTED_META_COLUMNS = [
  { name: 'key', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
] as const;

/**
 * The indexes the two tables carry: the spec-named expiry index, and the
 * primary-key autoindexes that serve the token-hash and key lookups.
 */
const EXPECTED_SESSIONS_INDEXES = [
  { name: 'sessions_expiry', unique: 0, origin: 'c' },
  { name: 'sqlite_autoindex_sessions_1', unique: 1, origin: 'pk' },
] as const;

const EXPECTED_META_INDEXES = [
  { name: 'sqlite_autoindex_meta_1', unique: 1, origin: 'pk' },
] as const;

/**
 * Fragments no `sessions` column name may contain — §11.2's "never store
 * the raw cookie token" as an explicit structural check that survives
 * future column additions (the accounts D-032 precedent). `token_hash` —
 * the §11.2-named hash column — is the one permitted match; any other
 * token/cookie/secret/raw-named column breaks the done-condition.
 */
const FORBIDDEN_COLUMN_FRAGMENTS = [
  'key',
  'secret',
  'token',
  'cookie',
  'password',
  'credential',
  'raw',
] as const;

/**
 * A §15.2 digest of a fixture cookie token — exactly what task 154's writer
 * will store: `createHash('sha256').update(token).digest('hex')`.
 */
const BASE_TOKEN_HASH = createHash('sha256').update('fixture-session-token').digest('hex');

/** One `sessions` row exactly as INSERTed — every field explicit. */
interface SessionRow {
  readonly tokenHash: string | null;
  readonly createdAt: number | null;
  readonly lastSeenAt: number | null;
  readonly expiresAt: number | null;
}

/** A §15.2-shaped session: freshly created, never refreshed. */
function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    tokenHash: BASE_TOKEN_HASH,
    createdAt: T0,
    lastSeenAt: T0,
    // The effective expiry: min(created + 7 d, created + 30 d) — the
    // inactivity bound is the tighter one at creation.
    expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertSessionValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed session row. */
function insertSession(database: DatabaseSync, row: SessionRow): void {
  insertSessionValues(database, row.tokenHash, row.createdAt, row.lastSeenAt, row.expiresAt);
}

/** Raw INSERT for `meta` accepting anything the STRICT columns must reject. */
function insertMetaValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(...values);
}

/** One stored `sessions` row, in SELECT * column order. */
interface StoredSession {
  readonly token_hash: string;
  readonly created_at: number;
  readonly last_seen_at: number;
  readonly expires_at: number;
}

/** All `sessions` rows, ordered for deterministic assertions. */
function allSessions(database: DatabaseSync): StoredSession[] {
  return database
    .prepare('SELECT * FROM sessions ORDER BY token_hash ASC')
    .all() as unknown as StoredSession[];
}

/** All `meta` rows, ordered for deterministic assertions. */
function allMeta(database: DatabaseSync): Array<{ key: string; value: string }> {
  return database.prepare('SELECT * FROM meta ORDER BY key ASC').all() as unknown as Array<{
    key: string;
    value: string;
  }>;
}

/** Inserts one `accounts` row, for the not-account-bound proof. */
function insertAccount(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
       VALUES (?, 'zai-coding-plan', 'Work account', NULL, 'active', ?, NULL)`,
    )
    .run(id, T0);
}

/**
 * A migrated database ready for session/meta inserts: full canonical set
 * applied and the §11.1 foreign-keys setting switched on (079's connection
 * applies it in production; raw handles default to off).
 */
async function openSessionsDatabase(dbPath: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(dbPath);
  await createMigrationRunner({
    database,
    clock: createFixedClock(T0),
    migrations: MIGRATIONS,
  }).up();
  database.exec('PRAGMA foreign_keys = ON');
  return database;
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

describe('sessions and meta tables (task 087, spec §11.2, §15.2, decision D-056)', () => {
  it('migrates a schema-6 database forward to up-to-date version 7', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('sessions-meta-forward.sqlite');

      // §11.4's forward test from the previous supported schema: a database
      // at schema 6 — migrated by the task-086 canonical set (0001–0006);
      // the new migration is excluded, or 0007 would run ahead of the
      // version order the set defines.
      const schemaSixSet = MIGRATIONS.filter(
        (migration) => migration.name !== '0007-sessions-meta',
      );
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: schemaSixSet,
      }).up();
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 7,
        appliedVersion: 6,
        relation: 'behind',
        newerThanSupported: [],
      });

      // The one new migration completes it — and completes §11.2's table
      // list.
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 + 1),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual(['0007-sessions-meta']);
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 7,
        appliedVersion: 7,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      db.close();

      // Journal proven through an independent connection: all seven entries
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
        { name: '0006-raw-responses', applied_at: T0 },
        { name: '0007-sessions-meta', applied_at: T0 + 1 },
      ]);
      // Both tables landed with the migration.
      const tables = reader
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toContain('sessions');
      expect(tables.map((table) => table.name)).toContain('meta');
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

  it('pins the exact session column set: no raw session token column exists — the done-condition', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('sessions-columns.sqlite');
      const db = await openSessionsDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(sessions)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list exactly: the token hash plus the three times —
      // names, declared types (STRICT makes them per-value), all required,
      // and the digest as the single identity.
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_SESSIONS_COLUMNS,
      );

      // No SQL-side defaults: every value is writer-supplied (D-021 supplies
      // clock timestamps) — never a database time function or generated value.
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );

      // §11.2 "never store the raw cookie token" as an explicit structural
      // check that survives future column additions: `token_hash` — the
      // §11.2-named hash column — is the ONLY column whose name carries any
      // token/credential vocabulary. A raw-token, cookie, or secret column
      // cannot be added by a later migration without breaking this test.
      const suspicious = info
        .map((column) => column.name.toLowerCase())
        .filter((name) => FORBIDDEN_COLUMN_FRAGMENTS.some((fragment) => name.includes(fragment)));
      expect(suspicious).toEqual(['token_hash']);

      // §11.2 "strict tables where feasible": the declaration carries STRICT
      // (the per-value enforcement is pinned by the test below).
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      // The shipped CHECKs pin §15.2's durations and the digest shape. The
      // numbers are hardcoded here on purpose — interpolating the constants
      // would let a coordinated change of both sides pass CI while
      // already-migrated databases keep enforcing the old bounds; moving a
      // pinned number must require touching this test, as part of the
      // successor migration a duration change needs (the D-051 drift-pin
      // precedent).
      expect(created.sql).toContain('length(token_hash) = 64');
      expect(created.sql).toContain('expires_at <= created_at + 2592000000');
      expect(created.sql).toContain('expires_at <= last_seen_at + 604800000');

      // The expiry index and the primary-key autoindex — and nothing else.
      // `index_list` reports reverse-creation order, so sort for the pin.
      const indexes = reader.prepare('PRAGMA index_list(sessions)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_SESSIONS_INDEXES);
      reader.close();
    });
  });

  it('stores the SHA-256 digest of a session token, round-tripping exactly', async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-happy.sqlite'));

      insertSession(db, session());

      // A refreshed session (task 155's write shape): seen again at
      // T0 + 10 d, its effective expiry becomes min(T0 + 17 d, T0 + 30 d).
      const refreshedHash = createHash('sha256').update('fixture-refreshed-token').digest('hex');
      insertSession(
        db,
        session({
          tokenHash: refreshedHash,
          lastSeenAt: T0 + 10 * 86_400_000,
          expiresAt: T0 + 10 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        }),
      );

      expect(allSessions(db)).toEqual([
        {
          token_hash: BASE_TOKEN_HASH,
          created_at: T0,
          last_seen_at: T0,
          expires_at: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
        },
        {
          token_hash: refreshedHash,
          created_at: T0,
          last_seen_at: T0 + 10 * 86_400_000,
          expires_at: T0 + 10 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        },
      ]);
      db.close();
    });
  });

  it("admits only the SHA-256 hex digest shape — the raw token's wire forms cannot fit", async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-hash-shape.sqlite'));

      // Wrong length: 63 and 65 lowercase-hex characters.
      for (const hash of ['a'.repeat(63), 'a'.repeat(65)]) {
        expect(
          () => insertSession(db, session({ tokenHash: hash })),
          `${hash.length} characters`,
        ).toThrow(/CHECK constraint failed: sessions_token_hash_hex/);
      }

      // Uppercase hex: the encoding is case-sensitive, and `digest('hex')`
      // is lowercase.
      expect(() => insertSession(db, session({ tokenHash: 'A'.repeat(64) }))).toThrow(
        /CHECK constraint failed: sessions_token_hash_hex/,
      );

      // Characters outside the hex alphabet — including a raw 256-bit
      // cookie token's base64url wire form (43 characters, mixed case,
      // `-`/`_`).
      expect(() => insertSession(db, session({ tokenHash: 'g'.repeat(64) }))).toThrow(
        /CHECK constraint failed: sessions_token_hash_hex/,
      );
      expect(() =>
        insertSession(
          db,
          session({ tokenHash: 'AbCdEf0123456789-_AbCdEf0123456789-_AbCdEf01234' }),
        ),
      ).toThrow(/CHECK constraint failed: sessions_token_hash_hex/);

      // Embedded NUL: `length()` and GLOB stop at the NUL, so 64 visible
      // hex characters plus trailing bytes would pass every other clause —
      // the `instr` guard is what rejects it (the D-032 finding).
      expect(() =>
        insertSession(db, session({ tokenHash: 'a'.repeat(64) + '\0' + 'a'.repeat(8) })),
      ).toThrow(/CHECK constraint failed: sessions_token_hash_hex/);

      expect(allSessions(db)).toEqual([]);
      db.close();
    });
  });

  it("enforces §15.2's two expiry bounds: at-bound passes, one millisecond over is rejected", async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-expiry.sqlite'));

      // The absolute bound binds for a long-lived session: last seen at
      // T0 + 25 d, the effective expiry is the 30-day cap — stored at
      // equality, allowed (`<=`).
      const absoluteHash = createHash('sha256').update('fixture-absolute-token').digest('hex');
      insertSession(
        db,
        session({
          tokenHash: absoluteHash,
          lastSeenAt: T0 + 25 * 86_400_000,
          expiresAt: T0 + SESSION_MAX_AGE_MS,
        }),
      );

      // One millisecond past the 30-day cap — rejected by name, while the
      // inactivity bound alone would still allow it (last seen + 7 d =
      // T0 + 32 d): "no later than 30 days after creation".
      expect(() =>
        insertSession(
          db,
          session({
            tokenHash: createHash('sha256').update('fixture-over-absolute-token').digest('hex'),
            lastSeenAt: T0 + 25 * 86_400_000,
            expiresAt: T0 + SESSION_MAX_AGE_MS + 1,
          }),
        ),
      ).toThrow(/CHECK constraint failed: sessions_expiry_absolute/);

      // The inactivity bound binds for a stale session: never refreshed, the
      // effective expiry is creation + 7 d — stored at equality, allowed.
      insertSession(db, session());

      // One millisecond past the 7-day window is rejected while the absolute
      // bound alone would still allow it (T0 + 30 d): "expire after 7 days
      // of inactivity".
      expect(() =>
        insertSession(
          db,
          session({
            tokenHash: createHash('sha256').update('fixture-over-inactivity-token').digest('hex'),
            expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS + 1,
          }),
        ),
      ).toThrow(/CHECK constraint failed: sessions_expiry_inactivity/);

      // A refreshed row carries its own inactivity deadline: expiry past
      // last-seen + 7 d is rejected however far the creation lies below the
      // 30-day cap (T0 + 17 d + 1 ms is well inside it).
      expect(() =>
        insertSession(
          db,
          session({
            tokenHash: createHash('sha256').update('fixture-refreshed-over-token').digest('hex'),
            lastSeenAt: T0 + 10 * 86_400_000,
            expiresAt: T0 + 10 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS + 1,
          }),
        ),
      ).toThrow(/CHECK constraint failed: sessions_expiry_inactivity/);

      // The refresh path task 155 actually runs is an UPDATE, and SQLite
      // re-evaluates the row CHECKs on it: a coherent refresh (seen at
      // T0 + 2 d, expiry recomputed to the tighter bound T0 + 9 d) passes,
      // and the row lands with exactly the refreshed values.
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
        T0 + 2 * 86_400_000,
        T0 + 2 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        BASE_TOKEN_HASH,
      );
      expect(allSessions(db).find((row) => row.token_hash === BASE_TOKEN_HASH)?.expires_at).toBe(
        T0 + 2 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS,
      );

      // Pushing the expiry past the refreshed inactivity deadline on the
      // same UPDATE path is rejected by the same named constraint — the
      // bounds hold on writes, not just inserts.
      expect(() =>
        db
          .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
          .run(T0 + 2 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS + 1, BASE_TOKEN_HASH),
      ).toThrow(/CHECK constraint failed: sessions_expiry_inactivity/);

      // The two at-bound rows landed; only the over-bound attempts died.
      expect(allSessions(db)).toHaveLength(2);
      db.close();
    });
  });

  it('rejects NULL in every column and duplicate digests fail the primary key', async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-required.sqlite'));

      // §11.2's row is four required values: the hash identity and the
      // three times. The explicit NOT NULL on the TEXT primary key closes
      // the rowid-table quirk (D-032).
      const nullRejections: Array<[Partial<SessionRow>, RegExp]> = [
        [{ tokenHash: null }, /NOT NULL constraint failed: sessions.token_hash/],
        [{ createdAt: null }, /NOT NULL constraint failed: sessions.created_at/],
        [{ lastSeenAt: null }, /NOT NULL constraint failed: sessions.last_seen_at/],
        [{ expiresAt: null }, /NOT NULL constraint failed: sessions.expires_at/],
      ];
      for (const [overrides, pattern] of nullRejections) {
        expect(() => insertSession(db, session(overrides))).toThrow(pattern);
      }

      // One session per digest: a second row for the same token hash fails
      // the primary key, never silently replacing the first.
      insertSession(db, session());
      expect(() =>
        insertSession(
          db,
          session({
            lastSeenAt: T0 + 5_000,
            expiresAt: T0 + 5_000 + SESSION_INACTIVITY_TIMEOUT_MS,
          }),
        ),
      ).toThrow(/UNIQUE constraint failed: sessions.token_hash/);
      expect(allSessions(db)).toHaveLength(1);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-strict.sqlite'));

      // §11.2 "strict tables where feasible", per value: blobs cannot enter
      // the TEXT digest column, text cannot enter the INTEGER times.
      expect(() =>
        insertSessionValues(db, new Uint8Array([0x61]), T0, T0, T0 + SESSION_INACTIVITY_TIMEOUT_MS),
      ).toThrow(/cannot store BLOB value in TEXT column sessions.token_hash/);
      expect(() => insertSessionValues(db, BASE_TOKEN_HASH, 'now', T0, T0)).toThrow(
        /cannot store TEXT value in INTEGER column sessions.created_at/,
      );
      expect(() => insertSessionValues(db, BASE_TOKEN_HASH, T0, 'now', T0)).toThrow(
        /cannot store TEXT value in INTEGER column sessions.last_seen_at/,
      );
      expect(() => insertSessionValues(db, BASE_TOKEN_HASH, T0, T0, 'soon')).toThrow(
        /cannot store TEXT value in INTEGER column sessions.expires_at/,
      );

      expect(allSessions(db)).toEqual([]);
      db.close();
    });
  });

  it('serves token-hash lookup from the primary key and expiry cleanup from the named index', async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-indexes.sqlite'));

      // A small session inventory: one already expired, the fresh base row,
      // one refreshed into the future.
      insertSession(
        db,
        session({
          tokenHash: createHash('sha256').update('fixture-expired-token').digest('hex'),
          createdAt: T0 - 40 * 86_400_000,
          lastSeenAt: T0 - 40 * 86_400_000,
          expiresAt: T0 - 40 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        }),
      );
      insertSession(db, session());
      insertSession(
        db,
        session({
          tokenHash: createHash('sha256').update('fixture-refreshed-token').digest('hex'),
          lastSeenAt: T0 + 10 * 86_400_000,
          expiresAt: T0 + 10 * 86_400_000 + SESSION_INACTIVITY_TIMEOUT_MS,
        }),
      );

      // §15.2's lookup path — cookie token → digest → row — runs on the
      // primary-key autoindex.
      const lookup = queryPlan(db, 'SELECT * FROM sessions WHERE token_hash = ?', BASE_TOKEN_HASH);
      expect(lookup).toMatch(/USING INDEX sqlite_autoindex_sessions_1/);

      // §11.3's cleanup scan — "delete expired sessions" — is a range scan
      // over the spec-named expiry index.
      const expired = queryPlan(
        db,
        'SELECT token_hash FROM sessions WHERE expires_at < ?',
        T0 + 86_400_000,
      );
      expect(expired).toMatch(/USING (COVERING )?INDEX sessions_expiry/);

      // And the scans return the right rows: the expired row only.
      const expiredList = db
        .prepare('SELECT token_hash FROM sessions WHERE expires_at < ?')
        .all(T0 + 86_400_000) as Array<{ token_hash: string }>;
      expect(expiredList).toEqual([
        { token_hash: createHash('sha256').update('fixture-expired-token').digest('hex') },
      ]);
      db.close();
    });
  });

  it('keeps sessions and meta when an account is purged — service state, not account history', async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('sessions-unbound.sqlite'));
      insertAccount(db, 'work');
      insertSession(db, session());
      insertMetaValues(db, 'last_cleanup_at', String(T0));

      // §11.2's cascading deletion is for purged account history; §15.1's
      // one-user service state is not account-bound — with foreign keys
      // on, purging every account leaves both tables untouched.
      db.prepare('DELETE FROM accounts').run();
      expect(allSessions(db)).toHaveLength(1);
      expect(allMeta(db)).toEqual([{ key: 'last_cleanup_at', value: String(T0) }]);
      db.close();
    });
  });

  it('pins the exact meta column set and stores key/value service state per key', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('meta-columns.sqlite');
      const db = await openSessionsDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(meta)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's "key/value" exactly: the key identity and the value — no
      // timestamps or columns the spec does not list (the D-032 exact-set
      // rule).
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_META_COLUMNS,
      );
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      const indexes = reader.prepare('PRAGMA index_list(meta)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_META_INDEXES);
      reader.close();

      // The §11.3 cleanup metadata shape: task 091's rows land as plain
      // text values under keys it defines — any TEXT value is storable,
      // including the empty string (no shape CHECK: the D-039
      // identical-states rule).
      const writable = await openSessionsDatabase(dbPath);
      insertMetaValues(writable, 'last_cleanup_at', String(T0));
      insertMetaValues(writable, 'retention_days', '180');
      insertMetaValues(writable, 'pending_state', '');
      expect(allMeta(writable)).toEqual([
        { key: 'last_cleanup_at', value: String(T0) },
        { key: 'pending_state', value: '' },
        { key: 'retention_days', value: '180' },
      ]);

      // One row per key: a duplicate fails the primary key, and rewriting a
      // value is the UPDATE the daily cleanup refresh runs.
      expect(() => insertMetaValues(writable, 'last_cleanup_at', String(T0 + 86_400_000))).toThrow(
        /UNIQUE constraint failed: meta.key/,
      );
      writable
        .prepare('UPDATE meta SET value = ? WHERE key = ?')
        .run(String(T0 + 86_400_000), 'last_cleanup_at');
      expect(allMeta(writable)).toEqual([
        { key: 'last_cleanup_at', value: String(T0 + 86_400_000) },
        { key: 'pending_state', value: '' },
        { key: 'retention_days', value: '180' },
      ]);

      // Key lookups run on the primary-key autoindex.
      const lookup = queryPlan(writable, 'SELECT value FROM meta WHERE key = ?', 'retention_days');
      expect(lookup).toMatch(/USING INDEX sqlite_autoindex_meta_1/);
      writable.close();
    });
  });

  it('rejects blank keys and NULLs in meta; enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openSessionsDatabase(dir.sqlitePath('meta-bad-values.sqlite'));

      // The key is the identity: blank keys are unaddressable state.
      expect(() => insertMetaValues(db, '', 'orphaned')).toThrow(
        /CHECK constraint failed: meta_key_nonempty/,
      );

      // Both columns are required.
      expect(() => insertMetaValues(db, 'last_cleanup_at', null)).toThrow(
        /NOT NULL constraint failed: meta.value/,
      );
      expect(() => insertMetaValues(db, null, '1761000000000')).toThrow(
        /NOT NULL constraint failed: meta.key/,
      );

      // §11.2 "strict tables where feasible", per value.
      expect(() => insertMetaValues(db, new Uint8Array([0x6b]), 'v')).toThrow(
        /cannot store BLOB value in TEXT column meta.key/,
      );
      expect(() => insertMetaValues(db, 'last_cleanup_at', new Uint8Array([0x76]))).toThrow(
        /cannot store BLOB value in TEXT column meta.value/,
      );

      expect(allMeta(db)).toEqual([]);
      db.close();
    });
  });
});
