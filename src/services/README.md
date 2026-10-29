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
