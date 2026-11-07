import { describe, expect, it } from 'vitest';
import { isValidTimeZoneName } from '../../src/schemas/config';
import {
  ZONE_CHECK_MEMO_CAPACITY,
  createFixedClock,
  createSystemClock,
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
 * Unit tests for src/util/clock.ts (spec §10). Every expectation is pinned to
 * an explicit instant and zone, so the suite never depends on the host `TZ`.
 */

/** 2026-10-30T12:00:00Z — a modern instant with zone-dependent readings. */
const OCT_30_2026_NOON_UTC = 1_793_361_600_000;

const utc = resolveTimeZone('UTC');
const singapore = resolveTimeZone('Asia/Singapore');

describe('createSystemClock', () => {
  it('reads epoch time within a small slack of Date.now()', () => {
    const clock = createSystemClock();
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('exposes a non-decreasing monotonic reading', () => {
    const clock = createSystemClock();
    const first = clock.monotonicMs();
    const second = clock.monotonicMs();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe('createFixedClock', () => {
  it('returns the pinned readings', () => {
    const clock = createFixedClock(OCT_30_2026_NOON_UTC, 250);
    expect(clock.now()).toBe(OCT_30_2026_NOON_UTC);
    expect(clock.monotonicMs()).toBe(250);
  });

  it('defaults the monotonic reading to zero', () => {
    expect(createFixedClock(0).monotonicMs()).toBe(0);
  });

  it('set() jumps the wall clock without moving the monotonic reading', () => {
    const clock = createFixedClock(1_000, 40);
    clock.set(999_999);
    expect(clock.now()).toBe(999_999);
    expect(clock.monotonicMs()).toBe(40);
  });

  it('advance() moves both readings, including backwards', () => {
    const clock = createFixedClock(1_000, 40);
    clock.advance(60);
    expect(clock.now()).toBe(1_060);
    expect(clock.monotonicMs()).toBe(100);
    clock.advance(-10);
    expect(clock.now()).toBe(1_050);
    expect(clock.monotonicMs()).toBe(90);
  });

  it('rejects an advance whose sum overflows a reading to Infinity', () => {
    const clock = createFixedClock(Number.MAX_VALUE);
    expect(() => clock.advance(Number.MAX_VALUE)).toThrow(
      'fixed clock epoch must be a finite number, got Infinity',
    );
    expect(clock.now()).toBe(Number.MAX_VALUE);
    // The monotonic reading overflows on its own: the epoch sum stays
    // finite while the monotonic sum does not.
    const monotonic = createFixedClock(0, Number.MAX_VALUE);
    expect(() => monotonic.advance(1e308)).toThrow(
      'fixed clock monotonic reading must be a finite number, got Infinity',
    );
  });

  it('rejects non-finite inputs at every seam, naming it', () => {
    // Each seam names what was non-finite — the message a test double
    // relies on to tell its own wiring mistakes apart (U-008 triage).
    expect(() => createFixedClock(Number.NaN)).toThrow(
      'fixed clock epoch must be a finite number, got NaN',
    );
    expect(() => createFixedClock(0, Number.POSITIVE_INFINITY)).toThrow(
      'fixed clock monotonic start must be a finite number, got Infinity',
    );
    const clock = createFixedClock(0);
    expect(() => clock.set(Number.NaN)).toThrow(
      'fixed clock epoch must be a finite number, got NaN',
    );
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(
      'fixed clock advance must be a finite number, got Infinity',
    );
  });
});

describe('isValidTimeZone', () => {
  it.each([
    'UTC',
    'GMT',
    'Asia/Singapore',
    'America/New_York',
    'Europe/Kyiv',
    'Asia/Kolkata',
    'Etc/GMT+5',
    'EST',
    // Links/aliases and V8's case-insensitive resolution follow Intl (D-014 item 8).
    'Asia/Calcutta',
    'Europe/Kiev',
    'asia/singapore',
    'ASIA/SINGAPORE',
  ])('accepts %j', (name) => {
    expect(isValidTimeZone(name)).toBe(true);
  });

  it.each(['', 'Not/AZone', 'America/Noo_York', 'Pacific/Apia '])('rejects %j', (name) => {
    expect(isValidTimeZone(name)).toBe(false);
  });

  it('rejects ECMA-402 offset identifiers that Intl would accept', () => {
    expect(isValidTimeZone('+03:00')).toBe(false);
    expect(isValidTimeZone('-05:00')).toBe(false);
  });

  it('rejects Luxon pseudo-zones that Intl does not resolve', () => {
    expect(isValidTimeZone('local')).toBe(false);
    expect(isValidTimeZone('system')).toBe(false);
    expect(isValidTimeZone('default')).toBe(false);
  });
});

describe('isValidTimeZone memo growth is bounded (decision D-171)', () => {
  it('answers fresh names correctly once the memo is at capacity', () => {
    // Fill the memo to ZONE_CHECK_MEMO_CAPACITY distinct names using
    // synthetic names no other test in this file uses: the guard then
    // skips caching, and every further answer comes from a fresh
    // computation — memoization stays transparent at capacity.
    for (let index = 0; index < ZONE_CHECK_MEMO_CAPACITY; index += 1) {
      expect(isValidTimeZone(`definitely-not-a-zone-${index}`)).toBe(false);
    }
    // Fresh names beyond the cap: correct on the uncached first call…
    expect(isValidTimeZone('Pacific/Chatham')).toBe(true);
    expect(isValidTimeZone('also-not-a-zone-past-the-cap')).toBe(false);
    // …and identical on repeat — cached or recomputed, the verdict is
    // deterministic per name.
    expect(isValidTimeZone('Pacific/Chatham')).toBe(true);
    expect(isValidTimeZone('also-not-a-zone-past-the-cap')).toBe(false);
  });

  it('observes the bound: cached names skip the Intl construction, beyond-capacity names pay it per call', () => {
    // The capacity guard's observable face (review P2-1): results are
    // identical cached or not, so the bound is watched through the one
    // side effect memoization exists to skip — the `Intl.DateTimeFormat`
    // construction `resolvableByIntl` performs. A counting subclass
    // replaces the global for the test's duration (restored in finally;
    // nothing else runs inside this test's window), so no production
    // seam is added for tests.
    //
    // Saturate first (idempotent: the fill above may already have; an
    // already-full map stays full).
    for (let index = 0; index < ZONE_CHECK_MEMO_CAPACITY; index += 1) {
      isValidTimeZone(`saturation-fill-${index}`);
    }
    const realDateTimeFormat = Intl.DateTimeFormat;
    let constructions = 0;
    // A delegating constructable stub: `new`-called (what
    // `resolvableByIntl` does — an explicit `return` from a
    // `new`-invoked function replaces the fresh `this`), it counts
    // before delegating, so an invalid zone's throw still counts as a
    // construction attempt. A plain function expression, not an arrow:
    // arrows have no [[Construct]] and `new` on one throws. The double
    // cast bridges onto the interface's callable-constructor type; the
    // original is restored in `finally`.
    const countingFormatter = function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ): Intl.DateTimeFormat {
      constructions += 1;
      return new realDateTimeFormat(...args);
    };
    try {
      Intl.DateTimeFormat = countingFormatter as unknown as typeof Intl.DateTimeFormat;
      // A name cached before saturation: repeated lookups construct
      // nothing — the memoization itself, pinned for the first time.
      const before = constructions;
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(constructions - before).toBe(0);
      // A fresh name beyond the cap: computed per call — every lookup
      // pays the construction, the observable face of the skipped
      // cache write. (An always-cache or never-cache mutant of the
      // guard dies here: 0 or 1 instead of 2.)
      expect(isValidTimeZone('uncached-probe-fresh')).toBe(false);
      expect(isValidTimeZone('uncached-probe-fresh')).toBe(false);
      expect(constructions - before).toBe(2);
    } finally {
      Intl.DateTimeFormat = realDateTimeFormat;
    }
  });

  it('sizes the capacity over the engine’s own canonical zone list', () => {
    // The sizing rationale made executable, both halves: the capacity
    // must hold at least the engine's listed IANA names AND at least
    // the tzdb's ≈600 names including backward links (the engine lists
    // only ≈420 of those), so a legitimate workload that validates
    // every tzdb name through this gate stays fully cached. Either
    // relation failing forces a capacity revisit instead of silently
    // uncaching legitimate traffic.
    const engineZones = Intl.supportedValuesOf('timeZone');
    expect(engineZones.length).toBeGreaterThan(0);
    expect(ZONE_CHECK_MEMO_CAPACITY).toBeGreaterThanOrEqual(engineZones.length);
    expect(ZONE_CHECK_MEMO_CAPACITY).toBeGreaterThanOrEqual(600);
  });
});

describe('resolveTimeZone', () => {
  it('brands and returns a valid name unchanged', () => {
    expect(resolveTimeZone('Asia/Singapore')).toBe('Asia/Singapore');
  });

  it('throws an English error naming the rejected input', () => {
    expect(() => resolveTimeZone('Mars/Olympus_Mons')).toThrow(
      /'Mars\/Olympus_Mons' is not a valid IANA time zone/,
    );
  });
});

describe('clock and configuration zone validators stay in parity (D-021)', () => {
  const corpus = [
    'UTC',
    'GMT',
    'Asia/Singapore',
    'asia/singapore',
    'Asia/Calcutta',
    'America/New_York',
    'Etc/GMT+5',
    'EST',
    'local',
    'system',
    '',
    'Not/AZone',
    '+03:00',
    '-05:00',
    'America/Argentina/Buenos_Aires',
    'Europe/Kyiv',
    'Europe/Kiev',
  ];

  it.each(corpus)('agrees with isValidTimeZoneName on %j', (name) => {
    expect(isValidTimeZone(name)).toBe(isValidTimeZoneName(name));
  });
});

describe('zonedDateTime', () => {
  it('locates the epoch in the requested zone (UTC reading)', () => {
    const dateTime = zonedDateTime(0, utc);
    expect(dateTime.toISO()).toBe('1970-01-01T00:00:00.000Z');
    expect(dateTime.offset).toBe(0);
  });

  it('uses ICU history: Singapore read +07:30 at the epoch', () => {
    const dateTime = zonedDateTime(0, singapore);
    expect(dateTime.toFormat('HH:mm')).toBe('07:30');
    expect(dateTime.offset).toBe(450);
  });

  it('reads the same instant correctly across zones', () => {
    expect(zonedDateTime(OCT_30_2026_NOON_UTC, singapore).toFormat('HH:mm ZZ')).toBe(
      '20:00 +08:00',
    );
    expect(zonedDateTime(OCT_30_2026_NOON_UTC, utc).toFormat('HH:mm ZZ')).toBe('12:00 +00:00');
    expect(
      zonedDateTime(OCT_30_2026_NOON_UTC, resolveTimeZone('Europe/London')).toFormat('HH:mm'),
    ).toBe('12:00');
    expect(
      zonedDateTime(OCT_30_2026_NOON_UTC, resolveTimeZone('Asia/Kolkata')).toFormat('HH:mm'),
    ).toBe('17:30');
  });

  it('applies the DST offset on each side of the 2026 New York spring-forward gap', () => {
    const new_york = resolveTimeZone('America/New_York');
    const beforeGap = Date.UTC(2026, 2, 8, 6, 59, 59);
    const afterGap = Date.UTC(2026, 2, 8, 7, 0, 0);
    expect(zonedDateTime(beforeGap, new_york).toFormat('HH:mm:ss ZZ')).toBe('01:59:59 -05:00');
    expect(zonedDateTime(afterGap, new_york).toFormat('HH:mm ZZ')).toBe('03:00 -04:00');
  });

  it('throws on a non-finite or out-of-range epoch', () => {
    expect(() => zonedDateTime(Number.NaN, utc)).toThrow(/invalid date-time/);
    expect(() => zonedDateTime(Number.POSITIVE_INFINITY, utc)).toThrow(/invalid date-time/);
    expect(() => zonedDateTime(9e15, utc)).toThrow(/invalid date-time/);
    // The message names the epoch and the zone so the operator can tell
    // which conversion failed (pinned verbatim, U-008 triage).
    expect(() => zonedDateTime(Number.NaN, utc)).toThrow(
      "invalid date-time for epoch NaN in zone 'UTC': invalid input",
    );
  });

  it('throws on an unsupported zone despite the brand (erased at runtime)', () => {
    expect(() => zonedDateTime(0, 'Totally/Bogus' as ReturnType<typeof resolveTimeZone>)).toThrow(
      /not a valid IANA time zone/,
    );
  });

  it('rejects Luxon pseudo-zones and offset ids that would read machine-local time', () => {
    // Luxon accepts these as valid zones; the §10 invariant forbids them.
    for (const zone of ['local', 'system', 'default', 'utc+4', '+08:00']) {
      expect(() => zonedDateTime(0, zone as ReturnType<typeof resolveTimeZone>)).toThrow(
        /not a valid IANA time zone/,
      );
    }
  });
});

describe('toUtcIso', () => {
  it('formats with millisecond precision and a Z suffix', () => {
    expect(toUtcIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toUtcIso(86_400_000)).toBe('1970-01-02T00:00:00.000Z');
    expect(toUtcIso(OCT_30_2026_NOON_UTC)).toBe('2026-10-30T12:00:00.000Z');
    expect(toUtcIso(OCT_30_2026_NOON_UTC + 123)).toBe('2026-10-30T12:00:00.123Z');
  });

  it('zero-pads years below 1000', () => {
    expect(toUtcIso(-62_135_596_800_000)).toBe('0001-01-01T00:00:00.000Z');
  });

  it('throws on non-finite or out-of-range epochs', () => {
    expect(() => toUtcIso(Number.NaN)).toThrow(/invalid date-time/);
    expect(() => toUtcIso(9e15)).toThrow(/invalid date-time/);
  });
});

describe('epochMsFromIso', () => {
  it('parses Z, lowercase z, and numeric offsets into the same instant', () => {
    expect(epochMsFromIso('2026-10-30T12:00:00Z')).toBe(OCT_30_2026_NOON_UTC);
    expect(epochMsFromIso('2026-10-30t12:00:00z')).toBe(OCT_30_2026_NOON_UTC);
    expect(epochMsFromIso('2026-10-30T20:00:00+08:00')).toBe(OCT_30_2026_NOON_UTC);
    expect(epochMsFromIso('2026-10-30T20:00:00+0800')).toBe(OCT_30_2026_NOON_UTC);
    expect(epochMsFromIso('2026-10-30T07:00:00-05:00')).toBe(OCT_30_2026_NOON_UTC);
  });

  it('keeps sub-second precision and the far edge of year 9999', () => {
    expect(epochMsFromIso('2026-10-30T12:00:00.123Z')).toBe(OCT_30_2026_NOON_UTC + 123);
    expect(epochMsFromIso('9999-12-31T23:59:59.999Z')).toBe(253_402_300_799_999);
  });

  it('rejects strings without an explicit offset', () => {
    expect(() => epochMsFromIso('2026-10-30T12:00:00')).toThrow(/explicit offset/);
    expect(() => epochMsFromIso('2026-10-30')).toThrow(/explicit offset/);
    expect(() => epochMsFromIso('2026-10-30T12:00:00+03')).toThrow(/explicit offset/);
    // The designator must anchor the end of the string: a text tail after
    // an otherwise-valid offset is still an offset-less timestamp (the
    // unanchored pattern would wave it through to a different failure).
    expect(() => epochMsFromIso('2026-10-30T20:00:00+08:00tail')).toThrow(
      "ISO 8601 timestamp must carry an explicit offset or 'Z': '2026-10-30T20:00:00+08:00tail'",
    );
  });

  it('rejects invalid timestamps with the reason', () => {
    expect(() => epochMsFromIso('')).toThrow(/explicit offset/);
    expect(() => epochMsFromIso('not-a-dateZ')).toThrow(/invalid date-time/);
    expect(() => epochMsFromIso('2026-13-01T00:00:00Z')).toThrow(/invalid date-time/);
    // The message echoes the rejected timestamp and Luxon's reason.
    expect(() => epochMsFromIso('2026-13-01T00:00:00Z')).toThrow(
      "invalid date-time for ISO timestamp '2026-13-01T00:00:00Z': unit out of range",
    );
  });
});

describe('zonedParts', () => {
  it('reads wall-clock fields, offset, and ISO weekday in the zone', () => {
    // 2026-10-30T20:00Z is already Saturday, 2026-10-31 05:00 in Tokyo.
    const parts = zonedParts(Date.UTC(2026, 9, 30, 20), resolveTimeZone('Asia/Tokyo'));
    expect(parts).toEqual({
      epochMs: Date.UTC(2026, 9, 30, 20),
      offsetMinutes: 540,
      year: 2026,
      month: 10,
      day: 31,
      hour: 5,
      minute: 0,
      second: 0,
      millisecond: 0,
      weekday: 6,
    });
  });

  it('echoes the source instant unchanged', () => {
    expect(zonedParts(OCT_30_2026_NOON_UTC, singapore).epochMs).toBe(OCT_30_2026_NOON_UTC);
  });

  it('throws like zonedDateTime on invalid input', () => {
    expect(() => zonedParts(Number.NaN, utc)).toThrow(/invalid date-time/);
  });
});

describe('formatZonedTime / formatZonedDate', () => {
  it('formats the local time and calendar date in the zone', () => {
    expect(formatZonedTime(OCT_30_2026_NOON_UTC, singapore)).toBe('20:00');
    expect(formatZonedTime(OCT_30_2026_NOON_UTC, resolveTimeZone('America/New_York'))).toBe(
      '08:00',
    );
    expect(formatZonedDate(OCT_30_2026_NOON_UTC, utc)).toBe('2026-10-30');
    // Noon UTC is still the same calendar day in Tokyo (21:00 local)…
    expect(formatZonedDate(OCT_30_2026_NOON_UTC, resolveTimeZone('Asia/Tokyo'))).toBe('2026-10-30');
    // …but 20:00Z has already rolled over to the next day there.
    expect(formatZonedDate(Date.UTC(2026, 9, 30, 20), resolveTimeZone('Asia/Tokyo'))).toBe(
      '2026-10-31',
    );
  });

  it('throws on invalid input', () => {
    expect(() => formatZonedTime(Number.NaN, utc)).toThrow(/invalid date-time/);
    expect(() => formatZonedDate(9e15, utc)).toThrow(/invalid date-time/);
  });
});
