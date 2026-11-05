-- ============================================================================
-- Migration 005: إشعارات واتساب اليدوية (WhatsApp Click to Chat عبر wa.me)
--
-- مجانية بالكامل: النظام يجهّز الرسالة ويفتح محادثة المستلم، والمستخدم يضغط «إرسال»
-- بنفسه في واتساب. لا WhatsApp Cloud API ولا أي خدمة مدفوعة ولا أتمتة إرسال.
--
-- جداول جديدة فقط (CREATE … IF NOT EXISTS): لا تعديل ولا حذف لأي جدول أو صف قائم،
-- فهي آمنة للتكرار. نفس التعريفات منسوخة في worker/schema.sql (يشغّله سكربت النشر
-- قبل رفع الكود)، فتطبيق هذا الملف يدوياً غير لازم على قاعدة يُنشر عليها بالسكربت.
--
--   wa_recipients        المستلمون (20 كحد أقصى — يفرضه الخادم ومشغّل القاعدة معاً)
--   wa_event_recipients  من يستلم كل نوع تنبيه (اختيار مستقل لكل حدث)
--   wa_templates         نص القالب المعدّل لكل نوع (غيابه = القالب الافتراضي في الكود)
--   wa_events            التنبيهات الناتجة عن أحداث محفوظة فعلاً (معرّف ثابت يمنع التكرار)
--   wa_sends             جلسة إرسال: الرسالة النهائية ومن بدأها
--   wa_log               سجل كل مستلم في الجلسة وحالته (لا ادعاء بوصول الرسالة)
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_recipients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,            -- صيغة دولية أرقاماً فقط بلا + (مثل 9665XXXXXXXX)
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- الحد الأقصى 20 مستلماً على مستوى القاعدة أيضاً (حماية إضافية من السباق بين طلبين)
CREATE TRIGGER IF NOT EXISTS wa_recipients_max
BEFORE INSERT ON wa_recipients
WHEN (SELECT COUNT(*) FROM wa_recipients) >= 20
BEGIN
  SELECT RAISE(ABORT, 'wa_recipients limit 20');
END;

CREATE TABLE IF NOT EXISTS wa_event_recipients (
  event_type   TEXT NOT NULL CHECK (event_type IN ('order_created', 'payment_received', 'expense_created', 'order_status')),
  recipient_id TEXT NOT NULL,
  PRIMARY KEY (event_type, recipient_id)
  -- بلا مفتاح أجنبي: الحذف يتم صراحةً من الخادم في نفس الدفعة مع حذف المستلم
);
CREATE INDEX IF NOT EXISTS wa_event_recipients_rcpt_idx ON wa_event_recipients(recipient_id);

CREATE TABLE IF NOT EXISTS wa_templates (
  event_type TEXT PRIMARY KEY CHECK (event_type IN ('order_created', 'payment_received', 'expense_created', 'order_status')),
  body       TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_events (
  id              TEXT PRIMARY KEY,           -- ثابت من الحدث نفسه (مثل order_created:<id>) فلا يتكرر
  type            TEXT NOT NULL,
  order_id        TEXT,
  order_number    INTEGER,
  ref_id          TEXT,                       -- معرّف الدفعة أو المصروف
  data            TEXT NOT NULL,              -- قيم متغيرات القالب وقت الحدث (JSON)
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dismissed')),
  created_by      TEXT,
  created_by_name TEXT,
  created_at      TEXT NOT NULL,
  handled_by      TEXT,
  handled_at      TEXT
);
CREATE INDEX IF NOT EXISTS wa_events_created_idx ON wa_events(created_at);
CREATE INDEX IF NOT EXISTS wa_events_status_idx ON wa_events(status);

CREATE TABLE IF NOT EXISTS wa_sends (
  id              TEXT PRIMARY KEY,
  event_id        TEXT,
  event_type      TEXT NOT NULL,
  order_number    INTEGER,
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'finished')),
  created_by      TEXT,
  created_by_name TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_sends_created_idx ON wa_sends(created_at);

CREATE TABLE IF NOT EXISTS wa_log (
  id             TEXT PRIMARY KEY,
  send_id        TEXT NOT NULL,
  seq            INTEGER NOT NULL,            -- ترتيب المستلم داخل الجلسة (1 من N)
  recipient_id   TEXT,
  recipient_name TEXT NOT NULL,               -- نسخة نصية تبقى بعد حذف المستلم
  phone          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'opened', 'confirmed', 'skipped', 'failed')),
  opened_at      TEXT,                        -- وقت فتح المحادثة (آخر فتح)
  confirmed_at   TEXT,                        -- وقت تأكيد المستخدم يدوياً — لا تأكيد من واتساب
  updated_by     TEXT,
  updated_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_log_send_idx ON wa_log(send_id);
CREATE INDEX IF NOT EXISTS wa_log_created_idx ON wa_log(created_at);
