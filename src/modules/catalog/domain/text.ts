/**
 * Text and slug normalization for Persian and Latin catalog content (ADR-025).
 *
 * The slug rules mirror the CHECK constraints in drizzle/0003_catalog exactly: lowercase Latin
 * letters, ASCII digits and normalized Persian letters, words joined by single hyphens, at most
 * 160 characters. An integration test checks this module against the database.
 */

export const MAX_SLUG_LENGTH = 160;

const SLUG_CHARS = "a-z0-9\\u0621-\\u0624\\u0626-\\u063A\\u0641\\u0642\\u0644-\\u0648\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC";
const SLUG_PATTERN = new RegExp(`^[${SLUG_CHARS}]+(-[${SLUG_CHARS}]+)*$`);
const NOT_SLUG_CHAR = new RegExp(`[^${SLUG_CHARS}]+`, "g");

/** Arabic letter forms that have a distinct Persian standard form. */
const PERSIAN_LETTERS: Readonly<Record<string, string>> = {
  "ي": "ی", // ي Arabic yeh -> ی
  "ى": "ی", // ى alef maksura -> ی
  "ك": "ک", // ك Arabic kaf -> ک
  "ۀ": "ه", // ۀ heh with yeh above -> ه
  "ة": "ه", // ة teh marbuta -> ه
};

/** Letters with hamza or wasla that slugs fold into their base letter. */
const SLUG_FOLDS: Readonly<Record<string, string>> = {
  "أ": "ا", // أ -> ا
  "إ": "ا", // إ -> ا
  "ٱ": "ا", // ٱ -> ا
  "ؤ": "و", // ؤ -> و
  "ئ": "ی", // ئ -> ی
};

/** Arabic diacritics (harakat, superscript alef) and tatweel; never meaningful in slugs. */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;
const ARABIC_DIGITS = /[٠-٩]/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII. */
export function toAsciiDigits(text: string): string {
  return text
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
}

function replaceLetters(text: string, table: Readonly<Record<string, string>>): string {
  let out = "";
  for (const ch of text) out += table[ch] ?? ch;
  return out;
}

/**
 * Display text (names, labels, alt text): NFC, Arabic yeh/kaf to Persian, collapsed whitespace,
 * trimmed. Keeps ZWNJ (required for correct Persian spelling) and the digits the author typed.
 */
export function normalizeDisplayText(text: string): string {
  return replaceLetters(text.normalize("NFC"), PERSIAN_LETTERS)
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `slug` satisfies the database slug constraint. */
export function isSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * Builds a normalized slug from free text (a name or a typed slug), or null when nothing usable
 * remains. ZWNJ, spaces and punctuation become word separators; Persian digits become ASCII;
 * Latin accents are removed. Over-long slugs are cut at a word boundary.
 */
export function slugify(input: string): string | null {
  // Strip Latin accents only (é -> e). NFKD also splits آ into ا + madda; NFC puts it back.
  let text = input.normalize("NFKD").replace(/[\u0300-\u036F]/g, "").normalize("NFC").toLowerCase();
  text = text.replace(ARABIC_MARKS, "").replace(ZERO_WIDTH, "-").replace(/\u200C/g, "-");
  text = replaceLetters(replaceLetters(toAsciiDigits(text), PERSIAN_LETTERS), SLUG_FOLDS);
  text = text.replace(NOT_SLUG_CHAR, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (text.length > MAX_SLUG_LENGTH) {
    const cut = text.slice(0, MAX_SLUG_LENGTH + 1);
    const boundary = cut.lastIndexOf("-");
    text = (boundary > 0 ? cut.slice(0, boundary) : text.slice(0, MAX_SLUG_LENGTH)).replace(/-$/, "");
  }
  return text.length > 0 && isSlug(text) ? text : null;
}
