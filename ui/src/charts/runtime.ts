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
 *   `echarts/charts`    — `LineChart` (the used/remaining line series)
 *   `echarts/components`— `GridComponent` (the value axes), `TooltipComponent`
 *                         (the date/value tooltip), `LegendComponent` (the
 *                         series labels — one §14.1 never-color-alone signal)
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

import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { inject, type InjectionKey } from 'vue';
import type { MetricChartOption } from './series';

// One registration for the whole bundle: the modular `use` call replaces the
// full-package side effects and keeps every consumed piece listed above.
use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

/**
 * The structural surface of one ECharts instance the chart component uses —
 * a subset, so tests provide plain objects and nothing depends on the full
 * class.
 */
export interface ChartHandle {
  setOption(option: MetricChartOption, opts?: { readonly notMerge?: boolean }): void;
  resize(): void;
  dispose(): void;
}

/** The injectable runtime: chart creation plus design-token reading. */
export interface ChartRuntime {
  /** Creates a chart bound to `element` (the component's canvas host). */
  createChart(element: HTMLElement): ChartHandle;
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
  createChart(element) {
    const chart = init(element, undefined, { renderer: 'canvas' });
    type EChartsOptionValue = Parameters<typeof chart.setOption>[0];
    return {
      setOption: (option, opts) => {
        // The deliberate double cast: ECharts' option parameter is
        // deliberately loose while `MetricChartOption` is the strict
        // source of truth — the conversion is the boundary between the
        // two disciplines, not an unchecked escape.
        chart.setOption(option as unknown as EChartsOptionValue, opts);
      },
      resize: () => {
        chart.resize();
      },
      dispose: () => {
        chart.dispose();
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
