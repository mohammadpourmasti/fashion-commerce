import { describe, expect, it } from "vitest";

import * as schema from "../infrastructure/schema";

import { ATTRIBUTE_USAGES, ATTRIBUTE_VALUE_TYPES, AXIS_KINDS, parseAttributeDefinition, parseDecimal, parseDescriptiveValues, type AttributeRecord, type ValueRecord } from "./attributes";
import { MEDIA_CONTENT_TYPES, PRODUCT_IMAGE_VIEWS } from "./media";
import { PRODUCT_STATUSES } from "./publication";

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.code));

describe("domain constants", () => {
  it("match the values the schema allows", () => {
    expect(ATTRIBUTE_USAGES).toEqual(schema.ATTRIBUTE_USAGES);
    expect(ATTRIBUTE_VALUE_TYPES).toEqual(schema.ATTRIBUTE_VALUE_TYPES);
    expect(AXIS_KINDS).toEqual(schema.AXIS_KINDS);
    expect(MEDIA_CONTENT_TYPES).toEqual(schema.MEDIA_CONTENT_TYPES);
    expect(PRODUCT_IMAGE_VIEWS).toEqual(schema.PRODUCT_IMAGE_VIEWS);
    expect(PRODUCT_STATUSES).toEqual(schema.PRODUCT_STATUSES);
  });
});

describe("parseAttributeDefinition", () => {
  it("accepts axis and descriptive definitions", () => {
    expect(parseAttributeDefinition({ key: " Color ", usage: "variant_axis", valueType: "select", axisKind: "color" })).toEqual({
      ok: true,
      value: { key: "color", usage: "variant_axis", valueType: "select", axisKind: "color", unit: null },
    });
    expect(parseAttributeDefinition({ key: "length", usage: "descriptive", valueType: "number", unit: "CM" })).toEqual({
      ok: true,
      value: { key: "length", usage: "descriptive", valueType: "number", axisKind: null, unit: "cm" },
    });
  });

  it.each([
    [{ key: "size", usage: "variant_axis", valueType: "text", axisKind: "size" }, "axis_must_be_select"],
    [{ key: "size", usage: "variant_axis", valueType: "select" }, "axis_kind_required"],
    [{ key: "fabric", usage: "descriptive", valueType: "select", axisKind: "color" }, "axis_kind_only_for_axes"],
    [{ key: "weight", usage: "descriptive", valueType: "text", unit: "g" }, "unit_only_for_numbers"],
    [{ key: "print", usage: "variant_axis", valueType: "select", axisKind: "pattern" }, "unknown_axis_kind"],
    [{ key: "x1", usage: "searchable", valueType: "select" }, "unknown_usage"],
    [{ key: "x1", usage: "descriptive", valueType: "date" }, "unknown_value_type"],
  ])("rejects %o (%s)", (input, reason) => {
    const parsed = parseAttributeDefinition(input);
    expect(!parsed.ok && parsed.issues.map((i) => i.detail?.reason)).toContain(reason);
  });

  it("rejects bad keys", () => {
    expect(codes(parseAttributeDefinition({ key: "size-women", usage: "descriptive", valueType: "text" }))).toEqual(["invalid_key"]);
  });
});

describe("parseDecimal", () => {
  it.each([
    [112.5, "112.5"],
    ["0112.50", "112.5"],
    ["۱۲۰٫۵", "120.5"],
    ["-0.0", "0"],
    ["-3", "-3"],
    ["9999999999.9999", "9999999999.9999"],
  ])("%s -> %s", (raw, out) => expect(parseDecimal(raw)).toBe(out));

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e21, 0.1 + 0.2, "1.23456", "12345678901", "1,5", "", "abc"])("rejects %s", (raw) =>
    expect(parseDecimal(raw)).toBeNull(),
  );
});

describe("parseDescriptiveValues", () => {
  const attrs = new Map<string, AttributeRecord>([
    ["material", { id: "material", usage: "descriptive", valueType: "select", axisKind: null, status: "active" }],
    ["length", { id: "length", usage: "descriptive", valueType: "number", axisKind: null, status: "active" }],
    ["lined", { id: "lined", usage: "descriptive", valueType: "boolean", axisKind: null, status: "active" }],
    ["care", { id: "care", usage: "descriptive", valueType: "text", axisKind: null, status: "active" }],
    ["size", { id: "size", usage: "variant_axis", valueType: "select", axisKind: "size", status: "active" }],
    ["season", { id: "season", usage: "descriptive", valueType: "select", axisKind: null, status: "archived" }],
  ]);
  const values = new Map<string, ValueRecord>([
    ["cotton", { id: "cotton", attributeId: "material", status: "active" }],
    ["linen", { id: "linen", attributeId: "material", status: "active" }],
    ["silk", { id: "silk", attributeId: "material", status: "archived" }],
    ["s", { id: "s", attributeId: "size", status: "active" }],
  ]);

  it("normalizes select, number, boolean and localized text values", () => {
    expect(
      parseDescriptiveValues(attrs, values, [
        { attributeId: "material", valueIds: ["cotton", "linen"] },
        { attributeId: "length", number: "112.50" },
        { attributeId: "lined", boolean: false },
        { attributeId: "care", text: [{ locale: "fa", name: "شست‌وشو با دست" }] },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { attributeId: "material", valueType: "select", valueIds: ["cotton", "linen"] },
        { attributeId: "length", valueType: "number", number: "112.5" },
        { attributeId: "lined", valueType: "boolean", boolean: false },
        { attributeId: "care", valueType: "text", text: [{ locale: "fa", name: "شست‌وشو با دست", slug: null, description: "", seoTitle: null, seoDescription: null }] },
      ],
    });
  });

  it.each([
    [[{ attributeId: "unknown", boolean: true }], "attribute_not_found"],
    [[{ attributeId: "size", valueIds: ["s"] }], "attribute_not_descriptive"],
    [[{ attributeId: "season", valueIds: [] }], "attribute_archived"],
    [[{ attributeId: "length", boolean: true }], "attribute_type_mismatch"],
    [[{ attributeId: "length", number: 1, boolean: true }], "attribute_type_mismatch"],
    [[{ attributeId: "material", valueIds: [] }], "attribute_type_mismatch"],
    [[{ attributeId: "material", valueIds: ["s"] }], "value_not_in_attribute"],
    [[{ attributeId: "material", valueIds: ["nope"] }], "value_not_found"],
    [[{ attributeId: "material", valueIds: ["silk"] }], "value_archived"],
    [[{ attributeId: "material", valueIds: ["cotton", "cotton"] }], "duplicate_value"],
    [[{ attributeId: "length", number: "1.23456" }], "invalid_number"],
    [[{ attributeId: "care", text: [] }], "missing_text"],
    [[{ attributeId: "care", text: [{ locale: "fa", name: " " }] }], "invalid_name"],
    [[{ attributeId: "lined", boolean: true }, { attributeId: "lined", boolean: false }], "duplicate_value"],
  ])("rejects %o (%s)", (inputs, code) => {
    expect(codes(parseDescriptiveValues(attrs, values, inputs))).toContain(code);
  });

  it("lets a product keep an archived value it already has", () => {
    expect(parseDescriptiveValues(attrs, values, [{ attributeId: "material", valueIds: ["silk"] }], new Set(["silk"])).ok).toBe(true);
  });
});
