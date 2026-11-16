import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { AuthorizationError, createRequestContext, type Permission, type RequestContext } from "@/shared/kernel/authorization";

import { createCatalog, type Catalog } from "./application/catalog";
import { CATALOG_PERMISSIONS } from "./domain/permissions";

// Phase 2C Step 5B: media assets and product images against a throwaway PostgreSQL as the
// least-privilege application role. Concurrency tests order the competing calls with a lock held
// on the product row, so the outcome is deterministic.

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
const events = (type?: string) => count(type ? "SELECT count(*) AS n FROM outbox_events WHERE type = $1" : "SELECT count(*) AS n FROM outbox_events", type ? [type] : []);

function ok<T>(result: { ok: true; value: T } | { ok: false; issues: readonly unknown[] }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  return result.value;
}
const codes = (result: { ok: boolean; issues?: readonly { code: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.code));
const paths = (result: { ok: boolean; issues?: readonly { path?: string }[] }) => (result.ok ? [] : (result.issues ?? []).map((i) => i.path));
const fa = (name: string, extra: Record<string, string> = {}) => ({ locale: "fa", name, ...extra });

async function taxonomy() {
  const m = manager();
  const category = ok(await catalog.categories.create(m, { key: "women", translations: [fa("زنانه", { slug: "women" })] })).categoryId;
  const attr = async (key: string, axisKind: string) => ok(await catalog.attributes.create(m, { key, usage: "variant_axis", valueType: "select", axisKind, translations: [fa(key)] })).attributeId;
  const value = async (attributeId: string, key: string) => ok(await catalog.attributes.createValue(m, { attributeId, key, translations: [fa(key)] })).valueId;
  const color = await attr("color", "color");
  const size = await attr("size_women", "size");
  return { category, color, size, red: await value(color, "red"), blue: await value(color, "blue"), black: await value(color, "black"), s: await value(size, "s") };
}
type T = Awaited<ReturnType<typeof taxonomy>>;

let seq = 0;
async function newProduct(t: T) {
  seq += 1;
  return ok(await catalog.products.create(manager(), { translations: [fa(`محصول ${seq}`, { slug: `product-${seq}` })], primaryCategoryId: t.category }));
}
/** A product with a colour axis offering red and blue (black is not offered). */
async function colorProduct(t: T) {
  const p = await newProduct(t);
  let v = ok(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version, attributeIds: [t.color] })).version;
  v = ok(await catalog.variants.offerValues(manager(), { productId: p.productId, expectedVersion: v, attributeId: t.color, valueIds: [t.red, t.blue] })).version;
  return { productId: p.productId, version: v };
}

let assetSeq = 0;
async function asset(extra: Partial<{ storageKey: string; sha256: string }> = {}) {
  assetSeq += 1;
  return ok(
    await catalog.media.registerAsset(manager(), {
      storageKey: `products/photo-${assetSeq}.jpg`,
      contentType: "image/jpeg",
      byteSize: 120_000,
      width: 1200,
      height: 1600,
      sha256: assetSeq.toString(16).padStart(64, "0"),
      ...extra,
    }),
  ).assetId;
}

const productState = async (productId: string) => {
  const { rows } = await db.pool.query("SELECT version, updated_at FROM products WHERE id = $1", [productId]);
  return { version: Number(rows[0].version), updatedAt: new Date(rows[0].updated_at).getTime(), events: await events() };
};
const makeActive = (productId: string) => db.pool.query("UPDATE products SET status = 'active', published_at = now() WHERE id = $1", [productId]); // test-only: publishing is a later step

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
  it("refuses writes without catalog:media.manage and reads without catalog:products.read", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const assetId = await asset();
    const calls = [
      () => catalog.media.registerAsset(nobody(), { storageKey: "x/y.jpg", contentType: "image/jpeg", byteSize: 1, width: 1, height: 1, sha256: "a".repeat(64) }),
      () => catalog.media.registerAsset(reader(), { storageKey: "x/y.jpg", contentType: "image/jpeg", byteSize: 1, width: 1, height: 1, sha256: "a".repeat(64) }),
      () => catalog.media.setProductImages(nobody(), { productId: p.productId, expectedVersion: 1, images: [] }),
      () => catalog.media.setProductImages(reader(), { productId: p.productId, expectedVersion: 1, images: [] }),
      () => catalog.media.getAsset(nobody(), { assetId }),
      () => catalog.media.listImages(nobody(), { productId: p.productId }),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(AuthorizationError);
    expect(ok(await catalog.media.listImages(reader(), { productId: p.productId })).images).toEqual([]);
    expect(ok(await catalog.media.getAsset(reader(), { assetId })).id).toBe(assetId);
  });
});

describe("asset registration", () => {
  it("registers metadata only, emits nothing, and reads it back", async () => {
    const before = await events();
    const id = await asset({ storageKey: "products/dress.avif" });
    const view = ok(await catalog.media.getAsset(reader(), { assetId: id }));
    expect(view).toMatchObject({ storageKey: "products/dress.avif", contentType: "image/jpeg", byteSize: 120_000, width: 1200, height: 1600, createdAt: clock });
    expect(await events()).toBe(before);
    expect(codes(await catalog.media.getAsset(reader(), { assetId: "00000000-0000-7000-8000-000000000000" }))).toEqual(["not_found"]);
  });

  it("reports every invalid field", async () => {
    const bad = await catalog.media.registerAsset(manager(), { storageKey: "../x", contentType: "image/gif", byteSize: 0, width: 0, height: 20_001, sha256: "xyz" });
    expect(codes(bad)).toEqual(Array(6).fill("invalid_asset"));
    expect(paths(bad)).toEqual(["storageKey", "contentType", "byteSize", "width", "height", "sha256"]);
    expect(await count("SELECT count(*) AS n FROM media_assets")).toBe(0);
  });

  it("returns explicit conflicts for a taken storage key or hash and names the existing asset", async () => {
    const first = await asset({ storageKey: "products/a.jpg", sha256: "a".repeat(64) });
    const sameKey = await catalog.media.registerAsset(manager(), { storageKey: "products/a.jpg", contentType: "image/png", byteSize: 5, width: 5, height: 5, sha256: "b".repeat(64) });
    expect(codes(sameKey)).toEqual(["storage_key_taken"]);
    const sameHash = await catalog.media.registerAsset(manager(), { storageKey: "products/b.jpg", contentType: "image/png", byteSize: 5, width: 5, height: 5, sha256: "A".repeat(64) });
    expect(codes(sameHash)).toEqual(["asset_hash_taken"]);
    expect(sameHash.ok ? null : sameHash.issues[0]?.detail).toEqual({ assetId: first });
    const both = await catalog.media.registerAsset(manager(), { storageKey: "products/a.jpg", contentType: "image/png", byteSize: 5, width: 5, height: 5, sha256: "a".repeat(64) });
    expect(codes(both)).toEqual(["storage_key_taken", "asset_hash_taken"]);
    expect(await count("SELECT count(*) AS n FROM media_assets")).toBe(1);
  });

  it("lets exactly one of several concurrent registrations of the same hash or key win", async () => {
    const make = (i: number, key: string, sha: string) => catalog.media.registerAsset(manager(), { storageKey: key, contentType: "image/webp", byteSize: 10 + i, width: 10, height: 10, sha256: sha });
    const sameHash = await Promise.all([1, 2, 3, 4].map((i) => make(i, `race/hash-${i}.webp`, "c".repeat(64))));
    expect(sameHash.filter((r) => r.ok)).toHaveLength(1);
    expect(sameHash.filter((r) => !r.ok).every((r) => codes(r).join() === "asset_hash_taken")).toBe(true);
    const sameKey = await Promise.all([1, 2, 3, 4].map((i) => make(i, "race/key.webp", i.toString().repeat(64))));
    expect(sameKey.filter((r) => r.ok)).toHaveLength(1);
    expect(sameKey.filter((r) => !r.ok).every((r) => codes(r).join() === "storage_key_taken")).toBe(true);
    expect(await count("SELECT count(*) AS n FROM media_assets")).toBe(2);
  });

  it("is immutable and undeletable for the application role", async () => {
    const id = await asset();
    await expect(appPool.query("DELETE FROM media_assets WHERE id = $1", [id])).rejects.toMatchObject({ code: "42501" });
    expect(await count("SELECT count(*) AS n FROM media_assets WHERE id = $1", [id])).toBe(1);
  });
});

describe("setProductImages", () => {
  it("sets an ordered gallery with views, colour links and alt text; the first image is primary", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const [a1, a2, a3] = [await asset(), await asset(), await asset()];
    const before = await events("catalog.product.updated");
    const result = ok(
      await catalog.media.setProductImages(manager(), {
        productId: p.productId,
        expectedVersion: p.version,
        images: [
          { assetId: a1, view: "front", colorValueId: t.red, alt: [{ locale: "fa", text: "پیراهن قرمز" }, { locale: "en", text: "Red dress" }] },
          { assetId: a2, view: "back", colorValueId: t.red },
          { assetId: a3, view: "gallery" },
        ],
      }),
    );
    expect(result.version).toBe(p.version + 1);
    expect(result.images.map((i) => [i.assetId, i.position])).toEqual([[a1, 0], [a2, 1], [a3, 2]]);
    const view = ok(await catalog.media.listImages(reader(), { productId: p.productId }));
    expect(view.version).toBe(result.version);
    expect(view.images.map((i) => [i.assetId, i.view, i.position, i.colorValueId])).toEqual([[a1, "front", 0, t.red], [a2, "back", 1, t.red], [a3, "gallery", 2, null]]);
    expect(view.images[0]?.alt).toEqual([{ locale: "en", text: "Red dress" }, { locale: "fa", text: "پیراهن قرمز" }]);
    expect(view.images[1]?.alt).toEqual([]);
    expect(await events("catalog.product.updated")).toBe(before + 1);
  });

  it("allows several detail and gallery images, with no fixed limit", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const images: { assetId: string; view: string }[] = [];
    for (let i = 0; i < 25; i++) images.push({ assetId: await asset(), view: i % 2 ? "detail" : "gallery" });
    ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images }));
    expect(await count("SELECT count(*) AS n FROM product_images WHERE product_id = $1", [p.productId])).toBe(25);
  }, 60_000);

  it("reports every problem together and writes nothing", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const [a1, a2] = [await asset(), await asset()];
    const before = await productState(p.productId);
    const bad = await catalog.media.setProductImages(manager(), {
      productId: p.productId,
      expectedVersion: p.version,
      images: [
        { assetId: a1, view: "front", colorValueId: t.red },
        { assetId: a2, view: "front", colorValueId: t.red }, // second front in the red group
        { assetId: a1, view: "gallery" }, // repeated asset
        { assetId: "00000000-0000-7000-8000-000000000000", view: "side" }, // unknown asset, bad view
        { assetId: a2, view: "detail", colorValueId: t.black }, // colour not offered, repeated asset
        { assetId: a2, view: "detail", alt: [{ locale: "fa", text: "x".repeat(251) }, { locale: "fa", text: "y" }, { locale: "zz", text: "z" }] },
      ],
    });
    const found = new Set(codes(bad));
    for (const code of ["duplicate_view", "duplicate_asset", "asset_not_found", "invalid_view", "color_not_offered", "text_too_long", "duplicate_locale", "invalid_locale"]) expect(found.has(code)).toBe(true);
    expect(await productState(p.productId)).toEqual(before);
    expect(await count("SELECT count(*) AS n FROM product_images")).toBe(0);
  });

  it("refuses colour links on a product without a colour axis and non-colour values", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const a = await asset();
    expect(codes(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a, view: "front", colorValueId: t.red }] }))).toEqual(["not_a_color_axis"]);
    const sized = await newProduct(t);
    let v = ok(await catalog.variants.setAxes(manager(), { productId: sized.productId, expectedVersion: sized.version, attributeIds: [t.size] })).version;
    v = ok(await catalog.variants.offerValues(manager(), { productId: sized.productId, expectedVersion: v, attributeId: t.size, valueIds: [t.s] })).version;
    expect(codes(await catalog.media.setProductImages(manager(), { productId: sized.productId, expectedVersion: v, images: [{ assetId: a, view: "front", colorValueId: t.s }] }))).toEqual(["not_a_color_axis"]);
  });

  it("refuses stale versions, archived and unknown products", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const set = (productId: string, expectedVersion: number) => catalog.media.setProductImages(manager(), { productId, expectedVersion, images: [] });
    expect(codes(await set(p.productId, 9))).toEqual(["version_conflict"]);
    ok(await catalog.products.archive(manager(), { productId: p.productId, expectedVersion: 1 }));
    expect(codes(await set(p.productId, 2))).toEqual(["product_archived"]);
    expect(codes(await set("00000000-0000-7000-8000-000000000000", 1))).toEqual(["not_found"]);
  });

  it("matches existing images by asset, keeps their IDs, and removes what left the set with its alt text", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const [a1, a2, a3, a4] = [await asset(), await asset(), await asset(), await asset()];
    const first = ok(
      await catalog.media.setProductImages(manager(), {
        productId: p.productId,
        expectedVersion: p.version,
        images: [{ assetId: a1, view: "front", alt: [{ locale: "fa", text: "الف" }] }, { assetId: a2, view: "back", alt: [{ locale: "fa", text: "ب" }] }, { assetId: a3, view: "detail" }],
      }),
    );
    const id = (assetId: string) => first.images.find((i) => i.assetId === assetId)!.imageId;

    const second = ok(
      await catalog.media.setProductImages(manager(), {
        productId: p.productId,
        expectedVersion: first.version,
        images: [{ assetId: a3, view: "gallery" }, { assetId: a4, view: "front", colorValueId: t.blue }, { assetId: a1, view: "front", alt: [{ locale: "fa", text: "الف" }] }],
      }),
    );
    expect(second.version).toBe(first.version + 1);
    expect(second.images.map((i) => [i.assetId, i.position])).toEqual([[a3, 0], [a4, 1], [a1, 2]]);
    expect(second.images.find((i) => i.assetId === a3)?.imageId).toBe(id(a3));
    expect(second.images.find((i) => i.assetId === a1)?.imageId).toBe(id(a1));
    expect(second.images.find((i) => i.assetId === a4)?.imageId).not.toBe(id(a2));

    expect(await count("SELECT count(*) AS n FROM product_images WHERE id = $1", [id(a2)])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM product_image_translations WHERE image_id = $1", [id(a2)])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM media_assets WHERE id = $1", [a2])).toBe(1); // the asset itself stays
    const view = ok(await catalog.media.listImages(reader(), { productId: p.productId }));
    expect(view.images.map((i) => [i.assetId, i.view, i.colorValueId])).toEqual([[a3, "gallery", null], [a4, "front", t.blue], [a1, "front", null]]);
    expect(view.images[2]?.alt).toEqual([{ locale: "fa", text: "الف" }]);
  });
});

describe("no-op writes and real changes", () => {
  it("an identical set changes nothing; each kind of real change bumps once and emits once", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const [a1, a2] = [await asset(), await asset()];
    const base = [{ assetId: a1, view: "front", colorValueId: t.red, alt: [{ locale: "fa", text: "قرمز" }] }, { assetId: a2, view: "back", colorValueId: t.red }];
    const first = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: base }));
    const settled = await productState(p.productId);
    clock = new Date("2030-02-01T00:00:00Z");

    const same = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: first.version, images: base }));
    expect(same.version).toBe(first.version);
    expect(same.images.map((i) => i.imageId)).toEqual(first.images.map((i) => i.imageId));
    expect(await productState(p.productId)).toEqual(settled);
    expect(codes(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: first.version - 1, images: base }))).toEqual(["version_conflict"]);

    const changes: { name: string; images: typeof base }[] = [
      { name: "alt text", images: [{ ...base[0]!, alt: [{ locale: "fa", text: "قرمز تیره" }] }, base[1]!] },
      { name: "view", images: [base[0]!, { ...base[1]!, view: "detail" }] },
      { name: "colour link", images: [{ ...base[0]!, colorValueId: t.blue }, base[1]!] },
      { name: "order", images: [base[1]!, base[0]!] },
    ];
    let version = first.version;
    for (const change of changes) {
      const before = await productState(p.productId);
      const result = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: version, images: change.images }));
      expect(result.version, change.name).toBe(version + 1);
      const after = await productState(p.productId);
      expect(after.version, change.name).toBe(before.version + 1);
      expect(after.events, change.name).toBe(before.events + 1);
      expect(after.updatedAt, change.name).toBe(clock.getTime());
      version = result.version;
      // restore the base set so the next change is measured against the same state
      version = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: version, images: base })).version;
    }
  });
});

describe("active and draft products", () => {
  it("lets a draft clear its images but keeps at least one on an active product", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const a = await asset();
    const set = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a, view: "front" }] }));
    const cleared = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: set.version, images: [] }));
    expect(cleared.version).toBe(set.version + 1);
    expect(await count("SELECT count(*) AS n FROM product_images")).toBe(0);
    // an empty set on a draft without images is a no-op
    expect(ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: cleared.version, images: [] })).version).toBe(cleared.version);

    const again = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: cleared.version, images: [{ assetId: a, view: "front" }] }));
    await makeActive(p.productId);
    const refused = await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: again.version, images: [] });
    expect(codes(refused)).toEqual(["no_image"]);
    expect(await count("SELECT count(*) AS n FROM product_images")).toBe(1);
    // replacing the image set of an active product is fine as long as one remains
    const b = await asset();
    ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: again.version, images: [{ assetId: b, view: "front" }] }));
  });
});

describe("reference protection", () => {
  it("blocks withdrawing a colour or removing the axis while an image links it, and releases them after", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const a = await asset();
    const set = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a, view: "front", colorValueId: t.red }] }));
    expect(codes(await catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion: set.version, attributeId: t.color, valueIds: [t.red] }))).toEqual(["value_in_use"]);
    expect(codes(await catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: set.version, attributeIds: [t.size] }))).toEqual(["axis_in_use"]);

    const unlinked = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: set.version, images: [{ assetId: a, view: "front" }] }));
    ok(await catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion: unlinked.version, attributeId: t.color, valueIds: [t.red] }));
  });
});

describe("concurrency and rollback", () => {
  it("an image set queued before a withdrawal wins; the withdrawal is refused as in use", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const a = await asset();
    const [set, withdraw] = await queued(
      p.productId,
      () => catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a, view: "front", colorValueId: t.red }] }),
      () => catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion: p.version + 1, attributeId: t.color, valueIds: [t.red] }),
    );
    expect(set.ok).toBe(true);
    expect(codes(withdraw)).toEqual(["value_in_use"]);
    expect(await count("SELECT count(*) AS n FROM product_axis_values WHERE value_id = $1", [t.red])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM product_images WHERE color_value_id = $1", [t.red])).toBe(1);
    expect(await productState(p.productId).then((s) => s.version)).toBe(p.version + 1);
  });

  it("a withdrawal queued before an image set wins; the colour link is refused", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const a = await asset();
    const [withdraw, set] = await queued(
      p.productId,
      () => catalog.variants.withdrawValues(manager(), { productId: p.productId, expectedVersion: p.version, attributeId: t.color, valueIds: [t.red] }),
      () => catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version + 1, images: [{ assetId: a, view: "front", colorValueId: t.red }] }),
    );
    expect(withdraw.ok).toBe(true);
    expect(codes(set)).toEqual(["color_not_offered"]);
    expect(await count("SELECT count(*) AS n FROM product_images")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM product_axis_values WHERE value_id = $1", [t.red])).toBe(0);
  });

  it("an image set queued before an axis change wins; removing the colour axis is refused", async () => {
    const t = await taxonomy();
    const p = await colorProduct(t);
    const a = await asset();
    const [set, axes] = await queued(
      p.productId,
      () => catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a, view: "front", colorValueId: t.blue }] }),
      () => catalog.variants.setAxes(manager(), { productId: p.productId, expectedVersion: p.version + 1, attributeIds: [t.size] }),
    );
    expect(set.ok).toBe(true);
    expect(codes(axes)).toEqual(["axis_in_use"]);
    expect(await count("SELECT count(*) AS n FROM product_axes WHERE product_id = $1 AND attribute_id = $2", [p.productId, t.color])).toBe(1);
  });

  it("two image sets from the same version: the first wins, the second is a version conflict", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const [a, b] = [await asset(), await asset()];
    const [one, two] = await queued(
      p.productId,
      () => catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a, view: "front" }] }),
      () => catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: b, view: "front" }] }),
    );
    expect(one.ok).toBe(true);
    expect(codes(two)).toEqual(["version_conflict"]);
    const view = ok(await catalog.media.listImages(reader(), { productId: p.productId }));
    expect(view.images.map((i) => i.assetId)).toEqual([a]);
    expect(view.version).toBe(p.version + 1);
    expect(await events("catalog.product.updated")).toBe(1);
  });

  it("archive queued before an image set wins; the set is refused. The reverse order keeps the images", async () => {
    const t = await taxonomy();
    const a = await asset();
    const first = await newProduct(t);
    const [archive, set] = await queued(
      first.productId,
      () => catalog.products.archive(manager(), { productId: first.productId, expectedVersion: first.version }),
      () => catalog.media.setProductImages(manager(), { productId: first.productId, expectedVersion: first.version + 1, images: [{ assetId: a, view: "front" }] }),
    );
    expect(archive.ok).toBe(true);
    expect(codes(set)).toEqual(["product_archived"]);
    expect(await count("SELECT count(*) AS n FROM product_images WHERE product_id = $1", [first.productId])).toBe(0);

    const second = await newProduct(t);
    const [set2, archive2] = await queued(
      second.productId,
      () => catalog.media.setProductImages(manager(), { productId: second.productId, expectedVersion: second.version, images: [{ assetId: a, view: "front" }] }),
      () => catalog.products.archive(manager(), { productId: second.productId, expectedVersion: second.version + 1 }),
    );
    expect(set2.ok).toBe(true);
    expect(archive2.ok).toBe(true);
    expect(await count("SELECT count(*) AS n FROM product_images WHERE product_id = $1", [second.productId])).toBe(1);
  });

  it("rolls back every write, the version and the event when a statement fails mid-way", async () => {
    const t = await taxonomy();
    const p = await newProduct(t);
    const [a1, a2] = [await asset(), await asset()];
    const set = ok(await catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version, images: [{ assetId: a1, view: "front" }] }));
    const before = await productState(p.productId);
    await db.pool.query(`
      CREATE FUNCTION fail_boom_alt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.alt_text = 'boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER product_image_translations_boom BEFORE INSERT ON product_image_translations FOR EACH ROW EXECUTE FUNCTION fail_boom_alt();
    `);

    // a2 is inserted and a1 moved before the failing alt-text insert
    await expect(
      catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: set.version, images: [{ assetId: a2, view: "front" }, { assetId: a1, view: "detail", alt: [{ locale: "fa", text: "boom" }] }] }),
    ).rejects.toThrow();

    expect(await productState(p.productId)).toEqual(before);
    const view = ok(await catalog.media.listImages(reader(), { productId: p.productId }));
    expect(view.images.map((i) => [i.assetId, i.view, i.position])).toEqual([[a1, "front", 0]]);
    expect(await count("SELECT count(*) AS n FROM product_images")).toBe(1);
  });
});
