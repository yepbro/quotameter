/**
 * The §15.3 request-security checks (task 149; decision D-115).
 *
 * The Origin/Fetch-Metadata guard: every state-changing request (§13's
 * `POST`/`PUT`/`PATCH`/`DELETE`) under `/api` must look same-origin before
 * any handler or body parser runs. The check is deliberately total over
 * three request signals — `Origin`, `Sec-Fetch-Site`, and the request's own
 * `Host` authority — and never over server state: not the auth mode (152
 * selects credentials; the guard runs identically in `off`/`auto`/
 * `required`), not static serving, not configuration. That mode-blindness
 * is structural (D-113's hardening lesson: router-level and static-mode
 * classes must stay mode-independent — a security verdict must not depend
 * on whether the UI build happens to be deployed).
 *
 * Two pieces, the D-113 throw-side pattern: {@link classifyOriginRequest}
 * is the pure decision (total over the signal, fail-closed on anything it
 * cannot validate), and {@link originGuard} is the Fastify `onRequest`
 * hook the `/api` scope registers (`./index.ts`) — on denial it throws
 * `ApiError('FORBIDDEN')`, so the existing root-scope error handler
 * answers the §13 envelope with no new wiring (verified on the pinned
 * runtime: a throw from a scoped `onRequest` hook reaches the root error
 * handler).
 *
 * The resolved pass/reject matrix (spec §15.3 says "validate" — D-115 is
 * the resolved table): safe methods pass untouched; `Origin: null`,
 * unparseable values, and non-http(s) schemes (a serialized Origin is
 * always an http/https tuple with a host) are rejected (fail closed); a
 * present `Origin` must carry the request's own authority (`host:port`
 * — scheme is deliberately not compared: behind §15.6's documented
 * TLS-terminating proxy the browser's Origin is `https://…` while the
 * internal hop is plain HTTP); `Sec-Fetch-Site` must be `same-origin` or `none` —
 * `same-site` is rejected because same-site ≠ same-origin (a sibling
 * subdomain or another port on the same host is still a cross-origin
 * mutation, exactly what the done-condition binds); both headers absent
 * passes, because only non-browser clients omit them both (a curl/CLI
 * call is not a CSRF vector), and the residual old-browser gap is closed
 * by task 150's mandatory custom header — a header no HTML form can set
 * while CORS stays disabled (§13).
 *
 * This module is the seam for the remaining §15.3 checks: task 150's
 * custom-header/JSON-content-type guard joins here as a sibling hook over
 * the shared {@link STATE_CHANGING_METHODS}, and task 151's Host
 * allowlist reuses {@link normalizeAuthority} as its comparison yardstick.
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './error';

/**
 * Spec §13's definition of state-changing, single-sited for the §15.3
 * checks (`POST`, `PUT`, `PATCH`, `DELETE`) — task 150's header guard
 * decides over the same set. Uppercase: the HTTP parser delivers methods
 * uppercased, and {@link classifyOriginRequest} normalizes before asking.
 */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = Object.freeze(
  new Set(['POST', 'PUT', 'PATCH', 'DELETE']),
);

/**
 * The `Sec-Fetch-Site` values a state-changing request may carry
 * (compared on the trimmed, lowercased value — browsers emit exactly
 * these lowercase tokens): `same-origin` is the browser's own assertion
 * that the initiator's origin equals the target's; `none` marks a
 * user-initiated request (address bar, bookmark) with no initiating
 * origin. Everything else — `same-site`, `cross-site`, any malformed or
 * forged token — is a cross-origin mutation attempt (D-115).
 */
const SEC_FETCH_SITE_ALLOWED: ReadonlySet<string> = Object.freeze(new Set(['same-origin', 'none']));

/**
 * Why a state-changing request was rejected — the stable `details.reason`
 * value on the wire. Deliberately a closed vocabulary that names the
 * failed check, never the attacker-controlled header value (§15.4
 * discipline: the rejection echoes nothing the client sent).
 */
export type OriginGuardReason =
  'opaque-origin' | 'malformed-origin' | 'origin-mismatch' | 'cross-site-fetch';

/** The pure verdict of {@link classifyOriginRequest}. */
export type OriginDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: OriginGuardReason };

/** The request signals the Origin/Fetch-Metadata check decides over. */
export interface OriginRequestSignal {
  /** HTTP method as delivered (uppercased by the parser). */
  readonly method: string;
  /** Raw `Origin` header value; `undefined` when absent. */
  readonly origin?: string;
  /** Raw `Sec-Fetch-Site` header value; `undefined` when absent. */
  readonly secFetchSite?: string;
  /** The request's own authority (`Host` header); `undefined` when absent. */
  readonly authority?: string;
}

/**
 * The comparison yardstick for authorities (and task 151's Host
 * allowlist): case-normalized, with an explicit default port stripped.
 * Scheme-aware (the P2-2 review fix): only the given origin scheme's
 * default port is stripped — `http`'s `:80` or `https`'s `:443` — because
 * the opposite scheme's default is a NON-default port there and stays
 * identity (`http://a.example:443` must not collapse onto a port-80
 * authority). The scheme-less form strips both (inherently ambiguous
 * without a scheme; the guard always passes the Origin's, task 151 may
 * refine). `http://localhost` (a browser Origin never serializes the
 * default port) and `Host: localhost:80` (an explicitly written default)
 * are the same authority, as are `https://a.example` and
 * `a.example:443`; `new URL` already drops default ports from
 * `url.host`, so normalizing the Origin side with its own scheme is
 * idempotent. A non-default port always survives, making
 * `localhost:3000` and `localhost:8080` different authorities.
 */
export function normalizeAuthority(value: string, scheme?: 'http' | 'https'): string {
  const lowered = value.trim().toLowerCase();
  const defaultPorts =
    scheme === 'https' ? [':443'] : scheme === 'http' ? [':80'] : [':80', ':443'];
  for (const defaultPort of defaultPorts) {
    if (lowered.endsWith(defaultPort)) {
      return lowered.slice(0, -defaultPort.length);
    }
  }
  return lowered;
}

/**
 * The §15.3 decision for one request signal — pure, total, and fail
 * closed: anything that cannot be validated as same-origin on a
 * state-changing method is rejected, in a fixed check order so the
 * reason is deterministic (the Origin family first, then
 * `Sec-Fetch-Site`). Every present signal must independently pass — a
 * browser never lets the two disagree, so disagreement is a forged
 * client and either failure rejects.
 */
export function classifyOriginRequest(signal: OriginRequestSignal): OriginDecision {
  if (!STATE_CHANGING_METHODS.has(signal.method.toUpperCase())) {
    // §13's state-changing definition: GET/HEAD (and any other method)
    // carries no mutation, so the CSRF question does not arise.
    return { allowed: true };
  }
  const origin = signal.origin;
  if (origin !== undefined) {
    // The literal `null` is an opaque origin (sandboxed iframe, a
    // cross-scheme redirect, privacy contexts) — never the UI's own
    // same-origin fetch.
    if (origin === 'null') {
      return { allowed: false, reason: 'opaque-origin' };
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return { allowed: false, reason: 'malformed-origin' };
    }
    // A serialized Origin is always an http/https tuple origin with a
    // host (or the literal `null` above): `file:`/`data:`/`mailto:` URLs
    // parse but carry no origin authority (the P3-1 review fix). The
    // protocol check also guarantees a non-empty host — the WHATWG parser
    // fails every empty-host http/https form (`http://`, `http:///`)
    // before this code runs, so no separate empty-host arm exists.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'malformed-origin' };
    }
    const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    if (
      signal.authority === undefined ||
      normalizeAuthority(parsed.host, scheme) !== normalizeAuthority(signal.authority, scheme)
    ) {
      // No authority to compare against, or a different one: the request
      // cannot be established as same-origin, so it is not (fail closed).
      return { allowed: false, reason: 'origin-mismatch' };
    }
  }
  if (
    signal.secFetchSite !== undefined &&
    !SEC_FETCH_SITE_ALLOWED.has(signal.secFetchSite.trim().toLowerCase())
  ) {
    return { allowed: false, reason: 'cross-site-fetch' };
  }
  // Both headers absent is the non-browser client (only browsers emit
  // them) — not a CSRF vector; the residual old-browser gap is task
  // 150's custom header, which no HTML form can set without CORS.
  return { allowed: true };
}

/**
 * Joins a split header value into the shape the wire's duplicate-join
 * would have produced — the type-total read for Node's `string |
 * string[]` header values. A joined value fails the strict checks above
 * (`same-origin, cross-site` is not an allowed token; a comma-carrying
 * Origin does not parse), so a split value can never smuggle a
 * same-origin verdict through.
 */
function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * The Fastify `onRequest` hook the `/api` scope registers (`./index.ts`,
 * task 149): decide over the raw headers, reject by throwing — the
 * thrown `ApiError` is already the envelope's classification, answered by
 * the root-scope error handler (D-113). Async because fastify's hook
 * runner advances on the returned promise (a synchronous hook that never
 * calls `done` stalls the request — verified on the pinned runtime).
 * Runs before body parsing, so a rejected mutation never reads its body,
 * and before routing handlers, so it outranks every endpoint (the scope's
 * catch-all included — the guard also protects paths whose route does
 * not exist yet).
 */
export async function originGuard(request: FastifyRequest): Promise<void> {
  const decision = classifyOriginRequest({
    method: request.method,
    origin: readHeader(request.headers.origin),
    secFetchSite: readHeader(request.headers['sec-fetch-site']),
    authority: readHeader(request.headers.host),
  });
  if (!decision.allowed) {
    throw new ApiError('FORBIDDEN', {
      message: 'Cross-origin request rejected',
      details: { reason: decision.reason },
    });
  }
}
