import { describe, expect, it } from "vitest";

/**
 * Smoke test: proves the Vitest pipeline executes TypeScript specs on the
 * current runtime and that the runtime satisfies the declared minimum
 * Node.js version (spec §3).
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

describe("test environment", () => {
  it("runs TypeScript specs", () => {
    const answer: number = 6 * 7;
    expect(answer).toBe(42);
  });

  it("runs on the minimum supported Node.js version", () => {
    expect(compareVersions(process.versions.node, "22.13.0")).toBeGreaterThanOrEqual(0);
  });
});
