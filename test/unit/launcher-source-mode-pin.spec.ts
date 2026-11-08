import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The real-launcher suites' source-mode membership pin (task 186, D-196).
 *
 * Every suite that spawns `bin/quotameter.mjs` with `--import
 * jiti/register` tests the development contract: the TypeScript source
 * tree loaded through jiti (the task-130 child-process pattern). D-195's
 * deliberate dist-first resolution would flip exactly those children into
 * the compiled `dist/` graph whenever a built `dist/` exists in the tree —
 * `make check-all`'s build leg leaves one, so the first run after a clean
 * was green and every consecutive run was red (the 2026-11-08 landing
 * rollback: 26 real-launcher failures, `request for
 * '…/node_modules/jiti/lib/jiti.mjs' is not in cache` — under jiti's
 * process-wide ESM hooks, the compiled graph's CJS dependencies die in
 * Node's require(esm) bridge).
 *
 * The fix pins each such suite's children to `QUOTAMETER_CLI_ENTRY=
 * 'source'` (the launcher's mode override, `CLI_ENTRY_SOURCE` in
 * `test/helpers/hermetic-child-env.ts`); the compiled mode keeps its own
 * dedicated suite (`test/integration/cli-bin-dist.spec.ts` — plain Node,
 * fixture package roots). This spec keeps the membership from drifting: a
 * NEW suite that spawns the launcher under jiti without the pin would
 * reintroduce the ambient-dist nondeterminism, and it fails here with the
 * remedy instead.
 *
 * The detection is textual and deliberately narrow: a file under `test/`
 * that contains the jiti preload literal `'jiti/register'` AND the
 * launcher-path literal `'bin/quotameter.mjs'` (the `BIN` constant every
 * launcher-spawning suite declares) must also reference
 * `QUOTAMETER_CLI_ENTRY`. Runner-spawning suites (server-main,
 * single-instance, rolling-ranges, the service-setup probe) mention
 * jiti/register but never the launcher path as a path literal; fixture
 * strings that embed the installed path
 * (`/usr/local/lib/node_modules/quotameter/bin/quotameter.mjs`) do not
 * contain the quoted relative literal, so they do not match.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_ROOT = path.join(REPO_ROOT, 'test');

/** Every *.spec.ts / *.ts helper under test/, as absolute paths. */
function listTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTestFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('real-launcher suites pin the source entry mode (task 186, D-196)', () => {
  it('every suite spawning the launcher under jiti sets QUOTAMETER_CLI_ENTRY', () => {
    const offenders: string[] = [];
    for (const file of listTestFiles(TEST_ROOT)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes("'jiti/register'") && text.includes("'bin/quotameter.mjs'")) {
        // Either pin form is membership: the raw env literal or the
        // spread constant (the suites that strip QUOTAMETER_* re-set the
        // literal explicitly, e.g. cli-run.spec.ts).
        const pinned = text.includes('QUOTAMETER_CLI_ENTRY') || text.includes('CLI_ENTRY_SOURCE');
        if (!pinned) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(
      offenders.sort(),
      'these suites spawn bin/quotameter.mjs with --import jiti/register but do not pin ' +
        "QUOTAMETER_CLI_ENTRY='source' — their children would flip into the compiled dist/ " +
        "graph whenever a built dist/ exists (D-195 dist-first) and die under jiti's ESM hooks " +
        "in Node's require(esm) bridge; spread CLI_ENTRY_SOURCE " +
        '(test/helpers/hermetic-child-env.ts) into their spawn env',
    ).toEqual([]);
  });

  it('the pin constant the suites spread exists and names the launcher contract', () => {
    // The membership rule is only as good as the constant it points to:
    // if the helper is renamed or re-scoped, the message above must move
    // with it (this pin fails first).
    const helper = readFileSync(path.join(REPO_ROOT, 'test/helpers/hermetic-child-env.ts'), 'utf8');
    expect(helper).toContain('export const CLI_ENTRY_SOURCE');
    expect(helper).toContain("QUOTAMETER_CLI_ENTRY: 'source'");
  });
});
