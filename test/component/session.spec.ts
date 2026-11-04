import { flushPromises } from '@vue/test-utils';
import { createMemoryHistory, type RouteLocationNormalizedGeneric } from 'vue-router';
import { createApp, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import {
  createSession,
  createSessionGuard,
  installSessionRouting,
  loginReturnTarget,
  useSession,
} from '../../ui/src/session';
import { createAppRouter, LOGIN_ROUTE_NAME } from '../../ui/src/router';

/**
 * The session layer (task 180, spec §14.6/§15.1; decision D-159): the
 * tri-state store, the destination validator, the navigation guard, and
 * the reactive redirect — the client's whole auth-state handling minus
 * the wire (the client's own `onUnauthenticated` firing is pinned in
 * `api-client.spec.ts`, the composed round trip in
 * `login-view.spec.ts` and the e2e login suite).
 */

/** A minimal normalized route for direct guard calls. */
function toRoute(
  name: string | symbol | undefined,
  extra: Partial<RouteLocationNormalizedGeneric> = {},
): RouteLocationNormalizedGeneric {
  return {
    name,
    fullPath: '/',
    path: '/',
    query: {},
    hash: '',
    params: {},
    matched: [],
    meta: {},
    redirectedFrom: undefined,
    ...extra,
  } as RouteLocationNormalizedGeneric;
}

describe('the session store', () => {
  it('starts unknown — no signal guesses', () => {
    const session = createSession();
    expect(session.state.value).toBe('unknown');
  });

  it('the three marks flip the state and are idempotent', () => {
    const session = createSession();
    session.markUnauthenticated();
    expect(session.state.value).toBe('unauthenticated');
    session.markUnauthenticated();
    expect(session.state.value).toBe('unauthenticated');
    session.markAuthenticated();
    expect(session.state.value).toBe('authenticated');
    session.signOut();
    expect(session.state.value).toBe('unknown');
  });

  it('provides itself through the plugin; useSession throws with its remedy when missing', () => {
    const session = createSession();
    const app = createApp({
      setup() {
        expect(useSession()).toBe(session);
      },
      render: () => null,
    });
    app.use(session);
    app.mount(document.createElement('div'));
    app.unmount();

    const bare = createApp({
      setup() {
        expect(() => useSession()).toThrow(/createSession\(\)/su);
      },
      render: () => null,
    });
    bare.mount(document.createElement('div'));
    bare.unmount();
  });
});

describe('loginReturnTarget (the preserved destination)', () => {
  it.each([
    ['/settings', '/settings'],
    ['/', '/'],
    ['/accounts?selected=acc-1', '/accounts?selected=acc-1'],
    ['/no/such/path', '/no/such/path'],
  ])('passes the in-app path %s verbatim', (redirect, expected) => {
    expect(loginReturnTarget(redirect)).toBe(expected);
  });

  it.each([
    ['non-string values', undefined],
    ['non-string values', 42],
    ['non-string values', null],
    ['non-string values', ['/settings']],
    ['the empty string', ''],
    ['an absolute foreign URL', 'https://evil.example/quotameter'],
    ['a relative path', 'settings'],
    ['the protocol-relative escape', '//evil.example'],
    ['// with a path', '//evil.example/settings'],
  ])('rejects %s (%j) to the overview', (_kind, redirect) => {
    expect(loginReturnTarget(redirect)).toBe('/');
  });

  it.each([
    ['the login path itself', '/login'],
    ['login with a query', '/login?redirect=/settings'],
    ['login with a hash', '/login#fragment'],
    ['login with a trailing slash', '/login/'],
    ['login in upper case', '/LOGIN'],
    ['the backslash form of the protocol-relative escape', '/\\evil.example'],
  ])('collapses %s (%s) to the overview — returning would loop the guard', (_kind, redirect) => {
    expect(loginReturnTarget(redirect)).toBe('/');
  });
});

describe('createSessionGuard', () => {
  it('unknown allows everything — the optimistic default', () => {
    const guard = createSessionGuard(createSession());
    expect(
      guard(toRoute('settings', { fullPath: '/settings' }), toRoute(undefined), () => undefined),
    ).toBe(true);
    expect(guard(toRoute(LOGIN_ROUTE_NAME), toRoute(undefined), () => undefined)).toBe(true);
  });

  it('unauthenticated sends protected targets to login with the destination preserved', () => {
    const session = createSession();
    session.markUnauthenticated();
    const guard = createSessionGuard(session);
    expect(
      guard(
        toRoute('settings', { path: '/settings', fullPath: '/settings?tab=general' }),
        toRoute(undefined),
        () => undefined,
      ),
    ).toEqual({ name: LOGIN_ROUTE_NAME, query: { redirect: '/settings?tab=general' } });
  });

  it('unauthenticated stays on the login page (the form lives there)', () => {
    const session = createSession();
    session.markUnauthenticated();
    const guard = createSessionGuard(session);
    expect(guard(toRoute(LOGIN_ROUTE_NAME), toRoute(undefined), () => undefined)).toBe(true);
  });

  it('authenticated visits to login bounce to the preserved destination', () => {
    const session = createSession();
    session.markAuthenticated();
    const guard = createSessionGuard(session);
    // A STRING location (the review round's P2-1): vue-router parses
    // query and hash out of string locations but drops them from a
    // `{ path }` object — the preserved destination may carry either.
    expect(
      guard(
        toRoute(LOGIN_ROUTE_NAME, { query: { redirect: '/accounts' } }),
        toRoute(undefined),
        () => undefined,
      ),
    ).toBe('/accounts');
    expect(
      guard(
        toRoute(LOGIN_ROUTE_NAME, { query: { redirect: '/accounts?selected=acc-1' } }),
        toRoute(undefined),
        () => undefined,
      ),
    ).toBe('/accounts?selected=acc-1');
    expect(
      guard(
        toRoute(LOGIN_ROUTE_NAME, { query: { redirect: '/settings#retention' } }),
        toRoute(undefined),
        () => undefined,
      ),
    ).toBe('/settings#retention');
  });

  it('authenticated visits to login without a destination bounce to the overview', () => {
    const session = createSession();
    session.markAuthenticated();
    const guard = createSessionGuard(session);
    expect(guard(toRoute(LOGIN_ROUTE_NAME), toRoute(undefined), () => undefined)).toBe('/');
  });

  it('authenticated allows protected targets', () => {
    const session = createSession();
    session.markAuthenticated();
    const guard = createSessionGuard(session);
    expect(
      guard(toRoute('settings', { fullPath: '/settings' }), toRoute(undefined), () => undefined),
    ).toBe(true);
  });
});

describe('installSessionRouting (the reactive redirect)', () => {
  // The rigged mounts lazy-load the target view's chunk (the overview
  // pulls the charts seam — the D-087/D-094 lesson from 177's landing:
  // the default 5 s budget flakes under parallel-worktree load). The
  // 30 s house value.
  /** A ready memory router with the session routing installed. */
  async function rigged(initial: string) {
    const router = createAppRouter(createMemoryHistory());
    await router.push(initial);
    await router.isReady();
    const session = createSession();
    installSessionRouting(router, session);
    return { router, session };
  }

  /**
   * Polls a router predicate to truth inside the 30 s house budget —
   * the watcher-driven navigation mounts the target view's lazy chunk,
   * and a fixed macrotask hop cannot bound a cold transform (the
   * review round's P3-6).
   */
  async function waitForRoute(
    router: ReturnType<typeof createAppRouter>,
    predicate: (route: {
      readonly name: unknown;
      readonly fullPath: string;
      readonly query: Record<string, unknown>;
    }) => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      if (predicate(router.currentRoute.value)) return;
      await nextTick();
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(predicate(router.currentRoute.value), 'the watcher-driven navigation settled').toBe(
      true,
    );
  }

  /** Lets a no-op assert itself: drains the microtask and timer queues. */
  async function settle(): Promise<void> {
    await nextTick();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPromises();
  }

  it(
    'a flip off a protected page lands on login with the page preserved',
    { timeout: 30_000 },
    async () => {
      const { router, session } = await rigged('/settings');
      session.markUnauthenticated();
      await waitForRoute(router, (route) => route.name === LOGIN_ROUTE_NAME);
      expect(router.currentRoute.value.query.redirect).toBe('/settings');
    },
  );

  it(
    'a flip while already on login does not navigate (the form owns its 401s)',
    { timeout: 30_000 },
    async () => {
      const { router, session } = await rigged('/login');
      const pushes: string[] = [];
      router.afterEach((to) => pushes.push(to.fullPath));
      session.markUnauthenticated();
      await settle();
      expect(pushes).toEqual([]);
      expect(router.currentRoute.value.name).toBe(LOGIN_ROUTE_NAME);
    },
  );

  it(
    'the guard holds while the state stays unauthenticated: navigation to a protected page bounces back',
    { timeout: 30_000 },
    async () => {
      const { router, session } = await rigged('/');
      session.markUnauthenticated();
      await waitForRoute(router, (route) => route.name === LOGIN_ROUTE_NAME);
      expect(router.currentRoute.value.query.redirect).toBe('/');
      // An in-app click towards a protected page while signed out: the
      // guard answers with the login redirect — no API round trip, no
      // flash of the protected page.
      await router.push('/accounts');
      await waitForRoute(
        router,
        (route) => route.name === LOGIN_ROUTE_NAME && route.query.redirect === '/accounts',
      );
    },
  );

  it(
    'signing in again releases the guard: the bounce follows the destination',
    { timeout: 30_000 },
    async () => {
      const { router, session } = await rigged('/settings');
      session.markUnauthenticated();
      await waitForRoute(router, (route) => route.name === LOGIN_ROUTE_NAME);
      session.markAuthenticated();
      await router.push(String(router.currentRoute.value.query.redirect ?? '/'));
      await waitForRoute(router, (route) => route.fullPath === '/settings');
    },
  );

  it('a repeated flip of the same value does not re-push', { timeout: 30_000 }, async () => {
    const { router, session } = await rigged('/accounts');
    session.markUnauthenticated();
    await waitForRoute(router, (route) => route.name === LOGIN_ROUTE_NAME);
    const pushes: string[] = [];
    router.afterEach((to) => pushes.push(to.fullPath));
    session.markUnauthenticated();
    await settle();
    expect(pushes).toEqual([]);
  });
});
