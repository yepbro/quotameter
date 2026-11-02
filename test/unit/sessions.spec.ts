import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_INACTIVITY_TIMEOUT_MS, SESSION_MAX_AGE_MS } from '../../src/storage/migrations';
import type {
  NewSession,
  QuotaRepository,
  SessionRecord,
  SessionSighting,
} from '../../src/storage/repository';
import {
  authenticateSession,
  createSession,
  effectiveSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  revokeSession,
  SESSION_TOKEN_BYTES,
} from '../../src/services/sessions';

/**
 * Task 154's unit half (spec §15.2, §11.2; decision D-123): the pure
 * pieces of the session module — the 256-bit token's base64url wire
 * shape (D-056's never-hex precondition), the SHA-256 digest's shape and
 * known-answer behavior over the wire string, D-056's effective-expiry
 * formula on the schema's own exported constants, and the creation
 * contract over a capturing repository stub (the `events-cycle.spec.ts`
 * stand-in pattern): the inserted row carries exactly the §11.2 fields,
 * the raw token returns exactly once, non-integer clock readings fail
 * fast, repository failures propagate unchanged, and no console method
 * fires during creation — the executable §15.4/§16 half of "the module
 * holds no logger". The real-database half of the done-condition (the
 * stored row, and the whole-DB marker scan proving the raw token absent)
 * lives in `test/integration/sessions-creation.spec.ts`.
 *
 * Task 155's unit half (decision D-124) joins below: the request-side
 * verdict (`authenticateSession`) and the logout revocation
 * (`revokeSession`) over a behavioral repository stand-in — an
 * in-memory `sessions` table that applies `touchSession`/deletes like
 * the real facade, so the fake-clock expiry tables (both §15.2 rules,
 * the half-open boundary, the sliding refresh) and the revocation
 * matrix run without SQLite; the real-schema half (CHECK-accepted
 * refresh writes, the whole-DB marker scan after refreshes, the
 * password-change revocation through the facade's own
 * `deleteAllSessions`) lives in
 * `test/integration/sessions-authentication.spec.ts`.
 */

/** A deterministic §11.1 epoch-millisecond anchor for the timestamp tables. */
const T0 = 1_761_000_000_000;

/** One day in epoch milliseconds — readable expiry-table deltas. */
const DAY_MS = 86_400_000;

/**
 * A capturing stand-in for the facade — records every `insertSession`
 * argument, answers failures on demand, and serves nothing else (the
 * creation path touches exactly this one method).
 */
function capturingRepository(options: { readonly insertError?: Error } = {}): {
  readonly repository: QuotaRepository;
  /** Every `NewSession` the creation path wrote, in order. */
  readonly inserted: NewSession[];
} {
  const inserted: NewSession[] = [];
  const repository = {
    insertSession(session: NewSession): void {
      if (options.insertError !== undefined) {
        throw options.insertError;
      }
      inserted.push(session);
    },
  } as unknown as QuotaRepository;
  return { repository, inserted };
}

describe('generateSessionToken (§15.2 256-bit token)', () => {
  it('is 43 base64url characters — the wire form of exactly 32 bytes', () => {
    for (let index = 0; index < 100; index += 1) {
      const token = generateSessionToken();
      expect(token).toHaveLength(43);
      // URL-safe alphabet only: no '+', '/', or '=' padding can appear.
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
    }
  });

  it('can never be shape-identical to the stored digest — 43 chars vs 64', () => {
    // D-056's recorded precondition, pinned deterministically: a wire
    // form shape-identical to the digest (64 lowercase hex) is what the
    // hex CHECK could not tell apart from the identity column — and the
    // base64url encoding's 43 characters make that shape unreachable,
    // whatever bytes the mint draws (an all-hex-alphabet token is still
    // 43, never 64).
    for (let index = 0; index < 100; index += 1) {
      const token = generateSessionToken();
      expect(token).not.toMatch(/^[0-9a-f]{64}$/);
      expect(token).not.toBe(hashSessionToken(token));
    }
  });

  it('draws fresh randomness per call — every token distinct', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      tokens.add(generateSessionToken());
    }
    expect(tokens.size).toBe(1000);
  });
});

describe('hashSessionToken (§15.2 SHA-256-only storage)', () => {
  it('is the sha256 hex digest of the wire string — the known answer', () => {
    for (const value of ['fixture-session-token', '', 'ünïcode-✓-token', generateSessionToken()]) {
      expect(hashSessionToken(value)).toBe(
        createHash('sha256').update(value, 'utf8').digest('hex'),
      );
    }
  });

  it('has the 64-lowercase-hex shape the sessions_token_hash_hex CHECK enforces', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(hashSessionToken(generateSessionToken())).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('distinguishes distinct tokens — the lookup key cannot collide', () => {
    const digests = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      digests.add(hashSessionToken(generateSessionToken()));
    }
    expect(digests.size).toBe(200);
  });
});

describe('effectiveSessionExpiry (D-056 formula, single-sited)', () => {
  it('a fresh session expires at the 7-day inactivity bound — the tighter at birth', () => {
    expect(effectiveSessionExpiry(T0, T0)).toBe(T0 + SESSION_INACTIVITY_TIMEOUT_MS);
  });

  it('a mid-life sighting extends to sighting + 7 days while inside the absolute bound', () => {
    expect(effectiveSessionExpiry(T0, T0 + 10 * DAY_MS)).toBe(
      T0 + 10 * DAY_MS + SESSION_INACTIVITY_TIMEOUT_MS,
    );
  });

  it('the 30-day absolute bound clamps a late sighting', () => {
    // Sighting + 7 d would outrun creation + 30 d: the absolute rule wins.
    expect(effectiveSessionExpiry(T0, T0 + 25 * DAY_MS)).toBe(T0 + SESSION_MAX_AGE_MS);
  });

  it('a sighting exactly at the absolute boundary keeps the absolute expiry', () => {
    const atBoundary = T0 + SESSION_MAX_AGE_MS - SESSION_INACTIVITY_TIMEOUT_MS;
    expect(effectiveSessionExpiry(T0, atBoundary)).toBe(T0 + SESSION_MAX_AGE_MS);
  });

  it('rejects non-integer timestamps with a TypeError naming the field', () => {
    // §11.1 epoch milliseconds are integers; a fractional value would
    // otherwise reach the STRICT INTEGER column and die with SQLite's
    // opaque `cannot store REAL value` instead of this diagnosis.
    expect(() => effectiveSessionExpiry(Number.NaN, T0)).toThrowError(TypeError);
    expect(() => effectiveSessionExpiry(T0, Number.POSITIVE_INFINITY)).toThrowError(/lastSeenAtMs/);
    expect(() => effectiveSessionExpiry(Number.NaN, T0)).toThrowError(/createdAtMs/);
    expect(() => effectiveSessionExpiry(T0 + 0.5, T0)).toThrowError(/createdAtMs/);
    expect(() => effectiveSessionExpiry(T0, T0 + 0.25)).toThrowError(/lastSeenAtMs/);
  });
});

describe('createSession (task 154 primitive)', () => {
  it('persists exactly the §11.2 digest row and returns the raw token exactly once', () => {
    const { repository, inserted } = capturingRepository();

    const creation = createSession({ repository, now: T0 });

    // One write, digest identity, all three times from the seam.
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.tokenHash).toBe(hashSessionToken(creation.token));
    expect(row.createdAt).toBe(T0);
    // D-056: the login that mints a session is its first sighting.
    expect(row.lastSeenAt).toBe(T0);
    expect(row.expiresAt).toBe(T0 + SESSION_INACTIVITY_TIMEOUT_MS);
    // The returned record mirrors the row the caller can audit.
    expect(creation.session).toEqual({
      tokenHash: row.tokenHash,
      createdAt: T0,
      lastSeenAt: T0,
      expiresAt: row.expiresAt,
    });
  });

  it('mints a distinct token per creation — no session shares identity', () => {
    const { repository, inserted } = capturingRepository();
    const first = createSession({ repository, now: T0 });
    const second = createSession({ repository, now: T0 });
    expect(first.token).not.toBe(second.token);
    expect(inserted.map((row) => row.tokenHash)).toEqual([
      hashSessionToken(first.token),
      hashSessionToken(second.token),
    ]);
  });

  it('reads its timestamps from the injected clock seam', () => {
    const { repository, inserted } = capturingRepository();
    const later = T0 + 42 * DAY_MS;
    createSession({ repository, now: later });
    expect(inserted[0]?.createdAt).toBe(later);
    expect(inserted[0]?.lastSeenAt).toBe(later);
    expect(inserted[0]?.expiresAt).toBe(later + SESSION_INACTIVITY_TIMEOUT_MS);
  });

  it('propagates repository failures unchanged — no swallow, no retry', () => {
    const failure = new Error('CHECK constraint failed: sessions_token_hash_hex');
    const { repository, inserted } = capturingRepository({ insertError: failure });
    expect(() => createSession({ repository, now: T0 })).toThrowError(failure);
    // The failed attempt left nothing behind, not even a partial row.
    expect(inserted).toHaveLength(0);
  });

  it('rejects a non-integer clock reading before any token or row exists', () => {
    const { repository, inserted } = capturingRepository();
    expect(() => createSession({ repository, now: Number.NaN })).toThrowError(TypeError);
    expect(() => createSession({ repository, now: Number.NaN })).toThrowError(/now/);
    // Fractional epoch milliseconds are refused the same way — STRICT
    // INTEGER columns must never see them (§11.1).
    expect(() => createSession({ repository, now: T0 + 0.5 })).toThrowError(/now/);
    expect(inserted).toHaveLength(0);
  });

  it('writes nothing to the console — the module holds no logger (§15.4/§16)', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level as keyof Console).mockImplementation(() => {}),
    );
    try {
      const { repository } = capturingRepository();
      const creation = createSession({ repository, now: T0 });
      expect(creation.token).toHaveLength(43);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

/* ── Task 155 (D-124): the verdict and the revocation ─────────────────── */

/**
 * A behavioral stand-in for the session half of the facade — an
 * in-memory `token_hash → row` table that answers `getSession`,
 * applies `touchSession` (returning the facade's existed boolean), and
 * performs the deletes, plus call capture and on-demand failure arms.
 * The verdict path touches exactly these methods; everything else stays
 * absent like the creation stub's.
 */
function sessionStoreStub(options: { readonly touchReports?: boolean } = {}): {
  readonly repository: QuotaRepository;
  /** Seeds one canonical row and returns its wire token. */
  readonly seed: (row: {
    readonly createdAt: number;
    readonly lastSeenAt: number;
    readonly expiresAt?: number;
  }) => string;
  /** Every `touchSession` call, in order. */
  readonly touched: Array<{ readonly tokenHash: string } & SessionSighting>;
  /** Every digest handed to `deleteSession`, in order. */
  readonly deleted: string[];
  /** How many reads ran — the fail-fast guard's "no storage call" oracle. */
  readonly reads: () => number;
  readonly rows: () => Map<string, SessionRecord>;
} {
  const rows = new Map<string, SessionRecord>();
  const touched: Array<{ readonly tokenHash: string } & SessionSighting> = [];
  const deleted: string[] = [];
  let reads = 0;
  const repository = {
    getSession(tokenHash: string): SessionRecord | null {
      reads += 1;
      return rows.get(tokenHash) ?? null;
    },
    touchSession(tokenHash: string, sighting: SessionSighting): boolean {
      const row = rows.get(tokenHash);
      if (row === undefined) {
        return false;
      }
      if (options.touchReports !== undefined) {
        // The injected arm for the revocation-won-the-race verdict: the
        // row was there at the read, gone at the write.
        rows.delete(tokenHash);
        return options.touchReports;
      }
      rows.set(tokenHash, { ...row, ...sighting });
      touched.push({ tokenHash, ...sighting });
      return true;
    },
    deleteSession(tokenHash: string): boolean {
      deleted.push(tokenHash);
      return rows.delete(tokenHash);
    },
    deleteAllSessions(): number {
      const count = rows.size;
      rows.clear();
      return count;
    },
  } as unknown as QuotaRepository;
  return {
    repository,
    seed(row) {
      const token = generateSessionToken();
      const record: SessionRecord = {
        tokenHash: hashSessionToken(token),
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        // Canonical writer behavior when no explicit expiry is pinned:
        // D-056's formula over the seeded times.
        expiresAt: row.expiresAt ?? effectiveSessionExpiry(row.createdAt, row.lastSeenAt),
      };
      rows.set(record.tokenHash, record);
      return token;
    },
    touched,
    deleted,
    reads: () => reads,
    rows: () => rows,
  };
}

describe('authenticateSession (task 155 verdict, D-124)', () => {
  it('accepts a live session, records the sighting, and slides the inactivity window', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });

    const verdict = authenticateSession({
      repository: store.repository,
      token,
      now: T0 + 2 * DAY_MS,
    });

    expect(verdict).toEqual({
      verdict: 'valid',
      session: {
        tokenHash: hashSessionToken(token),
        createdAt: T0,
        lastSeenAt: T0 + 2 * DAY_MS,
        expiresAt: T0 + 2 * DAY_MS + SESSION_INACTIVITY_TIMEOUT_MS,
      },
    });
    // Exactly one refresh write, with the single-sited formula's values.
    expect(store.touched).toEqual([
      {
        tokenHash: hashSessionToken(token),
        lastSeenAt: T0 + 2 * DAY_MS,
        expiresAt: T0 + 2 * DAY_MS + SESSION_INACTIVITY_TIMEOUT_MS,
      },
    ]);
    expect(store.rows().get(hashSessionToken(token))?.lastSeenAt).toBe(T0 + 2 * DAY_MS);
  });

  it('never extends the absolute cap — a late sighting refreshes last_seen only', () => {
    const store = sessionStoreStub();
    // A canonical capped row: the 25-day sighting already clamped the
    // effective expiry to created + 30 d.
    const token = store.seed({
      createdAt: T0,
      lastSeenAt: T0 + 25 * DAY_MS,
      expiresAt: T0 + SESSION_MAX_AGE_MS,
    });

    const verdict = authenticateSession({
      repository: store.repository,
      token,
      now: T0 + 26 * DAY_MS,
    });

    expect(verdict.verdict).toBe('valid');
    if (verdict.verdict !== 'valid') {
      return;
    }
    expect(verdict.session.lastSeenAt).toBe(T0 + 26 * DAY_MS);
    // Sighting + 7 d would outrun the cap; the cap wins, again.
    expect(verdict.session.expiresAt).toBe(T0 + SESSION_MAX_AGE_MS);
  });

  it('enforces the 7-day inactivity rule alone — idle past the bound, absolute bound un-reached', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });

    const verdict = authenticateSession({
      repository: store.repository,
      token,
      now: T0 + 8 * DAY_MS,
    });

    // 8 days idle (> 7) while 8 < 30 days of age: only the inactivity
    // rule can have rejected it.
    expect(verdict.verdict).toBe('expired');
    if (verdict.verdict !== 'expired') {
      return;
    }
    expect(verdict.rule).toBe('inactivity');
    // The verdict never writes — no sighting was recorded for a dead row.
    expect(store.touched).toHaveLength(0);
    expect(store.rows().get(hashSessionToken(token))?.lastSeenAt).toBe(T0);
  });

  it('enforces the 30-day absolute rule over recent activity', () => {
    const store = sessionStoreStub();
    // Capped row with a sighting 5 days before the cap: the inactivity
    // bound (last_seen + 7 d) lies BEYOND the expiry — only the absolute
    // rule can have rejected the request.
    const token = store.seed({
      createdAt: T0,
      lastSeenAt: T0 + 25 * DAY_MS,
      expiresAt: T0 + SESSION_MAX_AGE_MS,
    });

    const verdict = authenticateSession({
      repository: store.repository,
      token,
      now: T0 + SESSION_MAX_AGE_MS,
    });

    expect(verdict.verdict).toBe('expired');
    if (verdict.verdict !== 'expired') {
      return;
    }
    expect(verdict.rule).toBe('absolute');
    expect(verdict.session.lastSeenAt).toBe(T0 + 25 * DAY_MS);
    expect(store.touched).toHaveLength(0);
  });

  it('pins the half-open boundary for both rules: valid one ms before, expired at the instant', () => {
    // Inactivity bound: fresh row, expiry = created + 7 d.
    const inactivityStore = sessionStoreStub();
    const idleToken = inactivityStore.seed({ createdAt: T0, lastSeenAt: T0 });
    const idleBoundary = T0 + SESSION_INACTIVITY_TIMEOUT_MS;
    expect(
      authenticateSession({
        repository: inactivityStore.repository,
        token: idleToken,
        now: idleBoundary - 1,
      }).verdict,
    ).toBe('valid');
    // A fresh twin for the dead side: the accepted sighting above just
    // moved the first row's window (the refresh is part of acceptance).
    const idleTokenDead = inactivityStore.seed({ createdAt: T0, lastSeenAt: T0 });
    expect(
      authenticateSession({
        repository: inactivityStore.repository,
        token: idleTokenDead,
        now: idleBoundary,
      }),
    ).toMatchObject({ verdict: 'expired', rule: 'inactivity' });

    // Absolute bound: capped row, expiry = created + 30 d.
    const absoluteStore = sessionStoreStub();
    const cappedToken = absoluteStore.seed({
      createdAt: T0,
      lastSeenAt: T0 + 25 * DAY_MS,
      expiresAt: T0 + SESSION_MAX_AGE_MS,
    });
    const cappedBoundary = T0 + SESSION_MAX_AGE_MS;
    expect(
      authenticateSession({
        repository: absoluteStore.repository,
        token: cappedToken,
        now: cappedBoundary - 1,
      }).verdict,
    ).toBe('valid');
    const cappedTokenDead = absoluteStore.seed({
      createdAt: T0,
      lastSeenAt: T0 + 25 * DAY_MS,
      expiresAt: T0 + SESSION_MAX_AGE_MS,
    });
    expect(
      authenticateSession({
        repository: absoluteStore.repository,
        token: cappedTokenDead,
        now: cappedBoundary,
      }),
    ).toMatchObject({ verdict: 'expired', rule: 'absolute' });
  });

  it('answers unknown for a token no row carries — fail closed on absence', () => {
    const store = sessionStoreStub();
    store.seed({ createdAt: T0, lastSeenAt: T0 });

    const verdict = authenticateSession({
      repository: store.repository,
      token: 'never-minted-wire-value',
      now: T0,
    });

    expect(verdict).toEqual({ verdict: 'unknown' });
    expect(store.touched).toHaveLength(0);
  });

  it('downgrades to unknown when the row vanishes at the refresh — revocation wins the race', () => {
    const store = sessionStoreStub({ touchReports: false });
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });

    const verdict = authenticateSession({ repository: store.repository, token, now: T0 + DAY_MS });

    // The passwd CLI revokes every session over its own connection
    // while the server runs, so the row can genuinely be gone between
    // the read and the write — and the composition must never
    // authenticate a sighting whose row is gone at the write.
    expect(verdict).toEqual({ verdict: 'unknown' });
    expect(store.touched).toHaveLength(0);
  });

  it('trusts a regressed clock reading — the verdict tests the upper endpoint alone', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });

    // A wall clock behind the row's own creation instant is accepted
    // (D-124: the validity test is `now < expires_at`; the interval's
    // lower endpoint names the canonical birth, not a second verdict
    // input) and the refresh only shrinks the expiry — fail-closed.
    const verdict = authenticateSession({
      repository: store.repository,
      token,
      now: T0 - DAY_MS,
    });

    expect(verdict.verdict).toBe('valid');
    if (verdict.verdict !== 'valid') {
      return;
    }
    expect(verdict.session.lastSeenAt).toBe(T0 - DAY_MS);
    expect(verdict.session.expiresAt).toBe(T0 - DAY_MS + SESSION_INACTIVITY_TIMEOUT_MS);
  });

  it('rejects a non-integer clock reading before any storage call', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });
    const readsBefore = store.reads();

    expect(() =>
      authenticateSession({ repository: store.repository, token, now: Number.NaN }),
    ).toThrowError(TypeError);
    expect(() =>
      authenticateSession({ repository: store.repository, token, now: T0 + 0.5 }),
    ).toThrowError(/now/);
    // §11.1's integer epoch milliseconds never reach a STRICT INTEGER
    // comparison or write — and no read even ran.
    expect(store.reads()).toBe(readsBefore);
    expect(store.touched).toHaveLength(0);
  });

  it('propagates repository failures unchanged — no swallow, no synthesis', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });
    const lookupFailure = new Error('database is locked');
    const refreshFailure = new Error('disk I/O error');
    const repository = {
      ...store.repository,
      getSession: () => {
        throw lookupFailure;
      },
    } as unknown as QuotaRepository;
    expect(() => authenticateSession({ repository, token, now: T0 })).toThrowError(lookupFailure);

    const failingTouch = {
      ...store.repository,
      touchSession: () => {
        throw refreshFailure;
      },
    } as unknown as QuotaRepository;
    expect(() =>
      authenticateSession({ repository: failingTouch, token, now: T0 + DAY_MS }),
    ).toThrowError(refreshFailure);
  });

  it('writes nothing to the console across the verdict — no logger to leak through', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level as keyof Console).mockImplementation(() => {}),
    );
    try {
      const live = sessionStoreStub();
      const liveToken = live.seed({ createdAt: T0, lastSeenAt: T0 });
      expect(
        authenticateSession({ repository: live.repository, token: liveToken, now: T0 }).verdict,
      ).toBe('valid');
      const dead = sessionStoreStub();
      const deadToken = dead.seed({ createdAt: T0, lastSeenAt: T0 });
      expect(
        authenticateSession({ repository: dead.repository, token: deadToken, now: T0 + 8 * DAY_MS })
          .verdict,
      ).toBe('expired');
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe('revokeSession (task 155 logout revocation, D-124)', () => {
  it('revokes exactly the named session, by digest — the raw token never reaches storage', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });

    expect(revokeSession({ repository: store.repository, token })).toBe(true);

    // The delete ran against the digest, and the row is gone.
    expect(store.deleted).toEqual([hashSessionToken(token)]);
    expect(store.rows().has(hashSessionToken(token))).toBe(false);
    // …and the verdict answers unknown for the revoked token.
    expect(authenticateSession({ repository: store.repository, token, now: T0 + DAY_MS })).toEqual({
      verdict: 'unknown',
    });
  });

  it('is idempotent — a second logout revokes nothing', () => {
    const store = sessionStoreStub();
    const token = store.seed({ createdAt: T0, lastSeenAt: T0 });
    expect(revokeSession({ repository: store.repository, token })).toBe(true);
    expect(revokeSession({ repository: store.repository, token })).toBe(false);
  });

  it('leaves sibling sessions untouched — one logout, one row', () => {
    const store = sessionStoreStub();
    const first = store.seed({ createdAt: T0, lastSeenAt: T0 });
    const second = store.seed({ createdAt: T0, lastSeenAt: T0 });

    expect(revokeSession({ repository: store.repository, token: first })).toBe(true);
    expect(
      authenticateSession({ repository: store.repository, token: second, now: T0 + DAY_MS })
        .verdict,
    ).toBe('valid');
  });

  it('treats the password-change revocation as the facade delete — every verdict turns unknown', () => {
    const store = sessionStoreStub();
    const first = store.seed({ createdAt: T0, lastSeenAt: T0 });
    const second = store.seed({ createdAt: T0, lastSeenAt: T0 });

    // The exact primitive task 144's `revokeAllSessions` (src/cli/passwd.ts)
    // runs — nothing session-shaped survives it, and the verdicts agree.
    expect(store.repository.deleteAllSessions()).toBe(2);
    expect(
      authenticateSession({ repository: store.repository, token: first, now: T0 + DAY_MS }),
    ).toEqual({ verdict: 'unknown' });
    expect(
      authenticateSession({ repository: store.repository, token: second, now: T0 + DAY_MS }),
    ).toEqual({ verdict: 'unknown' });
  });

  it('propagates a failing delete unchanged', () => {
    const store = sessionStoreStub();
    const failure = new Error('database is locked');
    const repository = {
      ...store.repository,
      deleteSession: () => {
        throw failure;
      },
    } as unknown as QuotaRepository;
    expect(() => revokeSession({ repository, token: 'any-wire-value' })).toThrowError(failure);
  });
});
