import { describe, expect, it, vi } from "vitest";

import {
  ANONYMOUS,
  AuthorizationError,
  createRequestContext,
  isPermission,
  mergeCatalogs,
  type Actor,
  type Authorizer,
  type Permission,
  type Scope,
} from "./authorization";

const user: Actor = { kind: "user", userId: "u1", sessionId: "s1" };

function authorizerReturning(result: boolean) {
  const isAllowed = vi.fn<Authorizer["isAllowed"]>(async () => result);
  return { authorizer: { isAllowed } satisfies Authorizer, isAllowed };
}

describe("isPermission", () => {
  it.each(["identity:users.manage", "catalog:products.read", "a:b"])("accepts %s", (key) => {
    expect(isPermission(key)).toBe(true);
  });
  it.each(["", "identity", "Identity:users", "identity:", ":x", "a:b c", "a:b;drop", "x".repeat(101) + ":y"])(
    "rejects %j",
    (key) => {
      expect(isPermission(key)).toBe(false);
    },
  );
});

describe("createRequestContext", () => {
  it("anonymous actors are refused as unauthenticated without asking the authorizer", async () => {
    const { authorizer, isAllowed } = authorizerReturning(true);
    const ctx = createRequestContext({ requestId: "r", actor: ANONYMOUS, authorizer });
    await expect(ctx.authorize("identity:users.read")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(ctx.can("identity:users.read")).resolves.toBe(false);
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it("allows when the authorizer allows, passing actor, permission and the global scope by default", async () => {
    const { authorizer, isAllowed } = authorizerReturning(true);
    const ctx = createRequestContext({ requestId: "r", actor: user, authorizer });
    await expect(ctx.authorize("identity:users.read")).resolves.toBeUndefined();
    expect(isAllowed).toHaveBeenCalledWith(user, "identity:users.read", { type: "global" });
  });

  it("forwards an explicit scope", async () => {
    const { authorizer, isAllowed } = authorizerReturning(true);
    const ctx = createRequestContext({ requestId: "r", actor: user, authorizer });
    const scope: Scope = { type: "location", id: "L1" };
    await ctx.authorize("inventory:stock.read", scope);
    expect(isAllowed).toHaveBeenCalledWith(user, "inventory:stock.read", scope);
  });

  it("denies with a client-safe message and structured details", async () => {
    const { authorizer } = authorizerReturning(false);
    const ctx = createRequestContext({ requestId: "r", actor: user, authorizer });
    const error = await ctx.authorize("identity:roles.manage").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({ code: "forbidden", message: "Forbidden", permission: "identity:roles.manage" });
    await expect(ctx.can("identity:roles.manage")).resolves.toBe(false);
  });

  it("reports denials to onDenied, and a throwing hook cannot change the outcome", async () => {
    const { authorizer } = authorizerReturning(false);
    const seen: string[] = [];
    const ctx = createRequestContext({
      requestId: "r",
      actor: user,
      authorizer,
      onDenied: (event) => {
        seen.push(`${event.code}:${event.permission}`);
        throw new Error("audit store down");
      },
    });
    await expect(ctx.authorize("identity:audit.read")).rejects.toMatchObject({ code: "forbidden" });
    expect(seen).toEqual(["forbidden:identity:audit.read"]);
  });

  it("an authorizer error propagates (fail closed, never an implicit allow)", async () => {
    const authorizer: Authorizer = {
      isAllowed: async () => {
        throw new Error("db down");
      },
    };
    const ctx = createRequestContext({ requestId: "r", actor: user, authorizer });
    await expect(ctx.authorize("identity:users.read")).rejects.toThrow("db down");
  });
});

describe("mergeCatalogs", () => {
  const perm = (key: Permission) => ({ key, description: key });

  it("merges, resolves '*' lazily and keeps order", () => {
    const merged = mergeCatalogs(
      { permissions: [perm("a:read")], roles: [{ key: "owner", name: "Owner", description: "", permissions: "*" }] },
      { permissions: [perm("b:read")], roles: [{ key: "reader", name: "Reader", description: "", permissions: ["b:read"] }] },
    );
    expect(merged.permissions.map((p) => p.key)).toEqual(["a:read", "b:read"]);
    expect(merged.roles.map((r) => r.key)).toEqual(["owner", "reader"]);
  });

  it("rejects duplicates, bad keys and unknown permission references", () => {
    expect(() => mergeCatalogs({ permissions: [perm("a:read"), perm("a:read")], roles: [] })).toThrow(/Duplicate permission/);
    expect(() => mergeCatalogs({ permissions: [perm("Bad:Key" as Permission)], roles: [] })).toThrow(/Invalid permission/);
    expect(() =>
      mergeCatalogs({ permissions: [], roles: [{ key: "Bad Role", name: "x", description: "", permissions: [] }] }),
    ).toThrow(/Invalid role key/);
    expect(() =>
      mergeCatalogs({ permissions: [], roles: [{ key: "r1", name: "x", description: "", permissions: ["nope:x"] }] }),
    ).toThrow(/unknown permission/);
    expect(() =>
      mergeCatalogs(
        { permissions: [], roles: [{ key: "r1", name: "x", description: "", permissions: [] }] },
        { permissions: [], roles: [{ key: "r1", name: "y", description: "", permissions: [] }] },
      ),
    ).toThrow(/Duplicate role/);
  });
});
