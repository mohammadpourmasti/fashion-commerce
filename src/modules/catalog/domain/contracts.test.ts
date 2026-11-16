import { describe, expect, it } from "vitest";

import { validateEvent } from "@/shared/events/outbox";
import { mergeCatalogs } from "@/shared/kernel/authorization";

import { attributeChanged, brandChanged, CATALOG_EVENT_TYPES, categoryChanged, productEvent, variantEvent } from "./events";
import { catalogAuthorization, CATALOG_PERMISSIONS } from "./permissions";

describe("catalog permission catalog", () => {
  it("is internally consistent, uses only catalog: permissions and matches its constants", () => {
    const merged = mergeCatalogs(catalogAuthorization);
    expect(merged.permissions.map((p) => p.key).sort()).toEqual(Object.values(CATALOG_PERMISSIONS).sort());
    expect(merged.permissions.every((p) => p.key.startsWith("catalog:"))).toBe(true);
  });

  it("gives editors no publishing or taxonomy rights", () => {
    const editor = catalogAuthorization.roles.find((r) => r.key === "catalog_editor");
    expect(editor?.permissions).not.toContain(CATALOG_PERMISSIONS.productsPublish);
    expect(editor?.permissions).not.toContain(CATALOG_PERMISSIONS.taxonomyManage);
    const manager = catalogAuthorization.roles.find((r) => r.key === "catalog_manager");
    expect([...(manager?.permissions ?? [])].sort()).toEqual(Object.values(CATALOG_PERMISSIONS).sort());
  });

  it("merges with another module's catalog without collisions", () => {
    const other = { permissions: [{ key: "identity:users.read" as const, description: "x" }], roles: [{ key: "owner", name: "Owner", description: "", permissions: "*" as const }] };
    expect(mergeCatalogs(other, catalogAuthorization).permissions).toHaveLength(Object.keys(CATALOG_PERMISSIONS).length + 1);
  });
});

describe("catalog events", () => {
  it("are valid outbox events with ID-only payloads", () => {
    const productId = "0193b7a0-0000-7000-8000-000000000001";
    const variantId = "0193b7a0-0000-7000-8000-000000000002";
    const events = [
      ...(["productCreated", "productPublished", "productUpdated", "productUnpublished", "productArchived", "productRestored"] as const).map((k) =>
        productEvent(CATALOG_EVENT_TYPES[k], productId),
      ),
      variantEvent(CATALOG_EVENT_TYPES.variantCreated, productId, variantId),
      variantEvent(CATALOG_EVENT_TYPES.variantDiscontinued, productId, variantId),
    ];
    for (const event of events) {
      expect(() => validateEvent(event)).not.toThrow();
      expect(event.type.startsWith("catalog.")).toBe(true);
      expect(event.aggregate).toEqual({ type: "product", id: productId });
      for (const [key, value] of Object.entries(event.payload)) {
        expect(key).toMatch(/Id$/);
        expect(value).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  });

  it("taxonomy events are valid, ID-only and keyed by their own aggregate", () => {
    const id = "0193b7a0-0000-7000-8000-000000000003";
    const valueId = "0193b7a0-0000-7000-8000-000000000004";
    expect(categoryChanged(id)).toEqual({ type: "catalog.category.changed", aggregate: { type: "category", id }, payload: { categoryId: id } });
    expect(brandChanged(id)).toEqual({ type: "catalog.brand.changed", aggregate: { type: "brand", id }, payload: { brandId: id } });
    expect(attributeChanged(id)).toEqual({ type: "catalog.attribute.changed", aggregate: { type: "attribute", id }, payload: { attributeId: id } });
    expect(attributeChanged(id, valueId).payload).toEqual({ attributeId: id, valueId });
    for (const event of [categoryChanged(id), brandChanged(id), attributeChanged(id, valueId)]) expect(() => validateEvent(event)).not.toThrow();
  });
});
