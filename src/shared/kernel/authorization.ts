/**
 * Authorization contracts shared by every module (ADR-016).
 *
 * Catalog, inventory and the other business modules never import the identity
 * module. They receive a `RequestContext` and call `ctx.authorize(...)`; identity
 * implements the `Authorizer` port and the composition root wires the two together.
 * Deny by default: anything that is not explicitly allowed is refused.
 */

/** "<resource>:<action>", e.g. "identity:users.manage". */
export type Permission = `${string}:${string}`;

export const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_.]*$/;

export function isPermission(value: string): value is Permission {
  return value.length <= 100 && PERMISSION_PATTERN.test(value);
}

/**
 * Where a permission applies. A grant with global scope satisfies any scope; a scoped grant
 * (for example a branch or warehouse, defined by the module that owns it) satisfies only
 * the same scope. A request without a scope is global and needs a global grant.
 */
export type Scope = { readonly type: "global" } | { readonly type: string; readonly id: string };

export const GLOBAL_SCOPE: Scope = { type: "global" };

export type Actor =
  | { readonly kind: "anonymous" }
  | { readonly kind: "user"; readonly userId: string; readonly sessionId: string }
  /** Trusted in-process work (jobs, CLI). Created only by code that already runs with full trust. */
  | { readonly kind: "system"; readonly name: string };

export const ANONYMOUS: Actor = { kind: "anonymous" };

/** Decides whether an actor holds a permission in a scope. Implemented by the identity module. */
export interface Authorizer {
  isAllowed(actor: Actor, permission: Permission, scope: Scope): Promise<boolean>;
}

export type AuthorizationFailure = "unauthenticated" | "forbidden";

export class AuthorizationError extends Error {
  readonly code: AuthorizationFailure;
  readonly permission: Permission;
  readonly scope: Scope;

  constructor(code: AuthorizationFailure, permission: Permission, scope: Scope) {
    // The message is safe to show to a client; details stay in the properties for server logs.
    super(code === "unauthenticated" ? "Authentication required" : "Forbidden");
    this.name = "AuthorizationError";
    this.code = code;
    this.permission = permission;
    this.scope = scope;
  }
}

export interface RequestContext {
  readonly requestId: string;
  readonly actor: Actor;
  /** Client address as determined by trusted infrastructure, or null when unknown. */
  readonly ip: string | null;
  /** True when the actor holds the permission. Never throws for a denial. */
  can(permission: Permission, scope?: Scope): Promise<boolean>;
  /** Resolves when allowed; throws AuthorizationError otherwise. */
  authorize(permission: Permission, scope?: Scope): Promise<void>;
}

export interface RequestContextOptions {
  requestId: string;
  actor: Actor;
  ip?: string | null;
  authorizer: Authorizer;
  /** Called for every denial after the decision is made. Must not throw into the caller. */
  onDenied?: (event: { actor: Actor; permission: Permission; scope: Scope; code: AuthorizationFailure }) => void | Promise<void>;
}

export function createRequestContext(options: RequestContextOptions): RequestContext {
  const { requestId, actor, authorizer, onDenied } = options;
  const ip = options.ip ?? null;

  const deny = async (code: AuthorizationFailure, permission: Permission, scope: Scope): Promise<never> => {
    if (onDenied) {
      try {
        await onDenied({ actor, permission, scope, code });
      } catch {
        // A failing audit hook must not turn a denial into an allow or a different error.
      }
    }
    throw new AuthorizationError(code, permission, scope);
  };

  return {
    requestId,
    actor,
    ip,
    async can(permission, scope = GLOBAL_SCOPE) {
      if (actor.kind === "anonymous") return false;
      return authorizer.isAllowed(actor, permission, scope);
    },
    async authorize(permission, scope = GLOBAL_SCOPE) {
      if (actor.kind === "anonymous") return deny("unauthenticated", permission, scope);
      const allowed = await authorizer.isAllowed(actor, permission, scope);
      if (!allowed) return deny("forbidden", permission, scope);
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog: what permissions exist and which system roles bundle them. Each module
// contributes its own; the composition root merges them and identity stores the result.
// ---------------------------------------------------------------------------

export interface PermissionDefinition {
  readonly key: Permission;
  readonly description: string;
}

export interface RoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** "*" means every permission in the merged catalog. */
  readonly permissions: "*" | readonly Permission[];
}

export interface AuthorizationCatalog {
  readonly permissions: readonly PermissionDefinition[];
  readonly roles: readonly RoleDefinition[];
}

export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

/** Merges catalogs and rejects duplicates, bad keys and roles that reference unknown permissions. */
export function mergeCatalogs(...catalogs: readonly AuthorizationCatalog[]): AuthorizationCatalog {
  const permissions = new Map<string, PermissionDefinition>();
  const roles = new Map<string, RoleDefinition>();
  for (const catalog of catalogs) {
    for (const permission of catalog.permissions) {
      if (!isPermission(permission.key)) throw new Error(`Invalid permission key: ${permission.key}`);
      if (permissions.has(permission.key)) throw new Error(`Duplicate permission: ${permission.key}`);
      permissions.set(permission.key, permission);
    }
    for (const role of catalog.roles) {
      if (!ROLE_KEY_PATTERN.test(role.key)) throw new Error(`Invalid role key: ${role.key}`);
      if (roles.has(role.key)) throw new Error(`Duplicate role: ${role.key}`);
      roles.set(role.key, role);
    }
  }
  for (const role of roles.values()) {
    if (role.permissions === "*") continue;
    for (const key of role.permissions) {
      if (!permissions.has(key)) throw new Error(`Role ${role.key} references unknown permission ${key}`);
    }
  }
  return { permissions: [...permissions.values()], roles: [...roles.values()] };
}
