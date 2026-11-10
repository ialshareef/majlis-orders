/* اختبار واجهة آلي لـ«ملخص الطلب» وملف PDF الإدارة:
   الأرقام (البيع، الخصم، الضريبة، الدفعات، كل بند تكلفة، صافي الربح، المصروفات المربوطة)،
   وإخفاء التكاليف وزر PDF عمّن لا يرى التكاليف، وتخطيط صفحات PDF، والجوال بلا تمرير أفقي.
   الاستخدام: node test/order-summary-e2e.mjs [--save <مجلد>] */
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
const at = new Date(Date.now() - 86400000 * 3).toISOString();
const U = (id, username, name, role, extra = {}) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H, ...extra });
/* طلب المالك: طاولة 2×500 (تكلفة 300 للوحدة) + سجاد 400 بلا تكلفة، خصم 100، ضريبة 15٪
   البيع 1400، الإيراد 1300، الإجمالي 1495؛ التكاليف 600 + توصيل 150 = 750؛ الربح 550؛ مدفوع 500 */
const mk = (id, number, by, byName, extra = {}) => {
  const d = Object.assign({ id, number, status: 'progress', createdBy: by, createdByName: byName, createdAt: at, updatedAt: at,
    customer: { name: 'عميل ' + number, phone: '0500000' + number }, design: { pieces: [] },
    manualRows: [{ name: 'طاولة', qty: 2, unit: 'قطعة', price: 500, cost: 300 }, { name: 'سجاد', qty: 1, unit: 'قطعة', price: 400 }],
    extraCosts: [{ name: 'التوصيل', amount: 150 }],
    subtotal: 1400, discount: 100, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: 195, total: 1495, paid: 500, remaining: 995,
    costTotal: 750, commRates: { ownerRate: 10, parentId: null, parentRate: null, shareRate: 0 },
    payments: [{ id: 'p' + id, at: at.slice(0, 10), amount: 500, method: 'transfer', note: 'عربون', by: byName }] }, extra);
  return { id, number, status: d.status, customer_name: d.customer.name, created_by: by, created_at: at, updated_at: at, data: JSON.stringify(d) };
};
const lateDay = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
const orders = [mk('o1', 1, '1', 'المالك', { deliveryDate: lateDay }), mk('o3', 3, '5', 'موظف بلا تكاليف')];
const grant = (user_id, list, value = 1) => list.map((permission) => ({ user_id, permission, value, updated_by: '1', updated_at: past }));
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('5', 'staff2', 'موظف بلا تكاليف', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }], settings: [{ id: 1, data: '{}', updated_at: past }], items: [],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses']) env.DB.tables.set(t, []);
env.DB.tables.set('expenses', [
  { id: 'e1', name: 'قماش إضافي', amount: 80, category: 'خامات', note: 'للطلب 1', created_by: '1', created_at: at, updated_at: at, expense_date: at.slice(0, 10), order_id: 'o1' },
  { id: 'e2', name: 'إيجار', amount: 1000, category: 'إيجار', note: '', created_by: '1', created_at: at, updated_at: at, expense_date: at.slice(0, 10), order_id: null },
]);
env.DB.tables.set('user_permissions', [...grant('5', ['costs.view_own', 'profit.view_own'], 0)]);
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
        const c = await real(el, o);
        if (window.__shots && el.classList && el.classList.contains('rep-page')) window.__shots.push(c.toDataURL('image/jpeg', 0.8));
        return c;
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
const navVisible = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#mainNav button[data-page]')].map((b) => [b.dataset.page, !b.hidden]).concat([...document.querySelectorAll('.page-tabs [data-goto]')].map((b) => [b.dataset.goto, !b.hidden]))));
const go = async (page, name) => { await page.evaluate((n) => (document.querySelector(`#mainNav button[data-page="${n}"]`) || document.querySelector(`.page-tabs [data-goto="${n}"]`)).click(), name); await sleep(900); };
const tabs = (page) => page.evaluate(() => [...document.querySelectorAll('#repCatalog [data-rep]')].map((b) => b.dataset.rep));
const pick = async (page, id) => { await page.evaluate((i) => document.querySelector(`#repCatalog [data-rep="${i}"]`).click(), id); await sleep(400); };
const range = async (page, rr) => { await page.evaluate((r) => document.querySelector(`#repRangeChips [data-rr="${r}"]`).click(), rr); await sleep(400); };
const kpis = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#repKpis .stat')].map((s) => [s.querySelector('span').textContent.trim(), s.querySelector('b').textContent.trim()])));
const heads = (page, i = 0) => page.evaluate((k) => { const t = document.querySelectorAll('#repTables table')[k]; return t ? [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : []; }, i);
const bodyRows = (page, i = 0) => page.evaluate((k) => { const t = document.querySelectorAll('#repTables table')[k]; return t ? [...t.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()) : []; }, i);
const pdfLayout = (page) => page.evaluate(() => { const p = window.__pdfPages || []; return { n: p.length, titles: p.map((x) => x.title), bad: p.filter((x) => x.over.length || !x.footIn || !/صفحة \d+ من \d+/.test(x.foot)) }; });
const openSum = async (page, id) => {
  const label = await page.evaluate((i) => { const b = document.querySelector(`[data-sum="${i}"]`); if (!b) return null; const t = b.textContent.trim(); b.click(); return t; }, id);
  await sleep(1200);
  return label;
};
const readSum = (page) => page.evaluate(() => {
  const m = document.getElementById('modal');
  return {
    open: !!m && !m.hidden,
    title: (document.getElementById('modalTitle') || {}).textContent || '',
    kpis: Object.fromEntries([...m.querySelectorAll('.sum-kpis .stat')].map((s) => [s.querySelector('span').textContent.trim(), s.querySelector('b').textContent.trim()])),
    heads: [...m.querySelectorAll('.sum-h')].map((h) => h.textContent.trim()),
    tables: [...m.querySelectorAll('.sum-table')].map((t) => [...t.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim())),
    notes: [...m.querySelectorAll('.sum-notes li')].map((l) => l.textContent.trim()),
    pdf: !!m.querySelector('#sumPdf'), wa: !!m.querySelector('#sumWa'), cost: !!m.querySelector('#sumCost'),
    meta: m.querySelector('.sum-meta') ? m.querySelector('.sum-meta').innerText.replace(/\s+/g, ' ') : '',
  };
});

try {
  /* ----- المالك: الملخص كامل مع كل بند تكلفة ----- */
  let page = await login('owner');
  await go(page, 'orders');
  const lbl = await openSum(page, 'o1');
  ok(lbl === 'ملخص الطلب والتكاليف', 'owner: عنصر «ملخص الطلب والتكاليف» في قائمة الطلب', lbl);
  let s = await readSum(page);
  ok(s.open && /ملخص الطلب #1/.test(s.title), 'owner: نافذة «ملخص الطلب #1» تُفتح', s.title);
  ok(s.kpis['الإجمالي شامل الضريبة'] === '1,495.00' && s.kpis['قبل الضريبة (بعد الخصم)'] === '1,300.00' && s.kpis['المدفوع'] === '500.00' && s.kpis['المتبقي'] === '995.00', 'owner: الإجمالي 1495 وقبل الضريبة 1300 والمدفوع 500 والمتبقي 995', s.kpis);
  ok(s.kpis['إجمالي التكاليف'] === '750.00' && s.kpis['صافي الربح'] === '550.00' && /42\.31/.test(s.kpis['هامش الربح'] || ''), 'owner: إجمالي التكاليف 750 وصافي الربح 550 والهامش 42.31٪', s.kpis);
  ok(s.kpis['عمولة البائع (10٪)'] === '55.00', 'owner: العمولة 10٪ = 55', s.kpis);
  ok(s.heads.join('|') === 'الأصناف وتكاليفها|تكاليف إضافية على الطلب|ملخص الحساب|الدفعات|مصروفات مسجّلة على هذا الطلب (صفحة المصروفات)', 'owner: الأقسام الخمسة بالترتيب', s.heads);
  const items = s.tables[0] || [];
  ok(items.length === 3 && /طاولة/.test(items[0]) && /300\.00/.test(items[0]) && /600\.00/.test(items[0]) && /400\.00/.test(items[0]) && /سجاد/.test(items[1]) && /—/.test(items[1]) && /المجموع/.test(items[2]) && /1,400\.00/.test(items[2]), 'owner: الأصناف بتكلفة الوحدة وإجماليها وربحها، والسجاد بلا تكلفة (—)', items);
  ok((s.tables[1] || []).some((r) => /التوصيل/.test(r) && /150\.00/.test(r)), 'owner: بند «التوصيل 150» كما سُجّل', s.tables[1]);
  const accTxt = (s.tables[2] || []).join(' || ');
  ok(/الخصم -?100\.00|الخصم -100/.test(accTxt) && /ضريبة القيمة المضافة \(15٪\) 195\.00/.test(accTxt) && /تكاليف الأصناف -600\.00/.test(accTxt) && /التكاليف الإضافية -150\.00/.test(accTxt) && /إجمالي التكاليف -750\.00/.test(accTxt) && /صافي الربح 550\.00/.test(accTxt), 'owner: ملخص الحساب خطوة بخطوة (خصم، ضريبة، تكاليف، ربح)', accTxt);
  ok((s.tables[3] || []).some((r) => /تحويل بنكي/.test(r) && /500\.00/.test(r) && /عربون/.test(r)), 'owner: الدفعة بالطريقة والملاحظة', s.tables[3]);
  ok((s.tables[4] || []).length === 2 && /قماش إضافي/.test(s.tables[4][0]) && /80\.00/.test(s.tables[4][0]) && !(s.tables[4] || []).some((r) => /إيجار/.test(r)), 'owner: المصروف المربوط بالطلب فقط (لا الإيجار العام)', s.tables[4]);
  ok(s.notes.some((n) => /^1 من الأصناف بلا تكلفة/.test(n)) && s.notes.some((n) => /لا يُرسل للعميل/.test(n)), 'owner: تنبيه «صنف بلا تكلفة» و«مستند داخلي»', s.notes);
  ok(/صاحب الطلب المالك/.test(s.meta) && /عميل 1/.test(s.meta) && /قيد التنفيذ/.test(s.meta), 'owner: بيانات الطلب (العميل، الحالة، صاحب الطلب)', s.meta);
  ok(s.pdf && s.wa && s.cost, 'owner: أزرار «تنزيل PDF» و«مشاركة واتساب» و«تعديل التكاليف»', s);

  // PDF الإدارة
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    await page.screenshot({ path: path.join(saveDir, 'summary-modal.png'), fullPage: false });
    // صور صفحات PDF كما صُوِّرت (للمراجعة اليدوية فقط)
    await page.evaluate(() => { window.__shots = []; });
  }
  await page.evaluate(() => { window.__dl = []; window.__pdfPages = []; document.getElementById('sumPdf').click(); });
  await page.waitForFunction(() => window.__dl.length > 0, { timeout: 90000 });
  const f = await page.evaluate(() => window.__dl[window.__dl.length - 1]);
  const buf = Buffer.from(f.b64, 'base64');
  if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); fs.writeFileSync(path.join(saveDir, f.name), buf); }
  ok(f.name === 'order-summary-1.pdf' && buf.slice(0, 5).toString() === '%PDF-' && buf.length > 20000, 'owner/pdf: ملف order-summary-1.pdf صالح', { name: f.name, size: buf.length });
  if (saveDir) (await page.evaluate(() => window.__shots || [])).forEach((d, i) => fs.writeFileSync(path.join(saveDir, `pdf-page-${i + 1}.jpg`), Buffer.from(d.split(',')[1], 'base64')));
  const lay = await pdfLayout(page);
  ok(lay.n >= 1 && !lay.bad.length && lay.titles[0] === 'ملخص الطلب #1', 'owner/pdf: كل صفحة سليمة (لا صف تحت التذييل) والعنوان «ملخص الطلب #1»', lay);
  const head = await page.evaluate(() => (document.querySelector('.rep-print .rp-head p') || {}).textContent || 'removed');
  ok(head === 'removed', 'owner/pdf: صفحات الطباعة المؤقتة أُزيلت بعد التصدير', head);

  // الجوال: الملخص بلا تمرير أفقي
  await page.evaluate(() => document.getElementById('modalClose').click());
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(2500);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); document.querySelectorAll('.tour-skip, [data-tour-skip]').forEach((b) => b.click()); });
  await go(page, 'orders');
  await sleep(800);
  const reopened = await openSum(page, 'o1');
  await page.waitForSelector('#sumWa', { timeout: 8000 }).catch(() => {});
  const st = await page.evaluate(() => ({ hidden: document.getElementById('modal').hidden, title: (document.getElementById('modalTitle') || {}).textContent, wa: !!document.getElementById('sumWa') }));
  ok(st.wa, 'mobile: نافذة الملخص تُفتح من جديد في الجوال', { reopened, st });
  const ov = await page.evaluate(() => { const m = document.querySelector('#modal .modal-card, #modal .modal-box, #modal > div') || document.getElementById('modal'); return { doc: document.scrollingElement.scrollWidth, w: innerWidth, wide: [...document.querySelectorAll('#modal *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.offsetParent).map((e) => e.className || e.tagName).slice(0, 5) }; });
  ok(ov.doc <= ov.w + 1 && !ov.wide.length, 'mobile: نافذة الملخص بلا تمرير أفقي', ov);
  // مشاركة PDF الملخص عبر واتساب (قائمة المشاركة): ملف فعلي + نص داخلي، ولا محادثة عميل
  const sh = await page.evaluate(async () => {
    window.__shared = null; window.__opened = [];
    navigator.canShare = () => true;
    navigator.share = (d) => { window.__shared = { files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })), text: d.text || '' }; return Promise.resolve(); };
    const ow = window.open; window.open = (u) => { window.__opened.push(String(u)); return null; };
    const btn = document.getElementById('sumWa');
    const label = btn ? btn.textContent.trim() : '';
    btn.click();
    for (let i = 0; i < 300 && !window.__shared; i++) await new Promise((r) => setTimeout(r, 100));
    window.open = ow;
    return { label, shared: window.__shared, opened: window.__opened };
  });
  const sf = sh.shared && sh.shared.files[0];
  ok(/مشاركة PDF عبر واتساب/.test(sh.label) && sf && sf.name === 'order-summary-1.pdf' && sf.type === 'application/pdf' && sf.size > 20000, 'whatsapp: زر «مشاركة PDF عبر واتساب» يرسل ملف PDF فعلياً', sh);
  ok(sh.shared && /ملخص الطلب \*#1\* — داخلي للإدارة/.test(sh.shared.text) && /التكاليف: 750\.00/.test(sh.shared.text) && /صافي الربح: 550\.00/.test(sh.shared.text) && !sh.opened.length, 'whatsapp: النص المرافق بالإجمالي والتكاليف والربح، ولا يفتح محادثة العميل', sh.shared && sh.shared.text);
  // بطاقة الطلب في الجوال: مجموع التكاليف والربح ظاهران قبل الدخول
  await page.evaluate(() => { const c = document.getElementById('modalClose'); if (c && !document.getElementById('modal').hidden) c.click(); });
  await sleep(500);
  const card = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#ordersTable tbody tr')].find((r) => r.querySelector('[data-sum="o1"]'));
    const vis = (sel) => { const td = tr && tr.querySelector(sel); return td && getComputedStyle(td).display !== 'none' ? td.innerText.replace(/\s+/g, ' ').trim() : null; };
    const R = (el) => el.getBoundingClientRect();
    const tag = tr.querySelector('.late-tag'), deliv = tr.querySelector('td.c-deliv'), comm = tr.querySelector('td.c-comm'), tot = tr.querySelector('td.c-total');
    const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
    return { cost: vis('td.c-cost:not(.c-profit)'), profit: vis('td.c-profit'), comm: vis('td.c-comm'),
      tagIn: !!tag && inside(R(tag), R(deliv)) && inside(R(deliv), R(tr)) && R(tag).top >= R(deliv.querySelector('.num')).bottom - 1,
      tagTxt: tag ? tag.textContent : '', delivBg: getComputedStyle(deliv).backgroundColor, totBg: getComputedStyle(tot).backgroundColor,
      commFull: R(comm).width > R(tot).width * 1.8 };
  });
  if (saveDir) { await page.evaluate(() => { const tr = [...document.querySelectorAll('#ordersTable tbody tr')].find((r) => r.querySelector('[data-sum="o1"]')); document.querySelectorAll('.hj-tour').forEach((e) => e.remove()); tr.scrollIntoView({ block: 'start' }); }); await sleep(300); await page.screenshot({ path: path.join(saveDir, 'mobile-card.png') }); }
  ok(card.tagIn && card.tagTxt === 'متأخر', 'mobile/card: شارة «متأخر» كاملة تحت تاريخ التوصيل وداخل البطاقة', card);
  ok(card.delivBg === card.totBg, 'mobile/card: مربع التوصيل بنفس خلفية مربعات المبالغ', card);
  ok(card.commFull, 'mobile/card: العمولة سطر كامل بلا فراغ بجانبها', card);
  ok(card.cost && /750\.00/.test(card.cost) && card.profit && /550\.00/.test(card.profit), 'mobile/card: بطاقة الطلب تعرض «التكلفة 750» و«صافي الربح 550» قبل الدخول', card);
  await page.browserContext().close();

  /* ----- موظف بلا صلاحية التكاليف: الملخص بلا تكاليف ولا PDF إدارة ----- */
  page = await login('staff2');
  await go(page, 'orders');
  const lbl2 = await openSum(page, 'o3');
  ok(lbl2 === 'ملخص الطلب', 'staff بلا تكاليف: العنصر «ملخص الطلب» فقط', lbl2);
  s = await readSum(page);
  ok(s.open && s.kpis['الإجمالي شامل الضريبة'] === '1,495.00' && !('إجمالي التكاليف' in s.kpis) && !('صافي الربح' in s.kpis), 'staff بلا تكاليف: المبالغ دون التكاليف والربح', s.kpis);
  ok(!s.pdf && !s.wa && !s.cost && !s.heads.some((h) => /تكاليف|مصروفات/.test(h)) && !(s.tables[0] || []).some((r) => /300\.00/.test(r)), 'staff بلا تكاليف: لا زر PDF الإدارة ولا أي تكلفة', s);
  await page.evaluate(() => document.getElementById('modalClose').click());
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(2500);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); document.querySelectorAll('.tour-skip, [data-tour-skip]').forEach((b) => b.click()); });
  await go(page, 'orders');
  const card2 = await page.evaluate(() => { const tr = [...document.querySelectorAll('#ordersTable tbody tr')].find((r) => r.querySelector('[data-sum="o3"]')); return [...tr.querySelectorAll('td.c-cost, td.c-profit, td.c-comm')].filter((td) => getComputedStyle(td).display !== 'none').length; });
  ok(card2 === 0, 'staff بلا تكاليف/الجوال: لا خانة تكلفة ولا ربح فارغة في البطاقة', card2);
  await page.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== ملخص الطلب: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
