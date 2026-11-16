import { describe, expect, it } from "vitest";

import { planBrand, planCategoryAssignment, type ReferenceStatus } from "./products";

const codes = (r: { ok: boolean; issues?: readonly { code: string; path?: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => `${i.code}@${i.path}`));
const statuses = new Map<string, ReferenceStatus>([
  ["women", "active"],
  ["dresses", "active"],
  ["sale", "active"],
  ["old", "archived"],
]);

describe("planCategoryAssignment", () => {
  it("puts the primary first, adds it when missing and removes duplicates", () => {
    expect(planCategoryAssignment(statuses, { primaryCategoryId: "dresses", categoryIds: ["women", "dresses", "women"] })).toEqual({
      ok: true,
      value: { primaryCategoryId: "dresses", categoryIds: ["dresses", "women"] },
    });
    expect(planCategoryAssignment(statuses, { primaryCategoryId: "women" })).toEqual({ ok: true, value: { primaryCategoryId: "women", categoryIds: ["women"] } });
  });

  it("refuses unknown categories and newly chosen archived ones", () => {
    expect(codes(planCategoryAssignment(statuses, { primaryCategoryId: "missing" }))).toEqual(["category_not_found@primaryCategoryId"]);
    expect(codes(planCategoryAssignment(statuses, { primaryCategoryId: "women", categoryIds: ["old"] }))).toEqual(["category_archived@categoryIds[0]"]);
    expect(codes(planCategoryAssignment(statuses, { primaryCategoryId: "old" }))).toEqual(["category_archived@primaryCategoryId"]);
  });

  it("keeps archived categories the product already has, in the same role", () => {
    const current = { primaryCategoryId: "old", categoryIds: new Set(["old", "women"]) };
    expect(planCategoryAssignment(statuses, { primaryCategoryId: "old", categoryIds: ["women"] }, current).ok).toBe(true);
    const secondary = { primaryCategoryId: "women", categoryIds: new Set(["women", "old"]) };
    expect(planCategoryAssignment(statuses, { primaryCategoryId: "women", categoryIds: ["old"] }, secondary).ok).toBe(true);
    // an archived secondary cannot be promoted to primary
    expect(codes(planCategoryAssignment(statuses, { primaryCategoryId: "old", categoryIds: ["women"] }, secondary))).toEqual(["category_archived@primaryCategoryId"]);
  });

  it("imposes no fixed limit on the number of categories", () => {
    const many = new Map<string, ReferenceStatus>(Array.from({ length: 100 }, (_, i) => [`c${i}`, "active"]));
    const ids = [...many.keys()];
    const result = planCategoryAssignment(many, { primaryCategoryId: ids[0]!, categoryIds: ids });
    expect(result.ok && result.value.categoryIds.length).toBe(100);
  });
});

describe("planBrand", () => {
  const brands = new Map<string, ReferenceStatus>([
    ["house", "active"],
    ["retired", "archived"],
  ]);
  it("accepts an active brand or none, keeps the current archived brand, refuses new archived or unknown ones", () => {
    expect(planBrand(brands, "house")).toEqual({ ok: true, value: "house" });
    expect(planBrand(brands, null, "retired")).toEqual({ ok: true, value: null });
    expect(planBrand(brands, "retired", "retired")).toEqual({ ok: true, value: "retired" });
    expect(codes(planBrand(brands, "retired", "house"))).toEqual(["brand_archived@brandId"]);
    expect(codes(planBrand(brands, "missing"))).toEqual(["brand_not_found@brandId"]);
  });
});
