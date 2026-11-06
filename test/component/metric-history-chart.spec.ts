import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EventsResponse,
  HistoryPointItem,
  HistoryRangeReport,
  HistoryResponse,
} from '../../src/schemas/api/history';
import type { PeakHoursResponse } from '../../src/schemas/api/peak-hours';
import type { MetricUnit } from '../../src/schemas/metrics';
import MetricHistoryChart from '../../ui/src/components/MetricHistoryChart.vue';
import { createApiClientPlugin } from '../../ui/src/api';
import { formatChartDate } from '../../ui/src/format';
import { historyRangeIsoBounds } from '../../ui/src/history-range';
import {
  CHART_RUNTIME_KEY,
  cssTokenReader,
  type ChartDataZoomEvent,
  type ChartDataZoomResetAction,
  type ChartHandle,
  type ChartRuntime,
} from '../../ui/src/charts/runtime';
import {
  CHART_X_ZOOM_ID,
  MIN_ZOOM_SPAN_MS,
  type MetricChartOption,
} from '../../ui/src/charts/series';
import { createChartSync, type ChartSync } from '../../ui/src/charts/sync';
import { createAppI18n } from '../../ui/src/i18n';
import { en } from '../../ui/src/i18n/en';
import { createAppTheme, type ThemeController } from '../../ui/src/theme';
import { FakeFetch, jsonResponse, neverRespond, type RecordedCall } from '../helpers/api';
import { FakeThemeMedia, MemoryThemeStorage } from '../helpers/theme';

/**
 * The §14.4 metric chart card, mounted (task 175; decision D-148): the
 * per-metric range-keyed load in D-139's grammar, the §14.4 view toggle,
 * the states (loading/empty/rejected/truncated/failure+retry), the live
 * theme restyle (D-133), and the instance lifecycle. The ECharts runtime
 * is the injected seam — the recording fake below keeps echarts itself
 * out of happy-dom (it cannot boot there) while every option the card
 * builds is asserted through it; the TOKEN reader is the production one
 * over live inline custom properties, so the token plumbing is real.
 *
 * Task 176 (D-149): the annotation props (the page's events/peaks loads)
 * flow into the option — this metric's resets only, the account-level
 * strip, the served peak bands — and the aria summary states the mark
 * counts as text.
 *
 * Task 178 (D-153): the card joins the page's cursor/zoom group (the
 * `syncGroup` the create call carries), reports its `dataZoom` events to
 * the coordinator, re-densifies its ticks over the zoom span while the
 * axes keep the requested bounds, resets its own zoom on a refresh, and
 * hands its handle to the coordinator after the first option lands.
 */

/* ── The recording chart runtime ───────────────────────────────────────── */

interface RecordedSetOption {
  readonly option: MetricChartOption;
  readonly opts?: { readonly notMerge?: boolean; readonly replaceMerge?: readonly string[] };
}

class RecordingChartHandle implements ChartHandle {
  readonly setOptions: RecordedSetOption[] = [];
  readonly actions: ChartDataZoomResetAction[] = [];
  readonly dataZoomHandlers: Array<(payload: ChartDataZoomEvent) => void> = [];
  resized = 0;
  disposed = false;

  setOption(
    option: MetricChartOption,
    opts?: { readonly notMerge?: boolean; readonly replaceMerge?: readonly string[] },
  ): void {
    this.setOptions.push({ option, opts });
  }

  resize(): void {
    this.resized += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  on(_event: 'dataZoom', handler: (payload: ChartDataZoomEvent) => void): void {
    this.dataZoomHandlers.push(handler);
  }

  off(_event: 'dataZoom', handler: (payload: ChartDataZoomEvent) => void): void {
    const index = this.dataZoomHandlers.indexOf(handler);
    if (index >= 0) this.dataZoomHandlers.splice(index, 1);
  }

  dispatchAction(action: ChartDataZoomResetAction): void {
    this.actions.push(action);
  }

  /** Fires one `dataZoom` event the way the real runtime would. */
  emitDataZoom(payload: ChartDataZoomEvent): void {
    for (const handler of [...this.dataZoomHandlers]) handler(payload);
  }
}

class RecordingChartRuntime implements ChartRuntime {
  readonly handles: RecordingChartHandle[] = [];
  readonly hosts: HTMLElement[] = [];
  /** The sync group each created chart was asked to join (D-153). */
  readonly syncGroups: (string | undefined)[] = [];

  createChart(element: HTMLElement, options?: { readonly syncGroup?: string }): ChartHandle {
    const handle = new RecordingChartHandle();
    this.handles.push(handle);
    this.hosts.push(element);
    this.syncGroups.push(options?.syncGroup);
    return handle;
  }

  readToken = cssTokenReader;
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const T1 = T0 + 3_600_000;

function point(
  overrides: Partial<Extract<HistoryPointItem, { kind: 'point' }>> = {},
): HistoryPointItem {
  return {
    kind: 'point',
    collectedAt: T0,
    used: 120_000,
    remaining: 30_000,
    limit: 150_000,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: null,
    isValid: true,
    invalidReason: null,
    ...overrides,
  };
}

function historyBody(
  input: string,
  options: {
    points?: HistoryPointItem[];
    unit?: MetricUnit | null;
    range?: Partial<HistoryRangeReport>;
  } = {},
): HistoryResponse {
  const params = new URLSearchParams(input.slice('/api/history?'.length));
  const requestedFrom = Date.parse(params.get('from') ?? '');
  const requestedTo = Date.parse(params.get('to') ?? '');
  return {
    accountId: params.get('accountId') ?? '',
    metric: params.get('metric') ?? '',
    unit: options.unit === undefined ? 'CREDITS' : options.unit,
    limitType: 'ROLLING_WINDOW',
    range: {
      outcome: 'ok',
      requestedFrom,
      requestedTo,
      effectiveFrom: requestedFrom,
      effectiveTo: requestedTo,
      retentionHorizon: null,
      ...options.range,
    },
    downsampled: false,
    resolutionMs: null,
    sourcePointCount: options.points?.length ?? 0,
    points: options.points ?? [],
  };
}

/** One served answer per request: a body, a refusal status, or a stall. */
type Serve = (
  input: string,
) => { status: number; body: unknown } | { body: unknown } | { stall: true };

function backendOf(serve: Serve): FakeFetch {
  return new FakeFetch((call) => {
    const answer = serve(call.input);
    if ('stall' in answer) return neverRespond()();
    return Promise.resolve(
      'status' in answer
        ? jsonResponse(answer.status, answer.body)
        : jsonResponse(200, answer.body),
    );
  });
}

/** The query params of one served request URL (the serve-side parse). */
function queryParamsOf(input: string): URLSearchParams {
  return new URLSearchParams(input.slice('/api/history?'.length));
}

const INTERNAL_ENVELOPE = { error: { code: 'INTERNAL', message: 'refused', details: null } };

/** The light/dark inline token sets — the values `base.css` declares. */
const LIGHT_TOKENS: Readonly<Record<string, string>> = {
  '--qm-chart-used': '#1b4fa0',
  '--qm-chart-remaining': '#1e6b33',
  '--qm-chart-peak': '#5b4fa8',
  '--qm-chart-reset': '#9a3e63',
  '--qm-chart-gap': '#5a5a64',
  '--qm-chart-stopped': '#8a5800',
  '--qm-color-danger': '#b3261e',
  '--qm-color-muted': '#5a5a64',
  '--qm-color-muted-background': '#efeff2',
  '--qm-color-background': '#ffffff',
  '--qm-color-foreground': '#1b1b1f',
  '--qm-font-family': 'system-ui-test',
};
const DARK_TOKENS: Readonly<Record<string, string>> = {
  '--qm-chart-used': '#8ab4f8',
  '--qm-chart-remaining': '#9fdcae',
  '--qm-chart-peak': '#a5a1e8',
  '--qm-chart-reset': '#e2a4c0',
  '--qm-chart-gap': '#a9a9b3',
  '--qm-chart-stopped': '#e8c179',
  '--qm-color-danger': '#f2b8b5',
  '--qm-color-muted': '#a9a9b3',
  '--qm-color-muted-background': '#26262c',
  '--qm-color-background': '#17171b',
  '--qm-color-foreground': '#ececf1',
  '--qm-font-family': 'system-ui-test',
};

function applyTokens(tokens: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value);
  }
}

/* ── Mount helpers ─────────────────────────────────────────────────────── */

const wrappers: VueWrapper[] = [];

interface MountOptions {
  readonly serve: Serve;
  readonly props?: Partial<{
    accountId: string;
    metricKey: string;
    label: string;
    rangeId: '24h' | '3d' | '7d' | '14d' | '30d';
    timeZone: string;
    refreshToken: number;
    sync: ChartSync;
    events: EventsResponse | null;
    peaks: PeakHoursResponse | null;
  }>;
  readonly controller?: ThemeController;
}

async function mountChart(options: MountOptions): Promise<{
  wrapper: VueWrapper;
  runtime: RecordingChartRuntime;
  calls: RecordedCall[];
  controller: ThemeController;
  sync: ChartSync;
}> {
  const runtime = new RecordingChartRuntime();
  const sync = options.props?.sync ?? createChartSync();
  const controller =
    options.controller ??
    createAppTheme({ storage: new MemoryThemeStorage(), media: new FakeThemeMedia() });
  const fake = backendOf(options.serve);
  const wrapper = mount(MetricHistoryChart, {
    attachTo: document.body,
    props: {
      accountId: 'acc-1',
      metricKey: 'tokens-5h',
      label: '5-hour token quota',
      rangeId: '7d',
      timeZone: 'UTC',
      refreshToken: 0,
      sync,
      ...options.props,
    },
    global: {
      plugins: [createAppI18n(), controller, createApiClientPlugin({ fetchImpl: fake.impl })],
      provide: { [CHART_RUNTIME_KEY as symbol]: runtime },
    },
  });
  wrappers.push(wrapper);
  await settle();
  return { wrapper, runtime, calls: fake.calls, controller, sync };
}

async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  for (const name of Object.keys(LIGHT_TOKENS)) {
    document.documentElement.style.removeProperty(name);
  }
  vi.unstubAllGlobals();
});

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function historyParams(call: RecordedCall): URLSearchParams {
  return new URLSearchParams(call.input.slice('/api/history?'.length));
}

/** A dual-view series (both families present) — the toggle's fixture. */
const DUAL_POINTS: HistoryPointItem[] = [
  point({ collectedAt: T0 }),
  point({
    collectedAt: T1,
    used: 100_000,
    remaining: 50_000,
    percentUsed: 66.67,
    percentRemaining: 33.33,
  }),
];

/* ── Task 176: the annotation prop fixtures ────────────────────────────── */

/**
 * Instants guaranteed inside the card's own rolling window (the card
 * clamps annotations to the window its history response requests — fixed
 * epochs would drift out of it as the calendar moves).
 */
function windowInstants(): { inside: number; later: number } {
  const { from, to } = historyRangeIsoBounds('7d', Date.now());
  const start = Date.parse(from);
  const end = Date.parse(to);
  const inside = Math.floor((start + end) / 2);
  return { inside, later: inside + 600_000 };
}

/** The events range report: the same rolling window the card requests. */
function eventsRange(): EventsResponse['range'] {
  const { from, to } = historyRangeIsoBounds('7d', Date.now());
  return {
    outcome: 'ok',
    requestedFrom: Date.parse(from),
    requestedTo: Date.parse(to),
    effectiveFrom: Date.parse(from),
    effectiveTo: Date.parse(to),
    retentionHorizon: null,
  };
}

/** The window-relative instants the annotation fixtures share (one clock read). */
type WindowInstants = ReturnType<typeof windowInstants>;

/** An events prop fixture over the four §12.2 kinds (D-139's wire shape). */
function eventsProp(instants: WindowInstants): EventsResponse {
  const { inside, later } = instants;
  return {
    accountId: 'acc-1',
    metric: null,
    range: eventsRange(),
    events: [
      {
        kind: 'reset',
        metricKey: 'tokens-5h',
        eventAt: inside,
        runId: 7,
        details: { reason: 'usage-decreased' },
      },
      {
        kind: 'reset',
        metricKey: 'mcp-monthly',
        eventAt: inside,
        runId: 7,
        details: { reason: 'usage-decreased' },
      },
      {
        kind: 'collection_error',
        outcome: 'rate_limited',
        fromEpochMs: later,
        toEpochMs: later + 5_000,
        durationMs: 5_000,
        httpStatus: 429,
        message: 'slow down',
        attempts: 3,
        retryAfterSeconds: 30,
      },
    ],
  };
}

/** A peaks prop fixture: one evening peak plus the off-peak complement. */
function peaksProp(instants: WindowInstants): PeakHoursResponse {
  const { inside, later } = instants;
  return {
    accountId: 'acc-1',
    providerId: 'zai-coding-plan',
    timezone: 'Asia/Shanghai',
    offPeakMultiplier: 0.75,
    range: eventsRange(),
    intervals: [
      {
        kind: 'peak',
        start: inside,
        end: later,
        multiplier: 1.5,
        windowId: 'evening',
        name: 'Evening',
        localStart: '2026-11-02T17:00',
        localEnd: '2026-11-02T18:00',
      },
      {
        kind: 'off-peak',
        start: later,
        end: later + 3_600_000,
        multiplier: 0.75,
        localStart: '2026-11-02T18:00',
        localEnd: '2026-11-02T19:00',
      },
    ],
  };
}

/* ── The load: D-139's grammar, per metric ─────────────────────────────── */

describe('metric chart: the per-metric range-keyed load (D-147/D-139)', () => {
  it('dispatches one series request in D-139’s grammar for its own metric', async () => {
    const beforeMount = Date.now();
    const { calls } = await mountChart({ serve: (input) => ({ body: historyBody(input) }) });

    expect(calls).toHaveLength(1);
    const params = historyParams(calls[0]!);
    expect(params.get('accountId')).toBe('acc-1');
    expect(params.get('metric')).toBe('tokens-5h');
    expect(params.get('from')).toMatch(ISO_Z);
    expect(params.get('to')).toMatch(ISO_Z);
    // §13's server-side maxPoints default applies — no client budget.
    expect(params.has('maxPoints')).toBe(false);
    expect(Date.parse(params.get('to')!)).toBeGreaterThanOrEqual(beforeMount);
    expect(Date.parse(params.get('from')!)).toBe(Date.parse(params.get('to')!) - 7 * 86_400_000);
  });

  it('re-dispatches with fresh bounds when the range prop changes', async () => {
    const { wrapper, calls } = await mountChart({
      serve: (input) => ({ body: historyBody(input) }),
    });
    expect(calls).toHaveLength(1);

    await wrapper.setProps({ rangeId: '24h' });
    await settle();

    expect(calls).toHaveLength(2);
    const params = historyParams(calls[1]!);
    expect(Date.parse(params.get('to')!) - Date.parse(params.get('from')!)).toBe(24 * 3_600_000);
  });

  it('re-dispatches on the refresh token while keeping the last-good chart (D-135)', async () => {
    const { wrapper, runtime, calls } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    const dispatched = calls.length;

    await wrapper.setProps({ refreshToken: 1 });
    await settle();

    expect(calls).toHaveLength(dispatched + 1);
    // The previous chart stays rendered — no dispose/recreate churn.
    expect(handle.disposed).toBe(false);
    expect(runtime.handles).toHaveLength(1);
  });

  it('keeps the last-good chart beside the notice when a refresh fails (D-135)', async () => {
    applyTokens(LIGHT_TOKENS);
    let refuse = false;
    const { wrapper, runtime } = await mountChart({
      serve: (input) =>
        refuse
          ? { status: 500, body: INTERNAL_ENVELOPE }
          : { body: historyBody(input, { points: DUAL_POINTS }) },
    });
    const handle = runtime.handles[0]!;
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(true);

    refuse = true;
    await wrapper.setProps({ refreshToken: 1 });
    await settle();

    // The failure renders its notice AND the previous chart stays —
    // `useApiCall` nulls `data` on error; the card's kept copy renders.
    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    expect(handle.disposed).toBe(false);
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(true);

    // And a recovered refresh replaces the kept chart with fresh data.
    refuse = false;
    await wrapper.find('[data-testid="chart-retry"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('clears the kept copy on a range switch — one window never renders for another', async () => {
    applyTokens(LIGHT_TOKENS);
    let stall = false;
    const { wrapper } = await mountChart({
      serve: (input) =>
        stall ? { stall: true } : { body: historyBody(input, { points: DUAL_POINTS }) },
    });
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(true);

    stall = true;
    await wrapper.setProps({ rangeId: '3d' });
    await settle();

    // The reset cleared the kept copy with the query identity: the
    // pending state renders, never the previous window's chart.
    expect(wrapper.find('[data-testid="chart-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(false);
  });
});

/* ── Rendering and the §14.4 toggle ────────────────────────────────────── */

describe('metric chart: rendering and the percent/absolute toggle (§14.4)', () => {
  it('renders the used/remaining pair on one absolute axis with the toggle available', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });

    expect(wrapper.find('[data-testid="chart-view-toggle"]').exists()).toBe(true);
    expect(runtime.handles).toHaveLength(1);
    const handle = runtime.handles[0]!;
    expect(handle.setOptions.length).toBeGreaterThan(0);
    const first = handle.setOptions[0]!;
    // D-148's deferred follow-through (D-153): merge-mode updates — the
    // count-varying families replace, the interaction state persists.
    expect(first.opts).toEqual({ replaceMerge: ['series', 'xAxis', 'yAxis', 'grid'] });

    // The done-condition's construction: ONE value axis, one unit —
    // both series plot absolute credits fields.
    expect(first.option.yAxis).toHaveLength(1);
    expect(first.option.yAxis[0]!.name).toBe(en.overview.metric.unit.credits);
    expect(first.option.series.map((series) => series.name)).toEqual([
      en.overview.chart.seriesUsed,
      en.overview.chart.seriesRemaining,
    ]);
    expect(first.option.series[0]?.data).toEqual([
      [T0, 120_000],
      [T1, 100_000],
    ]);
  });

  it('switches to the percent view on the toggle: the % axis, percent fields', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    const before = handle.setOptions.length;

    await wrapper.find('[data-testid="chart-view-percent"]').setValue();
    await settle();

    expect(handle.setOptions.length).toBeGreaterThan(before);
    const last = handle.setOptions.at(-1)!.option;
    expect(last.yAxis[0]!.name).toBe('%');
    expect(last.yAxis[0]!.min).toBe(0);
    expect(last.yAxis[0]!.max).toBe(100);
    expect(last.series[0]?.data).toEqual([
      [T0, 80],
      [T1, 66.67],
    ]);
  });

  it('a percentage-only metric renders percentages — no toggle, no absolute axis (§14.4)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({
        body: historyBody(input, {
          unit: 'PERCENT',
          points: [
            point({
              collectedAt: T0,
              used: null,
              remaining: null,
              limit: null,
              percentUsed: 42,
              percentRemaining: 58,
            }),
            point({
              collectedAt: T1,
              used: null,
              remaining: null,
              limit: null,
              percentUsed: 50,
              percentRemaining: 50,
            }),
          ],
        }),
      }),
    });

    // The toggle never renders for a metric without both views.
    expect(wrapper.find('[data-testid="chart-view-toggle"]').exists()).toBe(false);
    const option = runtime.handles[0]!.setOptions[0]!.option;
    expect(option.yAxis[0]!.name).toBe('%');
    expect(option.yAxis[0]!.min).toBe(0);
    expect(option.yAxis[0]!.max).toBe(100);
    expect(option.series[0]?.data).toEqual([
      [T0, 42],
      [T1, 50],
    ]);
  });

  it('an absolute-only metric stays absolute with no toggle', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({
        body: historyBody(input, {
          points: DUAL_POINTS.map((entry) =>
            entry.kind === 'point'
              ? { ...entry, percentUsed: null, percentRemaining: null }
              : entry,
          ),
        }),
      }),
    });

    expect(wrapper.find('[data-testid="chart-view-toggle"]').exists()).toBe(false);
    const option = runtime.handles[0]!.setOptions[0]!.option;
    expect(option.yAxis[0]!.name).toBe(en.overview.metric.unit.credits);
    expect(option.yAxis[0]!.min).toBeUndefined();
  });

  it('states the chart’s latest facts as text (role=img, §14.1)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });

    const canvas = wrapper.find('[data-testid="chart-canvas"]');
    expect(canvas.attributes('role')).toBe('img');
    // The metric names the image (several charts share the page), then
    // the latest values as text.
    expect(canvas.attributes('aria-label')).toBe(
      `5-hour token quota: latest 100,000 used, 50,000 remaining ${en.overview.metric.unit.credits} at Nov 2, 2026, 1:00 PM`,
    );
  });
});

/* ── States: loading, empty, the range report, failures ────────────────── */

describe('metric chart: states and the D-147 residual', () => {
  it('renders the loading line and no chart while the first load is pending', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) =>
        input.startsWith('/api/history') ? { stall: true } : { body: historyBody(input) },
    });

    expect(wrapper.find('[data-testid="chart-loading"]').text()).toBe(en.overview.chart.loading);
    expect(runtime.handles).toHaveLength(0);
  });

  it('renders the empty state for an empty series — no chart instance', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: [], unit: null }) }),
    });

    expect(wrapper.find('[data-testid="chart-empty"]').text()).toBe(en.overview.chart.empty);
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(false);
    expect(runtime.handles).toHaveLength(0);
  });

  it('states a rejected range instead of an empty chart', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({
        body: historyBody(input, {
          points: [],
          unit: null,
          range: {
            outcome: 'rejected',
            effectiveFrom: null,
            effectiveTo: null,
            retentionHorizon: T0,
          },
        }),
      }),
    });

    expect(wrapper.find('[data-testid="chart-rejected"]').text()).toBe(en.overview.chart.rejected);
    expect(runtime.handles).toHaveLength(0);
  });

  it('surfaces a real truncation with the retained window’s start', async () => {
    applyTokens(LIGHT_TOKENS);
    const effectiveFrom = T1 + 86_400_000;
    const { wrapper } = await mountChart({
      serve: (input) => ({
        body: historyBody(input, {
          points: DUAL_POINTS,
          range: { outcome: 'truncated', effectiveFrom, retentionHorizon: effectiveFrom },
        }),
      }),
    });

    const notice = wrapper.find('[data-testid="chart-truncated"]');
    expect(notice.text()).toBe(
      en.overview.chart.truncatedNotice.replace('{time}', 'Nov 3, 2026, 1:00 PM'),
    );
    // The chart still renders its retained window.
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(true);
  });

  it('stays quiet on the sub-tolerance truncation sliver (the D-147 residual)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper } = await mountChart({
      serve: (input) => ({
        body: historyBody(input, {
          points: DUAL_POINTS,
          range: {
            outcome: 'truncated',
            effectiveFrom: Date.parse(queryParamsOf(input).get('from') ?? '') + 2_000,
            retentionHorizon: T0,
          },
        }),
      }),
    });

    expect(wrapper.find('[data-testid="chart-truncated"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(true);
  });

  it('states a series of only invalid rows and gaps instead of a blank chart', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({
        body: historyBody(input, {
          points: [
            point({
              collectedAt: T0,
              used: null,
              remaining: null,
              limit: null,
              percentUsed: null,
              percentRemaining: null,
              isValid: false,
              invalidReason: 'currentValue is not a number',
            }),
            { kind: 'empty', collectedAt: T1 },
          ],
        }),
      }),
    });

    // A different fact from an empty range: rows exist, none carried a
    // valid value — stated, never rendered as unlabeled blank axes.
    expect(wrapper.find('[data-testid="chart-no-valid-values"]').text()).toBe(
      en.overview.chart.noValidValues,
    );
    expect(wrapper.find('[data-testid="chart-canvas"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="chart-empty"]').exists()).toBe(false);
    expect(runtime.handles).toHaveLength(0);
  });

  it('presents a failed load with its own named retry, and the retry recovers', async () => {
    applyTokens(LIGHT_TOKENS);
    let refuse = true;
    const { wrapper, runtime } = await mountChart({
      serve: (input) =>
        refuse
          ? { status: 500, body: INTERNAL_ENVELOPE }
          : { body: historyBody(input, { points: DUAL_POINTS }) },
    });

    const notice = wrapper.find('[data-testid="api-error"]');
    expect(notice.text()).toBe(en.errors.codes.internal);
    const retry = wrapper.find('[data-testid="chart-retry"]');
    // The distinct accessible name carries the metric label (D-137).
    expect(retry.text()).toBe('Retry loading the 5-hour token quota history');
    expect(runtime.handles).toHaveLength(0);

    refuse = false;
    await retry.trigger('click');
    await settle();

    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    expect(runtime.handles).toHaveLength(1);
  });
});

/* ── Theme restyle and the instance lifecycle (D-133) ─────────────────── */

/**
 * The `lineStyle.color` of a line series in the handle's latest option —
 * the theme-restyle target; narrows the option's series union to its
 * line members by the discriminant.
 */
function lastOptionLineColor(handle: RecordingChartHandle, index: number): string {
  const series = handle.setOptions.at(-1)?.option.series[index];
  if (series?.type !== 'line') throw new Error(`expected a line series at index ${index}`);
  return series.lineStyle.color;
}

describe('metric chart: theme restyle and lifecycle', () => {
  it('re-reads the tokens and re-sets the option when the theme flips (D-133)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime, controller } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    const before = handle.setOptions.length;
    expect(lastOptionLineColor(handle, 0)).toBe('#1b4fa0');

    // The live flip: the token cascade changes with the mode (inline here
    // as the stylesheet does in the browser) and the controller follows.
    applyTokens(DARK_TOKENS);
    controller.setTheme('dark');
    await settle();

    expect(handle.setOptions.length).toBe(before + 1);
    expect(lastOptionLineColor(handle, 0)).toBe('#8ab4f8');
    expect(lastOptionLineColor(handle, 1)).toBe('#9fdcae');
  });

  it('releases the chart on unmount', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    expect(handle.disposed).toBe(false);

    wrapper.unmount();
    wrappers.pop();

    expect(handle.disposed).toBe(true);
  });

  it('recreates the chart after a range switch resets the card', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const firstHandle = runtime.handles[0]!;
    expect(runtime.handles).toHaveLength(1);

    // A range switch resets the card: the chart releases with its host,
    // and the fresh data creates a fresh instance on the new element.
    await wrapper.setProps({ rangeId: '3d' });
    await settle();

    expect(firstHandle.disposed).toBe(true);
    expect(runtime.handles).toHaveLength(2);
    expect(runtime.handles[1]!.setOptions.length).toBeGreaterThan(0);
  });
});

/* ── Task 176: the annotation props render (D-149) ────────────────────── */

/** One series of the built option, narrowed per kind for pins. */
type OptionSeries = MetricChartOption['series'][number];

describe('metric chart: the annotation props (task 176, D-149)', () => {
  it('renders this metric’s resets only, the served peak bands, and the strip', async () => {
    applyTokens(LIGHT_TOKENS);
    const instants = windowInstants();
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { events: eventsProp(instants), peaks: peaksProp(instants) },
    });

    const option = runtime.handles[0]!.setOptions[0]!.option;
    // The reset of THIS metric renders; the other metric's does not
    // (per-metric facts, D-149).
    const used = option.series[0] as Extract<OptionSeries, { type: 'line' }>;
    expect(used.markLine?.data).toEqual([{ xAxis: instants.inside }]);
    // The bands series carries the served peak + off-peak pair; the strip
    // carries the account-level failed cycle.
    const bands = option.series.find(
      (series) => 'id' in series && series.id === 'qm-chart-bands',
    ) as Extract<OptionSeries, { type: 'custom' }>;
    expect(bands.data.map((datum) => datum.value)).toEqual([
      [instants.inside, instants.later],
      [instants.later, instants.later + 3_600_000],
    ]);
    const strip = option.series.find(
      (series) => 'id' in series && series.id === 'qm-chart-errors',
    ) as Extract<OptionSeries, { type: 'scatter' }>;
    expect(strip.data).toHaveLength(1);
    expect(strip.data[0]!.symbol).toBe('triangle');
    // The strip joins the legend by name — the text signal beside color.
    expect(option.legend.data).toEqual([
      en.overview.chart.seriesUsed,
      en.overview.chart.seriesRemaining,
      en.overview.chart.errorsSeries,
    ]);
  });

  it('states the annotation counts in the accessible name (§14.1)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { events: eventsProp(windowInstants()), peaks: peaksProp(windowInstants()) },
    });

    const label = wrapper.find('[data-testid="chart-canvas"]').attributes('aria-label');
    // The counts state every annotation kind the range carries.
    expect(label).toContain('— in range: 1 quota resets, 1 failed collections');
  });

  it('re-styles the annotations with the theme (the band tokens re-read)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime, controller } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { events: eventsProp(windowInstants()), peaks: peaksProp(windowInstants()) },
    });
    const handle = runtime.handles[0]!;
    const bandsOf = (): Extract<OptionSeries, { type: 'custom' }> =>
      handle.setOptions
        .at(-1)!
        .option.series.find(
          (series) => 'id' in series && series.id === 'qm-chart-bands',
        ) as Extract<OptionSeries, { type: 'custom' }>;
    expect(bandsOf().data[0]!.itemStyle.color).toBe('#5b4fa8');

    applyTokens(DARK_TOKENS);
    controller.setTheme('dark');
    await settle();

    expect(bandsOf().data[0]!.itemStyle.color).toBe('#a5a1e8');
  });

  it('without the props the option keeps the task-175 shape', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime, wrapper } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });

    const option = runtime.handles[0]!.setOptions[0]!.option;
    expect(
      option.series.find(
        (series) =>
          'id' in series && (series.id === 'qm-chart-bands' || series.id === 'qm-chart-errors'),
      ),
    ).toBeUndefined();
    expect(option.series).toHaveLength(2);
    expect(option.grid).toHaveLength(1);
    expect(option.legend.data).toEqual([
      en.overview.chart.seriesUsed,
      en.overview.chart.seriesRemaining,
    ]);
    // No counts append to the accessible name without annotations.
    const label = wrapper.find('[data-testid="chart-canvas"]').attributes('aria-label');
    expect(label).not.toContain('in range');
  });

  it('a no-schedule peak response renders no bands and breaks nothing', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: {
        peaks: {
          ...peaksProp(windowInstants()),
          timezone: null,
          offPeakMultiplier: null,
          intervals: [],
        },
      },
    });

    const option = runtime.handles[0]!.setOptions[0]!.option;
    expect(
      option.series.find((series) => 'id' in series && series.id === 'qm-chart-bands'),
    ).toBeUndefined();
  });
});

describe('metric chart: the axis ticks (task 177, D-150)', () => {
  /** Reads an instant's wall minute/second in a zone — the alignment oracle. */
  function wallMinuteSecondOf(at: number, zone: string): { minute: number; second: number } {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: zone,
      hourCycle: 'h23',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(at);
    const read: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== 'literal') read[part.type] = Number(part.value);
    }
    return { minute: read.minute ?? 0, second: read.second ?? 0 };
  }

  it('places every tick on a local boundary of the configured zone, inside the window', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { timeZone: 'Asia/Kathmandu' },
    });

    const axis = runtime.handles[0]!.setOptions[0]!.option.xAxis[0]!;
    const values = axis.axisLabel.customValues ?? [];
    expect(values.length).toBeGreaterThan(1);
    // Every tick sits on the zone's own hour/day boundary (a +05:45 zone
    // aligns at :15 UTC-minutes — never the machine's or UTC's phase) and
    // inside the half-open window.
    for (const value of values) {
      expect(wallMinuteSecondOf(value, 'Asia/Kathmandu')).toEqual({ minute: 0, second: 0 });
      expect(value).toBeGreaterThanOrEqual(axis.min);
      expect(value).toBeLessThan(axis.max);
    }
    // The labels are the tick words (time, day, or month) — a tick label
    // never carries the full date's colon (the fallback would).
    for (const value of values) {
      expect(axis.axisLabel.formatter!(value)).not.toContain(':');
    }
    // The tick marks ride the same instants.
    expect(axis.axisTick!.customValues).toBe(values);
  });

  it('the strip x-axis carries the same instants as the main axis (the D-149 pair)', async () => {
    applyTokens(LIGHT_TOKENS);
    const instants = windowInstants();
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { events: eventsProp(instants), peaks: peaksProp(instants) },
    });

    const option = runtime.handles[0]!.setOptions[0]!.option;
    const [main, strip] = option.xAxis as [(typeof option.xAxis)[0], (typeof option.xAxis)[0]];
    expect(strip!.axisLabel.customValues).toEqual(main!.axisLabel.customValues);
    expect(strip!.axisTick!.customValues).toEqual(main!.axisTick!.customValues);
    // The main axis hides its label row (the strip owns it below) but
    // keeps the instants for its tick marks.
    expect(main!.axisLabel.show).toBe(false);
    expect(strip!.axisLabel.show).toBeUndefined();
  });

  it('re-fits the tick ladder when the host reports its real width', async () => {
    applyTokens(LIGHT_TOKENS);
    // A controllable ResizeObserver (happy-dom's never fires; the
    // component's callback reads the host's clientWidth, so the entries
    // it receives are irrelevant to the behavior under test).
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });

    const handle = runtime.handles[0]!;
    // The unmeasured mount builds at the §14.1 floor (the host's
    // clientWidth is 0 under happy-dom) — the 7-day window at a 284 px
    // plot carries the 2-day step.
    const firstTicks = handle.setOptions[0]!.option.xAxis[0]!.axisLabel.customValues!;
    expect(firstTicks.length).toBeGreaterThanOrEqual(3);
    expect(firstTicks.length).toBeLessThanOrEqual(4);

    // A wide host re-fits: the observer fires, the ladder moves to the
    // 1-day step, and the option re-sets with more ticks.
    const host = wrapper.find('[data-testid="chart-canvas"]').element as HTMLElement;
    Object.defineProperty(host, 'clientWidth', { value: 1200, configurable: true });
    observers[0]!();
    await settle();
    expect(handle.setOptions).toHaveLength(2);
    const wideTicks = handle.setOptions[1]!.option.xAxis[0]!.axisLabel.customValues!;
    expect(wideTicks.length).toBeGreaterThan(firstTicks.length);
    expect(handle.resized).toBe(1);

    // A width change that keeps the ladder step is stretch-only: the
    // canvas resizes, the option does not re-set (the review round's
    // per-frame-rebuild gate).
    Object.defineProperty(host, 'clientWidth', { value: 1199, configurable: true });
    observers[0]!();
    await settle();
    expect(handle.setOptions).toHaveLength(2);
    expect(handle.resized).toBe(2);
  });
});

/* ── Task 178: the cursor/zoom sync wiring (D-153) ────────────────────── */

describe('metric chart: the cursor/zoom sync (task 178, D-153)', () => {
  it('joins the page’s connect group and carries the shared zoom and cursor config', async () => {
    applyTokens(LIGHT_TOKENS);
    const sync = createChartSync();
    const instants = windowInstants();
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { sync, events: eventsProp(instants) },
    });

    // The instance joins the coordinator's group — the connect relay's
    // membership is the page-minted id, never a per-card one.
    expect(runtime.syncGroups).toEqual([sync.groupId]);

    const option = runtime.handles[0]!.setOptions[0]!.option;
    // One inside zoom over every x-axis of THIS chart: the strip rides.
    expect(option.dataZoom).toEqual([
      {
        type: 'inside',
        id: CHART_X_ZOOM_ID,
        xAxisIndex: [0, 1],
        filterMode: 'weakFilter',
        minValueSpan: MIN_ZOOM_SPAN_MS,
        zoomOnMouseWheel: 'shift',
      },
    ]);
    // The cursor's on-axis label formats the instant in the zone — never
    // the raw epoch-ms number — and colors through the tooltip tokens
    // (D-133; ECharts' defaults hardcode its built-in theme).
    expect(option.axisPointer.label.formatter({ value: T0 })).toBe(formatChartDate(T0, 'UTC'));
    expect(option.axisPointer.label.backgroundColor).toBe(LIGHT_TOKENS['--qm-color-background']);
    expect(option.axisPointer.label.color).toBe(LIGHT_TOKENS['--qm-color-foreground']);
    // The stable ids merge-mode matching relies on (D-153).
    expect(option.series.map((series) => series.id)).toEqual([
      'qm-series-used',
      'qm-series-remaining',
      'qm-chart-errors',
    ]);
    expect(option.xAxis.map((axis) => axis.id)).toEqual(['qm-x-main', 'qm-x-strip']);
    expect(option.yAxis.map((axis) => axis.id)).toEqual(['qm-y-main', 'qm-y-strip']);
    expect(option.grid.map((grid) => grid.id)).toEqual(['qm-grid-main', 'qm-grid-strip']);
  });

  it('a strip-less chart zooms its one axis (the degenerate axis list)', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const option = runtime.handles[0]!.setOptions[0]!.option;
    expect(option.dataZoom[0]!.xAxisIndex).toEqual([0]);
    expect(option.xAxis.map((axis) => axis.id)).toEqual(['qm-x-main']);
  });

  it('feeds a zoom event back: ticks over the zoom span, bounds untouched', async () => {
    applyTokens(LIGHT_TOKENS);
    const { runtime, sync } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    const first = handle.setOptions[0]!.option;
    const from = first.xAxis[0]!.min;
    const to = first.xAxis[0]!.max;
    const fullTicks = first.xAxis[0]!.axisLabel.customValues!;

    // The zoom event ECharts fires on the user's gesture (batched shape).
    handle.emitDataZoom({ batch: [{ dataZoomId: CHART_X_ZOOM_ID, start: 40, end: 60 }] });
    await settle();

    const zoomed = handle.setOptions.at(-1)!.option;
    // The axes KEEP the requested bounds — the percent base the group's
    // relay scales (the alignment invariant, D-153).
    expect(zoomed.xAxis[0]!.min).toBe(from);
    expect(zoomed.xAxis[0]!.max).toBe(to);
    // The tick ladder walked the ZOOM span: every tick sits inside the
    // zoomed middle fifth of the window (the un-recomputed full-window
    // set would fail this — three of its four ticks sit outside).
    const zoomFrom = from + ((to - from) * 40) / 100;
    const zoomTo = from + ((to - from) * 60) / 100;
    const zoomTicks = zoomed.xAxis[0]!.axisLabel.customValues!;
    expect(zoomTicks.length).toBeGreaterThanOrEqual(2);
    for (const tick of zoomTicks) {
      expect(tick).toBeGreaterThanOrEqual(zoomFrom - 1);
      expect(tick).toBeLessThanOrEqual(zoomTo);
    }
    // The coordinator holds the scaled window — the page's announcement
    // source — with the exact card arithmetic.
    expect(sync.zoomed.value).toBe(true);
    expect(sync.zoomWindow.value).toEqual({ from: zoomFrom, to: zoomTo });

    // A full-range event retires the zoom: the ladder walks the whole
    // window again (the identical tick set) and the page state clears.
    handle.emitDataZoom({ start: 0, end: 100 });
    await settle();
    expect(sync.zoomed.value).toBe(false);
    expect(handle.setOptions.at(-1)!.option.xAxis[0]!.axisLabel.customValues).toEqual(fullTicks);
  });

  it('reports the zoom to the coordinator; a later card adopts the shared window', async () => {
    applyTokens(LIGHT_TOKENS);
    const sync = createChartSync();
    const { runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { sync },
    });
    runtime.handles[0]!.emitDataZoom({
      batch: [{ dataZoomId: CHART_X_ZOOM_ID, start: 10, end: 30 }],
    });
    await settle();
    expect(sync.zoomed.value).toBe(true);

    // A card whose data lands later joins the already-zoomed group: the
    // attach dispatches the shared percent to its fresh handle (after its
    // first option landed, so the id resolves).
    const { runtime: lateRuntime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { sync, metricKey: 'mcp-monthly' },
    });
    expect(lateRuntime.handles[0]!.actions).toEqual([
      { type: 'dataZoom', dataZoomId: CHART_X_ZOOM_ID, start: 10, end: 30 },
    ]);
  });

  it('a refresh re-anchors the window: the card resets its own zoom', async () => {
    applyTokens(LIGHT_TOKENS);
    const { wrapper, runtime, sync } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    handle.emitDataZoom({ start: 20, end: 40 });
    await settle();
    expect(sync.zoomed.value).toBe(true);

    await wrapper.setProps({ refreshToken: 1 });
    await settle();

    // The bounds moved with the fresh "now" — the old percent would name
    // different instants, so the card dispatched its own reset and the
    // page state followed.
    expect(handle.actions).toEqual([
      { type: 'dataZoom', dataZoomId: CHART_X_ZOOM_ID, start: 0, end: 100 },
    ]);
    expect(sync.zoomed.value).toBe(false);
    // The same chart instance stays (the keep-last-good refresh path).
    expect(handle.disposed).toBe(false);
    expect(runtime.handles).toHaveLength(1);
  });

  it('a range switch clears the zoom with the identity — the fresh chart starts clean', async () => {
    applyTokens(LIGHT_TOKENS);
    const sync = createChartSync();
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { sync },
    });
    runtime.handles[0]!.emitDataZoom({ start: 15, end: 45 });
    await settle();
    expect(sync.zoomed.value).toBe(true);

    await wrapper.setProps({ rangeId: '3d' });
    await settle();

    // The old instance released with its host (detached from the group),
    // and the fresh instance received NO catch-up dispatch — the previous
    // window's zoom never applies to the new window.
    expect(runtime.handles[0]!.disposed).toBe(true);
    const fresh = runtime.handles[1]!;
    expect(fresh.setOptions.length).toBeGreaterThan(0);
    expect(fresh.actions).toEqual([]);
    expect(sync.zoomed.value).toBe(false);
  });

  it('re-fits the tick ladder over the ZOOM span on resize (the review round’s P2)', async () => {
    applyTokens(LIGHT_TOKENS);
    // A controllable ResizeObserver (happy-dom's never fires; the
    // component's callback reads the host's clientWidth).
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
    });
    const handle = runtime.handles[0]!;
    const host = wrapper.find('[data-testid="chart-canvas"]').element as HTMLElement;

    // Zoom to the middle fifth of the 7-day window, still at the §14.1
    // floor width (plot 284 px — the ladder's 12-hour step).
    handle.emitDataZoom({ start: 40, end: 60 });
    await settle();
    const zoomTicks = handle.setOptions.at(-1)!.option.xAxis[0]!.axisLabel.customValues!;
    expect(handle.setOptions).toHaveLength(2); // the initial render + the zoom

    // A width whose FULL-window step holds (2-day at both plot 284 and
    // plot 447) but whose ZOOM-window step moves (12-hour → 6-hour): the
    // re-fit gate must read the ACTIVE tick span, not the requested
    // window — otherwise the zoomed chart keeps the stale density.
    Object.defineProperty(host, 'clientWidth', { value: 523, configurable: true });
    observers[0]!();
    await settle();

    // The re-fit re-set the option over the zoom span at the wider plot.
    expect(handle.setOptions).toHaveLength(3);
    const refitTicks = handle.setOptions.at(-1)!.option.xAxis[0]!.axisLabel.customValues!;
    expect(refitTicks.length).toBeGreaterThan(zoomTicks.length);
    expect(refitTicks.length).toBeGreaterThan(zoomTicks.length);
    // The refit still walks the zoom span, and the bounds stay full.
    const axis = handle.setOptions.at(-1)!.option.xAxis[0]!;
    const full = handle.setOptions[0]!.option.xAxis[0]!;
    expect(axis.min).toBe(full.min);
    expect(axis.max).toBe(full.max);
    for (const tick of refitTicks) {
      expect(tick).toBeGreaterThanOrEqual(axis.min);
      expect(tick).toBeLessThanOrEqual(axis.max);
    }
  });

  it('unmount detaches the handle and drops the event subscription', async () => {
    applyTokens(LIGHT_TOKENS);
    const sync = createChartSync();
    const { wrapper, runtime } = await mountChart({
      serve: (input) => ({ body: historyBody(input, { points: DUAL_POINTS }) }),
      props: { sync },
    });
    const handle = runtime.handles[0]!;
    runtime.handles[0]!.emitDataZoom({ start: 5, end: 50 });
    await settle();
    expect(sync.zoomed.value).toBe(true);
    expect(handle.dataZoomHandlers.length).toBeGreaterThan(0);

    wrapper.unmount();
    wrappers.pop();

    // The group forgot with its last chart, and the released handle is
    // unsubscribed (a late fire could not resurrect the state).
    expect(handle.disposed).toBe(true);
    expect(handle.dataZoomHandlers).toHaveLength(0);
    expect(sync.zoomed.value).toBe(false);
  });
});
