/**
 * The §7.4 diagnostic read path — `quotameter doctor --raw <account>`'s data
 * source (task 103, decision D-067).
 *
 * Spec §7.4 exposes stored raw payloads "only through `quotameter doctor
 * --raw <account>` (never over HTTP or in the web UI)", and §5.5 repeats the
 * shape: the diagnostic is CLI-only. This module is that exposure path's
 * read-and-render half, kept in exactly one file so the structural gate
 * (`test/unit/raw-response-gate.spec.ts`, the D-058 SQL-gate pattern) can
 * confine every raw-payload identifier outside `src/storage/` to it — the
 * Stage 12 HTTP API (`src/server/api/*`) and the web UI (`ui/`) fail
 * `make check` on their first reference to the raw-response surface instead
 * of shipping an unsanctioned route.
 *
 * Task 145's `doctor` handler composes these two functions behind the
 * `--raw <account>` option the dispatch table already declares (spec §5.5
 * fixes the surface; the handler is 145's, this module is 103's).
 *
 * - **The read is bounded by the cap** — at most
 *   `RAW_RESPONSE_MAX_PER_ACCOUNT` records, newest first (the facade's
 *   `captured_at DESC, run_id DESC` ordering). The write path (D-067) keeps
 *   the table within policy; the bound here means even a pathological state
 *   (facade-seeded, pre-cap database) never floods a terminal.
 * - **The body renders verbatim** — D-041 pinned "doctor --raw renders it as
 *   text"; pretty-printing JSON is a display concern, and the sanitizer's
 *   output is stored as-is (D-051). Timestamps render through `toUtcIso`
 *   (§10's ISO 8601 UTC `Z` form — machine-comparable diagnostics, no
 *   implicit local zone).
 */

import { RAW_RESPONSE_MAX_PER_ACCOUNT } from '../storage/raw-response-retention';
import type { QuotaRepository, RawResponseRecord } from '../storage/repository';
import { toUtcIso } from '../util/clock';

/**
 * Reads an account's retained §7.4 payloads for diagnostics: newest first,
 * at most {@link RAW_RESPONSE_MAX_PER_ACCOUNT} records. Throws on a blank
 * `accountId` (a wiring bug, not a data state); an account with no retained
 * payloads — or no payloads at all — reads as an empty list.
 */
export function readRawDiagnostics(
  repository: QuotaRepository,
  accountId: string,
): ReadonlyArray<RawResponseRecord> {
  if (accountId.trim().length === 0) {
    throw new Error('readRawDiagnostics: accountId must be a non-blank string (spec §7.4)');
  }
  return repository.listRawResponses(accountId, { limit: RAW_RESPONSE_MAX_PER_ACCOUNT });
}

/**
 * Renders diagnostic records as the text `doctor --raw` prints: one header
 * line per record (run id, captured instant, HTTP status, content type) with
 * the payload body indented two spaces below it, records separated by a
 * blank line — the indentation keeps multi-line bodies visually attached to
 * their header. Absent evidence columns render as explicit `none`/
 * `unknown` words, so a record never looks richer than what was retained.
 * The result carries no trailing newline; the `CliOutput` seam adds one.
 */
export function renderRawDiagnostics(records: ReadonlyArray<RawResponseRecord>): string {
  if (records.length === 0) {
    return 'No sanitized raw responses retained.';
  }
  const blocks = records.map((record) => {
    const status = record.httpStatus === null ? 'no HTTP status' : `HTTP ${record.httpStatus}`;
    const type = record.contentType === null ? 'unknown content type' : record.contentType;
    const bodyLines = record.body === '' ? [] : record.body.split('\n').map((line) => `  ${line}`);
    return [
      `run ${record.runId}  captured ${toUtcIso(record.capturedAt)}  ${status}  ${type}`,
      ...bodyLines,
    ].join('\n');
  });
  // "shown", not "retained": the read is cap-bounded, and in a pathological
  // overshoot state (unreachable through the sanctioned write path) the
  // account may hold more rows than this bounded listing displays.
  return [
    `Sanitized raw responses: ${records.length} shown (newest first)`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
