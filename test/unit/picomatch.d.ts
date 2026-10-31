/**
 * Minimal ambient types for picomatch — the matcher the installed Vitest uses
 * for coverage threshold keys (`resolveThresholds` compiles each non-global key
 * with `picomatch(key)`, default options; see coverage-thresholds.spec.ts for
 * the verification). picomatch 4 ships no bundled declarations and
 * `@types/picomatch` is not a dependency; the guard needs exactly this
 * factory-and-matcher surface. Remove this file if picomatch types ever become
 * available from the package itself.
 */

declare module 'picomatch' {
  /** A compiled glob matcher, as returned by picomatch's factory. */
  type Matcher = (str: string) => boolean;

  function picomatch(glob: string, options?: Record<string, unknown>): Matcher;

  export default picomatch;
}
