-- ============================================================================
-- Migration 004: expense date + optional link to an order
--
-- Adds expenses.expense_date (YYYY-MM-DD, the day the expense happened) and
-- expenses.order_id (optional link to an order). Existing rows get their
-- expense_date from created_at. No row is deleted or changed otherwise.
--
-- When to apply: only on a database whose expenses table lacks these columns
-- (created before this migration). Fresh installs get them from schema.sql.
-- deploy-cloudflare.ps1 stops before uploading code when the columns are missing.
--
-- NOT re-runnable: ALTER TABLE ADD COLUMN fails if the column already exists.
-- Run it ONCE, after a backup. Do not run 003 after this file (003 rebuilds
-- expenses with the pre-004 columns).
-- ============================================================================

ALTER TABLE expenses ADD COLUMN expense_date TEXT;
ALTER TABLE expenses ADD COLUMN order_id TEXT;

UPDATE expenses SET expense_date = substr(created_at, 1, 10) WHERE expense_date IS NULL;
