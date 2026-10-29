import { describe, expect, it } from "vitest";
import { compareVersions, satisfiesMinimum } from "../../src/version";
import { fc } from "../helpers/property";

/**
 * Sample property tests over src/version.ts proving the deterministic
 * fast-check convention works and the comparison behaves as an ordering.
 */
const versionArb = fc
  .tuple(fc.nat(99), fc.nat(99), fc.nat(99))
  .map(([a, b, c]) => `${a}.${b}.${c}`);

describe("compareVersions properties", () => {
  it("is antisymmetric", () => {
    fc.assert(
      fc.property(versionArb, versionArb, (a, b) => {
        const forward = Math.sign(compareVersions(a, b));
        const backward = Math.sign(compareVersions(b, a));
        expect(forward).toBe(-backward);
      }),
    );
  });

  it("is reflexive", () => {
    fc.assert(
      fc.property(versionArb, (a) => {
        expect(compareVersions(a, a)).toBe(0);
      }),
    );
  });

  it("is transitive", () => {
    fc.assert(
      fc.property(versionArb, versionArb, versionArb, (a, b, c) => {
        const ab = compareVersions(a, b);
        const bc = compareVersions(b, c);
        if (ab <= 0 && bc <= 0) {
          expect(compareVersions(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it("treats a version as the minimum for itself", () => {
    fc.assert(
      fc.property(versionArb, (a) => {
        expect(satisfiesMinimum(a, a)).toBe(true);
      }),
    );
  });
});
