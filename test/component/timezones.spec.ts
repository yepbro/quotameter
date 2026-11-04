import { describe, expect, it } from 'vitest';
import { isValidTimeZoneName } from '../../src/schemas/config';
import { browserTimeZones, isValidTimeZone, zoneSuggestions } from '../../ui/src/timezones';

/**
 * The settings page's pure time-zone helpers (task 179, spec §14.5, §5.3;
 * decision D-156): the validity check must agree with the SERVER's own
 * IANA gate (`isValidTimeZoneName`) — the same probe set through both
 * functions, so a resolver change on either side fails here instead of
 * surfacing as a settings PUT the server refuses. The suggestion filter
 * is the §14.5 search behavior, pinned over a fixed list.
 */

/** Both functions must agree on every member — valid and invalid alike. */
const AGREEMENT_PROBES = [
  'UTC',
  'Asia/Kolkata',
  // IANA alias links stay valid names (the server's own docblock rule).
  'Asia/Calcutta',
  'America/New_York',
  'Pacific/Kiritimati',
  'Etc/GMT-14',
  // V8 resolves zone names case-insensitively; the mirror agrees because
  // both sides are the same Intl resolver.
  'asia/kolkata',
  // Not IANA names: the empty string, an unknown path, and ECMA-402
  // offset identifiers (which Intl alone would accept).
  '',
  'Not/AZone',
  '+03:00',
  '-05:00',
  'America/New York',
] as const;

describe('isValidTimeZone (the server-mirroring IANA gate)', () => {
  it('agrees with the server check on every probe', () => {
    for (const probe of AGREEMENT_PROBES) {
      expect(
        { probe, client: isValidTimeZone(probe) },
        `client and server must agree on ${probe === '' ? '(empty)' : probe}`,
      ).toEqual({ probe, client: isValidTimeZoneName(probe) });
    }
  });

  it('rejects the offset identifiers Intl alone would accept', () => {
    expect(isValidTimeZone('+03:00')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
  });

  it('accepts the canonical probes', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
  });
});

describe('browserTimeZones (the §14.5 search vocabulary)', () => {
  it('serves the engine list: non-empty, canonical members, all valid', () => {
    // Node 22's full-ICU Intl (the component project's environment) has
    // `supportedValuesOf`; happy-dom does not replace Intl. The list
    // carries CLDR-canonical names — this ICU serves 'Asia/Calcutta',
    // not the tzdb primary 'Asia/Kolkata', and no bare 'UTC' — facts the
    // twin-match below compensates for (a pinned-ICU assertion; an ICU
    // bump that renames the zone updates this pin).
    const zones = browserTimeZones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain('Asia/Calcutta');
    expect(zones).not.toContain('UTC');
    for (const zone of zones) {
      expect(isValidTimeZone(zone), `${zone} must be a valid zone`).toBe(true);
    }
  });
});

describe('zoneSuggestions (the search filter)', () => {
  const ZONES = [
    'Africa/Cairo',
    'America/New_York',
    'Asia/Calcutta',
    'Asia/Singapore',
    'Australia/Lord_Howe',
    'Europe/Berlin',
    'Pacific/Kiritimati',
    'UTC',
  ] as const;

  it('matches case-insensitively and preserves the served order', () => {
    expect(zoneSuggestions('asia', ZONES)).toEqual(['Asia/Calcutta', 'Asia/Singapore']);
    expect(zoneSuggestions('NEW_YORK', ZONES)).toEqual(['America/New_York']);
  });

  it('a fully typed tzdb primary surfaces its listed canonical twin', () => {
    // The engine lists 'Asia/Calcutta'; the operator typed 'Asia/Kolkata'
    // — a valid zone that resolves to the same canonical identifier.
    expect(zoneSuggestions('Asia/Kolkata', ZONES)).toEqual(['Asia/Calcutta']);
  });

  it('a partial modern alias matches nothing (the vocabulary is the list’s)', () => {
    expect(zoneSuggestions('Kolkata', ZONES)).toEqual([]);
  });

  it('an empty or blank query matches nothing (never a catalog dump)', () => {
    expect(zoneSuggestions('', ZONES)).toEqual([]);
    expect(zoneSuggestions('   ', ZONES)).toEqual([]);
  });

  it('caps the list at the limit', () => {
    const many = Array.from({ length: 20 }, (_unused, index) => `Zone/Prefix_${index}`);
    expect(zoneSuggestions('Prefix', many, 8)).toHaveLength(8);
  });

  it('an unmatched query answers an empty list', () => {
    expect(zoneSuggestions('Mars/Olympus', ZONES)).toEqual([]);
  });
});
