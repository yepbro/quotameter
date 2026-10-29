import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Accessibility checking helper (spec §14.1, §17.1).
 *
 * Wraps axe-core for browser tests: scans the page currently open in the
 * browser context against WCAG 2.1/2.2 AA rules and turns violations into
 * readable test failures. Use on every page-level E2E scenario as the UI
 * grows: `await assertNoAccessibilityViolations(page)`.
 */
export interface AccessibilityViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

export async function scanPageAccessibility(page: Page): Promise<AccessibilityViolation[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

/** Fails the current test with a readable report when violations are found. */
export async function assertNoAccessibilityViolations(page: Page): Promise<void> {
  const violations = await scanPageAccessibility(page);
  const report = violations
    .map((v) => `- [${v.impact ?? 'unknown'}] ${v.id}: ${v.help} (${v.nodes.join(', ')})`)
    .join('\n');
  if (violations.length > 0) {
    throw new Error(`Accessibility violations found:\n${report}`);
  }
}
