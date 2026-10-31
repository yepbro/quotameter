import { describe, expect, it } from 'vitest';
import { TransportStatusError } from '../../src/providers/transport';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABELS,
  STATUS_FRESHNESS_INTERVALS,
  deriveAccountStatus,
  type AccountStatus,
  type AccountStatusInput,
  type PollingRunEvidence,
} from '../../src/services/polling-status';
import { classifySuccess, classifyTransportError } from '../../src/services/polling-outcomes';
import {
  INITIAL_SUSPENSION_STATE,
  applyCycleOutcome,
  applyKeyIdentity,
  type AuthSuspensionState,
} from '../../src/services/polling-suspension';

/**
 * Task 111's done-condition — "every state and transition has tests" (spec
 * §7.3, §14.6, decision D-070): each of the eight statuses derives from its
 * defining evidence, the three-interval boundary is pinned on both anchors
 * from both sides, the precedence pins cover every cross-evidence overlap
 * (suspension over inconclusive probes, latest-run over older failures,
 * 429's fall-through to the age states), the transition matrix walks every
 * observable status change an account can undergo, and the fail-fast
 * contract rejects every malformed input. Time is data (D-021); the
 * suspension fixtures are real D-064 states built through the machine, not
 * hand-crafted literals.
 */

/** A fixed wall reading; every age in the suite is an offset from it. */
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

/** The §7.1 default interval, in seconds (the derivation's unit). */
const INTERVAL = 300;

/** §7.3's freshness window at `INTERVAL`: three configured intervals. */
const WINDOW = STATUS_FRESHNESS_INTERVALS * INTERVAL * 1000;

/** One classified 401 — the event that enters D-064 suspension. */
const authRejected401 = classifyTransportError(
  new TransportStatusError(401, 'Unauthorized', undefined),
);

/** A real suspended state, entered through the D-064 machine at `at`. */
function suspendedAt(at: number): AuthSuspensionState {
  return applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected401, 'generation-7', at).state;
}

/**
 * A healthy baseline: enabled, configured, never suspended, the latest run
 * a success one interval old (the anchor run an hour before that).
 */
function healthyInput(overrides: Partial<AccountStatusInput> = {}): AccountStatusInput {
  return {
    enabled: true,
    configured: true,
    suspension: INITIAL_SUSPENSION_STATE,
    runs: {
      latestRunOutcome: 'success',
      lastSuccessAt: NOW - INTERVAL * 1000,
      firstAttemptAt: NOW - 3_600_000,
    },
    intervalSeconds: INTERVAL,
    ...overrides,
  };
}

/** Derives at `NOW` unless the case moves the clock itself. */
function derive(input: AccountStatusInput, now = NOW): AccountStatus {
  return deriveAccountStatus(input, now);
}

/* ── The vocabulary ────────────────────────────────────────────────────── */

describe('account status vocabulary', () => {
  it('lists exactly the eight §7.3/§14.6 statuses, ranked ones first', () => {
    expect([...ACCOUNT_STATUSES]).toEqual([
      'auth-rejected',
      'format-changed',
      'unreachable',
      'stale',
      'collecting',
      'fresh',
      'disabled',
      'not-configured',
    ]);
  });

  it('labels every status with its exact §7.3/§14.6 English spelling', () => {
    expect(ACCOUNT_STATUS_LABELS).toEqual({
      'auth-rejected': 'Auth rejected',
      'format-changed': 'Format changed',
      unreachable: 'Unreachable',
      stale: 'Stale',
      collecting: 'Collecting',
      fresh: 'Fresh',
      disabled: 'Disabled',
      'not-configured': 'Not configured',
    });
  });
});

/* ── Every state, from its defining evidence ───────────────────────────── */

describe('each status derives from its defining evidence', () => {
  it('fresh: the latest success is one interval old', () => {
    expect(derive(healthyInput())).toBe('fresh');
  });

  it('stale: the latest success is past three intervals', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'success',
            lastSuccessAt: NOW - WINDOW - 1,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('stale');
  });

  it('collecting: no runs at all — the §7.1 first poll is due or in flight', () => {
    expect(
      derive(
        healthyInput({
          runs: { latestRunOutcome: null, lastSuccessAt: null, firstAttemptAt: null },
        }),
      ),
    ).toBe('collecting');
  });

  it('collecting: never a success, within three intervals of the first attempt', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: null,
            firstAttemptAt: NOW - WINDOW,
          },
        }),
      ),
    ).toBe('collecting');
  });

  it('unreachable: the latest cycle failed as network_error, timeout, or server_error', () => {
    for (const outcome of ['network_error', 'timeout', 'server_error'] as const) {
      expect(
        derive(
          healthyInput({
            runs: {
              latestRunOutcome: outcome,
              lastSuccessAt: NOW - 1_000,
              firstAttemptAt: NOW - 3_600_000,
            },
          }),
        ),
      ).toBe('unreachable');
    }
  });

  it('format-changed: the latest cycle is a parse_error', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'parse_error',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('format-changed');
  });

  it('auth-rejected: the D-064 suspension is active (rank 1 over a fresh success)', () => {
    expect(derive(healthyInput({ suspension: suspendedAt(NOW - 60_000) }))).toBe('auth-rejected');
  });

  it('auth-rejected: the latest run is an auth_error even without suspension', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'auth_error',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('auth-rejected');
  });

  it('disabled: enablement outranks every other input', () => {
    expect(
      derive(
        healthyInput({
          enabled: false,
          suspension: suspendedAt(NOW - 60_000),
          runs: {
            latestRunOutcome: 'auth_error',
            lastSuccessAt: null,
            firstAttemptAt: NOW - WINDOW - 1,
          },
        }),
      ),
    ).toBe('disabled');
  });

  it('not-configured: a resolved key outranks the ranked statuses, not enablement', () => {
    expect(
      derive(
        healthyInput({
          configured: false,
          suspension: suspendedAt(NOW - 60_000),
          runs: { latestRunOutcome: 'auth_error', lastSuccessAt: null, firstAttemptAt: null },
        }),
      ),
    ).toBe('not-configured');
  });
});

/* ── The three-interval boundary (§7.3's own words) ────────────────────── */

describe('the three-interval freshness boundary', () => {
  it('fresh at exactly three intervals ("no older than")', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'success',
            lastSuccessAt: NOW - WINDOW,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('fresh');
  });

  it('stale one millisecond past three intervals ("more than")', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'success',
            lastSuccessAt: NOW - WINDOW - 1,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('stale');
  });

  it('collecting at exactly three intervals from the first attempt', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: null,
            firstAttemptAt: NOW - WINDOW,
          },
        }),
      ),
    ).toBe('collecting');
  });

  it('stale one millisecond past three intervals from the first attempt', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: null,
            firstAttemptAt: NOW - WINDOW - 1,
          },
        }),
      ),
    ).toBe('stale');
  });

  it('a wall reading behind the last success (clock regression, D-021) stays fresh', () => {
    // lastSuccessAt is NOW − 300 000; the reading is 600 000 — a negative age.
    expect(derive(healthyInput(), NOW - 2 * INTERVAL * 1000)).toBe('fresh');
  });

  it('the window scales with the configured interval', () => {
    const age = 200_000; // 200 s: inside three 300 s intervals, past three 60 s ones
    const runs: PollingRunEvidence = {
      latestRunOutcome: 'success',
      lastSuccessAt: NOW - age,
      firstAttemptAt: NOW - age,
    };
    expect(derive(healthyInput({ runs }))).toBe('fresh');
    expect(derive(healthyInput({ runs, intervalSeconds: 60 }))).toBe('stale');
  });
});

/* ── Precedence pins (§7.3's cross-evidence overlaps) ──────────────────── */

describe('precedence pins', () => {
  it('suspension keeps rank 1 over an inconclusive verification probe', () => {
    // While suspended, the hourly probe failed as network/timeout/5xx/429/parse:
    // D-064 neither releases nor re-arms, and §7.3 rank 1 still governs.
    for (const outcome of [
      'network_error',
      'timeout',
      'server_error',
      'rate_limited',
      'parse_error',
    ] as const) {
      expect(
        derive(
          healthyInput({
            suspension: suspendedAt(NOW - 60_000),
            runs: {
              latestRunOutcome: outcome,
              lastSuccessAt: NOW - 1_000,
              firstAttemptAt: NOW - 3_600_000,
            },
          }),
        ),
      ).toBe('auth-rejected');
    }
  });

  it('suspension outranks even a latest success run (input-domain totality)', () => {
    // The D-064 machine releases on a success, so the engine keeps this pair
    // consistent; the derivation is total over its inputs regardless, and
    // rank 1 is the pause itself, not the run history beside it.
    expect(derive(healthyInput({ suspension: suspendedAt(NOW - 60_000) }))).toBe('auth-rejected');
  });

  it('a latest auth_error without suspension covers the restart and release windows', () => {
    // After a restart (in-memory suspension lost) or a key change (D-064
    // released, D-066 makes the next poll immediately due), the last
    // recorded verdict is still a rejection — for exactly one cycle.
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'auth_error',
            lastSuccessAt: null,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('auth-rejected');
  });

  it('the latest cycle governs ranks 2–3, not the failure history', () => {
    const firstAttemptAt = NOW - 3_600_000;
    const lastSuccessAt = NOW - 1_000;
    // An older auth rejection superseded by a parse failure:
    expect(
      derive(
        healthyInput({ runs: { latestRunOutcome: 'parse_error', lastSuccessAt, firstAttemptAt } }),
      ),
    ).toBe('format-changed');
    // An older parse failure superseded by a network failure:
    expect(
      derive(
        healthyInput({
          runs: { latestRunOutcome: 'network_error', lastSuccessAt, firstAttemptAt },
        }),
      ),
    ).toBe('unreachable');
    // An older auth rejection superseded by a success:
    expect(
      derive(
        healthyInput({ runs: { latestRunOutcome: 'success', lastSuccessAt, firstAttemptAt } }),
      ),
    ).toBe('fresh');
  });

  it('rank 3 carries no recency qualifier: an old network failure still beats stale data', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'timeout',
            lastSuccessAt: NOW - WINDOW - 86_400_000,
            firstAttemptAt: NOW - 2 * 86_400_000,
          },
        }),
      ),
    ).toBe('unreachable');
  });

  it('a rate-limited cycle falls through to the age states (D-048 delegation)', () => {
    // Fresh data, 429 latest: not a failure status, data age governs.
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('fresh');
    // No data, recent attempts: still collecting.
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: null,
            firstAttemptAt: NOW - 1_000,
          },
        }),
      ),
    ).toBe('collecting');
    // No data, attempts past the window: stale.
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: null,
            firstAttemptAt: NOW - WINDOW - 1,
          },
        }),
      ),
    ).toBe('stale');
  });
});

/* ── Transitions: every observable status change ───────────────────────── */

describe('transitions', () => {
  /** A representative input per status, for the dominance events. */
  const representatives: Readonly<Record<AccountStatus, AccountStatusInput>> = {
    'auth-rejected': healthyInput({
      suspension: suspendedAt(NOW - 60_000),
      runs: {
        latestRunOutcome: 'auth_error',
        lastSuccessAt: null,
        firstAttemptAt: NOW - 3_600_000,
      },
    }),
    'format-changed': healthyInput({
      runs: {
        latestRunOutcome: 'parse_error',
        lastSuccessAt: NOW - 1_000,
        firstAttemptAt: NOW - 3_600_000,
      },
    }),
    unreachable: healthyInput({
      runs: {
        latestRunOutcome: 'network_error',
        lastSuccessAt: NOW - 1_000,
        firstAttemptAt: NOW - 3_600_000,
      },
    }),
    stale: healthyInput({
      runs: {
        latestRunOutcome: 'success',
        lastSuccessAt: NOW - WINDOW - 1,
        firstAttemptAt: NOW - 3_600_000,
      },
    }),
    collecting: healthyInput({
      runs: { latestRunOutcome: null, lastSuccessAt: null, firstAttemptAt: null },
    }),
    fresh: healthyInput(),
    disabled: healthyInput({ enabled: false }),
    'not-configured': healthyInput({ configured: false }),
  };

  it('each representative really is the status it stands for', () => {
    for (const [status, input] of Object.entries(representatives)) {
      expect(derive(input), status).toBe(status);
    }
  });

  it('disabling the account shows Disabled from every status', () => {
    for (const [status, input] of Object.entries(representatives)) {
      expect(derive({ ...input, enabled: false }), `from ${status}`).toBe('disabled');
    }
  });

  it('losing the resolved key shows Not configured from every enabled status', () => {
    for (const [status, input] of Object.entries(representatives)) {
      if (status === 'disabled') continue; // enablement stays the outermost switch
      expect(derive({ ...input, configured: false }), `from ${status}`).toBe('not-configured');
    }
  });

  it('re-enabling a disabled account with healthy evidence shows Fresh', () => {
    expect(derive({ ...representatives.disabled, enabled: true })).toBe('fresh');
  });

  it('resolving the key of a not-configured account with healthy evidence shows Fresh', () => {
    expect(derive({ ...representatives['not-configured'], configured: true })).toBe('fresh');
  });

  it('fresh —network failure→ unreachable', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'network_error',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('unreachable');
  });

  it('fresh —parse failure→ format-changed', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'parse_error',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('format-changed');
  });

  it('fresh —429 cycle→ fresh (the age states govern)', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'rate_limited',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('fresh');
  });

  it('fresh —auth rejection→ auth-rejected (suspension enters)', () => {
    const state = suspendedAt(NOW - 60_000); // the 401 cycle's own effect
    expect(
      derive(
        healthyInput({
          suspension: state,
          runs: {
            latestRunOutcome: 'auth_error',
            lastSuccessAt: NOW - INTERVAL * 1000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('auth-rejected');
  });

  it('unreachable/format-changed —success→ fresh (recovery)', () => {
    for (const from of ['network_error', 'parse_error'] as const) {
      expect(
        derive(
          healthyInput({
            runs: {
              latestRunOutcome: from,
              lastSuccessAt: NOW - 1_000,
              firstAttemptAt: NOW - 3_600_000,
            },
          }),
        ),
        `from a ${from} account`,
      ).not.toBe('fresh');
      expect(
        derive(
          healthyInput({
            runs: {
              latestRunOutcome: 'success',
              lastSuccessAt: NOW - 1_000,
              firstAttemptAt: NOW - 3_600_000,
            },
          }),
        ),
        `from a ${from} account`,
      ).toBe('fresh');
    }
  });

  it('auth-rejected —inconclusive probe→ auth-rejected', () => {
    const state = suspendedAt(NOW - 60_000);
    expect(
      derive(
        healthyInput({
          suspension: state,
          runs: {
            latestRunOutcome: 'network_error',
            lastSuccessAt: null,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('auth-rejected');
  });

  it('auth-rejected —successful probe→ fresh (release plus success)', () => {
    const suspended = suspendedAt(NOW - 60_000);
    const released = applyCycleOutcome(suspended, classifySuccess(), 'generation-7', NOW).state;
    expect(released.suspended).toBe(false);
    expect(
      derive(
        healthyInput({
          suspension: released,
          runs: {
            latestRunOutcome: 'success',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('fresh');
  });

  it('auth-rejected —key change, no new cycle yet→ auth-rejected', () => {
    const suspended = suspendedAt(NOW - 60_000);
    const released = applyKeyIdentity(suspended, 'generation-8', NOW).state;
    // D-066 makes the next poll immediately due; until it lands, the latest
    // run is still the old key's rejection.
    expect(released.suspended).toBe(false);
    expect(
      derive(
        healthyInput({
          suspension: released,
          runs: {
            latestRunOutcome: 'auth_error',
            lastSuccessAt: null,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('auth-rejected');
  });

  it('auth-rejected —key change, new-key cycle succeeds→ fresh', () => {
    const suspended = suspendedAt(NOW - 60_000);
    const released = applyKeyIdentity(suspended, 'generation-8', NOW).state;
    expect(
      derive(
        healthyInput({
          suspension: released,
          runs: {
            latestRunOutcome: 'success',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('fresh');
  });

  it('service restart: suspension lost, latest run still the rejection → auth-rejected', () => {
    expect(
      derive(
        healthyInput({
          suspension: INITIAL_SUSPENSION_STATE,
          runs: {
            latestRunOutcome: 'auth_error',
            lastSuccessAt: null,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('auth-rejected');
  });

  it('fresh —time passes the window→ stale', () => {
    const freshAt = NOW;
    const input = healthyInput(); // success one interval old
    expect(derive(input, freshAt)).toBe('fresh');
    expect(derive(input, freshAt + WINDOW - INTERVAL * 1000)).toBe('fresh'); // still inside
    expect(derive(input, freshAt + WINDOW - INTERVAL * 1000 + 1)).toBe('stale');
  });

  it('stale —success→ fresh', () => {
    expect(
      derive(
        healthyInput({
          runs: {
            latestRunOutcome: 'success',
            lastSuccessAt: NOW - 1_000,
            firstAttemptAt: NOW - 3_600_000,
          },
        }),
      ),
    ).toBe('fresh');
  });

  it('collecting —first run lands→ fresh / format-changed / unreachable / collecting', () => {
    // A succeeding first cycle writes its snapshot, so lastSuccessAt exists.
    const succeeded = {
      latestRunOutcome: 'success',
      lastSuccessAt: NOW - 500,
      firstAttemptAt: NOW - 1_000,
    } as const;
    expect(derive(healthyInput({ runs: succeeded }))).toBe('fresh');
    // Failing first cycles write no snapshot; lastSuccessAt stays null.
    const failed = { lastSuccessAt: null, firstAttemptAt: NOW - 1_000 } as const;
    expect(derive(healthyInput({ runs: { ...failed, latestRunOutcome: 'parse_error' } }))).toBe(
      'format-changed',
    );
    expect(derive(healthyInput({ runs: { ...failed, latestRunOutcome: 'server_error' } }))).toBe(
      'unreachable',
    );
    expect(derive(healthyInput({ runs: { ...failed, latestRunOutcome: 'rate_limited' } }))).toBe(
      'collecting',
    );
  });

  it('collecting (never a success) —time passes the window→ stale', () => {
    const input = healthyInput({
      runs: { latestRunOutcome: 'rate_limited', lastSuccessAt: null, firstAttemptAt: NOW - 1_000 },
    });
    expect(derive(input, NOW)).toBe('collecting');
    expect(derive(input, NOW + WINDOW - 1_000)).toBe('collecting'); // still inside
    expect(derive(input, NOW + WINDOW - 1_000 + 1)).toBe('stale');
  });
});

/* ── Fail-fast validation (the D-064/D-066 convention) ─────────────────── */

describe('input validation', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: unknown;
    readonly error: ErrorConstructor;
  }> = [
    { name: 'input is null', input: null, error: TypeError },
    { name: 'input is a string', input: 'nope', error: TypeError },
    { name: 'enabled is a string', input: { ...healthyInput(), enabled: 'yes' }, error: TypeError },
    {
      name: 'configured is a number',
      input: { ...healthyInput(), configured: 1 },
      error: TypeError,
    },
    {
      name: 'suspension is null',
      input: { ...healthyInput(), suspension: null },
      error: TypeError,
    },
    {
      name: 'suspension.suspended is a string',
      input: { ...healthyInput(), suspension: { suspended: 'yes' } },
      error: TypeError,
    },
    { name: 'runs is null', input: { ...healthyInput(), runs: null }, error: TypeError },
    {
      name: "latestRunOutcome is the 'cancelled' pseudo-outcome",
      input: {
        ...healthyInput(),
        runs: { latestRunOutcome: 'cancelled', lastSuccessAt: null, firstAttemptAt: null },
      },
      error: TypeError,
    },
    {
      name: 'lastSuccessAt is NaN',
      input: {
        ...healthyInput(),
        runs: { latestRunOutcome: null, lastSuccessAt: Number.NaN, firstAttemptAt: null },
      },
      error: TypeError,
    },
    {
      name: 'firstAttemptAt is Infinity',
      input: {
        ...healthyInput(),
        runs: {
          latestRunOutcome: null,
          lastSuccessAt: null,
          firstAttemptAt: Number.POSITIVE_INFINITY,
        },
      },
      error: TypeError,
    },
    {
      name: 'intervalSeconds is fractional',
      input: { ...healthyInput(), intervalSeconds: 300.5 },
      error: RangeError,
    },
    {
      name: 'intervalSeconds is below the §7.1 floor',
      input: { ...healthyInput(), intervalSeconds: 59 },
      error: RangeError,
    },
    {
      name: 'intervalSeconds is above the §7.1 ceiling',
      input: { ...healthyInput(), intervalSeconds: 3601 },
      error: RangeError,
    },
    {
      name: 'intervalSeconds is a string',
      input: { ...healthyInput(), intervalSeconds: '300' },
      error: RangeError,
    },
  ];

  it.each(cases)('rejects when $name', ({ input, error }) => {
    expect(() => deriveAccountStatus(input as AccountStatusInput, NOW)).toThrow(error);
  });

  it('names the caller in every message', () => {
    expect(() =>
      deriveAccountStatus({ ...healthyInput(), enabled: 'yes' as unknown as boolean }, NOW),
    ).toThrow(/^deriveAccountStatus: /);
  });

  it('rejects a non-finite clock reading', () => {
    expect(() => deriveAccountStatus(healthyInput(), Number.NaN)).toThrow(
      'deriveAccountStatus: nowEpochMs must be a finite number',
    );
    expect(() => deriveAccountStatus(healthyInput(), Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('accepts every §7.1 interval bound', () => {
    const runs: PollingRunEvidence = {
      latestRunOutcome: 'success',
      lastSuccessAt: NOW - 30_000,
      firstAttemptAt: NOW - 30_000,
    };
    expect(derive({ ...healthyInput(), runs, intervalSeconds: 60 })).toBe('fresh');
    expect(derive({ ...healthyInput(), runs, intervalSeconds: 3600 })).toBe('fresh');
  });
});
