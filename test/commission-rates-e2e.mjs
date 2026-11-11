/* اختبار واجهة آلي لمصدر نسب العمولة الموحّد:
   - نسبة مخصّصة لطلب بائع (من «نسبة البائع») تصل قائمة الطلبات وملخص الطلب وتقرير العمولات معاً.
   - نسبة مخصّصة لطلب مندوب تُطبَّق فعلاً (كانت تُحفظ وتُهمل)، وتظهر عند إعادة فتح النافذة.
   - تقرير العمولات يعرض «مصدر النسبة» لكل سطر.
   الاستخدام: node test/commission-rates-e2e.mjs */
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
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 500) : '')); }
};
const PW = 'test1234';
const salt = crypto.randomBytes(16);
const H = `pbkdf2$100000$${salt.toString('base64')}$${crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256').toString('base64')}`;
const past = new Date(Date.now() - 86400000 * 400).toISOString();
const at = new Date(Date.now() - 86400000 * 3).toISOString();
const U = (id, username, name, role, extra = {}) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H, ...extra });
// ربح كل طلب = 1000 (بيع 2000 قبل الضريبة − تكلفة 1000)
const ord = (id, number, by, byName, rates, extra = {}) => {
  const d = Object.assign({ id, number, status: 'delivered', createdBy: by, createdByName: byName, createdAt: at, updatedAt: at,
    customer: { name: 'عميل ' + number, phone: '05000' + number }, design: { pieces: [] },
    subtotal: 2000, discount: 0, vat: { enabled: false, rate: 15 }, vatRate: 0, total: 2000, paid: 2000, remaining: 0, costTotal: 1000,
    commRates: rates, payments: [{ id: 'p' + id, at: at.slice(0, 10), amount: 2000, method: 'cash', by: byName }] }, extra);
  return { id, number, status: d.status, customer_name: d.customer.name, created_by: by, created_at: at, updated_at: at, data: JSON.stringify(d) };
};
const orders = [
  ord('oa', 1, '2', 'سالم البائع', { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }),
  ord('ob', 2, '3', 'مندوب تابع', { ownerRate: 6, parentId: '4', parentRate: 3, shareRate: 5 }),
  ord('oc', 3, '2', 'سالم البائع', { ownerRate: 8, parentId: null, parentRate: null, shareRate: 5 }),
];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'staff1', 'سالم البائع', 'staff'), U('3', 'mand2', 'مندوب تابع', 'mandoub', { parent_id: '4', rate: 6, parent_rate: 3 }), U('4', 'mand1', 'مندوب أعلى', 'mandoub')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }], items: [],
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, shareRate: 5, mandoubRate: 5, mandoubParentRate: 5 }), updated_at: past }],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions']) env.DB.tables.set(t, []);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1';
{ const prep = env.DB.prepare.bind(env.DB); env.DB.prepare = (sql) => prep(String(sql).replace(/lower\(username\)\s*=\s*\?/i, 'username = ?').replace(/\bid IS NOT \?/i, 'id <> ?')); }

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
routeDownloads(browser); // تنزيلات الاختبار إلى Documents/majlis-test-downloads لا مجلد التنزيلات
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, opts = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  /* الأرقام القديمة في هذا الاختبار تشمل الطلب «الجديد»: نختار كل الحالات في «يشمل التقرير»
     إلا حين نختبر الافتراضي نفسه (opts.defaultInclude) */
  if (!opts.defaultInclude) await page.evaluateOnNewDocument(() => { try { if (!sessionStorage.getItem('incSet')) { localStorage.setItem('majlis_rep_inc', JSON.stringify({ statuses: ['new', 'progress', 'done', 'delivered'], paidOnly: false })); sessionStorage.setItem('incSet', '1'); } } catch (_) { /* */ } });
  page.on('pageerror', (e) => pageErrors.push(username + ': ' + String(e.message).split('\n')[0]));
  // التقاط التنزيلات: browserDownload ينقر رابط blob بسمة download
  /* فحص تخطيط كل صفحة PDF لحظة تصويرها: لا صف ولا نص يتجاوز منطقة المحتوى إلى التذييل أو يُقصّ */
  await page.evaluateOnNewDocument(() => {
    window.__pdfPages = [];
    let real;
    Object.defineProperty(window, 'html2canvas', {
      configurable: true,
      get() { return real && (async (el, o) => {
        if (el.classList && el.classList.contains('rep-page')) {
          const body = el.querySelector('.rp-body').getBoundingClientRect(), foot = el.querySelector('.rp-foot').getBoundingClientRect(), pg = el.getBoundingClientRect();
          const items = [...el.querySelectorAll('.rp-body tr, .rp-body h2, .rp-body .rp-kpis, .rp-body .rp-notes')];
          const over = items.filter((x) => x.getBoundingClientRect().bottom > body.bottom + 0.5).map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
          window.__pdfPages.push({ title: (el.querySelector('.rp-head h1, .rp-head b') || {}).textContent, over, footIn: foot.bottom <= pg.bottom + 0.5 && foot.top >= body.bottom - 0.5, foot: el.querySelector('.rp-foot').textContent.trim() });
        }
        return real(el, o);
      }); },
      set(v) { real = v; },
    });
  });
  await page.evaluateOnNewDocument(() => {
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return orig.call(this);
      const name = this.download, href = this.href;
      window.__dl.push(fetch(href).then((r) => r.arrayBuffer()).then((b) => {
        const u8 = new Uint8Array(b);
        let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return { name, size: b.byteLength, b64: btoa(bin) };
      }));
    };
  });
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', username); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(3000);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  return page;
}
const go = async (page, name) => { await page.evaluate((n) => (document.querySelector(`#mainNav button[data-page="${n}"]`) || document.querySelector(`.page-tabs [data-goto="${n}"]`)).click(), name); await sleep(900); };
const commCell = (page, id) => page.evaluate((i) => { const tr = [...document.querySelectorAll('#ordersTable tbody tr')].find((r) => r.querySelector(`[data-open="${i}"]`)); const td = tr && tr.querySelector('td.c-comm'); return td ? td.textContent.trim() : null; }, id);
async function setRate(page, id, val) {
  await page.evaluate((i) => document.querySelector(`[data-comm="${i}"]`).click(), id);
  await sleep(700);
  const before = await page.evaluate(() => document.getElementById('commOwner').value);
  await page.evaluate((v) => { const i = document.getElementById('commOwner'); i.value = String(v); i.dispatchEvent(new Event('input')); document.getElementById('commOk').click(); }, val);
  await sleep(1500);
  return before;
}
const detailRows = (page) => page.evaluate(() => { const t = document.querySelectorAll('#repTables table')[1]; return t ? [...t.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()) : []; });
const detailHeads = (page) => page.evaluate(() => { const t = document.querySelectorAll('#repTables table')[1]; return t ? [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : []; });

try {
  const page = await login('owner');
  await go(page, 'orders');
  const c0 = [await commCell(page, 'oa'), await commCell(page, 'ob'), await commCell(page, 'oc')];
  ok(c0.join() === '100.00,60.00,80.00', 'قبل التعديل: العمولة من النسب المحفوظة (10٪ و6٪ و8٪ من ربح 1000)', c0);
  const b1 = await setRate(page, 'oa', 20);
  ok(b1 === '10', 'نافذة نسبة البائع تعرض النسبة الفعلية للطلب (10)', b1);
  ok(await commCell(page, 'oa') === '200.00', 'بائع: النسبة المخصّصة 20٪ تظهر فوراً في قائمة الطلبات (200)', await commCell(page, 'oa'));
  const b2 = await setRate(page, 'ob', 12);
  ok(b2 === '6', 'نافذة نسبة المندوب تعرض نسبته الفعلية (6)', b2);
  ok(await commCell(page, 'ob') === '120.00', 'مندوب: النسبة المخصّصة 12٪ تُطبَّق فعلاً (كانت تُهمل)', await commCell(page, 'ob'));
  const again = await page.evaluate(async () => { document.querySelector('[data-comm="ob"]').click(); await new Promise((r) => setTimeout(r, 600)); const v = document.getElementById('commOwner').value; document.getElementById('commCancel').click(); return v; });
  ok(again === '12', 'إعادة فتح نافذة المندوب تعرض 12 (لا القديمة)', again);

  // ملخص الطلب يطابق
  await sleep(400);
  await page.evaluate(() => document.querySelector('[data-sum="oa"]').click());
  await sleep(1200);
  const sm = await page.evaluate(() => [...document.querySelectorAll('#modal .sum-table tbody tr')].map((tr) => tr.innerText.replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim()).join(' || '));
  ok(/عمولة البائع — سالم البائع \(20٪ من صافي الربح • مخصّصة لهذا الطلب\) 200\.00/.test(sm) && /حصة المشاركة \(5٪ • مخصّصة لهذا الطلب\) 50\.00/.test(sm) && /صافي الربح 1,000\.00/.test(sm), 'ملخص الطلب: 20٪ «مخصّصة لهذا الطلب» = 200، والمشاركة 5٪ «افتراضية»', sm);
  await page.evaluate(() => document.getElementById('modalClose').click());
  await sleep(400);

  // تقرير العمولات يطابق، ومعه مصدر النسبة
  await go(page, 'reports');
  await page.evaluate(() => document.querySelector('#repCatalog [data-rep="commissions"]').click()); await sleep(500);
  await page.evaluate(() => document.querySelector('#repRangeChips [data-rr="all"]').click()); await sleep(700);
  const heads = await detailHeads(page);
  ok(heads.includes('مصدر النسبة'), 'التقرير: عمود «مصدر النسبة» في تفصيل العمولات', heads);
  const rows = await detailRows(page);
  const find = (re) => rows.find((r) => re.test(r)) || '';
  const r1 = find(/#1 .*سالم البائع.*عمولة طلبه/), r2 = find(/#2 .*مندوب تابع.*عمولة طلبه/), r2p = find(/#2 .*مندوب أعلى.*طلب تابع/), r3 = find(/#3 .*سالم البائع.*عمولة طلبه/);
  ok(/مخصّصة لهذا الطلب/.test(r1) && /200\.00/.test(r1), 'التقرير: طلب #1 بنسبة 20٪ «مخصّصة لهذا الطلب» = 200 (يطابق القائمة)', rows);
  ok(/مخصّصة لهذا الطلب/.test(r2) && /120\.00/.test(r2), 'التقرير: طلب المندوب #2 بنسبة 12٪ = 120', rows);
  ok(/نسبة المندوب الخاصة/.test(r2p) && /30\.00/.test(r2p), 'التقرير: المندوب الأعلى 3٪ «نسبة المندوب الخاصة» = 30', rows);
  ok(/محفوظة على الطلب وقت اعتماده/.test(r3) && /80\.00/.test(r3), 'التقرير: طلب #3 بنسبة 8٪ «محفوظة على الطلب وقت اعتماده» (الافتراضي الآن 10٪)', rows);
  ok(/مخصّصة لهذا الطلب/.test(find(/#1 .*حصة المشاركة/)) && /افتراضية \(الإعدادات\)/.test(find(/#3 .*حصة المشاركة/)), 'التقرير: مشاركة #1 «مخصّصة» (حُفظت من النافذة) و#3 «افتراضية (الإعدادات)»', rows);

  // الخادم حفظ النسب المخصّصة (المالك)
  const stored = (id) => JSON.parse(env.DB.tables.get('orders').find((o) => o.id === id).data);
  ok(Number(stored('oa').sellerRate) === 20 && Number(stored('ob').mandoubRate) === 12, 'الخادم: حُفظت النسبتان المخصّصتان', { a: stored('oa').sellerRate, b: stored('ob').mandoubRate });
  await page.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== commission-rates: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
