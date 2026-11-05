/// <reference lib="dom" />
// (The DOM lib reference exists because this spec reads the document's
// scroll metrics inside `page.evaluate` — browser-only DOM API — while
// the project's tsconfig is the Node-only server config; the smoke spec
// documents the same pattern.)

import { expect, test } from '@playwright/test';
import {
  seedSuccessCycle,
  seededMetric,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';

/**
 * The §17.1 responsive acceptance scenario (spec §14.1: "a minimal,
 * responsive interface that works from 360 px wide") against the served
 * construction: the populated shell — nav, selector, identity card, metric
 * cards, and the charts grid — never gains horizontal overflow at the
 * spec's narrowest width, and the primary navigation still works there.
 * The overflow check reads the document's own scroll metrics: any element
 * poking past the viewport (a too-wide chart, an unbreakable card) makes
 * `scrollWidth` exceed 360.
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        {
          id: 'narrow',
          providerId: 'zai-coding-plan',
          label: 'Narrow viewport account',
          apiKey: 'sk-dummy-narrow',
        },
      ],
    },
  });
  seedSuccessCycle(server.repository, 'narrow', Date.now() - 240_000, [
    seededMetric('mcp-monthly'),
    seededMetric('tokens-5h', {
      limitType: 'ROLLING_WINDOW',
      unit: 'TOKENS',
      windowSeconds: 18_000,
    }),
  ]);
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('the populated overview fits the 360 px viewport and navigates from it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto(`${server.baseUrl}/`);

  // The populated surface renders at the narrow width: the selector, the
  // identity card, both metric cards (the responsive grid stacks them),
  // and one chart per metric.
  await expect(page.getByTestId('overview-account-select')).toBeVisible();
  await expect(page.getByTestId('account-overview-card')).toBeVisible();
  await expect(page.getByTestId('overview-metrics').locator(':scope > *')).toHaveCount(2);
  await expect(page.getByTestId('metric-chart')).toHaveCount(2);

  // §14.1's own criterion: no horizontal scrolling anywhere on the page —
  // measured after the charts paint (a canvas wider than its track would
  // only appear once the chart exists).
  await expect(page.getByTestId('chart-canvas').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the overview must not scroll horizontally at 360 px').toBeLessThanOrEqual(0);

  // Navigation works from the narrow viewport: the primary nav link
  // routes to the accounts page, which fits as well.
  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByTestId('account-card').first()).toBeVisible();
  const accountsOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(
    accountsOverflow,
    'the accounts page must not scroll horizontally at 360 px',
  ).toBeLessThanOrEqual(0);
});

test('the wide desktop viewport lays the metric cards side by side', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${server.baseUrl}/`);

  // The same grid on a wide viewport: the two metric cards sit on one row
  // (the §14.3 auto-fill grid's desktop shape) — a distinct layout from
  // the stacked narrow rendering, proving the responsiveness is real.
  const first = page.getByTestId('overview-metrics').locator(':scope > *').first();
  const second = page.getByTestId('overview-metrics').locator(':scope > *').nth(1);
  await Promise.all([first, second].map((card) => expect(card).toBeVisible()));
  const boxes = await Promise.all([first, second].map((card) => card.boundingBox()));
  expect(boxes[0]).not.toBeNull();
  expect(boxes[1]).not.toBeNull();
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y), 'both metric cards share a desktop row').toBeLessThan(
    4,
  );
  expect(boxes[1]!.x, 'the second card sits to the right of the first').toBeGreaterThan(
    boxes[0]!.x,
  );
});
