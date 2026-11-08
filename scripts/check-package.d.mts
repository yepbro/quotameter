/**
 * The type surface of `scripts/check-package.mjs` for its TypeScript
 * consumer (`test/unit/package-manifest.spec.ts`). The module itself is
 * plain ESM JavaScript, so it has no inferred types; the three exported
 * allowlist constants are the contract between the tarball check and the
 * manifest's `files` field — the spec pins their agreement (task 184,
 * D-194), so a change to either side alone fails `make check`.
 */
/** Exact tarball entries allowed beyond the prefix set (task 052, task 184/D-194). */
export declare const ALLOWED_EXACT: readonly string[];
/** Directory prefixes whose packed contents are allowed (the prebuilt UI). */
export declare const ALLOWED_PREFIXES: readonly string[];
/** Entries that must be present in every packed tarball. */
export declare const REQUIRED_ENTRIES: readonly string[];
