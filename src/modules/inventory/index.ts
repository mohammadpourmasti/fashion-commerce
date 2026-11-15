import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Inventory — public API.
 *
 * One stock ledger across warehouses and boutiques: stock levels, reservations, transfers, adjustments.
 *
 * Other code imports only from "@/modules/inventory". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const inventoryModule = {
  name: "inventory",
  summary: "One stock ledger across warehouses and boutiques: stock levels, reservations, transfers, adjustments.",
  owns: ["location", "stockLevel", "stockMovement", "reservation"],
  dependsOn: ["catalog"],
} as const satisfies ModuleDescriptor;
