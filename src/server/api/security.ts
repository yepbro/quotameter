/**
 * The §15.3 request-security checks (tasks 149/150; decisions D-115/D-117).
 *
 * The Origin/Fetch-Metadata guard (149): every state-changing request
 * (§13's `POST`/`PUT`/`PATCH`/`DELETE`) under `/api` must look same-origin
 * before any handler or body parser runs. The check is deliberately total
 * over three request signals — `Origin`, `Sec-Fetch-Site`, and the
 * request's own `Host` authority — and never over server state: not the
 * auth mode (152 selects credentials; the guard runs identically in
 * `off`/`auto`/`required`), not static serving, not configuration. That
 * mode-blindness is structural (D-113's hardening lesson: router-level
 * and static-mode classes must stay mode-independent — a security verdict
 * must not depend on whether the UI build happens to be deployed).
 *
 * Two pieces each, the D-113 throw-side pattern: a pure classifier
 * ({@link classifyOriginRequest}, {@link classifyCustomHeaderRequest} —
 * total over the signal, fail-closed on anything it cannot validate) and
 * a Fastify `onRequest` hook the `/api` scope registers (`./index.ts`,
 * the origin guard first) — on denial each throws an `ApiError` that is
 * already the envelope's classification, so the existing root-scope
 * error handler answers the §13 envelope with no new wiring (verified on
 * the pinned runtime: a throw from a scoped `onRequest` hook reaches the
 * root error handler).
 *
 * The resolved Origin pass/reject matrix (spec §15.3 says "validate" —
 * D-115 is the resolved table): safe methods pass untouched; `Origin:
 * null`, unparseable values, and non-http(s) schemes (a serialized Origin
 * is always an http/https tuple with a host) are rejected (fail closed);
 * a present `Origin` must carry the request's own authority (`host:port`
 * — scheme is deliberately not compared: behind §15.6's documented
 * TLS-terminating proxy the browser's Origin is `https://…` while the
 * internal hop is plain HTTP); `Sec-Fetch-Site` must be `same-origin` or `none` —
 * `same-site` is rejected because same-site ≠ same-origin (a sibling
 * subdomain or another port on the same host is still a cross-origin
 * mutation, exactly what the done-condition binds); both headers absent
 * passes, because only non-browser clients omit them both (a curl/CLI
 * call is not a CSRF vector), and the residual old-browser gap is closed
 * by the custom header below — a header no HTML form can set while CORS
 * stays disabled (§13).
 *
 * The custom-header/JSON-content-type guard (150, D-117) is §15.3's
 * second leg over the same {@link STATE_CHANGING_METHODS}: every
 * state-changing request under `/api` must carry the dedicated nonstandard
 * header {@link API_MUTATION_HEADER_NAME} (present and non-empty — the
 * value is deliberately uninterpreted: the CSRF proof is that a
 * cross-origin browser cannot set *any* custom header without a CORS
 * preflight, and CORS stays disabled), and a request that carries a body
 * must type it `Content-Type: application/json` (base media type exact;
 * parameters allowed — fastify's JSON parser ignores the charset). The
 * content-type leg binds body-carrying requests only — a bodiless
 * mutation has no payload to type, and claiming a JSON body without
 * sending one is the transport's own empty-body 400 (verified on the
 * pinned runtime), so requiring the header unconditionally would make a
 * legal bodiless mutation (`DELETE /api/accounts/:id`, logout)
 * inexpressible. The layering that makes this safe: the dedicated header
 * is the unforgeable CSRF leg (applies always), the content type is the
 * JSON-contract leg (§13 speaks JSON) — and the HTML form enctype values are
 * rejected wherever a form must carry them, on a body. The header
 * rejection answers FORBIDDEN with the reason detail; the media-type
 * rejection keeps the registry's default 415 shape (details `null`) —
 * byte-identical to fastify's native `FST_ERR_CTP_INVALID_MEDIA_TYPE`
 * class, so the 415 class has exactly one wire body regardless of which
 * layer rejected (D-113's one-vocabulary rule).
 *
 * This module is the seam for the remaining §15.3 check: task 151's Host
 * allowlist reuses {@link normalizeAuthority} as its comparison yardstick.
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './error';

/**
 * Spec §13's definition of state-changing, single-sited for the §15.3
 * checks (`POST`, `PUT`, `PATCH`, `DELETE`) — the custom-header guard
 * decides over the same set. Uppercase: the HTTP parser delivers methods
 * uppercased, and both classifiers normalize before asking.
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

/**
 * The dedicated nonstandard header §15.3 requires on state-changing
 * requests (task 150, decision D-117): `X-Quotameter-Request` —
 * project-namespaced, purpose-specific, and outside the CORS-safelisted
 * set, so no browser sends it implicitly and no HTML form can send it at
 * all while CORS stays disabled (§13). Exported as the single name
 * source: the UI client, any CLI API use, and tasks 159+/164 set and
 * document the same header through this constant. Only presence (a
 * non-empty value) is required — the value itself is not interpreted
 * ({@link classifyCustomHeaderRequest} explains why that is the whole
 * CSRF property).
 */
export const API_MUTATION_HEADER_NAME = 'X-Quotameter-Request';

/**
 * §15.3's "Accept only `application/json`" — the exact base media type a
 * state-changing request's `Content-Type` must carry (compared on the
 * segment before the first `;`, trimmed and lowercased).
 */
const JSON_REQUEST_CONTENT_TYPE = 'application/json';

/**
 * Why a state-changing request was rejected — the classifier's stable
 * vocabulary. `missing-custom-header` serializes onto the wire as the
 * FORBIDDEN `details.reason`; `non-json-content-type` deliberately does
 * not (the 415 class keeps the registry's default, byte-identical to
 * fastify's native media-type rejection — one wire body per class,
 * D-113), it exists so the hook maps the verdict onto the right
 * `ApiError` and the unit table pins both arms.
 */
export type HeaderGuardReason = 'missing-custom-header' | 'non-json-content-type';

/** The pure verdict of {@link classifyCustomHeaderRequest}. */
export type HeaderDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: HeaderGuardReason };

/** The request signals the custom-header/content-type check decides over. */
export interface HeaderRequestSignal {
  /** HTTP method as delivered (uppercased by the parser). */
  readonly method: string;
  /** Raw {@link API_MUTATION_HEADER_NAME} value; `undefined` when absent. */
  readonly customHeader?: string;
  /** Raw `Content-Type` value; `undefined` when absent. */
  readonly contentType?: string;
  /** Raw `Content-Length` value; `undefined` when absent. */
  readonly contentLength?: string;
  /** Raw `Transfer-Encoding` value; `undefined` when absent. */
  readonly transferEncoding?: string;
}

/**
 * Whether the request actually carries a body, decided exactly where the
 * guard runs (ahead of the parser): any `Transfer-Encoding` (chunked)
 * counts as carrying one — checked first, because RFC 9112 §6.1 makes
 * the framing header win over Content-Length, and the contradictory
 * smuggle shape (a Content-Length beside a Transfer-Encoding) must fail
 * closed into the content-type check, not slip through the zero length;
 * otherwise only the exact `0` is the bodiless request — a non-zero
 * length and any value that is not the canonical zero (leading zeros
 * like `00`, unparsable text, Node's duplicate-header join) count as
 * carrying one, fail closed and transport-aligned: verified on the
 * pinned runtime, fastify treats `Content-Length: 00` as a body present
 * (it then demands a content type), so the guard must not read it as
 * bodiless either.
 */
function requestCarriesBody(contentLength?: string, transferEncoding?: string): boolean {
  if (transferEncoding !== undefined) {
    return true;
  }
  if (contentLength !== undefined) {
    return contentLength.trim() !== '0';
  }
  return false;
}

/**
 * The base media type of a Content-Type value — the segment before the
 * first `;`, trimmed and lowercased, which is the RFC 9110 media-range
 * comparison form (`application/json; charset=utf-8` and
 * `APPLICATION/JSON` are the same type). Everything after the `;` is
 * parameters (fastify's JSON parser ignores the charset; the guard does
 * too). Node joins duplicate headers with `, `, and the joined value
 * (`application/json, application/json`) never equals the single type —
 * a split header cannot smuggle a verdict through, same as the Origin
 * guard's joined-split reads.
 */
function baseMediaType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

/**
 * The §15.3 decision for one request signal — pure, total, and fail
 * closed, in a fixed check order so the rejection class is deterministic
 * (the dedicated header first, then the content type). Safe methods pass
 * untouched (the request carries no mutation to forge); a state-changing
 * request must carry the dedicated header with a non-empty value —
 * presence alone is the CSRF property, because a cross-origin browser
 * cannot set any non-safelisted header without a successful CORS
 * preflight and CORS stays disabled, while the value is uninterpreted (a
 * fixed literal would add no security: a client that can set the header
 * at all is not a form or a cross-origin page) — and, when the request
 * carries a body, a `Content-Type` whose base media type is exactly
 * `application/json`: the three HTML form enctype values (`urlencoded`,
 * `multipart`, `text/plain`) and a header-less body are form-built
 * shapes, and §13 speaks JSON. A bodiless mutation has no payload to
 * type, so the content-type leg does not apply to it (see the module
 * docblock for the empty-body transport class that makes the
 * unconditional reading inexpressible); a bodiless request that still
 * carries a stray Content-Type is likewise the transport's business, not
 * the guard's — verified on the pinned runtime, fastify answers the
 * stray type from its own parser registry (an empty `application/json`
 * body → its empty-body 400; an unregistered type → its native 415
 * through D-113's handler; its default `text/plain` parser accepts the
 * empty body), and the guard deliberately does not adjudicate types
 * there.
 */
export function classifyCustomHeaderRequest(signal: HeaderRequestSignal): HeaderDecision {
  if (!STATE_CHANGING_METHODS.has(signal.method.toUpperCase())) {
    // §13's state-changing definition: GET/HEAD (and any other method)
    // carries no mutation, so the form-forgery question does not arise.
    return { allowed: true };
  }
  if (signal.customHeader === undefined || signal.customHeader.trim() === '') {
    return { allowed: false, reason: 'missing-custom-header' };
  }
  if (
    requestCarriesBody(signal.contentLength, signal.transferEncoding) &&
    (signal.contentType === undefined ||
      baseMediaType(signal.contentType) !== JSON_REQUEST_CONTENT_TYPE)
  ) {
    return { allowed: false, reason: 'non-json-content-type' };
  }
  return { allowed: true };
}

/**
 * The second §15.3 `onRequest` hook the `/api` scope registers
 * (`./index.ts`, task 150) — after the origin guard, so a cross-origin
 * mutation is answered by the Origin verdict first (the layering D-115
 * pins: nothing downstream is consulted for a request an earlier layer
 * already rejected). Same throw-side pattern: the header arm throws
 * `ApiError('FORBIDDEN')` naming the required header (§15.1's
 * "with instructions" shape — the name is public client-bundle
 * knowledge, never a secret); the media-type arm throws the registry's
 * default 415, byte-identical to fastify's native class. Async for the
 * same runtime reason as {@link originGuard}, and also ahead of body
 * parsing — a rejected mutation is never read.
 */
export async function customHeaderGuard(request: FastifyRequest): Promise<void> {
  const decision = classifyCustomHeaderRequest({
    method: request.method,
    customHeader: readHeader(request.headers[API_MUTATION_HEADER_NAME.toLowerCase()]),
    contentType: readHeader(request.headers['content-type']),
    contentLength: readHeader(request.headers['content-length']),
    transferEncoding: readHeader(request.headers['transfer-encoding']),
  });
  if (decision.allowed) {
    return;
  }
  if (decision.reason === 'missing-custom-header') {
    throw new ApiError('FORBIDDEN', {
      message: `The ${API_MUTATION_HEADER_NAME} header is required`,
      details: { reason: decision.reason },
    });
  }
  throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
}
