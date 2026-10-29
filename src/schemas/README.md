# `src/schemas/` — shared contracts

TypeBox schemas and validated types for every trust boundary
([trust boundaries](../../docs/architecture/trust-boundaries.md)):
configuration, API request/response payloads, and the provider-neutral
snapshot/metric model (spec §8.4).

**Rule:** this layer is a leaf — it imports nothing from other `src/` modules.
Everything else may import it; server, storage, API, and the UI (type-only)
consume the same canonical contracts from here.

Modules: `boundary.ts` (validated-type brand and boundary-parser shape) and
`metrics.ts` (the spec §8.4 normalized snapshot and metric model — closed
`LimitType`/`MetricUnit`/derived-field enums with guards, the
`ProviderSnapshot`/`NormalizedMetric` types, and the spec-rule invariant
checks). It is pure TypeScript: it is the _output_ of trust boundary 2, not a
validation schema; TypeBox schemas for configuration and API payloads arrive
with their owning tasks.
