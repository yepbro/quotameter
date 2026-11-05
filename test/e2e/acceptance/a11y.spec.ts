/// <reference lib="dom" />
// (The DOM lib reference exists because this spec reads a computed CSS
// custom property inside `page.evaluate` — browser-only DOM API — while
// the project's tsconfig is the Node-only server config; the smoke spec
// documents the same pattern.)

import { expect, test } from '@playwright/test';
import {
  ACCEPTANCE_PASSWORD,
  seedSuccessCycle,
  seededMetric,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';
import { assertNoAccessibilityViolations } from '../helpers/a11y';
import { hashPassword } from '../../../src/services/password-hash';

/**
 * The §17.1 accessibility smoke acceptance scenario (spec §14.1; decisions
 * D-129, D-133) against the served construction: axe scans of the
 * POPULATED surfaces — the overview with its identity card, badge, metric
 * cards, and painted chart, in both explicit themes with the token
 * cascade verified APPLIED (the resolved background token must differ
 * between the modes — an attribute flip that restyled nothing would not
 * pass) — plus the accounts management card and the real password-mode
 * login page (a second world this file starts beside the populated one).
 * The preview-server a11y suite could only scan the degradation surfaces
 * (no API behind it — task 172's recorded seam); these scans close that
 * gap over real served data.
 */

let populated: AcceptanceServer;
let authGuarded: AcceptanceServer | undefined;

test.beforeAll(async () => {
  populated = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        {
          id: 'scanned',
          providerId: 'zai-coding-plan',
          label: 'Scanned account',
          apiKey: 'sk-dummy-scanned',
        },
      ],
    },
  });
  seedSuccessCycle(populated.repository, 'scanned', Date.now() - 240_000, [
    seededMetric('mcp-monthly'),
  ]);
  authGuarded = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC' },
      auth: { mode: 'required', passwordHash: await hashPassword(ACCEPTANCE_PASSWORD) },
    },
  });
});

test.afterAll(async () => {
  await populated.stop();
  // A failed second-world start leaves no handle — the first world still
  // must be released (above), and this one only when it exists.
  await authGuarded?.stop();
});

test.describe.configure({ mode: 'serial' });

test('the populated overview passes the WCAG scan in both themes', async ({ page }) => {
  await page.goto(`${populated.baseUrl}/`);
  await expect(page.getByTestId('account-overview-card')).toBeVisible();
  await expect(page.getByTestId('chart-canvas')).toBeVisible();

  // The token cascade, verified applied per mode: the resolved background
  // token is read the way the charts read it, and must differ between the
  // two explicit modes before either scan means anything.
  const backgroundToken = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--qm-color-background').trim(),
    );
  await page.getByTestId('theme-select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightToken = await backgroundToken();
  await page.getByTestId('theme-select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkToken = await backgroundToken();
  expect(darkToken).not.toBe(lightToken);

  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('the accounts management page passes the WCAG scan with its card rendered', async ({
  page,
}) => {
  await page.goto(`${populated.baseUrl}/accounts`);
  await expect(page.getByTestId('account-card')).toBeVisible();
  await assertNoAccessibilityViolations(page);
});

test('the real password-mode login page passes the WCAG scan', async ({ page }) => {
  await page.goto(`${authGuarded!.baseUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible();
  await assertNoAccessibilityViolations(page);
});
