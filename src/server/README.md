# `src/server/` — composition root and HTTP API

The application assembly point (spec §3, §5.6, §13, §15): the process entry
point `main.ts` — runtime gate (Node.js ≥ 22.13.0 by numeric prefix, so a
nightly of a supported line runs while anything below the line refuses;
non-root; task 129, decision D-098), signal wiring, exit codes — whose
`buildComponents()` (task U-040, decision D-140) now delegates to
`composition.ts`: `composeApplication()` resolves the §6.1 directories,
enforces the §6.3 permissions eagerly (before the file's content is read),
loads and validates through `loadConfigWithEnv` (§6.2's refuse-to-start),
then assembles the §5.6 component list
`[single-instance-lock, storage, http-listener]` with every landed route
family wired — the D-128 `AccountConfigStore` and D-130 `SettingsStore` over
`config-stores.ts`'s serialized config-file owner, the D-064 suspension
holder (`src/services/account-suspensions.ts`) feeding `suspensionOf` and
the manual-test lift, the registry with observation-wrapped adapters
(`providers.ts`, task U-040), and a lazy repository facade bridging eager
route registration to the storage component's start-time open (the data
directory exists only after the lock's start, D-017). Deliberately unwired
(D-140's loose ends): SIGHUP → reload (the D-024 readiness seam), the
sessions-backed `isAuthenticated` (the login endpoints are the recorded
D-125/D-126 gap), and the polling engine. The lifecycle skeleton `app.ts`
(task 060) is where components
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
(decision D-020). `http.ts` (tasks 146/158) is the Fastify construction: the §3
plugin set (`@fastify/static` with the §14.1 SPA fallback, `@fastify/cookie`;
`@fastify/helmet` registered by task 158 with the §15.5 list — D-127 — and
`@fastify/rate-limit` declared but unregistered, superseded by
the services-layer primitive `src/services/login-rate-limit.ts` (156, D-125)),
the §15.5 body limit and
connection/request timeouts, the §15.5 security headers (the strict CSP,
nosniff, and no-referrer on every response — the router-level rejection arm
excepted, D-127 — `Cache-Control: no-store` on API responses via a root-scope
hook on the §13 `/api` boundary, percent-decoded so `/%61pi/health` is an API
path on the wire; every helmet
default the spec does not list is disabled — D-127), §16's level-gated request
logging through the
redacting logger's Pino instance, and the `/api` route seam — whose
route-family dependencies (`HttpServerOptions.routes`, task U-040/D-140)
the composition root supplies beside the auth projection: absent members
stay unregistered (the no-half-wired rule and its 404 pins hold for the
bare construction), present members wire exactly that family to the
composition's stores; the cookie's
§15.2 write-side flags are the services-layer primitive
`src/services/session-cookie.ts` (157, D-126), which the future login/logout
endpoints spread into `reply.setCookie` — the registered cookie plugin stays
parsing-only; the same
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
(159–163) — §15.2's login rate
limiting is not middleware here: it lives in
`src/services/login-rate-limit.ts` (156, D-125), composed by the future
login endpoint. It is the only
layer allowed to wire concrete provider adapters into the registry. `providers.ts` (task 133, extended by
task U-040) is that privilege's first
exercise: `createInitialAccountProvider()` constructs the v1.0 adapter with
production defaults for `init`'s initial-account connection test (spec §5.3
step 6) — the factory constructs and never registers, so the bootstrap
composition that fills the `ProviderRegistry` is unchanged by it
(decision D-102). That same composition (U-040, D-140) now registers the
adapter into the registry wrapped by `observingManualTests()`: manual
connection tests feed the §7.2 suspension holder — release-on-request
before the attempt, re-entry with a fresh 60-minute window on a D-052
`credentials-rejected` rejection, so a successful manual test lifts an
`Auth rejected` pause (wire-observable through `/api/status`), while
`fetchSnapshot` stays unobserved (the polling engine owns polled-cycle
outcomes).

**Rule:** as the composition root it may import every layer except
`src/cli/`. Route handlers validate input through `src/schemas/api/` and
delegate to services; they never touch providers or SQL directly.

## The accounts endpoints (task 159, spec §13, §8.2; decision D-128)

`src/server/api/accounts.ts` registers the five §13 accounts routes inside
the `/api` scope — the first dependency-carrying endpoint plugin: the scope
plugin (`./index.ts`) registers it only when the construction passes
`ApiRoutesOptions.accounts` (the configuration-store seam, the
`QuotaRepository` facade, the `ProviderRegistry`, and the clock), so the
unwired task-146 construction keeps answering the scope catch-all's 404
envelope for `/api/accounts*` instead of a half-wired surface. The scope's
three guards (Origin, custom-header/content-type, §15.1 auth-mode) cover
these routes like every other `/api` route; none is public.

- **`GET /api/accounts`** — the management list: the union of the
  configuration entries and the storage rows, id-ascending, merged into the
  closed `AccountView` contract (`src/schemas/api/accounts.ts`). The
  configuration wins for label/enabled/key state (§6.4's live truth), the
  row for lifecycle and history facts; a configured-not-yet-mirrored
  account reads `status: 'active'` with null history facts, and an archived
  account (whose configuration entry the archive removed) stays listed with
  `enabled: false`, `keySource: 'none'` (§8.2: archive retains identity and
  history).
- **`POST /api/accounts`** — create; the key is write-only. The id is
  client-supplied (the §6.2 charset, shared with the API schema via the
  now-exported `ID_PATTERN` — one pattern, two consumers, D-100's rule) or
  generated (`acc-<16 hex>`, stable from creation). `apiKey` is optional
  (§5.3's "skip the key, add it later"); `apiKeyEnv` is deliberately not a
  request field — binding an account to an environment variable is a
  configuration-file concern (§6.3). Write order: storage row first,
  configuration entry second, with a compensating row delete when the
  configuration write fails (a just-created row carries no history, so the
  compensation is total).
- **`PATCH /api/accounts/:id`** — §13's three mutable fields (label,
  enabled, key; at least one required). An archived account is refused
  (`FORBIDDEN`/`account-archived` — §8.2's archive is terminal, D-061); a
  key change on an `apiKeyEnv`-sourced account is refused
  (`environment-key-read-only`, §6.3's read-only rule). Label changes
  mirror to the row's denormalized copy (best-effort: a configured account
  not yet mirrored has no row to update).
- **`DELETE /api/accounts/:id`** — §8.2's split: archive by default
  (`retireAccount`, idempotent with `already-archived`), purge on exactly
  `?purgeHistory=true` (`purgeAccount`, whose D-061 per-table evidence
  counts ride the response — including the `raw_responses` row count, the
  gate-sanctioned count-only surface, D-128). Both remove the
  configuration entry so polling stops. "Unknown account" is a
  **both-halves verdict** (the review round's P1): an entry without a row
  (a hand-edited account the config-sync has not mirrored, or the residue
  of a purge whose entry-removal failed) is still an account this API
  lists — it archives by its entry removal alone and purges with the
  honest zero-evidence report, so a failed cleanup is always retryable
  through the API instead of stranding a ghost entry behind a 404.
- **`POST /api/accounts/:id/test`** — the provider connection test: the
  key is resolved through the store seam into the registry's branded
  `AccountContext` (non-enumerable secret) and handed to
  `validateCredentials`. The request answers `200` whenever the test RAN,
  with D-052's outcome vocabulary — `ok`, `rejected` (the provider refused
  the key), `unavailable` (inconclusive: transport, an unset environment
  name, or a provider this build lacks) — and the sanitized provider
  message on failure; an unclassifiable provider error escalates to the
  `INTERNAL` envelope, logged server-side. Bounded by the transport's own
  §7.2 deadline; a keyless account is refused
  (`FORBIDDEN`/`no-key-configured`).

**The configuration-side seam (`AccountConfigStore`, D-128):** keys and
the enabled flag live in the configuration file (§6.3 — never the
database), so the endpoints' configuration half is an injected interface —
list/find/add/update/remove/`secretOf` — the D-121 `RequestAuthenticator`
precedent: the routes are complete and fully tested against the seam, and
the production implementation (atomic `writeConfigFile` read-modify-write
plus §6.4's change application) belongs to the composition root that owns
the configuration file and the database. `secretOf` is the only secret
surface — resolved into `createAccountContext` for the connection test,
never echoed, logged, or serialized.

**Write-only keys (§13/§15.4):** every response serializes through closed
TypeBox contracts — the compiled serializer emits exactly the declared keys
and structurally drops any other, so the key cannot leak through a handler
bug (the D-111 health guard, generalized); the mask is the constant
`ACCOUNT_KEY_MASK` (`********`), content-free by construction (no prefix,
suffix, or length derivation), beside §13's `hasKey` boolean. The suites
pin the marker-secret discipline: a created account's key never appears in
any response body across every flow, while the store positively receives
it.

**Strict body validation (D-128):** the plugin compiles its schemas through
a scope-local Ajv with `removeAdditional: false` — fastify's shared default
silently strips unknown body fields, but §13's boundary rejects them (a
payload smuggling `apiKeyEnv` answers `VALIDATION`, not a silent ignore);
`coerceTypes`/`useDefaults`/`allErrors` re-assert the framework's own
defaults so only the stripping changes.

**Error vocabulary:** no new registry codes (D-113 stays frozen for this
task) — endpoint refusals ride the existing classes with stable
`details.reason` values: `unknown-provider`/`duplicate-account-id`/
`blank-api-key` (VALIDATION), `account-archived`/
`environment-key-read-only`/`no-key-configured` (FORBIDDEN), and unknown
ids as NOT_FOUND.

**The write-only-key proof, browser-side (task 171, D-136):** the marker
discipline above pins the server's response bodies per flow; the
composition with the UI is pinned by
`test/integration/accounts-real-surface.spec.ts`, which drives these
routes through the real API client over a full §14.2 session (plus one
refused create) and scans every response body, request URL, and
client-resolved value the browser would see — plus the server-side log
channel (non-empty by construction of the refused exchange). The proof
map's entry point is `ui/README.md` ("The write-only key proof map").

## The §13 status, providers, quota, and settings endpoints (task 160, decision D-130)

Task 160 lands the four read-heavy §13 route families as three endpoint
plugins on the D-128 registration rule — each registers inside the `/api`
scope only when the construction passes its options block, and absent
dependencies leave the paths to the scope catch-all's 404 envelope (the
no-half-wired-surface pin, one test per family).

- **`src/server/api/status.ts`** (spec §13, §7.2, §7.3, §8.4) registers
  `GET /api/status` and `GET /api/quota?accountId=` — the §7.3-facts
  family over one options object. Both routes are read-only composition:
  the status token is task 111's `deriveAccountStatus` over
  `readPollingRunEvidence`, never re-derived here; the quota metrics are
  task 122's `getLatestValidMetricValues` (D-077 — the last **valid**
  value per metric key, per-row collection stamps, an invalid newer row
  never erasing a metric) beside `getLatestSnapshot`'s header facts; the
  account set is the D-128 union of configuration entries and storage
  rows, so an archived account stays visible (`disabled`, its §8.2-retained
  history still served by `/api/quota`). §7.2's "most recent error" is the
  newest non-success run found by six bounded, indexed outcome-filtered
  probes (the D-114 CLI method — no unbounded scan, no facade change), and
  the stored message passes an exact-occurrence redaction of the account's
  resolved secret (§7.4's rule, D-114 made server-side; a marker seeded
  into a stored error renders `[REDACTED]`). Two per-request seams exist
  because their inputs are §6.4-live: `pollingIntervalSeconds` (a reader,
  not a startup constant — the freshness window follows a reload; pinned
  on the wire) and `suspensionOf` (the D-064 suspension the scheduler
  holds; a composition without one passes the unsuspended constant, D-070's
  recorded restart view). `configured` resolves through 159's
  `AccountConfigStore.secretOf` — the same source of truth the connection
  test uses; the resolved value feeds the comparison and the redaction,
  never the response (the closed contracts drop it anyway).
- **`src/server/api/providers.ts`** (spec §13, §9.2) registers
  `GET /api/providers`: the registry listing (available types in
  registration order) joined with the live configuration's peak-hours
  schedules through a per-request `schedules()` reader (§6.4-live again)
  and with each adapter's declared static metric catalog (`metrics`,
  decision D-137 — the `{metricKey, label}` pairs the UI's §14.3 cards
  and §14.4 charts label metrics by; empty for an adapter that declares
  none, and the UI's documented fallback is the raw metric key).
  `peakHours` is `null` when nothing is configured (§9.2's "not
  configured" state, never an invented schedule), the response nests the
  configuration contract's own `PeakHoursConfigSchema` (one schedule
  contract, two consumers — the `ID_PATTERN` sharing precedent applied to
  a whole node), config-only providers are not listed (they are not
  available types — the D-119 doctor case owns reporting them), and
  `requestTimeoutSeconds` stays a file fact (§13 names types and
  schedules).
- **`src/server/api/settings.ts`** (spec §13, §6.2–§6.4, §14.5, §15.2)
  registers `GET`/`PUT /api/settings` — the §6.4 seam. The GET view
  annotates every scalar `{ value, source, restartRequired }`: the
  restart flags are §6.4's closed trio (pinned against D-026's
  `RESTART_REQUIRED_FIELDS` — the done-condition's identification half),
  `source: 'environment'` is the §6.3 read-only marking, `passwordConfigured`
  is the mask-and-boolean for the hash, and the view can structurally
  express no secret (no view object declares one; the closed-contract
  suite pins it). The PUT updates the §6.4 live-applicable vocabulary
  through the D-022 boundary (`validateSettings` over the effective
  configuration → `parseConfig`: the loader's own ranges, enums, and
  cross-field rules with its field-addressed, value-free problems as the
  400 details — the body schema stays deliberately structural so the
  messages stay single-sourced) and refuses three shapes with stable
  FORBIDDEN reasons: `environment-overridden-read-only` (§6.3, checked
  first — the environment wins over the file, the twin of 159's
  `environment-key-read-only`), `restart-required-field` (D-130's literal
  reading of §13's "Update settings allowed for runtime modification":
  `server.host`/`server.port`/`auth.mode` change through the file plus
  `quotameter restart` — §6.4's own remedy — and are _identified_, not
  silently ignored), and `password-hash-not-settable` (D-022: the
  plaintext `auth.password` is the one channel; a client-settable hash is
  a lockout footgun). The configuration half is the third D-121
  consumer-owned seam: `SettingsStore` (`read`/`apply`) is defined here
  and implemented by the composition root over the reloader, the atomic
  `writeConfigFile`, and §6.4's change application — `apply` receives the
  validated merged configuration (omitted sections keep their values, so
  stored account secrets and provider schedules survive a settings PUT;
  D-022's GET-then-PUT warning is structural here: the body cannot even
  name `accounts` or `providers`) plus the pending password to hash. The
  PUT response is D-026's `applied`/`restartRequired` — the latter
  non-empty exactly when a hand-edited pending change (carried by this
  update's reload) differs from the startup configuration, never this
  request's doing. §15.5's "settings must not be writable without
  authentication" rides the §15.1 guard's method-blind rule (D-121) — the
  PUT is exactly as guarded as the GET, and the §15.3 mutation guards bind
  it (missing-header and form-type pins included).

**Error vocabulary:** still no new registry codes (D-113 frozen) —
`NOT_FOUND` for an account unknown to both halves, VALIDATION for schema
and boundary problems (`details.reason: 'invalid-settings'` with the
parser's `problems`), and the three PUT refusals above as FORBIDDEN with
stable reasons; a store failure escalates to the generic INTERNAL
envelope, logged server-side.

**Tests:** `test/unit/api-status-schema.spec.ts` (closed tables, the
§7.3-token and failure-outcome no-drift rows),
`test/unit/api-providers-schema.spec.ts`,
`test/unit/api-settings-schema.spec.ts` (the no-secret closed guard, the
body grammar, D-026 vocabulary drift rows against `RELOAD_FIELDS`),
`test/unit/api-status-view.spec.ts` and `test/unit/api-settings-view.spec.ts`
(the pure compositions), and the three integration suites through the
real `/api` scope over real migrated disposable SQLite databases —
contract shapes, §15.1 authorization paths, error classes, the
done-condition pins, and the §15.4 marker discipline (key, rotated key,
password, and hash never in any response body).

### Review-round folds (still task 160, decision D-130)

One synchronous review round (deepseek-v4.1-flash, APPROVE with 4 P2 / 5
P3) ran before landing; every finding was folded into the same commit. The
shape-changing ones: a supplied-but-**blank-after-trim** field now answers
`VALIDATION`/`blank-value` before any policy refusal (D-022's blank-means-
not-supplied stays the right semantics for interactive prompts, but through
a request body a blank password "change" would otherwise answer success
while changing nothing); `SettingsStore.apply` carries **`sources`** on its
payload — the write-side obligation that the composition's file write skip
the environment-merged fields, or a `QUOTAMETER_*` value would be baked
into `config.json` and silently outlive its variable; the D-128 strict
validator construction lives once in **`src/server/api/validation.ts`**
(`strictValidatorCompiler`; scope-local installation unchanged — 159's
accounts module keeps its frozen copy until its next owning change); and
`/api/quota`'s **plan name** passes the same §7.4 exact-occurrence
redaction as the last-error message (provider-controlled data fields and
transport messages get one rule; the accounts surface's `planName` shares
the exposure and carries the same standing note as its validator copy).
Smaller folds: one clock reading per status response (no account row is
derived against a different instant than its siblings), the compile-time
exhaustive `RunOutcome` no-drift pin, and the attempted-fields ≡
`ENV_OVERRIDES` no-drift row.

## The §13 history and events endpoints (task 161, spec §12, §13, §11.3; decision D-139)

`src/server/api/history.ts` registers the two range-bearing §13 routes
inside the `/api` scope behind the D-128 optional-options rule
(`ApiRoutesOptions.history` — the store seam, the repository, the §6.4-live
retention reader, the clock; absent, both paths keep the scope catch-all's
404). The contracts live in `src/schemas/api/history.ts`; everything is
composition over the landed Stage-10/11 services — nothing here re-derives a
gap, a reset, a bucket, or a retention bound.

- **`GET /api/history?accountId&metric&from&to&maxPoints`** — the metric
  series: retention-aware read (`getMetricSeriesWithRetention`, D-082),
  downsampling to the `maxPoints` budget (D-081/D-090, with the stored
  §12.1 reset instants and the §12.2 gaps fed as boundary data), and §12.2's
  gaps spliced in as explicit `kind: 'empty'` points at the interval
  midpoints. The response carries the series identity (`unit`/`limitType`
  from the newest in-range row, honest nulls when empty — an unknown metric
  key is an empty series, never an error: the vocabulary is adapter-owned
  and served through `/api/providers`), the effective resolution
  (`resolutionMs`, the widest allocated slice width — fractional by
  construction — plus `downsampled` and `sourcePointCount`), and the range
  report.
- **`GET /api/events?accountId&from&to&metric`** — the unified §12.2
  timeline as one time-ordered kind-discriminated array: `reset` (the
  stored `quota_events` with the D-046/D-074 evidence verbatim), `gap`
  (D-075's detector over each metric's valid points), `collection_error`
  (task 120's class-a indicators, message passed the same §7.4
  exact-occurrence redaction as `/api/status`'s `lastError`), and
  `stopped_service` (class-b regions). Without a `metric` filter, the
  last-valid query's key set enumerates exactly the series that can hold
  gaps (a metric with valid points in range necessarily has a last valid
  row). Order: instant-ascending, then a frozen kind rank, then metric key.

**The timestamp rule (D-139, closing D-130's loose end):** the request
`from`/`to` are ISO 8601 UTC strings with a mandatory explicit offset or
`Z` (parsed through `epochMsFromIso`, §10 — offset-less strings are exactly
where an implicit zone would creep in), while every response timestamp is
an epoch-ms integer (the D-128/D-130 vocabulary). The requested and
effective ranges echo as epoch-ms: one format per direction, never a mixed
clock inside one body.

**Retention reporting (§13/§11.3):** D-082's open choice is closed as the
**200-with-report** — a range entirely beyond the horizon answers the empty
series with `range.outcome: 'rejected'` and the horizon named; a partially
older range serves truncated with `effectiveFrom` = the horizon; both arms
share one response contract ("state that in the response" read as the body
report, not the error envelope). The retention window is read per request
(`historyRetentionDays`, the `pollingIntervalSeconds` precedent — §6.4
classifies it live).

**The runs-evidence read:** one margin-widened raw facade read
(`EVIDENCE_MARGIN_MS = 12_180_000` = the widest §12.2 silence judgment
`gapThresholdMs(3600)` plus one worst-case cycle span) supplies the
run-stamped interval timeline the gap detector judges by (D-069's per-run
`interval_seconds`, collapsed to changes) and the bounding records that
anchor task 120's range-edge silences. Raw (un-retentioned) reads for
internal composition are the sanctioned D-082 pattern; pre-horizon rows are
cadence/anchor evidence only — the timeline module clamps its regions to
the range and filters its markers, so nothing out-of-policy is served.

**Error vocabulary** stays D-113-frozen: VALIDATION with stable
`details.reason` values (`invalid-timestamp` + the offending `param`,
`inverted-range`) for malformed/offset-less/inverted ranges, NOT_FOUND for
an account unknown to both halves (archived accounts stay readable, §8.2 —
pinned on the wire), schema VALIDATION for budget violations and smuggled
query fields.

**Review-round folds (kimi/k3.1-pro, REQUEST_CHANGES, 2 P1 / 1 P2):** when
the margin read finds no runs at all, the range sits inside an outage
longer than the margin, and two bounded probes recover the nearest
bounding records wherever they are (`listCollectionRuns {from: effectiveTo,
limit: 1}` — ascending order makes it the nearest at/after — plus
`getLatestCollectionRun` when it precedes the range), so the full-range
hatched region still renders; the downsampler input is the VALID points
only, with the invalid rows re-inserted as their own point entries
(`insertInvalidPointItems`) — an invalid row inside a gap used to glue the
gap's edge points into one segment (nothing straddled the whole interval)
and defeat §13's must-not-be-lost boundary — and the empty-point merge
flushes by the gap's midpoint (timestamp-ordered even when an in-gap entry
passes the midpoint, with a strict gap-start guard for the degenerate 1 ms
gap).

**Tests:** `test/unit/api-history-schema.spec.ts` (closed contracts, kind
unions, the query grammar, and the no-drift rows pinning the schema-layer
literals against `history-downsample`'s budget constants, task 123's
outcome vocabulary, and the status surface's outcome list),
`test/unit/api-history-view.spec.ts` (the pure compositions: parsing,
timeline, views, merge, report, redaction, ordering), and the two
integration suites through the real `/api` scope over migrated disposable
SQLite — history (contract shapes, gap empty points, downsampling with
boundary preservation and extrema equality, the default budget, retention
truncation/rejection/live-read, error classes, §15.1 seam, no-half-wired
404, marker discipline) and events (both §12.1 reset conditions and the
false-positive avoidance through the real detection pipeline, gap threshold
and cadence judgments, failed-cycle evidence with §7.4 redaction,
stopped-region clamping and the pre-range anchor, retention, errors,
authz). The heavy downsampling seeds (120–1501 points) carry explicit
timeouts — the D-094 load-sensitivity family; the 1501-point bulk seed uses
one repository transaction for the same structural rows (the per-cycle
ceremony costs ~40 s there).

## The composition stores and the config-sync (task U-040, spec §6.2–§6.4, §13, §15.2; decision D-140)

`src/server/composition.ts` is the production assembly `buildComponents()`
delegates to (see the module docblock for the full startup sequence and the
deliberately-unwired seams). `config-stores.ts` implements the two
consumer-owned seams over the real configuration file: one
`ConfigFileOwner` serializes every mutation of both stores (accounts and
settings edit the same file), and each mutation is a read-modify-write over
the RAW parsed file JSON — never the environment-merged effective
configuration, whose verbatim persistence would bake `QUOTAMETER_*` values
into `config.json` (D-130's write-side hazard) — validated through
`parseConfigWithEnv` before any byte is written (a mutation that would break
the effective configuration is refused with the pipeline's value-free
problems), written atomically (`writeConfigFile`, D-016), and applied
through §6.4's reload so the last valid configuration stays effective when
anything refuses (§6.2). The accounts store reads list/find/secretOf from
the live effective configuration and resolves `apiKeyEnv` against the
startup environment snapshot; the settings store persists only the mutable
scalars the request attempted (the payload's `attempted` set, D-140 — never
an environment-owned field, never the
sections a PUT cannot own), hashes a supplied `pendingPassword` itself
(`hashPassword`, D-130's obligation), and revokes every session after a
password write (§15.2/D-124, the fail-safe direction). The composition's
reload wrapper runs the config-sync — configured accounts mirrored into
storage rows at startup (post-migrations) and after every reload whose
`applied` includes `accounts` (D-128's pre-sync gap): missing rows are
inserted with the shared clock's stamp, label drift updates the row's
denormalized mirror, and archived rows are never touched (D-061's terminal
archive).

**Tests:** `test/integration/composition.spec.ts` — the done-condition
through the production construction (temp config + SQLite, only the
provider adapter doubled): the previously-404 families answering, the
config-sync across two lifecycles, create/update/archive and settings PUTs
persisting through the real file (secrets present in the file, absent from
every response body and log line, environment-owned fields never baked,
the scrypt hash stored and sessions revoked), the §7.2 suspension shown
`auth-rejected` after a refused manual test and lifted on success, and the
§6.2 startup refusals — plus the unit pins
`test/unit/account-suspensions.spec.ts` and
`test/unit/server-providers.spec.ts` for the holder and the observation
wrapper.
