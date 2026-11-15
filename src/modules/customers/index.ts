import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Customers — public API.
 *
 * Customer profiles, addresses, size profiles, preferences and consent.
 *
 * Other code imports only from "@/modules/customers". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const customersModule = {
  name: "customers",
  summary: "Customer profiles, addresses, size profiles, preferences and consent.",
  owns: ["customer", "address", "sizeProfile", "consent"],
  dependsOn: ["identity"],
} as const satisfies ModuleDescriptor;
