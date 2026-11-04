import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
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
import MetricHistoryChart from '../../ui/src/components/MetricHistoryChart.vue';
import { accountAttentionOf, type AccountAttention } from '../../ui/src/account-attention';
import type { ApiFetchResponse } from '../../ui/src/api/client';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { createAppRouter } from '../../ui/src/router';
import { createAppTheme } from '../../ui/src/theme';
import { en } from '../../ui/src/i18n/en';
import {
  FakeFetch,
  jsonResponse,
  healthyApiBody,
  healthyEventsBody,
  healthyHistoryBody,
  healthyPeakHoursBody,
  healthySettingsBody,
  neverRespond,
  type RecordedCall,
} from '../helpers/api';
import { MemoryThemeStorage, FakeThemeMedia } from '../helpers/theme';

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
 * A miniature overview service: the routes the page loads, over
 * in-memory programmable state, recording every dispatch. Since task
 * 174 the range-keyed routes (`/api/history`, `/api/events`) are part
 * of the served set, and the settings answer can be held back
 * (`settingsGate`) to pin the unknown-retention window.
 */
class FakeOverviewBackend {
  readonly fake: FakeFetch;
  accounts: AccountView[];
  providers: ProviderView[];
  status: StatusResponse;
  quotaByAccount: Map<string, QuotaResponse>;
  /** The retention the settings answer carries (task 174). */
  historyRetentionDays: number;
  /** While set, the settings route waits for this promise (the late-arrival arm). */
  settingsGate: Promise<void> | null = null;
  /** One-shot per-URL refusals (the failure arms); value = HTTP status. */
  refuseNext: ((call: RecordedCall) => number | undefined) | null = null;

  constructor(
    options: {
      accounts?: AccountView[];
      providers?: ProviderView[];
      status?: StatusResponse;
      quotaByAccount?: Map<string, QuotaResponse>;
      historyRetentionDays?: number;
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
    this.historyRetentionDays = options.historyRetentionDays ?? 365;
    this.fake = new FakeFetch((call) => Promise.resolve(this.route(call)));
  }

  get impl(): FakeFetch['impl'] {
    return this.fake.impl;
  }

  get calls(): RecordedCall[] {
    return this.fake.calls;
  }

  /** Every dispatched `/api/history` call, oldest first. */
  get historyCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.input.startsWith('/api/history?'));
  }

  /** Every dispatched `/api/events` call, oldest first. */
  get eventsCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.input.startsWith('/api/events?'));
  }

  /** Every dispatched `/api/peak-hours` call, oldest first (task 176). */
  get peakHoursCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.input.startsWith('/api/peak-hours?'));
  }

  private route(call: RecordedCall): ApiFetchResponse | Promise<ApiFetchResponse> {
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
      const answer = (): ReturnType<typeof jsonResponse> =>
        jsonResponse(200, healthySettingsBody(this.historyRetentionDays));
      return this.settingsGate === null ? answer() : this.settingsGate.then(answer);
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
    if (method === 'GET' && input.startsWith('/api/history?')) {
      return jsonResponse(200, healthyHistoryBody(input));
    }
    if (method === 'GET' && input.startsWith('/api/events?')) {
      return jsonResponse(200, healthyEventsBody(input));
    }
    if (method === 'GET' && input.startsWith('/api/peak-hours?')) {
      return jsonResponse(200, healthyPeakHoursBody(input));
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
  // Task 173: the view renders RouterLinks (the empty state's and the
  // attention notice's CTAs), so the mount carries a memory-history
  // router (the app-shell precedent). Task 175: the metric charts read
  // the theme controller (D-133's restyle trigger), so the mount carries
  // the theme plugin too — the shell always installs both.
  const router = createAppRouter(createMemoryHistory());
  const wrapper = mount(OverviewView, {
    attachTo: document.body,
    global: {
      plugins: [
        createAppI18n(),
        selection,
        router,
        createAppTheme({ storage, media: new FakeThemeMedia() }),
        createApiClientPlugin({ fetchImpl: backend.impl }),
      ],
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

    // Task 173 (D-138): the titled guidance block whose link is the
    // actionable next step — never a bare one-liner.
    const empty = wrapper.find('[data-testid="overview-empty"]');
    expect(empty.find('h3').text()).toBe(en.overview.empty.noAccountsTitle);
    expect(empty.find('p').text()).toBe(en.overview.empty.noAccountsHint);
    const cta = empty.find('[data-testid="overview-empty-cta"]');
    expect(cta.text()).toBe(en.overview.empty.cta);
    expect(cta.attributes('href')).toBe('/accounts');
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

/* ── The fresh-install matrix (task 173's done-condition) ─────────────── */

/**
 * Task 173 (spec §14.3/§14.6; decision D-138): a fresh install never
 * renders a blank or broken page. Every cell of the fresh-install
 * matrix mounts against the honest bodies that install shape serves
 * and pins BOTH halves of the done-condition: some guidance node
 * renders, and no failure notice does (a guidance surface that only
 * appears beside an `api-error` would be the broken page in disguise).
 */
describe('overview fresh-install matrix (task 173, D-138)', () => {
  function assertNoPageFailure(wrapper: VueWrapper): void {
    expect(
      wrapper.findAll('[data-testid="api-error"]'),
      'no load failure renders in a fresh-install cell',
    ).toHaveLength(0);
  }

  it('fresh init without accounts: the guidance block with its link, nothing else', async () => {
    // The complete fresh-install floor: no accounts, no providers
    // listed, no status rows — the page answers with the actionable
    // no-accounts block.
    const backend = new FakeOverviewBackend({
      accounts: [],
      providers: [],
      status: { status: 'ok', pollingIntervalSeconds: 300, accounts: [] },
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="overview-empty-cta"]').attributes('href')).toBe('/accounts');
    expect(wrapper.find('[data-testid="account-overview-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-attention"]').exists()).toBe(false);
    assertNoPageFailure(wrapper);
  });

  it('an account whose environment key is declared but unset: env-worded guidance, no link', async () => {
    // The reachable `Not configured` account (§7.3): `apiKeyEnv` names
    // a variable the process does not provide. `hasKey` is
    // declaration-level (a source IS configured, §6.3) — the wire
    // shape is `hasKey: true, keySource: 'environment'` and the
    // unresolvable-key signal is the §7.3 row's `not-configured`
    // (the review round's P1). Read-only through the API (§6.3), so
    // the remedy is server-side and the notice carries no link.
    const backend = new FakeOverviewBackend({
      accounts: [account({ keySource: 'environment' })],
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'not-configured' })],
      },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    const notice = wrapper.find('[data-testid="overview-attention"]');
    expect(notice.attributes('data-attention')).toBe('keyless-environment');
    expect(notice.text()).toBe(en.overview.attention.keylessEnvironment);
    expect(wrapper.find('[data-testid="overview-attention-cta"]').exists()).toBe(false);
    // The §14.6 badge names the state; the notice adds the remedy.
    expect(wrapper.find('[data-testid="status-badge"]').attributes('data-status')).toBe(
      'not-configured',
    );
    // The waiting sentence would promise a poll that never runs.
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').text()).toBe(
      en.overview.empty.noSnapshotBlocked,
    );
    assertNoPageFailure(wrapper);
  });

  it('an environment-keyed account with the status row still unknown claims nothing', async () => {
    // The §7.3 load has not completed: a `not-configured` row is the
    // only keyless evidence the wire carries, so no notice renders and
    // the status slots stay Unknown (172's absent-row rule) — the
    // page never announces a key problem it cannot vouch for.
    const backend = new FakeOverviewBackend({
      accounts: [account({ keySource: 'environment' })],
      status: { status: 'ok', pollingIntervalSeconds: 300, accounts: [] },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-attention"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-last-success"]').text()).toBe(
      en.overview.card.unknown,
    );
    assertNoPageFailure(wrapper);
  });

  it('a sourceless account shape: the schema-total fallback links to the fix-here remedy', async () => {
    // `hasKey: false` on an ACTIVE account is the schema-total
    // fallback no current composition produces (the config contract
    // rejects sourceless accounts; archived accounts read
    // `keySource: 'none'` and classify by the lifecycle above) — the
    // classifier still answers it honestly: set the key on the
    // Accounts page.
    const backend = new FakeOverviewBackend({
      accounts: [account({ hasKey: false, keySource: 'none', keyMask: null })],
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'not-configured' })],
      },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    const notice = wrapper.find('[data-testid="overview-attention"]');
    expect(notice.attributes('data-attention')).toBe('keyless');
    expect(notice.find('p').text()).toBe(en.overview.attention.keyless);
    const cta = wrapper.find('[data-testid="overview-attention-cta"]');
    expect(cta.attributes('href')).toBe('/accounts');
    expect(cta.text()).toBe(en.overview.attention.cta);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').text()).toBe(
      en.overview.empty.noSnapshotBlocked,
    );
    assertNoPageFailure(wrapper);
  });

  it('a disabled account: the notice links to re-enabling, blocked line, badge agrees', async () => {
    const backend = new FakeOverviewBackend({
      accounts: [account({ enabled: false })],
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'disabled' })],
      },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    const notice = wrapper.find('[data-testid="overview-attention"]');
    expect(notice.attributes('data-attention')).toBe('disabled');
    expect(notice.find('p').text()).toBe(en.overview.attention.disabled);
    expect(wrapper.find('[data-testid="overview-attention-cta"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="status-badge"]').attributes('data-status')).toBe('disabled');
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').text()).toBe(
      en.overview.empty.noSnapshotBlocked,
    );
    assertNoPageFailure(wrapper);
  });

  it('an archived account outranks the disabled/keyless facts its wire shape carries', async () => {
    // The archived wire shape reads `enabled: false`, `hasKey: false`,
    // `keySource: 'none'` — all three blockers at once — and §7.3
    // derives `disabled` for it. The archived notice is the fuller
    // story and wins the precedence (D-138).
    const backend = new FakeOverviewBackend({
      accounts: [
        account({
          status: 'archived',
          enabled: false,
          hasKey: false,
          keySource: 'none',
          keyMask: null,
          archivedAt: 1,
        }),
      ],
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'disabled' })],
      },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    const notice = wrapper.find('[data-testid="overview-attention"]');
    expect(notice.attributes('data-attention')).toBe('archived');
    expect(notice.find('p').text()).toBe(en.overview.attention.archived);
    expect(wrapper.find('[data-testid="overview-attention-cta"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').text()).toBe(
      en.overview.empty.noSnapshotBlocked,
    );
    assertNoPageFailure(wrapper);
  });

  it('an archived account with retained history renders its values beside the notice', async () => {
    // §8.2/D-130: archived history stays served — the notice explains
    // the stopped polling without displacing the collected facts.
    const collectedAt = Date.now() - 7 * 24 * 3_600_000;
    const backend = new FakeOverviewBackend({
      accounts: [
        account({
          status: 'archived',
          enabled: false,
          hasKey: false,
          keySource: 'none',
          archivedAt: 1,
        }),
      ],
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'disabled', lastSuccessAt: collectedAt })],
      },
      quotaByAccount: new Map([
        ['acc-1', quota({ collectedAt, planName: 'Max20', metrics: [metric({ collectedAt })] })],
      ]),
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-attention"]').attributes('data-attention')).toBe(
      'archived',
    );
    expect(ddOf(cardOf(wrapper, 'tokens-5h'), 'metric-limit')).toBe('150,000 credits');
    // A snapshot exists: no absence line renders at all.
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').exists()).toBe(false);
    assertNoPageFailure(wrapper);
  });

  it('a healthy keyed account before its first poll: waiting wording, no notice', async () => {
    // The pre-sync storage shape (`createdAt` null — the row has not
    // been mirrored yet) beside the honest empty quota view: §7.3 says
    // `Collecting`, §7.2 says `Never`, and the metrics region states
    // the waiting fact — no blocker, so no notice and no blocked line.
    const backend = new FakeOverviewBackend({
      accounts: [account({ createdAt: null })],
      status: {
        status: 'ok',
        pollingIntervalSeconds: 300,
        accounts: [statusRow({ status: 'collecting' })],
      },
      quotaByAccount: new Map([['acc-1', quota()]]),
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-attention"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').text()).toBe(
      en.overview.empty.noSnapshot,
    );
    expect(wrapper.find('[data-testid="status-badge"]').text()).toBe(en.overview.status.collecting);
    expect(wrapper.find('[data-testid="overview-last-success"]').text()).toBe(
      en.overview.card.never,
    );
    assertNoPageFailure(wrapper);
  });

  it('a registry-empty build degrades to raw ids and keys — never a blank region', async () => {
    // The degradation case beside the matrix: an empty providers
    // catalog (D-137's fallback path — the empty-catalog variant of
    // the failed-providers load, not a fresh-install state: a real
    // install registers its adapters) still renders provider names
    // and metric labels verbatim from the wire.
    const backend = new FakeOverviewBackend({
      providers: [],
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="overview-provider"]').text()).toBe('zai-coding-plan');
    expect(cardOf(wrapper, 'tokens-5h').find('h4').text()).toBe('tokens-5h');
    assertNoPageFailure(wrapper);
  });

  it('the initial load renders the loading line — never an empty block, never an error', async () => {
    // The "initial" half of the task: the accounts list never answers,
    // so the page's honest first paint is the loading line alone (the
    // review round's P2 — the line had never been pinned).
    // `neverRespond()` is a thunk factory — invoke it for the promise.
    const stalled = new FakeFetch((call) =>
      call.input === '/api/accounts'
        ? neverRespond()()
        : Promise.resolve(jsonResponse(200, healthyApiBody(call.input))),
    );
    const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
    const wrapper = mount(OverviewView, {
      attachTo: document.body,
      global: {
        plugins: [
          createAppI18n(),
          selection,
          createAppRouter(createMemoryHistory()),
          createApiClientPlugin({ fetchImpl: stalled.impl }),
        ],
      },
    });
    wrappers.push(wrapper);
    await settle();

    expect(wrapper.find('[data-testid="overview-loading"]').text()).toBe(en.overview.loading);
    expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-attention"]').exists()).toBe(false);
    assertNoPageFailure(wrapper);
  });

  it('a pending quota renders the quota-loading line with no absence wording', async () => {
    // The selected account's quota never answers: the identity card
    // renders, the metrics region states the pending fact, and none
    // of the absence wordings render (absence is a LOADED fact).
    const stalled = new FakeFetch((call) => {
      if (call.input.startsWith('/api/quota')) return neverRespond()();
      if (call.input === '/api/accounts') {
        return Promise.resolve(jsonResponse(200, { accounts: [account()] }));
      }
      if (call.input === '/api/providers') {
        return Promise.resolve(jsonResponse(200, { providers: PROVIDERS }));
      }
      if (call.input === '/api/status') {
        return Promise.resolve(
          jsonResponse(200, {
            status: 'ok',
            pollingIntervalSeconds: 300,
            accounts: [statusRow()],
          }),
        );
      }
      // Everything else routes through the healthy per-route bodies —
      // task 174's events load included (a catch-all settings body is
      // the one-shape lie the trusted casts choke on).
      return Promise.resolve(jsonResponse(200, healthyApiBody(call.input)));
    });
    const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
    const wrapper = mount(OverviewView, {
      attachTo: document.body,
      global: {
        plugins: [
          createAppI18n(),
          selection,
          createAppRouter(createMemoryHistory()),
          createApiClientPlugin({ fetchImpl: stalled.impl }),
        ],
      },
    });
    wrappers.push(wrapper);
    await settle();

    expect(wrapper.find('[data-testid="account-overview-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="overview-quota-loading"]').text()).toBe(en.overview.loading);
    expect(wrapper.find('[data-testid="metric-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-snapshot"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overview-no-metrics"]').exists()).toBe(false);
    assertNoPageFailure(wrapper);
  });
});

/* ── The attention classifier's truth table (D-138's precedence) ──────── */

describe('accountAttentionOf (the D-138 precedence, pure)', () => {
  const CASES: ReadonlyArray<{
    label: string;
    view: AccountView;
    row: StatusAccountView | null;
    expected: AccountAttention | null;
  }> = [
    {
      label: 'archived — the terminal lifecycle outranks every switch',
      view: account({ status: 'archived', enabled: false, hasKey: false, keySource: 'none' }),
      row: statusRow({ status: 'disabled' }),
      expected: 'archived',
    },
    {
      label: 'disabled — the operator switch',
      view: account({ enabled: false }),
      row: statusRow({ status: 'disabled' }),
      expected: 'disabled',
    },
    {
      // The reachable keyless shape (the review round's P1): declared
      // (`hasKey: true`) but unresolved — only the §7.3 row knows.
      label: 'keyless-environment — declared but unresolved, the reachable shape',
      view: account({ keySource: 'environment' }),
      row: statusRow({ status: 'not-configured' }),
      expected: 'keyless-environment',
    },
    {
      label: 'keyless-environment is NOT claimed while the row is unknown',
      view: account({ keySource: 'environment' }),
      row: null,
      expected: null,
    },
    {
      label: 'an env-sourced key with a resolving row is healthy',
      view: account({ keySource: 'environment' }),
      row: statusRow({ status: 'fresh' }),
      expected: null,
    },
    {
      // A `not-configured` row on a file-sourced account cannot happen
      // on the wire (a declared file key always resolves); the
      // classifier discriminates on `keySource` rather than claiming
      // the environment wording for any not-configured row.
      label: 'a not-configured row on a file-sourced account claims no environment remedy',
      view: account({ keySource: 'file' }),
      row: statusRow({ status: 'not-configured' }),
      expected: null,
    },
    {
      // The `hasKey: false` active shape is the schema-total fallback
      // no current composition produces — still answered honestly.
      label: 'keyless — the schema-total sourceless fallback',
      view: account({ hasKey: false, keySource: 'none' }),
      row: null,
      expected: 'keyless',
    },
    {
      label: 'null — a healthy account',
      view: account(),
      row: statusRow(),
      expected: null,
    },
  ];

  it.each(CASES)('$label', ({ view, row, expected }) => {
    expect(accountAttentionOf(view, row)).toBe(expected);
  });

  it('mirrors §7.3: the operator switch outranks the key state', () => {
    // A disabled account without a key derives `disabled` (§7.3's
    // rank 0a over 0b); the classifier agrees — enabling it later is
    // the outermost remedy.
    expect(
      accountAttentionOf(
        account({ enabled: false, hasKey: false, keySource: 'none' }),
        statusRow({ status: 'disabled' }),
      ),
    ).toBe('disabled');
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
        plugins: [
          createAppI18n(),
          selection,
          createAppRouter(createMemoryHistory()),
          createApiClientPlugin({ fetchImpl: failing.impl }),
        ],
      },
    });
    wrappers.push(wrapper);
    await settle();

    const notices = wrapper.findAll('[data-testid="api-error"]');
    // Four loads fail — the list, providers, status, and settings. The
    // target-keyed loads (quota, timeline, peak-hours) fire only once an
    // account is selected, which a failed list never produces.
    expect(notices.length).toBe(4);
    for (const notice of notices) {
      expect(notice.text()).toBe(en.errors.network);
    }
    expect(wrapper.find('[data-testid="overview-empty"]').exists()).toBe(false);
  });
});

/* ── Task 174: the §14.4 rolling-range controls (decision D-147) ──────── */

/**
 * The task-174 done-condition, executable (spec §14.4; decision
 * D-147): the five rolling ranges render at the D-137 seam, the chosen
 * range is passed to the server as D-139’s ISO-8601 grammar (a rolling
 * window ending now, §10 — exact absolute-duration bounds, no zone),
 * retention-aware disabling explains itself, and the range-keyed loads
 * (history series + account timeline) re-run on selection, range, and
 * refresh changes — with the shared failure surface when they fail.
 */

/** ISO 8601 UTC at millisecond precision with the `Z` designator. */
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The parsed range parameters of one dispatched history/events call. */
function rangeParamsOf(call: RecordedCall): {
  accountId: string;
  metric: string | null;
  from: string;
  to: string;
  hasMaxPoints: boolean;
} {
  const prefix = ['/api/history?', '/api/events?', '/api/peak-hours?'].find((candidate) =>
    call.input.startsWith(candidate),
  );
  const params = new URLSearchParams(call.input.slice(prefix!.length));
  return {
    accountId: params.get('accountId') ?? '',
    metric: params.get('metric'),
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    hasMaxPoints: params.has('maxPoints'),
  };
}

/** The exact span a dispatched window covers, in ms. */
function spanOf(call: RecordedCall): number {
  const { from, to } = rangeParamsOf(call);
  return Date.parse(to) - Date.parse(from);
}

describe('overview rolling-range controls (task 174, D-147)', () => {
  it('mounts the control at the D-137 seam: identity card, range controls, metrics, charts', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    const wrapper = await mountView(backend);

    expect(
      wrapper
        .findAll(
          '[data-testid="account-overview-card"], [data-testid="history-range"], [data-testid="overview-metrics"], [data-testid="overview-charts"]',
        )
        .map((node) => node.attributes('data-testid')),
    ).toEqual(['account-overview-card', 'history-range', 'overview-metrics', 'overview-charts']);
    // The refresh affordance sits beside the control (D-137’s loose
    // end, discharged): re-anchoring the rolling window.
    expect(wrapper.find('[data-testid="overview-refresh"]').exists()).toBe(true);
    // Task 175: the charts region renders one chart card per metric.
    expect(wrapper.findAll('[data-testid="metric-chart"]')).toHaveLength(1);
  });

  it('passes the default 7-day rolling window to every metric series in D-139’s grammar', async () => {
    const beforeMount = Date.now();
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({ metricKey: 'mcp-monthly', collectedAt: 1 }),
              metric({ metricKey: 'tokens-5h', collectedAt: 1 }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);

    // The §14.4 default is checked.
    const checked = wrapper.find('[data-range-id="7d"] input');
    expect((checked.element as HTMLInputElement).checked).toBe(true);
    // Task 175: one chart card per metric (D-147's per-metric extension).
    expect(
      wrapper
        .findAll('[data-testid="metric-chart"]')
        .map((card) => card.attributes('data-metric-key')),
    ).toEqual(['mcp-monthly', 'tokens-5h']);

    // Each metric's series request: the account, its own metric key, the
    // 7-day window as exact ISO-Z bounds ending now, no maxPoints
    // (§13’s server-side default applies).
    const seriesParams = backend.historyCalls.map((call) => rangeParamsOf(call));
    expect(seriesParams.map((params) => params.metric)).toEqual(['mcp-monthly', 'tokens-5h']);
    for (const params of seriesParams) {
      expect(params.accountId).toBe('acc-1');
      expect(params.from).toMatch(ISO_Z);
      expect(params.to).toMatch(ISO_Z);
      expect(params.hasMaxPoints).toBe(false);
      expect(Date.parse(params.to)).toBeGreaterThanOrEqual(beforeMount);
      expect(Date.parse(params.to)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(params.from)).toBe(Date.parse(params.to) - 7 * 86_400_000);
    }

    // The timeline request: account-level (no metric filter), the same
    // window shape.
    const events = backend.eventsCalls.at(-1);
    expect(events, 'an events request was dispatched').toBeDefined();
    const eventsParams = rangeParamsOf(events!);
    expect(eventsParams.accountId).toBe('acc-1');
    expect(eventsParams.metric).toBeNull();
    expect(spanOf(events!)).toBe(7 * 86_400_000);
  });

  it('dispatches no history request without a metric vocabulary; the timeline still loads', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ collectedAt: null, metrics: [] })]]),
    });
    const wrapper = await mountView(backend);

    // No snapshot ⇒ no metric keys ⇒ nothing to request a series FOR.
    expect(backend.historyCalls.length).toBe(0);
    // The §12.2 timeline states account-level facts — it still loads,
    // for the same 7-day default window.
    expect(backend.eventsCalls.length).toBeGreaterThan(0);
    expect(rangeParamsOf(backend.eventsCalls[0]!).accountId).toBe('acc-1');
    // The control renders regardless — the range is selectable before
    // any data exists.
    expect(wrapper.find('[data-testid="history-range"]').exists()).toBe(true);
  });

  it('re-dispatches with the new window on a range change; a disabled option never dispatches', async () => {
    const backend = new FakeOverviewBackend({
      historyRetentionDays: 7,
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    const wrapper = await mountView(backend);

    // Retention 7: the 14/30-day options are disabled, each with its
    // explanation as text; the default stays selectable.
    expect(wrapper.find('[data-range-id="14d"] [data-testid="history-range-reason"]').text()).toBe(
      en.overview.range.disabledReason.replace('{days}', '7'),
    );
    expect(wrapper.find('[data-range-id="7d"] [data-testid="history-range-reason"]').exists()).toBe(
      false,
    );

    await wrapper.find('[data-range-id="24h"] input').setChecked();
    await settle();
    const last = backend.historyCalls.at(-1);
    expect(last, 'the 24-hour window was dispatched').toBeDefined();
    expect(spanOf(last!)).toBe(24 * 3_600_000);
    const eventsLast = backend.eventsCalls.at(-1);
    expect(spanOf(eventsLast!)).toBe(24 * 3_600_000);

    // The disabled 30-day option is inert — no dispatch, no selection.
    const dispatched = backend.historyCalls.length;
    await wrapper.find('[data-range-id="30d"] input').trigger('change');
    await settle();
    expect(backend.historyCalls.length).toBe(dispatched);
    expect((wrapper.find('[data-range-id="30d"] input').element as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('falls back to the default range when a late retention disables the selection', async () => {
    const backend = new FakeOverviewBackend({
      historyRetentionDays: 7,
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    let releaseSettings!: () => void;
    backend.settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const wrapper = await mountView(backend);

    // While retention is unknown nothing is disabled: 30 days is an
    // honest request (the server’s range report stays the authority).
    expect(wrapper.find('[data-testid="history-range-reason"]').exists()).toBe(false);
    await wrapper.find('[data-range-id="30d"] input').setChecked();
    await settle();
    expect(spanOf(backend.historyCalls.at(-1)!)).toBe(30 * 86_400_000);

    // Retention 7 arrives: the selection reverts to the §14.4 default
    // (always selectable — §11.3’s minimum retention equals it), the
    // window re-dispatches as 7 days, and the disabled option explains
    // itself.
    releaseSettings();
    await settle();
    expect((wrapper.find('[data-range-id="7d"] input').element as HTMLInputElement).checked).toBe(
      true,
    );
    expect(spanOf(backend.historyCalls.at(-1)!)).toBe(7 * 86_400_000);
    expect(wrapper.find('[data-range-id="30d"] [data-testid="history-range-reason"]').text()).toBe(
      en.overview.range.disabledReason.replace('{days}', '7'),
    );
  });

  it('re-dispatches both loads for the newly selected account', async () => {
    const backend = new FakeOverviewBackend({
      accounts: [account(), account({ id: 'acc-2', label: 'Second' })],
      quotaByAccount: new Map([
        ['acc-1', quota({ metrics: [metric({ metricKey: 'tokens-5h', collectedAt: 1 })] })],
        [
          'acc-2',
          quota({ metrics: [metric({ metricKey: 'weekly-quota', collectedAt: 1 })] }, 'acc-2'),
        ],
      ]),
    });
    const wrapper = await mountView(backend);
    expect(rangeParamsOf(backend.historyCalls.at(-1)!)).toMatchObject({
      accountId: 'acc-1',
      metric: 'tokens-5h',
    });

    await wrapper.find('[data-testid="overview-account-select"]').setValue('acc-2');
    await settle();

    // Both range-keyed loads re-ran for the new account — the series
    // once the new metric vocabulary arrived, the timeline immediately.
    expect(rangeParamsOf(backend.historyCalls.at(-1)!)).toMatchObject({
      accountId: 'acc-2',
      metric: 'weekly-quota',
    });
    expect(rangeParamsOf(backend.eventsCalls.at(-1)!)).toMatchObject({ accountId: 'acc-2' });
  });

  it('presents a refused history load beside its own retry, and the retry recovers', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    backend.refuseNext = (call) => (call.input.startsWith('/api/history?') ? 500 : undefined);
    const wrapper = await mountView(backend);

    // Task 175: the per-metric series failure renders inside its chart
    // card, with the card's own named retry (D-137's distinct-name rule).
    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    const retry = wrapper.find('[data-testid="chart-retry"]');
    expect(retry.text()).toBe(`Retry loading the 5-hour token quota history`);
    const dispatched = backend.historyCalls.length;

    await retry.trigger('click');
    await settle();
    expect(backend.historyCalls.length).toBe(dispatched + 1);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('presents a refused timeline load beside its own retry, and the retry recovers', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    backend.refuseNext = (call) => (call.input.startsWith('/api/events?') ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    const retry = wrapper.find('[data-testid="overview-retry-events"]');
    expect(retry.text()).toBe(en.overview.retryEvents);
    const dispatched = backend.eventsCalls.length;

    await retry.trigger('click');
    await settle();
    expect(backend.eventsCalls.length).toBe(dispatched + 1);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('dispatches the peak-hours load range-keyed in D-139’s grammar (task 176, D-149)', async () => {
    const beforeMount = Date.now();
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    await mountView(backend);

    // The §9.3 schedule load: the same account/window grammar as the
    // timeline, account-level (no metric parameter exists for it).
    expect(backend.peakHoursCalls.length).toBeGreaterThan(0);
    const params = new URLSearchParams(
      backend.peakHoursCalls[0]!.input.slice('/api/peak-hours?'.length),
    );
    expect(params.get('accountId')).toBe('acc-1');
    expect(params.get('metric')).toBeNull();
    expect(params.has('maxPoints')).toBe(false);
    const from = Date.parse(params.get('from') ?? '');
    const to = Date.parse(params.get('to') ?? '');
    expect(from).toBe(to - 7 * 86_400_000);
    expect(to).toBeGreaterThanOrEqual(beforeMount);
  });

  it('re-runs the peak-hours load on range changes and account switches', async () => {
    const backend = new FakeOverviewBackend({
      accounts: [account(), account({ id: 'acc-2', label: 'Second' })],
      quotaByAccount: new Map([
        ['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })],
        ['acc-2', quota({ metrics: [metric({ collectedAt: 1 })] }, 'acc-2')],
      ]),
    });
    const wrapper = await mountView(backend);
    expect(backend.peakHoursCalls).toHaveLength(1);

    await wrapper.find('[data-range-id="24h"] input').setChecked();
    await settle();
    expect(backend.peakHoursCalls).toHaveLength(2);
    expect(spanOf(backend.peakHoursCalls[1]!)).toBe(24 * 3_600_000);

    await wrapper.find('[data-testid="overview-account-select"]').setValue('acc-2');
    await settle();
    expect(backend.peakHoursCalls).toHaveLength(3);
    expect(rangeParamsOf(backend.peakHoursCalls[2]!).accountId).toBe('acc-2');
  });

  it('presents a refused peak-hours load beside its own named retry, and the retry recovers', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    backend.refuseNext = (call) => (call.input.startsWith('/api/peak-hours?') ? 500 : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    const retry = wrapper.find('[data-testid="overview-retry-peak-hours"]');
    // The distinct accessible name (D-137): the schedule's retry says
    // which load failed, apart from the timeline's.
    expect(retry.text()).toBe(en.overview.retryPeakHours);
    const dispatched = backend.peakHoursCalls.length;

    await retry.trigger('click');
    await settle();
    expect(backend.peakHoursCalls.length).toBe(dispatched + 1);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('a failed refresh keeps the previous annotations flowing to the chart cards (D-135/D-149)', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    const wrapper = await mountView(backend);
    const card = wrapper.findComponent(MetricHistoryChart);
    expect(card.exists()).toBe(true);
    // The healthy first loads reach the card as props.
    expect(card.props('events')).toMatchObject({ accountId: 'acc-1' });
    expect(card.props('peaks')).toMatchObject({ providerId: 'zai-coding-plan' });

    // The next timeline load fails: the refresh renders its notice while
    // the kept copy keeps the previous annotations at the cards — never
    // a silently blanked chart (D-135's rule, the cards' own precedent).
    backend.refuseNext = (call) => (call.input.startsWith('/api/events?') ? 500 : undefined);
    await wrapper.find('[data-testid="overview-refresh"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="overview-retry-events"]').exists()).toBe(true);
    expect(card.props('events')).toMatchObject({ accountId: 'acc-1' });
    expect(card.props('peaks')).toMatchObject({ providerId: 'zai-coding-plan' });

    // The schedule's kept copy behaves the same under its own failure.
    backend.refuseNext = (call) => (call.input.startsWith('/api/peak-hours?') ? 500 : undefined);
    await wrapper.find('[data-testid="overview-refresh"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="overview-retry-peak-hours"]').exists()).toBe(true);
    expect(card.props('peaks')).toMatchObject({ providerId: 'zai-coding-plan' });
  });

  it('refresh re-runs the account’s data loads and re-anchors the rolling window', async () => {
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([['acc-1', quota({ metrics: [metric({ collectedAt: 1 })] })]]),
    });
    const wrapper = await mountView(backend);
    const quotaCalls = () =>
      backend.calls.filter((call) => call.input.startsWith('/api/quota?')).length;
    const before = {
      quota: quotaCalls(),
      history: backend.historyCalls.length,
      events: backend.eventsCalls.length,
      peaks: backend.peakHoursCalls.length,
    };
    const firstTo = Date.parse(rangeParamsOf(backend.historyCalls.at(-1)!).to);

    await wrapper.find('[data-testid="overview-refresh"]').trigger('click');
    await settle();

    // Exactly one more of each account-scoped load — the range never
    // changed, so the watchers stayed quiet; the explicit refresh ran.
    expect(quotaCalls()).toBe(before.quota + 1);
    expect(backend.historyCalls.length).toBe(before.history + 1);
    expect(backend.eventsCalls.length).toBe(before.events + 1);
    expect(backend.peakHoursCalls.length).toBe(before.peaks + 1);
    // The window re-anchored: the refreshed `to` is not before the old.
    expect(Date.parse(rangeParamsOf(backend.historyCalls.at(-1)!).to)).toBeGreaterThanOrEqual(
      firstTo,
    );
    // And the refreshed span is still the selected 7 days.
    expect(spanOf(backend.historyCalls.at(-1)!)).toBe(7 * 86_400_000);
  });

  it('refresh re-runs every metric series once (the per-metric refresh)', async () => {
    // Two metric cards: the refresh token each card watches fires once
    // per card — +2 series dispatches, one per metric (D-148).
    const backend = new FakeOverviewBackend({
      quotaByAccount: new Map([
        [
          'acc-1',
          quota({
            metrics: [
              metric({ metricKey: 'mcp-monthly', collectedAt: 1 }),
              metric({ metricKey: 'tokens-5h', collectedAt: 1 }),
            ],
          }),
        ],
      ]),
    });
    const wrapper = await mountView(backend);
    const before = backend.historyCalls.length;
    const metricsBefore = backend.historyCalls
      .slice(-2)
      .map((call) => rangeParamsOf(call).metric)
      .sort();

    await wrapper.find('[data-testid="overview-refresh"]').trigger('click');
    await settle();

    expect(backend.historyCalls.length).toBe(before + 2);
    expect(
      backend.historyCalls
        .slice(-2)
        .map((call) => rangeParamsOf(call).metric)
        .sort(),
    ).toEqual(metricsBefore);
  });
});
