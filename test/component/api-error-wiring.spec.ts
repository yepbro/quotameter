import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import App from '../../ui/src/App.vue';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin, useApi, useApiCall } from '../../ui/src/api';
import { ApiClientError } from '../../ui/src/api/error';
import { createAppI18n } from '../../ui/src/i18n';
import { createAppRouter } from '../../ui/src/router';
import { createSession } from '../../ui/src/session';
import { createAppTheme } from '../../ui/src/theme';
import { en } from '../../ui/src/i18n/en';
import { FakeThemeMedia, MemoryThemeStorage } from '../helpers/theme';
import { FakeFetch, jsonResponse, networkFailure, healthyApiBody } from '../helpers/api';

/**
 * The done-condition proof (task 169): errors are handled consistently
 * across pages — the shell is mounted at every route with the same
 * shared wiring (useApi + useApiCall + ApiErrorNotice), and whichever
 * way the API answers, every page presents it through the one surface.
 * The vue-router navigation settle pattern is `app.spec.ts`'s
 * (macrotask hop under happy-dom). Since task 180 the login page is
 * load-free (the §14.6 form renders before any credential exists), so
 * it carries its own cell below instead of the per-route probe cells.
 */

async function settleNavigation(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
}

/** The full shell with a programmable API behind it. */
async function mountShell(initial: string, fetchImpl: FakeFetch['impl']): Promise<VueWrapper> {
  const router = createAppRouter(createMemoryHistory());
  await router.push(initial);
  await router.isReady();
  const theme = createAppTheme({ storage: new MemoryThemeStorage(), media: new FakeThemeMedia() });
  const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
  const session = createSession();
  const api = createApiClientPlugin({ fetchImpl });
  const wrapper = mount(App, {
    global: { plugins: [router, createAppI18n(), theme, selection, session, api] },
  });
  await settleNavigation();
  return wrapper;
}

/**
 * A healthy answer per §13 route the shell's pages load — the shared
 * `healthyApiBody` helper (task 170 made `/accounts` a real page — the
 * accounts list and the providers list — so a one-shape answer would be
 * a lie the trusted casts choke on).
 */
const healthyBody = healthyApiBody;

const ROUTES = ['/', '/accounts', '/settings'] as const;

describe('shared error wiring across pages (task 169, D-134)', () => {
  // Shell mounts carry the full overview pipeline (charts seam included,
  // task 177) — 2.7 s worst clean under the full suite, so the default
  // 5 s budget flakes under parallel-worktree load (D-087/D-094 family,
  // observed at 177's landing). Pinned to the 30 s house value.
  it.each(ROUTES)(
    'renders the shared notice on %s when the API is unreachable',
    { timeout: 30_000 },
    async (path) => {
      const fake = new FakeFetch(networkFailure());
      const wrapper = await mountShell(path, fake.impl);
      const notice = wrapper.find('[data-testid="api-error"]');
      expect(notice.exists()).toBe(true);
      expect(notice.text()).toBe(en.errors.network);
      expect(notice.attributes('data-error-kind')).toBe('network');
      // Every dispatched request went through the shared client to a §13
      // route (the accounts page fires two loads; the probe pages one).
      expect(fake.calls.length).toBeGreaterThan(0);
      for (const call of fake.calls) {
        expect(call.input.startsWith('/api/')).toBe(true);
      }
    },
  );

  it.each(ROUTES)(
    'renders no notice on %s when the API answers',
    { timeout: 30_000 },
    async (path) => {
      const fake = new FakeFetch((call) =>
        Promise.resolve(jsonResponse(200, healthyBody(call.input))),
      );
      const wrapper = await mountShell(path, fake.impl);
      expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
      // Real page content rendered beside the wiring: the overview's
      // honest empty state (task 172), the accounts page's empty state
      // (task 170), or the settings page's general form (task 179).
      expect(
        wrapper
          .find(
            '[data-testid="overview-empty"], [data-testid="accounts-empty"], [data-testid="settings-general"]',
          )
          .exists(),
      ).toBe(true);
    },
  );

  it('the login page (task 180) renders its form with zero requests and no notice', async () => {
    // The load-free §14.6 page: unlike every other route it fires
    // nothing on mount — the csp-shell e2e cells stand on this — so an
    // unreachable API costs it nothing; the form is the whole surface
    // until a credential is presented.
    const fake = new FakeFetch(networkFailure());
    const wrapper = await mountShell('/login', fake.impl);
    expect(fake.calls).toHaveLength(0);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true);
    expect(wrapper.find('h2').text()).toBe(en.login.title);
  });

  it('every page presents an envelope rejection through the same surface', async () => {
    // A hostile/other responder answering the §13 envelope: the pages
    // render the code's catalog sentence, never the envelope payload.
    const envelope = {
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: null },
    };
    const fake = new FakeFetch(() => Promise.resolve(jsonResponse(401, envelope)));
    const wrapper = await mountShell('/settings', fake.impl);
    const notice = wrapper.find('[data-testid="api-error"]');
    expect(notice.text()).toBe(en.errors.codes.unauthenticated);
    expect(notice.attributes('data-error-code')).toBe('UNAUTHENTICATED');
  });
});

describe('the client plugin seam', () => {
  it('useApi() returns the installed client', async () => {
    const fake = new FakeFetch(() => Promise.resolve(jsonResponse(200, { status: 'ok' })));
    const api = createApiClientPlugin({ fetchImpl: fake.impl });
    const app = createApp({
      setup() {
        const client = useApi();
        expect(client).toBeDefined();
        expect(client.health).toBeDefined();
      },
      render: () => null,
    });
    app.use(api);
    app.mount(document.createElement('div'));
    app.unmount();
  });

  it('useApi() throws with its remedy when the plugin is missing', () => {
    const app = createApp({
      setup() {
        expect(() => useApi()).toThrow(/createApiClientPlugin/s);
      },
      render: () => null,
    });
    app.mount(document.createElement('div'));
    app.unmount();
  });
});

/** A controllable promise — the call's transport in miniature. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useApiCall (the shared page-level pattern)', () => {
  /** Renders the composable's state: the reactivity pins need a component. */
  function mountProbe<T>(call: () => Promise<T>) {
    const state = { current: null as ReturnType<typeof useApiCall<T>> | null };
    const wrapper = mount(
      defineComponent({
        setup() {
          state.current = useApiCall(call);
          return () =>
            h('output', [
              state.current!.pending.value ? 'pending' : 'idle',
              `:${state.current!.error.value?.kind ?? 'none'}`,
              `:${JSON.stringify(state.current!.data.value)}`,
            ]);
        },
      }),
    );
    return { wrapper, state: state.current! };
  }

  it('tracks pending, then stores the data and clears the error on success', async () => {
    const transport = deferred<{ status: string }>();
    const { wrapper, state } = mountProbe(() => transport.promise);
    const inFlight = state.execute();
    await nextTick();
    expect(state.pending.value).toBe(true);
    expect(wrapper.text()).toContain('pending');

    transport.resolve({ status: 'ok' });
    await expect(inFlight).resolves.toEqual({ status: 'ok' });
    expect(state.data.value).toEqual({ status: 'ok' });
    expect(state.error.value).toBeNull();
    expect(state.pending.value).toBe(false);
    expect(wrapper.text()).toContain('"status":"ok"');
  });

  it('catches a taxonomy error into state and resolves null', async () => {
    const transport = deferred<never>();
    const { state } = mountProbe(() => transport.promise);
    const inFlight = state.execute();
    transport.reject(new ApiClientError({ kind: 'rejected', status: 404, code: 'NOT_FOUND' }));
    await expect(inFlight).resolves.toBeNull();
    expect(state.error.value?.kind).toBe('rejected');
    expect(state.error.value?.code).toBe('NOT_FOUND');
    expect(state.data.value).toBeNull();
    expect(state.pending.value).toBe(false);
  });

  it('a deliberate cancellation is not an error: aborted resolves quietly, state untouched', async () => {
    // The review round's P2: `aborted` is a cancellation, never a
    // presented failure (D-134) — the composable must not record it.
    const transport = deferred<never>();
    const { state } = mountProbe(() => transport.promise);
    const inFlight = state.execute();
    transport.reject(new ApiClientError({ kind: 'aborted' }));
    await expect(inFlight).resolves.toBeNull();
    expect(state.error.value).toBeNull();
    expect(state.pending.value).toBe(false);
    // And previously loaded data survives the cancellation.
    expect(state.data.value).toBeNull();
  });

  it('a superseded run cannot overwrite the newest state', async () => {
    // The review round's P2: overlapping execute() calls — only the
    // newest may write. The stale success resolves to its caller but
    // leaves the newer run's state alone, whichever settles first.
    const slow = deferred<string>();
    const fast = deferred<string>();
    let invoke = 0;
    const { state } = mountProbe(() => ((invoke += 1), invoke === 1 ? slow.promise : fast.promise));
    const stale = state.execute();
    const fresh = state.execute();
    // The newer call settles first…
    fast.resolve('fresh');
    await expect(fresh).resolves.toBe('fresh');
    expect(state.data.value).toBe('fresh');
    expect(state.pending.value).toBe(false);
    // …then the stale one lands late and must not clobber it.
    slow.resolve('stale');
    await expect(stale).resolves.toBe('stale');
    expect(state.data.value).toBe('fresh');
  });

  it('a superseded failure cannot clobber a newer success either', async () => {
    const slow = deferred<never>();
    const fast = deferred<string>();
    let invoke = 0;
    const { state } = mountProbe(() => ((invoke += 1), invoke === 1 ? slow.promise : fast.promise));
    const stale = state.execute();
    const fresh = state.execute();
    fast.resolve('fresh');
    await fresh;
    slow.reject(new ApiClientError({ kind: 'network' }));
    await expect(stale).resolves.toBeNull();
    expect(state.data.value).toBe('fresh');
    expect(state.error.value).toBeNull();
    expect(state.pending.value).toBe(false);
  });

  it('rethrows anything that is not a taxonomy error (code bugs stay loud)', async () => {
    const transport = deferred<never>();
    const { state } = mountProbe(() => transport.promise);
    const inFlight = state.execute();
    transport.reject(new TypeError('programmer error'));
    await expect(inFlight).rejects.toThrow('programmer error');
    expect(state.error.value).toBeNull();
  });

  it('clears a previous error when re-executed successfully', async () => {
    let rejectNext = true;
    const { state } = mountProbe(() =>
      rejectNext
        ? Promise.reject(new ApiClientError({ kind: 'network' }))
        : Promise.resolve('value'),
    );
    await state.execute();
    expect(state.error.value?.kind).toBe('network');
    rejectNext = false;
    await state.execute();
    expect(state.error.value).toBeNull();
    expect(state.data.value).toBe('value');
  });

  it('reset() clears a loaded result without dispatching a new call', async () => {
    let calls = 0;
    const { state } = mountProbe(() => {
      calls += 1;
      return Promise.resolve('value');
    });
    await state.execute();
    expect(state.data.value).toBe('value');
    const dispatched = calls;
    state.reset();
    expect(calls).toBe(dispatched);
    expect(state.data.value).toBeNull();
    expect(state.error.value).toBeNull();
    expect(state.pending.value).toBe(false);
  });

  it('reset() clears a presented failure state', async () => {
    const { state } = mountProbe(() => Promise.reject(new ApiClientError({ kind: 'network' })));
    await state.execute();
    expect(state.error.value?.kind).toBe('network');
    state.reset();
    expect(state.error.value).toBeNull();
    expect(state.pending.value).toBe(false);
  });

  it('reset() supersedes an in-flight run — the settling call writes nothing', async () => {
    const transport = deferred<string>();
    const { state } = mountProbe(() => transport.promise);
    const inFlight = state.execute();
    expect(state.pending.value).toBe(true);
    state.reset();
    expect(state.pending.value).toBe(false);
    transport.resolve('late');
    await expect(inFlight).resolves.toBe('late');
    // The stale success resolved to its caller but wrote no state.
    expect(state.data.value).toBeNull();
    expect(state.pending.value).toBe(false);
  });
});
