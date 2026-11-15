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

// Contracts other modules and the composition root (2E) need. Application services follow in
// later steps of phase 2C; the domain rules stay internal and are used through them.
export { catalogAuthorization, CATALOG_PERMISSIONS } from "./domain/permissions";
export { CATALOG_EVENT_TYPES } from "./domain/events";
