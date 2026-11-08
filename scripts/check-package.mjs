#!/usr/bin/env node
/**
 * npm tarball content check (spec §4.4, §17.2; tasks 052 and 184, D-194).
 *
 * Runs `npm pack --dry-run` and compares the packed file list against the
 * manifest's `files` allowlist: tests, fixtures, local configuration, plans,
 * docs beyond the README, and development artifacts must never ship. Fails
 * with the list of unexpected entries when the package would leak something.
 *
 * Two entry classes (task 184, D-194):
 *  - exact entries — single files (`bin/quotameter.mjs`, the published
 *    schema, the README, LICENSE, NOTICE);
 *  - prefix entries — `ui/dist/`, the prebuilt web UI the release workflow
 *    builds before packing (spec §3: no install-time build). npm lists each
 *    built file individually, so the prefix matches them all.
 *
 * The prefix class is allowed but not required: `npm pack` silently skips
 * allowlisted-but-missing paths (the LICENSE/NOTICE precedent), the CI
 * `package` job packs without building the UI, and dev-container builds go
 * to the data volume (`DIST_DIR`) — only the release pipeline (build →
 * check → publish, its step order pinned by test/unit/release-workflow.spec.ts)
 * produces a tarball that carries `ui/dist`.
 *
 * The lists are exported (consumed by test/unit/package-manifest.spec.ts,
 * which pins their agreement with the manifest's `files`) and the check runs
 * only when the script is invoked directly (render-mutation-report pattern).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Exact entries allowed in the tarball. `npm` always adds `package.json`
 * and the README automatically; LICENSE/NOTICE are listed here and packed
 * once they exist (they are §18 deliverables of the plan). The published
 * JSON Schema (task 062, D-015) is listed and required: it is committed,
 * so a tarball without it means the allowlist stopped matching reality.
 */
export const ALLOWED_EXACT = [
  'package.json',
  'README.md',
  'bin/quotameter.mjs',
  'schema/config.schema.json',
  'LICENSE',
  'NOTICE',
];

/**
 * Directory prefixes whose packed contents are allowed: the prebuilt UI of
 * the release build (task 184, D-194). Every packed entry starting with one
 * of these prefixes passes.
 */
export const ALLOWED_PREFIXES = ['ui/dist/'];

/** Entries that must be present in every packed tarball. */
export const REQUIRED_ENTRIES = ['package.json', 'bin/quotameter.mjs', 'schema/config.schema.json'];

function main() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  const packed = JSON.parse(stdout)
    .flatMap((entry) => entry.files.map((file) => file.path))
    .filter((path) => path !== 'package'); // npm's root directory marker

  const unexpected = packed.filter(
    (path) =>
      !ALLOWED_EXACT.includes(path) && !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  const missingRequired = REQUIRED_ENTRIES.filter((path) => !packed.includes(path));

  console.log(`packed entries: ${packed.join(', ') || '(none)'}`);

  let failed = false;
  if (unexpected.length > 0) {
    failed = true;
    console.error(`\nUNEXPECTED entries in the tarball:\n  ${unexpected.join('\n  ')}`);
  }
  if (missingRequired.length > 0) {
    failed = true;
    console.error(
      `\nREQUIRED entries missing from the tarball:\n  ${missingRequired.join('\n  ')}`,
    );
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!pkg.bin?.quotameter) {
    failed = true;
    console.error('\npackage.json must declare the `quotameter` bin entry.');
  }

  if (failed) {
    console.error(
      '\nThe tarball allowlist lives in scripts/check-package.mjs and package.json `files` ' +
        '(they must agree — test/unit/package-manifest.spec.ts pins it). ' +
        'Extend them only with files that belong in the published package.',
    );
    process.exitCode = 1;
  } else {
    console.log('\ntarball contents match the allowlist');
  }
}

// CLI entry: the module is imported (and unit-tested) as a pure seam, so
// run main() only when executed directly (`node scripts/check-package.mjs`).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
