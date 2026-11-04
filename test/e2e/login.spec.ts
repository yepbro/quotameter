import { expect, test, type Route } from '@playwright/test';
import { healthyApiBody } from '../helpers/api';

/**
 * The login/logout flows in a real browser (task 180, spec §14.6, §15.2;
 * decision D-159): the redirect round trip (a protected page's 401 → the
 * login page with the destination preserved → sign-in → back), the two
 * distinguishable §15.2 arms the wire exposes (D-146's
 * `invalid-credentials` and `source-busy` reasons), and the sign-out
 * invalidation (logout → the next protected load redirects). The preview
 * server has no API behind it (the suite's standing shape), so the wire
 * is produced by route interception — the D-138 technique — with the
 * §13 envelope's 401 shape standing in for the password-requiring
 * deployment the real server would be.
 */

/** The §13 envelope's unauthenticated answer. */
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

test('a protected page whose load is refused redirects to login and back (the round trip)', async ({
  page,
}) => {
  // Before the sign-in: every GET answers the 401 envelope; after it:
  // healthy bodies. The login POST itself is answered by its own arm.
  let signedIn = false;
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/auth/login') {
      signedIn = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session: { expiresAt: Date.now() + 86_400_000 } }),
      });
    }
    return route.fulfill(signedIn ? healthy(route) : unauthenticated());
  });

  await page.goto('/settings');
  // The 401-driven redirect preserved the destination (vue-router leaves
  // `/` unencoded in query values, so the bar reads it verbatim).
  await expect(page).toHaveURL(/\/login\?redirect=\/settings$/);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible();

  await page.getByTestId('login-password').fill('a-correct-password');
  await page.getByTestId('login-submit').click();
  // The session cookie is the server's business; the UI's proof is the
  // return: the destination renders its real content.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(page.getByTestId('settings-general')).toBeVisible();
  await expect(page.getByTestId('api-error')).toHaveCount(0);
});

test('the wrong-password arm renders its own sentence and stays on the form', async ({ page }) => {
  await page.route('**/api/auth/**', (route) =>
    route.fulfill(unauthenticated('invalid-credentials')),
  );
  await page.goto('/login');
  await page.getByTestId('login-password').fill('a-wrong-candidate');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-failure')).toHaveText('That password is incorrect.');
  await expect(page).toHaveURL(/\/login$/);
});

test('the source-busy arm renders its own sentence (D-146)', async ({ page }) => {
  await page.route('**/api/auth/**', (route) => route.fulfill(unauthenticated('source-busy')));
  await page.goto('/login');
  await page.getByTestId('login-password').fill('a-concurrent-candidate');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-failure')).toContainText(
    'Another sign-in attempt from your address is still in progress',
  );
  await expect(page).toHaveURL(/\/login$/);
});

test('signing out invalidates the session: the next protected load redirects to login', async ({
  page,
}) => {
  let signedIn = true;
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/auth/logout') {
      signedIn = false;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ revoked: true }),
      });
    }
    return route.fulfill(signedIn ? healthy(route) : unauthenticated());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
  await page.getByTestId('session-signout').click();

  // The sign-out's own landing: the overview, until its next load says
  // the session is gone — then the redirect, with `/` preserved.
  await expect(page).toHaveURL(/\/login\?redirect=\/$/);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible();
});
