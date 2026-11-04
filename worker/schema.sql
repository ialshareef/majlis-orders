-- ============================================================================
-- أصالة نجد | نظام إدارة طلبات المجالس — قاعدة بيانات Cloudflare D1
-- شغّل هذا الملف كاملاً مرة واحدة في: Workers & Pages > D1 > (قاعدتك) > Console
-- (يمكن إعادة تشغيله بأمان)
-- المستخدم الأول يُنشأ عند أول طلب على قاعدة خالية، وكلمة مروره الأولى تأتي حصرياً من
-- متغير بيئة الخادم `ADMIN_INIT_PASSWORD` (لا كلمة مرور افتراضية ثابتة في الكود).
-- يُفرض تغيير كلمة المرور عند أول دخول.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  parent_id     TEXT,
  rate          REAL,
  parent_rate   REAL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  number        INTEGER,
  status        TEXT,
  customer_name TEXT,
  created_by    TEXT,
  created_at    TEXT,
  data          TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
CREATE INDEX IF NOT EXISTS orders_number_idx ON orders(number);

CREATE TABLE IF NOT EXISTS activity (
  id   TEXT PRIMARY KEY,
  at   TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_at_idx ON activity(at);

-- محاولات الدخول الفاشلة (الحد من تخمين كلمات المرور). يُنشئه الـ Worker تلقائياً أيضاً.
CREATE TABLE IF NOT EXISTS login_fail (
  k        TEXT PRIMARY KEY,   -- u:<اسم المستخدم> أو ip:<العنوان>
  n        INTEGER NOT NULL,
  first_at TEXT NOT NULL,
  until    TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- عدّاد أرقام الطلبات (أول طلب = 1001)
INSERT OR IGNORE INTO counters (key, value) VALUES ('order_no', 1000);

-- ============================================================================
-- بوابة العميل: جدول مستقل (لا يمس الطلبات/المستخدمين). الرقم العام تسلسلي
-- (أول رقم = MJ-26000127)، والتوكن عشوائي آمن منفصل يُولَّد في الـ Worker.
-- ============================================================================
CREATE TABLE IF NOT EXISTS customer_designs (
  id                TEXT PRIMARY KEY,
  public_no         INTEGER UNIQUE,
  token             TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'draft',
  design            TEXT NOT NULL,
  customer_name     TEXT,
  customer_phone    TEXT,
  contact_requested INTEGER NOT NULL DEFAULT 0,
  order_id          TEXT,
  order_number      INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT
);
CREATE INDEX IF NOT EXISTS designs_token_idx ON customer_designs(token);
CREATE INDEX IF NOT EXISTS designs_public_idx ON customer_designs(public_no);

-- عدّاد أرقام التصاميم (أول رقم = MJ-26000127)
INSERT OR IGNORE INTO counters (key, value) VALUES ('design_no', 26000126);

-- الإعدادات الافتراضية
INSERT OR IGNORE INTO settings (id, data, updated_at) VALUES (1,
  '{"shopName":"أصالة نجد","phone":"","address":"","currency":"ر.س","vatEnabled":true,"vatRate":15,"vatNumber":"","invoiceNote":"","cornerMode":"deduct"}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- الأصناف الافتراضية
INSERT OR IGNORE INTO items (id, data, updated_at) VALUES
  ('sofa-qatifa',  '{"id":"sofa-qatifa","name":"كنب عربي - قطيفة","category":"sofa","unit":"m","price":450,"depth":0.8,"fabric":"قطيفة","color":"#8b5a2b","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sofa-mukhmal', '{"id":"sofa-mukhmal","name":"كنب عربي - مخمل","category":"sofa","unit":"m","price":550,"depth":0.8,"fabric":"مخمل","color":"#5b2c6f","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sofa-jild',    '{"id":"sofa-jild","name":"كنب عربي - جلد","category":"sofa","unit":"m","price":700,"depth":0.85,"fabric":"جلد طبيعي","color":"#2c3e50","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sofa-kattan',  '{"id":"sofa-kattan","name":"كنب عربي - كتان","category":"sofa","unit":"m","price":400,"depth":0.75,"fabric":"كتان","color":"#a67c52","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('acc-balot',    '{"id":"acc-balot","name":"طاولة بلوت","category":"acc","unit":"pc","price":350,"w":0.9,"h":0.6,"shape":"rect","color":"#6d4c41","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('acc-marka',    '{"id":"acc-marka","name":"مركى","category":"acc","unit":"pc","price":80,"w":0.6,"h":0.35,"shape":"rect","color":"#c0392b","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('acc-mkhada',   '{"id":"acc-mkhada","name":"مخدة","category":"acc","unit":"pc","price":45,"w":0.45,"h":0.45,"shape":"rect","color":"#d35400","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('acc-side',     '{"id":"acc-side","name":"طاولة جانبية","category":"acc","unit":"pc","price":120,"w":0.5,"h":0.5,"shape":"circle","color":"#7f8c8d","active":true}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ═══════════════════ تحليلات لوحة المالك ═══════════════════
-- جدول عدّادات مجمّعة فقط: يوم + اسم حدث + بُعد اختياري + رقم.
-- لا اسم عميل ولا رقم جوال ولا عنوان IP ولا بصمة جهاز ولا مُعرّف جلسة:
-- ما يُخزَّن هنا لا يصلح لربط أي حدث بهوية أحد. تُنشأ تلقائياً من الخادم
-- (ensureAnalytics) وهذا السطر لتوثيق المخطط فقط.
CREATE TABLE IF NOT EXISTS analytics_events (
  day  TEXT    NOT NULL,
  name TEXT    NOT NULL,
  dim  TEXT    NOT NULL DEFAULT '',
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, dim)
);
CREATE INDEX IF NOT EXISTS analytics_events_name_day_idx ON analytics_events(name, day);

-- Permission Manager tables (idempotent)
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
  reason         TEXT
  -- بلا مفاتيح أجنبية عمداً: السجل للإلحاق فقط (المشغّلان أدناه يمنعان أي UPDATE)، و ON DELETE SET NULL
  -- يُنفَّذ UPDATE فيُفشل حذف أي مستخدم ورد في السجل. المعرّف والاسم يُحفظان نصّاً ويبقيان بعد الحذف.
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
  updated_at    TEXT NOT NULL, expense_date TEXT, order_id TEXT
  -- created_by بلا مفتاح أجنبي (مثل orders.created_by): المصروف يبقى منسوباً لصاحبه بعد حذفه.
  -- (NOT NULL مع ON DELETE SET NULL كان يُفشل حذف أي مستخدم له مصروفات)
  -- expense_date (YYYY-MM-DD) تاريخ المصروف نفسه، وorder_id ربط اختياري بطلب (الهجرة 004)
);

CREATE INDEX IF NOT EXISTS expenses_created_at_idx ON expenses(created_at);
CREATE INDEX IF NOT EXISTS expenses_created_by_idx ON expenses(created_by);
