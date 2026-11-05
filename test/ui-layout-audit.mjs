/* فحص تخطيط الواجهة آلياً: يفتح كل صفحات التطبيق ببيانات طويلة (أسماء عربية طويلة، أرقام كبيرة،
   نصوص مختلطة) على مقاسات الجوال واللوحي وسطح المكتب، ويكشف:
     - تمرير أفقي للصفحة كلها
     - عناصر تخرج عن الشاشة أو عن حاويتها (خارج حاويات التمرير المقصودة كالجداول)
     - نصوص مقصوصة داخل عنصر لا يعرض «…» ولا يلتف
     - حقول وأزرار في نفس الصف بارتفاعات مختلفة
     - أهداف لمس صغيرة جداً على الجوال
   الخادم الحقيقي على D1 وهمية + index.html في Chrome/Edge headless (نفس أسلوب reports-ui-e2e.mjs).
   الاستخدام: node test/ui-layout-audit.mjs [--shots <مجلد>] [--verbose] */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : '');
const shotsDir = arg('--shots');
const verbose = process.argv.includes('--verbose');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8')).toString('base64'));
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, verbose ? 6000 : 900) : '')); }
};

/* ---------- بيانات طويلة واقعية ---------- */
const PW = 'test1234';
const salt = crypto.randomBytes(16);
const H = `pbkdf2$100000$${salt.toString('base64')}$${crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256').toString('base64')}`;
const past = new Date(Date.now() - 86400000 * 400).toISOString();
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const thisMonth = (dd) => day(new Date(now.getFullYear(), now.getMonth(), Math.min(dd, now.getDate())));
const U = (id, username, name, role, extra = {}) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H, ...extra });
const LONG_NAMES = ['عبدالرحمن بن عبدالعزيز بن محمد آل الشيخ القحطاني', 'مؤسسة أصالة نجد للمجالس والديكورات الداخلية المحدودة', 'Mohammed Al-Otaibi (VIP) — فرع الرياض',
  'نورة', 'فهد سعود عبدالله الدوسري', 'شركة الرواد المتحدة للتجارة والمقاولات العامة ذ.م.م'];
const ord = (id, number, by, byName, date, i) => {
  const subtotal = [1234567.89, 950, 45000, 7800.5, 120, 333333][i % 6];
  const cost = Math.round(subtotal * 0.55 * 100) / 100;
  const total = Math.round(subtotal * 1.15 * 100) / 100;
  const paid = i % 3 === 0 ? total : i % 3 === 1 ? Math.round(total / 3) : 0;
  const status = ['new', 'quote', 'progress', 'done', 'delivered', 'cancelled'][i % 6];
  const at = date + 'T09:00:00.000Z';
  const name = LONG_NAMES[i % LONG_NAMES.length];
  return { id, number, status, customer_name: name, created_by: by, created_at: at, updated_at: at,
    data: JSON.stringify({ id, number, status, createdBy: by, createdByName: byName, createdAt: at, updatedAt: at,
      customer: { name, phone: '0550000' + String(number).padStart(3, '0'), city: 'الرياض — حي الملقا، شارع الأمير محمد بن سعد', notes: 'ملاحظة طويلة جداً: يرجى التواصل قبل التركيب بيومين، والمدخل ضيق من جهة الدرج الخلفي، ويوجد مصعد للبضائع فقط.' },
      design: { pieces: [] }, lines: [{ name: 'كنب عربي - قطيفة فاخرة مع تطريز يدوي ذهبي', qty: 12.5, unit: 'm', price: 450, total: 5625 }],
      subtotal, discount: i % 2 ? 150 : 0, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: total - subtotal, total, paid, remaining: total - paid,
      costTotal: cost, commRates: { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 },
      payments: paid ? [{ id: 'p' + id, at: date, amount: paid, method: i % 2 ? 'transfer' : 'cash', note: 'تحويل بنكي — مصرف الراجحي', by: byName }] : [] }) };
};
const orders = [];
for (let i = 0; i < 24; i++) orders.push(ord('o' + i, 1001 + i, ['1', '2', '3'][i % 3], ['المالك فواز', LONG_NAMES[4], 'مندوب المنطقة الشرقية والوسطى'][i % 3], thisMonth(1 + (i % 27)), i));
const env = envWith({
  users: [U('1', 'owner', 'المالك فواز', 'admin'),
    U('2', 'staff_with_a_very_long_username', LONG_NAMES[4], 'staff'),
    U('3', 'mand2', 'مندوب المنطقة الشرقية والوسطى', 'mandoub', { parent_id: '4', rate: 12.5, parent_rate: 2.5 }),
    U('4', 'mand1', LONG_NAMES[0], 'mandoub', { rate: 10 }),
    U('6', 'admin2', 'مدير العمليات', 'admin')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 1100 }],
  settings: [{ id: 1, data: JSON.stringify({ shopName: 'أصالة نجد للمجالس العربية والديكور', phone: '0500000000' }), updated_at: past }], items: [],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions']) env.DB.tables.set(t, []);
env.DB.tables.set('expenses', Array.from({ length: 8 }, (_, i) => ({ id: 'e' + i, name: ['إيجار المعرض الرئيسي — طريق الملك فهد', 'رواتب', 'Google Ads campaign (Ramadan)', 'كهرباء'][i % 4], amount: [125000, 300, 45678.9, 12][i % 4], category: ['إيجار', 'رواتب', 'تسويق', 'خدمات'][i % 4], note: 'ملاحظة', created_by: '1', created_at: thisMonth(1 + i) + 'T08:00:00Z', updated_at: thisMonth(1 + i) + 'T08:00:00Z', expense_date: thisMonth(1 + i), order_id: null })));
env.DB.tables.set('activity', Array.from({ length: 15 }, (_, i) => ({ id: 'a' + i, at: new Date(Date.now() - i * 3600e3).toISOString(), data: JSON.stringify({ id: 'a' + i, at: new Date(Date.now() - i * 3600e3).toISOString(), user: LONG_NAMES[i % 6], action: 'تعديل الطلب', detail: 'تغيير حالة الطلب رقم 1005 من «جديد» إلى «قيد التنفيذ» مع تحديث مبلغ الدفعة الأولى إلى 12,345.67 ر.س' }) })));
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1';
{ const prep = env.DB.prepare.bind(env.DB); env.DB.prepare = (sql) => prep(String(sql).replace(/lower\(username\)\s*=\s*\?/i, 'username = ?').replace(/\bid IS NOT \?/i, 'id <> ?')); }

/* ---------- خادم محلي ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
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
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي فحص التخطيط'); server.close(); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- كاشف الخلل (يعمل داخل الصفحة) ---------- */
function auditInPage(opts) {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const name = (el) => {
    const parts = [];
    for (let e = el, k = 0; e && e !== document.body && k < 4; e = e.parentElement, k++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += '#' + e.id; parts.unshift(s); break; }
      const c = [...e.classList].filter((x) => !/^(active|on|show)$/.test(x)).slice(0, 2);
      if (c.length) s += '.' + c.join('.');
      parts.unshift(s);
    }
    return parts.join('>');
  };
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  const scrollerX = (el) => {
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if (o === 'auto' || o === 'scroll') return e;
    }
    return null;
  };
  const clipAncestor = (el) => {
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if (o === 'hidden' || o === 'clip') return e;
    }
    return null;
  };
  if (document.documentElement.scrollWidth > vw + 1) out.push({ k: 'hscroll', w: document.documentElement.scrollWidth, vw });
  const roots = [...document.querySelectorAll(opts.scope)].filter(visible);
  const seen = new Set();
  for (const r0 of roots) for (const el of [r0, ...r0.querySelectorAll('*')]) {
    if (seen.has(el) || !visible(el)) continue; seen.add(el);
    if (el.closest('svg, canvas, .no-audit, [aria-hidden="true"], .sr-only, .visually-hidden') && el.tagName !== 'svg') continue;
    if (el.classList.contains('sr-only') || (el.clientWidth <= 1 && el.clientHeight <= 1)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const sx = scrollerX(el);
    // 1) خارج الشاشة أفقياً دون حاوية تمرير
    if (!sx && (r.right > vw + 1 || r.left < -1)) {
      const ca = clipAncestor(el);
      const cr = ca && ca.getBoundingClientRect();
      if (!cr || (r.right > cr.right + 1 || r.left < cr.left - 1) === false) { /* داخل حاوية قص مرئية */ }
      if (!ca) out.push({ k: 'offscreen', el: name(el), l: Math.round(r.left), r: Math.round(r.right), vw });
    }
    // 2) خارج حاويته المباشرة ذات القص (نص يُقص)
    const cs = getComputedStyle(el);
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const ell = cs.textOverflow === 'ellipsis';
      if (!ell && (cs.overflowX === 'hidden' || cs.overflowX === 'clip')) out.push({ k: 'clipped', el: name(el), sw: el.scrollWidth, cw: el.clientWidth, t: el.textContent.trim().slice(0, 40) });
      else if (!ell && cs.overflowX === 'visible' && !['TD', 'TH'].includes(el.tagName)) out.push({ k: 'spill', el: name(el), sw: el.scrollWidth, cw: el.clientWidth, t: el.textContent.trim().slice(0, 40) });
    }
    // 3) يتجاوز أباه (ليس في حاوية تمرير ولا موضوع مطلق)
    // حاوية تمرير تمتد عمداً إلى حافتي البطاقة (هوامش سالبة) ليست خللاً
    const selfScroll = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    const bleed = parseFloat(cs.marginLeft) < 0 || parseFloat(cs.marginRight) < 0; // امتداد مقصود بهامش سالب
    if (!sx && !selfScroll && !bleed && cs.position !== 'absolute' && cs.position !== 'fixed' && el.parentElement) {
      const p = el.parentElement, pr = p.getBoundingClientRect();
      const pcs = getComputedStyle(p);
      if (pcs.display !== 'contents' && pcs.overflowX === 'visible' && pr.width > 0 && (r.right > pr.right + 2 || r.left < pr.left - 2) && !['TD', 'TH', 'TR'].includes(el.tagName)) {
        out.push({ k: 'overparent', el: name(el), by: Math.round(Math.max(r.right - pr.right, pr.left - r.left)) });
      }
    }
  }
  // 4) صفوف التحكم: حقول وأزرار متجاورة بارتفاعات مختلفة
  const ctrls = [...document.querySelectorAll(opts.scope.split(',').map((s) => s + ' input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), ' + s + ' select, ' + s + ' button.btn').join(','))].filter(visible);
  const rows = new Map();
  for (const c of ctrls) {
    const r = c.getBoundingClientRect(); if (r.height < 4) continue;
    const p = c.closest('.row, .form-row, .grid, .toolbar, .filters, .actions, .field-row, .inline, form, .card') || c.parentElement;
    const key = name(p) + '|' + Math.round(r.top / 6);
    if (!rows.has(key)) rows.set(key, []); rows.get(key).push({ el: name(c), h: Math.round(r.height), top: Math.round(r.top) });
  }
  for (const [k, list] of rows) {
    if (list.length < 2) continue;
    const hs = list.map((x) => x.h); const mx = Math.max(...hs), mn = Math.min(...hs);
    if (mx - mn > 4) out.push({ k: 'uneven', row: k.split('|')[0], hs: list.map((x) => x.el.split('>').pop() + ':' + x.h) });
  }
  // 4ب) حقول الصف الواحد في نموذج (row2/row3) تبدأ على نفس الخط — عنوان يلتف لسطرين كان يُنزل حقله وحده
  for (const g of document.querySelectorAll(opts.scope.split(',').map((s) => s + ' .row2, ' + s + ' .row3').join(','))) {
    if (!visible(g)) continue;
    const fields = [...g.children].map((c) => c.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea')).filter((x) => x && visible(x));
    const tops = fields.map((f) => Math.round(f.getBoundingClientRect().top));
    const lefts = fields.map((f) => Math.round(f.getBoundingClientRect().left));
    // نفس السطر فقط (الأعمدة المتراكبة على الجوال ليست خللاً)
    const sameRow = fields.length > 1 && new Set(lefts).size === fields.length && Math.max(...tops) - Math.min(...tops) < 60;
    if (sameRow && Math.max(...tops) - Math.min(...tops) > 3) out.push({ k: 'misaligned', row: name(g), tops });
  }
  // 5) أهداف لمس على الجوال
  if (opts.touch) {
    for (const b of [...document.querySelectorAll(opts.scope.split(',').map((s) => s + ' button, ' + s + ' a[href], ' + s + ' select, ' + s + ' input:not([type=hidden])').join(','))].filter(visible)) {
      // الحقل داخل label (حقول .fld والمربعات) هدف لمسه هو الـ label كله
      const r = (b.matches('input, select') && b.closest('label') ? b.closest('label') : b).getBoundingClientRect();
      if (b.closest('svg, .no-audit')) continue;
      if ((r.height < 32 || r.width < 32) && r.height > 0) out.push({ k: 'tiny', el: name(b), w: Math.round(r.width), h: Math.round(r.height), t: (b.textContent || b.getAttribute('aria-label') || b.title || '').trim().slice(0, 20) });
    }
  }
  // دمج المكررات
  const m = new Map();
  for (const x of out) { const key = x.k + ' ' + (x.el || x.row || ''); if (!m.has(key)) m.set(key, { ...x, n: 1 }); else m.get(key).n++; }
  return [...m.values()];
}

async function login(username, vp) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(username + ': ' + String(e.message).split('\n')[0]));
  // جولة الشرح الأولى تُغطي الصفحة: تُعلَّم كمعروضة حتى يُفحص التخطيط نفسه
  await page.evaluateOnNewDocument(() => { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return String(k).startsWith('mj_help_seen_') ? '1' : g.call(this, k); }; });
  await page.setViewport(vp);
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.tag}-login.png`) });
  const loginIssues = await page.evaluate(auditInPage, { scope: '#loginScreen', touch: vp.width < 768 });
  await page.type('#loginUser', username); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(2500);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  return { page, loginIssues };
}

const VPS = [
  { tag: 'mobile', width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  { tag: 'tablet', width: 768, height: 1024, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  { tag: 'desktop', width: 1366, height: 900 },
];
const IGNORE = (process.env.AUDIT_IGNORE || '').split(',').filter(Boolean);
const summary = {};
try {
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  // أداة تشخيص: --probe <ملف js> يُقيَّم بعد الدخول (المتغيرات: page, vp, sleep) ثم يخرج
  if (arg('--probe')) {
    const vp = VPS.find((v) => v.tag === (arg('--vp') || 'desktop'));
    const { page } = await login('owner', vp);
    const fn = new Function('page', 'vp', 'sleep', 'return (async () => {' + fs.readFileSync(arg('--probe'), 'utf8') + '})()');
    console.log(JSON.stringify(await fn(page, vp, sleep), null, 1));
    await browser.close(); server.close(); process.exit(0);
  }
  for (const vp of VPS) {
    const { page, loginIssues } = await login('owner', vp);
    summary[vp.tag + ':login'] = loginIssues;
    const pages = await page.evaluate(() => [...document.querySelectorAll('#mainNav button[data-page]')].filter((b) => !b.hidden).map((b) => b.dataset.page));
    for (const p of pages) {
      await page.evaluate((n) => { const b = document.querySelector(`#mainNav button[data-page="${n}"]`); b.click(); }, p);
      await sleep(900);
      await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
      // إغلاق القائمة الجانبية إن فُتحت على الجوال
      await page.evaluate(() => { document.body.classList.remove('nav-open', 'sidebar-open'); });
      const issues = await page.evaluate(auditInPage, { scope: `#page-${p}, .sidebar, #bottomNav`, touch: vp.width < 768 });
      summary[vp.tag + ':' + p] = issues.filter((x) => !IGNORE.some((g) => (x.el || x.row || '').includes(g)));
      if (shotsDir) { const h = await page.evaluate(() => document.documentElement.scrollHeight); await page.screenshot({ path: path.join(shotsDir, `${vp.tag}-${p}.png`), clip: { x: 0, y: 0, width: vp.width, height: Math.min(h, 1600) }, captureBeyondViewport: true }); }
    }
    const shot = async (n) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.tag}-${n}.png`) }); };
    const goPage = async (p) => { await page.evaluate((n) => document.querySelector(`#mainNav button[data-page="${n}"]`).click(), p); await sleep(700); };
    // مراحل الطلب الحالي لطلب فيه بيانات طويلة
    await goPage('orders');
    await page.evaluate(() => document.querySelector('#ordersTable [data-open]').click()); await sleep(1200);
    for (const st of ['design', 'price', 'customer', 'pay', 'export']) {
      await page.evaluate((s) => document.querySelector(`#stepNav a[data-stage="${s}"]`).click(), st); await sleep(600);
      summary[vp.tag + ':order-' + st] = await page.evaluate(auditInPage, { scope: '#page-order, .order-actions', touch: vp.width < 768 });
      await shot('order-' + st);
    }
    // النوافذ المنبثقة
    const MODALS = [['items', '#btnAddItem'], ['users', '#btnAddUser'], ['users', '[data-edit="3"]'], ['expenses', '#btnAddExpense'], ['expenses', '[data-expedit]'],
      ['orders', '#ordersTable [data-cost]'], ['orders', '#ordersTable [data-comm]'], ['orders', '#ordersTable [data-owner]'], ['mandoubs', '#btnMandoubDefaults'], ['mandoubs', '[data-medit]']];
    for (const [p, sel] of MODALS) {
      const key = `${vp.tag}:modal ${p} ${sel}`;
      await goPage(p);
      const clicked = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return false; b.click(); return true; }, sel);
      if (!clicked) { summary[key] = [{ k: 'missing-trigger', el: sel }]; continue; }
      await sleep(700);
      if (!(await page.evaluate(() => !document.getElementById('modal').hidden))) { summary[key] = [{ k: 'modal-not-open', el: sel }]; continue; }
      summary[key] = await page.evaluate(auditInPage, { scope: '#modal .modal-card', touch: vp.width < 768 });
      await shot('modal-' + p + '-' + sel.replace(/[^a-z0-9]+/gi, '_'));
      await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);
    }
    // لوحة التنبيهات والقائمة الجانبية المنزلقة (الجوال/اللوحي)
    await page.evaluate(() => document.getElementById('btnNotif').click()); await sleep(400);
    summary[vp.tag + ':notif'] = await page.evaluate(auditInPage, { scope: '#notifPanel', touch: vp.width < 768 });
    await shot('notif');
    await page.evaluate(() => document.getElementById('notifClose').click()); await sleep(200);
    if (vp.width <= 960) {
      await page.evaluate(() => document.getElementById('btnMenu').click()); await sleep(500);
      summary[vp.tag + ':drawer'] = await page.evaluate(auditInPage, { scope: '#sbDrawer', touch: vp.width < 768 });
      await shot('drawer');
      await page.evaluate(() => document.getElementById('sbClose').click()); await sleep(300);
    }
    // قائمة إجراءات صف الطلب
    await goPage('orders');
    await page.evaluate(() => document.querySelector('#ordersTable .rmenu-btn').click()); await sleep(300);
    summary[vp.tag + ':rowmenu'] = await page.evaluate(auditInPage, { scope: '.rmenu-list', touch: vp.width < 768 });
    await shot('rowmenu');
    await page.browserContext().close();
  }
  // الموظف والمندوب: صفحاتهم الظاهرة على الجوال وسطح المكتب (قوائم ونصوص مختلفة عن المالك)
  for (const who of ['staff_with_a_very_long_username', 'mand2']) {
    for (const vp of [VPS[0], VPS[2]]) {
      const { page } = await login(who, vp);
      const pages = await page.evaluate(() => [...document.querySelectorAll('#mainNav button[data-page]')].filter((b) => !b.hidden).map((b) => b.dataset.page));
      for (const p of pages) {
        await page.evaluate((n) => document.querySelector(`#mainNav button[data-page="${n}"]`).click(), p); await sleep(700);
        summary[`${who.slice(0, 8)}:${vp.tag}:${p}`] = await page.evaluate(auditInPage, { scope: `#page-${p}, .sidebar, #bottomNav`, touch: vp.width < 768 });
      }
      await page.browserContext().close();
    }
  }
  for (const [k, v] of Object.entries(summary)) {
    const serious = v.filter((x) => x.k !== 'tiny');
    ok(serious.length === 0, `layout ${k}: بلا تجاوز أو قص أو عدم تطابق`, serious);
    const tiny = v.filter((x) => x.k === 'tiny');
    if (tiny.length) ok(false, `touch ${k}: أهداف لمس ≥ 32px`, tiny);
  }
  ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript', pageErrors);
} catch (e) {
  fail++; console.log('FAIL  harness :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally {
  await browser.close();
  server.close();
}
console.log(`=== ui-layout-audit: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
