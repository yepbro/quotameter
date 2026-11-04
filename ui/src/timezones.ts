/**
 * Pure display-time-zone helpers (spec §14.5, §5.3; decision D-156): the
 * settings page's "time-zone search over IANA zones" — the zone list and
 * the validity check, both derived from the browser's own `Intl`, which
 * is the same resolver the UI formats every date through (§14.1), so the
 * list, the validation, and the rendering can never disagree.
 *
 * §5.3's explicit-choice rule holds here too: the page never silently
 * adopts a zone (no "use system zone" option) — the operator's input is
 * either a valid IANA name or a field error. Validity mirrors the
 * server's own `isValidTimeZoneName` (`src/schemas/config.ts`): ECMA-402
 * offset identifiers (`+03:00`) are not IANA names and are rejected
 * before the `Intl` probe; the mirror is drift-pinned by
 * `test/component/timezones.spec.ts` (the `API_MUTATION_HEADER`
 * precedent — a runtime import would carry server code into the bundle).
 */

/**
 * True when `name` is a valid IANA time-zone identifier — the client-side
 * mirror of the server's check (see the module docblock). `Intl` resolves
 * names case-insensitively in V8 and accepts IANA aliases (`Asia/Calcutta`),
 * exactly as the server's resolver does.
 */
export function isValidTimeZone(name: string): boolean {
  if (name.startsWith('+') || name.startsWith('-')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser's IANA zone list (§14.5's search vocabulary). Engines without
 * `Intl.supportedValuesOf` (or with a hostile `Intl`) answer an empty list:
 * the input degrades to free text and {@link isValidTimeZone} stays the
 * authority — never a broken field.
 */
export function browserTimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/**
 * The zone's runtime-canonical name — `resolvedOptions()` maps IANA
 * links/aliases onto the canonical identifier the engine serves. Cached:
 * the resolver is comparatively expensive and the zone set is small.
 */
const canonicalZones = new Map<string, string | null>();

function canonicalZone(name: string): string | null {
  let canonical = canonicalZones.get(name);
  if (canonical === undefined) {
    try {
      canonical = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      canonical = null;
    }
    canonicalZones.set(name, canonical);
  }
  return canonical;
}

/**
 * The zones matching a typed query — case-insensitive substring over the
 * `Area/Locale` paths, in the served list's own (stable) order, capped so
 * the suggestion list stays a list. An empty or blank query matches
 * nothing (the suggestions are a narrowing affordance, not a catalog dump).
 *
 * The engine's list carries CLDR-canonical names (`Asia/Calcutta`), while
 * an operator may type the tzdb primary (`Asia/Kolkata`) — a full valid
 * zone name resolves canonically, so when the substring pass finds
 * nothing, the listed twins of the query's own canonical zone surface
 * instead. A partial modern alias (`Kolkata`) still matches nothing —
 * the vocabulary is the engine's, and validity never depends on list
 * membership (`isValidTimeZone` accepts both spellings).
 */
export function zoneSuggestions(query: string, zones: readonly string[], limit = 8): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const direct = zones.filter((zone) => zone.toLowerCase().includes(needle));
  if (direct.length > 0) return direct.slice(0, limit);
  const resolved = canonicalZone(needle);
  if (resolved === null) return [];
  return zones.filter((zone) => canonicalZone(zone) === resolved).slice(0, limit);
}
