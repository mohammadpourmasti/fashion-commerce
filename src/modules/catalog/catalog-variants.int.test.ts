import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { AuthorizationError, createRequestContext, type Permission, type RequestContext } from "@/shared/kernel/authorization";

import { createCatalog, type Catalog } from "./application/catalog";
import { CATALOG_PERMISSIONS } from "./domain/permissions";

// Phase 2C Step 5A: product axes, offered values and variants against a throwaway PostgreSQL as
// the least-privilege application role. Concurrency tests order the competing calls with a
// lock-holding connection so the outcome is deterministic.

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
const reader = () => ctxWith([CATALOG_PERMISSIONS.productsRead]);
const nobody = () => ctxWith([]);

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query(sql, params);
  return Number(rows[0].n);
}
const events = (type: string) => count("SELECT count(*) AS n FROM outbox_events WHERE type = $1", [type]);

function ok<T>(result: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  return result.value;
}
const codes = (result: { ok: boolean; issues?: readonly { code: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.code));
const paths = (result: { ok: boolean; issues?: readonly { path?: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.path));
const fa = (name: string, extra: Record<string, string> = {}) => ({ locale: "fa", name, ...extra });

const EAN_A = "4006381333931";
const EAN_B = "5901234123457";

async function taxonomy() {
  const m = manager();
  const category = ok(await catalog.categories.create(m, { key: "women", translations: [fa("زنانه", { slug: "women" })] })).categoryId;
  const attr = async (key: string, usage: string, valueType: string, extra: Record<string, string> = {}) =>
    ok(await catalog.attributes.create(m, { key, usage, valueType, translations: [fa(key)], ...extra })).attributeId;
  const value = async (attributeId: string, key: string) => ok(await catalog.attributes.createValue(m, { attributeId, key, translations: [fa(key)] })).valueId;
  const size = await attr("size_women", "variant_axis", "select", { axisKind: "size" });
  const color = await attr("color", "variant_axis", "select", { axisKind: "color" });
  const color2 = await attr("color_alt", "variant_axis", "select", { axisKind: "color" });
  const other = await attr("pack", "variant_axis", "select", { axisKind: "other" });
  const other2 = await attr("fit", "variant_axis", "select", { axisKind: "other" });
  const fabric = await attr("fabric", "descriptive", "select");
  return {
    category, size, color, color2, other, other2, fabric,
    s: await value(size, "s"), m: await value(size, "m"), l: await value(size, "l"),
    red: await value(color, "red"), blue: await value(color, "blue"),
    wool: await value(fabric, "wool"),
    attr, value,
  };
}
type T = Awaited<ReturnType<typeof taxonomy>>;

let seq = 0;
async function newProduct(t: T) {
  seq += 1;
  return ok(await catalog.products.create(manager(), { translations: [fa(`محصول ${seq}`, { slug: `product-${seq}` })], primaryCategoryId: t.category }));
}

/** A product with size and colour axes, offering s, m / red, blue. Returns the latest version. */
async function productWithAxes(t: T) {
  const p = await newProduct(t);
  let v = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size, t.color] })).version;
  v = ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: v, attributeId: t.size, valueIds: [t.s, t.m] })).version;
  v = ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: v, attributeId: t.color, valueIds: [t.red, t.blue] })).version;
  return { productId: p.productId, version: v };
}

/** Starts `first`, then `second`, both blocked behind a lock the test holds on the product row. */
async function queued<A, B>(productId: string, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const holder: PoolClient = await db.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [productId]);
    const a = first();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const b = second();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query("COMMIT");
    return await Promise.all([a, b]);
  } finally {
    holder.release();
  }
}

describe("authorization", () => {
  it("refuses every write without catalog:products.manage and reads without catalog:products.read", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const calls = [
      () => catalog.variants.setAxes(nobody(), { productId: p.productId, expectedVersion: 1, attributeIds: [] }),
      () => catalog.variants.offerValues(nobody(), { productId: p.productId, expectedVersion: 1, attributeId: t.size, valueIds: [] }),
      () => catalog.variants.withdrawValues(nobody(), { productId: p.productId, expectedVersion: 1, attributeId: t.size, valueIds: [] }),
      () => catalog.variants.create(nobody(), { productId: p.productId, variants: [] }),
      () => catalog.variants.updateBarcode(nobody(), { variantId: p.productId, barcode: null }),
      () => catalog.variants.discontinue(nobody(), { variantId: p.productId }),
      () => catalog.variants.list(nobody(), { productId: p.productId }),
      () => catalog.variants.setAxes(reader(), { productId: p.productId, expectedVersion: 1, attributeIds: [] }),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(AuthorizationError);
    expect(ok(await catalog.variants.list(reader(), { productId: p.productId })).variants).toEqual([]);
  });
});

describe("axes", () => {
  it("sets ordered axes, bumps the version and emits product.updated", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const result = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: 1, attributeIds: [t.size, t.color] }));
    expect(result.version).toBe(2);
    const view = ok(await catalog.variants.list(reader(), { productId: p.productId }));
    expect(view.axes.map((a) => [a.position, a.attributeId])).toEqual([[1, t.size], [2, t.color]]);
    expect(await count("SELECT axis_count AS n FROM products WHERE id = $1", [p.productId])).toBe(2);
    expect(await events("catalog.product.updated")).toBe(1);
  });

  it("refuses bad axis lists with every issue, and stale versions, and archived products", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const set = (attributeIds: string[], expectedVersion = 1) => catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion, attributeIds });
    expect(codes(await set([t.size, t.color, t.other, t.other2]))).toEqual(["too_many_axes"]);
    expect(codes(await set([t.color, t.color2]))).toEqual(["multiple_color_axes"]);
    expect(codes(await set([t.size, t.size]))).toEqual(["duplicate_axis"]);
    expect(codes(await set([t.fabric]))).toEqual(["not_an_axis_attribute"]);
    expect(codes(await set([t.size], 7))).toEqual(["version_conflict"]);
    ok(await catalog.products.archive(manager(), { productId: p.productId, expectedVersion: 1 }));
    expect(codes(await set([t.size], 2))).toEqual(["product_archived"]);
    expect(codes(await catalog.variants.setAxes(manager(), { productId: "00000000-0000-7000-8000-000000000000", expectedVersion: 1, attributeIds: [] }))).toEqual(["not_found"]);
  });

  it("keeps the values of unchanged axes and drops those of removed ones", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size, t.other] }));
    const view = ok(await catalog.variants.list(reader(), { productId: p.productId }));
    expect(view.axes.map((a) => [a.attributeId, a.valueIds.length])).toEqual([[t.size, 2], [t.other, 0]]);
  });

  it("freezes the structure once variants exist, but allows an identical list and new values", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const created = ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }));
    expect(codes(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: created.version, attributeIds: [t.color, t.size] }))).toEqual(["axes_frozen"]);
    const same = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: created.version, attributeIds: [t.size, t.color] }));
    ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: same.version, attributeId: t.size, valueIds: [t.l] }));
  });

  it("refuses removing a colour axis that colour-linked images use", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    await linkImage(p.productId, t.red, t.color);
    expect(codes(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size] }))).toEqual(["axis_in_use"]);
    expect(await count("SELECT count(*) AS n FROM product_axes WHERE product_id = $1", [p.productId])).toBe(2);
  });
});

async function linkImage(productId: string, colorValueId: string, colorAttributeId: string) {
  const { rows } = await db.pool.query(
    "INSERT INTO media_assets (storage_key, content_type, byte_size, width, height, sha256) VALUES ($1, 'image/jpeg', 100, 10, 10, $2) RETURNING id",
    [`img/${colorValueId}`, colorValueId.replace(/-/g, "").padEnd(64, "a")],
  );
  await db.pool.query("INSERT INTO product_images (product_id, asset_id, view, color_value_id, color_attribute_id, position) VALUES ($1, $2, 'front', $3, $4, 0)", [productId, rows[0].id, colorValueId, colorAttributeId]);
}

describe("offered values", () => {
  it("offers values idempotently and in order", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const again = ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: p.version, attributeId: t.size, valueIds: [t.m, t.l] }));
    const view = ok(await catalog.variants.list(reader(), { productId: p.productId }));
    expect(view.axes[0]?.valueIds).toEqual([t.s, t.m, t.l]);
    expect(again.version).toBe(p.version + 1);
  });

  it("refuses unknown, foreign, archived and non-axis references", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const offer = (attributeId: string, valueIds: string[]) => catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: p.version, attributeId, valueIds });
    expect(codes(await offer(t.size, [t.red]))).toEqual(["value_not_in_attribute"]);
    expect(codes(await offer(t.size, ["00000000-0000-7000-8000-000000000000"]))).toEqual(["value_not_found"]);
    expect(codes(await offer(t.other, [t.l]))).toEqual(["not_an_axis_attribute"]);
    expect(codes(await offer(t.size, [t.l, t.l]))).toEqual(["duplicate_value"]);
    ok(await catalog.attributes.archiveValue(manager(), { valueId: t.l }));
    expect(codes(await offer(t.size, [t.l]))).toEqual(["value_archived"]);
  });

  it("withdraws unused values and refuses values that variants or images use", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const created = ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }));
    await linkImage(p.productId, t.blue, t.color);
    const withdraw = (attributeId: string, valueIds: string[], expectedVersion: number) => catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion, attributeId, valueIds });

    const refused = await withdraw(t.size, [t.s, t.m, t.l], created.version);
    expect(codes(refused)).toEqual(["value_in_use", "value_not_offered"]);
    expect(codes(await withdraw(t.color, [t.blue], created.version))).toEqual(["value_in_use"]);
    const done = ok(await withdraw(t.size, [t.m], created.version));
    expect(ok(await catalog.variants.list(reader(), { productId: p.productId })).axes[0]?.valueIds).toEqual([t.s]);
    expect(codes(await withdraw(t.size, [t.m], created.version))).toEqual(["version_conflict"]);
    expect(done.version).toBe(created.version + 1);
  });
});

describe("variants", () => {
  it("creates a matrix of variants with events, positions and one version bump", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const result = ok(
      await catalog.variants.create(manager(), {
        productId: p.productId,
        variants: [
          { sku: " drs-s-red ", barcode: EAN_A, values: [t.s, t.red] },
          { sku: "DRS-M-BLUE", values: [t.m, t.blue] },
        ],
      }),
    );
    expect(result.version).toBe(p.version + 1);
    expect(result.variants.map((v) => v.sku)).toEqual(["DRS-S-RED", "DRS-M-BLUE"]);
    const view = ok(await catalog.variants.list(reader(), { productId: p.productId }));
    expect(view.variants.map((v) => [v.sku, v.position, v.status, v.barcode])).toEqual([["DRS-S-RED", 0, "active", EAN_A], ["DRS-M-BLUE", 1, "active", null]]);
    expect(await events("catalog.variant.created")).toBe(2);
  });

  it("reports every failing row and writes nothing", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }));
    const bad = await catalog.variants.create(manager(), {
      productId: p.productId,
      variants: [
        { sku: "DRS-M-RED", values: [t.m, t.red] }, // fine
        { sku: "DRS-S-RED", values: [t.m, t.blue] }, // duplicate sku
        { sku: "DRS-L-RED", values: [t.l, t.red] }, // value not offered
        { sku: "DRS-X", values: [t.s] }, // wrong count
        { sku: "ab", values: [t.s, t.blue], barcode: "123" }, // invalid sku and barcode
        { sku: "DRS-S-RED-2", values: [t.s, t.red] }, // duplicate combination
      ],
    });
    expect(codes(bad)).toEqual(["duplicate_sku", "value_not_offered", "wrong_value_count", "invalid_sku", "invalid_barcode", "duplicate_combination"]);
    expect(await count("SELECT count(*) AS n FROM variants")).toBe(1);
    expect(await events("catalog.variant.created")).toBe(1);
  });

  it("reports SKU and barcode clashes with other products per row", async () => {
    const t = await taxonomy();
    const a = await productWithAxes(t);
    const b = await productWithAxes(t);
    ok(await catalog.variants.create(manager(), { productId: a.productId, variants: [{ sku: "DRS-S-RED", barcode: EAN_A, values: [t.s, t.red] }] }));
    const clash = await catalog.variants.create(manager(), {
      productId: b.productId,
      variants: [{ sku: "DRS-M-RED", values: [t.m, t.red] }, { sku: "DRS-S-RED", barcode: EAN_A, values: [t.s, t.red] }],
    });
    expect(codes(clash)).toEqual(["duplicate_sku", "duplicate_barcode"]);
    expect(paths(clash)).toEqual(["variants[1].sku", "variants[1].barcode"]);
    expect(await count("SELECT count(*) AS n FROM variants WHERE product_id = $1", [b.productId])).toBe(0);
  });

  it("gives a product without axes exactly one variant", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "SCARF-ONE", values: [] }] }));
    expect(codes(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "SCARF-TWO", values: [] }] }))).toEqual(["duplicate_combination"]);
  });

  it("caps a product at 100 variants, discontinued ones included", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    let v = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.other, t.other2] })).version;
    const packs: string[] = [];
    const fits: string[] = [];
    for (let i = 0; i < 11; i++) packs.push(await t.value(t.other, `pack-${i}`));
    for (let i = 0; i < 10; i++) fits.push(await t.value(t.other2, `fit-${i}`));
    v = ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: v, attributeId: t.other, valueIds: packs })).version;
    ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: v, attributeId: t.other2, valueIds: fits }));
    const combos = packs.flatMap((pk) => fits.map((f) => [pk, f]));
    const inputs = combos.map(([a, b], i) => ({ sku: `BULK-${i}`, values: [a!, b!] }));
    ok(await catalog.variants.create(manager(), { productId: p.productId, variants: inputs.slice(0, 100) }));
    const first = ok(await catalog.variants.list(reader(), { productId: p.productId })).variants[0]!;
    ok(await catalog.variants.discontinue(manager(), { variantId: first.id }));
    const over = await catalog.variants.create(manager(), { productId: p.productId, variants: inputs.slice(100, 101) });
    expect(codes(over)).toEqual(["too_many_variants"]);
  }, 120_000);

  it("refuses variants on an archived product and unknown products", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    ok(await catalog.products.archive(manager(), { productId: p.productId, expectedVersion: p.version }));
    expect(codes(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }))).toEqual(["product_archived"]);
    expect(codes(await catalog.variants.create(manager(), { productId: "00000000-0000-7000-8000-000000000000", variants: [] }))).toEqual(["not_found"]);
  });
});

describe("barcode and discontinuation", () => {
  it("edits the barcode, never the SKU, and refuses invalid or taken barcodes", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const created = ok(
      await catalog.variants.create(manager(), {
        productId: p.productId,
        variants: [{ sku: "DRS-S-RED", barcode: EAN_A, values: [t.s, t.red] }, { sku: "DRS-M-RED", values: [t.m, t.red] }],
      }),
    );
    const [one, two] = created.variants;
    expect(codes(await catalog.variants.updateBarcode(manager(), { variantId: two!.variantId, barcode: EAN_A }))).toEqual(["duplicate_barcode"]);
    expect(codes(await catalog.variants.updateBarcode(manager(), { variantId: two!.variantId, barcode: "12345" }))).toEqual(["invalid_barcode"]);
    const set = ok(await catalog.variants.updateBarcode(manager(), { variantId: two!.variantId, barcode: EAN_B }));
    expect(set.version).toBe(created.version + 1);
    ok(await catalog.variants.updateBarcode(manager(), { variantId: one!.variantId, barcode: null }));
    const view = ok(await catalog.variants.list(reader(), { productId: p.productId }));
    expect(view.variants.map((v) => [v.sku, v.barcode])).toEqual([["DRS-S-RED", null], ["DRS-M-RED", EAN_B]]);
    expect(codes(await catalog.variants.updateBarcode(manager(), { variantId: "00000000-0000-7000-8000-000000000000", barcode: null }))).toEqual(["not_found"]);
  });

  it("discontinues one way, keeps the row and its values, and emits an event", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const created = ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }));
    const id = created.variants[0]!.variantId;
    const done = ok(await catalog.variants.discontinue(manager(), { variantId: id }));
    expect(done.version).toBe(created.version + 1);
    const again = await catalog.variants.discontinue(manager(), { variantId: id });
    expect(codes(again)).toEqual(["invalid_transition"]);
    const view = ok(await catalog.variants.list(reader(), { productId: p.productId }));
    expect(view.variants[0]).toMatchObject({ status: "discontinued", discontinuedAt: clock });
    expect(view.version).toBe(done.version);
    expect(await events("catalog.variant.discontinued")).toBe(1);
    // the discontinued variant still uses its values
    expect(codes(await catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion: done.version, attributeId: t.size, valueIds: [t.s] }))).toEqual(["value_in_use"]);
  });
});

describe("no-op writes and real changes", () => {
  const state = async (productId: string) => {
    const { rows } = await db.pool.query("SELECT version, updated_at FROM products WHERE id = $1", [productId]);
    return { version: Number(rows[0].version), updatedAt: new Date(rows[0].updated_at).getTime(), events: await count("SELECT count(*) AS n FROM outbox_events") };
  };

  it("setAxes with the stored list changes nothing; a real change bumps once and emits once", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const before = await state(p.productId);
    clock = new Date("2030-02-01T00:00:00Z");

    const same = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size, t.color] }));
    expect(same.version).toBe(p.version);
    expect(await state(p.productId)).toEqual(before);

    // a stale version and an archived product are still refused for a no-op
    expect(codes(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version - 1, attributeIds: [t.size, t.color] }))).toEqual(["version_conflict"]);

    const real = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size] }));
    expect(real.version).toBe(p.version + 1);
    const after = await state(p.productId);
    expect(after.version).toBe(before.version + 1);
    expect(after.events).toBe(before.events + 1);
    expect(after.updatedAt).toBe(clock.getTime());
  });

  it("offerValues with only already-offered values (or none) changes nothing; new values bump once", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const before = await state(p.productId);
    const offer = (valueIds: string[], expectedVersion = p.version) => catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion, attributeId: t.size, valueIds });

    expect(ok(await offer([t.s, t.m])).version).toBe(p.version);
    expect(ok(await offer([])).version).toBe(p.version);
    expect(await state(p.productId)).toEqual(before);
    expect(codes(await offer([t.s], p.version + 5))).toEqual(["version_conflict"]);

    expect(ok(await offer([t.s, t.l])).version).toBe(p.version + 1);
    const after = await state(p.productId);
    expect(after.version).toBe(before.version + 1);
    expect(after.events).toBe(before.events + 1);
  });

  it("withdrawValues with an empty list changes nothing; a real withdrawal bumps once", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const before = await state(p.productId);
    const withdraw = (valueIds: string[]) => catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion: p.version, attributeId: t.size, valueIds });

    expect(ok(await withdraw([])).version).toBe(p.version);
    expect(await state(p.productId)).toEqual(before);

    expect(ok(await withdraw([t.m])).version).toBe(p.version + 1);
    const after = await state(p.productId);
    expect(after.version).toBe(before.version + 1);
    expect(after.events).toBe(before.events + 1);
  });

  it("updateBarcode with the stored barcode (or none for none) changes nothing; a real change bumps once", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const created = ok(
      await catalog.variants.create(manager(), {
        productId: p.productId,
        variants: [{ sku: "DRS-S-RED", barcode: EAN_A, values: [t.s, t.red] }, { sku: "DRS-M-RED", values: [t.m, t.red] }],
      }),
    );
    const [withCode, without] = created.variants;
    const before = await state(p.productId);
    clock = new Date("2030-02-01T00:00:00Z");

    expect(ok(await catalog.variants.updateBarcode(manager(), { variantId: withCode!.variantId, barcode: ` ${EAN_A.slice(0, 4)}-${EAN_A.slice(4)} ` })).version).toBe(created.version);
    expect(ok(await catalog.variants.updateBarcode(manager(), { variantId: without!.variantId, barcode: null })).version).toBe(created.version);
    expect(ok(await catalog.variants.updateBarcode(manager(), { variantId: without!.variantId, barcode: "" })).version).toBe(created.version);
    expect(await state(p.productId)).toEqual(before);

    expect(ok(await catalog.variants.updateBarcode(manager(), { variantId: without!.variantId, barcode: EAN_B })).version).toBe(created.version + 1);
    const after = await state(p.productId);
    expect(after.version).toBe(before.version + 1);
    expect(after.events).toBe(before.events + 1);
    expect(await events("catalog.product.updated")).toBe(4); // three setup writes + this one
  });

  it("variant creation emits catalog.variant.created only, and one version bump for the whole batch", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const updatedBefore = await events("catalog.product.updated");
    const result = ok(
      await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }, { sku: "DRS-M-RED", values: [t.m, t.red] }, { sku: "DRS-S-BLUE", values: [t.s, t.blue] }] }),
    );
    expect(result.version).toBe(p.version + 1);
    expect(await events("catalog.variant.created")).toBe(3);
    expect(await events("catalog.product.updated")).toBe(updatedBefore);
    // an empty batch is a no-op too
    expect(ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [] })).version).toBe(result.version);
    expect(await events("catalog.variant.created")).toBe(3);
  });
});

describe("concurrency", () => {
  it("variant creation queued before a structure change wins; the change is refused", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const [create, change] = await queued(
      p.productId,
      () => catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }),
      () => catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.color] }),
    );
    expect(create.ok).toBe(true);
    expect(codes(change)).toEqual(["version_conflict"]);
    expect(await count("SELECT count(*) AS n FROM variants WHERE product_id = $1", [p.productId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM product_axes WHERE product_id = $1", [p.productId])).toBe(2);
    expect(await count("SELECT version AS n FROM products WHERE id = $1", [p.productId])).toBe(p.version + 1);
    expect(await events("catalog.variant.created")).toBe(1);
    expect(await events("catalog.product.updated")).toBe(3); // the three setup writes only
  });

  it("a structure change queued before variant creation wins; the variant is refused", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const [change, create] = await queued(
      p.productId,
      () => catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size] }),
      () => catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }),
    );
    expect(change.ok).toBe(true);
    expect(codes(create)).toEqual(["wrong_value_count"]);
    expect(await count("SELECT count(*) AS n FROM variants")).toBe(0);
    expect(await count("SELECT axis_count AS n FROM products WHERE id = $1", [p.productId])).toBe(1);
    expect(await events("catalog.variant.created")).toBe(0);
  });

  it("serializes two creates of the same combination on one product", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const [a, b] = await queued(
      p.productId,
      () => catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }),
      () => catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED-B", values: [t.s, t.red] }] }),
    );
    expect(a.ok).toBe(true);
    expect(codes(b)).toEqual(["duplicate_combination"]);
    expect(await count("SELECT count(*) AS n FROM variants")).toBe(1);
    expect(await events("catalog.variant.created")).toBe(1);
  });

  it("lets exactly one of two products win the same SKU, leaving the loser untouched", async () => {
    const t = await taxonomy();
    const a = await productWithAxes(t);
    const b = await productWithAxes(t);
    const make = (productId: string) => catalog.variants.create(manager(), { productId, variants: [{ sku: "SHARED-SKU", values: [t.s, t.red] }] });
    const results = await Promise.all([make(a.productId), make(b.productId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.findIndex((r) => !r.ok) === 0 ? a : b;
    expect(codes(results.find((r) => !r.ok)!)).toEqual(["duplicate_sku"]);
    expect(await count("SELECT count(*) AS n FROM variants")).toBe(1);
    expect(await count("SELECT version AS n FROM products WHERE id = $1", [loser.productId])).toBe(loser.version);
    expect(await events("catalog.variant.created")).toBe(1);
  });

  it("two discontinues of one variant: one wins, one is an invalid transition, one event", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const created = ok(await catalog.variants.create(manager(), { productId: p.productId, variants: [{ sku: "DRS-S-RED", values: [t.s, t.red] }] }));
    const id = created.variants[0]!.variantId;
    const results = await Promise.all([catalog.variants.discontinue(manager(), { variantId: id }), catalog.variants.discontinue(manager(), { variantId: id })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(codes(results.find((r) => !r.ok)!)).toEqual(["invalid_transition"]);
    expect(await events("catalog.variant.discontinued")).toBe(1);
    expect(await count("SELECT version AS n FROM products WHERE id = $1", [p.productId])).toBe(created.version + 1);
  });

  it("a value archive committed while offerValues waits is honoured", async () => {
    const t = await taxonomy();
    const p = await productWithAxes(t);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE attribute_values SET status = 'archived' WHERE id = $1", [t.l]);
      let done = false;
      const offering = catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: p.version, attributeId: t.size, valueIds: [t.l] }).then((r) => ((done = true), r));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      await holder.query("COMMIT");
      expect(codes(await offering)).toEqual(["value_archived"]);
    } finally {
      holder.release();
    }
    expect(await count("SELECT count(*) AS n FROM product_axis_values WHERE value_id = $1", [t.l])).toBe(0);
    expect(await count("SELECT version AS n FROM products WHERE id = $1", [p.productId])).toBe(p.version);
  });

  it("an attribute archive committed while setAxes waits is honoured", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE attributes SET status = 'archived' WHERE id = $1", [t.size]);
      const setting = catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.size] });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await holder.query("COMMIT");
      expect(codes(await setting)).toEqual(["attribute_archived"]);
    } finally {
      holder.release();
    }
    expect(await count("SELECT count(*) AS n FROM product_axes")).toBe(0);
  });

});
