import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * AI — public API.
 *
 * Provider-independent AI: stylist, visual search, embeddings and (future) virtual try-on, behind model/provider ports.
 *
 * Other code imports only from "@/modules/ai". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const aiModule = {
  name: "ai",
  summary: "Provider-independent AI: stylist, visual search, embeddings and (future) virtual try-on, behind model/provider ports.",
  owns: ["aiProviderConfig", "embedding", "stylistSession"],
  dependsOn: ["catalog", "customers"],
} as const satisfies ModuleDescriptor;
