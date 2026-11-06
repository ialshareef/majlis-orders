/* اختبار واجهة آلي: الواجهة تتبع الصلاحيات لا الدور، وشاشة المصروفات من البداية للنهاية.
   الخادم الحقيقي على D1 وهمية + index.html في Chrome/Edge headless (نفس أسلوب
   user-permissions-ui-e2e.mjs، بلا حزم إضافية ولا ملفات تُكتب في المشروع).
   الاستخدام: node test/permission-ui-e2e.mjs */
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
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

const PW = 'test1234';
const salt = crypto.randomBytes(16);
const H = `pbkdf2$100000$${salt.toString('base64')}$${crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256').toString('base64')}`;
const past = new Date(Date.now() - 86400000).toISOString();
const U = (id, username, name, role) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H });
const ord = (id, number, by, byName, extra = {}) => ({ id, number, status: 'new', customer_name: 'عميل ' + number, created_by: by, created_at: past, updated_at: past,
  data: JSON.stringify(Object.assign({ id, number, status: 'new', createdBy: by, createdByName: byName, createdAt: past, updatedAt: past,
    customer: { name: 'عميل ' + number, phone: '0500000000' }, design: { pieces: [] }, lines: [], subtotal: 1000, vatAmount: 150, total: 1150,
    paid: 100, remaining: 1050, payments: [{ id: 'p' + id, at: '2026-11-01', amount: 100, method: 'cash', note: '' }] }, extra)) });
const grant = (user_id, list, value = 1) => list.map((permission) => ({ user_id, permission, value, updated_by: '1', updated_at: past }));
const env = envWith({
  users: [U('1', 'admin', 'مدير النظام', 'admin'), U('2', 'staff1', 'موظف افتراضي', 'staff'), U('3', 'staff2', 'موظف ممنوح', 'staff'), U('4', 'admin2', 'مدير مقيّد', 'admin')],
  sessions: [],
  orders: [ord('o2', 1001, '2', 'موظف افتراضي'), ord('o3', 1002, '3', 'موظف ممنوح')],
  counters: [{ key: 'order_no', value: 1002 }],
  settings: [{ id: 1, data: '{}', updated_at: past }],
  items: [],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses']) env.DB.tables.set(t, []);
env.DB.tables.set('user_permissions', [
  ...grant('3', ['expenses.view_own', 'expenses.add_own', 'expenses.edit_own', 'expenses.delete_own', 'reports.view_own', 'items.manage', 'users.view', 'payments.delete']),
  ...grant('3', ['costs.add_own'], 0),
  ...grant('4', ['settings.manage', 'reports.export'], 0),
]);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1'; // المدير 1 مالك النظام؛ المدير الآخر مدير عادي
/* D1 الوهمية لا تدعم lower(col) ولا IS NOT — صيغة مكافئة هنا فقط (أسماء بأحرف صغيرة) */
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
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', username); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(3200);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  return page;
}
const navVisible = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#mainNav button[data-page]')].map((b) => [b.dataset.page, !b.hidden]).concat([...document.querySelectorAll('.page-tabs [data-goto]')].map((b) => [b.dataset.goto, !b.hidden]))));
const go = async (page, name) => { await page.evaluate((n) => (document.querySelector(`#mainNav button[data-page="${n}"]`) || document.querySelector(`.page-tabs [data-goto="${n}"]`)).click(), name); await sleep(700); };
const exists = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!(e && !e.hidden && e.getClientRects().length); }, sel);
const rowsText = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s + ' tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()), sel);

try {
  /* ----- موظف بالافتراضيات ----- */
  let page = await login('staff1');
  let nav = await navVisible(page);
  ok(nav.designs === true, 'staff/default: «تصاميم العملاء» ظاهرة (designs.view افتراضي)', nav);
  ok(!nav.expenses && !nav.bi && !nav.items && !nav.users && !nav.settings && !nav.activity, 'staff/default: لا شاشة إدارية ولا مصروفات ولا تقارير تلقائياً', nav);
  ok(await page.evaluate(() => [...document.querySelectorAll('#mainNav .sb-group')].slice(1).every((g) => g.hidden)), 'staff/default: عناوين الأقسام (المال، التقارير، الإدارة) مخفية حين لا صفحة تحتها');
  await go(page, 'orders');
  ok(await exists(page, '[data-cost="o2"]'), 'staff/default: «إضافة التكاليف» لطلبه (costs.add_own افتراضي)');
  ok(!(await exists(page, '[data-delo="o2"]')), 'staff/default: لا حذف لطلبه (orders.delete_own غير ممنوح)');
  ok(!(await exists(page, '[data-perm-export]:not([hidden])')), 'staff/default: لا أزرار تصدير ظاهرة');
  await page.evaluate(() => document.querySelector('[data-open="o2"]').click()); await sleep(900);
  // قسم الدفعات خطوة من مراحل صفحة الطلب (#m-pay) قد تكون مطوية: المعيار سمة hidden على العنصر نفسه
  ok(await page.evaluate(() => { const e = document.querySelector('.pay-add'); return !!e && !e.hidden; }), 'staff/default: تسجيل الدفعات متاح (payments.add افتراضي)');
  ok(!(await exists(page, '[data-paydel]')), 'staff/default: لا زر حذف دفعة (payments.delete غير ممنوح)');
  await page.browserContext().close();

  /* ----- موظف ممنوح صلاحيات بعينها ----- */
  page = await login('staff2');
  nav = await navVisible(page);
  ok(nav.expenses && nav.bi && nav.items && nav.users, 'staff/granted: المصروفات والتقارير والأصناف والمستخدمون تظهر بالمنح', nav);
  ok(!nav.settings && !nav.activity && !nav.mandoubs, 'staff/granted: الإعدادات والسجل والمناديب تبقى للمدير', nav);
  await go(page, 'users');
  ok(!(await visible(page, '#btnAddUser')) && !(await exists(page, '#usersTable [data-edit]')), 'staff/granted: قائمة المستخدمين للعرض فقط (لا إضافة ولا تعديل)');
  await go(page, 'orders');
  ok(!(await exists(page, '[data-cost="o3"]')), 'staff/granted: منع costs.add_own يخفي «إضافة التكاليف»');
  await page.evaluate(() => document.querySelector('[data-open="o3"]').click()); await sleep(900);
  ok(await exists(page, '[data-paydel]'), 'staff/granted: payments.delete الممنوح يُظهر حذف الدفعة');

  // شاشة المصروفات: إضافة → ظهور → تعديل → حذف
  await go(page, 'expenses');
  ok(await visible(page, '#btnAddExpense'), 'expenses: زر الإضافة ظاهر (expenses.add_own)');
  await page.evaluate(() => document.getElementById('btnAddExpense').click());
  await page.waitForSelector('#exName', { visible: true });
  await page.evaluate(() => { document.getElementById('exDate').value = '2026-11-02'; });
  await page.type('#exName', 'نقل وتركيب'); await page.type('#exAmount', '2500'); await page.type('#exCat', 'نقل');
  await page.select('#exOrder', 'o3');
  ok(!(await exists(page, '#exUser')), 'expenses: لا «سجّله باسم» بلا expenses.add_all');
  await page.evaluate(() => document.getElementById('exSave').click());
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  await sleep(500);
  let rows = await rowsText(page, '#expensesTable');
  ok(rows.length === 1 && /نقل وتركيب/.test(rows[0]) && /2,500/.test(rows[0]) && /#1002/.test(rows[0]) && /موظف ممنوح/.test(rows[0]), 'expenses: المصروف يظهر بالبيان والمبلغ والطلب ومن سجّله', rows);
  const stored = env.DB.tables.get('expenses');
  ok(stored.length === 1 && stored[0].expense_date === '2026-11-02' && stored[0].order_id === 'o3' && stored[0].category === 'نقل' && stored[0].created_by === '3', 'd1: المصروف محفوظ بالتاريخ والتصنيف والطلب والمُسجِّل', stored);
  ok(/2,500/.test(await page.$eval('#expStats', (e) => e.innerText)), 'expenses: الإجمالي يُحسب من المصروفات الفعلية');
  await page.evaluate(() => document.querySelector('[data-expedit]').click());
  await page.waitForSelector('#exAmount', { visible: true });
  await page.evaluate(() => { const a = document.getElementById('exAmount'); a.value = '3000'; });
  await page.evaluate(() => document.getElementById('exSave').click());
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  await sleep(500);
  ok(env.DB.tables.get('expenses')[0].amount === 3000 && /3,000/.test((await rowsText(page, '#expensesTable'))[0]), 'expenses: التعديل يُحفظ ويظهر');
  await page.evaluate(() => document.querySelector('[data-expdel]').click());
  await page.waitForSelector('#cYes', { visible: true });
  await page.evaluate(() => document.getElementById('cYes').click());
  await sleep(1200);
  ok(env.DB.tables.get('expenses').length === 0 && await visible(page, '#expEmpty'), 'expenses: الحذف يُزيل المصروف');
  await page.browserContext().close();

  /* ----- المدير: مصروفات الجميع + قفل الصلاحيات الإدارية لغير المدير ----- */
  env.DB.tables.get('expenses').push({ id: 'e9', name: 'مشتريات', amount: 4000, category: 'مشتريات', note: null, created_by: '3', created_at: past, updated_at: past, expense_date: '2026-11-03', order_id: null });
  page = await login('admin');
  await go(page, 'expenses');
  rows = await rowsText(page, '#expensesTable');
  ok(rows.length === 1 && /مشتريات/.test(rows[0]) && await exists(page, '[data-expedit="e9"]'), 'admin: يرى مصروفات الموظفين ويعدّلها (‎_all)', rows);
  await page.evaluate(() => document.getElementById('btnAddExpense').click());
  await page.waitForSelector('#exName', { visible: true });
  ok(await exists(page, '#exUser'), 'admin: «سجّله باسم» متاح (expenses.add_all)');
  await page.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);
  await go(page, 'users');
  await page.evaluate(() => document.querySelector('[data-edit="2"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#uPermList .perm-row').length > 20, { timeout: 15000 });
  const locks = await page.evaluate(() => [...document.querySelectorAll('#uPermList .perm-row')].filter((r) => /للمدير فقط/.test(r.innerText)).map((r) => r.querySelector('.perm-key').textContent));
  ok(['permissions.manage', 'users.create', 'users.edit', 'users.disable', 'settings.manage'].every((p) => locks.includes(p)), 'admin/modal: الصلاحيات الإدارية مقفلة «للمدير فقط» عند تعديل موظف', locks);
  const newPerms = await page.evaluate(() => [...document.querySelectorAll('#uPermList .perm-key')].map((e) => e.textContent));
  ok(['payments.add', 'payments.edit', 'payments.delete', 'reports.export', 'items.manage', 'designs.view', 'designs.edit', 'designs.convert', 'designs.delete'].every((p) => newPerms.includes(p)) && !newPerms.includes('designs.manage'), 'admin/modal: الصلاحيات المفصولة الجديدة ظاهرة', newPerms);
  await page.evaluate(() => document.getElementById('uRole').value = 'admin');
  await page.evaluate(() => document.getElementById('uRole').dispatchEvent(new Event('change', { bubbles: true })));
  const locksAdmin = await page.evaluate(() => [...document.querySelectorAll('#uPermList .perm-row')].filter((r) => /للمدير فقط/.test(r.innerText)).length);
  ok(locksAdmin === 0, 'admin/modal: عند اختيار دور «مدير» تُفتح الصلاحيات الإدارية للتعديل', locksAdmin);
  await page.browserContext().close();

  /* ----- مدير مسحوب منه الإعدادات والتصدير ----- */
  page = await login('admin2');
  nav = await navVisible(page);
  ok(!nav.settings && nav.users && nav.bi, 'admin2: منع settings.manage يخفي الإعدادات فقط', nav);
  await go(page, 'bi');
  ok(!(await exists(page, '[data-perm-export]:not([hidden])')), 'admin2: منع reports.export يخفي أزرار التصدير');
  await page.browserContext().close();
} catch (e) {
  fail++; console.log('FAIL  تعذّر إكمال سيناريو الواجهة  -> ' + String(e && e.stack).split('\n').slice(0, 3).join(' <- '));
}

ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript في الصفحة', pageErrors);
await browser.close();
server.close();
console.log(`\n=== permission-ui: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
