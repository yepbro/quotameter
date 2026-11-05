import { expect, test } from '@playwright/test';
import { startAcceptanceServer, type AcceptanceServer } from '../helpers/acceptance';

/**
 * The §17.1 empty-state acceptance scenario against the served
 * construction: a freshly initialized service (no accounts) honestly
 * guides on both pages — the overview's no-accounts block with its link
 * to the management page (§14.3), the accounts page's own empty state
 * beside a ready add form (§14.2) — and nowhere a load failure: the real
 * API answers every load the pages dispatch. This is the honest empty
 * state the preview-server suites cannot produce (no API behind them),
 * which is exactly why the scenario belongs here.
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({ config: { app: { timezone: 'UTC' } } });
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('the overview shows the no-accounts guidance, not a failure', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);

  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
  await expect(page.getByTestId('overview-empty')).toBeVisible();
  await expect(page.getByTestId('overview-empty')).toContainText('No accounts yet');
  // The actionable next step is a live link to the management page.
  const cta = page.getByTestId('overview-empty-cta');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText('Go to Accounts');
  await expect(cta).toHaveAttribute('href', '/accounts');
  // The honest guidance, never a fake degradation.
  await expect(page.getByTestId('api-error')).toHaveCount(0);
});

test('the accounts page shows its empty state with a usable add form', async ({ page }) => {
  await page.goto(`${server.baseUrl}/accounts`);

  await expect(page.getByRole('heading', { name: 'Accounts', level: 2 })).toBeVisible();
  await expect(page.getByTestId('accounts-empty')).toBeVisible();
  await expect(page.getByTestId('accounts-empty')).toContainText(
    'Add your first account below — you can skip the API key and set it later.',
  );
  await expect(page.getByTestId('api-error')).toHaveCount(0);

  // The real registry serves the real adapter — the provider select offers
  // it and the form is ready (not the no-providers degradation).
  const provider = page.getByTestId('add-provider');
  await expect(provider).toBeEnabled();
  await expect(provider.locator('option')).toHaveCount(1);
  await expect(provider.locator('option')).toHaveText('Z.ai Coding Plan');
  await expect(page.getByTestId('add-label')).toBeEnabled();
  await expect(page.getByTestId('add-key')).toBeEnabled();
  // The key input is write-only by construction (§14.2).
  await expect(page.getByTestId('add-key')).toHaveAttribute('type', 'password');
});
