import { describe, expect, it } from 'vitest';

// @ts-expect-error the renderer is a plain-ESM CLI script (Node 22 runs it without a build step, like scripts/generate-schema.mjs); its two exports are typed locally below
import { normalizeStatus, renderMutationReport } from '../../scripts/render-mutation-report.mjs';

/**
 * Locks the mutation-report renderer (U-005, decision D-054) — the exact
 * code the workflow's render step runs against Stryker's `mutation.json`.
 *
 * The bug this replaces (issue #5, run 41054956364) tallied Stryker's
 * PascalCase statuses against lowercase keys and reported a contradictory
 * "0 detected of 3681 mutants". These tests pin the three properties that
 * prevent a repeat: statuses are normalized (both spellings accepted),
 * unknown statuses abort the render loudly, and every number in the
 * markdown is derived from the statuses actually present.
 */

interface MiniMutant {
  status: string;
  mutatorName: string;
  location: { start: { line: number } };
}

interface MiniReport {
  files?: Record<string, { mutants?: MiniMutant[] }>;
}

const render: (report: MiniReport, options: { outcome?: string; date: string }) => string =
  renderMutationReport;
const normalize: (status: string, where?: string) => string = normalizeStatus;

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
        '- Mutation score: 44.4% (4 detected of 9 mutants — killed 3, timed out 1)',
        '- Survived: 2, no coverage: 1, runtime errors: 1, compile errors: 0, ignored: 1',
        '- Error-status mutants (broke the test run itself — neither detected nor survived): `src/b.ts` (1)',
        '- Thresholds and scope: `stryker.config.mjs` (scope and cadence decision: DECISIONS.md D-045)',
        '',
        '## Per-file results',
        '',
        '| File | Mutants | Detected | Survived | Score |',
        '| --- | ---: | ---: | ---: | ---: |',
        '| `src/a.ts` | 3 | 1 | 1 | 33.3% |',
        '| `src/b.ts` | 6 | 3 | 1 | 50% |',
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
      '- Mutation score: — (0 detected of 0 mutants — killed 0, timed out 0)',
    );
    expect(markdown).toContain('None — every generated mutant was detected.');
    expect(markdown).not.toContain('| `src/empty.ts`');
  });

  it('renders a report with no files at all', () => {
    const markdown = render({ files: {} }, { date: '2026-10-30' });
    expect(markdown).toContain(
      '- Mutation score: — (0 detected of 0 mutants — killed 0, timed out 0)',
    );
  });
});
