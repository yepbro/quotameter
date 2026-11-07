import { describe, expect, it } from 'vitest';
import { createReloadFollowUps } from '../../src/server/composition';
import { keyIdentityOfSecret } from '../../src/services/account-suspensions';
import type { ReloadSuccess } from '../../src/config/reload';
import type { Validated } from '../../src/schemas/boundary';
import type { Config } from '../../src/schemas/config';
import type { QuotaRepository } from '../../src/storage/repository';

/**
 * The D-189 reload follow-up order, pinned at the composition's own
 * definition of "applying a reload" (FSM-3, review P3): config-sync →
 * polling-engine feed → key-identity report loop. The order between the
 * last two is load-bearing on the single D-064 store — the engine's
 * `setAccounts` observation must see (and re-anchor on) the release itself,
 * and a report-first regression would silently resume suspended accounts at
 * a stale future due. The behavioral consequence (the release re-anchor →
 * the immediate poll) is `polling-suspension-lockstep.spec.ts`'s; this spec
 * pins the composition's sequencing with recording seams.
 */

/** A successful reload literal over a configuration (§6.4's vocabulary). */
const reloadOf = (config: Config, applied: ReloadSuccess['applied']): ReloadSuccess => ({
  ok: true,
  outcome: 'applied',
  effective: {
    config: config as unknown as Validated<Config>,
    sources: { fields: [], accountSecrets: [] },
    fileAbsent: false,
  },
  applied,
  restartRequired: [],
});

/** A repository double recording the config-sync's calls into `order`. */
function repositorySpy(order: string[]): QuotaRepository {
  return {
    getAccount: () => {
      order.push('sync:getAccount');
      return null;
    },
    insertAccount: () => {
      order.push('sync:insert');
      return 1;
    },
  } as unknown as QuotaRepository;
}

describe('createReloadFollowUps (the D-189 order)', () => {
  it('runs config-sync → engine feed → key-identity report, in that order', () => {
    const order: string[] = [];
    const followUps = createReloadFollowUps({
      repository: repositorySpy(order),
      env: {},
      pollingEngine: {
        applyReloadChanges: () => order.push('engine-feed'),
      },
      suspensions: {
        reportKeyIdentity: (accountId, identity) => {
          order.push(`report:${accountId}:${identity === keyIdentityOfSecret('sk-a') ? 'A' : '?'}`);
          return false;
        },
      },
      clock: { now: () => 0 },
    });

    followUps(
      reloadOf(
        {
          app: { timezone: 'UTC' },
          accounts: [{ id: 'work', providerId: 'p', label: 'W', apiKey: 'sk-a' }],
        } as Config,
        ['accounts'],
      ),
    );

    // One timeline, one pass: the config-sync's mirror work precedes the
    // engine feed, which precedes the key-identity report loop — the
    // D-189 pin (a report-first regression reorders the tail and fails).
    expect(order).toEqual(['sync:getAccount', 'sync:insert', 'engine-feed', 'report:work:A']);
  });

  it('feeds the engine every result but syncs and reports only an accounts change', () => {
    const order: string[] = [];
    const followUps = createReloadFollowUps({
      repository: repositorySpy(order),
      env: {},
      pollingEngine: {
        applyReloadChanges: () => order.push('engine-feed'),
      },
      suspensions: {
        reportKeyIdentity: () => {
          order.push('report');
          return false;
        },
      },
      clock: { now: () => 0 },
    });

    followUps(
      reloadOf({ app: { timezone: 'UTC', pollingIntervalSeconds: 90 } } as Config, [
        'app.pollingIntervalSeconds',
      ]),
    );
    expect(order).toEqual(['engine-feed']); // the interval change reaches
    // the engine, but no row was mirrored and no identity reported

    followUps(reloadOf({ app: { timezone: 'UTC' } } as Config, []));
    expect(order).toEqual(['engine-feed', 'engine-feed']); // every result feeds
  });
});
