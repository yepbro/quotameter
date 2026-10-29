# `src/schemas/` — shared contracts

TypeBox schemas and validated types for every trust boundary
([trust boundaries](../../docs/architecture/trust-boundaries.md)):
configuration, API request/response payloads, and the provider-neutral
snapshot/metric model (spec §8.4).

**Rule:** this layer is a leaf — it imports nothing from other `src/` modules.
Everything else may import it; server, storage, API, and the UI (type-only)
consume the same canonical contracts from here.
