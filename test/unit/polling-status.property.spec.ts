import { describe, expect, it } from 'vitest';
import { TransportStatusError } from '../../src/providers/transport';
import {
  COLLECTION_OUTCOMES,
  STATUS_CONTRIBUTION_BY_OUTCOME,
  classifyTransportError,
} from '../../src/services/polling-outcomes';
import {
  INITIAL_SUSPENSION_STATE,
  applyCycleOutcome,
  type AuthSuspensionState,
} from '../../src/services/polling-suspension';
import {
  ACCOUNT_STATUSES,
  STATUS_FRESHNESS_INTERVALS,
  deriveAccountStatus,
  type AccountStatusInput,
} from '../../src/services/polling-status';
import { fc } from '../helpers/property';

/**
 * Property-based pins of the §7.3 derivation (task 111, decision D-070) —
 * the relations that must hold over *every* input, not just the table's
 * corners: totality over the eight statuses, the dominance of the two
 * configuration states and of an active suspension, biconditional agreement
 * with D-048's contribution table on the failure ranks and with the
 * three-interval arithmetic on the age ranks, freshness downward-closed in
 * the clock reading, and shift invariance (the derivation compares ages,
 * never dates). Time is data (D-021); the suspension fixtures are real
 * D-064 states built through the machine.
 */

/** A fixed wall reading; every generated instant is an offset from it. */
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

/** §7.3's window at the largest §7.1 interval — the widest the suite spans. */
const MAX_WINDOW_MS = STATUS_FRESHNESS_INTERVALS * 3600 * 1000;

/** One classified 401 — the event that enters D-064 suspension. */
const authRejected401 = classifyTransportError(
  new TransportStatusError(401, 'Unauthorized', undefined),
);

/** Epoch offsets wide enough to straddle the window at any interval. */
const offsets = fc.integer({ min: -2 * MAX_WINDOW_MS, max: 2 * MAX_WINDOW_MS });

/** §7.1 intervals, seconds. */
const intervals = fc.integer({ min: 60, max: 3600 });

/** The latest run's outcome, or no runs at all. */
const latestOutcomes = fc.oneof(fc.constant(null), fc.constantFrom(...COLLECTION_OUTCOMES));

/** Success/first-attempt stamps, or their absence. */
const epochOrAbsent = fc.oneof(fc.constant(null), offsets);

/** The generated evidence shape (epochs as offsets from {@link NOW}). */
interface GeneratedEvidence {
  readonly intervalSeconds: number;
  readonly latestRunOutcome: (typeof COLLECTION_OUTCOMES)[number] | null;
  readonly lastSuccessOffset: number | null;
  readonly firstAttemptOffset: number | null;
  readonly suspended: boolean;
}

const evidence = fc.record({
  intervalSeconds: intervals,
  latestRunOutcome: latestOutcomes,
  lastSuccessOffset: epochOrAbsent,
  firstAttemptOffset: epochOrAbsent,
  suspended: fc.boolean(),
});

/** Materializes generated evidence into a derivation input at `now`. */
function toInput(
  generated: GeneratedEvidence,
  enabled = true,
  configured = true,
): AccountStatusInput {
  const suspension: AuthSuspensionState = generated.suspended
    ? // A real D-064 entry; the entry instant is irrelevant to the derivation.
      applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected401, 'generation-7', NOW - 60_000)
        .state
    : INITIAL_SUSPENSION_STATE;
  return {
    enabled,
    configured,
    suspension,
    intervalSeconds: generated.intervalSeconds,
    runs: {
      latestRunOutcome: generated.latestRunOutcome,
      lastSuccessAt:
        generated.lastSuccessOffset === null ? null : NOW + generated.lastSuccessOffset,
      firstAttemptAt:
        generated.firstAttemptOffset === null ? null : NOW + generated.firstAttemptOffset,
    },
  };
}

describe('account status derivation properties', () => {
  it('is total: every generated derivation yields one of the eight statuses', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        const status = deriveAccountStatus(toInput(generated), NOW + nowOffset);
        expect((ACCOUNT_STATUSES as readonly string[]).includes(status)).toBe(true);
      }),
    );
  });

  it('a disabled account shows Disabled whatever the rest of the evidence', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        expect(deriveAccountStatus(toInput(generated, false, true), NOW + nowOffset)).toBe(
          'disabled',
        );
      }),
    );
  });

  it('an enabled account without a resolved key shows Not configured', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        expect(deriveAccountStatus(toInput(generated, true, false), NOW + nowOffset)).toBe(
          'not-configured',
        );
      }),
    );
  });

  it('an active suspension always shows Auth rejected (§7.3 rank 1)', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        const forcedSuspended: GeneratedEvidence = { ...generated, suspended: true };
        expect(deriveAccountStatus(toInput(forcedSuspended), NOW + nowOffset)).toBe(
          'auth-rejected',
        );
      }),
    );
  });

  it('agrees by biconditional with D-048’s contribution on the failure ranks', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        const input = toInput({ ...generated, suspended: false });
        const status = deriveAccountStatus(input, NOW + nowOffset);
        const contribution =
          generated.latestRunOutcome === null
            ? 'none'
            : STATUS_CONTRIBUTION_BY_OUTCOME[generated.latestRunOutcome];
        // A failure contribution maps to exactly its §7.3 status; 'none'
        // never produces one of the three failure statuses.
        if (contribution === 'auth-rejected') expect(status).toBe('auth-rejected');
        else if (contribution === 'format-changed') expect(status).toBe('format-changed');
        else if (contribution === 'unreachable') expect(status).toBe('unreachable');
        else expect(['stale', 'collecting', 'fresh']).toContain(status);
      }),
    );
  });

  it('agrees by biconditional with the three-interval arithmetic on Fresh', () => {
    // A dedicated generator: no suspension and a guaranteed latest success,
    // so the age branch is always reachable and nothing is vacuous.
    const freshEvidence = fc.record({
      intervalSeconds: intervals,
      latestRunOutcome: latestOutcomes,
      lastSuccessOffset: offsets,
      firstAttemptOffset: epochOrAbsent,
      suspended: fc.constant(false),
    });
    fc.assert(
      fc.property(freshEvidence, offsets, (generated, nowOffset) => {
        const input = toInput(generated);
        const lastSuccessAt = NOW + generated.lastSuccessOffset;
        const withinWindow =
          NOW + nowOffset - lastSuccessAt <=
          STATUS_FRESHNESS_INTERVALS * generated.intervalSeconds * 1000;
        const status = deriveAccountStatus(input, NOW + nowOffset);
        // Fresh ⟺ the latest success is no older than three intervals —
        // both directions, modulo a failure rank intervening.
        if (status === 'fresh') expect(withinWindow).toBe(true);
        else if (withinWindow)
          expect(['auth-rejected', 'format-changed', 'unreachable']).toContain(status);
      }),
    );
  });

  it('Stale always rests on a real anchor past three intervals', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        const input = toInput(generated);
        const status = deriveAccountStatus(input, NOW + nowOffset);
        if (status !== 'stale') return;
        const anchor = input.runs.lastSuccessAt ?? input.runs.firstAttemptAt;
        expect(anchor).not.toBeNull();
        expect(NOW + nowOffset - (anchor as number)).toBeGreaterThan(
          STATUS_FRESHNESS_INTERVALS * generated.intervalSeconds * 1000,
        );
      }),
    );
  });

  it('Collecting never claims data: no successful collection exists', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        const input = toInput(generated);
        if (deriveAccountStatus(input, NOW + nowOffset) !== 'collecting') return;
        expect(input.runs.lastSuccessAt).toBeNull();
      }),
    );
  });

  it('freshness is downward-closed in the clock reading', () => {
    fc.assert(
      fc.property(evidence, offsets, offsets, (generated, first, second) => {
        const lo = Math.min(first, second);
        const hi = Math.max(first, second);
        const input = toInput(generated);
        // Fresh at a later reading implies Fresh at every earlier one: the
        // failure ranks carry no time, so only the age can change.
        if (deriveAccountStatus(input, NOW + hi) === 'fresh') {
          expect(deriveAccountStatus(input, NOW + lo)).toBe('fresh');
        }
      }),
    );
  });

  it('is invariant under a uniform time shift (ages, never dates)', () => {
    fc.assert(
      fc.property(
        evidence,
        offsets,
        fc.integer({ min: -MAX_WINDOW_MS, max: MAX_WINDOW_MS }),
        (generated, nowOffset, shift) => {
          const input = toInput(generated);
          const shifted: AccountStatusInput = {
            ...input,
            runs: {
              latestRunOutcome: input.runs.latestRunOutcome,
              lastSuccessAt:
                input.runs.lastSuccessAt === null ? null : input.runs.lastSuccessAt + shift,
              firstAttemptAt:
                input.runs.firstAttemptAt === null ? null : input.runs.firstAttemptAt + shift,
            },
          };
          expect(deriveAccountStatus(shifted, NOW + nowOffset + shift)).toBe(
            deriveAccountStatus(input, NOW + nowOffset),
          );
        },
      ),
    );
  });

  it('is pure: identical calls agree', () => {
    fc.assert(
      fc.property(evidence, offsets, (generated, nowOffset) => {
        const input = toInput(generated);
        expect(deriveAccountStatus(input, NOW + nowOffset)).toBe(
          deriveAccountStatus(input, NOW + nowOffset),
        );
      }),
    );
  });
});
