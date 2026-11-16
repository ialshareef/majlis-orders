/* اختبار واجهة آلي لصفحة «الرئيسية»: البداية بعد الدخول، الأزرار حسب الصلاحية، الأرقام،
   «يحتاج متابعتك» (تأخر التسليم، مدفوع زائد، توصيل بلا تحصيل)، آخر الطلبات، وخريطة الأقسام.
   الاستخدام: node test/home-ui-e2e.mjs */
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
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const ymd = (d) => iso(d).slice(0, 10);
const hord = (id, number, by, byName, { total = 1150, paid = 0, status = 'new', delivery = '', ago = 1 } = {}) => {
  const at = iso(-ago);
  const d = { id, number, status, createdBy: by, createdByName: byName, createdAt: at, updatedAt: at, deliveryDate: delivery,
    customer: { name: 'عميل ' + number, phone: '05000' + number }, design: { pieces: [] }, subtotal: total, discount: 0, vat: { enabled: false, rate: 15 }, vatRate: 0,
    total, paid, remaining: total - paid, payments: paid ? [{ id: 'p' + id, at: at.slice(0, 10), amount: paid, method: 'cash', by: byName }] : [] };
  return { id, number, status, customer_name: d.customer.name, created_by: by, created_at: at, updated_at: at, data: JSON.stringify(d) };
};
const orders = [
  hord('late', 11, '2', 'عاصم', { status: 'progress', delivery: ymd(-3), paid: 500 }),
  hord('over', 12, '2', 'عاصم', { status: 'delivered', paid: 1300 }),
  hord('owe', 13, '2', 'عاصم', { status: 'delivered', paid: 150 }),
  hord('quote', 14, '2', 'عاصم', { status: 'quote' }),
  hord('fresh', 15, '1', 'المالك', { status: 'new', ago: 0 }),
];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'asim', 'عاصم', 'staff'), U('3', 'mand', 'مندوب', 'mandoub')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 20 }], items: [],
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, shareRate: 5 }), updated_at: iso(-400) }],
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
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel).then(clean);

try {
  /* ----- المالك ----- */
  const page = await login('owner');
  ok(await page.evaluate(() => document.body.dataset.page) === 'home', 'بعد الدخول: صفحة «الرئيسية» هي البداية');
  ok(await page.evaluate(() => document.querySelector('#mainNav [data-page="home"]').classList.contains('active')), 'القائمة: «الرئيسية» مُضاءة');
  ok(/صباح الخير|مساء الخير/.test(await txt(page, '#homeHello')) && /المالك/.test(await txt(page, '#homeHello')), 'ترحيب باسم المستخدم', await txt(page, '#homeHello'));
  const acts = await page.evaluate(() => [...document.querySelectorAll('#homeActions [data-hact]')].map((b) => b.dataset.hact));
  ok(acts[0] === 'new' && acts.includes('orders') && acts.includes('reports'), 'أزرار سريعة للمالك (طلب جديد أولاً)', acts);
  const k = await txt(page, '#homeKpis');
  ok(/المتبقي على العملاء 2,800\.00/.test(k) && /عروض أسعار مفتوحة 1/.test(k), 'الأرقام: المتبقي 650 + 1000 + 1150 (المدفوع زيادة لا يُنقص غيره) وعرض السعر', k);
  const at = await txt(page, '#homeAttn');
  ok(/#11/.test(at) && /تأخر التسليم 3 يوم/.test(at) && /#12/.test(at) && /مدفوع زيادة 150\.00/.test(at) && /#13/.test(at) && /سُلِّم وعليه 1,000\.00/.test(at), 'يحتاج متابعتك: التأخر والزيادة والتوصيل بلا تحصيل', at);
  const firstAttn = await page.evaluate(() => document.querySelector('#homeAttn [data-hattn="0"]').innerText);
  ok(/#11/.test(firstAttn), 'الترتيب: المتأخر أولاً', firstAttn);
  ok(/#15/.test(await txt(page, '#homeRecent')), 'آخر الطلبات: الأحدث يظهر');
  const map = await page.evaluate(() => [...document.querySelectorAll('#homeMap [data-hgo]')].map((b) => b.dataset.hgo));
  ok(map.includes('settings') && map.includes('users') && map.includes('order'), 'أين أجد: أقسام المالك', map);
  await page.evaluate(() => document.querySelector('#homeAttn [data-hattn="0"]').click());
  await sleep(1200);
  ok(await page.evaluate(() => document.body.dataset.page) === 'order' && /11/.test(await txt(page, '.order-title h2, #orderTitle')), 'الضغط على بند يفتح الطلب', await txt(page, '.order-title h2, #orderTitle'));
  await page.evaluate(() => document.querySelector('#mainNav [data-page="home"]').click()); await sleep(700);
  await page.evaluate(() => document.querySelector('#homeActions [data-hact="new"]').click()); await sleep(900);
  ok(await page.evaluate(() => document.body.dataset.page) === 'order', 'زر «طلب جديد» يفتح صفحة الطلب');
  await page.setViewport({ width: 390, height: 844 }); await sleep(500);
  ok(await page.evaluate(() => !!document.querySelector('#bottomNav [data-page="home"]') && getComputedStyle(document.getElementById('bottomNav')).display !== 'none'), 'الجوال: «الرئيسية» في الشريط السفلي');
  await page.evaluate(() => document.querySelector('#bottomNav [data-page="home"]').click()); await sleep(700);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'الجوال: لا تمرير أفقي في الرئيسية');
  await page.browserContext().close();

  /* ----- الموظف: بلا أقسام الإدارة ولا المصروفات ----- */
  const sp = await login('asim');
  ok(await sp.evaluate(() => document.body.dataset.page) === 'home', 'الموظف: يبدأ من الرئيسية');
  const sacts = await sp.evaluate(() => [...document.querySelectorAll('#homeActions [data-hact]')].map((b) => b.dataset.hact));
  ok(sacts.includes('new') && !sacts.includes('expense') && !sacts.includes('receipt'), 'الموظف: لا أزرار مصروفات بلا صلاحية', sacts);
  const smap = await sp.evaluate(() => [...document.querySelectorAll('#homeMap [data-hgo]')].map((b) => b.dataset.hgo));
  ok(!smap.includes('settings') && !smap.includes('users') && !smap.includes('items') && smap.includes('orders'), 'الموظف: خريطة الأقسام بلا الإدارة', smap);
  await sp.browserContext().close();

  /* ----- المندوب ----- */
  const mp = await login('mand');
  const mmap = await mp.evaluate(() => [...document.querySelectorAll('#homeMap [data-hgo]')].map((b) => b.dataset.hgo));
  ok(!mmap.includes('designs') && !mmap.includes('settings') && mmap.includes('order'), 'المندوب: أقسامه فقط', mmap);
  await mp.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== home-ui: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
