import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

// Table definitions for the catalog. drizzle/0003_catalog is the source of truth for the
// database; an integration test compares this file with the migrated schema (columns,
// nullability, CHECK, UNIQUE and FOREIGN KEY names and columns, indexes).
// Keep this file free of `@/` imports: drizzle-kit loads it outside Next.js.
//
// Not expressible in Drizzle 0.45 and therefore only in the SQL (and covered by tests):
//   * DEFERRABLE INITIALLY DEFERRED on products_primary_category_member_fk and
//     product_images_position_unique;
//   * the deferred constraint triggers that run catalog_check_product_axes();
//   * catalog_gtin_is_valid(), used by variants_barcode_gtin.
// products and product_categories reference each other, so their extra-config callbacks carry
// an explicit return type to break TypeScript's circular inference.
// Foreign keys are all named explicitly; inline REFERENCES in the SQL use PostgreSQL's
// default `<table>_<column>_fkey` names, mirrored here.

const tz = (name: string) => timestamp(name, { withTimezone: true });

const LOCALE_FORMAT = "'^[a-z]{2}$'";
// Lowercase Latin, ASCII digits and normalized Persian letters, words joined by single hyphens.
const SLUG_CHARS = "a-z0-9\\u0621-\\u0624\\u0626-\\u063A\\u0641\\u0642\\u0644-\\u0648\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC";
const slugCheck = (column: unknown) =>
  sql`char_length(${column}) <= 160 AND ${column} ~ ${sql.raw(`'^[${SLUG_CHARS}]+(-[${SLUG_CHARS}]+)*$'`)}`;
const localeCheck = (column: unknown) => sql`${column} ~ ${sql.raw(LOCALE_FORMAT)}`;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    parentId: uuid("parent_id"),
    key: text("key").notNull(),
    position: integer("position").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "categories_parent_id_fkey", columns: [t.parentId], foreignColumns: [t.id] }).onDelete("restrict"),
    unique("categories_key_unique").on(t.key),
    check("categories_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_-]{1,62}$'`),
    check("categories_not_own_parent", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check("categories_position_nonnegative", sql`${t.position} >= 0`),
    check("categories_status_valid", sql`${t.status} IN ('active', 'archived')`),
    index("categories_parent_idx").on(t.parentId, t.position),
  ],
);

export const categoryTranslations = pgTable(
  "category_translations",
  {
    categoryId: uuid("category_id").notNull(),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.locale] }),
    foreignKey({ name: "category_translations_category_id_fkey", columns: [t.categoryId], foreignColumns: [categories.id] }).onDelete("restrict"),
    unique("category_translations_slug_unique").on(t.locale, t.slug),
    check("category_translations_locale_format", localeCheck(t.locale)),
    check("category_translations_name_length", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check("category_translations_slug_format", slugCheck(t.slug)),
    check("category_translations_description_length", sql`char_length(${t.description}) <= 5000`),
    check("category_translations_seo_title_length", sql`${t.seoTitle} IS NULL OR char_length(${t.seoTitle}) <= 120`),
    check("category_translations_seo_description_length", sql`${t.seoDescription} IS NULL OR char_length(${t.seoDescription}) <= 320`),
  ],
);

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    key: text("key").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("brands_key_unique").on(t.key),
    check("brands_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_-]{1,62}$'`),
    check("brands_status_valid", sql`${t.status} IN ('active', 'archived')`),
  ],
);

export const brandTranslations = pgTable(
  "brand_translations",
  {
    brandId: uuid("brand_id").notNull(),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.brandId, t.locale] }),
    foreignKey({ name: "brand_translations_brand_id_fkey", columns: [t.brandId], foreignColumns: [brands.id] }).onDelete("restrict"),
    unique("brand_translations_slug_unique").on(t.locale, t.slug),
    check("brand_translations_locale_format", localeCheck(t.locale)),
    check("brand_translations_name_length", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check("brand_translations_slug_format", slugCheck(t.slug)),
    check("brand_translations_description_length", sql`char_length(${t.description}) <= 5000`),
  ],
);

// ---------------------------------------------------------------------------
// Attributes and values
// ---------------------------------------------------------------------------

export const ATTRIBUTE_USAGES = ["variant_axis", "descriptive"] as const;
export const ATTRIBUTE_VALUE_TYPES = ["select", "text", "number", "boolean"] as const;
/** Required for variant axes; product images can be tied only to values of a "color" axis. */
export const AXIS_KINDS = ["color", "size", "other"] as const;

export const attributes = pgTable(
  "attributes",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    key: text("key").notNull(),
    usage: text("usage", { enum: ATTRIBUTE_USAGES }).notNull(),
    valueType: text("value_type", { enum: ATTRIBUTE_VALUE_TYPES }).notNull(),
    axisKind: text("axis_kind", { enum: AXIS_KINDS }),
    unit: text("unit"),
    position: integer("position").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("attributes_key_unique").on(t.key),
    unique("attributes_id_value_type_unique").on(t.id, t.valueType),
    unique("attributes_id_usage_unique").on(t.id, t.usage),
    unique("attributes_id_usage_value_type_unique").on(t.id, t.usage, t.valueType),
    unique("attributes_id_axis_kind_unique").on(t.id, t.axisKind),
    check("attributes_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]{1,62}$'`),
    check("attributes_usage_valid", sql`${t.usage} IN ('variant_axis', 'descriptive')`),
    check("attributes_value_type_valid", sql`${t.valueType} IN ('select', 'text', 'number', 'boolean')`),
    check("attributes_axis_is_select", sql`${t.usage} <> 'variant_axis' OR ${t.valueType} = 'select'`),
    check("attributes_axis_kind_valid", sql`${t.axisKind} IS NULL OR ${t.axisKind} IN ('color', 'size', 'other')`),
    check("attributes_axis_kind_for_axes", sql`(${t.usage} = 'variant_axis') = (${t.axisKind} IS NOT NULL)`),
    check("attributes_unit_only_for_numbers", sql`${t.unit} IS NULL OR (${t.valueType} = 'number' AND ${t.unit} ~ '^[a-z%]{1,16}$')`),
    check("attributes_position_nonnegative", sql`${t.position} >= 0`),
    check("attributes_status_valid", sql`${t.status} IN ('active', 'archived')`),
  ],
);

export const attributeTranslations = pgTable(
  "attribute_translations",
  {
    attributeId: uuid("attribute_id").notNull(),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attributeId, t.locale] }),
    foreignKey({ name: "attribute_translations_attribute_id_fkey", columns: [t.attributeId], foreignColumns: [attributes.id] }).onDelete("restrict"),
    check("attribute_translations_locale_format", localeCheck(t.locale)),
    check("attribute_translations_name_length", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
  ],
);

export const attributeValues = pgTable(
  "attribute_values",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    attributeId: uuid("attribute_id").notNull(),
    valueType: text("value_type").generatedAlwaysAs(sql`'select'`),
    key: text("key").notNull(),
    position: integer("position").notNull().default(0),
    swatchHex: text("swatch_hex"),
    status: text("status").notNull().default("active"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("attribute_values_key_unique").on(t.attributeId, t.key),
    unique("attribute_values_attribute_id_unique").on(t.attributeId, t.id),
    foreignKey({
      name: "attribute_values_select_attribute_fk",
      columns: [t.attributeId, t.valueType],
      foreignColumns: [attributes.id, attributes.valueType],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("attribute_values_key_format", sql`${t.key} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check("attribute_values_position_nonnegative", sql`${t.position} >= 0`),
    check("attribute_values_swatch_format", sql`${t.swatchHex} IS NULL OR ${t.swatchHex} ~ '^#[0-9A-F]{6}$'`),
    check("attribute_values_status_valid", sql`${t.status} IN ('active', 'archived')`),
  ],
);

export const attributeValueTranslations = pgTable(
  "attribute_value_translations",
  {
    valueId: uuid("value_id").notNull(),
    locale: text("locale").notNull(),
    label: text("label").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.valueId, t.locale] }),
    foreignKey({ name: "attribute_value_translations_value_id_fkey", columns: [t.valueId], foreignColumns: [attributeValues.id] }).onDelete("restrict"),
    check("attribute_value_translations_locale_format", localeCheck(t.locale)),
    check("attribute_value_translations_label_length", sql`char_length(btrim(${t.label})) BETWEEN 1 AND 120`),
  ],
);

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    brandId: uuid("brand_id"),
    primaryCategoryId: uuid("primary_category_id").notNull(),
    status: text("status", { enum: PRODUCT_STATUSES }).notNull().default("draft"),
    axisCount: smallint("axis_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    publishedAt: tz("published_at"),
    archivedAt: tz("archived_at"),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({ name: "products_brand_id_fkey", columns: [t.brandId], foreignColumns: [brands.id] }).onDelete("restrict"),
    // DEFERRABLE INITIALLY DEFERRED in the SQL (see the header comment).
    foreignKey({
      name: "products_primary_category_member_fk",
      columns: [t.id, t.primaryCategoryId],
      foreignColumns: [productCategories.productId, productCategories.categoryId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("products_id_axis_count_unique").on(t.id, t.axisCount),
    check("products_status_valid", sql`${t.status} IN ('draft', 'active', 'archived')`),
    check("products_axis_count_range", sql`${t.axisCount} BETWEEN 0 AND 3`),
    check("products_version_positive", sql`${t.version} >= 1`),
    check("products_active_published", sql`${t.status} <> 'active' OR ${t.publishedAt} IS NOT NULL`),
    check("products_archived_consistent", sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`),
    index("products_category_status_idx").on(t.primaryCategoryId, t.status),
    index("products_brand_idx").on(t.brandId).where(sql`${t.brandId} IS NOT NULL`),
  ],
);

export const productTranslations = pgTable(
  "product_translations",
  {
    productId: uuid("product_id").notNull(),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.locale] }),
    foreignKey({ name: "product_translations_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] }).onDelete("restrict"),
    unique("product_translations_slug_unique").on(t.locale, t.slug),
    check("product_translations_locale_format", localeCheck(t.locale)),
    check("product_translations_name_length", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 200`),
    check("product_translations_slug_format", slugCheck(t.slug)),
    check("product_translations_description_length", sql`char_length(${t.description}) <= 10000`),
    check("product_translations_seo_title_length", sql`${t.seoTitle} IS NULL OR char_length(${t.seoTitle}) <= 120`),
    check("product_translations_seo_description_length", sql`${t.seoDescription} IS NULL OR char_length(${t.seoDescription}) <= 320`),
  ],
);

export const productCategories = pgTable(
  "product_categories",
  {
    productId: uuid("product_id").notNull(),
    categoryId: uuid("category_id").notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.productId, t.categoryId] }),
    foreignKey({ name: "product_categories_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] }).onDelete("restrict"),
    foreignKey({ name: "product_categories_category_id_fkey", columns: [t.categoryId], foreignColumns: [categories.id] }).onDelete("restrict"),
    index("product_categories_category_idx").on(t.categoryId, t.productId),
  ],
);

export const productAttributeValues = pgTable(
  "product_attribute_values",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    productId: uuid("product_id").notNull(),
    attributeId: uuid("attribute_id").notNull(),
    attributeUsage: text("attribute_usage").generatedAlwaysAs(sql`'descriptive'`),
    valueType: text("value_type", { enum: ATTRIBUTE_VALUE_TYPES }).notNull(),
    valueId: uuid("value_id"),
    numberValue: numeric("number_value", { precision: 14, scale: 4 }),
    booleanValue: boolean("boolean_value"),
  },
  (t) => [
    foreignKey({ name: "product_attribute_values_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] }).onDelete("restrict"),
    unique("product_attribute_values_unique").on(t.productId, t.attributeId, t.valueId).nullsNotDistinct(),
    unique("product_attribute_values_id_value_type_unique").on(t.id, t.valueType),
    foreignKey({
      name: "product_attribute_values_attribute_fk",
      columns: [t.attributeId, t.attributeUsage, t.valueType],
      foreignColumns: [attributes.id, attributes.usage, attributes.valueType],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "product_attribute_values_value_fk",
      columns: [t.attributeId, t.valueId],
      foreignColumns: [attributeValues.attributeId, attributeValues.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "product_attribute_values_typed",
      sql`(${t.valueType} = 'select') = (${t.valueId} IS NOT NULL) AND (${t.valueType} = 'number') = (${t.numberValue} IS NOT NULL) AND (${t.valueType} = 'boolean') = (${t.booleanValue} IS NOT NULL)`,
    ),
    check("product_attribute_values_number_finite", sql`${t.numberValue} IS NULL OR ${t.numberValue} <> 'NaN'::numeric`),
    index("product_attribute_values_filter_idx").on(t.attributeId, t.valueId),
  ],
);

export const productAttributeValueTranslations = pgTable(
  "product_attribute_value_translations",
  {
    productAttributeValueId: uuid("product_attribute_value_id").notNull(),
    valueType: text("value_type").generatedAlwaysAs(sql`'text'`),
    locale: text("locale").notNull(),
    textValue: text("text_value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productAttributeValueId, t.locale] }),
    foreignKey({
      name: "product_attribute_value_translations_text_fk",
      columns: [t.productAttributeValueId, t.valueType],
      foreignColumns: [productAttributeValues.id, productAttributeValues.valueType],
    })
      .onDelete("cascade")
      .onUpdate("restrict"),
    check("product_attribute_value_translations_locale_format", localeCheck(t.locale)),
    check("product_attribute_value_translations_text_length", sql`char_length(btrim(${t.textValue})) BETWEEN 1 AND 500`),
  ],
);

// ---------------------------------------------------------------------------
// Variant axes and variants
// ---------------------------------------------------------------------------

export const MAX_VARIANT_AXES = 3;

export const productAxes = pgTable(
  "product_axes",
  {
    productId: uuid("product_id").notNull(),
    position: smallint("position").notNull(),
    attributeId: uuid("attribute_id").notNull(),
    attributeUsage: text("attribute_usage").generatedAlwaysAs(sql`'variant_axis'`),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.position] }),
    foreignKey({ name: "product_axes_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] }).onDelete("restrict"),
    unique("product_axes_attribute_unique").on(t.productId, t.attributeId),
    unique("product_axes_target_unique").on(t.productId, t.attributeId, t.position),
    foreignKey({
      name: "product_axes_attribute_fk",
      columns: [t.attributeId, t.attributeUsage],
      foreignColumns: [attributes.id, attributes.usage],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("product_axes_position_range", sql`${t.position} BETWEEN 1 AND 3`),
    index("product_axes_attribute_idx").on(t.attributeId),
  ],
);

export const productAxisValues = pgTable(
  "product_axis_values",
  {
    productId: uuid("product_id").notNull(),
    valueId: uuid("value_id").notNull(),
    attributeId: uuid("attribute_id").notNull(),
    position: smallint("position").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.valueId] }),
    unique("product_axis_values_variant_target_unique").on(t.productId, t.position, t.valueId),
    unique("product_axis_values_image_target_unique").on(t.productId, t.valueId, t.attributeId),
    foreignKey({
      name: "product_axis_values_axis_fk",
      columns: [t.productId, t.attributeId, t.position],
      foreignColumns: [productAxes.productId, productAxes.attributeId, productAxes.position],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "product_axis_values_value_fk",
      columns: [t.attributeId, t.valueId],
      foreignColumns: [attributeValues.attributeId, attributeValues.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("product_axis_values_sort_order_nonnegative", sql`${t.sortOrder} >= 0`),
    index("product_axis_values_value_idx").on(t.attributeId, t.valueId),
  ],
);

export const VARIANT_STATUSES = ["active", "discontinued"] as const;

export const variants = pgTable(
  "variants",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    productId: uuid("product_id").notNull(),
    axisCount: smallint("axis_count").notNull(),
    sku: text("sku").notNull(),
    barcode: text("barcode"),
    status: text("status", { enum: VARIANT_STATUSES }).notNull().default("active"),
    position: integer("position").notNull().default(0),
    value1: uuid("value1"),
    value2: uuid("value2"),
    value3: uuid("value3"),
    axis1Position: smallint("axis1_position").generatedAlwaysAs(sql`1`),
    axis2Position: smallint("axis2_position").generatedAlwaysAs(sql`2`),
    axis3Position: smallint("axis3_position").generatedAlwaysAs(sql`3`),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    discontinuedAt: tz("discontinued_at"),
  },
  (t) => [
    unique("variants_sku_unique").on(t.sku),
    unique("variants_barcode_unique").on(t.barcode),
    unique("variants_product_id_unique").on(t.productId, t.id),
    unique("variants_combination_unique").on(t.productId, t.value1, t.value2, t.value3).nullsNotDistinct(),
    foreignKey({
      name: "variants_product_axis_count_fk",
      columns: [t.productId, t.axisCount],
      foreignColumns: [products.id, products.axisCount],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "variants_value1_fk",
      columns: [t.productId, t.axis1Position, t.value1],
      foreignColumns: [productAxisValues.productId, productAxisValues.position, productAxisValues.valueId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "variants_value2_fk",
      columns: [t.productId, t.axis2Position, t.value2],
      foreignColumns: [productAxisValues.productId, productAxisValues.position, productAxisValues.valueId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "variants_value3_fk",
      columns: [t.productId, t.axis3Position, t.value3],
      foreignColumns: [productAxisValues.productId, productAxisValues.position, productAxisValues.valueId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "variants_values_match_axis_count",
      sql`(${t.value1} IS NOT NULL) = (${t.axisCount} >= 1) AND (${t.value2} IS NOT NULL) = (${t.axisCount} >= 2) AND (${t.value3} IS NOT NULL) = (${t.axisCount} >= 3)`,
    ),
    check("variants_sku_format", sql`${t.sku} ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'`),
    check("variants_barcode_gtin", sql`${t.barcode} IS NULL OR catalog_gtin_is_valid(${t.barcode})`),
    check("variants_status_valid", sql`${t.status} IN ('active', 'discontinued')`),
    check("variants_discontinued_consistent", sql`(${t.status} = 'discontinued') = (${t.discontinuedAt} IS NOT NULL)`),
    check("variants_position_nonnegative", sql`${t.position} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Media (metadata only)
// ---------------------------------------------------------------------------

export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export const PRODUCT_IMAGE_VIEWS = ["front", "back", "detail", "gallery"] as const;

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type", { enum: MEDIA_CONTENT_TYPES }).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("media_assets_storage_key_unique").on(t.storageKey),
    unique("media_assets_sha256_unique").on(t.sha256),
    check(
      "media_assets_storage_key_format",
      sql`${t.storageKey} ~ '^[a-z0-9][a-z0-9/_.-]{0,254}$' AND strpos(${t.storageKey}, '..') = 0 AND strpos(${t.storageKey}, '//') = 0`,
    ),
    check("media_assets_content_type_valid", sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')`),
    check("media_assets_byte_size_range", sql`${t.byteSize} BETWEEN 1 AND 52428800`),
    check("media_assets_dimensions_range", sql`${t.width} BETWEEN 1 AND 20000 AND ${t.height} BETWEEN 1 AND 20000`),
    check("media_assets_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    productId: uuid("product_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    view: text("view", { enum: PRODUCT_IMAGE_VIEWS }).notNull(),
    colorValueId: uuid("color_value_id"),
    colorAttributeId: uuid("color_attribute_id"),
    colorAxisKind: text("color_axis_kind").generatedAlwaysAs(sql`'color'`),
    position: integer("position").notNull().default(0),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "product_images_product_id_fkey", columns: [t.productId], foreignColumns: [products.id] }).onDelete("restrict"),
    foreignKey({ name: "product_images_asset_id_fkey", columns: [t.assetId], foreignColumns: [mediaAssets.id] }).onDelete("restrict"),
    unique("product_images_asset_unique").on(t.productId, t.assetId),
    // DEFERRABLE INITIALLY DEFERRED in the SQL (see the header comment).
    unique("product_images_position_unique").on(t.productId, t.position),
    // A colour link must be a value this product offers on an axis whose attribute is a colour.
    foreignKey({
      name: "product_images_color_value_fk",
      columns: [t.productId, t.colorValueId, t.colorAttributeId],
      foreignColumns: [productAxisValues.productId, productAxisValues.valueId, productAxisValues.attributeId],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      name: "product_images_color_attribute_fk",
      columns: [t.colorAttributeId, t.colorAxisKind],
      foreignColumns: [attributes.id, attributes.axisKind],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("product_images_color_pair", sql`(${t.colorValueId} IS NULL) = (${t.colorAttributeId} IS NULL)`),
    check("product_images_view_valid", sql`${t.view} IN ('front', 'back', 'detail', 'gallery')`),
    check("product_images_position_nonnegative", sql`${t.position} >= 0`),
    index("product_images_asset_idx").on(t.assetId),
  ],
);

export const productImageTranslations = pgTable(
  "product_image_translations",
  {
    imageId: uuid("image_id").notNull(),
    locale: text("locale").notNull(),
    altText: text("alt_text").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.imageId, t.locale] }),
    foreignKey({ name: "product_image_translations_image_id_fkey", columns: [t.imageId], foreignColumns: [productImages.id] }).onDelete("cascade"),
    check("product_image_translations_locale_format", localeCheck(t.locale)),
    check("product_image_translations_alt_text_length", sql`char_length(btrim(${t.altText})) BETWEEN 1 AND 250`),
  ],
);
