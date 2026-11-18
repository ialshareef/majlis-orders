/* اختبار واجهة آلي لبطاقة «مصروفات الشركة والعهد» في الرئيسية (لمن يرى مصروفات الجميع):
   إجماليات الشركة، سطر لكل موظف، تفاصيل الموظف بالضغط، وPDF للموظف وللشركة — والموظف لا يراها.
   الاستخدام: node test/home-expenses-e2e.mjs */
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
const orders = [];
const tAt = (d, h = 10) => new Date(Date.now() - d * 86400000 + h * 3600000).toISOString();
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('5', 'khalid', 'خالد', 'admin'), U('2', 'asim', 'عاصم', 'staff'), U('3', 'salim', 'سليم', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }], items: [],
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, shareRate: 5 }), updated_at: past }],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'user_permissions']) env.DB.tables.set(t, []);
const E = (id, by, name, cat, amount, d) => ({ id, name, amount, category: cat, note: null, created_by: by, created_at: tAt(d), updated_at: tAt(d), expense_date: tAt(d).slice(0, 10), order_id: null });
env.DB.tables.set('expenses', [E('e1', '2', 'بنزين', 'نقل', 100, 3), E('e2', '2', 'مسامير', 'مشتريات', 250, 2), E('e3', '3', 'غداء العمال', 'أجور', 80, 1)]);
env.DB.tables.set('custody_receipts', [{ id: 'r1', user_id: '2', amount: 1000, note: 'من المدير', created_by: '5', created_at: tAt(4), updated_at: tAt(4) }]);
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
const clean = (t) => String(t || '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e && !e.hidden ? e.innerText : ''; }, sel).then(clean);

try {
  /* ----- المدير خالد: مصروفات الشركة في الرئيسية ----- */
  const page = await login('khalid');
  await page.waitForFunction(() => document.querySelectorAll('#homeExp [data-hexp]').length >= 2, { timeout: 15000 });
  const card = await txt(page, '#homeExp');
  ok(/مصروفات الشركة والعهد/.test(card) && /المستلم 1,000\.00/.test(card) && /المصروف 430\.00/.test(card) && /المتبقي من العهد 650\.00/.test(card), 'الرئيسية: إجمالي المستلم والمصروف والمتبقي للشركة', card);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#homeExp [data-hexp]')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 2 && /عاصم/.test(rows[0]) && /استلم 1,000\.00/.test(rows[0]) && /صرف 350\.00/.test(rows[0]) && /المتبقي 650\.00/.test(rows[0]) && /سليم/.test(rows[1]) && /صرف 80\.00/.test(rows[1]) && /بلا عهدة/.test(rows[1]), 'الرئيسية: سطر لكل موظف (عاصم بعهدته، وسليم بلا عهدة)', rows);
  await page.evaluate(() => document.querySelector('#homeExp [data-hexp="2"]').click()); await sleep(900);
  const m = clean(await page.evaluate(() => document.getElementById('modal').innerText));
  ok(/مصروفات وعهدة — عاصم/.test(m) && /كشف العهدة/.test(m) && /بنزين/.test(m) && /مسامير/.test(m) && /كل المصروفات \(2\)/.test(m), 'الضغط على الموظف: ملخصه وكشف العهدة وكل مصروفاته', m.slice(0, 300));
  await page.evaluate(() => { window.__dl = []; document.getElementById('hxPPdf').click(); });
  await page.waitForFunction(() => window.__dl && window.__dl.length > 0, { timeout: 60000 });
  const f1 = (await page.evaluate(() => Promise.all(window.__dl))).find((f) => /\.pdf$/.test(f.name));
  ok(f1 && /^expenses-/.test(f1.name) && Buffer.from(f1.b64, 'base64').subarray(0, 5).toString() === '%PDF-', 'PDF الموظف صالح', f1 && f1.name);
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(400);
  await page.evaluate(() => { window.__dl = []; window.__pdfPages = []; document.getElementById('hxPdf').click(); });
  await page.waitForFunction(() => window.__dl && window.__dl.length > 0, { timeout: 60000 });
  const f2 = (await page.evaluate(() => Promise.all(window.__dl))).find((f) => /\.pdf$/.test(f.name));
  const pg = await page.evaluate(() => window.__pdfPages);
  ok(f2 && /^company-expenses-/.test(f2.name) && pg.length >= 1 && pg.every((p) => !p.over.length && p.footIn), 'PDF مصروفات الشركة صالح بلا صفوف مقصوصة', { name: f2 && f2.name, pg });
  ok(await page.evaluate(() => !!document.getElementById('hxWa')), 'زر «مشاركة PDF واتساب» موجود');
  await page.setViewport({ width: 390, height: 844 }); await sleep(500);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'الجوال: البطاقة بلا تمرير أفقي');
  await page.browserContext().close();

  /* ----- الموظف: لا يرى مصروفات غيره ----- */
  const sp = await login('asim');
  await sleep(1500);
  ok(await sp.evaluate(() => document.getElementById('homeExp').hidden), 'الموظف: لا بطاقة «مصروفات الشركة» (يرى مصروفاته هو فقط)');
  await sp.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== home-expenses: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
