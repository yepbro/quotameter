import { describe, expect, it } from 'vitest';
import { isValidTimeZoneName } from '../../src/schemas/config';
import { fc } from '../helpers/property';
import {
  epochMsFromIso,
  formatZonedDate,
  formatZonedTime,
  isValidTimeZone,
  resolveTimeZone,
  toUtcIso,
  zonedDateTime,
  zonedParts,
} from '../../src/util/clock';

/**
 * Property tests for src/util/clock.ts (spec §10, §17.1): epoch ↔ ISO
 * round-trips, instant preservation across zones, formatter shapes, and
 * parity of the twin IANA validators (decision D-021).
 */

/** The full range of years 0001–9999, where ISO strings stay four-digit. */
const ISO_EPOCH_MIN = -62_135_596_800_000;
const ISO_EPOCH_MAX = 253_402_300_799_999;

/** ±~100 years around the epoch: DST rules are in force, years stay four-digit. */
const RECENT_EPOCH = fc.integer({ min: -3_200_000_000_000, max: 3_200_000_000_000 });

/** The spec §17.1 zones plus Asia/Singapore (rich historical offsets); the full matrix is task 126. */
const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
] as const;

const zoneArb = fc.constantFrom(...ZONES);

describe('clock properties', () => {
  it('toUtcIso and epochMsFromIso round-trip every ISO-representable epoch', () => {
    fc.assert(
      fc.property(fc.integer({ min: ISO_EPOCH_MIN, max: ISO_EPOCH_MAX }), (epochMs) => {
        expect(epochMsFromIso(toUtcIso(epochMs))).toBe(epochMs);
      }),
    );
  });

  it('zonedDateTime preserves the instant in every zone', () => {
    fc.assert(
      fc.property(RECENT_EPOCH, zoneArb, (epochMs, zone) => {
        expect(zonedDateTime(epochMs, resolveTimeZone(zone)).toMillis()).toBe(epochMs);
      }),
    );
  });

  it('zonedParts echoes the instant and the formatters stay well-shaped', () => {
    fc.assert(
      fc.property(RECENT_EPOCH, zoneArb, (epochMs, zone) => {
        const timeZone = resolveTimeZone(zone);
        const parts = zonedParts(epochMs, timeZone);
        expect(parts.epochMs).toBe(epochMs);
        expect(formatZonedTime(epochMs, timeZone)).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        expect(formatZonedDate(epochMs, timeZone)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(parts.hour).toBe(Number(formatZonedTime(epochMs, timeZone).slice(0, 2)));
      }),
    );
  });

  it('agrees with the configuration validator on arbitrary strings', () => {
    const zoneish = fc
      .array(fc.constantFrom(...'AZaz09/+-:_ .'.split('')), { maxLength: 40 })
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(zoneish, (name) => {
        expect(isValidTimeZone(name)).toBe(isValidTimeZoneName(name));
      }),
    );
  });
});
