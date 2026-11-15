import { describe, expect, it } from "vitest";

import type { AttributeRecord, ValueRecord } from "./attributes";
import { colorAxisOf, MAX_VARIANT_AXES, planAxes, planAxisValues, validateAxisChange } from "./axes";

const axis = (id: string, axisKind: "color" | "size" | "other", status: "active" | "archived" = "active"): [string, AttributeRecord] => [
  id,
  { id, usage: "variant_axis", valueType: "select", axisKind, status },
];
const attrs = new Map<string, AttributeRecord>([
  axis("size_women", "size"),
  axis("cup", "size"),
  axis("color", "color"),
  axis("shade", "color"),
  axis("length", "other"),
  axis("old_size", "size", "archived"),
  ["material", { id: "material", usage: "descriptive", valueType: "select", axisKind: null, status: "active" }],
]);
const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.code));

describe("planAxes", () => {
  it("numbers up to three axes from 1", () => {
    expect(MAX_VARIANT_AXES).toBe(3);
    expect(planAxes(attrs, ["size_women", "cup", "color"])).toEqual({
      ok: true,
      value: [
        { position: 1, attributeId: "size_women" },
        { position: 2, attributeId: "cup" },
        { position: 3, attributeId: "color" },
      ],
    });
    expect(planAxes(attrs, [])).toEqual({ ok: true, value: [] });
  });

  it("allows at most one colour axis per product", () => {
    expect(codes(planAxes(attrs, ["color", "shade"]))).toEqual(["multiple_color_axes"]);
    expect(codes(planAxes(attrs, ["size_women", "color", "shade"]))).toEqual(["multiple_color_axes"]);
    // several size-like axes are fine (band + cup)
    expect(planAxes(attrs, ["size_women", "cup"]).ok).toBe(true);
  });

  it("rejects more than three axes, duplicates, non-axis, archived and unknown attributes", () => {
    expect(codes(planAxes(attrs, ["size_women", "cup", "color", "length"]))).toEqual(["too_many_axes"]);
    expect(codes(planAxes(attrs, ["color", "color"]))).toEqual(["duplicate_axis"]);
    expect(codes(planAxes(attrs, ["material"]))).toEqual(["not_an_axis_attribute"]);
    expect(codes(planAxes(attrs, ["old_size"]))).toEqual(["attribute_archived"]);
    expect(codes(planAxes(attrs, ["missing"]))).toEqual(["attribute_not_found"]);
  });

  it("finds the colour axis", () => {
    const planned = planAxes(attrs, ["size_women", "color"]);
    expect(planned.ok && colorAxisOf(attrs, planned.value)).toEqual({ position: 2, attributeId: "color" });
    expect(colorAxisOf(attrs, [{ position: 1, attributeId: "size_women" }])).toBeNull();
  });
});

describe("validateAxisChange", () => {
  const current = [
    { position: 1, attributeId: "size_women" },
    { position: 2, attributeId: "color" },
  ];

  it("allows any change while the product has no variants", () => {
    expect(validateAxisChange(current, [{ position: 1, attributeId: "color" }], 0).ok).toBe(true);
  });

  it("freezes the structure once variants exist", () => {
    expect(codes(validateAxisChange(current, [{ position: 1, attributeId: "size_women" }], 3))).toEqual(["axes_frozen"]);
    expect(codes(validateAxisChange(current, [...current].reverse(), 1))).toEqual(["axes_frozen"]);
    expect(codes(validateAxisChange(current, [...current, { position: 3, attributeId: "length" }], 1))).toEqual(["axes_frozen"]);
    expect(validateAxisChange(current, current.map((a) => ({ ...a })), 5).ok).toBe(true);
  });
});

describe("planAxisValues", () => {
  const values = new Map<string, ValueRecord>([
    ["s", { id: "s", attributeId: "size_women", status: "active" }],
    ["m", { id: "m", attributeId: "size_women", status: "active" }],
    ["xxs", { id: "xxs", attributeId: "size_women", status: "archived" }],
    ["red", { id: "red", attributeId: "color", status: "active" }],
  ]);
  const sizeAxis = { position: 1, attributeId: "size_women" };

  it("adds new values and skips ones already offered", () => {
    expect(planAxisValues(sizeAxis, values, new Set(["s"]), ["s", "m"])).toEqual({ ok: true, value: ["m"] });
  });

  it("rejects values of another attribute, archived, unknown and repeated values", () => {
    expect(codes(planAxisValues(sizeAxis, values, new Set(), ["red"]))).toEqual(["value_not_in_attribute"]);
    expect(codes(planAxisValues(sizeAxis, values, new Set(), ["xxs"]))).toEqual(["value_archived"]);
    expect(codes(planAxisValues(sizeAxis, values, new Set(), ["nope"]))).toEqual(["value_not_found"]);
    expect(codes(planAxisValues(sizeAxis, values, new Set(), ["m", "m"]))).toEqual(["duplicate_value"]);
  });
});
