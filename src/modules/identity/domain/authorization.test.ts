import { describe, expect, it } from "vitest";

import { anyGrantAllows, grantAllows, type Grant } from "./authorization";
import { identityCatalog, IDENTITY_PERMISSIONS } from "./catalog";
import { mergeCatalogs } from "@/shared/kernel/authorization";

const global = (permission: string): Grant => ({ permission, scopeType: "global", scopeId: "" });
const scoped = (permission: string, scopeType: string, scopeId: string): Grant => ({ permission, scopeType, scopeId });

describe("grantAllows", () => {
  it("a global grant satisfies global and scoped requests for the same permission only", () => {
    const grant = global("inventory:stock.read");
    expect(grantAllows(grant, "inventory:stock.read", { type: "global" })).toBe(true);
    expect(grantAllows(grant, "inventory:stock.read", { type: "location", id: "L1" })).toBe(true);
    expect(grantAllows(grant, "inventory:stock.write", { type: "global" })).toBe(false);
  });

  it("a scoped grant satisfies only the identical scope", () => {
    const grant = scoped("inventory:stock.read", "location", "L1");
    expect(grantAllows(grant, "inventory:stock.read", { type: "location", id: "L1" })).toBe(true);
    expect(grantAllows(grant, "inventory:stock.read", { type: "location", id: "L2" })).toBe(false);
    expect(grantAllows(grant, "inventory:stock.read", { type: "warehouse", id: "L1" })).toBe(false);
    expect(grantAllows(grant, "inventory:stock.read", { type: "global" })).toBe(false);
  });

  it("has no prefix or wildcard matching", () => {
    expect(grantAllows(global("identity:users"), "identity:users.read", { type: "global" })).toBe(false);
    expect(grantAllows(global("identity:users.*"), "identity:users.read", { type: "global" })).toBe(false);
  });

  it("anyGrantAllows is false for no grants (deny by default)", () => {
    expect(anyGrantAllows([], "identity:users.read", { type: "global" })).toBe(false);
    expect(anyGrantAllows([global("x:y")], "identity:users.read", { type: "global" })).toBe(false);
  });
});

describe("identity catalog", () => {
  it("is internally consistent and its constants cover every permission", () => {
    const merged = mergeCatalogs(identityCatalog);
    expect(merged.permissions.map((p) => p.key).sort()).toEqual(Object.values(IDENTITY_PERMISSIONS).sort());
    expect(merged.roles.find((r) => r.key === "owner")?.permissions).toBe("*");
  });
});
