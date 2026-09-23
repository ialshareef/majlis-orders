-- ============================================================================
-- أصالة نجد | نظام إدارة طلبات المجالس — قاعدة بيانات Cloudflare D1
-- شغّل هذا الملف كاملاً مرة واحدة في: Workers & Pages > D1 > (قاعدتك) > Console
-- (يمكن إعادة تشغيله بأمان)
-- المستخدم الافتراضي admin / admin يُنشأ تلقائياً عند أول طلب للـ Worker
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
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
