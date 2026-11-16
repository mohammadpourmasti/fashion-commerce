import { describe, expect, it } from "vitest";

import { parseAssetMetadata, planImages, type ColorAxis } from "./media";

const codes = (r: { ok: boolean; issues?: readonly { code: string }[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => i.code));
const asset = { storageKey: "products/dress/front.webp", contentType: "image/webp", byteSize: 120_000, width: 1600, height: 2400, sha256: "A".repeat(64) };

describe("parseAssetMetadata", () => {
  it("accepts valid metadata and lower-cases the hash", () => {
    expect(parseAssetMetadata(asset)).toEqual({ ok: true, value: { ...asset, sha256: "a".repeat(64) } });
  });

  it.each([
    [{ storageKey: "products/../secret.webp" }, "storageKey"],
    [{ storageKey: "products//x.webp" }, "storageKey"],
    [{ storageKey: "Products/X.webp" }, "storageKey"],
    [{ contentType: "image/gif" }, "contentType"],
    [{ byteSize: 0 }, "byteSize"],
    [{ byteSize: 52_428_801 }, "byteSize"],
    [{ width: 0 }, "width"],
    [{ height: 20_001 }, "height"],
    [{ width: 1.5 }, "width"],
    [{ sha256: "xyz" }, "sha256"],
  ])("rejects %o", (patch, path) => {
    const parsed = parseAssetMetadata({ ...asset, ...patch });
    expect(!parsed.ok && parsed.issues).toEqual([{ code: "invalid_asset", path }]);
  });
});

describe("planImages", () => {
  const colorAxis: ColorAxis = { attributeId: "color", offeredValueIds: new Set(["red", "black"]) };

  it("assigns positions in order and ties colour images to the colour attribute", () => {
    expect(
      planImages(colorAxis, [
        { assetId: "a1", view: "front", colorValueId: "red" },
        { assetId: "a2", view: "back", colorValueId: "red" },
        { assetId: "a3", view: "detail" },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { assetId: "a1", view: "front", position: 0, colorValueId: "red", colorAttributeId: "color" },
        { assetId: "a2", view: "back", position: 1, colorValueId: "red", colorAttributeId: "color" },
        { assetId: "a3", view: "detail", position: 2, colorValueId: null, colorAttributeId: null },
      ],
    });
  });

  it("only links to colours the product offers on its colour axis", () => {
    expect(codes(planImages(colorAxis, [{ assetId: "a1", view: "front", colorValueId: "s" }]))).toEqual(["color_not_offered"]);
    // a product without a colour axis cannot have colour links at all (e.g. a size value)
    expect(codes(planImages(null, [{ assetId: "a1", view: "front", colorValueId: "s" }]))).toEqual(["not_a_color_axis"]);
    expect(planImages(null, [{ assetId: "a1", view: "front" }]).ok).toBe(true);
  });

  it("rejects unknown views and repeated assets", () => {
    expect(codes(planImages(colorAxis, [{ assetId: "a1", view: "side" }]))).toEqual(["invalid_view"]);
    expect(
      codes(
        planImages(colorAxis, [
          { assetId: "a1", view: "front" },
          { assetId: "a1", view: "gallery" },
        ]),
      ),
    ).toEqual(["duplicate_asset"]);
  });

  it("allows one front and one back per colour group, and the unlinked images form one group", () => {
    const ok = planImages(colorAxis, [
      { assetId: "a1", view: "front", colorValueId: "red" },
      { assetId: "a2", view: "front", colorValueId: "black" },
      { assetId: "a3", view: "back", colorValueId: "red" },
      { assetId: "a4", view: "front" },
      { assetId: "a5", view: "back" },
    ]);
    expect(ok.ok).toBe(true);

    const bad = planImages(colorAxis, [
      { assetId: "a1", view: "front", colorValueId: "red" },
      { assetId: "a2", view: "front", colorValueId: "red" },
      { assetId: "a3", view: "back" },
      { assetId: "a4", view: "back" },
    ]);
    expect(codes(bad)).toEqual(["duplicate_view", "duplicate_view"]);
    expect(bad.ok ? [] : bad.issues.map((i) => i.path)).toEqual(["images[1].view", "images[3].view"]);
  });

  it("does not restrict detail and gallery images", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ assetId: `a${i}`, view: i % 2 ? "detail" : "gallery", colorValueId: "red" }));
    expect(planImages(colorAxis, many).ok).toBe(true);
  });
});
