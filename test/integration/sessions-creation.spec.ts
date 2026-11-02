import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  MIGRATIONS,
  SESSION_INACTIVITY_TIMEOUT_MS,
} from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { createSession, hashSessionToken } from '../../src/services/sessions';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 154's done-condition (spec §15.2, §11.2; decision D-123): "raw
 * tokens are not present in the DB" — verified executably against a real
 * migrated database by scanning **every cell of every table** for the
 * minted token (the §15.4 marker discipline: the one string that must
 * not exist anywhere in storage), positively pinning that the one
 * `sessions` row stores the SHA-256 digest with the §15.2 creation
 * timestamps (which is also the schema-acceptance proof — a row the
 * 087 CHECKs would reject never inserts), and pinning the §15.2 lookup
 * round-trip `getSession(hashSessionToken(token))` task 155's
 * authenticator performs. Conventions follow
 * `test/integration/repository.spec.ts` — disposable databases, the
 * canonical migrations, `PRAGMA foreign_keys = ON` matching the §11.1
 * production connection (task 079). The `node:sqlite`
 * ExperimentalWarning is expected here, as in every storage test
 * (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond creation instants. */
const T0 = 1_761_000_000_000;

/**
 * Runs `body` against a fresh repository over a fully migrated disposable
 * database with §11.1 foreign-key enforcement on — the
 * `repository.spec.ts` harness.
 */
async function withRepository(
  body: (repository: QuotaRepository, database: DatabaseSync) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    try {
      await body(repository, database);
    } finally {
      database.close();
    }
  });
}

/**
 * Every cell of every user table as a string — the whole-database view
 * the marker scan asserts over. Internal SQLite tables
 * (`sqlite_*` — the journal included) are skipped: they are engine
 * bookkeeping, not storage the application shapes.
 */
function allCellStrings(database: DatabaseSync): string[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as ReadonlyArray<{ readonly name: string }>;
  const cells: string[] = [];
  for (const { name } of tables) {
    if (name.startsWith('sqlite_')) {
      continue;
    }
    const rows = database.prepare(`SELECT * FROM "${name}"`).all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        cells.push(String(value));
      }
    }
  }
  return cells;
}

describe('createSession over the canonical schema', () => {
  it('stores only the digest — the raw token is absent from every cell of every table', async () => {
    await withRepository((repository, database) => {
      const creation = createSession({ repository, now: T0 });

      // The done-condition's negative half: the minted token (and its
      // digest-free byte forms) appear in no stored cell whatsoever.
      const cells = allCellStrings(database);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell).not.toContain(creation.token);
        expect(cell).not.toContain(Buffer.from(creation.token, 'base64url').toString('base64'));
        expect(cell).not.toContain(Buffer.from(creation.token, 'base64url').toString('hex'));
        expect(cell).not.toContain(Buffer.from(creation.token, 'base64url').toString('latin1'));
      }

      // The positive half: exactly one sessions row, and it is the
      // §11.2/§15.2 shape — digest identity, creation-stamped times,
      // the 7-day inactivity bound at birth (the tighter §15.2 bound,
      // D-056). Inserting it at all is the CHECK-acceptance proof.
      const rows = database
        .prepare('SELECT token_hash, created_at, last_seen_at, expires_at FROM sessions')
        .all() as unknown as ReadonlyArray<{
        readonly token_hash: string;
        readonly created_at: number;
        readonly last_seen_at: number;
        readonly expires_at: number;
      }>;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.token_hash).toBe(
        createHash('sha256').update(creation.token, 'utf8').digest('hex'),
      );
      expect(row.created_at).toBe(T0);
      expect(row.last_seen_at).toBe(T0);
      expect(row.expires_at).toBe(T0 + SESSION_INACTIVITY_TIMEOUT_MS);
    });
  });

  it('serves the §15.2 cookie lookup: digest of the token finds the row', async () => {
    await withRepository((repository) => {
      const creation = createSession({ repository, now: T0 });

      // The exact transform task 155's authenticator performs per
      // request: cookie value → digest → row, with no decode step.
      const record = repository.getSession(hashSessionToken(creation.token));
      expect(record).not.toBeNull();
      expect(record).toEqual(creation.session);

      // An unknown digest (no such cookie) answers null — the miss arm.
      expect(repository.getSession(hashSessionToken('no-such-cookie-token'))).toBeNull();
    });
  });

  it('mints independent sessions — distinct digests, distinct rows, both lookups resolve', async () => {
    await withRepository((repository, database) => {
      const first = createSession({ repository, now: T0 });
      const second = createSession({ repository, now: T0 + 5_000 });

      expect(first.token).not.toBe(second.token);
      expect(first.session.tokenHash).not.toBe(second.session.tokenHash);

      expect(repository.getSession(hashSessionToken(first.token))).toEqual(first.session);
      expect(repository.getSession(hashSessionToken(second.token))).toEqual(second.session);

      const count = database.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {
        readonly n: number;
      };
      expect(count.n).toBe(2);

      // The marker discipline holds with two tokens in storage.
      const cells = allCellStrings(database);
      for (const cell of cells) {
        expect(cell).not.toContain(first.token);
        expect(cell).not.toContain(second.token);
      }
    });
  });
});
