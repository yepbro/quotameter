import { expect, test, type Route } from '@playwright/test';
import { healthyEventsBody, healthyPeakHoursBody, healthySettingsBody } from '../helpers/api';

/**
 * The §14.4 cursor/zoom synchronization in a real browser (task 178, spec
 * §14.4; decision D-153): the connect group's relay, the wheel zoom, and
 * the page's reset affordance run against the real ECharts instances —
 * the one place the suite can observe the relay at all (component tests
 * stop at the injected seam; D-148's recorded boundary). The relay proof
 * is a canvas-bitmap CHANGE assertion (the second chart repaints only if
 * the group relayed the zoom to a chart the mouse never entered) — a
 * change observation, not a visual baseline; ECharts' painting itself
 * remains outside the stack.
 *
 * The preview server has no API behind it (the suite's standing shape),
 * so the overview loads are served by route interception — the a11y
 * suite's pattern — with TWO metrics whose history carries real points,
 * the minimum for two chart instances in one connect group.
 */

/** One dual-view point fixture of a served history window. */
function pointAt(at: number): Record<string, unknown> {
  return {
    kind: 'point',
    collectedAt: at,
    used: 120_000,
    remaining: 30_000,
    limit: 150_000,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: null,
    isValid: true,
    invalidReason: null,
  };
}

/**
 * A points-bearing history body: the requested window (echoed by the
 * wire) with points at its quarter marks — enough for the chart to
 * instantiate and the cursor relay to resolve samples on both charts.
 */
function pointsHistoryBody(pathWithSearch: string): unknown {
  const params = new URLSearchParams(pathWithSearch.slice('/api/history?'.length));
  const requestedFrom = Date.parse(params.get('from') ?? '');
  const requestedTo = Date.parse(params.get('to') ?? '');
  const span = requestedTo - requestedFrom;
  return {
    accountId: params.get('accountId') ?? '',
    metric: params.get('metric') ?? '',
    unit: 'CREDITS',
    limitType: 'ROLLING_WINDOW',
    range: {
      outcome: 'ok',
      requestedFrom,
      requestedTo,
      effectiveFrom: requestedFrom,
      effectiveTo: requestedTo,
      retentionHorizon: null,
    },
    downsampled: false,
    resolutionMs: null,
    sourcePointCount: 2,
    points: [
      pointAt(requestedFrom + Math.floor(span / 4)),
      pointAt(requestedFrom + Math.floor((span * 3) / 4)),
    ],
  };
}

/** Serves the populated overview surface: one account, two quota metrics. */
async function fulfillSyncOverviewBody(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const { pathname, search } = url;
  const metricRow = (metricKey: string): Record<string, unknown> => ({
    metricKey,
    limitType: 'ROLLING_WINDOW',
    unit: 'CREDITS',
    windowSeconds: 18_000,
    used: 120_000,
    remaining: 30_000,
    limit: 150_000,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: null,
    isValid: true,
    invalidReason: null,
    derivedFields: null,
    collectedAt: 1,
  });
  const body: Record<string, unknown> = {
    '/api/accounts': {
      accounts: [
        {
          id: 'acc-1',
          providerId: 'zai-coding-plan',
          label: 'Main',
          enabled: true,
          status: 'active',
          hasKey: true,
          keySource: 'file',
          keyMask: '********',
          planName: null,
          createdAt: null,
          archivedAt: null,
        },
      ],
    },
    '/api/providers': {
      providers: [
        {
          id: 'zai-coding-plan',
          name: 'Z.ai Coding Plan',
          peakHours: null,
          metrics: [
            { metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' },
            { metricKey: 'tokens-5h', label: '5-hour token quota' },
          ],
        },
      ],
    },
    '/api/status': {
      status: 'ok',
      pollingIntervalSeconds: 300,
      accounts: [{ id: 'acc-1', status: 'fresh', lastSuccessAt: null, lastError: null }],
    },
    '/api/settings': healthySettingsBody(),
    '/api/quota': {
      accountId: 'acc-1',
      status: 'fresh',
      collectedAt: 1,
      planName: null,
      metrics: [metricRow('mcp-monthly'), metricRow('tokens-5h')],
    },
    '/api/history': pointsHistoryBody(`${pathname}${search}`),
    '/api/events': healthyEventsBody(`${pathname}${search}`),
    '/api/peak-hours': healthyPeakHoursBody(`${pathname}${search}`),
  };
  const answer = body[pathname];
  await route.fulfill({
    status: answer === undefined ? 404 : 200,
    contentType: 'application/json',
    body: JSON.stringify(
      answer ?? { error: { code: 'NOT_FOUND', message: 'no route', details: null } },
    ),
  });
}

test('a shift-wheel zoom surfaces the reset affordance and the reset retires it', async ({
  page,
}) => {
  await page.route('**/api/**', fulfillSyncOverviewBody);
  await page.goto('/');

  // Two populated chart cards — two real ECharts instances in one group.
  const charts = page.getByTestId('metric-chart');
  await expect(charts).toHaveCount(2);
  const canvases = page.getByTestId('chart-canvas');
  await expect(canvases).toHaveCount(2);
  await expect(page.getByTestId('api-error')).toHaveCount(0);

  // Unzoomed: no affordance, no announcement.
  await expect(page.getByTestId('chart-zoom-reset')).toHaveCount(0);
  await expect(page.getByTestId('chart-zoom-status')).toHaveCount(0);

  // Shift+wheel over the FIRST chart's canvas: the inside zoom fires the
  // dataZoom action, the connect group relays it to the second chart, and
  // both cards' own events reach the page state. The canvas is scrolled
  // into the viewport first: the charts region sits below the fold at the
  // default viewport, and `mouse.move` does not scroll.
  const firstCanvas = canvases.first();
  await firstCanvas.scrollIntoViewIfNeeded();
  const box = await firstCanvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

  // THE RELAY PROOF: the second chart's canvas bitmap, snapshotted after
  // the hover has settled (the cursor relay paints its pointer) and again
  // after the wheel — it changes only if the group relayed the ZOOM to a
  // chart the mouse never entered. Not a visual baseline: a change
  // assertion, the one cross-instance effect observable without a
  // library seam (the page state alone would also flip on the first
  // chart's own event — a broken relay would pass that alone).
  const secondBitmap = canvases.nth(1).locator('canvas').first();
  const bitmapOf = (): Promise<string> =>
    secondBitmap.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const beforeWheel = await bitmapOf();

  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Shift');

  const reset = page.getByTestId('chart-zoom-reset');
  await expect(reset).toBeVisible();
  await expect.poll(bitmapOf, { timeout: 5000 }).not.toBe(beforeWheel);

  await expect(reset).toHaveText('Reset zoom');
  const status = page.getByTestId('chart-zoom-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveText(/^Charts zoomed to .+ – .+\.$/);

  // The keyboard-operable reset dispatches to every chart; echarts fires
  // the events back, the page state clears, and both surfaces retire.
  await reset.click();
  await expect(page.getByTestId('chart-zoom-reset')).toHaveCount(0);
  await expect(page.getByTestId('chart-zoom-status')).toHaveText(
    'Zoom reset — charts show the full selected range.',
  );
});
