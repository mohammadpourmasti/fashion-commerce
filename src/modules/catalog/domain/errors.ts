/**
 * Validation outcome shared by the catalog domain. Domain functions never throw for invalid
 * input: they return every issue they find, so the application layer can report them together.
 */

export type CatalogIssueCode =
  // lookups and uniqueness (application layer)
  | "not_found"
  | "key_taken"
  | "slug_taken"
  | "invalid_order"
  | "version_conflict"
  | "product_archived"
  | "brand_not_found"
  // text, slugs and keys
  | "invalid_locale"
  | "invalid_name"
  | "text_too_long"
  | "invalid_slug"
  | "invalid_key"
  | "invalid_swatch"
  | "duplicate_locale"
  // SKU and barcode
  | "invalid_sku"
  | "invalid_barcode"
  | "duplicate_sku"
  | "duplicate_barcode"
  // categories
  | "category_not_found"
  | "category_archived"
  | "category_cycle"
  | "category_too_deep"
  | "category_has_active_children"
  // attributes
  | "invalid_attribute_definition"
  | "attribute_not_found"
  | "attribute_archived"
  | "attribute_in_use"
  | "attribute_not_descriptive"
  | "attribute_type_mismatch"
  | "value_not_found"
  | "value_archived"
  | "value_not_in_attribute"
  | "duplicate_value"
  | "invalid_number"
  | "missing_text"
  // axes and variants
  | "too_many_axes"
  | "not_an_axis_attribute"
  | "duplicate_axis"
  | "multiple_color_axes"
  | "axes_frozen"
  | "wrong_value_count"
  | "value_not_offered"
  | "duplicate_combination"
  | "too_many_variants"
  // media and images
  | "invalid_asset"
  | "invalid_view"
  | "invalid_position"
  | "duplicate_position"
  | "duplicate_asset"
  | "color_link_incomplete"
  | "not_a_color_axis"
  | "color_not_offered"
  // publishing and lifecycle
  | "invalid_transition"
  | "missing_required_translation"
  | "no_active_variant"
  | "no_image"
  | "brand_archived"
  | "axes_incomplete";

export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  /** Where the issue is, e.g. "translations.fa.slug" or "variants[2].sku". */
  readonly path?: string;
  /** Safe, non-personal context for messages (limits, offending keys). */
  readonly detail?: Readonly<Record<string, string | number>>;
}

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly CatalogIssue[] };

export const valid = <T>(value: T): Validation<T> => ({ ok: true, value });

export const invalid = <T = never>(issues: readonly CatalogIssue[]): Validation<T> => ({ ok: false, issues });

export const issue = (code: CatalogIssueCode, path?: string, detail?: Record<string, string | number>): CatalogIssue =>
  detail ? { code, path, detail } : path ? { code, path } : { code };

/** `valid(value)` when there are no issues, otherwise `invalid(issues)`. */
export const result = <T>(issues: readonly CatalogIssue[], value: T): Validation<T> => (issues.length === 0 ? valid(value) : invalid(issues));
