import { describe, expect, it } from 'vitest';
import { epochMsFromIso, resolveTimeZone, zonedParts } from '../../src/util/clock';
import type { TimeZone } from '../../src/util/clock';
import { resolveLocalInstantDst } from '../../src/services/peak-hours-dst';
import { resolveLocalInstantLuxon } from '../../src/services/peak-hours-intervals';
import type { LocalScheduleTime } from '../../src/services/peak-hours-intervals';

/**
 * The §9.3 DST policy, pinned by exact instants (task 115, decision D-079):
 * a nonexistent local reading (inside a spring-forward gap) shifts forward
 * by the exact size of the gap, and an ambiguous one (inside a fall-back
 * overlap) resolves to the FIRST occurrence.
 *
 * Expected instants are hand-derived from the zones' transition facts —
 * stated and offset-arithmetic-annotated per case, never produced by the
 * module under test — as verified against the tz database on the pinned
 * runtime (Node 22.13.0, 2026 rules):
 *
 * | Zone                | gap (spring)      | overlap (fall)    | offsets        |
 * | ------------------- | ----------------- | ----------------- | -------------- |
 * | America/New_York    | 03-08 02:00→03:00 | 11-01 02:00→01:00 | −5 → −4 → −5   |
 * | Europe/London       | 03-29 01:00→02:00 | 10-25 02:00→01:00 | 0 → +1 → 0     |
 * | Australia/Lord_Howe | 10-04 02:00→02:30 | 04-05 02:00→01:30 | +10:30→+11→+10:30 |
 * | Pacific/Chatham     | 09-27 02:45→03:45 | 04-05 03:45→02:45 | +12:45→+13:45→+12:45 |
 * | America/Havana      | 03-08 00:00→01:00 | 11-01 01:00→00:00 | −5 → −4 → −5   |
 *
 * §17.1 names the first four and `UTC` for transition coverage;
 * `America/Havana` joins them because its gap starts at midnight (the
 * shape task 114's review flagged), and the fixed zones appear in the
 * no-DST matrix below.
 */

/** `epochMsFromIso` under a shorter name — every expected instant goes through it. */
const iso = epochMsFromIso;

/** A local reading; minute values are minutes since local midnight. */
const at = (
  year: number,
  month: number,
  day: number,
  minutesSinceMidnight: number,
): LocalScheduleTime => ({ year, month, day, minutesSinceMidnight });

describe('spring-forward gaps shift nonexistent readings forward by the exact gap', () => {
  it('America/New_York: a one-hour gap [02:00, 03:00) on 2026-03-08', () => {
    const zone = resolveTimeZone('America/New_York');
    // EST is UTC−5 until 02:00 wall (07:00Z), then EDT (UTC−4).
    expect(resolveLocalInstantDst(at(2026, 3, 8, 1 * 60 + 59), zone)).toBe(
      // 01:59 is the last reading before the jump — 01:59 + 5:00.
      iso('2026-03-08T06:59:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 8, 2 * 60 + 0), zone)).toBe(
      // 02:00 does not exist: shifted by the 60-minute gap it is the
      // instant of 03:00 EDT = 02:00 + 5:00 = 07:00Z.
      iso('2026-03-08T07:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 8, 2 * 60 + 30), zone)).toBe(
      // 02:30 + 60 min = 03:30 EDT = 07:30Z (§9.3's own example shape).
      iso('2026-03-08T07:30:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 8, 2 * 60 + 59), zone)).toBe(
      iso('2026-03-08T07:59:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 8, 3 * 60), zone)).toBe(
      // 03:00 exists — same instant the shifted 02:00 lands on.
      iso('2026-03-08T07:00:00.000Z'),
    );
  });

  it('Europe/London: the gap starts at 01:00 on 2026-03-29 (GMT → BST)', () => {
    const zone = resolveTimeZone('Europe/London');
    expect(resolveLocalInstantDst(at(2026, 3, 29, 60), zone)).toBe(
      // 01:00 GMT would be 01:00Z; shifted by the gap it IS 01:00Z, where
      // the clock reads 02:00 BST.
      iso('2026-03-29T01:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 29, 90), zone)).toBe(
      // 01:30 + 60 min = 02:30 BST = 01:30Z.
      iso('2026-03-29T01:30:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 29, 120), zone)).toBe(
      // 02:00 exists as the first BST reading: 02:00 − 1:00.
      iso('2026-03-29T01:00:00.000Z'),
    );
  });

  it('Australia/Lord_Howe: the gap is only 30 minutes, [02:00, 02:30) on 2026-10-04', () => {
    const zone = resolveTimeZone('Australia/Lord_Howe');
    expect(resolveLocalInstantDst(at(2026, 10, 4, 2 * 60), zone)).toBe(
      // +10:30 before the jump: 02:00 + 10:30 = 15:30Z the previous day;
      // the shifted reading (02:30 at +11:00) is that same instant.
      iso('2026-10-03T15:30:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 10, 4, 2 * 60 + 15), zone)).toBe(
      // 02:15 + the 30-minute gap = 02:45 at +11:00 = 15:45Z — the shift is
      // the offset delta, not a fixed hour.
      iso('2026-10-03T15:45:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 10, 4, 2 * 60 + 29), zone)).toBe(
      iso('2026-10-03T15:59:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 10, 4, 2 * 60 + 30), zone)).toBe(
      // 02:30 exists at +11:00: 15:30Z.
      iso('2026-10-03T15:30:00.000Z'),
    );
  });

  it('Pacific/Chatham: the gap starts at 02:45 on 2026-09-27 (+12:45 → +13:45)', () => {
    const zone = resolveTimeZone('Pacific/Chatham');
    expect(resolveLocalInstantDst(at(2026, 9, 27, 2 * 60 + 44), zone)).toBe(
      // 02:44 + 12:45 = 13:59Z the previous day — the last existing minute.
      iso('2026-09-26T13:59:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 9, 27, 2 * 60 + 45), zone)).toBe(
      // 02:45 + 60 min = 03:45 at +13:45 = 2026-09-26T14:00Z.
      iso('2026-09-26T14:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 9, 27, 3 * 60), zone)).toBe(
      // 03:00 + 60 min = 04:00 at +13:45 = 14:15Z.
      iso('2026-09-26T14:15:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 9, 27, 3 * 60 + 45), zone)).toBe(
      // 03:45 exists at +13:45 — the same instant the shifted 02:45 hits.
      iso('2026-09-26T14:00:00.000Z'),
    );
  });

  it('America/Havana: a gap that starts at midnight, [00:00, 01:00) on 2026-03-08', () => {
    const zone = resolveTimeZone('America/Havana');
    expect(resolveLocalInstantDst(at(2026, 3, 7, 23 * 60 + 59), zone)).toBe(
      // 23:59 CST (UTC−5) of the previous day: 2026-03-08T04:59Z.
      iso('2026-03-08T04:59:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 8, 0), zone)).toBe(
      // The day's midnight does not exist: shifted to 01:00 CDT = 05:00Z.
      iso('2026-03-08T05:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 3, 8, 30), zone)).toBe(iso('2026-03-08T05:30:00.000Z'));
    expect(resolveLocalInstantDst(at(2026, 3, 8, 60), zone)).toBe(
      // 01:00 exists at CDT (UTC−4) — again the shifted-midnight instant.
      iso('2026-03-08T05:00:00.000Z'),
    );
  });

  it('Pacific/Apia: a whole-day dateline gap — 2011-12-30 never happened', () => {
    const zone = resolveTimeZone('Pacific/Apia');
    // Samoa skipped 2011-12-30 when it moved across the dateline: at
    // 2011-12-30T10:00Z the offset jumped from −10:00 to +14:00, so the
    // local day 2011-12-30 (and only it) does not exist.
    expect(resolveLocalInstantDst(at(2011, 12, 29, 12 * 60), zone)).toBe(
      // 2011-12-29 12:00 at −10:00.
      iso('2011-12-29T22:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2011, 12, 30, 12 * 60), zone)).toBe(
      // The reading is inside a 24-hour gap: shifted forward by the full
      // offset delta it is the instant of 2011-12-31 12:00 at +14:00 —
      // 2011-12-30T22:00Z (the pre-offset candidate, whose wall reading
      // lands on December 31, is rejected by the round-trip).
      iso('2011-12-30T22:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2011, 12, 31, 0), zone)).toBe(
      // 2011-12-31 00:00 at +14:00 = 2011-12-30T10:00Z — the transition
      // instant itself.
      iso('2011-12-30T10:00:00.000Z'),
    );
  });

  it('the shifted instant reads back as the wall time plus the gap', () => {
    const zone = resolveTimeZone('America/New_York');
    const shifted = resolveLocalInstantDst(at(2026, 3, 8, 2 * 60 + 30), zone);
    const parts = zonedParts(shifted, zone);
    // The §9.3 sentence made observable: 02:30 "is" 03:30 after the shift.
    expect(`${parts.hour}:${String(parts.minute).padStart(2, '0')}`).toBe('3:30');
    expect(parts.offsetMinutes).toBe(-240);
  });
});

describe('fall-back overlaps resolve ambiguous readings to the first occurrence', () => {
  it('America/New_York: [01:00, 02:00) repeats on 2026-11-01', () => {
    const zone = resolveTimeZone('America/New_York');
    expect(resolveLocalInstantDst(at(2026, 11, 1, 60), zone)).toBe(
      // First of the two 01:00s: EDT (UTC−4) = 05:00Z; the second (EST)
      // would be 06:00Z.
      iso('2026-11-01T05:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 11, 1, 90), zone)).toBe(
      // First 01:30 = 05:30Z, not the 06:30Z EST repetition.
      iso('2026-11-01T05:30:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 11, 1, 2 * 60), zone)).toBe(
      // 02:00 exists once, at EST: 07:00Z.
      iso('2026-11-01T07:00:00.000Z'),
    );
  });

  it('Europe/London: the first 01:30 on 2026-10-25 is the BST one', () => {
    const zone = resolveTimeZone('Europe/London');
    expect(resolveLocalInstantDst(at(2026, 10, 25, 90), zone)).toBe(
      // 01:30 BST = 00:30Z; the GMT repetition would be 01:30Z.
      iso('2026-10-25T00:30:00.000Z'),
    );
  });

  it('Australia/Lord_Howe: a 30-minute overlap [01:30, 02:00) on 2026-04-05', () => {
    const zone = resolveTimeZone('Australia/Lord_Howe');
    expect(resolveLocalInstantDst(at(2026, 4, 5, 90), zone)).toBe(
      // First 01:30 = +11:00 → 2026-04-04T14:30Z; the +10:30 repetition
      // would be 15:00Z.
      iso('2026-04-04T14:30:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 4, 5, 105), zone)).toBe(
      // First 01:45 = 14:45Z.
      iso('2026-04-04T14:45:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 4, 5, 120), zone)).toBe(
      // 02:00 exists once, at +10:30: 15:30Z.
      iso('2026-04-04T15:30:00.000Z'),
    );
  });

  it('Pacific/Chatham: [02:45, 03:45) repeats on 2026-04-05', () => {
    const zone = resolveTimeZone('Pacific/Chatham');
    expect(resolveLocalInstantDst(at(2026, 4, 5, 2 * 60 + 45), zone)).toBe(
      // First 02:45 = +13:45 → 2026-04-04T13:00Z; the +12:45 repetition
      // would be 14:00Z.
      iso('2026-04-04T13:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 4, 5, 3 * 60), zone)).toBe(
      // First 03:00 = 13:15Z.
      iso('2026-04-04T13:15:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 4, 5, 3 * 60 + 45), zone)).toBe(
      // 03:45 exists once, at +12:45: 15:00Z.
      iso('2026-04-04T15:00:00.000Z'),
    );
  });

  it('America/Havana: an ambiguous midnight [00:00, 01:00) on 2026-11-01', () => {
    const zone = resolveTimeZone('America/Havana');
    expect(resolveLocalInstantDst(at(2026, 11, 1, 0), zone)).toBe(
      // First 00:00 = CDT (UTC−4) = 04:00Z; the CST repetition is 05:00Z.
      iso('2026-11-01T04:00:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 11, 1, 30), zone)).toBe(iso('2026-11-01T04:30:00.000Z'));
    expect(resolveLocalInstantDst(at(2026, 11, 1, 60), zone)).toBe(
      // 01:00 exists once, at CST: 06:00Z.
      iso('2026-11-01T06:00:00.000Z'),
    );
  });

  it('Australia/Sydney: first occurrence in a positive-offset zone too', () => {
    // Not part of §17.1's list, but the case that distinguishes policy from
    // convergence: for wall readings east of UTC the pseudo-epoch sits after
    // the transition instant, so a guess-seeded algorithm can return the
    // later repetition. Explicit differencing returns the first by
    // construction: 02:30 AEDT (+11:00) = 2026-04-04T15:30Z, not the
    // 16:30Z AEST repetition.
    const zone = resolveTimeZone('Australia/Sydney');
    expect(resolveLocalInstantDst(at(2026, 4, 5, 2 * 60 + 30), zone)).toBe(
      iso('2026-04-04T15:30:00.000Z'),
    );
  });
});

describe('zones without DST resolve by their fixed offset', () => {
  it('UTC, Asia/Shanghai, Asia/Kolkata, and the production zone Asia/Singapore', () => {
    const utc = resolveTimeZone('UTC');
    const shanghai = resolveTimeZone('Asia/Shanghai');
    const kolkata = resolveTimeZone('Asia/Kolkata');
    const singapore = resolveTimeZone('Asia/Singapore');
    expect(resolveLocalInstantDst(at(2026, 5, 1, 12 * 60 + 34), utc)).toBe(
      iso('2026-05-01T12:34:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 5, 1, 9 * 60 + 5), shanghai)).toBe(
      // UTC+8: 09:05 − 8:00.
      iso('2026-05-01T01:05:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 5, 1, 9 * 60 + 5), kolkata)).toBe(
      // UTC+5:30: 09:05 − 5:30.
      iso('2026-05-01T03:35:00.000Z'),
    );
    expect(resolveLocalInstantDst(at(2026, 11, 2, 14 * 60), singapore)).toBe(
      // The §9.1 Z.ai window start: Singapore 14:00 = 06:00Z, all year.
      iso('2026-11-02T06:00:00.000Z'),
    );
  });
});

describe('the `24:00` window end', () => {
  it('is the following day’s local midnight on a normal day', () => {
    expect(resolveLocalInstantDst(at(2026, 3, 8, 1440), resolveTimeZone('UTC'))).toBe(
      iso('2026-03-09T00:00:00.000Z'),
    );
  });

  it('shifts forward when that midnight falls inside a DST gap', () => {
    const zone = resolveTimeZone('America/Havana');
    // 24:00 of 2026-03-07 is 00:00 of 2026-03-07+1 — inside Havana's
    // midnight gap — so the §9.3 shift applies to window ends as much as to
    // any other reading: the same 05:00Z as the day's 00:00 and 01:00.
    expect(resolveLocalInstantDst(at(2026, 3, 7, 1440), zone)).toBe(
      iso('2026-03-08T05:00:00.000Z'),
    );
  });

  it('takes the first occurrence when that midnight is ambiguous', () => {
    const zone = resolveTimeZone('America/Havana');
    // 24:00 of 2026-10-31 is the ambiguous 00:00 of 2026-11-01: the first
    // occurrence (CDT) wins, 04:00Z — not the 05:00Z CST repetition.
    expect(resolveLocalInstantDst(at(2026, 10, 31, 1440), zone)).toBe(
      iso('2026-11-01T04:00:00.000Z'),
    );
  });

  it('diverges from the Luxon compat resolver when the day’s own midnight was gapped', () => {
    const zone = resolveTimeZone('America/Havana');
    // 24:00 of the gap day 2026-03-08 is the ordinary 00:00 of 2026-03-09:
    // the authoritative resolver normalizes `24:00` to that next-day wall
    // reading (00:00 CDT = 04:00Z). Luxon instead adds a calendar day to
    // the *shifted* midnight (wall 01:00 of 03-08) and lands on wall 01:00
    // of 03-09 = 05:00Z — the shift applied twice (D-079; the parity sweep
    // of `peak-hours-dst.property.spec.ts` skips `24:00` for this reason).
    expect(resolveLocalInstantDst(at(2026, 3, 8, 1440), zone)).toBe(
      iso('2026-03-09T04:00:00.000Z'),
    );
    expect(resolveLocalInstantLuxon(at(2026, 3, 8, 1440), zone)).toBe(
      iso('2026-03-09T05:00:00.000Z'),
    );
  });
});

describe('fail-fast inputs', () => {
  const UTC: TimeZone = resolveTimeZone('UTC');

  it('rejects a non-IANA zone through the gate', () => {
    expect(() => resolveLocalInstantDst(at(2026, 11, 2, 0), 'local' as TimeZone)).toThrow(
      /'local' is not a valid IANA time zone/,
    );
  });

  it('rejects non-integer and out-of-range minutes', () => {
    expect(() => resolveLocalInstantDst(at(2026, 11, 2, 1441), UTC)).toThrow(
      /local schedule minutes must be an integer in 0-1440, got 1441/,
    );
    expect(() => resolveLocalInstantDst(at(2026, 11, 2, -1), UTC)).toThrow(
      /must be an integer in 0-1440, got -1/,
    );
    expect(() => resolveLocalInstantDst(at(2026, 11, 2, 12.5), UTC)).toThrow(
      /must be an integer in 0-1440, got 12.5/,
    );
  });

  it('rejects impossible calendar dates', () => {
    expect(() => resolveLocalInstantDst(at(2026, 2, 30, 0), UTC)).toThrow(
      /local schedule date 2026-2-30 is not a valid calendar date/,
    );
    // Month 13 rolls into the next year under Date.UTC — caught by the
    // field round-trip.
    expect(() => resolveLocalInstantDst(at(2026, 13, 1, 0), UTC)).toThrow(
      /local schedule date 2026-13-1 is not a valid calendar date/,
    );
    // Beyond the representable epoch range.
    expect(() => resolveLocalInstantDst(at(300000, 1, 1, 0), UTC)).toThrow(
      /local schedule date 300000-1-1 is not a valid calendar date/,
    );
  });

  it('rejects a `24:00` whose next midnight leaves the epoch range', () => {
    // 275760-09-13T00:00Z is the last representable midnight.
    expect(() => resolveLocalInstantDst(at(275760, 9, 13, 1440), UTC)).toThrow(
      /the day after 275760-9-13 is outside the supported epoch range/,
    );
  });

  it('resolves readings at the very edges of the epoch range', () => {
    // The last and first representable midnights. The out-of-range day
    // probes are skipped (no transition sits at either edge), and each
    // reading resolves to itself.
    expect(resolveLocalInstantDst(at(275760, 9, 13, 0), UTC)).toBe(8_640_000_000_000_000);
    expect(resolveLocalInstantDst(at(-271_821, 4, 20, 0), UTC)).toBe(-8_640_000_000_000_000);
    // `24:00` onto the last representable midnight still resolves.
    expect(resolveLocalInstantDst(at(275760, 9, 12, 1440), UTC)).toBe(8_640_000_000_000_000);
  });
});
