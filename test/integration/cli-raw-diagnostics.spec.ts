import { describe, expect, it } from 'vitest';
import { readRawDiagnostics, renderRawDiagnostics } from '../../src/cli/raw-diagnostics';
import { openStorageConnection, type StorageConnection } from '../../src/storage/connection';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { RAW_RESPONSE_MAX_PER_ACCOUNT } from '../../src/storage/raw-response-retention';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * The §7.4 diagnostic read against a real database (task 103): the CLI's
 * `readRawDiagnostics` is the bounded `listRawResponses` call — newest
 * first, at most the cap even in an overshoot state the write path cannot
 * produce (seeded through the facade, `test/integration/
 * raw-response-retention.spec.ts` conventions), account-scoped by
 * construction. The renderer is exercised end-to-end on real records.
 */

/** Deterministic §11.1 epoch-millisecond base. */
const T0 = 1_761_000_000_000;

/** Spacing between seeded rows. */
const STEP = 60_000;

/** Seeds `count` parse-failure payloads for `accountId` through the facade. */
function seedRawResponses(
  repository: QuotaRepository,
  accountId: string,
  providerId: string,
  count: number,
): void {
  repository.insertAccount({
    id: accountId,
    providerId,
    label: `${accountId} plan`,
    planName: 'Pro',
    createdAt: T0,
  });
  for (let index = 0; index < count; index += 1) {
    const startedAt = T0 + index * STEP;
    const runId = repository.insertCollectionRun({
      accountId,
      startedAt,
      endedAt: startedAt + 800,
      intervalSeconds: 300,
      outcome: 'parse_error',
      httpStatus: 200,
      errorMessage: `seed ${index}`,
      attempts: 1,
      retryAfterSeconds: null,
    });
    repository.insertRawResponse({
      accountId,
      runId,
      capturedAt: startedAt,
      httpStatus: index % 2 === 0 ? 200 : null,
      contentType: 'application/json',
      body: `{"seed": "${accountId}-${index}"}`,
    });
  }
}

describe('readRawDiagnostics against a real database (task 103, spec §7.4)', () => {
  it("returns the account's newest payloads, bounded by the cap and isolated per account", async () => {
    await withTempDir(async (dir) => {
      const connection: StorageConnection = openStorageConnection({ dataDir: dir.path });
      try {
        await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
        const repository = createQuotaRepository({ database: connection.database });
        seedRawResponses(repository, 'work', 'zai-coding-plan', 25);
        seedRawResponses(repository, 'personal', 'zai-coding-plan', 2);

        const work = readRawDiagnostics(repository, 'work');
        expect(work).toHaveLength(RAW_RESPONSE_MAX_PER_ACCOUNT);
        // Newest first — seed 24 heads the list, seed 5 is the oldest kept.
        expect(work[0]?.body).toBe('{"seed": "work-24"}');
        expect(work[19]?.body).toBe('{"seed": "work-5"}');
        expect(work.map((row) => row.accountId).every((id) => id === 'work')).toBe(true);

        const personal = readRawDiagnostics(repository, 'personal');
        expect(personal.map((row) => row.body)).toEqual([
          '{"seed": "personal-1"}',
          '{"seed": "personal-0"}',
        ]);

        // Unknown accounts read as empty — nothing to diagnose.
        expect(readRawDiagnostics(repository, 'ghost')).toEqual([]);

        // The rendered text stays bounded by the cap on a real overshoot.
        const text = renderRawDiagnostics(work);
        expect(text).toContain('Sanitized raw responses: 20 shown (newest first)');
        expect(text).toContain('run ');
      } finally {
        connection.close();
      }
    });
  });
});
