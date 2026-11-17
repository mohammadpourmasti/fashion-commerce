import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { createRequestContext, type Permission, type RequestContext } from "@/shared/kernel/authorization";

import { createCatalog, type Catalog } from "./application/catalog";
import { CATALOG_PERMISSIONS } from "./domain/permissions";

// Phase 2C Step 6: the public storefront read model. All data is built through the real catalog
// services (tests only, never part of the application), then read back without any permission.

let db: TestDatabase;
let appPool: Pool;
let clock: Date;
let catalog: Catalog;

beforeEach(async () => {
  clock = new Date("2030-01-01T00:00:00Z");
  db = await createTestDatabase();
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS, appRole: db.appRole });
  appPool = createPool(db.url, { max: 8, options: `-c role=${db.appRole}` });
  catalog = createCatalog({ pool: appPool, now: () => clock });
});

afterEach(async () => {
  await appPool?.end();
  await db?.cleanup();
});

const ctxWith = (permissions: readonly Permission[]): RequestContext => {
  const allowed = new Set<string>(permissions);
  return createRequestContext({ requestId: "req-test", actor: { kind: "user", userId: "u-1", sessionId: "s-1" }, authorizer: { isAllowed: async (_a, p) => allowed.has(p) } });
};
const manager = () => ctxWith(Object.values(CATALOG_PERMISSIONS));

function ok<T>(result: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  return result.value;
}
const codes = (result: { ok: boolean; issues?: readonly { code: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.code));
const fa = (name: string, extra: Record<string, string> = {}) => ({ locale: "fa", name, ...extra });
const en = (name: string, extra: Record<string, string> = {}) => ({ locale: "en", name, ...extra });

async function world() {
  const m = manager();
  const cat = async (key: string, translations: object[], parentId: string | null = null) => ok(await catalog.categories.create(m, { key, parentId, translations: translations as never })).categoryId;
  const women = await cat("women", [fa("زنانه", { slug: "زنانه" }), en("Women", { slug: "women" })]);
  const dresses = await cat("women-dresses", [fa("پیراهن", { slug: "پیراهن" }), en("Dresses", { slug: "dresses" })], women);
  const sale = await cat("sale", [fa("حراج", { slug: "حراج" })]); // Persian only
  const old = await cat("old", [fa("قدیمی", { slug: "قدیمی" }), en("Old", { slug: "old" })]);
  const oldChild = await cat("old-child", [fa("قدیمی-زیر", { slug: "قدیمی-زیر" }), en("Old child", { slug: "old-child" })], old);
  const brand = ok(await catalog.brands.create(m, { key: "house", translations: [fa("خانه"), en("House")] })).brandId;

  const attr = async (key: string, usage: string, valueType: string, names: object[], extra: Record<string, string> = {}) =>
    ok(await catalog.attributes.create(m, { key, usage, valueType, translations: names as never, ...extra })).attributeId;
  const value = async (attributeId: string, key: string, names: object[], swatchHex?: string) =>
    ok(await catalog.attributes.createValue(m, { attributeId, key, translations: names as never, swatchHex })).valueId;
  const color = await attr("color", "variant_axis", "select", [fa("رنگ"), en("Colour")], { axisKind: "color" });
  const size = await attr("size_women", "variant_axis", "select", [fa("اندازه"), en("Size")], { axisKind: "size" });
  const fabric = await attr("fabric", "descriptive", "select", [fa("پارچه"), en("Fabric")]);
  const length = await attr("length", "descriptive", "number", [fa("طول"), en("Length")], { unit: "cm" });
  const lined = await attr("lined", "descriptive", "boolean", [fa("آستردار"), en("Lined")]);
  const care = await attr("care", "descriptive", "text", [fa("نگهداری"), en("Care")]);
  const v = {
    red: await value(color, "red", [fa("قرمز"), en("Red")], "#C00000"),
    blue: await value(color, "blue", [fa("آبی"), en("Blue")], "#0000C0"),
    s: await value(size, "s", [fa("کوچک"), en("Small")]),
    m: await value(size, "m", [fa("متوسط"), en("Medium")]),
    cotton: await value(fabric, "cotton", [fa("نخی"), en("Cotton")]),
  };
  return { women, dresses, sale, old, oldChild, brand, color, size, fabric, length, lined, care, v };
}
type W = Awaited<ReturnType<typeof world>>;

let assetSeq = 0;
async function asset() {
  assetSeq += 1;
  return ok(
    await catalog.media.registerAsset(manager(), {
      storageKey: `products/photo-${assetSeq}.jpg`,
      contentType: "image/jpeg",
      byteSize: 1000,
      width: 800,
      height: 1200,
      sha256: assetSeq.toString(16).padStart(64, "0"),
    }),
  ).assetId;
}

/** The "evening dress": colour and size axes, four variants, three images, descriptive values; published at `at`. */
async function eveningDress(w: W, at: string) {
  const m = manager();
  const created = ok(
    await catalog.products.create(m, {
      translations: [fa("پیراهن مجلسی", { slug: "پیراهن-مجلسی", description: "پارچه نخی" }), en("Evening dress", { slug: "evening-dress", description: "Cotton", seoTitle: "Evening dress | House" })],
      brandId: w.brand,
      primaryCategoryId: w.dresses,
      categoryIds: [w.women],
      attributes: [
        { attributeId: w.fabric, valueIds: [w.v.cotton] },
        { attributeId: w.length, number: "112.50" },
        { attributeId: w.lined, boolean: true },
        { attributeId: w.care, text: [fa("شستشو با دست"), en("Hand wash")] },
      ],
    }),
  );
  let version = ok(await catalog.variants.setAxes(m, { productId: created.productId, expectedVersion: created.version, attributeIds: [w.color, w.size] })).version;
  version = ok(await catalog.variants.offerValues(m, { productId: created.productId, expectedVersion: version, attributeId: w.color, valueIds: [w.v.red, w.v.blue] })).version;
  version = ok(await catalog.variants.offerValues(m, { productId: created.productId, expectedVersion: version, attributeId: w.size, valueIds: [w.v.s, w.v.m] })).version;
  const made = ok(
    await catalog.variants.create(m, {
      productId: created.productId,
      variants: [
        { sku: "DRESS-RED-S", barcode: "4006381333931", values: [w.v.red, w.v.s] },
        { sku: "DRESS-RED-M", values: [w.v.red, w.v.m] },
        { sku: "DRESS-BLUE-S", values: [w.v.blue, w.v.s] },
        { sku: "DRESS-BLUE-M", values: [w.v.blue, w.v.m] },
      ],
    }),
  );
  version = made.version;
  const [a1, a2, a3] = [await asset(), await asset(), await asset()];
  version = ok(
    await catalog.media.setProductImages(m, {
      productId: created.productId,
      expectedVersion: version,
      images: [
        { assetId: a1, view: "front", colorValueId: w.v.red, alt: [fa("پیراهن قرمز"), en("Red dress")].map((t) => ({ locale: t.locale, text: t.name })) },
        { assetId: a2, view: "back", colorValueId: w.v.red },
        { assetId: a3, view: "front", colorValueId: w.v.blue },
      ],
    }),
  ).version;
  clock = new Date(at);
  const published = ok(await catalog.publication.publish(m, { productId: created.productId, expectedVersion: version }));
  return { productId: created.productId, version: published.version, variants: made.variants };
}

/** A Persian-only scarf with no axes, one variant and one image; published at `at`. */
async function scarf(w: W, at: string) {
  const m = manager();
  const created = ok(await catalog.products.create(m, { translations: [fa("روسری", { slug: "روسری" })], primaryCategoryId: w.sale }));
  const made = ok(await catalog.variants.create(m, { productId: created.productId, variants: [{ sku: "SCARF-ONE", values: [] }] }));
  const imageVersion = ok(await catalog.media.setProductImages(m, { productId: created.productId, expectedVersion: made.version, images: [{ assetId: await asset(), view: "front" }] })).version;
  clock = new Date(at);
  const published = ok(await catalog.publication.publish(m, { productId: created.productId, expectedVersion: imageVersion }));
  return { productId: created.productId, version: published.version };
}

/** A product that stays a draft. */
async function draft(w: W) {
  return ok(await catalog.products.create(manager(), { translations: [fa("پیش‌نویس", { slug: "پیش-نویس" })], primaryCategoryId: w.women }));
}

describe("categories", () => {
  it("shows only visible categories, localized, with every slug for the language switcher", async () => {
    const w = await world();
    const treeEn = ok(await catalog.storefront.categoryTree({ locale: "en" }));
    expect(treeEn.map((c) => [c.key, c.name, c.slug])).toEqual([["women", "Women", "women"], ["sale", "حراج", "حراج"], ["old", "Old", "old"]]);
    expect(treeEn[0]?.children.map((c) => [c.key, c.slug, c.slugs])).toEqual([["women-dresses", "dresses", { fa: "پیراهن", en: "dresses" }]]);
    // Persian-only content falls back to Persian
    expect(treeEn[1]?.slugs).toEqual({ fa: "حراج" });

    ok(await catalog.categories.archive(manager(), { categoryId: w.oldChild }));
    ok(await catalog.categories.archive(manager(), { categoryId: w.old }));
    const treeFa = ok(await catalog.storefront.categoryTree({ locale: "fa" }));
    expect(treeFa.map((c) => c.key)).toEqual(["women", "sale"]);
    expect(treeFa[0]?.name).toBe("زنانه");
  });

  it("hides the whole subtree of an archived category", async () => {
    const w = await world();
    // the services refuse an active child under an archived parent, so archive both and
    // re-activate the child directly (test-only) to prove the storefront checks ancestors itself
    ok(await catalog.categories.archive(manager(), { categoryId: w.oldChild }));
    ok(await catalog.categories.archive(manager(), { categoryId: w.old }));
    await db.pool.query("UPDATE categories SET status = 'active' WHERE id = $1", [w.oldChild]);
    const tree = ok(await catalog.storefront.categoryTree({ locale: "en" }));
    expect(tree.flatMap((c) => [c.key, ...c.children.map((x) => x.key)])).not.toContain("old-child");
    expect(codes(await catalog.storefront.getCategory({ locale: "en", slug: "old-child" }))).toEqual(["not_found"]);
  });

  it("resolves a category by slug in any locale, with breadcrumb and children", async () => {
    await world();
    const dresses = ok(await catalog.storefront.getCategory({ locale: "en", slug: "dresses" }));
    expect(dresses.category).toMatchObject({ key: "women-dresses", name: "Dresses", slug: "dresses", slugs: { fa: "پیراهن", en: "dresses" } });
    expect(dresses.breadcrumb.map((c) => c.slug)).toEqual(["women"]);
    expect(dresses.children).toEqual([]);

    const women = ok(await catalog.storefront.getCategory({ locale: "en", slug: "women" }));
    expect(women.breadcrumb).toEqual([]);
    expect(women.children.map((c) => c.slug)).toEqual(["dresses"]);

    // the Persian slug under /en resolves to the same category; the page redirects using `slug`
    const cross = ok(await catalog.storefront.getCategory({ locale: "en", slug: "پیراهن" }));
    expect(cross.category.slug).toBe("dresses");
    expect(codes(await catalog.storefront.getCategory({ locale: "en", slug: "missing" }))).toEqual(["not_found"]);
  });
});

describe("listing products", () => {
  it("lists only published products, newest first, and never drafts, unpublished or archived ones", async () => {
    const w = await world();
    const dress = await eveningDress(w, "2030-02-01T00:00:00Z");
    const sc = await scarf(w, "2030-03-01T00:00:00Z");
    await draft(w);

    const all = ok(await catalog.storefront.listProducts({ locale: "en" }));
    expect(all.items.map((p) => p.id)).toEqual([sc.productId, dress.productId]);
    expect(all.total).toBe(2);

    ok(await catalog.publication.unpublish(manager(), { productId: sc.productId, expectedVersion: sc.version }));
    expect(ok(await catalog.storefront.listProducts({ locale: "en" })).items.map((p) => p.id)).toEqual([dress.productId]);
    const archived = ok(await catalog.products.archive(manager(), { productId: dress.productId, expectedVersion: dress.version }));
    expect(archived.status).toBe("archived");
    expect(ok(await catalog.storefront.listProducts({ locale: "en" })).items).toEqual([]);
  });

  it("filters by category including its visible subcategories, and paginates", async () => {
    const w = await world();
    const dress = await eveningDress(w, "2030-02-01T00:00:00Z");
    const sc = await scarf(w, "2030-03-01T00:00:00Z");
    const ids = async (categoryId?: string, extra: { page?: number; pageSize?: number } = {}) =>
      ok(await catalog.storefront.listProducts({ locale: "en", categoryId, ...extra })).items.map((p) => p.id);

    expect(await ids(w.women)).toEqual([dress.productId]); // via its subcategory and extra membership
    expect(await ids(w.dresses)).toEqual([dress.productId]);
    expect(await ids(w.sale)).toEqual([sc.productId]);

    const first = ok(await catalog.storefront.listProducts({ locale: "en", pageSize: 1, page: 1 }));
    const second = ok(await catalog.storefront.listProducts({ locale: "en", pageSize: 1, page: 2 }));
    const beyond = ok(await catalog.storefront.listProducts({ locale: "en", pageSize: 1, page: 3 }));
    expect([first.items[0]?.id, second.items[0]?.id, beyond.items.length]).toEqual([sc.productId, dress.productId, 0]);
    expect([first.total, second.total, beyond.total, first.pageSize, beyond.page]).toEqual([2, 2, 2, 1, 3]);

    ok(await catalog.categories.archive(manager(), { categoryId: w.oldChild }));
    ok(await catalog.categories.archive(manager(), { categoryId: w.old }));
    expect(codes(await catalog.storefront.listProducts({ locale: "en", categoryId: w.old }))).toEqual(["not_found"]);
  });

  it("clamps paging input and treats non-finite values as the defaults", async () => {
    const w = await world();
    await eveningDress(w, "2030-02-01T00:00:00Z");
    const list = async (page?: number, pageSize?: number) => ok(await catalog.storefront.listProducts({ locale: "en", page, pageSize }));
    expect(await list(Number.NaN, Number.NaN)).toMatchObject({ page: 1, pageSize: 24, total: 1 });
    expect(await list(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toMatchObject({ page: 1, pageSize: 24 });
    expect(await list(0, 0)).toMatchObject({ page: 1, pageSize: 1 });
    expect(await list(-5, 1000)).toMatchObject({ page: 1, pageSize: 60 });
    expect((await list(2.9, 1.9)).page).toBe(2);
  });

  it("builds cards with localized text, primary image, brand and the colours of active variants", async () => {
    const w = await world();
    const dress = await eveningDress(w, "2030-02-01T00:00:00Z");
    await scarf(w, "2030-03-01T00:00:00Z");

    const en1 = ok(await catalog.storefront.listProducts({ locale: "en" })).items.find((p) => p.id === dress.productId)!;
    expect(en1).toMatchObject({ slug: "evening-dress", name: "Evening dress", slugs: { fa: "پیراهن-مجلسی", en: "evening-dress" }, brand: { key: "house", name: "House" } });
    expect(en1.image).toMatchObject({ view: "front", position: 0, alt: "Red dress", width: 800, height: 1200 });
    expect(en1.image?.storageKey).toMatch(/^products\/photo-\d+\.jpg$/);
    expect(en1.colors.map((c) => [c.key, c.label, c.swatchHex])).toEqual([["red", "Red", "#C00000"], ["blue", "Blue", "#0000C0"]]);
    expect(en1.publishedAt).toEqual(new Date("2030-02-01T00:00:00Z"));

    const fa1 = ok(await catalog.storefront.listProducts({ locale: "fa" })).items.find((p) => p.id === dress.productId)!;
    expect([fa1.name, fa1.slug, fa1.image?.alt, fa1.colors[0]?.label]).toEqual(["پیراهن مجلسی", "پیراهن-مجلسی", "پیراهن قرمز", "قرمز"]);

    // Persian-only product under /en: Persian text, no alt text, no colours
    const scarfCard = ok(await catalog.storefront.listProducts({ locale: "en" })).items.find((p) => p.name === "روسری")!;
    expect(scarfCard).toMatchObject({ slug: "روسری", brand: null, colors: [] });
    expect(scarfCard.image?.alt).toBeNull();

    // discontinuing both blue variants removes blue from the card
    const blue = dress.variants.filter((v) => v.sku.startsWith("DRESS-BLUE"));
    for (const variant of blue) ok(await catalog.variants.discontinue(manager(), { variantId: variant.variantId }));
    const after = ok(await catalog.storefront.listProducts({ locale: "en" })).items.find((p) => p.id === dress.productId)!;
    expect(after.colors.map((c) => c.key)).toEqual(["red"]);
  });
});

describe("product page", () => {
  it("returns the full public view without internal data", async () => {
    const w = await world();
    const dress = await eveningDress(w, "2030-02-01T00:00:00Z");
    const product = ok(await catalog.storefront.getProduct({ locale: "en", slug: "evening-dress" }));

    expect(product).toMatchObject({ id: dress.productId, slug: "evening-dress", name: "Evening dress", description: "Cotton", seoTitle: "Evening dress | House", slugs: { fa: "پیراهن-مجلسی", en: "evening-dress" } });
    expect(product.brand).toMatchObject({ key: "house", name: "House" });
    expect(product.breadcrumb.map((c) => c.slug)).toEqual(["women", "dresses"]);
    expect(product.axes.map((a) => [a.key, a.kind, a.name, a.values.map((x) => x.label)])).toEqual([
      ["color", "color", "Colour", ["Red", "Blue"]],
      ["size_women", "size", "Size", ["Small", "Medium"]],
    ]);
    expect(product.variants.map((v) => v.valueIds)).toEqual([
      [w.v.red, w.v.s],
      [w.v.red, w.v.m],
      [w.v.blue, w.v.s],
      [w.v.blue, w.v.m],
    ]);
    expect(product.images.map((i) => [i.view, i.position, i.colorValueId])).toEqual([["front", 0, w.v.red], ["back", 1, w.v.red], ["front", 2, w.v.blue]]);
    expect(product.attributes.map((a) => a.key).sort()).toEqual(["care", "fabric", "length", "lined"]);
    const byKey = Object.fromEntries(product.attributes.map((a) => [a.key, a]));
    expect(byKey.fabric).toMatchObject({ values: ["Cotton"] });
    expect(byKey.length).toMatchObject({ number: "112.5", unit: "cm" });
    expect(byKey.lined).toMatchObject({ boolean: true });
    expect(byKey.care).toMatchObject({ text: "Hand wash" });

    const serialized = JSON.stringify(product);
    for (const secret of ["DRESS-RED-S", "4006381333931", "sku", "barcode", "version", "status", "sha256"]) expect(serialized).not.toContain(secret);
  });

  it("resolves a slug of another locale and falls back to Persian text", async () => {
    const w = await world();
    await eveningDress(w, "2030-02-01T00:00:00Z");
    await scarf(w, "2030-03-01T00:00:00Z");
    const cross = ok(await catalog.storefront.getProduct({ locale: "en", slug: "پیراهن-مجلسی" }));
    expect(cross.slug).toBe("evening-dress"); // differs from the requested slug: redirect to the canonical URL
    const persianOnly = ok(await catalog.storefront.getProduct({ locale: "en", slug: "روسری" }));
    expect([persianOnly.name, persianOnly.slug, persianOnly.axes, persianOnly.variants.length]).toEqual(["روسری", "روسری", [], 1]);
  });

  it("never shows drafts, unpublished or archived products, and shows them again once republished", async () => {
    const w = await world();
    const dress = await eveningDress(w, "2030-02-01T00:00:00Z");
    const d = await draft(w);
    expect(d.productId).toBeTruthy();
    expect(codes(await catalog.storefront.getProduct({ locale: "fa", slug: "پیش-نویس" }))).toEqual(["not_found"]);

    const draftAgain = ok(await catalog.publication.unpublish(manager(), { productId: dress.productId, expectedVersion: dress.version }));
    expect(codes(await catalog.storefront.getProduct({ locale: "en", slug: "evening-dress" }))).toEqual(["not_found"]);
    ok(await catalog.publication.publish(manager(), { productId: dress.productId, expectedVersion: draftAgain.version }));
    expect(ok(await catalog.storefront.getProduct({ locale: "en", slug: "evening-dress" })).id).toBe(dress.productId);
  });

  it("offers only values and variants that an active variant still uses", async () => {
    const w = await world();
    const dress = await eveningDress(w, "2030-02-01T00:00:00Z");
    for (const variant of dress.variants.filter((v) => v.sku.startsWith("DRESS-BLUE"))) ok(await catalog.variants.discontinue(manager(), { variantId: variant.variantId }));
    const product = ok(await catalog.storefront.getProduct({ locale: "en", slug: "evening-dress" }));
    expect(product.axes[0]?.values.map((v) => v.key)).toEqual(["red"]);
    expect(product.variants).toHaveLength(2);
  });

  it("keeps a published product visible when its category is later archived, without a breadcrumb", async () => {
    const w = await world();
    await eveningDress(w, "2030-02-01T00:00:00Z");
    ok(await catalog.categories.archive(manager(), { categoryId: w.dresses }));
    const product = ok(await catalog.storefront.getProduct({ locale: "en", slug: "evening-dress" }));
    expect(product.breadcrumb).toEqual([]);
  });
});
