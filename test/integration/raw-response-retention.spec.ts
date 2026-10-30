import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openStorageConnection, type StorageConnection } from '../../src/storage/connection';
import {
  persistCollectionCycle,
  type ParseFailureCollectionCycle,
} from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  RAW_RESPONSE_MAX_PER_ACCOUNT,
  enforceRawResponseCap,
} from '../../src/storage/raw-response-retention';
import {
  createQuotaRepository,
  type NewAccount,
  type NewCollectionRun,
  type QuotaRepository,
} from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 103's done-condition (spec §7.4): "Keep at most 20 records per
 * account" — verified at the write moment, where the cap is enforced. Every
 * parse-failure payload enters through the 089 atomic-cycle seam, so the
 * suite pins the invariant continuously (after **every** write the account
 * holds at most 20), the 21st-write eviction of exactly the oldest record,
 * the boundary at exactly 20, cross-account independence, the deterministic
 * `(captured_at, run_id)` eviction order (same-instant tiebreak, an
 * out-of-order arrival older than everything retained), and the eviction's
 * transactional pairing with the cycle write (an injected failure rolls the
 * whole cycle back, §11.1). The standalone-pass half covers repair of a
 * facade-seeded overshoot (the write path cannot produce one), the no-op
 * pass, and the blank-account fail-fast before any row is touched.
 *
 * Conventions follow `test/integration/retention-cleanup.spec.ts` — fresh
 * disposable databases on the production connection (task 079), canonical
 * migrations, deterministic §11.1 timestamps. Payloads are synthetic
 * already-sanitized fixtures (D-041/D-049 discipline: no capture values).
 */

/** Deterministic §11.1 epoch-millisecond base for the factories. */
const T0 = 1_761_000_000_000;

/** Spacing between seeded cycles — one §7.1 polling minute. */
const STEP = 60_000;

function account(overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work plan',
    planName: 'Pro',
    createdAt: T0,
    ...overrides,
  };
}

/** A parse-failure cycle carrying a §7.4 payload distinct per index. */
function parseCycle(
  index: number,
  overrides: Partial<ParseFailureCollectionCycle> = {},
): ParseFailureCollectionCycle {
  const startedAt = overrides.startedAt ?? T0 + index * STEP;
  return {
    accountId: 'work',
    startedAt,
    endedAt: startedAt + 800,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    errorMessage: `envelope mismatch ${index}`,
    retryAfterSeconds: null,
    outcome: 'parse_error',
    rawResponse: {
      capturedAt: startedAt,
      httpStatus: 200,
      contentType: 'application/json',
      body: `{"seq": ${index}}`,
    },
    ...overrides,
  };
}

/**
 * Seeds `count` parse-failure payloads for `accountId` straight through the
 * facade — the write path a sanctioned caller never uses, and therefore the
 * only way to build an overshoot state (the cycle seam caps itself).
 */
function seedOvershoot(repository: QuotaRepository, accountId: string, count: number): number[] {
  const runIds: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const run: NewCollectionRun = {
      accountId,
      startedAt: T0 + index * STEP,
      endedAt: T0 + index * STEP + 800,
      intervalSeconds: 300,
      outcome: 'parse_error',
      httpStatus: 200,
      errorMessage: `seed ${index}`,
      attempts: 1,
      retryAfterSeconds: null,
    };
    const runId = repository.insertCollectionRun(run);
    repository.insertRawResponse({
      accountId,
      runId,
      capturedAt: run.startedAt,
      httpStatus: 200,
      contentType: 'application/json',
      body: `{"seed": ${index}}`,
    });
    runIds.push(runId);
  }
  return runIds;
}

/** Runs `body` against a fresh repository over the production connection. */
async function withRetention(
  body: (repository: QuotaRepository, database: DatabaseSync) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const connection: StorageConnection = openStorageConnection({ dataDir: dir.path });
    try {
      await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
      const repository = createQuotaRepository({ database: connection.database });
      await body(repository, connection.database);
    } finally {
      connection.close();
    }
  });
}

/** The retained payload bodies of `accountId`, oldest-listing-first helper. */
const retainedBodies = (repository: QuotaRepository, accountId: string): string[] =>
  repository.listRawResponses(accountId).map((row) => row.body);

describe('the §7.4 per-account cap at the write moment (task 103)', () => {
  it('holds after every parse-failure write; the 21st evicts exactly the oldest, its run survives', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      const runIds: number[] = [];
      for (let index = 0; index < 21; index += 1) {
        runIds.push(persistCollectionCycle(repository, parseCycle(index)));
        // The invariant is continuous, not eventual (decision D-067).
        expect(
          repository.listRawResponses('work').length,
          `after write ${index + 1}`,
        ).toBeLessThanOrEqual(RAW_RESPONSE_MAX_PER_ACCOUNT);
      }

      const retained = repository.listRawResponses('work');
      expect(retained).toHaveLength(RAW_RESPONSE_MAX_PER_ACCOUNT);
      // Newest first; the first payload is the one the 21st write evicted.
      expect(retained.map((row) => row.body)).toEqual(
        Array.from({ length: 20 }, (_, slot) => `{"seq": ${20 - slot}}`),
      );
      expect(repository.getRawResponseByRun(runIds[0]!)).toBeNull();
      expect(repository.getRawResponseByRun(runIds[20]!)).not.toBeNull();
      // Eviction deletes the payload only — the run is §11.1 history.
      const evictedRun = repository.getCollectionRun(runIds[0]!);
      expect(evictedRun?.outcome).toBe('parse_error');
      expect(repository.listCollectionRuns('work')).toHaveLength(21);
    });
  });

  it('keeps exactly twenty at the boundary — the 20th write evicts nothing', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      for (let index = 0; index < 20; index += 1) {
        persistCollectionCycle(repository, parseCycle(index));
      }
      const retained = repository.listRawResponses('work');
      expect(retained).toHaveLength(20);
      expect(retainedBodies(repository, 'work')[19]).toBe('{"seq": 0}');
    });
  });

  it('caps each account independently', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      repository.insertAccount(account({ id: 'personal', label: 'Personal plan' }));
      for (let index = 0; index < 25; index += 1) {
        persistCollectionCycle(repository, parseCycle(index));
      }
      for (let index = 0; index < 3; index += 1) {
        persistCollectionCycle(
          repository,
          parseCycle(index, { accountId: 'personal', errorMessage: `personal ${index}` }),
        );
      }
      expect(repository.listRawResponses('work')).toHaveLength(RAW_RESPONSE_MAX_PER_ACCOUNT);
      expect(retainedBodies(repository, 'personal')).toEqual([
        '{"seq": 2}',
        '{"seq": 1}',
        '{"seq": 0}',
      ]);
    });
  });

  it('evicts by (captured_at, run_id): same-instant tiebreak and an out-of-order arrival', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      // Three payloads share T0: run ids break the tie, so writes 21 and 22
      // evict runs 1 and 2 — not run 3, same instant, higher id.
      const runIds: number[] = [];
      for (let index = 0; index < 22; index += 1) {
        const capturedAt = index < 3 ? T0 : T0 + index * STEP;
        runIds.push(
          persistCollectionCycle(repository, parseCycle(index, { startedAt: capturedAt })),
        );
      }
      expect(repository.getRawResponseByRun(runIds[0]!)).toBeNull();
      expect(repository.getRawResponseByRun(runIds[1]!)).toBeNull();
      expect(repository.getRawResponseByRun(runIds[2]!)).not.toBeNull();
      expect(repository.listRawResponses('work')).toHaveLength(20);

      // A payload older than everything retained evicts itself on arrival.
      persistCollectionCycle(repository, parseCycle(99, { startedAt: T0 - STEP }));
      expect(repository.listRawResponses('work')).toHaveLength(20);
      expect(retainedBodies(repository, 'work')[19]).toBe('{"seq": 2}');
    });
  });

  it('rolls the whole cycle back when the eviction fails (§11.1 atomicity)', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      for (let index = 0; index < 20; index += 1) {
        persistCollectionCycle(repository, parseCycle(index));
      }
      const failure = new Error('injected eviction failure');
      const inject = (target: QuotaRepository): QuotaRepository =>
        new Proxy(target, {
          get(target, property) {
            if (property === 'deleteRawResponsesByRunIds') {
              return () => {
                throw failure;
              };
            }
            if (property === 'withTransaction') {
              return (work: (tx: QuotaRepository) => number) =>
                target.withTransaction((tx) => work(inject(tx)));
            }
            return Reflect.get(target, property, target);
          },
        });
      const proxied = inject(repository);

      expect(() => persistCollectionCycle(proxied, parseCycle(20))).toThrow(failure);

      // The 21st cycle left nothing behind: no run row, no payload, and the
      // 20 retained payloads are exactly the pre-failure set.
      expect(repository.listCollectionRuns('work')).toHaveLength(20);
      expect(repository.listRawResponses('work')).toHaveLength(20);
      expect(retainedBodies(repository, 'work')[19]).toBe('{"seq": 0}');
      // The connection stays usable — the next write succeeds and caps.
      persistCollectionCycle(repository, parseCycle(21));
      expect(repository.listRawResponses('work')).toHaveLength(20);
      expect(retainedBodies(repository, 'work')[19]).toBe('{"seq": 1}');
    });
  });
});

describe('enforceRawResponseCap — the standalone pass', () => {
  it('repairs a facade-seeded overshoot to the newest twenty in one call', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      const runIds = seedOvershoot(repository, 'work', 25);

      const result = enforceRawResponseCap(repository, 'work');

      expect(result).toEqual({ retained: 20, evicted: 5 });
      const retained = repository.listRawResponses('work');
      expect(retained.map((row) => row.body)).toEqual(
        Array.from({ length: 20 }, (_, slot) => `{"seed": ${24 - slot}}`),
      );
      for (const runId of runIds.slice(0, 5)) {
        expect(repository.getRawResponseByRun(runId!)).toBeNull();
      }
    });
  });

  it('is a reporting no-op at or under the cap', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      seedOvershoot(repository, 'work', 5);
      expect(enforceRawResponseCap(repository, 'work')).toEqual({ retained: 5, evicted: 0 });
      expect(retainedBodies(repository, 'work')).toHaveLength(5);
    });
  });

  it('rejects a blank accountId before touching any row', async () => {
    await withRetention((repository) => {
      repository.insertAccount(account());
      seedOvershoot(repository, 'work', 1);
      expect(() => enforceRawResponseCap(repository, '   ')).toThrow(/non-blank/);
      expect(retainedBodies(repository, 'work')).toHaveLength(1);
    });
  });
});
