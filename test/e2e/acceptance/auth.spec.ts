import { expect, test, type Page } from '@playwright/test';
import {
  ACCEPTANCE_PASSWORD,
  seedSuccessCycle,
  seededMetric,
  startAcceptanceServer,
  type AcceptanceServer,
} from '../helpers/acceptance';
import { hashPassword } from '../../../src/services/password-hash';
import { SESSION_COOKIE_NAME } from '../../../src/services/session-cookie';

/**
 * The §17.1 login/logout acceptance scenario (spec §14.6, §15.1, §15.2)
 * against the served construction with REAL authentication: `auth.mode:
 * required` plus a genuine §15.2 scrypt password hash in the configuration
 * file. The round trip runs over the real wire the preview-suite login
 * spec could only intercept: the 401-driven redirect preserving a non-root
 * destination (the fallback destination is `/` too, so only a deep link
 * proves preservation), the wrong-password sentence from the real §15.2
 * check, the real session cookie (HttpOnly, SameSite=Strict, path-scoped
 * to `/api`) set by the real login endpoint, the authenticated surface
 * over the real stores, and the sign-out's SERVER-SIDE revocation — the
 * minted token, re-injected after the sign-out, must answer 401 (a
 * logout that only cleared the cookie would pass everything else).
 *
 * The §15.2 rate limit budgets five failed attempts per source address per
 * 15 minutes; this scenario spends exactly one (delays apply past the
 * budget, so staying far under it keeps the run deterministic).
 */

let server: AcceptanceServer;

test.beforeAll(async () => {
  const passwordHash = await hashPassword(ACCEPTANCE_PASSWORD);
  server = await startAcceptanceServer({
    config: {
      app: { timezone: 'UTC' },
      auth: { mode: 'required', passwordHash },
      accounts: [
        {
          id: 'guarded',
          providerId: 'zai-coding-plan',
          label: 'Guarded account',
          apiKey: 'sk-dummy-guarded',
        },
      ],
    },
  });
  seedSuccessCycle(server.repository, 'guarded', Date.now() - 240_000, [
    seededMetric('mcp-monthly'),
  ]);
});

test.afterAll(async () => {
  await server.stop();
});

test.describe.configure({ mode: 'serial' });

/** One session-cookie fact of the browser's jar, as Playwright reports it. */
interface SessionCookieFact {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: string;
}

/** The session cookies of the guarded server's API in the page's jar. */
async function sessionCookiesOf(page: Page): Promise<readonly SessionCookieFact[]> {
  // Playwright's cookies() filters by URL, path-matching included — the
  // session cookie is deliberately scoped to `/api` (only the API needs
  // it), so the query URL names that path; the name filter stays here
  // (cookie names are not URL-shaped).
  const cookies = await page.context().cookies(`${server.baseUrl}/api`);
  return cookies.filter((cookie) => cookie.name === SESSION_COOKIE_NAME);
}

test('an unauthenticated deep link lands on the login page with the destination kept', async ({
  page,
}) => {
  // A non-root destination: `/` is also the login fallback target, so
  // only a deep link proves the redirect PRESERVED anything.
  await page.goto(`${server.baseUrl}/settings`);

  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings$|\/login\?redirect=\/settings$/);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible();
  await expect(page.getByTestId('login-password')).toBeVisible();
  await expect(page.getByTestId('login-password')).toHaveAttribute('type', 'password');
  // §15.2's budget is stated up front on the form.
  await expect(page.getByTestId('login-form')).toContainText('deliberately slows each sign-in');
});

test('the wrong password states its sentence and stays on the form', async ({ page }) => {
  await page.goto(`${server.baseUrl}/login`);
  await page.getByTestId('login-password').fill('a-wrong-candidate-password');
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-failure')).toHaveText('That password is incorrect.');
  await expect(page).toHaveURL(/\/login$/);
  // No session was minted for the wrong password.
  expect(await sessionCookiesOf(page)).toHaveLength(0);
});

test('the correct password returns to the preserved deep link and sets the real cookie', async ({
  page,
}) => {
  // The same deep-link shape as the first test: after the sign-in the
  // destination — not the fallback root — must render.
  await page.goto(`${server.baseUrl}/settings`);
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings$|\/login\?redirect=\/settings$/);
  await page.getByTestId('login-password').fill(ACCEPTANCE_PASSWORD);
  await page.getByTestId('login-submit').click();

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(page.getByTestId('settings-general')).toBeVisible();

  // §15.2's cookie contract, read from the browser's own jar: HttpOnly,
  // SameSite=Strict, scoped to `/api`, and NOT Secure over this plain-
  // HTTP loopback world (a Secure cookie would not even be stored).
  const session = await sessionCookiesOf(page);
  expect(session).toHaveLength(1);
  expect(session[0]!.httpOnly).toBe(true);
  expect(session[0]!.sameSite).toBe('Strict');
  expect(session[0]!.path).toBe('/api');
  expect(session[0]!.secure).toBe(false);
});

test('signing out revokes the session server-side: the old token is dead', async ({ page }) => {
  // Sign in first — the previous test's cookie belongs to its own context.
  await page.goto(`${server.baseUrl}/login`);
  await page.getByTestId('login-password').fill(ACCEPTANCE_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
  const minted = (await sessionCookiesOf(page))[0]!;

  await page.getByTestId('session-signout').click();
  // The sign-out's own landing stays the overview until its next load
  // answers 401 — then the redirect, with `/` preserved (D-159).
  await expect(page).toHaveURL(/\/login\?redirect=%2F$|\/login\?redirect=\/$/);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible();
  // The cookie is gone from the browser's jar.
  expect(await sessionCookiesOf(page)).toHaveLength(0);

  // The REVOCATION, not just the clearing: the minted token re-injected
  // as a cookie must answer 401 — a logout that only cleared the cookie
  // would leave this request authenticated.
  await page.context().addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: minted.value,
      url: server.baseUrl,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const replay = await page.request.get(`${server.baseUrl}/api/status`);
  expect(replay.status()).toBe(401);
  // Leave the jar clean of the dead token.
  await page.context().clearCookies({ name: SESSION_COOKIE_NAME });
});
