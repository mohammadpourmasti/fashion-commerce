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
