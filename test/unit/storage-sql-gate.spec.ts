import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The storage SQL gate (task 088; spec §3, §8.1, §11; decision D-058).
 *
 * Task 088's done-condition — application services issue no ad hoc SQL
 * outside the storage module — enforced mechanically, the way
 * `package-layout.spec.ts` enforces the import directions (D-009): outside
 * `src/storage/`, no source file may carry a statement-shaped SQL string
 * literal. Together with the layout test's `node:sqlite` import gate (no
 * other layer can even construct a `DatabaseSync`), this keeps the typed
 * repository (`src/storage/repository.ts`) the only sanctioned data path —
 * a future service reaching for raw SQL over a received handle fails
 * `make check` instead of surviving until review.
 *
 * The detector deliberately matches **uppercase** statement keywords only:
 * every SQL statement in this codebase is written with uppercase keywords
 * (the house style tasks 078–087 established), while English prose in
 * strings and comments is lowercase-first ("select your plan from the
 * list", "Begin the setup…") — case sensitivity is what keeps the gate
 * precise without a TypeScript AST parse. Ambiguous transaction words
 * (`COMMIT`, `ROLLBACK`) additionally require a terminator so ordinary
 * uppercase identifiers cannot trip them. The pattern is proven
 * non-vacuous by the positive-control fixtures below.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');

/** A string literal that starts an SQL statement (see the header rationale). */
const SQL_STATEMENT_PATTERN =
  /['"`]\s*(?:SELECT\s|INSERT\s+INTO\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(?:UNIQUE\s+)?(?:TEMPORARY\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\s|ALTER\s+TABLE\s|PRAGMA\s+\w+\s*=|BEGIN\s*;|BEGIN\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE)\b|COMMIT\s*;|ROLLBACK\s*;|VACUUM\b)/;

/** Every `.ts` file under `dir`, recursively, skipping `skip` directory names. */
function listFiles(dir: string, skip: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.includes(entry.name)) continue;
      files.push(...listFiles(full, skip));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('storage SQL gate (task 088, spec §3/§11)', () => {
  it('no SQL statement literals outside src/storage/', () => {
    const violations: string[] = [];
    for (const file of listFiles(SRC, ['storage'])) {
      const code = readFileSync(file, 'utf8');
      if (SQL_STATEMENT_PATTERN.test(code)) {
        violations.push(
          `${path.relative(REPO_ROOT, file)}: SQL statement literal — all database access ` +
            `belongs in src/storage/ (the repository facade; decision D-058)`,
        );
      }
    }
    expect(violations.sort(), 'ad hoc SQL outside the storage module').toEqual([]);
  });

  it('detector flags statement-shaped literals (positive control)', () => {
    const offenders = [
      `const sql = 'SELECT id FROM accounts';`,
      `const sql = "INSERT INTO accounts (id) VALUES (?)";`,
      'const sql = `UPDATE accounts SET label = ?`;',
      `const sql = 'DELETE FROM sessions';`,
      `const sql = "CREATE TABLE x (id TEXT)";`,
      `const sql = "CREATE UNIQUE INDEX x ON t (a)";`,
      `const sql = "DROP TABLE x";`,
      `const sql = "ALTER TABLE x ADD COLUMN y TEXT";`,
      `const sql = 'PRAGMA journal_mode = WAL';`,
      `database.exec("BEGIN IMMEDIATE");`,
      `database.exec('COMMIT;');`,
      'const sql = `VACUUM`;',
    ];
    for (const sample of offenders) {
      expect(SQL_STATEMENT_PATTERN.test(sample), sample).toBe(true);
    }
  });

  it('detector ignores English prose and bare identifiers', () => {
    const innocuous = [
      'const message = "select your plan from the list";',
      'const message = "Begin the setup by editing config.json";',
      'const tableName = "accounts";',
      'const word = "commitment";',
      'const query = queryAccounts();',
      '// see the SELECT statements in src/storage/repository.ts',
    ];
    for (const sample of innocuous) {
      expect(SQL_STATEMENT_PATTERN.test(sample), sample).toBe(false);
    }
  });
});
