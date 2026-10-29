#!/usr/bin/env node
/**
 * npm tarball content check (spec §4.4, §17.2).
 *
 * Runs `npm pack --dry-run` and compares the packed file list against the
 * intended allowlist: tests, fixtures, local configuration, plans, docs
 * beyond the README, and development artifacts must never ship. Fails with
 * the list of unexpected entries when the package would leak something.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Exact entries allowed in the tarball. `npm` always adds `package.json`
 * and the README automatically; LICENSE/NOTICE are listed here and packed
 * once they exist (they are §18 deliverables of the plan). The published
 * JSON Schema (task 062, D-015) is listed and required: it is committed,
 * so a tarball without it means the allowlist stopped matching reality.
 */
const ALLOWED = [
  'package.json',
  'README.md',
  'bin/quotameter.mjs',
  'schema/config.schema.json',
  'LICENSE',
  'NOTICE',
];

const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
const packed = JSON.parse(stdout)
  .flatMap((entry) => entry.files.map((file) => file.path))
  .filter((path) => path !== 'package'); // npm's root directory marker

const unexpected = packed.filter((path) => !ALLOWED.includes(path));
const missingRequired = ['package.json', 'bin/quotameter.mjs', 'schema/config.schema.json'].filter(
  (path) => !packed.includes(path),
);

console.log(`packed entries: ${packed.join(', ') || '(none)'}`);

let failed = false;
if (unexpected.length > 0) {
  failed = true;
  console.error(`\nUNEXPECTED entries in the tarball:\n  ${unexpected.join('\n  ')}`);
}
if (missingRequired.length > 0) {
  failed = true;
  console.error(`\nREQUIRED entries missing from the tarball:\n  ${missingRequired.join('\n  ')}`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!pkg.bin?.quotameter) {
  failed = true;
  console.error('\npackage.json must declare the `quotameter` bin entry.');
}

if (failed) {
  console.error(
    '\nThe tarball allowlist lives in scripts/check-package.mjs. ' +
      'Extend it only with files that belong in the published package.',
  );
  process.exit(1);
}
console.log('\ntarball contents match the allowlist');
