import { expect, test, type Route } from '@playwright/test';
import {
  healthyEventsBody,
  healthyHistoryBody,
  healthyPeakHoursBody,
  healthySettingsBody,
} from '../helpers/api';
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

test('the overview fits the 360 px viewport without horizontal overflow (task 175)', async ({
  page,
}) => {
  // §14.1: "an interface that works from 360 px wide". The task-175
  // charts region's grid floor is the newest overflow risk (`minmax`
  // tracks do not shrink below their floor), so this cell renders the
  // populated overview — identity card, range controls, metric cards,
  // AND chart cards — through the same interception at 360 px and pins
  // that nothing exceeds the viewport. The shell margins leave 296 px
  // of content width: every grid track must respect `min(100%, …)`.
  await page.setViewportSize({ width: 360, height: 640 });
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
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('overview-charts')).toBeVisible();
  await expect(page.getByTestId('metric-chart')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal overflow at 360 px').toBeLessThanOrEqual(0);
});

test('login page has no WCAG violations in either theme (task 180)', async ({ page }) => {
  // The §14.6 sign-in form — the one page that needs no interception:
  // it fires nothing on mount (the mode-agnostic form renders before
  // any credential exists; the csp-shell cells stand on the same
  // property), so the preview server's missing API costs it nothing.
  // The blank-guard sentence and the arm sentences share the failure
  // presentation's tone, pinned at the component level; here the
  // resting form goes through axe with its tokens applied per mode.
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible();
  await expect(page.getByTestId('login-form')).toBeVisible();
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('settings page has no WCAG violations in either theme (task 179)', async ({ page }) => {
  // The settings page's populated surface through route interception:
  // the annotated settings view (a restart-requiring trio, a configured
  // password) and the real §9.1 schedule through the providers listing —
  // facts, forms, password section, schedule table, and paths all
  // scanned with their tokens applied per mode. The environment-keyed
  // field (the disabled input with its annotation) joins the scan: the
  // editability marking is a §14.1 text+state surface.
  await page.route('**/api/**', (route) =>
    fulfillSettingsBody(route, {
      '/api/settings': {
        settings: {
          server: {
            host: { value: '127.0.0.1', source: 'file', restartRequired: true },
            port: { value: 8787, source: 'environment', restartRequired: true },
          },
          app: {
            timezone: { value: 'UTC', source: 'file', restartRequired: false },
            pollingIntervalSeconds: {
              value: 300,
              source: 'environment',
              restartRequired: false,
            },
            historyRetentionDays: { value: 180, source: 'file', restartRequired: false },
          },
          auth: {
            mode: { value: 'auto', source: 'file', restartRequired: true },
            passwordConfigured: true,
          },
          logging: { level: { value: 'warn', source: 'file', restartRequired: false } },
        },
        paths: {
          configPath: '/home/op/.config/quotameter/config.json',
          dataDir: '/home/op/.local/share/quotameter',
        },
        // §11.3/D-178: null — no completed cleanup in the mocked world.
        // FSM-5/D-193: [] — the baseline world is a clean start; the
        // pending state's marker and notice get their own scan below.
        appliedRetentionDays: null,
        pendingRestart: [],
      },
    }),
  );
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(page.getByTestId('settings-general')).toBeVisible();
  await expect(page.getByTestId('settings-schedule-window')).toBeVisible();
  await expect(page.getByTestId('settings-restart-marker')).toHaveCount(3);
  await expect(page.getByTestId('settings-env-note')).toHaveCount(1);
  await expect(page.getByTestId('api-error')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('the settings pending-restart state has no WCAG violations in either theme (FSM-5)', async ({
  page,
}) => {
  // The live state's own surface (D-193) joins the scan: the per-row
  // "restart pending" marker and the section notice beside the static
  // class markings — the danger-toned text with the remedy line, over
  // the same populated page as the baseline cell above (only the served
  // pendingRestart differs, so the two cells read as one matrix).
  await page.route('**/api/**', (route) =>
    fulfillSettingsBody(route, {
      '/api/settings': {
        settings: {
          server: {
            host: { value: '127.0.0.1', source: 'file', restartRequired: true },
            port: { value: 8787, source: 'environment', restartRequired: true },
          },
          app: {
            timezone: { value: 'UTC', source: 'file', restartRequired: false },
            pollingIntervalSeconds: {
              value: 300,
              source: 'environment',
              restartRequired: false,
            },
            historyRetentionDays: { value: 180, source: 'file', restartRequired: false },
          },
          auth: {
            mode: { value: 'auto', source: 'file', restartRequired: true },
            passwordConfigured: true,
          },
          logging: { level: { value: 'warn', source: 'file', restartRequired: false } },
        },
        paths: {
          configPath: '/home/op/.config/quotameter/config.json',
          dataDir: '/home/op/.local/share/quotameter',
        },
        appliedRetentionDays: null,
        // FSM-5/D-193: a hand-edited host adopted by a reload — the
        // live marker and notice are on the page under scan.
        pendingRestart: ['server.host'],
      },
    }),
  );
  await page.goto('/settings');
  await expect(page.getByTestId('settings-pending-restart')).toBeVisible();
  await expect(page.getByTestId('settings-pending-marker')).toHaveCount(1);
  await expect(page.getByTestId('settings-restart-marker')).toHaveCount(3);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('the settings page fits the 360 px viewport without horizontal overflow (task 179)', async ({
  page,
}) => {
  // §14.1's 360 px floor against this page's widest content: the facts
  // rows (a fixed dt floor) and the schedule's four-column window table
  // (task 175's precedent cell — grids and tables are the overflow
  // risks). The same interception as the a11y cell above serves the
  // populated surface.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.route('**/api/**', (route) =>
    fulfillSettingsBody(route, { '/api/settings': healthySettingsBody() }),
  );
  await page.goto('/settings');
  await expect(page.getByTestId('settings-schedule-window')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal overflow at 360 px').toBeLessThanOrEqual(0);
});

test('the charts region with annotations has no WCAG violations in either theme (task 181)', async ({
  page,
}) => {
  // The §14.4 chart surface every earlier cell left unrendered: their
  // fixtures answer the history load with an honest EMPTY series, so the
  // `chart-empty` state rendered instead of the chart. This cell serves a
  // points-bearing series (dual view, so the percent/absolute toggle
  // renders) under the FULL annotation vocabulary — a reset, a gap, a
  // failed cycle (the strip), a stopped region, and a windows-bearing
  // peak-hours schedule (the bands) — so the scanned surface includes
  // the chart image with its aria summary, the toggle fieldset, and the
  // identity/range/metric regions around it, with a live ECharts canvas
  // booted inside the scanned host.
  await page.route('**/api/**', fulfillAnnotatedChartsBody);
  await page.goto('/');
  await expect(page.getByTestId('overview-charts')).toBeVisible();
  await expect(page.getByTestId('chart-canvas')).toBeVisible();
  await expect(page.getByTestId('chart-view-toggle')).toBeVisible();
  // The ECharts instance booted — the scan runs against the live chart,
  // not a bare host div.
  await expect(page.locator('[data-testid="chart-canvas"] canvas')).toHaveCount(1);
  // §14.1's non-color signals, stated in the chart's accessible name:
  // ALL four annotation counts ride the aria summary as text (the
  // component composes them in this order) — dropping any annotation
  // class fails here, not just the first two.
  await expect(page.getByTestId('chart-canvas')).toHaveAttribute(
    'aria-label',
    /quota resets.+collection gaps.+stopped periods.+failed collections/s,
  );
  await expect(page.getByTestId('api-error')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('the populated accounts page has no WCAG violations in either theme (task 181)', async ({
  page,
}) => {
  // The management surface's populated arm — earlier cells scanned only
  // the degradation surface (the failed-load notice). One account with
  // a file-sourced key serves the selector, the management card's facts
  // and action buttons, and the add form; the purge confirm panel opens
  // once so its tinted danger surface and typed-label field join the
  // scan (the panel persists across the theme flips below).
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
    }),
  );
  await page.goto('/accounts');
  await expect(page.getByTestId('account-card')).toBeVisible();
  await expect(page.getByTestId('add-account-form')).toBeVisible();
  await page.getByTestId('purge-button').click();
  await expect(page.getByTestId('purge-confirm')).toBeVisible();
  await expect(page.getByTestId('api-error')).toHaveCount(0);
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('the accounts page fits the 360 px viewport without horizontal overflow (task 181)', async ({
  page,
}) => {
  // §14.1's 360 px floor against this page's widest content: the
  // management card's facts grid (a fixed 8rem dt track) beside the
  // selector and add form — the task-175/179 precedent cells cover the
  // overview and settings; this closes the matrix for the third page.
  await page.setViewportSize({ width: 360, height: 640 });
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
    }),
  );
  await page.goto('/accounts');
  await expect(page.getByTestId('account-card')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal overflow at 360 px').toBeLessThanOrEqual(0);
});

test('the login failure surface has no WCAG violations in either theme (task 181)', async ({
  page,
}) => {
  // The §14.6 form's failure arm — the earlier login cell scanned the
  // resting form only. One refused attempt renders the role="alert"
  // sentence beside the aria-invalid field (D-146's
  // invalid-credentials arm), and THAT surface goes through axe with
  // its tokens applied per mode.
  await page.route('**/auth/login', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
          details: { reason: 'invalid-credentials' },
        },
      }),
    }),
  );
  await page.goto('/login');
  await page.getByTestId('login-password').fill('a-wrong-candidate');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-failure')).toBeVisible();
  await expect(page.getByTestId('login-password')).toHaveAttribute('aria-invalid', 'true');
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('theme-select').selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await assertNoAccessibilityViolations(page);
  }
});

test('the login page fits the 360 px viewport without horizontal overflow (task 181)', async ({
  page,
}) => {
  // §14.1's 360 px floor for the fourth page — the form's capped-width
  // column and the shell header wrapping around it.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/login');
  await expect(page.getByTestId('login-form')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal overflow at 360 px').toBeLessThanOrEqual(0);
});

/**
 * Fulfills one settings-page GET with the given per-path body overrides
 * on top of the standing providers default (the real registered provider
 * with its §9.1 schedule); unknown API paths answer the §13 envelope's
 * 404 shape, matching the honest server behavior.
 */
async function fulfillSettingsBody(
  route: Route,
  overrides: Record<string, unknown>,
): Promise<void> {
  const url = new URL(route.request().url());
  const { pathname } = url;
  const body: Record<string, unknown> = {
    '/api/providers': {
      providers: [
        {
          id: 'zai-coding-plan',
          name: 'Z.ai Coding Plan',
          peakHours: {
            timezone: 'Asia/Singapore',
            offPeakMultiplier: 0.5,
            windows: [
              {
                id: 'zai-weekday-peak',
                name: 'Z.ai Coding Plan peak hours',
                days: ['mon', 'tue', 'wed', 'thu', 'fri'],
                start: '14:00',
                end: '18:00',
                multiplier: 1,
              },
            ],
          },
          metrics: [{ metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' }],
        },
      ],
    },
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
    // Task 176: the page's third range-keyed load — the no-schedule arm
    // (the scenario providers above carry `peakHours: null`), so the
    // chart surface renders its stated no-schedule state, never an error.
    '/api/peak-hours': healthyPeakHoursBody(`${pathname}${search}`),
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

/* ── The task-181 annotation-bearing charts fixture ─────────────────────── */

/** The wire shape of one account row (the §13 accounts surface). */
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

/** One dual-view series point at the given instant. */
function annotatedPointAt(at: number): Record<string, unknown> {
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

/** `yyyy-MM-ddTHH:mm` — the D-073 local string in the schedule zone. */
const SCHEDULE_ZONE = 'Asia/Singapore';
function localTime(at: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Serves the populated overview with the FULL §14.4 annotation
 * vocabulary (task 181's axe fixture): a dual-view series (the toggle
 * renders), a reset and a gap on the metric, a failed cycle and a
 * stopped region (the account-level marks), and a windows-bearing
 * peak-hours schedule (the bands) — every annotation surface the chart
 * card can render, over the intercepted window like the sync suite's
 * fixture.
 */
async function fulfillAnnotatedChartsBody(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const { pathname, search } = url;
  const params = new URLSearchParams(search);
  const requestedFrom = Date.parse(params.get('from') ?? '');
  const requestedTo = Date.parse(params.get('to') ?? '');
  const span = requestedTo - requestedFrom;
  const at = (fraction: number): number => requestedFrom + Math.floor(span * fraction);
  const range = {
    outcome: 'ok',
    requestedFrom,
    requestedTo,
    effectiveFrom: requestedFrom,
    effectiveTo: requestedTo,
    retentionHorizon: null,
  };
  // The range-keyed routes answer only range-bearing requests; every
  // other GET (settings, accounts, status, quota, providers) skips the
  // block entirely — their URLs carry no boundaries to echo.
  const ranged =
    Number.isFinite(requestedFrom) && Number.isFinite(requestedTo) && span > 0
      ? {
          '/api/history': {
            accountId: params.get('accountId') ?? '',
            metric: params.get('metric') ?? '',
            unit: 'CREDITS',
            limitType: 'ROLLING_WINDOW',
            range,
            downsampled: false,
            resolutionMs: null,
            sourcePointCount: 2,
            points: [annotatedPointAt(at(0.25)), annotatedPointAt(at(0.75))],
          },
          '/api/events': {
            accountId: params.get('accountId') ?? '',
            metric: null,
            range,
            // Time-ascending (the wire contract's documented order).
            events: [
              {
                kind: 'collection_error',
                outcome: 'rate_limited',
                fromEpochMs: at(0.1),
                toEpochMs: at(0.1) + 30_000,
                durationMs: 30_000,
                httpStatus: 429,
                message: 'Provider rate limited the request.',
                attempts: 2,
                retryAfterSeconds: 5,
              },
              {
                kind: 'gap',
                metricKey: 'mcp-monthly',
                fromEpochMs: at(0.3),
                toEpochMs: at(0.4),
                elapsedMs: Math.floor(span * 0.1),
                intervalSeconds: 300,
                thresholdMs: 900_000,
              },
              {
                kind: 'reset',
                metricKey: 'mcp-monthly',
                eventAt: at(0.5),
                runId: null,
                details: { reason: 'limit-change' },
              },
              {
                kind: 'stopped_service',
                fromEpochMs: at(0.6),
                toEpochMs: at(0.7),
                elapsedMs: Math.floor(span * 0.1),
                intervalSeconds: 300,
                thresholdMs: 900_000,
              },
            ],
          },
          '/api/peak-hours': {
            accountId: params.get('accountId') ?? '',
            providerId: 'zai-coding-plan',
            timezone: 'Asia/Singapore',
            offPeakMultiplier: 0.5,
            range,
            intervals: [
              {
                kind: 'off-peak',
                start: requestedFrom,
                end: at(0.5),
                multiplier: 0.5,
                localStart: localTime(requestedFrom),
                localEnd: localTime(at(0.5)),
              },
              {
                kind: 'peak',
                start: at(0.5),
                end: requestedTo,
                multiplier: 1,
                windowId: 'zai-weekday-peak',
                name: 'Z.ai Coding Plan peak hours',
                localStart: localTime(at(0.5)),
                localEnd: localTime(requestedTo),
              },
            ],
          },
        }
      : {};
  const body: Record<string, unknown> = {
    '/api/accounts': { accounts: [accountRow()] },
    '/api/providers': {
      providers: [
        {
          id: 'zai-coding-plan',
          name: 'Z.ai Coding Plan',
          peakHours: {
            timezone: 'Asia/Singapore',
            offPeakMultiplier: 0.5,
            windows: [
              {
                id: 'zai-weekday-peak',
                name: 'Z.ai Coding Plan peak hours',
                days: ['mon', 'tue', 'wed', 'thu', 'fri'],
                start: '14:00',
                end: '18:00',
                multiplier: 1,
              },
            ],
          },
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
    ...ranged,
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
