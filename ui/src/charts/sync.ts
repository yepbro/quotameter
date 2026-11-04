/**
 * The §14.4 cursor/zoom sync coordinator for one account page's metric
 * charts (task 178, spec §14.4; decision D-153).
 *
 * The cross-instance relay itself is ECharts' `connect` registry (wired in
 * `./runtime.ts` — every chart of the page is created with the same
 * `syncGroup` id, source-verified against the 6.1.0 source: the registry
 * relays the value-carrying `updateAxisPointer` and percent-based
 * `dataZoom` actions between the group's instances). What the registry does
 * NOT provide is the page-level state a §14.1 surface needs — whether the
 * charts are currently zoomed (the reset affordance), the shared window in
 * instants (the announcement text), and the identity rules that keep one
 * window's zoom from leaking into another's. That is this module: a small
 * echarts-free coordinator the page owns and every chart card talks to.
 *
 * Pinned interpretations:
 *
 * - **The zoom window is shared, per page.** §14.4 says "synchronized …
 *   across charts on the same page": one window for all of the selected
 *   account's metric charts. The connect relay keeps the instances
 *   converging; this object holds what the page renders from.
 * - **An empty group forgets.** A range switch or an account switch rebuilds
 *   every chart card (fresh loads, fresh instances — D-135's no-staleness
 *   rule). When the last live handle detaches, the shared window resets:
 *   the next window's charts start unzoomed, never re-applying the previous
 *   window's percent to different instants.
 * - **Late joiners catch up.** A card whose own data lands after the others
 *   (its request resolves last, so its instance is created last) joins the
 *   already-zoomed window: attaching dispatches the current percent to the
 *   new handle — the group stays aligned by construction.
 * - **Reset is dispatched to every handle directly**, not relayed through
 *   one chart: deterministic and observable at the seam, independent of the
 *   relay's event timing.
 */

import { ref, type Ref } from 'vue';
import { CHART_X_ZOOM_ID } from './series';
import type { ChartDataZoomEvent, ChartDataZoomResetAction } from './runtime';

/**
 * The percent window a chart reports — `start`/`end` in percent of the
 * requested-bounds extent (the only mode this app dispatches; the value
 * fields of the wire event are ignored).
 */
export interface ChartZoomPercent {
  readonly start: number;
  readonly end: number;
}

/**
 * The shared zoom as instants — the reporting card's own requested bounds
 * scaled by the percent (cards of one page share the bounds to
 * milliseconds; the page formats these for its announcement).
 */
export interface ChartZoomWindow {
  readonly from: number;
  readonly to: number;
}

/** One zoom report: the percent and the instants it covers; `null` = full. */
export type ChartZoomReport = {
  readonly percent: ChartZoomPercent;
  readonly window: ChartZoomWindow;
} | null;

/** The handle surface the coordinator drives (the `ChartHandle` subset). */
export interface SyncableChartHandle {
  dispatchAction(action: ChartDataZoomResetAction): void;
}

/**
 * Below this percent margin a window counts as full-range: wheel zoom
 * produces float dust, and a 0.001% sliver of the smallest §14.4 window
 * (24 h) is under a second — not a zoom anyone made on purpose.
 */
const ZOOM_EPSILON_PERCENT = 0.001;

/** Module-scoped group counter: every page load mints a fresh group id. */
let nextSyncGroup = 0;

/** The coordinator one account page owns; see the module docblock. */
export interface ChartSync {
  /** The ECharts `connect` group id passed to every chart's creation. */
  readonly groupId: string;
  /** Whether any live chart reports a zoomed window (the reset affordance). */
  readonly zoomed: Ref<boolean>;
  /** The last reported zoom window (instants), or `null` when not zoomed. */
  readonly zoomWindow: Ref<ChartZoomWindow | null>;
  /** Joins a live chart; a late joiner adopts the current shared window. */
  attach(handle: SyncableChartHandle): void;
  /** Releases a chart; an empty group forgets the window (see above). */
  detach(handle: SyncableChartHandle): void;
  /** A card's zoom report — from its own `dataZoom` event. */
  reportZoom(report: ChartZoomReport): void;
  /** Resets every live chart to the full range (the page's affordance). */
  reset(): void;
}

/**
 * Normalizes a `dataZoom` event into the percent window — `null` when the
 * event carries no usable percent pair or the window is the full range.
 * Both event shapes are read: the batched form first (the item of THIS
 * app's dataZoom id when present), else the flat form (this app's own
 * dispatches).
 */
export function zoomPercentOf(event: ChartDataZoomEvent): ChartZoomPercent | null {
  const item =
    event.batch?.find((entry) => entry.dataZoomId === CHART_X_ZOOM_ID) ?? event.batch?.[0];
  const start = item?.start ?? event.start;
  const end = item?.end ?? event.end;
  if (start === undefined || end === undefined) return null;
  if (start <= ZOOM_EPSILON_PERCENT && end >= 100 - ZOOM_EPSILON_PERCENT) return null;
  return { start, end };
}

/** The zoom-adopt/reset action over the shared dataZoom id. */
function zoomActionOf(percent: ChartZoomPercent): ChartDataZoomResetAction {
  return {
    type: 'dataZoom',
    dataZoomId: CHART_X_ZOOM_ID,
    start: percent.start,
    end: percent.end,
  };
}

const FULL_RANGE: ChartZoomPercent = { start: 0, end: 100 };

/** Creates the page's coordinator. */
export function createChartSync(): ChartSync {
  const groupId = `qm-chart-sync-${(nextSyncGroup += 1)}`;
  const handles = new Set<SyncableChartHandle>();
  const zoomed = ref(false);
  const zoomWindow = ref<ChartZoomWindow | null>(null);
  let lastPercent: ChartZoomPercent | null = null;

  return {
    groupId,
    zoomed,
    zoomWindow,
    attach(handle) {
      handles.add(handle);
      // A late joiner adopts the shared window: the dispatch lands after
      // the card's first `setOption` (the attach site), so the id resolves.
      if (lastPercent !== null) handle.dispatchAction(zoomActionOf(lastPercent));
    },
    detach(handle) {
      handles.delete(handle);
      // The empty group forgets: the next window's charts start unzoomed.
      if (handles.size === 0) {
        lastPercent = null;
        zoomWindow.value = null;
        zoomed.value = false;
      }
    },
    reportZoom(report) {
      // A null report means "this chart is at full range" — the only
      // sources are resets (the page's button, a card's own refresh
      // re-anchor, a user zooming back out), and each of them reaches
      // every chart of the group, so the page state follows directly.
      if (report === null) {
        lastPercent = null;
        zoomWindow.value = null;
        zoomed.value = false;
        return;
      }
      lastPercent = report.percent;
      zoomWindow.value = report.window;
      zoomed.value = true;
    },
    reset() {
      if (handles.size === 0) return;
      for (const handle of handles) handle.dispatchAction(zoomActionOf(FULL_RANGE));
    },
  };
}
