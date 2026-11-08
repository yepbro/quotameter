import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_EXACT } from '../../scripts/check-package.mjs';

/**
 * The license and attribution guard (task 191, spec §4.3, §18; decision
 * D-201 — the review that closed D-007's "pending provenance verification").
 *
 * Task 191's done-condition — "all copied code and dependency notices have
 * been reviewed" — lands as four executable layers:
 *
 *  1. the repository's own license METADATA cannot rot: LICENSE is pinned
 *     byte-exact to the canonical MIT text with the §4.3 copyright holder,
 *     NOTICE keeps the §4.3 attribution set (the prototype author, the
 *     LICENSE pointer, the D-007 provenance rule, the license-report
 *     pointer) and the embedded-libraries section, and package.json keeps
 *     `license: MIT`, the author attribution, and the license set in the
 *     shipped `files`;
 *  2. the dependency closure stays inside the license gate's allowlist —
 *     every license atom of every package in package-lock.json (both
 *     scopes, installed or not) must be approved by the REAL allowlist of
 *     scripts/check-licenses.mjs, every allowlist entry must be earned
 *     by at least one package (D-201: entries arrive with the dependency
 *     that needs them, never before), and the copyleft/data licenses that
 *     are acceptable only while development-scoped (MPL-2.0, the CC-BY
 *     data licenses, Apache-2.0 per the allowlist's own comment) are
 *     pinned OUT of the production closure;
 *  3. the shipped web UI bundle's embedded third-party code is attributed:
 *     the ui/dist artifact redistributes minified copies of libraries that
 *     are dev-scoped in the manifest (so license-checker's production
 *     report never lists them) — NOTICE's "Embedded third-party
 *     libraries" section names them, the full license texts those
 *     licenses require for object-form redistribution ship in
 *     THIRD-PARTY-NOTICES, and this spec checks both against the real UI
 *     dependency closure and the curated embedded-runtime set;
 *  4. the closure fence: no copyleft, data, or unknown license (and no
 *     missing lockfile license field) may enter the UI closure.
 *
 * The closure walk is a documented OVER-APPROXIMATION of the browser
 * bundle: it follows every `dependencies`/`optionalDependencies`/required
 * peer edge npm-style, which drags in build-time-only tail (the Vue
 * compiler stack and vue-router's tooling dependencies that Vite executes
 * at build time but never emits). Over-approximation is the safe direction
 * for a fence. The attribution layer is therefore anchored to the curated
 * EMBEDDED_RUNTIME set below — the packages that actually ship in the
 * bundle — which the review round added after demonstrating that root
 * imports alone let the zrender attribution be deleted silently.
 *
 * The import extractor is deliberately lexical (regex over stripped
 * sources), not a parser: it recognizes `from` clauses, dynamic
 * `import('…')`, side-effect `import '…'`, and CSS `@import`, and it FAILS
 * CLOSED on a non-literal dynamic `import(…)`, whose target no static
 * reader can resolve. Residual, documented: specifiers inside multi-line
 * strings after a line starting `//` can be missed (the dangerous
 * direction) only when such a string opens on a comment-looking line;
 * commented-out markup in Vue templates (`<!-- import … -->`) produces
 * harmless false positives (the safe direction).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LICENSE = readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8');
const NOTICE = readFileSync(path.join(REPO_ROOT, 'NOTICE'), 'utf8');
const THIRD_PARTY = readFileSync(path.join(REPO_ROOT, 'THIRD-PARTY-NOTICES'), 'utf8');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-licenses.mjs');
const MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  license: string;
  author: string;
  files: string[];
  dependencies: Record<string, string>;
};

/** The §4.3 copyright holder pinned into LICENSE, NOTICE, and the manifest. */
const COPYRIGHT_HOLDER = 'Den Brooks';
const COPYRIGHT_EMAIL = 'denis@yepbro.pro';

/** The canonical MIT text (opensource.org) with this project's line wrapping. */
const CANONICAL_MIT = `MIT License

Copyright (c) 2026 ${COPYRIGHT_HOLDER}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * The echarts Apache NOTICE, complete — Apache-2.0 §4(d) requires
 * redistributors of a work whose NOTICE file they ship to retain its text.
 */
const APACHE_ECHARTS_NOTICE = `Apache ECharts
Copyright 2017-2026 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).`;

/**
 * The embedded runtime set: the third-party packages whose minified code
 * ships inside the ui/dist bundle (directly imported by ui/src or pulled in
 * as their runtime dependency — zrender and tslib ride along inside echarts,
 * the runtime subpackages inside their top-level libraries). This is the
 * curated shipping set the attribution must cover completely; the closure
 * walk below stays the over-approximated fence.
 */
const EMBEDDED_RUNTIME: ReadonlyArray<{ name: string; copyrights: string[] }> = [
  { name: 'echarts', copyrights: ['Copyright 2017-2026 The Apache Software Foundation'] },
  { name: 'zrender', copyrights: ['Copyright (c) 2017, Baidu Inc.'] },
  { name: 'vue', copyrights: ['Copyright (c) 2018-present, Yuxi (Evan) You'] },
  { name: '@vue/reactivity', copyrights: ['Copyright (c) 2018-present, Yuxi (Evan) You'] },
  { name: '@vue/runtime-core', copyrights: ['Copyright (c) 2018-present, Yuxi (Evan) You'] },
  { name: '@vue/runtime-dom', copyrights: ['Copyright (c) 2018-present, Yuxi (Evan) You'] },
  { name: '@vue/shared', copyrights: ['Copyright (c) 2018-present, Yuxi (Evan) You'] },
  {
    name: '@vue/devtools-api',
    copyrights: ['Copyright (c) 2023 webfansplz', 'Copyright (c) Guillaume Chau'],
  },
  { name: '@vue/devtools-kit', copyrights: ['Copyright (c) 2023 webfansplz'] },
  { name: '@vue/devtools-shared', copyrights: ['Copyright (c) 2023 webfansplz'] },
  {
    name: 'vue-router',
    copyrights: ['Copyright (c) 2019-present Eduardo San Martin Morote'],
  },
  { name: 'vue-i18n', copyrights: ['Copyright (c) 2020 kazuya kawaguchi'] },
  { name: '@intlify/core-base', copyrights: ['Copyright (c) 2020 kazuya kawaguchi'] },
  { name: '@intlify/devtools-types', copyrights: ['Copyright (c) 2024 kazuya kawaguchi'] },
  { name: '@intlify/message-compiler', copyrights: ['Copyright (c) 2020 kazuya kawaguchi'] },
  { name: '@intlify/shared', copyrights: ['Copyright (c) 2020 kazuya kawaguchi'] },
  { name: 'tslib', copyrights: ['Copyright (c) Microsoft Corporation.'] },
];

/**
 * Licenses that may lawfully sit inside the shipped UI bundle: the
 * permissive family only (D-201). Copyleft (MPL-*, GPL family), data
 * licenses (CC-BY-*), UNKNOWN, UNLICENSED, and a missing license field all
 * fail the fence — embedding such code in an MIT-licensed distribution is
 * a successor decision, never a silent pass.
 */
const PERMISSIVE_EMBEDDABLE = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Apache-2.0',
]);

/**
 * Licenses accepted only while they stay development-scoped (the
 * check-licenses.mjs allowlist comments name Apache-2.0 and MPL-2.0 exactly
 * this way; the data licenses join them). An atom from this set inside the
 * PRODUCTION closure is a successor decision, so the guard fails instead of
 * trusting the census to stay true.
 */
const DEVELOPMENT_ONLY_LICENSES = new Set(['Apache-2.0', 'MPL-2.0', 'CC-BY-3.0', 'CC-BY-4.0']);

/* ------------------------------------------------------------------ *
 * The license gate's real code, extracted and executed (the D-155
 * pattern: the script has top-level side effects, so it cannot be
 * imported — cutting its own functions out of the source keeps this spec
 * on the real logic, never a spec-local mirror that could drift).
 * ------------------------------------------------------------------ */

function scriptSource(): string {
  return readFileSync(SCRIPT_PATH, 'utf8');
}

/** The real `ALLOWED` set built from the script's own literal. */
function allowedSet(): Set<string> {
  const [, body] = /const ALLOWED = new Set\(\[([\s\S]*?)\]\);/.exec(scriptSource()) ?? [];
  if (body === undefined) {
    throw new Error(
      'scripts/check-licenses.mjs lost its `const ALLOWED = new Set([...])` allowlist — ' +
        'the license gate cannot run without it; restore the literal or update this guard ' +
        'together with the new mechanism (decision D-201)',
    );
  }
  const entries = new Function(`return [${body}];`)() as string[];
  return new Set(entries);
}

/** The script's own `atomicLicenses`, cut out of the source and compiled. */
function extractedAtomicLicenses(): (licenses: string[]) => string[] {
  const declaration = /function atomicLicenses\(licenses\) \{[\s\S]*?\n\}/.exec(scriptSource());
  if (declaration === null) {
    throw new Error(
      'scripts/check-licenses.mjs lost its `function atomicLicenses(licenses)` helper — ' +
        'compound SPDX expressions could then dodge the gate; restore it or update this ' +
        'guard together with the new mechanism (decision D-201)',
    );
  }
  const factory = new Function(`return (${declaration[0]});`) as () => (
    licenses: string[],
  ) => string[];
  return factory();
}

/* ------------------------------------------------------------------ *
 * The dependency closure, walked npm-style from package-lock.json (the
 * install-time-build.spec.ts resolution rules).
 * ------------------------------------------------------------------ */

interface LockPackage {
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Lockfile {
  packages: Record<string, LockPackage | undefined>;
}

const LOCKFILE = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
) as Lockfile;

/** npm-style resolution of a dependency name against the parent chain. */
function resolveLockKey(name: string, fromKey: string): string | undefined {
  let dir = fromKey;
  for (;;) {
    const candidate = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (candidate in LOCKFILE.packages) return candidate;
    if (dir === '') return undefined;
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut === -1 ? '' : dir.slice(0, cut);
  }
}

/** The package name of a lockfile key: the path after the last `node_modules/`. */
function baseName(lockKey: string): string {
  return lockKey.slice(lockKey.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** Breadth-first closure over the edges npm follows on an install. */
function closureOf(rootNames: string[]): Map<string, LockPackage> {
  const seen = new Map<string, LockPackage>();
  const queue: Array<[name: string, from: string]> = [];
  for (const name of rootNames) queue.push([name, '']);
  while (queue.length > 0) {
    const [name, from] = queue.shift()!;
    const key = resolveLockKey(name, from);
    if (key === undefined) {
      throw new Error(
        `bare import '${name}' resolves to no package-lock.json entry — every library the ` +
          'UI compiles against must be a declared dependency; update this guard together ' +
          'with the manifest change',
      );
    }
    if (seen.has(key)) continue;
    const entry = LOCKFILE.packages[key];
    if (entry === undefined) continue;
    seen.set(key, entry);
    const edges = [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}).filter(
        (peer) => entry.peerDependenciesMeta?.[peer]?.optional !== true,
      ),
    ];
    queue.push(...edges.map((dep) => [dep, key] as [string, string]));
  }
  return seen;
}

/** True when `lockKey`'s package is known under the given name in the closure. */
const closureHas = (closure: Map<string, LockPackage>, name: string): boolean =>
  [...closure.keys()].some((key) => baseName(key) === name);

/* ------------------------------------------------------------------ *
 * The libraries the UI source actually imports (the closure roots).
 * ------------------------------------------------------------------ */

const UI_SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|jsx|vue|css)$/;

/** Strips block comments and whole-line `//` comments from a source. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Reduces an import specifier to its package name (`echarts/core` → `echarts`). */
function packageNameOfSpecifier(specifier: string): string | undefined {
  if (/^[.#]/.test(specifier) || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
}

/**
 * Every bare specifier referenced from `ui/src`: `from '…'` clauses,
 * dynamic `import('…')` calls, side-effect `import '…'` statements, and
 * CSS `@import '…'`. A dynamic `import(…)` whose argument is not a string
 * literal fails closed — its target cannot be resolved statically, and a
 * silent skip would be a hole in the fence.
 */
function uiImportRoots(): Set<string> {
  const roots = new Set<string>();
  const files = readdirSync(path.join(REPO_ROOT, 'ui', 'src'), {
    recursive: true,
    encoding: 'utf8',
  }).filter((file) => UI_SOURCE_EXTENSIONS.test(file));
  if (files.length === 0) {
    throw new Error(
      'no UI sources found under ui/src — the extractor cannot see the UI dependency roots',
    );
  }
  for (const file of files) {
    const source = stripComments(readFileSync(path.join(REPO_ROOT, 'ui', 'src', file), 'utf8'));
    const specifiers = [
      ...source.matchAll(/(?:from\s*|import\()\s*['"`]([^'"`]+)['"`]/g),
      ...source.matchAll(/^\s*import\s*['"`]([^'"`]+)['"`]/gm),
      ...source.matchAll(/@import\s+['"`]([^'"`]+)['"`]/g),
    ];
    for (const match of specifiers) {
      const name = packageNameOfSpecifier(match[1]!);
      if (name !== undefined) roots.add(name);
    }
    for (const dynamic of source.matchAll(/\bimport\s*\(/g)) {
      const rest = source.slice(dynamic.index! + dynamic[0].length).replace(/^[ \t\n]+/, '');
      if (!/^['"`]/.test(rest)) {
        throw new Error(
          `ui/src/${file} uses a dynamic import with a non-literal argument — this guard ` +
            'cannot resolve which package it loads, so the license fence would have a hole; ' +
            'use a literal specifier or update this guard together with the change',
        );
      }
    }
  }
  return roots;
}

/** The UI dependency closure from the real import roots (over-approximated). */
const UI_CLOSURE = closureOf([...uiImportRoots()]);

/** The production dependency closure from the manifest's runtime dependencies. */
const PROD_CLOSURE = closureOf(Object.keys(MANIFEST.dependencies));

const licenseAtoms = extractedAtomicLicenses();
const atomsOf = (entry: LockPackage): string[] => licenseAtoms([entry.license ?? 'UNKNOWN']);

/* ------------------------------------------------------------------ *
 * NOTICE's embedded-libraries section.
 * ------------------------------------------------------------------ */

interface EmbeddedEntry {
  label: string;
  names: string[];
  spdx: string;
}

/**
 * Parses the `- Label (names) — SPDX` lines of NOTICE's "Embedded
 * third-party libraries" section. A name is an exact package name
 * (`echarts`) or a scoped family prefix (`@vue/*`); lists may wrap across
 * lines.
 */
function embeddedEntries(): EmbeddedEntry[] {
  return [...NOTICE.matchAll(/^- (.+?) \(([^)]+)\) — ([A-Za-z0-9.-]+)\b/gm)].map((match) => ({
    label: match[1]!,
    names: match[2]!.split(',').map((name) => name.trim()),
    spdx: match[3]!,
  }));
}

/** Closure keys an entry covers: exact names plus family prefixes. */
function packagesOfEntry(entry: EmbeddedEntry): string[] {
  return [...UI_CLOSURE.keys()].filter((key) =>
    entry.names.some((name) => {
      const base = baseName(key);
      return name.endsWith('/*') ? base.startsWith(name.slice(0, -1)) : base === name;
    }),
  );
}

/** NOTICE's retained Apache NOTICE block, de-indented to its verbatim text. */
function retainedApacheNotice(): string {
  const match = /Retained NOTICE text:\n\n([\s\S]*?)\n\n(?=- )/.exec(NOTICE);
  if (match === null) {
    throw new Error(
      'NOTICE lost its "Retained NOTICE text:" block for Apache ECharts — Apache-2.0 ' +
        '§4(d) obliges the redistributor to retain it; restore the block (decision D-201)',
    );
  }
  return match[1]!
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n');
}

/** Coverage test for a package name against the NOTICE entries. */
const coveredByEntry = (name: string): boolean =>
  embeddedEntries().some((entry) =>
    entry.names.some((candidate) =>
      candidate.endsWith('/*') ? name.startsWith(candidate.slice(0, -1)) : name === candidate,
    ),
  );

describe('LICENSE (task 191, spec §4.3; decision D-201)', () => {
  it('is the canonical MIT text with the pinned copyright holder', () => {
    expect(
      LICENSE,
      'LICENSE must stay byte-exact canonical MIT with the §4.3 copyright holder — ' +
        'any edit (holder, year, wording, rewrapping) is a decision-requiring change; ' +
        'update CANONICAL_MIT in the same change with the D-201 successor recorded',
    ).toBe(CANONICAL_MIT);
  });
});

describe('NOTICE (task 191, spec §4.3, §18; decision D-201)', () => {
  it('carries the §4.3 attribution set', () => {
    expect(NOTICE).toContain('Quotameter');
    expect(NOTICE).toContain(`Copyright (c) 2026 ${COPYRIGHT_HOLDER} <${COPYRIGHT_EMAIL}>`);
    expect(NOTICE).toContain('MIT License');
    expect(NOTICE).toContain('LICENSE file');
    expect(
      NOTICE,
      'NOTICE must attribute the original prototype author with the §4.3 contact',
    ).toContain(`prototype by ${COPYRIGHT_HOLDER}`);
    expect(NOTICE).toContain(COPYRIGHT_EMAIL);
    expect(
      NOTICE,
      'NOTICE must keep the D-007 provenance rule — no prototype code without verified ' +
        'provenance and license compatibility (the rule D-201 verified as satisfied today)',
    ).toContain('D-007');
    expect(
      NOTICE,
      'NOTICE must keep the pointer to the generated dependency license report',
    ).toContain('npm run license:check');
    expect(NOTICE).toContain('scripts/check-licenses.mjs');
  });

  it('retains the complete Apache ECharts NOTICE text (Apache-2.0 §4(d))', () => {
    // echarts ships an Apache NOTICE file; redistributing its code inside
    // the ui/dist bundle obliges us to carry that notice text forward —
    // completely, including its title line.
    expect(
      retainedApacheNotice(),
      'the retained NOTICE block must be the complete Apache ECharts notice text — ' +
        'a partial retention does not satisfy Apache-2.0 §4(d)',
    ).toBe(APACHE_ECHARTS_NOTICE);
    expect(THIRD_PARTY).toContain(APACHE_ECHARTS_NOTICE);
  });

  it('names an embedded-libraries entry for every ui/src bare-import library', () => {
    const entries = embeddedEntries();
    expect(entries.length, 'the embedded-libraries section is missing').toBeGreaterThan(0);
    for (const root of uiImportRoots()) {
      expect(
        coveredByEntry(root),
        `ui/src imports '${root}', whose minified copy ships inside the ui/dist bundle — ` +
          'name it in NOTICE\'s "Embedded third-party libraries" section together with ' +
          'its license id (decision D-201)',
      ).toBe(true);
    }
  });

  it('attributes the full curated embedded runtime set, not just the import roots', () => {
    // The review round's demonstration: the roots-only pin let the zrender
    // attribution (echarts' runtime dependency, never imported by ui/src)
    // be deleted with every test green. The shipping set is pinned here.
    for (const { name } of EMBEDDED_RUNTIME) {
      expect(
        closureHas(UI_CLOSURE, name),
        `'${name}' is curated as embedded but absent from the UI dependency closure — the ` +
          'entry went fictional after a dependency change; update EMBEDDED_RUNTIME, NOTICE, ' +
          'and THIRD-PARTY-NOTICES together (decision D-201)',
      ).toBe(true);
      expect(
        coveredByEntry(name),
        `'${name}' ships inside the ui/dist bundle but no NOTICE embedded-libraries entry ` +
          'names it — transitive embedded libraries are attribution-relevant too (the ' +
          'review round zrender finding; decision D-201)',
      ).toBe(true);
    }
  });

  it('matches the real UI closure: no fiction, exact license ids', () => {
    for (const entry of embeddedEntries()) {
      const matched = packagesOfEntry(entry);
      expect(
        matched.length > 0,
        `NOTICE embedded entry '${entry.label}' (${entry.names.join(', ')}) matches no ` +
          'package in the UI dependency closure — the entry is fiction or the dependency ' +
          'moved; update NOTICE (decision D-201)',
      ).toBe(true);
      for (const key of matched) {
        expect(
          atomsOf(LOCKFILE.packages[key]!),
          `NOTICE states '${entry.label}' is ${entry.spdx}, but the closure package at ` +
            `'${key}' is licensed differently — keep NOTICE and the dependency in agreement ` +
            '(decision D-201)',
        ).toEqual([entry.spdx]);
      }
    }
  });

  it('fences the UI closure: permissive licenses only, every license known', () => {
    const offenders: string[] = [];
    for (const [key, entry] of UI_CLOSURE) {
      if (entry.license === undefined) {
        offenders.push(`${key}: no license field in package-lock.json`);
        continue;
      }
      for (const atom of atomsOf(entry)) {
        if (!PERMISSIVE_EMBEDDABLE.has(atom)) offenders.push(`${key}: ${atom}`);
      }
    }
    expect(
      offenders,
      'Copyleft, data, or unknown licenses inside the UI dependency closure — embedding ' +
        'such code in the MIT-licensed ui/dist bundle is a successor decision (D-201), ' +
        'never a silent pass; review the dependency and either replace it or record the ' +
        'decision plus the NOTICE attribution',
    ).toEqual([]);
  });
});

describe('THIRD-PARTY-NOTICES (task 191, spec §4.3; decision D-201)', () => {
  it('ships with the package and the tarball allowlist knows it', () => {
    expect(
      MANIFEST.files,
      'THIRD-PARTY-NOTICES must ship in the tarball — the embedded licenses require ' +
        'their texts to accompany object-form redistribution (the review round P1)',
    ).toContain('THIRD-PARTY-NOTICES');
    expect(
      ALLOWED_EXACT,
      "scripts/check-package.mjs's ALLOWED_EXACT must list THIRD-PARTY-NOTICES in the " +
        'same change as the manifest files entry (the D-194 agreement pin)',
    ).toContain('THIRD-PARTY-NOTICES');
  });

  it('carries the full license texts the embedded licenses require', () => {
    // Apache-2.0 §4.1: a copy of the License with every distribution in
    // object form. BSD-3: the conditions and disclaimer reproduced with
    // redistributions. MIT: the permission notice. 0BSD: the notice (no
    // obligation, listed for completeness).
    expect(THIRD_PARTY).toContain('Apache ECharts (echarts) — Apache License 2.0');
    expect(THIRD_PARTY).toContain('Apache License');
    expect(THIRD_PARTY).toContain('Version 2.0, January 2004');
    expect(THIRD_PARTY).toContain('ZRender (zrender) — BSD 3-Clause License');
    expect(THIRD_PARTY).toContain('Redistribution and use in source and binary forms');
    expect(THIRD_PARTY).toContain(
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
    );
    expect(THIRD_PARTY).toContain('Permission is hereby granted, free of charge');
    expect(THIRD_PARTY).toContain('tslib — Zero-Clause BSD (0BSD)');
    expect(THIRD_PARTY).toContain(
      'Permission to use, copy, modify, and/or distribute this software for any',
    );
  });

  it('lists every embedded runtime package with its copyright line', () => {
    for (const { name, copyrights } of EMBEDDED_RUNTIME) {
      expect(
        THIRD_PARTY.includes(name),
        `THIRD-PARTY-NOTICES must name '${name}' — it ships inside the ui/dist bundle`,
      ).toBe(true);
      for (const line of copyrights) {
        expect(
          THIRD_PARTY,
          `THIRD-PARTY-NOTICES must carry the copyright notice of '${name}' verbatim ` +
            '(sourced from the package LICENSE/manifest; D-201)',
        ).toContain(line);
      }
    }
  });
});

describe('license gate allowlist vs dependency closure (task 191; decision D-201)', () => {
  const lockEntries = Object.entries(LOCKFILE.packages).filter(([key]) => key !== '');

  it("every lockfile license atom is approved by the script's real ALLOWED set", () => {
    const allowed = allowedSet();
    const offenders: string[] = [];
    for (const [key, entry] of lockEntries) {
      if (entry === undefined) continue;
      if (entry.license === undefined) {
        offenders.push(`${key}: no license field in package-lock.json`);
        continue;
      }
      for (const atom of licenseAtoms([entry.license])) {
        if (!allowed.has(atom)) offenders.push(`${key}: ${atom}`);
      }
    }
    expect(
      offenders,
      'Packages outside the allowlist (any scope, installed or not) — review each license ' +
        'and either extend ALLOWED in scripts/check-licenses.mjs with justification or ' +
        'replace the dependency (decisions D-007, D-201)',
    ).toEqual([]);
  });

  it('every allowlist entry is earned by a package in the lockfile', () => {
    const used = new Set(
      lockEntries.flatMap(([, entry]) => (entry?.license ? atomsOf(entry) : [])),
    );
    const unused = [...allowedSet()].filter((id) => !used.has(id));
    expect(
      unused,
      'ALLOWED entries with no package behind them — D-201: entries are earned by the ' +
        'closure and arrive with the dependency that needs them, never before; remove the ' +
        'entry or add it together with its dependency',
    ).toEqual([]);
  });

  it('keeps the development-only licenses out of the production closure', () => {
    const offenders: string[] = [];
    for (const [key, entry] of PROD_CLOSURE) {
      for (const atom of atomsOf(entry)) {
        if (DEVELOPMENT_ONLY_LICENSES.has(atom)) offenders.push(`${key}: ${atom}`);
      }
    }
    expect(
      offenders,
      'A development-only license (copyleft/data, or Apache-2.0 per the allowlist comment) ' +
        'entered the PRODUCTION closure — that arrival is a successor decision to D-201 ' +
        '(the allowlist comments say so; this pin keeps the census claim true); record the ' +
        'decision or replace the dependency',
    ).toEqual([]);
  });
});

describe('manifest license metadata (task 191, spec §4.3)', () => {
  it('package.json declares MIT with the §4.3 author attribution', () => {
    expect(MANIFEST.license).toBe('MIT');
    expect(MANIFEST.author).toBe(`${COPYRIGHT_HOLDER} <${COPYRIGHT_EMAIL}>`);
  });

  it('the license set ships with the package', () => {
    for (const entry of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES']) {
      expect(MANIFEST.files).toContain(entry);
    }
  });
});
