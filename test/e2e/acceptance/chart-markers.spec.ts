import { expect, test, type Request } from '@playwright/test';
import {
  seedFailedCycle,
  seedSuccessCycle,
  seededMetric,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';

/**
 * The §17.1 chart-marker acceptance scenario (spec §14.4, §12.2, §9.3)
 * against the served construction: one account whose stored history —
 * seeded through the real write path, anchored to the real now — carries
 * every §14.4 marker the aria contract states as text (§14.1): a §12.1
 * quota reset (the usage drop between two genuine snapshots), a §12.2
 * collection gap (a silence past the three-interval threshold), and a
 * failed collection cycle (the lower strip's marker). The peak schedule
 * rides the real configuration: `GET /api/peak-hours` — captured on the
 * wire the page itself fired — answers the configured window's intervals,
 * which the chart renders as bands (the interval→band mapping and the
 * painted band are the chart suite's component-level pin; this scenario
 * proves the served construction delivers the schedule facts end to end).
 *
 * The markers are asserted through the chart's accessible name — the
 * counts are real text facts of the range, stated per §14.1 — via
 * RETRYING attribute assertions: the marker suffix arrives with the
 * separate `/api/events` load, so a single `getAttribute` read could
 * legitimately see the mark-free label while events are still pending.
 * The regex anchors the full suffix with its boundaries, so "1 quota
 * resets" can never match "11 quota resets" — the counts are exact.
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        {
          id: 'charted',
          providerId: 'zai-coding-plan',
          label: 'Charted account',
          apiKey: 'sk-dummy-charted',
        },
      ],
      providers: {
        'zai-coding-plan': {
          peakHours: {
            timezone: 'UTC',
            offPeakMultiplier: 1,
            windows: [
              {
                // Every day, all day: the schedule is peak regardless of
                // when the scenario runs — no calendar-dependent arm.
                id: 'always',
                name: 'Working hours',
                days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
                start: '00:00',
                end: '24:00',
                multiplier: 3,
              },
            ],
          },
        },
      },
    },
  });

  const now = Date.now();
  const metric = (used: number) =>
    seededMetric('mcp-monthly', {
      used,
      remaining: 100 - used,
      percentUsed: used,
      percentRemaining: 100 - used,
    });
  // The world's shape is chosen for EXACT marker counts, each silence
  // either far under or far over the three-interval threshold (16.5 min
  // at the 300 s cadence), so every count is deterministic:
  //   t0 (-75 min) success used=80 → t1 (-70 min) success used=10 — the
  //   genuine §12.1 usage-drop reset, 5 min apart (no silence);
  //   tf (-65 min) the failed 503 cycle, 5 min after t1 (no silence) —
  //   the strip's error marker;
  //   t3 (-5 min) success used=30 — the 60-minute silence before it is
  //   the one beyond-threshold gap (whichever stamp pairs the gap service
  //   judges — valid points or runs — exactly one such silence exists).
  // The leading stopped period (range start → t0) is the honest §12.2
  // "no run records at all" region of any finite history, and the
  // tf→t3 silence adds the second: exactly two stopped periods.
  seedSuccessCycle(server.repository, 'charted', now - 4_500_000, [metric(80)]);
  seedSuccessCycle(server.repository, 'charted', now - 4_200_000, [metric(10)]);
  seedFailedCycle(server.repository, 'charted', now - 3_900_000, 'server_error', {
    httpStatus: 503,
    errorMessage: 'the provider answered 503',
    attempts: 3,
  });
  seedSuccessCycle(server.repository, 'charted', now - 300_000, [metric(30)]);
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('the chart states the reset, gap, and failed-collection markers as text', async ({ page }) => {
  // The schedule facts the page loaded, captured on the real wire: the
  // configured all-day window answers peak intervals with its multiplier.
  const peakHoursLoaded = page
    .waitForResponse((response) => new URL(response.url()).pathname === '/api/peak-hours')
    .then((response) => response.json() as Promise<{ intervals: unknown[] }>);
  await page.goto(`${server.baseUrl}/`);

  const chart = page.getByTestId('metric-chart');
  await expect(chart).toHaveCount(1);
  // The real catalog's label (D-137): the chart is the real metric.
  await expect(chart.getByRole('heading', { name: 'Monthly MCP tool quota' })).toBeVisible();

  // The §14.1 accessible name states the marker counts of the range —
  // exactly the world's facts (see the seeding above for the shape), the
  // full suffix anchored so the counts are exact, not substrings.
  const canvas = page.getByTestId('chart-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'aria-label',
    /— in range: 1 quota resets, 1 collection gaps, 2 stopped periods, 1 failed collections$/,
  );

  const peakHours = await peakHoursLoaded;
  expect(peakHours.intervals.length).toBeGreaterThanOrEqual(1);
  const first = peakHours.intervals[0] as { kind: string; name?: string; multiplier: number };
  expect(first.kind).toBe('peak');
  expect(first.name).toBe('Working hours');
  expect(first.multiplier).toBe(3);
});

test('switching to the 24-hour range re-anchors the loads and keeps the markers', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/`);

  // With the default retention (180 days) every §14.4 range is offered.
  const fieldset = page.getByTestId('history-range');
  for (const rangeId of ['24h', '3d', '7d', '14d', '30d']) {
    await expect(fieldset.locator(`[data-range-id="${rangeId}"] input`)).toBeEnabled();
  }

  // The switch is proven on the wire, not assumed: the re-dispatched
  // events and per-metric history requests ask for a ~24-hour window.
  const spanOf = (request: Promise<Request>): Promise<number> =>
    request.then((req) => {
      const url = new URL(req.url());
      return (
        Date.parse(url.searchParams.get('to') ?? '') -
        Date.parse(url.searchParams.get('from') ?? '')
      );
    });
  const eventsRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/events',
  );
  const historyRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/history',
  );
  await fieldset.locator('[data-range-id="24h"] input').check();
  // A rolling 24 h range asks for exactly 24 h (± the milliseconds of
  // fresh bounds) — far from the 7-day default the switch replaced.
  for (const span of [await spanOf(eventsRequest), await spanOf(historyRequest)]) {
    expect(span).toBeGreaterThan(86_300_000);
    expect(span).toBeLessThan(86_500_000);
  }

  // Every seeded fact lies within the last 24 hours, so the narrowest
  // range keeps the exact marker counts stated.
  const canvas = page.getByTestId('chart-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'aria-label',
    /— in range: 1 quota resets, 1 collection gaps, 2 stopped periods, 1 failed collections$/,
  );
});
