import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { runInTransaction } from "@/shared/db/transaction";
import { GLOBAL_SCOPE, type Actor, type RequestContext } from "@/shared/kernel/authorization";

import { OWNER_ROLE, IDENTITY_PERMISSIONS } from "../domain/catalog";
import { normalizeEmail } from "../domain/email";
import { checkPasswordPolicy, type PasswordHasher, type PasswordPolicyIssue } from "../domain/password";
import { credentials, roles, userRoles, users } from "../infrastructure/schema";

import { recordAudit } from "./audit";
import { revokeUserSessions } from "./sessions";

/** Serialises every change that could remove or add an owner. */
const OWNER_LOCK = 727450002;

export type IdentityError =
  | { code: "invalid_email" }
  | { code: "weak_password"; issues: PasswordPolicyIssue[] }
  | { code: "email_taken" }
  | { code: "not_found" }
  | { code: "owner_exists" }
  | { code: "last_owner" };

export type Result<T> = ({ ok: true } & T) | { ok: false; error: IdentityError };

export interface UserServiceDeps {
  readonly pool: Pool;
  readonly hasher: PasswordHasher;
  readonly now: () => Date;
}

const actorAudit = (actor: Actor): { type: "anonymous" | "user" | "system"; id?: string } =>
  actor.kind === "user" ? { type: "user", id: actor.userId } : actor.kind === "system" ? { type: "system", id: actor.name } : { type: "anonymous" };

export function createUserService({ pool, hasher, now }: UserServiceDeps) {
  async function insertUser(
    tx: Parameters<Parameters<typeof runInTransaction>[1]>[0],
    input: { email: string; emailNormalized: string; displayName?: string | undefined; passwordHash: string },
    at: Date,
  ): Promise<string | null> {
    const inserted = await tx.db
      .insert(users)
      .values({ email: input.email.trim(), emailNormalized: input.emailNormalized, displayName: input.displayName ?? null, createdAt: at, updatedAt: at })
      .onConflictDoNothing({ target: users.emailNormalized })
      .returning({ id: users.id });
    const row = inserted[0];
    if (!row) return null;
    await tx.db.insert(credentials).values({ userId: row.id, passwordHash: input.passwordHash, passwordChangedAt: at });
    return row.id;
  }

  async function prepare(
    email: string,
    password: string,
  ): Promise<{ error: IdentityError } | { emailNormalized: string; passwordHash: string }> {
    const emailNormalized = normalizeEmail(email);
    if (!emailNormalized) return { error: { code: "invalid_email" } };
    const issues = checkPasswordPolicy(password, { email: emailNormalized });
    if (issues.length > 0) return { error: { code: "weak_password", issues } };
    // Hashing is slow and the transaction may be retried, so it happens outside it.
    return { emailNormalized, passwordHash: await hasher.hash(password) };
  }

  return {
    /**
     * Creates the first owner. Refuses if any active owner already exists. For the CLI only:
     * there is no HTTP entry point and no default credential anywhere in the code.
     */
    async bootstrapOwner(input: { email: string; password: string; displayName?: string }): Promise<Result<{ userId: string }>> {
      const prepared = await prepare(input.email, input.password);
      if ("error" in prepared) return { ok: false, error: prepared.error };
      return runInTransaction(pool, async (tx) => {
        await tx.db.execute(sql`SELECT pg_advisory_xact_lock(${OWNER_LOCK})`);
        const existing = await tx.db
          .select({ id: userRoles.userId })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .innerJoin(users, eq(users.id, userRoles.userId))
          .where(and(eq(roles.key, OWNER_ROLE), eq(users.status, "active")))
          .limit(1);
        if (existing.length > 0) return { ok: false, error: { code: "owner_exists" } } as const;
        const [ownerRole] = await tx.db.select({ id: roles.id }).from(roles).where(eq(roles.key, OWNER_ROLE)).limit(1);
        if (!ownerRole) throw new Error("The authorization catalog has not been synchronised (owner role missing).");
        const at = now();
        const userId = await insertUser(tx, { email: input.email, emailNormalized: prepared.emailNormalized, displayName: input.displayName, passwordHash: prepared.passwordHash }, at);
        if (!userId) return { ok: false, error: { code: "email_taken" } } as const;
        await tx.db.insert(userRoles).values({ userId, roleId: ownerRole.id, grantedAt: at });
        await recordAudit(tx.db, { type: "identity.owner.bootstrap", actor: { type: "system", id: "bootstrap" }, subject: { type: "user", id: userId }, outcome: "success", occurredAt: at });
        return { ok: true, userId } as const;
      });
    },

    async createUser(ctx: RequestContext, input: { email: string; password: string; displayName?: string }): Promise<Result<{ userId: string }>> {
      await ctx.authorize(IDENTITY_PERMISSIONS.usersManage, GLOBAL_SCOPE);
      const prepared = await prepare(input.email, input.password);
      if ("error" in prepared) return { ok: false, error: prepared.error };
      return runInTransaction(pool, async (tx) => {
        const at = now();
        const userId = await insertUser(tx, { email: input.email, emailNormalized: prepared.emailNormalized, displayName: input.displayName, passwordHash: prepared.passwordHash }, at);
        if (!userId) return { ok: false, error: { code: "email_taken" } } as const;
        await recordAudit(tx.db, { type: "identity.user.create", actor: actorAudit(ctx.actor), subject: { type: "user", id: userId }, outcome: "success", requestId: ctx.requestId, occurredAt: at });
        return { ok: true, userId } as const;
      });
    },

    async assignRole(ctx: RequestContext, input: { userId: string; roleKey: string }): Promise<Result<object>> {
      await ctx.authorize(IDENTITY_PERMISSIONS.rolesManage, GLOBAL_SCOPE);
      return runInTransaction(pool, async (tx) => {
        const [role] = await tx.db.select({ id: roles.id }).from(roles).where(eq(roles.key, input.roleKey)).limit(1);
        const [user] = await tx.db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
        if (!role || !user) return { ok: false, error: { code: "not_found" } } as const;
        const at = now();
        await tx.db.insert(userRoles).values({ userId: user.id, roleId: role.id, grantedAt: at, grantedBy: ctx.actor.kind === "user" ? ctx.actor.userId : null }).onConflictDoNothing();
        await recordAudit(tx.db, { type: "identity.role.assign", actor: actorAudit(ctx.actor), subject: { type: "user", id: user.id }, outcome: "success", requestId: ctx.requestId, metadata: { role: input.roleKey }, occurredAt: at });
        return { ok: true } as const;
      });
    },

    async revokeRole(ctx: RequestContext, input: { userId: string; roleKey: string }): Promise<Result<object>> {
      await ctx.authorize(IDENTITY_PERMISSIONS.rolesManage, GLOBAL_SCOPE);
      return runInTransaction(pool, async (tx) => {
        await tx.db.execute(sql`SELECT pg_advisory_xact_lock(${OWNER_LOCK})`);
        const [role] = await tx.db.select({ id: roles.id }).from(roles).where(eq(roles.key, input.roleKey)).limit(1);
        if (!role) return { ok: false, error: { code: "not_found" } } as const;
        if (input.roleKey === OWNER_ROLE && (await otherActiveOwners(tx.db, input.userId)) === 0) {
          return { ok: false, error: { code: "last_owner" } } as const;
        }
        const removed = await tx.db.delete(userRoles).where(and(eq(userRoles.userId, input.userId), eq(userRoles.roleId, role.id))).returning({ r: userRoles.roleId });
        if (removed.length === 0) return { ok: false, error: { code: "not_found" } } as const;
        await recordAudit(tx.db, { type: "identity.role.revoke", actor: actorAudit(ctx.actor), subject: { type: "user", id: input.userId }, outcome: "success", requestId: ctx.requestId, metadata: { role: input.roleKey }, occurredAt: now() });
        return { ok: true } as const;
      });
    },

    /** Disabling revokes every session of the user in the same transaction. */
    async setUserStatus(ctx: RequestContext, input: { userId: string; status: "active" | "disabled" }): Promise<Result<object>> {
      await ctx.authorize(IDENTITY_PERMISSIONS.usersManage, GLOBAL_SCOPE);
      return runInTransaction(pool, async (tx) => {
        await tx.db.execute(sql`SELECT pg_advisory_xact_lock(${OWNER_LOCK})`);
        const [user] = await tx.db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1);
        if (!user) return { ok: false, error: { code: "not_found" } } as const;
        const at = now();
        if (input.status === "disabled") {
          if ((await isActiveOwner(tx.db, user.id)) && (await otherActiveOwners(tx.db, user.id)) === 0) {
            return { ok: false, error: { code: "last_owner" } } as const;
          }
          await tx.db.update(users).set({ status: "disabled", disabledAt: at, updatedAt: at }).where(eq(users.id, user.id));
          await revokeUserSessions(tx.db, user.id, "user_disabled", at);
        } else {
          await tx.db.update(users).set({ status: "active", disabledAt: null, updatedAt: at }).where(eq(users.id, user.id));
        }
        await recordAudit(tx.db, { type: `identity.user.${input.status === "disabled" ? "disable" : "enable"}`, actor: actorAudit(ctx.actor), subject: { type: "user", id: user.id }, outcome: "success", requestId: ctx.requestId, occurredAt: at });
        return { ok: true } as const;
      });
    },

    /** Changes the password after checking the current one, and ends every other session. */
    async changePassword(ctx: RequestContext, input: { currentPassword: string; newPassword: string }): Promise<Result<object> | { ok: false; error: { code: "invalid_credentials" } }> {
      if (ctx.actor.kind !== "user") {
        await ctx.authorize(IDENTITY_PERMISSIONS.usersRead); // throws "unauthenticated" / "forbidden"
        return { ok: false, error: { code: "not_found" } };
      }
      const { userId, sessionId } = ctx.actor;
      const [row] = await pool.query<{ password_hash: string; email_normalized: string }>(
        "SELECT c.password_hash, u.email_normalized FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1 AND u.status = 'active'",
        [userId],
      ).then((r) => r.rows);
      if (!row) return { ok: false, error: { code: "not_found" } };
      if (!(await hasher.verify(input.currentPassword, row.password_hash))) {
        return { ok: false, error: { code: "invalid_credentials" } };
      }
      const issues = checkPasswordPolicy(input.newPassword, { email: row.email_normalized });
      if (issues.length > 0) return { ok: false, error: { code: "weak_password", issues } };
      const passwordHash = await hasher.hash(input.newPassword);
      return runInTransaction(pool, async (tx) => {
        const at = now();
        await tx.db.update(credentials).set({ passwordHash, passwordChangedAt: at }).where(eq(credentials.userId, userId));
        const revoked = await revokeUserSessions(tx.db, userId, "password_changed", at, sessionId);
        await recordAudit(tx.db, { type: "identity.password.change", actor: { type: "user", id: userId }, subject: { type: "user", id: userId }, outcome: "success", requestId: ctx.requestId, metadata: { revokedSessions: revoked }, occurredAt: at });
        return { ok: true } as const;
      });
    },
  };
}

type Db = Parameters<Parameters<typeof runInTransaction>[1]>[0]["db"];

async function isActiveOwner(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.userId, userId), eq(roles.key, OWNER_ROLE), eq(users.status, "active")))
    .limit(1);
  return rows.length > 0;
}

async function otherActiveOwners(db: Db, excludingUserId: string): Promise<number> {
  const rows = await db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(roles.key, OWNER_ROLE), eq(users.status, "active"), sql`${userRoles.userId} <> ${excludingUserId}`));
  return rows.length;
}
