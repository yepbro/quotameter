# `src/server/` — composition root and HTTP API

The application assembly point (spec §3, §5.6, §13, §15): the process entry
point `main.ts` — runtime gate (Node.js ≥ 22.13.0 by numeric prefix, so a
nightly of a supported line runs while anything below the line refuses;
non-root; task 129, decision D-098), signal wiring, exit codes — and the
lifecycle skeleton `app.ts` (task 060), where components
start in registration order and stop in reverse, realizing the §5.6 shutdown
sequence by construction. `single-instance.ts` (task 074) guards each data
directory with an atomically published lockfile: a second process on the same
data directory refuses to start with an actionable error, a lock left by a
crashed holder (dead pid) is broken automatically, and the lock is released
last, on stop (decision D-017). `shutdown.ts` (task 075) coordinates graceful
shutdown: the polling service registers in-flight operations in a shared
`createInFlightTracker` counter, and the `graceful-drain` component waits for
them — bounded at 10 s by spec §5.6 — when the application stops. The HTTP
listener keeps its own §5.6 bound instead (decision D-109): it stops before
the drain in the documented registration order
(`[lock, storage, graceful-drain, polling, http]`), and `fastify.close()`
already serializes the in-flight-request wait — so `http.ts` races the close
against the same ten-second bound and forces completion
(`closeAllConnections`) when it expires. Registered between storage and the
schedulers, reverse-order teardown yields exactly the §5.6 sequence: stop
scheduling, bounded wait for in-flight work, close storage/checkpoint WAL,
release the lock. Its `onEvent` stream is the seam for the structured logger
(task 072); its timeout clock is injectable for deterministic tests
(decision D-020). `http.ts` (task 146) is the Fastify construction: the §3
plugin set construction owns (`@fastify/static` with the §14.1 SPA fallback,
`@fastify/cookie`; `@fastify/helmet` stays with its configuring task 158 —
D-109 — and `@fastify/rate-limit` is declared but unregistered, superseded by
the services-layer primitive `src/services/login-rate-limit.ts` (156, D-125)),
the §15.5 body limit and
connection/request timeouts, §16's level-gated request logging through the
redacting logger's Pino instance, and the `/api` route seam; the same
factory wraps it as the `http-listener` lifecycle component the application
shell starts and stops, and tests drive through `fastify.inject` without
sockets. The routes live in `src/server/api/` (147–163): `index.ts` is the
registered `/api` scope every Stage-12 endpoint joins, `health.ts`
(task 147) is the first endpoint — the public `GET /api/health` returning
exactly `{"status":"ok"}` (§13), unauthenticated in every auth mode, its
shape enforced by the closed TypeBox response contract in
`src/schemas/api/health.ts` — and `error.ts` (task 148) is the §13 error
envelope every error response answers through: the code registry lives in
`src/schemas/api/error.ts`, while `ApiError` (the throw-side extension
point the auth/CSRF/rate-limit/endpoint tasks reject through), the pure
`classifyApiError` trust boundary (strict unknown→INTERNAL, so no
unvouched message reaches the wire), and the root-scope Fastify error
handler the construction registers live here — also wired as fastify's
`frameworkErrors` callback (router-level rejections bypass
`setErrorHandler` without it) and as the static-serving scope's
containment handler (the `send` library's client 403/404s map onto
`FORBIDDEN`/`NOT_FOUND` instead of a false 500 INTERNAL) — with the
not-found handler's 404 arm, because an unmatched route is not an error
in fastify, and with the api scope's own catch-all route: the
mode-independent unmatched arm for `/api` paths (it outranks the static
wildcard), re-deriving the URI_TOO_LONG class for segments past the
router's parameter bound. `security.ts` (tasks 149/150/151) is the §15.3
request-security seam: the Origin/Fetch-Metadata guard — a pure,
fail-closed `classifyOriginRequest` plus the `originGuard` `onRequest`
hook the scope registers (async by runtime necessity: fastify's hook
runner advances on the returned promise) — rejects cross-origin
mutations through the envelope's `FORBIDDEN` class with a closed
`details.reason` vocabulary, mode-independently by construction (D-115);
the custom-header/JSON-content-type guard beside it (the pure
`classifyCustomHeaderRequest` and the `customHeaderGuard` hook, D-117)
requires the dedicated nonstandard `X-Quotameter-Request` header
(exported `API_MUTATION_HEADER_NAME` — the UI client and every §13
mutation consumer set it) on each of §13's four state-changing methods
and `Content-Type: application/json` on the ones that carry a body (a
bodiless mutation has no payload to type), rejecting as FORBIDDEN
(reason detail) and the registry-default 415 respectively, strictly
after the Origin verdict. Task 151 (D-120) adds the Host allowlist in
the same seam but registers it at ROOT scope in the construction
(`http.ts`), not the `/api` scope: validating `Host` against
`localhost`, `127.0.0.1`, `[::1]`, and the configured host is the one
§15.3 check that must bind frontend routes too (static assets, SPA deep
links, the API-only not-found arm), and root registration makes it the
outermost §15.3 layer by fastify's hook chain (a hostile-Host request
answers the Host verdict before any Origin/header class or handler).
The `createHostAllowlist`/`classifyHostRequest` pair compares authority
NAMES — ports unpinned, because §15.6's recommended SSH tunneling
remaps them freely — and also adjudicates absolute-form request targets
(the router matches their extracted path while `request.url` keeps the
full attacker-controlled URL) plus the RFC 9112 duplicate/missing-Host
rejects the runtime does not enforce itself; the configured host
normalizes into the bracketed wire name (IPv6 binds, both spellings),
a wildcard bind logs one construction-time `warn` beside admitting
only its literal name, and rejections are the envelope's FORBIDDEN
class over a closed five-value reason vocabulary. `auth.ts` (task
152, D-121) is the §15.1 auth-mode selection layer, registered as the
`/api` scope's third hook (after the two §15.3 guards, under the
root-scope Host guard): per request it decides whether authentication
is required over four facts — the configured `auth.mode`
(restart-requiring, captured at construction), the bind's
loopback-ness (`isLoopbackHost`, the single owner), password presence
(read per request: §6.4 classifies `auth.passwordHash` live), and the
§15.1 proxy indicators (`Forwarded`, `X-Real-IP`, any `X-Forwarded-*`,
presence-only and value-blind). `auto` + loopback + no indicator is
passwordless; every other cell with a password demands credentials
through the envelope's 401 class; the proxied passwordless shape
answers §15.1's own 403-with-instructions; the two startup-refused
shapes (`required`/non-loopback without a password, refused by the
config layer) fail closed to 401 if ever constructed anyway. The
`RequestAuthenticator` seam (default: nothing is authenticated, fail
closed) is where the session tasks (154/155) plug request
authentication in — requests carry session cookies, not passwords;
task 153's scrypt verifier (`verifyPassword` in
`services/password-hash.ts`, D-122) is consumed at the login endpoint
that presents the password;
`GET /api/health` opts out through its public route config
(`PUBLIC_AUTH_ROUTE_CONFIG`, inherited by the HEAD twin) — the same
contract the future login endpoint uses. The frontend shell stays
outside the layer: the §14.6 login page must load before credentials
can be presented.
Later: the remaining HTTP API routes and auth/session endpoints
(153–163) and the security-header pass (158) — §15.2's login rate
limiting is not middleware here: it lives in
`src/services/login-rate-limit.ts` (156, D-125), composed by the future
login endpoint. It is the only
layer allowed to wire concrete provider adapters into the registry. `providers.ts` (task 133) is that privilege's first
exercise: `createInitialAccountProvider()` constructs the v1.0 adapter with
production defaults for `init`'s initial-account connection test (spec §5.3
step 6) — the factory constructs and never registers, so the future
bootstrap composition that fills the `ProviderRegistry` is unchanged by it
(decision D-102).

**Rule:** as the composition root it may import every layer except
`src/cli/`. Route handlers validate input through `src/schemas/api/` and
delegate to services; they never touch providers or SQL directly.
