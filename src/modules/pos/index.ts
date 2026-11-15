import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Point of sale — public API.
 *
 * In-store sales: registers, shifts, POS orders and receipts against the unified inventory.
 *
 * Other code imports only from "@/modules/pos". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const posModule = {
  name: "pos",
  summary: "In-store sales: registers, shifts, POS orders and receipts against the unified inventory.",
  owns: ["register", "shift", "posSale", "receipt"],
  dependsOn: ["identity", "catalog", "inventory", "customers", "commerce", "payments"],
} as const satisfies ModuleDescriptor;
