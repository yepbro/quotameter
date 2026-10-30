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
