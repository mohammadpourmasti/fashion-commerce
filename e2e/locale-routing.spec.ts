import { expect, test } from "@playwright/test";
import { defaultLocale, LOCALE_COOKIE } from "../src/shared/i18n/config";

/** `locale` sets the browser's Accept-Language header. */
test.describe("default locale redirect", () => {
  test.describe("browser prefers English", () => {
    test.use({ locale: "en-US" });

    test("/ redirects to /en", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/en$/);
    });

    test("an un-prefixed path keeps its path under the locale", async ({ page }) => {
      const response = await page.goto("/some-page");
      expect(new URL(page.url()).pathname).toBe("/en/some-page");
      expect(response?.status()).toBe(404); // no such route yet; see 404 tests
    });
  });

  test.describe("browser prefers Persian", () => {
    test.use({ locale: "fa-IR" });

    test("/ redirects to /fa", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/fa$/);
    });
  });

  test.describe("browser prefers an unsupported language", () => {
    test.use({ locale: "ar" });

    test(`/ falls back to the default locale (${defaultLocale})`, async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(new RegExp(`/${defaultLocale}$`));
    });
  });

  test.describe("saved locale cookie", () => {
    test.use({ locale: "fa-IR" });

    test("takes precedence over Accept-Language", async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: LOCALE_COOKIE, value: "en", url: baseURL! }]);
      await page.goto("/");
      await expect(page).toHaveURL(/\/en$/);
    });

    test("an invalid cookie value is ignored", async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: LOCALE_COOKIE, value: "xx", url: baseURL! }]);
      await page.goto("/");
      await expect(page).toHaveURL(/\/fa$/);
    });
  });
});
