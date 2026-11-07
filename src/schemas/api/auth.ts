/**
 * The §13 auth endpoint contracts (tasks U-041 and U-055, spec §13, §15.1,
 * §15.2, §14.6; decisions D-146 and D-182).
 *
 * TypeBox definitions for §13's auth rows — the login/logout endpoints that
 * compose the four landed §15.2 primitives (verify D-122, mint D-123,
 * verdict/revocation D-124, budget D-125, cookie attributes D-126) behind
 * the §15.1 seam (D-121), and the session reader (U-055) that answers the
 * row task 180's carve-out once deferred: it exists now, public like login,
 * and the UI session cache stays probe-free over it by D-182's recorded
 * reconciliation.
 *
 * Two disciplines shape the file:
 *
 * - **The password is write-only** (§15.4): the body schema accepts it,
 *   no response object declares it, and the compiled serializer drops
 *   every key the success contracts do not name — a handler bug cannot
 *   echo what the schema cannot express (the D-111 guard, generalized
 *   since D-128). The session's raw token is likewise absent from every
 *   response: it lives only in the `Set-Cookie` header the login handler
 *   writes with D-126's attribute object (D-123's disclose-exactly-once).
 * - **Response timestamps are epoch milliseconds** — the D-139/D-142
 *   family rule: one format per direction, never a mixed clock inside
 *   one body. `expiresAt` is the session row's effective expiry, the
 *   same integer the cookie's `Max-Age` mirrors.
 */

import { type Static, Type } from '@sinclair/typebox';

/* ── POST /api/auth/login ───────────────────────────────────────────────── */

/**
 * The login body — the password alone, because §15.1 fixes the user
 * model: one user, no username, no registration. Structural rules only
 * (a non-empty string): the §15.2 minimum-length rule binds whoever SETS
 * a password (init/passwd/the settings boundary), never the verifier —
 * a candidate that cannot match any storable hash is simply a failed
 * attempt (D-122's fail-closed boolean), and a schema-level minimum
 * would fork that vocabulary. Closed at every level: a smuggled extra
 * field answers VALIDATION through the strict scope-local compiler
 * (D-128), never a silent strip.
 */
export const LoginBodySchema = Type.Object(
  {
    password: Type.String({
      minLength: 1,
      description: 'The account password (write-only, never echoed).',
    }),
  },
  { additionalProperties: false },
);

/** The shape `POST /api/auth/login` accepts. */
export type LoginBody = Static<typeof LoginBodySchema>;

/**
 * The login success body. The cookie is the credential — this body only
 * reports the fact and the bound the client cannot read out of a
 * `Set-Cookie` header's attributes: `expiresAt` is the minted row's
 * effective expiry (`min(created + 7 d, created + 30 d)` = the 7-day
 * inactivity bound at mint, D-123), epoch milliseconds per the family
 * rule. The UI's session surface (180+) may render it; nothing today
 * depends on the field beyond the contract's honesty.
 */
export const LoginResponseSchema = Type.Object(
  {
    session: Type.Object(
      {
        expiresAt: Type.Integer({
          description:
            "The session row's effective expiry as epoch milliseconds — the instant from which the §15.2 verdict rejects the cookie (half-open, D-124).",
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** The shape `POST /api/auth/login` serializes to. */
export type LoginResponse = Static<typeof LoginResponseSchema>;

/* ── POST /api/auth/logout ──────────────────────────────────────────────── */

/**
 * The logout body — idempotent by construction (D-124: revocation's only
 * aftermath is `unknown`, and logout clears the cookie either way).
 * `revoked` reports whether a live session row was actually deleted, the
 * honest distinction between "you were logged out" and "there was nothing
 * to log out" — both 200, both answered with the clear-cookie twin.
 */
export const LogoutResponseSchema = Type.Object(
  {
    revoked: Type.Boolean({
      description:
        'Whether a live session row was deleted; the cookie is cleared either way (logout is idempotent).',
    }),
  },
  { additionalProperties: false },
);

/** The shape `POST /api/auth/logout` serializes to. */
export type LogoutResponse = Static<typeof LogoutResponseSchema>;

/* ── GET /api/auth/session ──────────────────────────────────────────────── */

/**
 * The §15.1 verdict vocabulary the session response reports — D-121's own
 * three values, verbatim: how the server treats THIS request. The configured
 * `auth.mode` alone would mislead (`auto` on a non-loopback bind or behind a
 * proxy indicator still demands a password for the request at hand), and
 * every verdict cell is already wire-visible through the guard's own answers
 * on protected routes (200 for `not-required`, 401 for `required`, the
 * 403-with-instructions envelope for `proxy-without-password`), so reporting
 * it here discloses nothing an unauthenticated client could not learn by
 * probing any protected path.
 */
export const SESSION_AUTH_MODES = ['not-required', 'required', 'proxy-without-password'] as const;

/** The `mode` values {@link SessionResponseSchema} carries (D-121's verdicts). */
export type SessionAuthMode = (typeof SESSION_AUTH_MODES)[number];

/**
 * The session reader's success body (spec §13's "current session and
 * auth-mode information"): the §15.1 verdict for the request, whether the
 * presented cookie maps to a valid session, and — exactly on that valid arm —
 * the row's refreshed effective expiry. `authenticated` deliberately
 * collapses every rejection into `false` (D-124: storage cannot distinguish
 * a never-minted, expired, revoked, or password-change-revoked token, and
 * the wire must not try); the raw token never appears (D-123's
 * disclose-exactly-once discipline — it lives only in the cookie).
 */
export const SessionResponseSchema = Type.Object(
  {
    mode: Type.Union(
      SESSION_AUTH_MODES.map((mode) => Type.Literal(mode)),
      {
        description:
          "The §15.1 verdict for this request (D-121's vocabulary): " +
          "'not-required' (direct loopback under `auto`), 'required' (a " +
          'password must be presented for protected routes), or ' +
          "'proxy-without-password' (the proxied shape a protected route " +
          'answers with the 403-instructions envelope).',
      },
    ),
    authenticated: Type.Boolean({
      description:
        'Whether the presented session cookie maps to a valid, unexpired ' +
        'session row — every other outcome (absent, garbage, expired, ' +
        'revoked) answers false without distinction.',
    }),
    session: Type.Optional(
      Type.Object(
        {
          expiresAt: Type.Integer({
            description:
              "The session row's effective expiry as epoch milliseconds, " +
              'refreshed by this sighting (D-124: every valid sighting slides ' +
              'the inactivity window within the 30-day cap) — the same ' +
              'integer the login response reports at mint time.',
          }),
        },
        {
          additionalProperties: false,
          description: 'Present exactly when `authenticated` is true; absent otherwise.',
        },
      ),
    ),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/auth/session` serializes to. */
export type SessionResponse = Static<typeof SessionResponseSchema>;
