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
 * writer those tasks deferred and, since task 155, the per-request judge
 * over the same facade: it mints the token, reduces it to the digest,
 * hands the repository the §11.2 row — and, through
 * `authenticateSession`/`revokeSession` below, renders the §15.2 expiry
 * verdict with its sighting refresh, and the logout revocation.
 * Deliberately absent still, each a later task's own scope: the login
 * and logout endpoints (the cookie's consumers; no plan task owns them —
 * the gap D-125 recorded) — the cookie's wire attributes landed as their
 * own primitive, `src/services/session-cookie.ts` (157, D-126: flags
 * travel with the response, not with the token the handler mints); the
 * §15.2 login rate budget landed as its own module,
 * `src/services/login-rate-limit.ts` (156, D-125).
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
 *
 * Pinned interpretations (D-124, task 155):
 *
 * - **The validity test is `now < expires_at` — the upper endpoint of
 *   the half-open lifetime `[created_at, expires_at)`.** A request at
 *   exactly `expires_at` is expired; at `expires_at - 1` it is valid.
 *   "Expires at T" makes T the first dead instant (§15.2's "no later
 *   than 30 days after creation" composes the same way: the expiry
 *   lands at `created + 30 d` at the latest, and a session alive AT
 *   that instant would be alive later than the rule allows), and it is
 *   the reading under which every accepted sighting refreshes to a
 *   strictly future expiry — an inclusive boundary would let a sighting
 *   at exactly `created + 30 d` rewrite `expires_at = now`, a refresh
 *   to an already-dead expiry. The interval's lower endpoint names the
 *   canonical row's birth, not a second verdict input: a clock reading
 *   before `created_at` is the regressed-clock case the refresh bullet
 *   below pins. `deleteSessionsExpiredBefore` (strict `<`,
 *   D-056/D-061) still deletes only rows dead before `now`, so a
 *   boundary-dead row survives until the next §11.3 cleanup — storage
 *   hygiene lag only; the verdict is the gate.
 * - **Every valid sighting refreshes.** D-056's sighting seam
 *   (`touchSession`) runs on every accepted request: `last_seen_at`
 *   tracks the latest authenticated request exactly, with no threshold
 *   or dedup. A regressed clock reading is trusted like every other
 *   wall stamp in the codebase (D-021) — including one before
 *   `created_at`, which the verdict accepts (the test is the upper
 *   endpoint alone) and which can only shrink the expiry, the
 *   fail-closed direction.
 * - **The verdict never deletes.** An `expired` row is left for §11.3's
 *   cleanup (task 091, D-061): the verdict is read-plus-refresh, the
 *   cleanup owns expired-row deletion, and re-deleting here would be a
 *   second writer for a job the scheduler already does.
 * - **Revocation is deletion, `unknown` the only aftermath.** No
 *   tombstones and no revoked-vs-unknown distinction: storage cannot
 *   tell a never-existed digest from a deleted one, and the consumer's
 *   401 is identical. `revokeSession` (logout) digests the token and
 *   deletes the one row; password-change revocation lives in the two
 *   password-change paths, both over the facade's `deleteAllSessions`
 *   and both in the fail-secure order (revoke before the write, D-184 —
 *   `revokeAllSessions` in `src/cli/passwd.ts` over its own connection
 *   while the server runs, and the settings store's pre-mutation call
 *   in `src/server/config-stores.ts`) — a service wrapper that only
 *   forwarded one facade call would add a second name, no logic.
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
   * the token's **only** disclosure: set the cookie with the attribute
   * object `src/services/session-cookie.ts` computes (task 157, D-126),
   * then let the value go — nothing else stores, logs, or echoes
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

/* ── The request-side verdict and revocation (task 155, D-124) ────────── */

/** Which §15.2 bound a rejected session's own `expires_at` sits at. */
export type SessionExpiryRule =
  /** `expires_at = last_seen_at + 7 d` — the inactivity bound. */
  | 'inactivity'
  /** `expires_at = created_at + 30 d` — the absolute age bound. */
  | 'absolute';

/**
 * The verdict on one presented cookie token — the discriminated-union
 * shape of `classifyAuthMode`'s `AuthModeVerdict` (`src/server/api/auth.ts`),
 * the layer that will compose this behind its `RequestAuthenticator`
 * seam:
 *
 * - `valid` — the digest named a row whose `expires_at` is still
 *   ahead of `now` (D-124's half-open reading); the sighting was
 *   recorded, and `session` carries the refreshed record.
 * - `expired` — the row exists but `now >= expires_at`: §15.2 rejected
 *   it. `rule` names which bound the row's own `expires_at` equals —
 *   `'absolute'` when it sits at `created_at + 30 d`, `'inactivity'`
 *   otherwise — diagnostic vocabulary for the consumer's 401 shape;
 *   the canonical writers (creation, refresh) always produce exactly
 *   one of the two bounds, and when both coincide (a last sighting
 *   exactly 23 days in) the absolute rule is the name.
 * - `unknown` — no row carries the digest: the token was never minted,
 *   or the row is gone (logout revocation, password-change revocation,
 *   §11.3 cleanup). Storage cannot distinguish these, and the
 *   consumer's 401 must not try (fail closed on absence).
 */
export type SessionVerdict =
  | { readonly verdict: 'valid'; readonly session: SessionRecord }
  | {
      readonly verdict: 'expired';
      readonly session: SessionRecord;
      readonly rule: SessionExpiryRule;
    }
  | { readonly verdict: 'unknown' };

/** Options for {@link authenticateSession}. */
export interface AuthenticateSessionOptions {
  /** The storage facade — reads through `getSession`, refreshes through `touchSession`. */
  readonly repository: QuotaRepository;
  /**
   * The cookie token exactly as the request presented it — the wire
   * string, digested here and never passed to storage raw (the module's
   * whole discipline; an empty or garbage cookie value simply digests to
   * a digest no row carries and answers `unknown`).
   */
  readonly token: string;
  /**
   * The request instant as UTC epoch milliseconds — the D-021 clock
   * seam, the same explicit-`now` contract as
   * {@link CreateSessionOptions.now}. Both the expiry comparison and
   * the refresh stamp read it.
   */
  readonly now: number;
}

/**
 * The per-request §15.2 judgement — the composition D-123 recorded for
 * this task: digest the presented token
 * ({@link hashSessionToken} — no decode step), look the row up
 * (`getSession`), render the verdict on `expires_at` (D-124's
 * half-open reading: `now < expires_at` is the whole validity test —
 * the row's single effective-expiry column already folds both §15.2
 * bounds, whichever is tighter), and, on the valid arm only, record the
 * sighting: `touchSession` writes `last_seen_at = now` and
 * `expires_at = effectiveSessionExpiry(created_at, now)`, so the
 * inactivity window slides to `now + 7 d` while the absolute cap never
 * extends past `created_at + 30 d` — the same single-sited formula the
 * shipped CHECKs enforce (D-056), which is why the write can never
 * violate them.
 *
 * An `expired` verdict performs no write (§11.3's cleanup owns
 * expired-row deletion, D-061). A `touchSession` that reports the row
 * gone downgrades the verdict to `unknown`: a revocation must beat an
 * in-flight sighting, never lose to it. Nothing can interleave between
 * two calls on the server's own synchronous connection, but the
 * `quotameter passwd` CLI revokes every session over its own separate
 * connection while the server runs (task 144's flow), so the row can
 * genuinely be gone at the write — the arm is live, not defensive.
 * Synchronous (D-058), logger-free (§15.4/§16), and a non-integer `now`
 * fails fast before any storage call, naming the field.
 */
export function authenticateSession(options: AuthenticateSessionOptions): SessionVerdict {
  requireEpochMilliseconds(options.now, 'now');
  const now = options.now;
  const session = options.repository.getSession(hashSessionToken(options.token));
  if (session === null) {
    return { verdict: 'unknown' };
  }
  if (now >= session.expiresAt) {
    return { verdict: 'expired', session, rule: sessionExpiryRule(session) };
  }
  const expiresAt = effectiveSessionExpiry(session.createdAt, now);
  const recorded = options.repository.touchSession(session.tokenHash, {
    lastSeenAt: now,
    expiresAt,
  });
  if (!recorded) {
    return { verdict: 'unknown' };
  }
  return { verdict: 'valid', session: { ...session, lastSeenAt: now, expiresAt } };
}

/**
 * Which §15.2 bound an expired row's `expires_at` sits at — `absolute`
 * at `created_at + SESSION_MAX_AGE_MS`, `inactivity` otherwise. The
 * canonical writers produce exactly one of the two bounds (the `min` of
 * D-056's formula), so this reads the binding rule off the row without
 * recomputing the formula against a `now` the row never saw.
 */
function sessionExpiryRule(session: SessionRecord): SessionExpiryRule {
  return session.expiresAt === session.createdAt + SESSION_MAX_AGE_MS ? 'absolute' : 'inactivity';
}

/** Options for {@link revokeSession}. */
export interface RevokeSessionOptions {
  /** The storage facade — the delete runs through `deleteSession`. */
  readonly repository: QuotaRepository;
  /** The cookie token exactly as the request presented it; digested here, never stored raw. */
  readonly token: string;
}

/**
 * Revokes one session — the logout half of §15.2's revocation: digest
 * the presented token ({@link hashSessionToken}) and delete the row
 * through the facade's `deleteSession`. Returns whether a session was
 * revoked; a token naming no row (already logged out, never minted,
 * cleaned up) returns `false` — logout is idempotent, and the cookie
 * clearing (the `clearSessionCookieAttributes` primitive of
 * `src/services/session-cookie.ts`, 157/D-126, spread by the logout
 * endpoint) makes the client forget the token either
 * way. No timestamp is written, so there is no `now` to pass; the
 * password-change half ("changing the password revokes all sessions")
 * lives in the two password-change paths, both in the fail-secure order
 * of D-184 — `revokeAllSessions` in `src/cli/passwd.ts` and the
 * settings store's pre-mutation call (`src/server/config-stores.ts`) —
 * over the facade's `deleteAllSessions` each.
 */
export function revokeSession(options: RevokeSessionOptions): boolean {
  return options.repository.deleteSession(hashSessionToken(options.token));
}
