-- Reverts 0002_identity. Every DROP TABLE is preceded by a guard that aborts the whole
-- transaction if the table still holds rows. Once the authorization catalog has been
-- synchronised, roles/permissions are non-empty and this down is refused by design.

SELECT fc_assert_table_empty('auth_throttle');
DROP TABLE auth_throttle;

SELECT fc_assert_table_empty('audit_events');
DROP TABLE audit_events;

SELECT fc_assert_table_empty('user_roles');
DROP TABLE user_roles;

SELECT fc_assert_table_empty('role_permissions');
DROP TABLE role_permissions;

SELECT fc_assert_table_empty('permissions');
DROP TABLE permissions;

SELECT fc_assert_table_empty('roles');
DROP TABLE roles;

SELECT fc_assert_table_empty('sessions');
DROP TABLE sessions;

SELECT fc_assert_table_empty('credentials');
DROP TABLE credentials;

SELECT fc_assert_table_empty('users');
DROP TABLE users;
