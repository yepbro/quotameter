import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The release checklist and changelog structure guard (task 193, spec
 * §4.4/§18; decision D-205).
 *
 * Two artifacts of the release process are prose that must not drift:
 *
 * - `CHANGELOG.md` — the release fold ("Unreleased becomes the new version
 *   section") is only a deterministic edit if the section carries each
 *   category heading at most once, headings keep the Keep a Changelog
 *   shapes, and sections stay newest-first. The file had accumulated five
 *   `### Added` blocks under one Unreleased before this guard's first
 *   commit; the one-time merge preserved every entry byte, and this spec is
 *   what keeps the structure fold-ready from now on.
 * - `docs/release.md`'s checklist — "release steps are documented and
 *   reproducible" (task 193's done condition) means every step names its
 *   executable form. This spec pins that the named commands are REAL: every
 *   `npm run <script>` the page mentions exists in package.json, every
 *   `make <target>` exists in the Makefile, and the clean-container
 *   image's Node version equals the Dockerfile pin — a rename that strands
 *   the checklist fails `make check` here, not at the next release.
 *
 * The shape follows the repo's guard precedents: loud scanners that throw
 * on unrecognized shapes (`test/unit/release-workflow.spec.ts`) and
 * structure pins with both-directions counts
 * (`test/unit/readme-command-table.spec.ts`). Boundary:
 * `test/unit/package-manifest.spec.ts` checks that a released
 * package.json version HAS a changelog section; this spec checks the
 * section's own structure.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The Keep a Changelog category set, as documented in docs/release.md. */
const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const;

/** One `##` section of CHANGELOG.md. */
interface ChangelogSection {
  /** `Unreleased` or the `X.Y.Z` version. */
  id: string;
  /** The trailing `- YYYY-MM-DD` of a released heading, if present. */
  date?: string;
  /** Category headings in order of appearance, duplicates included. */
  categoryHeadings: string[];
  /** Non-blank lines seen before the first category heading of the section. */
  preambleLines: string[];
  /** Non-blank entry lines that did not start with `- `. */
  nonEntryLines: string[];
}

/** Reads a repository file, verbatim. */
function repoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Parses CHANGELOG.md into its `##` sections (an empty array is a loud throw). */
function changelogSections(): ChangelogSection[] {
  const lines = repoFile('CHANGELOG.md').split('\n');
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  let inHeader = true;
  for (const line of lines) {
    const sectionHeading = /^## (.+?)\s*$/.exec(line);
    if (sectionHeading?.[1]) {
      inHeader = false;
      const bracket = /^\[(Unreleased|\d+\.\d+\.\d+)\](?: - (.+?))?\s*$/.exec(sectionHeading[1]);
      if (!bracket?.[1]) {
        throw new Error(
          `CHANGELOG.md heading '${sectionHeading[1]}' is not '[Unreleased]' or ` +
            "'[X.Y.Z] - YYYY-MM-DD' — Keep a Changelog shapes only; update the fold " +
            'mechanics in docs/release.md together with this parser',
        );
      }
      current = {
        id: bracket[1],
        date: bracket[2],
        categoryHeadings: [],
        preambleLines: [],
        nonEntryLines: [],
      };
      sections.push(current);
      continue;
    }
    if (current === undefined) {
      continue; // the file header (Keep a Changelog / Semver links)
    }
    const category = /^### (.+?)\s*$/.exec(line);
    if (category?.[1]) {
      current.categoryHeadings.push(category[1]);
      continue;
    }
    if (line.trim().length === 0) continue;
    if (current.categoryHeadings.length === 0) {
      current.preambleLines.push(line);
      continue;
    }
    if (!line.startsWith('- ')) current.nonEntryLines.push(line);
  }
  if (inHeader || sections.length === 0) {
    throw new Error(
      'CHANGELOG.md has no ## section headings — the Unreleased section is the ' +
        'release fold input; it cannot be missing',
    );
  }
  return sections;
}

/** `[major, minor, patch]` for an exact X.Y.Z version. */
function semverTuple(version: string): [number, number, number] {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`'${version}' is not an exact X.Y.Z version`);
  }
  return parts as [number, number, number];
}

/** True when `YYYY-MM-DD` is a real calendar date (not just digit-shaped). */
function isCalendarDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/** Compares two semver tuples: negative when `a` is older than `b`. */
function compareTuple(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** The `## <name>` section body of a markdown file, or a loud throw. */
function markdownSection(file: string, name: string): string {
  const lines = repoFile(file).split('\n');
  const start = lines.findIndex((line) => line === `## ${name}`);
  if (start === -1) {
    throw new Error(
      `${file} lost its '## ${name}' section — restore it or retire this guard deliberately`,
    );
  }
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
}

/** One numbered checklist step of docs/release.md's release checklist. */
interface ChecklistStep {
  number: number;
  /** The step's bold lead, e.g. `Verify CI is green`. */
  lead: string;
}

/** The checklist's numbered steps in order (a loud throw when none parse). */
function checklistSteps(): ChecklistStep[] {
  const section = markdownSection('docs/release.md', 'Release checklist');
  const numbered = captures(section, /^(\d+)\./gm);
  const steps: ChecklistStep[] = [];
  for (const match of section.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)) {
    const lead = match[2];
    if (lead !== undefined) steps.push({ number: Number(match[1]), lead });
  }
  if (steps.length === 0) {
    throw new Error(
      "docs/release.md's release checklist has no numbered '**bold-lead**' steps — " +
        'the pinned checklist shape is a numbered list with bold step leads',
    );
  }
  if (numbered.length !== steps.length) {
    throw new Error(
      `the release checklist has ${numbered.length} numbered lines but only ${steps.length} ` +
        "parse as numbered '**bold-lead**' steps — a numbered step without a bold lead is " +
        'invisible to this guard; give every step its bold lead',
    );
  }
  return steps;
}

/** The first capture group of every match of `pattern` in `text`. */
function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] !== undefined ? [match[1]] : []));
}

/**
 * Every `make <target>` named in docs/release.md — code spans only: the page
 * writes whole commands inside one backtick pair (`make openapi`), which
 * keeps ordinary prose ("make sure the release is safe") out of the reality
 * check while still checking every command-shaped mention.
 */
function makeTargetsNamed(): string[] {
  return captures(repoFile('docs/release.md'), /`make ([a-zA-Z0-9_-]+)`/g);
}

/** Every `npm run <script>` named in docs/release.md (code spans only). */
function npmScriptsNamed(): string[] {
  return captures(repoFile('docs/release.md'), /`npm run ([a-zA-Z0-9:._-]+)`/g);
}

describe('changelog structure guard (task 193, spec §4.4/§18; decision D-205)', () => {
  it('declares the Keep a Changelog format and SemVer adherence, and opens with Unreleased', () => {
    const text = repoFile('CHANGELOG.md');
    expect(text, 'the header must link the Keep a Changelog format the fold depends on').toContain(
      'https://keepachangelog.com/en/1.1.0/',
    );
    expect(text, 'the header must state the SemVer adherence docs/release.md describes').toContain(
      'https://semver.org/spec/v2.0.0.html',
    );
    const sections = changelogSections();
    expect(sections[0]?.id, 'the first section must be Unreleased (newest first)').toBe(
      'Unreleased',
    );
    expect(
      sections[0]?.date,
      'Unreleased never carries a date — only released sections do',
    ).toBeUndefined();
  });

  it('uses exact heading shapes: versions are dated real calendar days', () => {
    for (const section of changelogSections()) {
      if (section.id === 'Unreleased') continue;
      expect(
        section.date,
        `version section ${section.id} must carry a '- YYYY-MM-DD' date`,
      ).toBeDefined();
      expect(
        isCalendarDate(section.date ?? ''),
        `version section ${section.id} date '${section.date}' is not a real calendar day`,
      ).toBe(true);
    }
  });

  it('lists sections newest first with unique ids — exactly one Unreleased', () => {
    const ids = changelogSections().map((section) => section.id);
    expect(
      new Set(ids).size,
      'each changelog section id may appear exactly once — a second Unreleased ' +
        'section (a fold that opened a fresh heading without renaming the old one) ' +
        'or two sections for one version make the fold ambiguous',
    ).toBe(ids.length);
    const versions = ids.filter((id) => id !== 'Unreleased');
    for (let index = 1; index < versions.length; index += 1) {
      const previous = semverTuple(versions[index - 1] ?? '');
      const current = semverTuple(versions[index] ?? '');
      expect(
        compareTuple(previous, current) > 0,
        `section order must be newest first: ${versions[index - 1]} is followed by ${versions[index]}`,
      ).toBe(true);
    }
  });

  it('carries each category heading at most once per section, from the fixed set', () => {
    // This is the invariant the release fold needs: with one heading per
    // category, renaming `## [Unreleased]` yields a complete version
    // section. The file once grew five `### Added` blocks instead.
    for (const section of changelogSections()) {
      for (const heading of section.categoryHeadings) {
        expect(
          CATEGORIES,
          `section ${section.id}: '${heading}' is not a Keep a Changelog category`,
        ).toContain(heading);
      }
      const counts = new Map<string, number>();
      for (const heading of section.categoryHeadings) {
        counts.set(heading, (counts.get(heading) ?? 0) + 1);
      }
      for (const [heading, count] of counts) {
        expect(
          count,
          `section ${section.id} carries '${heading}' ${count}× — merge the blocks; ` +
            'the fold would otherwise produce a duplicated-category version section',
        ).toBe(1);
      }
      if (section.id !== 'Unreleased') {
        expect(
          section.categoryHeadings.length,
          `released section ${section.id} must hold at least one category of entries`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every entry a list item under a category heading', () => {
    for (const section of changelogSections()) {
      expect(
        section.preambleLines,
        `section ${section.id} has prose between the section heading and the first ` +
          'category — entries live under `###` category headings only',
      ).toEqual([]);
      expect(
        section.nonEntryLines,
        `section ${section.id} has lines under a category that are not '- ' entries`,
      ).toEqual([]);
    }
  });
});

describe('release checklist guard (task 193, spec §4.4/§18; decision D-205)', () => {
  /** The pinned steps, in order: adding/renaming one is a deliberate guard update. */
  const PINNED_STEPS = [
    'Verify CI is green',
    'Update the changelog',
    'Bump the version',
    'Commit and push',
    'Verify the npm trusted-publisher configuration',
    'Create and push the tag',
    'Watch the release workflow',
    'Verify on npm',
    'Announce',
  ];

  it('numbers its steps contiguously with the pinned bold leads, in order', () => {
    const steps = checklistSteps();
    expect(
      steps.map((step) => step.lead),
      'the step set changed — update the pinned leads in this guard consciously, ' +
        'together with the component anchors below',
    ).toEqual(PINNED_STEPS);
    expect(
      steps.map((step) => step.number),
      'checklist numbering must stay contiguous 1..N (no inserted or shadowed steps)',
    ).toEqual(steps.map((_, index) => index + 1));
  });

  it('covers the six spec-named release components with named commands', () => {
    const checklist = markdownSection('docs/release.md', 'Release checklist');
    const anchors: ReadonlyArray<[string, string[]]> = [
      ['version', ['npm version X.Y.Z --no-git-tag-version', 'make openapi']],
      ['tests', ['--workflow ci.yml', 'test:ci', '--exit-status']],
      ['package inspection', ['check:package']],
      ['tag', ['git tag vX.Y.Z && git push origin vX.Y.Z']],
      ['provenance', ['dist.attestations', 'https://slsa.dev/provenance/v1', '--provenance']],
      ['post-release verification', ['npm view', 'docker run', 'dist-tags --json']],
    ];
    for (const [component, phrases] of anchors) {
      for (const phrase of phrases) {
        expect(
          checklist,
          `the checklist no longer names the ${component} step's command '${phrase}' — ` +
            'restore the executable form or update this anchor with the new one',
        ).toContain(phrase);
      }
    }
  });

  it('documents the fold mechanics the changelog structure guard enforces', () => {
    const changelogSection = markdownSection('docs/release.md', 'Changelog');
    expect(
      changelogSection,
      'the Changelog section must state the released heading shape the fold produces',
    ).toContain('## [X.Y.Z] - YYYY-MM-DD');
    expect(
      changelogSection,
      'the Changelog section must state that a fresh Unreleased heading opens above',
    ).toContain('## [Unreleased]');
    expect(changelogSection, 'the fold mechanics must reference their enforcing guard').toContain(
      'test/unit/release-checklist.spec.ts',
    );
  });

  it('names only real npm scripts and make targets', () => {
    const scripts: Record<string, string> = JSON.parse(repoFile('package.json')).scripts;
    for (const script of npmScriptsNamed()) {
      expect(
        scripts[script],
        `docs/release.md tells the releaser to run 'npm run ${script}', which does not ` +
          'exist — a renamed script stranded the checklist; fix the page or the rename',
      ).toBeDefined();
    }
    const makefile = repoFile('Makefile');
    const targets = new Set(captures(makefile, /^([a-zA-Z][a-zA-Z0-9_-]*):(?!=)/gm));
    for (const target of makeTargetsNamed()) {
      expect(
        targets.has(target),
        `docs/release.md tells the releaser to run 'make ${target}', which is not a ` +
          'Makefile target — a renamed target stranded the checklist; fix the page or the rename',
      ).toBe(true);
    }
  });

  it('pins the clean-container image of the docker-run command to the Dockerfile Node version', () => {
    const nodeTag = /^FROM node:(\d+\.\d+\.\d+)/m.exec(repoFile('Dockerfile'))?.[1];
    expect(nodeTag, 'the Dockerfile must pin a node:<version> base image').toBeDefined();
    const checklist = markdownSection('docs/release.md', 'Release checklist');
    const image = /docker run --rm node:(\d+\.\d+\.\d+)-/.exec(checklist)?.[1];
    expect(
      image,
      'the post-release verification must keep its docker-run clean-container install ' +
        'in the pinned `docker run --rm node:<version>-…` shape — its image version is ' +
        'compared to the Dockerfile pin below',
    ).toBeDefined();
    expect(
      image,
      'the clean-container image must run the declared minimum Node — the same version ' +
        'line the Dockerfile pins (a Node bump must update both)',
    ).toBe(nodeTag);
  });

  it('keeps the version bump honest: package.json and package-lock.json agree', () => {
    // `npm version X.Y.Z --no-git-tag-version` (checklist step 3) updates
    // both files; a hand edit of package.json alone leaves the lockfile's
    // embedded version stale, and the release tarball would disagree with
    // the manifest the registry shows.
    const version: string = JSON.parse(repoFile('package.json')).version;
    const lock = JSON.parse(repoFile('package-lock.json'));
    expect(lock.version, "package-lock.json's root version must equal package.json's").toBe(
      version,
    );
    expect(
      lock.packages?.['']?.version,
      'package-lock.json packages[""].version must equal package.json\'s — run ' +
        '`npm version X.Y.Z --no-git-tag-version`, never a hand edit',
    ).toBe(version);
  });
});
