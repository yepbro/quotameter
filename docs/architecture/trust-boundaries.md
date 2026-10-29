# Trust boundaries and validated types

## Rule

**Untrusted data never enters application logic without schema validation.** Every trust boundary has exactly one validation module that owns the schema and exports a validated type; downstream code consumes only the validated shape. This rule is enforceable in review by checking import direction: nothing may import raw `JSON.parse` results, `fetch` bodies, or `process.env` values except through the modules below.

## Boundaries

| #   | Boundary                      | Untrusted input                                     | Validation owner                                        | Validated output                                                                                                |
| --- | ----------------------------- | --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | HTTP API requests             | Request bodies, query parameters, headers           | `src/schemas/api/` (Stage 12, tasks 147+)               | Typed route handlers only see validated shapes                                                                  |
| 2   | Provider responses            | Provider HTTP bodies (Z.ai now, others later)       | Adapter-local schema in `src/providers/<id>/` (Stage 9) | Normalized snapshot model (spec §8.4); anything unvalidated becomes a parse failure with a sanitized diagnostic |
| 3   | Configuration and environment | `config.json`, `QUOTAMETER_*` environment variables | `src/schemas/config.ts` (task 061+)                     | One validated configuration object; startup refuses invalid config (spec §6.2)                                  |
| 4   | Database rows                 | Anything read back from SQLite                      | Repository layer mapping (Stage 8)                      | Typed domain records                                                                                            |
| 5   | UI ↔ API                      | Browser-originated payloads (JSON)                  | Same schemas as boundary 1, applied at the server       | The UI itself is untrusted; server-side validation is authoritative                                             |

## Enforcement points

- Runtime validation happens with TypeBox schemas shared between the API layer and the configuration loader (task 061 defines the canonical contract; Stage 9 uses the same mechanism inside adapters).
- Parse failures at boundary 2 keep a **sanitized** raw response for diagnostics (spec §7.4): secrets and personal data are redacted before storage.
- Environment overrides (boundary 3) are read once at load; runtime code never re-reads `process.env` for the same setting.
- ESLint security rules (task 034) and the no-network guard (task 031) complement these boundaries; the structured logger's redaction (task 072) is the exit-side counterpart.

## Status

This file is the durable map; the schema modules are created by their owning tasks and must link back here. When a new boundary appears (for example a new provider), it is added to this table first, then implemented. The directory owning each module and the allowed import directions are fixed by [package-layout.md](package-layout.md) and enforced by `test/unit/package-layout.spec.ts`. The rationale for these boundaries and the decisions behind them is consolidated in [decision-overview.md](decision-overview.md).
