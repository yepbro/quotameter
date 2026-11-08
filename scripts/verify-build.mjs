#!/usr/bin/env node
/**
 * Build-artifact verification (spec §3, §17.2; decisions D-127, D-129).
 *
 * Runs after the CI build steps and fails when an expected artifact is
 * missing, so a silently broken build cannot pass. The manifest below is
 * the contract between the build scripts and CI; extend it when new build
 * outputs (further package artifacts) become real. Since task 185 (D-195)
 * it covers both halves of the packaged product: the compiled CLI under
 * `dist/` (`npm run build:cli`, honored through CLI_DIST_DIR) beside the
 * web UI (`npm run build:ui`, DIST_DIR).
 *
 * Beyond existence, the built output's CSP shape is asserted (D-127):
 * the served policy (`script-src`/`style-src 'self'`, `img-src`/
 * `font-src 'self'` without `data:`) admits same-origin external
 * resources only — so a configuration or plugin regression that
 * reintroduces an inline script, a style attribute, or an inlined data
 * URI fails here, at every build, instead of surfacing as a browser CSP
 * violation in the e2e shell spec.
 */
import { access, glob, readFile } from 'node:fs/promises'; // Node >= 22 supports fs.glob

// Container builds live in the isolated data volume (DIST_DIR, see
// compose.yaml); host and CI builds use the default ui/dist. The compiled
// CLI follows the same pattern through CLI_DIST_DIR (task 185, D-195) —
// tests build into temp fixture roots, every other context uses dist/.
const UI_BASE = process.env.DIST_DIR ?? 'ui/dist';
const CLI_BASE = process.env.CLI_DIST_DIR ?? 'dist';

/** Each entry must exist after the build steps for the build to count. */
const REQUIRED_FILES = [`${UI_BASE}/index.html`, `${CLI_BASE}/cli/main.js`];

/** Each glob must match at least one file after the build. */
const REQUIRED_GLOBS = [
  // Vite output: at least one JS and one CSS bundle with hashed names.
  // (Sourcemaps are intentionally not produced for the shipping UI.)
  `${UI_BASE}/assets/*.js`,
  `${UI_BASE}/assets/*.css`,
  // tsc output: the compiled CLI island (the launcher resolves
  // dist/cli/main.js; the rest of the graph hangs off it transitively).
  `${CLI_BASE}/cli/*.js`,
];

/**
 * CSP shape patterns (D-127, D-129). Each matches a shape the served
 * policy blocks: an inline `<script>` (no `src`), a `<style>` block
 * (including the self-closing form), a `style=` attribute (quoted or
 * unquoted), an inline event handler, a `javascript:` URI, or an inlined
 * `data:` URI (MIME-anchored, so plain text starting with "data:" cannot
 * trip it). The `data:` pattern is applied to the emitted JavaScript
 * bundles as well as HTML and stylesheets — Vite's asset inlining lands
 * JS-imported assets inside the JS chunk, the exact regression that
 * `build.assetsInlineLimit: 0` exists to prevent. Stylesheets are
 * additionally checked for external `url()` references, which
 * `style-src 'self'` and §14.1's no-third-party rule both refuse.
 */
const INLINE_SCRIPT_PATTERN = /<script(?![^>]*\bsrc\s*=)[^>]*>/i;
const STYLE_BLOCK_PATTERN = /<style[\s/>]/i;
const STYLE_ATTRIBUTE_PATTERN = /(?:^|[\s"'])style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
const EVENT_HANDLER_PATTERN = /\bon[a-z]+\s*=\s*["']/i;
const JAVASCRIPT_URI_PATTERN = /(?:href|src)\s*=\s*["']\s*javascript:/i;
const DATA_URI_PATTERN = /data:(?:image|font|application|audio|video)\/[a-z0-9.+-]+/i;
const EXTERNAL_CSS_URL_PATTERN = /url\(\s*["']?(?:https?:)?\/\//i;

const problems = [];

/**
 * Materializes an fs.glob result. `node:fs/promises`' `glob` returns an
 * async iterable, not an array — a bare `.length` on it is `undefined`,
 * which silently disables any emptiness check (the bug this helper
 * removed: a missing-bundle build used to pass verification).
 */
async function globArray(pattern) {
  const matches = [];
  for await (const entry of glob(pattern)) matches.push(entry);
  return matches;
}

for (const file of REQUIRED_FILES) {
  try {
    await access(file);
  } catch {
    problems.push(`missing expected build artifact: ${file}`);
  }
}

for (const pattern of REQUIRED_GLOBS) {
  const matches = await globArray(pattern);
  if (matches.length === 0) {
    problems.push(`build artifact glob matched nothing: ${pattern}`);
  }
}

// Shape checks run whenever the file is readable — independent of the
// existence problems, which are already recorded above.
let indexHtml;
try {
  indexHtml = await readFile(`${UI_BASE}/index.html`, 'utf8');
} catch {
  indexHtml = undefined;
}

if (indexHtml !== undefined) {
  if (INLINE_SCRIPT_PATTERN.test(indexHtml)) {
    problems.push(
      `inline <script> without src in ${UI_BASE}/index.html — the served CSP blocks inline scripts (D-127)`,
    );
  }
  if (STYLE_BLOCK_PATTERN.test(indexHtml)) {
    problems.push(
      `inline <style> block in ${UI_BASE}/index.html — the served CSP blocks inline stylesheets (D-127)`,
    );
  }
  if (STYLE_ATTRIBUTE_PATTERN.test(indexHtml)) {
    problems.push(
      `style= attribute in ${UI_BASE}/index.html — the served CSP blocks inline style attributes (D-127)`,
    );
  }
  if (EVENT_HANDLER_PATTERN.test(indexHtml)) {
    problems.push(
      `inline event handler (on*=) in ${UI_BASE}/index.html — the served CSP blocks inline script attributes (D-127)`,
    );
  }
  if (JAVASCRIPT_URI_PATTERN.test(indexHtml)) {
    problems.push(
      `javascript: URI in ${UI_BASE}/index.html — the served CSP blocks inline scripts (D-127)`,
    );
  }
  if (DATA_URI_PATTERN.test(indexHtml)) {
    problems.push(
      `data: URI in ${UI_BASE}/index.html — the served CSP admits no data: sources (D-127)`,
    );
  }
}

// Stylesheets: inlined data: URIs and external url() references.
for (const cssFile of await globArray(`${UI_BASE}/assets/*.css`)) {
  const css = await readFile(cssFile, 'utf8');
  if (DATA_URI_PATTERN.test(css)) {
    problems.push(`data: URI in ${cssFile} — the served CSP admits no data: sources (D-127)`);
  }
  if (EXTERNAL_CSS_URL_PATTERN.test(css)) {
    problems.push(
      `external url() in ${cssFile} — the served CSP and §14.1 admit same-origin assets only (D-127)`,
    );
  }
}

// JavaScript bundles: Vite's asset inlining lands JS-imported assets here.
for (const jsFile of await globArray(`${UI_BASE}/assets/*.js`)) {
  const js = await readFile(jsFile, 'utf8');
  if (DATA_URI_PATTERN.test(js)) {
    problems.push(
      `data: URI in ${jsFile} — the served CSP admits no data: sources (D-127); ` +
        `check build.assetsInlineLimit`,
    );
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log('build artifacts verified: web UI present and CSP-clean, compiled CLI present');
