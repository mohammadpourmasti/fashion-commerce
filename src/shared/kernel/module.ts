/**
 * Module boundary contract. Every business module in src/modules declares
 * what it owns and which other modules it is allowed to call. The registry
 * (src/modules/registry.ts) checks the graph is acyclic.
 *
 * Rules (see docs/ARCHITECTURE.md):
 * - Import a module only via `@/modules/<name>` (enforced by ESLint).
 * - A module may only import modules listed in its `dependsOn`.
 * - Modules never read another module's database tables directly.
 */

export const moduleNames = [
  "identity",
  "catalog",
  "inventory",
  "customers",
  "payments",
  "shipping",
  "commerce",
  "pos",
  "finance",
  "marketing",
  "analytics",
  "ai",
] as const;

export type ModuleName = (typeof moduleNames)[number];

export type ModuleDescriptor = {
  readonly name: ModuleName;
  readonly summary: string;
  /** Aggregates/data this module is the single source of truth for. */
  readonly owns: readonly string[];
  /** Modules whose public API this module may call synchronously. */
  readonly dependsOn: readonly ModuleName[];
};
