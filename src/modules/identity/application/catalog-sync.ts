import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { runInTransaction } from "@/shared/db/transaction";
import type { AuthorizationCatalog } from "@/shared/kernel/authorization";

import { permissions, rolePermissions, roles } from "../infrastructure/schema";

const CATALOG_LOCK = 727450001;

/**
 * Makes the database match the code-defined catalog: upserts permissions and roles and
 * sets each catalog role's permission list exactly. Roles with `"*"` receive every
 * catalog permission. Roles or permissions that exist only in the database (custom
 * roles) are left alone. Idempotent and safe to run concurrently.
 */
export async function syncAuthorizationCatalog(pool: Pool, catalog: AuthorizationCatalog): Promise<void> {
  const allKeys = catalog.permissions.map((p) => p.key);
  await runInTransaction(pool, async ({ db }) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(${CATALOG_LOCK})`);
    for (const p of catalog.permissions) {
      await db
        .insert(permissions)
        .values({ key: p.key, description: p.description })
        .onConflictDoUpdate({ target: permissions.key, set: { description: p.description } });
    }
    for (const role of catalog.roles) {
      const [row] = await db
        .insert(roles)
        .values({ key: role.key, name: role.name, description: role.description })
        .onConflictDoUpdate({ target: roles.key, set: { name: role.name, description: role.description } })
        .returning({ id: roles.id });
      if (!row) throw new Error(`role upsert returned no row for ${role.key}`);
      const wanted = role.permissions === "*" ? allKeys : [...role.permissions];
      if (wanted.length === 0) {
        await db.delete(rolePermissions).where(eq(rolePermissions.roleId, row.id));
        continue;
      }
      await db
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, row.id), notInArray(rolePermissions.permissionKey, wanted)));
      await db
        .insert(rolePermissions)
        .values(wanted.map((permissionKey) => ({ roleId: row.id, permissionKey })))
        .onConflictDoNothing();
    }
  });
}
