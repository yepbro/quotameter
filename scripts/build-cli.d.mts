/**
 * The type surface of `scripts/build-cli.mjs` for its TypeScript consumer
 * (`test/unit/build-cli-script.spec.ts`). The module itself is plain ESM
 * JavaScript, so it has no inferred types; the four exported seams are the
 * specifier-normalization contract of the packaging build (task 185,
 * D-195) — the spec pins their behavior, so a change to either side alone
 * fails `make check` (the check-package.d.mts pattern).
 */

/** Answers whether an emitted tree contains the file a candidate names. */
export type ResolveSibling = (candidate: string) => boolean;

/** One planned textual replacement of an emitted specifier literal. */
export interface SpecifierEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** The planned outcome for one emitted module. */
export interface SpecifierPlan {
  readonly edits: readonly SpecifierEdit[];
  readonly problems: readonly string[];
}

/** Maps a relative specifier to the exact form plain Node ESM resolves. */
export declare function mapRelativeSpecifier(
  specifier: string,
  resolveSibling: ResolveSibling,
): string | undefined;

/** True for extensionless bare specifiers with a path beyond the package root. */
export declare function isDeepBareImport(specifier: string): boolean;

/** Plans every specifier rewrite one emitted module needs. */
export declare function planSpecifierEdits(
  code: string,
  resolveSibling: ResolveSibling,
): SpecifierPlan;

/** Applies planned edits (ascending, offset-adjusted) — a pure splice. */
export declare function applyEdits(code: string, edits: readonly SpecifierEdit[]): string;
