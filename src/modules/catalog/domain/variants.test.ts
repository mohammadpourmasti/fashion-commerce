import { describe, expect, it } from "vitest";

import { cartesian, combinationKey, MAX_VARIANTS_PER_PRODUCT, missingCombinations, planVariants } from "./variants";

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.code));
// size axis: s, m ; colour axis: red
const offered = [new Set(["s", "m"]), new Set(["red"])];

describe("cartesian and combinationKey", () => {
  it("builds every combination in axis order; no axes gives one empty combination", () => {
    expect(cartesian([["s", "m"], ["red", "black"]])).toEqual([
      ["s", "red"],
      ["s", "black"],
      ["m", "red"],
      ["m", "black"],
    ]);
    expect(cartesian([])).toEqual([[]]);
    expect(combinationKey(["s", "red"])).toBe("s|red");
    expect(combinationKey([])).toBe("");
  });
});

describe("planVariants", () => {
  it("normalizes SKUs and barcodes for valid combinations", () => {
    expect(planVariants(offered, [], [{ sku: "drs-s-red", barcode: "4006381333931", values: ["s", "red"] }])).toEqual({
      ok: true,
      value: [{ sku: "DRS-S-RED", barcode: "4006381333931", values: ["s", "red"] }],
    });
  });

  it("needs one offered value per axis, in axis order", () => {
    expect(codes(planVariants(offered, [], [{ sku: "A-1", values: ["s"] }]))).toEqual(["wrong_value_count"]);
    expect(codes(planVariants(offered, [], [{ sku: "A-1", values: ["red", "s"] }]))).toEqual(["value_not_offered", "value_not_offered"]);
    expect(codes(planVariants(offered, [], [{ sku: "A-1", values: ["l", "red"] }]))).toEqual(["value_not_offered"]);
  });

  it("rejects a combination, SKU or barcode that already exists or repeats in the batch", () => {
    const existing = [{ sku: "DRS-S-RED", barcode: "4006381333931", values: ["s", "red"] }];
    expect(codes(planVariants(offered, existing, [{ sku: "DRS-S-RED-2", values: ["s", "red"] }]))).toEqual(["duplicate_combination"]);
    expect(codes(planVariants(offered, existing, [{ sku: "drs-s-red", values: ["m", "red"] }]))).toEqual(["duplicate_sku"]);
    expect(codes(planVariants(offered, existing, [{ sku: "DRS-M-RED", barcode: "4006381333931", values: ["m", "red"] }]))).toEqual(["duplicate_barcode"]);
    expect(
      codes(
        planVariants(offered, [], [
          { sku: "A-1", values: ["m", "red"] },
          { sku: "A-2", values: ["m", "red"] },
        ]),
      ),
    ).toEqual(["duplicate_combination"]);
  });

  it("validates SKU and barcode formats", () => {
    expect(codes(planVariants(offered, [], [{ sku: "ab", barcode: "123", values: ["s", "red"] }]))).toEqual(["invalid_sku", "invalid_barcode"]);
  });

  it("allows exactly one variant on a product without axes", () => {
    expect(planVariants([], [], [{ sku: "SCARF-01", values: [] }]).ok).toBe(true);
    expect(codes(planVariants([], [{ sku: "SCARF-01", barcode: null, values: [] }], [{ sku: "SCARF-02", values: [] }]))).toEqual(["duplicate_combination"]);
  });

  it(`caps a product at ${MAX_VARIANTS_PER_PRODUCT} variants, counting discontinued ones`, () => {
    const sizes = Array.from({ length: 101 }, (_, i) => `v${i}`);
    const existing = sizes.slice(0, 100).map((v, i) => ({ sku: `SKU-${i}`, barcode: null, values: [v] }));
    expect(codes(planVariants([new Set(sizes)], existing, [{ sku: "SKU-100", values: ["v100"] }]))).toEqual(["too_many_variants"]);
  });
});

describe("missingCombinations", () => {
  it("lists combinations without a variant yet", () => {
    expect(missingCombinations([["s", "m"], ["red"]], [{ sku: "X", barcode: null, values: ["s", "red"] }])).toEqual({ ok: true, value: [["m", "red"]] });
  });

  it("refuses a matrix larger than the cap", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `v${i}`);
    expect(missingCombinations([ten, ten], []).ok).toBe(true); // exactly 100
    expect(codes(missingCombinations([ten, ten, ["a", "b"]], []))).toEqual(["too_many_variants"]);
  });
});
