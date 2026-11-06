import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error the renderer is a plain-ESM CLI script (Node 22 runs it without a build step, like scripts/generate-schema.mjs); its exports are typed locally below through the namespace
import * as rendererModule from '../../scripts/render-mutation-report.mjs';

/**
 * Locks the mutation-report renderer (U-005, decision D-054; the crashed-run
 * half U-046, decision D-172) — the exact code the workflow's render step
 * runs against Stryker's `mutation.json`.
 *
 * The bug this replaces (issue #5, run 41054956364) tallied Stryker's
 * PascalCase statuses against lowercase keys and reported a contradictory
 * "0 detected of 3681 mutants". These tests pin the three properties that
 * prevent a repeat: statuses are normalized (both spellings accepted),
 * unknown statuses abort the render loudly, and every number in the
 * markdown is derived from the statuses actually present.
 *
 * The U-046 half pins the run that produced NO report (Stryker's initial
 * test run died, U-045): the crash body names the crash, extracts the
 * failing initial-run tests from the captured Stryker log (bounded), and
 * never states or implies a score — the pre-U-046 workflow blanked the
 * rolling issue's body and titled the crash "below threshold".
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER_PATH = path.join('scripts', 'render-mutation-report.mjs');

interface MiniMutant {
  status: string;
  mutatorName: string;
  location: { start: { line: number } };
}

interface MiniReport {
  files?: Record<string, { mutants?: MiniMutant[] }>;
}

const render: (report: MiniReport, options: { outcome?: string; date: string }) => string =
  rendererModule.renderMutationReport;
const normalize: (status: string, where?: string) => string = rendererModule.normalizeStatus;
const extractFailed: (log: string | undefined) => Array<{ id: string; message?: string }> =
  rendererModule.extractFailedInitialTests;
const renderCrash: (options: {
  date: string;
  log?: string;
  reportPath?: string;
  runUrl?: string;
}) => string = rendererModule.renderCrashReport;

const mutant = (status: string, line: number, mutator: string): MiniMutant => ({
  status,
  mutatorName: mutator,
  location: { start: { line } },
});

// One mutant of every status the schema defines, spread over two files so
// the per-file table and the file-ordering of the triage list are covered.
const report: MiniReport = {
  files: {
    'src/a.ts': {
      mutants: [
        mutant('Killed', 1, 'MethodExpression'),
        mutant('Survived', 2, 'StringLiteral'),
        mutant('NoCoverage', 3, 'ConditionalExpression'),
      ],
    },
    'src/b.ts': {
      mutants: [
        mutant('Killed', 10, 'ArrowFunction'),
        mutant('Killed', 11, 'MethodExpression'),
        mutant('Timeout', 12, 'ObjectLiteral'),
        mutant('Survived', 13, 'ConditionalExpression'),
        mutant('RuntimeError', 14, 'MethodExpression'),
        mutant('Ignored', 15, 'StringLiteral'),
      ],
    },
  },
};

// Same report with every status lowercased: must render identically.
const lowercasedReport: MiniReport = {
  files: Object.fromEntries(
    Object.entries(report.files ?? {}).map(([file, data]) => [
      file,
      { mutants: (data.mutants ?? []).map((m) => ({ ...m, status: m.status.toLowerCase() })) },
    ]),
  ),
};

describe('normalizeStatus', () => {
  it('passes the canonical PascalCase statuses through', () => {
    for (const status of [
      'Killed',
      'Survived',
      'Timeout',
      'NoCoverage',
      'CompileError',
      'RuntimeError',
      'Ignored',
    ]) {
      expect(normalize(status)).toBe(status);
    }
  });

  it('accepts the lowercase spellings as aliases', () => {
    expect(normalize('killed')).toBe('Killed');
    expect(normalize('survived')).toBe('Survived');
    expect(normalize('timeout')).toBe('Timeout');
    expect(normalize('nocoverage')).toBe('NoCoverage');
    expect(normalize('compileerror')).toBe('CompileError');
    expect(normalize('runtimeerror')).toBe('RuntimeError');
    expect(normalize('ignored')).toBe('Ignored');
  });

  it('aborts loudly on unknown statuses', () => {
    // The old renderer's camelCase keys must not count as known: no Stryker
    // report ever spelled them that way.
    expect(() => normalize('timedOut')).toThrow(/Unknown mutant status "timedOut"/);
    expect(() => normalize('noCoverage')).toThrow(/Unknown mutant status "noCoverage"/);
    // Object.prototype keys are not statuses either.
    expect(() => normalize('toString')).toThrow(/Unknown mutant status "toString"/);
    expect(() => normalize('Zombie')).toThrow(/in the report/);
    expect(() => normalize('Zombie', 'src/x.ts')).toThrow(/in src\/x\.ts/);
    expect(() => normalize('Zombie')).toThrow(/STATUS_ALIASES/);
  });
});

describe('renderMutationReport', () => {
  it('renders the full report from PascalCase statuses', () => {
    expect(render(report, { date: '2026-10-30' })).toBe(
      [
        'Daily mutation report — 2026-10-30',
        '',
        '- Verdict: within the configured thresholds',
        '- Mutation score: 57.1% (4 detected of 7 scoreable mutants — killed 3, ' +
          'timed out 1; ignored and error-status mutants are excluded, see D-055)',
        '- Survived: 2, no coverage: 1, runtime errors: 1, compile errors: 0, ignored: 1',
        '- Error-status mutants (broke the test run itself — neither detected nor survived): `src/b.ts` (1)',
        '- Thresholds and scope: `stryker.config.mjs` (scope and cadence decision: DECISIONS.md D-045)',
        '',
        '## Per-file results',
        '',
        '| File | Mutants | Detected | Survived | Score |',
        '| --- | ---: | ---: | ---: | ---: |',
        '| `src/a.ts` | 3 | 1 | 1 | 33.3% |',
        '| `src/b.ts` | 6 | 3 | 1 | 75% |',
        '',
        '## Survived mutants (triage list)',
        '',
        '- `src/a.ts:2` — StringLiteral',
        '- `src/b.ts:13` — ConditionalExpression',
        '',
        '<sub>Generated by `scripts/render-mutation-report.mjs` via `.github/workflows/mutation.yml`; full JSON/HTML in the run artifact.</sub>',
      ].join('\n'),
    );
  });

  it('renders identical markdown from lowercase statuses', () => {
    expect(render(lowercasedReport, { date: '2026-10-30' })).toBe(
      render(report, { date: '2026-10-30' }),
    );
  });

  it('marks the verdict below-threshold when the Stryker step failed', () => {
    const markdown = render(report, { outcome: 'failure', date: '2026-10-30' });
    expect(markdown).toContain(
      '- Verdict: **below the configured break threshold** (see stryker.config.mjs)',
    );
  });

  it('aborts loudly on an unknown status, naming the file', () => {
    const poisoned: MiniReport = {
      files: {
        'src/c.ts': {
          mutants: [mutant('Killed', 1, 'MethodExpression'), mutant('Zombie', 2, 'StringLiteral')],
        },
      },
    };
    expect(() => render(poisoned, { date: '2026-10-30' })).toThrow(
      /Unknown mutant status "Zombie" in src\/c\.ts/,
    );
  });

  it('caps the triage list at 200 rows with an overflow note', () => {
    const big: MiniReport = {
      files: {
        'src/big.ts': {
          mutants: Array.from({ length: 205 }, (_, i) =>
            mutant('Survived', i + 1, 'StringLiteral'),
          ),
        },
      },
    };
    const markdown = render(big, { date: '2026-10-30' });
    const rows = markdown.split('\n').filter((line) => line.startsWith('- `src/big.ts:'));
    expect(rows).toHaveLength(200);
    expect(rows[0]).toBe('- `src/big.ts:1` — StringLiteral');
    expect(rows[199]).toBe('- `src/big.ts:200` — StringLiteral');
    expect(markdown).toContain('- …and 5 more (see the uploaded artifact)');
  });

  it('lists error-status files by count, then name', () => {
    const noisy: MiniReport = {
      files: {
        'src/x.ts': {
          mutants: [
            mutant('Killed', 1, 'MethodExpression'),
            mutant('Killed', 2, 'MethodExpression'),
            mutant('Survived', 3, 'StringLiteral'),
            mutant('RuntimeError', 4, 'MethodExpression'),
            mutant('RuntimeError', 5, 'MethodExpression'),
          ],
        },
        'src/y.ts': {
          mutants: [
            mutant('CompileError', 10, 'MethodExpression'),
            mutant('CompileError', 11, 'MethodExpression'),
            mutant('CompileError', 12, 'MethodExpression'),
          ],
        },
        'src/z.ts': {
          mutants: [
            mutant('RuntimeError', 20, 'MethodExpression'),
            mutant('RuntimeError', 21, 'MethodExpression'),
            mutant('RuntimeError', 22, 'MethodExpression'),
          ],
        },
      },
    };
    const markdown = render(noisy, { date: '2026-10-30' });
    expect(markdown).toContain(
      '- Error-status mutants (broke the test run itself — neither detected nor survived): ' +
        '`src/y.ts` (3), `src/z.ts` (3), `src/x.ts` (2)',
    );
    expect(markdown).toContain(
      '- Survived: 1, no coverage: 0, runtime errors: 5, compile errors: 3, ignored: 0',
    );
  });

  it('reports a mutantless run without dividing by zero', () => {
    const empty: MiniReport = { files: { 'src/empty.ts': { mutants: [] } } };
    const markdown = render(empty, { date: '2026-10-30' });
    expect(markdown).toContain(
      '- Mutation score: — (0 detected of 0 scoreable mutants — killed 0, ' +
        'timed out 0; ignored and error-status mutants are excluded, see D-055)',
    );
    expect(markdown).toContain('None — every generated mutant was detected.');
    expect(markdown).not.toContain('| `src/empty.ts`');
  });

  it('renders a report with no files at all', () => {
    const markdown = render({ files: {} }, { date: '2026-10-30' });
    expect(markdown).toContain(
      '- Mutation score: — (0 detected of 0 scoreable mutants — killed 0, ' +
        'timed out 0; ignored and error-status mutants are excluded, see D-055)',
    );
  });

  it('excludes ignored and error-status mutants from the score (D-055)', () => {
    // 50 killed + 50 survived are scoreable; the ignored and error-status
    // mutants must leave the denominator, matching Stryker's own metrics.
    const ignoredHeavy: MiniReport = {
      files: {
        'src/i.ts': {
          mutants: [
            ...Array.from({ length: 50 }, (_, i) => mutant('Killed', i + 1, 'StringLiteral')),
            ...Array.from({ length: 50 }, (_, i) => mutant('Survived', i + 100, 'StringLiteral')),
            ...Array.from({ length: 30 }, (_, i) => mutant('Ignored', i + 200, 'StringLiteral')),
            ...Array.from({ length: 20 }, (_, i) =>
              mutant('RuntimeError', i + 300, 'StringLiteral'),
            ),
          ],
        },
      },
    };
    const markdown = render(ignoredHeavy, { date: '2026-10-30' });
    expect(markdown).toContain(
      '- Mutation score: 50% (50 detected of 100 scoreable mutants — killed 50, ' +
        'timed out 0; ignored and error-status mutants are excluded, see D-055)',
    );
    // The raw mutant count stays visible in the per-file table.
    expect(markdown).toContain('| `src/i.ts` | 150 | 50 | 50 | 50% |');
  });
});

// The crashed-run log shape, from the real daily runs (41421143977 /
// 41611856943 / 41805574274, U-045's ConfigError): timestamped logger lines
// with ANSI colors, the failing test ids on tab-indented lines, the
// assertion summary on a doubly-tab-indented one, then Stryker's own final
// ERROR line and the ConfigError dump.
const green = '\u001B[32m';
const red = '\u001B[91m';
const reset = '\u001B[39m';
const CRASHED_RUN_LOG = [
  `${green}09:13:28 (2558) INFO DryRunExecutor${reset} Starting initial test run ` +
    '(vitest test runner with "perTest" coverage analysis). This may take a while.',
  `${red}09:14:22 (2558) ERROR DryRunExecutor${reset} One or more tests failed in the initial test run:`,
  '\tquotameter init --yes (real launcher, stdin closed) > is reproducible: ' +
    'the same invocation in a fresh directory prints identical bytes',
  "\t\texpected 'A password is required before the ser…' to be 'A password is " +
    "required before the ser…' // Object.is equality",
  `${red}09:14:22 (2558) ERROR Stryker${reset} There were failed tests in the initial test run.`,
  'ConfigError: There were failed tests in the initial test run.',
].join('\n');

describe('extractFailedInitialTests', () => {
  it('extracts the failing test ids and first assertion line from the ANSI-colored log', () => {
    expect(extractFailed(CRASHED_RUN_LOG)).toEqual([
      {
        id:
          'quotameter init --yes (real launcher, stdin closed) > is reproducible: ' +
          'the same invocation in a fresh directory prints identical bytes',
        message:
          "expected 'A password is required before the ser…' to be 'A password is " +
          "required before the ser…' // Object.is equality",
      },
    ]);
  });

  it('returns nothing without the initial-test-run failure header', () => {
    expect(extractFailed(undefined)).toEqual([]);
    expect(extractFailed('')).toEqual([]);
    expect(
      extractFailed(
        [
          '09:13:28 (2558) INFO DryRunExecutor Starting initial test run.',
          `${red}09:14:22 (2558) ERROR Stryker${reset} Some unrelated failure.`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('collects multiple tests and blocks, surviving multi-line failure messages', () => {
    // Stryker logs the whole failed-test list as ONE log entry
    // (`logFailedTestsInInitialRun`), and each test's failureMessage may be
    // multi-line — its continuation lines arrive untabbed between tests, so
    // only the next timestamped log entry may end the block (verified
    // against the installed Stryker's source for U-046).
    const log = [
      '09:14:22 (2558) ERROR DryRunExecutor One or more tests failed in the initial test run:',
      '\ttest/integration/a.spec.ts > suite one > first test fails',
      '\t\tassertion line for the first test',
      'continuation of the multi-line failure message (untabbed, not a log entry)',
      '\ttest/integration/b.spec.ts > second test, still collected after the continuation',
      '\t\tsecond assertion line',
      '09:14:22 (2558) INFO Stryker the next timestamped entry ends the block',
      '\tthis tab line is NOT inside a block and must be ignored',
      '09:14:23 (2558) ERROR DryRunExecutor One or more tests failed in the initial test run:',
      '\ttest/integration/c.spec.ts > a second block restarts collection',
    ].join('\n');
    expect(extractFailed(log)).toEqual([
      {
        id: 'test/integration/a.spec.ts > suite one > first test fails',
        message: 'assertion line for the first test',
      },
      {
        id: 'test/integration/b.spec.ts > second test, still collected after the continuation',
        message: 'second assertion line',
      },
      { id: 'test/integration/c.spec.ts > a second block restarts collection' },
    ]);
  });
});

describe('renderCrashReport', () => {
  it('renders the honest crash body: named crash, extracted tests, run link, no score', () => {
    expect(
      renderCrash({
        date: '2026-11-04',
        log: CRASHED_RUN_LOG,
        runUrl: 'https://github.com/yepbro/quotameter/actions/runs/41805574274',
      }),
    ).toBe(
      [
        'Daily mutation report — 2026-11-04 — crashed before scoring',
        '',
        '- Verdict: **run crashed — no score was measured** (Stryker exited without writing `reports/mutation/mutation.json`)',
        '- Mutation score: **not measured** — no per-file results or survivor list exists for this run',
        '- Cause: There were failed tests in the initial test run.',
        '- Run: https://github.com/yepbro/quotameter/actions/runs/41805574274',
        '- Artifact: no mutation report exists for this run; the run artifact carries the ' +
          'Stryker output log (`stryker-output.log`) instead',
        '',
        '## Failing initial-run tests (from the Stryker output log)',
        '',
        '- `quotameter init --yes (real launcher, stdin closed) > is reproducible: ' +
          'the same invocation in a fresh directory prints identical bytes`',
        "  - expected 'A password is required before the ser…' to be 'A password is " +
          "required before the ser…' // Object.is equality",
        '',
        'This is NOT a below-threshold score — no score exists. Triage per the crashed-run ' +
          'case in `docs/mutation-testing.md` ("How to react"), not the survivor list.',
        '',
        '<sub>Generated by `scripts/render-mutation-report.mjs` via `.github/workflows/mutation.yml`; ' +
          'the last scored report, if any, stays in the issue body until a scored run replaces it.</sub>',
      ].join('\n'),
    );
  });

  it('omits the run link and the tests section when only a date is known (local render)', () => {
    const markdown = renderCrash({ date: '2026-11-04' });
    expect(markdown).not.toContain('- Run:');
    expect(markdown).not.toContain('## Failing initial-run tests');
    expect(markdown).toContain('- Cause: unknown (no Stryker output log was captured)');
  });

  it('says the cause is unknown when the log carries no ERROR line', () => {
    const markdown = renderCrash({
      date: '2026-11-04',
      log: '09:00:00 (1) INFO Stryker all quiet\n',
    });
    expect(markdown).toContain('- Cause: unknown (no Stryker ERROR line in the captured log)');
  });

  it('never states or implies a measured score', () => {
    for (const markdown of [
      renderCrash({ date: '2026-11-04', log: CRASHED_RUN_LOG }),
      renderCrash({ date: '2026-11-04' }),
    ]) {
      expect(markdown).toContain('no score was measured');
      expect(markdown).toContain('NOT a below-threshold score');
      // No phantom numbers: the crash body must not carry a percent score,
      // a scoreable-mutants line, or the normal body's verdict vocabulary.
      expect(markdown).not.toMatch(/Mutation score: [\d.]+%/);
      expect(markdown).not.toContain('scoreable mutants');
      expect(markdown).not.toContain('within the configured thresholds');
      expect(markdown).not.toContain('below the configured break threshold');
    }
  });

  it('caps the failing-test list at 20 rows with an overflow note', () => {
    const log = [
      '09:14:22 (2558) ERROR DryRunExecutor One or more tests failed in the initial test run:',
      ...Array.from(
        { length: 25 },
        (_, i) => `\ttest/integration/big.spec.ts > test ${i + 1} died`,
      ),
    ].join('\n');
    const markdown = renderCrash({ date: '2026-11-04', log });
    const rows = markdown
      .split('\n')
      .filter((line) => line.startsWith('- `test/integration/big.spec.ts'));
    expect(rows).toHaveLength(20);
    expect(rows[19]).toBe('- `test/integration/big.spec.ts > test 20 died`');
    expect(markdown).toContain('- …and 5 more (see the run log)');
  });

  it('clips long test ids and assertion lines', () => {
    const longId = `${'x'.repeat(400)} > tail-visible`;
    const longMessage = 'y'.repeat(400);
    const markdown = renderCrash({
      date: '2026-11-04',
      log: [
        '09:14:22 (2558) ERROR DryRunExecutor One or more tests failed in the initial test run:',
        `\t${longId}`,
        `\t\t${longMessage}`,
      ].join('\n'),
    });
    expect(markdown).toContain(`- \`${'x'.repeat(299)}…\``);
    expect(markdown).toContain(`  - ${'y'.repeat(199)}…`);
    // The id clip must keep the leading part, never the tail past the cap.
    expect(markdown).not.toContain('tail-visible');
  });
});

describe('render-mutation-report CLI no-report path', () => {
  // The workflow calls the script with a shell redirect
  // (`node scripts/render-mutation-report.mjs > /tmp/mutation-report.md`);
  // the redirect creates the output file even when node exits non-zero —
  // the mechanism that blanked the rolling issue before U-046. These cells
  // pin the contract at the CLI boundary: a MISSING report exits 0 with the
  // crash body on stdout (the redirect then holds the honest body).
  // A plain node spawn is deterministic; 15 s only margins load reporting.
  const runRenderer = (args: string[], envOverrides: Record<string, string>) =>
    new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      execFile(
        process.execPath,
        [RENDERER_PATH, ...args],
        {
          cwd: REPO_ROOT,
          timeout: 15_000,
          env: {
            // Strip the renderer's own inputs (GITHUB_* build the run link,
            // STRYKER_* feed verdict and log) so each cell controls them
            // explicitly — an ambient STRYKER_LOG_FILE would flip the
            // "no captured log" cell's expected cause line (review round P2).
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) =>
                  !name.startsWith('GITHUB_') &&
                  name !== 'STRYKER_LOG_FILE' &&
                  name !== 'STRYKER_OUTCOME',
              ),
            ),
            ...envOverrides,
          },
        },
        (error, stdout, stderr) => {
          if (error !== null && error.code === undefined) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr, code: error === null ? 0 : Number(error.code) || 1 });
        },
      );
    });

  it('a missing mutation.json exits 0 and prints the crash body, not an ENOENT', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'qm-mutation-crash-'));
    const logFile = path.join(logDir, 'stryker-output.log');
    writeFileSync(logFile, CRASHED_RUN_LOG, 'utf8');
    try {
      const { stdout, stderr, code } = await runRenderer(
        [path.join(logDir, 'reports', 'mutation', 'mutation.json')],
        { STRYKER_LOG_FILE: logFile },
      );
      expect(code, 'the missing report is a rendered crash body, exit 0').toBe(0);
      expect(stdout).toContain('crashed before scoring');
      expect(stdout).toContain('- Verdict: **run crashed — no score was measured**');
      // The log file feeds the extraction (same content as the unit-level cells).
      expect(stdout).toContain('Failing initial-run tests');
      expect(stdout).toContain('quotameter init --yes');
      expect(stderr).toBe('');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('a missing mutation.json without a captured log still renders honestly (exit 0)', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'qm-mutation-crash-'));
    try {
      const { stdout, code } = await runRenderer([path.join(logDir, 'missing-mutation.json')], {});
      expect(code).toBe(0);
      expect(stdout).toContain('- Cause: unknown (no Stryker output log was captured)');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('a corrupt (unparseable) report still aborts loudly — it is not a missing report', async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), 'qm-mutation-crash-'));
    const corrupt = path.join(logDir, 'mutation.json');
    writeFileSync(corrupt, '{"files": ', 'utf8');
    try {
      const { code, stderr } = await runRenderer([corrupt], {});
      expect(code, 'D-054: an unparseable report must fail the render step').not.toBe(0);
      expect(stderr).toContain('render-mutation-report:');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
