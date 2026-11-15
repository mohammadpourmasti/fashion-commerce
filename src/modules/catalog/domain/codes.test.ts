import { describe, expect, it } from "vitest";

import { isValidGtin, parseBarcode, parseKey, parseSku, parseSwatch } from "./codes";

describe("parseSku", () => {
  it.each([
    ["drs-s-red", "DRS-S-RED"],
    ["  abc ", "ABC"],
    ["sku-۱۲۳", "SKU-123"], // Persian digits -> ASCII
    ["A".repeat(40), "A".repeat(40)],
  ])("normalizes %s to %s", (raw, sku) => expect(parseSku(raw)).toEqual({ ok: true, value: sku }));

  it.each(["", "AB", "-ABC", "AB C", "A_B_C", "پیراهن", "A".repeat(41)])("rejects %s", (raw) => {
    expect(parseSku(raw)).toEqual({ ok: false, issues: [{ code: "invalid_sku", path: "sku" }] });
  });
});

describe("GTIN", () => {
  it.each(["96385074", "036000291452", "4006381333931", "10614141000415", "0000000000000"])("accepts %s", (code) => expect(isValidGtin(code)).toBe(true));
  it.each(["96385075", "036000291453", "4006381333932", "1234567", "123456789", "12345678901", "40063813339A1", "400638133393100", ""])("rejects %s", (code) =>
    expect(isValidGtin(code)).toBe(false),
  );

  it("parseBarcode treats blank as none and strips separators and Persian digits", () => {
    expect(parseBarcode(null)).toEqual({ ok: true, value: null });
    expect(parseBarcode("   ")).toEqual({ ok: true, value: null });
    expect(parseBarcode("400 6381 33393-1")).toEqual({ ok: true, value: "4006381333931" });
    expect(parseBarcode("۴۰۰۶۳۸۱۳۳۳۹۳۱")).toEqual({ ok: true, value: "4006381333931" });
    expect(parseBarcode("4006381333932")).toEqual({ ok: false, issues: [{ code: "invalid_barcode", path: "barcode" }] });
  });
});

describe("parseKey", () => {
  it("lower-cases and checks the pattern of each key kind", () => {
    expect(parseKey("category", " Women-Dresses ")).toEqual({ ok: true, value: "women-dresses" });
    expect(parseKey("attribute", "size_women")).toEqual({ ok: true, value: "size_women" });
    expect(parseKey("value", "75b")).toEqual({ ok: true, value: "75b" });
    expect(parseKey("attribute", "size-women").ok).toBe(false); // hyphen not allowed in attribute keys
    expect(parseKey("category", "1women").ok).toBe(false);
    expect(parseKey("category", "w").ok).toBe(false);
    expect(parseKey("value", "-s").ok).toBe(false);
    expect(parseKey("brand", "برند").ok).toBe(false);
  });
});

describe("parseSwatch", () => {
  it("expands and upper-cases hex colours; blank means none", () => {
    expect(parseSwatch("#c0ffee")).toEqual({ ok: true, value: "#C0FFEE" });
    expect(parseSwatch("#abc")).toEqual({ ok: true, value: "#AABBCC" });
    expect(parseSwatch("")).toEqual({ ok: true, value: null });
    expect(parseSwatch("red").ok).toBe(false);
    expect(parseSwatch("#abcd").ok).toBe(false);
  });
});
