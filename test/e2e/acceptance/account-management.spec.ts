import { expect, test } from '@playwright/test';
import {
  ACCEPTANCE_MARKER_KEY,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';

/**
 * The §17.1 account-creation and key-masking acceptance scenario against
 * the served construction (spec §14.2, §15.4): adding an account through
 * the real form persists through the real stores (a 201 from the real
 * route over the real configuration file), the key is masked end to end —
 * the constant content-free mask on the card, the typed marker secret
 * nowhere in the rendered page, and nowhere in the server's own log lines
 * — and the connection test reaches the REAL Z.ai adapter, whose one
 * request the mock provider answers on loopback: 200 passes the key,
 * 401 rejects it (§8.2's test-connection vocabulary).
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  server = await startAcceptanceServer({ config: { app: { timezone: 'UTC' } } });
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

test('creating an account through the form masks the key everywhere', async ({ page }) => {
  await page.goto(`${server.baseUrl}/accounts`);

  // The real form over the real registry (§14.2): label plus a write-only
  // key, submitted to the real POST route.
  await page.getByTestId('add-label').fill('Acceptance Main');
  await page.getByTestId('add-key').fill(ACCEPTANCE_MARKER_KEY);
  await page.getByTestId('add-account-form').getByRole('button').click();

  // The created account's management card: label, provider, and the §13
  // key-masking pair rendered as the constant content-free mask.
  const card = page.getByTestId('account-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Acceptance Main' })).toBeVisible();
  await expect(card).toContainText('Z.ai Coding Plan');
  await expect(card).toContainText('API key');
  await expect(card).toContainText('********');
  await expect(card).not.toContainText('Not set');

  // §15.4: the marker secret never renders — not the card, not the page.
  expect(await page.content(), 'the marker key must not appear in the DOM').not.toContain(
    ACCEPTANCE_MARKER_KEY,
  );
  // And never in the server's own log lines (the §16 redacting logger).
  for (const line of server.sink.lines()) {
    expect(line, 'the marker key must not appear in server logs').not.toContain(
      ACCEPTANCE_MARKER_KEY,
    );
  }
});

test('the connection test passes against the mock provider, then rejects on a 401', async ({
  page,
}) => {
  // The mock answers the adapter's real credential check (one GET to
  // `{codingBaseUrl}/models`): 200 accepts the key first, 401 rejects it.
  server.mock.setPathBehavior('/models', {
    kind: 'respond',
    status: 200,
    body: '{"data":[]}',
  });
  await page.goto(`${server.baseUrl}/accounts`);

  const result = page.getByTestId('test-result');
  await page.getByTestId('test-button').click();
  await expect(result).toHaveAttribute('data-outcome', 'ok');
  await expect(result).toContainText('Connection test passed.');

  // The real adapter's request genuinely reached the mock with the key.
  const check = server.mock.requests.find((request) => request.url === '/models');
  expect(check, 'the adapter must have requested the credential check').toBeDefined();
  expect(check!.headers.authorization).toBe(`Bearer ${ACCEPTANCE_MARKER_KEY}`);

  // §7.2's rejection arm: the 401 answer fails the test with its own
  // sentence, immediately (§14.2).
  server.mock.setPathBehavior('/models', { kind: 'respond', status: 401, body: '{}' });
  await page.getByTestId('test-button').click();
  await expect(result).toHaveAttribute('data-outcome', 'rejected');
  await expect(result).toContainText('Connection test failed: the provider rejected the API key.');
  // The rejection is honest data, still no secret anywhere.
  expect(await page.content()).not.toContain(ACCEPTANCE_MARKER_KEY);
  // §15.4 re-scan AFTER the secret-bearing round trips: both credential
  // checks sent the marker key to the real adapter — the scan must cover
  // the server's whole lifetime, not just the create path above.
  for (const line of server.sink.lines()) {
    expect(line, 'the marker key must not appear in server logs').not.toContain(
      ACCEPTANCE_MARKER_KEY,
    );
  }
});
