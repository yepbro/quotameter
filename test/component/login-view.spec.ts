import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, it } from 'vitest';
import LoginView from '../../ui/src/views/LoginView.vue';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { createAppRouter } from '../../ui/src/router';
import { createSession } from '../../ui/src/session';
import { en } from '../../ui/src/i18n/en';
import { FakeFetch, jsonResponse, networkFailure, neverRespond } from '../helpers/api';

/**
 * The login form (task 180, spec §14.6/§15.2; decision D-159): the
 * wire pins (exact method/URL/body/headers per attempt), the arm matrix
 * (D-146's 401 reasons presented as catalog sentences — never the
 * payload), the write-only discipline, the destination round trip, and
 * the zero-fetch first paint the csp-shell e2e cells rely on. The
 * client pipeline itself (deadline, envelope classification, the
 * `onUnauthenticated` hook) is `api-client.spec.ts`'s; the guard and
 * redirect mechanics are `session.spec.ts`'s.
 */

/** The wire arms the server's login endpoint answers (D-146). */
function loginFailure(reason: string): unknown {
  return {
    error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: { reason } },
  };
}

interface Mounted {
  readonly wrapper: ReturnType<typeof mount>;
  readonly router: ReturnType<typeof createAppRouter>;
  readonly session: ReturnType<typeof createSession>;
  readonly fake: FakeFetch;
}

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
}

/**
 * Awaits a component-driven navigation leaving the login route. Unlike
 * the shell specs (whose navigations are awaited router.push calls),
 * this page's push happens inside the submit handler, so the test
 * cannot await it directly — and the FIRST navigation of the file pays
 * the target view's cold lazy-chunk transform (the overview chunk pulls
 * the charts seam), which can outlive a fixed macrotask hop. A bounded
 * poll at the 30 s house budget (the D-087/D-094 lesson; the review
 * round's P3-6) waits the navigation out deterministically.
 */
async function navigatedAwayFromLogin(router: Mounted['router']): Promise<void> {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    if (router.currentRoute.value.name !== 'login') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPromises();
  }
  expect(router.currentRoute.value.name, 'the sign-in navigation settled').not.toBe('login');
}

async function mountLogin(
  initial: string,
  handler: FakeFetch['handler'],
  session: ReturnType<typeof createSession> = createSession(),
): Promise<Mounted> {
  const router = createAppRouter(createMemoryHistory());
  await router.push(initial);
  await router.isReady();
  const fake = new FakeFetch(handler);
  // The composition root's exact client wiring: the wire's
  // UNAUTHENTICATED answers feed the session store (D-159).
  const api = createApiClientPlugin({
    fetchImpl: fake.impl,
    onUnauthenticated: () => session.markUnauthenticated(),
  });
  const wrapper = mount(LoginView, {
    global: { plugins: [router, createAppI18n(), api, session] },
  });
  await flushPromises();
  return { wrapper, router, session, fake };
}

/** Fills the field and submits the form. */
async function submitWith(wrapper: Mounted['wrapper'], password: string): Promise<void> {
  await wrapper.find('[data-testid="login-password"]').setValue(password);
  await wrapper.find('[data-testid="login-form"]').trigger('submit');
  await settle();
}

describe('first paint', () => {
  it('renders the mode-agnostic form and fires no request', async () => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(jsonResponse(200, { status: 'ok' })),
    );
    expect(mounted.wrapper.find('[data-testid="login-form"]').exists()).toBe(true);
    expect(mounted.wrapper.find('h2').text()).toBe(en.login.title);
    expect(mounted.wrapper.find('label[for="login-password"]').text()).toBe(en.login.field);
    // The zero-fetch property: the login page makes the csp-shell e2e
    // cells possible (§14.6's page must render before any credential
    // exists, so nothing is fetched on mount).
    expect(mounted.fake.calls).toHaveLength(0);
    // The §15.2 budget-delay hint is stated up front.
    expect(mounted.wrapper.find('.login-hint').text()).toBe(en.login.delayHint);
  });
});

describe('the blank guard', () => {
  it('an empty password refuses client-side with no request', async () => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(jsonResponse(200, { status: 'ok' })),
    );
    await mounted.wrapper.find('[data-testid="login-form"]').trigger('submit');
    await settle();
    expect(mounted.fake.calls).toHaveLength(0);
    expect(mounted.wrapper.find('[data-testid="login-blank"]').text()).toBe(en.login.errorBlank);
    expect(mounted.wrapper.find('[data-testid="login-password"]').attributes('aria-invalid')).toBe(
      'true',
    );
  });
});

describe('a successful sign-in', () => {
  it('sends exactly the §15.3-shaped login request and follows the preserved destination', async () => {
    const mounted = await mountLogin('/login?redirect=/settings', (call) =>
      Promise.resolve(
        jsonResponse(
          200,
          call.input === '/api/auth/login' ? { session: { expiresAt: 123 } } : { status: 'ok' },
        ),
      ),
    );
    await submitWith(mounted.wrapper, 'correct horse battery staple');
    await navigatedAwayFromLogin(mounted.router);
    expect(mounted.fake.calls).toHaveLength(1);
    const call = mounted.fake.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.input).toBe('/api/auth/login');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['X-Quotameter-Request']).toBe('1');
    expect(JSON.parse(call.body ?? '')).toEqual({ password: 'correct horse battery staple' });
    // The session state and the navigation.
    expect(mounted.session.state.value).toBe('authenticated');
    expect(mounted.router.currentRoute.value.path).toBe('/settings');
    // The write-only discipline: the attempted candidate never lingers.
    expect(
      (mounted.wrapper.find('[data-testid="login-password"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(mounted.wrapper.text()).not.toContain('correct horse battery staple');
  });

  it('without a preserved destination it lands on the overview', async () => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(jsonResponse(200, { session: { expiresAt: 123 } })),
    );
    await submitWith(mounted.wrapper, 'the-password');
    await navigatedAwayFromLogin(mounted.router);
    expect(mounted.router.currentRoute.value.path).toBe('/');
    expect(mounted.session.state.value).toBe('authenticated');
  });

  it('an unsafe preserved destination collapses to the overview (open-redirect guard)', async () => {
    const mounted = await mountLogin(
      '/login?redirect=' + encodeURIComponent('//evil.example'),
      () => Promise.resolve(jsonResponse(200, { session: { expiresAt: 123 } })),
    );
    await submitWith(mounted.wrapper, 'the-password');
    await navigatedAwayFromLogin(mounted.router);
    expect(mounted.router.currentRoute.value.path).toBe('/');
  });
});

describe('the 401 arm matrix (D-146)', () => {
  it.each([
    ['invalid-credentials', en.login.errors.incorrect],
    ['source-busy', en.login.errors.busy],
    ['some-future-reason', en.login.errors.failed],
  ] as const)('the %s arm renders its own catalog sentence', async (reason, sentence) => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(jsonResponse(401, loginFailure(reason))),
    );
    await submitWith(mounted.wrapper, 'a-wrong-candidate');
    expect(mounted.wrapper.find('[data-testid="login-failure"]').text()).toBe(sentence);
    // The shared notice does not double-present the failure.
    expect(mounted.wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    // The login arm is EXEMPT from the session signal (the review
    // round's P2-2): a rejected candidate says nothing about the
    // browser's session — in the passwordless `auto`-loopback world
    // every attempt 401s, and a flip here would brick navigation until
    // a reload. The state stays whatever it was.
    expect(mounted.session.state.value).toBe('unknown');
    // Still on the form, ready for the next attempt.
    expect(mounted.router.currentRoute.value.path).toBe('/login');
  });

  it('an absent reason answers the generic failure sentence — never a guess', async () => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(
        jsonResponse(401, {
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: null },
        }),
      ),
    );
    await submitWith(mounted.wrapper, 'a-wrong-candidate');
    expect(mounted.wrapper.find('[data-testid="login-failure"]').text()).toBe(
      en.login.errors.failed,
    );
  });

  it('a hostile reason value never renders — only the catalog sentence shows', async () => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(jsonResponse(401, loginFailure('<script>alert(1)</script>'))),
    );
    await submitWith(mounted.wrapper, 'a-wrong-candidate');
    expect(mounted.wrapper.find('[data-testid="login-failure"]').text()).toBe(
      en.login.errors.failed,
    );
    expect(mounted.wrapper.text()).not.toContain('<script>');
  });

  it('a retry after a failure clears the previous sentence', async () => {
    let refused = true;
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(
        refused
          ? jsonResponse(401, loginFailure('invalid-credentials'))
          : jsonResponse(200, { session: { expiresAt: 1 } }),
      ),
    );
    await submitWith(mounted.wrapper, 'first-attempt');
    expect(mounted.wrapper.find('[data-testid="login-failure"]').exists()).toBe(true);
    refused = false;
    await submitWith(mounted.wrapper, 'second-attempt');
    expect(mounted.wrapper.find('[data-testid="login-failure"]').exists()).toBe(false);
    expect(mounted.session.state.value).toBe('authenticated');
  });
});

describe('failures outside the login arms', () => {
  it('a non-UNAUTHENTICATED envelope rides the shared notice', async () => {
    const mounted = await mountLogin('/login', () =>
      Promise.resolve(
        jsonResponse(500, { error: { code: 'INTERNAL', message: 'boom', details: null } }),
      ),
    );
    await submitWith(mounted.wrapper, 'a-candidate');
    const notice = mounted.wrapper.find('[data-testid="api-error"]');
    expect(notice.text()).toBe(en.errors.codes.internal);
    expect(mounted.wrapper.find('[data-testid="login-failure"]').exists()).toBe(false);
    // Not an unauthenticated signal: the session state stays unknown.
    expect(mounted.session.state.value).toBe('unknown');
  });

  it('an unreachable service rides the shared notice', async () => {
    const mounted = await mountLogin('/login', networkFailure());
    await submitWith(mounted.wrapper, 'a-candidate');
    expect(mounted.wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.network);
  });
});

describe('the pending state (§15.2 budget delays are waited out)', () => {
  it('disables the field and the submit while the slow answer is awaited', async () => {
    const mounted = await mountLogin('/login', neverRespond());
    await mounted.wrapper.find('[data-testid="login-password"]').setValue('patient-candidate');
    await mounted.wrapper.find('[data-testid="login-form"]').trigger('submit');
    await flushPromises();
    // Both controls lock and the label states the wait — the honest UX
    // for a deliberately slow answer (LOGIN_TIMEOUT_MS outlives it).
    expect(
      (mounted.wrapper.find('[data-testid="login-submit"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (mounted.wrapper.find('[data-testid="login-password"]').element as HTMLInputElement).disabled,
    ).toBe(true);
    expect(mounted.wrapper.find('[data-testid="login-submit"]').text()).toBe(en.login.pending);
    // The write-only clear runs at DISPATCH (the review round's P3-2):
    // the candidate never lingers through the possibly minutes-long
    // pending window — the body is already built and on the wire.
    expect(
      (mounted.wrapper.find('[data-testid="login-password"]').element as HTMLInputElement).value,
    ).toBe('');
  });
});
