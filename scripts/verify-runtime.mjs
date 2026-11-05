#!/usr/bin/env node
/**
 * Runtime verification for the minimum supported environment (spec §5.1, §20).
 *
 * Checks that the current Node.js process:
 *  1. satisfies the minimum declared in the manifest's `engines.node` —
 *     the single source of truth the CLI launcher's gate also derives from
 *     (task 129, decision D-098) — and
 *  2. can import the built-in `node:sqlite` module without the
 *     `--experimental-sqlite` flag and run a trivial query.
 *
 * Exits non-zero with an actionable message when either check fails. The
 * `node:sqlite` import is dynamic and happens only after the version gate:
 * the module is exactly the unsupported feature the gate exists to keep
 * away from older runtimes, so it must not load before the check — on a
 * runtime without the module a static import would crash the process
 * before this script could print anything (decision D-161).
 *
 * All exits set `process.exitCode` and let the event loop drain — the
 * launcher's pipe-flush discipline (`bin/quotameter.mjs`) — with the gate
 * as an if/else chain so a refusing arm can never fall through to the
 * SQLite probe below it.
 *
 * The comparison below is a deliberate plain-JS copy of the canonical
 * prefix ordering in `src/util/version.ts` (this script runs under plain
 * `node` — no jiti, no build — and must not import `src/`; the second
 * such copy beside the launcher's), pinned equivalent by the shared
 * boundary matrix in `test/helpers/nodeVersionGate.ts`:
 * `test/integration/runtime-verify-script.spec.ts` fakes every matrix
 * case into a real child process running this file, and proves with
 * fixture packages that the gate follows a raised or relaxed declaration
 * (patch-level included). Wired as the `verify:runtime` npm script (the
 * `make verify-runtime` target runs it), consistent with the sibling
 * tool scripts.
 */
import { readFileSync } from 'node:fs';

let pkg;
try {
  pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
} catch {
  pkg = undefined;
}

// The manifest contract: exactly '>=X.Y.Z' (spec §20). Anything else is a
// packaging defect — fail closed rather than guess a minimum.
const declared = pkg?.engines?.node;
const match = typeof declared === 'string' ? /^>=(\d+)\.(\d+)\.(\d+)$/.exec(declared.trim()) : null;

// Same prefix ordering as src/util/version.ts and bin/quotameter.mjs: cut
// the prerelease/build suffix, require 1–3 numeric segments, missing → 0.
function numericSegments(version) {
  const cut = version.search(/[+-]/);
  const numeric = cut === -1 ? version : version.slice(0, cut);
  const parts = numeric.split('.');
  const valid = parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p));
  return valid ? [0, 1, 2].map((i) => Number(parts[i] ?? 0)) : null;
}

const current = process.versions.node;

async function main() {
  if (!pkg || !match) {
    console.error(
      'quotameter: package.json must declare engines.node as exactly ">=X.Y.Z" ' +
        `(found ${JSON.stringify(declared)}); fix the manifest`,
    );
    process.exitCode = 1;
    return;
  }

  const MINIMUM = [Number(match[1]), Number(match[2]), Number(match[3])];
  const segments = numericSegments(current);

  if (segments === null) {
    console.error(
      `quotameter cannot determine the Node.js version ` +
        `(process.versions.node is ${JSON.stringify(current)}); ` +
        `quotameter requires Node.js >= ${MINIMUM.join('.')}`,
    );
    process.exitCode = 1;
    return;
  }

  let below = false;
  for (let i = 0; i < MINIMUM.length; i++) {
    if (segments[i] !== MINIMUM[i]) {
      below = segments[i] < MINIMUM[i];
      break;
    }
  }

  if (below) {
    console.error(
      `quotameter requires Node.js >= ${MINIMUM.join('.')} (found ${current}). ` +
        'Upgrade Node.js or use the development container: make shell',
    );
    process.exitCode = 1;
    return;
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO probe (value) VALUES (?)').run('ok');
  const row = db.prepare('SELECT value FROM probe WHERE id = ?').get(1);
  db.close();

  if (row?.value !== 'ok') {
    console.error('node:sqlite verification failed: unexpected query result.');
    process.exitCode = 1;
    return;
  }

  console.log(`runtime ok: node ${current}, node:sqlite available without flags`);
}

await main();
