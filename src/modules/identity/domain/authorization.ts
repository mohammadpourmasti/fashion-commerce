import type { Permission, Scope } from "@/shared/kernel/authorization";

export interface Grant {
  readonly permission: string;
  readonly scopeType: string;
  readonly scopeId: string;
}

/**
 * A grant satisfies a request when the permission is equal and either the grant is global
 * or its scope equals the requested one. There are no wildcards and no implicit hierarchy.
 */
export function grantAllows(grant: Grant, permission: Permission, scope: Scope): boolean {
  if (grant.permission !== permission) return false;
  if (grant.scopeType === "global") return true;
  return "id" in scope && grant.scopeType === scope.type && grant.scopeId === scope.id;
}

export function anyGrantAllows(grants: readonly Grant[], permission: Permission, scope: Scope): boolean {
  return grants.some((grant) => grantAllows(grant, permission, scope));
}
