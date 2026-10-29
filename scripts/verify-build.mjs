#!/usr/bin/env node
/**
 * Build-artifact verification (spec §3, §17.2).
 *
 * Runs after the CI build step and fails when an expected artifact is
 * missing, so a silently broken build cannot pass. The manifest below is
 * the contract between the build scripts and CI; extend it when new build
 * outputs (server bundle, package tarball) become real.
 */
import { access } from 'node:fs/promises';
import { glob } from 'node:fs/promises'; // Node >= 22 supports fs.glob

// Container builds live in the isolated data volume (DIST_DIR, see
// compose.yaml); host and CI builds use the default ui/dist.
const BASE = process.env.DIST_DIR ?? 'ui/dist';

/** Each entry must exist after `npm run build` for the build to count. */
const REQUIRED_FILES = [`${BASE}/index.html`];

/** Each glob must match at least one file after the build. */
const REQUIRED_GLOBS = [
  // Vite output: at least one JS and one CSS bundle with hashed names.
  // (Sourcemaps are intentionally not produced for the shipped UI.)
  `${BASE}/assets/*.js`,
  `${BASE}/assets/*.css`,
];

const problems = [];

for (const file of REQUIRED_FILES) {
  try {
    await access(file);
  } catch {
    problems.push(`missing expected build artifact: ${file}`);
  }
}

for (const pattern of REQUIRED_GLOBS) {
  const matches = await glob(pattern);
  if (matches.length === 0) {
    problems.push(`build artifact glob matched nothing: ${pattern}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log('build artifacts verified: all expected outputs are present');
