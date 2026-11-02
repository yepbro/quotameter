import { createMemoryHistory } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { createAppRouter, routes } from '../../ui/src/router';

/**
 * Router contract (spec §14; decision D-131): the shell's four pages
 * resolve to their named routes, direct navigation reaches each of them,
 * and unknown paths redirect to the overview — the client half of the
 * SPA fallback the server already serves for every path (§14.1). Runs on
 * a memory history so navigation is exercised without a browser location.
 */
describe('app router', () => {
  it('defines the four shell pages plus the catch-all redirect', () => {
    const paths = routes.map((route) => route.path).sort();
    expect(paths).toEqual(['/', '/:pathMatch(.*)*', '/accounts', '/login', '/settings']);
  });

  it('lazy-loads each page component (external chunks, decision D-131)', () => {
    const pages = routes.filter((route) => route.name !== undefined);
    expect(pages).toHaveLength(4);
    for (const page of pages) {
      // A lazy route carries the dynamic-import function; a statically
      // imported component would be an options object — and the per-view
      // external chunks (the CSP-shaped code splitting) would disappear.
      expect(typeof page.component).toBe('function');
    }
  });

  it('resolves each page path to its named route', () => {
    const router = createAppRouter(createMemoryHistory());
    expect(router.resolve('/').name).toBe('overview');
    expect(router.resolve('/accounts').name).toBe('accounts');
    expect(router.resolve('/settings').name).toBe('settings');
    expect(router.resolve('/login').name).toBe('login');
  });

  it.each([
    ['/', 'overview'],
    ['/accounts', 'accounts'],
    ['/settings', 'settings'],
    ['/login', 'login'],
  ] as const)('direct navigation reaches %s', async (path, name) => {
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    expect(router.currentRoute.value.name).toBe(name);
    expect(router.currentRoute.value.path).toBe(path);
  });

  it('redirects unknown paths to the overview (no not-found page in §14)', async () => {
    const router = createAppRouter(createMemoryHistory());
    await router.push('/no/such/path');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('overview');
    expect(router.currentRoute.value.path).toBe('/');
  });
});
