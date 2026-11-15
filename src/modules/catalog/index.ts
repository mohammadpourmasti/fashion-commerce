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
