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
`quotameter status`, and §14.3's overview are the consumers.

Landed: [`polling-persist.ts`](./polling-persist.ts) — the run writer behind
the scheduler's settle seam (task 110, decision D-069):
`createCycleRecorder({ account, provider, repository, clock, intervalSeconds })`
produces one account's D-066 closure pair: `attempt(signal)` stamps the
cycle's wall-clock start (§7.1's actual collection timestamps) and makes the
raw `fetchSnapshot` call D-059's wrapper needs unwrapped;
`settleCycle(result)` classifies the retried cycle with task 105, persists it
through `persistCollectionCycle` (D-060's §11.1 transaction — one
`collection_runs` row per cycle, the snapshot with its metric rows only for a
successful one, the §7.4 sanitized payload beside a parse-error run), and
returns the classification the engine gates on. A provider-level success
whose value fails §8.4 validation (the seam's input is `unknown`) becomes a
`parse_error` run without a snapshot; a caller abort classifies `'cancelled'`
and is deliberately unpersisted (service lifecycle — §12.2's no-record
class); an error outside both taxonomies throws, contained per §7.2. The
adapter parse failure is recognized structurally (`reason`/
`sanitizedPayload`/`httpStatus` — the layout forbids importing the adapter
island), `retry_after_seconds` is `deferNextPoll`'s decision at the settle
reading (D-062: seconds only for a deferred 429, `NULL` otherwise),
`intervalSeconds` is read at settle (§11.2's "interval in effect"), and §12.1
reset-event detection (tasks 117/118) plugs into the success write's empty
`events` array. The one-file widening of D-067's raw-payload gate for this
write-side composer is recorded in D-069.

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
injectable closure pair: `attempt(signal)` (the raw fetch, wrapped in
D-059's `runCycleWithRetries` by the engine, seams passed through) and
`settleCycle(result)` — task 110's classify+persist seam, whose returned
D-048 classification drives every scheduling decision; a throwing seam is
contained (the account reschedules on the plain interval, §7.2 isolation).
`setAccounts`/`setIntervalMs` handle mid-run changes (added accounts poll
immediately; a key change mid-flight discards the stale cycle's outcome —
an old key's 401 never suspends a new key; interval changes re-anchor);
`requestManualTest` owes the account one attempt — a flag consumed at
dispatch, so it survives an in-flight cycle and an interval change, and
still respects the `Retry-After` gate. `stop()` is §5.6's stop-scheduling —
abort every live flight, resolve promptly — with the optional structural
in-flight tracker (D-020) for the server's graceful drain; a wiring-level
loop failure is retained and observable (`running` turns false, `stop()`
re-surfaces the error), and every wake is sliced to `MAX_WAKE_MS` (one
hour) so a wall-regressed gate wait can never busy-spin.

Landed: [`peak-hours-intervals.ts`](./peak-hours-intervals.ts) — the §9.3
peak-hours interval calculation (task 114, decision D-073): a validated
`PeakHoursConfig` (§9.2 contract, never re-validated) plus a half-open
`[from, to)` epoch range map to a `PeakHoursTimeline` that partitions the
range — peak intervals with exact UTC epoch-ms boundaries, `windowId`,
`name`, `multiplier`, and both boundaries as `yyyy-MM-ddTHH:mm` local
times in the schedule zone, plus the off-peak complement carrying
`offPeakMultiplier`. The walk runs on the zone's local calendar days
(anchored and count-bounded, one guard day early for `24:00` windows), and
every wall-clock→instant conversion goes through the injectable
`LocalInstantResolver` seam — the single §9.3 DST-policy siting point
task 115 pins — whose default delegates to Luxon. D-021 discipline
throughout: the `resolveTimeZone` gate, the `zonedDateTime` bridge, no
machine zone or clock. Fail-fast on non-finite or inverted ranges, spans
beyond 3660 local days, and non-IANA zones; `from === to` yields an empty
timeline. Scoped coverage is 100% (the §17.3 peak-hours target), and the
suite is green under `TZ` = UTC, America/New_York, Pacific/Kiritimati,
and Asia/Kathmandu.

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
series' previous point as the last valid stored row through
`getMetricSeries` (walked back past trailing invalid rows), and runs the
pure detector pairwise — exactly one comparison per metric per cycle, so
detection is idempotent and never re-folds persisted history.
`createCycleRecorder`'s success branch carries exactly the detector's
output as the cycle's `events` through the §11.1 transaction (D-060);
the read happens strictly before the transaction opens — a snapshot's
own points can never be its comparison base — and failed or aborted
cycles never reach detection at all. Events are produced going forward
only; there is deliberately no backfill over pre-existing history
(D-078). Flagged follow-up (recorded in D-078's consequences): the
per-cycle read materializes the full retained series per metric until
the repository gains a latest-valid-point read.
