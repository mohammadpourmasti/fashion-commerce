/**
 * Variant combinations (ADR-024): one offered value per axis, each combination once, at most
 * 100 variants per product, SKUs and barcodes unique within the set. Variants are never deleted,
 * so the cap counts discontinued ones too.
 */

import { parseBarcode, parseSku } from "./codes";
import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";

export const MAX_VARIANTS_PER_PRODUCT = 100;

/** Values per axis position: offered[0] holds the values offered on axis 1, and so on. */
export type OfferedValues = readonly ReadonlySet<string>[];

/** Stable identity of a combination; a product without axes has the single key "". */
export const combinationKey = (values: readonly string[]): string => values.join("|");

/** Every combination of the given value lists, in order (Cartesian product). No axes -> one empty combination. */
export function cartesian(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap((prefix) => list.map((value) => [...prefix, value])), [[]]);
}

export interface ExistingVariant {
  readonly sku: string;
  readonly barcode: string | null;
  readonly values: readonly string[];
}

export interface VariantInput {
  readonly sku: string;
  readonly barcode?: string | null;
  /** One value per axis, in axis order. */
  readonly values: readonly string[];
}

export interface PlannedVariant {
  readonly sku: string;
  readonly barcode: string | null;
  readonly values: readonly string[];
}

/**
 * Validates new variants against the product's axes, its offered values and its existing
 * variants. Global SKU/barcode uniqueness is enforced by the database; this catches clashes
 * within the product first so they can be reported per row.
 */
export function planVariants(offered: OfferedValues, existing: readonly ExistingVariant[], inputs: readonly VariantInput[]): Validation<PlannedVariant[]> {
  const issues: CatalogIssue[] = [];
  const planned: PlannedVariant[] = [];
  const combinations = new Set(existing.map((v) => combinationKey(v.values)));
  const skus = new Set(existing.map((v) => v.sku));
  const barcodes = new Set(existing.flatMap((v) => (v.barcode ? [v.barcode] : [])));

  if (existing.length + inputs.length > MAX_VARIANTS_PER_PRODUCT) {
    issues.push(issue("too_many_variants", "variants", { max: MAX_VARIANTS_PER_PRODUCT }));
  }

  inputs.forEach((input, index) => {
    const path = `variants[${index}]`;
    const rowIssues: CatalogIssue[] = [];

    const sku = parseSku(input.sku, `${path}.sku`);
    if (!sku.ok) rowIssues.push(...sku.issues);
    else if (skus.has(sku.value)) rowIssues.push(issue("duplicate_sku", `${path}.sku`));

    const barcode = parseBarcode(input.barcode, `${path}.barcode`);
    if (!barcode.ok) rowIssues.push(...barcode.issues);
    else if (barcode.value !== null && barcodes.has(barcode.value)) rowIssues.push(issue("duplicate_barcode", `${path}.barcode`));

    if (input.values.length !== offered.length) {
      rowIssues.push(issue("wrong_value_count", `${path}.values`, { expected: offered.length }));
    } else {
      input.values.forEach((valueId, position) => {
        if (!offered[position]?.has(valueId)) rowIssues.push(issue("value_not_offered", `${path}.values[${position}]`, { position: position + 1 }));
      });
      if (combinations.has(combinationKey(input.values))) rowIssues.push(issue("duplicate_combination", `${path}.values`));
    }

    if (rowIssues.length > 0 || !sku.ok || !barcode.ok) return void issues.push(...rowIssues);
    combinations.add(combinationKey(input.values));
    skus.add(sku.value);
    if (barcode.value) barcodes.add(barcode.value);
    planned.push({ sku: sku.value, barcode: barcode.value, values: [...input.values] });
  });

  return issues.length > 0 ? invalid(issues) : valid(planned);
}

/**
 * The combinations not yet covered by a variant, for "generate the matrix" in the admin.
 * Refuses when the full matrix would exceed the per-product cap.
 */
export function missingCombinations(offered: readonly (readonly string[])[], existing: readonly ExistingVariant[]): Validation<string[][]> {
  const total = offered.reduce((n, list) => n * list.length, 1);
  if (total > MAX_VARIANTS_PER_PRODUCT) return invalid([issue("too_many_variants", "variants", { max: MAX_VARIANTS_PER_PRODUCT, requested: total })]);
  const have = new Set(existing.map((v) => combinationKey(v.values)));
  return valid(cartesian(offered).filter((values) => !have.has(combinationKey(values))));
}
