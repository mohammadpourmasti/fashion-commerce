import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Pool, QueryResult } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { pgErrorCode } from "@/shared/db/errors";
import { migrateDown, migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS, schemaSnapshot } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";

import * as schema from "./infrastructure/schema";

// Step 1 of phase 2C: the catalog schema only (migration 0003_catalog + Drizzle mirror).
// Rows inserted here are test fixtures in throwaway databases, never seed data.

const PREVIOUS_MIGRATION = 2;
const FCD01 = /refused.*still contains data/s;

const TABLES: PgTable[] = [
  schema.categories,
  schema.categoryTranslations,
  schema.brands,
  schema.brandTranslations,
  schema.attributes,
  schema.attributeTranslations,
  schema.attributeValues,
  schema.attributeValueTranslations,
  schema.products,
  schema.productTranslations,
  schema.productCategories,
  schema.productAttributeValues,
  schema.productAttributeValueTranslations,
  schema.productAxes,
  schema.productAxisValues,
  schema.variants,
  schema.mediaAssets,
  schema.productImages,
  schema.productImageTranslations,
];
const TABLE_NAMES = TABLES.map((t) => getTableName(t)).sort();

let db: TestDatabase;
/** Connects as the least-privilege application role, like the real runtime. */
let app: Pool;

beforeEach(async () => {
  db = await createTestDatabase();
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS, appRole: db.appRole });
  app = createPool(db.url, { max: 4, options: `-c role=${db.appRole}` });
});

afterEach(async () => {
  await app?.end();
  await db?.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Query = (text: string, params?: unknown[]) => Promise<QueryResult>;

/** Orders rows by their first cell in code-unit order, independent of the database collation. */
const byFirst = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);

/** Runs `fn` in one transaction as `pool`'s role; deferred constraints are checked at COMMIT. */
async function inTx(fn: (q: Query) => Promise<void>, pool: Pool = app): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn((text, params) => client.query(text, params));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The SQLSTATE and constraint of the failure, or null when the operation succeeded.
 * A bad reference reports 23503; deleting or re-keying a row that is still referenced through an
 * ON DELETE/UPDATE RESTRICT foreign key reports 23001 (restrict_violation).
 */
async function failure(operation: Promise<unknown>): Promise<{ code: string | undefined; constraint: string | undefined } | null> {
  return operation.then(
    () => null,
    (error: unknown) => ({ code: pgErrorCode(error), constraint: (error as { constraint?: string }).constraint }),
  );
}

const q: Query = (text, params) => app.query(text, params);

async function id(query: Query, text: string, params: unknown[] = []): Promise<string> {
  const { rows } = await query(text, params);
  const value = rows[0]?.id;
  if (typeof value !== "string") throw new Error(`no id returned by: ${text}`);
  return value;
}

async function count(table: string): Promise<number> {
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

const category = (key: string, query: Query = q) => id(query, "INSERT INTO categories (key) VALUES ($1) RETURNING id", [key]);

const attribute = (key: string, usage: "variant_axis" | "descriptive", valueType: string, unit: string | null = null, axisKind: string | null = null) =>
  id(q, "INSERT INTO attributes (key, usage, value_type, unit, axis_kind) VALUES ($1, $2, $3, $4, $5) RETURNING id", [key, usage, valueType, unit, axisKind]);

const axisAttribute = (key: string, axisKind: "color" | "size" | "other") => attribute(key, "variant_axis", "select", null, axisKind);

const value = (attributeId: string, key: string) =>
  id(q, "INSERT INTO attribute_values (attribute_id, key) VALUES ($1, $2) RETURNING id", [attributeId, key]);

/** Inserts a product and its primary category membership in the caller's transaction. */
async function insertProduct(query: Query, categoryId: string, axisCount = 0): Promise<string> {
  const productId = await id(query, "INSERT INTO products (primary_category_id, axis_count) VALUES ($1, $2) RETURNING id", [categoryId, axisCount]);
  await query("INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)", [productId, categoryId]);
  return productId;
}

const addAxis = (query: Query, productId: string, position: number, attributeId: string) =>
  query("INSERT INTO product_axes (product_id, position, attribute_id) VALUES ($1, $2, $3)", [productId, position, attributeId]);

const offer = (query: Query, productId: string, position: number, attributeId: string, valueId: string) =>
  query("INSERT INTO product_axis_values (product_id, value_id, attribute_id, position) VALUES ($1, $2, $3, $4)", [productId, valueId, attributeId, position]);

const variant = (query: Query, productId: string, axisCount: number, sku: string, values: (string | null)[], barcode: string | null = null) =>
  id(
    query,
    "INSERT INTO variants (product_id, axis_count, sku, barcode, value1, value2, value3) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [productId, axisCount, sku, barcode, values[0] ?? null, values[1] ?? null, values[2] ?? null],
  );

/**
 * A small women's-wear taxonomy and one dress with two axes: size (S, M offered) and colour
 * (red offered). L and black exist as attribute values but are not offered by the dress.
 */
async function apparel() {
  const women = await category("women");
  const dresses = await category("women-dresses");
  const size = await axisAttribute("size_women", "size");
  const color = await axisAttribute("color", "color");
  const material = await attribute("material", "descriptive", "select");
  const lengthCm = await attribute("length", "descriptive", "number", "cm");
  const lined = await attribute("lined", "descriptive", "boolean");
  const care = await attribute("care", "descriptive", "text");
  const [S, M, L] = [await value(size, "s"), await value(size, "m"), await value(size, "l")];
  const [red, black] = [await value(color, "red"), await value(color, "black")];
  const [cotton, linen] = [await value(material, "cotton"), await value(material, "linen")];
  let dress = "";
  await inTx(async (tx) => {
    dress = await insertProduct(tx, dresses, 2);
    await addAxis(tx, dress, 1, size);
    await addAxis(tx, dress, 2, color);
    await offer(tx, dress, 1, size, S);
    await offer(tx, dress, 1, size, M);
    await offer(tx, dress, 2, color, red);
  });
  return { women, dresses, size, color, material, lengthCm, lined, care, S, M, L, red, black, cotton, linen, dress };
}

async function asset(sha = "a".repeat(64), key = `products/${sha.slice(0, 8)}.webp`): Promise<string> {
  return id(
    q,
    "INSERT INTO media_assets (storage_key, content_type, byte_size, width, height, sha256) VALUES ($1, 'image/webp', 1024, 800, 1200, $2) RETURNING id",
    [key, sha],
  );
}

// ---------------------------------------------------------------------------
// Migration and schema parity
// ---------------------------------------------------------------------------

describe("migration 0003_catalog", () => {
  it.each(TABLES.map((t) => [getTableName(t), t] as const))("Drizzle definition of %s matches the database", async (name, table) => {
    const config = getTableConfig(table);
    const rel = `public.${name}`;

    const cols = await db.pool.query(
      "SELECT column_name, is_nullable, is_generated FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
      [name],
    );
    expect(cols.rows.map((r) => [r.column_name, r.is_nullable, r.is_generated]).sort(byFirst)).toEqual(
      config.columns
        .map((c) => [c.name, c.notNull ? "NO" : "YES", c.generated ? "ALWAYS" : "NEVER"])
        .sort(byFirst),
    );

    const checks = await db.pool.query("SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname", [rel]);
    expect(checks.rows.map((r) => r.conname).sort()).toEqual(config.checks.map((c) => c.name).sort());

    const uniques = await db.pool.query(
      `SELECT c.conname, i.indnullsnotdistinct AS nnd
         FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
        WHERE c.conrelid = $1::regclass AND c.contype = 'u' ORDER BY c.conname`,
      [rel],
    );
    expect(uniques.rows.map((r) => [r.conname, r.nnd]).sort(byFirst)).toEqual(
      config.uniqueConstraints.map((u) => [u.getName(), u.nullsNotDistinct]).sort(byFirst),
    );

    const fks = await db.pool.query(
      `SELECT c.conname, c.confrelid::regclass::text AS ref,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
              ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i) AS refcols
         FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f' ORDER BY c.conname`,
      [rel],
    );
    expect(fks.rows.map((r) => [r.conname, r.ref, r.cols, r.refcols]).sort(byFirst)).toEqual(
      config.foreignKeys
        .map((fk) => {
          const ref = fk.reference();
          return [fk.getName(), getTableName(ref.foreignTable), ref.columns.map((c) => c.name), ref.foreignColumns.map((c) => c.name)];
        })
        .sort(byFirst),
    );

    // Plain indexes only: indexes that back a PRIMARY KEY or UNIQUE constraint are covered above.
    const indexes = await db.pool.query(
      `SELECT ic.relname AS name FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
        WHERE i.indrelid = $1::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
        ORDER BY ic.relname`,
      [rel],
    );
    expect(indexes.rows.map((r) => r.name).sort()).toEqual(config.indexes.map((i) => i.config.name).sort());
  });

  it("keeps the deferred constraints and triggers that Drizzle cannot express", async () => {
    const deferred = await db.pool.query(
      "SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND condeferrable AND condeferred ORDER BY conname",
    );
    expect(deferred.rows.map((r) => r.conname).sort()).toEqual([
      "product_axes_match_axis_count",
      "product_images_position_unique",
      "products_axes_match_axis_count",
      "products_primary_category_member_fk",
    ]);
  });

  it("creates exactly the 19 catalog tables, and an empty down restores the previous schema exactly", async () => {
    const empty = await createTestDatabase();
    try {
      await migrateUp(empty.pool, { directory: REAL_MIGRATIONS, appRole: empty.appRole, to: PREVIOUS_MIGRATION });
      const tablesBefore = await tableNames(empty.pool);
      const before = await schemaSnapshot(empty.pool);

      await migrateUp(empty.pool, { directory: REAL_MIGRATIONS, appRole: empty.appRole });
      const after = await schemaSnapshot(empty.pool);
      expect((await tableNames(empty.pool)).filter((t) => !tablesBefore.includes(t))).toEqual(TABLE_NAMES);

      expect(await migrateDown(empty.pool, { directory: REAL_MIGRATIONS, steps: 1, production: false })).toEqual({ reverted: ["0003_catalog"] });
      expect(await tableNames(empty.pool)).toEqual(tablesBefore);
      expect(await schemaSnapshot(empty.pool)).toBe(before);

      await migrateUp(empty.pool, { directory: REAL_MIGRATIONS, appRole: empty.appRole });
      expect(await schemaSnapshot(empty.pool)).toBe(after);
    } finally {
      await empty.cleanup();
    }
  });

  it("refuses to go down once catalog data exists (FCD01), and changes nothing", async () => {
    const t = await apparel();
    await variant(q, t.dress, 2, "DRS-S-RED", [t.S, t.red]);
    const before = await schemaSnapshot(db.pool);

    await expect(migrateDown(db.pool, { directory: REAL_MIGRATIONS, steps: 1, production: false })).rejects.toThrow(FCD01);

    expect(await schemaSnapshot(db.pool)).toBe(before);
    expect(await count("variants")).toBe(1);
    expect(await count("products")).toBe(1);
    expect(await count("product_categories")).toBe(1);
  });

  it("refuses to go down when only a leaf table holds data", async () => {
    await category("women");
    await expect(migrateDown(db.pool, { directory: REAL_MIGRATIONS, steps: 1, production: false })).rejects.toThrow(FCD01);
    expect(await count("categories")).toBe(1);
  });

  it("seeds nothing: every catalog table is empty after migrating", async () => {
    for (const name of TABLE_NAMES) expect(await count(name), name).toBe(0);
  });

  it("gives the application role no way to delete or truncate master rows", async () => {
    const t = await apparel();
    await variant(q, t.dress, 2, "DRS-S-RED", [t.S, t.red]);
    await brandRow();
    await asset();
    for (const statement of [
      "DELETE FROM products",
      "DELETE FROM variants",
      "DELETE FROM attribute_values",
      "DELETE FROM attributes",
      "DELETE FROM categories",
      "DELETE FROM brands",
      "DELETE FROM media_assets",
      "TRUNCATE products CASCADE",
      "DROP TABLE variants",
    ]) {
      expect((await failure(q(statement)))?.code, statement).toBe("42501");
    }
    expect(await count("products")).toBe(1);
    expect(await count("variants")).toBe(1);
  });
});

async function tableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  return rows.map((r) => r.tablename as string);
}

const brandRow = () => id(q, "INSERT INTO brands (key) VALUES ('house-label') RETURNING id");

// ---------------------------------------------------------------------------
// Primary category membership (refinement D)
// ---------------------------------------------------------------------------

describe("primary category", () => {
  it("cannot be committed unless it is one of the product's categories", async () => {
    const women = await category("women");
    const kids = await category("kids");
    const orphan = await failure(
      inTx(async (tx) => {
        await tx("INSERT INTO products (primary_category_id) VALUES ($1)", [women]);
      }),
    );
    expect(orphan).toEqual({ code: "23503", constraint: "products_primary_category_member_fk" });

    const elsewhere = await failure(
      inTx(async (tx) => {
        const productId = await id(tx, "INSERT INTO products (primary_category_id) VALUES ($1) RETURNING id", [women]);
        await tx("INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)", [productId, kids]);
      }),
    );
    expect(elsewhere).toEqual({ code: "23503", constraint: "products_primary_category_member_fk" });
    expect(await count("products")).toBe(0);
  });

  it("cannot lose its membership, but secondary categories can be removed and the primary switched", async () => {
    const women = await category("women");
    const sale = await category("sale");
    let productId = "";
    await inTx(async (tx) => {
      productId = await insertProduct(tx, women);
      await tx("INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)", [productId, sale]);
    });

    expect(await failure(q("DELETE FROM product_categories WHERE product_id = $1 AND category_id = $2", [productId, women]))).toEqual({
      code: "23001",
      constraint: "products_primary_category_member_fk",
    });

    // Switch the primary to the other membership, then drop the old one, in one transaction.
    await inTx(async (tx) => {
      await tx("UPDATE products SET primary_category_id = $2 WHERE id = $1", [productId, sale]);
      await tx("DELETE FROM product_categories WHERE product_id = $1 AND category_id = $2", [productId, women]);
    });
    const { rows } = await q("SELECT primary_category_id FROM products WHERE id = $1", [productId]);
    expect(rows[0].primary_category_id).toBe(sale);
  });
});

// ---------------------------------------------------------------------------
// Attributes, axes and axis values
// ---------------------------------------------------------------------------

describe("attributes and axes", () => {
  it("allows values only on select attributes, and axes only on select attributes", async () => {
    const lengthCm = await attribute("length", "descriptive", "number", "cm");
    expect(await failure(value(lengthCm, "long"))).toEqual({ code: "23503", constraint: "attribute_values_select_attribute_fk" });
    expect(await failure(attribute("size_text", "variant_axis", "text", null, "size"))).toEqual({ code: "23514", constraint: "attributes_axis_is_select" });
    expect(await failure(attribute("size_plain", "variant_axis", "select"))).toEqual({ code: "23514", constraint: "attributes_axis_kind_for_axes" });
    expect(await failure(attribute("fabric", "descriptive", "select", null, "color"))).toEqual({ code: "23514", constraint: "attributes_axis_kind_for_axes" });
    expect(await failure(axisAttribute("print", "pattern" as "other"))).toEqual({ code: "23514", constraint: "attributes_axis_kind_valid" });
    expect(await failure(attribute("weight", "descriptive", "text", "g"))).toEqual({ code: "23514", constraint: "attributes_unit_only_for_numbers" });

    const material = await attribute("material", "descriptive", "select");
    await value(material, "cotton");
    expect(await failure(q("UPDATE attributes SET value_type = 'text' WHERE id = $1", [material]))).toEqual({
      code: "23001",
      constraint: "attribute_values_select_attribute_fk",
    });
  });

  it("uses only variant-axis attributes as axes, each at most once", async () => {
    const t = await apparel();
    const plain = await category("accessories");
    const result = await failure(
      inTx(async (tx) => {
        const bag = await insertProduct(tx, plain, 1);
        await addAxis(tx, bag, 1, t.material);
      }),
    );
    expect(result).toEqual({ code: "23503", constraint: "product_axes_attribute_fk" });

    const twice = await failure(
      inTx(async (tx) => {
        const bag = await insertProduct(tx, plain, 2);
        await addAxis(tx, bag, 1, t.size);
        await addAxis(tx, bag, 2, t.size);
      }),
    );
    expect(twice).toEqual({ code: "23505", constraint: "product_axes_attribute_unique" });
  });

  it("only offers values that belong to the axis attribute in that position", async () => {
    const t = await apparel();
    // A colour value on the size axis.
    expect(await failure(offer(q, t.dress, 1, t.size, t.black))).toEqual({ code: "23503", constraint: "product_axis_values_value_fk" });
    // The colour attribute claimed for position 1, which is the size axis.
    expect(await failure(offer(q, t.dress, 1, t.color, t.black))).toEqual({ code: "23503", constraint: "product_axis_values_axis_fk" });
    // A new value on an existing axis is fine.
    await offer(q, t.dress, 2, t.color, t.black);
  });

  it("requires a product's axes to be exactly positions 1..axis_count at commit", async () => {
    const t = await apparel();
    const missing = await failure(
      inTx(async (tx) => {
        const top = await insertProduct(tx, t.women, 2);
        await addAxis(tx, top, 1, t.size);
      }),
    );
    expect(missing).toEqual({ code: "23514", constraint: "product_axes_match_axis_count" });

    const gap = await failure(
      inTx(async (tx) => {
        const top = await insertProduct(tx, t.women, 2);
        await addAxis(tx, top, 1, t.size);
        await addAxis(tx, top, 3, t.color);
      }),
    );
    expect(gap).toEqual({ code: "23514", constraint: "product_axes_match_axis_count" });

    const extra = await failure(
      inTx(async (tx) => {
        const top = await insertProduct(tx, t.women, 0);
        await addAxis(tx, top, 1, t.size);
      }),
    );
    expect(extra).toEqual({ code: "23514", constraint: "product_axes_match_axis_count" });
    expect(await count("products")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

describe("variants", () => {
  it("need one offered value per axis, in the right position, and a unique combination", async () => {
    const t = await apparel();
    await variant(q, t.dress, 2, "DRS-S-RED", [t.S, t.red]);

    expect(await failure(variant(q, t.dress, 2, "DRS-S", [t.S, null]))).toEqual({ code: "23514", constraint: "variants_values_match_axis_count" });
    expect(await failure(variant(q, t.dress, 2, "DRS-RED-S", [t.red, t.S]))).toEqual({ code: "23503", constraint: "variants_value1_fk" });
    // L is a size value, but the dress does not offer it.
    expect(await failure(variant(q, t.dress, 2, "DRS-L-RED", [t.L, t.red]))).toEqual({ code: "23503", constraint: "variants_value1_fk" });
    expect(await failure(variant(q, t.dress, 2, "DRS-S-RED-2", [t.S, t.red]))).toEqual({ code: "23505", constraint: "variants_combination_unique" });
    // axis_count must match the product's.
    expect(await failure(variant(q, t.dress, 1, "DRS-M", [t.M]))).toEqual({ code: "23503", constraint: "variants_product_axis_count_fk" });
  });

  it("cannot use another product's axis values", async () => {
    const t = await apparel();
    let other = "";
    await inTx(async (tx) => {
      other = await insertProduct(tx, t.women, 1);
      await addAxis(tx, other, 1, t.size);
      await offer(tx, other, 1, t.size, t.L);
    });
    expect(await failure(variant(q, t.dress, 2, "DRS-L-RED", [t.L, t.red]))).toEqual({ code: "23503", constraint: "variants_value1_fk" });
  });

  it("allow exactly one variant on a product without axes (one size)", async () => {
    const accessories = await category("accessories");
    let scarf = "";
    await inTx(async (tx) => {
      scarf = await insertProduct(tx, accessories, 0);
    });
    await variant(q, scarf, 0, "SCARF-01", []);
    expect(await failure(variant(q, scarf, 0, "SCARF-02", []))).toEqual({ code: "23505", constraint: "variants_combination_unique" });
  });

  it("freeze the axis structure once they exist, but new values can still be added (refinement E)", async () => {
    const t = await apparel();
    await variant(q, t.dress, 2, "DRS-S-RED", [t.S, t.red]);

    expect(await failure(q("UPDATE products SET axis_count = 1 WHERE id = $1", [t.dress]))).toEqual({
      code: "23001",
      constraint: "variants_product_axis_count_fk",
    });
    expect(await failure(q("DELETE FROM product_axis_values WHERE product_id = $1 AND value_id = $2", [t.dress, t.red]))).toEqual({
      code: "23001",
      constraint: "variants_value2_fk",
    });
    expect(await failure(q("DELETE FROM product_axes WHERE product_id = $1 AND position = 2", [t.dress]))).toEqual({
      code: "23001",
      constraint: "product_axis_values_axis_fk",
    });
    // Even the schema owner cannot re-point an axis at another attribute.
    const pattern = await axisAttribute("pattern", "other");
    expect(await failure(db.pool.query("UPDATE product_axes SET attribute_id = $2 WHERE product_id = $1 AND position = 2", [t.dress, pattern]))).toEqual({
      code: "23001",
      constraint: "product_axis_values_axis_fk",
    });
    // The app role has no UPDATE on product_axes at all.
    expect((await failure(q("UPDATE product_axes SET position = 3 WHERE product_id = $1 AND position = 2", [t.dress])))?.code).toBe("42501");

    // Adding values to the existing axes, and variants that use them, still works.
    await offer(q, t.dress, 1, t.size, t.L);
    await offer(q, t.dress, 2, t.color, t.black);
    await variant(q, t.dress, 2, "DRS-L-BLACK", [t.L, t.black]);
    // An offered value that no variant uses can still be withdrawn.
    const xl = await value(t.size, "xl");
    await offer(q, t.dress, 1, t.size, xl);
    await q("DELETE FROM product_axis_values WHERE product_id = $1 AND value_id = $2", [t.dress, xl]);
    expect(await count("product_axis_values")).toBe(5);
  });

  it("let the axis structure change freely while no variant exists", async () => {
    const t = await apparel();
    await inTx(async (tx) => {
      await tx("DELETE FROM product_axis_values WHERE product_id = $1 AND position = 2", [t.dress]);
      await tx("DELETE FROM product_axes WHERE product_id = $1 AND position = 2", [t.dress]);
      await tx("UPDATE products SET axis_count = 1 WHERE id = $1", [t.dress]);
    });
    await variant(q, t.dress, 1, "DRS-M", [t.M]);
  });

  it("enforce the SKU format and uniqueness, and a valid GTIN barcode when present", async () => {
    const t = await apparel();
    await variant(q, t.dress, 2, "DRS-S-RED", [t.S, t.red], "4006381333931");
    expect(await failure(variant(q, t.dress, 2, "drs-m-red", [t.M, t.red]))).toEqual({ code: "23514", constraint: "variants_sku_format" });
    expect(await failure(variant(q, t.dress, 2, "DR", [t.M, t.red]))).toEqual({ code: "23514", constraint: "variants_sku_format" });
    expect(await failure(variant(q, t.dress, 2, "DRS-S-RED", [t.M, t.red]))).toEqual({ code: "23505", constraint: "variants_sku_unique" });
    expect(await failure(variant(q, t.dress, 2, "DRS-M-RED", [t.M, t.red], "4006381333932"))).toEqual({ code: "23514", constraint: "variants_barcode_gtin" });
    expect(await failure(variant(q, t.dress, 2, "DRS-M-RED", [t.M, t.red], "4006381333931"))).toEqual({ code: "23505", constraint: "variants_barcode_unique" });

    const { rows } = await q(
      "SELECT code, catalog_gtin_is_valid(code) AS ok FROM unnest($1::text[]) AS code ORDER BY code",
      [["96385074", "036000291452", "4006381333931", "10614141000415", "96385075", "40063813339A1", "123", "400638133393100"]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.code, r.ok]))).toEqual({
      "96385074": true, // GTIN-8
      "036000291452": true, // GTIN-12 (UPC-A)
      "4006381333931": true, // GTIN-13 (EAN-13)
      "10614141000415": true, // GTIN-14
      "96385075": false,
      "40063813339A1": false,
      "123": false,
      "400638133393100": false,
    });
  });

  it("keep discontinued and timestamps consistent", async () => {
    const t = await apparel();
    const v = await variant(q, t.dress, 2, "DRS-S-RED", [t.S, t.red]);
    expect(await failure(q("UPDATE variants SET status = 'discontinued' WHERE id = $1", [v]))).toEqual({
      code: "23514",
      constraint: "variants_discontinued_consistent",
    });
    await q("UPDATE variants SET status = 'discontinued', discontinued_at = now() WHERE id = $1", [v]);
    expect(await failure(q("UPDATE products SET status = 'active' WHERE id = $1", [t.dress]))).toEqual({
      code: "23514",
      constraint: "products_active_published",
    });
  });
});

// ---------------------------------------------------------------------------
// Descriptive attributes (refinement A)
// ---------------------------------------------------------------------------

describe("descriptive attribute values", () => {
  const pav = (productId: string, attributeId: string, valueType: string, v: { valueId?: string; number?: string; bool?: boolean } = {}) =>
    id(
      q,
      "INSERT INTO product_attribute_values (product_id, attribute_id, value_type, value_id, number_value, boolean_value) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [productId, attributeId, valueType, v.valueId ?? null, v.number ?? null, v.bool ?? null],
    );

  it("store select, number, boolean and localized text values, typed by the attribute", async () => {
    const t = await apparel();
    await pav(t.dress, t.material, "select", { valueId: t.cotton });
    await pav(t.dress, t.material, "select", { valueId: t.linen }); // several selected values
    await pav(t.dress, t.lengthCm, "number", { number: "112.5" });
    await pav(t.dress, t.lined, "boolean", { bool: true });
    const careRow = await pav(t.dress, t.care, "text");
    await q("INSERT INTO product_attribute_value_translations (product_attribute_value_id, locale, text_value) VALUES ($1, 'fa', $2), ($1, 'en', $3)", [
      careRow,
      "شست‌وشو با دست در آب سرد",
      "Hand wash cold",
    ]);
    expect(await count("product_attribute_values")).toBe(5);

    // Deleting a text value removes its translations with it.
    await q("DELETE FROM product_attribute_values WHERE id = $1", [careRow]);
    expect(await count("product_attribute_value_translations")).toBe(0);
  });

  it("reject values that do not match the attribute's type or usage", async () => {
    const t = await apparel();
    // number declared for a select attribute
    expect(await failure(pav(t.dress, t.material, "number", { number: "1" }))).toEqual({ code: "23503", constraint: "product_attribute_values_attribute_fk" });
    // a variant axis used as a descriptive attribute
    expect(await failure(pav(t.dress, t.size, "select", { valueId: t.S }))).toEqual({ code: "23503", constraint: "product_attribute_values_attribute_fk" });
    // a value of a different attribute
    expect(await failure(pav(t.dress, t.material, "select", { valueId: t.red }))).toEqual({ code: "23503", constraint: "product_attribute_values_value_fk" });
    // a number row without a number, or with a stray select value
    expect(await failure(pav(t.dress, t.lengthCm, "number"))).toEqual({ code: "23514", constraint: "product_attribute_values_typed" });
    expect(await failure(pav(t.dress, t.lengthCm, "number", { number: "1", valueId: t.cotton }))).toEqual({
      code: "23514",
      constraint: "product_attribute_values_typed",
    });
    expect(await failure(pav(t.dress, t.lengthCm, "number", { number: "NaN" }))).toEqual({ code: "23514", constraint: "product_attribute_values_number_finite" });
    // one number per product and attribute
    await pav(t.dress, t.lengthCm, "number", { number: "110" });
    expect(await failure(pav(t.dress, t.lengthCm, "number", { number: "120" }))).toEqual({ code: "23505", constraint: "product_attribute_values_unique" });
    // translations only for text values
    const numberRow = (await q("SELECT id FROM product_attribute_values WHERE attribute_id = $1", [t.lengthCm])).rows[0].id;
    expect(
      await failure(q("INSERT INTO product_attribute_value_translations (product_attribute_value_id, locale, text_value) VALUES ($1, 'fa', 'x')", [numberRow])),
    ).toEqual({ code: "23503", constraint: "product_attribute_value_translations_text_fk" });
  });
});

// ---------------------------------------------------------------------------
// Images (refinements B and C)
// ---------------------------------------------------------------------------

describe("product images", () => {
  /** `color` is [valueId, attributeId]: the colour value and the attribute it belongs to. */
  const image = (productId: string, assetId: string, view: string, position: number, color: [string | null, string | null] = [null, null]) =>
    id(
      q,
      "INSERT INTO product_images (product_id, asset_id, view, position, color_value_id, color_attribute_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [productId, assetId, view, position, color[0], color[1]],
    );

  it("carry a view and may be tied only to a colour the product offers, never to a size or other axis", async () => {
    const t = await apparel();
    const front = await image(t.dress, await asset("1".repeat(64)), "front", 0, [t.red, t.color]);
    await image(t.dress, await asset("2".repeat(64)), "back", 1, [t.red, t.color]);
    await image(t.dress, await asset("3".repeat(64)), "detail", 2);
    await q("INSERT INTO product_image_translations (image_id, locale, alt_text) VALUES ($1, 'fa', $2)", [front, "پیراهن قرمز، نمای جلو"]);

    expect(await failure(image(t.dress, await asset("4".repeat(64)), "side", 3))).toEqual({ code: "23514", constraint: "product_images_view_valid" });
    // S is offered by the dress, but on the size axis: not a colour
    expect(await failure(image(t.dress, await asset("a1".repeat(32)), "gallery", 3, [t.S, t.size]))).toEqual({
      code: "23503",
      constraint: "product_images_color_attribute_fk",
    });
    // S claimed to be a value of the colour attribute
    expect(await failure(image(t.dress, await asset("a2".repeat(32)), "gallery", 3, [t.S, t.color]))).toEqual({
      code: "23503",
      constraint: "product_images_color_value_fk",
    });
    // a value without its attribute (or the reverse)
    expect(await failure(image(t.dress, await asset("a3".repeat(32)), "gallery", 3, [t.red, null]))).toEqual({ code: "23514", constraint: "product_images_color_pair" });
    expect(await failure(image(t.dress, await asset("a4".repeat(32)), "gallery", 3, [null, t.color]))).toEqual({ code: "23514", constraint: "product_images_color_pair" });
    // a colour axis of kind "other" (e.g. pattern) does not qualify either
    const pattern = await axisAttribute("pattern", "other");
    const floral = await value(pattern, "floral");
    let printed = "";
    await inTx(async (tx) => {
      printed = await insertProduct(tx, t.women, 1);
      await addAxis(tx, printed, 1, pattern);
      await offer(tx, printed, 1, pattern, floral);
    });
    expect(await failure(image(printed, await asset("a5".repeat(32)), "front", 0, [floral, pattern]))).toEqual({
      code: "23503",
      constraint: "product_images_color_attribute_fk",
    });
    // black exists, but the dress does not offer it
    expect(await failure(image(t.dress, await asset("5".repeat(64)), "gallery", 3, [t.black, t.color]))).toEqual({
      code: "23503",
      constraint: "product_images_color_value_fk",
    });
    // an axis value that is offered, but by another product
    let other = "";
    await inTx(async (tx) => {
      other = await insertProduct(tx, t.women, 1);
      await addAxis(tx, other, 1, t.color);
      await offer(tx, other, 1, t.color, t.black);
    });
    expect(await failure(image(t.dress, await asset("6".repeat(64)), "gallery", 3, [t.black, t.color]))).toEqual({
      code: "23503",
      constraint: "product_images_color_value_fk",
    });
    // a colour that has images cannot be withdrawn from the product
    expect(await failure(q("DELETE FROM product_axis_values WHERE product_id = $1 AND value_id = $2", [t.dress, t.red]))).toEqual({
      code: "23001",
      constraint: "product_images_color_value_fk",
    });
    // nor can the colour attribute stop being a colour while images point at it
    expect(await failure(q("UPDATE attributes SET axis_kind = 'other' WHERE id = $1", [t.color]))).toEqual({
      code: "23001",
      constraint: "product_images_color_attribute_fk",
    });

    // removing an image removes its alt texts
    await q("DELETE FROM product_images WHERE id = $1", [front]);
    expect(await count("product_image_translations")).toBe(0);
  });

  it("can be reordered in one transaction, but positions are unique at commit", async () => {
    const t = await apparel();
    const a = await image(t.dress, await asset("1".repeat(64)), "front", 0);
    const b = await image(t.dress, await asset("2".repeat(64)), "back", 1);
    await inTx(async (tx) => {
      await tx("UPDATE product_images SET position = 1 WHERE id = $1", [a]);
      await tx("UPDATE product_images SET position = 0 WHERE id = $1", [b]);
    });
    expect(await failure(q("UPDATE product_images SET position = 1 WHERE id = $1", [b]))).toEqual({
      code: "23505",
      constraint: "product_images_position_unique",
    });
    const sameAsset = (await q("SELECT asset_id FROM product_images WHERE id = $1", [a])).rows[0].asset_id;
    expect(await failure(image(t.dress, sameAsset, "gallery", 5))).toEqual({ code: "23505", constraint: "product_images_asset_unique" });
  });

  it("validate media metadata", async () => {
    expect(await failure(asset("not-a-hash"))).toEqual({ code: "23514", constraint: "media_assets_sha256_format" });
    expect(await failure(asset("7".repeat(64), "products/../secret.webp"))).toEqual({ code: "23514", constraint: "media_assets_storage_key_format" });
    expect(await failure(asset("8".repeat(64), "Products/UPPER.webp"))).toEqual({ code: "23514", constraint: "media_assets_storage_key_format" });
    expect(
      await failure(
        q("INSERT INTO media_assets (storage_key, content_type, byte_size, width, height, sha256) VALUES ('a.gif', 'image/gif', 10, 1, 1, $1)", ["9".repeat(64)]),
      ),
    ).toEqual({ code: "23514", constraint: "media_assets_content_type_valid" });
    await asset("a".repeat(64));
    expect(await failure(asset("a".repeat(64), "products/copy.webp"))).toEqual({ code: "23505", constraint: "media_assets_sha256_unique" });
  });
});

// ---------------------------------------------------------------------------
// Localized content
// ---------------------------------------------------------------------------

describe("localized content", () => {
  const translate = (productId: string, locale: string, name: string, slug: string) =>
    q("INSERT INTO product_translations (product_id, locale, name, slug) VALUES ($1, $2, $3, $4)", [productId, locale, name, slug]);

  it("accepts normalized Persian and Latin slugs, unique per locale", async () => {
    const t = await apparel();
    await translate(t.dress, "fa", "پیراهن مجلسی زنانه", "پیراهن-مجلسی-زنانه");
    await translate(t.dress, "en", "Women's evening dress", "womens-evening-dress-2030");
    let other = "";
    await inTx(async (tx) => {
      other = await insertProduct(tx, t.women);
    });
    expect(await failure(translate(other, "fa", "پیراهن", "پیراهن-مجلسی-زنانه"))).toEqual({ code: "23505", constraint: "product_translations_slug_unique" });
    // the same slug in another locale is a different URL
    await q("INSERT INTO category_translations (category_id, locale, name, slug) VALUES ($1, 'fa', 'زنانه', 'زنانه'), ($1, 'en', 'Women', 'women')", [t.women]);
    await q("INSERT INTO category_translations (category_id, locale, name, slug) VALUES ($1, 'en', 'Dresses', 'زنانه-dresses')", [t.dresses]);
    // one translation per locale
    expect(await failure(translate(t.dress, "fa", "دیگر", "دیگر"))).toMatchObject({ code: "23505" });
  });

  it("rejects slugs that are not normalized, and malformed locales and names", async () => {
    const t = await apparel();
    const cases: [string, string, string][] = [
      ["fa", "پيراهن", "Arabic yeh instead of Persian ی"],
      ["fa", "كيف", "Arabic kaf instead of Persian ک"],
      ["fa", "می‌خواهم", "zero-width non-joiner"],
      ["fa", "پیراهن مجلسی", "space"],
      ["fa", "پیراهن--مجلسی", "double hyphen"],
      ["fa", "-پیراهن", "leading hyphen"],
      ["fa", "پیراهن-۲", "Persian digit (slugs use ASCII digits)"],
      ["en", "Evening-Dress", "uppercase"],
      ["en", "evening_dress", "underscore"],
      ["en", "x".repeat(161), "too long"],
    ];
    for (const [locale, slug, why] of cases) {
      expect(await failure(translate(t.dress, locale, "name", slug)), why).toEqual({ code: "23514", constraint: "product_translations_slug_format" });
    }
    expect(await failure(translate(t.dress, "FA", "name", "slug"))).toEqual({ code: "23514", constraint: "product_translations_locale_format" });
    expect(await failure(translate(t.dress, "fa", "   ", "slug"))).toEqual({ code: "23514", constraint: "product_translations_name_length" });
  });
});
