-- 0003_catalog: categories, brands, attributes, products, variant axes, variants and image
-- metadata (ADR-018, ADR-024, ADR-025). Structure only: no prices, no stock, no seed rows.
--
-- Integrity is declarative wherever PostgreSQL allows it:
--   * Constant generated columns (e.g. `attribute_usage`, `axis1_position`) let composite
--     foreign keys pin a reference to the right kind of row (an axis attribute, a select
--     attribute, the axis in position 1, ...).
--   * A product's primary category must be one of its product_categories rows (deferred FK,
--     so the product and its first membership are written in the same transaction).
--   * Variants carry up to three positional axis values. Once a variant exists, the product's
--     axis_count and its axes can no longer change (foreign keys), but new values can still
--     be added to the existing axes.
--   * One deferred constraint trigger checks that a product's axes are exactly positions
--     1..axis_count; that rule spans rows and cannot be a plain constraint.
-- No other module may reference these tables except through catalog's schema-refs (2D).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- GTIN-8, GTIN-12 (UPC-A), GTIN-13 (EAN-13) and GTIN-14 with a valid mod-10 check digit.
CREATE FUNCTION catalog_gtin_is_valid(code text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT code ~ '^([0-9]{8}|[0-9]{12,14})$'
     AND (
       SELECT (10 - sum(substr(reverse(code), i, 1)::int * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END) % 10) % 10
         FROM generate_series(2, length(code)) AS i
     ) = substr(reverse(code), 1, 1)::int
$$;

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  parent_id uuid REFERENCES categories (id) ON DELETE RESTRICT,
  key text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_key_unique UNIQUE (key),
  CONSTRAINT categories_key_format CHECK (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT categories_position_nonnegative CHECK (position >= 0),
  CONSTRAINT categories_status_valid CHECK (status IN ('active', 'archived'))
);
CREATE INDEX categories_parent_idx ON categories (parent_id, position);

-- Slugs are normalized per locale: lowercase Latin letters, ASCII digits and Persian letters
-- (Arabic yeh/kaf already mapped to Persian ی/ک, no ZWNJ, no spaces), words joined by '-'.
CREATE TABLE category_translations (
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  locale text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  seo_title text,
  seo_description text,
  PRIMARY KEY (category_id, locale),
  CONSTRAINT category_translations_slug_unique UNIQUE (locale, slug),
  CONSTRAINT category_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT category_translations_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT category_translations_slug_format CHECK (
    char_length(slug) <= 160
    AND slug ~ '^[a-z0-9ء-ؤئ-غفقل-وپچژکگی]+(-[a-z0-9ء-ؤئ-غفقل-وپچژکگی]+)*$'
  ),
  CONSTRAINT category_translations_description_length CHECK (char_length(description) <= 5000),
  CONSTRAINT category_translations_seo_title_length CHECK (seo_title IS NULL OR char_length(seo_title) <= 120),
  CONSTRAINT category_translations_seo_description_length CHECK (seo_description IS NULL OR char_length(seo_description) <= 320)
);

-- ---------------------------------------------------------------------------
-- Brands
-- ---------------------------------------------------------------------------

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_key_unique UNIQUE (key),
  CONSTRAINT brands_key_format CHECK (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  CONSTRAINT brands_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE TABLE brand_translations (
  brand_id uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  locale text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  PRIMARY KEY (brand_id, locale),
  CONSTRAINT brand_translations_slug_unique UNIQUE (locale, slug),
  CONSTRAINT brand_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT brand_translations_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT brand_translations_slug_format CHECK (
    char_length(slug) <= 160
    AND slug ~ '^[a-z0-9ء-ؤئ-غفقل-وپچژکگی]+(-[a-z0-9ء-ؤئ-غفقل-وپچژکگی]+)*$'
  ),
  CONSTRAINT brand_translations_description_length CHECK (char_length(description) <= 5000)
);

-- ---------------------------------------------------------------------------
-- Attributes and values
-- ---------------------------------------------------------------------------

-- usage: 'variant_axis' (size, colour, cup size: always 'select') or 'descriptive'
-- (material, fit, sleeve length: any value_type). Each sizing system is its own attribute.
-- axis_kind ('color', 'size', 'other') is required for axes and absent otherwise; product images
-- can be tied only to values of a 'color' axis.
CREATE TABLE attributes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL,
  usage text NOT NULL,
  value_type text NOT NULL,
  axis_kind text,
  unit text,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attributes_key_unique UNIQUE (key),
  -- Targets for composite foreign keys that pin the attribute's usage and value type.
  CONSTRAINT attributes_id_value_type_unique UNIQUE (id, value_type),
  CONSTRAINT attributes_id_usage_unique UNIQUE (id, usage),
  CONSTRAINT attributes_id_usage_value_type_unique UNIQUE (id, usage, value_type),
  CONSTRAINT attributes_id_axis_kind_unique UNIQUE (id, axis_kind),
  CONSTRAINT attributes_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT attributes_usage_valid CHECK (usage IN ('variant_axis', 'descriptive')),
  CONSTRAINT attributes_value_type_valid CHECK (value_type IN ('select', 'text', 'number', 'boolean')),
  CONSTRAINT attributes_axis_is_select CHECK (usage <> 'variant_axis' OR value_type = 'select'),
  CONSTRAINT attributes_axis_kind_valid CHECK (axis_kind IS NULL OR axis_kind IN ('color', 'size', 'other')),
  CONSTRAINT attributes_axis_kind_for_axes CHECK ((usage = 'variant_axis') = (axis_kind IS NOT NULL)),
  CONSTRAINT attributes_unit_only_for_numbers CHECK (unit IS NULL OR (value_type = 'number' AND unit ~ '^[a-z%]{1,16}$')),
  CONSTRAINT attributes_position_nonnegative CHECK (position >= 0),
  CONSTRAINT attributes_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE TABLE attribute_translations (
  attribute_id uuid NOT NULL REFERENCES attributes (id) ON DELETE RESTRICT,
  locale text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (attribute_id, locale),
  CONSTRAINT attribute_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT attribute_translations_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 120)
);

-- Values exist only for 'select' attributes; the FK also stops an attribute with values from
-- changing its value_type. Values are never deleted (no DELETE grant); they are archived.
CREATE TABLE attribute_values (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  attribute_id uuid NOT NULL,
  value_type text GENERATED ALWAYS AS ('select') STORED,
  key text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  swatch_hex text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribute_values_key_unique UNIQUE (attribute_id, key),
  CONSTRAINT attribute_values_attribute_id_unique UNIQUE (attribute_id, id),
  CONSTRAINT attribute_values_select_attribute_fk FOREIGN KEY (attribute_id, value_type)
    REFERENCES attributes (id, value_type) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT attribute_values_key_format CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT attribute_values_position_nonnegative CHECK (position >= 0),
  CONSTRAINT attribute_values_swatch_format CHECK (swatch_hex IS NULL OR swatch_hex ~ '^#[0-9A-F]{6}$'),
  CONSTRAINT attribute_values_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE TABLE attribute_value_translations (
  value_id uuid NOT NULL REFERENCES attribute_values (id) ON DELETE RESTRICT,
  locale text NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (value_id, locale),
  CONSTRAINT attribute_value_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT attribute_value_translations_label_length CHECK (char_length(btrim(label)) BETWEEN 1 AND 120)
);

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

-- Products are never deleted (no DELETE grant): draft -> active -> archived.
-- version supports optimistic concurrency in the application layer.
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  brand_id uuid REFERENCES brands (id) ON DELETE RESTRICT,
  primary_category_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  axis_count smallint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  archived_at timestamptz,
  -- Target for variants (product_id, axis_count): axis_count is frozen once variants exist.
  CONSTRAINT products_id_axis_count_unique UNIQUE (id, axis_count),
  CONSTRAINT products_status_valid CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT products_axis_count_range CHECK (axis_count BETWEEN 0 AND 3),
  CONSTRAINT products_version_positive CHECK (version >= 1),
  CONSTRAINT products_active_published CHECK (status <> 'active' OR published_at IS NOT NULL),
  CONSTRAINT products_archived_consistent CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX products_category_status_idx ON products (primary_category_id, status);
CREATE INDEX products_brand_idx ON products (brand_id) WHERE brand_id IS NOT NULL;

CREATE TABLE product_translations (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  locale text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  seo_title text,
  seo_description text,
  PRIMARY KEY (product_id, locale),
  CONSTRAINT product_translations_slug_unique UNIQUE (locale, slug),
  CONSTRAINT product_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT product_translations_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT product_translations_slug_format CHECK (
    char_length(slug) <= 160
    AND slug ~ '^[a-z0-9ء-ؤئ-غفقل-وپچژکگی]+(-[a-z0-9ء-ؤئ-غفقل-وپچژکگی]+)*$'
  ),
  CONSTRAINT product_translations_description_length CHECK (char_length(description) <= 10000),
  CONSTRAINT product_translations_seo_title_length CHECK (seo_title IS NULL OR char_length(seo_title) <= 120),
  CONSTRAINT product_translations_seo_description_length CHECK (seo_description IS NULL OR char_length(seo_description) <= 320)
);

CREATE TABLE product_categories (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_category_idx ON product_categories (category_id, product_id);

-- The primary category is always one of the product's categories. Deferred, so a product and
-- its first membership can be inserted in either order within one transaction.
ALTER TABLE products ADD CONSTRAINT products_primary_category_member_fk
  FOREIGN KEY (id, primary_category_id) REFERENCES product_categories (product_id, category_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Descriptive attribute values, typed by the attribute: select (one row per chosen value),
-- number or boolean (one row per product and attribute). Text values are localized in
-- product_attribute_value_translations.
CREATE TABLE product_attribute_values (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  attribute_id uuid NOT NULL,
  attribute_usage text GENERATED ALWAYS AS ('descriptive') STORED,
  value_type text NOT NULL,
  value_id uuid,
  number_value numeric(14, 4),
  boolean_value boolean,
  CONSTRAINT product_attribute_values_unique UNIQUE NULLS NOT DISTINCT (product_id, attribute_id, value_id),
  CONSTRAINT product_attribute_values_id_value_type_unique UNIQUE (id, value_type),
  CONSTRAINT product_attribute_values_attribute_fk FOREIGN KEY (attribute_id, attribute_usage, value_type)
    REFERENCES attributes (id, usage, value_type) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_attribute_values_value_fk FOREIGN KEY (attribute_id, value_id)
    REFERENCES attribute_values (attribute_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_attribute_values_typed CHECK (
    (value_type = 'select') = (value_id IS NOT NULL)
    AND (value_type = 'number') = (number_value IS NOT NULL)
    AND (value_type = 'boolean') = (boolean_value IS NOT NULL)
  ),
  CONSTRAINT product_attribute_values_number_finite CHECK (number_value IS NULL OR number_value <> 'NaN'::numeric)
);
CREATE INDEX product_attribute_values_filter_idx ON product_attribute_values (attribute_id, value_id);

CREATE TABLE product_attribute_value_translations (
  product_attribute_value_id uuid NOT NULL,
  value_type text GENERATED ALWAYS AS ('text') STORED,
  locale text NOT NULL,
  text_value text NOT NULL,
  PRIMARY KEY (product_attribute_value_id, locale),
  CONSTRAINT product_attribute_value_translations_text_fk FOREIGN KEY (product_attribute_value_id, value_type)
    REFERENCES product_attribute_values (id, value_type) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT product_attribute_value_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT product_attribute_value_translations_text_length CHECK (char_length(btrim(text_value)) BETWEEN 1 AND 500)
);

-- ---------------------------------------------------------------------------
-- Variant axes and variants
-- ---------------------------------------------------------------------------

-- Positions 1..products.axis_count, each a distinct 'variant_axis' attribute.
CREATE TABLE product_axes (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  position smallint NOT NULL,
  attribute_id uuid NOT NULL,
  attribute_usage text GENERATED ALWAYS AS ('variant_axis') STORED,
  PRIMARY KEY (product_id, position),
  CONSTRAINT product_axes_attribute_unique UNIQUE (product_id, attribute_id),
  CONSTRAINT product_axes_target_unique UNIQUE (product_id, attribute_id, position),
  CONSTRAINT product_axes_attribute_fk FOREIGN KEY (attribute_id, attribute_usage)
    REFERENCES attributes (id, usage) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_axes_position_range CHECK (position BETWEEN 1 AND 3)
);
CREATE INDEX product_axes_attribute_idx ON product_axes (attribute_id);

-- The values a product offers on each axis. A value belongs to exactly one attribute, and a
-- product uses an attribute on at most one axis, so (product_id, value_id) is unique.
CREATE TABLE product_axis_values (
  product_id uuid NOT NULL,
  value_id uuid NOT NULL,
  attribute_id uuid NOT NULL,
  position smallint NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, value_id),
  CONSTRAINT product_axis_values_variant_target_unique UNIQUE (product_id, position, value_id),
  CONSTRAINT product_axis_values_image_target_unique UNIQUE (product_id, value_id, attribute_id),
  CONSTRAINT product_axis_values_axis_fk FOREIGN KEY (product_id, attribute_id, position)
    REFERENCES product_axes (product_id, attribute_id, position) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_axis_values_value_fk FOREIGN KEY (attribute_id, value_id)
    REFERENCES attribute_values (attribute_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_axis_values_sort_order_nonnegative CHECK (sort_order >= 0)
);
CREATE INDEX product_axis_values_value_idx ON product_axis_values (attribute_id, value_id);

-- Variants are never deleted (no DELETE grant): active -> discontinued.
CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  product_id uuid NOT NULL,
  axis_count smallint NOT NULL,
  sku text NOT NULL,
  barcode text,
  status text NOT NULL DEFAULT 'active',
  position integer NOT NULL DEFAULT 0,
  value1 uuid,
  value2 uuid,
  value3 uuid,
  axis1_position smallint GENERATED ALWAYS AS (1) STORED,
  axis2_position smallint GENERATED ALWAYS AS (2) STORED,
  axis3_position smallint GENERATED ALWAYS AS (3) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  discontinued_at timestamptz,
  CONSTRAINT variants_sku_unique UNIQUE (sku),
  CONSTRAINT variants_barcode_unique UNIQUE (barcode),
  CONSTRAINT variants_product_id_unique UNIQUE (product_id, id),
  -- One variant per combination; a product without axes has exactly one variant.
  CONSTRAINT variants_combination_unique UNIQUE NULLS NOT DISTINCT (product_id, value1, value2, value3),
  CONSTRAINT variants_product_axis_count_fk FOREIGN KEY (product_id, axis_count)
    REFERENCES products (id, axis_count) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT variants_value1_fk FOREIGN KEY (product_id, axis1_position, value1)
    REFERENCES product_axis_values (product_id, position, value_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT variants_value2_fk FOREIGN KEY (product_id, axis2_position, value2)
    REFERENCES product_axis_values (product_id, position, value_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT variants_value3_fk FOREIGN KEY (product_id, axis3_position, value3)
    REFERENCES product_axis_values (product_id, position, value_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT variants_values_match_axis_count CHECK (
    (value1 IS NOT NULL) = (axis_count >= 1)
    AND (value2 IS NOT NULL) = (axis_count >= 2)
    AND (value3 IS NOT NULL) = (axis_count >= 3)
  ),
  CONSTRAINT variants_sku_format CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  CONSTRAINT variants_barcode_gtin CHECK (barcode IS NULL OR catalog_gtin_is_valid(barcode)),
  CONSTRAINT variants_status_valid CHECK (status IN ('active', 'discontinued')),
  CONSTRAINT variants_discontinued_consistent CHECK ((status = 'discontinued') = (discontinued_at IS NOT NULL)),
  CONSTRAINT variants_position_nonnegative CHECK (position >= 0)
);

-- A product's axes must be exactly positions 1..axis_count. Checked at commit, so a product,
-- its axis_count and its axes can be written in any order inside one transaction.
CREATE FUNCTION catalog_check_product_axes() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ids uuid[];
  pid uuid;
  expected smallint;
  actual_count integer;
  actual_max integer;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    ids := ARRAY[NEW.product_id];
  ELSIF TG_OP = 'DELETE' THEN
    ids := ARRAY[OLD.product_id];
  ELSE
    ids := ARRAY[OLD.product_id, NEW.product_id];
  END IF;
  FOREACH pid IN ARRAY ids LOOP
    SELECT axis_count INTO expected FROM products WHERE id = pid;
    CONTINUE WHEN NOT FOUND;
    SELECT count(*), coalesce(max(position), 0) INTO actual_count, actual_max
      FROM product_axes WHERE product_id = pid;
    IF actual_count <> expected OR actual_max <> expected THEN
      RAISE EXCEPTION 'product % declares % variant axes but has % (positions must be 1..%)',
        pid, expected, actual_count, expected
        USING ERRCODE = 'check_violation', CONSTRAINT = 'product_axes_match_axis_count';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER products_axes_match_axis_count
  AFTER INSERT OR UPDATE OF axis_count ON products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog_check_product_axes();

CREATE CONSTRAINT TRIGGER product_axes_match_axis_count
  AFTER INSERT OR UPDATE OR DELETE ON product_axes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog_check_product_axes();

-- ---------------------------------------------------------------------------
-- Media (metadata only; storage and upload come later)
-- ---------------------------------------------------------------------------

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_assets_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT media_assets_sha256_unique UNIQUE (sha256),
  CONSTRAINT media_assets_storage_key_format CHECK (
    storage_key ~ '^[a-z0-9][a-z0-9/_.-]{0,254}$' AND strpos(storage_key, '..') = 0 AND strpos(storage_key, '//') = 0
  ),
  CONSTRAINT media_assets_content_type_valid CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  CONSTRAINT media_assets_byte_size_range CHECK (byte_size BETWEEN 1 AND 52428800),
  CONSTRAINT media_assets_dimensions_range CHECK (width BETWEEN 1 AND 20000 AND height BETWEEN 1 AND 20000),
  CONSTRAINT media_assets_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

-- view: what the image shows (front, back, detail, gallery). color_value_id optionally ties an
-- image to one of the product's own axis values, and only on an axis whose attribute is a colour:
-- the pair (color_value_id, color_attribute_id) must be offered by this product, and the attribute
-- must have axis_kind = 'color'. A size or any other axis value is rejected.
CREATE TABLE product_images (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES media_assets (id) ON DELETE RESTRICT,
  view text NOT NULL,
  color_value_id uuid,
  color_attribute_id uuid,
  color_axis_kind text GENERATED ALWAYS AS ('color') STORED,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_images_asset_unique UNIQUE (product_id, asset_id),
  -- Deferred so images can be reordered (positions swapped) in one transaction.
  CONSTRAINT product_images_position_unique UNIQUE (product_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT product_images_color_value_fk FOREIGN KEY (product_id, color_value_id, color_attribute_id)
    REFERENCES product_axis_values (product_id, value_id, attribute_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_images_color_attribute_fk FOREIGN KEY (color_attribute_id, color_axis_kind)
    REFERENCES attributes (id, axis_kind) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_images_color_pair CHECK ((color_value_id IS NULL) = (color_attribute_id IS NULL)),
  CONSTRAINT product_images_view_valid CHECK (view IN ('front', 'back', 'detail', 'gallery')),
  CONSTRAINT product_images_position_nonnegative CHECK (position >= 0)
);
CREATE INDEX product_images_asset_idx ON product_images (asset_id);

CREATE TABLE product_image_translations (
  image_id uuid NOT NULL REFERENCES product_images (id) ON DELETE CASCADE,
  locale text NOT NULL,
  alt_text text NOT NULL,
  PRIMARY KEY (image_id, locale),
  CONSTRAINT product_image_translations_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  CONSTRAINT product_image_translations_alt_text_length CHECK (char_length(btrim(alt_text)) BETWEEN 1 AND 250)
);

-- ---------------------------------------------------------------------------
-- Grants (least privilege). No DELETE on master rows: products, variants, attribute values,
-- attributes, categories, brands and media assets are archived or discontinued instead.
-- ---------------------------------------------------------------------------

SELECT fc_app_grant('categories', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('category_translations', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('brands', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('brand_translations', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('attributes', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('attribute_translations', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('attribute_values', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('attribute_value_translations', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('products', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('product_translations', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('product_categories', 'SELECT, INSERT, DELETE');
SELECT fc_app_grant('product_attribute_values', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('product_attribute_value_translations', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('product_axes', 'SELECT, INSERT, DELETE');
SELECT fc_app_grant('product_axis_values', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('variants', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('media_assets', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('product_images', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('product_image_translations', 'SELECT, INSERT, UPDATE, DELETE');
