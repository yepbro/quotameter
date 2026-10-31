import { describe, expect, it } from 'vitest';
import { compareVersions, satisfiesMinimum } from '../../src/util/version';
import { MINIMUM_RUNTIME, VERSION_GATE_CASES } from '../helpers/nodeVersionGate';

describe('compareVersions', () => {
  it('orders numeric segments correctly', () => {
    expect(compareVersions('22.13.0', '22.13.0')).toBe(0);
    expect(compareVersions('22.13.0', '22.9.0')).toBeGreaterThan(0);
    expect(compareVersions('22.9.0', '22.13.0')).toBeLessThan(0);
    expect(compareVersions('24.0.0', '22.99.99')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('22.13', '22.13.0')).toBe(0);
    expect(compareVersions('22', '22.0.1')).toBeLessThan(0);
  });

  it('orders prerelease and build suffixes by their numeric prefix', () => {
    // Nightly and custom builds report suffixed process.versions.node; the
    // runtime minimum gates the numeric release line, not semver precedence
    // (task 129, decision D-098).
    expect(compareVersions('22.13.0-nightly.20261101abc', '22.13.0')).toBe(0);
    expect(compareVersions('22.13.0+custom', '22.13.0')).toBe(0);
    expect(compareVersions('22.12.9-nightly.20261101abc', '22.13.0')).toBeLessThan(0);
    expect(compareVersions('22.13.1-pre', '22.13.0')).toBeGreaterThan(0);
  });

  it('rejects invalid version strings', () => {
    expect(() => compareVersions('22.13.x', '22.13.0')).toThrow(/Invalid version string/);
    expect(() => compareVersions('', '22.13.0')).toThrow(/Invalid version string/);
    expect(() => compareVersions('1.2.3.4', '1.2.3')).toThrow(/Invalid version string/);
    expect(() => compareVersions('v22.13.0', '22.13.0')).toThrow(/Invalid version string/);
    expect(() => compareVersions('garbage', '22.13.0')).toThrow(/Invalid version string/);
  });
});

describe('satisfiesMinimum', () => {
  it('accepts the minimum itself and anything newer', () => {
    expect(satisfiesMinimum('22.13.0', '22.13.0')).toBe(true);
    expect(satisfiesMinimum('24.14.0', '22.13.0')).toBe(true);
  });

  it('rejects older versions', () => {
    expect(satisfiesMinimum('22.12.0', '22.13.0')).toBe(false);
    expect(satisfiesMinimum('21.0.0', '22.13.0')).toBe(false);
  });
});

describe('the shared runtime-gate boundary matrix (task 129)', () => {
  // The same list drives the child-process gate suite of the real launcher
  // (test/integration/cli-bin-version-gate.spec.ts); this block pins the
  // src/util/version.ts side of the equivalence.
  it('matches every case the launcher gate pins', () => {
    for (const { version, outcome } of VERSION_GATE_CASES) {
      if (outcome === 'invalid') {
        expect(() => satisfiesMinimum(version, MINIMUM_RUNTIME), `case ${version}`).toThrow(
          /Invalid version string/,
        );
      } else {
        expect(satisfiesMinimum(version, MINIMUM_RUNTIME), `case ${version}`).toBe(
          outcome === 'pass',
        );
      }
    }
  });
});
