-- ============================================================================
-- Migration 008: employee custody receipts (cash handed to an employee)
--
-- Adds one new, independent table. No existing table or row is changed.
-- Idempotent (CREATE TABLE IF NOT EXISTS): safe to run more than once.
-- deploy-cloudflare.ps1 runs schema.sql (which contains this table) on every
-- deploy, and the Worker also creates it on first use, so no manual step is needed.
-- ============================================================================

-- عهدة الموظف (008): كل مبلغ يستلمه موظف (user_id) ليصرف منه. created_by من سجّله (هو أو المالك)،
-- وcreated_at وقت التسجيل تلقائياً. مصروفات الموظف المسجّلة بعد أول استلام تُخصم من الرصيد.
CREATE TABLE IF NOT EXISTS custody_receipts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  amount     REAL NOT NULL DEFAULT 0,
  note       TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS custody_receipts_user_idx ON custody_receipts(user_id);
