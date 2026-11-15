/**
 * Attribute definitions and typed descriptive values (ADR-024, refinement A).
 * Axis attributes are always `select` and carry an axis kind; descriptive attributes may be
 * select, text, number or boolean and never have an axis kind.
 */

import { parseKey } from "./codes";
import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";
import { parseTranslations, type Translation, type TranslationInput } from "./localization";
import { toAsciiDigits } from "./text";

export const ATTRIBUTE_USAGES = ["variant_axis", "descriptive"] as const;
export const ATTRIBUTE_VALUE_TYPES = ["select", "text", "number", "boolean"] as const;
export const AXIS_KINDS = ["color", "size", "other"] as const;

export type AttributeUsage = (typeof ATTRIBUTE_USAGES)[number];
export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];
export type AxisKind = (typeof AXIS_KINDS)[number];

const UNIT_PATTERN = /^[a-z%]{1,16}$/;

export interface AttributeDefinitionInput {
  readonly key: string;
  readonly usage: string;
  readonly valueType: string;
  readonly axisKind?: string | null;
  readonly unit?: string | null;
}

export interface AttributeDefinition {
  readonly key: string;
  readonly usage: AttributeUsage;
  readonly valueType: AttributeValueType;
  readonly axisKind: AxisKind | null;
  readonly unit: string | null;
}

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** Mirrors the attributes CHECK constraints and normalizes the key and unit. */
export function parseAttributeDefinition(input: AttributeDefinitionInput): Validation<AttributeDefinition> {
  const issues: CatalogIssue[] = [];
  const key = parseKey("attribute", input.key);
  if (!key.ok) issues.push(...key.issues);

  const usage = input.usage;
  const valueType = input.valueType;
  const axisKind = input.axisKind ?? null;
  const unit = input.unit?.trim() ? input.unit.trim().toLowerCase() : null;
  const bad = (path: string, reason: string) => issues.push(issue("invalid_attribute_definition", path, { reason }));

  if (!isOneOf(ATTRIBUTE_USAGES, usage)) bad("usage", "unknown_usage");
  if (!isOneOf(ATTRIBUTE_VALUE_TYPES, valueType)) bad("valueType", "unknown_value_type");
  if (axisKind !== null && !isOneOf(AXIS_KINDS, axisKind)) bad("axisKind", "unknown_axis_kind");
  if (usage === "variant_axis" && valueType !== "select") bad("valueType", "axis_must_be_select");
  if (usage === "variant_axis" && axisKind === null) bad("axisKind", "axis_kind_required");
  if (usage === "descriptive" && axisKind !== null) bad("axisKind", "axis_kind_only_for_axes");
  if (unit !== null && (valueType !== "number" || !UNIT_PATTERN.test(unit))) bad("unit", "unit_only_for_numbers");

  if (issues.length > 0 || !key.ok) return invalid(issues);
  return valid({ key: key.value, usage: usage as AttributeUsage, valueType: valueType as AttributeValueType, axisKind: axisKind as AxisKind | null, unit });
}

// ---------------------------------------------------------------------------
// Numbers: numeric(14, 4) — up to 10 integer digits and 4 decimals, never rounded silently.
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^-?\d{1,10}(\.\d{1,4})?$/;

/** A canonical decimal string ("112.5", "-3", "0.25"), or null when it does not fit numeric(14, 4). */
export function parseDecimal(raw: number | string): string | null {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    text = String(raw);
  } else {
    text = toAsciiDigits(raw.trim()).replace("٫", "."); // Arabic decimal separator
  }
  if (!DECIMAL_PATTERN.test(text)) return null;
  const negative = text.startsWith("-");
  const [intPart = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  const integer = intPart.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  const canonical = decimals ? `${integer}.${decimals}` : integer;
  return negative && canonical !== "0" ? `-${canonical}` : canonical;
}

// ---------------------------------------------------------------------------
// Descriptive values for one product
// ---------------------------------------------------------------------------

export interface AttributeRecord {
  readonly id: string;
  readonly usage: AttributeUsage;
  readonly valueType: AttributeValueType;
  readonly axisKind: AxisKind | null;
  readonly status: "active" | "archived";
}

export interface ValueRecord {
  readonly id: string;
  readonly attributeId: string;
  readonly status: "active" | "archived";
}

export interface DescriptiveInput {
  readonly attributeId: string;
  /** select: one or more value ids of this attribute. */
  readonly valueIds?: readonly string[];
  /** number: a JS number or decimal string. */
  readonly number?: number | string;
  readonly boolean?: boolean;
  /** text: localized text, one entry per locale. */
  readonly text?: readonly TranslationInput[];
}

export type DescriptiveValue =
  | { readonly attributeId: string; readonly valueType: "select"; readonly valueIds: readonly string[] }
  | { readonly attributeId: string; readonly valueType: "number"; readonly number: string }
  | { readonly attributeId: string; readonly valueType: "boolean"; readonly boolean: boolean }
  | { readonly attributeId: string; readonly valueType: "text"; readonly text: readonly Translation[] };

/**
 * Checks and normalizes a product's complete set of descriptive values: each attribute at most
 * once, active and descriptive, with a value of its own type. Archived values may stay on a
 * product that already has them (`keepArchived`), but cannot be newly chosen.
 */
export function parseDescriptiveValues(
  attributes: ReadonlyMap<string, AttributeRecord>,
  values: ReadonlyMap<string, ValueRecord>,
  inputs: readonly DescriptiveInput[],
  keepArchived: ReadonlySet<string> = new Set(),
): Validation<DescriptiveValue[]> {
  const issues: CatalogIssue[] = [];
  const out: DescriptiveValue[] = [];
  const seen = new Set<string>();

  inputs.forEach((input, index) => {
    const path = `attributes[${index}]`;
    const attribute = attributes.get(input.attributeId);
    if (seen.has(input.attributeId)) return void issues.push(issue("duplicate_value", path));
    seen.add(input.attributeId);
    if (!attribute) return void issues.push(issue("attribute_not_found", path));
    if (attribute.usage !== "descriptive") return void issues.push(issue("attribute_not_descriptive", path));
    if (attribute.status !== "active") return void issues.push(issue("attribute_archived", path));

    const given = [input.valueIds !== undefined, input.number !== undefined, input.boolean !== undefined, input.text !== undefined].filter(Boolean).length;
    const expected = { select: input.valueIds, number: input.number, boolean: input.boolean, text: input.text }[attribute.valueType];
    if (given !== 1 || expected === undefined) return void issues.push(issue("attribute_type_mismatch", path, { expected: attribute.valueType }));

    switch (attribute.valueType) {
      case "select": {
        const ids = input.valueIds ?? [];
        if (ids.length === 0) return void issues.push(issue("attribute_type_mismatch", `${path}.valueIds`, { expected: "select" }));
        const unique = new Set<string>();
        ids.forEach((valueId, i) => {
          const at = `${path}.valueIds[${i}]`;
          const value = values.get(valueId);
          if (unique.has(valueId)) issues.push(issue("duplicate_value", at));
          else if (!value) issues.push(issue("value_not_found", at));
          else if (value.attributeId !== attribute.id) issues.push(issue("value_not_in_attribute", at));
          else if (value.status !== "active" && !keepArchived.has(valueId)) issues.push(issue("value_archived", at));
          unique.add(valueId);
        });
        out.push({ attributeId: attribute.id, valueType: "select", valueIds: [...unique] });
        return;
      }
      case "number": {
        const number = parseDecimal(input.number as number | string);
        if (number === null) return void issues.push(issue("invalid_number", `${path}.number`));
        out.push({ attributeId: attribute.id, valueType: "number", number });
        return;
      }
      case "boolean":
        out.push({ attributeId: attribute.id, valueType: "boolean", boolean: input.boolean === true });
        return;
      case "text": {
        const text = parseTranslations("text_value", input.text ?? [], `${path}.text`);
        if (!text.ok) return void issues.push(...text.issues);
        if (text.value.length === 0) return void issues.push(issue("missing_text", `${path}.text`));
        out.push({ attributeId: attribute.id, valueType: "text", text: text.value });
        return;
      }
    }
  });

  return issues.length > 0 ? invalid(issues) : valid(out);
}
