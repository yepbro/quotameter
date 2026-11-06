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
 *
 * The second bug (U-046, decision D-172): a run that dies BEFORE scoring
 * (Stryker's initial test run fails, `mutation.json` is never written) used
 * to abort here with ENOENT — while the workflow's shell redirect had
 * already created an empty body file, which the upsert step then blanked
 * the rolling issue with, and the step outcome ("failure" for ANY Stryker
 * failure) dressed the crash up as a below-threshold score. The missing
 * report is now a first-class case: `renderCrashReport` builds an honest
 * crash body (failing initial-run tests extracted from the Stryker log,
 * an explicit "no score was measured", no phantom numbers), and the
 * workflow gates every verdict claim on the report file's existence.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

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

// Stryker's initial-test-run failure block header (DryRunExecutor). The
// failing test ids follow on tab-indented lines, each with its assertion
// summary on a doubly-tab-indented line — the shapes verified against the
// installed Stryker's `logFailedTestsInInitialRun` (one `\t<name>` and one
// `\t\t<failureMessage>` line per test) and the crashed daily runs
// (41421143977/41611856943/41805574274).
const FAILED_TESTS_HEADER = /One or more tests failed in the initial test run/;
// A timestamped logger line — the shape every Stryker log entry carries.
// Inside a failed-tests block it is the block's only reliable terminator:
// the failure messages themselves are multi-line and their continuation
// lines arrive untabbed.
const LOG_ENTRY = /^\d{2}:\d{2}:\d{2} \(\d+\) \w+ /;
// The last ERROR line is Stryker's own reason to die (e.g. "ERROR Stryker
// There were failed tests in the initial test run."); the leading timestamp
// and logger name are stripped, the message kept.
const ERROR_LINE = /^\d{2}:\d{2}:\d{2} \(\d+\) ERROR \S+ (.+)$/;

/** Caps a possibly long log line for the issue body; one ellipsis char, not three dots. */
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Extracts the failing initial-run tests from the raw Stryker step output.
 *
 * @param {string | undefined} logText the captured stdout+stderr of the
 *   Stryker step (ANSI escapes tolerated; `undefined`/empty → no tests)
 * @returns {Array<{ id: string, message?: string }>} in log order, unbounded
 *   (the cap is a rendering concern; see renderCrashReport)
 */
export function extractFailedInitialTests(logText) {
  if (typeof logText !== 'string' || logText === '') {
    return [];
  }
  const tests = [];
  let inBlock = false;
  let current;
  for (const rawLine of stripVTControlCharacters(logText).split('\n')) {
    if (FAILED_TESTS_HEADER.test(rawLine)) {
      inBlock = true;
      current = undefined;
      continue;
    }
    if (!inBlock) {
      continue;
    }
    if (LOG_ENTRY.test(rawLine)) {
      // The next timestamped log entry ends the block (Stryker logs the
      // whole failed-test list as ONE entry; multi-line failure messages
      // in between are untabbed and must not end it).
      inBlock = false;
      current = undefined;
      continue;
    }
    const test = /^\t(\S.*)$/.exec(rawLine);
    if (test) {
      current = { id: test[1].trimEnd() };
      tests.push(current);
      continue;
    }
    // Only the first message line per test: the assertion summary, not the
    // multi-line diff that may follow.
    const message = /^\t\t(.+)$/.exec(rawLine);
    if (message && current?.message === undefined) {
      current.message = message[1].trim();
      continue;
    }
    // Anything else (a failure-message continuation line) is ignored.
  }
  return tests;
}

/**
 * Stryker's own reason to die, or an honest "unknown" — never a guess.
 *
 * @param {string | undefined} logText the captured Stryker step output
 * @returns {string} the clipped message of the last ERROR line, if any
 */
function extractFailureCause(logText) {
  if (typeof logText !== 'string') {
    return 'unknown (no Stryker output log was captured)';
  }
  let cause;
  for (const rawLine of stripVTControlCharacters(logText).split('\n')) {
    const match = ERROR_LINE.exec(rawLine);
    if (match) {
      cause = match[1].trim();
    }
  }
  if (cause === undefined) {
    return 'unknown (no Stryker ERROR line in the captured log)';
  }
  return clip(cause, 200);
}

/**
 * Renders the issue-body markdown for a run that produced no report —
 * Stryker exited before writing `mutation.json`, so nothing was scored
 * (U-046, decision D-172). The body names the crash, surfaces the failing
 * initial-run tests when they are extractable from the log (bounded), links
 * the run, and states explicitly that no score was measured — no phantom
 * numbers, and nothing a reader could mistake for survivor triage.
 *
 * @param {{ date: string, log?: string, reportPath?: string, runUrl?: string }} options
 *   `date` is the run date (ISO `YYYY-MM-DD`); `log` the captured Stryker
 *   step output; `reportPath` the report location the run failed to write;
 *   `runUrl` the Actions run link (omitted in local renders)
 * @returns {string} markdown (no trailing newline)
 */
export function renderCrashReport({
  date,
  log,
  reportPath = 'reports/mutation/mutation.json',
  runUrl,
}) {
  const failed = extractFailedInitialTests(log);
  const lines = [];
  lines.push(`Daily mutation report — ${date} — crashed before scoring`, '');
  lines.push(
    `- Verdict: **run crashed — no score was measured** ` +
      `(Stryker exited without writing \`${reportPath}\`)`,
  );
  lines.push(
    '- Mutation score: **not measured** — no per-file results or survivor list exists for this run',
  );
  lines.push(`- Cause: ${extractFailureCause(log)}`);
  if (runUrl !== undefined) {
    lines.push(`- Run: ${runUrl}`);
  }
  lines.push(
    '- Artifact: no mutation report exists for this run; the run artifact carries the ' +
      'Stryker output log (`stryker-output.log`) instead',
    '',
  );
  if (failed.length > 0) {
    lines.push('## Failing initial-run tests (from the Stryker output log)', '');
    for (const test of failed.slice(0, 20)) {
      lines.push(`- \`${clip(test.id, 300)}\``);
      if (test.message !== undefined) {
        lines.push(`  - ${clip(test.message, 200)}`);
      }
    }
    if (failed.length > 20) {
      lines.push(`- …and ${failed.length - 20} more (see the run log)`);
    }
    lines.push('');
  }
  lines.push(
    'This is NOT a below-threshold score — no score exists. Triage per the crashed-run ' +
      'case in `docs/mutation-testing.md` ("How to react"), not the survivor list.',
    '',
  );
  lines.push(
    '<sub>Generated by `scripts/render-mutation-report.mjs` via `.github/workflows/mutation.yml`; ' +
      'the last scored report, if any, stays in the issue body until a scored run replaces it.</sub>',
  );
  return lines.join('\n');
}

/** The Actions run page, from the runner's default environment variables; `undefined` locally. */
const actionsRunUrl = () => {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : undefined;
};

async function main() {
  const reportPath = process.argv[2] ?? 'reports/mutation/mutation.json';
  let reportText;
  try {
    reportText = await readFile(reportPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // No report file: the run died before scoring. Render the honest crash
      // body (exit 0 — a body WAS produced). The pre-U-046 behavior aborted
      // here while the calling shell's redirect had already created an empty
      // body file, which the upsert step then blanked the rolling issue with.
      // Any other read error (permissions, &c.) still aborts loudly.
      let log;
      if (process.env.STRYKER_LOG_FILE !== undefined) {
        // Best-effort evidence: an unreadable log must not kill the crash
        // body — the report's absence is the fact being reported.
        log = await readFile(process.env.STRYKER_LOG_FILE, 'utf8').catch(() => undefined);
      }
      console.log(
        renderCrashReport({
          date: new Date().toISOString().slice(0, 10),
          log,
          reportPath,
          runUrl: actionsRunUrl(),
        }),
      );
      return;
    }
    throw error;
  }
  const report = JSON.parse(reportText);
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
