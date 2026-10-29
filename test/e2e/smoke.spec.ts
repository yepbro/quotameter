import { expect, test } from "@playwright/test";

/**
 * Smoke test: opens the built UI and asserts its initial page (spec §17.1).
 * When the real interface arrives, this test keeps guarding the most basic
 * contract — the page loads and renders the application shell.
 */
test("opens the application shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/Quotameter/);
  await expect(page.getByRole("heading", { name: "Quotameter" })).toBeVisible();
  await expect(page.getByTestId("app-status")).toContainText("not implemented yet");
});
