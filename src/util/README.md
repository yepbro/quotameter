# `src/util/` — cross-cutting helpers

Cross-cutting utilities shared across layers: the clock/time-zone API
(`clock.ts`, task 071), rolling-range boundary calculations
(`rolling-ranges.ts`, task 116), the shared epoch-millisecond comparator
family (`compare-epoch-ms.ts`, tasks U-013 and U-023), the structured
redacting logger (`logger.ts`, task 072), and version-string helpers
(`version.ts`).

**Rule:** this layer is a leaf — it imports nothing from other `src/` modules.
External packages are allowed (`clock.ts` uses Luxon, `logger.ts` uses Pino —
both named by spec §3). Add a file here only when it is genuinely
cross-cutting; module-specific helpers stay inside their owning module.

## `clock.ts` — the canonical time API (spec §10, decision D-021)

The single entry point for "now", epoch/zone conversions, and timestamp
formatting. Server-side business logic receives time through this module and
never calls `Date.now()`, `new Date()`, or machine-local zone APIs itself.

- **Injectable now:** `Clock` (`now()` for UTC epoch ms, `monotonicMs()` for
  elapsed-time measurement and monotonic scheduling, spec §7.1).
  `createSystemClock()` is the only sanctioned `Date.now()` call site and is
  instantiated once by the composition root; tests use `createFixedClock()`
  (`set` jumps the wall clock only, `advance` moves both readings).
- **Explicit, branded zones:** validate once with `resolveTimeZone()` and
  pass the branded `TimeZone` to every helper — the construction-gate pattern
  of `AccountContext` (D-013). `isValidTimeZone` follows the configuration
  contract's semantics (D-014 item 8: `Intl` resolution minus ECMA-402 offset
  identifiers). It is a deliberate twin of `isValidTimeZoneName` in
  `src/schemas/config.ts` — both layers are leaves and cannot import each
  other — and a parity test keeps the twins identical.
- **Conversions and formatting:** `zonedDateTime` (the Luxon bridge),
  `zonedParts` (wall-clock fields incl. ISO weekday), `formatZonedTime`
  (`HH:mm`) and `formatZonedDate` (`yyyy-MM-dd`) in a zone, `toUtcIso`
  (ISO 8601 UTC with `Z`, the API timestamp format of spec §10), and
  `epochMsFromIso` (rejects offset-less strings — exactly where an implicit
  zone would creep in).
- **No machine-local paths:** nothing here reads the system zone or `TZ`,
  and Luxon's `DateTime.now()`/default-zone behavior is outside the contract,
  so results are identical under any `TZ` setting.
- **Loud failure:** every helper re-runs the IANA gate at runtime (Luxon alone
  would accept pseudo-zones such as `local` or `utc+4` that resolve to
  machine-local readings) and checks Luxon `.isValid`, so unsupported zones
  and non-finite or out-of-range epochs throw English errors instead of
  producing `NaN`s. `isValidTimeZone` memoizes results, so formatting loops
  do not pay an `Intl.DateTimeFormat` construction per call.
- **Deliberately absent:** local wall-clock → epoch conversion. That
  direction is where DST nonexistent/ambiguous times live, and spec §9.3
  fixes their resolution policy — task 115 owns it; peak-hours intervals
  (114) build on `zonedDateTime`/`zonedParts`. Rolling ranges (116) needed
  neither — pure duration arithmetic, see the next section (D-068).

## `rolling-ranges.ts` — explicit bounds for "last N hours/days" (spec §10, decision D-068)

The closed vocabulary of spec §14.4 — `24h`, `3d`, `7d` (default), `14d`,
`30d` — and the boundary arithmetic §10 requires: a rolling range is an
interval ending **now**, so callers pass explicit `from`/`to` bounds (UTC
epoch ms) to the server, which filters history server-side (§13's
`/api/history`, `/api/events`, `/api/peak-hours` take those bounds as ISO
8601 UTC; the HTTP layer itself is Stage 12).

- **Pure duration arithmetic:** `rollingRangeBounds(range, now)` returns
  `{ from: now − duration, to: now }` — exact milliseconds, no calendar or
  DST wall-clock component. A "24h" range across a spring-forward transition
  is still exactly 86 400 000 ms of absolute time.
- **`now` is an argument, never the machine clock** (the D-021 discipline):
  callers inject the `Clock`; the module reads no environment and no `TZ`,
  so bounds are identical under any `TZ` setting by construction — verified
  in real child processes by
  `test/integration/rolling-ranges-tz.spec.ts` (the task-116
  done-condition).
- **Closed interval `[from, to]`** — both ends inclusive (the spec is
  silent; pinned by D-068 and made executable through
  `rollingRangeContains`, matching the server-side filter
  `collected_at >= from AND collected_at <= to`).
- **Loud failure:** an unknown range id throws with the valid ids listed
  (the D-013 registry error discipline); a non-finite `now` throws. For
  finite `now` the subtraction cannot overflow — at `±Number.MAX_VALUE` the
  ≤ 30-day duration is absorbed (`from === now`), documented float-exact
  behavior.
- **Consumers:** the Stage 12 history/events endpoints (as the source of
  the `from`/`to` they filter by, via `toUtcIso`), the §14.4 history view's
  range selector, and retention-aware range disabling (compare
  `rollingRangeDurationMs` with the configured retention; §14.4).

## `logger.ts` — the structured redacting logger (spec §16, §15.4, decision D-025)

The module every layer logs through; the exit side of "secrets stop at their
layer". `createLogger(options)` returns a wrapper around one Pino instance
writing JSON lines to an injectable destination (default `process.stdout`,
spec §16; journald collects them). Never `console` — ESLint forbids it in
`src/**`, and the logger is the sanctioned output path.

- **Two redaction layers (D-025).** Layer B (the wrapper, first-party
  surface) deep-sanitizes the message and the merging object before Pino
  sees them: sensitive keys by name at any depth, known secret values
  wherever they occur in strings, `Error` payloads normalized through
  Pino's `errWithCause` and scrubbed (message, stack, cause chain, custom
  properties). Layer A (Pino `redact` paths + an `err` serializer) protects
  the raw instance exposed as `logger.pino` for integrations (task 146
  wraps it as the Fastify logger) — by key name at depths 0–2 only; the raw
  instance does not scrub message strings or non-sensitive field values, so
  task 146 must keep secrets out of its own URLs, messages, and values by
  construction or scrub them itself (D-025 records the boundary).
- **Levels.** The wrapper exposes all six Pino levels (`trace`…`fatal`);
  spec §16's four configuration levels (`error|warn|info|debug`, default
  `warn`) remain the user-facing policy pinned by `LOG_LEVELS` in
  `src/schemas/config.ts` — a deliberate twin, since the layers cannot
  import each other. `setLevel` serves the reload path (D-023).
- **Sensitive key names** are matched normalized (lowercase,
  non-alphanumerics stripped), so `apiKey`, `API_KEY`, `api-key`, and
  `api_key` all match; the closed list is exported as `SENSITIVE_KEY_NAMES`
  and errs on the side of redaction. Known-secret values supplied at
  creation (`secrets`) are scrubbed from every string.
- **Failure contract.** Construction validates options and throws (wiring
  mistakes fail fast); every log call is synchronous and never throws
  (D-020's diagnostics rule). The non-enumerable D-013 `AccountContext`
  secret is invisible to the sanitizer by construction.
- **Lifecycle seam.** `createLifecycleSink(logger)` adapts the logger to the
  reserved `onLifecycle`/`onEvent` seams of `src/server/` — synchronous,
  never throws, logs `lifecycle: <type>` at `info` (§16: at `info`, log
  only lifecycle events). The event type is the structural supertype
  `{ type: string } & Record<string, unknown>`, so both server event unions
  fit without importing them.
- **Marker-secret proof.** `test/unit/logger-redaction.spec.ts` fires every
  leak vector (message interpolation, deep/nested fields, array elements,
  error payloads, sensitive keys) at every level of the ladder and asserts
  the marker is absent from the raw JSON line — the task 072
  done-condition.

## `compare-epoch-ms.ts` — the shared epoch-ms ordering family (spec §10, decisions D-090 and D-096)

One contract family for every chronological sort over `EpochMs` data.
`compareEpochMs(a, b)` returns −1/0/1 and slots directly into
`Array#sort`; it replaced the three byte-identical private copies the
history services carried (tasks 119–121 — task 121's review P3 asked for
exactly this single-siting, and the parallel wave deferred it here).
`compareByEpochMs(primary, tieBreak)` (U-023, D-096) builds the
compound-key variant — order by the primary epoch, break exact ties by a
second finite number ascending — and replaced the two subtraction-based
sorts the U-013 census had flagged: `peak-hours-intervals.ts`'s
`(start, end)` and `storage/backups.ts`'s `(timestampMs, seq)`.

- **Total order over finite epoch-ms:** exact sign comparison — no
  subtraction, so no precision corners anywhere in the finite domain;
  exact at the ±8.64e15 ECMAScript time-value bounds (the domain task
  124's rolling-range properties generate over), where a difference-based
  comparator starts relying on IEEE-754 rounding for magnitudes ≥ 2⁵³.
- **Non-finite input fails fast:** `NaN` and `±Infinity` throw a
  `TypeError` naming both values (per key role in the compound form).
  Timestamps are validated-finite data under D-021 (the clock and every
  service seam reject non-finite values first), and a silent NaN-as-equal
  answer would not be a total order — a non-finite timestamp reaching an
  ordering decision is a missed validation seam and fails loudly (the
  D-059/D-064 convention). The compound form validates both keys of both
  items on every invocation, primary pair first, so rejection never
  depends on where a sort happens to stop comparing.
- **Tie-break domain (D-096):** any finite `number`, ascending, the same
  sign ladder — an epoch at the services site (`end`), an integer counter
  at the storage site (`seq`); the family claims neither identity.
- **Consumers:** the chronological sorts of the history services
  (`history-gaps.ts`, `history-downsample.ts`, `history-timeline.ts`);
  the peak-occurrence union sort of `peak-hours-intervals.ts`; the
  `(timestampMs, seq)` retention order of `storage/backups.ts` — where
  both keys are finite by construction (the creation path validates `now`
  as a non-negative integer, and the file system's 255-byte name cap
  bounds a grammar digit run at 241 digits, ~1e241, while a non-finite
  parse needs 309 — so no reachable name can hand the comparator a key
  its fail-fast contract must refuse).
  `test/unit/compare-epoch-ms.spec.ts` pins both contract halves of both
  members (extreme-value exactness, tie-break ordering, the non-finite
  throw table, and `Array#sort` use included).
