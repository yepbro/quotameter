import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The raw-response access gate (task 103; spec §7.4, §5.5; decision D-067).
 *
 * §7.4 exposes stored raw payloads "only through `quotameter doctor --raw
 * <account>` (never over HTTP or in the web UI)" — enforced mechanically,
 * the way `storage-sql-gate.spec.ts` enforces the one-database-gate rule
 * (D-058) and `package-layout.spec.ts` the import directions (D-009):
 * outside the sanctioned homes, no source file may reference the
 * raw-payload surface. There is no HTTP API yet (Stage 12 builds it), so
 * the gate is what makes the guarantee forward-enforceable rather than
 * today-true: the first `src/server/api/**` route or `ui/**` component
 * that reaches for the payloads fails `make check` instead of shipping an
 * unsanctioned exposure.
 *
 * Sanctioned homes: `src/storage/**` (the data layer — the facade, the
 * cycle write, the cap, the retention cleanup) and `src/cli/**` (the CLI
 * diagnostic consumer layer — `doctor --raw`'s read path, currently
 * `raw-diagnostics.ts`, which task 145's handler composes; the layer-wide
 * boundary is deliberate so 145 can wire the handler wherever the dispatch
 * table needs it). Spec §7.4's prohibition is HTTP and the web UI, and
 * those are exactly the layers the gate denies; within the CLI, D-067
 * records the doctor `--raw` path as the sanctioned consumer. Widening the
 * allowlist is a successor decision, never a silent edit — the same
 * no-silent-widening rule the SQL gate records. One such widening has
 * landed: decision D-069 (task 110) sanctions `src/services/polling-
 * persist.ts` — the write-side cycle composer that feeds D-060's
 * parse-failure branch its §7.4 payload (see `isSanctioned`).
 *
 * The detector's subject is the **typed facade surface** — every camelCase
 * identifier the stored payloads travel through: the read methods
 * (`listRawResponses`, `getRawResponseByRun`), the write/delete methods
 * (`insertRawResponse`, `deleteRawResponses…`), the record/input types
 * (`RawResponseRecord`, `NewRawResponse`, `CycleRawResponseInput`), the
 * classified-cycle field (`rawResponse`), and any future name carrying the
 * same `[Rr]awResponse` stem — **plus the diagnostic module's own API**
 * (`[Rr]awDiagnostics`, and the `raw-diagnostics` module path): a future
 * route importing `readRawDiagnostics` would receive the full payload list
 * without ever naming a facade identifier, so the exposure functions and
 * their import path are surface too (review finding P3-1). One deliberate
 * exclusion: the §7.4 sanitizer `sanitizeRawResponse` (D-041) lives in
 * `src/providers/` by design — it is the write-side purification that
 * makes payloads safe, never a read of the stored table — so its name is
 * exempted via lookbehind, both spellings of any reference included.
 * Direct SQL over the `raw_responses` table is deliberately out of this
 * gate's scope: constructing a `DatabaseSync` outside `src/storage/`
 * already fails `package-layout.spec.ts`, uppercase statement literals
 * fail the SQL gate, and the lowercase/concatenated residual is the
 * documented non-security-boundary caveat both gates share (D-058). The
 * exposure guarantee is therefore this gate **plus** the layout table
 * (which keeps `server`/`ui` from importing `cli` at all) — each layer
 * catching what the other cannot see. Tests are sanctioned readers and
 * are not scanned, matching the SQL gate's scope. The controls below
 * prove the detector and the scanner non-vacuous.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');
const UI = path.join(REPO_ROOT, 'ui');

/** Identifiers of the stored raw-payload surface (see the header rationale). */
const RAW_RESPONSE_PATTERN = /(?<!sanitize)[Rr]awResponse|[Rr]awDiagnostics|raw-diagnostics/;

/** The §7.4 sanctioned homes: the data layer and the CLI consumer layer. */
function isSanctioned(relativeFile: string): boolean {
  return (
    relativeFile.startsWith(`src${path.sep}storage${path.sep}`) ||
    relativeFile.startsWith(`src${path.sep}cli${path.sep}`) ||
    // D-069 (task 110), the successor decision D-067 reserves this list
    // for: the cycle recorder is the write-side composer of D-060's
    // parse-failure branch — the one services file that hands the §7.4
    // payload to `persistCollectionCycle`, which requires naming the
    // classified-cycle field and its input type. It composes no read of
    // the stored table; the exposure guarantee (reads confined to storage
    // and `doctor --raw`) is unchanged, which is why this entry sanctions
    // exactly one file, never the services layer.
    relativeFile === path.join('src', 'services', 'polling-persist.ts')
  );
}

/** Every file under `dir` with one of `extensions`, recursively, skipping `skip`. */
function listFiles(dir: string, extensions: readonly string[], skip: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.includes(entry.name)) continue;
      files.push(...listFiles(full, extensions, skip));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

describe('raw-response access gate (task 103, spec §7.4/§5.5)', () => {
  it('no raw-payload surface references outside src/storage/ and src/cli/', () => {
    // The same extension sets the layout gate scans (P3-2): `.ts` under
    // `src/`, `.ts`/`.tsx`/`.js`/`.vue` under `ui/`.
    const scanned = [
      ...listFiles(SRC, ['.ts'], []),
      ...listFiles(UI, ['.ts', '.tsx', '.js', '.vue'], ['dist', 'node_modules']),
    ];
    // Scanner-level control: the walk must reach both sanctioned homes and
    // at least one file beyond them, or the assertion below is vacuous.
    const relative = scanned.map((file) => path.relative(REPO_ROOT, file));
    expect(relative, 'scanner reaches src/storage').toContain(
      path.join('src', 'storage', 'repository.ts'),
    );
    expect(relative, 'scanner reaches the CLI diagnostic file').toContain(
      path.join('src', 'cli', 'raw-diagnostics.ts'),
    );
    expect(relative, 'scanner reaches src beyond storage').toContain(
      path.join('src', 'server', 'main.ts'),
    );
    expect(relative, 'scanner reaches the ui tree').toContain(path.join('ui', 'src', 'main.ts'));

    const violations: string[] = [];
    for (const file of scanned) {
      if (isSanctioned(path.relative(REPO_ROOT, file))) continue;
      const code = readFileSync(file, 'utf8');
      if (RAW_RESPONSE_PATTERN.test(code)) {
        violations.push(
          `${path.relative(REPO_ROOT, file)}: raw-payload surface reference — spec §7.4 ` +
            `exposes stored responses only through 'quotameter doctor --raw <account>', never ` +
            `over HTTP or in the web UI (decision D-067)`,
        );
      }
    }
    expect(violations.sort(), 'raw-payload surface outside the sanctioned homes').toEqual([]);
  });

  it('detector flags every spelling of the surface (positive control)', () => {
    const offenders = [
      'const rows = repository.listRawResponses("work");',
      'const one = repo.getRawResponseByRun(runId);',
      'import type { RawResponseRecord } from "../storage/repository";',
      'const payload = cycle.rawResponse;',
      'const deleted = tx.deleteRawResponsesByRunIds(ids);',
      'await enforceRawResponseCap(repository, "work");',
      'const summary = renderRawResponseSummary(rows); // a future identifier',
      'const records = readRawDiagnostics(repository, "work");',
      'import { renderRawDiagnostics } from "../cli/raw-diagnostics";',
      'import * as diag from "../cli/raw-diagnostics";',
    ];
    for (const sample of offenders) {
      expect(RAW_RESPONSE_PATTERN.test(sample), sample).toBe(true);
    }
  });

  it('detector ignores the sanctioned sanitizer and CLI prose (negative control)', () => {
    const innocuous = [
      'import { sanitizeRawResponse } from "../sanitize";',
      'const safe = sanitizeRawResponse(body, secrets);',
      'const message = "raw response body was sanitized";',
      'const option = "--raw <account>";',
      'const cap = RAW_RESPONSE_MAX_PER_ACCOUNT;',
      'const doctor = "doctor --raw work";',
    ];
    for (const sample of innocuous) {
      expect(RAW_RESPONSE_PATTERN.test(sample), sample).toBe(false);
    }
  });
});
