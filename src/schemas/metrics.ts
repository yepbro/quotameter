/**
 * Normalized snapshot and metric model — the provider-neutral vocabulary every
 * consumer shares (spec §8.4).
 *
 * This module is the validated output of trust boundary 2 (provider
 * responses; see docs/architecture/trust-boundaries.md): adapters validate raw
 * provider payloads against adapter-local schemas and emit these shapes, and
 * storage (spec §11.2), the HTTP API (spec §13), and the UI (type-only
 * import) consume the same types from here.
 *
 * The model is deliberately pure TypeScript with no runtime dependency: §8.4
 * specifies the *output* shape of a trust boundary, not a validation schema.
 * Runtime validation of provider payloads is Stage 9 adapter work; TypeBox
 * schemas arrive with the configuration contract (task 061).
 */

/* ── Closed enums ──────────────────────────────────────────────────────── */

/**
 * Every `limitType` value the model accepts (spec §8.4). Storage CHECK
 * constraints and UI selects consume this exact set; adding a value is a code
 * change and requires a database migration.
 */
export const LIMIT_TYPES = Object.freeze([
  'ROLLING_WINDOW',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'OTHER',
] as const);

/** The quota accounting regime a metric belongs to (spec §8.4). */
export type LimitType = (typeof LIMIT_TYPES)[number];

/**
 * Every `unit` value the model accepts (spec §8.4). Adding a value is a code
 * change and requires a database migration.
 */
export const METRIC_UNITS = Object.freeze(['TOKENS', 'CREDITS', 'REQUESTS', 'PERCENT'] as const);

/**
 * The unit of `used`, `remaining`, and `limit` (spec §8.4). Percentage fields
 * are always percentage values; when a provider returns only percentages,
 * `unit` is `'PERCENT'` and the absolute fields stay empty.
 */
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * Field names that may appear in `derivedFields` (spec §8.4): the numeric
 * fields a metric may compute from other supplied fields, for example
 * `remaining = limit - used`. Token counts must never be derived from
 * percentages; derivations only fill fields whose inputs the provider gave.
 */
export const DERIVED_METRIC_FIELDS = Object.freeze([
  'used',
  'remaining',
  'limit',
  'percentUsed',
  'percentRemaining',
] as const);

/** A numeric metric field that may be marked as derived (spec §8.4). */
export type DerivedMetricField = (typeof DERIVED_METRIC_FIELDS)[number];

/** True when `value` is a member of the closed list `values`. */
function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

/** Narrows unknown input (for example a database row) to a `LimitType`. */
export function isLimitType(value: unknown): value is LimitType {
  return oneOf(LIMIT_TYPES, value);
}

/** Narrows unknown input to a `MetricUnit`. */
export function isMetricUnit(value: unknown): value is MetricUnit {
  return oneOf(METRIC_UNITS, value);
}

/** Narrows unknown input to a `DerivedMetricField`. */
export function isDerivedMetricField(value: unknown): value is DerivedMetricField {
  return oneOf(DERIVED_METRIC_FIELDS, value);
}

/* ── Model types ───────────────────────────────────────────────────────── */

/** One provider-neutral quota metric reading (spec §8.4). */
export interface NormalizedMetric {
  /** Stable, adapter-defined identifier; the series identity together with account and time. */
  key: string;
  /** English display label. */
  label: string;
  /** Quota accounting regime. */
  limitType: LimitType;
  /** Unit of `used`, `remaining`, and `limit`. */
  unit: MetricUnit;
  /** Window length in seconds for rolling-window quotas. */
  windowSeconds?: number;
  /** Consumed amount in `unit`; absent on invalid metrics. */
  used?: number;
  /** Remaining amount in `unit`; absent on invalid metrics. */
  remaining?: number;
  /** Total allowance in `unit`; absent on invalid metrics. */
  limit?: number;
  /** Percentage of the allowance consumed. */
  percentUsed?: number;
  /** Percentage of the allowance remaining. */
  percentRemaining?: number;
  /** Next quota reset, UTC epoch milliseconds. */
  resetsAt?: number;
  /**
   * Per-metric validity (spec §8.4): an invalid metric carries no numeric
   * values — never zero placeholders — and a non-empty `invalidReason`.
   */
  isValid: boolean;
  /** Why the metric is invalid; required when `isValid` is false. */
  invalidReason?: string;
  /** Names of fields computed from other supplied fields (spec §8.4). */
  derivedFields?: DerivedMetricField[];
}

/** A provider-neutral snapshot returned by every adapter (spec §8.4, §8.1). */
export interface ProviderSnapshot {
  /** Adapter identifier from the provider registry (spec §8.1). */
  providerId: string;
  /** Collection time, UTC epoch milliseconds. */
  collectedAt: number;
  /** Provider-reported plan name, when available. */
  planName?: string;
  /** Metrics collected in this cycle; keys are unique within a snapshot. */
  metrics: NormalizedMetric[];
}

/* ── Invariant checks ──────────────────────────────────────────────────── */

/**
 * The numeric quota-value fields of `NormalizedMetric`, in spec order. They
 * are exactly the fields that may be derived (spec §8.4) and exactly the
 * fields an invalid metric must not carry.
 */
const NUMERIC_METRIC_FIELDS = Object.freeze([...DERIVED_METRIC_FIELDS] as const);

/**
 * Optional numeric metadata — `windowSeconds` (a duration in seconds) and
 * `resetsAt` (UTC epoch milliseconds) — that must be a finite number when set.
 * Unlike the quota-value fields, these stay meaningful on invalid metrics.
 */
const NUMERIC_METADATA_FIELDS = Object.freeze(['windowSeconds', 'resetsAt'] as const);

/**
 * Returns the spec-§8.4/§11.2 invariant violations of `metric` as
 * field-addressed problems (the `problems` vocabulary of `boundary.ts`); an
 * empty array means the metric may be persisted and served.
 *
 * Encoding the rules once here keeps the storage write path and the adapter
 * emit path from each reimplementing them.
 */
export function findNormalizedMetricProblems(metric: NormalizedMetric): string[] {
  const problems: string[] = [];

  if (typeof metric.key !== 'string' || metric.key.trim() === '') {
    problems.push('key: must be a non-empty string');
  }
  if (typeof metric.label !== 'string' || metric.label.trim() === '') {
    problems.push('label: must be a non-empty string');
  }
  if (!isLimitType(metric.limitType)) {
    problems.push(`limitType: must be one of ${LIMIT_TYPES.join(', ')}`);
  }
  if (!isMetricUnit(metric.unit)) {
    problems.push(`unit: must be one of ${METRIC_UNITS.join(', ')}`);
  }

  const present: string[] = [];
  for (const field of NUMERIC_METRIC_FIELDS) {
    const value = metric[field];
    if (value === undefined) continue;
    present.push(field);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${field}: must be a finite number`);
    }
  }
  for (const field of NUMERIC_METADATA_FIELDS) {
    const value = metric[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      problems.push(`${field}: must be a finite number`);
    }
  }

  if (typeof metric.isValid !== 'boolean') {
    problems.push('isValid: must be a boolean');
  } else if (metric.isValid) {
    // Spec §11.2: a valid metric row includes at least one usable numeric value.
    if (present.length === 0) {
      problems.push('metric: a valid metric must supply at least one numeric value');
    }
  } else {
    // Spec §8.4: an invalid metric is stored without numeric values, not as
    // zero. "Numeric values" are the five quota-value fields above; the
    // metadata fields (windowSeconds, resetsAt) may be retained, because a
    // window length or reset schedule can remain known when a reading fails
    // (decision D-010).
    if (present.length > 0) {
      problems.push(`${present.join(', ')}: an invalid metric must not carry numeric values`);
    }
    if (typeof metric.invalidReason !== 'string' || metric.invalidReason.trim() === '') {
      problems.push('invalidReason: required when the metric is invalid');
    }
  }

  if (metric.derivedFields !== undefined) {
    if (!Array.isArray(metric.derivedFields)) {
      problems.push('derivedFields: must be an array of field names');
    } else {
      const seenDerived = new Set<string>();
      metric.derivedFields.forEach((name, index) => {
        if (!isDerivedMetricField(name)) {
          problems.push(`derivedFields[${index}]: '${String(name)}' is not a derivable field name`);
          return;
        }
        if (seenDerived.has(name)) {
          problems.push(`derivedFields[${index}]: '${name}' is listed more than once`);
          return;
        }
        seenDerived.add(name);
        if (metric[name] === undefined) {
          problems.push(
            `derivedFields[${index}]: '${name}' is marked as derived but the field is not set`,
          );
        }
      });
    }
  }

  return problems;
}

/**
 * Returns the invariant violations of `snapshot` (and each of its metrics) as
 * field-addressed problems; an empty array means the snapshot may be persisted
 * and served. Metric problems are addressed by position, since a metric with a
 * broken key cannot be addressed by key.
 */
export function findProviderSnapshotProblems(snapshot: ProviderSnapshot): string[] {
  const problems: string[] = [];

  if (typeof snapshot.providerId !== 'string' || snapshot.providerId.trim() === '') {
    problems.push('providerId: must be a non-empty string');
  }
  if (
    snapshot.planName !== undefined &&
    (typeof snapshot.planName !== 'string' || snapshot.planName.trim() === '')
  ) {
    problems.push('planName: must be a non-empty string when present');
  }
  if (typeof snapshot.collectedAt !== 'number' || !Number.isFinite(snapshot.collectedAt)) {
    problems.push('collectedAt: must be a finite UTC epoch-milliseconds timestamp');
  }
  if (!Array.isArray(snapshot.metrics)) {
    problems.push('metrics: must be an array of normalized metrics');
    return problems;
  }

  const seenKeys = new Set<string>();
  for (const [index, metric] of snapshot.metrics.entries()) {
    if (metric === null || typeof metric !== 'object') {
      problems.push(`metrics[${index}]: must be a metric object`);
      continue;
    }
    for (const problem of findNormalizedMetricProblems(metric)) {
      problems.push(`metrics[${index}].${problem}`);
    }
    if (typeof metric.key === 'string' && metric.key !== '') {
      if (seenKeys.has(metric.key)) {
        problems.push(`metrics[${index}].key: duplicate metric key '${metric.key}'`);
      }
      seenKeys.add(metric.key);
    }
  }

  return problems;
}
