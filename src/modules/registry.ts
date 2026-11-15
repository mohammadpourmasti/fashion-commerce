import { aiModule } from "@/modules/ai";
import { analyticsModule } from "@/modules/analytics";
import { catalogModule } from "@/modules/catalog";
import { commerceModule } from "@/modules/commerce";
import { customersModule } from "@/modules/customers";
import { financeModule } from "@/modules/finance";
import { identityModule } from "@/modules/identity";
import { inventoryModule } from "@/modules/inventory";
import { marketingModule } from "@/modules/marketing";
import { paymentsModule } from "@/modules/payments";
import { posModule } from "@/modules/pos";
import { shippingModule } from "@/modules/shipping";
import type { ModuleDescriptor, ModuleName } from "@/shared/kernel/module";

/** Every business module, keyed by name. Missing modules fail typecheck. */
export const modules: Record<ModuleName, ModuleDescriptor> = {
  identity: identityModule,
  catalog: catalogModule,
  inventory: inventoryModule,
  customers: customersModule,
  payments: paymentsModule,
  shipping: shippingModule,
  commerce: commerceModule,
  pos: posModule,
  finance: financeModule,
  marketing: marketingModule,
  analytics: analyticsModule,
  ai: aiModule,
};

/**
 * Returns a dependency cycle if one exists, otherwise null. Covered by
 * registry.test.ts, which keeps the module graph a DAG.
 */
export function findDependencyCycle(
  graph: Record<ModuleName, ModuleDescriptor> = modules,
): ModuleName[] | null {
  const state = new Map<ModuleName, "visiting" | "done">();

  const visit = (name: ModuleName, path: ModuleName[]): ModuleName[] | null => {
    if (state.get(name) === "done") return null;
    if (state.get(name) === "visiting") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "visiting");
    for (const dep of graph[name].dependsOn) {
      const cycle = visit(dep, [...path, name]);
      if (cycle) return cycle;
    }
    state.set(name, "done");
    return null;
  };

  for (const name of Object.keys(graph) as ModuleName[]) {
    const cycle = visit(name, []);
    if (cycle) return cycle;
  }
  return null;
}
