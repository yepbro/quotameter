import { describe, expect, it } from 'vitest';
import { compareVersions, satisfiesMinimum } from '../../src/util/version';

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

  it('rejects invalid version strings', () => {
    expect(() => compareVersions('22.13.x', '22.13.0')).toThrow(/Invalid version string/);
    expect(() => compareVersions('', '22.13.0')).toThrow(/Invalid version string/);
    expect(() => compareVersions('1.2.3.4', '1.2.3')).toThrow(/Invalid version string/);
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
