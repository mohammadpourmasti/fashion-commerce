-- 0002_identity: users, credentials, sessions, RBAC, audit log, login throttle.
-- Roles and permissions are NOT seeded here: they are defined in code and synchronised
-- idempotently at startup, so this migration stays reversible by its guarded down.sql.
-- No other module may reference these tables with a foreign key (ADR-016).

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email text NOT NULL,
  email_normalized text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT users_email_normalized_unique UNIQUE (email_normalized),
  CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_disabled_consistent CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT users_display_name_length CHECK (display_name IS NULL OR char_length(display_name) <= 120)
);

CREATE TABLE credentials (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_hash_format CHECK (password_hash ~ '^scrypt\$N=[0-9]+,r=[0-9]+,p=[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text,
  rotated_from uuid REFERENCES sessions (id) ON DELETE SET NULL,
  user_agent text,
  ip_hash text,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT sessions_revoked_reason_valid CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'rotated', 'password_changed', 'user_disabled', 'admin', 'expired')),
  CONSTRAINT sessions_user_agent_length CHECK (user_agent IS NULL OR char_length(user_agent) <= 256)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_key_unique UNIQUE (key),
  CONSTRAINT roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$')
);

CREATE TABLE permissions (
  key text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  CONSTRAINT permissions_key_format CHECK (key ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_.]*$' AND char_length(key) <= 100)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  permission_key text NOT NULL REFERENCES permissions (key) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  scope_type text NOT NULL DEFAULT 'global',
  scope_id text NOT NULL DEFAULT '',
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  PRIMARY KEY (user_id, role_id, scope_type, scope_id),
  CONSTRAINT user_roles_scope_consistent CHECK ((scope_type = 'global') = (scope_id = '')),
  CONSTRAINT user_roles_scope_type_format CHECK (scope_type ~ '^[a-z][a-z0-9_]{0,62}$')
);
CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- Append-only: the application role is only granted SELECT and INSERT.
-- No FK to users so the history survives any future account removal.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  subject_type text,
  subject_id text,
  outcome text NOT NULL,
  ip_hash text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_type_format CHECK (type ~ '^[a-z][a-z0-9_.]{0,99}$'),
  CONSTRAINT audit_events_actor_type_valid CHECK (actor_type IN ('anonymous', 'user', 'system')),
  CONSTRAINT audit_events_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied', 'throttled')),
  CONSTRAINT audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 4096)
);
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at);
CREATE INDEX audit_events_type_idx ON audit_events (type, occurred_at);

CREATE TABLE auth_throttle (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key_hash),
  CONSTRAINT auth_throttle_scope_valid CHECK (scope IN ('account', 'account_ip')),
  CONSTRAINT auth_throttle_count_nonnegative CHECK (count >= 0)
);
CREATE INDEX auth_throttle_updated_at_idx ON auth_throttle (updated_at);

SELECT fc_app_grant('users', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('credentials', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('roles', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('permissions', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('sessions', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('auth_throttle', 'SELECT, INSERT, UPDATE, DELETE');
SELECT fc_app_grant('role_permissions', 'SELECT, INSERT, DELETE');
SELECT fc_app_grant('user_roles', 'SELECT, INSERT, DELETE');
SELECT fc_app_grant('audit_events', 'SELECT, INSERT');
