/**
 * Stable machine keys, SKUs and barcodes. Each pattern mirrors a CHECK constraint in
 * drizzle/0003_catalog; an integration test checks the two agree.
 */

import { invalid, issue, valid, type Validation } from "./errors";
import { toAsciiDigits } from "./text";

/** categories.key and brands.key */
export const CATEGORY_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,62}$/;
export const BRAND_KEY_PATTERN = CATEGORY_KEY_PATTERN;
/** attributes.key */
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;
/** attribute_values.key */
export const VALUE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** variants.sku */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const SWATCH_PATTERN = /^#([0-9A-F]{3}|[0-9A-F]{6})$/;

export type KeyKind = "category" | "brand" | "attribute" | "value";

const KEY_PATTERNS: Readonly<Record<KeyKind, RegExp>> = {
  category: CATEGORY_KEY_PATTERN,
  brand: BRAND_KEY_PATTERN,
  attribute: ATTRIBUTE_KEY_PATTERN,
  value: VALUE_KEY_PATTERN,
};

/** Trims and lower-cases a key; keys are never transliterated or otherwise rewritten. */
export function parseKey(kind: KeyKind, raw: string, path = "key"): Validation<string> {
  const key = raw.trim().toLowerCase();
  return KEY_PATTERNS[kind].test(key) ? valid(key) : invalid([issue("invalid_key", path, { kind })]);
}

/** Trims, converts Persian digits and upper-cases. SKUs are required (ADR-024). */
export function parseSku(raw: string, path = "sku"): Validation<string> {
  const sku = toAsciiDigits(raw.normalize("NFKC")).trim().toUpperCase();
  return SKU_PATTERN.test(sku) ? valid(sku) : invalid([issue("invalid_sku", path)]);
}

/** GTIN-8, GTIN-12 (UPC-A), GTIN-13 (EAN-13) or GTIN-14 with a valid mod-10 check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  let sum = 0;
  // Walk right to left, skipping the check digit; weights alternate 3, 1, 3, ...
  for (let i = code.length - 2, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}

/**
 * Optional barcode: blank means none. Spaces and hyphens are removed and Persian digits
 * converted before the GTIN check.
 */
export function parseBarcode(raw: string | null | undefined, path = "barcode"): Validation<string | null> {
  if (raw === null || raw === undefined) return valid(null);
  const code = toAsciiDigits(raw.normalize("NFKC")).replace(/[\s-]/g, "");
  if (code === "") return valid(null);
  return isValidGtin(code) ? valid(code) : invalid([issue("invalid_barcode", path)]);
}

/** "#abc" or "#AABBCC" (any case) to the stored "#AABBCC" form; blank means no swatch. */
export function parseSwatch(raw: string | null | undefined, path = "swatchHex"): Validation<string | null> {
  if (raw === null || raw === undefined || raw.trim() === "") return valid(null);
  const hex = raw.trim().toUpperCase();
  if (!SWATCH_PATTERN.test(hex)) return invalid([issue("invalid_swatch", path)]);
  const digits = hex.slice(1);
  return valid(`#${digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits}`);
}
