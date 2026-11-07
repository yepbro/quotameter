/**
 * The §13 auth endpoints (tasks U-041 and U-055, spec §13, §15.1, §15.2,
 * §14.6; decisions D-146 and D-182) — the composition the four §15.2
 * primitives waited on (the plan gap D-125/D-126 recorded: every primitive
 * landed, no task owned the endpoints composing them), plus §13's third
 * auth row, the session reader (U-055).
 *
 * Nothing here re-derives a §15.2 rule: the scrypt comparison is
 * `verifyPassword` (D-122), the token and its digest `createSession`
 * (D-123), the expiry verdict and revocation `authenticateSession` /
 * `revokeSession` (D-124), the five-failure/15-minute budget
 * `createLoginRateLimiter` (D-125), and the `Set-Cookie` attribute
 * objects `sessionCookieAttributes` / `clearSessionCookieAttributes`
 * (D-126). The session reader reuses the same two §15.1/§15.2 pieces the
 * guard composes — `classifyAuthMode` and `authenticateSession`, never
 * re-implemented — and owns only the wire: the public `GET
 * /api/auth/session` body of §13's "current session and auth-mode
 * information" row (D-182). This module owns only the wire for the other
 * two routes as well: the bodies, the responses, the per-request
 * composition order, and the two fastify-side seams below.
 *
 * Pinned interpretations (D-146):
 *
 * - **Login's composition order is D-125's documented order, held under
 *   concurrency by per-source MUTUAL EXCLUSION.** One attempt runs
 *   `delayBeforeAttempt(source, now)` → sleep-if-delayed →
 *   `verifyPassword` → `recordAttempt`, and at most ONE attempt per
 *   source is in that section at any moment: a same-source request that
 *   arrives while another is in flight is answered immediately with the
 *   same 401 class under `details.reason: 'source-busy'` — without
 *   verifying anything and without recording anything, so no credential
 *   is guessed, no budget is consumed, and the wire shape stays a failed
 *   login. This is the cadence hold D-125's consequences assigned to the
 *   endpoint ("serializing per source"), in its strictest form: the
 *   check-then-record window D-125 warned about ("a concurrent burst can
 *   race the check-then-record window and land K attempts at one delay
 *   each") is structurally impossible when the second attempt cannot
 *   enter, and the processed-attempt rate is at or below the serialized
 *   ideal. (Correction trail — the review round's two P1s: the first
 *   design queued same-source attempts on a promise chain, which made
 *   the per-connection hold unbounded (queue wait plus the delay) and
 *   exceeded the construction's socket-inactivity bound from the queued
 *   position alone; the queue was also an unbounded memory lever over
 *   the public endpoint. Exclusion closes both: the hold is one clamped
 *   delay plus one scrypt, and the busy map holds at most one entry per
 *   ACTIVE source.)
 * - **The slept delay is clamped below the transport's socket-inactivity
 *   bound.** D-125's curve reaches 512 s at the thirteenth in-window
 *   failure and caps at the 15-minute window, while the construction
 *   destroys an idle socket after `HTTP_CONNECTION_TIMEOUT_MS`
 *   (300 s — D-109's own docblock: the bound "must comfortably exceed
 *   the longest legitimate silent handler", and a login inside its delay
 *   is exactly that). The endpoint therefore sleeps
 *   `min(delay, {@link MAX_LOGIN_DELAY_SLEEP_MS})` — 240 s, comfortably
 *   inside the bound with the scrypt to follow — a clamp that only binds
 *   where D-125's curve exceeds it (delays are 1 s doubling from the
 *   sixth failure: the clamp first bites at 512 s), keeps the delays
 *   increasing (§15.2's own word), keeps the effective cap inside the
 *   15-minute window (the purpose of D-125's cap), and tightens the
 *   throttle in the fail-closed direction. The budget's arithmetic is
 *   untouched: the delay is computed, the failure recorded, exactly as
 *   D-125 prescribes — only the timer the endpoint arms is bounded by
 *   the transport it answers through. A unit test pins the constant
 *   relation so the two bounds cannot drift apart silently.
 * - **The sleep timer never holds the process open** (§5.6): the default
 *   sleep unrefs its `setTimeout`, so a SIGTERM that closes the listener
 *   (the bounded close already force-destroys the sleeping attempt's
 *   socket) lets the event loop drain without waiting out an in-flight
 *   delay — `runServer` never calls `process.exit`, so a referenced
 *   timer would linger up to the full clamp (the review round's second
 *   P1). While the server runs, the listening socket keeps the loop
 *   alive and the sleep completes normally.
 * - **The source key is `request.ip`** — the socket-derived remote
 *   address. `trustProxy` is never enabled (D-109), so the value cannot
 *   be forged through a header; behind §15.6's reverse proxy every
 *   client shares the proxy's address, the shared-source reality whose
 *   denial-of-service lever D-125's delays-never-rejections choice
 *   explicitly rejected — and the busy arm is the same trade again: a
 *   flooded shared source answers fast non-verifying 401s while its
 *   processed cadence stays throttled, never a lockout. The key stays
 *   opaque (D-125: never parsed).
 * - **The delay is invisible on the wire.** §15.2 says "apply increasing
 *   delays", not "reject": an over-budget attempt — failed OR successful
 *   (the check precedes the verify, so a verified password still pays
 *   the delay its source earned) — is answered slowly with the SAME
 *   envelope an under-budget failure answers. No rate-limit error code
 *   exists (D-125 retired the promised `RATE_LIMITED`), no
 *   `Retry-After`, no status change. The sleep runs through the
 *   injectable {@link AuthRouteOptions.sleep} seam (the timer is the
 *   endpoint's, D-125's rule; the default is the unref'd timer above) so
 *   fake-clock tests observe the requested delay without waiting it.
 * - **Failed attempts log exactly one `warn`, credential-free** (§15.2's
 *   own sentence): `{ source, outcome: 'failure' }` through the request
 *   logger — the redacting pino the construction owns — never the
 *   candidate password, the stored hash, or any session token (§15.4;
 *   the route suite's marker test scans for the ATTEMPTED candidate,
 *   which is the string a handler bug would leak). The busy arm logs its
 *   own single `warn` with `outcome: 'source-busy'` — it is not a
 *   §15.2 failed attempt (nothing was verified), but a same-source flood
 *   is the one signal an operator wants on the record. 4xx classes log
 *   nothing else (§16/D-113 discipline).
 * - **A passwordless configuration answers 401, not an error** —
 *   `verifyPassword(undefined, …)` is `false` by D-122's totality guard,
 *   so the fail-closed arm is one code path. The reachable shape is
 *   `auto` + loopback direct with no password set (every passwordless
 *   remote shape refuses at startup): there the §15.1 layer's
 *   403-with-instructions covers the PROTECTED routes — the proxied
 *   passwordless request against them never reaches a handler — while
 *   login itself, being public, takes this 401 (the deliberate
 *   deviation: D-121 wants the login route reachable in every proxy
 *   state, and an unverifiable credential is a wrong password to
 *   D-122's verifier, never an error).
 * - **Refreshed sightings do NOT re-issue the cookie** — D-126's
 *   documented open point, resolved conservatively: the §15.1 seam stays
 *   D-121's `(request) => boolean` (the one-lambda shape D-124's
 *   consequences predicted, made a named factory below for testability),
 *   which cannot see the reply, so every valid sighting refreshes the
 *   ROW (`authenticateSession`'s `touchSession`) while the COOKIE keeps
 *   its mint-time `Max-Age` (7 days) — an active owner re-logs-in at
 *   most every 7 days, the row's own bounds are untouched, and the
 *   orphaned row self-expires within the 30-day cap. The
 *   alignment-preserving alternative (the seam seeing the reply, or an
 *   onSend re-issue hook) is a successor decision if the UX ever demands
 *   it — D-146 records the trade.
 *
 * Route security is inherited, never re-implemented: login and logout are
 * POSTs, so the scope's §15.3 guards (Origin/Fetch-Metadata, the
 * dedicated mutation header, the JSON content-type on the body-carrying
 * login) run ahead of every handler exactly as for any other mutation;
 * the session reader is a GET, so no mutation leg binds it at all.
 * Login and the session reader opt out of the §15.1 auth question
 * through {@link PUBLIC_AUTH_ROUTE_CONFIG} — the client that presents
 * credentials (or asks whether it needs any) has no session yet
 * (D-121's contract); logout is session-bound like every protected route
 * (under `required` a cookieless logout answers the guard's 401 — the
 * clear-cookie it never got costs one dead `Max-Age`-bounded client
 * cookie, D-126's documented hygiene lag).
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ApiError } from './error';
import { strictValidatorCompiler } from './validation';
import {
  classifyAuthMode,
  PUBLIC_AUTH_ROUTE_CONFIG,
  proxyIndicatorPresent,
  type RequestAuthenticator,
} from './auth';
import { verifyPassword } from '../../services/password-hash';
import { createLoginRateLimiter, type LoginRateLimiter } from '../../services/login-rate-limit';
import { createSession, revokeSession, authenticateSession } from '../../services/sessions';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieAttributes,
  sessionCookieAttributes,
  type SessionCookieTransportFacts,
} from '../../services/session-cookie';
import { isLoopbackHost, type AuthMode } from '../../schemas/config';
import type { QuotaRepository } from '../../storage/repository';
import type {
  LoginBody,
  LoginResponse,
  LogoutResponse,
  SessionResponse,
} from '../../schemas/api/auth';
import {
  LoginBodySchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  SessionResponseSchema,
} from '../../schemas/api/auth';

/**
 * The ceiling the endpoint clamps its login-delay sleep to — comfortably
 * inside the construction's `HTTP_CONNECTION_TIMEOUT_MS` (300 s, D-109),
 * which destroys an idle socket and would turn a longer sleep into a
 * connection reset instead of the slow answer §15.2 demands (see the
 * module header; the unit suite pins the relation, so the two bounds
 * cannot drift apart silently). D-125's delay curve first exceeds this
 * at 512 s, so every spec-level delay (1 s doubling from the sixth
 * failure through 256 s) sleeps unchanged.
 */
export const MAX_LOGIN_DELAY_SLEEP_MS = 240_000;

/**
 * The §15.1 facts source the session reader reports — D-121's guard
 * inputs minus the credential seam: the session endpoint answers WHAT the
 * guard would decide for this request, never re-deciding protection
 * itself. Deliberately NOT named `AuthModeFacts` — that identifier is the
 * classifier's four-fact input (`./auth`); this is the guard-options
 * shape the scope provides. The scope (`./index.ts`) injects it from its
 * own required `auth` options, so the guard and the reader can never
 * drift apart on mode, bind, or password presence.
 */
export interface AuthModeSource {
  /** The configured `auth.mode` (`auto` default, `required`; spec §15.1). */
  readonly mode: AuthMode;
  /**
   * The listener's bind address — the §15.1 bind fact, reduced to
   * loopback-ness with `isLoopbackHost` (the single owner of that
   * semantics) once at registration, exactly as the guard factory does.
   */
  readonly bindHost: string;
  /**
   * Whether a password is configured, read per request — §6.4/D-026
   * classify the hash live, so a `passwd` run against a running server
   * flips the reported mode on the next request (the same thunk shape the
   * guard takes). Defaults to "no password configured".
   */
  readonly passwordConfigured?: () => boolean;
}

/** Options of {@link authRoutes}; every member is an injection seam. */
export interface AuthRouteOptions {
  /**
   * The storage facade — session minting (D-123) and revocation (D-124)
   * run through it; the raw token never does (digest-only discipline).
   */
  readonly repository: QuotaRepository;
  /**
   * The stored password hash (`auth.passwordHash`), read per attempt:
   * §6.4/D-026 classify the hash live, so a `quotameter passwd` run (or a
   * settings PUT that changes it) applies to the next login without a
   * restart — the same per-request-thunk shape the §15.1 guard's
   * `passwordConfigured` takes. `undefined` means no password is
   * configured; login then answers 401 fail-closed (D-122's guard).
   */
  readonly passwordHash: () => string | undefined;
  /** The clock (D-021) — stamps the budget check, the record, the mint. */
  readonly now: () => number;
  /**
   * The login-delay sleep — the timer is the endpoint's (D-125's rule: a
   * service-layer sleep would be untestable without fake timers). The
   * default is the unref'd `setTimeout` promise ({@link defaultSleep});
   * tests inject a recorder so the fake-clock budget proofs observe the
   * requested delay without waiting it.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The §15.1 facts `GET /auth/session` reports ({@link AuthModeSource}).
   * Required here — the plugin's own declaration of the dependency — but
   * supplied by the `/api` scope from its guard options at registration
   * (`./index.ts`), never by the outer constructions: one source of §15.1
   * truth serves both the guard and the reader.
   */
  readonly authMode: AuthModeSource;
}

/* ── The transport-fact resolution (D-126's documented recipe) ──────────── */

/**
 * Node's folded header value: one string (duplicates joined with `, `) or
 * a pre-split array under some client shapes — either way the parsers in
 * `src/services/session-cookie.ts` take the comma-joined list form.
 */
function foldedHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Resolves one request's {@link SessionCookieTransportFacts} exactly as
 * the D-126 module docblock prescribes: `request.protocol === 'https'`
 * for the socket-derived fact (trustProxy is never enabled in D-109's
 * construction, so no header can fake it), and the folded
 * `X-Forwarded-Proto` / RFC 7239 `Forwarded` values for the two
 * forwarded ones. Exported because the resolution is half of the
 * `Secure` verdict's contract — the unit suite pins it against the
 * header shapes (lists, arrays, absence) without a socket.
 */
export function sessionCookieTransportOf(request: FastifyRequest): SessionCookieTransportFacts {
  return {
    requestTls: request.protocol === 'https',
    forwardedProto: foldedHeader(request.headers['x-forwarded-proto']),
    forwarded: foldedHeader(request.headers.forwarded),
  };
}

/* ── The §15.1 seam consumption (D-124's one-lambda, a named factory) ───── */

/**
 * Builds the sessions-backed {@link RequestAuthenticator} the §15.1
 * guard consults on every credential-demanding verdict — the wiring
 * D-124's consequences predicted (`authenticateSession(...).verdict ===
 * 'valid'`), as a named factory so the composition root stays a one-line
 * call and the unit suite can drive the arms without fastify. A missing
 * or empty cookie answers `false` without touching storage (a digest of
 * nothing names no row anyway — the early return only saves the read);
 * any other value is digested by the primitive itself, never stored raw.
 *
 * The factory deliberately does NOT re-issue the cookie on refreshed
 * sightings (D-146's resolution): the seam sees the request alone, the
 * row slides (D-124), the cookie keeps its mint-time `Max-Age`.
 */
export function createSessionAuthenticator(options: {
  readonly repository: QuotaRepository;
  readonly now: () => number;
}): RequestAuthenticator {
  return (request) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (typeof token !== 'string' || token === '') {
      return false;
    }
    return (
      authenticateSession({ repository: options.repository, token, now: options.now() }).verdict ===
      'valid'
    );
  };
}

/* ── The per-source exclusion (D-125's cadence hold, strictest form) ────── */

/**
 * Runs `task` as the ONLY in-flight attempt of `source`: a same-source
 * request that arrives while one is running takes the
 * {@link onSourceBusy} arm instead — no verify, no record, the busy 401
 * (see the module header). The busy set holds at most one entry per
 * ACTIVE source and self-empties as each attempt settles, so neither
 * the map nor any queue can grow with hostile traffic; `task`'s
 * rejection propagates to the caller (the envelope's class) while the
 * entry is released in the `finally` regardless.
 */
async function runExclusively<T>(
  busySources: Set<string>,
  source: string,
  task: () => Promise<T>,
  onSourceBusy: () => Promise<T>,
): Promise<T> {
  if (busySources.has(source)) {
    return onSourceBusy();
  }
  busySources.add(source);
  try {
    return await task();
  } finally {
    busySources.delete(source);
  }
}

/**
 * The production sleep — a timer promise that never holds the event loop
 * open (§5.6: `runServer` drains rather than exits, so a referenced
 * timer would linger past the bounded shutdown; unref'd, the closed
 * server's loop drains while the sleeping handler simply never completes
 * its response — its socket was force-destroyed by the bounded close
 * anyway). Exported for the unref pin in the unit suite.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/* ── The plugin ────────────────────────────────────────────────────────── */

/**
 * Registers `POST /auth/login`, `POST /auth/logout`, and `GET
 * /auth/session` inside the `/api` scope (the paths are `/api/auth/*` under
 * the scope prefix). The scope's three guards apply by hook encapsulation;
 * the §15.3 legs bind both POSTs identically (login additionally carries
 * the JSON content-type leg because it carries a body — D-117's bodiless
 * rule keeps logout header-only), while the GET needs no mutation legs at
 * all. The limiter instance is created here, once per registration:
 * registration IS the composition moment, so one instance serves the whole
 * login surface (D-125) while each fastify instance (each test harness
 * included) gets its own budget state.
 */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (fastify, options) => {
  const { repository, passwordHash, now } = options;
  const sleep = options.sleep ?? defaultSleep;
  const limiter: LoginRateLimiter = createLoginRateLimiter();
  const busySources = new Set<string>();
  // The §15.1 facts for the session reader — the construction-time halves
  // (mode, bind) decided once, exactly as the guard factory does; the live
  // password thunk stays per-request (§6.4/D-026).
  const { mode: authModeName, bindHost } = options.authMode;
  const bindIsLoopback = isLoopbackHost(bindHost);
  const passwordConfigured = options.authMode.passwordConfigured ?? (() => false);

  // Strict schema validation, scoped to these routes (D-128's rule): a
  // body smuggling an extra field answers VALIDATION, never a strip.
  fastify.setValidatorCompiler(strictValidatorCompiler());

  fastify.post(
    '/auth/login',
    {
      schema: {
        body: LoginBodySchema,
        response: { 200: LoginResponseSchema },
      },
      // D-121's opt-out contract: the credential-presenting client has no
      // session yet, and the §14.6 login page's submit must reach this
      // handler in every mode, bind, and proxy state. Only the §15.1
      // auth question is opted out — the §15.3 guards still bind (a
      // cross-origin or header-less login POST is rejected like any
      // other mutation).
      config: PUBLIC_AUTH_ROUTE_CONFIG,
    },
    async (request, reply) => {
      const source = request.ip;
      const body = request.body as LoginBody;
      // D-125's composition, per-source exclusive: check → sleep →
      // verify → record. The ApiError a failure throws propagates to the
      // envelope; the busy set is released in the finally either way.
      const creation = await runExclusively(
        busySources,
        source,
        async () => {
          const delayMs = limiter.delayBeforeAttempt(source, now());
          if (delayMs > 0) {
            // Clamped to the transport-safe ceiling (the module header):
            // the socket the answer rides is destroyed after 300 idle
            // seconds, and a delay the socket cannot outlive would be a
            // reset, not the slow answer §15.2 demands.
            await sleep(Math.min(delayMs, MAX_LOGIN_DELAY_SLEEP_MS));
          }
          const verified = await verifyPassword(passwordHash(), body.password);
          if (!verified) {
            // §15.2's own logging sentence: one `warn` per failed
            // attempt, source and outcome only — never the candidate
            // password, the stored hash, or any token (§15.4; the marker
            // test scans for the attempted candidate itself).
            limiter.recordAttempt(source, 'failure', now());
            request.log.warn({ source, outcome: 'failure' }, 'login attempt failed');
            throw new ApiError('UNAUTHENTICATED', { details: { reason: 'invalid-credentials' } });
          }
          // Success resets the source's budget (D-125) before the mint, so
          // the new session's first typo does not inherit the old budget.
          limiter.recordAttempt(source, 'success', now());
          return createSession({ repository, now: now() });
        },
        async () => {
          // The busy arm: another attempt of this source is in flight, so
          // this one is neither verified nor recorded — no guess is
          // evaluated, no budget is consumed, and the wire answer is the
          // same 401 class with the honest reason (the one distinguisher
          // is timing, which is the throttle working as designed).
          request.log.warn({ source, outcome: 'source-busy' }, 'login attempt not processed');
          throw new ApiError('UNAUTHENTICATED', { details: { reason: 'source-busy' } });
        },
      );
      // D-123's disclose-exactly-once: the token goes straight from the
      // mint's return value into the cookie with D-126's attribute
      // object — `nowMs` is the row's own creation stamp, so the fresh
      // cookie carries exactly the 7-day inactivity bound (Max-Age
      // 604800; the ceil never rounds a whole-second bound either way).
      reply
        .setCookie(
          SESSION_COOKIE_NAME,
          creation.token,
          sessionCookieAttributes({
            transport: sessionCookieTransportOf(request),
            expiresAtMs: creation.session.expiresAt,
            nowMs: creation.session.createdAt,
          }),
        )
        .header('cache-control', 'no-store');
      const response: LoginResponse = {
        session: { expiresAt: creation.session.expiresAt },
      };
      return response;
    },
  );

  fastify.post(
    '/auth/logout',
    {
      schema: {
        response: { 200: LogoutResponseSchema },
      },
    },
    async (request, reply) => {
      // D-124's logout primitive + D-126's clear twin. No `now`, no
      // verdict: revocation digests whatever cookie value is present and
      // deletes the row it names — absent, garbage, or already-revoked
      // values revoke nothing (`revoked: false`) and the cookie is
      // cleared either way, which is what makes logout idempotent. The
      // route is session-bound (no public opt-out): under `required` the
      // §15.1 guard has already answered 401 for a cookieless request
      // before this handler exists on the wire.
      const token = request.cookies[SESSION_COOKIE_NAME];
      const revoked =
        typeof token === 'string' && token !== '' ? revokeSession({ repository, token }) : false;
      reply
        .setCookie(
          SESSION_COOKIE_NAME,
          '',
          clearSessionCookieAttributes(sessionCookieTransportOf(request)),
        )
        .header('cache-control', 'no-store');
      const response: LogoutResponse = { revoked };
      return response;
    },
  );

  fastify.get(
    '/auth/session',
    {
      schema: {
        response: { 200: SessionResponseSchema },
      },
      // The D-121 opt-out health and login already use: the session
      // reader's client is precisely the client that may hold no session
      // yet — the D-159 chicken-and-egg (every mode-fact surface being
      // itself protected) is the reason this row exists. Only the §15.1
      // auth question is opted out; the root-scope Host guard and the
      // §15.3 guards still bind this route like every other.
      config: PUBLIC_AUTH_ROUTE_CONFIG,
    },
    async (request, reply) => {
      // The §15.1 verdict for THIS request, recomputed from the same four
      // facts the guard reads — the answer a probe of any protected route
      // would reveal (200 / 401 / the 403-instructions envelope), stated
      // instead of forced on the client.
      const verdict = classifyAuthMode({
        mode: authModeName,
        bindIsLoopback,
        passwordConfigured: passwordConfigured(),
        proxyIndicated: proxyIndicatorPresent(Object.keys(request.headers)),
      });
      // The §15.2 verdict over the presented cookie — `authenticateSession`
      // verbatim (D-124): a missing or empty cookie skips storage (a digest
      // of nothing names no row), any other value is digested and judged
      // half-open, and a valid sighting REFRESHES the row (the sliding
      // inactivity window) exactly as every authenticated request does.
      // No minting, no cookie write (D-146's no-re-issue holds here too).
      const token = request.cookies[SESSION_COOKIE_NAME];
      const authentication =
        typeof token === 'string' && token !== ''
          ? authenticateSession({ repository, token, now: now() })
          : undefined;
      reply.header('cache-control', 'no-store');
      if (authentication?.verdict === 'valid') {
        // `expired` and `unknown` deliberately collapse into the bare
        // false arm below — D-124's indistinguishable-absence rule.
        const response: SessionResponse = {
          mode: verdict.authentication,
          authenticated: true,
          session: { expiresAt: authentication.session.expiresAt },
        };
        return response;
      }
      const response: SessionResponse = {
        mode: verdict.authentication,
        authenticated: false,
      };
      return response;
    },
  );
};
