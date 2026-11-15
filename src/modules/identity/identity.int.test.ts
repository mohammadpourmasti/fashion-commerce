import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPool } from "@/shared/db/client";
import { migrateDown, migrateUp } from "@/shared/db/migrations";
import { pgErrorCode } from "@/shared/db/errors";
import { REAL_MIGRATIONS, schemaSnapshot } from "@/shared/db/testing/migration-fixtures";
import { createTestDatabase, type TestDatabase } from "@/shared/db/testing/test-database";
import { AuthorizationError } from "@/shared/kernel/authorization";

import { createIdentity, type Identity } from "./application/identity";
import { identityCatalog, IDENTITY_PERMISSIONS } from "./domain/catalog";
import { hashSessionToken, deriveKeys } from "./domain/keys";
import * as schema from "./infrastructure/schema";

const SECRET = "integration-test-secret-0123456789abcdef";
const SITE = "https://shop.example.com";
const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const PASSWORD = "correct horse battery staple";
const COOKIE = "__Host-session";
const IDENTITY_MIGRATION = 2;

let db: TestDatabase;
let appPool: Pool;
let clock: Date;
let identity: Identity;

beforeEach(async () => {
  clock = new Date("2030-01-01T00:00:00Z");
  db = await createTestDatabase();
  // Stop at 0002 so the down-migration tests below revert identity, not a later module's migration.
  await migrateUp(db.pool, { directory: REAL_MIGRATIONS, appRole: db.appRole, to: IDENTITY_MIGRATION });
  // Everything the application does in these tests runs as the least-privilege role.
  appPool = createPool(db.url, { max: 8, options: `-c role=${db.appRole}` });
  identity = createIdentity({ pool: appPool, authSecret: SECRET, siteUrl: SITE, scrypt: FAST_SCRYPT, now: () => clock });
  await identity.syncCatalog();
});

afterEach(async () => {
  await appPool?.end();
  await db?.cleanup();
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const MIN = 60_000;
const HOUR = 3_600_000;

async function owner(email = "owner@example.com") {
  const result = await identity.users.bootstrapOwner({ email, password: PASSWORD });
  if (!result.ok) throw new Error(`bootstrap failed: ${result.error.code}`);
  return result.userId;
}

async function loginAs(email: string, password = PASSWORD, ip = "203.0.113.7") {
  return identity.login({ email, password, ip, userAgent: "vitest", requestId: "req-1" });
}

async function sessionFor(email: string, ip = "203.0.113.7") {
  const result = await loginAs(email, PASSWORD, ip);
  if (!result.ok) throw new Error(`login failed: ${result.reason}`);
  return result.token;
}

const cookieHeader = (token: string) => `${COOKIE}=${token}`;
const auth = (token: string | null, extra: { ip?: string } = {}) =>
  identity.authenticate({ cookieHeader: token ? cookieHeader(token) : null, requestId: "req-x", ip: extra.ip ?? "203.0.113.7" });

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query(sql, params);
  return Number(rows[0].n);
}

const TABLES: [string, PgTable][] = [
  ["users", schema.users],
  ["credentials", schema.credentials],
  ["sessions", schema.sessions],
  ["roles", schema.roles],
  ["permissions", schema.permissions],
  ["role_permissions", schema.rolePermissions],
  ["user_roles", schema.userRoles],
  ["audit_events", schema.auditEvents],
  ["auth_throttle", schema.authThrottle],
];

describe("migration 0002_identity", () => {
  it.each(TABLES)("Drizzle definition of %s matches the database", async (name, table) => {
    const config = getTableConfig(table);
    const cols = await db.pool.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
      [name],
    );
    expect(cols.rows.map((r) => [r.column_name, r.is_nullable])).toEqual(
      config.columns.map((c) => [c.name, c.notNull ? "NO" : "YES"]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const checks = await db.pool.query("SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname", [`public.${name}`]);
    expect(checks.rows.map((r) => r.conname)).toEqual(config.checks.map((c) => c.name).sort());
    const indexes = await db.pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexname !~ '(_pkey|_key|_unique)$' ORDER BY indexname", [name]);
    expect(indexes.rows.map((r) => r.indexname)).toEqual(config.indexes.map((i) => i.config.name).sort());
  });

  it("round-trips down and up to an identical schema when the tables are empty", async () => {
    const empty = await createTestDatabase();
    try {
      await migrateUp(empty.pool, { directory: REAL_MIGRATIONS, appRole: empty.appRole, to: IDENTITY_MIGRATION });
      const before = await schemaSnapshot(empty.pool);
      await migrateDown(empty.pool, { directory: REAL_MIGRATIONS, steps: 1, production: false });
      const gone = await empty.pool.query("SELECT to_regclass('public.users') AS t");
      expect(gone.rows[0].t).toBeNull();
      await migrateUp(empty.pool, { directory: REAL_MIGRATIONS, appRole: empty.appRole, to: IDENTITY_MIGRATION });
      expect(await schemaSnapshot(empty.pool)).toBe(before);
    } finally {
      await empty.cleanup();
    }
  });

  it("refuses to go down once data exists, and changes nothing", async () => {
    await owner();
    const before = await schemaSnapshot(db.pool);
    await expect(migrateDown(db.pool, { directory: REAL_MIGRATIONS, steps: 1, production: false })).rejects.toThrow();
    expect(await schemaSnapshot(db.pool)).toBe(before);
    expect(await count("SELECT count(*) AS n FROM users")).toBe(1);
  });

  it("gives the application role no way to alter or erase the audit log", async () => {
    await owner();
    const client = await db.pool.connect();
    try {
      await client.query(`SET ROLE ${db.appRole}`);
      expect(await count("SELECT count(*) AS n FROM audit_events")).toBeGreaterThan(0);
      for (const statement of [
        "UPDATE audit_events SET outcome = 'success'",
        "DELETE FROM audit_events",
        "TRUNCATE audit_events",
        "DROP TABLE audit_events",
      ]) {
        const code = await client.query(statement).then(() => null, pgErrorCode);
        expect(code, statement).toBe("42501");
      }
      const codeNoDelete = await client.query("DELETE FROM users").then(() => null, pgErrorCode);
      expect(codeNoDelete).toBe("42501");
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });

  it("does not seed accounts: a fresh database has no users, only the synchronised catalog", async () => {
    expect(await count("SELECT count(*) AS n FROM users")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM credentials")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM permissions")).toBe(identityCatalog.permissions.length);
  });

  it("catalog sync is idempotent and gives the owner every permission", async () => {
    await identity.syncCatalog();
    await identity.syncCatalog();
    expect(await count("SELECT count(*) AS n FROM roles")).toBe(identityCatalog.roles.length);
    expect(
      await count("SELECT count(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'owner'"),
    ).toBe(identityCatalog.permissions.length);
  });
});

describe("bootstrap and accounts", () => {
  it("creates exactly one owner, even under concurrency", async () => {
    const results = await Promise.all(
      ["a@example.com", "b@example.com", "c@example.com"].map((email) => identity.users.bootstrapOwner({ email, password: PASSWORD })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === "owner_exists")).toBe(true);
    expect(await count("SELECT count(*) AS n FROM users")).toBe(1);
  });

  it("rejects weak passwords and bad emails and stores no hash for them", async () => {
    expect(await identity.users.bootstrapOwner({ email: "x@example.com", password: "short" })).toMatchObject({ ok: false, error: { code: "weak_password" } });
    expect(await identity.users.bootstrapOwner({ email: "nope", password: PASSWORD })).toMatchObject({ ok: false, error: { code: "invalid_email" } });
    expect(await count("SELECT count(*) AS n FROM users")).toBe(0);
  });

  it("stores a scrypt hash, never the password, and normalizes the email", async () => {
    await owner("Owner@Example.COM");
    const { rows } = await db.pool.query("SELECT u.email, u.email_normalized, c.password_hash FROM users u JOIN credentials c ON c.user_id = u.id");
    expect(rows[0].email_normalized).toBe("owner@example.com");
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  it("createUser needs identity:users.manage, refuses duplicates case-insensitively", async () => {
    await owner();
    const ownerCtx = (await auth(await sessionFor("owner@example.com"))).context;
    const created = await identity.users.createUser(ownerCtx, { email: "staff@example.com", password: PASSWORD });
    expect(created.ok).toBe(true);
    expect(await identity.users.createUser(ownerCtx, { email: "STAFF@example.com", password: PASSWORD })).toMatchObject({ ok: false, error: { code: "email_taken" } });

    const staffCtx = (await auth(await sessionFor("staff@example.com"))).context;
    await expect(identity.users.createUser(staffCtx, { email: "third@example.com", password: PASSWORD })).rejects.toBeInstanceOf(AuthorizationError);
    expect(await count("SELECT count(*) AS n FROM users")).toBe(2);
  });
});

describe("login", () => {
  it("returns the same generic failure for wrong password, unknown user and disabled user", async () => {
    const ownerId = await owner();
    const ownerCtx = (await auth(await sessionFor("owner@example.com"))).context;
    await identity.users.createUser(ownerCtx, { email: "off@example.com", password: PASSWORD });
    const [{ id: offId }] = (await db.pool.query("SELECT id FROM users WHERE email_normalized = 'off@example.com'")).rows;
    await identity.users.setUserStatus(ownerCtx, { userId: offId, status: "disabled" });

    const outcomes = await Promise.all([
      loginAs("owner@example.com", "wrong password here", "198.51.100.1"),
      loginAs("ghost@example.com", PASSWORD, "198.51.100.2"),
      loginAs("off@example.com", PASSWORD, "198.51.100.3"),
      loginAs("not-an-email", PASSWORD, "198.51.100.4"),
    ]);
    for (const outcome of outcomes) expect(outcome).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(ownerId).toBeTruthy();
  });

  it("writes audit events without passwords, tokens or raw attempted emails", async () => {
    await owner();
    await loginAs("ghost-attacker@example.com", "hunter2hunter2hunter2");
    const token = await sessionFor("owner@example.com");
    const dump = JSON.stringify((await db.pool.query("SELECT * FROM audit_events")).rows);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("ghost-attacker");
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("203.0.113.7");
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE type = 'auth.login' AND outcome = 'failure'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE type = 'auth.login' AND outcome = 'success'")).toBe(1);
  });

  it("stores only an HMAC of the session token", async () => {
    await owner();
    const token = await sessionFor("owner@example.com");
    const { rows } = await db.pool.query("SELECT * FROM sessions");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0].token_hash).toBe(hashSessionToken(token, deriveKeys(SECRET)));
    expect(rows[0].expires_at.getTime() - clock.getTime()).toBe(7 * 24 * HOUR);
  });
});

describe("login throttling", () => {
  beforeEach(async () => {
    await owner();
  });

  it("blocks the sixth failure for the same account and address, even with the right password", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await loginAs("owner@example.com", "wrong password here")).toEqual({ ok: false, reason: "invalid_credentials" });
    }
    const blocked = await loginAs("owner@example.com", PASSWORD);
    expect(blocked).toMatchObject({ ok: false, reason: "throttled" });
    expect(blocked.ok === false && blocked.reason === "throttled" && blocked.retryAfterSeconds).toBe(30);
    // Refused attempts are not counted: still the same wait immediately afterwards.
    expect(await loginAs("owner@example.com", PASSWORD)).toMatchObject({ reason: "throttled" });
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE outcome = 'throttled'")).toBe(2);
  });

  it("does not lock the account for other addresses (no hard lockout)", async () => {
    for (let i = 0; i < 5; i += 1) await loginAs("owner@example.com", "wrong password here", "198.51.100.9");
    expect(await loginAs("owner@example.com", PASSWORD, "198.51.100.9")).toMatchObject({ reason: "throttled" });
    expect(await loginAs("owner@example.com", PASSWORD, "203.0.113.50")).toMatchObject({ ok: true });
  });

  it("lets the right password in once the wait has passed, and a success resets the counter", async () => {
    for (let i = 0; i < 5; i += 1) await loginAs("owner@example.com", "wrong password here");
    expect(await loginAs("owner@example.com", PASSWORD)).toMatchObject({ reason: "throttled" });
    advance(31_000);
    expect(await loginAs("owner@example.com", PASSWORD)).toMatchObject({ ok: true });
    for (let i = 0; i < 5; i += 1) {
      expect(await loginAs("owner@example.com", "wrong password here")).toMatchObject({ reason: "invalid_credentials" });
    }
  });

  it("doubles the wait for continued guessing (the delay cap itself is unit-tested)", async () => {
    for (let i = 0; i < 5; i += 1) await loginAs("owner@example.com", "wrong password here");
    const waits: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const result = await loginAs("owner@example.com", "wrong password here");
      if (result.ok || result.reason !== "throttled") throw new Error("expected throttle");
      waits.push(result.retryAfterSeconds);
      advance(result.retryAfterSeconds * 1000 + 1000);
      // The permitted attempt after waiting is itself a failure that raises the next wait.
      expect(await loginAs("owner@example.com", "wrong password here")).toMatchObject({ reason: "invalid_credentials" });
    }
    expect(waits).toEqual([30, 60, 120, 240, 480]);
  });

  it("caps one account at 100 attempts per hour across all addresses", async () => {
    let throttledAt = -1;
    for (let i = 0; i < 105; i += 1) {
      const result = await loginAs("owner@example.com", "wrong password here", `10.0.0.${i + 1}`);
      if (!result.ok && result.reason === "throttled") {
        throttledAt = i;
        break;
      }
    }
    expect(throttledAt).toBe(100);
  });
});

describe("sessions and cookies", () => {
  beforeEach(async () => {
    await owner();
  });

  it("authenticates a valid cookie as the user, and an absent or unknown one as anonymous", async () => {
    const token = await sessionFor("owner@example.com");
    const known = await auth(token);
    expect(known.context.actor).toMatchObject({ kind: "user" });
    expect(known.setCookies).toEqual([]);
    expect((await auth(null)).context.actor.kind).toBe("anonymous");
    const unknown = await auth("A".repeat(43));
    expect(unknown.context.actor.kind).toBe("anonymous");
    expect(unknown.setCookies[0]).toMatch(/^__Host-session=;.*Max-Age=0/);
  });

  it("rotates after an hour: new token issued, old token dead, absolute expiry unchanged", async () => {
    const token = await sessionFor("owner@example.com");
    const expiry = (await db.pool.query("SELECT expires_at FROM sessions")).rows[0].expires_at.getTime();
    advance(61 * MIN);
    const rotated = await auth(token);
    expect(rotated.context.actor.kind).toBe("user");
    const cookie = rotated.setCookies[0] ?? "";
    expect(cookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const newToken = /^__Host-session=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect(newToken).not.toBe(token);
    expect((await auth(token)).context.actor.kind).toBe("anonymous");
    expect((await auth(newToken)).context.actor.kind).toBe("user");
    const rows = (await db.pool.query("SELECT revoked_reason, expires_at FROM sessions ORDER BY created_at, id")).rows;
    expect(rows.map((r) => r.revoked_reason)).toEqual(["rotated", null]);
    expect(rows[1].expires_at.getTime()).toBe(expiry);
  });

  it("lets exactly one of two simultaneous rotations win", async () => {
    const token = await sessionFor("owner@example.com");
    advance(61 * MIN);
    const [a, b] = await Promise.all([auth(token), auth(token)]);
    const users = [a, b].filter((r) => r.context.actor.kind === "user");
    expect(users).toHaveLength(1);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL")).toBe(1);
  });

  it("expires after 8 hours idle and after 7 days absolute", async () => {
    const token = await sessionFor("owner@example.com");
    advance(9 * HOUR);
    expect((await auth(token)).context.actor.kind).toBe("anonymous");

    let current = await sessionFor("owner@example.com");
    // Stay active every 7 hours (rotating as needed); the absolute limit still ends it.
    for (let i = 0; i < 40; i += 1) {
      advance(7 * HOUR);
      const result = await auth(current);
      if (result.context.actor.kind !== "user") {
        expect(clock.getTime() - new Date("2030-01-01T09:00:00Z").getTime()).toBeGreaterThanOrEqual(7 * 24 * HOUR - 7 * HOUR);
        return;
      }
      const rotated = /^__Host-session=([^;]+)/.exec(result.setCookies[0] ?? "")?.[1];
      if (rotated) current = rotated;
    }
    throw new Error("session outlived its absolute expiry");
  });

  it("logout revokes the session and clears the cookie", async () => {
    const token = await sessionFor("owner@example.com");
    const { context } = await auth(token);
    const { setCookies } = await identity.logout(context);
    expect(setCookies[0]).toMatch(/Max-Age=0/);
    expect((await auth(token)).context.actor.kind).toBe("anonymous");
    expect(await count("SELECT count(*) AS n FROM sessions WHERE revoked_reason = 'logout'")).toBe(1);
  });

  it("changing the password ends the other sessions but keeps this one", async () => {
    const first = await sessionFor("owner@example.com", "198.51.100.1");
    const second = await sessionFor("owner@example.com", "198.51.100.2");
    const { context } = await auth(second);
    const changed = await identity.users.changePassword(context, { currentPassword: PASSWORD, newPassword: "another long passphrase" });
    expect(changed.ok).toBe(true);
    expect((await auth(first)).context.actor.kind).toBe("anonymous");
    expect((await auth(second)).context.actor.kind).toBe("user");
    expect(await loginAs("owner@example.com", PASSWORD, "198.51.100.8")).toMatchObject({ ok: false });
    expect(await loginAs("owner@example.com", "another long passphrase", "198.51.100.9")).toMatchObject({ ok: true });
  });

  it("changePassword checks the current password", async () => {
    const { context } = await auth(await sessionFor("owner@example.com"));
    expect(await identity.users.changePassword(context, { currentPassword: "not the password", newPassword: "another long passphrase" })).toMatchObject({ ok: false, error: { code: "invalid_credentials" } });
  });

  it("a session of a user disabled behind the application's back is still refused", async () => {
    const token = await sessionFor("owner@example.com");
    await db.pool.query("UPDATE users SET status = 'disabled', disabled_at = now()");
    expect((await auth(token)).context.actor.kind).toBe("anonymous");
  });

  it("disabling a user kills their sessions at once", async () => {
    const ownerCtx = (await auth(await sessionFor("owner@example.com"))).context;
    await identity.users.createUser(ownerCtx, { email: "staff@example.com", password: PASSWORD });
    const staffToken = await sessionFor("staff@example.com", "198.51.100.5");
    expect((await auth(staffToken)).context.actor.kind).toBe("user");
    const staffId = (await db.pool.query("SELECT id FROM users WHERE email_normalized = 'staff@example.com'")).rows[0].id;
    await identity.users.setUserStatus(ownerCtx, { userId: staffId, status: "disabled" });
    expect((await auth(staffToken)).context.actor.kind).toBe("anonymous");
  });
});

describe("RBAC", () => {
  async function staff() {
    const ownerCtx = (await auth(await sessionFor("owner@example.com"))).context;
    await identity.users.createUser(ownerCtx, { email: "staff@example.com", password: PASSWORD });
    const id = (await db.pool.query("SELECT id FROM users WHERE email_normalized = 'staff@example.com'")).rows[0].id as string;
    return { ownerCtx, id };
  }

  beforeEach(async () => {
    await owner();
  });

  it("denies by default, audits the denial, and allows after a role is granted", async () => {
    const { ownerCtx, id } = await staff();
    const ctx = () => auth(null).then(async () => (await auth(await sessionFor("staff@example.com", `198.51.100.${Math.floor(Math.random() * 200)}`))).context);

    const before = await ctx();
    await expect(before.authorize(IDENTITY_PERMISSIONS.usersManage)).rejects.toMatchObject({ code: "forbidden" });
    expect(await before.can(IDENTITY_PERMISSIONS.usersManage)).toBe(false);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE type = 'authz.denied'")).toBe(1);

    await identity.users.assignRole(ownerCtx, { userId: id, roleKey: "identity_admin" });
    const after = await ctx();
    await expect(after.authorize(IDENTITY_PERMISSIONS.usersManage)).resolves.toBeUndefined();
    // identity_admin does not include roles.manage.
    await expect(after.authorize(IDENTITY_PERMISSIONS.rolesManage)).rejects.toMatchObject({ code: "forbidden" });

    await identity.users.revokeRole(ownerCtx, { userId: id, roleKey: "identity_admin" });
    await expect(after.authorize(IDENTITY_PERMISSIONS.usersManage)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("anonymous callers are unauthenticated, not forbidden", async () => {
    const { context } = await auth(null);
    await expect(context.authorize(IDENTITY_PERMISSIONS.usersRead)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("a disabled user keeps no permissions even with an existing context", async () => {
    const { ownerCtx, id } = await staff();
    await identity.users.assignRole(ownerCtx, { userId: id, roleKey: "identity_admin" });
    const staffCtx = (await auth(await sessionFor("staff@example.com", "198.51.100.77"))).context;
    await expect(staffCtx.authorize(IDENTITY_PERMISSIONS.usersRead)).resolves.toBeUndefined();
    await identity.users.setUserStatus(ownerCtx, { userId: id, status: "disabled" });
    await expect(staffCtx.authorize(IDENTITY_PERMISSIONS.usersRead)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("scoped role grants apply only to their scope", async () => {
    const { id } = await staff();
    const [{ id: roleId }] = (await db.pool.query("SELECT id FROM roles WHERE key = 'identity_admin'")).rows;
    await db.pool.query("INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'branch', 'tehran')", [id, roleId]);
    const ctx = (await auth(await sessionFor("staff@example.com", "198.51.100.66"))).context;
    await expect(ctx.authorize(IDENTITY_PERMISSIONS.usersRead, { type: "branch", id: "tehran" })).resolves.toBeUndefined();
    await expect(ctx.authorize(IDENTITY_PERMISSIONS.usersRead, { type: "branch", id: "shiraz" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(ctx.authorize(IDENTITY_PERMISSIONS.usersRead)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("protects the last owner from being disabled or demoted, and allows it once a second exists", async () => {
    const { ownerCtx, id } = await staff();
    const ownerId = (await db.pool.query("SELECT id FROM users WHERE email_normalized = 'owner@example.com'")).rows[0].id as string;
    expect(await identity.users.setUserStatus(ownerCtx, { userId: ownerId, status: "disabled" })).toMatchObject({ ok: false, error: { code: "last_owner" } });
    expect(await identity.users.revokeRole(ownerCtx, { userId: ownerId, roleKey: "owner" })).toMatchObject({ ok: false, error: { code: "last_owner" } });
    await identity.users.assignRole(ownerCtx, { userId: id, roleKey: "owner" });
    expect(await identity.users.revokeRole(ownerCtx, { userId: ownerId, roleKey: "owner" })).toMatchObject({ ok: true });
    // Now staff is the only owner.
    const staffCtx = (await auth(await sessionFor("staff@example.com", "198.51.100.55"))).context;
    expect(await identity.users.setUserStatus(staffCtx, { userId: id, status: "disabled" })).toMatchObject({ ok: false, error: { code: "last_owner" } });
  });

  it("two owners cannot demote each other at the same time", async () => {
    const { ownerCtx, id } = await staff();
    const ownerId = (await db.pool.query("SELECT id FROM users WHERE email_normalized = 'owner@example.com'")).rows[0].id as string;
    await identity.users.assignRole(ownerCtx, { userId: id, roleKey: "owner" });
    const staffCtx = (await auth(await sessionFor("staff@example.com", "198.51.100.44"))).context;
    // The loser is refused either by the last-owner rule or because it just lost its own permission.
    const results = await Promise.allSettled([
      identity.users.revokeRole(ownerCtx, { userId: id, roleKey: "owner" }),
      identity.users.revokeRole(staffCtx, { userId: ownerId, roleKey: "owner" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.ok)).toHaveLength(1);
    expect(
      await count("SELECT count(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'owner'"),
    ).toBe(1);
  });
});
