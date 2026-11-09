# `src/services/` — application services

The domain services (spec §8.1): `PollingService` (Stage 9), `HistoryService`,
`EventService`, `PeakHoursService` (Stage 10), `ConfigService`, and
`AuthService` (Stage 12). Services coordinate adapters (through the provider
registry), persistence (through `QuotaRepository`), and configuration.

Landed: [`config-validation.ts`](./config-validation.ts) — the
settings-validation half of the future `ConfigService` (task 073, decision
D-022). `validateSettings(submission, base?)` is the boundary for externally
supplied settings (`init` answers, CLI flags, future `PUT /api/settings`
payloads): it normalizes loose input (string coercion, blank = not supplied,
secrets verbatim), merges it over the current configuration (§5.3
keep-or-change), and delegates every structural and cross-field rule to the
landed parser (`src/config/load.ts`), so invalid settings surface as
field-specific English problems. A supplied plaintext password is validated
against the §15.2 minimum and returned pending hashing (Stage 12).

Landed: [`password-hash.ts`](./password-hash.ts) — the §15.2 credential
encoding and its verification (task 144 / task 153, decisions D-118 /
D-122), the halves of the future `AuthService` the configuration
schema's `auth.passwordHash` docblock assigns the module.
`hashPassword(password)` derives through `node:crypto`'s async scrypt
with a fresh random 16-byte salt per hash and the frozen, exported
`SCRYPT_PARAMETERS` (`N=2^16, r=8, p=1`, 64-byte key, explicit 128 MiB
`maxmem`), and encodes self-describingly as
`scrypt$N=…,r=…,p=…,keylen=…$<salt base64>$<hash base64>`;
`verifyPassword(stored, candidate)` (task 153) takes the stored hash
exactly as the configuration holds it (`string | undefined` — the
optional `auth.passwordHash` passes straight through), parses the
string strictly (four fields, the one algorithm id, the canonical
parameter grammar, canonical base64, `keylen` consistent with the hash
byte length, `p` inside the exported `VERIFICATION_MAX_PARALLELIZATION`
CPU ceiling), re-derives under the parameters **the string carries** —
never the module constants, so a future cost raise never invalidates
stored hashes — inside the exported `VERIFICATION_MAXMEM_BYTES` memory
ceiling (1 GiB), and compares the derived keys constant-time
(`timingSafeEqual`, equal lengths guaranteed pre-derivation by the
parse). Verification is fail-closed and never throws: an absent,
malformed, or refused stored hash answers `false`, never an error and
never an accept. The §15.2
minimum-length rule stays with the `config-validation` boundary
(`MIN_PASSWORD_LENGTH`); the login endpoint (U-041, D-146,
`src/server/api/auth-routes.ts`) consumes the
verifier — requests carry session cookies, not
passwords, so the §15.1 seam is not a consumer.

Landed: [`sessions.ts`](./sessions.ts) — the §15.2 session-creation half
(task 154, decision D-123): the session twin of `password-hash.ts` inside
the future `AuthService`, minting the cookie token and owning its
storage-only-as-a-digest discipline. `generateSessionToken()` draws 256
bits of `node:crypto` randomness into the **base64url** wire form (43
unpadded URL-safe characters — D-056's recorded precondition: a hex wire
form would be shape-identical to the digest, so the raw token stays
structurally distinguishable from anything the `sessions` table can
hold); `hashSessionToken(token)` reduces the wire string to the SHA-256
hex digest — the lookup-key transform task 155's authenticator applies
per request (`cookie value → digest → row`, no decode step);
`effectiveSessionExpiry(createdAt, lastSeenAt)` is the single site of
D-056's formula `min(last_seen + 7 d, created + 30 d)`, computed from the
schema's own exported constants so writer and CHECKs cannot drift (task
155's sighting refresh reuses it); `createSession({ repository, now })`
mints, digests, and inserts the §11.2 row through the task-088 facade
(`last_seen_at` born equal to `created_at` — login is the first sighting
— expiry at the tighter 7-day bound) and returns `{ token, session }`:
the raw token's **only** disclosure, exactly once, to the caller that
sets the cookie (157 owns the flags). The module holds no logger (the
§15.4 "never in logs" rule is by construction, executably pinned), is
synchronous like the repository it writes through (D-058), takes its
clock as an explicit `now` argument (D-021), propagates repository
failures unchanged, and retries no mint — a 2^256 primary-key collision
is an event retry ceremony cannot make more testable.

The task-155 request-side half (decision D-124) joins it in the same
module: `authenticateSession({ repository, token, now })` is the
per-request §15.2 verdict the future `RequestAuthenticator` composition
consumes — digest the presented cookie, look the row up, judge
`expires_at` on **half-open validity** (`[created_at, expires_at)`: a
request at exactly the expiry instant is rejected, one ms before it is
accepted — D-124's pinned reading, the one under which every accepted
sighting refreshes to a strictly future expiry; the verdict's test is
the interval's upper endpoint alone, and a regressed clock reading
before `created_at` is accepted with its refresh shrinking the expiry —
fail-closed, pinned by test), and on the valid arm
record the sighting through `touchSession` +
`effectiveSessionExpiry`, so the 7-day inactivity window slides to
`now + 7 d` while the 30-day absolute cap never extends. The verdict
variants carry the evidence: `expired` names which §15.2 bound fired
(`inactivity` or `absolute`, read off the row's own expiry), `unknown`
is the single fail-closed answer for every absent row (never minted,
logout-revoked, password-revoked, cleaned up — storage cannot tell them
apart and the 401 must not try), and a refresh that finds the row gone
downgrades to `unknown` (a revocation beats an in-flight sighting — the
passwd CLI's separate database connection makes the arm live
cross-process, not defensive). The
verdict never deletes — §11.3's cleanup (D-061) owns expired-row
deletion. `revokeSession({ repository, token })` is the logout
revocation: digest the token, delete the one row, answer whether one
existed (idempotent); password-change revocation lives in the two
password-change paths — `revokeAllSessions` in `src/cli/passwd.ts` and
the settings store's pre-mutation call (`src/server/config-stores.ts`),
both over the facade's `deleteAllSessions` in the fail-secure order of
D-184 (a service wrapper would only forward one facade
call). Fake-clock tests pin both rules and both revocations over a
behavioral stub (`test/unit/sessions.spec.ts`) and the canonical schema
(`test/integration/sessions-authentication.spec.ts`); the login/logout
endpoints landed with task U-041 (`src/server/api/auth-routes.ts`,
D-146) and the cookie's wire attributes with task 157
(`session-cookie.ts` below).

Landed: [`login-rate-limit.ts`](./login-rate-limit.ts) — the §15.2 login
rate budget (task 156, decision D-125), the third §15.2 primitive of the
future `AuthService` beside the credential and session modules:
`createLoginRateLimiter()` holds one in-process map from an **opaque
source key** (never parsed — the endpoint decides what "source address"
means on the wire) to that source's retained failure history, and answers
the two questions the login endpoint (U-041, D-146) asks per attempt.
`delayBeforeAttempt(source, now)` — read-only — is `0` while fewer than
five failures sit inside the **sliding** 15-minute window (half-open: a
failure exactly window-old is out, D-124's boundary discipline; a fixed
bucket would let five failures straddle an edge as neighbors), otherwise
the increasing §15.2 delay `1 s × 2^(n−5)` capped at the window length —
**delays, never rejections** (§15.2's own word: the endpoint sleeps, then
processes, so a legitimate user who mistypes five times still logs in,
later, while a serially attacking source's guessing collapses to the
delay cadence — the endpoint holds the cadence under concurrency by
serializing per source, D-125's consequence for that task).
`recordAttempt(source, 'failure' | 'success', now)` reports the outcome:
a failure appends its stamp (pruning what the window expired), a success
**deletes the history** — a verified password ends the guessing, the
budget resets. The delay is computed from history, before verification
(§15.2 budgets _failed_ attempts), so the endpoint's
check-then-record ordering is the honest one. **Memory is bounded with
behaviorally exact counting**: per source only the newest
saturation-count stamps are retained, and the retention trim sorts by
stamp value first, so the retained set is always the largest stamps by
value whatever the clock did (in-window-ness is monotone in stamp
value, the bounded count is exactly `min(k, bound)` of the unbounded
history's `k`, and both sides of that `min` answer the capped delay at
and above saturation — so truncation is invisible for every count and
every clock reading, pinned against the raw formula including a
regressed-clock trim case), and a sweep at most once per window drops
fully-expired
sources (the map never exceeds the sources active in roughly the last
two windows; the deletion side is behaviorally invisible under a
non-regressing clock by the same argument, the keep side is pinned). The module owns **no timers**
(delays are returned numbers; the sleep is the endpoint's), **no
logger** (§15.2's "log failed attempts at `warn` without logging
passwords" is the endpoint layer's contract: one `warn` record per
failed attempt carrying source and outcome only — never the candidate
password, the stored hash, or any session token), and **no clock of its
own**: `now` is an explicit argument (D-021), fails fast on non-integer
readings before any state change (the D-090 family), and a regressed
reading is trusted — it can only widen the counted window, the
fail-closed direction. Restart clears every budget (in-memory state by
design). Fake-clock tables in `test/unit/login-rate-limit.spec.ts`
(23 tests) pin the five-failure budget with undelayed attempts 1–5, the
exact doubling sequence and cap, the ±1 ms window edge, per-source
isolation, the success reset, the retention exactness, the sweep, the
clock discipline, and the zero-console pin; the login endpoint that
composes this primitive landed with task U-041
(`src/server/api/auth-routes.ts`, D-146 — check-budget → sleep → verify
→ record, per-source serialized; the `@fastify/rate-limit`
dependency is removed — D-143: the generic per-request 429 limiter
cannot express a failed-attempt budget with increasing delays, and no
other spec sentence asks for a per-request limit).

Landed: [`session-cookie.ts`](./session-cookie.ts) — the §15.2
session-cookie attribute layer (task 157, decision D-126), the fourth
§15.2 primitive of the future `AuthService` beside the credential,
session, and rate-budget modules: everything the login/logout endpoints
(task U-041, D-146 — `src/server/api/auth-routes.ts`) need to serialize
the `Set-Cookie` header, as one frozen
attribute object spread into `@fastify/cookie`'s `reply.setCookie`
(the plugin task 146 registered for parsing). `SESSION_COOKIE_NAME`
(`quotameter_session`) and `SESSION_COOKIE_PATH` (`/api` — §13's prefix;
the cookie never rides a static-asset request) pin the cookie's identity;
`HttpOnly` and `SameSite=Strict` are unconditional (§15.2's own words,
no exception cells); **`Secure` mirrors exactly one question — is the
client-facing leg of the request HTTPS?** (`isClientFacingHttps` over
`SessionCookieTransportFacts`): the request's own TLS socket, else the
leftmost `X-Forwarded-Proto` element, else the leftmost RFC 7239
`Forwarded` entry's `proto` parameter, else HTTP — the leg the server
itself saw, because §15.6 terminates TLS at the reverse proxy and no
certificate configuration exists. The configuration contract defines no
public-URL or proxy field, so the spec's "public URL/reverse-proxy
configuration" resolves from the request itself (D-126), and the bind
host has no vote: a non-loopback bind is still plain HTTP, and `Secure`
on an HTTP cookie protects nothing while breaking the session bootstrap.
A forged `X-Forwarded-Proto: https` on a direct plain-HTTP request can
only make the attacker's own cookie unusable (§15.1/D-121 already force
the password on every proxied request). `sessionCookieAttributes({
transport, expiresAtMs, nowMs })` maps the row's effective expiry to
`Max-Age = ceil((expiresAt − now)/1000)` — rounded up so the client
cookie never dies before the row D-124's verdict judges; the server-side
verdict stays the gate, and re-issuing the cookie on a refreshed sighting
is the endpoint's documented composition (without it the cookie merely
caps at 7 days — a re-login, never an out-of-bounds session; U-041/D-146
resolved the open point as the no-re-issue arm — the endpoints'
`auth-routes.ts` never re-issues, the §15.2 verdict is the boundary).
Fail-fast:
a non-integer epoch-ms input throws a `TypeError` naming the field (the
D-090/D-123 family), and `nowMs >= expiresAtMs` throws — an
already-expired session gets its cookie **cleared** (`clearSessionCookieAttributes`,
`Max-Age=0` with identical attributes, so the deletion addresses the
cookie that was set), never set. The module owns **no endpoint** (the
login/logout routes live in `src/server/api/auth-routes.ts`, U-041/D-146
— every composition
above is consumed there) and **no logger** (nothing here can log a
token; the zero-console pin holds executably). The pure tables live in
`test/unit/session-cookie.spec.ts`; the wire half — the attribute set
serialized through the real `@fastify/cookie` on the task-146
construction, under the plain-HTTP, proxied-HTTP, proxied-HTTPS,
`Forwarded`-proto, and direct-TLS setups, plus the value's verbatim
round-trip — lives in `test/integration/session-cookie.spec.ts`.

**Rule:** may import `src/schemas/`, `src/util/`, `src/config/`, the provider
core (`src/providers/` root, never a concrete adapter), and `src/storage/` —
never `src/server/` or `src/cli/`.

Landed: [`polling-outcomes.ts`](./polling-outcomes.ts) — the provider error
classification (task 105, decision D-048): the pure seam mapping task 104's
transport failures and adapter parse outcomes to the §11.2 collection-outcome
enum (D-034's `collection_runs` CHECK vocabulary) with the §7.2 metadata
(retained HTTP status, raw `Retry-After` passthrough and its 429-only
eligibility, within-cycle retryability) and the §7.3 status-priority input
(the precedence-ordered failure contributions task 111 consumes). A caller
abort classifies as the unpersistable pseudo-outcome `'cancelled'`. The
within-cycle retry policy (106, [`polling-retry.ts`](./polling-retry.ts))
consumes this module's `retryable` flag; `Retry-After` scheduling (107),
run persistence (110), and state derivation (111) consume its output as
data.

Landed: [`polling-retry.ts`](./polling-retry.ts) — the §7.2 within-cycle
retry/backoff (task 106, decision D-059): `runCycleWithRetries(attempt,
options)` wraps one collection-cycle attempt (the polling service's single
`fetchSnapshot` call) and retries network failures, timeouts, and HTTP 5xx
up to three times with delays of 2, 4, and 8 seconds plus a uniform 0–500 ms
jitter (`RETRY_BASE_DELAYS_MS`, `RETRY_JITTER_MAX_MS`, pure `retryDelayMs`).
Eligibility is not re-decided: it is `classifyTransportError(error).retryable`
from `polling-outcomes.ts` — exactly §7.2's retryable set, so 429, 401/403,
and parse defects report immediately with one attempt. The result object
`{ ok, value | error, attempts }` never throws for provider failures and
carries the total attempt count (1–4) that §11.2's `collection_runs.attempts`
persists (task 110); a caller abort interrupts the backoff and surfaces as
`TransportAbortError` (105's `'cancelled'`). The randomness and sleep seams
are injectable; the per-attempt §7.2 timeout stays with the transport
(D-042) — a timed-out attempt is just another retryable failure.

Landed: [`polling-retry-after.ts`](./polling-retry-after.ts) — the §7.2
`Retry-After` half of the HTTP 429 row (task 107, decision D-062): after a
rate-limited cycle — which 106's wrapper already leaves un-retried —
`deferNextPoll(classified, nowEpochMs)` defers the account's next poll to
the provider-indicated time, capped at one hour
(`RETRY_AFTER_MAX_SECONDS`, the same bound `collection_runs`'
`retry_after_seconds` CHECK enforces). The pure
`parseRetryAfter(raw, nowEpochMs)` underneath parses RFC 9110's two forms —
delta-seconds (`1*DIGIT`, ASCII-only) or HTTP-date (IMF-fixdate plus the two
legacy obs-date formats, via Luxon `fromHTTP` in UTC, with §5.6.7's sliding
50-year rule applied to RFC 850 two-digit years) — after stripping HTTP
whitespace (SP/HTAB/CR/LF; wider Unicode whitespace is malformed).
The three §7.2 failure modes are decisions, not crashes: malformed values
produce no deferral (normal interval, `NULL` persisted), past HTTP-dates
clamp to zero seconds, and excessive values — including magnitudes no double
can represent — cap at 3600 s with `capped: true`; date quantization rounds
up so the wait never ends before the indicated instant. The eligibility gate
lives inside the entry point (105's `retryAfterEligible`, 429-only — a 503
carrying the header was retried in-cycle instead). Time is an argument
(D-021); the scheduler (109) gates on `notBeforeEpochMs` and the run writer
(110) persists `seconds` (NULL when not deferred).

Landed: [`polling-suspension.ts`](./polling-suspension.ts) — the §7.2 HTTP
401/403 row's pause half (task 108, decision D-064): a pure state machine
that suspends an account's normal polling after an auth-rejected cycle
(until the key changes or a manual test is requested) and paces the
once-per-60-minutes verification probe (`AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS`).
Transitions are `(state, event, nowEpochMs)` → `(next state, effect)`:
`applyCycleOutcome` (an `auth_error` enters or re-arms suspension, a
`success` releases, every other outcome is a pinned no-op — an inconclusive
probe proves nothing about the key), `applyKeyIdentity` (the key-change
release event: the caller reports an opaque key identity and the machine
compares identities, never key material), and `applyManualTestRequest` (the
manual-test release event). `admitVerification` is the gate the scheduler
(109) requests automatic attempts through — granted only at/after the armed
instant (the boundary admits), re-armed a full window at admission, monotone
within an episode, and carried across releases as an admission floor, so
two automatic attempts can never be closer than 60 minutes whatever the
caller does (lost outcomes, duplicate rejections, clock regressions); the
run writer (110) persists each probe cycle and the status derivation (111)
consumes the `Auth rejected` contribution 105 already attaches. Time is an
argument (D-021); the caller holds the (frozen) state object.

Landed: [`account-suspensions.ts`](./account-suspensions.ts) — the single
D-064 suspension store (task U-040, decision D-140; the single-holder
unification FSM-3, decision D-189): one per-account map over the landed
transitions that the composition shares with every D-064 consumer — the
status routes' `suspensionOf` seam, the manual-test flow, the
key-observation flow, and (since FSM-3) the polling scheduler's own
dispatch gates. `manualTestRequested` applies the unconditional
release-on-request, `manualTestRejected` feeds the outcome seam (re-entry
with a fresh 60-minute window, under the tested key's identity), and
`reportKeyIdentity` feeds the key-change release on every configuration
observation (idempotent by D-064's design, returning whether it released —
the scheduler's re-anchor condition), so a successful manual test lifts an
`Auth rejected` pause, a refused one keeps it, and a key rotation releases
it without a test. `polledCycleOutcome` is the ONE application a settled,
non-stale cycle classification gets (the scheduler's settle path calls it
behind its mid-flight staleness check), `admitVerification` is the
scheduler's probe gate (a granted admission persists its re-armed window in
the store), and `dropAccount` drops an account's episode when it leaves the
polled set (the restart equivalence). `keyIdentityOfSecret` is the single
identity vocabulary (sha256 of the resolved secret) every observation
shares. Unit-pinned in `test/unit/account-suspensions.spec.ts`; the
wiring-level lockstep (every event source against the real scheduler) in
`test/unit/polling-suspension-lockstep.spec.ts`.

Landed: [`polling-status.ts`](./polling-status.ts) — the account status
derivation (task 111, decision D-070): `deriveAccountStatus(input,
nowEpochMs)` computes the primary displayed status of §7.3/§14.6 — the six
ranked states (`Auth rejected`, `Format changed`, `Unreachable`, `Stale`,
`Collecting`, `Fresh`) plus `Disabled` and `Not configured` as separate
states — from the evidence the pipeline already produces: 105's
`STATUS_CONTRIBUTION_BY_OUTCOME` for the failure ranks (a 429 or success
contributes nothing and falls through to the age states), the D-064
suspension state for rank 1 (an inconclusive probe while suspended keeps
`Auth rejected`; a latest `auth_error` run covers the restart/release
window for one cycle), and the age of the latest success — or of the first
attempt when none exists — against three configured intervals. The
configuration inputs are caller-resolved booleans: `enabled`
(config §6.2) and `configured` (a usable secret: `apiKey` set or a set
`apiKeyEnv` variable). `readPollingRunEvidence(repository, accountId)` is
the storage seam — the three D-058 lookups designed for this consumer
(latest cycle, latest snapshot's §8.4 stamp as the last success, oldest
run as the no-success `Stale` anchor) frozen into one evidence object.
Time is an argument (D-021); the §13 `/api/status` route, §5.2's
`quotameter status` (landed: task 142's handler in
[`../cli/service-status.ts`](../cli/service-status.ts), which passes
`INITIAL_SUSPENSION_STATE` and resolves `configured` against its own
environment per D-114), and §14.3's overview are the consumers.

Landed: [`polling-persist.ts`](./polling-persist.ts) — the run writer behind
the scheduler's settle seam (task 110, decision D-069):
`createCycleRecorder({ account, provider, repository, clock, intervalSeconds })`
produces one account's D-066 closures: `attempt(signal)` stamps the
cycle's wall-clock start (§7.1's actual collection timestamps) and makes the
raw `fetchSnapshot` call D-059's wrapper needs unwrapped;
`settleCycle(result)` classifies the retried cycle with task 105, persists it
through `persistCollectionCycle` (D-060's §11.1 transaction — one
`collection_runs` row per cycle, the snapshot with its metric rows only for a
successful one, the §7.4 sanitized payload beside a parse-error run), and
returns the classification the engine gates on; `abandonCycle()` drops the
start stamp when the wrapper itself threw and no settle can ever come —
the engine's notification hook (U-035, D-169) without which a thrown
wrapper's stamp bled into the next run row's `started_at`. A provider-level
success whose value fails §8.4 validation (the seam's input is `unknown`)
becomes a `parse_error` run without a snapshot; a caller abort classifies
`'cancelled'` and is deliberately unpersisted (service lifecycle — §12.2's
no-record class); an error outside both taxonomies throws, contained per
§7.2. Since U-035 (D-169) a successful run retains the snapshot's optional
transport evidence — the delivered 2xx of the exchange that produced it —
as §11.2's `http_status`, through the same classification the failure
statuses ride. The adapter parse failure is recognized structurally
(`reason`/`sanitizedPayload`/`httpStatus`/`contentType`, plus the
envelope-encoded rejection facts `envelopeCode`/`envelopeMessage` whose
401/403 arm classifies as auth — U-061/D-210; the layout forbids importing
the adapter island), its observed `Content-Type` rides the §7.4
payload as §11.2's raw-response "content type",
`retry_after_seconds` is `deferNextPoll`'s decision at the settle
reading (D-062: seconds only for a deferred 429, `NULL` otherwise),
`intervalSeconds` is read at settle (§11.2's "interval in effect"), and §12.1
reset-event detection (tasks 117/118) plugs into the success write's empty
`events` array. The one-file widening of D-067's raw-payload gate for this
write-side composer is recorded in D-069. The recorder is composed into
the running service per pollable account by
[`../server/polling.ts`](../server/polling.ts) since U-051 (D-176), whose
settle wrapper adds the contained-failure diagnostics around it (the D-064
feed is the scheduler's own settle-path application to the shared store
since FSM-3/D-189).

Landed: [`polling-scheduler.ts`](./polling-scheduler.ts) — the §7.1 polling
loop engine (task 109, decision D-066): `createPollingScheduler(options)`
runs one dispatch loop over per-account state — each account's first poll
fires immediately, accounts are polled sequentially with a random additive
jitter of up to 10% of the configured interval (`pollingDelayMs`,
§7.1-validated `intervalMs`), and per-account overlap is structural (an
account with a live cycle is never dispatchable, and only one cycle starts
at a time). A cycle unsettled past `cycleHangThresholdMs` (default 255.5 s
— §7.2's own worst-case cycle) is skipped for dispatch so one hanging
closure cannot starve the other accounts, while its account still never
runs a second cycle. Next-poll dues live on the monotonic clock (§7.1);
the wall clock feeds only the epoch-expressed gates — the D-062
`Retry-After` `notBeforeEpochMs` (every dispatch, manual tests included)
and the D-064 suspension cadence (hourly verification probes through
`admitVerification`, releases by key change via `setAccounts`, manual test
via `requestManualTest`, or a successful probe). Each account is an
injectable closure set: `attempt(signal)` (the raw fetch, wrapped in
D-059's `runCycleWithRetries` by the engine, seams passed through) and
`settleCycle(result)` — task 110's classify+persist seam, whose returned
D-048 classification drives every scheduling decision; a throwing seam is
contained (the account reschedules on the plain interval, §7.2 isolation) —
plus the optional `abandonCycle()` hook the engine invokes when the wrapper
itself threw, so a never-settling cycle leaves no per-cycle state behind
(U-035/D-169).
`setAccounts`/`setIntervalMs` handle mid-run changes (added accounts poll
immediately; a key change mid-flight discards the stale cycle's outcome —
an old key's 401 never suspends a new key; interval changes re-anchor);
`requestManualTest` owes the account one attempt — a flag consumed at
dispatch, so it survives an in-flight cycle and an interval change, and
still respects the `Retry-After` gate; `manualTestRejected` (additive,
D-176) is the engine-side half of a refused manual test — the D-064
re-entry is the observation wrapper's single application to the shared
store (`src/server/providers.ts`), while the engine drops any still-owed
attempt, so §7.2's pause holds on the engine side of a refused manual test.
The engine carries no suspension state of its own (FSM-3, D-189): the
required `suspensions` option is the one `AccountSuspensions` store, read
by every gate and written by every transition above — including the
leave-the-polled-set drop and the admission re-arm — so dispatch gating and
`/api/status` cannot diverge. `stop()` is §5.6's stop-scheduling —
abort every live flight, resolve promptly — with the optional structural
in-flight tracker (D-020) for the server's graceful drain; a wiring-level
loop failure is retained and observable (`running` turns false, `stop()`
re-surfaces the error, and — since FSM-4, D-192 — exactly one `error`
record fires at the moment of death through the injected logger), and
every wake is sliced to `MAX_WAKE_MS` (one hour) so a wall-regressed gate
wait can never busy-spin. The scheduler is
composed into the running service — the shared clock, the shared tracker,
one recorder per pollable account, and (since FSM-1) the shared redacting
logger for `debug`-level plan-transition diagnostics (its `error` half
carrying the loop-death record since FSM-4) — by
[`../server/polling.ts`](../server/polling.ts) since U-051 (D-176):
`src/server/composition.ts` registers it in the documented §5.6 order and
feeds `setAccounts`/`setIntervalMs` from §6.4 reloads; the composition
also surfaces the engine's live `running` getter to the authenticated
`/api/health` diagnostics (D-192).

Landed: [`polling-phase.ts`](./polling-phase.ts) — the dispatcher's
explicit per-account phase model (task FSM-1, decision D-190, the D-066
successor): the entry's scheduling state is one held `PollPlan` value —
`scheduled` (a monotonic due behind the D-062 wall gate) or `manual-owed`
(one operator attempt due now, carrying the dormant normal schedule beside
the owed marker) — moved only by `nextPlan(plan, event)`, a pure
transition table over an explicit event union (`key-released`,
`cycle-settled`, `contained-failure`, `manual-test-requested`,
`manual-test-rejected`, `interval-changed`, `dispatched` — the single
consume site of an owed attempt — plus `initialPlan` for §7.1's immediate
first poll), where every row mirrors the D-066 field mutation it replaces
(nothing invented, and the clock readings and jitter rolls drawn only
where the old code drew them — the re-anchor arguments reach the table
only when a consuming row will read them). Per dispatch pass the engine derives the
observed `PollPhase` — `pollPhaseOf({plan, flight, suspension, wall,
mono})`, a pure projection folding in live-flight membership (with the
sticky D-066 hang flag) and the D-064 state **referenced from the shared
store, never copied** — and the dispatcher switches over it exhaustively
with compile-time totality: adding a phase without a dispatcher arm is a
compile error, never a missed gate (the U-028/P2-3 bug class). The
standing proofs are the golden parity suite
`test/unit/polling-phase.golden.spec.ts` (decision traces captured from
the pre-refactor engine, byte-identical after), the property suite
`polling-phase.property.spec.ts` (no per-account overlap under generated
command scripts, a hung account never starving the others, owed survival,
the unconditional gate over all three attempt kinds, the
never-dispatchable flight), and the table spec
`polling-phase.spec.ts`.

Landed: [`peak-hours-intervals.ts`](./peak-hours-intervals.ts) — the §9.3
peak-hours interval calculation (task 114, decision D-073): a validated
`PeakHoursConfig` (§9.2 contract, never re-validated) plus a half-open
`[from, to)` epoch range map to a `PeakHoursTimeline` that partitions the
range — peak intervals with exact UTC epoch-ms boundaries, `windowId`,
`name`, `multiplier`, and both boundaries as `yyyy-MM-ddTHH:mm` local
times in the schedule zone, plus the off-peak complement carrying
`offPeakMultiplier`. The walk runs on the zone's local calendar days
(anchored and count-bounded, one guard day early for `24:00` windows),
sorts peaks by `(start, end)` and union-clips each start to the
uncovered stretch (D-079: the §9.3 gap shift is not monotone in wall
order, so wall-disjoint windows can overlap in instant space), and every
wall-clock→instant conversion goes through the injectable
`LocalInstantResolver` seam — the single §9.3 DST-policy siting point —
whose default since task 115 is `resolveLocalInstantDst`
([`peak-hours-dst.ts`](./peak-hours-dst.ts)). D-021 discipline
throughout: the `resolveTimeZone` gate, the `zonedDateTime` bridge, no
machine zone or clock. Fail-fast on non-finite or inverted ranges, spans
beyond 3660 local days, and non-IANA zones; `from === to` yields an empty
timeline. Scoped coverage is 100% (the §17.3 peak-hours target), and the
suite is green under `TZ` = UTC, America/New_York, Pacific/Kiritimati,
and Asia/Kathmandu.

Landed: [`peak-hours-dst.ts`](./peak-hours-dst.ts) — the authoritative
§9.3 DST resolution (task 115, decision D-079): `resolveLocalInstantDst`
computes the policy explicitly by offset differencing through the D-021
`zonedParts` bridge — candidate offsets probed ±1 day around the
reading, occurrences verified by exact wall-clock round-trip, the
**first occurrence** for ambiguous times being the earliest verified
instant, and nonexistent local times shifting forward by the exact gap
delta (the pre-transition offset's instant). A dedicated implementation
rather than a pinned Luxon default because Luxon's algorithm is a
convergence from a now-seeded offset guess, not policy; Luxon stays as a
compat path with whole-matrix parity plus one pinned carve-out (`24:00`
of a gapped-midnight day double-shifts under Luxon — `Pacific/Apia`
2011-12-30 among the pinned cases). The matrix walks §17.1's seven named
zones plus `America/Havana` (midnight gap), `Asia/Singapore` (§9.1
production), `Asia/Sydney`, and `Pacific/Apia`, with an exhaustive
every-minute transition-day check against an independent brute-force
oracle; scoped coverage of both peak-hours modules is 100% (§17.3).

Landed: [`history-gaps.ts`](./history-gaps.ts) — the §12.2 collection-gap
detection (task 119, decision D-075): a pure seam mapping successful
metric points (§8.4 identity: account, metric, collection time) plus the
effective-interval source to `CollectionGap` records. A gap is an elapsed
interval strictly greater than three effective polling intervals (the
spec's "exceeds"), where the effective interval is the configured seconds
plus §7.1's 10% jitter allowance (`effectivePollingIntervalMs`, sourced
from the scheduler's single `POLLING_JITTER_FRACTION` constant); a pair's
cadence is the earlier point's interval, widened to the span's most
permissive interval when a change lands between the two points, so a
legitimate D-066 re-anchor grow never false-flags as a gap. Successful
points only — edges exist only between observed points — grouped by
account and metric with deterministic output order and fail-fast
validation against the scheduler's §7.1 bounds. No storage, no clock
(D-021); task 120's timeline consumes the gaps as data.
Landed: [`events-detection.ts`](./events-detection.ts) — the §12.1
conservative quota-reset detection (task 117, decision D-074): a pure
seam mapping consecutive valid points of one (account, metric) series to
`RESET` events. Condition 1 (value evidence: usage falls, remaining
rises) is judged jointly across every carried field pair with the D-074
tolerances (0 absolute, 1 percent — D-047 integer-percent noise), and any
beyond-tolerance anti-predicted movement on any pair vetoes the event;
for rolling-window metrics value evidence is inadmissible entirely
(replenishment explains any magnitude), so only condition 2 — the
previous `resetsAt` already passed plus a strictly later `resetsAt` —
fires, suffixed `rolling_window_conservative`. Event time is the
previous `resetsAt` when it lies strictly between the two snapshots,
else the new `collectedAt`. The output is structurally
`CycleEventInput` (the D-046 evidence vocabulary, reason in
`details.reason`), so the cycle-persistence seam (task 110, wired by task
118's [`events-cycle.ts`](./events-cycle.ts)) consumes it with zero
conversion; `detectSeriesResetEvents`
folds a flat interleaved list by account and metric, skipping invalid
points entirely.

Landed: [`events-cycle.ts`](./events-cycle.ts) — the §12.1
storage-reading half of reset persistence (task 118, decision D-078):
`detectCycleResetEvents(repository, accountId, snapshot)` builds task
117's point inputs from a new snapshot's valid metrics, reads each
metric's previous point as its newest valid stored row through
`getLatestValidMetricValues` (U-011, decision D-083 — trailing invalid
rows skipped in SQL; one account-level read per cycle, performed only
when a valid metric needs a base), and runs the
pure detector pairwise — exactly one comparison per metric per cycle, so
detection is idempotent and never re-folds persisted history.
`createCycleRecorder`'s success branch carries exactly the detector's
output as the cycle's `events` through the §11.1 transaction (D-060);
the read happens strictly before the transaction opens — a snapshot's
own points can never be its comparison base — and failed or aborted
cycles never reach detection at all. Events are produced going forward
only; there is deliberately no backfill over pre-existing history
(D-078). D-078's flagged follow-up — the per-cycle read materializing
the full retained series per metric — is closed by the U-011 read swap:
the latest-valid-point read resolves to exactly the row the old
full-series walk-back selected (the valid row maximizing
`(collected_at, run_id)`), so the swap is a pure cost change with no
observable behavior difference (D-083).

Landed: [`history-timeline.ts`](./history-timeline.ts) — the §12.2
collection-error and downtime timeline (task 120, decision D-080):
`buildTimelineIndicators(runs, range)` maps §11.2 run records plus an
explicit range to a kind-discriminated indicator union — one
`collection_error` indicator per failed run (never merged), typed by the
D-048/D-034 outcome vocabulary and carrying the run's evidence (HTTP
status, sanitized message, attempts, `Retry-After` seconds), and
`stopped_service` regions as maximal run-less sub-intervals whose silence
strictly exceeds the three jitter-expanded effective intervals shared
with `history-gaps.ts` (`gapThresholdMs` — one source of truth), widened
by the boundary records' per-run interval stamps (D-075's span rule) and
clamped to the range edges. Failure types and no-collection activity are
structurally distinguishable — the task's done-condition, made
executable by the suite. Pure: no storage, no clock (D-021);
`Retry-After` deferrals and suspension probes are deliberately not
subtracted from the silence (D-080, following D-075's precedent).

Landed: [`history-downsample.ts`](./history-downsample.ts) — the §13
history downsampling (task 121, decision D-081):
`downsampleHistorySeries(points, maxPoints, boundaries?)` aggregates an
overfull series (§13's 1500-point default budget, 100–5000 bounds) into
buckets while preserving per-field min/max, the caller's own first/last
point objects, and critical boundaries — reset events and collection
gaps arrive as data through structural interfaces satisfied verbatim by
the D-074/D-075 outputs, never recomputed. Boundaries are separations
between consecutive points (a reset at a point groups it post-side; a
gap separates its whole bracketing pair); separations cut the sorted
series into segments apportioned `1 + ⌊n·E/N⌋` uniform time slices each,
with exact cross-multiplied integer membership, and the
boundary-preservation rule outranks the budget (more segments than
`maxPoints` → one bucket per segment). At-or-under-budget series pass
through identically with `resolutionMs: null`. Property suites prove the
preservation rules — budget bounds, no-loss/no-reorder coverage, per-field
extrema equality, boundary cleanliness — and §17.3 names downsampling for
mutation testing when task 125 configures critical-module thresholds.

Landed: [`history-skew.ts`](./history-skew.ts) — the clock-skew tolerance
gate for the §12.2/§13 history reads (task U-057, decision D-185): the
schema deliberately admits skewed rows (D-034 rejected an
`ended_at >= started_at` CHECK — a rejected INSERT would lose the run
record), so the API composition passes its raw evidence through explicit
rules before the fail-fast services see it. `projectInvertedRuns` skips
an inverted run's contradictory span while keeping its record: projected
to a zero-duration cycle at the trusted `startedAt`, it still bounds
§12.2's record-based stopped silence (dropping it could merge two legal
neighbor silences into a fabricated outage) and a failed cycle still
marks at its start stamp. `dropUnjudgeablePoints` leaves a point
preceding the interval timeline's coverage unjudgeable by the gap
detector — seeding the timeline instead would fabricate cadence coverage
and can mint false gaps, so the fail-safe direction mints none; the point
itself still renders as series data. `mergeSkewDiagnostics` aggregates
the diagnostics into one sanitized §16 report per rule per account (kind,
account, count, epoch-ms bounds — never a row payload), which the routes
log at `warn`; the services' D-075/D-080 fail-fast contracts stay intact
for wiring mistakes. A deterministic table and a property suite pin the
projection/partition shapes; the view suite pins the companion rule — a
skewed interval change anchored at `min(startedAt, endedAt)` inside
`intervalTimelineFromRuns` (the API adapter), so a late-biased start
stamp cannot tighten a straddling pair into a false gap; the API
integration suites seed the mixed clean/skewed world through the real
facade write path and assert the 200s, the honest indicators, the
fabrication regressions, and the diagnostics.
