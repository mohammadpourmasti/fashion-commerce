import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { AuthorizationError, createRequestContext, type Permission, type RequestContext } from "@/shared/kernel/authorization";

import { createCatalog, type Catalog } from "./application/catalog";
import { CATALOG_PERMISSIONS } from "./domain/permissions";

// Phase 2C Step 6: publishing and unpublishing, and the last-active-variant guard, against a
// throwaway PostgreSQL as the least-privilege application role.

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
const editor = () => ctxWith([CATALOG_PERMISSIONS.productsRead, CATALOG_PERMISSIONS.productsManage, CATALOG_PERMISSIONS.mediaManage]);

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

let seq = 0;
async function setup() {
  const m = manager();
  const category = ok(await catalog.categories.create(m, { key: "women", translations: [fa("زنانه", { slug: "women" })] })).categoryId;
  const brand = ok(await catalog.brands.create(m, { key: "house", translations: [fa("خانه")] })).brandId;
  return { category, brand };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A draft product with one variant and one image: everything publishing needs. */
async function readyProduct(s: S, options: { brand?: boolean; variant?: boolean; image?: boolean } = {}) {
  seq += 1;
  const created = ok(
    await catalog.products.create(manager(), {
      translations: [fa(`محصول ${seq}`, { slug: `product-${seq}` })],
      primaryCategoryId: s.category,
      brandId: options.brand ? s.brand : null,
    }),
  );
  let version = created.version;
  let variantId: string | null = null;
  if (options.variant !== false) {
    const v = ok(await catalog.variants.create(manager(), { productId: created.productId, variants: [{ sku: `SKU-${seq}`, values: [] }] }));
    version = v.version;
    variantId = v.variants[0]!.variantId;
  }
  if (options.image !== false) {
    const assetId = ok(
      await catalog.media.registerAsset(manager(), { storageKey: `products/p-${seq}.jpg`, contentType: "image/jpeg", byteSize: 1000, width: 100, height: 100, sha256: seq.toString(16).padStart(64, "0") }),
    ).assetId;
    version = ok(await catalog.media.setProductImages(manager(), { productId: created.productId, expectedVersion: version, images: [{ assetId, view: "front" }] })).version;
  }
  return { productId: created.productId, version, variantId };
}

const row = async (productId: string) => {
  const { rows } = await db.pool.query("SELECT status, version, published_at FROM products WHERE id = $1", [productId]);
  return { status: rows[0].status as string, version: Number(rows[0].version), publishedAt: rows[0].published_at ? new Date(rows[0].published_at).getTime() : null };
};

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
  it("needs catalog:products.publish for both calls", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    await expect(catalog.publication.publish(editor(), { productId: p.productId, expectedVersion: p.version })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(catalog.publication.unpublish(editor(), { productId: p.productId, expectedVersion: p.version })).rejects.toBeInstanceOf(AuthorizationError);
    expect((await row(p.productId)).status).toBe("draft");
  });
});

describe("publish and unpublish", () => {
  it("publishes a ready draft: status, date, one version bump, one event", async () => {
    const s = await setup();
    const p = await readyProduct(s, { brand: true });
    clock = new Date("2030-03-01T00:00:00Z");
    const result = ok(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }));
    expect(result).toEqual({ productId: p.productId, version: p.version + 1, status: "active" });
    expect(await row(p.productId)).toEqual({ status: "active", version: p.version + 1, publishedAt: clock.getTime() });
    expect(await events("catalog.product.published")).toBe(1);
  });

  it("reports every blocking reason together and changes nothing", async () => {
    const s = await setup();
    const p = await readyProduct(s, { variant: false, image: false });
    const before = await events();
    const refused = await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version });
    expect(codes(refused)).toEqual(["no_active_variant", "no_image"]);
    expect(await row(p.productId)).toMatchObject({ status: "draft", version: p.version, publishedAt: null });
    expect(await events()).toBe(before);
  });

  it("refuses an archived primary category or brand", async () => {
    const s = await setup();
    const p = await readyProduct(s, { brand: true });
    ok(await catalog.brands.archive(manager(), { brandId: s.brand }));
    expect(codes(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }))).toEqual(["brand_archived"]);
    ok(await catalog.categories.archive(manager(), { categoryId: s.category }));
    expect(codes(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }))).toEqual(["category_archived", "brand_archived"]);
  });

  it("treats a repeat as an invalid transition, a stale version as a conflict, and unpublishes back to draft", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const published = ok(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }));
    expect(codes(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: published.version }))).toEqual(["invalid_transition"]);
    expect(codes(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }))).toEqual(["version_conflict"]);
    expect(codes(await catalog.publication.unpublish(manager(), { productId: p.productId, expectedVersion: 1 }))).toEqual(["version_conflict"]);

    const draft = ok(await catalog.publication.unpublish(manager(), { productId: p.productId, expectedVersion: published.version }));
    expect(draft).toEqual({ productId: p.productId, version: published.version + 1, status: "draft" });
    expect(await events("catalog.product.unpublished")).toBe(1);
    expect(codes(await catalog.publication.unpublish(manager(), { productId: p.productId, expectedVersion: draft.version }))).toEqual(["invalid_transition"]);

    const again = ok(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: draft.version }));
    expect(again.version).toBe(draft.version + 1);
    expect(await events("catalog.product.published")).toBe(2);
  });

  it("refuses archived and unknown products", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    ok(await catalog.products.archive(manager(), { productId: p.productId, expectedVersion: p.version }));
    expect(codes(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version + 1 }))).toEqual(["product_archived"]);
    expect(codes(await catalog.publication.publish(manager(), { productId: "00000000-0000-7000-8000-000000000000", expectedVersion: 1 }))).toEqual(["not_found"]);
  });

  it("an active product can still be archived, and a restore returns it to draft", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const published = ok(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }));
    const archived = ok(await catalog.products.archive(manager(), { productId: p.productId, expectedVersion: published.version }));
    const restored = ok(await catalog.products.restore(manager(), { productId: p.productId, expectedVersion: archived.version }));
    expect(restored.status).toBe("draft");
  });
});

describe("last active variant guard", () => {
  it("refuses discontinuing the last active variant of an active product, but not of a draft", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    expect(p.variantId).not.toBeNull();

    // two variants need an axis; use a second product with a size axis
    const sizeAxis = ok(await catalog.attributes.create(manager(), { key: "size", usage: "variant_axis", valueType: "select", axisKind: "size", translations: [fa("اندازه")] })).attributeId;
    const small = ok(await catalog.attributes.createValue(manager(), { attributeId: sizeAxis, key: "s", translations: [fa("s")] })).valueId;
    const medium = ok(await catalog.attributes.createValue(manager(), { attributeId: sizeAxis, key: "m", translations: [fa("m")] })).valueId;
    seq += 1;
    const created = ok(await catalog.products.create(manager(), { translations: [fa("پیراهن", { slug: "dress-two" })], primaryCategoryId: s.category }));
    let version = ok(await catalog.variants.setAxes(manager(), { productId: created.productId, expectedVersion: created.version, attributeIds: [sizeAxis] })).version;
    version = ok(await catalog.variants.offerValues(manager(), { productId: created.productId, expectedVersion: version, attributeId: sizeAxis, valueIds: [small, medium] })).version;
    const made = ok(
      await catalog.variants.create(manager(), { productId: created.productId, variants: [{ sku: "DRESS-S", values: [small] }, { sku: "DRESS-M", values: [medium] }] }),
    );
    const assetId = ok(
      await catalog.media.registerAsset(manager(), { storageKey: "products/dress-two.jpg", contentType: "image/jpeg", byteSize: 1000, width: 100, height: 100, sha256: "d".repeat(64) }),
    ).assetId;
    version = ok(await catalog.media.setProductImages(manager(), { productId: created.productId, expectedVersion: made.version, images: [{ assetId, view: "front" }] })).version;
    const published = ok(await catalog.publication.publish(manager(), { productId: created.productId, expectedVersion: version }));

    const [a, b] = made.variants;
    ok(await catalog.variants.discontinue(manager(), { variantId: a!.variantId }));
    const refused = await catalog.variants.discontinue(manager(), { variantId: b!.variantId });
    expect(codes(refused)).toEqual(["no_active_variant"]);
    expect(await count("SELECT count(*) AS n FROM variants WHERE product_id = $1 AND status = 'active'", [created.productId])).toBe(1);
    expect(await events("catalog.variant.discontinued")).toBe(1);
    expect((await row(created.productId)).version).toBe(published.version + 1);

    // once unpublished, the last variant may be discontinued
    const draft = ok(await catalog.publication.unpublish(manager(), { productId: created.productId, expectedVersion: published.version + 1 }));
    ok(await catalog.variants.discontinue(manager(), { variantId: b!.variantId }));
    expect(draft.status).toBe("draft");
    // and a product without active variants cannot be published again
    const blocked = await catalog.publication.publish(manager(), { productId: created.productId, expectedVersion: draft.version + 1 });
    expect(codes(blocked)).toEqual(["no_active_variant"]);
  });

  it("keeps the single variant of a published product", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    ok(await catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }));
    expect(codes(await catalog.variants.discontinue(manager(), { variantId: p.variantId! }))).toEqual(["no_active_variant"]);
  });
});

describe("concurrency", () => {
  it("publish queued before discontinuing the only variant wins; the discontinue is refused", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const [publish, discontinue] = await queued(
      p.productId,
      () => catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }),
      () => catalog.variants.discontinue(manager(), { variantId: p.variantId! }),
    );
    expect(publish.ok).toBe(true);
    expect(codes(discontinue)).toEqual(["no_active_variant"]);
    expect(await count("SELECT count(*) AS n FROM variants WHERE status = 'active'")).toBe(1);
    expect((await row(p.productId)).status).toBe("active");
  });

  it("discontinuing the only variant queued before publish wins; the publish is refused", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const [discontinue, publish] = await queued(
      p.productId,
      () => catalog.variants.discontinue(manager(), { variantId: p.variantId! }),
      () => catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version + 1 }),
    );
    expect(discontinue.ok).toBe(true);
    expect(codes(publish)).toEqual(["no_active_variant"]);
    expect((await row(p.productId)).status).toBe("draft");
    expect(await events("catalog.product.published")).toBe(0);
  });

  it("publish queued before clearing the images wins; clearing is then refused", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const [publish, clear] = await queued(
      p.productId,
      () => catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }),
      () => catalog.media.setProductImages(manager(), { productId: p.productId, expectedVersion: p.version + 1, images: [] }),
    );
    expect(publish.ok).toBe(true);
    expect(codes(clear)).toEqual(["no_image"]);
    expect(await count("SELECT count(*) AS n FROM product_images WHERE product_id = $1", [p.productId])).toBe(1);
  });

  it("two publishes from the same version: one wins, one conflicts, one event", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const [one, two] = await queued(
      p.productId,
      () => catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }),
      () => catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }),
    );
    expect(one.ok).toBe(true);
    expect(codes(two)).toEqual(["version_conflict"]);
    expect(await events("catalog.product.published")).toBe(1);
  });

  it("a category archive committed while publish waits is honoured", async () => {
    const s = await setup();
    const p = await readyProduct(s);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE categories SET status = 'archived' WHERE id = $1", [s.category]);
      let done = false;
      const publishing = catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version }).then((r) => ((done = true), r));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      await holder.query("COMMIT");
      expect(codes(await publishing)).toEqual(["category_archived"]);
    } finally {
      holder.release();
    }
    expect((await row(p.productId)).status).toBe("draft");
  });

  it("a brand archive committed while publish waits is honoured", async () => {
    const s = await setup();
    const p = await readyProduct(s, { brand: true });
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE brands SET status = 'archived' WHERE id = $1", [s.brand]);
      const publishing = catalog.publication.publish(manager(), { productId: p.productId, expectedVersion: p.version });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await holder.query("COMMIT");
      expect(codes(await publishing)).toEqual(["brand_archived"]);
    } finally {
      holder.release();
    }
    expect((await row(p.productId)).status).toBe("draft");
  });
});
