/**
 * Minimal ambient types for picomatch — the matcher the coverage-threshold
 * guard (`coverage-thresholds.spec.ts`, decision D-093) imports to mirror
 * `resolveThresholds`' key compilation (`picomatch(key)`, default options;
 * see that spec for the verification). picomatch is a declared devDependency
 * (`^4.0.7`, the exact range the installed Vitest 5 declares, so the guard
 * and the runner resolve one instance — an invariant the guard spec pins
 * executably through a resolve-identity assertion, task U-027), and the declared 4.0.7 ships no
 * declarations — no `types`/`typings` field and no `.d.ts` in the package —
 * while `@types/picomatch` is not a dependency; the guard needs exactly this
 * factory-and-matcher surface, so this file stays. Remove it if picomatch
 * types ever become available from the package itself.
 */

declare module 'picomatch' {
  /** A compiled glob matcher, as returned by picomatch's factory. */
  type Matcher = (str: string) => boolean;

  function picomatch(glob: string, options?: Record<string, unknown>): Matcher;

  export default picomatch;
}
