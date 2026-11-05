/* تقرير «زيارات الموقع» — محرّك التقرير (js/reports.js) + بيانات الخادم (/api/owner-analytics) على SQLite حقيقية.
   يغطي: كل أيام الفترة بما فيها الصفر · الزوار الفريدون يومياً عبر الصفحتين (بلا عدّ مزدوج) · ما قبل 40 يوماً بلا زوار ·
   أيام الأسبوع وأعلى يوم والمتوسط والتحويل · مسار العميل · الإجماليات · الصلاحية (المالك فقط) في المحرّك والخادم. */
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

/* ---------------- 1) المحرّك ---------------- */
const base = (over = {}) => Object.assign({
  orders: [], expenses: [], users: [], from: '2026-11-01', to: '2026-11-07', today: '2026-11-07', me: 'o', scopeAll: true,
  perms: { visits: true, profitAny: true, commAny: true, expenses: true, profit: () => true, comm: () => true },
  calc: { revenue: () => 0, cost: () => 0, breakdown: () => null, ordDate: (o) => o.createdAt, payDay: () => '', expDay: () => '' },
  labels: { STATUS: {}, PAY_METHOD: {}, ROLES: {} }, userName: () => '', userRole: () => '',
}, over);
const V = {
  ready: true,
  links: { customer: 'بوابة العميل', expanded: 'التصميم الموسّع' },
  visitsDaily: [
    { day: '2026-11-01', link: 'customer', n: 10 }, { day: '2026-11-01', link: 'expanded', n: 2 },
    { day: '2026-11-03', link: 'customer', n: 30 },
    { day: '2026-11-07', link: 'customer', n: 5 }, { day: '2026-11-07', link: 'expanded', n: 1 },
    { day: '2026-10-20', link: 'customer', n: 99 },                 // خارج الفترة
  ],
  visitorsDaily: [{ day: '2026-11-01', u: 7 }, { day: '2026-11-03', u: 12 }, { day: '2026-11-07', u: 4 }],
  visitorsKeptFrom: '2026-11-02',
  funnel: { steps: [{ key: 'visit', label: 'زيارة', n: 48, rate: null }, { key: 'start', label: 'بدء تصميم', n: 20, rate: 41.7 }, { key: 'finish', label: 'إكمال التصميم', n: 9, rate: 45 }, { key: 'order', label: 'طلب مؤكد', n: 3, rate: 15 }] },
};
{
  ok(Reports.catalog(base()).map((c) => c.id).includes('visits'), 'catalog: «زيارات الموقع» للمالك');
  ok(!Reports.catalog(base({ perms: { visits: false, profitAny: true, commAny: true, expenses: true } })).map((c) => c.id).includes('visits'), 'catalog: يختفي بلا صلاحية المالك');
  let threw = false; try { Reports.build('visits', base({ perms: { visits: false } })); } catch (_) { threw = true; }
  ok(threw, 'build: مرفوض بلا صلاحية');
  const loading = Reports.build('visits', base({ visits: null }));
  ok(loading.tables.length === 0 && /جارٍ تحميل/.test(loading.summary[0].value), 'build: حالة التحميل قبل وصول البيانات');
  const err = Reports.build('visits', base({ visits: { ready: false, error: 'تعذّر' } }));
  ok(/تعذّر/.test(err.summary[0].value) && err.notes[0] === 'تعذّر', 'build: رسالة الخطأ تظهر كما هي');

  const r = Reports.build('visits', base({ visits: V }));
  const S = Object.fromEntries(r.summary.map((s) => [s.label, s.value]));
  const daily = r.tables[0];
  ok(daily.rows.length === 7 && daily.rows[0].date === '2026-11-07' && daily.rows[6].date === '2026-11-01', 'daily: كل أيام الفترة السبعة (الأحدث أولاً) بما فيها أيام الصفر', daily.rows.map((x) => x.date));
  const d2 = daily.rows.find((x) => x.date === '2026-11-02');
  ok(d2.total === 0 && d2.customer === 0 && d2.visitors === 0, 'daily: يوم بلا زيارات صفر فعلي');
  ok(daily.rows.find((x) => x.date === '2026-11-01').visitors === null, 'daily: يوم قبل حفظ بصمات الزوار ← «—» لا صفر مضلل');
  ok(daily.totals.total === 48 && daily.totals.customer === 45 && daily.totals.expanded === 3, 'daily: الإجمالي 48 (45 + 3)، وما خارج الفترة مستبعد', daily.totals);
  ok(daily.totals.visitors === 16 && S['الزوار (جهاز/يوم)'] === 16, 'summary: الزوار 16 (12 + 4، بلا يوم 11-01 غير المحفوظ)', S);
  ok(S['إجمالي الزيارات'] === 48 && S['متوسط الزيارات اليومي'] === 6.9, 'summary: الإجمالي 48 والمتوسط 6.9 يومياً', S);
  ok(S['أعلى يوم'] === '2026-11-03 (30)', 'summary: أعلى يوم 2026-11-03 بـ 30 زيارة', S['أعلى يوم']);
  ok(S['أنشط يوم في الأسبوع'] === 'الثلاثاء', 'summary: أنشط يوم في الأسبوع = الثلاثاء (2026-11-03)', S['أنشط يوم في الأسبوع']);
  ok(S['بدء تصميم'] === 20 && S['طلبات مؤكدة من التصاميم'] === 3 && S['التحويل: زيارة ← طلب'] === 6.25, 'summary: البدء 20 والطلبات 3 والتحويل 6.25٪', S);
  const byT = (re) => r.tables.find((t) => re.test(t.title));
  const wk = byT(/يوم الأسبوع/);
  ok(wk.rows.length === 7 && wk.rows[0].weekday === 'الثلاثاء' && wk.rows[0].avg === 30 && wk.totals.visits === 48 && wk.totals.days === 7, 'weekday: مرتّب بالمتوسط، وإجماليه 48 في 7 أيام', wk.rows.slice(0, 2));
  ok(byT(/مسار العميل/).rows.map((x) => x.step).join() === 'زيارة,بدء تصميم,إكمال التصميم,طلب مؤكد' && byT(/مسار العميل/).rows[3].rate === 15, 'funnel: مراحل المسار ونسبها من الخادم');
  ok(r.notes.some((n) => /40 يوماً/.test(n)) && r.notes.some((n) => /\?src=/.test(n)), 'notes: توضيح حفظ الزوار 40 يوماً وطريقة معرفة المصدر (?src=)');
  // «كل الفترات»: من أول يوم فيه بيانات
  const all = Reports.build('visits', base({ from: '', visits: V }));
  ok(all.tables[0].rows[all.tables[0].rows.length - 1].date === '2026-10-20' && all.tables[0].totals.total === 147, '«كل الفترات»: يبدأ من أول زيارة مسجّلة (2026-10-20) والإجمالي 147', all.tables[0].totals);
  // التصدير: الأرقام أرقام في Excel/CSV
  const aoa = Reports.tableAoa(daily);
  ok(typeof aoa[1][2] === 'number' && aoa[aoa.length - 1][0] === 'الإجمالي', 'export: أرقام حقيقية وصف الإجمالي');
  ok(/زيارات الموقع/.test(Reports.toCsv(r, [['المتجر', 'أصالة نجد']])), 'export: CSV بعنوان التقرير');
  // بلا زيارات إطلاقاً
  const z = Reports.build('visits', base({ visits: { ready: true, visitsDaily: [], visitorsDaily: [], funnel: { steps: [] } } }));
  ok(z.tables[0].rows.length === 7 && z.tables[0].totals.total === 0 && z.summary.find((s) => s.label === 'أعلى يوم').value === null && z.summary.find((s) => s.label === 'التحويل: زيارة ← طلب').value === null, 'empty: فترة بلا زيارات ← أصفار و«—» بلا قسمة على صفر');
}

/* ---------------- 2) الخادم: /api/owner-analytics على SQLite حقيقية ---------------- */
{
  const DB = new SqliteD1();
  DB.exec(fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8'));
  DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  DB.exec('CREATE TABLE IF NOT EXISTS link_visits (day TEXT NOT NULL, link TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, link))');
  DB.exec('CREATE TABLE IF NOT EXISTS link_visitors (day TEXT NOT NULL, link TEXT NOT NULL, fp TEXT NOT NULL, PRIMARY KEY (day, link, fp))');
  const T0 = '2026-01-01T00:00:00.000Z', FUT = new Date(Date.now() + 864e5).toISOString();
  for (const [id, r] of [['u-own', 'admin'], ['u-adm', 'admin'], ['u-st', 'staff']]) {
    DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES (?,?,?,?,?,1,?)').run(id, id, id, 'x', r, T0);
    DB.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run('t-' + id, id, T0, FUT);
  }
  const ins = DB.db.prepare('INSERT INTO link_visits (day, link, n) VALUES (?,?,?)');
  ins.run('2026-11-01', 'customer', 10); ins.run('2026-11-01', 'expanded', 2); ins.run('2026-11-03', 'customer', 30); ins.run('2026-10-01', 'customer', 5);
  const fp = DB.db.prepare('INSERT INTO link_visitors (day, link, fp) VALUES (?,?,?)');
  // الجهاز a فتح الصفحتين يوم 11-01 ← زائر واحد لا اثنان
  fp.run('2026-11-01', 'customer', 'a'); fp.run('2026-11-01', 'expanded', 'a'); fp.run('2026-11-01', 'customer', 'b'); fp.run('2026-11-03', 'customer', 'c');
  const env = { DB, OWNER_USER_ID: 'u-own', ALLOWED_ORIGIN: 'https://x.test' };
  const call = async (tk, qs) => { const r = await worker.fetch(new Request('https://x.test/api/owner-analytics?' + qs, { headers: { 'x-session-token': tk } }), env); return { s: r.status, b: await r.json().catch(() => null) }; };
  const r = await call('t-u-own', 'range=custom&from=2026-11-01&to=2026-11-05');
  ok(r.s === 200 && Array.isArray(r.b.visitsDaily) && Array.isArray(r.b.visitorsDaily), 'server: المالك يحصل على visitsDaily وvisitorsDaily', r.s);
  const vd = Object.fromEntries(r.b.visitsDaily.map((x) => [x.day + '/' + x.link, x.n]));
  ok(vd['2026-11-01/customer'] === 10 && vd['2026-11-01/expanded'] === 2 && vd['2026-11-03/customer'] === 30 && !vd['2026-10-01/customer'], 'server: الزيارات لكل يوم ولكل صفحة ضمن الفترة فقط', vd);
  const ud = Object.fromEntries(r.b.visitorsDaily.map((x) => [x.day, x.u]));
  ok(ud['2026-11-01'] === 2 && ud['2026-11-03'] === 1, 'server: الزوار الفريدون يوم 11-01 = 2 (الجهاز الذي فتح الصفحتين يُحتسب مرة)', ud);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(r.b.visitorsKeptFrom) && r.b.links && r.b.links.customer, 'server: تاريخ بدء حفظ الزوار وأسماء الصفحات');
  ok((await call('t-u-adm', 'range=d30')).s === 403 && (await call('t-u-st', 'range=d30')).s === 403 && (await call('', 'range=d30')).s === 401, 'server: المدير العادي والموظف ← 403، وبلا جلسة ← 401');
  // التقرير من استجابة الخادم الفعلية
  const rep = Reports.build('visits', base({ from: '2026-11-01', to: '2026-11-05', today: '2026-11-05', visits: Object.assign({ ready: true }, r.b, { visitorsKeptFrom: '2026-10-01' }) }));
  ok(rep.tables[0].totals.total === 42 && rep.tables[0].totals.visitors === 3 && rep.tables[0].rows.length === 5, 'end-to-end: استجابة الخادم ← تقرير بـ 42 زيارة و3 زوار في 5 أيام', rep.tables[0].totals);
}

/* ---------------- 3) مصادر الزيارة: الرابط ← الزيارة ← التصميم ← الطلب ← المبيعات ---------------- */
{
  // رابط وحدة مختلف (تعليق في آخرها): Node يخزّن وحدات data: المتطابقة فتعود الوحدة نفسها بتهيئتها السابقة
  const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8') + '\n// fresh-instance-sources').toString('base64'));
  const { visitSource } = mod;
  const cases = [['', 'direct'], [null, 'direct'], ['Instagram', 'instagram'], ['IG', 'instagram'], ['wa', 'whatsapp'], ['tt', 'tiktok'], ['gmaps', 'google'], ['store', 'qr'], ['ramadan_ad', 'ramadan_ad'], ['<script>x', 'scriptx'], ['a'.repeat(40), 'a'.repeat(24)], ['عربي', 'direct']];
  ok(cases.every(([i, o]) => visitSource(i) === o), 'src: تطبيع اسم المصدر (مرادفات، أحرف لاتينية فقط، 24 حرفاً، بلا src = مباشر)', cases.map(([i]) => visitSource(i)));

  const DB = new SqliteD1();
  DB.exec(fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8'));
  DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  const T0 = '2026-01-01T00:00:00.000Z', FUT = new Date(Date.now() + 864e5).toISOString();
  DB.db.prepare("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('u-own','o','o','x','admin',1,?)").run(T0);
  DB.db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ('t-own','u-own',?,?)").run(T0, FUT);
  const env = { DB, OWNER_USER_ID: 'u-own', ALLOWED_ORIGIN: 'https://x.test' };
  const UA = { 'user-agent': 'Mozilla/5.0 (Linux; Android 16) Chrome/156 Mobile', 'cf-connecting-ip': '10.0.0.1' };
  const w2 = mod.default;   // وحدة جديدة = تهيئة ensureSeed من جديد كما في نسخة منشورة جديدة
  const req = (m, p, h, b) => w2.fetch(new Request('https://x.test' + p, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, UA, h || {}), body: b ? JSON.stringify(b) : undefined }), env);
  const J = async (r) => ({ s: r.status, b: await r.json().catch(() => null) });
  await req('GET', '/api/me');   // تهيئة الأعمدة (ensureSeed) كما في أول طلب على الخادم
  ok(DB.db.prepare("SELECT COUNT(*) n FROM pragma_table_info('customer_designs') WHERE name = 'src'").get().n === 1, 'src: عمود customer_designs.src يُضاف تلقائياً (بلا هجرة يدوية، الصفوف القديمة NULL = مباشر)');
  // زيارات بروابط القنوات
  for (const q of ['?src=instagram', '?src=IG', '?src=wa', '', '?src=ramadan_ad']) await req('GET', '/customer-design' + q);
  await req('GET', '/customer-design?src=instagram', { 'user-agent': 'facebookexternalhit/1.1' });   // معاينة رابط ← لا تُحتسب
  const ev = Object.fromEntries(DB.db.prepare("SELECT dim, SUM(n) AS n FROM analytics_events WHERE name = 'visit_src' GROUP BY dim").all().map((r) => [r.dim, r.n]));
  ok(ev.instagram === 2 && ev.whatsapp === 1 && ev.direct === 1 && ev.ramadan_ad === 1, 'src: كل فتح للصفحة يُنسب لقناته (معاينات الروابط مستبعدة)', ev);
  ok(DB.db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE name = 'visit_src' AND (dim LIKE '%.%' OR dim LIKE '%:%')").get().n === 0, 'src: لا يُخزَّن مع المصدر أي شيء آخر (عدّاد مجمّع فقط)');
  // المسار العام لا يقبل حدث المصدر (منع التزوير)
  await req('POST', '/api/analytics/event', null, { name: 'visit_src', dim: 'fake' });
  ok(!DB.db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE name = 'visit_src' AND dim = 'fake'").get().n, 'src: /api/analytics/event لا يقبل visit_src — يسجّله الخادم وحده عند فتح الصفحة');
  // تصاميم بمصادرها
  const mk = async (src) => (await J(await req('POST', '/api/portal/session', null, { src }))).b.token;
  const tIg = await mk('instagram'), tIg2 = await mk('IG'), tWa = await mk('wa'), tNone = await mk(undefined);
  const srcOf = (tok) => DB.db.prepare('SELECT src FROM customer_designs WHERE token = ?').get(tok).src;
  ok(srcOf(tIg) === 'instagram' && srcOf(tIg2) === 'instagram' && srcOf(tWa) === 'whatsapp' && srcOf(tNone) === 'direct', 'src: التصميم يحفظ مصدره المطبَّع عند البدء');
  // تحويل تصميمَي إنستغرام إلى طلبين (أحدهما يُلغى لاحقاً)، وتصميم واتساب لا يتحوّل
  const idOf = (tok) => DB.db.prepare('SELECT id FROM customer_designs WHERE token = ?').get(tok).id;
  const c1 = await J(await req('POST', '/api/designs/' + idOf(tIg) + '/convert', { 'x-session-token': 't-own' }));
  const c2 = await J(await req('POST', '/api/designs/' + idOf(tIg2) + '/convert', { 'x-session-token': 't-own' }));
  ok(c1.s === 200 && c2.s === 200, 'src: تحويل تصميمين إلى طلبين', [c1.s, c2.s]);
  const o1 = JSON.parse(DB.db.prepare('SELECT data FROM orders WHERE id = ?').get(c1.b.orderId).data);
  ok(o1.source === 'instagram', 'src: الطلب المحوَّل يرث مصدر تصميمه (source)', o1.source);
  const setOrder = (id, patch) => { const d = JSON.parse(DB.db.prepare('SELECT data FROM orders WHERE id = ?').get(id).data); Object.assign(d, patch); DB.db.prepare('UPDATE orders SET data = ?, status = ? WHERE id = ?').run(JSON.stringify(d), d.status, id); };
  setOrder(c1.b.orderId, { total: 5000, status: 'new' });
  setOrder(c2.b.orderId, { total: 3000, status: 'cancelled' });
  const dg = await J(await req('GET', '/api/designs/' + idOf(tWa), { 'x-session-token': 't-own' }));
  ok(dg.b.design.source === 'whatsapp', 'src: الموظف يرى مصدر التصميم', dg.b.design.source);
  const today = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);
  const oa = await J(await req('GET', `/api/owner-analytics?range=custom&from=2000-01-01&to=${today}`, { 'x-session-token': 't-own' }));
  const S = Object.fromEntries((oa.b.sources || []).map((x) => [x.src, x]));
  ok(S.instagram && S.instagram.visits === 2 && S.instagram.started === 2 && S.instagram.orders === 2 && S.instagram.revenue === 5000, 'src: إنستغرام — زيارتان، تصميمان، طلبان، ومبيعات 5000 (الملغي لا يُحتسب بيعاً)', S.instagram);
  ok(S.whatsapp && S.whatsapp.visits === 1 && S.whatsapp.started === 1 && S.whatsapp.orders === 0 && S.direct.started === 1 && S.ramadan_ad.visits === 1, 'src: واتساب ومباشر والحملة المخصّصة كلٌّ برقمه', { wa: S.whatsapp, direct: S.direct, ad: S.ramadan_ad });
  const lv = await J(await req('GET', '/api/link-visits', { 'x-session-token': 't-own' }));
  ok(lv.s === 200 && lv.b.sources.find((x) => x.dim === 'instagram').n === 2, '«عن التطبيق»: أهم المصادر لآخر ٣٠ يوماً', lv.b.sources);
  // التقرير
  const rep = Reports.build('visits', base({ from: '', to: today, today, visits: Object.assign({ ready: true }, oa.b) }));
  const st = rep.tables.find((t) => /مصدر الزيارة/.test(t.title));
  const ig = st && st.rows.find((r) => r.source === 'إنستغرام');
  ok(ig && ig.orders === 2 && ig.revenue === 5000 && ig.conv === 100 && st.totals.visits === 5, 'report: جدول «حسب مصدر الزيارة» بالأسماء العربية والمبيعات والتحويل', { ig, totals: st && st.totals });
  ok(st.rows.some((r) => r.source === 'ramadan_ad') && st.rows.some((r) => /مباشر/.test(r.source)), 'report: الحملة المخصّصة باسمها، وبلا رابط مصدر = «مباشر»');
  ok(rep.summary.find((s) => s.label === 'أفضل مصدر (طلبات)').value === 'إنستغرام (2)', 'report: أفضل مصدر = إنستغرام (2)');
}

console.log(`\n=== visits-report: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
