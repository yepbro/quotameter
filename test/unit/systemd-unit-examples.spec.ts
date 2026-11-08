import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INIT_RESTART_SEC_SECONDS } from '../../src/cli/service-setup';
import { buildSystemUnit, validateSystemUnit } from '../../src/cli/systemd-unit';
import { buildUserUnit, validateUserUnit } from '../../src/cli/systemd-user-unit';

/**
 * The documented example unit files' drift guard (task 190, spec §5.4/§18,
 * decision D-200): `docs/examples/quotameter.service` and
 * `docs/examples/quotameter-user.service` are the annotated twins of what
 * the CLI generators emit, and "consistent with the generated units" is
 * enforced, not asserted — the same repo-file guard shape as
 * `readme-command-table.spec.ts` (D-198) over the D-093
 * stated-properties-are-structural precedent.
 *
 * The guard renders both units through the real generators with one
 * representative input (below) and pins every section/directive line of
 * the committed examples against the output — the annotation layer
 * (full-line comments, blank lines) is the only normalization. A new
 * directive, a reordered line, or a changed value on either side fails
 * `make check` until the other follows; the default restart delay is
 * derived from `INIT_RESTART_SEC_SECONDS`, never duplicated (the D-198
 * rule). The raw annotated files must also pass the same §5.4 validators
 * `doctor` reads installed units with — at once the proof that the
 * annotations remain valid unit syntax and the mechanical no-secrets rule
 * (any `Environment=` line other than NODE_ENV=production is a problem;
 * the generator inputs carry no secret-shaped field at all).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'docs', 'examples');
const SYSTEM_EXAMPLE_PATH = path.join(EXAMPLES_DIR, 'quotameter.service');
const USER_EXAMPLE_PATH = path.join(EXAMPLES_DIR, 'quotameter-user.service');

/**
 * The representative install the examples document (decision D-200): a
 * neutral service account under the default npm global prefix, and the
 * CLI's default restart delay. Deliberately generic values — the task-134
 * fixture account is a real person's and stays out of public docs.
 */
const EXAMPLE_NODE_PATH = '/usr/local/bin/node';
const EXAMPLE_CLI_PATH = '/usr/local/lib/node_modules/quotameter/bin/quotameter.mjs';
const EXAMPLE_USER = 'quotameter';
const EXAMPLE_CONFIG_DIR = `/home/${EXAMPLE_USER}/.config/quotameter`;
const EXAMPLE_DATA_DIR = `/home/${EXAMPLE_USER}/.local/share/quotameter`;

/**
 * The example's directive skeleton: full-line comments (systemd's `#` and
 * `;`) and blank lines — the annotation layer — stripped; every remaining
 * line is pushed verbatim, surrounding whitespace included (the generated
 * output carries none, so a padded example line fails the pin). Comparing
 * skeletons pins section order, directive order, and every directive
 * line; comment placement and wording are the documented unpinned
 * residual (cosmetic).
 */
function directiveLines(content: string): string[] {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
    lines.push(line);
  }
  return lines;
}

/** Reads an example file as text, failing the suite when it is missing. */
function readExample(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('docs/examples unit files (spec §5.4/§18, D-200)', () => {
  it('ships exactly the two example units in docs/examples/', () => {
    expect(readdirSync(EXAMPLES_DIR).sort()).toEqual([
      'quotameter-user.service',
      'quotameter.service',
    ]);
  });

  it('the system example is the generator output for the documented install', () => {
    const generated = buildSystemUnit({
      nodePath: EXAMPLE_NODE_PATH,
      cliPath: EXAMPLE_CLI_PATH,
      user: EXAMPLE_USER,
      restartSecSeconds: INIT_RESTART_SEC_SECONDS,
      configDir: EXAMPLE_CONFIG_DIR,
      dataDir: EXAMPLE_DATA_DIR,
    });
    const example = readExample(SYSTEM_EXAMPLE_PATH);
    expect(directiveLines(example)).toEqual(directiveLines(generated));
    // One trailing newline: tidy files, no doubled blank tail.
    expect(example.endsWith('\n')).toBe(true);
    expect(example.endsWith('\n\n')).toBe(false);
  });

  it('the user example is the generator output for the documented install', () => {
    const generated = buildUserUnit({
      nodePath: EXAMPLE_NODE_PATH,
      cliPath: EXAMPLE_CLI_PATH,
      restartSecSeconds: INIT_RESTART_SEC_SECONDS,
    });
    const example = readExample(USER_EXAMPLE_PATH);
    expect(directiveLines(example)).toEqual(directiveLines(generated));
    expect(example.endsWith('\n')).toBe(true);
    expect(example.endsWith('\n\n')).toBe(false);
  });

  it('both annotated examples pass the §5.4 validators doctor reads units with', () => {
    expect(
      validateSystemUnit(readExample(SYSTEM_EXAMPLE_PATH), {
        configDir: EXAMPLE_CONFIG_DIR,
        dataDir: EXAMPLE_DATA_DIR,
      }),
    ).toEqual([]);
    expect(validateUserUnit(readExample(USER_EXAMPLE_PATH))).toEqual([]);
  });

  it('the README guide links both example files', () => {
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('](docs/examples/quotameter.service)');
    expect(readme).toContain('](docs/examples/quotameter-user.service)');
  });
});
