import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Composer } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import eslintConfig from '../../eslint.config';
import { en } from '../../ui/src/i18n/en';
import { createAppI18n } from '../../ui/src/i18n';

/**
 * Catalog completeness (spec §14.1; decisions D-131, D-132): every
 * user-facing string lives in the `en` catalog, the catalog carries
 * nothing dead, and the surfaces a text-node lint rule cannot see are
 * pinned here instead.
 *
 * The lint side (`@intlify/vue-i18n/no-raw-text`, re-tightened by this
 * task with no text exemptions and the `attributes` option; proven by
 * `test/unit/vue-i18n-lint.spec.ts` through the real ESLint binary)
 * catches raw text nodes and static attribute literals at authoring
 * time. This spec reads the component sources the same way a regression
 * would be written, so the two guards close every door together:
 *
 *   raw text node / static attribute   → lint (no-raw-text, no exceptions)
 *   missing/dead key                   → here, both directions
 *   dynamic t() key                    → here (static literals only, so the
 *                                        two directions above stay sound)
 *   bound static literal (:attr="'…'") → here (an expression to lint, a
 *                                        string to this scan)
 */

const UI_SOURCE_ROOT = join(process.cwd(), 'ui', 'src');

/**
 * User-facing attributes: rendered by the browser even though no text
 * node exists — the surface that motivated `no-raw-text`'s `attributes`
 * option (D-131's blind spot). A closed, text-bearing list: form values
 * (`value`) and ID references (`aria-labelledby`, `aria-describedby`, …)
 * are not labels and stay out. Kept in lockstep with the ESLint rule's
 * own list — the no-drift pin below fails if either side changes alone.
 */
const USER_FACING_ATTRIBUTES = [
  'abbr',
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
] as const;

/** A `t('dotted.key')` call with a static string literal argument. */
const T_LITERAL_PATTERN = /\bt\(\s*(['"])((?:[^\\'"\n]|\\.)*)\1/g;

/** Every `t(` opening, whatever follows — the dynamic-key detector
 * inspects the first non-space character after each match. */
const T_CALL_PATTERN = /\bt\(/g;

/** A static literal in a user-facing attribute (`title="Save"`). The
 * lookbehind excludes the bound (`:title="…"`, `v-bind:title="…"`) and
 * prefixed (`data-title="…"`) forms, where the value is an expression. */
const STATIC_ATTRIBUTE_PATTERN = new RegExp(
  `(?<![:\\w-])(${USER_FACING_ATTRIBUTES.join('|')})\\s*=\\s*(["'])([^"']*)\\2`,
  'g',
);

/** A bound attribute whose expression is exactly a string literal
 * (`:title="'Save'"`) — a static literal in disguise: lint sees an
 * expression, so this scan must catch it. */
const BOUND_LITERAL_ATTRIBUTE_PATTERN = new RegExp(
  `:(${USER_FACING_ATTRIBUTES.join('|')})\\s*=\\s*(["'])\\s*(['"])(.*?)\\3\\s*\\2`,
  'g',
);

/**
 * Strips comments quote-aware: block (`/* … *\/`), line (`// …`),
 * and HTML (`<!-- … -->`) prose would otherwise let documentation
 * mentions of `t('key')` fake usages (masking dead keys) or fake
 * dynamic lookups. Quotes are respected so `https://…` inside strings
 * and quoted attribute values survive (their `//` is not a comment) —
 * the reason a plain `//.*$` regex would corrupt templates and strings.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? '';
    if (char === undefined) break; // unreachable while the guard holds
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue; // drop the comment, keep the newline
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === '<' && source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      index = close === -1 ? source.length : close + 3;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += quote;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined) break; // unterminated quote: drop the rest
        if (current === '\\') {
          out += current + (source[index + 1] ?? '');
          index += 2;
          continue;
        }
        out += current;
        if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (/\.(?:ts|vue)$/u.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

const sourceFiles = listSourceFiles(UI_SOURCE_ROOT);
const sources = sourceFiles.map((path) => ({
  path: path.slice(UI_SOURCE_ROOT.length + 1),
  content: stripComments(readFileSync(path, 'utf8')),
}));

/** Flattens the catalog into `out`'s dot paths (`nav.overview` → value). */
function flattenCatalog(prefix: string, node: unknown, out: Record<string, string>): void {
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const dotPath = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      out[dotPath] = value;
    } else {
      flattenCatalog(dotPath, value, out);
    }
  }
}

const catalog: Record<string, string> = {};
flattenCatalog('', en, catalog);

/** Shape premise of the completeness rules: every leaf is a string, and
 * every namespace carries at least one leaf. (A non-string leaf would
 * silently vanish in `flattenCatalog` — `Object.entries(5)` is empty —
 * and an empty namespace would smuggle a "reserved" section past the
 * dead-key rule, so both are checked on the catalog object itself.) */
function assertCatalogShape(node: unknown, path: string): number {
  let leaves = 0;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const dotPath = path === '' ? key : `${path}.${key}`;
    if (typeof value === 'string') {
      leaves += 1;
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      expect.unreachable(`${dotPath} must be a string entry or a namespace`);
    }
    const nested = assertCatalogShape(value, dotPath);
    expect(nested, `${dotPath} is a namespace with no entries`).toBeGreaterThan(0);
    leaves += nested;
  }
  return leaves;
}

/** All `t('…')` keys referenced anywhere under `ui/src`, with locations. */
function collectUsedKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const { path, content } of sources) {
    for (const match of content.matchAll(T_LITERAL_PATTERN)) {
      const key = match[2];
      used.set(key, [...(used.get(key) ?? []), path]);
    }
  }
  return used;
}

/** The `<template>` markup of a `.vue` file: script and style blocks
 * stripped, so their strings (CSS selectors, code) cannot false-positive. */
function templateMarkupOf(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/gu, '')
    .replace(/<style[\s\S]*?<\/style>/gu, '');
}

/** The ESLint rule's `attributes` list for the catch-all (`.*`) tag pattern. */
function eslintAttributeList(): string[] {
  const scoped = eslintConfig.find((entry) => entry.plugins?.['@intlify/vue-i18n'] !== undefined);
  const rule = scoped?.rules?.['@intlify/vue-i18n/no-raw-text'] as
    [string, { attributes?: Record<string, string[]> }] | string | undefined;
  expect(Array.isArray(rule), 'no-raw-text configured as [level, options]').toBe(true);
  const options = Array.isArray(rule) ? rule[1] : undefined;
  return options?.attributes?.['/.*/'] ?? [];
}

describe('vue-i18n English catalog (spec §14.1)', () => {
  it('is a nested catalog of string leaves, with no empty namespaces', () => {
    expect(assertCatalogShape(en, '')).toBeGreaterThan(0);
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
    // The bootstrap strings the e2e contracts assert byte-exactly.
    expect(catalog['app.title']).toBe('Quotameter');
    // Task 172 replaced the overview's placeholder line with the §14.3
    // vocabulary; the honesty marker is the explicit-unknown string.
    expect(catalog['overview.metric.unknown']).toBe('Unknown');
    expect(catalog['overview.status.fresh']).toBe('Fresh');
  });

  it('every t() key used in ui/src exists in the catalog', () => {
    const used = collectUsedKeys();
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used.entries()]
      .filter(([key]) => !(key in catalog))
      .map(([key, paths]) => `${key} (used in ${[...new Set(paths)].join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('every catalog key is used by a t() call in ui/src (no dead keys)', () => {
    const used = collectUsedKeys();
    const dead = Object.keys(catalog).filter((key) => !used.has(key));
    expect(dead).toEqual([]);
  });

  it('uses static literal keys only — no dynamic t() lookups', () => {
    // A `t(variable)` call would be invisible to both directions above;
    // the catalog is small and static by design (D-132), so a dynamic
    // lookup is always a mistake to catch, not a pattern to allow.
    const dynamic: string[] = [];
    for (const { path, content } of sources) {
      for (const match of content.matchAll(T_CALL_PATTERN)) {
        const rest = content.slice((match.index ?? 0) + match[0].length);
        const trimmed = rest.trimStart();
        if (!['"', "'"].includes(trimmed[0] ?? '')) {
          dynamic.push(`${path}: t(…${trimmed.slice(0, 12)}…)`);
        }
      }
    }
    expect(dynamic).toEqual([]);
  });

  it('carries no static literals in user-facing attributes (D-131 blind spot)', () => {
    // Static literals are lint's half (the `attributes` option); this is
    // the test-side pin over the real components.
    const statics: string[] = [];
    for (const { path, content } of sources) {
      if (!path.endsWith('.vue')) continue;
      for (const match of templateMarkupOf(content).matchAll(STATIC_ATTRIBUTE_PATTERN)) {
        if (match[3].trim() !== '') {
          statics.push(`${path}: ${match[1]}="${match[3]}"`);
        }
      }
    }
    expect(statics).toEqual([]);
  });

  it('carries no bound attributes that are string literals in disguise', () => {
    // `:title="'Save'"` is an expression to the lint rule but a static
    // user-facing string to the reader — it must be `t('key')` instead.
    const disguised: string[] = [];
    for (const { path, content } of sources) {
      if (!path.endsWith('.vue')) continue;
      for (const match of templateMarkupOf(content).matchAll(BOUND_LITERAL_ATTRIBUTE_PATTERN)) {
        disguised.push(`${path}: :${match[1]}=…`);
      }
    }
    expect(disguised).toEqual([]);
  });

  it('pins the attribute list against the ESLint rule (no drift)', () => {
    // The lint config and this spec must forbid the same attribute set —
    // if one changes without the other, this pin fails.
    expect(eslintAttributeList()).toEqual([...USER_FACING_ATTRIBUTES]);
  });

  it('factory: Composition mode, English locale and fallback', () => {
    const i18n = createAppI18n();
    expect(i18n.mode).toBe('composition');
    const composer = i18n.global as Composer;
    expect(composer.locale.value).toBe('en');
    expect(composer.fallbackLocale.value).toBe('en');
  });

  it('factory: t() renders catalog strings verbatim', () => {
    const { t } = createAppI18n().global as Composer;
    // The whole pipeline over one key: lookup, no reformatting — the
    // rendered bytes stay identical to the catalog values, which is
    // what keeps the e2e contracts green unchanged.
    expect(t('app.title')).toBe('Quotameter');
    expect(t('nav.ariaLabel')).toBe('Primary');
    expect(t('overview.metric.unknown')).toBe(en.overview.metric.unknown);
    // Named parameters interpolate (the rolling-window phrase).
    expect(t('overview.metric.windowHours', { count: 5 })).toBe('5-hour window');
  });
});

/* ── Interpolation integrity and the whole-catalog render (task 182, D-165) ── */

/**
 * A named-interpolation placeholder of vue-i18n message format
 * (`{count}` in `'{count}-hour window'`).
 */
const PLACEHOLDER_PATTERN = /\{(\w+)\}/gu;

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!);
}

/** Every `t(` opening that carries a second argument (params or plural). */
const T_SECOND_ARG_PATTERN = /\bt\(\s*(['"])((?:[^\\'"\n]|\\.)*)\1\s*,/g;

/** Slices the balanced `{…}` block starting at `content[start] === '{'`. */
function balancedBlock(content: string, start: number): string {
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    else if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced object literal at offset ${start}`);
}

/** Splits an object literal's inner content on top-level commas. */
function topLevelSegments(inner: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') segments.push(current);
  return segments;
}

/** One `ui/src` file's comment-stripped content, by relative path. */
function sourceOf(path: string): string {
  const file = sources.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`unknown source file ${path}`);
  return file.content;
}

/**
 * Resolves the same-file `const <identifier> = { … }` initializer that is
 * in scope at `offset` — the NEAREST declaration before the call site,
 * so two same-named consts in different functions cannot credit a site
 * with the wrong member set — to its member names. The seam for param
 * objects built beside their call site (`stamps` in
 * AccountOverviewCard.vue today).
 */
function constObjectMembers(
  identifier: string,
  path: string,
  offset: number,
  depth: number,
): string[] {
  if (depth > 2) throw new Error(`spread chain too deep at ${path}: ${identifier}`);
  const source = sourceOf(path);
  const declaration = new RegExp(`const\\s+${identifier}\\s*=\\s*\\{`, 'g');
  let scoped: RegExpExecArray | null = null;
  for (let match = declaration.exec(source); match !== null; match = declaration.exec(source)) {
    if (match.index >= offset) break;
    scoped = match; // keep the nearest declaration before the call site
  }
  if (scoped === null) {
    throw new Error(
      `cannot resolve the param object '${identifier}' in ${path} (no declaration precedes the call site)`,
    );
  }
  return objectMembers(
    balancedBlock(source, scoped.index + scoped[0].length - 1),
    path,
    offset,
    depth + 1,
  );
}

/**
 * The member names of an object literal slice: `name:` pairs, shorthands,
 * and `...identifier` spreads resolved through their same-file
 * initializers. Anything else (computed keys, expressions) fails loudly —
 * the catalog's discipline is static, auditable call sites.
 */
function objectMembers(block: string, path: string, offset: number, depth: number): string[] {
  const inner = block.slice(1, -1);
  const names: string[] = [];
  for (const segment of topLevelSegments(inner)) {
    const member = segment.trim();
    if (member === '') continue;
    if (member.startsWith('...')) {
      const identifier = member.slice(3).trim();
      if (!/^\w+$/u.test(identifier)) {
        throw new Error(`unexpected spread shape at ${path}: ${member}`);
      }
      names.push(...constObjectMembers(identifier, path, offset, depth));
      continue;
    }
    const named = /^(\w+)\s*:/u.exec(member);
    if (named !== null) {
      names.push(named[1]!);
      continue;
    }
    if (/^\w+$/u.test(member)) {
      names.push(member); // shorthand
      continue;
    }
    throw new Error(`unexpected param member at ${path}: ${member}`);
  }
  return names;
}

/**
 * Parameterized keys rendered RAW — `t()` without params — and
 * interpolated by the chart builder's own template engine (`interpolate`
 * in `ui/src/charts/series.ts`; `MetricHistoryChart.vue` passes these
 * catalog values verbatim, because ECharts formatters compose strings,
 * not vue-i18n). Their substitution is behaviorally pinned in
 * `test/component/chart-series.spec.ts` (the composed tooltip lines);
 * this table pins each entry's placeholder-name set so renaming a
 * placeholder in the catalog fails HERE with a named key instead of
 * rendering literal braces inside a chart tooltip.
 */
const CHART_TEMPLATE_KEYS: Record<string, readonly string[]> = {
  'overview.chart.peakHead': ['name', 'multiplier'],
  'overview.chart.offPeakHead': ['multiplier'],
  'overview.chart.bandTimes': ['start', 'end', 'zone'],
  'overview.chart.gapBody': ['duration'],
  'overview.chart.stoppedBody': ['duration'],
  'overview.chart.resetTooltip': ['time'],
  'overview.chart.errorAttempts': ['count'],
  'overview.chart.errorStatus': ['status'],
  'overview.chart.errorRetryAfter': ['seconds'],
};

/**
 * One call site's param names, with its location for failure messages.
 */
interface SuppliedSite {
  readonly path: string;
  readonly names: ReadonlySet<string>;
}

/**
 * The param names EVERY of a catalog key's call sites supplies, keyed by
 * dot path — per site, not as a union, because a second site that
 * omits a placeholder would render literal braces on screen while a
 * union stayed green. Built once from the same comment-stripped sources
 * the key scans read, so a `t('key', { … })` shape the harvest cannot
 * parse fails the whole suite loudly (the dynamic-key discipline's
 * param-side twin).
 */
function collectSuppliedParams(): Map<string, SuppliedSite[]> {
  const supplied = new Map<string, SuppliedSite[]>();
  const failures: string[] = [];
  for (const { path, content } of sources) {
    for (const match of content.matchAll(T_SECOND_ARG_PATTERN)) {
      const key = match[2]!;
      const after = (match.index ?? 0) + match[0].length;
      const rest = content.slice(after).trimStart();
      let names: string[];
      if (rest.startsWith('{')) {
        names = objectMembers(balancedBlock(content, content.indexOf('{', after)), path, after, 0);
      } else {
        const identifier = /^(\w+)/u.exec(rest)?.[1];
        if (identifier === undefined) {
          failures.push(`${path}: t('${key}', …${rest.slice(0, 16)}…) — not an object literal`);
          continue;
        }
        names = constObjectMembers(identifier, path, after, 0);
      }
      supplied.set(key, [...(supplied.get(key) ?? []), { path, names: new Set(names) }]);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
  return supplied;
}

describe('vue-i18n interpolation integrity (task 182, D-165)', () => {
  const supplied = collectSuppliedParams();

  it('every placeholder is supplied at EVERY call site — and every supplied name is a placeholder', () => {
    // Per site, not per key: one complete site does not vouch for a
    // second, incomplete one — a site omitting a placeholder would
    // render literal braces on screen whatever its siblings pass.
    const problems: string[] = [];
    for (const [key, value] of Object.entries(catalog)) {
      const placeholders = placeholdersOf(value);
      const sites = supplied.get(key);
      if (sites === undefined) {
        if (placeholders.length === 0) continue; // no params needed
        if (key in CHART_TEMPLATE_KEYS) continue; // the chart builder seam
        problems.push(
          `${key}: carries {${placeholders.join('}, {')}} but no call site supplies them`,
        );
        continue;
      }
      for (const { path, names } of sites) {
        for (const placeholder of placeholders) {
          if (!names.has(placeholder)) {
            problems.push(
              `${path}: t('${key}') omits {${placeholder}} (got [${[...names].join(', ')}])`,
            );
          }
        }
        for (const name of names) {
          if (!placeholders.includes(name)) {
            problems.push(
              `${path}: t('${key}') passes '${name}' but the message carries no {${name}}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the chart-template seam table is closed and exact — no drift in either direction', () => {
    // Every allow-listed entry exists, is parameterized, renders raw (no
    // t() call site passes params for it), and names exactly the
    // placeholders the catalog carries; and every parameterized key with
    // no param-supplying call site is allow-listed (a new one joins this
    // table consciously, or the first test fails).
    const problems: string[] = [];
    for (const [key, expected] of Object.entries(CHART_TEMPLATE_KEYS)) {
      const value = catalog[key];
      if (value === undefined) {
        problems.push(`${key}: allow-listed but absent from the catalog`);
        continue;
      }
      const placeholders = placeholdersOf(value);
      if (placeholders.length === 0)
        problems.push(`${key}: allow-listed but carries no placeholders`);
      if (JSON.stringify(placeholders) !== JSON.stringify(expected)) {
        problems.push(
          `${key}: placeholders [${placeholders.join(', ')}] ≠ the pinned [${expected.join(', ')}]`,
        );
      }
      if (supplied.has(key)) problems.push(`${key}: allow-listed but a call site supplies params`);
    }
    for (const [key, value] of Object.entries(catalog)) {
      if (placeholdersOf(value).length === 0) continue;
      if (supplied.has(key) || key in CHART_TEMPLATE_KEYS) continue;
      problems.push(`${key}: parameterized, unsupplied, and not in the chart-template table`);
    }
    expect(problems).toEqual([]);
  });

  it('renders every key through the real composer — paramless verbatim, parameterized without residue', () => {
    // The runtime complement of the static scans: every message compiles
    // and resolves through the actual vue-i18n pipeline. Paramless keys
    // must render their value byte-for-byte (an accidental plural `|` or
    // linked-message `@` would compile to something else); a
    // parameterized key rendered with one synthetic marker per
    // placeholder must contain every marker and leave no literal `{`/`}`
    // behind — the exact failure a drifted placeholder would put on
    // screen.
    const { t } = createAppI18n().global as Composer;
    const problems: string[] = [];
    for (const [key, value] of Object.entries(catalog)) {
      const placeholders = placeholdersOf(value);
      if (placeholders.length === 0) {
        const rendered = t(key);
        if (rendered !== value) {
          problems.push(`${key}: rendered '${rendered}' ≠ catalog '${value}'`);
        }
        continue;
      }
      const params: Record<string, string> = {};
      for (const placeholder of placeholders) params[placeholder] = `⟨${placeholder}⟩`;
      const rendered = t(key, params);
      if (/[{}]/u.test(rendered)) {
        problems.push(`${key}: residual braces in '${rendered}'`);
      }
      for (const placeholder of placeholders) {
        if (!rendered.includes(`⟨${placeholder}⟩`)) {
          problems.push(`${key}: the {${placeholder}} marker did not render`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('comment stripping (the completeness scans’ premise)', () => {
  it('drops t(…) mentions in line, block, and HTML comments', () => {
    expect(stripComments("const a = 1; // uses t('ghost.key')\n")).not.toContain('ghost.key');
    expect(stripComments("/* t('ghost.key') */ const a = 1;")).not.toContain('ghost.key');
    expect(stripComments("<template><!-- t('ghost.key') --></template>")).not.toContain(
      'ghost.key',
    );
  });

  it('keeps string contents intact, including // inside URLs', () => {
    expect(stripComments("const url = 'https://example.com'; t('nav.x')")).toContain(
      'https://example.com',
    );
    expect(stripComments("const url = 'https://example.com'; t('nav.x')")).toContain("t('nav.x')");
    expect(stripComments('<a href="https://example.com">{{ t(\'nav.x\') }}</a>')).toContain(
      'https://example.com',
    );
  });

  it('keeps escaped quotes inside strings', () => {
    expect(stripComments(`const s = 'it\\'s'; t('nav.x')`)).toContain("t('nav.x')");
  });
});
