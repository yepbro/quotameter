/**
 * The type surface of `scripts/openapi-document.mjs` for the TypeScript
 * consumers (the drift guard and the builder spec in `test/unit/`). The
 * module itself is plain ESM JavaScript loaded through jiti (the
 * `generate-schema.mjs` pattern), so it has no inferred types; its single
 * export returns the OpenAPI document as parsed JSON data — exactly what
 * the guard deep-compares against the committed `docs/openapi.json`. The
 * optional operations argument is the builder spec's injection point for
 * the rejection arms; production callers omit it.
 */
export declare function buildOpenApiDocument(
  operations?: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>;
