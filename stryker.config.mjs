/**
 * Stryker mutation-testing configuration (spec §17.3, task 055; cadence
 * decision D-045).
 *
 * Scope: everything under src/. The four critical modules §17.3 names —
 * reset detection (`src/services/events-detection.ts`), peak-hours
 * schedule calculation (`src/services/peak-hours-*.ts`), response
 * sanitization (`src/providers/sanitize.ts`), and history downsampling
 * (`src/services/history-downsample.ts`) — all exist and are inside the
 * scope through the `src/**` glob (module map:
 * docs/architecture/package-layout.md).
 *
 * Mutation testing is not a push gate: it runs once per day on `master`
 * via `.github/workflows/mutation.yml` with rolling-issue triage (D-045;
 * how it works and how to triage: docs/mutation-testing.md). `npm run
 * test:mutation` (or `make mutation`) runs the full suite per mutant
 * against the Vitest runner for manual runs.
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
    // One global break threshold (D-045): a score below 60 fails the
    // daily workflow. Per-module mutation thresholds for the four
    // §17.3 mutation-critical modules (reset detection, peak-hours,
    // sanitization, downsampling) remain the recorded D-045 follow-up
    // ("revisit the mutate scope and per-module thresholds from the
    // daily report's data"). Coverage is a separate §17.3 list —
    // time-zone logic, peak-hours, sanitization, secret-handling —
    // held at 100% per file in vitest.config.ts.
    high: 80,
    low: 60,
    break: 60,
  },
  timeoutMS: 60000,
  // Four runners: the hosted job's 4-vCPU container with two runners measured
  // 13 223/16 507 mutants in the 6 h hosted-job ceiling (2026-11-05..07 runs,
  // ~1.6 s of wall time per mutant, ≈3.3 s of runner time per mutant per
  // runner) — a full 18k-mutant run needs ~8 h of wall time and can never
  // score. Four runners (the dev container's 8 cores leave local headroom)
  // projects under the ceiling; task 197 (D-207) records the measurement and
  // the oversubscription risk with its fallback.
  concurrency: 4,
};
