/// <reference lib="dom" />
// (The DOM lib reference exists because this spec reads computed styles
// inside `page.evaluate` — `getComputedStyle` is browser-only — while the
// project's tsconfig is the Node-only server config; the smoke spec
// documents the same pattern.)

import { expect, test, type Page } from '@playwright/test';

/**
 * Theme selection end to end (spec §14.1; decision D-133): the mode
 * switch must restyle the shell LIVE — the `data-theme` attribute flips
 * the `--qm-*` token cascade with no reload — `system` must follow the
 * OS preference, the choice must survive a reload (browser storage),
 * and an invalid stored value must fall back to `system`. The pins
 * below are the token values from `ui/src/assets/base.css`: `body`
 * paints `--qm-color-background`, and the RAW token is read the way the
 * 175/176 charts will read it (`getComputedStyle` on the document
 * element) — a raw custom property must carry a verbatim color, which
 * is exactly why the tokens duplicate the dark values instead of using
 * `light-dark()` (that wrapper would resolve on real properties but
 * hand charts an unresolved string).
 */

const LIGHT_BACKGROUND = 'rgb(255, 255, 255)';
const DARK_BACKGROUND = 'rgb(23, 23, 27)';
// The as-built token spellings: esbuild's CSS minifier shortens
// `#ffffff` to `#fff`, and a raw custom property carries the author
// value verbatim — the charts will read these exact strings.
const LIGHT_TOKEN = '#fff';
const DARK_TOKEN = '#17171b';

function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

/** The raw token, read the chart way: document element, custom property. */
function backgroundToken(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--qm-color-background').trim(),
  );
}

test('switching themes restyles the shell live, without a reload', async ({ page }) => {
  await page.goto('/');
  // A sentinel that only client-side state changes can survive; a full
  // page reload (what a broken handler could cause) would lose it.
  await page.evaluate(() => {
    (window as { __themeNoReload?: boolean }).__themeNoReload = true;
  });
  // Chromium's default scheme is light and the default mode is system.
  expect(await bodyBackground(page)).toBe(LIGHT_BACKGROUND);

  await page.getByTestId('theme-select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBackground(page)).toBe(DARK_BACKGROUND);

  // Back to explicit light — still no navigation, still instant.
  await page.getByTestId('theme-select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bodyBackground(page)).toBe(LIGHT_BACKGROUND);

  expect(
    await page.evaluate(() => (window as { __themeNoReload?: boolean }).__themeNoReload === true),
  ).toBe(true);
});

test('the raw tokens carry verbatim colors in every mode (the chart contract)', async ({
  page,
}) => {
  await page.goto('/');

  await page.getByTestId('theme-select').selectOption('light');
  expect(await backgroundToken(page)).toBe(LIGHT_TOKEN);

  await page.getByTestId('theme-select').selectOption('dark');
  expect(await backgroundToken(page)).toBe(DARK_TOKEN);

  // System under an emulated dark OS must resolve to the SAME raw value
  // as explicit dark — the duplicated dark block cannot drift — and the
  // light default resolves to the light value.
  await page.getByTestId('theme-select').selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await backgroundToken(page)).toBe(DARK_TOKEN);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await backgroundToken(page)).toBe(LIGHT_TOKEN);
});

test('explicit light overrides an OS dark preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  expect(await bodyBackground(page)).toBe(DARK_BACKGROUND); // system + OS dark

  await page.getByTestId('theme-select').selectOption('light');
  expect(await bodyBackground(page)).toBe(LIGHT_BACKGROUND);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('system mode follows OS preference flips', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('theme-select').selectOption('system');
  // In system mode no attribute is set: the prefers-color-scheme block
  // in base.css governs, and emulating a different OS scheme re-evaluates
  // it live.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');

  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await bodyBackground(page)).toBe(DARK_BACKGROUND);

  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bodyBackground(page)).toBe(LIGHT_BACKGROUND);
});

test('reads the documented storage key on load', async ({ page }) => {
  // Seeded before any app code runs: a dark page here proves the READ
  // key literally (not just a value the app itself wrote).
  await page.addInitScript(() => localStorage.setItem('quotameter.theme', 'dark'));
  await page.goto('/');
  expect(await bodyBackground(page)).toBe(DARK_BACKGROUND);
  await expect(page.getByTestId('theme-select')).toHaveValue('dark');
});

test('the choice persists across reloads', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('theme-select').selectOption('dark');
  await page.reload();

  expect(await bodyBackground(page)).toBe(DARK_BACKGROUND);
  await expect(page.getByTestId('theme-select')).toHaveValue('dark');
});

test('an invalid stored value falls back to system and is never written back', async ({ page }) => {
  // Runs before the app loads, so the controller reads this value first.
  await page.addInitScript(() => localStorage.setItem('quotameter.theme', 'neon'));
  await page.goto('/');

  await expect(page.getByTestId('theme-select')).toHaveValue('system');
  expect(await bodyBackground(page)).toBe(LIGHT_BACKGROUND);
  // The invalid value stays untouched until the user picks a mode.
  expect(await page.evaluate(() => localStorage.getItem('quotameter.theme'))).toBe('neon');
});
