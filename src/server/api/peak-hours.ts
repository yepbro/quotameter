/**
 * The §13 peak-hours endpoint (task 162, spec §9.3, §13; decision D-142).
 *
 * One read route inside the `/api` scope: `GET /peak-hours` — the UTC
 * peak/off-peak timeline of the account's provider schedule over a requested
 * range. Pure composition over the landed services: task 114/115's
 * `calculatePeakHoursIntervals` (D-073/D-079 — the interval math, the DST
 * policy, and the partition contract are never re-derived here), task 123's
 * `boundHistoryRange` (D-082 — §13's retention sentence over the range), and
 * task 161's §13 range parsing and range report (D-139 — reused verbatim,
 * not forked: this route is §13's third named consumer of both).
 *
 * The timestamp rule (D-139, inherited): the request `from`/`to` are ISO 8601
 * UTC values parsed through `epochMsFromIso` (an explicit offset or `Z` is
 * mandatory), while every response timestamp stays the epoch-millisecond
 * integer of the landed §13 vocabulary — one format per direction. The
 * interval boundaries additionally carry their local times in the schedule
 * zone as D-073's `yyyy-MM-ddTHH:mm` strings, §9.3's own output requirement,
 * rendered by the calculator from the instants it actually emitted.
 *
 * Retention (D-142, closing §13's open choice for this route the D-139 way):
 * the 200-with-report — a range beyond the retention horizon is truncated or
 * rejected with the report in the body, and the intervals are computed over
 * the effective range only, so nothing older than retention is ever served.
 *
 * The no-schedule arm (§9.2, never an invented schedule): an account whose
 * provider has no `providers.<id>` configuration entry answers the schedule
 * facts as nulls with empty intervals; a configured schedule with empty
 * windows computes normally (the whole range is off-peak — the complement
 * of no windows). The §14 UI's "Peak-hours schedule is not configured"
 * message reads `/api/providers` (it serves the `windows` array); this route
 * serves intervals.
 *
 * Error vocabulary stays inside D-113's registry (no new codes): malformed
 * or offset-less timestamps and `from > to` answer VALIDATION with the
 * D-139 `details.reason` values (`invalid-timestamp` + the offending
 * `param`, `inverted-range`); an account unknown to both the configuration
 * store and the storage is NOT_FOUND (the D-128 both-halves verdict — an
 * archived account's timeline stays computable, §8.2); a range the
 * calculator refuses as too wide answers VALIDATION with `range-too-wide`
 * and the bound in days; and a range whose instants no zone conversion can
 * represent (the epoch ceiling's neighborhood) answers VALIDATION with
 * `range-unsupported` — checked before any computation, so each refusal
 * names its own truth.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { AccountConfigStore } from './accounts';
import { ApiError } from './error';
import { parseRequestedRange, rangeReportOf } from './history';
import { strictValidatorCompiler } from './validation';
import { calculatePeakHoursIntervals } from '../../services/peak-hours-intervals';
import type { PeakHoursTimeline, PeakHoursInterval } from '../../services/peak-hours-intervals';
import { MAX_QUERY_SPAN_DAYS } from '../../services/peak-hours-intervals';
import type { QuotaRepository } from '../../storage/repository';
import { boundHistoryRange } from '../../storage/history-retention';
import type { RetentionBoundedRange } from '../../storage/history-retention';
import { CONFIG_DEFAULTS } from '../../schemas/config';
import type { PeakHoursConfig, ProvidersConfig } from '../../schemas/config';
import { resolveTimeZone } from '../../util/clock';
import { DAY_MS } from '../../util/rolling-ranges';
import type {
  PeakHoursIntervalItem,
  PeakHoursQuery,
  PeakHoursResponse,
} from '../../schemas/api/peak-hours';
import { PeakHoursQuerySchema, PeakHoursResponseSchema } from '../../schemas/api/peak-hours';

/* ── The injected seams (D-121: define at the consumer) ─────────────────── */

/** What the `/api` scope passes to {@link peakHoursRoutes}. */
export interface PeakHoursRouteOptions {
  /** The configuration-side account store — 159's seam, the same instance. */
  readonly store: AccountConfigStore;
  /** The storage facade — the both-halves account verdict (D-058). */
  readonly repository: QuotaRepository;
  /**
   * The live configuration's `providers` section, read per request: the
   * schedule is §6.4-live (a reload swaps it), so the composition hands
   * over its live-config reader, not a startup snapshot — the same reader
   * the providers endpoint reads (D-130).
   */
  readonly schedules: () => ProvidersConfig;
  /**
   * The effective `app.historyRetentionDays` (§11.3's 7–3650 window), read
   * per request — the retention bound is §6.4-live, the
   * `pollingIntervalSeconds` precedent (D-130) and the history family's own
   * seam (D-139).
   */
  readonly historyRetentionDays: () => number;
  /** The clock the retention horizon is computed from (§11.1, D-021). */
  readonly now: () => number;
}

/* ── Pure view composition ─────────────────────────────────────────────── */

/**
 * The schedule of `providerId`, or null when the live configuration carries
 * no `providers.<providerId>` entry — §9.2's "not configured" state. A
 * configured schedule with empty windows is NOT null: it is a real schedule
 * whose peak set is empty (the whole range computes off-peak).
 */
export function resolveSchedule(
  schedules: ProvidersConfig,
  providerId: string,
): PeakHoursConfig | null {
  return schedules[providerId]?.peakHours ?? null;
}

/** The schedule facts the response echoes: the resolved zone and the effective off-peak rate. */
export interface ScheduleFacts {
  readonly timezone: string | null;
  readonly offPeakMultiplier: number | null;
}

/**
 * The response's schedule facts: null when no schedule is configured,
 * otherwise the resolved zone and the defaulted multiplier — exactly the two
 * values the calculator puts on its timeline (`resolveTimeZone` and the
 * `CONFIG_DEFAULTS` fallback it applies), so the wire and the computed
 * intervals can never disagree. The nullables are the no-schedule arm's
 * whole encoding; a boolean beside them would say the same thing twice.
 */
export function scheduleFactsOf(schedule: PeakHoursConfig | null): ScheduleFacts {
  if (schedule === null) {
    return { timezone: null, offPeakMultiplier: null };
  }
  return {
    timezone: resolveTimeZone(schedule.timezone),
    offPeakMultiplier: schedule.offPeakMultiplier ?? CONFIG_DEFAULTS.peakHours.offPeakMultiplier,
  };
}

/**
 * The timeline's intervals as wire entries — a verbatim, typed copy: the
 * service's frozen union members already carry the wire vocabulary (D-073
 * designed the timeline as the endpoint's output shape), and the copy only
 * bridges the service's branded types onto the schema's statics.
 */
export function intervalViews(timeline: PeakHoursTimeline): PeakHoursIntervalItem[] {
  return timeline.intervals.map((interval: PeakHoursInterval) => ({ ...interval }));
}

/**
 * Calculates the timeline over the effective range, mapping the calculator's
 * span refusal to the VALIDATION envelope. Reachability of the mapped arm
 * after the two pre-checks: `from`/`to` arrive pre-validated (finite and
 * ordered — `parseRequestedRange` ran first), the schedule zone is a
 * config-validated IANA id (§9.2's configuration rules gate the live
 * reader), and `requireRepresentableRange` has kept every instant the
 * calculator's walk can touch inside the representable epoch range — so the
 * span cap is the only throw this call can produce. The bound stays
 * single-sited in the service (D-073's `MAX_QUERY_SPAN_DAYS`; a route-side
 * pre-check would have to re-derive the local-day arithmetic).
 */
function calculateOverEffectiveRange(
  schedule: PeakHoursConfig,
  bounded: RetentionBoundedRange & { readonly outcome: 'ok' | 'truncated' },
): PeakHoursTimeline {
  try {
    return calculatePeakHoursIntervals(schedule, {
      from: bounded.effectiveFrom,
      to: bounded.effectiveTo,
    });
  } catch {
    throw new ApiError('VALIDATION', {
      message:
        `The requested range is too wide: the peak-hours timeline serves at most ` +
        `${MAX_QUERY_SPAN_DAYS} local days of the schedule zone`,
      details: { reason: 'range-too-wide', maxDays: MAX_QUERY_SPAN_DAYS },
    });
  }
}

/**
 * The ECMAScript time-value bounds (±8.64e15 ms) — the range every epoch the
 * calculator reads, renders, or walks must stay strictly inside with
 * headroom for: the schedule zone's offset (at most ±14 h), the guard local
 * day before the range, and a `24:00` end's next-midnight resolution after
 * it. Two days of headroom cover that whole neighborhood (the review
 * round's P2: a one-day range at the ceiling parsed fine and then died
 * inside the zone conversion, misclassified by the span catch below).
 */
const EPOCH_LIMIT_MS = 8_640_000_000_000_000;
const EPOCH_HEADROOM_MS = 2 * DAY_MS;

/**
 * Rejects, truthfully and before any computation, a range whose instants
 * the calculator cannot represent in the schedule zone — the honest refusal
 * names the epoch range, never the day cap.
 */
function requireRepresentableRange(from: number, to: number): void {
  if (from < -EPOCH_LIMIT_MS + EPOCH_HEADROOM_MS || to > EPOCH_LIMIT_MS - EPOCH_HEADROOM_MS) {
    throw new ApiError('VALIDATION', {
      message: 'The requested range lies outside the supported epoch range',
      details: { reason: 'range-unsupported' },
    });
  }
}

/**
 * The D-128 both-halves account verdict, with the provider id this route
 * needs beside it: an account known to neither the configuration store nor
 * the storage is the 404; an archived account (a row without an entry) stays
 * readable — §8.2 retains its timeline. The configured entry wins for the
 * provider id (§6.4's live-reloadable truth); a storage-only account reads
 * it from its denormalized row.
 */
async function resolveAccount(
  store: AccountConfigStore,
  repository: QuotaRepository,
  accountId: string,
): Promise<string> {
  const managed = await store.find(accountId);
  const row = repository.getAccount(accountId);
  if (managed === null && row === null) {
    throw new ApiError('NOT_FOUND', { message: 'Account not found' });
  }
  return managed?.providerId ?? row!.providerId;
}

/* ── The plugin ────────────────────────────────────────────────────────── */

/**
 * Registers `GET /peak-hours` inside the `/api` scope. The scope's three
 * guards (Origin, custom-header/content-type, §15.1 auth-mode) apply by
 * fastify's hook encapsulation; the route is not public (only health is,
 * §13), and it is a GET, so the mutation-header rules bind nothing.
 */
export const peakHoursRoutes: FastifyPluginAsync<PeakHoursRouteOptions> = async (
  fastify,
  options,
) => {
  // Strict schema validation, scoped to this route (D-128's single
  // construction site in ./validation.ts): unknown or malformed query
  // fields answer the VALIDATION envelope instead of being silently
  // stripped.
  fastify.setValidatorCompiler(strictValidatorCompiler());

  fastify.get(
    '/peak-hours',
    {
      schema: {
        querystring: PeakHoursQuerySchema,
        response: { 200: PeakHoursResponseSchema },
      },
    },
    async (request, reply) => {
      const query = request.query as PeakHoursQuery;
      // The §13 parameters first (cheap, no I/O): a malformed or inverted
      // range is a client mistake whatever it targets.
      const requested = parseRequestedRange(query.from, query.to);
      requireRepresentableRange(requested.from, requested.to);
      const providerId = await resolveAccount(options.store, options.repository, query.accountId);

      // §13's retention sentence over this range, the D-139 way: the pure
      // bound plus the shared 200-with-report (one family, one shape).
      const bounded = boundHistoryRange(requested, {
        now: options.now(),
        retentionDays: options.historyRetentionDays(),
      });
      const range = rangeReportOf(bounded);

      // The intervals exist only for a configured schedule and a range
      // retention left queryable; the schedule facts echo either way —
      // they are configuration, not range output.
      const schedule = resolveSchedule(options.schedules(), providerId);
      const facts = scheduleFactsOf(schedule);
      const intervals =
        schedule !== null && bounded.outcome !== 'rejected'
          ? intervalViews(calculateOverEffectiveRange(schedule, bounded))
          : [];

      reply.header('cache-control', 'no-store');
      const body: PeakHoursResponse = {
        accountId: query.accountId,
        providerId,
        timezone: facts.timezone,
        offPeakMultiplier: facts.offPeakMultiplier,
        range,
        intervals,
      };
      return body;
    },
  );
};
