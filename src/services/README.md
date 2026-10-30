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
