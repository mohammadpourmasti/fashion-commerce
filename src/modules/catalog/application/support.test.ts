import { describe, expect, it } from "vitest";

import { mapUniqueViolations, requireRequiredLocale, uniqueViolationIssue } from "./support";

const pgError = (code: string, constraint?: string) => Object.assign(new Error("db"), { code, constraint });
const translation = (locale: "fa" | "en") => ({ locale, name: "n", slug: null, description: "", seoTitle: null, seoDescription: null });

describe("uniqueViolationIssue", () => {
  it("maps known catalog unique constraints to issues", () => {
    expect(uniqueViolationIssue(pgError("23505", "categories_key_unique"))).toEqual({ code: "key_taken", path: "key" });
    expect(uniqueViolationIssue(pgError("23505", "attribute_values_key_unique"))).toEqual({ code: "key_taken", path: "key" });
    expect(uniqueViolationIssue(pgError("23505", "brand_translations_slug_unique"))).toEqual({ code: "slug_taken", path: "translations" });
  });

  it("finds the database error behind Drizzle's query wrapper", () => {
    const wrapped = Object.assign(new Error("Failed query: insert ..."), { cause: pgError("23505", "product_translations_slug_unique") });
    expect(uniqueViolationIssue(wrapped)).toEqual({ code: "slug_taken", path: "translations" });
  });

  it("ignores other errors and unknown constraints", () => {
    expect(uniqueViolationIssue(pgError("23505", "users_email_normalized_unique"))).toBeNull();
    expect(uniqueViolationIssue(pgError("23503", "categories_key_unique"))).toBeNull();
    expect(uniqueViolationIssue(new Error("boom"))).toBeNull();
  });
});

describe("mapUniqueViolations", () => {
  it("turns a lost uniqueness race into an issue and rethrows anything else", async () => {
    await expect(mapUniqueViolations(() => Promise.reject(pgError("23505", "brands_key_unique")))).resolves.toEqual({ ok: false, issues: [{ code: "key_taken", path: "key" }] });
    await expect(mapUniqueViolations(() => Promise.reject(pgError("40001")))).rejects.toThrow("db");
    await expect(mapUniqueViolations(() => Promise.resolve({ ok: true as const, value: 1 }))).resolves.toEqual({ ok: true, value: 1 });
  });
});

describe("requireRequiredLocale", () => {
  it("requires a Persian translation", () => {
    expect(requireRequiredLocale([translation("fa")])).toEqual([]);
    expect(requireRequiredLocale([translation("en")])).toEqual([{ code: "missing_required_translation", path: "translations", detail: { locale: "fa" } }]);
  });
});
