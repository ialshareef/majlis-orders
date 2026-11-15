/* اختبار واجهة آلي لعهدة الموظف (الاستلام):
   - الموظف يسجّل استلاماً، وكل مصروف بعده يُخصم من الرصيد، ويصدّر PDF لحركة العهدة.
   - المالك يرى عهد الجميع ويسجّل استلاماً لموظف، وتقرير «حركة العهدة» يعرض الحركات بالترتيب.
   الاستخدام: node test/custody-ui-e2e.mjs */
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
const OWN = ['expenses.view_own', 'expenses.add_own', 'expenses.edit_own', 'expenses.delete_own'];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'asim', 'عاصم', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }], items: [],
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, shareRate: 5 }), updated_at: past }],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses']) env.DB.tables.set(t, []);
env.DB.tables.set('user_permissions', OWN.map((p) => ({ user_id: '2', permission: p, value: 1, updated_by: '1', updated_at: past })));
// مصروف قديم قبل أول استلام: لا يُخصم من العهدة
env.DB.tables.set('expenses', [{ id: 'old', name: 'مصروف قديم', amount: 999, category: 'نقل', note: null, created_by: '2', created_at: past, updated_at: past, expense_date: past.slice(0, 10), order_id: null }]);
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
const go = async (page, name) => { await page.evaluate((n) => document.querySelector(`[data-page="${n}"]`).click(), name); await sleep(1200); };
const clean = (t) => String(t || '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
const box = (page) => page.evaluate(() => { const b = document.getElementById('custBox'); return b && !b.hidden ? b.innerText : ''; }).then(clean);
const stat = async (page, label) => { const t = await box(page); const m = t.match(new RegExp(label + ' ([\\d,.-]+)')); return m ? m[1] : null; };
async function addExpense(page, name, cat, amount) {
  await page.evaluate(() => document.getElementById('btnAddExpense').click());
  await page.waitForFunction(() => !!document.getElementById('exName'), { timeout: 10000 });
  await page.type('#exAmount', String(amount));
  const hint = clean(await page.evaluate(() => { const h = document.getElementById('exCustHint'); return h && !h.hidden ? h.innerText : ''; }));
  await page.evaluate((n, c) => { document.getElementById('exName').value = n; document.getElementById('exCat').value = c; document.getElementById('exSave').click(); }, name, cat);
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  await sleep(1500);
  return hint;
}

try {
  /* ----- الموظف: يسجّل استلام 1500 ثم يصرف 100 و200 ----- */
  const page = await login('asim');
  await go(page, 'expenses');
  ok(/عهدتي/.test(await box(page)) && /لا يوجد استلام مسجّل/.test(await box(page)), 'الموظف: بطاقة «عهدتي» قبل أي استلام', await box(page));
  await page.evaluate(() => document.getElementById('btnAddReceipt').click());
  await page.waitForFunction(() => !!document.getElementById('rcAmount'), { timeout: 10000 });
  ok(await page.evaluate(() => !document.getElementById('rcUser')), 'الموظف: لا خيار «المستلِم» (يسجّل لنفسه فقط)');
  await page.type('#rcAmount', '1500'); await page.type('#rcNote', 'من المدير');
  await page.evaluate(() => document.getElementById('rcSave').click());
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  await sleep(1200);
  const rr = env.DB.tables.get('custody_receipts') || [];
  ok(rr.length === 1 && rr[0].user_id === '2' && Number(rr[0].amount) === 1500 && /T\d{2}:\d{2}/.test(rr[0].created_at), 'الخادم: استلام 1500 باسم عاصم بوقت تلقائي', rr);
  ok(await stat(page, 'المستلم') === '1,500.00' && await stat(page, 'المتبقي') === '1,500.00', 'البطاقة: المستلم 1500 والمتبقي 1500 (المصروف القديم لا يُخصم)', await box(page));
  const h1 = await addExpense(page, 'بنزين', 'نقل', 100);
  ok(/رصيد العهدة الآن 1,500\.00 ← بعد هذا المصروف 1,400\.00/.test(h1), 'نافذة المصروف: الرصيد الآن وبعد المصروف', h1);
  await addExpense(page, 'مسامير', 'مشتريات', 200);
  ok(await stat(page, 'المصروف منه') === '300.00' && await stat(page, 'المتبقي') === '1,200.00', 'البطاقة: صُرف 300 والمتبقي 1200', await box(page));
  ok(/آخر الاستلامات/.test(await box(page)) && /من المدير/.test(await box(page)), 'البطاقة: آخر الاستلامات بملاحظتها');
  ok(/استلمت 1,500\.00 − صرفت 300\.00 = المتبقي 1,200\.00/.test(await box(page)), 'البطاقة: سطر واضح «استلمت − صرفت = المتبقي»', await box(page));
  const stmt = await page.evaluate(() => [...document.querySelectorAll('#custBox .cust-moves tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  ok(stmt.length === 3 && /مسامير/.test(stmt[0]) && /1,200\.00/.test(stmt[0]) && /بنزين/.test(stmt[1]) && /1,400\.00/.test(stmt[1]) && /استلام/.test(stmt[2]) && /1,500\.00/.test(stmt[2]), 'البطاقة: كشف الحركة (الأحدث أولاً) بالرصيد بعد كل حركة', stmt);

  // تصدير PDF من البطاقة
  await page.evaluate(() => document.getElementById('custPdf').click());
  await page.waitForFunction(() => window.__dl && window.__dl.length > 0, { timeout: 60000 });
  const files = await page.evaluate(() => Promise.all(window.__dl));
  const pdf = files.find((f) => /\.pdf$/.test(f.name));
  ok(pdf && /^custody-/.test(pdf.name) && pdf.size > 3000 && Buffer.from(pdf.b64, 'base64').subarray(0, 5).toString() === '%PDF-', 'PDF: ملف حركة العهدة صالح', pdf && { name: pdf.name, size: pdf.size });
  const pg = await page.evaluate(() => window.__pdfPages);
  // زر «مشاركة PDF واتساب»: في المتصفح بلا مشاركة ملفات يُحفظ الملف مع تنبيه (وفي التطبيق تفتح المشاركة)
  await page.evaluate(() => { window.__dl = []; document.getElementById('custWa').click(); });
  await page.waitForFunction(() => window.__dl && window.__dl.length > 0, { timeout: 60000 });
  const wf = (await page.evaluate(() => Promise.all(window.__dl))).find((f) => /\.pdf$/.test(f.name));
  ok(wf && /^custody-/.test(wf.name) && await page.evaluate(() => /واتساب/.test(document.body.innerText)), 'واتساب: زر المشاركة ينشئ ملف حركة العهدة', wf && wf.name);
  ok(pg.length >= 1 && pg.every((p) => !p.over.length && p.footIn) && /حركة العهدة/.test(pg[0].title || ''), 'PDF: صفحة «حركة العهدة» بلا صفوف مقصوصة', pg);
  await page.browserContext().close();

  /* ----- المالك: يرى عهد الجميع ويسجّل لعاصم استلاماً إضافياً ----- */
  const op = await login('owner');
  await go(op, 'expenses');
  const ot = await box(op);
  ok(/عهد الموظفين/.test(ot) && /عاصم 1,500\.00 300\.00 1,200\.00/.test(ot), 'المالك: جدول عهد الموظفين (عاصم: 1500 / 300 / 1200)', ot);
  await op.evaluate(() => { const s = document.getElementById('expUser'); s.value = '2'; s.dispatchEvent(new Event('change')); });
  await sleep(500);
  ok(/عهدة عاصم/.test(await box(op)), 'المالك: اختيار عاصم يعرض عهدته', await box(op));
  await op.evaluate(() => document.getElementById('custAdd').click());
  await op.waitForFunction(() => !!document.getElementById('rcAmount'), { timeout: 10000 });
  ok(await op.evaluate(() => document.getElementById('rcUser').value === '2'), 'المالك: المستلِم محدد مسبقاً (عاصم)');
  await op.type('#rcAmount', '300');
  await op.evaluate(() => document.getElementById('rcSave').click());
  await op.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  await sleep(1200);
  const r2 = (env.DB.tables.get('custody_receipts') || []).find((r) => Number(r.amount) === 300);
  ok(r2 && r2.user_id === '2' && r2.created_by === '1', 'الخادم: استلام 300 لعاصم سجّله المالك', r2);
  ok(await stat(op, 'المتبقي') === '1,500.00', 'البطاقة: المتبقي صار 1500', await box(op));

  // تقرير «حركة العهدة» في صفحة التقارير
  await go(op, 'reports');
  ok(await op.evaluate(() => { const b = document.getElementById('btnRepWa'); return !!b && /واتساب/.test(b.textContent); }), 'التقارير: زر «واتساب» بجانب PDF');
  await op.evaluate(() => document.querySelector('#repCatalog [data-rep="custody"]').click()); await sleep(1500);
  await op.evaluate(() => document.querySelector('#repRangeChips [data-rr="all"]').click()); await sleep(1000);
  const mv = await op.evaluate(() => { const t = document.querySelectorAll('#repTables table')[1]; return t ? [...t.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()) : []; });
  ok(mv.length === 4 && /استلام/.test(mv[0]) && /بنزين/.test(mv[1]) && /نقل/.test(mv[1]) && /مسامير/.test(mv[2]) && /مشتريات/.test(mv[2]), 'التقرير: 4 حركات بالترتيب (استلام، بنزين، مسامير، استلام) بنوع الصرف', mv);
  await op.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== custody-ui: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
