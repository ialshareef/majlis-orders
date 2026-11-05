/* اختبار واجهة آلي لصفحة «التقارير»: الظهور بالصلاحيات، الأرقام، والتصدير PDF / Excel / CSV.
   الخادم الحقيقي على D1 وهمية + index.html في Chrome/Edge headless (نفس أسلوب permission-ui-e2e.mjs).
   يحتاج اتصالاً بالإنترنت لمكتبات PDF/Excel (cdnjs) كما في التطبيق نفسه.
   الاستخدام: node test/reports-ui-e2e.mjs [--save <مجلد>]   (--save يحفظ الملفات المُصدَّرة للفحص اليدوي) */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { routeDownloads, TEST_DL } from './_downloads.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
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
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const thisMonth = (dd) => day(new Date(now.getFullYear(), now.getMonth(), Math.min(dd, now.getDate())));
const U = (id, username, name, role, extra = {}) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H, ...extra });
const ord = (id, number, by, byName, date, { subtotal = 1000, cost = 600, paid = 0, status = 'new', rates = { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 } } = {}) => {
  const at = date + 'T09:00:00.000Z';
  const total = Math.round(subtotal * 1.15 * 100) / 100;
  return { id, number, status, customer_name: 'عميل ' + number, created_by: by, created_at: at, updated_at: at,
    data: JSON.stringify({ id, number, status, createdBy: by, createdByName: byName, createdAt: at, updatedAt: at,
      customer: { name: 'عميل ' + number, phone: '05000' + String(number).padStart(5, '0') }, design: { pieces: [] }, lines: [],
      subtotal, discount: 0, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: total - subtotal, total, paid, remaining: total - paid,
      costTotal: cost, commRates: rates,
      payments: paid ? [{ id: 'p' + id, at: date, amount: paid, method: 'cash', note: '', by: byName }] : [] }) };
};
const orders = [
  ord('o1', 1, '2', 'سالم الموظف', thisMonth(1), { subtotal: 1000, cost: 600, paid: 500 }),
  ord('o2', 2, '3', 'مندوب تابع', thisMonth(2), { subtotal: 2000, cost: 1000, paid: 2300, status: 'delivered', rates: { ownerRate: 20, parentId: '4', parentRate: 5, shareRate: 5 } }),
  ord('o3', 3, '2', 'سالم الموظف', thisMonth(2), { subtotal: 900, cost: 100, status: 'quote' }),
];
// طلبات كثيرة للمالك لاختبار تقسيم PDF على صفحات
for (let i = 0; i < 70; i++) orders.push(ord('b' + i, 100 + i, '1', 'المالك', day(new Date(now.getFullYear() - 1, 3, 1 + (i % 25))), { subtotal: 500 + i, cost: 300 }));
const grant = (user_id, list, value = 1) => list.map((permission) => ({ user_id, permission, value, updated_by: '1', updated_at: past }));
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'staff1', 'سالم الموظف', 'staff'), U('3', 'mand2', 'مندوب تابع', 'mandoub', { parent_id: '4' }), U('4', 'mand1', 'مندوب أعلى', 'mandoub'), U('5', 'staff2', 'موظف بلا تقارير', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 200 }], settings: [{ id: 1, data: '{}', updated_at: past }], items: [],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses']) env.DB.tables.set(t, []);
env.DB.tables.set('expenses', [{ id: 'e1', name: 'إيجار', amount: 100, category: 'إيجار', note: '', created_by: '1', created_at: thisMonth(1) + 'T08:00:00Z', updated_at: thisMonth(1) + 'T08:00:00Z', expense_date: thisMonth(1), order_id: null }]);
env.DB.tables.set('user_permissions', [
  ...grant('2', ['reports.view_own', 'reports.export']),
  ...grant('3', ['reports.view_own']),
]);
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

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي اختبار الواجهة'); server.close(); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
routeDownloads(browser); // تنزيلات الاختبار إلى Documents/majlis-test-downloads لا مجلد التنزيلات
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(username + ': ' + String(e.message).split('\n')[0]));
  // التقاط التنزيلات: browserDownload ينقر رابط blob بسمة download
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
const navVisible = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#mainNav button[data-page]')].map((b) => [b.dataset.page, !b.hidden])));
const go = async (page, name) => { await page.evaluate((n) => document.querySelector(`#mainNav button[data-page="${n}"]`).click(), name); await sleep(900); };
const tabs = (page) => page.evaluate(() => [...document.querySelectorAll('#repCatalog [data-rep]')].map((b) => b.dataset.rep));
const pick = async (page, id) => { await page.evaluate((i) => document.querySelector(`#repCatalog [data-rep="${i}"]`).click(), id); await sleep(400); };
const range = async (page, rr) => { await page.evaluate((r) => document.querySelector(`#repRangeChips [data-rr="${r}"]`).click(), rr); await sleep(400); };
const kpis = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#repKpis .stat')].map((s) => [s.querySelector('span').textContent.trim(), s.querySelector('b').textContent.trim()])));
const heads = (page, i = 0) => page.evaluate((k) => { const t = document.querySelectorAll('#repTables table')[k]; return t ? [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : []; }, i);
const bodyRows = (page, i = 0) => page.evaluate((k) => { const t = document.querySelectorAll('#repTables table')[k]; return t ? [...t.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()) : []; }, i);
/* أوامر النص في PDF (BT…ET و«(…) Tj») خارج بيانات الصور فقط: بايتات JPEG المضغوطة عشوائية وقد تحوي
   «) Tj» بالمصادفة (حدث فعلاً: «%)Tj» داخل صورة DCTDecode في تقرير يوم 2026-11-06 فأفشل الفحص زوراً).
   تُحذف محتويات تيارات /Subtype /Image فقط — كل تيار محتوى آخر (حيث يكتب jsPDF النص) يُفحص كما هو. */
function pdfTextOps(latin1) {
  const out = [];
  let i = 0;
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin1))) {
    const start = m.index + m[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end < 0) break;
    const dict = latin1.slice(Math.max(0, latin1.lastIndexOf('obj', m.index)), m.index);
    out.push(latin1.slice(i, start));
    if (!/\/Subtype\s*\/Image/.test(dict)) out.push(latin1.slice(start, end));   // تيار محتوى: يُفحص
    i = end;
    re.lastIndex = end + 9;
  }
  out.push(latin1.slice(i));
  const s = out.join('');
  return { tj: (s.match(/\)\s*Tj/g) || []).length, bt: (s.match(/(^|[\s\]>)])BT[\s\r\n]/g) || []).length };
}

async function download(page, btn) {
  await page.evaluate(() => { window.__dl = []; });
  await page.evaluate((b) => document.getElementById(b).click(), btn);
  await page.waitForFunction(() => window.__dl.length > 0, { timeout: 90000 });
  const f = await page.evaluate(() => window.__dl[window.__dl.length - 1]);
  const buf = Buffer.from(f.b64, 'base64');
  if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); fs.writeFileSync(path.join(saveDir, f.name), buf); }
  return { name: f.name, buf };
}

try {
  /* ----- المالك: كل التقارير والتصدير ----- */
  let page = await login('owner');
  let nav = await navVisible(page);
  ok(nav.reports === true, 'owner: «التقارير» في القائمة', nav);
  await go(page, 'reports');
  ok(await page.evaluate(() => document.getElementById('page-reports').classList.contains('active')), 'owner: الصفحة تُفتح');
  ok((await tabs(page)).join() === 'orders,commissions,pnl,staff,payments,receivables,expenses,customers,visits', 'owner: الفهرس كامل (9 تقارير مع «زيارات الموقع» للمالك)', await tabs(page));
  await pick(page, 'orders'); await range(page, 'm');
  let k = await kpis(page);
  ok(k['المبيعات قبل الضريبة'] === '3,000.00' && k['التكاليف'] === '1,600.00' && k['صافي الربح'] === '1,400.00', 'owner/orders: البيع 3000 والتكاليف 1600 والربح 1400 (هذا الشهر)', k);
  ok(k['إجمالي العمولات والحصص'] === '360.00' && k['المحصّل'] === '2,800.00', 'owner/orders: العمولات 360 والمحصّل 2800', k);
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    await page.screenshot({ path: path.join(saveDir, 'screen-desktop.png'), fullPage: false });
    await page.setViewport({ width: 390, height: 844 }); await sleep(500);
    await page.screenshot({ path: path.join(saveDir, 'screen-mobile.png'), fullPage: false });
    await page.setViewport({ width: 1366, height: 900 }); await sleep(300);
  }
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'owner: بلا تمرير أفقي للصفحة');
  const h = await heads(page);
  ok(['الموظف / المندوب', 'المندوب الأعلى', 'التكاليف', 'صافي الربح', 'عمولة صاحب الطلب', 'الربح بعد العمولات', 'المتبقي'].every((x) => h.includes(x)), 'owner/orders: أعمدة الموظف والمندوب والتكاليف والربح والعمولات', h);
  const rows = await bodyRows(page);
  ok(rows.length === 2 && rows.some((r) => r.includes('مندوب تابع') && r.includes('مندوب أعلى')), 'owner/orders: صفان (بلا عرض السعر) وصف المندوب يذكر مندوبه الأعلى', rows);
  await page.select('#repStatus', 'all'); await sleep(400);
  ok((await bodyRows(page)).length === 3, 'owner/orders: «كل الطلبات» تضيف عرض السعر');
  await page.select('#repStatus', ''); await sleep(200);
  await page.select('#repUser', '3'); await sleep(400);
  ok((await bodyRows(page)).length === 1, 'owner/orders: تصفية بالمندوب');
  await page.select('#repUser', ''); await sleep(300);

  await pick(page, 'pnl');
  k = await kpis(page);
  ok(k['صافي ربح الطلبات'] === '1,400.00' && k['العمولات والحصص'] === '360.00' && k['المصروفات'] === '100.00' && k['صافي الربح النهائي'] === '940.00', 'owner/pnl: 1400 − 360 − 100 = 940', k);
  await pick(page, 'commissions');
  const cr = await bodyRows(page);
  ok(cr.some((r) => r.includes('مندوب تابع') && r.includes('200.00')) && cr.some((r) => r.includes('مندوب أعلى') && r.includes('50.00')), 'owner/commissions: المندوب 200 والمندوب الأعلى 50', cr);

  // التصدير
  await pick(page, 'orders');
  let f = await download(page, 'btnRepCsv');
  const csv = f.buf.toString('utf8');
  ok(f.name.endsWith('.csv') && csv.charCodeAt(0) === 0xfeff && csv.includes('تفصيل الطلبات') && csv.includes('مندوب أعلى') && csv.includes('1400'), 'export/csv: ملف CSV بالعربية والأرقام', f.name);
  f = await download(page, 'btnRepXlsx');
  ok(f.name.endsWith('.xlsx') && f.buf.slice(0, 2).toString() === 'PK' && f.buf.length > 3000, 'export/xlsx: ملف Excel صالح (zip)', { name: f.name, size: f.buf.length });
  f = await download(page, 'btnRepPdf');
  let pdfTxt = f.buf.toString('latin1');
  let pagesN = (pdfTxt.match(/\/Type \/Page\b(?!s)/g) || []).length;
  ok(f.name.endsWith('.pdf') && pdfTxt.startsWith('%PDF') && pagesN === 1, 'export/pdf: تقرير قصير = صفحة واحدة', { name: f.name, pagesN });
  await range(page, 'all');
  f = await download(page, 'btnRepPdf');
  pdfTxt = f.buf.toString('latin1');
  pagesN = (pdfTxt.match(/\/Type \/Page\b(?!s)/g) || []).length;
  ok(pagesN >= 3, 'export/pdf: 72 طلباً تُقسَّم على عدة صفحات', { pagesN, size: f.buf.length });
  ok(!(await page.evaluate(() => !!document.querySelector('.rep-print'))), 'export/pdf: لا بقايا صفحات مؤقتة في الصفحة');

  /* ----- «ذكاء الأعمال»: أزرار PDF القديمة تمرّ بمحرّك الصفحات المصوَّرة (عربية متصلة)
     لا بنص jsPDF المباشر (حروف منفصلة)، وأزرار Excel تحمّل مكتبتها بنفسها ----- */
  await go(page, 'bi');
  await page.evaluate(() => { const b = document.querySelector('#biRangeChips [data-rg="all"]'); if (b) b.click(); });
  await sleep(600);
  for (const b of ['btnBiPdf', 'btnOrdersPdf', 'btnMandoubsPdf', 'btnExpensesPdf']) {
    f = await download(page, b);
    const t = f.buf.toString('latin1');
    const txt = pdfTextOps(t);
    ok(f.name.endsWith('.pdf') && t.startsWith('%PDF') && /\/Subtype\s*\/Image/.test(t) && txt.tj === 0 && txt.bt === 0, `bi/${b}: PDF مصوَّر بالعربية المتصلة (بلا نص jsPDF مباشر)`, { name: f.name, size: f.buf.length, ...txt });
  }
  ok(!(await page.evaluate(() => !!document.querySelector('.rep-print'))), 'bi/pdf: لا بقايا صفحات مؤقتة');
  await page.evaluate(() => { try { delete window.XLSX; } catch (_) { window.XLSX = undefined; } });
  for (const b of ['btnBiXlsx', 'btnOrdersXlsx', 'btnMandoubsXlsx', 'btnExpensesXlsx']) {
    f = await download(page, b);
    ok(f.name.endsWith('.xlsx') && f.buf.slice(0, 2).toString() === 'PK', `bi/${b}: ملف Excel صالح حتى دون تحميل المكتبة مسبقاً`, { name: f.name, size: f.buf.length });
  }
  await page.browserContext().close();

  /* ----- موظف بـ reports.view_own + export: طلباته فقط، بلا عمولات ----- */
  page = await login('staff1');
  nav = await navVisible(page);
  ok(nav.reports === true, 'staff/view_own: «التقارير» ظاهرة بالصلاحية الممنوحة');
  await go(page, 'reports');
  const st = await tabs(page);
  ok(!st.includes('commissions') && !st.includes('expenses') && st.includes('pnl'), 'staff: لا تقرير عمولات ولا مصروفات (بلا صلاحيتهما)، وصافي الأرباح لطلباته', st);
  ok(await page.evaluate(() => document.getElementById('repUser').hidden), 'staff: لا اختيار موظف آخر (طلباته فقط)');
  await pick(page, 'orders'); await range(page, 'm');
  const sr = await bodyRows(page);
  ok(sr.length === 1 && sr[0].includes('سالم الموظف'), 'staff: يرى طلبه فقط', sr);
  ok(!(await heads(page)).includes('عمولة صاحب الطلب'), 'staff: بلا أعمدة عمولة');
  ok(await page.evaluate(() => !document.getElementById('btnRepPdf').hidden), 'staff: زر التصدير ظاهر (reports.export)');
  await page.browserContext().close();

  /* ----- مندوب بـ reports.view_own بلا export: عمولته فقط بلا ربح ----- */
  page = await login('mand2');
  await go(page, 'reports');
  const mt = await tabs(page);
  ok(mt.includes('commissions') && !mt.includes('pnl'), 'mandoub: تقرير العمولات متاح وصافي الأرباح لا (بلا صلاحية الربح)', mt);
  await pick(page, 'commissions'); await range(page, 'm');
  const mr = await bodyRows(page);
  ok(mr.length === 1 && mr[0].includes('200.00'), 'mandoub: عمولته 200 فقط', mr);
  ok(!(await heads(page)).some((x) => x.includes('ربح')), 'mandoub: بلا أعمدة ربح', await heads(page));
  await pick(page, 'orders');
  ok(!(await heads(page)).includes('صافي الربح') && !(await heads(page)).includes('التكاليف'), 'mandoub/orders: بلا تكاليف ولا ربح');
  ok(await page.evaluate(() => document.getElementById('btnRepPdf').hidden && document.getElementById('btnRepXlsx').hidden && document.getElementById('btnRepCsv').hidden), 'mandoub: بلا أزرار تصدير (بلا reports.export)');
  await page.browserContext().close();

  /* ----- موظف بلا صلاحية تقارير ----- */
  page = await login('staff2');
  nav = await navVisible(page);
  ok(nav.reports === false, 'staff2: «التقارير» مخفية بلا reports.view_*', nav);
  await page.evaluate(() => document.querySelector('#mainNav button[data-page="reports"]').click()); await sleep(500);
  ok(!(await page.evaluate(() => document.getElementById('page-reports').classList.contains('active'))), 'staff2: فتح الصفحة برمجياً يُعاد إلى الطلب');
  await page.browserContext().close();

  ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript في الصفحة', pageErrors);
} catch (e) {
  fail++; console.log('FAIL  harness :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally {
  await browser.close();
  server.close();
}
console.log(`=== reports-ui: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
