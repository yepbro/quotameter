import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import App from '../../ui/src/App.vue';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { createAppRouter } from '../../ui/src/router';
import { createSession } from '../../ui/src/session';
import { createAppTheme } from '../../ui/src/theme';
import { en } from '../../ui/src/i18n/en';
import { FakeThemeMedia, MemoryThemeStorage } from '../helpers/theme';
import { FakeFetch, jsonResponse, healthyApiBody } from '../helpers/api';

/**
 * The application shell (spec §14.1; decisions D-131, D-132, D-133):
 * the layout the router renders into — the site header with the
 * application title, the primary navigation, the theme control, and
 * (task 180) the §14.6 sign-out control; the main landmark carries the
 * routed view. Each test mounts a fresh router, i18n, theme, session,
 * and API-client instance (a fake fetch answering a healthy §13 body
 * per route, so the views' shared error wiring stays silent — its
 * failure presentation is pinned by `api-error-wiring.spec.ts`) and
 * starts it at the given path (direct navigation), so no state leaks
 * between cases. The rendered-string assertions run the whole catalog →
 * `t()` → render pipeline, not just static markup.
 */

/**
 * Vue Router's navigation settles across micro- AND macrotask hops (an
 * await inside its navigation chain): after a DOM-driven navigation,
 * microtask flushing alone leaves the push pending under happy-dom. One
 * short timer hop lets the queue drain; the browser never needs this
 * (the e2e suite drives the same flows without waits).
 */
async function settleNavigation(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
}

async function mountShell(initial: string = '/') {
  const router = createAppRouter(createMemoryHistory());
  // The memory history starts at the root regardless of its base
  // argument, so the initial route is pushed before mounting.
  await router.push(initial);
  await router.isReady();
  const theme = createAppTheme({
    storage: new MemoryThemeStorage(),
    media: new FakeThemeMedia(),
  });
  const session = createSession();
  const fake = new FakeFetch((call) =>
    Promise.resolve(jsonResponse(200, healthyApiBody(call.input))),
  );
  const api = createApiClientPlugin({ fetchImpl: fake.impl });
  // Task 170: the accounts view consumes the selection store; task 180:
  // the shell's sign-out consumes the session store; every shell mount
  // installs both (the composition root does the same).
  const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
  const wrapper = mount(App, {
    global: { plugins: [router, createAppI18n(), theme, api, selection, session] },
  });
  await settleNavigation();
  return { wrapper, router, session, fake };
}

describe('App shell', () => {
  // Shell mounts carry the full overview pipeline (charts seam included,
  // task 177) — the D-087/D-094 lesson from 177's landing: the default
  // 5 s budget flakes under parallel-worktree load. 30 s house value.
  it('renders the application title in the site header', { timeout: 30_000 }, async () => {
    const { wrapper } = await mountShell();
    expect(wrapper.find('h1').text()).toBe('Quotameter');
  });

  it(
    'renders the overview page with its no-accounts guidance block (task 173)',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell();
      expect(wrapper.find('h2').text()).toBe('Overview');
      // The healthy empty backend: the no-accounts guidance block with
      // its CTA link — never a blank or broken page.
      expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="overview-empty-cta"]').attributes('href')).toBe(
        '/accounts',
      );
      expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    },
  );

  it(
    'navigates with the three primary sections only (no login nav entry — §14.6 asks for a page)',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell();
      const links = wrapper.findAll('nav a');
      expect(links.map((link) => link.text())).toEqual(['Overview', 'Accounts', 'Settings']);
    },
  );

  it(
    'direct navigation renders the settings view (task 179: real content)',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell('/settings');
      expect(wrapper.find('h2').text()).toBe('Settings');
      // The settings page's real surface against the healthy backend:
      // the general form beside the facts (the providers listing answers
      // the registry-empty build, so the schedule states that honestly).
      expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="settings-facts"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="settings-schedule-none"]').exists()).toBe(true);
    },
  );

  it(
    'direct navigation renders the /login view (task 180: the real form)',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell('/login');
      expect(wrapper.find('h2').text()).toBe('Sign in');
      // The mode-agnostic password form, first paint with no request.
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true);
      expect(wrapper.find('label[for="login-password"]').text()).toBe('Password');
      // The sign-out control is hidden on the login route (the review
      // round's P3-4): an authenticated visitor never sits here, so
      // the control would be noise about an unproven session.
      expect(wrapper.find('[data-testid="session-signout"]').exists()).toBe(false);
    },
  );

  it(
    'direct navigation renders the accounts view (task 170: real content)',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell('/accounts');
      expect(wrapper.find('h2').text()).toBe('Accounts');
      // The management page's honest empty state against the empty list.
      expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(true);
    },
  );

  it('navigates between sections through the nav links', { timeout: 30_000 }, async () => {
    const { wrapper } = await mountShell();
    const accountsLink = wrapper.findAll('nav a').at(1);
    expect(accountsLink?.text()).toBe('Accounts');

    await accountsLink?.trigger('click');
    await settleNavigation();

    expect(wrapper.find('h2').text()).toBe('Accounts');
    const active = wrapper.find('nav a[aria-current="page"]');
    expect(active.text()).toBe('Accounts');
  });

  it(
    'renders the theme control with the three modes, system by default',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell();
      const select = wrapper.find('[data-testid="theme-select"]');
      expect(select.exists()).toBe(true);
      // The label is the select's accessible name (label[for] pairing).
      expect(wrapper.find('label[for="theme-select"]').text()).toBe('Theme');
      expect((select.element as HTMLSelectElement).value).toBe('system');
      expect(wrapper.findAll('option').map((option) => option.text())).toEqual([
        'System',
        'Light',
        'Dark',
      ]);
    },
  );

  it(
    'selecting a mode applies it live through the data-theme attribute',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell();
      const select = wrapper.find('[data-testid="theme-select"]');

      await select.setValue('dark');
      await settleNavigation();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect((select.element as HTMLSelectElement).value).toBe('dark');

      await select.setValue('system');
      await settleNavigation();
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    },
  );

  // The §14.6 session control (task 180, D-159).
  it(
    'renders the sign-out control from the unknown session state',
    { timeout: 30_000 },
    async () => {
      const { wrapper } = await mountShell();
      const button = wrapper.find('[data-testid="session-signout"]');
      expect(button.exists()).toBe(true);
      expect(button.text()).toBe('Sign out');
    },
  );

  it(
    'sign-out POSTs /api/auth/logout and reloads the document to /',
    { timeout: 30_000 },
    async () => {
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      const { wrapper, fake, session } = await mountShell('/settings');
      await wrapper.find('[data-testid="session-signout"]').trigger('click');
      await settleNavigation();
      // The wire pin: the bodiless §15.3 POST to the logout endpoint (the
      // healthy-body fallback satisfies the trusted cast's shape).
      const logout = fake.calls.find((call) => call.input === '/api/auth/logout');
      expect(logout).toBeDefined();
      expect(logout?.method).toBe('POST');
      expect(logout?.body).toBeUndefined();
      // The post-sign-out routing is a DOCUMENT reload, not a router push
      // (a same-route push would be deduped — no remount, no fresh loads,
      // no 401 to drive the redirect under `required`): the SPA restarts
      // honestly at 'unknown' and the next wire answers decide the world.
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('/');
      expect(session.state.value).toBe('unknown');
      assign.mockRestore();
    },
  );

  it(
    'locks and re-labels the sign-out control while the request is pending — no re-entry (task 182)',
    { timeout: 30_000 },
    async () => {
      // The §14.1 pending-state pin: the control states its in-flight
      // state as text and refuses a second dispatch while the logout is
      // unanswered (the handler's pending guard — a double sign-out is a
      // double document reload in the making).
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
      let releaseLogout!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseLogout = resolve;
      });
      const stalling = new FakeFetch((call) =>
        call.input === '/api/auth/logout'
          ? gate.then(() => jsonResponse(200, { revoked: true }))
          : Promise.resolve(jsonResponse(200, healthyApiBody(call.input))),
      );
      const router = createAppRouter(createMemoryHistory());
      await router.push('/settings');
      await router.isReady();
      const wrapper = mount(App, {
        global: {
          plugins: [
            router,
            createAppI18n(),
            createAppTheme({ storage: new MemoryThemeStorage(), media: new FakeThemeMedia() }),
            createApiClientPlugin({ fetchImpl: stalling.impl }),
            createAccountSelection({ storage: new MemoryThemeStorage() }),
            createSession(),
          ],
        },
      });
      await settleNavigation();
      try {
        const button = wrapper.find('[data-testid="session-signout"]');
        await button.trigger('click');
        await settleNavigation();

        expect(
          (button.element as HTMLButtonElement).disabled,
          'the control locks while pending',
        ).toBe(true);
        expect(button.text()).toBe(en.app.session.signOutPending);

        // A second click during the pending window dispatches nothing.
        await button.trigger('click');
        await settleNavigation();
        expect(stalling.calls.filter((call) => call.input === '/api/auth/logout')).toHaveLength(1);

        releaseLogout();
        await settleNavigation();
        expect(stalling.calls.filter((call) => call.input === '/api/auth/logout')).toHaveLength(1);
        expect(assign).toHaveBeenCalledTimes(1);
        expect(assign).toHaveBeenCalledWith('/');
      } finally {
        assign.mockRestore();
      }
    },
  );

  it(
    'hides the sign-out control once the wire says unauthenticated',
    { timeout: 30_000 },
    async () => {
      const { wrapper, session } = await mountShell();
      expect(wrapper.find('[data-testid="session-signout"]').exists()).toBe(true);
      session.markUnauthenticated();
      await settleNavigation();
      expect(wrapper.find('[data-testid="session-signout"]').exists()).toBe(false);
    },
  );

  it(
    'a failed sign-out notice clears on the next completed navigation (P3-3)',
    { timeout: 30_000 },
    async () => {
      // The service dies for the logout alone (not a 401 — that arm
      // redirects instead): the shared notice renders in the shell,
      // which persists across routes.
      const flaky = new FakeFetch((call) =>
        call.input === '/api/auth/logout'
          ? Promise.reject(new Error('Failed to fetch'))
          : Promise.resolve(jsonResponse(200, healthyApiBody(call.input))),
      );
      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();
      const wrapper = mount(App, {
        global: {
          plugins: [
            router,
            createAppI18n(),
            createAppTheme({ storage: new MemoryThemeStorage(), media: new FakeThemeMedia() }),
            createApiClientPlugin({ fetchImpl: flaky.impl }),
            createAccountSelection({ storage: new MemoryThemeStorage() }),
            createSession(),
          ],
        },
      });
      await settleNavigation();
      await wrapper.find('[data-testid="session-signout"]').trigger('click');
      await settleNavigation();
      expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(true);
      // The user abandons the interaction and navigates: the notice
      // belongs to the sign-out attempt, not to the destination (the
      // review round's P3-3 — without the reset a stale "unreachable"
      // line would ride along until the next sign-out attempt).
      await router.push('/settings');
      await settleNavigation();
      expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    },
  );
});
