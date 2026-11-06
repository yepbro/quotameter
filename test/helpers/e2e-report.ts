import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The env slice the E2E JUnit report resolution reads. */
export type E2eReportEnv = { CI?: string | undefined; REPORTS_DIR?: string | undefined };

/**
 * Resolve the Playwright CI JUnit report's output file (consumed by
 * `playwright.config.ts`; pinned by `test/unit/playwright-junit-path.spec.ts`,
 * task U-034).
 *
 * The XML is a CI/report artifact, not a run artifact: it lands in the same
 * `REPORTS_DIR` the Vitest JUnit uses (package.json `test:ci`), which the
 * container points at the isolated data volume so container runs never
 * write into the bind-mounted repository tree (docs/agents/environment.md —
 * the container uid invariant). The relative default keeps host and CI runs
 * on the pre-U-034 `reports/` path, so the CI workflow is unchanged.
 *
 * The directory is created at resolution time exactly like the sibling
 * tools (`scripts/check-licenses.mjs`): a `REPORTS_DIR` that cannot be
 * created fails the run at startup instead of after the whole suite has
 * run (Playwright's junit reporter only mkdirs at `onEnd`, when it
 * writes). An existing but read-only directory is still only caught at
 * write time — the same limitation as the sibling tools.
 */
export function resolveE2eJunitOutputFile(env: E2eReportEnv = process.env): string {
  const reportsDir = env.REPORTS_DIR ?? 'reports';
  if (env.CI) {
    mkdirSync(reportsDir, { recursive: true });
  }
  return join(reportsDir, 'e2e-junit.xml');
}
