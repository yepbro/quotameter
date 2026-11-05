/// <reference lib="dom" />
// (The DOM lib reference exists because one cell reads a computed
// outline style inside `locator.evaluate` — `getComputedStyle` is
// browser-only — while the project's tsconfig is the Node-only server
// config; the smoke and theme specs document the same pattern.)

import { expect, test, type Route } from '@playwright/test';
import { healthyApiBody, healthySettingsBody } from '../helpers/api';

/**
 * Keyboard-operability proofs (task 181, spec §14.1; decision D-164):
 * the done-condition's "key workflows are keyboard-usable" made
 * executable — the shell navigation, the §14.6 login round trip, the
 * §14.4 range switch, the inline confirmation panels' dismissal with
 * focus restoration, and the §14.5 time-zone suggestion list. Native
 * controls carry the platform's keyboard support; these cells pin that
 * nothing in the composition broke it and that the task-181 additions
 * (the designed focus ring, Escape dismissal, ArrowDown into the
 * suggestions) behave.
 *
 * The preview server has no API behind it (the suite's standing shape),
 * so every data-backed surface is served by route interception — the
 * a11y suite's technique.
 */

/** The §13 envelope's unauthenticated answer (the login round trip). */
function unauthenticated(reason?: string) {
  return {
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
        details: reason === undefined ? null : { reason },
      },
    }),
  };
}

/** A healthy §13 body for whatever GET the page fired. */
function healthy(route: Route) {
  const url = new URL(route.request().url());
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(healthyApiBody(url.pathname + url.search)),
  };
}

/** One wire-shaped account row with a file-sourced key. */
function accountRow(): Record<string, unknown> {
  return {
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
  };
}

test('the shell is keyboard-navigable and paints the designed focus ring', async ({ page }) => {
  await page.goto('/');
  // Wait for the SPA to mount before keying (goto can return first).
  const overview = page.getByRole('link', { name: 'Overview' });
  await expect(overview).toBeVisible();

  // Tab reaches the primary nav first (the header precedes main); the
  // focused link paints the task-181 token outline, not just the UA
  // default — the designed indicator §14.1's keyboard support leans on.
  await page.keyboard.press('Tab');
  await expect(overview).toBeFocused();
  expect(await overview.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
    'solid',
  );

  // Arrow/Tab movement inside the nav, then Enter navigates (RouterLink
  // renders a real anchor — the platform's activation is the proof).
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Accounts' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('heading', { name: 'Accounts', level: 2 })).toBeVisible();

  // The theme control is a native select: arrow keys operate it without
  // a pointer (system → light), and the mode flips live (D-133).
  const themeSelect = page.getByTestId('theme-select');
  await themeSelect.focus();
  await page.keyboard.press('ArrowDown');
  await expect(themeSelect).toHaveValue('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The focused control keeps painting the ring in explicit light — and
  // the outline's COLOR is the mode's token: flipping to dark re-reads
  // the cascade, so the ring's two modes are both pinned (the system
  // mode computes one of the two, per the theme spec's token pins).
  const outlineOf = (): Promise<string> =>
    themeSelect.evaluate((element) => getComputedStyle(element).outlineColor);
  const lightOutline = await outlineOf();
  await themeSelect.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await themeSelect.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
    'solid',
  );
  expect(await outlineOf()).not.toBe(lightOutline);
});

test('the login round trip completes by keyboard alone', async ({ page }) => {
  // Before the sign-in every GET answers the 401 envelope; after it,
  // healthy bodies. The login POST is answered by its own arm — with a
  // delay, so the pending window (where the write-only clear at
  // dispatch is observable) is wide enough to assert inside.
  let signedIn = false;
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/auth/login') {
      signedIn = true;
      // Hold the response open (`route.fulfill`'s own `delay` option is
      // not honored by the installed Playwright — a handler-side await
      // is) so the pending window is wide enough to assert inside.
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ session: { expiresAt: Date.now() + 86_400_000 } }),
            }),
          );
        }, 1_000);
      });
    }
    return route.fulfill(signedIn ? healthy(route) : unauthenticated());
  });

  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?redirect=\/settings$/);
  // Keyboard only from here: the field fills by typing and the form
  // submits by Enter — no pointer anywhere in the round trip.
  const field = page.getByTestId('login-password');
  await field.focus();
  await page.keyboard.type('a-correct-password');
  await page.keyboard.press('Enter');

  // While the request is pending (still on the login page), the
  // attempted candidate is already gone — write-only AT DISPATCH
  // (D-159), not merely after the round trip.
  await expect(page.getByTestId('login-submit')).toHaveText(/Signing in/);
  await expect(field).toHaveValue('');

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('settings-general')).toBeVisible();
});

test('the history range switches by keyboard and re-dispatches the series load', async ({
  page,
}) => {
  // The §14.4 range control is a native radio group: arrow keys move
  // the selection AND fire change — the page re-dispatches its
  // range-keyed loads. The proof watches the requested span, not a
  // mock call count: a 3-day selection must send a 3-day window.
  const historySpansMs: number[] = [];
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/history') {
      const from = Date.parse(url.searchParams.get('from') ?? '');
      const to = Date.parse(url.searchParams.get('to') ?? '');
      if (Number.isFinite(from) && Number.isFinite(to)) historySpansMs.push(to - from);
    }
    return fulfillPopulatedOverview(route);
  });
  await page.goto('/');
  await expect(page.getByTestId('history-range')).toBeVisible();
  // The default 7-day load fired; the sentinel proves any later
  // navigation stayed client-side (an arrow key must not reload).
  await expect
    .poll(() => historySpansMs.filter((span) => Math.abs(span - 7 * 86_400_000) < 5_000).length, {
      timeout: 5_000,
    })
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as { __rangeNoReload?: boolean }).__rangeNoReload = true;
  });

  await page.locator('input[name="history-range"]:checked').focus();
  await page.keyboard.press('ArrowUp');
  // The selection moved to the previous option and its label checked.
  await expect(page.locator('input[name="history-range"]:checked')).toHaveValue('3d');
  // The re-dispatch: a /api/history window of (approximately) 3 days.
  await expect
    .poll(() => historySpansMs.filter((span) => Math.abs(span - 3 * 86_400_000) < 5_000).length, {
      timeout: 5_000,
    })
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (window as { __rangeNoReload?: boolean }).__rangeNoReload === true),
  ).toBe(true);
});

test('the inline confirmation panels dismiss by keyboard and restore focus', async ({ page }) => {
  await page.route('**/api/**', fulfillPopulatedOverview);
  await page.goto('/accounts');
  await expect(page.getByTestId('account-card')).toBeVisible();

  // Purge: Enter on the opener, focus lands in the typed-confirmation
  // input, Escape closes the panel and returns focus to the opener
  // (task 181, D-164 — the dismissal the review scope named).
  const purge = page.getByTestId('purge-button');
  await purge.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('purge-confirm-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('purge-confirm')).toHaveCount(0);
  await expect(purge).toBeFocused();

  // Archive: focus lands on the SAFE control first (D-135), Escape
  // restores the opener.
  const archive = page.getByTestId('archive-button');
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('archive-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('archive-confirm')).toHaveCount(0);
  await expect(archive).toBeFocused();

  // Rename: the inline form carries the same dismissal contract.
  const rename = page.getByTestId('rename-button');
  await rename.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('rename-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rename-input')).toHaveCount(0);
  await expect(rename).toBeFocused();
});

test('the time-zone suggestions are keyboard-reachable and escapable', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(healthyApiBody(new URL(route.request().url()).pathname)),
    }),
  );
  await page.goto('/settings');
  await expect(page.getByTestId('settings-general')).toBeVisible();

  const field = page.getByTestId('settings-timezone');
  await field.focus();
  // The task-181 linkage: the field describes its search affordance and,
  // while the list exists, controls it by id (aria-expanded is the
  // combobox contract D-156 declined — a plain textbox keeps the
  // ARIA-1.2-legal attributes only).
  await expect(field).toHaveAttribute('aria-describedby', 'settings-timezone-hint');
  await field.fill('');
  await page.keyboard.type('Toky');
  const list = page.getByTestId('settings-timezone-suggestions');
  await expect(list).toBeVisible();
  await expect(field).toHaveAttribute('aria-controls', 'settings-timezone-suggestions');
  // The controlled id resolves to the rendered list.
  await expect(page.locator('#settings-timezone-suggestions')).toBeVisible();

  // ArrowDown hands focus to the first suggestion — a real button, so
  // Tab/Enter keep working natively from there.
  await page.keyboard.press('ArrowDown');
  const first = page.getByTestId('settings-timezone-option').first();
  await expect(first).toBeFocused();

  // Escape from the list reverts the edit and returns focus to the field.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('UTC');
  await expect(field).not.toHaveAttribute('aria-controls');

  // The pick flow: ArrowDown + Enter applies the suggestion and returns
  // focus to the field (the picked button unmounts with the list —
  // without the hand-off, keyboard focus would fall to the body).
  await field.fill('');
  await page.keyboard.type('Toky');
  await expect(list).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('Asia/Tokyo');
  await expect(list).toHaveCount(0);
  await expect(field).toBeFocused();
});

/**
 * Serves the populated overview (one account, one quota metric, the
 * healthy range-keyed loads) or the accounts page's two loads — the
 * shared fixture of the range-switch and panel cells, the a11y suite's
 * per-path body map over the healthy-body helpers.
 */
async function fulfillPopulatedOverview(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const { pathname, search } = url;
  const body: Record<string, unknown> = {
    '/api/accounts': { accounts: [accountRow()] },
    '/api/providers': {
      providers: [
        {
          id: 'zai-coding-plan',
          name: 'Z.ai Coding Plan',
          peakHours: null,
          metrics: [{ metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' }],
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
      metrics: [
        {
          metricKey: 'mcp-monthly',
          limitType: 'MONTHLY',
          unit: 'REQUESTS',
          windowSeconds: null,
          used: 1,
          remaining: null,
          limit: null,
          percentUsed: null,
          percentRemaining: null,
          resetsAt: null,
          isValid: true,
          invalidReason: null,
          derivedFields: null,
          collectedAt: 1,
        },
      ],
    },
    '/api/history': healthyApiBody(`/api/history${search}`),
    '/api/events': healthyApiBody(`/api/events${search}`),
    '/api/peak-hours': healthyApiBody(`/api/peak-hours${search}`),
  };
  const answer = body[pathname];
  if (answer === undefined) {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route', details: null } }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(answer),
  });
}
