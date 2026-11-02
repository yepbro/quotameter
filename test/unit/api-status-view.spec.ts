import { describe, expect, it } from 'vitest';
import type { CollectionRunRecord, QuotaRepository } from '../../src/storage/repository';
import { INITIAL_SUSPENSION_STATE } from '../../src/services/polling-suspension';
import type { PollingRunEvidence } from '../../src/services/polling-status';
import {
  lastErrorOf,
  metricView,
  redactSecretOccurrences,
  statusAccountView,
} from '../../src/server/api/status';

/**
 * The pure half of task 160's status/quota composition (decision D-130):
 * the §7.2 last-error selection over the six failure classes, the §7.4
 * exact-occurrence redaction, the §7.3 view delegation, and the §11.2 →
 * §8.4 metric row rendering. Pinned here so the endpoint suites pin wire
 * behavior only.
 */

/** Deterministic §11.1 epoch-millisecond timestamps. */
const T0 = 1_761_000_000_000;

/** A run row — the base every override spreads. */
function run(overrides: Partial<CollectionRunRecord> = {}): CollectionRunRecord {
  return {
    id: 1,
    accountId: 'work',
    startedAt: T0,
    endedAt: T0 + 1_000,
    intervalSeconds: 300,
    outcome: 'network_error',
    httpStatus: null,
    errorMessage: 'connection refused',
    attempts: 1,
    retryAfterSeconds: null,
    ...overrides,
  };
}

/** A repository double answering from a per-outcome table. */
function repositoryWith(
  latest: Partial<Record<string, CollectionRunRecord | null>>,
): QuotaRepository {
  return {
    getLatestCollectionRun: (_accountId: string, outcome?: string) =>
      outcome === undefined ? null : (latest[outcome] ?? null),
  } as unknown as QuotaRepository;
}

describe('lastErrorOf (§7.2: the newest non-success run)', () => {
  it('picks the newest failure across the six outcome classes', () => {
    const repository = repositoryWith({
      auth_error: run({
        id: 3,
        startedAt: T0 - 100_000,
        outcome: 'auth_error',
        errorMessage: 'HTTP 401',
      }),
      network_error: run({ id: 7, startedAt: T0 - 1_000, outcome: 'network_error' }),
      parse_error: run({
        id: 5,
        startedAt: T0 - 50_000,
        outcome: 'parse_error',
        errorMessage: 'unexpected schema',
      }),
    });
    expect(lastErrorOf(repository, 'work')).toEqual({
      outcome: 'network_error',
      message: 'connection refused',
      at: T0 - 1_000,
    });
  });

  it('resolves equal start stamps to the later run (the D-077 discipline)', () => {
    const repository = repositoryWith({
      timeout: run({ id: 4, startedAt: T0, outcome: 'timeout', errorMessage: 'timed out' }),
      server_error: run({
        id: 9,
        startedAt: T0,
        outcome: 'server_error',
        errorMessage: 'HTTP 502',
      }),
    });
    expect(lastErrorOf(repository, 'work')).toEqual({
      outcome: 'server_error',
      message: 'HTTP 502',
      at: T0,
    });
  });

  it('answers null when every recorded run succeeded and renders a missing message honestly', () => {
    expect(lastErrorOf(repositoryWith({}), 'work')).toBeNull();
    const messageless = repositoryWith({
      rate_limited: run({ id: 2, startedAt: T0, outcome: 'rate_limited', errorMessage: null }),
    });
    expect(lastErrorOf(messageless, 'work')).toEqual({
      outcome: 'rate_limited',
      message: '',
      at: T0,
    });
  });
});

describe('redactSecretOccurrences (§7.4 rule, server-side)', () => {
  it('replaces every exact occurrence and leaves unrelated text intact', () => {
    const marker = 'sk-marker-secret-4f7a1c9e2b';
    expect(redactSecretOccurrences(`key ${marker} failed`, marker)).toBe('key [REDACTED] failed');
    expect(redactSecretOccurrences(`${marker}/${marker}`, marker)).toBe('[REDACTED]/[REDACTED]');
    expect(redactSecretOccurrences('connection refused', marker)).toBe('connection refused');
  });

  it('passes text through unchanged when no secret resolves', () => {
    expect(redactSecretOccurrences('connection refused', null)).toBe('connection refused');
    expect(redactSecretOccurrences('connection refused', '')).toBe('connection refused');
  });

  it('never redacts substrings of the secret (exact occurrences only)', () => {
    expect(redactSecretOccurrences('sk-marker', 'sk-marker-secret-4f7a1c9e2b')).toBe('sk-marker');
  });
});

describe('statusAccountView (the §7.3 delegation)', () => {
  const freshEvidence: PollingRunEvidence = Object.freeze({
    latestRunOutcome: 'success',
    lastSuccessAt: T0 - 60_000,
    firstAttemptAt: T0 - 600_000,
  });

  it('derives fresh within the window and stale past it', () => {
    const input = {
      id: 'work',
      enabled: true,
      configured: true,
      suspension: INITIAL_SUSPENSION_STATE,
      runs: freshEvidence,
      intervalSeconds: 300,
    };
    expect(statusAccountView(input, null, T0)).toEqual({
      id: 'work',
      status: 'fresh',
      lastSuccessAt: T0 - 60_000,
      lastError: null,
    });
    expect(statusAccountView(input, null, T0 + 901_000).status).toBe('stale');
  });

  it('carries the last error beside the derivation untouched', () => {
    const view = statusAccountView(
      {
        id: 'work',
        enabled: true,
        configured: true,
        suspension: INITIAL_SUSPENSION_STATE,
        runs: { ...freshEvidence, latestRunOutcome: 'network_error' },
        intervalSeconds: 300,
      },
      { outcome: 'network_error', message: 'connection refused', at: T0 - 1_000 },
      T0,
    );
    expect(view.status).toBe('unreachable');
    expect(view.lastError).toEqual({
      outcome: 'network_error',
      message: 'connection refused',
      at: T0 - 1_000,
    });
  });

  it('derives disabled for the storage-only (archived) row — enabled wins', () => {
    expect(
      statusAccountView(
        {
          id: 'gone',
          enabled: false,
          configured: false,
          suspension: INITIAL_SUSPENSION_STATE,
          runs: freshEvidence,
          intervalSeconds: 300,
        },
        null,
        T0,
      ).status,
    ).toBe('disabled');
  });
});

describe('metricView (the §11.2 → §8.4 rendering)', () => {
  it('renders every stored field verbatim and drops the storage-only keys', () => {
    const view = metricView({
      accountId: 'work',
      runId: 7,
      collectedAt: T0,
      metricKey: 'mcp-monthly',
      limitType: 'MONTHLY',
      unit: 'CREDITS',
      windowSeconds: null,
      used: 80,
      remaining: 20,
      limit: 100,
      percentUsed: 80,
      percentRemaining: 20,
      resetsAt: T0 + 86_400_000,
      isValid: true,
      invalidReason: null,
      derivedFields: ['remaining', 'percentRemaining'],
    });
    expect(view).toEqual({
      metricKey: 'mcp-monthly',
      limitType: 'MONTHLY',
      unit: 'CREDITS',
      windowSeconds: null,
      used: 80,
      remaining: 20,
      limit: 100,
      percentUsed: 80,
      percentRemaining: 20,
      resetsAt: T0 + 86_400_000,
      isValid: true,
      invalidReason: null,
      derivedFields: ['remaining', 'percentRemaining'],
      collectedAt: T0,
    });
    expect('accountId' in view).toBe(false);
    expect('runId' in view).toBe(false);
  });

  it('copies the derived-field mask and renders the null mask as null', () => {
    const derivedFields = ['used'] as const;
    const withMask = metricView({
      accountId: 'work',
      runId: 7,
      collectedAt: T0,
      metricKey: 'k',
      limitType: 'OTHER',
      unit: 'PERCENT',
      windowSeconds: null,
      used: null,
      remaining: null,
      limit: null,
      percentUsed: 42,
      percentRemaining: null,
      resetsAt: null,
      isValid: true,
      invalidReason: null,
      derivedFields,
    });
    expect(withMask.derivedFields).toEqual(['used']);
    expect(withMask.derivedFields).not.toBe(derivedFields);
    expect(
      metricView({
        accountId: 'work',
        runId: 7,
        collectedAt: T0,
        metricKey: 'k',
        limitType: 'OTHER',
        unit: 'PERCENT',
        windowSeconds: null,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: 42,
        percentRemaining: null,
        resetsAt: null,
        isValid: true,
        invalidReason: null,
        derivedFields: null,
      }).derivedFields,
    ).toBeNull();
  });
});
