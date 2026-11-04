#!/usr/bin/env node
/**
 * Dependency license verification (spec §4.3, §4.4).
 *
 * Checks production and development dependency licenses against the
 * project's allowlist (MIT-licensed distribution, see DECISIONS.md D-007).
 * Reports are retained as text files under reports/ for review; the command
 * exits non-zero when a dependency is unapproved or its license is unknown.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Approved licenses. Anything else — including "UNKNOWN" and "(UNLICENSED)"
 * — must be reviewed and added here explicitly with a justification in the
 * pull request that introduces the dependency.
 */
const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'MPL-2.0',
  'MPL-2.0-no-copyleft-exception',
  // SPDX license-list data files (spdx-exceptions, spdx-ranges) carry
  // CC-BY-3.0 for the license text itself; content license, no code
  // obligations. Reviewed with task 043.
  'CC-BY-3.0',
]);

/**
 * The package name of a license-checker key: every package is reported as
 * `name@version`, and scoped names carry their own leading `@`
 * (`@scope/pkg@1.2.3`) — the name is everything before the LAST `@`. Keys
 * without a version part are returned unchanged.
 */
function packageNameOf(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

/** Normalizes the various shapes license-checker emits. */
function collectLicenses(json, excludeNames) {
  const findings = [];
  for (const [name, meta] of Object.entries(json)) {
    if (excludeNames.has(packageNameOf(name))) continue;
    const licenses = Array.isArray(meta.licenses) ? meta.licenses : [meta.licenses];
    findings.push({ name, licenses: licenses.map(String) });
  }
  return findings;
}

/**
 * Splits SPDX expressions (`(MIT AND CC-BY-3.0)`) into atomic license ids so
 * compound expressions are approved exactly when every component is.
 */
function atomicLicenses(licenses) {
  return licenses.flatMap((license) =>
    license
      .replace(/[()]/g, ' ')
      .split(/\s+(?:AND|OR|and|or)\s+/)
      .map((atom) => atom.trim())
      .filter(Boolean),
  );
}

function runChecker(args, excludeNames) {
  const bin = join(process.cwd(), 'node_modules', '.bin', 'license-checker');
  const stdout = execFileSync(bin, [...args, '--json'], { encoding: 'utf8' });
  return collectLicenses(JSON.parse(stdout), excludeNames);
}

// Container runs redirect reports into the isolated data volume (see
// compose.yaml) to avoid ownership conflicts with host-generated output.
const REPORTS_DIR = process.env.REPORTS_DIR ?? 'reports';

mkdirSync(REPORTS_DIR, { recursive: true });
// The repository package itself is not a dependency; license-checker reports
// it as UNLICENSED because the package is private. The exclusion matches by
// NAME, read from package.json at runtime (decision D-155, task U-032): the
// former version-qualified pin went stale at the first release version bump
// and failed the gate on the project's own package.
const SELF = new Set([
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name,
]);
const scopes = [
  { label: 'production', args: ['--production'] },
  { label: 'development', args: ['--development'] },
];

let failed = false;
const summaryLines = ['# License check summary', ''];

for (const scope of scopes) {
  const findings = runChecker(scope.args, SELF);
  const lines = findings.map((f) => `${f.name}: ${f.licenses.join(', ')}`).sort();
  writeFileSync(join(REPORTS_DIR, `licenses-${scope.label}.txt`), `${lines.join('\n')}\n`);

  const offenders = findings.filter((f) => atomicLicenses(f.licenses).some((l) => !ALLOWED.has(l)));
  summaryLines.push(
    `${scope.label}: ${findings.length} dependencies checked, ${offenders.length} unapproved`,
  );
  for (const offender of offenders) {
    failed = true;
    summaryLines.push(`  UNAPPROVED ${offender.name}: ${offender.licenses.join(', ')}`);
  }
}

console.log(summaryLines.join('\n'));
if (failed) {
  console.error(
    '\nUnapproved or unknown licenses found. Review the dependency; if it must ' +
      'stay, extend ALLOWED in scripts/check-licenses.mjs with justification.',
  );
  process.exit(1);
}
console.log('\nAll dependency licenses are approved. Reports written to reports/.');
