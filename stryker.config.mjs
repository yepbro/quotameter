/**
 * Stryker mutation-testing configuration (spec §17.3, task 055).
 *
 * Scope today: everything under src/. The enforced scope for the future is
 * the four critical modules named by the specification — reset detection,
 * peak-hours schedule calculation, response sanitization, and history
 * downsampling — which must join `mutate` as soon as they exist, each with
 * their own threshold (see docs/architecture/trust-boundaries.md for the
 * module map).
 *
 * `test:mutation` runs the full suite per mutant against the Vitest runner.
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: ['src/**/*.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  thresholds: {
    // Bootstrap baseline for the small current codebase; the critical
    // modules raise this when they land (target 80+ for all of them).
    high: 80,
    low: 60,
    break: 60,
  },
  timeoutMS: 60000,
  concurrency: 2,
};
