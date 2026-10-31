import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { parseConfig, parseJson } from '../../src/config/load';
import { findConfigProblems } from '../../src/schemas/config';
import type { Config, PeakHoursConfig, PeakWindow, WeekDay } from '../../src/schemas/config';

/**
 * The peak-hours schedule validation matrix (spec §9.2; task 113) — the
 * done-condition made executable: every invalid dimension of a schedule
 * configuration produces a field-level error, every boundary is accepted.
 *
 * The rules themselves landed with the configuration contract (task 061,
 * decision D-014: structural rules in the TypeBox schemas, cross-field
 * invariants in `findConfigProblems`) and its runtime composition (task 064,
 * decision D-018: `parseConfig`). This suite consolidates them per §9.2
 * dimension through the public pipeline that startup and `quotameter reload`
 * actually run, and closes the matrix cells the per-task suites left open
 * (`offPeakMultiplier` bounds, non-finite multipliers — the D-071 wording
 * repair — `24:00` endpoint semantics, and the overlap property).
 */

/** A window-shaped input value; invalid dimensions deliberately mistype it. */
type WindowInput = Record<string, unknown>;

/** A valid peak window except `multiplier` (omitted — the default under test). */
const window = (overrides: WindowInput = {}): WindowInput => ({
  id: 'w1',
  name: 'W1',
  days: ['mon'],
  start: '10:00',
  end: '18:00',
  ...overrides,
});

/** A schedule section under test; defaults to the "not configured" shape. */
const schedule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  timezone: 'UTC',
  windows: [],
  ...overrides,
});

/** A configuration whose single provider carries the schedule under test. */
const config = (scheduleOverrides: Record<string, unknown> = {}, providerId = 'zai'): unknown => ({
  app: { timezone: 'UTC' },
  providers: { [providerId]: { peakHours: schedule(scheduleOverrides) } },
});

/** Runs the pipeline, asserting rejection; returns the exact problem list. */
function reject(input: unknown): string[] {
  const result = parseConfig(input);
  if (result.ok) throw new Error(`expected rejection, got a valid configuration`);
  return result.problems;
}

/** Runs the pipeline, asserting acceptance; returns the canonical config. */
function accept(input: unknown): Config {
  const result = parseConfig(input);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.problems.join('; ')}`);
  return result.value;
}

/** The test provider's schedule from a canonical result (always present here). */
function scheduleOf(result: Config, providerId = 'zai'): PeakHoursConfig {
  const provider = result.providers?.[providerId];
  if (provider === undefined) throw new Error(`missing provider '${providerId}'`);
  return provider.peakHours;
}

describe('acceptance: verified schedules and spec boundaries (spec §9.1, §9.2)', () => {
  it("loads spec §9.2's sample schedule — the verified Z.ai encoding — verbatim", () => {
    const result = accept(
      config({
        timezone: 'Asia/Singapore',
        offPeakMultiplier: 0.5,
        windows: [
          {
            id: 'zai-weekday-peak',
            name: 'Z.ai Coding Plan peak hours',
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            start: '14:00',
            end: '18:00',
            multiplier: 1,
          },
        ],
      }),
    );
    expect(scheduleOf(result)).toEqual({
      timezone: 'Asia/Singapore',
      offPeakMultiplier: 0.5,
      windows: [
        {
          id: 'zai-weekday-peak',
          name: 'Z.ai Coding Plan peak hours',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          start: '14:00',
          end: '18:00',
          multiplier: 1,
        },
      ],
    });
  });

  it('completes omitted multipliers with the spec defaults (§9.2)', () => {
    const result = accept(config({ windows: [window()] }));
    expect(scheduleOf(result)).toEqual({
      timezone: 'UTC',
      offPeakMultiplier: 1,
      windows: [
        { id: 'w1', name: 'W1', days: ['mon'], start: '10:00', end: '18:00', multiplier: 1 },
      ],
    });
    const explicit = accept(
      config({ offPeakMultiplier: 0.5, windows: [window({ multiplier: 2.5 })] }),
    );
    expect(scheduleOf(explicit).offPeakMultiplier).toBe(0.5);
    expect(scheduleOf(explicit).windows[0]!.multiplier).toBe(2.5);
  });

  it('accepts an empty window list — "not configured" — per provider', () => {
    const result = accept(config());
    expect(scheduleOf(result).windows).toEqual([]);
  });

  it('accepts the maximal window 00:00–24:00 and touching windows on a day', () => {
    expect(accept(config({ windows: [window({ start: '00:00', end: '24:00' })] }))).toBeTruthy();
    expect(
      accept(
        config({
          windows: [
            window({ id: 'am', start: '00:00', end: '12:00' }),
            window({ id: 'pm', start: '12:00', end: '24:00' }),
          ],
        }),
      ),
    ).toBeTruthy();
  });
});

describe('timezone must be a valid IANA identifier (spec §9.2)', () => {
  it('rejects unknown and offset names with the schedule field named', () => {
    for (const timezone of ['Mars/Olympus', '+08:00', 'localtime']) {
      expect(reject(config({ timezone }))).toEqual([
        `providers.zai.peakHours.timezone: '${timezone}' is not a valid IANA time zone`,
      ]);
    }
  });

  it('accepts IANA zones, aliases, and UTC — independent of the display zone', () => {
    for (const timezone of ['Asia/Singapore', 'UTC', 'Asia/Calcutta', 'Etc/GMT+8']) {
      const result = parseConfig({
        app: { timezone: 'Europe/Berlin' },
        providers: { zai: { peakHours: schedule({ timezone, windows: [] }) } },
      });
      expect(result.ok, timezone).toBe(true);
    }
  });
});

describe('days: a non-empty, duplicate-free subset of mon–sun (spec §9.2)', () => {
  it("rejects values outside the closed enum with one 'must be one of' line", () => {
    for (const day of ['funday', 'Monday', 'MON']) {
      expect(reject(config({ windows: [window({ days: [day] })] }))).toEqual([
        `providers.zai.peakHours.windows[0].days[0]: must be one of: 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'`,
      ]);
    }
  });

  it('rejects an empty day list and duplicate days', () => {
    expect(reject(config({ windows: [window({ days: [] })] }))).toEqual([
      'providers.zai.peakHours.windows[0].days: must contain at least 1 item',
    ]);
    expect(reject(config({ windows: [window({ days: ['mon', 'mon'] })] }))).toEqual([
      'providers.zai.peakHours.windows[0].days: must not contain duplicate items',
    ]);
  });

  it('accepts the full week in one window', () => {
    expect(
      accept(
        config({ windows: [window({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] })] }),
      ),
    ).toBeTruthy();
  });
});

describe('times use HH:mm, and 24:00 is an end-only endpoint (spec §9.2)', () => {
  const START_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  const END_PATTERN = '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$';

  it('rejects malformed starts, including 24:00 as a start', () => {
    for (const start of ['9:00', '14:0', '14:00:00', '24:00']) {
      expect(reject(config({ windows: [window({ start })] }))).toEqual([
        `providers.zai.peakHours.windows[0].start: must match the pattern '${START_PATTERN}'`,
      ]);
    }
  });

  it('rejects malformed ends, including the minutes past 24:00', () => {
    for (const end of ['25:00', '24:01', '2:00', '23:60']) {
      expect(reject(config({ windows: [window({ end })] }))).toEqual([
        `providers.zai.peakHours.windows[0].end: must match the pattern '${END_PATTERN}'`,
      ]);
    }
  });

  it('rejects a non-string time with the actual type named', () => {
    expect(reject(config({ windows: [window({ start: 14 })] }))).toEqual([
      'providers.zai.peakHours.windows[0].start: expected a string, got a number',
    ]);
  });

  it('accepts the boundary times 00:00, 23:59, and 24:00 as an end', () => {
    expect(accept(config({ windows: [window({ start: '00:00', end: '23:59' })] }))).toBeTruthy();
    expect(accept(config({ windows: [window({ start: '23:59', end: '24:00' })] }))).toBeTruthy();
  });
});

describe('start must be earlier than end, so windows cannot cross midnight (spec §9.2)', () => {
  it('rejects inverted, equal, and midnight-crossing pairs by name', () => {
    for (const [start, end] of [
      ['18:00', '14:00'],
      ['14:00', '14:00'],
      ['22:00', '02:00'],
      ['10:00', '00:00'],
    ] as const) {
      expect(reject(config({ windows: [window({ start, end })] }))).toEqual([
        `providers.zai.peakHours.windows[0] 'w1': start '${start}' must be earlier than end '${end}'`,
      ]);
    }
  });
});

describe('multipliers must be positive, finite numbers (spec §9.2)', () => {
  it('rejects zero and negative window multipliers', () => {
    for (const multiplier of [0, -0.5]) {
      expect(reject(config({ windows: [window({ multiplier })] }))).toEqual([
        'providers.zai.peakHours.windows[0].multiplier: must be > 0',
      ]);
    }
  });

  it('rejects zero and negative offPeakMultiplier', () => {
    for (const offPeakMultiplier of [0, -1]) {
      expect(reject(config({ offPeakMultiplier }))).toEqual([
        'providers.zai.peakHours.offPeakMultiplier: must be > 0',
      ]);
    }
  });

  it('rejects non-finite multipliers with a truthful type error (D-071)', () => {
    // A hand-edited out-of-range literal (`1e400`) parses to Infinity — not a
    // JSON number — and is rejected as a type violation naming the field.
    const text =
      '{"app":{"timezone":"UTC"},"providers":{"zai":{"peakHours":{"timezone":"UTC",' +
      '"windows":[{"id":"w","name":"W","days":["mon"],"start":"01:00","end":"02:00",' +
      '"multiplier":1e400}]}}}}';
    const parsed = parseJson(text);
    if (!parsed.ok) throw new Error(`expected the sample file to parse: ${parsed.problems}`);
    expect(reject(parsed.value)).toEqual([
      'providers.zai.peakHours.windows[0].multiplier: expected a number, got a non-finite number',
    ]);

    for (const multiplier of [Infinity, -Infinity, Number.NaN]) {
      expect(reject(config({ windows: [window({ multiplier })] }))).toEqual([
        'providers.zai.peakHours.windows[0].multiplier: expected a number, got a non-finite number',
      ]);
    }
    expect(reject(config({ offPeakMultiplier: Infinity }))).toEqual([
      'providers.zai.peakHours.offPeakMultiplier: expected a number, got a non-finite number',
    ]);
  });

  it('accepts every positive finite multiplier, fractional through huge', () => {
    for (const multiplier of [0.0001, 0.5, 1, 100, 1e308]) {
      expect(accept(config({ windows: [window({ multiplier })] }))).toBeTruthy();
    }
  });
});

describe('windows on the same day may not overlap (spec §9.2)', () => {
  it('rejects an overlapping pair, naming both windows and the shared day', () => {
    expect(
      reject(
        config({
          windows: [
            window({ id: 'early', start: '10:00', end: '16:00' }),
            window({ id: 'late', start: '15:00', end: '18:00' }),
          ],
        }),
      ),
    ).toEqual(["providers.zai.peakHours: windows 'early' and 'late' overlap on 'mon'"]);
  });

  it('flags the shared day only: disjoint days never overlap', () => {
    expect(
      reject(
        config({
          windows: [
            window({ id: 'a', days: ['tue', 'wed'], end: '16:00' }),
            window({ id: 'b', days: ['wed', 'thu'], start: '15:00' }),
          ],
        }),
      ),
    ).toEqual(["providers.zai.peakHours: windows 'a' and 'b' overlap on 'wed'"]);
    expect(
      accept(
        config({
          windows: [
            window({ id: 'a', days: ['mon', 'wed'], end: '16:00' }),
            window({ id: 'b', days: ['tue'], start: '15:00' }),
          ],
        }),
      ),
    ).toBeTruthy();
  });

  it('rejects containment and reports every overlapping pair of a chain', () => {
    expect(
      reject(
        config({
          windows: [
            window({ id: 'all-day', start: '08:00', end: '20:00' }),
            window({ id: 'inner', start: '10:00', end: '12:00' }),
          ],
        }),
      ),
    ).toEqual(["providers.zai.peakHours: windows 'all-day' and 'inner' overlap on 'mon'"]);
    expect(
      reject(
        config({
          windows: [
            window({ id: 'a', start: '08:00', end: '20:00' }),
            window({ id: 'b', start: '10:00', end: '22:00' }),
            window({ id: 'c', start: '21:00', end: '23:00' }),
          ],
        }),
      ),
    ).toEqual([
      "providers.zai.peakHours: windows 'a' and 'b' overlap on 'mon'",
      "providers.zai.peakHours: windows 'b' and 'c' overlap on 'mon'",
    ]);
  });

  it('rejects duplicate window ids within one schedule', () => {
    expect(
      reject(
        config({
          windows: [window({ days: ['mon'] }), window({ days: ['tue'] })],
        }),
      ),
    ).toEqual(["providers.zai.peakHours.windows[1]: duplicate window id 'w1'"]);
  });
});

describe('property: overlap is flagged exactly for same-day interval intersection', () => {
  /** Minutes since midnight → `HH:mm`; 1440 is the `24:00` end endpoint. */
  const toHhmm = (minutes: number): string =>
    minutes === 1440
      ? '24:00'
      : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  /** A valid window: start < end (end may be 24:00), non-empty day set. */
  const windowArb = (id: string) =>
    fc
      .tuple(
        fc.integer({ min: 0, max: 1439 }),
        fc.integer({ min: 1, max: 1440 }),
        fc.uniqueArray(fc.constantFrom<WeekDay>('mon', 'tue'), { minLength: 1 }),
      )
      .map(([start, span, days]): PeakWindow => {
        const minutes = { start, end: Math.min(1440, start + span) };
        return {
          id,
          name: id.toUpperCase(),
          days,
          start: toHhmm(minutes.start),
          end: toHhmm(minutes.end),
        };
      });

  const minutesOf = (value: string): number =>
    value === '24:00' ? 1440 : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

  it('agrees with the intersection oracle for two generated windows', () => {
    fc.assert(
      fc.property(windowArb('a'), windowArb('b'), (a, b) => {
        const configUnderTest: Config = {
          app: { timezone: 'UTC' },
          providers: { zai: { peakHours: { timezone: 'UTC', windows: [a, b] } } },
        };
        const problems = findConfigProblems(configUnderTest);
        // Sanity: generated windows are individually well-formed.
        expect(problems.some((p) => p.includes('must be earlier than end'))).toBe(false);
        const flagged = problems.some((p) => p.includes('overlap on'));
        const sharesDay = a.days.some((day) => b.days.includes(day));
        const intersects =
          minutesOf(a.start) < minutesOf(b.end) && minutesOf(b.start) < minutesOf(a.end);
        expect(flagged).toBe(sharesDay && intersects);
      }),
    );
  });
});
