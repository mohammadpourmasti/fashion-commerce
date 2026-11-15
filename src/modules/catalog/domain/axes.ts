/**
 * Variant axes of one product (ADR-024): at most three, in positions 1..n, each a distinct,
 * active `variant_axis` attribute, and at most one colour axis per product. The database
 * enforces most of this; the one-colour-axis rule exists only here, by design.
 * Once a product has variants its axis structure is frozen; values can still be added.
 */

import type { AttributeRecord, ValueRecord } from "./attributes";
import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";

export const MAX_VARIANT_AXES = 3;

export interface ProductAxis {
  readonly position: number;
  readonly attributeId: string;
}

/**
 * Checks an ordered list of axis attribute ids and returns the axes with positions 1..n.
 * `attributes` must contain every referenced attribute that exists.
 */
export function planAxes(attributes: ReadonlyMap<string, AttributeRecord>, attributeIds: readonly string[]): Validation<ProductAxis[]> {
  const issues: CatalogIssue[] = [];
  if (attributeIds.length > MAX_VARIANT_AXES) issues.push(issue("too_many_axes", "axes", { max: MAX_VARIANT_AXES }));

  const seen = new Set<string>();
  let colorAxes = 0;
  attributeIds.forEach((attributeId, index) => {
    const path = `axes[${index}]`;
    const attribute = attributes.get(attributeId);
    if (seen.has(attributeId)) return void issues.push(issue("duplicate_axis", path));
    seen.add(attributeId);
    if (!attribute) return void issues.push(issue("attribute_not_found", path));
    if (attribute.usage !== "variant_axis" || attribute.valueType !== "select" || attribute.axisKind === null) {
      return void issues.push(issue("not_an_axis_attribute", path));
    }
    if (attribute.status !== "active") return void issues.push(issue("attribute_archived", path));
    if (attribute.axisKind === "color") colorAxes += 1;
  });
  if (colorAxes > 1) issues.push(issue("multiple_color_axes", "axes"));

  return issues.length > 0 ? invalid(issues) : valid(attributeIds.map((attributeId, i) => ({ position: i + 1, attributeId })));
}

const sameStructure = (a: readonly ProductAxis[], b: readonly ProductAxis[]) =>
  a.length === b.length && a.every((axis, i) => axis.position === b[i]?.position && axis.attributeId === b[i]?.attributeId);

/** Replacing a product's axes: allowed only while it has no variants, or when nothing changes. */
export function validateAxisChange(current: readonly ProductAxis[], next: readonly ProductAxis[], variantCount: number): Validation<ProductAxis[]> {
  if (variantCount > 0 && !sameStructure(current, next)) return invalid([issue("axes_frozen", "axes", { variants: variantCount })]);
  return valid([...next]);
}

/** The colour axis of a product, if it has one. */
export function colorAxisOf(attributes: ReadonlyMap<string, AttributeRecord>, axes: readonly ProductAxis[]): ProductAxis | null {
  return axes.find((axis) => attributes.get(axis.attributeId)?.axisKind === "color") ?? null;
}

/**
 * Values to offer on one axis: each must exist, belong to the axis attribute, be active and
 * not be offered twice. Already-offered values are skipped, so adding values is idempotent.
 */
export function planAxisValues(
  axis: ProductAxis,
  values: ReadonlyMap<string, ValueRecord>,
  alreadyOffered: ReadonlySet<string>,
  valueIds: readonly string[],
): Validation<string[]> {
  const issues: CatalogIssue[] = [];
  const added: string[] = [];
  const seen = new Set<string>();
  valueIds.forEach((valueId, index) => {
    const path = `values[${index}]`;
    const value = values.get(valueId);
    if (seen.has(valueId)) return void issues.push(issue("duplicate_value", path));
    seen.add(valueId);
    if (!value) return void issues.push(issue("value_not_found", path));
    if (value.attributeId !== axis.attributeId) return void issues.push(issue("value_not_in_attribute", path, { position: axis.position }));
    if (alreadyOffered.has(valueId)) return;
    if (value.status !== "active") return void issues.push(issue("value_archived", path));
    added.push(valueId);
  });
  return issues.length > 0 ? invalid(issues) : valid(added);
}
