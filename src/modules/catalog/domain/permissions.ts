import type { AuthorizationCatalog, Permission } from "@/shared/kernel/authorization";

/**
 * Permissions owned by the catalog module (ADR-016). Catalog only declares them; the
 * composition root merges this catalog with the others and identity stores it (2E).
 * Public storefront reads of active products need no permission.
 */
export const CATALOG_PERMISSIONS = {
  /** Read every product including drafts and archived ones (admin). */
  productsRead: "catalog:products.read",
  /** Create and edit products, translations, descriptive values, axes and variants. */
  productsManage: "catalog:products.manage",
  /** Publish, unpublish, archive and restore products. */
  productsPublish: "catalog:products.publish",
  /** Categories, brands, attributes and attribute values. */
  taxonomyManage: "catalog:taxonomy.manage",
  /** Register image metadata and arrange product images. */
  mediaManage: "catalog:media.manage",
} as const satisfies Record<string, Permission>;

export const catalogAuthorization: AuthorizationCatalog = {
  permissions: [
    { key: CATALOG_PERMISSIONS.productsRead, description: "View all products, including drafts and archived products" },
    { key: CATALOG_PERMISSIONS.productsManage, description: "Create and edit products, variants and their content" },
    { key: CATALOG_PERMISSIONS.productsPublish, description: "Publish, unpublish, archive and restore products" },
    { key: CATALOG_PERMISSIONS.taxonomyManage, description: "Manage categories, brands and attributes" },
    { key: CATALOG_PERMISSIONS.mediaManage, description: "Manage product images" },
  ],
  roles: [
    {
      key: "catalog_manager",
      name: "Catalog manager",
      description: "Full control of the catalog, including publishing and taxonomy",
      permissions: Object.values(CATALOG_PERMISSIONS),
    },
    {
      key: "catalog_editor",
      name: "Catalog editor",
      description: "Edit products, variants and images; cannot publish or change the taxonomy",
      permissions: [CATALOG_PERMISSIONS.productsRead, CATALOG_PERMISSIONS.productsManage, CATALOG_PERMISSIONS.mediaManage],
    },
  ],
};
