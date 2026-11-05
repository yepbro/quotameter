import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTestResponse, AccountView } from '../../src/schemas/api/accounts';
import type { ProviderView } from '../../src/schemas/api/providers';
import AccountsView from '../../ui/src/views/AccountsView.vue';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { en } from '../../ui/src/i18n/en';
import { FakeFetch, jsonResponse, type RecordedCall } from '../helpers/api';
import { MemoryThemeStorage } from '../helpers/theme';

/**
 * The task-170 done-condition, executable: every §14.2 action — add,
 * rename, enable/disable, replace key, test, archive, purge — works
 * through the documented API client surface with the right method, URL,
 * and payload, and the destructive purge leaves the client only behind
 * the typed confirmation. The page is mounted against a miniature
 * accounts backend on the injectable fetch seam (the D-134 hermetic
 * pattern — no network, no browser globals), so the assertions pin the
 * wire shape AND the resulting UI state in one flow.
 */

/* ── Fixtures ─────────────────────────────────────────────────────────── */

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-1',
    providerId: 'zai-coding-plan',
    label: 'Main',
    enabled: true,
    status: 'active',
    hasKey: true,
    keySource: 'file',
    keyMask: '********',
    planName: null,
    createdAt: null,
    archivedAt: null,
    ...overrides,
  };
}

const PROVIDERS: ProviderView[] = [
  {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan',
    peakHours: null,
    // The D-137 catalog the real adapter declares.
    metrics: [
      { metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' },
      { metricKey: 'tokens-5h', label: '5-hour token quota' },
      { metricKey: 'weekly-quota', label: 'Weekly quota' },
    ],
  },
];

/** The §13 error-envelope response shape (D-113). */
function envelope(
  status: number,
  code: string,
  message: string,
  details: unknown = null,
): ReturnType<typeof jsonResponse> {
  return jsonResponse(status, { error: { code, message, details } });
}

const PURGED_COUNTS = {
  collectionRuns: 1,
  snapshots: 2,
  metricValues: 3,
  quotaEvents: 0,
  rawResponses: 1,
};

/**
 * A miniature accounts service: routes the five §13 accounts routes
 * plus `GET /api/providers` over in-memory state, answers through the
 * §13 shapes the real server serializes, and records every dispatch —
 * the page's whole world, programmable per case.
 */
class FakeAccountsBackend {
  readonly fake: FakeFetch;
  accounts: AccountView[];
  providers: ProviderView[];
  testResponse: AccountTestResponse = { outcome: 'ok' };
  /** A one-shot refusal for the next matching call (the error arms). */
  refuseNext: ((call: RecordedCall) => ReturnType<typeof jsonResponse> | undefined) | null = null;
  /** A one-shot stall: the next matching call resolves only on `unstall()`. */
  stallNext: ((call: RecordedCall) => boolean) | null = null;
  private releaseStalled: (() => void) | null = null;

  constructor(initial: AccountView[], providers: ProviderView[] = PROVIDERS) {
    this.accounts = initial;
    this.providers = providers;
    this.fake = new FakeFetch((call) => this.answer(call));
  }

  get impl(): FakeFetch['impl'] {
    return this.fake.impl;
  }

  get calls(): RecordedCall[] {
    return this.fake.calls;
  }

  /** Resolves the held stall (a no-op when none is held). */
  unstall(): void {
    this.releaseStalled?.();
    this.releaseStalled = null;
  }

  private answer(call: RecordedCall): Promise<ReturnType<typeof jsonResponse>> {
    if (this.stallNext?.(call) === true) {
      this.stallNext = null;
      return new Promise((resolve) => {
        this.releaseStalled = () => resolve(this.route(call));
      });
    }
    return Promise.resolve(this.route(call));
  }

  private route(call: RecordedCall): ReturnType<typeof jsonResponse> {
    const refusal = this.refuseNext?.(call);
    if (refusal !== undefined) {
      this.refuseNext = null;
      return refusal;
    }
    const { method, input } = call;
    if (method === 'GET' && input === '/api/accounts') {
      return jsonResponse(200, { accounts: this.accounts });
    }
    if (method === 'GET' && input === '/api/providers') {
      return jsonResponse(200, { providers: this.providers });
    }
    if (method === 'POST' && input === '/api/accounts') {
      const body = JSON.parse(call.body ?? '{}') as {
        providerId: string;
        label: string;
        apiKey?: string;
      };
      const id = `acc-${this.accounts.length + 1}`;
      const created = account({
        id,
        providerId: body.providerId,
        label: body.label,
        hasKey: body.apiKey !== undefined,
        keyMask: body.apiKey !== undefined ? '********' : null,
      });
      this.accounts = [...this.accounts, created];
      return jsonResponse(201, created);
    }
    const idOf = (prefix: string): string =>
      decodeURIComponent(input.slice(prefix.length).split('?')[0] ?? '');
    if (method === 'PATCH' && input.startsWith('/api/accounts/')) {
      const body = JSON.parse(call.body ?? '{}') as { label?: string; enabled?: boolean };
      this.accounts = this.accounts.map((entry) =>
        entry.id === idOf('/api/accounts/') ? { ...entry, ...body } : entry,
      );
      const updated = this.accounts.find((entry) => entry.id === idOf('/api/accounts/'));
      return jsonResponse(200, updated ?? account());
    }
    if (method === 'DELETE' && input.startsWith('/api/accounts/')) {
      const id = idOf('/api/accounts/');
      const purge = input.includes('purgeHistory=true');
      if (purge) {
        const purged = this.accounts.find((entry) => entry.id === id) ?? account({ id });
        this.accounts = this.accounts.filter((entry) => entry.id !== id);
        return jsonResponse(200, { result: 'purged', account: purged, removed: PURGED_COUNTS });
      }
      this.accounts = this.accounts.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: 'archived',
              archivedAt: 1,
              enabled: false,
              keySource: 'none',
              hasKey: false,
              keyMask: null,
            }
          : entry,
      );
      const archived = this.accounts.find((entry) => entry.id === id);
      return jsonResponse(200, {
        result: 'archived',
        account: archived ?? account(),
        removed: null,
      });
    }
    if (method === 'POST' && input.startsWith('/api/accounts/') && input.endsWith('/test')) {
      return jsonResponse(200, this.testResponse);
    }
    return envelope(404, 'NOT_FOUND', 'no route');
  }
}

/* ── Mount helpers ────────────────────────────────────────────────────── */

const wrappers: VueWrapper[] = [];

async function mountView(
  backend: FakeAccountsBackend,
  storage: MemoryThemeStorage = new MemoryThemeStorage(),
): Promise<VueWrapper> {
  const selection = createAccountSelection({ storage });
  const wrapper = mount(AccountsView, {
    attachTo: document.body,
    global: {
      plugins: [createAppI18n(), selection, createApiClientPlugin({ fetchImpl: backend.impl })],
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

/** Drain the async chains (load → mutate → reload) through micro- and macrotasks. */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

function callsOf(backend: FakeAccountsBackend, method: string, input: string): RecordedCall[] {
  return backend.calls.filter((call) => call.method === method && call.input === input);
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body ?? '{}') as Record<string, unknown>;
}

/* ── The page, the selector, the selection store seam ─────────────────── */

describe('accounts page: loading and selection (task 170, §14.2)', () => {
  it('lists the accounts, selects the first by default, and shows its card', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const wrapper = await mountView(backend);

    const select = wrapper.find('[data-testid="account-select"]');
    expect(select.exists()).toBe(true);
    expect(select.element.value).toBe('acc-1');
    expect(select.findAll('option').map((option) => option.text())).toEqual(['Main', 'Second']);

    const card = wrapper.find('[data-testid="account-card"]');
    expect(card.find('h3').text()).toBe('Main');
    // The provider row renders the display name from GET /api/providers.
    expect(card.text()).toContain('Z.ai Coding Plan');
    // The §13 mask, verbatim — a key VALUE never reaches the browser.
    expect(card.text()).toContain('********');
  });

  it('switching the selector swaps the card and persists the choice', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const storage = new MemoryThemeStorage();
    const wrapper = await mountView(backend, storage);

    await wrapper.find('[data-testid="account-select"]').setValue('acc-2');
    await settle();

    expect(wrapper.find('[data-testid="account-card"]').find('h3').text()).toBe('Second');
    expect(storage.getItem('quotameter.selected-account')).toBe('acc-2');
  });

  it('a stored selection is honored while its account is listed', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const storage = new MemoryThemeStorage({ 'quotameter.selected-account': 'acc-2' });
    const wrapper = await mountView(backend, storage);

    expect(wrapper.find('[data-testid="account-card"]').find('h3').text()).toBe('Second');
  });

  it('a stale stored selection is reconciled to the first listed account', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const storage = new MemoryThemeStorage({ 'quotameter.selected-account': 'purged-elsewhere' });
    const wrapper = await mountView(backend, storage);

    expect(wrapper.find('[data-testid="account-card"]').find('h3').text()).toBe('Main');
  });

  it('an empty list renders the helpful empty state and the add form only', async () => {
    const backend = new FakeAccountsBackend([]);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="accounts-empty"]').text()).toContain(en.accounts.empty.hint);
    expect(wrapper.find('[data-testid="account-select"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="add-account-form"]').exists()).toBe(true);
  });

  it('a failed list load renders the notice and a retry — never a fake empty state', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'GET' && call.input === '/api/accounts'
        ? envelope(500, 'INTERNAL', 'boom')
        : undefined;
    const wrapper = await mountView(backend);

    const notice = wrapper.find('[data-testid="api-error"]');
    expect(notice.exists()).toBe(true);
    expect(notice.attributes('data-error-kind')).toBe('rejected');
    expect(notice.attributes('data-error-code')).toBe('INTERNAL');
    // The failure is not "no accounts": no empty state, no selector/card.
    expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-select"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-card"]').exists()).toBe(false);

    // The retry re-dispatches the load, and the recovered answer renders.
    await wrapper.find('[data-testid="accounts-retry"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-card"]').exists()).toBe(true);
  });

  it('a failed reload keeps the last good list rendered beside the notice', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);
    expect(wrapper.find('[data-testid="account-card"]').exists()).toBe(true);

    // A successful mutation, then the triggered reload fails.
    backend.refuseNext = (call) =>
      call.method === 'GET' && call.input === '/api/accounts'
        ? envelope(500, 'INTERNAL', 'boom')
        : undefined;
    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await wrapper.find('[data-testid="rename-input"]').setValue('Renamed');
    await wrapper.find('[data-testid="rename-save"]').trigger('submit');
    await settle();

    // The stale list stays (the management surface survives) beside the
    // honest failure notice and its retry.
    expect(wrapper.find('[data-testid="account-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="account-select"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe(
      'INTERNAL',
    );
    expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(false);
  });

  it('a failed initial load leaves a stored selection untouched in storage', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    backend.refuseNext = (call) =>
      call.method === 'GET' && call.input === '/api/accounts'
        ? envelope(500, 'INTERNAL', 'boom')
        : undefined;
    const storage = new MemoryThemeStorage({ 'quotameter.selected-account': 'acc-2' });
    await mountView(backend, storage);

    // Reconciliation never ran against the failed load — the stored
    // choice survives for the load that will honor it.
    expect(storage.getItem('quotameter.selected-account')).toBe('acc-2');
  });

  it('a failed providers load renders its own notice and disables the add form honestly', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'GET' && call.input === '/api/providers'
        ? envelope(500, 'INTERNAL', 'boom')
        : undefined;
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe(
      'INTERNAL',
    );
    const form = wrapper.find('[data-testid="add-account-form"]');
    expect(form.find('fieldset').attributes('disabled')).toBeDefined();
    // The "no provider in this build" sentence states a build fact — it
    // must not render for a failed load (the notice already did).
    expect(form.text()).not.toContain(en.accounts.add.noProviders);
  });

  it('renders the no-providers sentence only for a successfully empty list', async () => {
    const backend = new FakeAccountsBackend([account()], []);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="add-account-form"]').text()).toContain(
      en.accounts.add.noProviders,
    );
  });
});

/* ── Add (§5.3 keyless create, write-only key) ────────────────────────── */

describe('accounts page: add (task 170, §14.2)', () => {
  it('creates an account with the typed key and reloads the list', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="add-label"]').setValue('Backup');
    await wrapper.find('[data-testid="add-key"]').setValue('sk-marker-key-1');
    await wrapper
      .find('[data-testid="add-account-form"]')
      .find('button[type="submit"]')
      .trigger('submit');
    await settle();

    const posts = callsOf(backend, 'POST', '/api/accounts');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({
      providerId: 'zai-coding-plan',
      label: 'Backup',
      apiKey: 'sk-marker-key-1',
    });
    // The list reloaded and the new account is selectable.
    expect(
      wrapper
        .find('[data-testid="account-select"]')
        .findAll('option')
        .map((o) => o.text()),
    ).toContain('Backup');
    // The form reset its label.
    expect((wrapper.find('[data-testid="add-label"]').element as HTMLInputElement).value).toBe('');
  });

  it('omits the key entirely when left empty (the §5.3 keyless account)', async () => {
    const backend = new FakeAccountsBackend([]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="add-label"]').setValue('Keyless');
    await wrapper
      .find('[data-testid="add-account-form"]')
      .find('button[type="submit"]')
      .trigger('submit');
    await settle();

    const posts = callsOf(backend, 'POST', '/api/accounts');
    expect(posts).toHaveLength(1);
    expect('apiKey' in bodyOf(posts[0]!)).toBe(false);
  });

  it('refuses a blank label and a blank key client-side — no request', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);
    const dispatched = backend.calls.length;

    await wrapper
      .find('[data-testid="add-account-form"]')
      .find('button[type="submit"]')
      .trigger('submit');
    await settle();

    expect(backend.calls.length).toBe(dispatched);
    expect(wrapper.text()).toContain(en.accounts.form.errorLabelRequired);

    await wrapper.find('[data-testid="add-key"]').setValue('   ');
    await wrapper
      .find('[data-testid="add-account-form"]')
      .find('button[type="submit"]')
      .trigger('submit');
    await settle();

    expect(backend.calls.length).toBe(dispatched);
    expect(wrapper.text()).toContain(en.accounts.form.errorKeyBlank);
  });

  it('presents a rejected create through the shared notice and keeps the label', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'POST' && call.input === '/api/accounts'
        ? envelope(400, 'VALIDATION', 'Unknown provider', { reason: 'unknown-provider' })
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="add-label"]').setValue('Nope');
    await wrapper
      .find('[data-testid="add-account-form"]')
      .find('button[type="submit"]')
      .trigger('submit');
    await settle();

    const notice = wrapper.find('[data-testid="api-error"]');
    expect(notice.attributes('data-error-code')).toBe('VALIDATION');
    expect(notice.text()).toBe(en.errors.codes.validation);
    expect((wrapper.find('[data-testid="add-label"]').element as HTMLInputElement).value).toBe(
      'Nope',
    );
    // The typed key never survives the attempt — a REFUSED submit too
    // (task 171: the write-only clearing pinned on both outcomes).
    expect((wrapper.find('[data-testid="add-key"]').element as HTMLInputElement).value).toBe('');
  });

  it('clears the replace-key field after a refused submit too (task 171)', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'PATCH' && call.input.startsWith('/api/accounts/')
        ? envelope(403, 'FORBIDDEN', 'The account is archived', { reason: 'account-archived' })
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="replace-key-button"]').trigger('click');
    await wrapper.find('[data-testid="replace-key-input"]').setValue('sk-typed-then-refused');
    await wrapper.find('[data-testid="replace-key-save"]').trigger('submit');
    await settle();

    // The form stays open for the retry, but the typed key is gone.
    expect(
      (wrapper.find('[data-testid="replace-key-input"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe(
      'FORBIDDEN',
    );
  });

  it('the key input is masked and write-only from the first paint', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    const keyInput = wrapper.find('[data-testid="add-key"]');
    expect((keyInput.element as HTMLInputElement).type).toBe('password');
    expect((keyInput.element as HTMLInputElement).value).toBe('');
    expect(keyInput.attributes('autocomplete')).toBe('new-password');
  });
});

/* ── Rename, enable/disable, replace key ──────────────────────────────── */

describe('accounts page: rename, polling, replace key (task 170, §14.2)', () => {
  it('renames through PATCH with the label alone', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    const input = wrapper.find('[data-testid="rename-input"]');
    // Prefilled with the current label — the label is not a secret.
    expect((input.element as HTMLInputElement).value).toBe('Main');
    await input.setValue('Renamed');
    await wrapper.find('[data-testid="rename-save"]').trigger('submit');
    await settle();

    const patches = callsOf(backend, 'PATCH', '/api/accounts/acc-1');
    expect(patches).toHaveLength(1);
    expect(bodyOf(patches[0]!)).toEqual({ label: 'Renamed' });
    expect(wrapper.find('[data-testid="account-card"]').find('h3').text()).toBe('Renamed');
  });

  it('refuses a blank rename client-side — no request', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await wrapper.find('[data-testid="rename-input"]').setValue('   ');
    await wrapper.find('[data-testid="rename-save"]').trigger('submit');
    await settle();

    expect(callsOf(backend, 'PATCH', '/api/accounts/acc-1')).toHaveLength(0);
    expect(wrapper.text()).toContain(en.accounts.form.errorLabelRequired);
  });

  it('presents a rejected rename through the shared notice', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'PATCH' && call.input === '/api/accounts/acc-1'
        ? envelope(403, 'FORBIDDEN', 'archived', { reason: 'account-archived' })
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await wrapper.find('[data-testid="rename-input"]').setValue('Renamed');
    await wrapper.find('[data-testid="rename-save"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe(
      'FORBIDDEN',
    );
  });

  it('a cancelled panel leaves no stale error behind on re-open', async () => {
    // The review round's P2-2: the failure notice of a previous attempt
    // must not survive cancel/re-open — a stale role="alert" would
    // re-announce a failure that did not just happen.
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'PATCH' && call.input === '/api/accounts/acc-1'
        ? envelope(500, 'INTERNAL', 'boom')
        : undefined;
    const wrapper = await mountView(backend);

    // First attempt: refused, notice under the open form.
    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await wrapper.find('[data-testid="rename-input"]').setValue('Renamed');
    await wrapper.find('[data-testid="rename-save"]').trigger('submit');
    await settle();
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(true);

    // Cancel: the panel and its notice both clear.
    await wrapper.find('[data-testid="rename-cancel"]').trigger('click');
    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);

    // Re-open: no notice before any new request.
    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('a successful key replacement clears the previous test verdict', async () => {
    // The verdict describes the credential it ran against — the old
    // key's result must not survive its replacement.
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="test-button"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(true);

    await wrapper.find('[data-testid="replace-key-button"]').trigger('click');
    await wrapper.find('[data-testid="replace-key-input"]').setValue('sk-next-key');
    await wrapper.find('[data-testid="replace-key-save"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(false);
  });

  it('disables polling through PATCH with the flag alone, and re-labels the button', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);
    expect(wrapper.find('[data-testid="toggle-polling"]').text()).toBe(
      en.accounts.actions.disablePolling,
    );

    await wrapper.find('[data-testid="toggle-polling"]').trigger('click');
    await settle();

    const patches = callsOf(backend, 'PATCH', '/api/accounts/acc-1');
    expect(patches).toHaveLength(1);
    expect(bodyOf(patches[0]!)).toEqual({ enabled: false });
    expect(wrapper.find('[data-testid="toggle-polling"]').text()).toBe(
      en.accounts.actions.enablePolling,
    );
  });

  it('replaces the key through PATCH with the key alone — masked, never prefilled, cleared after', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="replace-key-button"]').trigger('click');
    const input = wrapper.find('[data-testid="replace-key-input"]');
    expect((input.element as HTMLInputElement).type).toBe('password');
    expect((input.element as HTMLInputElement).value).toBe('');
    await input.setValue('sk-marker-key-2');
    await wrapper.find('[data-testid="replace-key-save"]').trigger('submit');
    await settle();

    const patches = callsOf(backend, 'PATCH', '/api/accounts/acc-1');
    expect(patches).toHaveLength(1);
    expect(bodyOf(patches[0]!)).toEqual({ apiKey: 'sk-marker-key-2' });
    // The typed key never lingers in the DOM.
    expect(wrapper.text()).not.toContain('sk-marker-key-2');
  });

  it('offers no replace-key form for an environment-sourced key (§6.3 read-only)', async () => {
    const backend = new FakeAccountsBackend([
      account({ keySource: 'environment', keyMask: '********' }),
    ]);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="replace-key-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-card"]').text()).toContain(
      en.accounts.card.keyEnvironment,
    );
  });

  it('refuses a blank replacement key client-side — no request', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="replace-key-button"]').trigger('click');
    await wrapper.find('[data-testid="replace-key-input"]').setValue('  ');
    await wrapper.find('[data-testid="replace-key-save"]').trigger('submit');
    await settle();

    expect(callsOf(backend, 'PATCH', '/api/accounts/acc-1')).toHaveLength(0);
    expect(wrapper.text()).toContain(en.accounts.form.errorKeyBlank);
  });

  it('Escape closes the inline forms and restores focus to the opener (task 181)', async () => {
    // The keyboard dismissal contract: the panel that opened on a
    // button closes on Escape, and focus returns to that button — the
    // opener is the interaction's stable landmark (D-164).
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    // Rename: the input's Escape bubbles to the form's handler.
    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await settle();
    expect(document.activeElement).toBe(wrapper.find('[data-testid="rename-input"]').element);
    await wrapper.find('[data-testid="rename-input"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="rename-button"]').element);
    expect(callsOf(backend, 'PATCH', '/api/accounts/acc-1')).toHaveLength(0);

    // Replace key: same contract for the write-only field.
    await wrapper.find('[data-testid="replace-key-button"]').trigger('click');
    await settle();
    expect(document.activeElement).toBe(wrapper.find('[data-testid="replace-key-input"]').element);
    await wrapper.find('[data-testid="replace-key-input"]').trigger('keydown', {
      key: 'Escape',
    });
    await settle();
    expect(wrapper.find('[data-testid="replace-key-input"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="replace-key-button"]').element);
    expect(callsOf(backend, 'PATCH', '/api/accounts/acc-1')).toHaveLength(0);
  });
});

/* ── Connection test (§14.2: results show immediately) ────────────────── */

describe('accounts page: connection test (task 170, §14.2)', () => {
  it.each([
    ['ok', { outcome: 'ok' } as AccountTestResponse, en.accounts.test.ok, null],
    [
      'rejected',
      { outcome: 'rejected', message: 'provider said no' } as AccountTestResponse,
      en.accounts.test.rejected,
      'provider said no',
    ],
    [
      'unavailable',
      { outcome: 'unavailable', message: 'timeout' } as AccountTestResponse,
      en.accounts.test.unavailable,
      'timeout',
    ],
  ])(
    'renders the %s outcome immediately with its message',
    async (name, testResponse, sentence, message) => {
      const backend = new FakeAccountsBackend([account()]);
      backend.testResponse = testResponse;
      const wrapper = await mountView(backend);

      await wrapper.find('[data-testid="test-button"]').trigger('click');
      await settle();

      expect(callsOf(backend, 'POST', '/api/accounts/acc-1/test')).toHaveLength(1);
      const result = wrapper.find('[data-testid="test-result"]');
      expect(result.exists()).toBe(true);
      expect(result.attributes('data-outcome')).toBe(name);
      expect(result.text()).toContain(sentence);
      if (message === null) {
        expect(result.text()).toBe(sentence);
      } else {
        expect(result.text()).toContain(message);
      }
    },
  );

  it('disables the test when no key is configured (the server would refuse)', async () => {
    const backend = new FakeAccountsBackend([account({ hasKey: false, keyMask: null })]);
    const wrapper = await mountView(backend);

    expect(
      (wrapper.find('[data-testid="test-button"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(callsOf(backend, 'POST', '/api/accounts/acc-1/test')).toHaveLength(0);
  });

  it('presents a refused test request through the shared notice', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'POST' && call.input === '/api/accounts/acc-1/test'
        ? envelope(403, 'FORBIDDEN', 'no key', { reason: 'no-key-configured' })
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="test-button"]').trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe(
      'FORBIDDEN',
    );
    expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(false);
  });
});

/* ── Archive and purge (§8.2's split; the confirmation gates) ─────────── */

describe('accounts page: archive and purge (task 170, §8.2)', () => {
  it('archives through a bare DELETE — no purge flag — only after confirmation', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const wrapper = await mountView(backend);

    // Step 1: the confirm panel opens, focus lands on the safe control.
    await wrapper.find('[data-testid="archive-button"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="archive-confirm"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="archive-cancel"]').element);
    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1')).toHaveLength(0);

    // Step 2: cancel aborts — still no request.
    await wrapper.find('[data-testid="archive-cancel"]').trigger('click');
    expect(wrapper.find('[data-testid="archive-confirm"]').exists()).toBe(false);
    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1')).toHaveLength(0);

    // Step 3: confirming issues the bare archive DELETE (§8.2 default).
    await wrapper.find('[data-testid="archive-button"]').trigger('click');
    await wrapper.find('[data-testid="archive-confirm-button"]').trigger('click');
    await settle();

    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1')).toHaveLength(1);
    // The §13 spelling: exactly the bare path, no query string at all.
    expect(
      backend.calls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.input !== '/api/accounts/acc-1' &&
          call.input.startsWith('/api/accounts/acc-1'),
      ),
    ).toBe(false);
    // The list reloaded: the account is archived in the backend and the
    // card shows the terminal state.
    expect(backend.accounts[0]!.status).toBe('archived');
    expect(wrapper.find('[data-testid="archived-notice"]').exists()).toBe(true);
  });

  it('purges through ?purgeHistory=true ONLY behind the typed label match', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="purge-button"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="purge-confirm"]').exists()).toBe(true);
    // Focus lands on the typing gate.
    expect(document.activeElement).toBe(
      wrapper.find('[data-testid="purge-confirm-input"]').element,
    );
    const confirmButton = () => wrapper.find('[data-testid="purge-confirm-button"]');

    // A wrong label keeps the destructive button disabled — no request.
    await wrapper.find('[data-testid="purge-confirm-input"]').setValue('Wrogn');
    expect((confirmButton().element as HTMLButtonElement).disabled).toBe(true);
    await confirmButton().trigger('click');
    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1?purgeHistory=true')).toHaveLength(0);

    // Whitespace around the exact label still matches.
    await wrapper.find('[data-testid="purge-confirm-input"]').setValue('  Main ');
    expect((confirmButton().element as HTMLButtonElement).disabled).toBe(false);

    await confirmButton().trigger('click');
    await settle();

    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1?purgeHistory=true')).toHaveLength(1);
    // The account is gone from the backend's list and the selector, and
    // the selection moved to the remaining account.
    expect(backend.accounts.map((entry) => entry.id)).toEqual(['acc-2']);
    expect(wrapper.find('[data-testid="account-select"]').element.value).toBe('acc-2');
    expect(wrapper.find('[data-testid="account-card"]').find('h3').text()).toBe('Second');
  });

  it('purge cancel closes the panel and dispatches nothing', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="purge-button"]').trigger('click');
    await wrapper.find('[data-testid="purge-confirm-input"]').setValue('Main');
    await wrapper.find('[data-testid="purge-cancel"]').trigger('click');

    expect(wrapper.find('[data-testid="purge-confirm"]').exists()).toBe(false);
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('Escape closes the confirm panels and restores focus to the opener (task 181)', async () => {
    // The keyboard dismissal contract on the destructive surfaces:
    // Escape from either panel aborts (no request) and hands focus back
    // to the opener — the destructive button is never left unfocused
    // after a keyboard escape (D-164).
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    // Archive: focus sits on the safe control when the panel opens.
    await wrapper.find('[data-testid="archive-button"]').trigger('click');
    await settle();
    await wrapper.find('[data-testid="archive-confirm"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('[data-testid="archive-confirm"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="archive-button"]').element);

    // Purge: focus sits in the typed gate.
    await wrapper.find('[data-testid="purge-button"]').trigger('click');
    await settle();
    await wrapper.find('[data-testid="purge-confirm"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('[data-testid="purge-confirm"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="purge-button"]').element);
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('an IME composition Escape does not dismiss (the composition owns the key)', async () => {
    const backend = new FakeAccountsBackend([account()]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="archive-button"]').trigger('click');
    await settle();
    await wrapper
      .find('[data-testid="archive-confirm"]')
      .trigger('keydown', { key: 'Escape', isComposing: true });
    await settle();
    expect(wrapper.find('[data-testid="archive-confirm"]').exists()).toBe(true);
  });

  it('Escape during a pending mutation is ignored — the request owns the panel', async () => {
    // The review round's P2: resetting the call mid-flight would
    // suppress the outcome while the request still applies. The panel
    // stays until the request settles; the settled outcome behaves
    // normally (success closes, emits, and restores focus).
    const backend = new FakeAccountsBackend([account()]);
    backend.stallNext = (call) => call.method === 'PATCH' && call.input === '/api/accounts/acc-1';
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="rename-button"]').trigger('click');
    await wrapper.find('[data-testid="rename-input"]').setValue('Renamed');
    await wrapper.find('[data-testid="rename-save"]').trigger('submit');
    await flushPromises();

    await wrapper.find('[data-testid="rename-input"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(true);

    backend.unstall();
    await settle();
    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(false);
    expect(callsOf(backend, 'PATCH', '/api/accounts/acc-1')).toHaveLength(1);
    // The success path restores focus to the opener (task 181).
    expect(document.activeElement).toBe(wrapper.find('[data-testid="rename-button"]').element);
  });

  it('a removed account hands focus to the selector, not the body (task 181)', async () => {
    const backend = new FakeAccountsBackend([account(), account({ id: 'acc-2', label: 'Second' })]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="archive-button"]').trigger('click');
    await wrapper.find('[data-testid="archive-confirm-button"]').trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="archive-confirm"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="account-select"]').element);
  });

  it('presents a refused purge through the shared notice', async () => {
    const backend = new FakeAccountsBackend([account()]);
    backend.refuseNext = (call) =>
      call.method === 'DELETE' && call.input === '/api/accounts/acc-1?purgeHistory=true'
        ? envelope(500, 'INTERNAL', 'boom')
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="purge-button"]').trigger('click');
    await wrapper.find('[data-testid="purge-confirm-input"]').setValue('Main');
    await wrapper.find('[data-testid="purge-confirm-button"]').trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe(
      'INTERNAL',
    );
    expect(wrapper.find('[data-testid="purge-confirm"]').exists()).toBe(true);
  });

  it('the purge gate trims both sides — a padded label stays purgeable (D-135)', async () => {
    // A label with surrounding whitespace (however it came to exist) must
    // never make the typed confirmation unsatisfiable — an archived
    // account with one would otherwise be unpurgeable from the UI.
    const backend = new FakeAccountsBackend([account({ label: 'Main ' })]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="purge-button"]').trigger('click');
    await wrapper.find('[data-testid="purge-confirm-input"]').setValue('Main');
    expect(
      (wrapper.find('[data-testid="purge-confirm-button"]').element as HTMLButtonElement).disabled,
    ).toBe(false);

    await wrapper.find('[data-testid="purge-confirm-button"]').trigger('click');
    await settle();

    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1?purgeHistory=true')).toHaveLength(1);
    expect(backend.accounts).toHaveLength(0);
  });

  it('purges an archived account too (the §8.2 follow-up over retained history)', async () => {
    const backend = new FakeAccountsBackend([
      account({
        status: 'archived',
        archivedAt: 1,
        enabled: false,
        keySource: 'none',
        hasKey: false,
        keyMask: null,
      }),
    ]);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="purge-button"]').trigger('click');
    await wrapper.find('[data-testid="purge-confirm-input"]').setValue('Main');
    await wrapper.find('[data-testid="purge-confirm-button"]').trigger('click');
    await settle();

    expect(callsOf(backend, 'DELETE', '/api/accounts/acc-1?purgeHistory=true')).toHaveLength(1);
    expect(backend.accounts).toHaveLength(0);
    expect(wrapper.find('[data-testid="accounts-empty"]').exists()).toBe(true);
  });

  it('an archived account keeps only the purge action (§8.2 terminal)', async () => {
    const backend = new FakeAccountsBackend([
      account({
        status: 'archived',
        archivedAt: 1,
        enabled: false,
        keySource: 'none',
        hasKey: false,
        keyMask: null,
      }),
    ]);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="archived-notice"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="rename-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="toggle-polling"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="replace-key-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="archive-button"]').exists()).toBe(false);
    expect(
      (wrapper.find('[data-testid="test-button"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(wrapper.find('[data-testid="purge-button"]').exists()).toBe(true);
  });

  it('the archived account is marked in the selector options (text, not color)', async () => {
    const backend = new FakeAccountsBackend([account({ status: 'archived', archivedAt: 1 })]);
    const wrapper = await mountView(backend);

    expect(wrapper.find('option').text()).toBe(`Main (${en.accounts.card.statusArchived})`);
  });
});
