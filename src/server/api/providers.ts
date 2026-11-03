/**
 * The §13 providers endpoint (task 160, spec §13, §9.2; decision D-130).
 *
 * One read-only route inside the `/api` scope: `GET /providers` — §13's
 * "Available provider types and read-only peak-hour schedules". Pure
 * composition over two landed modules: the {@link ProviderRegistry} answers
 * the available types (§8.1 — a provider exists when an adapter is
 * registered, in registration order), and the live configuration's
 * `providers` section answers each one's schedule (§9.2 — the schedule is
 * provider-scoped configuration data, edited in the file and applied by
 * reload; the API and UI only ever read it). A provider without a
 * configured schedule answers `peakHours: null` — §9.2's "Peak-hours
 * schedule is not configured" state, never an invented schedule.
 *
 * Registry-driven by design (D-130): the list answers what an account CAN
 * be created against, so a configuration entry naming an adapter this
 * build does not carry is not listed (it is not an available type — the
 * D-119 doctor case reports it there); its schedule becomes effective for
 * history views only through the composition task's wiring. No secret can
 * reach this response: the registry exposes ids and names, the schedule
 * contract carries no secret fields, and the response serializes through
 * a closed TypeBox contract besides (the D-111/D-128 structural guard).
 *
 * No request surface exists to validate — the route takes no parameters —
 * so unlike its sibling plugins this one installs no scope-local strict
 * Ajv (D-128's discipline guards request schemas; there are none here).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ProviderRegistry } from '../../providers/registry';
import type { ProvidersConfig } from '../../schemas/config';
import {
  ProvidersListResponseSchema,
  type ProvidersListResponse,
} from '../../schemas/api/providers';

/** What the `/api` scope passes to {@link providersRoutes}. */
export interface ProvidersRouteOptions {
  /** The registry — the available provider types (§8.1). */
  readonly registry: ProviderRegistry;
  /**
   * The live configuration's `providers` section, read per request: the
   * schedules are §6.4-live (a reload swaps them), so the composition
   * hands over its live-config reader, not a startup snapshot.
   */
  readonly schedules: () => ProvidersConfig;
}

/**
 * Registers `GET /providers` inside the `/api` scope. The scope's three
 * guards (Origin, custom-header/content-type, §15.1 auth-mode) apply by
 * fastify's hook encapsulation; the route is not public (only health is,
 * §13).
 */
export const providersRoutes: FastifyPluginAsync<ProvidersRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.get(
    '/providers',
    {
      // §13: the response is defined by schema; the closed object is the
      // structural no-leak guard (D-111).
      schema: { response: { 200: ProvidersListResponseSchema } },
    },
    async (_request, reply) => {
      const schedules = options.schedules();
      reply.header('cache-control', 'no-store');
      const body: ProvidersListResponse = {
        providers: options.registry.list().map((provider) => ({
          id: provider.id,
          name: provider.name,
          peakHours: schedules[provider.id]?.peakHours ?? null,
          // The adapter's declared catalog or the honest empty array —
          // never invented labels (D-137).
          metrics: provider.metricCatalog === undefined ? [] : [...provider.metricCatalog],
        })),
      };
      return body;
    },
  );
};
