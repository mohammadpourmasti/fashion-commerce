import { expect, test, type Page } from "@playwright/test";
import { getDirection, LOCALE_COOKIE, localeMeta, type Locale } from "../src/shared/i18n/config";
import { dictionaries } from "../src/shared/i18n/dictionaries";

async function expectDocument(page: Page, locale: Locale) {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", locale);
  await expect(html).toHaveAttribute("dir", getDirection(locale));
  // The attribute must also take effect in layout, not just exist.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).direction))
    .toBe(getDirection(locale));
}

function switcher(page: Page, locale: Locale) {
  return page.getByRole("navigation", { name: dictionaries[locale].nav.languageSwitch });
}

test.describe("text direction", () => {
  test("Persian (/fa) is RTL", async ({ page }) => {
    await page.goto("/fa");
    await expectDocument(page, "fa");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(dictionaries.fa.home.title);
  });

  test("English (/en) is LTR", async ({ page }) => {
    await page.goto("/en");
    await expectDocument(page, "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(dictionaries.en.home.title);
  });

  test("the brand link points at the current locale", async ({ page }) => {
    await page.goto("/en");
    await expect(page.getByRole("link", { name: dictionaries.en.brand.name })).toHaveAttribute(
      "href",
      "/en",
    );
  });
});

test.describe("language switching", () => {
  test("marks the current language and links to the other", async ({ page }) => {
    await page.goto("/en");
    const nav = switcher(page, "en");
    await expect(nav.getByRole("link", { name: localeMeta.en.nativeName })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(nav.getByRole("link", { name: localeMeta.fa.nativeName })).toHaveAttribute(
      "href",
      "/fa",
    );
  });

  test("English → Persian flips language, direction and copy", async ({ page }) => {
    await page.goto("/en");
    await switcher(page, "en").getByRole("link", { name: localeMeta.fa.nativeName }).click();

    await expect(page).toHaveURL(/\/fa$/);
    await expectDocument(page, "fa");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(dictionaries.fa.home.title);
  });

  test("Persian → English flips back", async ({ page }) => {
    await page.goto("/fa");
    await switcher(page, "fa").getByRole("link", { name: localeMeta.en.nativeName }).click();

    await expect(page).toHaveURL(/\/en$/);
    await expectDocument(page, "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(dictionaries.en.home.title);
  });

  test("remembers the choice in a cookie and uses it for /", async ({ page, context }) => {
    await page.goto("/en"); // browser default is en-US, so choose Persian explicitly
    await switcher(page, "en").getByRole("link", { name: localeMeta.fa.nativeName }).click();
    await expect(page).toHaveURL(/\/fa$/);

    const cookie = (await context.cookies()).find((c) => c.name === LOCALE_COOKIE);
    expect(cookie?.value).toBe("fa");

    await page.goto("/");
    await expect(page).toHaveURL(/\/fa$/);
  });
});
