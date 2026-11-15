import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateUp } from "@/shared/db/migrations";
import { REAL_MIGRATIONS } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";

import { AXIS_KINDS, ATTRIBUTE_USAGES, ATTRIBUTE_VALUE_TYPES, parseAttributeDefinition, parseDecimal } from "./domain/attributes";
import { isValidGtin, parseKey, parseSku, parseSwatch, type KeyKind } from "./domain/codes";
import { parseTranslation } from "./domain/localization";
import { parseAssetMetadata, type AssetInput } from "./domain/media";
import { isSlug, slugify } from "./domain/text";

// Phase 2C Step 2: the domain validators must agree with the database constraints from
// 0003_catalog — anything the domain accepts, the database accepts, and vice versa — so
// application code never hits a constraint error for input the domain approved.
// Every probe runs in a savepoint that is rolled back; nothing persists.

let db: TestDatabase;
let client: PoolClient;
let fixture: { category: string; product: string; number: string };

beforeAll(async () => {
  db = await createTestDatabase();
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS, appRole: db.appRole });
  client = await (db.pool as Pool).connect();
  await client.query(`SET ROLE ${db.appRole}`);
  await client.query("BEGIN");
  const category = (await client.query("INSERT INTO categories (key) VALUES ('probe') RETURNING id")).rows[0].id;
  const product = (await client.query("INSERT INTO products (primary_category_id) VALUES ($1) RETURNING id", [category])).rows[0].id;
  await client.query("INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)", [product, category]);
  const number = (await client.query("INSERT INTO attributes (key, usage, value_type) VALUES ('probe_number', 'descriptive', 'number') RETURNING id")).rows[0].id;
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  fixture = { category, product, number };
});

afterAll(async () => {
  await client?.query("ROLLBACK").catch(() => undefined);
  await client?.query("RESET ROLE").catch(() => undefined);
  client?.release();
  await db?.cleanup();
});

/** True when the statement succeeds; any constraint error counts as a rejection. Always rolled back. */
async function accepts(sql: string, params: unknown[]): Promise<boolean> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(sql, params);
    return true;
  } catch {
    return false;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe");
  }
}

const SLUG_SAMPLES = [
  "پیراهن-مجلسی-زنانه",
  "women",
  "a1",
  "2030",
  "زنانه-dresses",
  "آبی",
  "ءآأؤئ",
  "پيراهن",
  "كيف",
  "می‌خواهم",
  "پیراهن مجلسی",
  "پیراهن--مجلسی",
  "-پیراهن",
  "پیراهن-",
  "پیراهن-۲",
  "مانتو-٣",
  "Evening",
  "evening_dress",
  "ة",
  "ى",
  "ۀ",
  "x".repeat(160),
  "x".repeat(161),
  "",
];
const SLUG_INPUTS = ["پیراهن مجلسی زنانه", "كيف چرمی", "می‌خواهم ۲", "خانهٔ مُد", "Robe d'été", "  --Kids__Shoes!!  ", "ئیلا", "مؤسسه", "إسلامی", Array(30).fill("پیراهن").join(" ")];

describe("domain rules agree with the 0003_catalog constraints", () => {
  it("slugs: isSlug matches the database, and slugify only produces accepted slugs", async () => {
    const generated = SLUG_INPUTS.map((input) => slugify(input)).filter((s): s is string => s !== null);
    expect(generated).toHaveLength(SLUG_INPUTS.length);
    for (const slug of [...SLUG_SAMPLES, ...generated]) {
      const accepted = await accepts("INSERT INTO category_translations (category_id, locale, name, slug) VALUES ($1, 'fa', 'n', $2)", [fixture.category, slug]);
      expect(accepted, JSON.stringify(slug)).toBe(isSlug(slug));
    }
  });

  it("keys: parseKey matches categories, brands, attributes and attribute values", async () => {
    const samples = ["women", "women-dresses", "size_women", "75b", "s", "w", "1women", "-s", "Women", "a".repeat(63), "a".repeat(64), "برند", "a b"];
    const attribute = (await client.query("INSERT INTO attributes (key, usage, value_type, axis_kind) VALUES ('probe_axis', 'variant_axis', 'select', 'size') RETURNING id")).rows[0].id;
    const insert: Record<KeyKind, (key: string) => Promise<boolean>> = {
      category: (key) => accepts("INSERT INTO categories (key) VALUES ($1)", [key]),
      brand: (key) => accepts("INSERT INTO brands (key) VALUES ($1)", [key]),
      attribute: (key) => accepts("INSERT INTO attributes (key, usage, value_type) VALUES ($1, 'descriptive', 'text')", [key]),
      value: (key) => accepts("INSERT INTO attribute_values (attribute_id, key) VALUES ($1, $2)", [attribute, key]),
    };
    for (const kind of ["category", "brand", "attribute", "value"] as const) {
      for (const key of samples) {
        // parseKey lower-cases; compare on what it would store
        const parsed = parseKey(kind, key);
        expect(await insert[kind](key), `${kind} ${key}`).toBe(parsed.ok && parsed.value === key);
      }
    }
  });

  it("SKUs: parseSku output is accepted, and the format check matches the database", async () => {
    const samples = ["DRS-S-RED", "ABC", "AB", "-ABC", "A".repeat(40), "A".repeat(41), "drs-s-red", "AB C", "A_B", "SKU-۱۲۳", "پیراهن"];
    for (const raw of samples) {
      const parsed = parseSku(raw);
      const stored = parsed.ok ? parsed.value : raw;
      const accepted = await accepts("INSERT INTO variants (product_id, axis_count, sku) VALUES ($1, 0, $2)", [fixture.product, stored]);
      expect(accepted, raw).toBe(parsed.ok);
    }
  });

  it("GTIN: isValidGtin matches catalog_gtin_is_valid on fixed and generated codes", async () => {
    const codes = ["96385074", "036000291452", "4006381333931", "10614141000415", "4006381333932", "1234567", "123456789", "40063813339A1", ""];
    // Deterministic pseudo-random codes of every length 7..15; half get a correct check digit.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 400; i += 1) {
      const length = 7 + Math.floor(rand() * 9);
      let body = "";
      for (let d = 0; d < length - 1; d += 1) body += Math.floor(rand() * 10);
      const correct = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((c) => isValidGtin(body + c));
      codes.push(body + (i % 2 === 0 && correct !== undefined ? correct : Math.floor(rand() * 10)));
    }
    const { rows } = await client.query("SELECT code, catalog_gtin_is_valid(code) AS ok FROM unnest($1::text[]) WITH ORDINALITY AS t(code, n) ORDER BY n", [codes]);
    const mismatches = rows.filter((r) => r.ok !== isValidGtin(r.code));
    expect(mismatches).toEqual([]);
    expect(rows.filter((r) => r.ok).length).toBeGreaterThan(100);
  });

  it("attribute definitions: every usage × type × axis kind × unit combination agrees", async () => {
    let n = 0;
    for (const usage of [...ATTRIBUTE_USAGES, "other"]) {
      for (const valueType of [...ATTRIBUTE_VALUE_TYPES, "date"]) {
        for (const axisKind of [...AXIS_KINDS, "pattern", null]) {
          for (const unit of [null, "cm", "CM", "%", "kilograms-and-more"]) {
            n += 1;
            const key = `probe_${n}`;
            const parsed = parseAttributeDefinition({ key, usage, valueType, axisKind, unit });
            const accepted = await accepts("INSERT INTO attributes (key, usage, value_type, axis_kind, unit) VALUES ($1, $2, $3, $4, $5)", [
              key,
              usage,
              valueType,
              axisKind,
              parsed.ok ? parsed.value.unit : unit,
            ]);
            expect(accepted, JSON.stringify({ usage, valueType, axisKind, unit })).toBe(parsed.ok);
          }
        }
      }
    }
  });

  it("decimals: parseDecimal output is stored exactly by numeric(14, 4)", async () => {
    for (const raw of [112.5, "0112.50", "۱۲۰٫۵", "-3", "9999999999.9999", "-9999999999.9999", "0.0001", 0]) {
      const value = parseDecimal(raw);
      expect(value, String(raw)).not.toBeNull();
      await client.query("SAVEPOINT probe");
      try {
        const { rows } = await client.query(
          "INSERT INTO product_attribute_values (product_id, attribute_id, value_type, number_value) VALUES ($1, $2, 'number', $3) RETURNING number_value = $3::numeric AS exact",
          [fixture.product, fixture.number, value],
        );
        expect(rows[0].exact, String(raw)).toBe(true);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT probe");
      }
    }
  });

  it("swatches: parseSwatch output is accepted", async () => {
    const attribute = (await client.query("INSERT INTO attributes (key, usage, value_type, axis_kind) VALUES ('probe_color', 'variant_axis', 'select', 'color') RETURNING id")).rows[0].id;
    for (const raw of ["#c0ffee", "#abc", "#000000"]) {
      const parsed = parseSwatch(raw);
      expect(parsed.ok && (await accepts("INSERT INTO attribute_values (attribute_id, key, swatch_hex) VALUES ($1, 'x', $2)", [attribute, parsed.value]))).toBe(true);
    }
    expect(await accepts("INSERT INTO attribute_values (attribute_id, key, swatch_hex) VALUES ($1, 'x', '#abc')", [attribute])).toBe(false);
  });

  it("asset metadata: parseAssetMetadata matches media_assets", async () => {
    const base: AssetInput = { storageKey: "products/a.webp", contentType: "image/webp", byteSize: 1000, width: 800, height: 1200, sha256: "a".repeat(64) };
    const samples: Partial<AssetInput>[] = [
      {},
      { storageKey: "products/../a.webp" },
      { storageKey: "products//a.webp" },
      { storageKey: "Products/a.webp" },
      { storageKey: "a".repeat(255) },
      { storageKey: "a".repeat(256) },
      { contentType: "image/gif" },
      { contentType: "image/avif" },
      { byteSize: 0 },
      { byteSize: 52_428_800 },
      { byteSize: 52_428_801 },
      { width: 20_000, height: 1 },
      { width: 20_001 },
      { sha256: "A".repeat(64) },
      { sha256: "g".repeat(64) },
    ];
    for (const patch of samples) {
      const input = { ...base, ...patch };
      const parsed = parseAssetMetadata(input);
      const row = parsed.ok ? parsed.value : input;
      const accepted = await accepts("INSERT INTO media_assets (storage_key, content_type, byte_size, width, height, sha256) VALUES ($1, $2, $3, $4, $5, $6)", [
        row.storageKey,
        row.contentType,
        row.byteSize,
        row.width,
        row.height,
        row.sha256,
      ]);
      expect(accepted, JSON.stringify(patch)).toBe(parsed.ok);
    }
  });

  it("translations: parseTranslation output fits the product_translations limits exactly", async () => {
    const samples = [
      { name: "ن".repeat(200), description: "d".repeat(10000), seoTitle: "t".repeat(120), seoDescription: "s".repeat(320) },
      { name: "ن".repeat(201) },
      { name: "n", description: "d".repeat(10001) },
      { name: "n", seoTitle: "t".repeat(121) },
      { name: "n", seoDescription: "s".repeat(321) },
      { name: "   " },
    ];
    for (const [i, sample] of samples.entries()) {
      const parsed = parseTranslation("product", { locale: "fa", slug: `probe-${i}`, ...sample });
      const row = parsed.ok
        ? parsed.value
        : { name: sample.name, slug: `probe-${i}`, description: sample.description ?? "", seoTitle: sample.seoTitle ?? null, seoDescription: sample.seoDescription ?? null };
      const accepted = await accepts(
        "INSERT INTO product_translations (product_id, locale, name, slug, description, seo_title, seo_description) VALUES ($1, 'fa', $2, $3, $4, $5, $6)",
        [fixture.product, row.name, row.slug, row.description, row.seoTitle, row.seoDescription],
      );
      expect(accepted, `sample ${i}`).toBe(parsed.ok);
    }
  });
});
