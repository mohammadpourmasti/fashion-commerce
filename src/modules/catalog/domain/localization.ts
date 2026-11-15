/**
 * Per-locale catalog content (ADR-025). Limits mirror the translation tables' CHECK
 * constraints; Persian is required to publish, English is optional.
 */

import { isLocale, type Locale } from "@/shared/i18n/config";

import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";
import { isSlug, normalizeDisplayText, slugify } from "./text";

export const REQUIRED_LOCALE: Locale = "fa";

export type TranslationKind = "category" | "brand" | "product" | "attribute" | "value" | "image" | "text_value";

interface Limits {
  readonly name: number;
  readonly slug: boolean;
  readonly description?: number;
  readonly seo?: boolean;
}

/** What each kind of translation carries. `name` is the label, alt text or text value. */
export const TRANSLATION_LIMITS: Readonly<Record<TranslationKind, Limits>> = {
  category: { name: 120, slug: true, description: 5000, seo: true },
  brand: { name: 120, slug: true, description: 5000 },
  product: { name: 200, slug: true, description: 10000, seo: true },
  attribute: { name: 120, slug: false },
  value: { name: 120, slug: false },
  image: { name: 250, slug: false },
  text_value: { name: 500, slug: false },
};

export const SEO_TITLE_MAX = 120;
export const SEO_DESCRIPTION_MAX = 320;

export interface TranslationInput {
  readonly locale: string;
  readonly name: string;
  /** Optional for sluggable kinds: derived from the name when omitted. */
  readonly slug?: string | null;
  readonly description?: string | null;
  readonly seoTitle?: string | null;
  readonly seoDescription?: string | null;
}

export interface Translation {
  readonly locale: Locale;
  readonly name: string;
  readonly slug: string | null;
  readonly description: string;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
}

const optionalText = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return null;
  const text = normalizeDisplayText(raw);
  return text === "" ? null : text;
};

/** Normalizes one translation and reports every problem with it. */
export function parseTranslation(kind: TranslationKind, input: TranslationInput, path = `translations.${input.locale}`): Validation<Translation> {
  const limits = TRANSLATION_LIMITS[kind];
  const issues: CatalogIssue[] = [];

  if (!isLocale(input.locale)) issues.push(issue("invalid_locale", `${path}.locale`));

  const name = normalizeDisplayText(input.name);
  if (name.length === 0) issues.push(issue("invalid_name", `${path}.name`));
  else if (name.length > limits.name) issues.push(issue("text_too_long", `${path}.name`, { max: limits.name }));

  let slug: string | null = null;
  if (limits.slug) {
    const typed = input.slug?.trim();
    slug = typed ? slugify(typed) : slugify(name);
    if (slug === null || !isSlug(slug)) issues.push(issue("invalid_slug", `${path}.slug`));
  }

  // Descriptions keep their line breaks; only the ends are trimmed.
  const description = limits.description ? (input.description ?? "").normalize("NFC").trim() : "";
  if (limits.description && description.length > limits.description) {
    issues.push(issue("text_too_long", `${path}.description`, { max: limits.description }));
  }

  const seoTitle = limits.seo ? optionalText(input.seoTitle) : null;
  const seoDescription = limits.seo ? optionalText(input.seoDescription) : null;
  if (seoTitle && seoTitle.length > SEO_TITLE_MAX) issues.push(issue("text_too_long", `${path}.seoTitle`, { max: SEO_TITLE_MAX }));
  if (seoDescription && seoDescription.length > SEO_DESCRIPTION_MAX) {
    issues.push(issue("text_too_long", `${path}.seoDescription`, { max: SEO_DESCRIPTION_MAX }));
  }

  if (issues.length > 0) return invalid(issues);
  return valid({ locale: input.locale as Locale, name, slug, description, seoTitle, seoDescription });
}

/** Parses a set of translations: one per locale, each valid. */
export function parseTranslations(kind: TranslationKind, inputs: readonly TranslationInput[], path = "translations"): Validation<Translation[]> {
  const issues: CatalogIssue[] = [];
  const out: Translation[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    if (seen.has(input.locale)) issues.push(issue("duplicate_locale", `${path}[${index}].locale`));
    seen.add(input.locale);
    const parsed = parseTranslation(kind, input, `${path}[${index}]`);
    if (parsed.ok) out.push(parsed.value);
    else issues.push(...parsed.issues);
  });
  return issues.length > 0 ? invalid(issues) : valid(out);
}

/** True when the required (Persian) translation is present. */
export const hasRequiredLocale = (locales: Iterable<string>): boolean => new Set(locales).has(REQUIRED_LOCALE);
