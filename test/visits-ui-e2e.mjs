/* حركة الزوار — اختبار واجهة: قسم «عن التطبيق» المعاد تنسيقه + تقرير «زيارات الموقع» في التقارير مع التصدير.
   الخادم الحقيقي على SQLite مؤقتة وبيانات زيارات معروفة (بتوقيت المحل UTC+3). لا اتصال بالإنتاج.
   الاستخدام: node test/visits-ui-e2e.mjs [--save <مجلد>] */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from './_d1-sqlite.mjs';
import { routeDownloads, TEST_DL } from './_downloads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(read('worker/worker.js')).toString('base64'))).default;
const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- بيانات معروفة نسبةً لليوم (توقيت المحل) ---------------- */
const dayAgo = (n) => new Date(Date.now() + 180 * 60000 - n * 86400000).toISOString().slice(0, 10);
const PW = 'test1234';
const H = (() => { const s = crypto.randomBytes(16); return `pbkdf2$100000$${s.toString('base64')}$${crypto.pbkdf2Sync(PW, s, 100000, 32, 'sha256').toString('base64')}`; })();
const DB = new SqliteD1();
DB.exec(read('worker/schema.sql'));
DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
DB.exec('CREATE TABLE IF NOT EXISTS link_visits (day TEXT NOT NULL, link TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, link))');
DB.exec('CREATE TABLE IF NOT EXISTS link_visitors (day TEXT NOT NULL, link TEXT NOT NULL, fp TEXT NOT NULL, PRIMARY KEY (day, link, fp))');
const T0 = new Date(Date.now() - 864e5).toISOString();
for (const [id, un, r] of [['1', 'owner', 'admin'], ['2', 'staff1', 'staff']]) DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at, must_change_password) VALUES (?,?,?,?,?,1,?,0)').run(id, un, un, H, r, T0);
const V = DB.db.prepare('INSERT INTO link_visits (day, link, n) VALUES (?,?,?)');
V.run(dayAgo(0), 'customer', 4); V.run(dayAgo(0), 'expanded', 1); V.run(dayAgo(2), 'customer', 7); V.run(dayAgo(10), 'customer', 12); V.run(dayAgo(45), 'customer', 20);
const U = DB.db.prepare('INSERT INTO link_visitors (day, link, fp) VALUES (?,?,?)');
// مصادر الزيارة (عدّادات مجمّعة كما يسجّلها الخادم عند فتح الصفحة بـ ?src=…)
DB.exec("CREATE TABLE IF NOT EXISTS analytics_events (day TEXT NOT NULL, name TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name, dim))");
const A = DB.db.prepare("INSERT INTO analytics_events (day, name, dim, n) VALUES (?, 'visit_src', ?, ?)");
A.run(dayAgo(0), 'instagram', 3); A.run(dayAgo(2), 'whatsapp', 2); A.run(dayAgo(2), 'direct', 5);
U.run(dayAgo(0), 'customer', 'a'); U.run(dayAgo(0), 'expanded', 'a'); U.run(dayAgo(0), 'customer', 'b'); U.run(dayAgo(2), 'customer', 'c');
const env = { DB, OWNER_USER_ID: '1', ALLOWED_ORIGIN: 'http://127.0.0.1' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let origin = '';
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      const r = await worker.fetch(new Request(origin + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')), body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString('utf8') }), env);
      res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (u.pathname === '/config.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(`window.APP_CONFIG = { apiUrl: ${JSON.stringify(origin)} };`); return; }
    if (u.pathname === '/sw.js') { res.writeHead(404); res.end(); return; }
    let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = 'http://127.0.0.1:' + server.address().port; env.ALLOWED_ORIGIN = origin;

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي'); server.close(); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
routeDownloads(browser);
const errs = [];
async function login(un, vp = { width: 1366, height: 900 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(un + ': ' + String(e.message).split('\n')[0]));
  await page.evaluateOnNewDocument(() => {
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return orig.call(this);
      const name = this.download, href = this.href;
      window.__dl.push(fetch(href).then((r) => r.arrayBuffer()).then((b) => ({ name, size: b.byteLength, head: String.fromCharCode.apply(null, new Uint8Array(b).subarray(0, 5)) })));
    };
  });
  await page.setViewport(vp);
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', un); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(3000);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); document.querySelectorAll('.tour, .spot-tour, [class*="tour-"]').forEach((e) => e.remove()); });
  return page;
}
const shot = async (page, name) => { if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await page.screenshot({ path: path.join(saveDir, name + '.png'), fullPage: true }); } };
const goVisits = async (page) => { await page.evaluate(() => document.querySelector('.page-tabs [data-goto="visits"]').click()); await page.waitForFunction(() => document.querySelector('#visitStatsBody .vs-cards'), { timeout: 15000 }); };

/* ---------------- 1) «عن التطبيق» للمالك ---------------- */
const P = await login('owner');
await goVisits(P);
const cards = await P.evaluate(() => [...document.querySelectorAll('#visitStatsBody .vs-card')].map((c) => ({ lbl: c.querySelector('.vs-card-lbl').textContent.trim(), n: c.querySelector('b').textContent.trim(), sub: c.querySelector('small').textContent.replace(/\s+/g, ' ').trim() })));
ok(cards.length === 4 && cards.map((c) => c.lbl).join('|') === 'اليوم|آخر ٧ أيام|آخر ٣٠ يوماً|منذ البداية', 'about: أربع بطاقات واضحة للفترات', cards.map((c) => c.lbl));
ok(cards[0].n === '4' && /2 زائر/.test(cards[0].sub), 'about: اليوم 4 زيارات و2 زائر (سجلات الرابط التجريبي الملغى لا تُحتسب)', cards[0]);
ok(cards[1].n === '11' && /3 زائر/.test(cards[1].sub) && cards[2].n === '23' && cards[3].n === '43', 'about: ٧ أيام 11 · ٣٠ يوماً 23 · منذ البداية 43', cards);
const rows = await P.evaluate(() => [...document.querySelectorAll('#visitStatsBody .vs-table tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
ok(rows.length === 1 && /بوابة العميل/.test(rows[0]) && !rows.some((r) => /الموظفين|الموسّع/.test(r)), 'about: الجدول ببوابة العميل فقط (بلا الرابط التجريبي الملغى ولا صف الموظفين)', rows);
const chart = await P.evaluate(() => ({ bars: document.querySelectorAll('#visitStatsBody .vs-bar').length, peak: document.querySelectorAll('#visitStatsBody .vs-bar.peak').length, head: document.querySelector('.vs-chart-head').innerText.replace(/\s+/g, ' ') }));
ok(chart.bars === 30 && chart.peak === 1 && /الأعلى 12/.test(chart.head) && /متوسط 0.8/.test(chart.head), 'about: رسم 30 يوماً بعمود ذروة واحد (12) ومتوسط 0.8', chart);
ok(!(await P.evaluate(() => document.getElementById('visitStatsBody').classList.contains('hint'))), 'about: المحتوى لم يعد رمادياً باهتاً (أُزيلت hint عن الحاوية)');
const srcList = await P.evaluate(() => [...document.querySelectorAll('#visitStatsBody .vs-src li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
ok(srcList.length === 3 && /مباشر/.test(srcList[0]) && /5/.test(srcList[0]) && srcList.some((x) => /إنستغرام 3/.test(x)) && srcList.some((x) => /واتساب 2/.test(x)), 'about/sources: «من أين جاء الزوار؟» بأسماء القنوات وأعدادها', srcList);
const links = await P.evaluate(() => [...document.querySelectorAll('#visitStatsBody .vs-link input[readonly]')].map((i) => i.value));
ok(links.length === 8 && links.every((u) => /\/customer-design\?src=[a-z]+$/.test(u)) && links.some((u) => u.endsWith('?src=instagram')) && links.some((u) => u.endsWith('?src=qr')), 'about/links: رابط لكل قناة من القنوات الثماني', links);
await P.evaluate(() => { document.querySelector('.vs-links').open = true; window.__copied = []; try { navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); }; } catch (_) {} });
await P.evaluate(() => { const i = document.getElementById('vsSrcCustom'); i.value = 'Ramadan Ad!'; document.getElementById('vsSrcCustomCopy').click(); });
await sleep(400);
const copied = await P.evaluate(() => ({ c: window.__copied.slice(), v: document.getElementById('vsSrcCustom').value }));
ok(copied.v === 'ramadanad' && copied.c.length === 1 && copied.c[0].endsWith('/customer-design?src=ramadanad'), 'about/links: الحملة المخصّصة تُطبَّع (أحرف لاتينية صغيرة) ويُنسخ رابطها', copied);
await P.evaluate(() => document.querySelector('[data-srccopy="tiktok"]').click());
await sleep(300);
ok((await P.evaluate(() => window.__copied[1] || '')).endsWith('?src=tiktok'), 'about/links: زر «نسخ» لكل قناة');
await shot(P, 'about-desktop');

/* ---------------- 2) تقرير «زيارات الموقع» ---------------- */
await P.evaluate(() => document.getElementById('btnVisitsReport').click());
await P.waitForFunction(() => document.getElementById('page-reports').classList.contains('active') && document.querySelector('#repCatalog [data-rep="visits"].on'), { timeout: 15000 });
ok(true, 'report: زر «تقرير الزيارات المفصّل» يفتح التقرير مباشرة');
const tabs = await P.evaluate(() => [...document.querySelectorAll('#repCatalog [data-rep]')].map((b) => b.dataset.rep));
ok(tabs[tabs.length - 1] === 'visits', 'report: «زيارات الموقع» في فهرس التقارير', tabs);
await P.evaluate(() => document.querySelector('#repRangeChips [data-rr="all"]').click());
await P.waitForFunction(() => /إجمالي الزيارات/.test(document.getElementById('repKpis').innerText) && document.querySelectorAll('#repTables table').length === 4, { timeout: 15000 });
const k = await P.evaluate(() => Object.fromEntries([...document.querySelectorAll('#repKpis .stat')].map((s) => [s.querySelector('span').textContent.trim(), s.querySelector('b').textContent.trim()])));
ok(k['إجمالي الزيارات'] === '43' && k['الزوار (جهاز/يوم)'] === '3', 'report/all: إجمالي 43 زيارة و3 زوار (بلا الرابط التجريبي)', k);
ok(/\(20\)/.test(k['أعلى يوم']) && k['أنشط يوم في الأسبوع'] && k['أنشط يوم في الأسبوع'] !== '—', 'report/all: أعلى يوم (20) وأنشط يوم أسبوع', k);
const tt = await P.evaluate(() => [...document.querySelectorAll('#repTables h3')].map((h) => h.textContent.trim()));
ok(tt.join('|') === 'الزيارات يوماً بيوم|حسب مصدر الزيارة (أي قناة تجلب الطلبات)|حسب يوم الأسبوع (أفضل يوم للنشر والإعلان)|مسار العميل: من الزيارة إلى الطلب', 'report: الجداول الأربعة (مع «حسب مصدر الزيارة»)', tt);
const srcRows = await P.evaluate(() => [...document.querySelectorAll('#repTables table')[1].querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
ok(srcRows.length === 3 && srcRows.some((r) => /^إنستغرام 3/.test(r)) && srcRows.some((r) => /^واتساب 2/.test(r)), 'report/sources: صف لكل مصدر بزياراته', srcRows);
const dailyRows = await P.evaluate(() => document.querySelectorAll('#repTables table')[0].querySelectorAll('tbody tr').length);
ok(dailyRows === 46, 'report/all: كل الأيام من أول زيارة (قبل 45 يوماً) حتى اليوم = 46 يوماً', dailyRows);
ok(await P.evaluate(() => document.getElementById('repUser').hidden), 'report: لا تصفية بالموظف في تقرير الزيارات');
await P.evaluate(() => document.querySelector('#repRangeChips [data-rr="m"]').click());
await sleep(1500);
const km = await P.evaluate(() => document.getElementById('repKpis').innerText);
ok(/إجمالي الزيارات/.test(km), 'report: تغيير الفترة يعيد التحميل من الخادم');
await P.evaluate(() => document.querySelector('#repRangeChips [data-rr="all"]').click());
await P.waitForFunction(() => /43/.test(document.getElementById('repKpis').innerText), { timeout: 15000 });
await shot(P, 'report-desktop');
for (const [btn, ext, head] of [['btnRepPdf', '.pdf', '%PDF'], ['btnRepXlsx', '.xlsx', 'PK'], ['btnRepCsv', '.csv', '']]) {
  await P.evaluate(() => { window.__dl = []; });
  await P.evaluate((b) => document.getElementById(b).click(), btn);
  const got = await P.waitForFunction(() => window.__dl.length > 0, { timeout: 90000 }).then(() => true).catch(() => false);
  if (!got) {   // PDF يمر بنافذة اختيار (طباعة/تنزيل)
    await P.evaluate(() => { const b = [...document.querySelectorAll('#modal button')].find((x) => /تنزيل|PDF/.test(x.textContent)); if (b) b.click(); });
    await P.waitForFunction(() => window.__dl.length > 0, { timeout: 90000 }).catch(() => {});
  }
  const f = await P.evaluate(() => window.__dl.length ? window.__dl[window.__dl.length - 1] : null);
  ok(f && f.name.endsWith(ext) && f.name.includes('visits') && (!head || f.head.startsWith(head)) && f.size > 500, `export: ${ext} لتقرير الزيارات`, f);
  await P.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
}

/* ---------------- 3) الجوال ---------------- */
const M = await login('owner', { width: 375, height: 812, isMobile: true, hasTouch: true });
await goVisits(M);
const mob = await M.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth, cols: getComputedStyle(document.querySelector('.vs-cards')).gridTemplateColumns.split(' ').length }));
ok(mob.sw <= mob.w + 1 && mob.cols === 2, 'mobile: البطاقات عمودان ولا تمرير أفقي عند 375px', mob);
await shot(M, 'about-mobile');

/* ---------------- 4) الموظف: لا قسم ولا تقرير ---------------- */
const S = await login('staff1');
await S.evaluate(() => document.querySelector('.page-tabs [data-goto="visits"]').click());
await sleep(1500);
ok(await S.evaluate(() => document.getElementById('visitStatsBox').hidden), 'perm: قسم الزوار مخفي عن الموظف');
ok(await S.evaluate(() => [...document.querySelectorAll('.page-tabs [data-goto="visits"]')].every((t) => t.hidden) && !document.getElementById('page-visits').classList.contains('active')), 'perm: تبويب «زيارات الموقع» مخفي عن الموظف ولا تُفتح صفحته');
const st = await S.evaluate(async () => (await fetch('/api/owner-analytics?range=d30', { headers: { 'x-session-token': Store.token } })).status);
ok(st === 403, 'perm: الخادم يرفض بيانات الزيارات للموظف (403)', st);
ok(!errs.length, 'js: لا أخطاء JavaScript', errs);

await browser.close(); server.close();
console.log(`\n=== visits-ui: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
