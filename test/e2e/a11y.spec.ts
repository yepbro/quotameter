import { expect, test, type Route } from '@playwright/test';
import { healthyEventsBody, healthyHistoryBody, healthySettingsBody } from '../helpers/api';
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

test('overview page has no WCAG violations in either theme (task 172)', async ({ page }) => {
  // The overview's degradation surface under `vite preview` (no API):
  // the shared `unexpected` notices with their retries — scanned per
  // mode with the tokens actually applied. The full-data surface (the
  // identity card, status badges, metric cards) has no axe scan yet —
  // axe runs in the e2e project only, and this suite has no API behind
  // it; scanning the populated surface is the composition task's seam
  // (wire the API into a served construction) or a component-level axe
  // dependency, recorded as task 172's loose end.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
  await expect(page.getByTestId('api-error').first()).toBeVisible();
  await expect(page.getByTestId('overview-empty')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('overview fresh-install empty state has no WCAG violations (task 173)', async ({ page }) => {
  // The preview server has no API behind it (the suite's standing
  // shape), so the fresh-install surface is produced by route
  // interception: the four overview loads answered with the honest
  // bodies a fresh `init` without an account serves — including the
  // real registered provider (a fresh install carries its adapters;
  // the registry-empty build is a separate degradation case, pinned
  // at the component level). No quota fires — no account is selected.
  // The scanned page is then the real no-accounts guidance block —
  // the task-173 done-condition's first cell — in both themes, and
  // the CTA is proven a live SPA link to the management page.
  await page.route('**/api/**', (route) =>
    fulfillOverviewBody(route, {
      '/api/accounts': { accounts: [] },
      '/api/status': { status: 'ok', pollingIntervalSeconds: 300, accounts: [] },
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('overview-empty')).toBeVisible();
  await expect(page.getByTestId('overview-empty-cta')).toBeVisible();
  await expect(page.getByTestId('api-error')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }

  // The link is a real SPA navigation, not a dead anchor.
  await page.getByTestId('overview-empty-cta').click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('heading', { name: 'Accounts', level: 2 })).toBeVisible();
});

test('overview attention notice has no WCAG violations (task 173)', async ({ page }) => {
  // The same interception technique for the second task-173 surface:
  // one disabled account — the notice with its muted-background token
  // pair and the CTA link — axe-scanned in both themes.
  await page.route('**/api/**', (route) =>
    fulfillOverviewBody(route, {
      '/api/accounts': {
        accounts: [
          {
            id: 'acc-1',
            providerId: 'zai-coding-plan',
            label: 'Main',
            enabled: false,
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
      '/api/status': {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [{ id: 'acc-1', status: 'disabled', lastSuccessAt: null, lastError: null }],
      },
      '/api/quota': {
        accountId: 'acc-1',
        status: 'disabled',
        collectedAt: null,
        planName: null,
        metrics: [],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('overview-attention')).toBeVisible();
  await expect(page.getByTestId('overview-attention-cta')).toBeVisible();
  await expect(page.getByTestId('api-error')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('overview range controls’ disabled state has no WCAG violations (task 174)', async ({
  page,
}) => {
  // The §14.4 a11y-critical surface: retention 7 disables the 14/30-day
  // options, each explaining itself as real text (never color alone,
  // §14.1) — the same interception technique, one keyed account with a
  // metric so the range-keyed loads fire beside the control. The
  // disabled radios and the muted reason texts go through axe in both
  // themes (the component suite pins the structure, only a real
  // browser scans WCAG contrast).
  await page.route('**/api/**', (route) =>
    fulfillOverviewBody(route, {
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
      '/api/status': {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [{ id: 'acc-1', status: 'fresh', lastSuccessAt: null, lastError: null }],
      },
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
      '/api/settings': healthySettingsBody(7),
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('history-range')).toBeVisible();
  // Exactly the two beyond-retention options carry the explanation.
  await expect(page.getByTestId('history-range-reason')).toHaveCount(2);
  await expect(page.getByTestId('history-range-reason').first()).toHaveText(
    'Exceeds the 7-day history retention',
  );
  await expect(page.getByTestId('api-error')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

/**
 * Fulfills one overview GET with the given per-path body overrides on
 * top of the standing defaults (the real provider listing, the healthy
 * settings view, and — since task 174 wired them — the range-keyed
 * history/events loads, served through the same healthy-body helpers
 * the component suites use); unknown API paths answer the §13
 * envelope's 404 shape, matching the honest server behavior.
 */
async function fulfillOverviewBody(
  route: Route,
  overrides: Record<string, unknown>,
): Promise<void> {
  const url = new URL(route.request().url());
  const { pathname, search } = url;
  const body: Record<string, unknown> = {
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
    '/api/settings': healthySettingsBody(),
    // Task 174: the page's range-keyed loads — the helpers echo the
    // intercepted window back as the healthy range report.
    '/api/events': healthyEventsBody(`${pathname}${search}`),
    '/api/history': healthyHistoryBody(`${pathname}${search}`),
    ...overrides,
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
