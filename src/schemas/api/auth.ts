/**
 * The §13 auth endpoint contracts (task U-041, spec §13, §15.2, §14.6;
 * decision D-146).
 *
 * TypeBox definitions for the login/logout half of §13's auth row — the
 * endpoints that compose the four landed §15.2 primitives (verify D-122,
 * mint D-123, verdict/revocation D-124, budget D-125, cookie attributes
 * D-126) behind the §15.1 seam (D-121). `GET /api/auth/session` (§13's
 * third auth row) is deliberately absent: it belongs to the UI-consumer
 * task (180), and joining it here would wire a surface its owner has not
 * designed.
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
