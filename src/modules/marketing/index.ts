import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Marketing — public API.
 *
 * Promotions, discount codes, campaigns, gift cards and CMS-driven editorial content.
 *
 * Other code imports only from "@/modules/marketing". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const marketingModule = {
  name: "marketing",
  summary: "Promotions, discount codes, campaigns, gift cards and CMS-driven editorial content.",
  owns: ["promotion", "discountCode", "campaign", "giftCard"],
  dependsOn: ["catalog", "customers"],
} as const satisfies ModuleDescriptor;
