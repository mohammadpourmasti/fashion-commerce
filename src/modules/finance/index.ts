import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Finance — public API.
 *
 * Ledgers, tax, settlements, reconciliation and financial reporting across online and in-store sales.
 *
 * Other code imports only from "@/modules/finance". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const financeModule = {
  name: "finance",
  summary: "Ledgers, tax, settlements, reconciliation and financial reporting across online and in-store sales.",
  owns: ["ledgerEntry", "taxRule", "settlement"],
  dependsOn: ["commerce", "payments", "pos"],
} as const satisfies ModuleDescriptor;
