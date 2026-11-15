import { describe, expect, it } from "vitest";

import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("trims, lower-cases and NFKC-normalizes", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com");
    expect(normalizeEmail("ａｄｍｉｎ@example.com")).toBe("admin@example.com");
  });

  it.each([
    "", "a", "no-at.example.com", "two@@example.com", "a@b@example.com", "@example.com", "a@", "a@nodot",
    "a@.example.com", "a@example.com.", "a@exa..mple.com", "with space@example.com", "tab\t@example.com",
    "nul\u0000@example.com", `${"x".repeat(65)}@example.com`, `a@${"d".repeat(250)}.com`,
  ])("rejects %j", (value) => {
    expect(normalizeEmail(value)).toBeNull();
  });

  it("rejects non-strings and absurd input without throwing", () => {
    expect(normalizeEmail(undefined as unknown as string)).toBeNull();
    expect(normalizeEmail("x".repeat(100_000))).toBeNull();
  });
});
