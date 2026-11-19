-- ============================================================================
-- Migration 009: purchases (supplier invoices with their lines and prices)
--
-- Adds one new, independent table. No existing table or row is changed.
-- Idempotent (CREATE TABLE IF NOT EXISTS): safe to run more than once.
-- deploy-cloudflare.ps1 runs schema.sql (which contains this table) on every
-- deploy, and the Worker also creates it on first use, so no manual step is needed.
-- ============================================================================

-- المشتريات (009): فاتورة مورد واحدة لكل صف. data = JSON: البنود (الاسم، الرمز، الكمية، الوحدة، سعر الوحدة
-- قبل الضريبة بعد الخصم، الضريبة، الإجمالي، الفئة، الصنف المرتبط) والإجماليات. للإدارة فقط (costs.view_all).
CREATE TABLE IF NOT EXISTS purchases (
  id           TEXT PRIMARY KEY,
  supplier     TEXT NOT NULL,
  invoice_no   TEXT,
  invoice_date TEXT,
  data         TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS purchases_date_idx ON purchases(invoice_date);
