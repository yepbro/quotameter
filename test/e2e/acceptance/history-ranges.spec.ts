import { expect, test } from '@playwright/test';
import { startAcceptanceServer, type AcceptanceServer } from '../helpers/acceptance';

/**
 * The §17.1 range-disabling acceptance scenario (spec §14.4) against the
 * served construction: with `app.historyRetentionDays: 10` in the real
 * configuration, the overview's range control offers the five §14.4
 * rolling ranges, disables exactly those exceeding retention (14 days and
 * 30 days), explains why in real text beside each disabled option, keeps
 * the default (7 days) selected, and still switches between the enabled
 * ranges. The retention figure flows the full path — config file →
 * `GET /api/settings`'s annotated value → the control's reason sentence.
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC', historyRetentionDays: 10 },
      accounts: [
        {
          id: 'retention-account',
          providerId: 'zai-coding-plan',
          label: 'Retention account',
          apiKey: 'sk-dummy-retention',
        },
      ],
    },
  });
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('ranges beyond the configured retention are disabled with the reason sentence', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/`);

  const fieldset = page.getByTestId('history-range');
  await expect(fieldset).toBeVisible();
  await expect(fieldset).toContainText('History range');

  // The §14.4 "explain why": the disabled option carries the retention
  // sentence as real text beside its label — never color alone (§14.1).
  for (const rangeId of ['14d', '30d']) {
    const option = fieldset.locator(`[data-range-id="${rangeId}"]`);
    await expect(option.locator('input')).toBeDisabled();
    await expect(option.getByTestId('history-range-reason')).toHaveText(
      'Exceeds the 10-day history retention',
    );
  }
  // Within retention: enabled, no reason text rendered at all.
  for (const rangeId of ['24h', '3d', '7d']) {
    const option = fieldset.locator(`[data-range-id="${rangeId}"]`);
    await expect(option.locator('input')).toBeEnabled();
    await expect(option.getByTestId('history-range-reason')).toHaveCount(0);
  }
  // The §14.4 default: 7 days is the selected range on arrival.
  await expect(fieldset.locator('[data-range-id="7d"] input')).toBeChecked();
});

test('switching between enabled ranges moves the selection', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  const fieldset = page.getByTestId('history-range');

  await fieldset.locator('[data-range-id="24h"] input').check();
  await expect(fieldset.locator('[data-range-id="24h"] input')).toBeChecked();
  await expect(fieldset.locator('[data-range-id="7d"] input')).not.toBeChecked();

  await fieldset.locator('[data-range-id="3d"] input').check();
  await expect(fieldset.locator('[data-range-id="3d"] input')).toBeChecked();
  // The retention fallback never fired: retention (10 days) admits the
  // picked ranges, so no fallback announcement renders.
  await expect(page.getByTestId('history-range-fallback')).toHaveCount(0);
});
