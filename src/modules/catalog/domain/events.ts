import type { DomainEventInput } from "@/shared/events/outbox";

/**
 * Catalog domain events (ADR-020, ADR-024). Payloads carry IDs only — never names, prices or
 * other content — so consumers read current data through the catalog's public API. The
 * application layer adds them with `tx.events.add(...)` in the same transaction as the change.
 */
export const CATALOG_EVENT_TYPES = {
  productPublished: "catalog.product.published",
  productUpdated: "catalog.product.updated",
  productUnpublished: "catalog.product.unpublished",
  productArchived: "catalog.product.archived",
  productRestored: "catalog.product.restored",
  variantCreated: "catalog.variant.created",
  variantDiscontinued: "catalog.variant.discontinued",
  // Taxonomy: one "changed" event per aggregate (created, edited, moved, reordered, archived,
  // restored). Consumers such as caches or a search index re-read the current state.
  categoryChanged: "catalog.category.changed",
  brandChanged: "catalog.brand.changed",
  attributeChanged: "catalog.attribute.changed",
} as const;

export type ProductEventType = (typeof CATALOG_EVENT_TYPES)[
  "productPublished" | "productUpdated" | "productUnpublished" | "productArchived" | "productRestored"
];
export type VariantEventType = (typeof CATALOG_EVENT_TYPES)["variantCreated" | "variantDiscontinued"];

export const productEvent = (type: ProductEventType, productId: string): DomainEventInput => ({
  type,
  aggregate: { type: "product", id: productId },
  payload: { productId },
});

export const variantEvent = (type: VariantEventType, productId: string, variantId: string): DomainEventInput => ({
  type,
  aggregate: { type: "product", id: productId },
  payload: { productId, variantId },
});

export const categoryChanged = (categoryId: string): DomainEventInput => ({
  type: CATALOG_EVENT_TYPES.categoryChanged,
  aggregate: { type: "category", id: categoryId },
  payload: { categoryId },
});

export const brandChanged = (brandId: string): DomainEventInput => ({
  type: CATALOG_EVENT_TYPES.brandChanged,
  aggregate: { type: "brand", id: brandId },
  payload: { brandId },
});

/** Attribute values belong to their attribute's aggregate; `valueId` is set for value changes. */
export const attributeChanged = (attributeId: string, valueId?: string): DomainEventInput => ({
  type: CATALOG_EVENT_TYPES.attributeChanged,
  aggregate: { type: "attribute", id: attributeId },
  payload: valueId ? { attributeId, valueId } : { attributeId },
});
