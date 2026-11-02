import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_INACTIVITY_TIMEOUT_MS, SESSION_MAX_AGE_MS } from '../../src/storage/migrations';
import type { NewSession, QuotaRepository } from '../../src/storage/repository';
import {
  createSession,
  effectiveSessionExpiry,
  generateSessionToken,
  hashSessionToken,
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
