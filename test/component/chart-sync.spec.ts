import { describe, expect, it } from 'vitest';
import { CHART_X_ZOOM_ID } from '../../ui/src/charts/series';
import {
  createChartSync,
  zoomPercentOf,
  type ChartZoomPercent,
  type SyncableChartHandle,
} from '../../ui/src/charts/sync';
import type { ChartDataZoomEvent, ChartDataZoomResetAction } from '../../ui/src/charts/runtime';

/**
 * The §14.4 cursor/zoom coordinator (task 178, decision D-153), pure: the
 * shared zoom state machine the page renders from — attach/detach with the
 * empty-group forgets rule, the late-joiner catch-up, the report/reset
 * round-trips, and the event normalization (both `dataZoom` event shapes
 * and the full-range epsilon). The ECharts `connect` relay itself is the
 * library's behavior (source-verified; recorded in D-153 as outside the
 * test stack's boundary, D-148's precedent) — what this suite pins is
 * everything the app owns around it.
 */

/** A recording stand-in for one chart handle. */
class RecordingHandle implements SyncableChartHandle {
  readonly actions: ChartDataZoomResetAction[] = [];

  dispatchAction(action: ChartDataZoomResetAction): void {
    this.actions.push(action);
  }
}

function percent(start: number, end: number): ChartZoomPercent {
  return { start, end };
}

describe('chart sync: zoomPercentOf (the dataZoom event normalization)', () => {
  it('reads the batched shape — the gesture dispatches', () => {
    const event: ChartDataZoomEvent = {
      batch: [{ dataZoomId: CHART_X_ZOOM_ID, start: 20, end: 60 }],
    };
    expect(zoomPercentOf(event)).toEqual(percent(20, 60));
  });

  it('picks this app’s dataZoom id out of a foreign batch', () => {
    const event: ChartDataZoomEvent = {
      batch: [
        { dataZoomId: 'someone-elses', start: 0, end: 10 },
        { dataZoomId: CHART_X_ZOOM_ID, start: 40, end: 80 },
      ],
    };
    expect(zoomPercentOf(event)).toEqual(percent(40, 80));
  });

  it('reads the flat shape — this app’s own dispatches', () => {
    expect(zoomPercentOf({ start: 10, end: 90 })).toEqual(percent(10, 90));
  });

  it('a percent pair without the batch item falls back to the flat pair', () => {
    expect(zoomPercentOf({ batch: [{ dataZoomId: CHART_X_ZOOM_ID }], start: 5, end: 55 })).toEqual(
      percent(5, 55),
    );
  });

  it('the full range (0–100) is not a zoom — null, whatever the dust', () => {
    expect(zoomPercentOf({ start: 0, end: 100 })).toBeNull();
    expect(zoomPercentOf({ start: 0.0005, end: 99.9995 })).toBeNull();
  });

  it('a sliver off full range stays a zoom; a missing pair is null', () => {
    expect(zoomPercentOf({ start: 0.01, end: 100 })).toEqual(percent(0.01, 100));
    expect(zoomPercentOf({ start: 0, end: 99.99 })).toEqual(percent(0, 99.99));
    expect(zoomPercentOf({})).toBeNull();
    expect(zoomPercentOf({ batch: [] })).toBeNull();
  });
});

describe('chart sync: the coordinator state machine (D-153)', () => {
  it('mints a fresh group id per page and starts unzoomed', () => {
    const a = createChartSync();
    const b = createChartSync();
    expect(a.groupId).not.toBe(b.groupId);
    expect(a.zoomed.value).toBe(false);
    expect(a.zoomWindow.value).toBeNull();
  });

  it('a zoom report drives the page state; reset dispatches to every live handle', () => {
    const sync = createChartSync();
    const first = new RecordingHandle();
    const second = new RecordingHandle();
    sync.attach(first);
    sync.attach(second);
    expect(first.actions).toHaveLength(0);

    sync.reportZoom({
      percent: percent(25, 75),
      window: { from: 1_000, to: 2_000 },
    });
    expect(sync.zoomed.value).toBe(true);
    expect(sync.zoomWindow.value).toEqual({ from: 1_000, to: 2_000 });

    sync.reset();
    for (const handle of [first, second]) {
      expect(handle.actions).toEqual([
        { type: 'dataZoom', dataZoomId: CHART_X_ZOOM_ID, start: 0, end: 100 },
      ]);
    }
  });

  it('a null report clears the state (the reset and refresh paths)', () => {
    const sync = createChartSync();
    const handle = new RecordingHandle();
    sync.attach(handle);
    sync.reportZoom({ percent: percent(10, 20), window: { from: 0, to: 100 } });
    expect(sync.zoomed.value).toBe(true);

    sync.reportZoom(null);
    expect(sync.zoomed.value).toBe(false);
    expect(sync.zoomWindow.value).toBeNull();
  });

  it('a late joiner adopts the current shared window on attach', () => {
    const sync = createChartSync();
    const early = new RecordingHandle();
    sync.attach(early);
    sync.reportZoom({ percent: percent(30, 70), window: { from: 300, to: 700 } });

    const late = new RecordingHandle();
    sync.attach(late);
    expect(late.actions).toEqual([
      { type: 'dataZoom', dataZoomId: CHART_X_ZOOM_ID, start: 30, end: 70 },
    ]);
    // The early handle is untouched by the joiner's catch-up.
    expect(early.actions).toHaveLength(0);
  });

  it('the empty group forgets — the next window starts unzoomed', () => {
    const sync = createChartSync();
    const handle = new RecordingHandle();
    sync.attach(handle);
    sync.reportZoom({ percent: percent(10, 90), window: { from: 0, to: 1 } });

    sync.detach(handle);
    expect(sync.zoomed.value).toBe(false);
    expect(sync.zoomWindow.value).toBeNull();

    // A late joiner after the forget starts clean — no catch-up dispatch.
    const next = new RecordingHandle();
    sync.attach(next);
    expect(next.actions).toHaveLength(0);
  });

  it('the state survives while any handle stays live', () => {
    const sync = createChartSync();
    const first = new RecordingHandle();
    const second = new RecordingHandle();
    sync.attach(first);
    sync.attach(second);
    sync.reportZoom({ percent: percent(5, 95), window: { from: 0, to: 10 } });

    sync.detach(first);
    expect(sync.zoomed.value).toBe(true);

    // A joiner while the group lives still adopts the shared window.
    const third = new RecordingHandle();
    sync.attach(third);
    expect(third.actions).toEqual([
      { type: 'dataZoom', dataZoomId: CHART_X_ZOOM_ID, start: 5, end: 95 },
    ]);
  });

  it('reset with no live handles dispatches nothing', () => {
    const sync = createChartSync();
    expect(() => sync.reset()).not.toThrow();
  });

  it('detaching an unknown handle is a no-op', () => {
    const sync = createChartSync();
    const stranger = new RecordingHandle();
    expect(() => sync.detach(stranger)).not.toThrow();
    expect(sync.zoomed.value).toBe(false);
  });
});
