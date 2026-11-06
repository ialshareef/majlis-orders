-- ============================================================================
-- Migration 006: link WhatsApp recipients to user accounts
--
-- Adds one new, independent table. No existing table or row is changed.
-- Idempotent (CREATE TABLE IF NOT EXISTS): safe to run more than once.
-- deploy-cloudflare.ps1 runs schema.sql (which contains this table) on every
-- deploy, and the Worker also creates it on start, so no manual step is needed.
-- ============================================================================

-- ربط مستلمي واتساب بالمستخدمين (الهجرة 006): مستلم واحد على الأكثر لكل مستخدم.
-- الرقم والأحداث في صف wa_recipients نفسه؛ هذا الجدول يحفظ الربط فقط (حذف المستخدم يحذف مستلمه في الخادم).
CREATE TABLE IF NOT EXISTS wa_recipient_users (
  recipient_id TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL UNIQUE
);
