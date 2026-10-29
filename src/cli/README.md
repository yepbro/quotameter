# `src/cli/` — command implementations

The `quotameter` command surface (spec §5.2, Stage 11): `init`, `run`,
`service`, `start`/`stop`/`restart`, `reload`, `status`, `logs`, `passwd`, and
`doctor`. `bin/quotameter.mjs` stays a thin, build-free launcher that
dispatches here (compiled at publish time — no install-time build, spec §3).

**Rule:** a top-level consumer — it may import any layer except concrete
provider adapters. Nothing under `src/` imports this module; only `bin/` does.
