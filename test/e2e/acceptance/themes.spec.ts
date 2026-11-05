/// <reference lib="dom" />
// (The DOM lib reference exists because this spec reads a canvas bitmap
// inside `page.evaluate` — browser-only DOM API — while the project's
// tsconfig is the Node-only server config; the smoke spec documents the
// same pattern.)

import { expect, test } from '@playwright/test';
import {
  seedSuccessCycle,
  seededMetric,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';

/**
 * The §17.1 theme acceptance scenario (spec §14.1, decision D-133) against
 * the served construction: the populated overview — identity card, badge,
 * metric cards, and a real painted chart — renders in both explicit themes,
 * the `data-theme` attribute follows the control live, and the chart's
 * canvas genuinely repaints with the mode's tokens ("style charts for both
 * light and dark modes"). The preview-suite theme spec pins the token
 * values themselves; this scenario proves the restyling over real served
 * data, with a bitmap-change observation (the chart-sync suite's technique
 * — a change assertion, never a visual baseline).
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        {
          id: 'themed',
          providerId: 'zai-coding-plan',
          label: 'Themed account',
          apiKey: 'sk-dummy-themed',
        },
      ],
    },
  });
  seedSuccessCycle(server.repository, 'themed', Date.now() - 240_000, [
    seededMetric('mcp-monthly'),
  ]);
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('the populated overview restyles and the chart repaints in both themes', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);

  // The populated surface is present before either mode is asserted: the
  // real data card, the §14.6 badge, and one painted chart.
  await expect(page.getByTestId('account-overview-card')).toBeVisible();
  await expect(page.getByTestId('status-badge')).toHaveAttribute('data-status', 'fresh');
  const chart = page.getByTestId('metric-chart');
  await expect(chart).toHaveCount(1);

  const bitmap = async (): Promise<string> =>
    page
      .getByTestId('chart-canvas')
      .locator('canvas')
      .first()
      .evaluate((element: HTMLCanvasElement) => element.toDataURL());

  // Explicit light first: the tokens apply (asserted, not assumed).
  await page.getByTestId('theme-select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightBitmap = await bitmap();

  // Dark: the attribute flips live and the chart repaints with the dark
  // series tokens — the bitmap must differ from the light capture.
  await page.getByTestId('theme-select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(bitmap, { timeout: 5_000 }).not.toBe(lightBitmap);

  // The data stays rendered in the dark mode — the card and the marker
  // facts did not vanish behind the restyle.
  await expect(page.getByTestId('account-overview-card')).toBeVisible();
  await expect(page.getByTestId('chart-canvas')).toBeVisible();
});
