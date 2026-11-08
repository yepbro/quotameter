import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCommandTable } from '../../src/cli/commands';
import { INIT_RESTART_SEC_SECONDS } from '../../src/cli/service-setup';
import { SYSTEM_UNIT_INSTALL_PATH, SYSTEM_UNIT_NAME } from '../../src/cli/systemd-unit';
import { USER_UNIT_NAME } from '../../src/cli/systemd-user-unit';
import { CONFIG_DEFAULTS } from '../../src/schemas/config';
import { AUTOMATIC_BACKUP_DIRNAME } from '../../src/storage/backups';

/**
 * The deployment/operations guide's drift guard (task 188, spec §18;
 * decision D-198): the README's operator command surface must agree with
 * the real dispatch table — the same repo-file guard shape as
 * `configuration-reference.spec.ts` (D-197) over the D-093
 * stated-properties-are-structural precedent.
 *
 * The guard pins the guide's most drift-prone claims to the code that owns
 * them: the command table row-for-row against `buildCommandTable()`
 * (names, order, and summaries — the exact wording `--help` prints), the
 * `init` options table against the command's option set in both
 * directions with the row count pinned (a duplicated or foreign row
 * fails), exactly one table per expected header (a second same-header
 * table cannot silently merge into either comparison), and the deployment
 * literals — unit paths from the generator constants, the linger and
 * SSH-tunnel commands, the backup directory and name grammar from the
 * storage constants, the permission modes, the restart remedy, and the
 * documented defaults derived from `CONFIG_DEFAULTS` and
 * `INIT_RESTART_SEC_SECONDS` rather than duplicated — as prose
 * presences. A command, flag, default, or summary reworded in the
 * dispatch table now fails `make check` until the guide follows.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The README, verbatim. */
const README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

/** A table cell normalized for comparison: no backticks, single-spaced. */
function normalizedCell(raw: string): string {
  return raw.replaceAll('`', '').replaceAll(/\s+/gu, ' ').trim();
}

/** Parses one table line into trimmed cells (an empty array for non-table lines). */
function splitRow(line: string): string[] {
  if (!line.trim().startsWith('|')) return [];
  return line
    .trim()
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** How many tables in the README carry the (normalized) header `header`. */
function tableCount(header: readonly string[]): number {
  const lines = README.split('\n');
  const wanted = header.join('|');
  let count = 0;
  let inTable = false;
  for (const line of lines) {
    const cells = splitRow(line);
    if (cells.length === 0) {
      inTable = false;
      continue;
    }
    if (!inTable && cells.map(normalizedCell).join('|') === wanted) {
      count += 1;
      inTable = true;
    }
  }
  return count;
}

/** Every row of every table whose normalized header row equals `header`. */
function tableRows(header: readonly string[]): string[][] {
  const lines = README.split('\n');
  const wanted = header.join('|');
  const rows: string[][] = [];
  let current: string[][] | undefined;
  for (const line of lines) {
    const cells = splitRow(line);
    if (cells.length === 0) {
      if (current !== undefined && current.length > 0) rows.push(...current.slice(2));
      current = undefined;
      continue;
    }
    if (current === undefined) {
      if (cells.map(normalizedCell).join('|') !== wanted) continue;
      current = [];
    }
    current.push(cells);
  }
  if (current !== undefined && current.length > 0) rows.push(...current.slice(2));
  return rows;
}

/** The whole document, whitespace-collapsed and backtick-stripped. */
const PROSE = README.replaceAll('`', '').replaceAll(/\s+/gu, ' ');

/** The dispatch table flattened to command-path/summary pairs, in spec order. */
function flattenedCommands(): Array<{ name: string; summary: string }> {
  const flat: Array<{ name: string; summary: string }> = [];
  for (const command of buildCommandTable()) {
    if (command.kind === 'leaf') {
      flat.push({ name: command.name, summary: command.summary });
    } else {
      for (const sub of command.subcommands) {
        flat.push({ name: `${command.name} ${sub.name}`, summary: sub.summary });
      }
    }
  }
  return flat;
}

describe('README deployment guide: command table', () => {
  it('has exactly one command table and one option table to compare against', () => {
    expect(tableCount(['Command', 'Purpose'])).toBe(1);
    expect(tableCount(['Option', 'Meaning'])).toBe(1);
  });

  it('lists every dispatch-table command, in dispatch order, with the exact summary', () => {
    const rows = tableRows(['Command', 'Purpose']);
    expect(rows.length).toBeGreaterThan(0);
    const documented = rows.map(([command, purpose]) => ({
      name: normalizedCell(command ?? '').replace(/^quotameter /u, ''),
      summary: normalizedCell(purpose ?? ''),
    }));
    expect(documented).toEqual(flattenedCommands());
  });

  it('documents exactly the `init` option set', () => {
    const rows = tableRows(['Option', 'Meaning']);
    const init = buildCommandTable().find(
      (command) => command.kind === 'leaf' && command.name === 'init',
    );
    if (init?.kind !== 'leaf') {
      throw new Error('the init command is missing from the dispatch table');
    }
    const documentedNames = new Set(
      rows
        .map(([option]) => /^--([a-z-]+)/u.exec(normalizedCell(option ?? ''))?.[1])
        .filter((name): name is string => name !== undefined),
    );
    const actualNames = new Set(Object.keys(init.options));
    // Row count beside set equality: a duplicated row or one whose cell
    // does not parse as `--name` must fail, not pass silently (D-197's
    // review lesson).
    expect(rows.length).toBe(actualNames.size);
    expect(documentedNames).toEqual(actualNames);
  });
});

describe('README deployment guide: operational literals', () => {
  it('names the unit paths the generators own', () => {
    expect(PROSE).toContain(SYSTEM_UNIT_INSTALL_PATH);
    expect(PROSE).toContain(`~/.config/systemd/user/${USER_UNIT_NAME}`);
    expect(SYSTEM_UNIT_NAME).toBe(USER_UNIT_NAME);
  });

  it('carries the linger, tunnel, backup, permission, and restart remedies', () => {
    // The exact command renderLingerGuidance prints for a non-enabled state.
    expect(PROSE).toContain('sudo loginctl enable-linger');
    // The SSH-tunnel form renderInitNextSteps prints for the default bind.
    expect(PROSE).toContain(
      `ssh -N -L ${CONFIG_DEFAULTS.server.port}:${CONFIG_DEFAULTS.server.host}:${CONFIG_DEFAULTS.server.port}`,
    );
    // The automatic backups' directory (AUTOMATIC_BACKUP_DIRNAME) and the
    // name grammar of src/storage/backups.ts.
    expect(PROSE).toContain(`${AUTOMATIC_BACKUP_DIRNAME}/backup-*.sqlite`);
    // The enforced modes (§6.3) and the §6.4 restart remedy.
    expect(PROSE).toContain('0600');
    expect(PROSE).toContain('0700');
    expect(PROSE).toContain('quotameter restart');
  });

  it('documents the defaults the configuration owns', () => {
    expect(PROSE).toContain(`(default ${CONFIG_DEFAULTS.server.host})`);
    expect(PROSE).toContain(`(default ${CONFIG_DEFAULTS.server.port})`);
    expect(PROSE).toContain(`(default ${CONFIG_DEFAULTS.app.pollingIntervalSeconds})`);
    expect(PROSE).toContain(`(default ${INIT_RESTART_SEC_SECONDS})`);
  });
});
