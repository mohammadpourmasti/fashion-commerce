import { describe, expect, it } from "vitest";

import { hasRequiredLocale, parseTranslation, parseTranslations, REQUIRED_LOCALE } from "./localization";

describe("parseTranslation", () => {
  it("normalizes a Persian product translation and derives the slug from the name", () => {
    expect(parseTranslation("product", { locale: "fa", name: "  پيراهن   مجلسی  ", description: "  پارچه کتان\nدوخت دست  " })).toEqual({
      ok: true,
      value: { locale: "fa", name: "پیراهن مجلسی", slug: "پیراهن-مجلسی", description: "پارچه کتان\nدوخت دست", seoTitle: null, seoDescription: null },
    });
  });

  it("normalizes a typed slug instead of deriving one", () => {
    const parsed = parseTranslation("category", { locale: "en", name: "Women", slug: "Women's Wear" });
    expect(parsed.ok && parsed.value.slug).toBe("women-s-wear");
  });

  it("reports every problem at once", () => {
    const parsed = parseTranslation("product", {
      locale: "de",
      name: "   ",
      slug: "!!!",
      description: "x".repeat(10001),
      seoTitle: "t".repeat(121),
      seoDescription: "d".repeat(321),
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issues.map((i) => i.code)).toEqual(["invalid_locale", "invalid_name", "invalid_slug", "text_too_long", "text_too_long", "text_too_long"]);
  });

  it("applies per-kind limits and only gives slugs to sluggable kinds", () => {
    expect(parseTranslation("category", { locale: "fa", name: "ن".repeat(121) }).ok).toBe(false);
    expect(parseTranslation("product", { locale: "fa", name: "ن".repeat(200) }).ok).toBe(true);
    const value = parseTranslation("value", { locale: "fa", name: "قرمز", slug: "ignored" });
    expect(value.ok && value.value.slug).toBeNull();
    const alt = parseTranslation("image", { locale: "fa", name: "ن".repeat(251) });
    expect(!alt.ok && alt.issues[0]?.code).toBe("text_too_long");
    const seo = parseTranslation("brand", { locale: "en", name: "House", seoTitle: "ignored" });
    expect(seo.ok && seo.value.seoTitle).toBeNull();
  });
});

describe("parseTranslations", () => {
  it("allows one translation per configured locale", () => {
    const parsed = parseTranslations("attribute", [
      { locale: "fa", name: "رنگ" },
      { locale: "en", name: "Colour" },
      { locale: "fa", name: "رنگ دوم" },
    ]);
    expect(!parsed.ok && parsed.issues).toEqual([{ code: "duplicate_locale", path: "translations[2].locale" }]);
  });
});

describe("required locale", () => {
  it("is Persian; English is optional", () => {
    expect(REQUIRED_LOCALE).toBe("fa");
    expect(hasRequiredLocale(["fa"])).toBe(true);
    expect(hasRequiredLocale(["fa", "en"])).toBe(true);
    expect(hasRequiredLocale(["en"])).toBe(false);
    expect(hasRequiredLocale([])).toBe(false);
  });
});
