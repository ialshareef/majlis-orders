/* اختبار واجهة آلي لصفحة «المشتريات»: استيراد ملف فواتير، إنشاء الأصناف الجديدة مخفية بسعر الجملة،
   تحديث سعر جملة الصنف القائم، عدم التكرار عند إعادة الاستيراد، والتفاصيل — والموظف لا يرى الصفحة.
   بيانات تجريبية فقط. الاستخدام: node test/purchases-ui-e2e.mjs */
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
const now = new Date().toISOString();
// صنف قائم مربوط مسبقاً برمز المورد: يُحدَّث سعر جملته ولا يُنشأ مكرراً
const ITEMS = [{ id: 'f-old', name: 'قماش قائم', category: 'fabric', unit: 'm', price: 120, cost: 40, costDate: '2026-10-01', purchaseCodes: ['مورد تجريبي|T-2'], active: true, color: '#aa8866' }];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'asim', 'عاصم', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }],
  items: ITEMS.map((i) => ({ id: i.id, data: JSON.stringify(i), updated_at: now })),
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10 }), updated_at: past }],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions', 'purchases']) env.DB.tables.set(t, []);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1';
const FILE = path.join(TEST_DL.downloadPath, 'purchases-test.json');
fs.mkdirSync(TEST_DL.downloadPath, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ type: 'majlis-purchases', version: 1, purchases: [
  { supplier: 'مورد تجريبي', invoice_no: 'T-100', invoice_date: '2026-11-10', lines: [
    { name: 'قماش جديد تجريبي', itemName: 'قماش جديد', code: 'T-1', category: 'fabric', unit: 'متر', qty: 10, unitNet: 52.5, net: 525, vat: 78.75, total: 603.75 },
    { name: 'قماش قائم', code: 'T-2', category: 'fabric', unit: 'متر', qty: 5, unitNet: 45, net: 225, vat: 33.75, total: 258.75 },
    { name: 'لوح إسفنج تجريبي 200×80×10', code: 'S-1', category: 'foam', unit: 'لوح', qty: 4, unitNet: 116, net: 464, vat: 69.6, total: 533.6, sheetLen: 2 },
    { name: 'موكيت تجريبي', code: 'M-1', category: '', unit: 'م²', qty: 3, unitNet: 50, net: 150, vat: 22.5, total: 172.5 },
  ], totals: { net: 1364, vat: 204.6, total: 1568.6 } },
] }));
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
const itemRows = () => env.DB.tables.get('items').map((r) => JSON.parse(r.data));

try {
  const page = await login('owner');
  ok(await page.evaluate(() => !document.querySelector('#mainNav [data-page="purchases"]').hidden), 'القائمة: «المشتريات» ظاهرة للمالك');
  await page.evaluate(() => document.querySelector('#mainNav [data-page="purchases"]').click()); await sleep(1000);
  const input = await page.$('#purImport');
  await input.uploadFile(FILE); await sleep(2500);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#purTable tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 1 && /مورد تجريبي/.test(rows[0]) && /T-100/.test(rows[0]) && /1,568\.60/.test(rows[0]), 'الاستيراد: الفاتورة في الجدول بإجماليها', rows);
  const its = itemRows();
  const nw = its.find((i) => i.name === 'قماش جديد'), foam = its.find((i) => i.category === 'foam'), old = its.find((i) => i.id === 'f-old');
  ok(nw && nw.active === false && nw.cost === 52.5 && nw.price === 0, 'صنف جديد مخفي بسعر جملته حتى يوضع سعر البيع', nw);
  ok(foam && foam.cost === 116 && foam.sheetLen === 2, 'الإسفنج: سعر اللوح وطوله', foam);
  ok(old && old.cost === 45 && old.costDate === '2026-11-10' && old.active === true && its.filter((i) => i.name === 'قماش قائم').length === 1, 'الصنف القائم: حُدّث سعر جملته لأحدث فاتورة بلا تكرار', old);
  ok(!its.some((i) => /موكيت/.test(i.name)), 'بنود «أخرى» (الموكيت) تُسجَّل بلا إنشاء صنف تصميم');
  // إعادة الاستيراد: لا تكرار للفاتورة ولا للأصناف
  await input.uploadFile(FILE); await sleep(2500);
  ok(env.DB.tables.get('purchases').length === 1 && itemRows().length === its.length, 'إعادة الاستيراد: لا فاتورة مكررة ولا أصناف مكررة', { p: env.DB.tables.get('purchases').length, n: itemRows().length });
  // التفاصيل: البنود والأصناف المرتبطة
  await page.evaluate(() => document.querySelector('[data-pur]').click()); await sleep(900);
  const m = clean(await page.evaluate(() => document.getElementById('modal').innerText));
  ok(/قماش جديد تجريبي/.test(m) && /52\.50/.test(m) && /موكيت تجريبي/.test(m) && /لا يُربط/.test(m), 'التفاصيل: البنود بأسعارها وربطها', m.slice(0, 300));
  ok(await page.evaluate(() => { const s = document.querySelector('[data-pl="0"]'); return s && s.selectedOptions[0] && /قماش جديد/.test(s.selectedOptions[0].textContent); }), 'البند مربوط بصنفه الجديد');
  await page.evaluate(() => document.getElementById('plCancel').click()); await sleep(300);
  await page.browserContext().close();

  const sp = await login('asim');
  ok(await sp.evaluate(() => document.querySelector('#mainNav [data-page="purchases"]').hidden), 'الموظف: لا قسم «المشتريات»');
  await sp.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  try { fs.unlinkSync(FILE); } catch (_) { /* */ }
  await browser.close(); server.close();
  console.log(`\n=== purchases-ui: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
