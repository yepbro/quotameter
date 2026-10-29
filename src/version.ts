/**
 * Minimal version-string utilities.
 *
 * Used for the declared Node.js minimum (>= 22.13.0) at startup and in
 * diagnostics. Deliberately dependency-free: the runtime check must run
 * before any package can be assumed installed.
 */

/**
 * Compares two `major.minor.patch` version strings numerically.
 *
 * Missing segments are treated as `0`, so `"22.13"` equals `"22.13.0"`.
 * Non-numeric input is rejected loudly rather than guessed.
 *
 * @returns negative when `a < b`, `0` when equal, positive when `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const left = pa[i] ?? 0;
    const right = pb[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Returns `true` when `version` satisfies the declared minimum `>= minimum`. */
export function satisfiesMinimum(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

function parse(version: string): [number, number, number] {
  const parts = version.split('.');
  // Written without nested regex quantifiers on purpose: keeps the security
  // lint ("detect-unsafe-regex") clean and the check trivially auditable.
  const valid = parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p));
  if (!valid) {
    throw new Error(`Invalid version string: ${JSON.stringify(version)}`);
  }
  const numbers = parts.map(Number);
  while (numbers.length < 3) numbers.push(0);
  return numbers as [number, number, number];
}
