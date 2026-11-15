import { describe, expect, it } from "vitest";

import { checkPublishable, nextStatus, publicationIssues, type PublicationSnapshot } from "./publication";

const ready: PublicationSnapshot = {
  status: "draft",
  translatedLocales: ["fa"],
  primaryCategoryStatus: "active",
  brandStatus: null,
  axisCount: 2,
  axesDefined: 2,
  activeVariants: 1,
  images: 1,
};
const codes = (issues: readonly { code: string }[]) => issues.map((i) => i.code);

describe("product lifecycle", () => {
  it.each([
    ["draft", "publish", "active"],
    ["active", "unpublish", "draft"],
    ["draft", "archive", "archived"],
    ["active", "archive", "archived"],
    ["archived", "restore", "draft"],
  ] as const)("%s --%s--> %s", (from, action, to) => expect(nextStatus(from, action)).toEqual({ ok: true, value: to }));

  it.each([
    ["active", "publish"],
    ["archived", "publish"],
    ["draft", "unpublish"],
    ["archived", "archive"],
    ["draft", "restore"],
  ] as const)("refuses %s --%s-->", (from, action) => {
    const next = nextStatus(from, action);
    expect(!next.ok && next.issues[0]?.code).toBe("invalid_transition");
  });
});

describe("publishing", () => {
  it("is allowed with a Persian translation, an active variant and an image; English is optional", () => {
    expect(checkPublishable(ready)).toEqual({ ok: true, value: "active" });
    expect(checkPublishable({ ...ready, translatedLocales: ["fa", "en"], brandStatus: "active" }).ok).toBe(true);
    expect(checkPublishable({ ...ready, axisCount: 0, axesDefined: 0 }).ok).toBe(true);
  });

  it("requires Persian, one active variant and one image", () => {
    expect(codes(publicationIssues({ ...ready, translatedLocales: ["en"] }))).toEqual(["missing_required_translation"]);
    expect(codes(publicationIssues({ ...ready, activeVariants: 0 }))).toEqual(["no_active_variant"]);
    expect(codes(publicationIssues({ ...ready, images: 0 }))).toEqual(["no_image"]);
  });

  it("refuses archived categories or brands, incomplete axes and wrong states, reporting everything", () => {
    expect(
      codes(
        publicationIssues({
          ...ready,
          status: "archived",
          translatedLocales: [],
          primaryCategoryStatus: "archived",
          brandStatus: "archived",
          axesDefined: 1,
          activeVariants: 0,
          images: 0,
        }),
      ),
    ).toEqual(["invalid_transition", "missing_required_translation", "category_archived", "brand_archived", "axes_incomplete", "no_active_variant", "no_image"]);
  });
});
