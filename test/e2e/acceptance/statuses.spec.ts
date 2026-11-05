/// <reference lib="dom" />
// (The DOM lib reference exists because this spec reads option element
// values inside `evaluateAll` — browser-only DOM API — while the
// project's tsconfig is the Node-only server config; the smoke spec
// documents the same pattern.)

import { expect, test } from '@playwright/test';
import {
  seedFailedCycle,
  seedSuccessCycle,
  seededMetric,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';

/**
 * The §17.1 "all account statuses" acceptance scenario (spec §7.3, §14.6)
 * against the served construction: eight accounts, each driven into one of
 * the eight §7.3/§14.6 states through the real derivation path — the
 * configuration's enablement and key facts, storage rows seeded through the
 * real write path with `Date.now()`-anchored stamps, and the single §7.3
 * precedence resolving the badge the overview renders. The §7.2 "most
 * recent error" and "last successful collection" facts render beside the
 * badges for the failing and the fresh accounts respectively.
 *
 * Ages sit far from their boundaries (the default 300 s interval makes the
 * Fresh/Stale threshold 15 minutes): 5 minutes (Fresh), 40 minutes (Stale),
 * failures 3 minutes ago (their ranks preempt the age states entirely).
 */

/** One seeded world account: id, its §14.6 label, and how it was driven. */
const STATUS_WORLDS = [
  { id: 'acc-auth-rejected', label: 'Auth rejected', status: 'auth-rejected' },
  { id: 'acc-collecting', label: 'Collecting', status: 'collecting' },
  { id: 'acc-disabled', label: 'Disabled', status: 'disabled' },
  { id: 'acc-format-changed', label: 'Format changed', status: 'format-changed' },
  { id: 'acc-fresh', label: 'Fresh', status: 'fresh' },
  { id: 'acc-not-configured', label: 'Not configured', status: 'not-configured' },
  { id: 'acc-stale', label: 'Stale', status: 'stale' },
  { id: 'acc-unreachable', label: 'Unreachable', status: 'unreachable' },
] as const;

function statusWorldConfig(): unknown {
  return {
    app: { timezone: 'UTC' },
    accounts: STATUS_WORLDS.map((world) => ({
      id: world.id,
      providerId: 'zai-coding-plan',
      label: `${world.label} account`,
      // A distinct non-secret dummy key per account, except the
      // not-configured account: its `apiKeyEnv` names a variable this
      // process never sets — the declared-but-unresolved source is the
      // honest §7.3 Not configured path.
      ...(world.id === 'acc-not-configured'
        ? { apiKeyEnv: 'QM_ACCEPTANCE_UNSET_KEY' }
        : { apiKey: `sk-dummy-${world.id}` }),
      ...(world.id === 'acc-disabled' ? { enabled: false } : {}),
    })),
  };
}

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({ config: statusWorldConfig() });
  const now = Date.now();
  const metric = seededMetric('mcp-monthly');
  // The §7.3-ranked failures (3 minutes ago; their ranks preempt age).
  seedFailedCycle(server.repository, 'acc-auth-rejected', now - 180_000, 'auth_error', {
    httpStatus: 401,
    errorMessage: 'the provider rejected the credentials',
    attempts: 1,
  });
  seedFailedCycle(server.repository, 'acc-format-changed', now - 180_000, 'parse_error', {
    errorMessage: 'unrecognized response schema',
    attempts: 1,
  });
  seedFailedCycle(server.repository, 'acc-unreachable', now - 180_000, 'network_error', {
    errorMessage: 'the provider could not be reached',
    attempts: 3,
  });
  // The age-defined states: 5 minutes is Fresh, 40 minutes Stale (the
  // 300 s-interval threshold is 15 minutes).
  seedSuccessCycle(server.repository, 'acc-fresh', now - 300_000, [metric]);
  seedSuccessCycle(server.repository, 'acc-stale', now - 2_400_000, [metric]);
  // acc-collecting, acc-disabled, acc-not-configured need no runs: the
  // first poll pending, the disabled flag, and the unresolved key source
  // derive their states from the configuration alone.
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('every configured account appears in the selector, id-sorted', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  const select = page.getByTestId('overview-account-select');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveCount(8);
  // The rendered order is the merged list's id-ascending order (D-128).
  const renderedIds = await select
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(renderedIds).toEqual([...STATUS_WORLDS.map((world) => world.id)].sort());
  for (const world of STATUS_WORLDS) {
    await expect(select.locator(`option[value="${world.id}"]`)).toHaveText(
      `${world.label} account`,
    );
  }
});

test('each account renders its own §7.3 badge and label', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  for (const world of STATUS_WORLDS) {
    await page.getByTestId('overview-account-select').selectOption(world.id);
    const badge = page.getByTestId('status-badge');
    await expect(badge).toBeVisible();
    // The state is the data attribute AND the real i18n label — the text
    // is the signal, the attribute the contract (§14.1).
    await expect(badge).toHaveAttribute('data-status', world.status);
    await expect(badge).toHaveText(world.label);
  }
});

test('the failing accounts state their most recent error beside the badge', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  const cases = [
    { id: 'acc-auth-rejected', outcome: 'Authentication error' },
    { id: 'acc-format-changed', outcome: 'Response format error' },
    { id: 'acc-unreachable', outcome: 'Network error' },
  ] as const;
  for (const caseItem of cases) {
    await page.getByTestId('overview-account-select').selectOption(caseItem.id);
    const lastError = page.getByTestId('overview-last-error');
    await expect(lastError).toBeVisible();
    await expect(lastError).toContainText(caseItem.outcome);
  }
});

test('the fresh account states its last successful collection; the healthy have no error', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/`);
  await page.getByTestId('overview-account-select').selectOption('acc-fresh');
  const lastSuccess = page.getByTestId('overview-last-success');
  await expect(lastSuccess).toBeVisible();
  // A real collection happened — the never-collected sentence must not show.
  await expect(lastSuccess).not.toContainText('Never');
  // §7.2: no error for the healthy account renders the explicit none.
  await expect(page.getByTestId('overview-last-error')).toHaveText('None');
});

test('the not-configured account carries the actionable attention notice', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await page.getByTestId('overview-account-select').selectOption('acc-not-configured');
  // The environment-sourced remedy sentence (D-138): the notice is the
  // §14.3 companion of the Not configured state.
  const notice = page.getByTestId('overview-attention');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    'comes from an environment variable that is not set where the service runs',
  );
});
