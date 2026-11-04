/**
 * The client-side session state and its routing (task 180, spec §14.6,
 * §15.1, §15.2; decision D-159).
 *
 * **The cookie is the session's only truth** (§15.2): the server judges
 * every request by it, and this store is deliberately nothing more than
 * a reactive cache of what the wire last said about it — a tri-state
 * that never guesses:
 *
 * - `'unknown'` — no signal this SPA lifetime (a fresh load, or after
 *   sign-out). Optimistic by design: protected pages render and load,
 *   and if the deployment requires a password the loads' own 401s flip
 *   the state (the interception below). In `auto`-loopback (§15.1's
 *   default) no 401 ever arrives, nothing forces `/login`, and the
 *   login page stays reachable by URL — §14.6/§15.1's mode semantics
 *   without the UI knowing the mode.
 * - `'authenticated'` — a login succeeded in this SPA lifetime.
 * - `'unauthenticated'` — the wire answered the §13 envelope's
 *   `UNAUTHENTICATED` code. The state is in-memory only (never
 *   persisted): a reload honestly restarts at `'unknown'` while the
 *   cookie keeps riding every request.
 *
 * A factory + plugin + inject, exactly the router (D-131), i18n
 * (D-132), theme (D-133), and account selection (D-135) shape: the
 * composition root installs the real controller, component tests their
 * own per mount.
 */

import { inject, ref, watch, type App, type InjectionKey, type Ref } from 'vue';
import type { NavigationGuard, Router } from 'vue-router';
import { LOGIN_ROUTE_NAME } from './router';

/** What the client knows about the session right now (see the header). */
export type SessionState = 'unknown' | 'authenticated' | 'unauthenticated';

/** The session controller as an installable plugin (the `useTheme` precedent). */
export interface SessionController {
  /** Vue plugin installation — provides the controller to the app. */
  install(app: App): void;
  /** The reactive session knowledge; flips only through the actions below. */
  readonly state: Ref<SessionState>;
  /** The wire answered `UNAUTHENTICATED` — idempotent. */
  markUnauthenticated(): void;
  /** A login succeeded and the cookie is set — idempotent. */
  markAuthenticated(): void;
  /** A logout succeeded; back to knowing nothing (`'unknown'`). */
  signOut(): void;
}

const sessionInjectionKey: InjectionKey<SessionController> = Symbol('quotameter-session');

/** Creates the session controller (per app; no module singleton). */
export function createSession(): SessionController {
  const state = ref<SessionState>('unknown');
  return {
    install(app: App): void {
      app.provide(sessionInjectionKey, this);
    },
    state,
    markUnauthenticated(): void {
      state.value = 'unauthenticated';
    },
    markAuthenticated(): void {
      state.value = 'authenticated';
    },
    signOut(): void {
      // Not 'unauthenticated': in `auto`-loopback the overview keeps
      // working after a sign-out, and the next wire answer — not this
      // store — says which world we are in.
      state.value = 'unknown';
    },
  };
}

/** The installed controller; throws with its remedy when the plugin is missing. */
export function useSession(): SessionController {
  const session = inject(sessionInjectionKey);
  if (session === undefined) {
    throw new Error('useSession() requires the session plugin (createSession()) to be installed');
  }
  return session;
}

/**
 * Where an unauthenticated visitor lands after signing in: the
 * preserved destination when it is a safe in-app path, else `/`.
 *
 * The `redirect` query is attacker-influenceable like any URL input, so
 * only a same-origin SPA path passes: it must start with `/` and must
 * not start with `//` (the protocol-relative form — the open-redirect
 * escape) nor contain a backslash (browsers normalize `\` to `/` in
 * paths, making `/\host` the same escape). Anything that resolves onto
 * the login route itself — `/login`, `/login/`, `/login?…`, `/login#…`,
 * any casing — collapses to `/`: returning to the form that just
 * succeeded would loop the guard's bounce below. Unknown paths pass
 * verbatim — the router's catch-all sends them to `/` (§14 prescribes
 * no not-found screen).
 */
export function loginReturnTarget(redirect: unknown): string {
  if (typeof redirect !== 'string') return '/';
  if (!redirect.startsWith('/') || redirect.startsWith('//')) return '/';
  if (redirect.includes('\\')) return '/';
  if (/^\/login(?:[/?#]|$)/iu.test(redirect)) return '/';
  return redirect;
}

/** The subset of the controller the guard and watcher read. */
type SessionReader = { readonly state: Ref<SessionState> };

/**
 * The navigation guard: enforce — without a new API round trip — what
 * the wire already said. `'unknown'` allows everything (optimistic);
 * `'unauthenticated'` sends protected targets to the login page with
 * the destination preserved; an authenticated visit to `/login` bounces
 * to the preserved destination (or `/`) — the form has nothing to offer
 * a session that just proved itself. The bounce returns the target as a
 * STRING location: vue-router parses query and hash out of string
 * locations but silently drops them from a `{ path }` object, and a
 * preserved destination may carry either.
 */
export function createSessionGuard(session: SessionReader): NavigationGuard {
  return (to) => {
    if (to.name === LOGIN_ROUTE_NAME) {
      if (session.state.value === 'authenticated') {
        return loginReturnTarget(to.query.redirect);
      }
      return true;
    }
    if (session.state.value === 'unauthenticated') {
      return { name: LOGIN_ROUTE_NAME, query: { redirect: to.fullPath } };
    }
    return true;
  };
}

/**
 * Wires the session into the router — the composition root's one call:
 * the guard above, plus the reactive redirect for the flip the wire
 * drives (a protected page's load answered 401 while the page already
 * rendered). The watcher pushes `/login` with the CURRENT route
 * preserved as the destination, and never from the login route itself —
 * a flip arriving while the form is up (the review round's exemption
 * keeps the login arm's own 401s out of the signal entirely, but a
 * protected page's late 401 can land during the interlude) must not
 * re-navigate onto the page that owns it. The push is idempotent in
 * effect: a repeated flip of the same value does not re-fire the
 * watcher, and the guard's redirect keeps the query stable.
 */
export function installSessionRouting(router: Router, session: SessionController): void {
  router.beforeEach(createSessionGuard(session));
  watch(session.state, (state) => {
    if (state !== 'unauthenticated') return;
    const current = router.currentRoute.value;
    if (current.name === LOGIN_ROUTE_NAME) return;
    void router.push({ name: LOGIN_ROUTE_NAME, query: { redirect: current.fullPath } });
  });
}
