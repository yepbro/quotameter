/**
 * The ECharts runtime seam for the §14.4 charts (task 175, spec §3, §14.4;
 * decision D-148): the ONLY module that knows Apache ECharts exists.
 *
 * Import strategy — spec §3 mandates "Apache ECharts, modular imports", so
 * this file composes the runtime from `echarts/core` plus exactly the
 * chart/component/renderer pieces the metric charts use (tree-shaken; the
 * full `echarts` package import never enters the bundle):
 *
 *   `echarts/core`      — `init`, `use`, `dispose` through one instance
 *   `echarts/charts`    — `LineChart` (the used/remaining line series),
 *                         `ScatterChart` (the §12.2 error-strip markers,
 *                         task 176), `CustomChart` (the §14.4 band rects —
 *                         the only primitive that renders `decal` hatching,
 *                         task 176)
 *   `echarts/components`— `GridComponent` (the value axes), `TooltipComponent`
 *                         (the date/value tooltip), `LegendComponent` (the
 *                         series labels — one §14.1 never-color-alone signal),
 *                         `MarkLineComponent` (the §14.4 vertical reset
 *                         markers, task 176), `DataZoomInsideComponent` (the
 *                         §14.4 zoom, task 178 — the inside piece only, no
 *                         slider chrome), `AxisPointerComponent` (the
 *                         §14.4 cursor link, task 178 — registered
 *                         explicitly although `TooltipComponent` already
 *                         pulls it: this file lists what the option consumes)
 *   `echarts/core`      — beside `init`/`use`: `connect` (task 178, D-153 —
 *                         the group registry that relays cursor/zoom actions
 *                         between the page's separately-instantiated charts)
 *   `echarts/renderers` — `CanvasRenderer`
 *
 * The renderer is **canvas with `tooltip.renderMode: 'richText'`** (set in
 * the option builder, `./series.ts`): D-127's CSP analysis pinned that
 * ECharts' SVG renderer and HTML tooltips style through the `style=`
 * ATTRIBUTE (apache/echarts#19570, #19398), which `style-src 'self'`
 * blocks — the canvas painter and rich-text tooltip draw without DOM
 * styling, so no CSP amendment is needed.
 *
 * The seam: `ChartRuntime` bundles chart creation and design-token reading
 * behind one injectable interface (the theme-storage/api-fetch precedent,
 * D-133/D-134). The composition root installs nothing — the DOM runtime is
 * the default — while component tests provide a recording fake: ECharts
 * cannot boot under happy-dom at all (zrender measures text through a real
 * canvas 2d context), so the fake keeps the option pipeline — the part this
 * repository owns — fully tested while the rendering itself stays with the
 * library (recorded in D-148).
 */

import { CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { connect, init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { inject, type InjectionKey } from 'vue';
import type { MetricChartOption } from './series';

// One registration for the whole bundle: the modular `use` call replaces the
// full-package side effects and keeps every consumed piece listed above.
use([
  LineChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DataZoomInsideComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

/**
 * The structural surface of one ECharts instance the chart component uses —
 * a subset, so tests provide plain objects and nothing depends on the full
 * class.
 */
export interface ChartHandle {
  setOption(
    option: MetricChartOption,
    opts?: { readonly notMerge?: boolean; readonly replaceMerge?: readonly string[] },
  ): void;
  resize(): void;
  dispose(): void;
  /**
   * Subscribes to one sync-relevant instance event (task 178, D-153): the
   * percent window of a `dataZoom` change — fired by the user's own zoom
   * AND by every change the connect group relayed onto this chart.
   */
  on(event: 'dataZoom', handler: (payload: ChartDataZoomEvent) => void): void;
  /** Drops a subscription made through {@link ChartHandle.on}. */
  off(event: 'dataZoom', handler: (payload: ChartDataZoomEvent) => void): void;
  /** Dispatches one action (the zoom reset — task 178, D-153). */
  dispatchAction(action: ChartDataZoomResetAction): void;
}

/**
 * One item of a `dataZoom` event's batch — a percent window for one
 * dataZoom component (identified by `dataZoomId`).
 */
export interface ChartDataZoomBatchItem {
  readonly dataZoomId?: string;
  readonly start?: number;
  readonly end?: number;
}

/**
 * The `dataZoom` event payload the sync path consumes (task 178, D-153):
 * `start`/`end` are PERCENT of the axis extent. ECharts emits the event
 * BATCHED for gesture dispatches (the inside zoom dispatches one action
 * per dataZoom component) and FLAT for single-component dispatches (this
 * app's reset and catch-up actions) — both shapes are carried; value
 * fields exist on the echarts action contract but this app only ever
 * dispatches percent, and percent maps to the same instants on every
 * chart of the group because all share the requested-bounds extent
 * (D-148).
 */
export interface ChartDataZoomEvent {
  readonly batch?: readonly ChartDataZoomBatchItem[];
  readonly start?: number;
  readonly end?: number;
}

/** The one action the app dispatches: reset the shared zoom (D-153). */
export interface ChartDataZoomResetAction {
  readonly type: 'dataZoom';
  readonly dataZoomId: string;
  readonly start: number;
  readonly end: number;
}

/** The injectable runtime: chart creation plus design-token reading. */
export interface ChartRuntime {
  /**
   * Creates a chart bound to `element` (the component's canvas host).
   * `syncGroup` joins the instance to the page's cursor/zoom group
   * (task 178, D-153): ECharts' `connect` registry relays pointer and
   * dataZoom actions between the group's instances.
   */
  createChart(element: HTMLElement, options?: { readonly syncGroup?: string }): ChartHandle;
  /**
   * Reads one `--qm-*` design token from the live cascade (D-133: charts
   * color themselves only through token lookups, never hardcoded values).
   */
  readToken(name: string): string;
}

/**
 * Reads a raw custom property off the document element — the way the
 * e2e chart-contract cell reads tokens, and the only color source the
 * charts may use (D-133). Raw custom properties carry the author value
 * verbatim, which is why `base.css` duplicates the dark block instead of
 * `light-dark()` wrappers.
 */
export function cssTokenReader(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The production runtime: real ECharts over the live token cascade. */
export const domChartRuntime: ChartRuntime = {
  createChart(element, options) {
    const chart = init(element, undefined, { renderer: 'canvas' });
    if (options?.syncGroup !== undefined) {
      // D-153: `connect` registers the group; the instance's `group`
      // property is what the relay matches on. Registration is idempotent
      // (`connectedGroups[id] = true`), so one call per creation is enough,
      // and a disposed instance leaves the registry by itself — a stale
      // group flag is inert (no instances share the id again: every page
      // load mints a fresh one).
      chart.group = options.syncGroup;
      connect(options.syncGroup);
    }
    type EChartsOptionValue = Parameters<typeof chart.setOption>[0];
    return {
      setOption: (option, opts) => {
        // The deliberate double cast: ECharts' option parameter is
        // deliberately loose while `MetricChartOption` is the strict
        // source of truth — the conversion is the boundary between the
        // two disciplines, not an unchecked escape. The opts copy widens
        // the seam's readonly `replaceMerge` into ECharts' mutable array.
        chart.setOption(
          option as unknown as EChartsOptionValue,
          opts === undefined
            ? undefined
            : {
                notMerge: opts.notMerge,
                replaceMerge: opts.replaceMerge === undefined ? undefined : [...opts.replaceMerge],
              },
        );
      },
      resize: () => {
        chart.resize();
      },
      dispose: () => {
        chart.dispose();
      },
      // The same boundary discipline for the event/action surface: the
      // seam carries one event name and narrow payload types while
      // ECharts' listener signature is generic over its whole
      // event-definition map.
      on: (event, handler) => {
        chart.on(event as never, handler as never);
      },
      off: (event, handler) => {
        chart.off(event as never, handler as never);
      },
      dispatchAction: (action) => {
        chart.dispatchAction(action as Parameters<typeof chart.dispatchAction>[0]);
      },
    };
  },
  readToken: cssTokenReader,
};

const chartRuntimeKey: InjectionKey<ChartRuntime> = Symbol('quotameter-chart-runtime');

/**
 * The chart runtime for components: the DOM runtime unless a test injected
 * its own — the provide/inject seam every hermetic consumer follows.
 */
export function useChartRuntime(): ChartRuntime {
  return inject(chartRuntimeKey, domChartRuntime);
}

/** The injection key's exported identity (tests provide their runtime with it). */
export { chartRuntimeKey as CHART_RUNTIME_KEY };
