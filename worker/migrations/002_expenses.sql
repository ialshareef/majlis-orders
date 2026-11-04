-- ============================================================================
-- نظام إدارة طلبات المجالس — جدول المصروفات (الهجرة 002)
-- آمن للتكرار (idempotent). لا يضيف بيانات افتراضية ولا يعدل بيانات قائمة.
-- ============================================================================

CREATE TABLE IF NOT EXISTS expenses (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  amount        REAL NOT NULL DEFAULT 0,
  category      TEXT,
  note          TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS expenses_created_at_idx ON expenses(created_at);
CREATE INDEX IF NOT EXISTS expenses_created_by_idx ON expenses(created_by);
