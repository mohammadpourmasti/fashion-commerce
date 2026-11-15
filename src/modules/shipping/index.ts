import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Shipping — public API.
 *
 * Shipping zones, methods, rates, shipments and carrier adapters.
 *
 * Other code imports only from "@/modules/shipping". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const shippingModule = {
  name: "shipping",
  summary: "Shipping zones, methods, rates, shipments and carrier adapters.",
  owns: ["shippingZone", "shippingMethod", "shipment"],
  dependsOn: [],
} as const satisfies ModuleDescriptor;
