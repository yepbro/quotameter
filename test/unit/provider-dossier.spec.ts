import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZAI_METRIC_CATALOG } from '../../src/providers/zai-coding-plan/mapping';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_CODING_BASE_URL,
  composeCredentialCheckUrl,
  composeSnapshotUrls,
} from '../../src/providers/zai-coding-plan/provider';

/**
 * The provider dossier's drift guard (task 189, spec §8.3, §9.1, §18;
 * decision D-199): the contract summary appended by task 189 states the
 * provider contract as it ships, and its load-bearing claims must agree with
 * the code and the repository — the D-093/D-197/D-198 stated-properties
 * precedent applied to `docs/providers/zai-coding-plan.md` (task 112's
 * `example-config.spec.ts` pins the peak-schedule provenance; this suite
 * extends the idea to the endpoint, metric-identity, fixture, and citation
 * surfaces).
 *
 * Pinned: the four production endpoint URLs appear verbatim as the adapter
 * composes them (doc ↔ `provider.ts`); the summary's identities table equals
 * the adapter's served catalog exactly, in order (doc ↔ `mapping.ts`,
 * D-137); the summary's fixtures inventory equals the committed corpus as a
 * set (both directions) and every full `test/fixtures/...` path cited
 * anywhere in the dossier exists; every cited test suite exists, with the
 * test map's eight suites required by name inside the summary; every cited
 * `D-NNN` is a real `DECISIONS.md` entry; and the peak-hours reference
 * carries the §9.1 essentials (canonical URL, latest check date, window,
 * zone, multipliers).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOSSIER_PATH = path.join(REPO_ROOT, 'docs', 'providers', 'zai-coding-plan.md');
const DOSSIER = readFileSync(DOSSIER_PATH, 'utf8');

const SUMMARY_HEADING = '## Contract summary and evidence audit';

/**
 * The task-189 summary section: from its heading to the end of the file.
 * Throws (failing whichever test reaches for it) when the heading is absent
 * — the dedicated presence test names the requirement readably.
 */
function summary(): string {
  const start = DOSSIER.indexOf(SUMMARY_HEADING);
  if (start < 0) throw new Error(`the dossier must carry the '${SUMMARY_HEADING}' section`);
  return DOSSIER.slice(start);
}

/** One `###`-level subsection of the summary: heading to the next heading. */
function summarySubsection(heading: string): string {
  const text = summary();
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`the summary must carry the '${heading}' subsection`);
  const next = text.indexOf('\n### ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/** The committed fixture basenames (`.gitkeep` excluded), per directory. */
function committedFixtures(): Map<string, string[]> {
  const directories = ['sanitized', 'synthetic'] as const;
  const committed = new Map<string, string[]>();
  for (const directory of directories) {
    committed.set(
      directory,
      readdirSync(path.join(REPO_ROOT, 'test', 'fixtures', directory)).filter(
        (name) => name !== '.gitkeep',
      ),
    );
  }
  return committed;
}

/**
 * The suites the summary's test map must name — the provider's own seven
 * plus the example-config provenance test that pins this dossier.
 */
const TEST_MAP_SUITES = [
  'test/unit/zai-coding-plan-mapping.spec.ts',
  'test/unit/zai-coding-plan-mapping.property.spec.ts',
  'test/unit/zai-coding-plan-provider.spec.ts',
  'test/unit/zai-coding-plan-validate.spec.ts',
  'test/integration/zai-coding-plan-validate.spec.ts',
  'test/integration/zai-coding-plan-snapshot.spec.ts',
  'test/integration/zai-coding-plan-configured-provider.spec.ts',
  'test/integration/example-config.spec.ts',
] as const;

describe('provider dossier agrees with the implementation', () => {
  it('carries the task-189 contract summary section', () => {
    expect(DOSSIER.indexOf(SUMMARY_HEADING)).toBeGreaterThanOrEqual(0);
  });

  it('documents the four production endpoint URLs as the adapter composes them', () => {
    const urls = composeSnapshotUrls(DEFAULT_API_BASE_URL);
    // The composed reset-cards URL canonically encodes its query parameter.
    expect(urls.resetCards).toBe(
      'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL',
    );
    expect(summary()).toContain(urls.quotaLimit);
    expect(summary()).toContain(urls.subscriptionList);
    expect(summary()).toContain(urls.resetCards);
    expect(summary()).toContain(composeCredentialCheckUrl(DEFAULT_CODING_BASE_URL));
  });

  it('documents exactly the adapter metric identities, in catalog order', () => {
    // Parse the summary's identities table (the one whose header names the
    // metric key) and compare its rows with the catalog exactly.
    const units = summarySubsection('### Units and quota mapping');
    const lines = units.split('\n');
    const headerIndex = lines.findIndex((line) => line.includes('| Metric key'));
    expect(headerIndex, 'the summary must carry the identities table').toBeGreaterThanOrEqual(0);
    const rows = lines
      .slice(headerIndex + 2)
      .filter((line) => line.trim().startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    expect(rows.map((row) => row[0]?.replaceAll('`', ''))).toEqual(
      ZAI_METRIC_CATALOG.map((entry) => entry.metricKey),
    );
    expect(rows.map((row) => row[1])).toEqual(ZAI_METRIC_CATALOG.map((entry) => entry.label));
  });

  it('inventory: the summary lists exactly the committed fixtures, and cited paths exist', () => {
    // The inventory subsection's backticked `*.json` names must equal the
    // committed corpus as a set — both directions, no strays, no misses.
    const inventory = summarySubsection('### Fixtures inventory');
    const listed = new Set(inventory.match(/`[^`\n]+\.json`/gu)?.map((name) => name.slice(1, -1)));
    const committed = new Set([...committedFixtures().values()].flat());
    expect([...committed].sort()).toEqual([...listed].sort());

    // Every full `test/fixtures/...` path cited anywhere in the dossier
    // (dated sections included) must exist on disk.
    const cited = DOSSIER.match(/test\/fixtures\/[A-Za-z0-9._/-]+/gu) ?? [];
    for (const citation of cited) {
      const relative = citation.replace(/[.,)]+$/u, '');
      expect(
        existsSync(path.join(REPO_ROOT, relative)),
        `cited fixture path '${relative}' must exist`,
      ).toBe(true);
    }
  });

  it('cites test suites that exist, naming the test map suites in the summary', () => {
    const summaryText = summary();
    for (const suite of TEST_MAP_SUITES) {
      expect(existsSync(path.join(REPO_ROOT, suite)), `${suite} must exist`).toBe(true);
      expect(summaryText, `${suite} must be cited in the test map`).toContain(suite);
    }
    const cited = DOSSIER.match(/test\/(?:unit|integration)\/[A-Za-z0-9._-]+\.spec\.ts/gu) ?? [];
    for (const suite of cited) {
      expect(existsSync(path.join(REPO_ROOT, suite)), `cited suite '${suite}' must exist`).toBe(
        true,
      );
    }
  });

  it('cites only decisions that exist in DECISIONS.md', () => {
    const decisions = readFileSync(path.join(REPO_ROOT, 'DECISIONS.md'), 'utf8');
    const headings = new Set([...decisions.matchAll(/^## (D-\d{3}) /gmu)].map((match) => match[1]));
    expect(headings.size).toBeGreaterThan(150);
    const cited = new Set(DOSSIER.match(/\bD-\d{3}\b/gu));
    expect(cited.size).toBeGreaterThan(20);
    for (const decision of cited) {
      expect(headings, `cited decision '${decision}' must have a DECISIONS.md entry`).toContain(
        decision,
      );
    }
  });

  it('carries the §9.1 peak-hours essentials with the latest check date', () => {
    const reference = summarySubsection('### Peak-hours official reference');
    expect(reference).toContain('https://docs.z.ai/devpack/overview');
    expect(reference).toContain('https://docs.z.ai/devpack/teamplan');
    expect(reference).toContain('2026-10-31');
    expect(reference).toContain('Monday to Friday, 14:00–18:00 Singapore Standard Time (UTC+8)');
    expect(reference).toContain('`Asia/Singapore`');
    expect(reference).toContain('multiplier: 1.0');
    expect(reference).toContain('offPeakMultiplier: 0.5');
  });
});
