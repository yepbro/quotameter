import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { resolveTimeZone, zonedParts } from '../../src/util/clock';
import { DAY_MS } from '../../src/util/rolling-ranges';
import { resolveLocalInstantDst } from '../../src/services/peak-hours-dst';
import { MINUTES_PER_DAY, resolveLocalInstantLuxon } from '../../src/services/peak-hours-intervals';
import type { LocalScheduleTime } from '../../src/services/peak-hours-intervals';

/**
 * Standing proofs of the §9.3 DST policy (task 115, decision D-079):
 *
 * 1. **Exhaustive transition-day enumeration** — for every minute of every
 *    §17.1 DST zone's gap and overlap days (and their neighbors), the
 *    resolver agrees with an *independent scan oracle*: a brute-force
 *    minute-by-minute sweep of the zone (the epoch → wall-clock direction,
 *    `zonedParts`) that finds occurrences as first instants reading back as
 *    the wall time and gap answers as `transition + (wall − firstJumped)`.
 *    The oracle shares no code with the resolver's offset differencing.
 * 2. **Luxon parity** — the same enumeration checks the compat resolver
 *    `resolveLocalInstantLuxon` against the oracle, pinning the exported
 *    default of task 114 to the authoritative policy across the matrix.
 * 3. **Fixed-offset zones never shift** — for generated readings in zones
 *    without DST, resolving is the constant-offset inverse of `zonedParts`.
 * 4. **Arbitrary dates** — generated readings anywhere in 2024–2028 (any
 *    matrix zone, DST or fixed) agree with the scan oracle.
 *
 * 2026 transition facts (verified against the tz database on the pinned
 * runtime; the derivation of each expected instant is in
 * `peak-hours-dst.spec.ts`):
 *
 * | Zone                | gap day    | overlap day |
 * | ------------------- | ---------- | ----------- |
 * | America/New_York    | 2026-03-08 | 2026-11-01  |
 * | Europe/London       | 2026-03-29 | 2026-10-25  |
 * | Australia/Lord_Howe | 2026-10-04 | 2026-04-05  |
 * | Pacific/Chatham     | 2026-09-27 | 2026-04-05  |
 * | America/Havana      | 2026-03-08 | 2026-11-01  |
 */

/** The §17.1 DST zones' 2026 transition days, plus the matrix's fixed zones. */
const TRANSITION_DAYS = [
  { zone: 'America/New_York', gap: '2026-03-08', overlap: '2026-11-01' },
  { zone: 'Europe/London', gap: '2026-03-29', overlap: '2026-10-25' },
  { zone: 'Australia/Lord_Howe', gap: '2026-10-04', overlap: '2026-04-05' },
  { zone: 'Pacific/Chatham', gap: '2026-09-27', overlap: '2026-04-05' },
  { zone: 'America/Havana', gap: '2026-03-08', overlap: '2026-11-01' },
] as const;

/** Fixed-offset zones (no DST history in the generated era). */
const FIXED_ZONES = [
  'UTC',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'America/Phoenix',
] as const;

/**
 * ±50 hours of minute-step scanning. Enumeration covers readings up to one
 * day after the scan center (`24:00` of the day after the table's day), so
 * the sweep must reach: those readings' occurrences (up to 14 hours past
 * their pseudo-epoch, the |offset| bound) and the transitions that affect
 * them — 50 hours bounds both. Occurrences are exact-read matches, so a
 * wider window can only add real readings, never false ones.
 */
const SCAN_RADIUS_MS = 50 * 60 * 60_000;

/** Wall-clock fields as a comparable/exact key. */
interface WallFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** The reading of `time` as plain fields; `1440` normalizes to next midnight. */
function wallFieldsOf(time: LocalScheduleTime): WallFields {
  if (time.minutesSinceMidnight < 1440) {
    return {
      year: time.year,
      month: time.month,
      day: time.day,
      hour: Math.floor(time.minutesSinceMidnight / 60),
      minute: time.minutesSinceMidnight % 60,
    };
  }
  const next = new Date(Date.UTC(time.year, time.month - 1, time.day) + DAY_MS);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

const wallKey = (fields: WallFields): string =>
  `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;

/** Wall fields as the pseudo-epoch (fields read as if UTC). */
const pseudoMsOf = (fields: WallFields): number =>
  Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);

/** One brute-force sweep of the zone around `centerMs`. */
function scanZoneAround(
  zone: ReturnType<typeof resolveTimeZone>,
  centerMs: number,
): {
  firstByWall: Map<string, number>;
  transitions: { instant: number; fromWallMs: number; gapMinutes: number }[];
} {
  const firstByWall = new Map<string, number>();
  const transitions: { instant: number; fromWallMs: number; gapMinutes: number }[] = [];
  let previous: WallFields | undefined;
  let previousOffset = 0;
  for (let t = centerMs - SCAN_RADIUS_MS; t <= centerMs + SCAN_RADIUS_MS; t += 60_000) {
    const parts = zonedParts(t, zone);
    const fields: WallFields = {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
    };
    if (!firstByWall.has(wallKey(fields))) {
      firstByWall.set(wallKey(fields), t);
    }
    if (previous !== undefined && parts.offsetMinutes !== previousOffset) {
      // An offset jump at `t`: the minute after the last pre-jump reading is
      // the first wall time the jump covers (a gap start; negative for an
      // overlap).
      transitions.push({
        instant: t,
        fromWallMs: pseudoMsOf(previous) + 60_000,
        gapMinutes: parts.offsetMinutes - previousOffset,
      });
    }
    previous = fields;
    previousOffset = parts.offsetMinutes;
  }
  return { firstByWall, transitions };
}

/** The §9.3 answer derived purely from the scan: first occurrence or gap shift. */
function oracleResolve(scan: ReturnType<typeof scanZoneAround>, time: LocalScheduleTime): number {
  const fields = wallFieldsOf(time);
  const first = scan.firstByWall.get(wallKey(fields));
  if (first !== undefined) {
    return first;
  }
  const wallMs = pseudoMsOf(fields);
  for (const transition of scan.transitions) {
    if (
      transition.gapMinutes > 0 &&
      wallMs >= transition.fromWallMs &&
      wallMs < transition.fromWallMs + transition.gapMinutes * 60_000
    ) {
      // Shift forward by the gap: the transition instant plus how far into
      // the jumped-over interval the reading is.
      return transition.instant + (wallMs - transition.fromWallMs);
    }
  }
  throw new Error(`scan oracle found neither occurrence nor gap for ${wallKey(fields)}`);
}

/** Calendar fields of a UTC epoch day. */
function fieldsOfDate(dateMs: number): { year: number; month: number; day: number } {
  const date = new Date(dateMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** `YYYY-MM-DD` of the table above as a UTC epoch. */
const utcDay = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

// The exhaustive sweeps are compute-bound under load too: worst 7.1 s
// per test (the first-executed one, which also pays the coverage
// warm-up) in a full coverage `make check` under the six-hog rig, up
// to ~8 s at ambient sibling-wave load, vs 1.4 s clean isolated —
// hence the 25 s per-test timeout, ≈3× that worst per D-094's sizing
// rule (U-025).
describe('every minute of every §17.1 transition day agrees with the scan oracle', () => {
  for (const { zone, gap, overlap } of TRANSITION_DAYS) {
    for (const kind of ['gap', 'overlap'] as const) {
      it(`${zone}, ${kind} day and its neighbors, every minute (incl. Luxon parity)`, () => {
        const branded = resolveTimeZone(zone);
        const centerDay = kind === 'gap' ? gap : overlap;
        for (const dayOffset of [-1, 0, 1]) {
          const dateMs = utcDay(centerDay) + dayOffset * DAY_MS;
          const scan = scanZoneAround(branded, dateMs);
          const { year, month, day } = fieldsOfDate(dateMs);
          for (let minute = 0; minute <= 1440; minute++) {
            const time: LocalScheduleTime = { year, month, day, minutesSinceMidnight: minute };
            const expected = oracleResolve(scan, time);
            expect(resolveLocalInstantDst(time, branded), `${zone} ${centerDay} ${minute}`).toBe(
              expected,
            );
            if (
              minute === MINUTES_PER_DAY &&
              !scan.firstByWall.has(wallKey({ year, month, day, hour: 0, minute: 0 }))
            ) {
              // Deliberate, pinned divergence (D-079), and only here: the
              // compat resolver computes `24:00` as the (possibly shifted)
              // midnight plus one calendar day, which double-shifts exactly
              // when the day's own midnight was gapped — detected via the
              // oracle as a 00:00 reading with no occurrence (Havana's gap
              // day among the matrix zones). Everywhere else `24:00` parity
              // is asserted; the divergence itself is pinned in
              // `peak-hours-dst.spec.ts`.
              continue;
            }
            expect(
              resolveLocalInstantLuxon(time, branded),
              `Luxon parity ${zone} ${centerDay} ${minute}`,
            ).toBe(expected);
          }
        }
      }, 25_000);
    }
  }
});

describe('generated readings (fast-check)', () => {
  /** Calendar dates 2024–2028 whose `Date.UTC` construction is always valid. */
  const dateArb = fc
    .integer({ min: utcDay('2024-01-01'), max: utcDay('2028-12-31') })
    .map(fieldsOfDate);

  it('fixed-offset zones never shift: resolve is the constant-offset inverse', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXED_ZONES),
        dateArb,
        fc.integer({ min: 0, max: 1440 }),
        (zoneName, date, minute) => {
          const zone = resolveTimeZone(zoneName);
          const time: LocalScheduleTime = { ...date, minutesSinceMidnight: minute };
          const instant = resolveLocalInstantDst(time, zone);
          // The reading reads back identically…
          const back = zonedParts(instant, zone);
          const expectedFields = wallFieldsOf(time);
          expect([back.year, back.month, back.day, back.hour, back.minute]).toEqual([
            expectedFields.year,
            expectedFields.month,
            expectedFields.day,
            expectedFields.hour,
            expectedFields.minute,
          ]);
          // …and the instant is the pseudo-epoch minus the (constant) offset.
          expect(instant).toBe(pseudoMsOf(expectedFields) - back.offsetMinutes * 60_000);
        },
      ),
    );
  });

  // Each of the 100 runs sweeps ±50 h at minute steps (the oracle's
  // window) — 7.6 s clean isolated, 16.8/19.3 s worst in full coverage
  // `make check` runs under the six-hog starvation rig, and ~20 s at
  // ambient sibling-wave load alone (U-025, the D-094 method) — hence
  // the 60 s timeout: ≈3× the measured worst, so the worst observed
  // wave could double again and stay green while a stuck run still
  // fails within a bounded minute.
  it('arbitrary dates in any matrix zone agree with the scan oracle', () => {
    const allZones = [...TRANSITION_DAYS.map((row) => row.zone), ...FIXED_ZONES] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...allZones),
        dateArb,
        fc.integer({ min: 0, max: 1440 }),
        (zoneName, date, minute) => {
          const zone = resolveTimeZone(zoneName);
          const time: LocalScheduleTime = { ...date, minutesSinceMidnight: minute };
          const scan = scanZoneAround(zone, Date.UTC(date.year, date.month - 1, date.day));
          expect(resolveLocalInstantDst(time, zone)).toBe(oracleResolve(scan, time));
        },
      ),
    );
  }, 60_000);
});
