/// <reference lib="dom" />
// (The DOM lib reference exists because this spec reads computed styles
// inside `page.evaluate` — `getComputedStyle` is browser-only — while the
// project's tsconfig is the Node-only server config; the smoke spec
// documents the same pattern.)

import { expect, test, type Page } from '@playwright/test';
import { CHART_TOKEN_NAMES } from '../../ui/src/charts/tokens';

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
// Task 175 (D-148): the chart series tokens the metric charts read the
// same way — the chart contract extends to them (light/dark values from
// base.css, verbatim).
const LIGHT_CHART_USED = '#1b4fa0';
const DARK_CHART_USED = '#8ab4f8';
const LIGHT_CHART_REMAINING = '#1e6b33';
const DARK_CHART_REMAINING = '#9fdcae';
// Task 176 (D-149): the annotation tokens — the same chart contract over
// the peak/reset/gap/stopped colors.
const LIGHT_CHART_PEAK = '#5b4fa8';
const DARK_CHART_PEAK = '#a5a1e8';
const LIGHT_CHART_RESET = '#9a3e63';
const DARK_CHART_RESET = '#e2a4c0';
const LIGHT_CHART_GAP = '#5a5a64';
const DARK_CHART_GAP = '#a9a9b3';
const LIGHT_CHART_STOPPED = '#8a5800';
const DARK_CHART_STOPPED = '#e8c179';

function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

/** The raw token, read the chart way: document element, custom property. */
function backgroundToken(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--qm-color-background').trim(),
  );
}

/** Any raw token, read the chart way (D-133/D-148). */
function chartToken(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
    name,
  );
}

/** Every chart token at once — the completeness read (D-148's list). */
function allChartTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    (names: string[]) => {
      const computed = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        names.map((name) => [name, computed.getPropertyValue(name).trim()]),
      );
    },
    [...CHART_TOKEN_NAMES],
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
  // The chart series tokens carry their verbatim values per mode too —
  // the metric charts (task 175) color through exactly these reads.
  expect(await chartToken(page, '--qm-chart-used')).toBe(LIGHT_CHART_USED);
  expect(await chartToken(page, '--qm-chart-remaining')).toBe(LIGHT_CHART_REMAINING);
  // Task 176's annotation tokens (D-149) — the same contract.
  expect(await chartToken(page, '--qm-chart-peak')).toBe(LIGHT_CHART_PEAK);
  expect(await chartToken(page, '--qm-chart-reset')).toBe(LIGHT_CHART_RESET);
  expect(await chartToken(page, '--qm-chart-gap')).toBe(LIGHT_CHART_GAP);
  expect(await chartToken(page, '--qm-chart-stopped')).toBe(LIGHT_CHART_STOPPED);

  await page.getByTestId('theme-select').selectOption('dark');
  expect(await backgroundToken(page)).toBe(DARK_TOKEN);
  expect(await chartToken(page, '--qm-chart-used')).toBe(DARK_CHART_USED);
  expect(await chartToken(page, '--qm-chart-remaining')).toBe(DARK_CHART_REMAINING);
  expect(await chartToken(page, '--qm-chart-peak')).toBe(DARK_CHART_PEAK);
  expect(await chartToken(page, '--qm-chart-reset')).toBe(DARK_CHART_RESET);
  expect(await chartToken(page, '--qm-chart-gap')).toBe(DARK_CHART_GAP);
  expect(await chartToken(page, '--qm-chart-stopped')).toBe(DARK_CHART_STOPPED);
  // Completeness: every token the charts read resolves in the mode — a
  // name missing from one of base.css's three theme blocks fails here
  // (CHART_TOKEN_NAMES is the single list, D-148).
  for (const [name, value] of Object.entries(await allChartTokens(page))) {
    expect(value, `${name} resolves in dark mode`).not.toBe('');
  }

  // System under an emulated dark OS must resolve to the SAME raw value
  // as explicit dark — the duplicated dark block cannot drift — and the
  // light default resolves to the light value.
  await page.getByTestId('theme-select').selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await backgroundToken(page)).toBe(DARK_TOKEN);
  expect(await chartToken(page, '--qm-chart-used')).toBe(DARK_CHART_USED);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await backgroundToken(page)).toBe(LIGHT_TOKEN);
  expect(await chartToken(page, '--qm-chart-used')).toBe(LIGHT_CHART_USED);
  for (const [name, value] of Object.entries(await allChartTokens(page))) {
    expect(value, `${name} resolves in light mode`).not.toBe('');
  }
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
