/**
 * The chart color plumbing (task 175, spec §14.1/§14.4; decisions D-133,
 * D-148): the mapping from the `--qm-*` design tokens onto the value set
 * the ECharts option consumes.
 *
 * D-133's rule is absolute — charts color themselves only through
 * `getComputedStyle` token lookups (re-read on every `resolvedTheme`
 * change), never through hardcoded palettes. Six dedicated tokens
 * (`--qm-chart-used`, `--qm-chart-remaining` from task 175; the
 * `--qm-chart-peak`/`--qm-chart-reset`/`--qm-chart-gap`/`--qm-chart-stopped`
 * annotation tokens from task 176, D-149 — added to all three theme blocks
 * of `base.css`) carry the chart's own colors; everything else the charts
 * need reuses the shell's existing tokens so a theme change keeps the
 * charts in step with the rest of the UI by construction.
 *
 * Pure: the reader is injected, so the mapping is testable without a DOM
 * (the component passes the runtime's `readToken`, which reads the live
 * cascade).
 */

/** The chart-facing token values — one snapshot of the cascade. */
export interface ChartTokens {
  /** The used-series line color (`--qm-chart-used`). */
  readonly used: string;
  /** The remaining-series line color (`--qm-chart-remaining`). */
  readonly remaining: string;
  /** Peak-band tint (`--qm-chart-peak`; task 176, D-149). */
  readonly peak: string;
  /** Reset markLine color (`--qm-chart-reset`). */
  readonly reset: string;
  /** Gap-band hatch/border color (`--qm-chart-gap`). */
  readonly gap: string;
  /** Stopped-band tint/hatch/border color (`--qm-chart-stopped`). */
  readonly stopped: string;
  /** The failed-cycle markers' color (`--qm-color-danger` — the error tone). */
  readonly danger: string;
  /** Axis tick/label color (`--qm-color-muted`). */
  readonly axisLabel: string;
  /** Y-axis split lines (`--qm-color-muted-background`). */
  readonly splitLine: string;
  /** Tooltip background (`--qm-color-background`). */
  readonly tooltipBackground: string;
  /** Tooltip border (`--qm-color-muted`). */
  readonly tooltipBorder: string;
  /** Tooltip text (`--qm-color-foreground`). */
  readonly tooltipText: string;
  /** The shell's font stack, so chart typography matches the UI. */
  readonly fontFamily: string;
}

/** Reads one `--qm-*` token name; the DOM implementation reads the cascade. */
export type ChartTokenReader = (name: string) => string;

/** Every token the charts read — the single list both themes must carry. */
export const CHART_TOKEN_NAMES = Object.freeze([
  '--qm-chart-used',
  '--qm-chart-remaining',
  '--qm-chart-peak',
  '--qm-chart-reset',
  '--qm-chart-gap',
  '--qm-chart-stopped',
  '--qm-color-danger',
  '--qm-color-muted',
  '--qm-color-muted-background',
  '--qm-color-background',
  '--qm-color-foreground',
  '--qm-font-family',
] as const);

/** Maps the live token cascade onto {@link ChartTokens}. */
export function chartTokensOf(read: ChartTokenReader): ChartTokens {
  return {
    used: read('--qm-chart-used'),
    remaining: read('--qm-chart-remaining'),
    peak: read('--qm-chart-peak'),
    reset: read('--qm-chart-reset'),
    gap: read('--qm-chart-gap'),
    stopped: read('--qm-chart-stopped'),
    danger: read('--qm-color-danger'),
    axisLabel: read('--qm-color-muted'),
    splitLine: read('--qm-color-muted-background'),
    tooltipBackground: read('--qm-color-background'),
    tooltipBorder: read('--qm-color-muted'),
    tooltipText: read('--qm-color-foreground'),
    fontFamily: read('--qm-font-family'),
  };
}
