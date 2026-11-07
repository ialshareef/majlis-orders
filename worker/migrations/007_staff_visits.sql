-- ============================================================================
-- Migration 007: staff app opens (who opened the staff app, per day)
--
-- Adds one new, independent table. No existing table or row is changed.
-- Idempotent (CREATE TABLE IF NOT EXISTS): safe to run more than once.
-- deploy-cloudflare.ps1 runs schema.sql (which contains this table) on every
-- deploy, and the Worker also creates it on first use, so no manual step is needed.
-- ============================================================================

-- فتح الموظفين للتطبيق (007): صف لكل موظف في كل يوم بتوقيت المحل. n = مرات الفتح
-- (فتح جديد بعد غياب 30 دقيقة؛ المزامنة الدورية لا تُحتسب)، و first_at/last_at أول وآخر نشاط في اليوم.
CREATE TABLE IF NOT EXISTS staff_visits (
  day      TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  n        INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at  TEXT NOT NULL,
  PRIMARY KEY (day, user_id)
);
