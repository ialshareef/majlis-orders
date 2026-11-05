/* D1 فوق SQLite حقيقية (node:sqlite) لتشغيل الخادم الحقيقي في Node على قاعدة اختبار مؤقتة.
   بخلاف _d1-mem.mjs: SQL كاملة بقيودها (UNIQUE وCHECK والمشغّلات) ودفعات ذرّية فعلية (BEGIN/ROLLBACK)
   — مثل D1 الذي هو SQLite. لا اتصال بأي خدمة ولا بيانات إنتاج: القاعدة في الذاكرة أو ملف مؤقت. */
import { DatabaseSync } from 'node:sqlite';

const val = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class SqliteD1 {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.failNextBatch = null;   // للاختبار: رسالة خطأ تُسقط الدفعة التالية (محاكاة فشل الحفظ)
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const self = this;
    const mk = (args) => ({
      _run() { return self.db.prepare(sql).run(...args.map(val)); },
      async first(col) { const r = self.db.prepare(sql).get(...args.map(val)); return r === undefined ? null : (col ? r[col] : { ...r }); },
      async all() { return { results: self.db.prepare(sql).all(...args.map(val)).map((r) => ({ ...r })), success: true }; },
      async run() { const r = self.db.prepare(sql).run(...args.map(val)); return { success: true, meta: { changes: Number(r.changes) } }; },
    });
    const st = mk([]);
    st.bind = (...a) => mk(a);
    return st;
  }
  async batch(list) {
    if (this.failNextBatch) { const m = this.failNextBatch; this.failNextBatch = null; throw new Error(m); }
    // للاختبار: failBatchAt = n يُسقط الدفعة رقم n من الآن (1 = التالية)، وbatchSizes يسجّل حجم كل دفعة
    if (this.batchSizes) this.batchSizes.push(list.length);
    if (this.failBatchAt) { this.failBatchAt -= 1; if (this.failBatchAt === 0) { this.failBatchAt = null; throw new Error('D1_ERROR: simulated failure of a later chunk'); } }
    this.db.exec('BEGIN');
    try {
      const out = list.map((s) => { const r = s._run(); return { success: true, meta: { changes: Number(r.changes) } }; });
      this.db.exec('COMMIT');
      return out;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
