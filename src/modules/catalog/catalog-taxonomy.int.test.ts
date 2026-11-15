import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { ANONYMOUS, AuthorizationError, createRequestContext, type Actor, type Permission, type RequestContext } from "@/shared/kernel/authorization";

import { createCatalog, type Catalog } from "./application/catalog";
import { CATALOG_PERMISSIONS } from "./domain/permissions";

// Phase 2C Step 3: taxonomy services against a throwaway PostgreSQL, running as the
// least-privilege application role. Authorization uses the kernel contract with a fake
// Authorizer; identity is not involved (catalog never imports it).

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

const ALL = Object.values(CATALOG_PERMISSIONS);
const EDITOR: Permission[] = [CATALOG_PERMISSIONS.productsRead, CATALOG_PERMISSIONS.productsManage, CATALOG_PERMISSIONS.mediaManage];

function contextWith(permissions: readonly Permission[], actor: Actor = { kind: "user", userId: "u-1", sessionId: "s-1" }): RequestContext {
  const allowed = new Set<string>(permissions);
  return createRequestContext({ requestId: "req-test", actor, authorizer: { isAllowed: async (_actor, permission) => allowed.has(permission) } });
}

const manager = () => contextWith(ALL);
const editor = () => contextWith(EDITOR);
const nobody = () => contextWith([]);
const anonymous = () => contextWith(ALL, ANONYMOUS);

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query(sql, params);
  return Number(rows[0].n);
}
const events = (type?: string) => count(type ? "SELECT count(*) AS n FROM outbox_events WHERE type = $1" : "SELECT count(*) AS n FROM outbox_events", type ? [type] : []);

/** Unwraps a successful result or fails the test with its issues. */
function ok<T>(result: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  return result.value;
}
const codes = (result: { ok: boolean; issues?: readonly { code: string; path?: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.code));

const fa = (name: string, extra: Record<string, string> = {}) => ({ locale: "fa", name, ...extra });
const en = (name: string, extra: Record<string, string> = {}) => ({ locale: "en", name, ...extra });

async function category(key: string, parentId: string | null = null, name = key) {
  return ok(await catalog.categories.create(manager(), { key, parentId, translations: [fa(`دسته ${name}`, { slug: key }), en(name)] })).categoryId;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("refuses every taxonomy write without catalog:taxonomy.manage, writing nothing", async () => {
    const women = await category("women");
    const attr = ok(await catalog.attributes.create(manager(), { key: "color", usage: "variant_axis", valueType: "select", axisKind: "color", translations: [fa("رنگ")] })).attributeId;
    const value = ok(await catalog.attributes.createValue(manager(), { attributeId: attr, key: "red", translations: [fa("قرمز")] })).valueId;
    const brand = ok(await catalog.brands.create(manager(), { key: "house", translations: [fa("خانه")] })).brandId;
    const before = { events: await events(), categories: await count("SELECT count(*) AS n FROM categories") };

    const writes: [string, (ctx: RequestContext) => Promise<unknown>][] = [
      ["categories.create", (ctx) => catalog.categories.create(ctx, { key: "kids", translations: [fa("بچگانه")] })],
      ["categories.update", (ctx) => catalog.categories.update(ctx, { categoryId: women, translations: [fa("زنانه")] })],
      ["categories.move", (ctx) => catalog.categories.move(ctx, { categoryId: women, parentId: null })],
      ["categories.reorder", (ctx) => catalog.categories.reorder(ctx, { parentId: null, orderedIds: [women] })],
      ["categories.archive", (ctx) => catalog.categories.archive(ctx, { categoryId: women })],
      ["categories.restore", (ctx) => catalog.categories.restore(ctx, { categoryId: women })],
      ["brands.create", (ctx) => catalog.brands.create(ctx, { key: "other", translations: [fa("دیگر")] })],
      ["brands.update", (ctx) => catalog.brands.update(ctx, { brandId: brand, translations: [fa("خانه")] })],
      ["brands.archive", (ctx) => catalog.brands.archive(ctx, { brandId: brand })],
      ["brands.restore", (ctx) => catalog.brands.restore(ctx, { brandId: brand })],
      ["attributes.create", (ctx) => catalog.attributes.create(ctx, { key: "fit", usage: "descriptive", valueType: "text", translations: [fa("فرم")] })],
      ["attributes.update", (ctx) => catalog.attributes.update(ctx, { attributeId: attr, translations: [fa("رنگ")] })],
      ["attributes.archive", (ctx) => catalog.attributes.archive(ctx, { attributeId: attr })],
      ["attributes.restore", (ctx) => catalog.attributes.restore(ctx, { attributeId: attr })],
      ["attributes.createValue", (ctx) => catalog.attributes.createValue(ctx, { attributeId: attr, key: "blue", translations: [fa("آبی")] })],
      ["attributes.updateValue", (ctx) => catalog.attributes.updateValue(ctx, { valueId: value, swatchHex: "#f00" })],
      ["attributes.reorderValues", (ctx) => catalog.attributes.reorderValues(ctx, { attributeId: attr, orderedIds: [value] })],
      ["attributes.archiveValue", (ctx) => catalog.attributes.archiveValue(ctx, { valueId: value })],
      ["attributes.restoreValue", (ctx) => catalog.attributes.restoreValue(ctx, { valueId: value })],
    ];
    for (const [name, write] of writes) {
      await expect(write(editor()), `${name} as editor`).rejects.toMatchObject({ name: "AuthorizationError", code: "forbidden", permission: "catalog:taxonomy.manage" });
      await expect(write(anonymous()), `${name} anonymous`).rejects.toMatchObject({ name: "AuthorizationError", code: "unauthenticated" });
    }
    expect(await events()).toBe(before.events);
    expect(await count("SELECT count(*) AS n FROM categories")).toBe(before.categories);
  });

  it("lets catalog:products.read holders read the taxonomy, and nobody else", async () => {
    await category("women");
    expect(await catalog.categories.tree(editor())).toHaveLength(1);
    expect(await catalog.brands.list(editor())).toEqual([]);
    expect(await catalog.attributes.list(editor())).toEqual([]);
    for (const read of [() => catalog.categories.tree(nobody()), () => catalog.brands.list(nobody()), () => catalog.attributes.list(nobody())]) {
      await expect(read()).rejects.toBeInstanceOf(AuthorizationError);
    }
  });
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

describe("categories", () => {
  it("creates departments and children with normalized translations, positions and an ID-only event", async () => {
    const women = ok(await catalog.categories.create(manager(), { key: " Women ", translations: [fa("  پوشاک  زنانه "), en("Women")] })).categoryId;
    const kids = await category("kids");
    const dresses = ok(await catalog.categories.create(manager(), { key: "women-dresses", parentId: women, translations: [fa("پيراهن")] })).categoryId;

    const tree = await catalog.categories.tree(manager());
    expect(tree.map((c) => [c.key, c.parentId, c.position])).toEqual([
      ["women-dresses", women, 0],
      ["women", null, 0],
      ["kids", null, 1],
    ]);
    const womenView = tree.find((c) => c.id === women);
    expect(womenView?.translations.map((t) => [t.locale, t.name, t.slug])).toEqual([
      ["en", "Women", "women"],
      ["fa", "پوشاک زنانه", "پوشاک-زنانه"],
    ]);
    expect(tree.find((c) => c.id === dresses)?.translations[0]?.name).toBe("پیراهن"); // Arabic yeh normalized

    const { rows } = await db.pool.query("SELECT type, aggregate_type, aggregate_id, payload FROM outbox_events ORDER BY occurred_at, id");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ type: "catalog.category.changed", aggregate_type: "category", aggregate_id: women, payload: { categoryId: women } });
    expect(rows.map((r) => r.payload.categoryId)).toEqual([women, kids, dresses]);
  });

  it("validates input and reports every problem without writing", async () => {
    expect(codes(await catalog.categories.create(manager(), { key: "1bad", translations: [en("Only English")] }))).toEqual(["invalid_key", "missing_required_translation"]);
    // a blank name leaves nothing to derive the slug from, so both are reported
    expect(codes(await catalog.categories.create(manager(), { key: "ok-key", translations: [fa("   ")] }))).toEqual(["invalid_name", "invalid_slug"]);
    expect(await count("SELECT count(*) AS n FROM categories")).toBe(0);
    expect(await events()).toBe(0);
  });

  it("refuses taken keys and slugs (per locale)", async () => {
    await category("women");
    expect(codes(await catalog.categories.create(manager(), { key: "women", translations: [fa("دیگر")] }))).toEqual(["key_taken"]);
    const taken = await catalog.categories.create(manager(), { key: "women-2", translations: [fa("دسته women", { slug: "women" })] });
    expect(!taken.ok && taken.issues).toEqual([{ code: "slug_taken", path: "translations.fa.slug" }]);
    // the English slug "women" (derived from the name) is taken as well
    expect(codes(await catalog.categories.create(manager(), { key: "women-3", translations: [fa("سوم"), en("Women")] }))).toEqual(["slug_taken"]);
    ok(await catalog.categories.create(manager(), { key: "women-4", translations: [fa("چهارم"), en("Women Four")] }));
  });

  it("enforces the tree: active parent, at most four levels, no cycles", async () => {
    const l1 = await category("l1");
    const l2 = await category("l2", l1);
    const l3 = await category("l3", l2);
    const l4 = await category("l4", l3);
    expect(codes(await catalog.categories.create(manager(), { key: "l5", parentId: l4, translations: [fa("پنج")] }))).toEqual(["category_too_deep"]);
    expect(codes(await catalog.categories.create(manager(), { key: "orphan", parentId: "0193b7a0-0000-7000-8000-000000000999", translations: [fa("یتیم")] }))).toEqual([
      "category_not_found",
    ]);
    expect(codes(await catalog.categories.move(manager(), { categoryId: l1, parentId: l3 }))).toEqual(["category_cycle"]);
    const other = await category("other");
    const otherChild = await category("other-child", other);
    // l2 carries a subtree of height 3: under a level-2 parent its deepest node would be level 5
    expect(codes(await catalog.categories.move(manager(), { categoryId: l2, parentId: otherChild }))).toEqual(["category_too_deep"]);
    // under a level-1 parent it ends exactly at level 4
    expect(ok(await catalog.categories.move(manager(), { categoryId: l2, parentId: other }))).toEqual({ categoryId: l2, depth: 2 });
  });

  it("moves a subtree, appending it to the new parent, and does nothing for a no-op move", async () => {
    const women = await category("women");
    const kids = await category("kids");
    const kidsShoes = await category("kids-shoes", kids);
    await category("women-shoes", women);
    const before = await events();

    expect(ok(await catalog.categories.move(manager(), { categoryId: kidsShoes, parentId: women }))).toEqual({ categoryId: kidsShoes, depth: 2 });
    const moved = (await catalog.categories.tree(manager())).find((c) => c.id === kidsShoes);
    expect([moved?.parentId, moved?.position]).toEqual([women, 1]);
    expect(await events()).toBe(before + 1);

    ok(await catalog.categories.move(manager(), { categoryId: kidsShoes, parentId: women }));
    expect(await events()).toBe(before + 1);
    expect(codes(await catalog.categories.move(manager(), { categoryId: "0193b7a0-0000-7000-8000-000000000999", parentId: null }))).toEqual(["not_found"]);
  });

  it("reorders siblings only with a complete, exact list", async () => {
    const a = await category("a-cat");
    const b = await category("b-cat");
    const c = await category("c-cat");
    expect(codes(await catalog.categories.reorder(manager(), { parentId: null, orderedIds: [c, a] }))).toEqual(["invalid_order"]);
    expect(codes(await catalog.categories.reorder(manager(), { parentId: null, orderedIds: [c, a, a] }))).toEqual(["invalid_order"]);
    const before = await events();
    expect(ok(await catalog.categories.reorder(manager(), { parentId: null, orderedIds: [c, a, b] }))).toEqual({ changed: 3 });
    expect((await catalog.categories.tree(manager())).map((x) => x.id)).toEqual([c, a, b]);
    expect(await events()).toBe(before + 3);
  });

  it("archives leaves first, restores parents first, and is idempotent", async () => {
    const women = await category("women");
    const dresses = await category("women-dresses", women);
    expect(codes(await catalog.categories.archive(manager(), { categoryId: women }))).toEqual(["category_has_active_children"]);
    ok(await catalog.categories.archive(manager(), { categoryId: dresses }));
    ok(await catalog.categories.archive(manager(), { categoryId: women }));
    const before = await events();
    ok(await catalog.categories.archive(manager(), { categoryId: women })); // idempotent: no event
    expect(await events()).toBe(before);

    expect(codes(await catalog.categories.restore(manager(), { categoryId: dresses }))).toEqual(["category_archived"]);
    expect(codes(await catalog.categories.create(manager(), { key: "under-archived", parentId: women, translations: [fa("زیر")] }))).toEqual(["category_archived"]);
    ok(await catalog.categories.restore(manager(), { categoryId: women }));
    ok(await catalog.categories.restore(manager(), { categoryId: dresses }));
    expect((await catalog.categories.tree(manager())).every((c) => c.status === "active")).toBe(true);
    // nothing was deleted along the way
    expect(await count("SELECT count(*) AS n FROM categories")).toBe(2);
  });

  it("replaces translations on update: optional English can go, Persian cannot, and slugs stay unique", async () => {
    const women = await category("women");
    await category("kids");
    ok(await catalog.categories.update(manager(), { categoryId: women, translations: [fa("پوشاک زنانه", { slug: "women" })] }));
    expect((await catalog.categories.tree(manager())).find((c) => c.id === women)?.translations.map((t) => t.locale)).toEqual(["fa"]);
    expect(codes(await catalog.categories.update(manager(), { categoryId: women, translations: [en("Women")] }))).toEqual(["missing_required_translation"]);
    expect(codes(await catalog.categories.update(manager(), { categoryId: women, translations: [fa("بچه", { slug: "kids" })] }))).toEqual(["slug_taken"]);
    expect(codes(await catalog.categories.update(manager(), { categoryId: "0193b7a0-0000-7000-8000-000000000999", translations: [fa("x")] }))).toEqual(["not_found"]);
  });
});

// ---------------------------------------------------------------------------
// Transactions: concurrency and rollback
// ---------------------------------------------------------------------------

describe("transactions", () => {
  it("lets exactly one of several concurrent creates with the same slug win, leaving no partial rows", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => catalog.categories.create(manager(), { key: `race-${i}`, translations: [fa("مسابقه", { slug: "race" })] })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => codes(r).join() === "slug_taken")).toBe(true);
    expect(await count("SELECT count(*) AS n FROM categories")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM category_translations")).toBe(1);
    expect(await events()).toBe(1);
  });

  it("serializes concurrent tree changes so the depth limit holds", async () => {
    const l1 = await category("l1");
    const l2 = await category("l2", l1);
    const l3a = await category("l3a", l2);
    const sub = await category("sub");
    await category("sub-child", sub);
    // Both are valid alone; together they would put sub-child at level 5.
    const [a, b] = await Promise.all([
      catalog.categories.move(manager(), { categoryId: sub, parentId: l3a }),
      catalog.categories.create(manager(), { key: "deep", parentId: l3a, translations: [fa("عمیق")] }),
    ]);
    expect(a.ok || b.ok).toBe(true);
    const tree = await catalog.categories.tree(manager());
    const parents = new Map(tree.map((c) => [c.id, c.parentId]));
    const depth = (id: string | null): number => (id === null ? 0 : 1 + depth(parents.get(id) ?? null));
    expect(Math.max(...tree.map((c) => depth(c.id)))).toBeLessThanOrEqual(4);
  });

  it("rolls back every write of an operation that fails part-way", async () => {
    const women = await category("women");
    const before = { events: await events(), translations: await count("SELECT count(*) AS n FROM category_translations WHERE category_id = $1", [women]) };
    // Translations are replaced before updated_at is written; an invalid clock fails that last write.
    clock = new Date(Number.NaN);
    await expect(catalog.categories.update(manager(), { categoryId: women, translations: [fa("فقط فارسی", { slug: "only-fa" })] })).rejects.toThrow();
    clock = new Date("2030-01-01T00:00:00Z");
    const view = (await catalog.categories.tree(manager())).find((c) => c.id === women);
    expect(view?.translations.map((t) => [t.locale, t.slug])).toEqual([
      ["en", "women"],
      ["fa", "women"],
    ]);
    expect(await count("SELECT count(*) AS n FROM category_translations WHERE category_id = $1", [women])).toBe(before.translations);
    expect(await events()).toBe(before.events);
  });
});

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

describe("brands", () => {
  it("create, update, archive and restore, with events and no deletion", async () => {
    const brand = ok(await catalog.brands.create(manager(), { key: "House-Label", translations: [fa("برند خانه"), en("House Label")] })).brandId;
    expect(codes(await catalog.brands.create(manager(), { key: "house-label", translations: [fa("دیگر")] }))).toEqual(["key_taken"]);
    expect(codes(await catalog.brands.create(manager(), { key: "copy", translations: [fa("برند خانه")] }))).toEqual(["slug_taken"]);
    expect(codes(await catalog.brands.create(manager(), { key: "en-only", translations: [en("English")] }))).toEqual(["missing_required_translation"]);

    ok(await catalog.brands.update(manager(), { brandId: brand, translations: [fa("برند خانه", { description: "توضیح" })] }));
    ok(await catalog.brands.archive(manager(), { brandId: brand }));
    ok(await catalog.brands.archive(manager(), { brandId: brand }));
    let [view] = await catalog.brands.list(manager());
    expect([view?.key, view?.status, view?.translations.map((t) => t.locale), view?.translations[0]?.description]).toEqual(["house-label", "archived", ["fa"], "توضیح"]);
    ok(await catalog.brands.restore(manager(), { brandId: brand }));
    [view] = await catalog.brands.list(manager());
    expect(view?.status).toBe("active");
    expect(await events("catalog.brand.changed")).toBe(4); // create, update, archive, restore (the repeat archive is a no-op)
    expect(codes(await catalog.brands.archive(manager(), { brandId: "0193b7a0-0000-7000-8000-000000000999" }))).toEqual(["not_found"]);
  });
});

// ---------------------------------------------------------------------------
// Attributes and values
// ---------------------------------------------------------------------------

describe("attributes", () => {
  it("creates axis and descriptive attributes with a fixed definition", async () => {
    const color = ok(await catalog.attributes.create(manager(), { key: "color", usage: "variant_axis", valueType: "select", axisKind: "color", translations: [fa("رنگ"), en("Colour")] })).attributeId;
    const length = ok(await catalog.attributes.create(manager(), { key: "length", usage: "descriptive", valueType: "number", unit: "CM", translations: [fa("قد")] })).attributeId;
    expect(codes(await catalog.attributes.create(manager(), { key: "size", usage: "variant_axis", valueType: "select", translations: [fa("سایز")] }))).toEqual(["invalid_attribute_definition"]);
    expect(codes(await catalog.attributes.create(manager(), { key: "color", usage: "descriptive", valueType: "text", translations: [fa("رنگ")] }))).toEqual(["key_taken"]);

    ok(await catalog.attributes.update(manager(), { attributeId: length, unit: "mm" }));
    expect(codes(await catalog.attributes.update(manager(), { attributeId: color, unit: "cm" }))).toEqual(["invalid_attribute_definition"]);
    ok(await catalog.attributes.update(manager(), { attributeId: color, translations: [fa("رنگ‌بندی")] }));

    const list = await catalog.attributes.list(manager());
    expect(list.map((a) => [a.key, a.usage, a.valueType, a.axisKind, a.unit, a.position])).toEqual([
      ["color", "variant_axis", "select", "color", null, 0],
      ["length", "descriptive", "number", null, "mm", 1],
    ]);
    expect(list[0]?.names.map((n) => [n.locale, n.name])).toEqual([["fa", "رنگ‌بندی"]]);
  });

  it("manages values: select attributes only, active attribute, keys unique per attribute, normalized swatches", async () => {
    const color = ok(await catalog.attributes.create(manager(), { key: "color", usage: "variant_axis", valueType: "select", axisKind: "color", translations: [fa("رنگ")] })).attributeId;
    const material = ok(await catalog.attributes.create(manager(), { key: "material", usage: "descriptive", valueType: "select", translations: [fa("جنس")] })).attributeId;
    const lined = ok(await catalog.attributes.create(manager(), { key: "lined", usage: "descriptive", valueType: "boolean", translations: [fa("آستردار")] })).attributeId;

    const red = ok(await catalog.attributes.createValue(manager(), { attributeId: color, key: "Red", swatchHex: "#c00", translations: [fa("قرمز"), en("Red")] })).valueId;
    const black = ok(await catalog.attributes.createValue(manager(), { attributeId: color, key: "black", translations: [fa("مشکی")] })).valueId;
    ok(await catalog.attributes.createValue(manager(), { attributeId: material, key: "red", translations: [fa("قرمز")] })); // same key, other attribute
    expect(codes(await catalog.attributes.createValue(manager(), { attributeId: color, key: "red", translations: [fa("قرمز ۲")] }))).toEqual(["key_taken"]);
    expect(codes(await catalog.attributes.createValue(manager(), { attributeId: lined, key: "yes", translations: [fa("بله")] }))).toEqual(["attribute_type_mismatch"]);
    expect(codes(await catalog.attributes.createValue(manager(), { attributeId: color, key: "blue", swatchHex: "blue", translations: [] }))).toEqual([
      "invalid_swatch",
      "missing_required_translation",
    ]);

    ok(await catalog.attributes.updateValue(manager(), { valueId: red, swatchHex: null, translations: [fa("قرمز روشن")] }));
    expect(ok(await catalog.attributes.reorderValues(manager(), { attributeId: color, orderedIds: [black, red] }))).toEqual({ changed: 2 });
    expect(codes(await catalog.attributes.reorderValues(manager(), { attributeId: color, orderedIds: [black] }))).toEqual(["invalid_order"]);

    const colorView = (await catalog.attributes.list(manager())).find((a) => a.id === color);
    expect(colorView?.values.map((v) => [v.key, v.position, v.swatchHex, v.labels.map((l) => l.name).join("/")])).toEqual([
      ["black", 0, null, "مشکی"],
      ["red", 1, null, "قرمز روشن"],
    ]);
  });

  it("refuses to change a number attribute's unit once a product stores a value for it", async () => {
    const length = ok(await catalog.attributes.create(manager(), { key: "length", usage: "descriptive", valueType: "number", unit: "cm", translations: [fa("قد")] })).attributeId;
    ok(await catalog.attributes.update(manager(), { attributeId: length, unit: "mm" })); // unused: allowed
    // Product services arrive in Step 4; a fixture row stands in for a stored value.
    const women = await category("women");
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const product = (await client.query("INSERT INTO products (primary_category_id) VALUES ($1) RETURNING id", [women])).rows[0].id;
      await client.query("INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)", [product, women]);
      await client.query("INSERT INTO product_attribute_values (product_id, attribute_id, value_type, number_value) VALUES ($1, $2, 'number', 112)", [product, length]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const before = await events();
    const refused = await catalog.attributes.update(manager(), { attributeId: length, unit: "cm" });
    expect(!refused.ok && refused.issues).toEqual([{ code: "attribute_in_use", path: "unit" }]);
    expect(await events()).toBe(before);
    // the same unit, and name changes, are still fine
    ok(await catalog.attributes.update(manager(), { attributeId: length, unit: "MM", translations: [fa("بلندی")] }));
    const view = (await catalog.attributes.list(manager())).find((a) => a.id === length);
    expect([view?.unit, view?.names[0]?.name]).toEqual(["mm", "بلندی"]);
  });

  it("archives and restores attributes and values; values of an archived attribute stay archived", async () => {
    const color = ok(await catalog.attributes.create(manager(), { key: "color", usage: "variant_axis", valueType: "select", axisKind: "color", translations: [fa("رنگ")] })).attributeId;
    const red = ok(await catalog.attributes.createValue(manager(), { attributeId: color, key: "red", swatchHex: "#C0FFEE", translations: [fa("قرمز")] })).valueId;
    ok(await catalog.attributes.archiveValue(manager(), { valueId: red }));
    ok(await catalog.attributes.archive(manager(), { attributeId: color }));
    expect(codes(await catalog.attributes.restoreValue(manager(), { valueId: red }))).toEqual(["attribute_archived"]);
    expect(codes(await catalog.attributes.createValue(manager(), { attributeId: color, key: "blue", translations: [fa("آبی")] }))).toEqual(["attribute_archived"]);
    ok(await catalog.attributes.restore(manager(), { attributeId: color }));
    ok(await catalog.attributes.restoreValue(manager(), { valueId: red }));
    const [view] = await catalog.attributes.list(manager());
    expect([view?.status, view?.values[0]?.status, view?.values[0]?.swatchHex]).toEqual(["active", "active", "#C0FFEE"]);

    const { rows } = await db.pool.query("SELECT payload FROM outbox_events WHERE type = 'catalog.attribute.changed' ORDER BY occurred_at, id");
    expect(rows.map((r) => r.payload)).toEqual([
      { attributeId: color },
      { attributeId: color, valueId: red },
      { attributeId: color, valueId: red },
      { attributeId: color },
      { attributeId: color },
      { attributeId: color, valueId: red },
    ]);
    expect(await count("SELECT count(*) AS n FROM attribute_values")).toBe(1);
  });
});
