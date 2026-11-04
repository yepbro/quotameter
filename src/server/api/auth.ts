/**
 * The §15.1 auth-mode selection layer (task 152, decision D-121).
 *
 * This module decides, per request, WHETHER authentication is required —
 * never whether presented credentials are valid: password verification is
 * task 153 (scrypt, landed as the `verifyPassword` primitive the login
 * endpoint will consume), session creation task 154 (landed as the
 * `createSession` primitive in `../../services/sessions`, D-123), the
 * lookup/expiry rules over those sessions 155, login rate-limiting 156
 * (landed as the `createLoginRateLimiter` primitive in
 * `../../services/login-rate-limit`, D-125). The split
 * is the layer's contract: a pure verdict over four facts (mode, bind
 * loopback-ness, password presence, proxy indication), plus one injected
 * credential seam ({@link RequestAuthenticator}) the later tasks implement
 * without touching this layer — the guard calls it only on the verdicts
 * that demand credentials, so the mode semantics and the credential check
 * cannot tangle.
 *
 * Two pieces each, the D-113/D-115 throw-side pattern of the §15.3 seam
 * (`./security.ts`): a pure, total, fail-closed classifier
 * ({@link classifyAuthMode} over {@link AuthModeFacts}, and
 * {@link proxyIndicatorPresent} for the request-side fact) and a Fastify
 * `onRequest` hook (`{@link createAuthModeGuard}`) the `/api` scope
 * registers (`./index.ts`) as its THIRD hook, after the Origin and
 * custom-header guards — the placement D-120 pinned ("task 152's
 * auth-mode hook keeps its place after the two `/api` scope guards"),
 * with the Host allowlist still outermost at root scope: a request with a
 * hostile Host answers the Host verdict, a cross-origin or header-less
 * mutation answers the §15.3 verdict, and only then does the auth
 * question arise (nothing downstream is consulted for a request an
 * earlier layer already rejected).
 *
 * §15.1's semantics, resolved:
 *
 * - `auto` (default): direct loopback requests need no password. A
 *   password is required when the bind is non-loopback OR the request
 *   carries a reverse-proxy indicator — `Forwarded`, `X-Real-IP`, or any
 *   `X-Forwarded-*` header (presence only, value-blind: a proxy that
 *   forwards an empty value still forwarded the request, and Node's
 *   duplicate-header fold preserves the key, so no joining game can hide
 *   an indicator — the inverse of D-120's duplicate-Host scan, which
 *   needed `rawHeaders` because THERE any occurrence must reject; here
 *   any single occurrence suffices and the folded view cannot lose it).
 * - `required`: a password is always required, even from loopback.
 * - A proxied request with no password configured answers `403` with
 *   instructions (the only reachable shape is `auto` + loopback bind:
 *   `required`-without-password and non-loopback-without-password are
 *   refused at startup by `findConfigProblems`, task 073's leg — the
 *   classifier still answers those cells fail-closed `required` so a
 *   construction fed inconsistent facts can never open up).
 *
 * `GET /api/health` stays unauthenticated in every mode and state (§13,
 * task 147): it opts out through the route's `config` object
 * ({@link PUBLIC_AUTH_ROUTE_CONFIG}) rather than registration order —
 * explicit, method-scoped, and the same contract `POST /api/auth/login`
 * (task U-041, D-146) uses to stay reachable for the client that has no
 * session yet. The frontend (static assets, SPA shell) stays outside
 * this layer entirely: the scope of the hook is `/api`, because the
 * login page of §14.6 must load before any credential can be presented
 * (D-121).
 */

import type { FastifyRequest } from 'fastify';
import type { AuthMode } from '../../schemas/config';
import { isLoopbackHost } from '../../schemas/config';
import { ApiError } from './error';

/**
 * The route-config key of the public-route opt-out ({@link
 * PUBLIC_AUTH_ROUTE_CONFIG}) — declaration-merged into fastify's context
 * config so `request.routeOptions.config.auth` is typed everywhere a
 * route declares the marker.
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    /** The §15.1 opt-out marker of task 152 (D-121); absent on protected routes. */
    readonly auth?: 'public';
  }
}

/* ── Reverse-proxy indication (spec §15.1) ─────────────────────────────── */

/**
 * The exact-name reverse-proxy indicators §15.1 spells out: `Forwarded`
 * (RFC 7239) and `X-Real-IP` (the de-facto nginx spelling). Compared on
 * the trimmed, lowercased name — the wire's own casing varies by proxy.
 */
const PROXY_INDICATOR_EXACT_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(['forwarded', 'x-real-ip']),
);

/**
 * The prefix family §15.1 spells as `X-Forwarded-*`: `X-Forwarded-For`,
 * `-Proto`, `-Host`, `-Port`, `-Server`, and any successor a proxy adds —
 * the spec names the family, so any member indicates a proxy hop.
 */
const PROXY_INDICATOR_NAME_PREFIX = 'x-forwarded-';

/**
 * Whether the request's header names include a §15.1 reverse-proxy
 * indicator — pure over the names, total over any casing (normalized
 * here, although Node already lowercases the keys it exposes). Presence
 * is the whole test: the value is deliberately unread (an empty or
 * forwarded-empty value still proves the hop), which also makes the
 * verdict immune to Node's duplicate-header joining — the folded key
 * survives with whatever value, and the name is what fires.
 */
export function proxyIndicatorPresent(headerNames: Iterable<string>): boolean {
  for (const name of headerNames) {
    const normalized = name.trim().toLowerCase();
    if (
      PROXY_INDICATOR_EXACT_NAMES.has(normalized) ||
      normalized.startsWith(PROXY_INDICATOR_NAME_PREFIX)
    ) {
      return true;
    }
  }
  return false;
}

/* ── The pure §15.1 verdict ────────────────────────────────────────────── */

/** The four facts the §15.1 mode selection decides over. */
export interface AuthModeFacts {
  /** The configured `auth.mode` (`auto` default, `required`; spec §15.1). */
  readonly mode: AuthMode;
  /**
   * Whether the listener's bind address is loopback — the §15.1 bind
   * fact, derived once from `server.host` ({@link isLoopbackHost}, the
   * single owner of that semantics, `127.0.0.0/8` and both `::1`
   * spellings included).
   */
  readonly bindIsLoopback: boolean;
  /**
   * Whether a password is configured (`auth.passwordHash` present). The
   * live-reloadable half of the facts: §6.4/D-026 classify the hash
   * live (checked per attempt, not wired into a listener), so the guard
   * reads it through a thunk on every request.
   */
  readonly passwordConfigured: boolean;
  /**
   * Whether the request carries a §15.1 reverse-proxy indicator
   * ({@link proxyIndicatorPresent} over the request's header names).
   */
  readonly proxyIndicated: boolean;
}

/**
 * The §15.1 verdict for one request — pure, total, and fail closed over
 * the full address × password × mode matrix:
 *
 * - `not-required` — exactly `auto` + loopback bind + no proxy
 *   indication. A configured password does NOT change this cell: `auto`
 *   mode's own words are "direct loopback requests do not require a
 *   password", whether or not one happens to be set.
 * - `required` — authentication must be presented: `required` mode
 *   (always), or `auto` on a non-loopback bind, or `auto` behind a
 *   proxy indicator — in each case with a password configured, plus the
 *   two startup-refused shapes (see {@link AuthModeFacts}) answered
 *   fail-closed so an inconsistently constructed server stays shut.
 * - `proxy-without-password` — the proxied request reached a server with
 *   no password configured: §15.1's own `403`-with-instructions cell
 *   (reachable only as `auto` + loopback, since every passwordless
 *   remote shape refuses to start).
 */
export type AuthModeVerdict =
  | { readonly authentication: 'not-required' }
  | { readonly authentication: 'required' }
  | { readonly authentication: 'proxy-without-password' };

/**
 * Decides the §15.1 verdict — the fixed order makes the outcome
 * deterministic: the mode first (`required` is unconditional), then the
 * bind, then the proxy indication inside the loopback cell.
 */
export function classifyAuthMode(facts: AuthModeFacts): AuthModeVerdict {
  if (facts.mode === 'required') {
    // A missing password here is the startup-refused shape
    // (`findConfigProblems` refuses `required` without a hash): fail
    // closed — authentication stays demanded, and nothing can satisfy
    // it, so the server answers 401 rather than opening up.
    return { authentication: 'required' };
  }
  if (!facts.bindIsLoopback) {
    // `auto` on a non-loopback bind demands the password; without one
    // this is the second startup-refused shape, answered the same
    // fail-closed way.
    return { authentication: 'required' };
  }
  if (facts.proxyIndicated) {
    // Loopback bind, but the request rode a proxy hop: the passwordless
    // shape is §15.1's explicit 403-with-instructions cell.
    return facts.passwordConfigured
      ? { authentication: 'required' }
      : { authentication: 'proxy-without-password' };
  }
  // The direct loopback request of `auto` mode: no password demanded.
  return { authentication: 'not-required' };
}

/* ── The credential seam (tasks 154–156) ──────────────────────────────── */

/**
 * Whether this request presents valid credentials — the seam the
 * session tasks implement: 155's session-cookie lookup and expiry
 * rules, composed behind one boolean. Password verification itself is
 * not a request fact: task 153 landed it as `verifyPassword` in
 * `../../services/password-hash` (D-122), consumed where the password
 * is actually presented — the login endpoint, which stays reachable
 * for credential-less clients through {@link PUBLIC_AUTH_ROUTE_CONFIG}.
 * Session creation landed the same way (task 154, D-123):
 * `createSession` in `../../services/sessions` is the primitive that
 * endpoint calls after verification succeeds — it mints the token and
 * stores only its SHA-256 digest. The request-side half landed with it
 * (task 155, D-124): `authenticateSession({ repository, token, now })`
 * in the same module is the whole cookie→verdict composition this seam
 * wraps — digest the presented cookie, judge `expires_at` (half-open:
 * a request at exactly the expiry instant is rejected), refresh the
 * sighting on the valid arm — so the future wiring is one lambda:
 * `(request) => authenticateSession({ ..., token: cookieValue(request),
 * now }).verdict === 'valid'`. `revokeSession` in the same module is
 * the logout endpoint's primitive. Task 156's rate budget landed the
 * same way: `createLoginRateLimiter()` in
 * `../../services/login-rate-limit` (D-125) owns the §15.2
 * five-failures/15-minutes per-source delays the login endpoint
 * composes ahead of its verify-then-establish flow
 * (`delayBeforeAttempt` → sleep → verify → `recordAttempt`), never
 * inside this mode layer — D-121's consequences pin. Task 157's cookie
 * attribute layer landed the same way: `sessionCookieAttributes` /
 * `clearSessionCookieAttributes` in `src/services/session-cookie.ts`
 * (D-126) compute the §15.2 `Set-Cookie` attribute object — including the
 * `Secure` verdict over this same transport-fact shape — for those
 * endpoints to spread into `reply.setCookie`.
 * Async by nature (the session store is), so the seam allows promises;
 * the guard awaits it and never inspects HOW a request authenticated.
 * A construction that wires no seam keeps the fail-closed default —
 * `false` for every request — so a mode that demands credentials and a
 * seam that cannot verify them keeps the surface shut, never open; the
 * production composition wires {@link createSessionAuthenticator}
 * (`./auth-routes`, task U-041/D-146) since the login endpoints landed.
 */
export type RequestAuthenticator = (request: FastifyRequest) => boolean | Promise<boolean>;

/* ── The public-route contract (health today, login in 153) ───────────── */

/**
 * The route-config marker an endpoint carries to opt out of the §15.1
 * auth question entirely — `GET /api/health` (§13's public health
 * response, task 147) today, the future login endpoint (153) next: the
 * client that presents credentials has no session yet, and a health
 * probe must never depend on authentication state. Attached to the
 * route's `config` object (available to `onRequest` hooks through
 * `request.routeOptions`), so the exemption is declared on the route
 * itself, inherits to the auto-generated HEAD twin, and never depends
 * on registration order.
 */
export const PUBLIC_AUTH_ROUTE_CONFIG: { readonly auth: 'public' } = Object.freeze({
  auth: 'public',
});

/** Why the auth-mode guard rejected — the stable `details.reason` values. */
export type AuthGuardReason = 'proxy-without-password' | 'authentication-required';

/**
 * §15.1's "403 with instructions": names the operator's two ways out —
 * configure a password (the `passwd` command of task 144) or stop
 * reaching the loopback service through a proxy — and echoes nothing
 * the client sent (§15.4: the proxied shape is the attacker-controlled
 * part; the instruction is the server's own text).
 */
const PROXY_WITHOUT_PASSWORD_MESSAGE =
  'The request was forwarded by a reverse proxy, but no password is configured; ' +
  'set one with `quotameter passwd` before exposing the service through a proxy, ' +
  'or reach it directly on the loopback interface';

/** What {@link createAuthModeGuard} accepts. */
export interface AuthModeGuardOptions {
  /**
   * The configured `auth.mode`, captured at construction: §6.4 pins it
   * restart-requiring, so it cannot change under a running listener —
   * the D-120 construction-time-capture precedent for `server.host`.
   */
  readonly mode: AuthMode;
  /**
   * The bind address — the §15.1 bind fact, reduced once (with
   * {@link isLoopbackHost}) to the loopback boolean the classifier
   * takes. Also restart-requiring (§6.4), also captured at
   * construction.
   */
  readonly bindHost: string;
  /**
   * Whether a password is configured, read per request: §6.4/D-026
   * classify `auth.passwordHash` as live (checked per authentication
   * attempt), so a password set by `passwd` while the server runs takes
   * effect on the next request without a restart. Defaults to "no
   * password configured".
   */
  readonly passwordConfigured?: () => boolean;
  /**
   * The credential seam ({@link RequestAuthenticator}); defaults to the
   * fail-closed "no request is authenticated" until 154/155 land.
   */
  readonly isAuthenticated?: RequestAuthenticator;
}

/**
 * Builds the §15.1 auth-mode `onRequest` hook — a factory like task
 * 151's Host guard, because the verdict needs construction-time facts
 * (mode, bind) beside the per-request ones. Registered as the `/api`
 * scope's third hook (`./index.ts`, task 152): after the Origin and
 * custom-header guards, under the root-scope Host guard, and ahead of
 * every handler and the body parser. Async because the credential seam
 * may promise (and fastify's hook runner advances on the returned
 * promise, the D-115 runtime note). Throws {@link ApiError} shapes the
 * root error handler answers as the §13 envelope: the 403 instructions
 * class for the passwordless proxied shape, the 401 class when the
 * verdict demands credentials the request does not carry.
 */
export function createAuthModeGuard(
  options: AuthModeGuardOptions,
): (request: FastifyRequest) => Promise<void> {
  // Construction-time facts (§6.4 restart-requiring): decided once.
  const mode = options.mode;
  const bindIsLoopback = isLoopbackHost(options.bindHost);
  // The live fact and the credential seam, with fail-closed defaults.
  const passwordConfigured = options.passwordConfigured ?? (() => false);
  const isAuthenticated = options.isAuthenticated ?? (() => false);
  return async function authModeGuard(request: FastifyRequest): Promise<void> {
    // The public-route opt-out (health today, login in 153): declared on
    // the route's config, so the exemption is the route's own contract.
    if (request.routeOptions.config?.auth === 'public') {
      return;
    }
    const verdict = classifyAuthMode({
      mode,
      bindIsLoopback,
      passwordConfigured: passwordConfigured(),
      proxyIndicated: proxyIndicatorPresent(Object.keys(request.headers)),
    });
    if (verdict.authentication === 'not-required') {
      return;
    }
    if (verdict.authentication === 'proxy-without-password') {
      throw new ApiError('FORBIDDEN', {
        message: PROXY_WITHOUT_PASSWORD_MESSAGE,
        details: { reason: 'proxy-without-password' },
      });
    }
    if (!(await isAuthenticated(request))) {
      throw new ApiError('UNAUTHENTICATED', {
        details: { reason: 'authentication-required' },
      });
    }
  };
}
