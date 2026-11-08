import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  isDeepBareImport,
  mapRelativeSpecifier,
  planSpecifierEdits,
  type ResolveSibling,
  type SpecifierEdit,
} from '../../scripts/build-cli.mjs';

/**
 * The packaging build's specifier-normalization seams (task 185, decision
 * D-195; spec §3, §17.2).
 *
 * `npm run build:cli` compiles `src/` (extensionless, bundler-resolution
 * style) into `dist/` that plain Node ESM must load — no jiti, no source
 * checkout, no install-time build. These are the pure functions that make
 * the emitted graph loadable, pinned here at the unit level:
 *  - `mapRelativeSpecifier` — bundler resolution's two fallbacks
 *    (`x.js`, `x/index.js`) probed against the emitted tree;
 *  - `isDeepBareImport` — the extensionless deep bare import jiti resolves
 *    (CJS extension guessing) and real Node ESM refuses (`ajv/dist/2020`
 *    verified live on the pinned runtime in task 185's design phase);
 *  - `planSpecifierEdits`/`applyEdits` — TypeScript-parser-planned rewrites
 *    over emitted JavaScript: import, export-from (including `export *`),
 *    side-effect, and dynamic-import forms; prose strings and comments are
 *    structurally invisible to the planner (the precision regexes cannot
 *    offer — a string containing `from './x'` is never rewritten).
 *
 * The end-to-end proof (a real build imported and run through the real
 * launcher) lives in `test/integration/cli-bin-dist.spec.ts`.
 */

/** A sibling resolver over a fixture emitted tree. */
function resolverOf(...files: readonly string[]): ResolveSibling {
  const set = new Set(files);
  return (candidate: string) => set.has(candidate);
}

describe('mapRelativeSpecifier (bundler fallbacks against the emitted tree)', () => {
  it('appends .js when the sibling module file was emitted', () => {
    expect(mapRelativeSpecifier('./commands', resolverOf('./commands.js'))).toBe('./commands.js');
  });

  it('maps a directory import to its emitted index.js', () => {
    expect(
      mapRelativeSpecifier(
        '../providers/zai-coding-plan',
        resolverOf('../providers/zai-coding-plan/index.js'),
      ),
    ).toBe('../providers/zai-coding-plan/index.js');
  });

  it('leaves an already-exact specifier untouched without probing', () => {
    const probed: string[] = [];
    expect(mapRelativeSpecifier('./main.js', (candidate) => (probed.push(candidate), false))).toBe(
      './main.js',
    );
    expect(probed, 'an exact specifier must not probe the tree').toEqual([]);
  });

  it('fails closed with undefined when nothing emitted matches', () => {
    expect(mapRelativeSpecifier('./gone', resolverOf())).toBeUndefined();
    expect(mapRelativeSpecifier('./gone', resolverOf('./other.js'))).toBeUndefined();
  });
});

describe('isDeepBareImport (the class jiti resolves and Node ESM refuses)', () => {
  it('flags extensionless deep imports of plain and scoped packages', () => {
    expect(isDeepBareImport('ajv/dist/2020')).toBe(true);
    expect(isDeepBareImport('@scope/pkg/sub')).toBe(true);
    expect(isDeepBareImport('pkg/sub/dir')).toBe(true);
  });

  it('passes package roots, exact files, and node builtins', () => {
    expect(isDeepBareImport('pino')).toBe(false);
    expect(isDeepBareImport('ajv/dist/2020.js')).toBe(false);
    expect(isDeepBareImport('@fastify/cookie')).toBe(false);
    expect(isDeepBareImport('node:fs/promises')).toBe(false);
  });
});

describe('planSpecifierEdits (TypeScript-parser-planned rewrites)', () => {
  const resolve: ResolveSibling = resolverOf(
    './commands.js',
    './help.js',
    './lazy.js',
    './side-effect.js',
    './barrel/index.js',
  );

  it('rewrites every import form of an emitted module', () => {
    const code = [
      "import { buildCommandTable } from './commands';",
      "import './side-effect';",
      'import {', // multi-line clause: the from-clause is its own line
      '  renderCommandHelp,',
      "} from './help';",
      "export * from './barrel';",
      "export { runCli } from './main.js';",
      "const load = () => import('./lazy');",
      "import Fastify from 'fastify';",
      "import * as fs from 'node:fs/promises';",
      'export async function runCli() {}',
    ].join('\n');
    const { edits, problems } = planSpecifierEdits(code, resolve);
    expect(problems).toEqual([]);
    const out = applyEdits(code, edits);
    expect(out).toContain("from './commands.js';");
    expect(out).toContain("import './side-effect.js';");
    expect(out).toContain("} from './help.js';");
    expect(out).toContain("export * from './barrel/index.js';");
    expect(out).toContain("export { runCli } from './main.js';"); // already exact
    expect(out).toContain("import('./lazy.js')");
    expect(out).toContain("from 'fastify';"); // bare root untouched
    expect(out).toContain("from 'node:fs/promises';"); // builtin untouched
    expect(out).not.toContain("'./commands'");
  });

  it('never rewrites prose strings or comments that merely look like imports', () => {
    const code = [
      "/** Docblock mentioning {@link import('./doc-link')} — a comment. */",
      'const prose = "got from \'./not-an-import\'";',
      "const template = `see from './also-not'`;",
      'export async function runCli() {}',
    ].join('\n');
    const { edits, problems } = planSpecifierEdits(code, resolve);
    expect(problems).toEqual([]);
    expect(edits, 'no string or comment may produce an edit').toEqual([]);
  });

  it('reports unresolvable relative specifiers and deep bare imports as problems', () => {
    const code = [
      "import { gone } from './gone';",
      "import Ajv from 'ajv/dist/2020';",
      'export const x = 1;',
    ].join('\n');
    const { edits, problems } = planSpecifierEdits(code, resolve);
    expect(edits).toEqual([]);
    expect(problems.some((problem) => problem.includes('./gone'))).toBe(true);
    expect(problems.some((problem) => problem.includes("'ajv/dist/2020'"))).toBe(true);
  });

  it('plans the specifier of a two-argument dynamic import (import attributes)', () => {
    // The review round's latent-gap finding: the specifier must be
    // identified by POSITION (first argument), not by "exactly one
    // argument" — `import('./x', { with: … })` is planned, not skipped
    // (a skip would let an extensionless specifier reach the artifact).
    const code = "const m = import('./lazy', { with: { type: 'json' } });";
    const { edits, problems } = planSpecifierEdits(code, resolve);
    expect(problems).toEqual([]);
    expect(applyEdits(code, edits)).toContain("import('./lazy.js',");
  });

  it('fails closed on an escaped specifier the splice arithmetic cannot trust', () => {
    // The inner-span derivation assumes the cooked text equals the raw
    // slice; an escaped literal ('\u002e/x' — '.' escaped) breaks that.
    // The planner must refuse, never splice at a wrong offset.
    const code = "import { x } from '\\u002e/commands';";
    const { edits, problems } = planSpecifierEdits(code, resolve);
    expect(edits).toEqual([]);
    expect(problems.some((problem) => problem.includes('escapes'))).toBe(true);
  });
});

describe('applyEdits (pure offset-adjusted splicing)', () => {
  it('applies multiple edits of different lengths in one pass', () => {
    const code = "a './one'; b './two'; c './three';";
    const edits: SpecifierEdit[] = [
      { start: code.indexOf('one'), end: code.indexOf('one') + 3, text: 'one/two' },
      { start: code.indexOf('three'), end: code.indexOf('three') + 5, text: 'x' },
    ];
    expect(applyEdits(code, edits)).toBe("a './one/two'; b './two'; c './x';");
  });

  it('is a no-op for an empty edit list', () => {
    expect(applyEdits('code', [])).toBe('code');
  });
});
