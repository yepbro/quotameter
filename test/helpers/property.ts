import fc from 'fast-check';

/**
 * Property-based testing convention (spec §17.1).
 *
 * Specs import `fc` from this module so every property test shares the same
 * deterministic configuration:
 *
 * - fixed number of runs per property (`numRuns`);
 * - reproducible failures: fast-check prints the seed it used, and `FC_SEED`
 *   pins a specific seed to replay a failing case exactly;
 * - no timing-, network-, or clock-dependent generators.
 *
 * To reproduce a reported failure: rerun with `FC_SEED=<printed seed>`.
 */
fc.configureGlobal({
  numRuns: 100,
  ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
});

export { fc };
