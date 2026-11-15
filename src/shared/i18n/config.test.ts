import { describe, expect, it } from "vitest";
import {
  defaultLocale,
  getDirection,
  isLocale,
  LOCALE_COOKIE,
  localeMeta,
  locales,
  switchLocalePath,
} from "./config";

describe("locale configuration", () => {
  it("supports Persian and English with Persian as the default", () => {
    expect([...locales]).toEqual(["fa", "en"]);
    expect(defaultLocale).toBe("fa");
    expect(locales).toContain(defaultLocale);
  });

  it("uses the NEXT_LOCALE cookie name", () => {
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });

  it("declares complete metadata for every locale", () => {
    for (const locale of locales) {
      const meta = localeMeta[locale];
      expect(["rtl", "ltr"]).toContain(meta.dir);
      expect(meta.intl).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(meta.nativeName.length).toBeGreaterThan(0);
    }
  });

  it("maps Persian to RTL and English to LTR", () => {
    expect(getDirection("fa")).toBe("rtl");
    expect(getDirection("en")).toBe("ltr");
  });

  it("recognises only supported locales", () => {
    expect(isLocale("fa")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ar")).toBe(false);
    expect(isLocale("FA")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale("fa-IR")).toBe(false);
  });
});

describe("switchLocalePath", () => {
  it("replaces the leading locale segment", () => {
    expect(switchLocalePath("/fa", "en")).toBe("/en");
    expect(switchLocalePath("/en", "fa")).toBe("/fa");
    expect(switchLocalePath("/fa/products/shoes", "en")).toBe("/en/products/shoes");
  });

  it("keeps the same locale when the target equals the current one", () => {
    expect(switchLocalePath("/en/cart", "en")).toBe("/en/cart");
  });

  it("preserves a trailing slash", () => {
    expect(switchLocalePath("/fa/", "en")).toBe("/en/");
  });

  it("adds the locale when the path has no locale prefix", () => {
    expect(switchLocalePath("/", "fa")).toBe("/fa");
    expect(switchLocalePath("/", "en")).toBe("/en");
    expect(switchLocalePath("/cart", "en")).toBe("/en/cart");
    expect(switchLocalePath("", "en")).toBe("/en");
  });

  it("treats an unsupported first segment as part of the path", () => {
    expect(switchLocalePath("/xx/cart", "en")).toBe("/en/xx/cart");
  });

  it("only replaces the first segment, not later locale-like segments", () => {
    expect(switchLocalePath("/fa/en", "en")).toBe("/en/en");
  });
});
