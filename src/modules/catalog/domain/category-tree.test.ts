import { describe, expect, it } from "vitest";

import { depthOf, heightOf, MAX_CATEGORY_DEPTH, toTree, validateCategoryMove, validateNewCategory, type CategoryNode } from "./category-tree";

// women > dresses > evening > long ; kids ; archived "old"
const nodes: CategoryNode[] = [
  { id: "women", parentId: null, status: "active" },
  { id: "dresses", parentId: "women", status: "active" },
  { id: "evening", parentId: "dresses", status: "active" },
  { id: "long", parentId: "evening", status: "active" },
  { id: "kids", parentId: null, status: "active" },
  { id: "kids-shoes", parentId: "kids", status: "active" },
  { id: "old", parentId: null, status: "archived" },
];
const tree = toTree(nodes);
const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.code));

describe("category tree", () => {
  it("measures depth and subtree height", () => {
    expect(MAX_CATEGORY_DEPTH).toBe(4);
    expect(depthOf(tree, "women")).toBe(1);
    expect(depthOf(tree, "long")).toBe(4);
    expect(heightOf(tree, "women")).toBe(4);
    expect(heightOf(tree, "dresses")).toBe(3);
    expect(heightOf(tree, "long")).toBe(1);
  });

  it("allows new categories down to level 4 under an active parent", () => {
    expect(validateNewCategory(tree, null)).toEqual({ ok: true, value: { depth: 1 } });
    expect(validateNewCategory(tree, "evening")).toEqual({ ok: true, value: { depth: 4 } });
    expect(codes(validateNewCategory(tree, "long"))).toEqual(["category_too_deep"]);
    expect(codes(validateNewCategory(tree, "old"))).toEqual(["category_archived"]);
    expect(codes(validateNewCategory(tree, "missing"))).toEqual(["category_not_found"]);
  });

  it("rejects moves that create a cycle", () => {
    expect(codes(validateCategoryMove(tree, "women", "women"))).toEqual(["category_cycle"]);
    expect(codes(validateCategoryMove(tree, "women", "long"))).toEqual(["category_cycle"]);
    expect(codes(validateCategoryMove(tree, "dresses", "evening"))).toEqual(["category_cycle"]);
  });

  it("rejects moves that push the subtree below level 4", () => {
    // dresses has height 3; under kids-shoes (level 2) its leaves would sit at level 5
    expect(codes(validateCategoryMove(tree, "dresses", "kids-shoes"))).toEqual(["category_too_deep"]);
    // under kids (level 1) they sit at level 4: allowed
    expect(validateCategoryMove(tree, "dresses", "kids")).toEqual({ ok: true, value: { depth: 2 } });
  });

  it("allows promoting a category to the top level and refuses archived or unknown parents", () => {
    expect(validateCategoryMove(tree, "evening", null)).toEqual({ ok: true, value: { depth: 1 } });
    expect(codes(validateCategoryMove(tree, "kids-shoes", "old"))).toEqual(["category_archived"]);
    expect(codes(validateCategoryMove(tree, "kids-shoes", "missing"))).toEqual(["category_not_found"]);
    expect(codes(validateCategoryMove(tree, "missing", "kids"))).toEqual(["category_not_found"]);
  });

  it("detects a corrupted (cyclic) stored tree instead of looping forever", () => {
    const broken = toTree([
      { id: "a", parentId: "b", status: "active" },
      { id: "b", parentId: "a", status: "active" },
    ]);
    expect(() => depthOf(broken, "a")).toThrow(/cycle/);
  });
});
