import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Analytics — public API.
 *
 * Event collection and reporting read models. Consumes domain events; never mutates other modules.
 *
 * Other code imports only from "@/modules/analytics". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const analyticsModule = {
  name: "analytics",
  summary: "Event collection and reporting read models. Consumes domain events; never mutates other modules.",
  owns: ["analyticsEvent", "reportSnapshot"],
  dependsOn: [],
} as const satisfies ModuleDescriptor;
