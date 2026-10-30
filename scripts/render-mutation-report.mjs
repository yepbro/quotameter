#!/usr/bin/env node
/**
 * Mutation-report markdown renderer (spec §17.3, docs/mutation-testing.md;
 * U-005 decision D-054, score formula D-055).
 *
 * Turns Stryker's `reports/mutation/mutation.json` into the markdown body of
 * the rolling `mutation-report` issue. This script is the single renderer:
 * the workflow's "Render report markdown" step calls it, the unit tests
 * (`test/unit/render-mutation-report.spec.ts`) exercise the same exported
 * function, and it runs by hand against any downloaded artifact JSON.
 *
 * The first bug this renderer replaced (issue #5, run 41054956364) tallied
 * Stryker's PascalCase mutant statuses against lowercase keys and silently
 * reported 0%; status handling is therefore explicit here — every status is
 * normalized through STATUS_ALIASES and an unknown one aborts the render
 * loudly instead of being dropped on the floor.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The canonical vocabulary is the mutation-testing-schema `MutantStatus`
// enum Stryker serializes (PascalCase). The exact lowercase spellings are
// accepted as aliases so a casing change cannot re-break the report, but
// nothing else is: an unrecognized status must stop the render (see
// normalizeStatus) rather than vanish from the tallies.
const STATUSES = [
  'Killed',
  'Survived',
  'Timeout',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Ignored',
];

const STATUS_ALIASES = Object.freeze(
  Object.fromEntries(
    STATUSES.flatMap((canonical) => [
      [canonical, canonical],
      [canonical.toLowerCase(), canonical],
    ]),
  ),
);

/**
 * Maps a mutant status to its canonical PascalCase spelling.
 *
 * @param {string} status status as found in `mutation.json`
 * @param {string} [where] context (a file path) included in the error message
 * @returns {string} canonical status, a key of every tally object below
 */
export function normalizeStatus(status, where = 'the report') {
  const canonical = Object.hasOwn(STATUS_ALIASES, status) ? STATUS_ALIASES[status] : undefined;
  if (canonical === undefined) {
    throw new Error(
      `Unknown mutant status ${JSON.stringify(status)} in ${where}; ` +
        `update STATUS_ALIASES in scripts/render-mutation-report.mjs ` +
        `(did Stryker's status vocabulary change?)`,
    );
  }
  return canonical;
}

/** @returns {Record<string, number>} a zeroed tally with one key per canonical status */
const freshTally = () => Object.fromEntries(STATUSES.map((status) => [status, 0]));

// Mutants that broke the harness itself. They are excluded from the score
// denominator (D-055) but surface as neither detected nor survived; the
// summary lists their files so a crashing mutant is triaged instead of hiding
// behind the score.
const ERROR_STATUSES = ['RuntimeError', 'CompileError'];

/**
 * Stryker's own score formula (decision D-055, verified against
 * `mutation-testing-metrics`' `calculateMetrics`): detected divided by the
 * scoreable mutants — every status except Ignored and the error statuses.
 * Ignored mutants are deliberate exclusions reviewed in code (U-006), and
 * error-status mutants broke the run itself, so neither belongs in the
 * denominator of the number the issue's verdict line is judged against.
 */
const scoreable = (tally) => tally.Killed + tally.Timeout + tally.Survived + tally.NoCoverage;

/** One decimal place, the precision the report has always shown. */
const percent = (detected, total) =>
  total === 0 ? null : Math.round((detected / total) * 1000) / 10;

/**
 * Renders the issue-body markdown for a Stryker JSON report.
 *
 * @param {{ files?: Record<string, { mutants?: Array<{ status: string, mutatorName: string, location: { start: { line: number } } }> }> }} report
 *   parsed `mutation.json`
 * @param {{ outcome?: string, date: string }} options
 *   `outcome` is the Stryker step's outcome (`'failure'` means below the
 *   break threshold); `date` is the run date (ISO `YYYY-MM-DD`)
 * @returns {string} markdown (no trailing newline)
 */
export function renderMutationReport(report, { outcome, date }) {
  const tally = freshTally();
  const perFile = [];
  const survived = [];
  const errorStatusByFile = new Map();
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const fileTally = freshTally();
    for (const m of data.mutants ?? []) {
      const status = normalizeStatus(m.status, file);
      fileTally[status] += 1;
      tally[status] += 1;
      if (status === 'Survived') {
        survived.push({ file, line: m.location.start.line, mutator: m.mutatorName });
      }
      if (ERROR_STATUSES.includes(status)) {
        errorStatusByFile.set(file, (errorStatusByFile.get(file) ?? 0) + 1);
      }
    }
    const total = (data.mutants ?? []).length;
    const detected = fileTally.Killed + fileTally.Timeout;
    perFile.push({
      file,
      total,
      detected,
      survived: fileTally.Survived,
      score: percent(detected, scoreable(fileTally)),
    });
  }

  const detected = tally.Killed + tally.Timeout;
  const score = percent(detected, scoreable(tally));
  const errorStatusTotal = ERROR_STATUSES.reduce((sum, status) => sum + tally[status], 0);
  const belowThreshold = outcome === 'failure';

  const lines = [];
  lines.push(`Daily mutation report — ${date}`, '');
  lines.push(
    `- Verdict: ${
      belowThreshold
        ? '**below the configured break threshold** (see stryker.config.mjs)'
        : 'within the configured thresholds'
    }`,
  );
  lines.push(
    `- Mutation score: ${score === null ? '—' : `${score}%`} ` +
      `(${detected} detected of ${scoreable(tally)} scoreable mutants — ` +
      `killed ${tally.Killed}, timed out ${tally.Timeout}; ignored and ` +
      `error-status mutants are excluded, see D-055)`,
  );
  lines.push(
    `- Survived: ${tally.Survived}, no coverage: ${tally.NoCoverage}, ` +
      `runtime errors: ${tally.RuntimeError}, compile errors: ${tally.CompileError}, ignored: ${tally.Ignored}`,
  );
  if (errorStatusTotal > 0) {
    const byFile = [...errorStatusByFile.entries()]
      .sort(([fileA, countA], [fileB, countB]) => countB - countA || fileA.localeCompare(fileB))
      .map(([file, count]) => `\`${file}\` (${count})`);
    lines.push(
      `- Error-status mutants (broke the test run itself — neither detected nor survived): ` +
        `${byFile.join(', ')}`,
    );
  }
  lines.push(
    `- Thresholds and scope: \`stryker.config.mjs\` (scope and cadence decision: DECISIONS.md D-045)`,
    '',
  );
  lines.push(
    '## Per-file results',
    '',
    '| File | Mutants | Detected | Survived | Score |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const f of perFile.filter((x) => x.total > 0)) {
    lines.push(
      `| \`${f.file}\` | ${f.total} | ${f.detected} | ${f.survived} | ${f.score === null ? '—' : `${f.score}%`} |`,
    );
  }
  lines.push('', '## Survived mutants (triage list)', '');
  if (survived.length === 0) {
    lines.push('None — every generated mutant was detected.');
  } else {
    for (const s of survived.slice(0, 200)) {
      lines.push(`- \`${s.file}:${s.line}\` — ${s.mutator}`);
    }
    if (survived.length > 200) {
      lines.push(`- …and ${survived.length - 200} more (see the uploaded artifact)`);
    }
  }
  lines.push(
    '',
    '<sub>Generated by `scripts/render-mutation-report.mjs` via `.github/workflows/mutation.yml`; full JSON/HTML in the run artifact.</sub>',
  );
  return lines.join('\n');
}

async function main() {
  const reportPath = process.argv[2] ?? 'reports/mutation/mutation.json';
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const markdown = renderMutationReport(report, {
    outcome: process.env.STRYKER_OUTCOME,
    date: new Date().toISOString().slice(0, 10),
  });
  console.log(markdown);
}

// CLI entry: the module is imported (and unit-tested) as a pure seam, so
// run main() only when executed directly (`node scripts/render-mutation-report.mjs [report.json]`).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    console.error(`render-mutation-report: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
