/**
 * The §13 providers endpoint contract (task 160, spec §13, §9.2; decision
 * D-130).
 *
 * TypeBox definitions for `GET /api/providers` — §13's "Available provider
 * types and read-only peak-hour schedules". The schedule half nests the
 * configuration contract's own `PeakHoursConfigSchema` (the response
 * carries that data verbatim, so its contract is the single source — the
 * `ID_PATTERN` sharing precedent of `src/schemas/api/accounts.ts`, applied
 * to a whole node). The behavior lives in `src/server/api/providers.ts`.
 *
 * The response object is closed (`additionalProperties: false`): the
 * compiled serializer emits exactly the declared keys (the D-111 guard,
 * generalized since D-128).
 */

import { type Static, Type } from '@sinclair/typebox';
import { PeakHoursConfigSchema } from '../config';

/**
 * One available provider type — a registry entry (§8.1: `id` and the
 * English `name`) joined with the provider's read-only peak-hours schedule
 * when the live configuration carries one. `peakHours` is `null` when no
 * schedule is configured: §9.2's "Peak-hours schedule is not configured"
 * state, never an invented schedule.
 */
export const ProviderViewSchema = Type.Object(
  {
    /** Stable adapter identifier — the registry key and account `providerId`. */
    id: Type.String({ minLength: 1, description: 'Provider adapter id.' }),
    /** English display name (spec §8.1). */
    name: Type.String({ minLength: 1, description: 'Provider display name.' }),
    /**
     * The provider's §9.2 schedule as configured, or `null` when the
     * configuration names none for this provider.
     */
    peakHours: Type.Union([PeakHoursConfigSchema, Type.Null()], {
      description: 'Read-only peak-hours schedule or null.',
    }),
  },
  { additionalProperties: false },
);

/** The shape of one providers-list row. */
export type ProviderView = Static<typeof ProviderViewSchema>;

/**
 * The `GET /api/providers` response — every registered adapter in
 * registration order, each with its configured schedule. Registry-driven
 * by design (D-130): the list answers "available provider types"; a
 * configuration entry naming an adapter this build does not carry is not an
 * available type and does not appear. `requestTimeoutSeconds` is
 * deliberately absent — §13 names types and schedules; the timeout stays a
 * configuration-file fact (§7.2).
 */
export const ProvidersListResponseSchema = Type.Object(
  { providers: Type.Array(ProviderViewSchema, { description: 'Available provider types.' }) },
  { additionalProperties: false },
);

/** The shape `GET /api/providers` serializes to. */
export type ProvidersListResponse = Static<typeof ProvidersListResponseSchema>;
