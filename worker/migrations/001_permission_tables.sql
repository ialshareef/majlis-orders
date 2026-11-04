-- ============================================================================
-- Permission Manager — Migration 001: permission tables
-- Safe/idempotent. Run on an existing D1 database. No data changes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    TEXT NOT NULL,
  permission TEXT NOT NULL,
  value      INTEGER NOT NULL CHECK (value IN (0, 1)),
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS user_permissions_user_idx ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS user_permissions_perm_idx ON user_permissions(permission);

CREATE TABLE IF NOT EXISTS permission_audit (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  actor_user_id  TEXT,
  actor_name     TEXT,
  target_user_id TEXT,
  target_name    TEXT,
  change_type    TEXT NOT NULL CHECK (change_type IN ('permission', 'role', 'active', 'defaults_restore')),
  permission     TEXT,
  old_value      TEXT,
  new_value      TEXT,
  reason         TEXT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS permission_audit_target_idx ON permission_audit(target_user_id);
CREATE INDEX IF NOT EXISTS permission_audit_at_idx ON permission_audit(at);

-- Append-only protection for permission_audit (database-level).
CREATE TRIGGER IF NOT EXISTS permission_audit_no_update
BEFORE UPDATE ON permission_audit
BEGIN
  SELECT RAISE(ABORT, 'permission_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS permission_audit_no_delete
BEFORE DELETE ON permission_audit
BEGIN
  SELECT RAISE(ABORT, 'permission_audit is append-only');
END;
