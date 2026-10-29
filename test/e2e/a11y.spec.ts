import { expect, test } from "@playwright/test";
import { assertNoAccessibilityViolations } from "./helpers/a11y";

/**
 * Accessibility smoke test: the application shell must not introduce
 * WCAG violations. Real pages gain their own scans as they are implemented.
 */
test("application shell has no WCAG violations", async ({ page }) => {
  await page.goto("/");
  await assertNoAccessibilityViolations(page);

  // Sanity check that the scan actually ran against rendered content.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quotameter");
});
