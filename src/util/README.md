# `src/util/` — cross-cutting helpers

Cross-cutting utilities shared across layers: the clock/time-zone API
(`clock.ts`, task 071), the structured redacting logger (task 072), and
version-string helpers (`version.ts`).

**Rule:** this layer is a leaf — it imports nothing from other `src/` modules.
External packages are allowed (`clock.ts` uses Luxon, which spec §3 names for
server-side time zones). Add a file here only when it is genuinely
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
