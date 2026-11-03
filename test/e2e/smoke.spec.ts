/// <reference lib="dom" />
// (The DOM lib reference exists because this spec sets and reads a
// `window` sentinel — the client-navigation probe below — while the
// project's tsconfig is the Node-only server config; the csp-shell
// spec documents the same pattern.)

import { expect, test } from '@playwright/test';

/**
 * Smoke test: opens the built UI and asserts its initial page (spec §17.1).
 * Since task 172 the overview is a real API-loading page: under the e2e
 * suite's `vite preview` (no API behind it) every load honestly answers
 * the SPA-fallback HTML, so the asserted surface is the shell plus the
 * shared `unexpected` notice — the D-134 degradation contract.
 */
test('opens the application shell', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Quotameter/);
  await expect(page.getByRole('heading', { name: 'Quotameter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
  // The honest no-API degradation (D-134): the loads fail through the
  // shared notice — never a fake empty state, never a blank page.
  await expect(page.getByTestId('api-error').first()).toBeVisible();
  await expect(page.getByTestId('overview-empty')).toHaveCount(0);
});

test('routes the shell pages (deep link and client navigation)', async ({ page }) => {
  // Direct deep link: the SPA fallback (§14.1) serves the shell and the
  // router renders the target page (task 166's done-condition).
  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 2 })).toBeVisible();

  // Client-side navigation through the primary nav. The sentinel set on
  // `window` before the click must survive it: a full page load (what a
  // broken RouterLink interception would cause) would also reach the
  // /settings heading through the SPA fallback — but not keep the flag.
  await page.evaluate(() => {
    (window as { __shellNavigationSentinel?: boolean }).__shellNavigationSentinel = true;
  });
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as { __shellNavigationSentinel?: boolean }).__shellNavigationSentinel === true,
    ),
  ).toBe(true);
});
