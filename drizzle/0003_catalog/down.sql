-- Reverts 0003_catalog. Every DROP TABLE is preceded by a guard that aborts the whole
-- transaction if the table still holds rows, so this only succeeds on an empty catalog.
-- Children are dropped before parents; the triggers go with their tables.

SELECT fc_assert_table_empty('product_image_translations');
DROP TABLE product_image_translations;

SELECT fc_assert_table_empty('product_images');
DROP TABLE product_images;

SELECT fc_assert_table_empty('media_assets');
DROP TABLE media_assets;

SELECT fc_assert_table_empty('variants');
DROP TABLE variants;

SELECT fc_assert_table_empty('product_axis_values');
DROP TABLE product_axis_values;

SELECT fc_assert_table_empty('product_axes');
DROP TABLE product_axes;

SELECT fc_assert_table_empty('product_attribute_value_translations');
DROP TABLE product_attribute_value_translations;

SELECT fc_assert_table_empty('product_attribute_values');
DROP TABLE product_attribute_values;

SELECT fc_assert_table_empty('product_translations');
DROP TABLE product_translations;

-- products and product_categories reference each other (primary category membership).
SELECT fc_assert_table_empty('products');
ALTER TABLE products DROP CONSTRAINT products_primary_category_member_fk;

SELECT fc_assert_table_empty('product_categories');
DROP TABLE product_categories;

DROP TABLE products;

SELECT fc_assert_table_empty('attribute_value_translations');
DROP TABLE attribute_value_translations;

SELECT fc_assert_table_empty('attribute_values');
DROP TABLE attribute_values;

SELECT fc_assert_table_empty('attribute_translations');
DROP TABLE attribute_translations;

SELECT fc_assert_table_empty('attributes');
DROP TABLE attributes;

SELECT fc_assert_table_empty('brand_translations');
DROP TABLE brand_translations;

SELECT fc_assert_table_empty('brands');
DROP TABLE brands;

SELECT fc_assert_table_empty('category_translations');
DROP TABLE category_translations;

SELECT fc_assert_table_empty('categories');
DROP TABLE categories;

DROP FUNCTION catalog_check_product_axes();
DROP FUNCTION catalog_gtin_is_valid(text);
