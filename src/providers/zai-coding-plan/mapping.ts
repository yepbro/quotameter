/**
 * Z.ai Coding Plan metric mapping (spec §8.3, §8.4; tasks 099/100,
 * decisions D-047/D-053).
 *
 * The pure translation of endpoint-1's quota-limit payload
 * (`GET /api/monitor/usage/quota/limit`) into the §8.4 normalized model,
 * implementing the recognition and field-by-field tables of the dossier's
 * task-096 adapter contract (decision D-047): entry recognition by
 * `(type, unit)`, unknown-pair skip + first-wins key collisions (both
 * reported, never thrown), the D-047.1 value semantics (`usage` = allowance,
 * `currentValue` = consumed), the D-047.2 integer-percent pass-through, the
 * two-tier strictness of D-047.5 (containers strict at the caller, entry
 * fields tolerant), and the §8.4 derivation rules.
 *
 * Task 099 laid this module complete because its done-condition required
 * validated responses to produce a normalized snapshot; task 100
 * (2026-10-31) verified every D-047 mapping row against every fixture —
 * recognition identities and labels pinned by exact-equality rows, the
 * parseable fixture set checked for §8.4 unit discipline — with no
 * semantic change: the tables above remain decision property (D-047,
 * D-053). The module is pure — no HTTP, no clock, no logging. Skip and
 * collision reports travel as data (`skips`); the caller
 * ([`snapshot.ts`](snapshot.ts)) logs them.
 */

import type {
  DerivedMetricField,
  LimitType,
  MetricUnit,
  NormalizedMetric,
} from '../../schemas/metrics';

/* ── Recognition identities (D-047) ────────────────────────────────────── */

/** What a recognized `(type, unit)` pair maps a limits entry onto. */
interface MetricIdentity {
  /** Stable §8.4 metric key — the series identity. */
  readonly key: string;
  /** English display label. */
  readonly label: string;
  /** Quota accounting regime. */
  readonly limitType: LimitType;
  /**
   * Whether the §8.4 `unit` follows the present fields: `CREDITS` when any
   * absolute value is supplied, `PERCENT` while only `percentage` is
   * (assumption A5 — absolute values on token/weekly entries are unobserved,
   * and 094's documented credit metering beats the `TOKENS_LIMIT` type name).
   */
  readonly unitByFields: boolean;
  /** Whether `windowSeconds` derives from `number × 3600` (rolling hours). */
  readonly windowFromNumber: boolean;
}

/** `(TIME_LIMIT, 5)` — the monthly MCP-tool quota (verified, capture). */
const MONTHLY_MCP: MetricIdentity = {
  key: 'mcp-monthly',
  label: 'Monthly MCP tool quota',
  limitType: 'MONTHLY',
  unitByFields: false,
  windowFromNumber: false,
};

/** `(TOKENS_LIMIT, 3)` — the rolling 5-hour token quota (verified, capture). */
const TOKENS_5H: MetricIdentity = {
  key: 'tokens-5h',
  label: '5-hour token quota',
  limitType: 'ROLLING_WINDOW',
  unitByFields: true,
  windowFromNumber: true,
};

/** `unit 6` on either type — the weekly quota (assumption A1, unobserved). */
const WEEKLY_QUOTA: MetricIdentity = {
  key: 'weekly-quota',
  label: 'Weekly quota',
  limitType: 'WEEKLY',
  unitByFields: true,
  windowFromNumber: false,
};

/**
 * Recognizes a limits entry by its `(type, unit)` pair (D-047): the quota
 * mechanism and its window time-unit (3 = hours, 5 = months, 6 = weeks —
 * 093 prototype labels). Non-object entries and unknown pairs return
 * `undefined` — the caller skips and reports them; an unrecognized entry is
 * not a metric, and minting series keys for unknown shapes would fragment
 * the metric history.
 */
function recognizeEntry(entry: unknown): MetricIdentity | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (record.type === 'TIME_LIMIT' && record.unit === 5) return MONTHLY_MCP;
  if (record.type === 'TOKENS_LIMIT' && record.unit === 3) return TOKENS_5H;
  if ((record.type === 'TIME_LIMIT' || record.type === 'TOKENS_LIMIT') && record.unit === 6) {
    return WEEKLY_QUOTA;
  }
  return undefined;
}

/** Renders a payload value for a skip report: strings quoted, rest as-is. */
function describeValue(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * The skip report for an unrecognized entry — the (type, unit) pair the
 * adapter did not map, or the fact that the entry was not an object at all.
 * Values are payload enums, not secrets; the caller's logger scrubs known
 * secret values regardless (D-025).
 */
function skipReason(entry: unknown): string {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'skipped limits entry that was not an object';
  }
  const record = entry as Record<string, unknown>;
  return `skipped unrecognized limits entry (type ${describeValue(record.type)}, unit ${describeValue(record.unit)})`;
}

/* ── Entry field mapping (tolerant tier, D-047.5) ──────────────────────── */

/** A present field value that is a usable finite number. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The absolute-triple source fields in canonical derivation order. */
const VALUE_FIELDS = Object.freeze(['usage', 'currentValue', 'remaining', 'percentage'] as const);

/** Builds an invalid metric: no numeric quota values, metadata retained (D-010). */
function invalidMetric(
  identity: MetricIdentity,
  unit: MetricUnit,
  windowSeconds: number | undefined,
  resetsAt: number | undefined,
  invalidReason: string,
): NormalizedMetric {
  const metric: NormalizedMetric = {
    key: identity.key,
    label: identity.label,
    limitType: identity.limitType,
    unit,
    isValid: false,
    invalidReason,
  };
  // Metadata survives an invalid reading (D-010): a window length or reset
  // schedule can remain known when the values fail.
  if (windowSeconds !== undefined) metric.windowSeconds = windowSeconds;
  if (resetsAt !== undefined) metric.resetsAt = resetsAt;
  return metric;
}

/**
 * Maps one recognized limits entry to its metric — the D-047 field table.
 * Deterministic check order: wrong-typed values, then value presence, then
 * the supplied-triple arithmetic identity, then derivations. Derivations
 * never chain on derived values (§8.4: a missing value may be derived only
 * when the required original fields are *supplied*) — the one sanctioned
 * exception is `percentRemaining = 100 − percentUsed`, derived from a
 * supplied *or* derived percentage (dossier table).
 */
function buildMetric(identity: MetricIdentity, entry: Record<string, unknown>): NormalizedMetric {
  const windowNumber = identity.windowFromNumber ? finiteNumber(entry.number) : undefined;
  const windowSeconds = windowNumber === undefined ? undefined : windowNumber * 3600;
  const resetsAt = finiteNumber(entry.nextResetTime);
  const unit = unitForEntry(identity, entry);

  // A wrong-typed value field (string percentage, NaN, …) invalidates the
  // entry but not the response; the first offender in canonical order is
  // named.
  for (const field of VALUE_FIELDS) {
    const value = entry[field];
    if (value !== undefined && finiteNumber(value) === undefined) {
      return invalidMetric(identity, unit, windowSeconds, resetsAt, `${field} is not a number`);
    }
  }

  const limit = finiteNumber(entry.usage);
  const used = finiteNumber(entry.currentValue);
  const remaining = finiteNumber(entry.remaining);
  const percentSupplied = finiteNumber(entry.percentage);

  if (
    limit === undefined &&
    used === undefined &&
    remaining === undefined &&
    percentSupplied === undefined
  ) {
    return invalidMetric(
      identity,
      unit,
      windowSeconds,
      resetsAt,
      'no quota values present on limits entry',
    );
  }

  // The arithmetic identity is checked only when the whole triple was
  // supplied (D-047.1): a partially supplied triple is completed by
  // derivation below, which forces the identity by construction.
  if (limit !== undefined && used !== undefined && remaining !== undefined) {
    if (used + remaining !== limit) {
      return invalidMetric(
        identity,
        unit,
        windowSeconds,
        resetsAt,
        'currentValue + remaining does not equal usage',
      );
    }
  }

  const derived: DerivedMetricField[] = [];
  let usedValue = used;
  let limitValue = limit;
  let remainingValue = remaining;
  if (used !== undefined && limit !== undefined && remaining === undefined) {
    remainingValue = limit - used;
    derived.push('remaining');
  } else if (used !== undefined && remaining !== undefined && limit === undefined) {
    limitValue = used + remaining;
    derived.push('limit');
  } else if (limit !== undefined && remaining !== undefined && used === undefined) {
    usedValue = limit - remaining;
    derived.push('used');
  }

  // percentage is passed through verbatim (D-047.2: no re-scaling, no
  // rounding correction, no cross-validation against the absolutes). The
  // only permitted absolute→percentage derivation requires both `used` and
  // `limit` to have been *supplied* — never a derived `limit` — and a
  // zero allowance to be non-finite division, so the derivation is skipped
  // there (the metric keeps its absolutes; review finding P1-1).
  let percentUsed = percentSupplied;
  if (percentUsed === undefined && used !== undefined && limit !== undefined && limit !== 0) {
    percentUsed = (100 * used) / limit;
    derived.push('percentUsed');
  }
  let percentRemaining: number | undefined;
  if (percentUsed !== undefined) {
    percentRemaining = 100 - percentUsed;
    derived.push('percentRemaining');
  }

  const metric: NormalizedMetric = {
    key: identity.key,
    label: identity.label,
    limitType: identity.limitType,
    unit,
    isValid: true,
  };
  if (windowSeconds !== undefined) metric.windowSeconds = windowSeconds;
  if (usedValue !== undefined) metric.used = usedValue;
  if (remainingValue !== undefined) metric.remaining = remainingValue;
  if (limitValue !== undefined) metric.limit = limitValue;
  if (percentUsed !== undefined) metric.percentUsed = percentUsed;
  if (percentRemaining !== undefined) metric.percentRemaining = percentRemaining;
  if (resetsAt !== undefined) metric.resetsAt = resetsAt;
  if (derived.length > 0) metric.derivedFields = derived;
  return metric;
}

/**
 * The §8.4 unit of a by-fields identity (A5): `CREDITS` when any absolute
 * value arrived as a finite number, `PERCENT` while only `percentage` did.
 * Fixed-unit identities (`mcp-monthly` → `REQUESTS`) ignore the fields.
 */
function unitForEntry(identity: MetricIdentity, entry: Record<string, unknown>): MetricUnit {
  if (!identity.unitByFields) return 'REQUESTS';
  const hasAbsolutes =
    finiteNumber(entry.usage) !== undefined ||
    finiteNumber(entry.currentValue) !== undefined ||
    finiteNumber(entry.remaining) !== undefined;
  return hasAbsolutes ? 'CREDITS' : 'PERCENT';
}

/* ── Public API ────────────────────────────────────────────────────────── */

/** The result of mapping endpoint-1's `data` container. */
export interface QuotaLimitMapping {
  /** One metric per recognized entry, in response order, keys unique. */
  readonly metrics: NormalizedMetric[];
  /** The `data.level` plan-name candidate; `undefined` when absent/blank/non-string. */
  readonly planName: string | undefined;
  /** Skip reports for unrecognized and colliding entries (caller logs them). */
  readonly skips: readonly string[];
}

/**
 * Maps endpoint-1's `limits` array and `level` value (spec §8.3 → §8.4;
 * D-047 tables). Container types must already be validated strict by the
 * caller ([`snapshot.ts`](snapshot.ts) — parse error on violation); this
 * function never throws: field-level defects degrade to invalid metrics and
 * unknown shapes to skips, so a response with one broken entry keeps its
 * healthy siblings. Entries are processed in array order; a later entry
 * mapping to an already-emitted key is skipped (first wins, §8.4 requires
 * unique keys within a snapshot) and reported.
 */
export function mapQuotaLimitData(limits: readonly unknown[], level: unknown): QuotaLimitMapping {
  const metrics: NormalizedMetric[] = [];
  const skips: string[] = [];
  const seenKeys = new Set<string>();
  for (const entry of limits) {
    const identity = recognizeEntry(entry);
    if (identity === undefined) {
      skips.push(skipReason(entry));
      continue;
    }
    if (seenKeys.has(identity.key)) {
      skips.push(
        `skipped duplicate limits entry for metric key '${identity.key}' (first entry wins)`,
      );
      continue;
    }
    seenKeys.add(identity.key);
    metrics.push(buildMetric(identity, entry as Record<string, unknown>));
  }
  /**
   * The plan-name candidate: `data.level` verbatim when it is a usable
   * string. Blank values (including whitespace-only, which the snapshot
   * invariants reject) and non-strings count as absent — the endpoint-2
   * fallback then applies at snapshot assembly.
   */
  const planName = typeof level === 'string' && level.trim() !== '' ? level : undefined;
  return { metrics, planName, skips };
}
