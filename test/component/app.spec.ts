import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, it } from 'vitest';
import App from '../../ui/src/App.vue';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { createAppRouter } from '../../ui/src/router';
import { createAppTheme } from '../../ui/src/theme';
import { FakeThemeMedia, MemoryThemeStorage } from '../helpers/theme';
import { FakeFetch, jsonResponse, healthyApiBody } from '../helpers/api';

/**
 * The application shell (spec §14.1; decisions D-131, D-132, D-133): the
 * layout the router renders into — the site header with the application
 * title, the primary navigation, and the theme control, and the main
 * landmark carrying the routed view. Each test mounts a fresh router,
 * i18n, theme, and API-client instance (a fake fetch answering a healthy
 * §13 health response, so the views' shared error wiring stays silent —
 * its failure presentation is pinned by `api-error-wiring.spec.ts`) and
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
  const api = createApiClientPlugin({
    fetchImpl: new FakeFetch((call) =>
      Promise.resolve(jsonResponse(200, healthyApiBody(call.input))),
    ).impl,
  });
  // Task 170: the accounts view consumes the selection store; every
  // shell mount installs one (the composition root does the same).
  const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
  const wrapper = mount(App, {
    global: { plugins: [router, createAppI18n(), theme, api, selection] },
  });
  await settleNavigation();
  return wrapper;
}

describe('App shell', () => {
  it('renders the application title in the site header', async () => {
    const wrapper = await mountShell();
    expect(wrapper.find('h1').text()).toBe('Quotameter');
  });

  it('renders the overview page with its no-accounts guidance block (task 173)', async () => {
    const wrapper = await mountShell();
    expect(wrapper.find('h2').text()).toBe('Overview');
    // The healthy empty backend: the no-accounts guidance block with
    // its CTA link — never a blank or broken page.
    expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="overview-empty-cta"]').attributes('href')).toBe('/accounts');
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('navigates with the three primary sections only (login is task 180)', async () => {
    const wrapper = await mountShell();
    const links = wrapper.findAll('nav a');
    expect(links.map((link) => link.text())).toEqual(['Overview', 'Accounts', 'Settings']);
  });

  it.each([
    ['/settings', 'Settings'],
    ['/login', 'Login'],
  ] as const)('direct navigation renders the %s view', async (path, heading) => {
    const wrapper = await mountShell(path);
    expect(wrapper.find('h2').text()).toBe(heading);
    expect(wrapper.find('[data-testid="page-status"]').text()).toBe('Not implemented yet.');
  });

  it('direct navigation renders the accounts view (task 170: real content)', async () => {
    const wrapper = await mountShell('/accounts');
    expect(wrapper.find('h2').text()).toBe('Accounts');
    // The management page's honest empty state against the empty list.
    expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(true);
  });

  it('navigates between sections through the nav links', async () => {
    const wrapper = await mountShell();
    const accountsLink = wrapper.findAll('nav a').at(1);
    expect(accountsLink?.text()).toBe('Accounts');

    await accountsLink?.trigger('click');
    await settleNavigation();

    expect(wrapper.find('h2').text()).toBe('Accounts');
    const active = wrapper.find('nav a[aria-current="page"]');
    expect(active.text()).toBe('Accounts');
  });

  it('renders the theme control with the three modes, system by default', async () => {
    const wrapper = await mountShell();
    const select = wrapper.find('[data-testid="theme-select"]');
    expect(select.exists()).toBe(true);
    // The label is the select's accessible name (label[for] pairing).
    expect(wrapper.find('label[for="theme-select"]').text()).toBe('Theme');
    expect(select.element.value).toBe('system');
    expect(wrapper.findAll('option').map((option) => option.text())).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
  });

  it('selecting a mode applies it live through the data-theme attribute', async () => {
    const wrapper = await mountShell();
    const select = wrapper.find('[data-testid="theme-select"]');

    await select.setValue('dark');
    await settleNavigation();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(select.element.value).toBe('dark');

    await select.setValue('system');
    await settleNavigation();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
