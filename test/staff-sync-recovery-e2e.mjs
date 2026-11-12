/* اختبار واجهة آلي: مزامنة جهاز موظف لا تتعطل إلى الأبد.
   حالة حقيقية (موظف على آيفون): التطبيق فُتح والشبكة متعثرة فبقي على النسخة المحلية، ثم:
   1) نسخة محلية حفظها إصدار أقدم (إعدادات بلا commBase): كانت تُعدّ «إعدادات معدّلة» فتُرفع،
      والموظف لا يملك settings.manage ← 403 ← توقف الرفع والجلب كلياً على جهازه.
   2) تغيير محلي يرفضه الخادم نهائياً (تعديل دفعة بلا payments.edit) مع تغيير سليم (طلب جديد):
      كان الرفض يُسقط الدفعة كلها؛ الآن يُرفع السليم، ويُعاد المرفوض إلى نسخة الخادم مع رسالة بسببه.
   الخادم الحقيقي على D1 وهمية + index.html في Chrome headless.
   الاستخدام: node test/staff-sync-recovery-e2e.mjs */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { routeDownloads, TEST_DL } from './_downloads.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MAJLIS_ROOT || path.join(here, '..');
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
const past = new Date(Date.now() - 86400000 * 30).toISOString();
const U = (id, username, name, role) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H });
const at = new Date(Date.now() - 86400000).toISOString();
const orderData = { id: 'o1', number: 1001, status: 'progress', createdBy: '2', createdByName: 'عاصم', createdAt: at, updatedAt: at,
  customer: { name: 'عميل عاصم', phone: '0500000001' }, design: { walls: [], pieces: [] }, lines: [], manualRows: [{ name: 'خدمة', qty: 1, unit: 'خدمة', price: 1000 }],
  subtotal: 1000, discount: 0, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: 150, total: 1150, paid: 300, remaining: 850,
  payments: [{ id: 'p1', at: at.slice(0, 10), amount: 300, method: 'cash', note: '', by: 'عاصم', createdAt: at }] };
const env = envWith({
  users: [U('1', 'owner', 'فواز', 'admin'), U('2', 'asim', 'عاصم', 'staff')],
  sessions: [], counters: [{ key: 'order_no', value: 1001 }],
  // إعدادات الإنتاج كما هي بلا commBase (المالك لم يحفظ الإعدادات منذ 1.1.2)
  settings: [{ id: 1, data: JSON.stringify({ shopName: 'أصالة نجد', sellerRate: 10, shareRate: 5 }), updated_at: past }],
  items: [],
  orders: [{ id: 'o1', number: 1001, status: 'progress', customer_name: 'عميل عاصم', created_by: '2', created_at: at, updated_at: at, data: JSON.stringify(orderData) }],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions']) env.DB.tables.set(t, []);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1';
{ const prep = env.DB.prepare.bind(env.DB); env.DB.prepare = (sql) => prep(String(sql).replace(/lower\(username\)\s*=\s*\?/i, 'username = ?').replace(/\bid IS NOT \?/i, 'id <> ?')); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let origin = '';
let failMe = false;          // محاكاة شبكة متعثرة عند فتح التطبيق: /api/me لا يصل
const syncLog = [];          // [{status, keys}] لكل /api/sync
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      if (failMe && u.pathname === '/api/me') { req.socket.destroy(); return; }
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const r = await worker.fetch(new Request(origin + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')), body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
        if (u.pathname === '/api/sync') { let keys = []; try { keys = Object.keys(JSON.parse(body)); } catch (_) { /* */ } const e = { status: r.status, keys }; if (r.status >= 400) e.err = (await r.clone().text()).slice(0, 160); syncLog.push(e); }
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
routeDownloads(browser);
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CK = 'majlis_remote_db_v1';

/** تحويل النسخة المحلية المخزّنة على الجهاز (كما لو حفظها إصدار أقدم أو عُدّلت دون اتصال) */
const editCache = (page, fnSrc) => page.evaluate((k, src) => {
  const c = JSON.parse(localStorage.getItem(k));
  new Function('c', src)(c);
  localStorage.setItem(k, JSON.stringify(c));
}, CK, fnSrc);
/** إعادة فتح التطبيق والشبكة متعثرة عند البدء (يبقى على النسخة المحلية)، ثم تعود الشبكة وتعمل المزامنة الدورية */
async function reopenOffline(page) {
  failMe = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 }); }
  catch (e) { console.log('DBG', JSON.stringify(await page.evaluate(() => ({ app: document.getElementById('app').hidden, login: (document.getElementById('loginForm') || {}).offsetParent !== null, body: document.body.innerText.slice(0, 300) })))); throw e; }
  await sleep(1500);
  failMe = false;
  syncLog.length = 0;
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  await page.evaluate(() => document.getElementById('netState').click());
  await page.waitForFunction(() => ['ok', 'err'].includes(document.getElementById('netState').dataset.state), { timeout: 30000 });
  await sleep(800);
  return page.evaluate(() => ({ state: document.getElementById('netState').dataset.state, title: document.getElementById('netState').title, toast: (document.querySelector('.toast') || {}).textContent || '' }));
}

try {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message).split('\n')[0]));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', 'asim'); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(2500);

  /* ----- 0) استخدام عادي: تنقّل بين كل الصفحات المتاحة وفتح طلب وطلب جديد، ثم مزامنتان —
     لا يرفع جهاز الموظف شيئاً يرفضه الخادم (كان أي فرق مشتق في الأصناف/الإعدادات يعلّق المزامنة) ----- */
  syncLog.length = 0;
  const pages = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-page]')].filter((b) => !b.hidden && b.offsetParent !== null).map((b) => b.dataset.page))]);
  for (const pg of pages) { await page.evaluate((n) => { const b = [...document.querySelectorAll(`[data-page="${n}"]`)].find((x) => x.offsetParent !== null); if (b) b.click(); }, pg); await sleep(700); await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); }); }
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-page="orders"]')].find((x) => x.offsetParent !== null); if (b) b.click(); }); await sleep(800);
  await page.evaluate(() => { const r = document.querySelector('#ordersTable tbody tr [data-open], #ordersTable tbody tr'); if (r) r.click(); }); await sleep(1500);
  await page.evaluate(() => { const b = document.getElementById('btnNewOrder'); if (b && b.offsetParent !== null) b.click(); }); await sleep(1000);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  for (let i = 0; i < 2; i++) { await page.evaluate(() => document.getElementById('netState').click()); await sleep(2500); }
  const net0 = await page.evaluate(() => document.getElementById('netState').dataset.state);
  ok(net0 === 'ok' && !syncLog.some((x) => x.status >= 400), 'use: استخدام عادي لحساب الموظف ثم مزامنة — لا رفض من الخادم (' + pages.join('،') + ')', { net0, syncLog });

  /* ----- 1) فرق مشتق في الإعدادات على جهاز الموظف (حقل ناقص/زائد عن لقطة الخادم) ----- */
  const syncNow = async () => {
    syncLog.length = 0;
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => { t.textContent = ''; }); document.getElementById('netState').click(); });
    await page.waitForFunction(() => ['ok', 'err'].includes(document.getElementById('netState').dataset.state) && !document.body.classList.contains('syncing'), { timeout: 30000 });
    await sleep(800);
    return page.evaluate(() => ({ state: document.getElementById('netState').dataset.state, title: document.getElementById('netState').title, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ') }));
  };
  await page.evaluate(() => { delete Store.db.settings.commBase; Store.db.settings.extraDerived = 1; });
  let st = await syncNow();
  ok(st.state === 'ok', 'settings-diff: المزامنة تنجح على جهاز الموظف (محدّث)', st);
  ok(!syncLog.some((x) => x.status === 403) && !syncLog.some((x) => x.keys.includes('settings')), 'settings-diff: الموظف لا يرفع الإعدادات (لا يملك صلاحيتها) فلا رفض 403', syncLog);

  /* ----- 2) تغيير مرفوض نهائياً + تغيير سليم في الحمولة نفسها ----- */
  await page.evaluate(() => {
    const o = Store.db.orders.find((x) => x.id === 'o1');
    o.payments[0].amount = 500; o.paid = 500; o.remaining = 650;
    Store.db.orders.push({ id: 'new-o', number: 1002, status: 'new', createdBy: '2', createdByName: 'عاصم', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      customer: { name: 'عميل جديد', phone: '0500000002' }, design: { walls: [], pieces: [] }, lines: [], manualRows: [{ name: 'خدمة', qty: 1, unit: 'خدمة', price: 200 }],
      subtotal: 200, discount: 0, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: 30, total: 230, paid: 0, remaining: 230, payments: [] });
  });
  st = await syncNow();
  ok(st.state === 'ok', 'rejected: المزامنة تعود «محدّث» بعد عزل التغيير المرفوض', { st, syncLog });
  ok(!!env.DB.tables.get('orders').find((r) => r.id === 'new-o'), 'rejected: الطلب الجديد السليم وصل الخادم رغم رفض التغيير الآخر');
  const srvO1 = JSON.parse(env.DB.tables.get('orders').find((r) => r.id === 'o1').data);
  ok(srvO1.payments[0].amount === 300, 'rejected: الدفعة على الخادم لم تتغير (الخادم هو الحكم)', srvO1.payments[0]);
  const local = await page.evaluate(() => ({ amt: Store.db.orders.find((x) => x.id === 'o1').payments[0].amount, kept: JSON.parse(localStorage.getItem('majlis_rejected') || '[]').length }));
  ok(local.amt === 300 && local.kept >= 1, 'rejected: الجهاز عاد لنسخة الخادم، والتعديل المرفوض محفوظ نسخةً على الجهاز', local);
  ok(/لم يقبل الخادم تعديلاً على الطلب #1001/.test(st.toast) && /الدفعات/.test(st.toast), 'rejected: رسالة واضحة بالطلب وسبب الرفض', st.toast);

  st = await syncNow();
  ok(st.state === 'ok' && !syncLog.some((x) => x.status >= 400), 'after: المزامنة التالية سليمة', { st, syncLog });

  /* ----- 3) تغيير واحد مرفوض وحده (حذف دفعة بلا payments.delete): يُعزل ويُعاد أيضاً ----- */
  await page.evaluate(() => { const o = Store.db.orders.find((x) => x.id === 'o1'); o.payments = []; o.paid = 0; });
  st = await syncNow();
  ok(st.state === 'ok' && /الدفعات/.test(st.toast), 'single: تغيير واحد مرفوض يُعاد مع رسالته ولا يعلّق المزامنة', { st, syncLog });
  st = await syncNow();
  ok(st.state === 'ok' && !syncLog.some((x) => x.status >= 400), 'single: والمزامنة بعده سليمة', { st, syncLog });

  await ctx.close();
  ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript في الصفحة', pageErrors);
} catch (e) {
  fail++; console.log('FAIL  harness :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally {
  await browser.close();
  server.close();
}
console.log(`=== staff-sync-recovery: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
