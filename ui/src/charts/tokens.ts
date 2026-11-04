/**
 * The chart color plumbing (task 175, spec §14.1/§14.4; decisions D-133,
 * D-148): the mapping from the `--qm-*` design tokens onto the value set
 * the ECharts option consumes.
 *
 * D-133's rule is absolute — charts color themselves only through
 * `getComputedStyle` token lookups (re-read on every `resolvedTheme`
 * change), never through hardcoded palettes. Two dedicated tokens
 * (`--qm-chart-used`, `--qm-chart-remaining` — added to all three theme
 * blocks of `base.css`) carry the series colors; everything else the
 * charts need reuses the shell's existing tokens so a theme change keeps
 * the charts in step with the rest of the UI by construction.
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
    axisLabel: read('--qm-color-muted'),
    splitLine: read('--qm-color-muted-background'),
    tooltipBackground: read('--qm-color-background'),
    tooltipBorder: read('--qm-color-muted'),
    tooltipText: read('--qm-color-foreground'),
    fontFamily: read('--qm-font-family'),
  };
}
