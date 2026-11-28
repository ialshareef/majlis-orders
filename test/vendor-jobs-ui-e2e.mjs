/* اختبار واجهة آلي لأعمال الموردين والمصانع: عمل مصنع بمبلغ اتفاق (شامل الضريبة) ودفعة مقدمة في «تعديل التكاليف»،
   واحتسابه في تكلفة الطلب، وظهوره في ملخص الطلب ولوحة «مستحقات الموردين»، ثم الدفعة النهائية من اللوحة.
   بيانات تجريبية. الاستخدام: node test/vendor-jobs-ui-e2e.mjs */
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
const now = new Date().toISOString();
const od = { id: 'o1', number: 1001, status: 'new', createdBy: '1', createdByName: 'المالك', createdAt: now, updatedAt: now,
  customer: { name: 'عميل المصنع', phone: '0500000001' }, design: { walls: [], pieces: [] }, lines: [],
  manualRows: [{ name: 'مجلس', qty: 1, unit: 'خدمة', price: 2000 }], subtotal: 2000, discount: 0, vat: { enabled: false, rate: 15 }, vatRate: 0, total: 2000, paid: 0, remaining: 2000, payments: [] };
const orders = [{ id: 'o1', number: 1001, status: 'new', customer_name: od.customer.name, created_by: '1', created_at: now, updated_at: now, data: JSON.stringify(od) }];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin', { rate: 10 })],
  sessions: [], orders, counters: [{ key: 'order_no', value: 1001 }], items: [],
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, vatEnabled: false }), updated_at: past }],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions', 'purchases']) env.DB.tables.set(t, []);
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
const srv = () => JSON.parse(env.DB.tables.get('orders').find((r) => r.id === 'o1').data);
const set = (page, sel, v) => page.evaluate((s, val) => { const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, sel, v);

try {
  const page = await login('owner');
  await page.evaluate(() => document.querySelector('#mainNav [data-page="orders"]').click()); await sleep(900);
  await page.evaluate(() => document.querySelector('[data-sum="o1"]').click()); await sleep(1200);
  await page.evaluate(() => document.getElementById('sumCost').click()); await sleep(1000);
  // عمل مصنع: اتفاق 1150 شامل الضريبة (= 1000 تكلفة) ودفعة مقدمة 500
  await page.evaluate(() => document.getElementById('vjAdd').click()); await sleep(300);
  await set(page, '[data-vj="supplier"]', 'مصنع تجريبي');
  await set(page, '[data-vj="desc"]', 'إسفنج المجلس');
  await set(page, '[data-vj="amount"]', '1150');
  await page.evaluate(() => { const c = document.querySelector('[data-vj="vat"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => document.querySelector('[data-vpadd="0"]').click()); await sleep(300);
  const kind0 = await page.evaluate(() => document.querySelector('[data-vp="kind"]').value);
  await set(page, '[data-vp="amount"]', '500');
  await sleep(300);
  const sumTxt = clean(await page.evaluate(() => document.getElementById('costSum').innerText));
  const vjTxt = clean(await page.evaluate(() => document.querySelector('.vj-sum').innerText));
  ok(kind0 === 'advance' && /1,000\.00/.test(sumTxt) && /موردون ومصانع: 1,000\.00/.test(sumTxt), 'التكاليف: الاتفاق 1150 شامل الضريبة = تكلفة 1000، وأول دفعة «مقدمة»', { kind0, sumTxt });
  ok(/المدفوع 500\.00/.test(vjTxt) && /المتبقي للمورد 650\.00/.test(vjTxt), 'البطاقة: المدفوع 500 والمتبقي للمورد 650', vjTxt);
  await page.evaluate(() => document.getElementById('costOk').click()); await sleep(1500);
  const o = srv();
  ok(o.vendorJobs && o.vendorJobs.length === 1 && o.vendorJobs[0].amount === 1150 && o.vendorJobs[0].vat === true && o.vendorJobs[0].payments[0].amount === 500 && o.costTotal === 1000, 'الخادم: العمل ودفعته محفوظة، وإجمالي تكلفة الطلب 1000', { vj: o.vendorJobs, cost: o.costTotal });
  // ملخص الطلب
  await page.evaluate(() => document.querySelector('[data-sum="o1"]').click()); await sleep(1500);
  const sm = clean(await page.evaluate(() => document.getElementById('modal').innerText));
  ok(/أعمال الموردين والمصانع/.test(sm) && /مصنع تجريبي — إسفنج المجلس/.test(sm) && /650\.00/.test(sm) && /أعمال الموردين والمصانع \(قبل الضريبة\) -1,000\.00/.test(sm), 'ملخص الطلب: جدول المورد (الاتفاق/المدفوع/المتبقي) وسطر التكلفة في «الربح والتكاليف»', sm.slice(0, 500));
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);
  // لوحة مستحقات الموردين
  await page.evaluate(() => document.querySelector('#mainNav [data-page="purchases"]').click()); await sleep(1500);
  const bd = clean(await page.evaluate(() => { document.querySelectorAll('.vj-sup').forEach((d) => { d.open = true; }); return document.getElementById('vjBoard').innerText; }));
  ok(/مصنع تجريبي/.test(bd) && /متبقٍ 650\.00/.test(bd) && /دفعة مقدمة 500\.00/.test(bd) && /#1001/.test(bd), 'لوحة المستحقات: المورد والطلب والدفعة المقدمة والمتبقي 650', bd.slice(0, 400));
  // دفعة نهائية من اللوحة: تُعبّأ بالمتبقي
  await page.evaluate(() => { document.querySelector('.vj-sup').open = true; document.querySelector('[data-vjo]').click(); }); await sleep(1200);
  await page.evaluate(() => document.querySelector('[data-vpadd="0"]').click()); await sleep(300);
  const pre = await page.evaluate(() => { const r = [...document.querySelectorAll('.vj-pay')].pop(); return [r.querySelector('[data-vp="amount"]').value, r.querySelector('[data-vp="kind"]').value]; });
  ok(pre[0] === '650' && pre[1] === 'final', 'الدفعة الثانية تُقترح «نهائية» بالمتبقي 650', pre);
  await page.evaluate(() => document.getElementById('costOk').click()); await sleep(1500);
  const bd2 = clean(await page.evaluate(() => document.getElementById('vjBoard').innerText));
  ok(srv().vendorJobs[0].payments.length === 2 && /لا مستحقات متبقية/.test(bd2), 'بعد السداد: لا مستحقات متبقية', bd2.slice(0, 300));
  await page.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== vendor-jobs-ui: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
