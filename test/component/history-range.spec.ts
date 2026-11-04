import { describe, expect, it } from 'vitest';
import {
  HISTORY_DAY_MS,
  HISTORY_RANGE_DEFAULT,
  HISTORY_RANGE_DURATIONS_MS,
  HISTORY_RANGE_IDS,
  historyRangeDurationMs,
  historyRangeIsoBounds,
  isHistoryRangeWithinRetention,
  type HistoryRangeId,
} from '../../ui/src/history-range';
import {
  DEFAULT_ROLLING_RANGE,
  ROLLING_RANGE_IDS,
  rollingRangeDurationMs,
  type RollingRangeId,
} from '../../src/util/rolling-ranges';

/**
 * The §14.4 range vocabulary and boundary arithmetic (task 174, spec
 * §10, §13, §14.4; decision D-147): the UI-local constants are
 * drift-pinned against the server's own module (the
 * `API_MUTATION_HEADER` precedent — no runtime import from `src/**`
 * into the bundle), the retention comparison is the §14.4 disable
 * rule, and the ISO bounds are D-139's request grammar computed as
 * D-068 pinned it server-side: exact absolute-duration arithmetic, no
 * zone, no DST component.
 */

/* ── The vocabulary, drift-pinned against the server module ───────────── */

describe('the history-range vocabulary (drift pins)', () => {
  it('is exactly spec §14.4’s five ranges in ascending duration order', () => {
    // The literal set is the spec’s own sentence, made executable —
    // and the display order is the ascending-duration order.
    expect([...HISTORY_RANGE_IDS]).toEqual(['24h', '3d', '7d', '14d', '30d']);
  });

  it('matches the server’s ROLLING_RANGE_IDS (D-068) entry for entry', () => {
    expect([...HISTORY_RANGE_IDS]).toEqual([...ROLLING_RANGE_IDS]);
  });

  it('is the same UNION as the server’s RollingRangeId — both directions', () => {
    // The union is UI-local (the layout contract keeps ui imports of
    // server code to type-only `src/schemas/**`, and this vocabulary
    // lives in `src/util/`), so the drift pin is the whole contract:
    // each side’s ids assign to the other’s union — compile-time, this
    // file is type-checked by the same gate — and the runtime arrays
    // agree above. A server-side id this file does not know fails BOTH.
    const serverIds: readonly HistoryRangeId[] = ROLLING_RANGE_IDS;
    const uiIds: readonly RollingRangeId[] = HISTORY_RANGE_IDS;
    expect([...uiIds]).toEqual([...serverIds]);
  });

  it('defaults to 7 days, exactly like the server’s DEFAULT_ROLLING_RANGE', () => {
    expect(HISTORY_RANGE_DEFAULT).toBe(DEFAULT_ROLLING_RANGE);
    expect(HISTORY_RANGE_DEFAULT).toBe('7d');
  });

  it('carries the same exact durations as the server’s table', () => {
    for (const id of ROLLING_RANGE_IDS) {
      expect(historyRangeDurationMs(id)).toBe(rollingRangeDurationMs(id));
      expect(HISTORY_RANGE_DURATIONS_MS[id]).toBe(rollingRangeDurationMs(id));
    }
    // And the day constant is the absolute (DST-free) day.
    expect(HISTORY_DAY_MS).toBe(86_400_000);
  });
});

/* ── The §14.4 disable rule ───────────────────────────────────────────── */

describe('isHistoryRangeWithinRetention (§14.4: disable what EXCEEDS retention)', () => {
  it.each([
    {
      retentionDays: 7,
      enabled: ['24h', '3d', '7d'],
      disabled: ['14d', '30d'],
    },
    {
      retentionDays: 14,
      enabled: ['24h', '3d', '7d', '14d'],
      disabled: ['30d'],
    },
    {
      retentionDays: 30,
      enabled: ['24h', '3d', '7d', '14d', '30d'],
      disabled: [],
    },
    {
      // The §11.3 accepted maximum: nothing of §14.4’s set is disabled.
      retentionDays: 3650,
      enabled: ['24h', '3d', '7d', '14d', '30d'],
      disabled: [],
    },
  ] as const)(
    'retention $retentionDays days: enabled $enabled, disabled $disabled',
    ({ retentionDays, enabled, disabled }) => {
      for (const id of enabled) {
        expect(isHistoryRangeWithinRetention(id, retentionDays)).toBe(true);
      }
      for (const id of disabled) {
        expect(isHistoryRangeWithinRetention(id, retentionDays)).toBe(false);
      }
    },
  );

  it('an exactly-equal range stays selectable — only STRICT excess disables', () => {
    // §14.4 says “ranges that exceed the configured retention period”;
    // a 7-day range under a 7-day retention does not exceed it — and
    // §11.3’s 7-day minimum keeps the §14.4 default always selectable.
    expect(isHistoryRangeWithinRetention('7d', 7)).toBe(true);
    expect(isHistoryRangeWithinRetention('14d', 7)).toBe(false);
  });
});

/* ── D-139’s request grammar: ISO-8601 UTC boundaries ─────────────────── */

describe('historyRangeIsoBounds (§10/D-068 arithmetic, D-139 wire form)', () => {
  /** ISO 8601 UTC at millisecond precision with the `Z` designator. */
  const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

  it('computes to = now, from = now − duration, both ISO Z strings', () => {
    const nowMs = Date.UTC(2026, 10, 4, 9, 30, 15, 250);
    const bounds = historyRangeIsoBounds('24h', nowMs);
    expect(bounds.from).toMatch(ISO_Z);
    expect(bounds.to).toMatch(ISO_Z);
    expect(Date.parse(bounds.to)).toBe(nowMs);
    expect(Date.parse(bounds.from)).toBe(nowMs - 24 * 3_600_000);
  });

  it.each(['3d', '7d', '14d', '30d'] as const)(
    'spans exactly its duration for %s — the closed D-068 interval',
    (id) => {
      const nowMs = Date.UTC(2026, 0, 15, 18, 0, 0, 0);
      const bounds = historyRangeIsoBounds(id, nowMs);
      expect(Date.parse(bounds.to) - Date.parse(bounds.from)).toBe(rollingRangeDurationMs(id));
    },
  );

  it('is pure absolute arithmetic: a window spanning a DST transition keeps its exact span', () => {
    // Two instants on either side of a spring-forward transition (US
    // 2026-03-08): no zone participates in the bounds (§10 — the
    // display zone is presentation-only), so the span is exactly the
    // duration even across the missing hour.
    const aroundDst = Date.UTC(2026, 2, 8, 12, 0, 0, 0);
    for (const id of HISTORY_RANGE_IDS) {
      const bounds = historyRangeIsoBounds(id, aroundDst);
      expect(Date.parse(bounds.to) - Date.parse(bounds.from)).toBe(rollingRangeDurationMs(id));
    }
  });
});
