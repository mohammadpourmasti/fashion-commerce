import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Payments — public API.
 *
 * Provider-independent payment intents, captures and refunds behind a gateway port. No real providers connected yet.
 *
 * Other code imports only from "@/modules/payments". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const paymentsModule = {
  name: "payments",
  summary: "Provider-independent payment intents, captures and refunds behind a gateway port. No real providers connected yet.",
  owns: ["paymentIntent", "paymentTransaction", "refund"],
  dependsOn: [],
} as const satisfies ModuleDescriptor;
