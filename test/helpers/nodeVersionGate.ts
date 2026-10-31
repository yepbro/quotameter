/**
 * The shared runtime-gate boundary matrix (task 129, spec §5.1/§17.2,
 * decision D-098).
 *
 * One list consumed by both gate suites: `test/unit/version.spec.ts`
 * asserts `src/util/version.ts`'s verdict for every case, and
 * `test/integration/cli-bin-version-gate.spec.ts` runs the real launcher
 * (`bin/quotameter.mjs`, which keeps its own plain-JS comparison because
 * it must run before anything can be compiled) as a child process with the
 * case faked into `process.versions.node`. The two implementations cannot
 * import each other by design — this shared list is what pins them
 * equivalent, so adding a boundary case means adding it exactly here.
 */

/** What the gate concludes for a `process.versions.node` value. */
export type VersionGateOutcome = 'pass' | 'reject' | 'invalid';

export interface VersionGateCase {
  readonly version: string;
  readonly outcome: VersionGateOutcome;
}

/** The declared minimum (spec §5.1); asserted equal to `engines.node` by tests. */
export const MINIMUM_RUNTIME = '22.13.0';

export const VERSION_GATE_CASES: readonly VersionGateCase[] = [
  // The boundary itself and its immediate neighbors.
  { version: '22.13.0', outcome: 'pass' },
  { version: '22.13.1', outcome: 'pass' },
  { version: '22.12.9', outcome: 'reject' },
  { version: '22.12.0', outcome: 'reject' },
  // Older and newer release lines (the CI unsupported-node job sees Node 20).
  { version: '21.7.2', outcome: 'reject' },
  { version: '20.18.0', outcome: 'reject' },
  { version: '18.20.4', outcome: 'reject' },
  { version: '23.0.0', outcome: 'pass' },
  { version: '24.14.1', outcome: 'pass' },
  // Missing segments count as zero: the minimum's own short form passes,
  // a bare major below it does not.
  { version: '22.13', outcome: 'pass' },
  { version: '22', outcome: 'reject' },
  // Prerelease/build suffixes order by their numeric prefix (nightlies).
  { version: '22.13.0-nightly.20261101abc', outcome: 'pass' },
  { version: '22.13.0+custom', outcome: 'pass' },
  { version: '22.12.9-nightly.20261101abc', outcome: 'reject' },
  // Unverifiable input never passes (the launcher fails closed with its
  // own message; src/util/version.ts throws its loud invalid-string error).
  { version: '', outcome: 'invalid' },
  { version: 'v22.13.0', outcome: 'invalid' },
  { version: '22.13.x', outcome: 'invalid' },
  { version: 'garbage', outcome: 'invalid' },
];
