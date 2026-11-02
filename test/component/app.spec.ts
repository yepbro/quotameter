import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, it } from 'vitest';
import App from '../../ui/src/App.vue';
import { createAppRouter } from '../../ui/src/router';

/**
 * The application shell (spec §14.1; decision D-131): the layout the
 * router renders into — the site header with the application title and
 * the primary navigation, and the main landmark carrying the routed view.
 * Each test mounts a fresh router and starts it at the given path (direct
 * navigation), so no state leaks between cases.
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
  const wrapper = mount(App, { global: { plugins: [router] } });
  await settleNavigation();
  return wrapper;
}

describe('App shell', () => {
  it('renders the application title in the site header', async () => {
    const wrapper = await mountShell();
    expect(wrapper.find('h1').text()).toBe('Quotameter');
  });

  it('shows the implementation status placeholder on the overview', async () => {
    const wrapper = await mountShell();
    expect(wrapper.find('[data-testid="app-status"]').text()).toContain('not implemented yet');
  });

  it('navigates with the three primary sections only (login is task 180)', async () => {
    const wrapper = await mountShell();
    const links = wrapper.findAll('nav a');
    expect(links.map((link) => link.text())).toEqual(['Overview', 'Accounts', 'Settings']);
  });

  it.each([
    ['/accounts', 'Accounts'],
    ['/settings', 'Settings'],
    ['/login', 'Login'],
  ] as const)('direct navigation renders the %s view', async (path, heading) => {
    const wrapper = await mountShell(path);
    expect(wrapper.find('h2').text()).toBe(heading);
    expect(wrapper.find('[data-testid="page-status"]').text()).toBe('Not implemented yet.');
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
});
