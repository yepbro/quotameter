import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';

/**
 * The login route's name — the one route name the session layer
 * (`ui/src/session.ts`, task 180) keys its guard and redirect on, kept
 * here so the route table stays the single owner of the vocabulary.
 */
export const LOGIN_ROUTE_NAME = 'login';

/**
 * Route table and router factory for the web UI (spec §14; decision
 * D-131).
 *
 * §14 defines exactly four user-facing pages — the account overview
 * (§14.3–14.4), account management (§14.2), settings (§14.5), and the
 * login screen (§14.6). Every page component is lazy-loaded so code
 * splitting keeps the shell light and the output CSP-shaped (D-127):
 * each view becomes an external hashed chunk under `script-src 'self'`,
 * never an inline payload.
 *
 * The table itself carries no navigation guard: task 180's session
 * handling (§14.6/§15.1) installs its guard through
 * `installSessionRouting` from `ui/src/session.ts`, so the factory
 * stays pure routing and component tests mount it guard-free.
 *
 * The catch-all redirects to the overview: §14 prescribes no not-found
 * screen, so an unknown client path lands where the SPA fallback itself
 * lands (§14.1) — the overview page.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'overview', component: () => import('../views/OverviewView.vue') },
  { path: '/accounts', name: 'accounts', component: () => import('../views/AccountsView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/login', name: LOGIN_ROUTE_NAME, component: () => import('../views/LoginView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

/**
 * Creates the application router. The history is injectable so component
 * tests drive navigation with a memory history while the composition root
 * uses the browser history the server's SPA fallback serves (§14.1).
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({ history, routes });
}
