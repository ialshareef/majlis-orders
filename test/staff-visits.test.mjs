/* دخول الموظفين للتطبيق (الهجرة 007: staff_visits) — الخادم على SQLite حقيقية + محرّك التقرير.
   يغطي: التسجيل عند فتح التطبيق (/api/bootstrap) · المزامنة كل 30 ثانية لا تُعدّ فتحاً · فتح جديد بعد غياب 30 دقيقة ·
   الكتابة مرة كل 5 دقائق على الأكثر · كل موظف صف مستقل · الأسماء في /api/owner-analytics و/api/link-visits ·
   الموظف المحذوف · الصلاحية (المالك فقط) · عمود «الموظفون» وجدول «دخول الموظفين للتطبيق» في التقرير. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from './_d1-sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(import.meta.url);
const Reports = require(path.join(root, 'js', 'reports.js'));
const worker = (await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8')).toString('base64'))).default;

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };

/* ساعة مضبوطة: ظهر اليوم بتوقيت الرياض (09:00 UTC) حتى لا يعبر الاختبار منتصف الليل */
const realNow = Date.now;
const BASE = Date.parse(new Date().toISOString().slice(0, 10) + 'T09:00:00.000Z');
let off = 0;
Date.now = () => BASE + off;
const MIN = 60000;

const DB = new SqliteD1();
const schema = fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8');
DB.exec(schema);
DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
DB.exec('CREATE TABLE IF NOT EXISTS link_visits (day TEXT NOT NULL, link TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, link))');
DB.exec('CREATE TABLE IF NOT EXISTS link_visitors (day TEXT NOT NULL, link TEXT NOT NULL, fp TEXT NOT NULL, PRIMARY KEY (day, link, fp))');
ok(/CREATE TABLE IF NOT EXISTS staff_visits/.test(schema) && fs.existsSync(path.join(root, 'worker', 'migrations', '007_staff_visits.sql')), 'schema: جدول staff_visits في schema.sql وملف الهجرة 007');
const T0 = '2026-01-01T00:00:00.000Z', FUT = new Date(realNow() + 864e5 * 30).toISOString();
for (const [id, name, r] of [['u-own', 'فواز', 'admin'], ['u-adm', 'خالد', 'admin'], ['u-st', 'سعد', 'staff'], ['u-gone', 'محذوف', 'staff']]) {
  DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES (?,?,?,?,?,1,?)').run(id, id, name, 'x', r, T0);
  DB.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run('t-' + id, id, T0, FUT);
}
const env = { DB, OWNER_USER_ID: 'u-own', ALLOWED_ORIGIN: 'https://x.test' };
const get = async (tk, p) => { const r = await worker.fetch(new Request('https://x.test' + p, { headers: { 'x-session-token': tk } }), env); return { s: r.status, b: await r.json().catch(() => null) }; };
const row = (u) => DB.db.prepare('SELECT * FROM staff_visits WHERE user_id = ?').get(u);
const today = new Date(BASE + 180 * MIN).toISOString().slice(0, 10);

/* 1) التسجيل */
let r = await get('t-u-st', '/api/bootstrap');
ok(r.s === 200, 'bootstrap: يعمل كما هو للموظف', r.s);
let x = row('u-st');
ok(x && x.n === 1 && x.day === today && x.first_at === x.last_at, 'أول فتح ← صف لليوم بتوقيت المحل، مرة واحدة', x);
off += 30 * 1000; await get('t-u-st', '/api/bootstrap');
off += 30 * 1000; await get('t-u-st', '/api/bootstrap');
x = row('u-st');
ok(x.n === 1 && x.last_at === new Date(BASE).toISOString(), 'المزامنة كل 30 ثانية لا تُعدّ فتحاً ولا تكتب في القاعدة', x);
off = 6 * MIN; await get('t-u-st', '/api/bootstrap');
x = row('u-st');
ok(x.n === 1 && x.last_at === new Date(BASE + 6 * MIN).toISOString(), 'بعد 6 دقائق نشاط ← يُحدَّث «آخر نشاط» فقط', x);
off = 6 * MIN + 40 * MIN; await get('t-u-st', '/api/bootstrap');
x = row('u-st');
ok(x.n === 2, 'غياب 40 دقيقة ثم فتح ← مرة فتح ثانية', x);
off = 50 * MIN; await get('t-u-adm', '/api/bootstrap'); await get('t-u-gone', '/api/bootstrap');
ok(row('u-adm') && row('u-adm').n === 1 && row('u-st').n === 2, 'كل موظف صف مستقل');
DB.db.prepare("UPDATE staff_visits SET user_id = 'u-deleted' WHERE user_id = 'u-gone'").run();
r = await get('', '/api/bootstrap');
ok(r.s === 401 && DB.db.prepare('SELECT COUNT(*) AS c FROM staff_visits').get().c === 3, 'بلا جلسة ← 401 ولا يُسجَّل شيء');
// يوم سابق للفترات
DB.db.prepare("INSERT INTO staff_visits (day, user_id, n, first_at, last_at) VALUES ('2020-01-01', 'u-own', 4, 'a', '2020-01-01T10:00:00.000Z')").run();

/* 2) القراءة */
r = await get('t-u-own', '/api/link-visits');
const S = r.b && r.b.staff;
ok(r.s === 200 && S && S.today.users === 3 && S.today.opens === 4 && S.d30.users === 3, '/api/link-visits: اليوم 3 موظفين و4 مرات فتح (القديم خارج الفترة)', S);
const byName = Object.fromEntries((S.byUser || []).map((u) => [u.name, u]));
ok(byName['سعد'] && byName['سعد'].opens === 2 && byName['سعد'].days === 1 && byName['خالد'].opens === 1, '/api/link-visits: تفصيل بالاسم (سعد: مرتان)', S.byUser);
ok(byName['مستخدم محذوف'], 'موظف محذوف يظهر «مستخدم محذوف» بدل اسم فارغ', Object.keys(byName));
ok(S.byUser[0].name === 'خالد' || S.byUser[0].name === 'مستخدم محذوف', 'الترتيب: الأحدث دخولاً أولاً', S.byUser.map((u) => u.name));
r = await get('t-u-own', '/api/owner-analytics?range=custom&from=' + today + '&to=' + today);
ok(r.s === 200 && r.b.staffDaily.length === 1 && r.b.staffDaily[0].users === 3 && r.b.staffDaily[0].opens === 4 && r.b.staffByUser.length === 3, '/api/owner-analytics: staffDaily وstaffByUser للفترة', { d: r.b && r.b.staffDaily, n: r.b && r.b.staffByUser.length });
r = await get('t-u-own', '/api/owner-analytics?range=custom&from=2019-12-01&to=2020-02-01');
ok(r.b.staffByUser.length === 1 && r.b.staffByUser[0].name === 'فواز' && r.b.staffByUser[0].opens === 4, 'الفترة القديمة: فقط ما فيها', r.b.staffByUser);
ok((await get('t-u-adm', '/api/link-visits')).s === 403 && (await get('t-u-st', '/api/owner-analytics?range=d30')).s === 403, 'الصلاحية: المدير العادي والموظف ← 403');
const body = JSON.stringify((await get('t-u-own', '/api/link-visits')).b);
ok(!/password|token|t-u-/.test(body), 'لا تُكشف كلمات مرور ولا جلسات في الرد');

/* 3) محرّك التقرير */
Date.now = realNow;
const ctx = {
  orders: [], expenses: [], users: [], from: '2026-11-01', to: '2026-11-03', today: '2026-11-03', me: 'o', scopeAll: true,
  perms: { visits: true, profitAny: true, commAny: true, expenses: true, profit: () => true, comm: () => true },
  calc: { revenue: () => 0, cost: () => 0, breakdown: () => null, ordDate: (o) => o.createdAt, payDay: () => '', expDay: () => '' },
  labels: { STATUS: {}, PAY_METHOD: {}, ROLES: {} }, userName: () => '', userRole: () => '',
  visits: {
    ready: true, links: { customer: 'بوابة العميل' },
    visitsDaily: [{ day: '2026-11-02', link: 'customer', n: 5 }], visitorsDaily: [{ day: '2026-11-02', u: 3 }],
    staffDaily: [{ day: '2026-11-02', users: 2, opens: 5 }, { day: '2026-11-03', users: 1, opens: 1 }],
    staffByUser: [{ name: 'سعد', days: 2, opens: 4, lastAt: '2026-11-03T08:00:00.000Z' }, { name: 'خالد', days: 1, opens: 2, lastAt: '2026-11-02T08:00:00.000Z' }],
    funnel: { steps: [] },
  },
};
const rep = Reports.build('visits', ctx);
const daily = rep.tables[0];
ok(daily.columns.some((c) => c.key === 'staff' && c.label === 'الموظفون'), 'التقرير: عمود «الموظفون» في الزيارات يوماً بيوم', daily.columns.map((c) => c.label));
const dd = Object.fromEntries(daily.rows.map((r2) => [r2.date, r2.staff]));
ok(dd['2026-11-01'] === 0 && dd['2026-11-02'] === 2 && dd['2026-11-03'] === 1, 'التقرير: عدد الموظفين لكل يوم (اليوم بلا دخول صفر)', dd);
const st = rep.tables.find((t) => t.title === 'دخول الموظفين للتطبيق');
ok(st && st.rows.length === 2 && st.rows[0].name === 'سعد' && st.rows[0].opens === 4 && st.rows[0].last === '2026-11-03' && st.totals.opens === 6, 'التقرير: جدول «دخول الموظفين للتطبيق» بالأسماء والإجماليات', st);
ok(rep.summary.some((s) => s.label === 'موظفون دخلوا التطبيق' && s.value === 2), 'التقرير: ملخص «موظفون دخلوا التطبيق» = 2');
const empty = Reports.build('visits', Object.assign({}, ctx, { visits: Object.assign({}, ctx.visits, { staffDaily: undefined, staffByUser: undefined }) }));
ok(empty.tables[0].rows.every((r2) => r2.staff === 0) && empty.tables.find((t) => t.title === 'دخول الموظفين للتطبيق').rows.length === 0, 'التقرير: بيانات خادم قديم بلا الحقول الجديدة ← أصفار بلا أخطاء');

console.log(`\n=== staff-visits: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
