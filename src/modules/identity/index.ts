import type { ModuleDescriptor } from "@/shared/kernel/module";

/**
 * Identity & access — public API.
 *
 * Authentication, sessions, staff and customer accounts, roles and permissions (RBAC).
 *
 * Other code imports only from "@/modules/identity". Internals (domain,
 * application services, persistence adapters) live in subfolders and are
 * re-exported here deliberately.
 */
export const identityModule = {
  name: "identity",
  summary: "Authentication, sessions, staff and customer accounts, roles and permissions (RBAC).",
  owns: ["user", "session", "role", "permission"],
  dependsOn: [],
} as const satisfies ModuleDescriptor;
