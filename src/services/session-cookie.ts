/**
 * The §15.2 session-cookie attribute layer (task 157, decision D-126) — the
 * fourth §15.2 primitive of the future `AuthService` beside
 * `password-hash.ts` (D-118/D-122), `sessions.ts` (D-123/D-124), and
 * `login-rate-limit.ts` (D-125). Spec §15.2: "Use a random 256-bit session
 * token in a cookie with `HttpOnly` and `SameSite=Strict`; set `Secure` for
 * HTTPS based on the public URL/reverse-proxy configuration."
 *
 * The task-154 mint hands the login endpoint a raw token and the §11.2 row
 * (`createSession`, D-123 — "the raw token's only disclosure, exactly once,
 * to the caller that sets the cookie (157 owns the flags)"); this module is
 * the flags half of that contract: everything the endpoint needs to
 * serialize the `Set-Cookie` header — the cookie's name, the unconditional
 * `HttpOnly`/`SameSite=Strict` attributes, the `Secure` verdict over the
 * request's transport facts, the `Path` scope, and the `Max-Age` mirroring
 * the row's effective expiry — as one frozen attribute object the endpoint
 * spreads into `@fastify/cookie`'s `reply.setCookie` (registered at
 * construction since task 146, D-109). Like its three siblings it owns no
 * endpoint: the login and logout routes are the plan gap D-125 recorded, and
 * every composition below is documented, not wired.
 *
 * Pinned interpretations (D-126):
 *
 * - **"Public URL/reverse-proxy configuration" resolves from the request's
 *   own transport facts, because the configuration contract defines no
 *   public-URL field.** §6.2's schema covers `server` (host/port), `app`,
 *   `auth`, `logging`, providers, accounts — no public URL, no proxy
 *   settings — and §15.1/D-121 already read the reverse-proxy reality per
 *   request (`Forwarded`, `X-Forwarded-*`, `X-Real-IP` presence). The bind
 *   host has **no vote** in the `Secure` decision: a non-loopback bind is
 *   still plain HTTP (§15.6 pins TLS termination at the reverse proxy; the
 *   service itself never terminates TLS, there is no certificate
 *   configuration to load), and stamping `Secure` on an HTTP cookie would
 *   not protect anything — the token rides that same HTTP wire — while
 *   breaking the session bootstrap (a `Secure` cookie is not stored or sent
 *   over plain HTTP). `Secure` therefore mirrors exactly one question: is
 *   the **client-facing leg** of the request HTTPS?
 * - **The client-facing leg is HTTPS iff the socket is TLS or the leftmost
 *   forwarded proto says `https`.** `requestTls` (a directly observed fact)
 *   outranks any header; `X-Forwarded-Proto` (the de-facto header every
 *   documented proxy sets) outranks RFC 7239 `Forwarded` (the
 *   standards-track fallback); in a multi-hop list the **leftmost** element
 *   is the client-facing protocol (proxies append their observation, so the
 *   first element names the originating leg — the same leftmost rule as
 *   `X-Forwarded-For`). Whitespace is tolerated, casing is normalized, an
 *   **empty** value is no evidence (the next source stays consultable),
 *   while a non-empty one is read literally — `https` is HTTPS, anything
 *   else (`http` included) describes a non-HTTPS leg, and with no proto
 *   claim anywhere the answer is the leg the server itself saw, HTTP in
 *   every deployment this service offers. RFC 7239 splitting is
 *   quote-aware (a quoted `for` value may carry `,` or `;` — §5.2's own
 *   example — and neither may cut an entry off its `proto` parameter).
 *   Spoof analysis: a forged
 *   `X-Forwarded-Proto: https` on a direct plain-HTTP request can only make
 *   the attacker's **own** login cookie carry `Secure` — the browser then
 *   refuses to store it over HTTP, a self-inflicted lockout, never an
 *   exposure — and §15.1 (D-121) already forces the password on every
 *   request carrying a proxy indicator, so the header cannot be used to
 *   slide past authentication either. The mirror direction (the review
 *   round's ask, pinned here): a client that prepends a forged `http` to
 *   an append-style proxy's list (`http, https`) downgrades only **its
 *   own** cookie's `Secure` — the leftmost rule keeps answering the
 *   client-facing leg, and an any-`https` rule instead would mislabel
 *   genuine client-HTTP legs and break legitimate logins on HTTP-public
 *   deployments; cross-scheme replay of a downgraded cookie is the
 *   deployment's own exposure to close (§15.6 recommends TLS-only
 *   publication), not a flag this module can heal.
 * - **`HttpOnly` and `SameSite=Strict` are unconditional** — §15.2's own
 *   words attach them to the cookie itself, with no mode, transport, or
 *   deployment exception anywhere in §15. `SameSite=Strict` is what makes
 *   the cookie useless to a cross-site attacker who cannot even cause it
 *   to be sent; `HttpOnly` keeps it out of `document.cookie` (§15.5's
 *   no-inline-script CSP is the belt, this the braces).
 * - **`Path` is `/api`** — §13 mounts every endpoint under the `/api`
 *   prefix, so the cookie never rides a static-asset or SPA-fallback
 *   request; the spec prescribes no path, and `/` would re-attach the
 *   session token to every frontend asset fetch for no consumer.
 * - **`Max-Age` mirrors the row's effective expiry at set time, and the
 *   server-side verdict stays the gate.** The cookie is a client-side
 *   convenience aligned with the §11.2 row: `maxAge` is
 *   `ceil((expiresAt − now)/1000)` whole seconds — rounded **up**, so the
 *   client cookie never dies before the row D-124 judges (an early-dead
 *   cookie logs an owner out of a live session; a late one costs one 401
 *   from the verdict). At login the row expires at the 7-day inactivity
 *   bound (D-123), so the fresh cookie carries `Max-Age=604800`; the
 *   endpoint that re-issues the cookie on a refreshed sighting keeps the
 *   two aligned forever (documented composition, the endpoint's call), and
 *   an endpoint that never re-issues merely caps the cookie at 7 days —
 *   the user re-logs-in, the row's own bounds are untouched. A persistent
 *   cookie (explicit `Max-Age`) over a browser-session cookie is chosen so
 *   the client credential cannot outlive the row by a browser's lifetime.
 * - **The clear variant is the logout cookie** — same name, same
 *   attributes, `maxAge: 0`: `Set-Cookie` with `Max-Age=0` deletes the
 *   client's cookie, and browsers match cookies by name and path, so the
 *   identical `Path` (and the identical attribute set generally) is what
 *   makes the deletion reliably address the cookie that was set. The
 *   logout's own security boundary is server-side — `revokeSession`
 *   (D-124) deletes the row, so a cookie the clear misses is inert (its
 *   next use answers the verdict's 401); the one residual a mixed-scheme
 *   deployment can produce (login over the proxied-HTTPS leg, logout over
 *   plain HTTP) is that the browser's secure-cookie overwrite protection
 *   ignores the non-`Secure` clear and keeps the dead cookie until its
 *   `Max-Age` — client-side hygiene lag only, and a TLS-only publication
 *   (§15.6) cannot produce it; an endpoint that ever supports mixed-scheme
 *   logout may emit both clear variants (with and without `Secure`) over
 *   the same response.
 *
 * Fail-fast discipline (the D-090/D-123 family): a non-integer epoch-ms
 * input throws a `TypeError` naming the field, and `nowMs >= expiresAtMs`
 * throws — setting a session cookie for an already-expired session is a
 * composition error (D-124's half-open verdict would reject the session at
 * its first use), and a non-positive `maxAge` is the *clear* protocol's
 * semantic, not the set protocol's. The module holds no logger (§15.4/§16
 * — nothing here can log a token), no clock of its own (`now` is an
 * explicit argument, D-021), and no fastify import: the attribute type is
 * this module's own, mapping 1:1 onto `@fastify/cookie`'s serialize
 * options at the endpoint.
 */

/* ── The cookie's identity ─────────────────────────────────────────────── */

/**
 * The §15.2 session cookie's name. The spec names no cookie, so the name is
 * D-126's own pin: self-identifying (`quotameter_` prefix) so a user
 * inspecting their browser's cookies knows which service set it, and never
 * a generic `session` that another loopback service could collide with on
 * a shared host name. Frozen and exported so the endpoint, the tests, and
 * the future UI client read one constant.
 */
export const SESSION_COOKIE_NAME = 'quotameter_session';

/**
 * The §15.2 session cookie's `Path` scope — §13's `/api` prefix (D-126):
 * every authenticated endpoint lives under it, and no static asset or SPA
 * route ever needs the cookie. Exported for the same single-siting reason.
 */
export const SESSION_COOKIE_PATH = '/api';

/* ── The transport facts ───────────────────────────────────────────────── */

/**
 * The transport facts one request contributes to the `Secure` verdict —
 * resolved by the caller (the future login/logout endpoint) exactly as
 * §15.1's auth facts are, then handed here whole so the decision is
 * testable without a socket. The resolution recipe (module-docblock
 * contract, not code): `requestTls` is `request.protocol === 'https'`
 * (trustProxy is never enabled in D-109's construction, so Fastify derives
 * the protocol from the socket and no header can fake it); `forwardedProto`
 * is the folded `X-Forwarded-Proto` value; `forwarded` is the folded
 * RFC 7239 `Forwarded` value — Node joins duplicate headers with `, ` into
 * one string, which is exactly the multi-hop list shape the parsers below
 * take. Absent headers are absent fields.
 */
export interface SessionCookieTransportFacts {
  /**
   * Whether the request's own socket is TLS — the directly observed leg.
   * Not a deployment shape the service itself offers (§15.6 terminates TLS
   * at the reverse proxy, and no certificate configuration exists), but
   * the fact that outranks every header when it is true.
   */
  readonly requestTls: boolean;
  /**
   * The raw `X-Forwarded-Proto` value as the request presented it (a
   * comma-separated list under multi-hop proxies is legal and expected);
   * undefined when the header is absent.
   */
  readonly forwardedProto?: string;
  /**
   * The raw RFC 7239 `Forwarded` value (comma-separated entries, each a
   * `;`-separated parameter list); undefined when the header is absent.
   */
  readonly forwarded?: string;
}

/**
 * The leftmost element of a comma-separated `X-Forwarded-Proto` value —
 * the client-facing hop (proxies append, so the first element names the
 * originating leg) — trimmed and lowercased. An empty element answers
 * `undefined`: no evidence. Plain splitting is correct here: the de-facto
 * header's elements are protocol tokens, never quoted strings.
 */
function leftmostListedValue(value: string): string | undefined {
  const first = value.split(',')[0]?.trim().toLowerCase();
  return first === '' ? undefined : first;
}

/**
 * Splits a header value on `separator`, ignoring separators inside
 * double-quoted strings (with backslash escapes kept verbatim — the proto
 * comparison needs no unescaping). The review round's P2 fix: RFC 7239
 * allows any `Forwarded` parameter value to be a quoted string, and §5.2's
 * own example carries a quoted comma list (`for="192.0.2.43,
 * 2001:db8:cafe::17"`), so a plain split would cut an entry mid-quote and
 * lose the `proto` parameter behind it (fail-safe — no false `Secure` —
 * but the wrong answer). An unbalanced quote conservatively quotes to the
 * end, so the rest of the value stays one entry.
 */
function splitRespectingQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '\\' && quoted && index + 1 < value.length) {
      current += character + value[index + 1]!;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * The `proto` parameter of one RFC 7239 `Forwarded` entry
 * (`for=…;proto=https;host=…`), or `undefined` when the entry carries no
 * proto. Parameter names are case-insensitive, parameters are
 * quote-aware-split (a quoted `for` value may contain `;`), and values
 * may be double-quoted (RFC 7239 §6 grammar), so the quotes are stripped.
 */
function forwardedEntryProto(entry: string): string | undefined {
  for (const parameter of splitRespectingQuotes(entry, ';')) {
    const separator = parameter.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== 'proto') {
      continue;
    }
    const raw = parameter.slice(separator + 1).trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    return unquoted === '' ? undefined : unquoted.toLowerCase();
  }
  return undefined;
}

/**
 * Whether the **client-facing leg** of the request is HTTPS — §15.2's
 * entire `Secure` rule (D-126): the TLS socket if the request rode one
 * (direct observation, the strongest evidence), else the leftmost
 * `X-Forwarded-Proto` element, else the leftmost RFC 7239 `Forwarded`
 * entry's `proto` parameter, else the leg the server itself saw — HTTP in
 * every deployment this service offers (§15.6). Pure and total: whitespace
 * and casing are normalized, an empty value is treated as absent (the next
 * source stays consultable), and a non-empty value is read literally —
 * `https` is HTTPS, anything else describes a non-HTTPS leg.
 */
export function isClientFacingHttps(facts: SessionCookieTransportFacts): boolean {
  if (facts.requestTls) {
    return true;
  }
  const forwardedProto =
    facts.forwardedProto === undefined ? undefined : leftmostListedValue(facts.forwardedProto);
  if (forwardedProto !== undefined) {
    return forwardedProto === 'https';
  }
  if (facts.forwarded !== undefined) {
    // The leftmost ENTRY of the RFC 7239 list, split quote-aware — a
    // quoted `for` value may carry commas (§5.2's own example) or
    // semicolons, and neither may split the entry around its `proto`.
    const entry = splitRespectingQuotes(facts.forwarded, ',')[0]?.trim();
    if (entry !== '') {
      return forwardedEntryProto(entry!) === 'https';
    }
  }
  return false;
}

/* ── The attribute objects ─────────────────────────────────────────────── */

/**
 * The complete §15.2 attribute set of one session cookie — this module's
 * own shape, mapping 1:1 onto `@fastify/cookie`'s serialize options (the
 * endpoint's `reply.setCookie(SESSION_COOKIE_NAME, token, attributes)`).
 * `httpOnly`, `sameSite`, and `path` are literal types because they are
 * unconditional pins (D-126); `secure` and `maxAge` are the two facts the
 * transport and the session row contribute. `maxAge` is whole seconds, as
 * the `Max-Age` attribute and `@fastify/cookie` both take it.
 */
export interface SessionCookieAttributes {
  /** §15.2, unconditional: the cookie is invisible to `document.cookie`. */
  readonly httpOnly: true;
  /** §15.2, unconditional: no cross-site request carries the cookie. */
  readonly sameSite: 'strict';
  /**
   * §15.2's HTTPS rule: {@link isClientFacingHttps} over the transport
   * facts (D-126 — the bind host has no vote).
   */
  readonly secure: boolean;
  /** §13's `/api` prefix (D-126): never rides a static-asset request. */
  readonly path: '/api';
  /**
   * Whole seconds until the cookie expires — the row's effective expiry
   * rounded up (D-126), or `0` on the clear variant (logout deletion).
   */
  readonly maxAge: number;
}

/** Options for {@link sessionCookieAttributes}. */
export interface SessionCookieOptions {
  /**
   * The request's transport facts — the same shape the endpoint resolves
   * for the `Secure` verdict (see {@link SessionCookieTransportFacts}).
   */
  readonly transport: SessionCookieTransportFacts;
  /**
   * The session row's effective expiry as UTC epoch milliseconds — the
   * `expires_at` of the `createSession`/refresh result being serialized.
   */
  readonly expiresAtMs: number;
  /**
   * The set instant as UTC epoch milliseconds — the D-021 clock seam (the
   * same explicit-`now` contract as the session module; the endpoint
   * passes the reading it minted or refreshed the row with).
   */
  readonly nowMs: number;
}

/**
 * Builds the login cookie's attribute set — the task-157 primitive the
 * login endpoint spreads into `reply.setCookie` beside the raw token
 * D-123's `createSession` disclosed: `HttpOnly` and `SameSite=Strict`
 * unconditional, `Secure` over the transport facts, `Path` at §13's `/api`
 * prefix, and `Max-Age = ceil((expiresAtMs − nowMs)/1000)` so the client
 * cookie never dies before the row D-124's verdict judges. Frozen. A
 * non-integer epoch-ms input throws a `TypeError` naming the field, and
 * `nowMs >= expiresAtMs` throws — a session already at its expiry is not
 * settable (D-124's half-open verdict would reject its first use; the
 * deletion protocol is {@link clearSessionCookieAttributes}).
 */
export function sessionCookieAttributes(options: SessionCookieOptions): SessionCookieAttributes {
  requireEpochMilliseconds(options.expiresAtMs, 'expiresAtMs');
  requireEpochMilliseconds(options.nowMs, 'nowMs');
  if (options.nowMs >= options.expiresAtMs) {
    throw new Error(
      `session cookie maxAge must be positive: expiresAtMs ${options.expiresAtMs} is not after ` +
        `nowMs ${options.nowMs} — the session is expired (or expires now), and an expired session ` +
        'gets its cookie cleared, not set',
    );
  }
  // ceil: any fractional second of remaining lifetime rounds up, so the
  // client cookie outlives the row's boundary at worst by under a second
  // — never the other way around.
  const maxAge = Math.ceil((options.expiresAtMs - options.nowMs) / 1000);
  return Object.freeze({
    httpOnly: true,
    sameSite: 'strict',
    secure: isClientFacingHttps(options.transport),
    path: SESSION_COOKIE_PATH,
    maxAge,
  });
}

/**
 * Builds the logout cookie's attribute set — the deletion twin the logout
 * endpoint sends after `revokeSession` (D-124): identical name-scope
 * attributes (browsers match cookies by name and path, so the same `Path`
 * — and the same attribute set generally — is what makes `Max-Age=0`
 * reliably delete the cookie that was set), `Secure` over the same
 * transport facts, and `maxAge: 0`. Frozen.
 */
export function clearSessionCookieAttributes(
  transport: SessionCookieTransportFacts,
): SessionCookieAttributes {
  return Object.freeze({
    httpOnly: true,
    sameSite: 'strict',
    secure: isClientFacingHttps(transport),
    path: SESSION_COOKIE_PATH,
    maxAge: 0,
  });
}

/**
 * The D-090/D-123 integrality guard: §11.1 timestamps are integer UTC
 * epoch milliseconds, and a fractional or non-finite value would otherwise
 * reach `Math.ceil` and serialize a silently wrong `Max-Age` instead of
 * failing with the field's name.
 */
function requireEpochMilliseconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `session cookie timestamp '${field}' must be an integer epoch-milliseconds value, got ${value}`,
    );
  }
}
