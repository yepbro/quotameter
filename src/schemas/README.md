# `src/schemas/` — shared contracts

TypeBox schemas and validated types for every trust boundary
([trust boundaries](../../docs/architecture/trust-boundaries.md)):
configuration, API request/response payloads, and the provider-neutral
snapshot/metric model (spec §8.4).

**Rule:** this layer is a leaf — it imports nothing from other `src/` modules.
Everything else may import it; server, storage, API, and the UI (type-only)
consume the same canonical contracts from here.

Modules: `boundary.ts` (validated-type brand and boundary-parser shape),
`metrics.ts` (the spec §8.4 normalized snapshot and metric model — closed
`LimitType`/`MetricUnit`/derived-field enums with guards, the
`ProviderSnapshot`/`NormalizedMetric` types, and the spec-rule invariant
checks; pure TypeScript, because it is the _output_ of trust boundary 2, not a
validation schema), and `config.ts` (the spec §6.2 configuration contract —
TypeBox schemas for `server`/`app`/`auth`/`logging`/`providers`/`accounts`
with derived types, spec defaults, and the cross-field invariants of
`findConfigProblems`; trust boundary 3, consumed by `src/config/` tasks 064+).
The contract is published as a JSON Schema document (`CONFIG_SCHEMA_DOCUMENT`
→ the committed, generated [`schema/config.schema.json`](../../schema/config.schema.json);
task 062, D-015 — see [docs/config-schema.md](../../docs/config-schema.md)).
