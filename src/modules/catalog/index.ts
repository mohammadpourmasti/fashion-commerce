import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Catalog — public API.
 *
 * Products, variants (size/colour), categories, collections, attributes, localized content and media references.
 *
 * Other code imports only from "@/modules/catalog". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const catalogModule = {
  name: "catalog",
  summary: "Products, variants (size/colour), categories, collections, attributes, localized content and media references.",
  owns: ["product", "variant", "category", "collection", "attribute", "mediaAsset"],
  dependsOn: [],
} as const satisfies ModuleDescriptor;

// Contracts other modules and the composition root (2E) need, and the catalog's services.
// The domain rules stay internal and are used through the services.
export { catalogAuthorization, CATALOG_PERMISSIONS } from "./domain/permissions";
export { CATALOG_EVENT_TYPES } from "./domain/events";
export type { CatalogIssue, CatalogIssueCode } from "./domain/errors";
export { createCatalog, type Catalog, type CatalogOptions } from "./application/catalog";
export type { CatalogResult } from "./application/support";
export type { CategoryView } from "./application/categories";
export type { BrandView } from "./application/brands";
export type { AttributeView, AttributeValueView } from "./application/attributes";
export type { ProductView, ProductContentInput, ProductUpdateInput } from "./application/products";
export type { AxisView, VariantView, ProductVariantsView } from "./application/variants";
export type { AssetView, AltText, ProductImageInput, ProductImageView, ProductImagesView, ProductImagesResult } from "./application/images";
export type { DescriptiveInput, DescriptiveValue } from "./domain/attributes";
export type { TranslationInput } from "./domain/localization";
