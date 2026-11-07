import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The §10 API-timestamp rule's executable pin (task U-056, spec §10/§13;
 * decision D-183).
 *
 * The 2026-11-06 full-project review found §10's original sentence ("API
 * timestamps use ISO 8601 UTC ending in `Z`") contradicting every landed
 * response contract — all of them epoch-millisecond integers per the
 * D-139 split. D-183 resolved the contradiction by amendment (the D-180
 * precedent): spec 1.2 records epoch-ms responses as the deliberate API
 * representation and scopes the ISO 8601 UTC form to the §13 range request
 * parameters. This spec keeps that reconciliation from silently reverting:
 * the amended §10 sentence, the version/amendment header, the D-183→D-139
 * decision trail, and the corrected artifacts are all pinned against the
 * real files — the same repo-file guard shape as
 * `time-suite-manifest.spec.ts` (D-097) and `dev-container-uid.spec.ts`
 * (D-181). Whitespace is normalized before every prose match, so Prettier's
 * markdown wrapping cannot break the pins; the retired sentence's absence
 * is checked only where it was normative (the spec, the docblocks D-183
 * corrected) — DECISIONS/CHANGELOG quote it as history and must stay
 * free to.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Reads a repo-relative file. */
function read(repoRelative: string): string {
  return readFileSync(path.join(REPO_ROOT, repoRelative), 'utf8');
}

/** Collapses all whitespace runs to single spaces, so wrapped prose matches. */
function normalize(text: string): string {
  return text.replaceAll(/\s+/gu, ' ');
}

/** One repository file, whitespace-normalized. */
function readNormalized(repoRelative: string): string {
  return normalize(read(repoRelative));
}

/** The text of one `## N.` section of the specification, normalized. */
function specSection(heading: string): string {
  const spec = read('plan/SPECIFICATION.md');
  const start = spec.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`specification section '## ${heading}' not found — renamed?`);
  }
  const end = spec.indexOf('\n## ', start + 1);
  return normalize(end === -1 ? spec.slice(start) : spec.slice(start, end));
}

/** The text of one `## D-NNN` entry of DECISIONS.md, normalized. */
function decisionEntry(id: string): string {
  const decisions = read('DECISIONS.md');
  const start = decisions.indexOf(`## ${id} — `);
  if (start === -1) {
    throw new Error(`decision entry '## ${id}' not found — renumbered or removed?`);
  }
  const end = decisions.indexOf('\n## D-', start + 1);
  return normalize(end === -1 ? decisions.slice(start) : decisions.slice(start, end));
}

describe('the §10 API timestamp rule (task U-056, spec §10/§13; decision D-183)', () => {
  it('§10 states epoch-millisecond responses and ISO request parameters', () => {
    const section = specSection('10. Time and time zones');
    expect(section, 'the amended response clause — the D-183 representation of record').toContain(
      'API responses carry timestamps as epoch-millisecond integers',
    );
    expect(section, 'the storage clause stays epoch-ms INTEGER (never amended)').toContain(
      'Store all timestamps as UTC Unix epoch milliseconds (`INTEGER`) in SQLite',
    );
    expect(section, 'the ISO clause is scoped to the §13 range request parameters').toContain(
      'applies to the §13 range request parameters',
    );
    expect(section, 'the client-side Intl formatting clause is untouched').toContain(
      'Format timestamps in the client with `Intl.DateTimeFormat`',
    );
  });

  it('the retired ISO-response sentence is gone from the normative artifacts', () => {
    // The exact retired phrase — quoted verbatim in D-183/tasks/CHANGELOG as
    // history, but normative text may no longer state it.
    for (const file of ['plan/SPECIFICATION.md', 'src/util/clock.ts']) {
      expect(
        readNormalized(file).includes('API timestamps use ISO 8601 UTC'),
        `${file}: the retired claim must not return — revisiting the representation is a ` +
          'successor decision to D-183, and this pin updates in that same change',
      ).toBe(false);
    }
  });

  it('the corrected docblocks no longer claim toUtcIso API serialization', () => {
    // The per-artifact retired claims D-183 corrected: the util README named
    // the §13 endpoints as `toUtcIso` serializers and called `toUtcIso` "the
    // API timestamp format", the rolling-ranges docblock said its bounds are
    // "ready to serialize" for the endpoints, and the CLI renderer justified
    // its stamps with §10's ISO clause. Restoring any of them must fail here.
    const retiredClaims: ReadonlyArray<readonly [file: string, claim: string]> = [
      ['src/util/README.md', 'via `toUtcIso`'],
      ['src/util/README.md', 'the API timestamp format of spec §10'],
      ['src/util/rolling-ranges.ts', 'ready to serialize with `toUtcIso`'],
      ['src/cli/raw-diagnostics.ts', "§10's ISO 8601 UTC"],
    ];
    for (const [file, claim] of retiredClaims) {
      expect(
        readNormalized(file).includes(normalize(claim)),
        `${file}: the retired claim '${claim}' must not return — the endpoints only ever ` +
          'parse ISO boundaries through epochMsFromIso, and toUtcIso serves CLI rendering ' +
          '(D-183)',
      ).toBe(false);
    }
  });

  it('the spec header carries the 1.2 version and the §10 amendment line', () => {
    const spec = readNormalized('plan/SPECIFICATION.md');
    expect(spec).toContain('**Document version:** 1.2 (supersedes 1.1)');
    expect(spec, 'the amendment names its section and decision').toContain(
      '§10 API timestamp representation',
    );
    expect(spec, 'the 1.1 amendment trail is preserved').toContain(
      'Earlier amendments (1.1, 6 November 2026)',
    );
  });

  it('DECISIONS.md carries D-183 as the successor to D-139', () => {
    const entry = decisionEntry('D-183');
    expect(entry).toContain('epoch-millisecond response integers');
    expect(
      entry,
      'the successor trail: D-139 is the recorded split D-183 amends into the spec',
    ).toContain('D-139');
    expect(entry).toContain('§10');
    // The superseded D-068 note stays verbatim — DECISIONS entries are
    // immutable, so D-183's supersession is the only correction channel.
    expect(decisionEntry('D-068')).toContain('serialize these bounds with `toUtcIso`');
  });

  it('the published reading guide still states the epoch-ms response rule', () => {
    expect(readNormalized('docs/api.md')).toContain('response timestamps are epoch milliseconds');
  });

  it('`toUtcIso` is documented for its real consumer, not the API', () => {
    const clock = readNormalized('src/util/clock.ts');
    expect(clock, 'the docblock names the CLI stdout rendering role').toContain('CLI output');
    expect(clock, 'the docblock cites the decision of record').toContain('D-183');
  });
});
