/**
 * The type surface of `scripts/generate-openapi.mjs` for its TypeScript
 * consumer (`test/unit/openapi-published.spec.ts`). The module itself is
 * plain ESM JavaScript, so it has no inferred types; the exported
 * serializer is the exact pipeline the CLI writer runs — the drift guard's
 * byte-freshness arm (task 192, D-202) proves the committed
 * `docs/openapi.json` is what regeneration produces by running this one
 * implementation, never a mirrored copy that could fork.
 */
export declare function serializeOpenApiDocument(
  document: Record<string, unknown>,
): Promise<string>;
