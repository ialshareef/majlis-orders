/* اختبار واجهة آلي لشراكة العمولة بين موظفَين (فرع واحد):
   - المالك يضيف الشراكة من الإعدادات (2٪ من قيمة البيع).
   - ملخص الطلب وتقرير العمولات يعرضان حصة الشريك، ونافذة الصرف تسجّلها.
   الاستخدام: node test/commission-partner-e2e.mjs */
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
  ord('oa', 1, '2', 'عاصم', { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }),
  ord('ob', 2, '3', 'سليم', { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }),
  ord('oc', 3, '5', 'موظف آخر', { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }),
  // طلب قديم يحفظ رقم البائع رقماً لا نصاً (createdBy: 3): الشراكة تطابقه أيضاً
  (() => { const r = ord('od', 4, '3', 'سليم', { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }); const d = JSON.parse(r.data); d.createdBy = 3; r.data = JSON.stringify(d); return r; })(),
];
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin'), U('2', 'asim', 'عاصم', 'staff'), U('3', 'salim', 'سليم', 'staff'), U('5', 'other', 'موظف آخر', 'staff')],
  sessions: [], orders, counters: [{ key: 'order_no', value: 10 }], items: [],
  settings: [{ id: 1, data: JSON.stringify({ sellerRate: 10, shareRate: 5, mandoubRate: 5, mandoubParentRate: 5 }), updated_at: past }],
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
const go = async (page, name) => { await page.evaluate((n) => (document.querySelector(`#mainNav button[data-page="${n}"]`) || document.querySelector(`.page-tabs [data-goto="${n}"]`) || document.querySelector(`[data-page="${n}"]`)).click(), name); await sleep(900); };
const clean = (t) => String(t || '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
const stored = (id) => JSON.parse(env.DB.tables.get('orders').find((o) => o.id === id).data);
const settingsData = () => { const t = env.DB.tables.get('settings'); const r = t.find((x) => String(x.id) === '1') || t[t.length - 1]; try { return JSON.parse(r.data); } catch (_) { console.log('settings rows:', JSON.stringify(t).slice(0, 400)); throw _; } };

try {
  const page = await login('owner');
  // ---- الإعدادات: إضافة شراكة عاصم ⇄ سليم بنسبة 2٪ ----
  await go(page, 'settings');
  ok(await page.evaluate(() => !!document.getElementById('sAddPartner')), 'الإعدادات: قسم «شراكات العمولة» وزر الإضافة');
  await page.evaluate(() => document.getElementById('sAddPartner').click());
  const opts = await page.evaluate(() => [...document.querySelectorAll('#sPartners .partner-row .pa option')].map((o) => o.textContent));
  ok(opts.includes('عاصم') && opts.includes('سليم'), 'الإعدادات: قائمة الموظفين في الشراكة', opts);
  await page.evaluate(() => { const r = document.querySelector('#sPartners .partner-row'); r.querySelector('.pa').value = '2'; r.querySelector('.pb').value = '3'; r.querySelector('.pr input').value = '2'; document.getElementById('sSave').click(); });
  await sleep(2500);
  const P = settingsData().partners;
  ok(Array.isArray(P) && P.length === 1 && P[0].a === '2' && P[0].b === '3' && Number(P[0].rate) === 2 && /^\d{4}-\d{2}-\d{2}$/.test(P[0].since), 'الإعدادات: الشراكة محفوظة على الخادم (2 ⇄ 3، 2٪، since اليوم)', P);

  // ---- ملخص طلب عاصم: حصة سليم 2٪ من قيمة البيع 2000 = 40 ----
  await go(page, 'orders');
  await page.evaluate(() => document.querySelector('[data-sum="oa"]').click());
  await sleep(1200);
  const sm = await page.evaluate(() => [...document.querySelectorAll('#modal .sum-table tbody tr')].map((tr) => tr.innerText).join(' || '));
  ok(/حصة شريك الفرع — سليم \(2٪ من قيمة البيع\) — لم تُصرف 40\.00/.test(clean(sm)) && /عمولة البائع — عاصم .*100\.00/.test(clean(sm)), 'ملخص طلب عاصم: عمولته 100 + حصة سليم 40 (2٪ من 2000)', clean(sm));
  ok(/صافي الربح بعد العمولات غير المصروفة \(140\.00\) 860\.00/.test(clean(sm)), 'ملخص الطلب: الربح بعد خصم العمولتين غير المصروفتين (140) = 860', clean(sm));
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);
  await page.evaluate(() => document.querySelector('[data-sum="oc"]').click()); await sleep(1000);
  const sc = await page.evaluate(() => document.querySelector('#modal .sum-table').innerText);
  ok(!/شريك الفرع/.test(sc), 'طلب موظف آخر: بلا حصة شراكة');
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);

  // ---- تقرير العمولات ----
  await go(page, 'reports');
  await page.evaluate(() => document.querySelector('#repCatalog [data-rep="commissions"]').click()); await sleep(500);
  await page.evaluate(() => document.querySelector('#repRangeChips [data-rr="all"]').click()); await sleep(800);
  const people = await page.evaluate(() => { const t = document.querySelector('#repTables table'); const hs = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()); return { hs, rows: [...t.querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()) }; });
  ok(people.hs.includes('شراكة الفرع'), 'التقرير: عمود «شراكة الفرع»', people.hs);
  const ra = people.rows.find((r) => r.startsWith('عاصم')) || '', rs = people.rows.find((r) => r.startsWith('سليم')) || '';
  ok(/ 80\.00 /.test(ra) && / 40\.00 /.test(rs) && people.rows.filter((r) => r.startsWith('سليم')).length === 1, 'التقرير: عاصم 80 (من طلبَي سليم) وسليم 40، وسليم سطر واحد', people.rows);
  const det = await page.evaluate(() => [...document.querySelectorAll('#repTables table')[1].querySelectorAll('tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  ok(det.filter((r) => /حصة شريك الفرع/.test(r)).length === 3, 'التقرير: ثلاثة أسطر «حصة شريك الفرع» في التفصيل', det);

  // ---- صرف حصة الشريك من نافذة الصرف ----
  await go(page, 'orders');
  await page.evaluate(() => document.querySelector('[data-commpay="oa"]').click()); await sleep(900);
  const kinds = await page.evaluate(() => [...document.querySelectorAll('#modal input[type=checkbox][data-k]')].map((i) => i.dataset.k));
  ok(kinds.includes('owner') && kinds.includes('partner'), 'نافذة الصرف: عمولة البائع وحصة الشريك', kinds);
  await page.evaluate(() => document.getElementById('cpSave').click()); await sleep(2000);
  const cp = stored('oa').commPaid || {};
  ok(cp.partner && Number(cp.partner.amount) === 40 && cp.owner && Number(cp.owner.amount) === 100, 'الخادم: حُفظ صرف حصة الشريك 40 وعمولة البائع 100', cp);
  // العمولة المصروفة بنداً في التكاليف: «عمولة عاصم» 100 و«عمولة سليم» 40 — والربح ينقص، والعمولة لا تتغيّر
  ok(!(stored('oa').extraCosts || []).length, 'بنود العمولة لا تُخزَّن مع التكاليف اليدوية (تُشتق من سجل الصرف)');
  const rowTxt = await page.evaluate(() => { const tr = [...document.querySelectorAll('#ordersTable tbody tr')].find((r) => r.querySelector('[data-open="oa"]')); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; });
  ok(/1,140\.00/.test(rowTxt) && /860\.00/.test(rowTxt) && /100\.00/.test(rowTxt), 'قائمة الطلبات: التكلفة 1140 (1000 + عمولتان) وصافي الربح 860، والعمولة 100 كما هي', rowTxt);
  await page.evaluate(() => document.querySelector('[data-sum="oa"]').click()); await sleep(1200);
  const sumTxt = clean(await page.evaluate(() => document.getElementById('modal').innerText));
  ok(/عمولة عاصم \(صُرفت[^)]*\) 100\.00/.test(sumTxt) && /عمولة سليم \(صُرفت[^)]*\) 40\.00/.test(sumTxt) && /العمولات المصروفة \(عمولة عاصم، عمولة سليم\)/.test(sumTxt), 'ملخص الطلب: بند لكل عمولة مصروفة باسم صاحبها', sumTxt.slice(0, 600));
  ok(!/غير المصروفة/.test(sumTxt), 'بعد الصرف: لا سطر «بعد العمولات غير المصروفة» (كلها في التكاليف)');
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(400);
  // التقرير: لا تُخصم العمولة مرتين — الربح بعد العمولات = 2000 − 1000 − (100 + 40 + 50 مشاركة) = 810
  await go(page, 'reports');
  await page.evaluate(() => document.querySelector('#repCatalog [data-rep="orders"]').click()); await sleep(600);
  await page.evaluate(() => document.querySelector('#repRangeChips [data-rr="all"]').click()); await sleep(900);
  const repRow = await page.evaluate(() => { const t = document.querySelector('#repTables table'); const hs = [...t.querySelectorAll('thead th')].map((x) => x.textContent.trim()); const tr = [...t.querySelectorAll('tbody tr')].find((r) => /^#1\b/.test(r.innerText.trim())); return { hs, cells: tr ? [...tr.querySelectorAll('td')].map((x) => x.textContent.trim()) : [] }; });
  const cellOf = (lbl) => repRow.cells[repRow.hs.indexOf(lbl)];
  ok(cellOf('الربح بعد العمولات') === '810.00' && cellOf('صافي الربح') === '860.00', 'التقرير: صافي الربح 860 والربح بعد العمولات 810 (بلا خصم مزدوج)', { p: cellOf('صافي الربح'), a: cellOf('الربح بعد العمولات') });
  // إلغاء الصرف يزيل البند تلقائياً
  await go(page, 'orders');
  await page.evaluate(() => document.querySelector('[data-commpay="oa"]').click()); await sleep(900);
  await page.evaluate(() => { document.querySelectorAll('#modal input[type=checkbox][data-k]').forEach((c) => { c.checked = false; }); document.getElementById('cpSave').click(); }); await sleep(700);
  await page.evaluate(() => { const b = document.getElementById('cYes'); if (b) b.click(); }); await sleep(1500);
  const rowTxt2 = await page.evaluate(() => { const tr = [...document.querySelectorAll('#ordersTable tbody tr')].find((r) => r.querySelector('[data-open="oa"]')); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; });
  ok(!(stored('oa').commPaid || {}).owner && /1,000\.00/.test(rowTxt2), 'إلغاء الصرف: تعود التكلفة 1000 (يُزال بند العمولة)', rowTxt2);
  // رقم البائع المحفوظ رقماً: حصة الشريك تظهر أيضاً
  await page.evaluate(() => document.querySelector('[data-commpay="od"]').click()); await sleep(900);
  const kd = await page.evaluate(() => [...document.querySelectorAll('#modal input[type=checkbox][data-k]')].map((i) => i.dataset.k));
  ok(kd.includes('partner'), 'الشراكة تطابق طلباً يحفظ رقم البائع رقماً لا نصاً', kd);
  await page.evaluate(() => document.getElementById('cpCancel').click()); await sleep(400);
  // بائع بلا شراكة: تنبيه في نافذة الصرف وزر لضبط الشراكات
  await page.evaluate(() => document.querySelector('[data-commpay="oc"]').click()); await sleep(900);
  const np = await page.evaluate(() => { const x = document.querySelector('#modal .cp-nopartner'); return x ? x.innerText.replace(/\s+/g, ' ') : ''; });
  ok(/ليس له شراكة مضبوطة/.test(np) && /ضبط الشراكات/.test(np), 'نافذة الصرف: تنبيه «لا شراكة» لبائع بلا شريك', np);
  await page.evaluate(() => document.getElementById('cpGoPartners').click()); await sleep(1200);
  ok(await page.evaluate(() => document.body.dataset.page === 'settings' && !!document.getElementById('set-comm') && /العمولات والشراكات/.test(document.getElementById('set-comm').innerText)), 'زر «ضبط الشراكات» يفتح قسم «العمولات والشراكات» في الإعدادات');
  ok(await page.evaluate(() => document.querySelectorAll('.set-nav [data-setgo]').length >= 6), 'الإعدادات: شريط تنقل بين الأقسام');
  await page.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e));
} finally {
  ok(!pageErrors.length, 'لا أخطاء JavaScript في الصفحة', pageErrors);
  await browser.close(); server.close();
  console.log(`\n=== commission-partner: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
