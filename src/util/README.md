# `src/util/` — cross-cutting helpers

Cross-cutting utilities shared across layers: the clock/time-zone API
(`clock.ts`, task 071), the structured redacting logger (`logger.ts`,
task 072), and version-string helpers (`version.ts`).

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
  (114) and rolling ranges (116) build on `zonedDateTime`/`zonedParts`.

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
