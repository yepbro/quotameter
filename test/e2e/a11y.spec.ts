import { expect, test } from '@playwright/test';
import { assertNoAccessibilityViolations } from './helpers/a11y';

/**
 * Accessibility scans (spec §14.1; decisions D-129, D-133): the shell
 * must not introduce WCAG violations in ANY theme. The contrast rules
 * read computed styles, so each mode is scanned with its tokens actually
 * applied — asserted, not assumed: the two explicit modes through the
 * control (each `data-theme` state verified before axe runs, so a
 * broken handler cannot silently scan the same light page twice), and
 * `system` under an emulated dark OS preference (the deferred dark-mode
 * pass D-129 recorded as task 168's — axe's default Chromium run paints
 * light). Real pages gain their own scans as they are implemented.
 */

test('application shell has no WCAG violations in explicit light and dark themes', async ({
  page,
}) => {
  await page.goto('/');
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    // The tokens must actually be applied before the scan means anything.
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }

  // Sanity check that the scan ran against rendered content.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quotameter');
});

test('application shell has no WCAG violations under a system dark preference', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  // System mode carries no attribute; the OS preference drives the tokens.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await assertNoAccessibilityViolations(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quotameter');
});

test('accounts page has no WCAG violations in either theme (task 170)', async ({ page }) => {
  // The management page's real content — selector, empty state, add
  // form, and the API-failure surface — scanned with its tokens applied
  // per mode. Against `vite preview` (no API behind it) the loads
  // honestly answer the SPA-fallback HTML, so the page under scan is
  // its degradation surface: the failure notice with its retry and the
  // disabled add form (a failed load is never a fake empty state).
  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 2 })).toBeVisible();
  await expect(page.getByTestId('api-error').first()).toBeVisible();
  await expect(page.getByTestId('accounts-retry')).toBeVisible();
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
  expect(await page.getByTestId('accounts-empty').count()).toBe(0);
});
