import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The §19 evidence-matrix guard (task 199, spec §19; decision D-209).
 *
 * `docs/mvp-acceptance.md` is the criteria-vs-evidence verification: one
 * section per §19 criterion, each with a verdict and named evidence. Prose
 * like that rots in exactly two ways, and this spec pins both:
 *
 * - structure — the page must carry one section per criterion of the spec's
 *   own §19 list (parsed live from plan/SPECIFICATION.md, so a spec change
 *   that adds or removes a criterion fails here until the page follows), a
 *   dated header, a verdict from the documented vocabulary in every section
 *   and in the summary table (the two must agree), and the
 *   residual/re-verification anchors (U-061, task 200, `1.0.0`).
 * - evidence reality — every repository path the page cites in backticks
 *   (plus its relative markdown links) must exist on disk, so a renamed
 *   suite, a moved doc, or a deleted fixture fails `make check` at the
 *   citation site, not at the 1.0.0 re-verification.
 *
 * The shape follows the repo's guard precedents (`test/unit/release-checklist.spec.ts`,
 * `test/unit/provider-dossier.spec.ts`): loud scanners that throw on
 * unrecognized shapes and both-directions count checks.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ACCEPTANCE_DOC = 'docs/mvp-acceptance.md';
const SPEC = 'plan/SPECIFICATION.md';

/** Repository roots a backtick token must start with to be a checkable path. */
const PATH_ROOTS = ['.github', 'docs', 'test', 'src', 'ui', 'plan', 'schema', 'scripts', 'bin'];

/** Root-level files the page may cite; anything else at the top level is not a path. */
const ROOT_FILES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'DECISIONS.md',
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-NOTICES',
  'Makefile',
  'package.json',
  'AGENTS.md',
];

/** File extensions that make a bare backtick token a checkable repository file. */
const PATH_EXTENSIONS = /\.(spec\.ts|d\.ts|ts|md|json|ya?ml|mjs|cjs|sh|vue|service)$/;

/** The page's documented verdict vocabulary (docs/mvp-acceptance.md legend). */
const VERDICTS = ['Complete', 'Complete with residual', 'Pending'] as const;

/** Reads a repository file, verbatim. */
function repoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** One §19 criterion of the specification. */
interface SpecCriterion {
  /** The `1.`-style number. */
  number: number;
  /** The criterion's leading words, used as an identity anchor. */
  lead: string;
}

/**
 * Parses the numbered criteria out of spec §19. Loud by design: the spec's
 * §19 shape is an input, and any change to it must consciously update
 * docs/mvp-acceptance.md together with this parser.
 */
function specCriteria(): SpecCriterion[] {
  const lines = repoFile(SPEC).split('\n');
  const heading = lines.findIndex((line) => line.startsWith('## 19. '));
  if (heading < 0) {
    throw new Error(
      `${SPEC} has no '## 19.' heading — update this spec together with the spec change`,
    );
  }
  const criteria: SpecCriterion[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith('## ')) break;
    const numbered = /^(\d{1,2})\. (.+)$/.exec(line);
    if (!numbered) continue;
    const number = Number(numbered[1]);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`${SPEC} §19 has an unparsable criterion line: '${line.trim()}'`);
    }
    criteria.push({ number, lead: numbered[2]! });
  }
  if (criteria.length === 0) {
    throw new Error(`${SPEC} §19 yielded no numbered criteria — parser or spec shape drifted`);
  }
  for (let index = 0; index < criteria.length; index += 1) {
    if (criteria[index]!.number !== index + 1) {
      throw new Error(
        `${SPEC} §19 criteria are not sequential from 1 (position ${index + 1} carries number ${criteria[index]!.number}) ` +
          '— update docs/mvp-acceptance.md and this parser together with the spec change',
      );
    }
  }
  return criteria;
}

/** One `### N.` section of the evidence page. */
interface DocSection {
  number: number;
  /** The section's full text (heading line included). */
  text: string;
  /** The `**Verdict — …**` line, verbatim. */
  verdictLine: string;
}

/** Removes backticks so prose and quoted spec text can be compared literally. */
function stripTicks(fragment: string): string {
  return fragment.replaceAll('`', '');
}

/** Parses the evidence page's per-criterion sections. */
function docSections(doc: string): DocSection[] {
  const sections: DocSection[] = [];
  for (const part of doc.split(/^### /m).slice(1)) {
    const header = /^(\d{1,2})\. /.exec(part.split('\n')[0] ?? '');
    if (!header) continue;
    sections.push({
      number: Number(header[1]),
      text: part,
      verdictLine: part.split('\n').find((line) => line.startsWith('**Verdict —')) ?? '',
    });
  }
  return sections;
}

/** Extracts every backtick span of a markdown fragment. */
function backtickSpans(fragment: string): string[] {
  return [...fragment.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
}

/** The `## <name>` section body of a markdown document, loudly. */
function markdownSection(doc: string, name: string): string {
  const parts = doc.split(`## ${name}`);
  if (parts.length < 2) throw new Error(`docs page has no '## ${name}' section`);
  return parts[1]!.split('\n## ')[0]!;
}

/** Parses the vocabulary verdict out of a `**Verdict — …**` line. */
function parseVerdict(verdictLine: string): string | undefined {
  // Longest-first so "Complete with residual" wins over "Complete"; the
  // lookahead confines the value to a delimiter (optionally after a space,
  // as in "Complete with residual (R1/U-061)"), so a future
  // "Complete with caveats" cannot degrade to plain "Complete" at a word
  // boundary (the review round's prefix hole).
  const alternation = [...VERDICTS].sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`^\\*\\*Verdict — (${alternation})(?=\\s*[.(]|$)`).exec(verdictLine)?.[1];
}

/** Parses the number and verdict cell out of a summary-table row line. */
function parseSummaryRow(line: string): { number: string; verdict: string } | undefined {
  const cells = line.split('|');
  const number = /^\s*(\d{1,2})\s*$/.exec(cells[1] ?? '')?.[1];
  if (!number) return undefined;
  // Bold markup is tolerated in the cell (`**Pending**`).
  return { number, verdict: (cells[3] ?? '').replaceAll('*', '').trim() };
}

describe('the §19 evidence page (docs/mvp-acceptance.md)', () => {
  const doc = repoFile(ACCEPTANCE_DOC);
  const sections = docSections(doc);

  it('carries a dated verification header', () => {
    expect(doc).toMatch(/Verification date: \d{4}-\d{2}-\d{2}\./);
  });

  it('documents every §19 criterion the specification defines, in order', () => {
    const criteria = specCriteria();
    expect(sections.map((section) => section.number)).toEqual(
      criteria.map((criterion) => criterion.number),
    );

    // Identity: each section must quote its criterion — the spec's leading
    // words (backtick-normalized) appear in the section body — so the page
    // cannot silently verify a paraphrase of a changed criterion.
    for (const criterion of criteria) {
      const section = sections.find((candidate) => candidate.number === criterion.number);
      expect(section, `a '### ${criterion.number}.' section`).toBeDefined();
      const anchor = stripTicks(criterion.lead.split(' ').slice(0, 4).join(' '));
      expect(
        stripTicks(section!.text),
        `criterion ${criterion.number}'s section must quote the spec's words '${anchor}…'`,
      ).toContain(anchor);
    }
  });

  it('gives every criterion a verdict from the documented vocabulary', () => {
    for (const section of sections) {
      const verdict = parseVerdict(section.verdictLine);
      expect(
        verdict,
        `criterion ${section.number}: verdict line '${section.verdictLine}' must start with one of: ${VERDICTS.join(' | ')}`,
      ).toBeDefined();
      expect(VERDICTS as readonly string[]).toContain(verdict);
      if (verdict !== 'Complete') {
        // Non-plain verdicts must name their residual id (R1, R2, …) so the
        // Residuals table and the verdict cannot diverge.
        expect(
          section.verdictLine,
          `criterion ${section.number}: a non-Complete verdict must name its residual (R<n>)`,
        ).toMatch(/\(R\d/);
      }
    }
  });

  it('has exactly one summary row per criterion, agreeing with its verdict', () => {
    const criteria = specCriteria();
    const summary = markdownSection(doc, 'Summary');
    const rows = [...summary.matchAll(/^\| (\d{1,2})\s+\|/gm)].map((match) => Number(match[1]));
    expect(rows).toEqual(criteria.map((criterion) => criterion.number));

    // The summary is the reader-facing verdict table: each row's verdict cell
    // must equal its section's verdict, or the page contradicts itself while
    // every structural check stays green (the review round's finding).
    for (const line of summary.split('\n')) {
      const row = parseSummaryRow(line);
      if (!row) continue;
      const sectionVerdict = parseVerdict(
        sections.find((section) => section.number === Number(row.number))?.verdictLine ?? '',
      );
      expect(row.verdict, `summary row ${row.number}'s verdict cell`).toBe(sectionVerdict);
    }
  });

  it('names the tracked residuals and their owners', () => {
    const residuals = markdownSection(doc, 'Residuals and owners');
    // R1 is U-061; R3's owner is task 200 (the v0.1.0 rehearsal, D-186).
    expect(residuals).toContain('U-061');
    expect(residuals).toContain('task 200');
  });

  it('carries the 1.0.0 re-verification hook', () => {
    const reverify = markdownSection(doc, 'Re-verification at 1.0.0');
    expect(reverify).toContain('1.0.0');
    expect(reverify).toMatch(/R2/);
    expect(reverify).toMatch(/R3/);
  });

  it('cites only repository paths that exist (evidence rot-check)', () => {
    const missing: string[] = [];
    const checkToken = (token: string): void => {
      const isPath =
        PATH_ROOTS.some((root) => token === root || token.startsWith(`${root}/`)) ||
        ROOT_FILES.includes(token) ||
        // Bare filenames with a repository extension are paths too — a
        // citation like `i18n-catalog.spec.ts` must not bypass the check
        // just because it omits the directory (the review round's finding).
        (PATH_EXTENSIONS.test(token) && !/\s/.test(token));
      if (isPath && !existsSync(path.join(REPO_ROOT, token))) missing.push(token);
    };
    for (const token of backtickSpans(doc)) checkToken(token);
    // Relative markdown links resolve against the page's own directory.
    for (const link of [...doc.matchAll(/\]\(([^)#\s]+)\)/g)].map((match) => match[1]!)) {
      if (/^[a-z]+:\/\//.test(link)) continue;
      if (!existsSync(path.join(REPO_ROOT, path.dirname(ACCEPTANCE_DOC), link))) missing.push(link);
    }
    expect(missing, 'cited paths that do not exist — fix the citation or restore the file').toEqual(
      [],
    );
  });
});

describe('the evidence page is reachable', () => {
  it('is linked from README', () => {
    expect(repoFile('README.md')).toContain('docs/mvp-acceptance.md');
  });
});
