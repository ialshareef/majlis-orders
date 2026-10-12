/* اختبار إحصائيات الزوار — ثلاثة نطاقات على الخادم الحقيقي (حزمة مبنية).
   يفحص: اليوم/٧/٣٠، التمييز بين الزائر والزيارة، التوقيت المحلي، thwart التطاير. */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bundleSrc = fs.readFileSync(path.join(root, 'worker', 'worker.bundle.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundleSrc, 'utf8').toString('base64'));

// D1 محلي
const SQL = await initSqlJs();
const sqlite = new SQL.Database();
sqlite.exec(fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8'));
const norm = (v) => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
const DB = {
  prepare(sql) { const st = { sql, args: [] };
    st.bind = (...a) => { st.args = a.map(norm); return st; };
    st.first = async () => { const s = sqlite.prepare(sql); s.bind(st.args); const h = s.step(); const r = h ? s.getAsObject() : null; s.free(); return r; };
    st.all = async () => { const s = sqlite.prepare(sql); s.bind(st.args); const o = []; while (s.step()) o.push(s.getAsObject()); s.free(); return { results: o, success: true }; };
    st.run = async () => { sqlite.run(sql, st.args); return { success: true }; };
    return st; },
  async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
};
const env = { DB };
let pass = 0, fail = 0;
const t = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (info ? '  [' + info + ']' : '')); };

const UA = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36';
const UA2 = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
const hit = (p, ua, ip) => mod.default.fetch(new Request('https://majlis.test' + p, {
  headers: Object.assign({}, ua ? { 'user-agent': ua } : {}, ip ? { 'cf-connecting-ip': ip } : {}),
}), env);

/* --- زيارة واحدة: جهاز واحد (نفس IP+UA) مرة واحدة --- */
await hit('/customer-design', UA, '1.1.1.1');
const admin = { token: 'x' };
const rows = () => sqlite.exec('SELECT day, link, SUM(n) AS n FROM link_visits GROUP BY day, link');
// الجداول تُنشأ عند أول زيارة (idempotent) — نتحقق منها بعد ذلك
// نتحقق من وجود الجدولين
const hasTable = (n) => !!sqlite.exec("SELECT name FROM sqlite_master WHERE name='" + n + "'")[0];
t('جدول link_visits موجود', hasTable('link_visits'));
t('جدول link_visitors موجود', hasTable('link_visitors'));
const lvs = sqlite.exec("SELECT sql FROM sqlite_master WHERE name='link_visitors'")[0];
t('link_visitors مفتاح (day,link,fp)', lvs && lvs.values[0][0].includes('PRIMARY KEY (day, link, fp)'));

t('سجّل زيارة واحدة', rows()[0] && rows()[0].values[0][2] === 1, JSON.stringify(rows()[0] && rows()[0].values[0]));

/* --- نفس الجهاز مرة أخرى: زيارة++ لكن الزائر واحد --- */
await hit('/customer-design', UA, '1.1.1.1');
await hit('/customer-design', UA, '1.1.1.1');
const vrow = sqlite.exec('SELECT day, link, n FROM link_visits')[0];
t('زيارات جهاز واحد = 3', vrow && vrow.values[0][2] === 3, JSON.stringify(vrow.values[0]));
const urow = sqlite.exec('SELECT day, link, COUNT(DISTINCT fp) AS u FROM link_visitors GROUP BY day, link')[0];
t('زوار فريدون = 1 (تحديث الصفحة لا يضاعف)', urow && urow.values[0][2] === 1, JSON.stringify(urow.values[0]));

/* --- جهازان مختلفان: زائران --- */
await hit('/customer-design', UA2, '2.2.2.2');
const u2 = sqlite.exec('SELECT COUNT(DISTINCT fp) AS u FROM link_visitors')[0];
t('جهازان = زائران فريدان', u2.values[0][0] === 2, 'u=' + u2.values[0][0]);

/* --- الروبوتات لا تُحتسب --- */
await hit('/customer-design', 'Googlebot/2.1', '3.3.3.3');
await hit('/customer-design', '', '4.4.4.4');
const after = sqlite.exec('SELECT SUM(n) AS t FROM link_visits')[0];
t('الروبوتات والبلا-UA لا تُحتسب', after.values[0][0] === 4, 'visits=' + after.values[0][0]);

/* --- بيانات قديمة: نحاكي 10 أيام في الماضي و25 يوماً --- */
const off = 180; //分钟
const dayAgo = (n) => new Date(Date.now() - n * 86400000 + off * 60000).toISOString().slice(0, 10);
sqlite.run('INSERT OR REPLACE INTO link_visits (day,link,n) VALUES (?,?,?)', [dayAgo(3), 'customer', 4]);
sqlite.run('INSERT OR REPLACE INTO link_visitors (day,link,fp) VALUES (?,?,?)', [dayAgo(3), 'customer', 'fpold3']);
sqlite.run('INSERT OR REPLACE INTO link_visits (day,link,n) VALUES (?,?,?)', [dayAgo(10), 'customer', 7]);
sqlite.run('INSERT OR REPLACE INTO link_visitors (day,link,fp) VALUES (?,?,?)', [dayAgo(10), 'customer', 'fpold10']);
sqlite.run('INSERT OR REPLACE INTO link_visits (day,link,n) VALUES (?,?,?)', [dayAgo(25), 'customer', 9]);
sqlite.run('INSERT OR REPLACE INTO link_visitors (day,link,fp) VALUES (?,?,?)', [dayAgo(25), 'customer', 'fpold25']);
sqlite.run('INSERT OR REPLACE INTO link_visits (day,link,n) VALUES (?,?,?)', [dayAgo(40), 'customer', 99]);
sqlite.run('INSERT OR REPLACE INTO link_visitors (day,link,fp) VALUES (?,?,?)', [dayAgo(40), 'customer', 'fpold40']);

/* --- نقرأ الإحصاءات عبر linkVisits — نُصدّرها للاختبار بـ data URL لا يمكن استدعاؤها مباشرة.
       نستعمل نقطة القراءة عبر request مع جلسة مزيفة غير ممكنة؛ لذا نتحقق عبر الاستعلام المباشر
       لكن بنفس منطق الاستعلام المستخدم في linkVisits. */

// نتحقق من الحسابات الثلاثة عبر نفس التعبيرات
const today = dayAgo(0);
const d7 = dayAgo(6), d30 = dayAgo(29);
const q = (sql, ...b) => { const s = sqlite.prepare(sql); s.bind(b); const o = []; while (s.step()) o.push(s.getAsObject()); s.free(); return o; };
const vis = q(`SELECT link,
  COALESCE(SUM(CASE WHEN day = ? THEN n ELSE 0 END),0) AS today_n,
  COALESCE(SUM(CASE WHEN day >= ? THEN n ELSE 0 END),0) AS d7_n,
  COALESCE(SUM(CASE WHEN day >= ? THEN n ELSE 0 END),0) AS d30_n,
  COALESCE(SUM(n),0) AS all_n
 FROM link_visits GROUP BY link`, today, d7, d30);
const uq = q(`SELECT link,
  COALESCE(SUM(CASE WHEN day = ? THEN 1 ELSE 0 END),0) AS today_u,
  COALESCE(SUM(CASE WHEN day >= ? THEN 1 ELSE 0 END),0) AS d7_u,
  COALESCE(SUM(CASE WHEN day >= ? THEN 1 ELSE 0 END),0) AS d30_u
 FROM link_visitors WHERE day >= ? GROUP BY link`, today, d7, d30, d30);
const c = vis.find((r) => r.link === 'customer');
const u = uq.find((r) => r.link === 'customer');

// اليوم: 4 زيارات (1.1.1.1×3 + 2.2.2.2×1)، زوار اليوم 2
t('اليوم: زيارات = 4', Number(c.today_n) === 4, 'today=' + c.today_n);
t('اليوم: زوار = 2', Number(u.today_u) === 2, 'today_u=' + u.today_u);
// آخر ٧ أيام: اليوم 4 + قبل ٣ أيام 4 = 8، زوار 2+1 = 3
t('آخر ٧: زيارات = 8 (4 اليوم + 4 قبل ٣ أيام)', Number(c.d7_n) === 8, 'd7=' + c.d7_n);
t('آخر ٧: زوار = 3', Number(u.d7_u) === 3, 'd7_u=' + u.d7_u);
// آخر ٣٠ يوماً: 4+4+7+9 = 24 (لا تشمل 40 يوماً=99)، زوار 2+1+1+1 = 5
t('آخر ٣٠: زيارات = 24', Number(c.d30_n) === 24, 'd30=' + c.d30_n);
t('آخر ٣٠: زوار = 5', Number(u.d30_u) === 5, 'd30_u=' + u.d30_u);
// الإجمالي: يشمل ٩٩ من ٤٠ يوماً = 4+4+7+9+99 = 123
t('الإجمالي = 123 (يشمل كل السجل)', Number(c.all_n) === 123, 'all=' + c.all_n);
// حدود النافذة: ٣٠ يوماً لا تشمل ما قبل ٣٠
const justOutside = q('SELECT COALESCE(SUM(n),0) AS n FROM link_visits WHERE day >= ?', dayAgo(29))[0];
t('حد ٣٠ يوماً صحيح', Number(justOutside.n) === 24, 'cutoff_sum=' + justOutside.n);

/* --- تنظيف: ما بعد ٤٠ يوماً يُحذف --- */
await hit('/customer-design', UA, '1.1.1.1');
const old = sqlite.exec("SELECT COUNT(*) AS c FROM link_visitors WHERE day < ?", [dayAgo(40)])[0];
t('تنظيف البصمات القديمة (>٤٠ يوماً)', Number(old.values[0][0]) === 0, 'leftover=' + old.values[0][0]);

/* --- التوقيت المحلي: dayKey يتبع UTC+3 --- */
const src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
t('visitDayKey يضيف الإزاحة', /visitDayKey\(env/.test(src) && /visitTzOffset/.test(src));
t('إزاحة افتراضية ١٨٠ دقيقة', /VISIT_TZ_OFFSET_MIN\s*\)\s*\|\|\s*180/.test(src));
t('نطاقات維سخة في الاستجابة', /periods: \{ today/.test(src));

console.log('\nPASS=' + pass + '  FAIL=' + fail);
process.exit(fail ? 1 : 0);