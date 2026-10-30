/**
 * Public surface of the Z.ai Coding Plan adapter island (spec §8.3).
 *
 * The composition root (`src/server/`) is the only importer outside
 * `src/providers/` (island rule, docs/architecture/package-layout.md):
 * it constructs {@link ZaiCodingPlanProvider} and registers it in the
 * `ProviderRegistry`; everything else consumes providers through the
 * 070 contracts only.
 */

export * from './provider';
export * from './snapshot';
export * from './validate';
