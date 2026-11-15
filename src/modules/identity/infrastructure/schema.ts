import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Table definitions for identity. drizzle/0002_identity is the source of truth for the
// database; an integration test compares this file with the migrated schema.
// Keep this file free of `@/` imports: drizzle-kit loads it outside Next.js.

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    disabledAt: tz("disabled_at"),
  },
  (t) => [
    unique("users_email_normalized_unique").on(t.emailNormalized),
    check("users_status_valid", sql`${t.status} IN ('active', 'disabled')`),
    check("users_disabled_consistent", sql`(${t.status} = 'disabled') = (${t.disabledAt} IS NOT NULL)`),
    check("users_email_length", sql`char_length(${t.email}) BETWEEN 3 AND 254`),
    check("users_display_name_length", sql`${t.displayName} IS NULL OR char_length(${t.displayName}) <= 120`),
  ],
);

export const credentials = pgTable(
  "credentials",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: tz("password_changed_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "credentials_hash_format",
      sql`${t.passwordHash} ~ '^scrypt\$N=[0-9]+,r=[0-9]+,p=[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
    expiresAt: tz("expires_at").notNull(),
    rotatedAt: tz("rotated_at").notNull().defaultNow(),
    revokedAt: tz("revoked_at"),
    revokedReason: text("revoked_reason"),
    rotatedFrom: uuid("rotated_from").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
  },
  (t) => [
    unique("sessions_token_hash_unique").on(t.tokenHash),
    check("sessions_token_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("sessions_revoked_pair", sql`(${t.revokedAt} IS NULL) = (${t.revokedReason} IS NULL)`),
    check(
      "sessions_revoked_reason_valid",
      sql`${t.revokedReason} IS NULL OR ${t.revokedReason} IN ('logout', 'rotated', 'password_changed', 'user_disabled', 'admin', 'expired')`,
    ),
    check("sessions_user_agent_length", sql`${t.userAgent} IS NULL OR char_length(${t.userAgent}) <= 256`),
    index("sessions_user_active_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("roles_key_unique").on(t.key),
    check("roles_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]{1,62}$'`),
  ],
);

export const permissions = pgTable(
  "permissions",
  {
    key: text("key").primaryKey(),
    description: text("description").notNull().default(""),
  },
  (t) => [
    check(
      "permissions_key_format",
      sql`${t.key} ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_.]*$' AND char_length(${t.key}) <= 100`,
    ),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
    permissionKey: text("permission_key").notNull().references(() => permissions.key, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
    scopeType: text("scope_type").notNull().default("global"),
    scopeId: text("scope_id").notNull().default(""),
    grantedAt: tz("granted_at").notNull().defaultNow(),
    grantedBy: uuid("granted_by"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId, t.scopeType, t.scopeId] }),
    check("user_roles_scope_consistent", sql`(${t.scopeType} = 'global') = (${t.scopeId} = '')`),
    check("user_roles_scope_type_format", sql`${t.scopeType} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    occurredAt: tz("occurred_at").notNull().defaultNow(),
    type: text("type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    outcome: text("outcome").notNull(),
    ipHash: text("ip_hash"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    check("audit_events_type_format", sql`${t.type} ~ '^[a-z][a-z0-9_.]{0,99}$'`),
    check("audit_events_actor_type_valid", sql`${t.actorType} IN ('anonymous', 'user', 'system')`),
    check("audit_events_outcome_valid", sql`${t.outcome} IN ('success', 'failure', 'denied', 'throttled')`),
    check("audit_events_metadata_object", sql`jsonb_typeof(${t.metadata}) = 'object' AND pg_column_size(${t.metadata}) <= 4096`),
    index("audit_events_occurred_at_idx").on(t.occurredAt),
    index("audit_events_actor_idx").on(t.actorId, t.occurredAt),
    index("audit_events_type_idx").on(t.type, t.occurredAt),
  ],
);

export const authThrottle = pgTable(
  "auth_throttle",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStartedAt: tz("window_started_at").notNull().defaultNow(),
    count: integer("count").notNull().default(0),
    blockedUntil: tz("blocked_until"),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.keyHash] }),
    check("auth_throttle_scope_valid", sql`${t.scope} IN ('account', 'account_ip')`),
    check("auth_throttle_count_nonnegative", sql`${t.count} >= 0`),
    index("auth_throttle_updated_at_idx").on(t.updatedAt),
  ],
);
