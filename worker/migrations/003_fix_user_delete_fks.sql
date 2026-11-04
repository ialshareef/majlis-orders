-- ============================================================================
-- Migration 003: fix foreign keys that block deleting a user
--
-- The 001/002 definitions break user deletion when foreign keys are enforced (D1 enforces them):
--   - permission_audit: ON DELETE SET NULL performs an UPDATE, and the append-only
--     trigger rejects every UPDATE -> deleting any user in the audit log fails.
--   - expenses: created_by is NOT NULL with ON DELETE SET NULL -> deleting any user
--     who owns an expense fails.
-- Fix: rebuild both tables WITHOUT those foreign keys (same as orders.created_by). Rows are
-- preserved; the IDs and names stay as text after the user is deleted.
--
-- When to apply: only if 001/002 were applied with their original definitions. Fresh installs
-- get the correct definitions from schema.sql directly. deploy-cloudflare.ps1 stops
-- (before uploading code) when it detects the old definitions, and tells you to run this file.
-- Safe to rerun: on correct tables it rebuilds them with the same definitions and the same data.
-- Take a backup first (D1 Time Travel or an export), then run it ONCE as a single
-- execution (D1 console or the D1 query API). It does not touch any other table.
-- ============================================================================

-- ---------- permission_audit ----------
ALTER TABLE permission_audit RENAME TO permission_audit__old003;

CREATE TABLE permission_audit (
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
  reason         TEXT
);

INSERT INTO permission_audit (id, at, actor_user_id, actor_name, target_user_id, target_name, change_type, permission, old_value, new_value, reason)
  SELECT id, at, actor_user_id, actor_name, target_user_id, target_name, change_type, permission, old_value, new_value, reason
  FROM permission_audit__old003;

-- Dropping the old table also drops its indexes and triggers (DROP TABLE fires no triggers).
DROP TABLE permission_audit__old003;

CREATE INDEX IF NOT EXISTS permission_audit_target_idx ON permission_audit(target_user_id);
CREATE INDEX IF NOT EXISTS permission_audit_at_idx ON permission_audit(at);

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

-- ---------- expenses ----------
ALTER TABLE expenses RENAME TO expenses__old003;

CREATE TABLE expenses (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  amount        REAL NOT NULL DEFAULT 0,
  category      TEXT,
  note          TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

INSERT INTO expenses (id, name, amount, category, note, created_by, created_at, updated_at)
  SELECT id, name, amount, category, note, created_by, created_at, updated_at
  FROM expenses__old003;

DROP TABLE expenses__old003;

CREATE INDEX IF NOT EXISTS expenses_created_at_idx ON expenses(created_at);
CREATE INDEX IF NOT EXISTS expenses_created_by_idx ON expenses(created_by);
