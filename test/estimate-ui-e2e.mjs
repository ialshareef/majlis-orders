/* اختبار واجهة آلي للتكلفة التقديرية: البطاقة في مرحلة التسعير بأرقامها (قماش، ألواح إسفنج، هيكل، أجرة، إكسسوار)،
   وتنبيه الربح المنخفض، و«اعتماد كتكلفة»، وقسم الإعدادات — والموظف لا تصله أسعار الجملة.
   الاستخدام: node test/estimate-ui-e2e.mjs */
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
const ITEMS = [
  { id: 'w1', name: 'كنب سويدي', category: 'wood', unit: 'm', price: 300, cost: 100, seatType: 'sofa', depth: 0.8, active: true, color: '#8b5a2b' },
  { id: 'f1', name: 'شمواه', category: 'fabric', unit: 'm', price: 100, cost: 50, active: true, color: '#aa8866' },
  { id: 'm1', name: 'إسفنج HR', category: 'foam', unit: 'm', price: 50, cost: 120, sheetLen: 2, active: true, color: '#eeeeee' },
  { id: 'a1', name: 'طاولة', category: 'acc', unit: 'pc', price: 400, cost: 250, w: 1, h: 0.6, shape: 'rect', active: true, color: '#7f8c8d' },
];
const od = { id: 'o1', number: 1, status: 'new', createdBy: '1', createdByName: 'المالك', createdAt: now, updatedAt: now,
  customer: { name: 'عميل التقدير', phone: '0500000001' },
  design: { room: { w: 5, h: 4 }, walls: [], openings: [], pieces: [
    { id: 's1', kind: 'sofa', wall: 0, t: 0.5, w: 3, h: 0.8, rot: 0, x: 0, y: 0, woodId: 'w1', fabricId: 'f1', foamId: 'm1' },
    { id: 'a1p', kind: 'acc', itemId: 'a1', x: 2, y: 2, w: 1, h: 0.6, rot: 0 },
  ] },
  subtotal: 1750, discount: 0, vat: { enabled: false, rate: 15 }, vatRate: 0, total: 1750, paid: 0, remaining: 1750, payments: [] };
const orders = [{ id: 'o1', number: 1, status: 'new', customer_name: od.customer.name, created_by: '1', created_at: now, updated_at: now, data: JSON.stringify(od) }];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'asim', 'عاصم', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }],
  items: ITEMS.map((i) => ({ id: i.id, data: JSON.stringify(i), updated_at: now })),
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, shareRate: 5, vatEnabled: false }), updated_at: past }],
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

try {
  const page = await login('owner');
  await page.evaluate(() => document.querySelector('#mainNav [data-page="orders"]').click()); await sleep(900);
  await page.evaluate(() => document.querySelector('[data-open="o1"]').click()); await sleep(1500);
  await page.evaluate(() => document.querySelector('#stepNav a[data-stage="price"]').click()); await sleep(900);
  const box = clean(await page.evaluate(() => { const b = document.getElementById('estBox'); return b && !b.hidden ? b.innerText : ''; }));
  // القماش: 3 م × 2.5 × عمق 1 × هدر 10٪ = 8.25 م × 50 = 412.50 • الإسفنج: 3 × 2 طبقة ÷ لوح 2 م = 3 ألواح × 120 = 360
  // الهيكل: 3 × 100 = 300 • الأجرة: 3 × 70 = 210 • الطاولة 250 → المجموع 1,532.50 • الربح 1750 − 1532.5 = 217.50 (12.43٪)
  ok(/التكلفة التقديرية/.test(box), 'بطاقة «التكلفة التقديرية» في مرحلة التسعير للمالك', box.slice(0, 200));
  ok(/8\.25 م 412\.50/.test(box) && /3\.00 لوح 360\.00/.test(box) && /300\.00/.test(box) && /3\.00 م × 70\.00 210\.00/.test(box) && /طاولة × 1\.00 250\.00/.test(box), 'التفصيل: القماش والإسفنج (ألواح) والهيكل والأجرة والإكسسوار', box);
  ok(/التكلفة التقديرية 1,532\.50/.test(box) && /الربح التقديري 217\.50/.test(box), 'المجموع 1,532.50 والربح التقديري 217.50', box);
  ok(/أقل من 30\.00٪|أقل من 30٪/.test(box), 'تنبيه الربح المنخفض (أقل من 30٪)', box.slice(-260));
  // اعتماد كتكلفة: نافذة التكاليف معبّأة بالتقدير
  await page.evaluate(() => document.getElementById('estApply').click()); await sleep(900);
  const pre = await page.evaluate(() => [...document.querySelectorAll('#modal input[data-ck]')].map((i) => ({ v: i.value, est: i.dataset.est === '1' })));
  ok(pre.length === 2 && pre.some((x) => x.v === '427.5' && x.est) && pre.some((x) => x.v === '250' && x.est), 'اعتماد كتكلفة: تكلفة متر الكنب 427.5 والطاولة 250 معبّأة كقيم تقديرية', pre);
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(400);
  // الإعدادات: قسم التكلفة التقديرية، وتغيير الأجرة ينعكس
  await page.evaluate(() => document.querySelector('#mainNav [data-page="settings"]').click()); await sleep(1000);
  ok(await page.evaluate(() => !!document.getElementById('set-est') && !!document.getElementById('sEstL_sofa')), 'الإعدادات: قسم «التكلفة التقديرية» بمعدّلات كل نوع جلسة');
  await page.browserContext().close();

  /* ----- الموظف: لا بطاقة تقدير ولا أسعار جملة ----- */
  const sp = await login('asim');
  const leaked = await sp.evaluate(() => JSON.stringify(['w1', 'f1', 'm1', 'a1'].map((id) => Store.getItem(id))));
  ok(/شمواه/.test(leaked) && !/"cost"/.test(leaked) && !/sheetLen/.test(leaked), 'الموظف: لا تصل أسعار الجملة إلى جهازه', leaked.slice(0, 200));
  await sp.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== estimate-ui: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
