import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { ANONYMOUS, AuthorizationError, createRequestContext, type Actor, type Permission, type RequestContext } from "@/shared/kernel/authorization";

import { createCatalog, type Catalog } from "./application/catalog";
import { CATALOG_PERMISSIONS } from "./domain/permissions";

// Phase 2C Step 4: product core — create, update (optimistic locking), archive, restore,
// translations, category assignment and typed descriptive values — against a throwaway
// PostgreSQL as the least-privilege application role, with a fake Authorizer.

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

const ctxWith = (permissions: readonly Permission[], actor: Actor = { kind: "user", userId: "u-1", sessionId: "s-1" }): RequestContext => {
  const allowed = new Set<string>(permissions);
  return createRequestContext({ requestId: "req-test", actor, authorizer: { isAllowed: async (_a, p) => allowed.has(p) } });
};
const manager = () => ctxWith(Object.values(CATALOG_PERMISSIONS));
const editor = () => ctxWith([CATALOG_PERMISSIONS.productsRead, CATALOG_PERMISSIONS.productsManage, CATALOG_PERMISSIONS.mediaManage]);
const nobody = () => ctxWith([]);
const anonymous = () => ctxWith(Object.values(CATALOG_PERMISSIONS), ANONYMOUS);

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query(sql, params);
  return Number(rows[0].n);
}
const events = (type?: string) => count(type ? "SELECT count(*) AS n FROM outbox_events WHERE type = $1" : "SELECT count(*) AS n FROM outbox_events", type ? [type] : []);

function ok<T>(result: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  return result.value;
}
const codes = (result: { ok: boolean; issues?: readonly { code: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.code));
const fa = (name: string, extra: Record<string, string> = {}) => ({ locale: "fa", name, ...extra });
const en = (name: string, extra: Record<string, string> = {}) => ({ locale: "en", name, ...extra });

/** Taxonomy built through the Step 3 services. */
async function taxonomy() {
  const m = manager();
  const cat = async (key: string, parentId: string | null = null) => ok(await catalog.categories.create(m, { key, parentId, translations: [fa(key, { slug: key })] })).categoryId;
  const women = await cat("women");
  const dresses = await cat("women-dresses", women);
  const sale = await cat("sale");
  const brand = ok(await catalog.brands.create(m, { key: "house", translations: [fa("خانه")] })).brandId;
  const attr = async (key: string, usage: string, valueType: string, extra: Record<string, string> = {}) =>
    ok(await catalog.attributes.create(m, { key, usage, valueType, translations: [fa(key)], ...extra })).attributeId;
  const material = await attr("material", "descriptive", "select");
  const length = await attr("length", "descriptive", "number", { unit: "cm" });
  const lined = await attr("lined", "descriptive", "boolean");
  const care = await attr("care", "descriptive", "text");
  const size = await attr("size_women", "variant_axis", "select", { axisKind: "size" });
  const value = async (attributeId: string, key: string) => ok(await catalog.attributes.createValue(m, { attributeId, key, translations: [fa(key)] })).valueId;
  const cotton = await value(material, "cotton");
  const linen = await value(material, "linen");
  const silk = await value(material, "silk");
  const small = await value(size, "s");
  return { women, dresses, sale, brand, material, length, lined, care, size, cotton, linen, silk, small };
}

type T = Awaited<ReturnType<typeof taxonomy>>;

const dressInput = (t: T, slug = "پیراهن-مجلسی") => ({
  translations: [fa("پیراهن مجلسی", { slug, description: "پارچه کتان" }), en("Evening dress")],
  brandId: t.brand,
  primaryCategoryId: t.dresses,
  categoryIds: [t.women],
  attributes: [
    { attributeId: t.material, valueIds: [t.cotton, t.linen] },
    { attributeId: t.length, number: "112.50" },
    { attributeId: t.lined, boolean: true },
    { attributeId: t.care, text: [fa("شست‌وشو با دست"), en("Hand wash")] },
  ],
});

// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("needs products.manage to write, products.publish to archive/restore and products.read to read", async () => {
    const t = await taxonomy();
    const { productId, version } = ok(await catalog.products.create(editor(), dressInput(t))); // editors may create
    const before = await events();

    await expect(catalog.products.create(nobody(), dressInput(t, "x"))).rejects.toMatchObject({ code: "forbidden", permission: "catalog:products.manage" });
    await expect(catalog.products.update(nobody(), { productId, expectedVersion: version, brandId: null })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(catalog.products.archive(editor(), { productId, expectedVersion: version })).rejects.toMatchObject({ code: "forbidden", permission: "catalog:products.publish" });
    await expect(catalog.products.restore(editor(), { productId, expectedVersion: version })).rejects.toMatchObject({ code: "forbidden" });
    await expect(catalog.products.get(nobody(), { productId })).rejects.toMatchObject({ code: "forbidden", permission: "catalog:products.read" });
    await expect(catalog.products.create(anonymous(), dressInput(t, "y"))).rejects.toMatchObject({ code: "unauthenticated" });

    expect(await events()).toBe(before);
    expect(await count("SELECT count(*) AS n FROM products")).toBe(1);
    expect(ok(await catalog.products.get(editor(), { productId })).version).toBe(version);
  });
});

describe("create", () => {
  it("creates a draft with translations, categories, brand and typed descriptive values", async () => {
    const t = await taxonomy();
    const created = ok(await catalog.products.create(manager(), dressInput(t)));
    expect(created.version).toBe(1);
    const view = ok(await catalog.products.get(manager(), { productId: created.productId }));
    expect(view).toMatchObject({ status: "draft", version: 1, brandId: t.brand, primaryCategoryId: t.dresses, categoryIds: [t.dresses, t.women], axisCount: 0, publishedAt: null, archivedAt: null });
    expect(view.translations.map((x) => [x.locale, x.name, x.slug])).toEqual([
      ["en", "Evening dress", "evening-dress"],
      ["fa", "پیراهن مجلسی", "پیراهن-مجلسی"],
    ]);
    expect(view.attributes).toEqual([
      { attributeId: t.material, valueType: "select", valueIds: [t.cotton, t.linen] },
      { attributeId: t.length, valueType: "number", number: "112.5" },
      { attributeId: t.lined, valueType: "boolean", boolean: true },
      { attributeId: t.care, valueType: "text", text: expect.arrayContaining([expect.objectContaining({ locale: "fa", name: "شست‌وشو با دست" })]) },
    ]);
    const { rows } = await db.pool.query("SELECT type, aggregate_type, aggregate_id, payload FROM outbox_events WHERE type LIKE 'catalog.product.%'");
    expect(rows).toEqual([{ type: "catalog.product.created", aggregate_type: "product", aggregate_id: created.productId, payload: { productId: created.productId } }]);
  });

  it("validates everything and writes nothing on failure", async () => {
    const t = await taxonomy();
    ok(await catalog.categories.archive(manager(), { categoryId: t.sale }));
    ok(await catalog.brands.archive(manager(), { brandId: t.brand }));
    const before = await events();
    const cases: [Record<string, unknown>, string[]][] = [
      [{ translations: [en("English only")] }, ["missing_required_translation"]],
      [{ primaryCategoryId: "0193b7a0-0000-7000-8000-000000000999" }, ["category_not_found"]],
      [{ categoryIds: [t.sale] }, ["category_archived"]],
      [{ brandId: t.brand }, ["brand_archived"]],
      [{ brandId: "0193b7a0-0000-7000-8000-000000000999" }, ["brand_not_found"]],
      [{ attributes: [{ attributeId: t.size, valueIds: [t.small] }] }, ["attribute_not_descriptive"]],
      [{ attributes: [{ attributeId: t.material, valueIds: [t.small] }] }, ["value_not_in_attribute"]],
      [{ attributes: [{ attributeId: t.length, number: "1.23456" }] }, ["invalid_number"]],
    ];
    for (const [patch, expected] of cases) {
      const input = { ...dressInput(t), brandId: null, ...patch };
      expect(codes(await catalog.products.create(manager(), input as never)), JSON.stringify(patch)).toEqual(expected);
    }
    expect(await count("SELECT count(*) AS n FROM products")).toBe(0);
    expect(await events()).toBe(before);
  });

  it("refuses a Persian slug another product already uses", async () => {
    const t = await taxonomy();
    ok(await catalog.products.create(manager(), dressInput(t)));
    const second = await catalog.products.create(manager(), { ...dressInput(t), translations: [fa("پیراهن دیگر", { slug: "پیراهن-مجلسی" })] });
    expect(!second.ok && second.issues).toEqual([{ code: "slug_taken", path: "translations.fa.slug" }]);
  });
});

describe("update", () => {
  it("uses optimistic locking: a stale version is a conflict, each success bumps the version", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    expect(ok(await catalog.products.update(manager(), { productId, expectedVersion: 1, brandId: null }))).toEqual({ productId, version: 2 });
    const stale = await catalog.products.update(manager(), { productId, expectedVersion: 1, brandId: t.brand });
    expect(!stale.ok && stale.issues).toEqual([{ code: "version_conflict", path: "expectedVersion", detail: { current: 2 } }]);
    expect(ok(await catalog.products.get(manager(), { productId })).brandId).toBeNull();
    expect(await events("catalog.product.updated")).toBe(1);
  });

  it("lets exactly one of two concurrent updates from the same version win", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    const results = await Promise.all([
      catalog.products.update(manager(), { productId, expectedVersion: 1, translations: [fa("نسخه الف")] }),
      catalog.products.update(manager(), { productId, expectedVersion: 1, translations: [fa("نسخه ب")] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map(codes)).toEqual([["version_conflict"]]);
    const view = ok(await catalog.products.get(manager(), { productId }));
    expect(view.version).toBe(2);
    expect(["نسخه الف", "نسخه ب"]).toContain(view.translations[0]?.name);
  });

  it("replaces only the sections that are given", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    ok(await catalog.products.update(manager(), { productId, expectedVersion: 1, translations: [fa("پیراهن شب", { slug: "پیراهن-شب" })] }));
    let view = ok(await catalog.products.get(manager(), { productId }));
    expect(view.translations.map((x) => x.locale)).toEqual(["fa"]); // English removed, as replaced
    expect(view.categoryIds).toEqual([t.dresses, t.women]); // untouched
    expect(view.attributes).toHaveLength(4); // untouched

    ok(await catalog.products.update(manager(), { productId, expectedVersion: 2, attributes: [{ attributeId: t.lined, boolean: false }] }));
    view = ok(await catalog.products.get(manager(), { productId }));
    expect(view.attributes).toEqual([{ attributeId: t.lined, valueType: "boolean", boolean: false }]);
    expect(await count("SELECT count(*) AS n FROM product_attribute_value_translations")).toBe(0); // text rows went with their values
  });

  it("switches the primary category and replaces the others in one transaction", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    ok(await catalog.products.update(manager(), { productId, expectedVersion: 1, primaryCategoryId: t.sale, categoryIds: [t.women] }));
    let view = ok(await catalog.products.get(manager(), { productId }));
    expect([view.primaryCategoryId, view.categoryIds]).toEqual([t.sale, [t.sale, t.women]]);
    // primary alone: the other categories stay
    ok(await catalog.products.update(manager(), { productId, expectedVersion: 2, primaryCategoryId: t.women }));
    view = ok(await catalog.products.get(manager(), { productId }));
    expect([view.primaryCategoryId, [...view.categoryIds].sort()]).toEqual([t.women, [t.sale, t.women].sort()]);
    // dropping everything but the primary
    ok(await catalog.products.update(manager(), { productId, expectedVersion: 3, categoryIds: [] }));
    expect(ok(await catalog.products.get(manager(), { productId })).categoryIds).toEqual([t.women]);
    expect(await count("SELECT count(*) AS n FROM product_categories WHERE product_id = $1", [productId])).toBe(1);
  });

  it("keeps archived references the product already has, but refuses new ones", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    ok(await catalog.categories.archive(manager(), { categoryId: t.sale })); // not assigned yet
    ok(await catalog.attributes.archiveValue(manager(), { valueId: t.cotton })); // assigned
    ok(await catalog.attributes.archiveValue(manager(), { valueId: t.silk })); // not assigned
    ok(await catalog.brands.archive(manager(), { brandId: t.brand })); // assigned

    // keeping cotton and the brand while editing other things is fine
    ok(await catalog.products.update(manager(), { productId, expectedVersion: 1, brandId: t.brand, attributes: [{ attributeId: t.material, valueIds: [t.cotton] }] }));
    expect(codes(await catalog.products.update(manager(), { productId, expectedVersion: 2, attributes: [{ attributeId: t.material, valueIds: [t.silk] }] }))).toEqual(["value_archived"]);
    expect(codes(await catalog.products.update(manager(), { productId, expectedVersion: 2, categoryIds: [t.sale] }))).toEqual(["category_archived"]);
    expect(ok(await catalog.products.get(manager(), { productId })).version).toBe(2);
  });

  it("rolls back every write when the operation fails part-way", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    const before = ok(await catalog.products.get(manager(), { productId }));
    const eventsBefore = await events();
    // Translations, categories and attributes are written before the product row; an invalid
    // clock makes that last write fail.
    clock = new Date(Number.NaN);
    await expect(
      catalog.products.update(manager(), {
        productId,
        expectedVersion: 1,
        translations: [fa("باید برگردد", { slug: "rollback" })],
        categoryIds: [t.sale],
        attributes: [{ attributeId: t.lined, boolean: false }],
      }),
    ).rejects.toThrow();
    clock = new Date("2030-01-01T00:00:00Z");
    const after = ok(await catalog.products.get(manager(), { productId }));
    expect(after).toEqual(before);
    expect(await events()).toBe(eventsBefore);
  });

  it("reports unknown products", async () => {
    expect(codes(await catalog.products.update(manager(), { productId: "0193b7a0-0000-7000-8000-000000000999", expectedVersion: 1, brandId: null }))).toEqual(["not_found"]);
    expect(codes(await catalog.products.get(manager(), { productId: "0193b7a0-0000-7000-8000-000000000999" }))).toEqual(["not_found"]);
  });
});

describe("archive and restore", () => {
  it("archives, makes the product read-only, restores it to draft, and never deletes", async () => {
    const t = await taxonomy();
    const { productId } = ok(await catalog.products.create(manager(), dressInput(t)));
    expect(ok(await catalog.products.archive(manager(), { productId, expectedVersion: 1 }))).toEqual({ productId, version: 2, status: "archived" });
    let view = ok(await catalog.products.get(manager(), { productId }));
    expect([view.status, view.archivedAt?.toISOString()]).toEqual(["archived", clock.toISOString()]);

    expect(codes(await catalog.products.update(manager(), { productId, expectedVersion: 2, brandId: null }))).toEqual(["product_archived"]);
    expect(codes(await catalog.products.archive(manager(), { productId, expectedVersion: 2 }))).toEqual(["invalid_transition"]);
    expect(codes(await catalog.products.restore(manager(), { productId, expectedVersion: 1 }))).toEqual(["version_conflict"]);

    ok(await catalog.products.restore(manager(), { productId, expectedVersion: 2 }));
    view = ok(await catalog.products.get(manager(), { productId }));
    expect([view.status, view.archivedAt, view.version]).toEqual(["draft", null, 3]);
    expect(codes(await catalog.products.restore(manager(), { productId, expectedVersion: 3 }))).toEqual(["invalid_transition"]);

    expect(await events("catalog.product.archived")).toBe(1);
    expect(await events("catalog.product.restored")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM products")).toBe(1);
  });
});

describe("concurrency", () => {
  it("lets one of several concurrent creates with the same slug win, with no partial rows", async () => {
    const t = await taxonomy();
    const results = await Promise.all([1, 2, 3, 4].map(() => catalog.products.create(manager(), dressInput(t))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => codes(r).join() === "slug_taken")).toBe(true);
    expect(await count("SELECT count(*) AS n FROM products")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM product_categories")).toBe(2);
    expect(await events("catalog.product.created")).toBe(1);
  });

  // A product write takes FOR SHARE on the references it checks, so an archive of one of them
  // either commits first (the assignment is then refused) or waits for the write (the product
  // keeps the reference, which is allowed to be archived afterwards). Never a refused-yet-assigned
  // or accepted-yet-missing state.
  it("keeps category archive vs. assigning that category consistent", async () => {
    const t = await taxonomy();
    for (let i = 0; i < 10; i++) {
      const created = ok(await catalog.products.create(manager(), { ...dressInput(t, `cat-slug-${i}`), translations: [fa("پیراهن", { slug: `cat-slug-${i}` }), en(`Cat dress ${i}`, { slug: `cat-dress-${i}` })], brandId: null }));
      const extra = ok(await catalog.categories.create(manager(), { key: `extra-${i}`, translations: [fa(`extra-${i}`, { slug: `extra-${i}` })] })).categoryId;
      const [assign, archive] = await Promise.all([
        catalog.products.update(manager(), { productId: created.productId, expectedVersion: 1, categoryIds: [t.women, extra] }),
        catalog.categories.archive(manager(), { categoryId: extra }),
      ]);
      expect(archive.ok).toBe(true);
      expect(await count("SELECT count(*) AS n FROM categories WHERE id = $1 AND status = 'archived'", [extra])).toBe(1);
      const assigned = await count("SELECT count(*) AS n FROM product_categories WHERE product_id = $1 AND category_id = $2", [created.productId, extra]);
      if (assign.ok) expect(assigned).toBe(1);
      else {
        expect(codes(assign)).toEqual(["category_archived"]);
        expect(assigned).toBe(0);
      }
    }
  });

  it("keeps brand archive vs. assigning that brand consistent", async () => {
    const t = await taxonomy();
    for (let i = 0; i < 10; i++) {
      const created = ok(await catalog.products.create(manager(), { ...dressInput(t, `slug-${i}`), translations: [fa("پیراهن", { slug: `slug-${i}` }), en(`Brand dress ${i}`, { slug: `brand-dress-${i}` })], brandId: null }));
      const brand = ok(await catalog.brands.create(manager(), { key: `race-brand-${i}`, translations: [fa(`برند ${i}`)] })).brandId;
      const [assign, archive] = await Promise.all([
        catalog.products.update(manager(), { productId: created.productId, expectedVersion: 1, brandId: brand }),
        catalog.brands.archive(manager(), { brandId: brand }),
      ]);
      expect(archive.ok).toBe(true);
      const { rows } = await db.pool.query("SELECT brand_id FROM products WHERE id = $1", [created.productId]);
      if (assign.ok) expect(rows[0].brand_id).toBe(brand);
      else {
        expect(codes(assign)).toEqual(["brand_archived"]);
        expect(rows[0].brand_id).toBeNull();
      }
    }
  });

  it("makes an archive wait for an in-flight product write that holds the reference", async () => {
    const t = await taxonomy();
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM brands WHERE id = $1 FOR SHARE", [t.brand]);
      let done = false;
      const archiving = catalog.brands.archive(manager(), { brandId: t.brand }).then((r) => ((done = true), r));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      await holder.query("COMMIT");
      expect((await archiving).ok).toBe(true);
    } finally {
      holder.release();
    }
  });
});
