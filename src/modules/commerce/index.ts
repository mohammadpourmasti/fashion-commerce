import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Commerce — public API.
 *
 * Cart, checkout, orders, returns and multi-currency price lists. Orchestrates inventory, payments and shipping.
 *
 * Other code imports only from "@/modules/commerce". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const commerceModule = {
  name: "commerce",
  summary: "Cart, checkout, orders, returns and multi-currency price lists. Orchestrates inventory, payments and shipping.",
  owns: ["cart", "order", "orderLine", "return", "priceList"],
  dependsOn: ["catalog", "inventory", "customers", "payments", "shipping"],
} as const satisfies ModuleDescriptor;
