# `src/config/` — configuration mechanics

Everything around the configuration file and environment (spec §6): XDG path
resolution with `QUOTAMETER_*` overrides (task 063), loading and validation
against the schema in `src/schemas/config.ts` (064, 067), atomic writes and
permission enforcement (065, 066). The runtime `ConfigService` facade lives in
`src/services/`; this module holds the mechanics it delegates to.

**Rule:** may import only `src/schemas/` and `src/util/` — no services,
storage, providers, or server code.
