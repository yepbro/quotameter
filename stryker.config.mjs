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

// Container runs redirect reports into the isolated data volume (see
// compose.yaml) to avoid ownership conflicts with host-generated output.
const reportsDir = process.env.REPORTS_DIR ?? 'reports';
const htmlReportFile = `${reportsDir}/mutation/mutation.html`;
// Stryker's scratch directory gets the same treatment.
const tempDir = reportsDir === 'reports' ? '.stryker-tmp' : `${reportsDir}/../stryker-tmp`;

export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: ['src/**/*.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {
    fileName: htmlReportFile,
  },
  jsonReporter: {
    fileName: `${reportsDir}/mutation/mutation.json`,
  },
  tempDirName: tempDir,
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
