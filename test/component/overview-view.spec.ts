import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountView } from '../../src/schemas/api/accounts';
import type { ProviderView } from '../../src/schemas/api/providers';
import {
  ACCOUNT_STATUS_TOKENS,
  type AccountStatusToken,
  type MetricView,
  type QuotaResponse,
  type StatusAccountView,
  type StatusResponse,
} from '../../src/schemas/api/status';
import OverviewView from '../../ui/src/views/OverviewView.vue';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { en } from '../../ui/src/i18n/en';
import { FakeFetch, jsonResponse, healthySettingsBody, type RecordedCall } from '../helpers/api';
import { MemoryThemeStorage } from '../helpers/theme';

/**
 * The task-172 done-condition, executable (spec §14.3/§8.4/§14.6; decision
 * D-137): the overview renders the selected account's identity, §7.3
 * status, and §7.2 recents, and one card per metric of its last-valid
 * quota row set — with EVERY partial or missing value rendered honestly
 * (an explicit Unknown, never zero, never blank) across the §8.4 shape
 * matrix, and every §14.6 status rendered as text + tone (never color
 * alone). The page is mounted against a miniature overview backend on
 * the injectable fetch seam (the D-134 hermetic pattern): no network, no
 * browser globals, hostile zero-plausible fixtures per case.
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

/** The provider with the D-137 catalog the real Z.ai adapter declares. */
const PROVIDERS: ProviderView[] = [
  {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan',
    peakHours: null,
    metrics: [
      { metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' },
      { metricKey: 'tokens-5h', label: '5-hour token quota' },
      { metricKey: 'weekly-quota', label: 'Weekly quota' },
    ],
  },
];

function statusRow(overrides: Partial<StatusAccountView> = {}): StatusAccountView {
  return { id: 'acc-1', status: 'fresh', lastSuccessAt: null, lastError: null, ...overrides };
}

function metric(overrides: Partial<MetricView> = {}): MetricView {
  return {
    metricKey: 'tokens-5h',
    limitType: 'ROLLING_WINDOW',
    unit: 'CREDITS',
    windowSeconds: 18_000,
    used: 120_000,
    remaining: 30_000,
    limit: 150_000,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: null,
    isValid: true,
    invalidReason: null,
    derivedFields: null,
    collectedAt: 0,
    ...overrides,
  };
}

function quota(overrides: Partial<QuotaResponse> = {}, accountId = 'acc-1'): QuotaResponse {
  return {
    accountId,
    status: 'fresh',
    collectedAt: null,
    planName: null,
    metrics: [],
    ...overrides,
  };
}

/**
 * A miniature overview service: the five routes the page loads, over
 * in-memory programmable state, recording every dispatch.
 */
class FakeOverviewBackend {
  readonly fake: FakeFetch;
  accounts: AccountView[];
  providers: ProviderView[];
  status: StatusResponse;
  quotaByAccount: Map<string, QuotaResponse>;
  /** One-shot per-URL refusals (the failure arms); value = HTTP status. */
  refuseNext: ((call: RecordedCall) => number | undefined) | null = null;

  constructor(
    options: {
      accounts?: AccountView[];
      providers?: ProviderView[];
      status?: StatusResponse;
      quotaByAccount?: Map<string, QuotaResponse>;
    } = {},
  ) {
    this.accounts = options.accounts ?? [account()];
    this.providers = options.providers ?? PROVIDERS;
    this.status = options.status ?? {
      status: 'ok',
      pollingIntervalSeconds: 300,
      accounts: [statusRow()],
    };
    this.quotaByAccount = options.quotaByAccount ?? new Map();
    this.fake = new FakeFetch((call) => Promise.resolve(this.route(call)));
  }

  get impl(): FakeFetch['impl'] {
    return this.fake.impl;
  }

  get calls(): RecordedCall[] {
    return this.fake.calls;
  }

  private route(call: RecordedCall): ReturnType<typeof jsonResponse> {
    const refusal = this.refuseNext?.(call);
    if (refusal !== undefined) {
      this.refuseNext = null;
      return jsonResponse(refusal, {
        error: { code: 'INTERNAL', message: 'refused by the test', details: null },
      });
    }
    const { method, input } = call;
    if (method === 'GET' && input === '/api/accounts') {
      return jsonResponse(200, { accounts: this.accounts });
    }
    if (method === 'GET' && input === '/api/providers') {
      return jsonResponse(200, { providers: this.providers });
    }
    if (method === 'GET' && input === '/api/status') {
      return jsonResponse(200, this.status);
    }
    if (method === 'GET' && input === '/api/settings') {
      return jsonResponse(200, healthySettingsBody());
    }
    if (method === 'GET' && input.startsWith('/api/quota?')) {
      const id = new URLSearchParams(input.slice('/api/quota?'.length)).get('accountId') ?? '';
      const body = this.quotaByAccount.get(id);
      if (body === undefined) {
        return jsonResponse(404, {
          error: { code: 'NOT_FOUND', message: 'Account not found', details: null },
        });
      }
      return jsonResponse(200, body);
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'no route', details: null } });
  }
}

/* ── Mount helpers ────────────────────────────────────────────────────── */

const wrappers: VueWrapper[] = [];

async function mountView(
  backend: FakeOverviewBackend,
  storage: MemoryThemeStorage = new MemoryThemeStorage(),
): Promise<VueWrapper> {
  const selection = createAccountSelection({ storage });
  const wrapper = mount(OverviewView, {
    attachTo: document.body,
    global: {
      plugins: [createAppI18n(), selection, createApiClientPlugin({ fetchImpl: backend.impl })],
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

/** Drain the async chains (load → reconcile → selection-keyed quota load). */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

function cardOf(wrapper: VueWrapper, metricKey: string): VueWrapper {
  const card = wrapper
    .findAll('[data-testid="metric-card"]')
    .find((element) => element.attributes('data-metric-key') === metricKey);
  expect(card, `metric card '${metricKey}' renders`).toBeDefined();
  return card!;
}

function ddOf(card: VueWrapper, testid: string): string {
  return card.find(`[data-testid="${testid}"]`).text();
}

/* ── The §8.4 honesty matrix (the done-condition) ─────────────────────── */

describe('overview metric cards: the §8.4 value matrix renders honestly', () => {
  it('renders a full metric with explicit units, quota type, window, and reset', async () => {
    const resetsAt = Date.now() + 2 * 3_600_000 + 5 * 60_000;
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        ['acc-1', quota({ planName: 'Max20', collectedAt: 1, metrics: [metric({ resetsAt })] })],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'tokens-5h');
    // The label comes from the provider's declared catalog (D-137).
    expect(card.find('h4').text()).toBe('5-hour token quota');
    expect(card.find('.quota-type').text()).toBe('Rolling window · 5-hour window');
    // Every value carries its explicit unit (§14.3) — exact strings.
    expect(ddOf(card, 'metric-used')).toBe('120,000 credits');
    expect(ddOf(card, 'metric-remaining')).toBe('30,000 credits');
    expect(ddOf(card, 'metric-limit')).toBe('150,000 credits');
    // The reset renders absolute + relative to now.
    const resetLine = card.find('.reset').text();
    expect(resetLine).toContain('Resets:');
    expect(resetLine).toContain('(in 2 hours)');
  });

  it('renders a genuine zero as zero — the hostile null/zero pair', async () => {
    // The zero-plausible hostile fixture: used is ABSENT (must render
    // Unknown, never 0) while remaining is a GENUINE zero (must render
    // as 0 — substituting "Unknown" there would be equally dishonest).
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [metric({ used: null, percentUsed: null, remaining: 0, limit: 150_000 })],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'tokens-5h');
    expect(ddOf(card, 'metric-used')).toBe(en.overview.metric.unknown);
    expect(ddOf(card, 'metric-used')).not.toContain('0');
    expect(ddOf(card, 'metric-remaining')).toBe('0 credits');
    expect(ddOf(card, 'metric-limit')).toBe('150,000 credits');
  });

  it('renders a percent-only metric as percentages — never inferred counts', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({
                metricKey: 'weekly-quota',
                limitType: 'WEEKLY',
                unit: 'PERCENT',
                windowSeconds: null,
                used: null,
                remaining: null,
                limit: null,
                percentUsed: 42,
                percentRemaining: 58,
              }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'weekly-quota');
    expect(card.find('.quota-type').text()).toBe('Weekly');
    // §8.4: percent-only metrics show percentages; §14.3: no token
    // counts inferred from them; the limit has no percentage form.
    expect(ddOf(card, 'metric-used')).toBe('42%');
    expect(ddOf(card, 'metric-remaining')).toBe('58%');
    expect(ddOf(card, 'metric-limit')).toBe(en.overview.metric.unknown);
    // No absolute-unit token leaks into a percent-only card.
    expect(card.text()).not.toContain('tokens');
    expect(card.text()).not.toContain('credits');
  });

  it('renders a limit-only metric with Unknown for the absent pair', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({
                metricKey: 'mcp-monthly',
                limitType: 'MONTHLY',
                unit: 'REQUESTS',
                windowSeconds: null,
                used: null,
                remaining: null,
                limit: 17_000,
                percentUsed: null,
                percentRemaining: null,
              }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'mcp-monthly');
    expect(card.find('h4').text()).toBe('Monthly MCP tool quota');
    expect(card.find('.quota-type').text()).toBe('Monthly');
    expect(ddOf(card, 'metric-used')).toBe(en.overview.metric.unknown);
    expect(ddOf(card, 'metric-remaining')).toBe(en.overview.metric.unknown);
    expect(ddOf(card, 'metric-limit')).toBe('17,000 requests');
  });

  it('renders an invalid metric with its reason and no numeric lines (§8.4)', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({
                isValid: false,
                invalidReason: 'currentValue is not a number',
                used: null,
                remaining: null,
                limit: null,
                percentUsed: null,
                percentRemaining: null,
              }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'tokens-5h');
    expect(card.find('[data-testid="metric-invalid"]').text()).toBe(
      'Invalid reading: currentValue is not a number',
    );
    // An invalid metric carries no values (§8.4): no value lines render
    // at all — not "0", not Unknown placeholders, the reason IS the line.
    expect(card.find('[data-testid="metric-used"]').exists()).toBe(false);
    expect(card.find('[data-testid="metric-limit"]').exists()).toBe(false);
  });

  it('renders the per-field percentage fallback on a mixed metric', async () => {
    // The §14.3 ladder per field: `used` absent but its percentage
    // present renders the percentage (a different unit, labeled as
    // such); `remaining`/`limit` present render their absolutes.
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({
                used: null,
                remaining: 30_000,
                limit: 150_000,
                percentUsed: 80,
                percentRemaining: 20,
              }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'tokens-5h');
    expect(ddOf(card, 'metric-used')).toBe('80%');
    expect(ddOf(card, 'metric-remaining')).toBe('30,000 credits');
    expect(ddOf(card, 'metric-limit')).toBe('150,000 credits');
  });

  it('omits the reset line and the window phrase when the metric declares neither', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({
                limitType: 'MONTHLY',
                unit: 'REQUESTS',
                windowSeconds: null,
                resetsAt: null,
              }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = cardOf(wrapper, 'tokens-5h');
    // §14.3's own "if available": an absent reset omits the line; a
    // non-rolling metric carries no window phrase.
    expect(card.find('.reset').exists()).toBe(false);
    expect(card.find('.quota-type').text()).toBe('Monthly');
    expect(card.text()).not.toContain('window');
  });

  it('falls back to the raw metric key when no catalog entry declares it', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        ['acc-1', quota({ metrics: [metric({ metricKey: 'mystery-metric' })] })],
      ]),
    });
    const wrapper = await mountView(backend);

    // D-137's honest fallback: the stable adapter-defined key, verbatim.
    expect(cardOf(wrapper, 'mystery-metric').find('h4').text()).toBe('mystery-metric');
  });

  it('renders the honest no-snapshot state — never zeros, never a blank card', async () => {
    const backend = new FakeOverviewBackend({
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'collecting' })],
      },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="metric-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').text()).toBe(
      en.overview.empty.noSnapshot,
    );
    // Identity still renders, with the plan's explicit Unknown.
    expect(wrapper.find('[data-testid="overview-plan"]').text()).toBe(en.overview.card.planUnknown);
  });

  it('tells a zero-metric snapshot apart from no snapshot (the P2 pin)', async () => {
    // A successful snapshot whose entries the adapter recognized as no
    // metric (the skip path) has a collection stamp but no rows — a
    // different fact from "no successful collection yet".
    const collectedAt = Date.now() - 3_600_000;
    const backend = new FakeOverviewBackend({
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'fresh', lastSuccessAt: collectedAt })],
      },
      quotaByAccount: new Map([['acc-1', quota({ collectedAt, planName: 'Max20', metrics: [] })]]),
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="metric-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-metrics"]').text()).toBe(
      en.overview.empty.noMetrics,
    );
    // The collection fact renders from the status row.
    expect(wrapper.find('[data-testid="overview-last-success"]').text()).toContain('1 hour ago');
  });
});

/* ── The identity card: §14.3 facts and §14.6 statuses ────────────────── */

describe('overview identity card (§14.3/§14.6)', () => {
  it('shows provider name, account label, plan, last success, and last error', async () => {
    const collectedAt = Date.now() - 2 * 3_600_000 - 5 * 60_000;
    const errorAt = Date.now() - 3_600_000 - 5 * 60_000;
    const backend = new FakeOverviewBackend({
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [
          statusRow({
            status: 'unreachable',
            lastSuccessAt: collectedAt,
            lastError: {
              outcome: 'network_error',
              message: 'fetch failed: connection refused',
              at: errorAt,
            },
          }),
        ],
      },
      quotaByAccount: new Map([
        ['acc-1', quota({ planName: 'Max20', collectedAt, metrics: [metric({ collectedAt })] })],
      ]),
    });
    const wrapper = await mountView(backend);

    const card = wrapper.find('[data-testid="account-overview-card"]');
    expect(card.find('h3').text()).toBe('Main');
    expect(wrapper.find('[data-testid="overview-provider"]').text()).toBe('Z.ai Coding Plan');
    expect(wrapper.find('[data-testid="overview-plan"]').text()).toBe('Max20');
    // §7.2's two most-recents: the successful collection renders
    // absolute + relative; the error renders outcome + message + time.
    expect(wrapper.find('[data-testid="overview-last-success"]').text()).toContain('(2 hours ago)');
    const errorText = wrapper.find('[data-testid="overview-last-error"]').text();
    expect(errorText).toContain('(1 hour ago)');
    expect(errorText).toContain(en.overview.error.outcome.networkError);
    expect(errorText).toContain('fetch failed: connection refused');
  });

  it('renders Never and None for an account without any collection', async () => {
    const backend = new FakeOverviewBackend({
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'not-configured' })],
      },
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-last-success"]').text()).toBe(
      en.overview.card.never,
    );
    expect(wrapper.find('[data-testid="overview-last-error"]').text()).toBe(
      en.overview.card.noError,
    );
  });

  it.each([...ACCOUNT_STATUS_TOKENS])(
    'renders the %s status as its exact label plus its tone — never color alone (§14.1)',
    async (token: AccountStatusToken) => {
      // The exact label AND the expected tone: a mis-wired label or a
      // wrong tone must fail (the review round's P3).
      const expectedLabel: Record<AccountStatusToken, string> = {
        fresh: en.overview.status.fresh,
        collecting: en.overview.status.collecting,
        unreachable: en.overview.status.unreachable,
        'auth-rejected': en.overview.status.authRejected,
        stale: en.overview.status.stale,
        'format-changed': en.overview.status.formatChanged,
        disabled: en.overview.status.disabled,
        'not-configured': en.overview.status.notConfigured,
      };
      const expectedTone: Record<AccountStatusToken, string> = {
        fresh: 'tone-ok',
        collecting: 'tone-pending',
        stale: 'tone-warn',
        unreachable: 'tone-error',
        'auth-rejected': 'tone-error',
        'format-changed': 'tone-error',
        disabled: 'tone-neutral',
        'not-configured': 'tone-neutral',
      };
      const backend = new FakeOverviewBackend({
        status: {
          status: 'ok',
          pollingIntervalSeconds: 300,
          accounts: [statusRow({ status: token })],
        },
      });
      const wrapper = await mountView(backend);

      const badge = wrapper.find('[data-testid="status-badge"]');
      expect(badge.attributes('data-status')).toBe(token);
      // The label is real text (the signal); the tone class and the
      // CSS-drawn marker are the supplements (§14.1).
      expect(badge.text()).toBe(expectedLabel[token]);
      expect(badge.classes()).toContain(expectedTone[token]);
      expect(badge.find('.marker').exists()).toBe(true);
    },
  );

  it('renders Unknown — never Never/None — while the status row is unknown (the P1 pin)', async () => {
    // A failed §7.3 load leaves the row absent: the card must not
    // assert "Never — no successful collection yet" or "None" as facts
    // no loaded row vouches for — the explicit Unknown is the honest
    // render beside the failure notice.
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ planName: 'Max20' })]]),
    });
    backend.refuseNext = (call) => (call.input === '/api/status' ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-last-success"]').text()).toBe(
      en.overview.card.unknown,
    );
    expect(wrapper.find('[data-testid="overview-last-error"]').text()).toBe(
      en.overview.card.unknown,
    );
    expect(wrapper.find('[data-testid="status-badge"]').exists()).toBe(false);
    // "Never"/"None" assert facts only a LOADED row with nulls may state.
    expect(wrapper.find('[data-testid="overview-last-success"]').text()).not.toBe(
      en.overview.card.never,
    );
  });
});

/* ── Selection, reconciliation, and the quota lifecycle ───────────────── */

describe('overview selection (the D-135 consumer rule)', () => {
  it('selects the first account, renders its quota, and persists switches', async () => {
    const backend = new FakeOverviewBackend({
      accounts: [account(), account({ id: 'acc-2', label: 'Second', providerId: 'other-plan' })],
      quotaByAccount: new Map([
        ['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })],
        [
          'acc-2',
          quota(
            {
              accountId: 'acc-2',
              planName: 'Lite',
              metrics: [
                metric({
                  metricKey: 'mcp-monthly',
                  limitType: 'MONTHLY',
                  unit: 'REQUESTS',
                  windowSeconds: null,
                  used: 5,
                  remaining: null,
                  limit: null,
                  percentUsed: null,
                  percentRemaining: null,
                  collectedAt: 1,
                }),
              ],
            },
            'acc-2',
          ),
        ],
      ]),
    });
    const storage = new MemoryThemeStorage();
    const wrapper = await mountView(backend, storage);

    const select = wrapper.find('[data-testid="overview-account-select"]');
    expect(select.element.value).toBe('acc-1');
    expect(cardOf(wrapper, 'tokens-5h')).toBeDefined();

    await select.setValue('acc-2');
    await settle();

    expect(storage.getItem('quotameter.selected-account')).toBe('acc-2');
    // The quota re-requested for the new account…
    expect(backend.calls.some((call) => call.input === '/api/quota?accountId=acc-2')).toBe(true);
    // …the previous account's values are GONE — no cross-account staleness.
    expect(
      wrapper
        .findAll('[data-testid="metric-card"]')
        .map((card) => card.attributes('data-metric-key')),
    ).toEqual(['mcp-monthly']);
    expect(ddOf(cardOf(wrapper, 'mcp-monthly'), 'metric-used')).toBe('5 requests');
  });

  it('honors a stored selection and dispatches no quota for a stale one (the P2 pin)', async () => {
    // A stored id the list still contains is honored as-is; a stored id
    // the list no longer contains dispatches NO quota request (the
    // honest 404 it would earn never flashes) and reconciliation moves
    // the selection to the first listed account.
    const honored = new FakeOverviewBackend({
      accounts: [account(), account({ id: 'acc-2', label: 'Second' })],
      quotaByAccount: new Map([['acc-2', quota({ planName: 'Second' })]]),
    });
    const wrapper = await mountView(
      honored,
      new MemoryThemeStorage({ 'quotameter.selected-account': 'acc-2' }),
    );
    expect(wrapper.find('[data-testid="overview-account-select"]').element.value).toBe('acc-2');
    expect(honored.calls.some((call) => call.input === '/api/quota?accountId=acc-2')).toBe(true);

    const stale = new FakeOverviewBackend({
      accounts: [account(), account({ id: 'acc-2', label: 'Second' })],
      quotaByAccount: new Map([['acc-1', quota({ planName: 'Main' })]]),
    });
    const wrapper2 = await mountView(
      stale,
      new MemoryThemeStorage({ 'quotameter.selected-account': 'purged-elsewhere' }),
    );
    await settle();
    expect(wrapper2.find('[data-testid="overview-account-select"]').element.value).toBe('acc-1');
    // The stale id never reached the wire; the reconciled first
    // account's quota did.
    expect(stale.calls.some((call) => call.input.includes('purged-elsewhere'))).toBe(false);
    expect(stale.calls.some((call) => call.input === '/api/quota?accountId=acc-1')).toBe(true);
    expect(wrapper2.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('renders the honest empty state when no accounts exist', async () => {
    const backend = new FakeOverviewBackend({ accounts: [] });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-empty"]').text()).toBe(
      en.overview.empty.noAccounts,
    );
    expect(wrapper.find('[data-testid="account-overview-card"]').exists()).toBe(false);
    // No quota request is dispatched without a selected account.
    expect(backend.calls.some((call) => call.input.startsWith('/api/quota'))).toBe(false);
  });

  it('marks archived accounts in the selector with text, not color', async () => {
    const backend = new FakeOverviewBackend({
      accounts: [account(), account({ id: 'acc-2', label: 'Old', status: 'archived' })],
    });
    const wrapper = await mountView(backend);

    expect(
      wrapper
        .find('[data-testid="overview-account-select"]')
        .findAll('option')
        .map((o) => o.text()),
    ).toEqual(['Main', `Old (${en.overview.selector.archivedOption})`]);
  });
});

/* ── Failure surfaces: honest notices, kept last-good data ────────────── */

describe('overview failure surfaces (D-134/D-135 rules)', () => {
  it('a failed quota load renders the notice with a working retry', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    backend.refuseNext = (call) => (call.input.startsWith('/api/quota') ? 500 : undefined);
    const wrapper = await mountView(backend);

    // The failure renders through the shared notice (the envelope's own
    // message never does), with no values and no fake empty state —
    // and the identity card still renders beside it.
    const notice = wrapper.find('[data-testid="api-error"]');
    expect(notice.text()).toBe(en.errors.codes.internal);
    expect(wrapper.find('[data-testid="metric-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-overview-card"]').exists()).toBe(true);

    backend.refuseNext = null;
    await wrapper.find('[data-testid="overview-retry-quota"]').trigger('click');
    await settle();

    // The retry re-runs the same account's load; success clears the
    // notice and renders the values.
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    expect(ddOf(cardOf(wrapper, 'tokens-5h'), 'metric-limit')).toBe('150,000 credits');
  });

  it('a failed accounts load renders the notice with a working retry — never a fake empty', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    backend.refuseNext = (call) => (call.input === '/api/accounts' ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    // A failed load is never an empty list (D-135): no selector, no
    // card, and above all no empty state.
    expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-overview-card"]').exists()).toBe(false);

    backend.refuseNext = null;
    await wrapper.find('[data-testid="overview-retry-list"]').trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-overview-card"]').exists()).toBe(true);
    expect(ddOf(cardOf(wrapper, 'tokens-5h'), 'metric-limit')).toBe('150,000 credits');
  });

  it('a failed status load renders its notice without breaking the identity card', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ planName: 'Max20' })]]),
    });
    backend.refuseNext = (call) => (call.input === '/api/status' ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    expect(wrapper.find('[data-testid="overview-provider"]').text()).toBe('Z.ai Coding Plan');
    expect(wrapper.find('[data-testid="overview-plan"]').text()).toBe('Max20');
  });

  it('a failed settings load degrades to the browser zone beside its notice', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        ['acc-1', quota({ metrics: [metric({ collectedAt: Date.now() })] })],
      ]),
    });
    backend.refuseNext = (call) => (call.input === '/api/settings' ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    // The card still renders with collected lines — in the fallback zone.
    const card = cardOf(wrapper, 'tokens-5h');
    expect(card.find('.collected').text()).toContain('Collected:');
  });

  it('a failed providers load renders raw ids and keys — never invented names', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    backend.refuseNext = (call) => (call.input === '/api/providers' ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-provider"]').text()).toBe('zai-coding-plan');
    expect(cardOf(wrapper, 'tokens-5h').find('h4').text()).toBe('tokens-5h');
  });

  it('a network-level failure presents the shared network notice per load', async () => {
    // Every load rejects at fetch level: each presents the shared
    // sentence — no fake empty state anywhere.
    const failing = new FakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
    const wrapper = mount(OverviewView, {
      attachTo: document.body,
      global: {
        plugins: [createAppI18n(), selection, createApiClientPlugin({ fetchImpl: failing.impl })],
      },
    });
    wrappers.push(wrapper);
    await settle();

    const notices = wrapper.findAll('[data-testid="api-error"]');
    // Four loads fail (the quota fires only once an account is selected,
    // which a failed list never produces).
    expect(notices.length).toBe(4);
    for (const notice of notices) {
      expect(notice.text()).toBe(en.errors.network);
    }
    expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(false);
  });
});
