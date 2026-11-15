import { and, eq } from "drizzle-orm";

import type { Database } from "@/shared/db/client";
import type { Actor, Authorizer, Permission, Scope } from "@/shared/kernel/authorization";

import { anyGrantAllows, type Grant } from "../domain/authorization";
import { rolePermissions, userRoles, users } from "../infrastructure/schema";

/**
 * Database-backed authorizer. Grants are read on every check, so a role change or a
 * disabled account takes effect on the next request. Deny by default.
 */
export function createAuthorizer(db: Database): Authorizer {
  return {
    async isAllowed(actor: Actor, permission: Permission, scope: Scope): Promise<boolean> {
      if (actor.kind === "system") return true;
      if (actor.kind !== "user") return false;
      const rows = await db
        .select({ permission: rolePermissions.permissionKey, scopeType: userRoles.scopeType, scopeId: userRoles.scopeId })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
        .where(
          and(eq(userRoles.userId, actor.userId), eq(users.status, "active"), eq(rolePermissions.permissionKey, permission)),
        );
      const grants: Grant[] = rows;
      return anyGrantAllows(grants, permission, scope);
    },
  };
}
