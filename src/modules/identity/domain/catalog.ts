import type { AuthorizationCatalog, Permission } from "@/shared/kernel/authorization";

/** Permissions owned by the identity module. Other modules declare their own catalogs. */
export const IDENTITY_PERMISSIONS = {
  usersRead: "identity:users.read",
  usersManage: "identity:users.manage",
  rolesManage: "identity:roles.manage",
  sessionsRevoke: "identity:sessions.revoke",
  auditRead: "identity:audit.read",
} as const satisfies Record<string, Permission>;

export const OWNER_ROLE = "owner";

export const identityCatalog: AuthorizationCatalog = {
  permissions: [
    { key: IDENTITY_PERMISSIONS.usersRead, description: "View staff accounts" },
    { key: IDENTITY_PERMISSIONS.usersManage, description: "Create, disable and enable staff accounts" },
    { key: IDENTITY_PERMISSIONS.rolesManage, description: "Assign and remove roles" },
    { key: IDENTITY_PERMISSIONS.sessionsRevoke, description: "Revoke other users' sessions" },
    { key: IDENTITY_PERMISSIONS.auditRead, description: "Read the security audit log" },
  ],
  roles: [
    { key: OWNER_ROLE, name: "Owner", description: "Every permission, including those added later", permissions: "*" },
    {
      key: "identity_admin",
      name: "Identity administrator",
      description: "Manage staff accounts and sessions; read the audit log",
      permissions: [
        IDENTITY_PERMISSIONS.usersRead,
        IDENTITY_PERMISSIONS.usersManage,
        IDENTITY_PERMISSIONS.sessionsRevoke,
        IDENTITY_PERMISSIONS.auditRead,
      ],
    },
  ],
};
