/* اختبار واجهة آلي لأساس احتساب النسب واختيار أعمدة التقرير:
   1) الإعدادات: «تُحسب كل النسب من» صافي الربح أو الإجمالي شامل الضريبة، ويُحفظ على الخادم.
   2) تقرير العمولات: عمود «النسبة ٪» لكل شخص، والمبالغ من الأساس المختار (طلب بلا تكاليف يُحسب مع «الإجمالي»).
   3) زر «الأعمدة» لكل جدول: إخفاء عمود وإظهاره، يبقى بعد إعادة الرسم، ويُطبَّق على ملف CSV المُصدَّر.
   الخادم الحقيقي على D1 وهمية + index.html في Chrome headless (نفس أسلوب reports-ui-e2e.mjs).
   الاستخدام: node test/commission-base-e2e.mjs */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { routeDownloads, TEST_DL } from './_downloads.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8')).toString('base64'));
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); }
};

const PW = 'test1234';
const salt = crypto.randomBytes(16);
const H = `pbkdf2$100000$${salt.toString('base64')}$${crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256').toString('base64')}`;
const past = new Date(Date.now() - 86400000 * 400).toISOString();
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const thisMonth = (dd) => { const d = new Date(now.getFullYear(), now.getMonth(), Math.min(dd, now.getDate())); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const U = (id, username, name, role, extra = {}) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H, ...extra });
const ord = (id, number, by, byName, date, { subtotal = 1000, cost = 600, status = 'progress', rates = { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 } } = {}) => {
  const at = date + 'T09:00:00.000Z';
  const total = Math.round(subtotal * 1.15 * 100) / 100;
  const data = { id, number, status, createdBy: by, createdByName: byName, createdAt: at, updatedAt: at,
    customer: { name: 'عميل ' + number, phone: '05000' + String(number).padStart(5, '0') }, design: { pieces: [] }, lines: [],
    subtotal, discount: 0, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: total - subtotal, total, paid: 0, remaining: total, commRates: rates, payments: [] };
  if (cost !== null) data.costTotal = cost;
  return { id, number, status, customer_name: 'عميل ' + number, created_by: by, created_at: at, updated_at: at, data: JSON.stringify(data) };
};
// سالم: طلب بتكاليف (بيع 1000، تكلفة 600، إجمالي 1150) وطلب بلا تكاليف (بيع 500، إجمالي 575) — نسبته 10٪ والمشاركة 5٪
const orders = [
  ord('o1', 1, '2', 'سالم الموظف', thisMonth(1), { subtotal: 1000, cost: 600 }),
  ord('o2', 2, '2', 'سالم الموظف', thisMonth(1), { subtotal: 500, cost: null }),
];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'staff1', 'سالم الموظف', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 200 }], settings: [{ id: 1, data: '{}', updated_at: past }], items: [],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions']) env.DB.tables.set(t, []);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1';
{
  const prep = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    let s = String(sql).replace(/lower\(username\)\s*=\s*\?/i, 'username = ?').replace(/\bid IS NOT \?/i, 'id <> ?');
    // D1 الوهمية لا تفهم القيمة الحرفية «1» داخل VALUES: صيغة مكافئة بمعامل
    if (/INSERT INTO settings \(id, data, updated_at\) VALUES \(1, \?, \?\)/.test(s)) {
      s = s.replace('VALUES (1, ?, ?)', 'VALUES (?, ?, ?)');
      const st = prep(s);
      return { ...st, bind: (...a) => st.bind(1, ...a) };
    }
    return prep(s);
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let origin = '';
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      try {
        const r = await worker.fetch(new Request(origin + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')), body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString('utf8') }), env);
        res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message) })); }
      return;
    }
    if (u.pathname === '/config.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(`window.APP_CONFIG = { apiUrl: ${JSON.stringify(origin)} };`); return; }
    if (u.pathname === '/sw.js') { res.writeHead(404); res.end(); return; }
    let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(f));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = 'http://127.0.0.1:' + server.address().port;

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي اختبار الواجهة'); server.close(); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
routeDownloads(browser);
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(username + ': ' + String(e.message).split('\n')[0]));
  await page.evaluateOnNewDocument(() => {
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return orig.call(this);
      const name = this.download;
      window.__dl.push(fetch(this.href).then((r) => r.text()).then((text) => ({ name, text })));
    };
  });
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', username); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(2500);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  return page;
}
const go = async (page, name) => { await page.evaluate((n) => (document.querySelector(`#mainNav button[data-page="${n}"]`) || document.querySelector(`.page-tabs [data-goto="${n}"]`)).click(), name); await sleep(900); };
const pick = async (page, id) => { await page.evaluate((i) => document.querySelector(`#repCatalog [data-rep="${i}"]`).click(), id); await sleep(400); };
const heads = (page, i = 0) => page.evaluate((k) => { const t = document.querySelectorAll('#repTables table')[k]; return t ? [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : []; }, i);
/** صف الشخص في جدول المستحقات: {عنوان العمود: النص} */
const personRow = (page, name) => page.evaluate((n) => {
  const t = document.querySelectorAll('#repTables table')[0];
  const hs = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  const tr = [...t.querySelectorAll('tbody tr')].find((x) => x.cells[0] && x.cells[0].textContent.trim() === n);
  return tr ? Object.fromEntries([...tr.cells].map((c, i) => [hs[i], c.textContent.trim()])) : null;
}, name);
const kpis = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#repKpis .stat')].map((s) => [s.querySelector('span').textContent.trim(), s.querySelector('b').textContent.trim()])));

try {
  const page = await login('owner');

  /* ----- الأساس الافتراضي: صافي الربح ----- */
  await go(page, 'reports');
  await pick(page, 'commissions');
  await page.evaluate(() => document.querySelector('#repRangeChips [data-rr="m"]').click()); await sleep(400);
  let h = await heads(page, 0);
  ok(h.includes('النسبة ٪') && !h.some((x) => x.startsWith('أساس العمولة')), 'profit: عمود «النسبة ٪» ظاهر بلا عمود الأساس', h);
  let salem = await personRow(page, 'سالم الموظف');
  ok(salem && salem['النسبة ٪'] === '10٪' && salem['عمولة طلباته'] === '40.00', 'profit: سالم 10٪ من صافي ربح 400 = 40 (الطلب بلا تكاليف لا يُحسب)', salem);

  /* ----- الإعدادات: تغيير الأساس إلى الإجمالي شامل الضريبة ----- */
  await go(page, 'settings');
  const opts = await page.evaluate(() => { const s = document.getElementById('sCommBase'); return s ? [...s.options].map((o) => o.value + ':' + (o.selected ? 1 : 0)) : null; });
  ok(opts && opts.join() === 'profit:1,total:0', 'settings: خيار «تُحسب كل النسب من» وافتراضيه صافي الربح', opts);
  await page.select('#sCommBase', 'total');
  await page.evaluate(() => document.getElementById('sSave').click());
  await sleep(2500);
  const saved = JSON.parse(env.DB.tables.get('settings')[0].data || '{}');
  ok(saved.commBase === 'total', 'settings: الأساس محفوظ على الخادم (total)', saved.commBase);

  /* ----- تقرير العمولات بأساس الإجمالي ----- */
  await go(page, 'reports');
  await pick(page, 'commissions');
  h = await heads(page, 0);
  ok(h.includes('أساس العمولة (الإجمالي شامل الضريبة)') && h.includes('النسبة ٪'), 'total: عمودا الأساس والنسبة', h);
  salem = await personRow(page, 'سالم الموظف');
  ok(salem && salem['أساس العمولة (الإجمالي شامل الضريبة)'] === '1,725.00' && salem['عمولة طلباته'] === '172.50' && salem['النسبة ٪'] === '10٪', 'total: سالم 10٪ من 1150 + 575 = 172.50 (الطلب بلا تكاليف يُحسب)', salem);
  const k = await kpis(page);
  ok(k['حصص المشاركة'] === '86.25', 'total: حصص المشاركة 5٪ من 1725 = 86.25', k);

  /* ----- اختيار الأعمدة ----- */
  const menuItems = await page.evaluate(() => {
    document.querySelector('#repTables [data-repcols="0"]').click();
    const list = document.querySelector('#repTables [data-repcols="0"]').nextElementSibling;
    return { open: !list.hidden, items: [...list.querySelectorAll('[data-repcol]')].map((b) => b.textContent.trim()) };
  });
  ok(menuItems.open && menuItems.items.includes('المبيعات') && menuItems.items.includes('النسبة ٪'), 'cols: قائمة «الأعمدة» تُفتح بكل أعمدة الجدول', menuItems);
  await page.evaluate(() => [...document.querySelectorAll('#repTables [data-repcols="0"] + .rmenu-list [data-repcol]')].find((b) => b.dataset.repcol === 'revenue').click());
  await sleep(500);
  h = await heads(page, 0);
  const stillOpen = await page.evaluate(() => !document.querySelector('#repTables [data-repcols="0"]').nextElementSibling.hidden);
  ok(!h.includes('المبيعات') && h.includes('النسبة ٪'), 'cols: إخفاء «المبيعات» من الجدول', h);
  ok(stillOpen, 'cols: القائمة تبقى مفتوحة لتبديل عمود آخر');
  await page.evaluate(() => [...document.querySelectorAll('#repTables [data-repcols="0"] + .rmenu-list [data-repcol]')].find((b) => b.dataset.repcol === 'role').click());
  await sleep(500);
  h = await heads(page, 0);
  ok(!h.includes('الدور') && !h.includes('المبيعات'), 'cols: إخفاء عمود ثانٍ بالفتحة نفسها', h);
  await page.mouse.click(5, 5); await sleep(200);
  // يبقى الاختيار بعد التنقل وإعادة الرسم
  await go(page, 'orders'); await go(page, 'reports'); await pick(page, 'commissions');
  h = await heads(page, 0);
  ok(!h.includes('المبيعات') && !h.includes('الدور'), 'cols: الاختيار محفوظ بعد التنقل', h);
  const h1 = await heads(page, 1);
  ok(h1.includes('النسبة ٪') && h1.includes('العميل'), 'cols: الجدول الثاني مستقل (لم يتأثر)', h1);

  // التصدير يتبع اختيار الأعمدة
  await page.evaluate(() => { window.__dl = []; document.getElementById('btnRepCsv').click(); });
  await page.waitForFunction(() => window.__dl.length > 0, { timeout: 30000 });
  const csv = (await page.evaluate(() => window.__dl[0])).text;
  const headerLine = csv.split(/\r?\n/).find((l) => /^\W*الاسم/.test(l) && l.includes('إجمالي المستحق')) || '';
  ok(headerLine && !headerLine.includes('المبيعات') && !headerLine.includes('الدور') && headerLine.includes('النسبة ٪'), 'cols: ملف CSV بلا الأعمدة المخفية ومعه النسبة', headerLine);

  // إعادة إظهار عمود
  await page.evaluate(() => { document.querySelector('#repTables [data-repcols="0"]').click(); });
  await page.evaluate(() => [...document.querySelectorAll('#repTables [data-repcols="0"] + .rmenu-list [data-repcol]')].find((b) => b.dataset.repcol === 'revenue').click());
  await sleep(500);
  h = await heads(page, 0);
  ok(h.includes('المبيعات'), 'cols: إعادة إظهار «المبيعات»', h);

  /* ----- العودة إلى صافي الربح ----- */
  await go(page, 'settings');
  await page.select('#sCommBase', 'profit');
  await page.evaluate(() => document.getElementById('sSave').click());
  await sleep(2500);
  await go(page, 'reports'); await pick(page, 'commissions');
  salem = await personRow(page, 'سالم الموظف');
  ok(salem && salem['عمولة طلباته'] === '40.00', 'profit: العودة إلى صافي الربح تعيد الحساب (40)', salem);

  await page.browserContext().close();
  ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript في الصفحة', pageErrors);
} catch (e) {
  fail++; console.log('FAIL  harness :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally {
  await browser.close();
  server.close();
}
console.log(`=== commission-base: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
