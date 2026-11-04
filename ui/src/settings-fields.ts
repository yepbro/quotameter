/**
 * The settings page's UI-local vocabulary (task 179, spec §14.5, §7.1,
 * §11.3, §15.2; decision D-156): the validated ranges, the log-level
 * enum, and the §15.2 password minimum, as plain browser-side constants.
 *
 * Each value mirrors a server-side constant (the ranges live in
 * `src/schemas/config.ts`'s schema bounds, the levels and the password
 * minimum in exported constants) — deliberately NOT imported at runtime:
 * a runtime import would carry the server module graph into the browser
 * bundle for four numbers and an enum (the `API_MUTATION_HEADER`
 * precedent, D-134). `test/component/settings-view.spec.ts` pins every
 * value against its server counterpart, so the two cannot drift.
 */

/** §7.1's polling-interval floor, in seconds. */
export const POLLING_INTERVAL_MIN_SECONDS = 60;

/** §7.1's polling-interval ceiling, in seconds. */
export const POLLING_INTERVAL_MAX_SECONDS = 3600;

/** §11.3's accepted retention floor, in days. */
export const RETENTION_MIN_DAYS = 7;

/** §11.3's accepted retention ceiling, in days. */
export const RETENTION_MAX_DAYS = 3650;

/** §15.2's minimum password length, on the raw untrimmed value. */
export const MIN_PASSWORD_LENGTH = 12;

/** The `logging.level` choices, in the served enum's own order. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

/**
 * Parses a whole-number input strictly: the trimmed text must be an
 * optionally-signed digit run, or the value is not a whole number
 * (`parseInt` alone would accept `"60x"`; `Number` alone would accept
 * `"1e3"`). `null` is the honest "not a valid whole number" answer the
 * field validation consumes.
 */
function parseWholeInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * True when `raw` parses as a whole number inside the inclusive range —
 * the shared shape of the interval and retention field guards.
 */
export function isIntegerInRange(raw: string, min: number, max: number): boolean {
  const value = parseWholeInteger(raw);
  return value !== null && value >= min && value <= max;
}
