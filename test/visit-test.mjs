/* اختبار إحصاءات زيارات الروابط — يعمل على الحزمة المبنية (نسخة الإنتاج).
   تشغيل:  node test/visit-test.mjs   (من مجلد المشروع)
   يستخدم sql.js كقاعدة D1 محلية ويتحقق من:
     1) العدّ اليومي التراكمي يزيد صحيحاً
     2) الروبوتات/المكشّفون/المتصفحات المخفية (Headless) لا تُحتسب
     3) صفحات الأصول و/api وواجهة الموظفين لا تُسجَّل
     4) صف (day,link,n) صحيح الشكل
     5) /api/link-visits محمي بـ requireAdmin (بلا جلسة => 401)
     6) نافذة ٣٠ يوماً تستبعد الأيام القديمة */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SQL = await initSqlJs();
const sqlite = new SQL.Database();
sqlite.exec(fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8'));
const norm = (v) => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
const DB = {
  prepare(sql) {
    const st = { sql, args: [] };
    st.bind = (...a) => { st.args = a.map(norm); return st; };
    st.first = async () => { const s = sqlite.prepare(sql); s.bind(st.args); const h = s.step(); const r = h ? s.getAsObject() : null; s.free(); return r; };
    st.all = async () => { const s = sqlite.prepare(sql); s.bind(st.args); const o = []; while (s.step()) o.push(s.getAsObject()); s.free(); return { results: o, success: true }; };
    st.run = async () => { sqlite.run(sql, st.args); return { success: true }; };
    return st;
  },
  async batch(s) { const o = []; for (const x of s) o.push(await x.run()); return o; },
};
/* نستورد الحزمة عبر data: URL لأن الامتداد .js يُحمَّل كـ CommonJS في Node،
   والحزمة تستخدم export default (ESM). */
const bundleSrc = fs.readFileSync(path.join(root, 'worker', 'worker.bundle.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundleSrc, 'utf8').toString('base64'));
const env = { DB };
const UA = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36';
const hit = (p, ua) => mod.default.fetch(new Request('https://majlis.test' + p, ua ? { headers: { 'user-agent': ua } } : {}), env);
const totalOf = async (link) => {
  const r = await DB.prepare('SELECT COALESCE(SUM(n),0) AS t FROM link_visits WHERE link = ?').bind(link).first();
  return Number(r.t) || 0;
};

let pass = 0, fail = 0;
const t = (n, ok, info) => {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (info ? '  [' + info + ']' : ''));
};

// 1) العدّ التراكمي
await hit('/customer-design', UA);
t('customer=1 بعد زيارة واحدة', (await totalOf('customer')) === 1, 'n=' + (await totalOf('customer')));
await hit('/customer-design', UA);
await hit('/customer-design/', UA);
t('customer=3 بعد ثلاث زيارات', (await totalOf('customer')) === 3, 'n=' + (await totalOf('customer')));
await hit('/customer-design-expanded', UA);
t('expanded=1', (await totalOf('expanded')) === 1, 'n=' + (await totalOf('expanded')));

// 2) الروبوتات لا تُحتسب
const bots = ['Googlebot/2.1', 'bingbot/2.0', 'Mozilla/5.0 (compatible; YandexBot/3.0)', 'curl/8.4.0',
  'wget/1.21', 'python-requests/2.31', 'facebookexternalhit/1.1', 'WhatsApp/2.1', 'TelegramBot',
  'Discordbot/2.0', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120',
  'SemrushBot/7~bl', 'AhrefsBot/7.0', 'PetalBot'];
for (const b of bots) await hit('/customer-design', b);
t('الروبوتات لا تُحتسب (يبقى 3)', (await totalOf('customer')) === 3, 'n=' + (await totalOf('customer')) + ' بعد ' + bots.length + ' روبوت');
await hit('/customer-design', '');
t('الطلب بلا UA لا يُحتسب', (await totalOf('customer')) === 3, 'n=' + (await totalOf('customer')));

// 3) صفحات غير الزوار لا تُسجَّل
for (const p of ['/', '/index.html', '/portal.html', '/portal-expanded.html', '/css/style.css', '/js/app.js', '/api/app-update', '/foo']) {
  await hit(p, UA);
}
t('صفحات الأصول والموظفين لا تُسجَّل', (await totalOf('customer')) === 3 && (await totalOf('expanded')) === 1,
  'c=' + (await totalOf('customer')) + ' e=' + (await totalOf('expanded')));

// 4) صف (day,link,n)
const row = await DB.prepare('SELECT day, link, n FROM link_visits WHERE link = ?').bind('customer').first();
t('شكل الصف (day,link,n)', !!row && /^\d{4}-\d{2}-\d{2}$/.test(row.day) && row.link === 'customer' && Number(row.n) === 3, JSON.stringify(row));
t('جدول link_visits مبني بمفتاح (day,link)', !!sqlite.exec("SELECT sql FROM sqlite_master WHERE name='link_visits'")[0].values[0][0].includes('PRIMARY KEY (day, link)'));

// 5) الحماية
const unauth = await hit('/api/link-visits', UA);
t('/api/link-visits بلا جلسة => 401', unauth.status === 401, 'status=' + unauth.status);
const src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
t('المسار محاط بـ requireAdmin', /'\/api\/link-visits'[\s\S]{0,40}requireAdmin\(user\)/.test(src));

// 6) نافذة ٣٠ يوماً
await DB.prepare('INSERT OR REPLACE INTO link_visits (day, link, n) VALUES (?,?,?)').bind('2000-01-01', 'customer', 99).run();
const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
const recent = await DB.prepare('SELECT COALESCE(SUM(n),0) AS t FROM link_visits WHERE day >= ?').bind(since).first();
// داخل النافذة: customer=3 اليوم + expanded=1 اليوم = 4 (سطر 2000 مستبعد)
t('نافذة ٣٠ يوماً تستبعد القديم', Number(recent.t) === 4, 't=' + recent.t + ' (يجب 4 لا 103)');

console.log('\nPASS=' + pass + '  FAIL=' + fail);
process.exit(fail ? 1 : 0);