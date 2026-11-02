import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  MIGRATIONS,
  SESSION_INACTIVITY_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
} from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import {
  authenticateSession,
  createSession,
  hashSessionToken,
  revokeSession,
} from '../../src/services/sessions';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 155's done-condition (spec §15.2, §17.1 "session
 * expiry/revocation"; decision D-124): both expiry rules and the
 * revocation semantics enforced over the canonical schema, driven by
 * fake-clock instants through the D-021 seam — every `now` below is a
 * plain integer epoch-milliseconds argument, so the whole §15.2 table
 * (the 7-day inactivity rule, the 30-day absolute rule, the half-open
 * boundary, the sliding refresh, logout, password-change revocation)
 * runs deterministically with no timers and no real clock. The verdict
 * writes (`touchSession` refreshes) run against the real 087 CHECKs —
 * the same guarantee `sessions-creation.spec.ts` pins for inserts — and
 * the §15.4 marker discipline is repeated after refreshes: the raw
 * token stays absent from every cell of every table. Conventions follow
 * that suite: disposable migrated databases, `PRAGMA foreign_keys = ON`
 * matching the §11.1 production connection, and the expected
 * `node:sqlite` ExperimentalWarning (docs/agents/gotchas.md). The pure
 * verdict tables over the behavioral stub live in
 * `test/unit/sessions.spec.ts`.
 */

/** Deterministic §11.1 epoch-millisecond creation instants. */
const T0 = 1_761_000_000_000;

/** One day in epoch milliseconds — readable fake-clock deltas. */
const DAY_MS = 86_400_000;

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
 * the marker scan asserts over (the `sessions-creation.spec.ts`
 * helper, kept local so each suite stays self-contained).
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

describe('authenticateSession over the canonical schema', () => {
  it('slides the inactivity window day by day, then enforces the 30-day absolute rule over recent activity', async () => {
    await withRepository((repository) => {
      const creation = createSession({ repository, now: T0 });
      const tokenHash = creation.session.tokenHash;

      // Daily sightings for 29 days: every one valid, every one sliding
      // the 7-day window — until the 30-day cap pins the expiry at
      // `created + 30 d` (from day 23 on, sighting + 7 d outruns it).
      for (let day = 1; day <= 29; day += 1) {
        const verdict = authenticateSession({
          repository,
          token: creation.token,
          now: T0 + day * DAY_MS,
        });
        expect(verdict.verdict, `day ${day} must stay valid`).toBe('valid');
        if (verdict.verdict !== 'valid') {
          return;
        }
        expect(verdict.session.lastSeenAt).toBe(T0 + day * DAY_MS);
        expect(verdict.session.expiresAt).toBe(T0 + Math.min(day + 7, 30) * DAY_MS);
        // The stored row carries the refreshed sighting — the write the
        // 087 CHECKs gate, exercised once per day of the walk.
        expect(repository.getSession(tokenHash)).toEqual({
          tokenHash,
          createdAt: T0,
          lastSeenAt: T0 + day * DAY_MS,
          expiresAt: T0 + Math.min(day + 7, 30) * DAY_MS,
        });
      }

      // Day 30: the session was seen one day ago — well inside the
      // 7-day inactivity window — and is rejected anyway: the absolute
      // rule is the only one that can have fired.
      const verdict = authenticateSession({
        repository,
        token: creation.token,
        now: T0 + 30 * DAY_MS,
      });
      expect(verdict).toMatchObject({
        verdict: 'expired',
        rule: 'absolute',
        session: { lastSeenAt: T0 + 29 * DAY_MS },
      });
    });
  });

  it('enforces the 7-day inactivity rule alone — an idle session inside the absolute bound', async () => {
    await withRepository((repository) => {
      const creation = createSession({ repository, now: T0 });
      const tokenHash = creation.session.tokenHash;

      // Eight days of silence: past the 7-day inactivity bound, barely
      // a quarter of the absolute one — only the inactivity rule fits.
      const verdict = authenticateSession({
        repository,
        token: creation.token,
        now: T0 + 8 * DAY_MS,
      });

      expect(verdict).toMatchObject({ verdict: 'expired', rule: 'inactivity' });
      // The verdict never deletes (§11.3's cleanup owns that): the row
      // is still stored, exactly as the last sighting left it.
      expect(repository.getSession(tokenHash)).toEqual({
        tokenHash,
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
      });
    });
  });

  it('pins the half-open boundary: valid one ms before expires_at, expired at the instant', async () => {
    await withRepository((repository) => {
      // Live side of the boundary: a fresh session seen one ms before
      // its 7-day expiry — accepted, and the acceptance refreshes.
      const live = createSession({ repository, now: T0 });
      const boundary = T0 + SESSION_INACTIVITY_TIMEOUT_MS;
      expect(
        authenticateSession({ repository, token: live.token, now: boundary - 1 }).verdict,
      ).toBe('valid');
      const row = repository.getSession(hashSessionToken(live.token))!;
      expect(row.lastSeenAt).toBe(boundary - 1);
      expect(row.expiresAt).toBe(boundary - 1 + SESSION_INACTIVITY_TIMEOUT_MS);

      // Dead side: an identical fresh twin judged exactly at its expiry.
      const dead = createSession({ repository, now: T0 });
      expect(authenticateSession({ repository, token: dead.token, now: boundary })).toMatchObject({
        verdict: 'expired',
        rule: 'inactivity',
      });
      expect(repository.getSession(hashSessionToken(dead.token))?.lastSeenAt).toBe(T0);
    });
  });

  it('keeps the raw token absent from every cell across refresh writes', async () => {
    await withRepository((repository, database) => {
      const creation = createSession({ repository, now: T0 });
      for (const day of [1, 3, 6]) {
        expect(
          authenticateSession({ repository, token: creation.token, now: T0 + day * DAY_MS })
            .verdict,
          `day ${day}`,
        ).toBe('valid');
      }

      // The §15.4 marker discipline after the refresh path has written:
      // nothing storage holds contains the wire token, in any of the
      // byte forms the creation suite scans (base64, hex, latin1).
      const cells = allCellStrings(database);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell).not.toContain(creation.token);
        expect(cell).not.toContain(Buffer.from(creation.token, 'base64url').toString('base64'));
        expect(cell).not.toContain(Buffer.from(creation.token, 'base64url').toString('hex'));
        expect(cell).not.toContain(Buffer.from(creation.token, 'base64url').toString('latin1'));
      }
      // The one row is the digest with the slid window, under both caps.
      const row = repository.getSession(creation.session.tokenHash)!;
      expect(row.tokenHash).toBe(hashSessionToken(creation.token));
      expect(row.lastSeenAt).toBe(T0 + 6 * DAY_MS);
      expect(row.expiresAt).toBe(T0 + 13 * DAY_MS);
      expect(row.expiresAt).toBeLessThanOrEqual(row.createdAt + SESSION_MAX_AGE_MS);
      expect(row.expiresAt).toBeLessThanOrEqual(row.lastSeenAt + SESSION_INACTIVITY_TIMEOUT_MS);
    });
  });
});

describe('revocation over the canonical schema (task 155, §15.2)', () => {
  it('logout revokes exactly the named session', async () => {
    await withRepository((repository) => {
      const first = createSession({ repository, now: T0 });
      const second = createSession({ repository, now: T0 });

      expect(revokeSession({ repository, token: first.token })).toBe(true);

      // The revoked cookie authenticates nothing; the sibling is live.
      expect(authenticateSession({ repository, token: first.token, now: T0 + DAY_MS })).toEqual({
        verdict: 'unknown',
      });
      expect(
        authenticateSession({ repository, token: second.token, now: T0 + DAY_MS }).verdict,
      ).toBe('valid');

      // Logout is idempotent, and the digest row is gone.
      expect(revokeSession({ repository, token: first.token })).toBe(false);
      expect(repository.getSession(hashSessionToken(first.token))).toBeNull();
    });
  });

  it('password-change revocation — the facade delete task 144 wired — kills every session', async () => {
    await withRepository((repository) => {
      const first = createSession({ repository, now: T0 });
      const second = createSession({ repository, now: T0 });
      // Both verifiably live first: the revocation must be the
      // difference the verdicts see.
      expect(
        authenticateSession({ repository, token: first.token, now: T0 + DAY_MS }).verdict,
      ).toBe('valid');
      expect(
        authenticateSession({ repository, token: second.token, now: T0 + DAY_MS }).verdict,
      ).toBe('valid');

      // Exactly the call `revokeAllSessions` in src/cli/passwd.ts makes
      // (D-118): the verdict side must agree that nothing survives it.
      expect(repository.deleteAllSessions()).toBe(2);

      expect(authenticateSession({ repository, token: first.token, now: T0 + 2 * DAY_MS })).toEqual(
        { verdict: 'unknown' },
      );
      expect(
        authenticateSession({ repository, token: second.token, now: T0 + 2 * DAY_MS }),
      ).toEqual({ verdict: 'unknown' });
    });
  });
});
