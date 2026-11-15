import { expect, test } from "@playwright/test";
import { dictionaries } from "../src/shared/i18n/dictionaries";

const { fa, en } = dictionaries;

/**
 * URLs that match no route render `global-not-found.tsx`: a standalone
 * bilingual document, because no locale can be resolved there.
 */
test.describe("global 404 (no matching route)", () => {
  for (const path of ["/fa/does-not-exist", "/en/does-not-exist"]) {
    test(`${path} returns 404 with both languages`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);

      // Persian first, RTL document; English block is explicitly LTR.
      await expect(page.locator("html")).toHaveAttribute("lang", "fa");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.getByRole("heading", { level: 1, name: fa.errors.notFoundTitle })).toBeVisible();

      const english = page.locator('section[lang="en"]');
      await expect(english).toHaveAttribute("dir", "ltr");
      await expect(english.getByRole("heading", { level: 1 })).toHaveText(en.errors.notFoundTitle);
    });
  }

  test("an un-prefixed unknown URL is redirected, then 404s", async ({ page }) => {
    const response = await page.goto("/does-not-exist");
    expect(response?.status()).toBe(404);
    expect(new URL(page.url()).pathname).toBe("/en/does-not-exist"); // default browser locale en-US
  });

  test("the return links lead to each localized home page", async ({ page }) => {
    await page.goto("/en/does-not-exist");
    await page.getByRole("link", { name: en.errors.backHome }).click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.goto("/en/does-not-exist");
    await page.getByRole("link", { name: fa.errors.backHome }).click();
    await expect(page).toHaveURL(/\/fa$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });
});

/**
 * Why these two tests are `fixme` (skipped on purpose, not forgotten):
 * src/app/[locale]/not-found.tsx renders only when a route under [locale]
 * calls notFound(). Phase 0/1 has just the home page, so nothing triggers it
 * and every unknown URL falls through to the global 404 tested above (verified
 * against a production build with 11 different unknown paths).
 *
 * To enable: when the first dynamic route exists (catalog product/category
 * pages) and calls notFound() for a missing slug, change `test.fixme` to `test`
 * and point the URLs at it; /fa/products/does-not-exist is a placeholder.
 */
const blockedBy = {
  annotation: {
    type: "blocked-by",
    description:
      "No route under [locale] calls notFound() yet, so [locale]/not-found.tsx is unreachable; enable with the first dynamic route (catalog).",
  },
};

test.describe("localized 404 (notFound() inside a locale route)", () => {
  test.fixme("renders the Persian 404 with the site header under /fa", blockedBy, async ({ page }) => {
    const response = await page.goto("/fa/products/does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: fa.errors.notFoundTitle })).toBeVisible();
    await expect(page.getByRole("navigation", { name: fa.nav.label })).toBeVisible();
  });

  test.fixme("renders the English 404 with the site header under /en", blockedBy, async ({ page }) => {
    const response = await page.goto("/en/products/does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: en.errors.notFoundTitle })).toBeVisible();
    await expect(page.getByRole("navigation", { name: en.nav.label })).toBeVisible();
  });
});
