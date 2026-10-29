/**
 * Runtime validation boundary helpers.
 *
 * Every trust boundary in the application (see
 * docs/architecture/trust-boundaries.md) validates untrusted input exactly
 * once, at the edge, and hands typed data to the rest of the codebase. The
 * TypeBox-based schemas for configuration and API payloads arrive with task
 * 061; provider adapters get their schemas in Stage 9. Until then, this
 * module defines the shared vocabulary so those tasks implement against a
 * stable contract instead of inventing per-module conventions.
 */

/**
 * Brand for values that passed schema validation. Downstream signatures
 * accept `Validated<T>` and cannot be satisfied with raw untrusted input.
 */
export type Validated<T> = T & { readonly __validated: unique symbol };

/** Shape every boundary parser implements. */
export interface BoundaryParser<Output> {
  /**
   * Validates untrusted input and returns either the validated value or a
   * list of human-readable, field-addressed problems. Parsers never throw
   * for invalid input and never return partial data.
   */
  parse(input: unknown): { ok: true; value: Validated<Output> } | { ok: false; problems: string[] };
}
