import { describe, expect, it } from "vitest";

import { isSlug, MAX_SLUG_LENGTH, normalizeDisplayText, slugify, toAsciiDigits } from "./text";

describe("slugify", () => {
  it.each([
    ["پیراهن مجلسی زنانه", "پیراهن-مجلسی-زنانه"],
    ["پيراهن", "پیراهن"], // Arabic yeh -> Persian ی
    ["كيف چرمی", "کیف-چرمی"], // Arabic kaf -> Persian ک
    ["می‌خواهم", "می-خواهم"], // ZWNJ is a word separator
    ["لباس زیر ۲ تکه", "لباس-زیر-2-تکه"], // Persian digits -> ASCII
    ["مانتو ٣ دکمه", "مانتو-3-دکمه"], // Arabic-Indic digits -> ASCII
    ["آبی آسمانی", "آبی-آسمانی"], // آ survives normalization
    ["خانهٔ مُد", "خانه-مد"], // diacritics and hamza-above removed
    ["Women's Evening Dress", "women-s-evening-dress"],
    ["Robe d'été", "robe-d-ete"], // Latin accents removed
    ["  --Kids__Shoes!!  ", "kids-shoes"],
    ["مانتو - Coat 2030", "مانتو-coat-2030"],
    ["ـــکیفـــ", "کیف"], // tatweel removed
  ])("%s -> %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
    expect(isSlug(expected)).toBe(true);
  });

  it("returns null when nothing usable remains", () => {
    for (const input of ["", "   ", "!!!", "‌‌", "😀"]) expect(slugify(input)).toBeNull();
  });

  it("cuts long slugs at a word boundary within the limit", () => {
    const slug = slugify(Array.from({ length: 40 }, () => "پیراهن").join(" "));
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug!.endsWith("-")).toBe(false);
    expect(slug!.split("-").every((w) => w === "پیراهن")).toBe(true);
  });

  it("is idempotent", () => {
    for (const input of ["پیراهن مجلسی", "Kids' Shoes", "می‌خواهم ۲"]) {
      const once = slugify(input);
      expect(slugify(once!)).toBe(once);
    }
  });
});

describe("isSlug", () => {
  it.each(["پیراهن-مجلسی", "women", "a1", "2030", "زنانه-dresses"])("accepts %s", (slug) => expect(isSlug(slug)).toBe(true));
  it.each([
    "پيراهن", // Arabic yeh
    "می‌خواهم", // ZWNJ
    "پیراهن مجلسی",
    "پیراهن--مجلسی",
    "-پیراهن",
    "پیراهن-",
    "پیراهن-۲", // Persian digit
    "Evening",
    "evening_dress",
    "",
    "x".repeat(MAX_SLUG_LENGTH + 1),
  ])("rejects %s", (slug) => expect(isSlug(slug)).toBe(false));
});

describe("normalizeDisplayText", () => {
  it("maps Arabic letters to Persian, keeps ZWNJ and digits, and collapses whitespace", () => {
    expect(normalizeDisplayText("  پيراهن   كتان‌دار ۲  ")).toBe("پیراهن کتان‌دار ۲");
    expect(normalizeDisplayText("Evening\tdress\n")).toBe("Evening dress");
  });
});

describe("toAsciiDigits", () => {
  it("converts Persian and Arabic-Indic digits", () => {
    expect(toAsciiDigits("۰۱۲۳۴۵۶۷۸۹ ٠١٢٣٤٥٦٧٨٩")).toBe("0123456789 0123456789");
  });
});
