/**
 * The §15.2 session-creation half (task 154, decision D-123) — the session
 * twin of `password-hash.ts` (D-118/D-122) inside the future `AuthService`
 * the services README pins: that module owns the credential format, this
 * one owns the cookie token's minting and its storage-only-as-a-digest
 * discipline. Spec §15.2: "Use a random 256-bit session token in a cookie
 * … Store only SHA-256 of the token in SQLite. Sessions expire after 7
 * days of inactivity and no later than 30 days after creation." Spec
 * §11.2's row: "hash of the session token, created/last-seen/expiry
 * times; never store the raw cookie token."
 *
 * Everything on the persistence side already exists — task 087's
 * `sessions` table (D-056: the hex-shape `token_hash` CHECK, the two
 * expiry CHECKs, the exported window constants) and task 088's repository
 * methods (`insertSession`, `getSession`, …, D-058). This module is the
 * writer those tasks deferred: it mints the token, reduces it to the
 * digest, and hands the repository the §11.2 row. Deliberately absent
 * here, each a later task's own scope: the login endpoint and the
 * request-side lookup/expiry enforcement (155), rate limiting (156), and
 * the cookie's wire attributes (157 — flags travel with the response, not
 * with the token the handler mints).
 *
 * Pinned interpretations (D-123):
 *
 * - **The wire form is base64url** — `randomBytes(32).toString('base64url')`,
 *   exactly 43 unpadded URL-safe characters. D-056 recorded the
 *   precondition: a lowercase-hex cookie encoding would be shape-identical
 *   to the SHA-256 digest, and no SQL constraint can tell the two apart;
 *   base64url keeps the raw token structurally distinguishable from
 *   everything the `sessions` table can store.
 * - **The digest is taken over the wire string** — the cookie value
 *   exactly as a request presents it, never over re-decoded bytes. The
 *   155 lookup path (`cookie value → hashSessionToken → getSession`) then
 *   has no decode step and no decode-failure arm, and the digest is the
 *   same `sha256(<string>).digest('hex')` shape task 087's schema tests
 *   pinned.
 * - **The effective expiry is single-sited** — `effectiveSessionExpiry`
 *   is the one home of D-056's formula `min(last_seen + 7 d, created +
 *   30 d)`, computed from the schema's own exported constants so the
 *   writer and the shipped CHECKs can never disagree. Creation passes
 *   `lastSeen = created` (the login that mints a session is its first
 *   sighting, D-056), so a fresh row expires at the 7-day inactivity
 *   bound — the tighter of the two at birth; task 155's sighting refresh
 *   reuses the same helper after `touchSession`.
 * - **The raw token is disclosed exactly once** — in `createSession`'s
 *   return value, to the caller that sets the cookie, and nowhere else:
 *   the module persists only the digest row, holds no logger (nothing to
 *   log the token through — §15.4's "never in logs" holds by
 *   construction, executably pinned by the no-logging test), and the
 *   docblock below is the drop-it-after-setting contract.
 * - **No collision retry.** The digest is the table's primary key, so a
 *   mint colliding with a stored session would surface as the
 *   repository's constraint failure — the per-pair collision
 *   probability of two independent 256-bit tokens is 2^-256 (the
 *   birthday bound sits near 2^128 mints for a ~50% risk), so a retry
 *   loop would be untestable dead code dressing up as robustness. The
 *   failure propagates to the login attempt like any other write
 *   failure (D-058: the named CHECKs are the write gate, and neither
 *   the repository nor this service re-validates them).
 */

import { createHash, randomBytes } from 'node:crypto';
import { SESSION_INACTIVITY_TIMEOUT_MS, SESSION_MAX_AGE_MS } from '../storage/migrations';
import type { QuotaRepository, SessionRecord } from '../storage/repository';

/**
 * The §15.2 token length in bytes — 256 bits of `node:crypto` randomness.
 * Frozen and exported so tests pin the entropy executably against the
 * module's own budget (a silent halving here would halve the session
 * token's security with no visible change in any output shape).
 */
export const SESSION_TOKEN_BYTES = 32;

/**
 * Mints one §15.2 session token — `SESSION_TOKEN_BYTES` random bytes in
 * the base64url wire form (43 characters: URL-safe, unpadded, and never
 * confusable with the digest's lowercase hex, per D-056's precondition —
 * the length alone keeps the two shapes distinct: 43 characters can
 * never be the digest's 64). Every call draws fresh OS randomness; two
 * calls returning the same string is the 2^-256 collision the schema's
 * primary key would reject.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Reduces a session token to exactly what §15.2 allows SQLite to hold:
 * the SHA-256 digest, hex-encoded — the 64-lowercase-hex shape the
 * `sessions_token_hash_hex` CHECK enforces (D-056). The input is the
 * **wire string** (the cookie value as presented), so the 155 lookup
 * path never decodes anything: `hashSessionToken(cookieValue)` is the
 * whole cookie→row key transform.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The effective session expiry at a sighting — D-056's formula, the
 * single site it lives: `min(lastSeen + 7 d, createdAt + 30 d)` over the
 * schema's own exported constants (§15.2's "expire after 7 days of
 * inactivity and no later than 30 days after creation"), so the value a
 * writer computes and the value the shipped CHECKs accept cannot drift.
 * Creation passes `lastSeenAtMs === createdAtMs`; task 155's refresh
 * passes the sighting time. Non-integer inputs — fractional or
 * non-finite — throw a `TypeError` naming the field: §11.1 timestamps
 * are integer UTC epoch milliseconds, the table's columns are STRICT
 * INTEGER, and the guard's whole point is the field-naming diagnosis a
 * fractional value would otherwise lose to SQLite's `cannot store REAL
 * value in INTEGER column` (the D-090 comparator family's fail-fast
 * discipline, extended to integrality).
 */
export function effectiveSessionExpiry(createdAtMs: number, lastSeenAtMs: number): number {
  requireEpochMilliseconds(createdAtMs, 'createdAtMs');
  requireEpochMilliseconds(lastSeenAtMs, 'lastSeenAtMs');
  return Math.min(lastSeenAtMs + SESSION_INACTIVITY_TIMEOUT_MS, createdAtMs + SESSION_MAX_AGE_MS);
}

function requireEpochMilliseconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `session timestamp '${field}' must be an integer epoch-milliseconds value, got ${value}`,
    );
  }
}

/** What {@link createSession} hands back — the token exactly once, plus the stored row. */
export interface SessionCreation {
  /**
   * The raw §15.2 cookie token in its base64url wire form. This field is
   * the token's **only** disclosure: set the cookie (task 157 owns the
   * flags), then let the value go — nothing else stores, logs, or echoes
   * it, and the row below carries only its digest.
   */
  readonly token: string;
  /** The stored `sessions` row — digest identity plus the three §11.2 times. */
  readonly session: SessionRecord;
}

/** Options for {@link createSession}. */
export interface CreateSessionOptions {
  /** The storage facade — the only sanctioned write path (D-058). */
  readonly repository: QuotaRepository;
  /**
   * The creation instant as UTC epoch milliseconds — the D-021 clock
   * seam, an explicit argument in the `deriveAccountStatus(input,
   * nowEpochMs)` house pattern: the composition root passes its injected
   * `Clock`'s reading, and task 155's fake-clock tests pass readings
   * directly. Stamps all three of the row's times (`last_seen_at` is
   * born equal to `created_at`, D-056's "login is the first sighting").
   */
  readonly now: number;
}

/**
 * Mints and persists one §15.2 session — the task-154 primitive the task
 * 155 login endpoint calls after `verifyPassword` succeeds: generate the
 * 256-bit token ({@link generateSessionToken}), reduce it to its digest
 * ({@link hashSessionToken}), insert the §11.2 row through the repository
 * (`created_at` and `last_seen_at` at `now`, `expires_at` at the tighter
 * of the two §15.2 bounds), and return the token with the stored record.
 *
 * Synchronous by inheritance from the repository's own contract (D-058:
 * the `node:sqlite` driver is sync, and a promise here would wrap
 * nothing). Repository failures — the named CHECKs of migration 0007
 * included — propagate unchanged; there is no retry and no swallow (see
 * the module header's no-collision-retry reading).
 */
export function createSession(options: CreateSessionOptions): SessionCreation {
  requireEpochMilliseconds(options.now, 'now');
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = options.now;
  const expiresAt = effectiveSessionExpiry(now, now);
  options.repository.insertSession({
    tokenHash,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  return {
    token,
    session: {
      tokenHash,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    },
  };
}
