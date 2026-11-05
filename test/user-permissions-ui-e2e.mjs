/* اختبار واجهة آلي: صلاحيات المستخدم داخل نافذة تعديل المستخدم (من البداية للنهاية).
   الخادم الحقيقي (worker/worker.js) على D1 وهمية في الذاكرة (_d1-mem.mjs) + الواجهة
   الحقيقية (index.html) في Chrome/Edge headless عبر puppeteer-core — بلا حزم إضافية.
   الخادم المحلي يقدّم ملفات المشروع ويمرّر /api/* للـ Worker من نفس الأصل، ويستبدل
   config.js في الذاكرة فقط (لا يُعدَّل أي ملف ولا اتصال بالإنتاج).

   يغطي: تحديث الافتراضيات فور تغيير الدور مع بقاء التجاوزات اليدوية · حفظ بيانات المستخدم
   وحفظ صلاحياته كلٌّ على حدة ثم الاسترجاع بعد إعادة الفتح · «إعادة إلى افتراضي الدور»
   قبل الإغلاق وبعد إعادة الفتح · admin.core مقفلة · Deny override · سجل التدقيق ·
   إخفاء القسم عمّن لا يملك permissions.manage · رفض الخادم (403) للموظف والمندوب والمدير
   المسحوبة منه الصلاحية.

   الاستخدام: node test/user-permissions-ui-e2e.mjs */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { routeDownloads, TEST_DL } from './_downloads.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const workerSrc = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const { default: worker, ROLE_PERMISSIONS } = await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'));
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

/* ---------------- بيانات تجريبية ---------------- */
const PW = 'test1234';
const mkHash = (pw) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
  return `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
};
const past = new Date(Date.now() - 86400000).toISOString();
const H = mkHash(PW);
const U = (id, username, name, role) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H });
const env = envWith({
  users: [
    U('1', 'admin', 'مدير النظام', 'admin'),
    U('2', 'staff1', 'موظف تجريبي', 'staff'),
    U('3', 'mand1', 'مندوب تجريبي', 'mandoub'),
    U('4', 'admin2', 'مدير بلا إدارة صلاحيات', 'admin'),
  ],
  sessions: [],
  orders: [],
  counters: [{ key: 'order_no', value: 1000 }],
  settings: [{ id: 1, data: '{}', updated_at: past }],
  items: [],
});
for (const t of ['customer_designs', 'permission_audit', 'expenses', 'activity']) env.DB.tables.set(t, []);
// المدير الثاني: Deny override على permissions.manage (والدور مدير)
env.DB.tables.set('user_permissions', [{ user_id: '4', permission: 'permissions.manage', value: 0, updated_by: '1', updated_at: past }]);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1'; // المدير 1 مالك النظام؛ المدير الآخر مدير عادي
/* D1 الوهمية لا تدعم lower(col) ولا IS NOT فتتجاهل الشرط (الدخول يعيد المدير دائماً،
   وفحص تكرار الاسم يجد المستخدم نفسه). أسماء المستخدمين هنا بأحرف صغيرة والتعديل دائماً
   بمعرّف، فالصيغة المبسّطة مكافئة — داخل هذا الاختبار فقط. */
{
  const prep = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => prep(String(sql)
    .replace(/lower\(username\)\s*=\s*\?/i, 'username = ?')
    .replace(/\bid IS NOT \?/i, 'id <> ?'));
}

/* ---------------- خادم محلي: ملفات + /api ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let origin = '';
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      const request = new Request(origin + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString('utf8'),
      });
      try {
        const r = await worker.fetch(request, env);
        res.statusCode = r.status;
        r.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message) })); }
      return;
    }
    if (u.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      res.end(`window.APP_CONFIG = { apiUrl: ${JSON.stringify(origin)} };`);
      return;
    }
    if (u.pathname === '/sw.js') { res.writeHead(404); res.end(); return; } // لا Service Worker في الاختبار
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = 'http://127.0.0.1:' + server.address().port;

/* ---------------- 1) فرض الخادم: من يرى ويعدّل صلاحيات غيره ---------------- */
const api = async (method, p, token, body) => {
  const r = await fetch(origin + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { 'x-session-token': token } : {}), body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const tok = {};
for (const n of ['admin', 'staff1', 'mand1', 'admin2']) tok[n] = (await api('POST', '/api/login', null, { username: n, password: PW })).body.token;
ok(Object.values(tok).every(Boolean), 'api: كل المستخدمين التجريبيين سجّلوا الدخول');

for (const n of ['staff1', 'mand1', 'admin2']) {
  const target = n === 'staff1' ? '3' : '2';
  ok((await api('GET', `/api/users/${target}/permissions`, tok[n])).status === 403, `api: ${n} لا يعرض صلاحيات غيره (403)`);
  ok((await api('POST', `/api/users/${target}/permissions`, tok[n], { overrides: { 'orders.view_all': 1 } })).status === 403, `api: ${n} لا يعدّل صلاحيات غيره (403)`);
  ok((await api('DELETE', `/api/users/${target}/permissions`, tok[n])).status === 403, `api: ${n} لا يعيد صلاحيات غيره (403)`);
}
ok((await api('POST', '/api/users/2/permissions', tok.staff1, { overrides: { 'permissions.manage': 1 } })).status === 403, 'api: الموظف لا يمنح نفسه/غيره إدارة الصلاحيات');
ok((await api('GET', '/api/users/2/permissions', null)).status === 401, 'api: بلا جلسة = 401');
const g = await api('GET', '/api/users/2/permissions', tok.admin);
ok(g.status === 200 && g.body.roleDefaults && Array.isArray(g.body.roleDefaults.mandoub), 'api: المدير يقرأ الصلاحيات مع افتراضيات كل الأدوار');
ok((await api('POST', '/api/users/2/permissions', tok.admin, { overrides: { 'admin.core': 1 } })).status === 400, 'api: admin.core لا تُمنح بالتجاوز (400)');

const bootPerms = async (n) => (await api('GET', '/api/bootstrap', tok[n])).body.permissions || [];
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
ok(same(await bootPerms('staff1'), ROLE_PERMISSIONS.staff), 'bootstrap: صلاحيات الموظف الفعّالة = افتراضي دوره');
ok(same(await bootPerms('mand1'), ROLE_PERMISSIONS.mandoub), 'bootstrap: صلاحيات المندوب الفعّالة = افتراضي دوره');
ok((await bootPerms('admin')).includes('permissions.manage'), 'bootstrap: المدير يملك permissions.manage');
// المدير الثاني مدير عادي: بلا الإدارة الكاملة أصلاً (للمالك)، ويبقى له التشغيلي
ok(!(await bootPerms('admin2')).includes('permissions.manage') && !(await bootPerms('admin2')).includes('users.edit') && (await bootPerms('admin2')).includes('orders.view_all'), 'bootstrap: المدير العادي بلا الإدارة الكاملة ومعه التشغيلي');

/* ---------------- 2) الواجهة ---------------- */
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي اختبار الواجهة'); server.close(); process.exit(fail ? 1 : 2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
routeDownloads(browser); // تنزيلات الاختبار إلى Documents/majlis-test-downloads لا مجلد التنزيلات
const pageErrors = [];

async function loginPage(username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(username + ': ' + String(e.message).split('\n')[0]));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', username);
  await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => { const a = document.getElementById('app'); return a && !a.hidden; }, { timeout: 30000 });
  // نوافذ ما بعد الدخول (الشرح/استعادة المسودة) لا تُغلق نموذج المستخدم أثناء الاختبار
  await new Promise((r) => setTimeout(r, 3200));
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); document.querySelectorAll('.tour, .spot-tour, [class*="tour-"]').forEach((el) => el.remove()); });
  return { page, ctx };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openUser(page, id) {
  await page.evaluate(() => document.querySelector('[data-page="users"]').click());
  await page.waitForSelector(`[data-edit="${id}"]`, { visible: true });
  await page.evaluate((i) => document.querySelector(`[data-edit="${i}"]`).click(), id);
  await page.waitForSelector('#uName', { visible: true });
}
const waitPerms = (page) => page.waitForFunction(() => document.querySelectorAll('#uPermList .perm-row').length > 10 && !document.getElementById('uPermSave').disabled, { timeout: 15000 });
/** حالة صف صلاحية: الزر المفعّل (default/1/0) والفعّال المعروض */
const row = (page, p) => page.evaluate((perm) => {
  const btn = document.querySelector(`#uPermList button[data-p="${perm}"]`);
  const r = btn ? btn.closest('.perm-row') : [...document.querySelectorAll('#uPermList .perm-row')].find((x) => x.querySelector('.perm-key').textContent === perm);
  if (!r) return null;
  const on = r.querySelector('.perm-tri button.on');
  return { cur: on ? on.dataset.v : null, eff: r.querySelector('.perm-eff').textContent.trim(), locked: r.classList.contains('is-locked') };
}, p);
const clickPerm = (page, p, v) => page.evaluate((perm, val) => document.querySelector(`#uPermList button[data-p="${perm}"][data-v="${val}"]`).click(), p, v);
const setSelect = (page, sel, v) => page.evaluate((s, val) => { const e = document.querySelector(s); e.value = val; e.dispatchEvent(new Event('change', { bubbles: true })); }, sel, v);
const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!(e && !e.hidden && e.getClientRects().length); }, sel);
const closeModal = async (page) => { await page.evaluate(() => document.getElementById('modalClose').click()); await page.waitForFunction(() => document.getElementById('modal').hidden); };
const allDefault = (page) => page.evaluate(() => [...document.querySelectorAll('#uPermList .perm-tri')].every((t) => (t.querySelector('button.on') || {}).dataset?.v === 'default'));

try {
  /* ----- المدير ----- */
  const { page } = await loginPage('admin');
  await openUser(page, '2');
  await waitPerms(page);
  ok(await visible(page, '#uPermSection'), 'ui/admin: قسم الصلاحيات ظاهر للمدير');
  ok(/موظف/.test(await text(page, '#uPermRoleHint')), 'ui: الدور المعروض موظف');
  let r = await row(page, 'orders.view_all');
  ok(r && r.cur === 'default' && r.eff === 'ممنوع', 'ui: orders.view_all افتراضي وممنوع للموظف', r);
  r = await row(page, 'admin.core');
  ok(r && r.locked && r.cur === null && r.eff === 'ممنوع', 'ui: admin.core مقفلة (بالدور فقط) بلا أزرار', r);

  // تجاوز يدوي ثم تغيير الدور: التجاوز يبقى والافتراضيات تتبع الدور الجديد
  await clickPerm(page, 'orders.view_all', '1');
  await clickPerm(page, 'reports.view_own', '0');
  ok(await visible(page, '#uPermDirty'), 'ui: شارة «تعديلات غير محفوظة» تظهر بعد التعديل');
  await setSelect(page, '#uRole', 'mandoub');
  ok(/مندوب/.test(await text(page, '#uPermRoleHint')) && /غير محفوظ/.test(await text(page, '#uPermRoleHint')), 'ui: تغيير الدور يحدّث التلميح فوراً (غير محفوظ)');
  r = await row(page, 'commission.view_own');
  ok(r && r.cur === 'default' && r.eff === 'مسموح', 'ui: افتراضي المندوب يظهر فوراً (commission.view_own مسموح)', r);
  r = await row(page, 'profit.view_own');
  ok(r && r.cur === 'default' && r.eff === 'ممنوع', 'ui: افتراضي الموظف يختفي فوراً (profit.view_own ممنوع للمندوب)', r);
  r = await row(page, 'orders.view_all');
  ok(r && r.cur === '1' && r.eff === 'مسموح', 'ui: التجاوز اليدوي (مسموح) باقٍ بعد تغيير الدور', r);
  await setSelect(page, '#uRole', 'admin');
  r = await row(page, 'users.view');
  ok(r && r.cur === 'default' && r.eff === 'مسموح', 'ui: دور مدير: users.view افتراضياً مسموح', r);
  r = await row(page, 'reports.view_own');
  ok(r && r.cur === '0' && r.eff === 'ممنوع', 'ui: Deny override يغلب افتراضي المدير المسموح', r);
  r = await row(page, 'admin.core');
  ok(r && r.eff === 'ممنوع' && r.locked, 'ui: admin.core لا تتبع دور «مدير» — لمالك النظام وحده', r);
  await setSelect(page, '#uRole', 'staff');
  ok(!/غير محفوظ/.test(await text(page, '#uPermRoleHint')), 'ui: العودة للدور المحفوظ تزيل «غير محفوظ»');
  await setSelect(page, '#uActive', '0');
  r = await row(page, 'orders.view_own');
  ok(r && r.eff === 'ممنوع', 'ui: الحساب الموقوف يُعرض بلا صلاحيات فعّالة', r);
  await setSelect(page, '#uActive', '1');

  // «حفظ» المستخدم مع صلاحيات غير محفوظة: تنبيه داخل النافذة ولا إغلاق
  await page.evaluate(() => document.getElementById('uSave').click());
  await sleep(300);
  ok(await visible(page, '#uPermList') && /لم تحفظها/.test(await text(page, '#uErr')), 'ui: حفظ المستخدم ينبّه لصلاحيات غير محفوظة دون إغلاق النافذة');

  // حفظ الصلاحيات وحده
  await page.evaluate(() => document.getElementById('uPermSave').click());
  await page.waitForFunction(() => document.getElementById('uPermDirty').hidden, { timeout: 15000 });
  const stored = env.DB.tables.get('user_permissions').filter((x) => x.user_id === '2');
  ok(stored.length === 2 && stored.some((x) => x.permission === 'orders.view_all' && Number(x.value) === 1) && stored.some((x) => x.permission === 'reports.view_own' && Number(x.value) === 0), 'd1: حفظ الصلاحيات خزّن التجاوزين فقط', stored);
  const bootStaff = await bootPerms('staff1');
  ok(bootStaff.includes('orders.view_all') && !bootStaff.includes('reports.view_own'), 'api: التجاوزات تسري فوراً على جلسة الموظف القائمة');
  await closeModal(page);
  await openUser(page, '2');
  await waitPerms(page);
  r = await row(page, 'orders.view_all');
  const r2 = await row(page, 'reports.view_own');
  ok(r && r.cur === '1' && r2 && r2.cur === '0' && r2.eff === 'ممنوع', 'ui: إعادة الفتح تسترجع الصلاحيات المحفوظة', { r, r2 });
  ok(!(await visible(page, '#uPermDirty')), 'ui: لا «غير محفوظ» بعد إعادة الفتح');

  // حفظ بيانات المستخدم وحده (الاسم) — لا يمس الصلاحيات
  await page.evaluate(() => { const e = document.getElementById('uName'); e.value = 'موظف معدّل'; });
  await page.evaluate(() => document.getElementById('uSave').click());
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  ok(env.DB.tables.get('users').find((x) => x.id === '2').name === 'موظف معدّل', 'd1: حفظ بيانات المستخدم خزّن الاسم');
  await openUser(page, '2');
  await waitPerms(page);
  ok((await page.$eval('#uName', (e) => e.value)) === 'موظف معدّل', 'ui: إعادة الفتح تسترجع الاسم المحفوظ');
  r = await row(page, 'orders.view_all');
  ok(r && r.cur === '1', 'ui: حفظ بيانات المستخدم لم يمس الصلاحيات المحفوظة', r);

  // إعادة إلى افتراضي الدور: تأكيد بضغطة ثانية داخل النافذة
  await page.evaluate(() => document.getElementById('uPermReset').click());
  ok(/للتأكيد/.test(await text(page, '#uPermReset')) && await visible(page, '#uPermList'), 'ui: الإعادة تطلب ضغطة تأكيد ولا تغلق النافذة');
  ok(env.DB.tables.get('user_permissions').filter((x) => x.user_id === '2').length === 2, 'd1: لا مسح قبل التأكيد');
  await page.evaluate(() => document.getElementById('uPermReset').click());
  await page.waitForFunction(() => [...document.querySelectorAll('#uPermList .perm-tri')].every((t) => (t.querySelector('button.on') || {}).dataset?.v === 'default'), { timeout: 15000 });
  ok(await visible(page, '#uPermList'), 'ui: النافذة باقية مفتوحة بعد الإعادة');
  r = await row(page, 'orders.view_all');
  // reports.view_own لم يعد افتراضياً للموظف (لا شاشة تُمنح تلقائياً): يعود «ممنوع»، وorders.view_own «مسموح»
  ok(r && r.eff === 'ممنوع' && (await row(page, 'reports.view_own')).eff === 'ممنوع' && (await row(page, 'orders.view_own')).eff === 'مسموح', 'ui: القيم بعد الإعادة = افتراضي الموظف', r);
  ok(env.DB.tables.get('user_permissions').filter((x) => x.user_id === '2').length === 0, 'd1: الإعادة مسحت كل تجاوزات المستخدم');
  await closeModal(page);
  await openUser(page, '2');
  await waitPerms(page);
  ok(await allDefault(page), 'ui: بعد إعادة الفتح كل الصلاحيات «افتراضي»');

  // تغيير الدور ثم حفظ المستخدم: الافتراضيات المعروضة بعد إعادة الفتح للدور الجديد
  await closeModal(page);
  await openUser(page, '3');
  await waitPerms(page);
  await setSelect(page, '#uRole', 'staff');
  await page.evaluate(() => document.getElementById('uSave').click());
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });
  await openUser(page, '3');
  await waitPerms(page);
  r = await row(page, 'profit.view_own');
  ok(/موظف/.test(await text(page, '#uPermRoleHint')) && !/غير محفوظ/.test(await text(page, '#uPermRoleHint')) && r.eff === 'مسموح', 'ui: الدور المحفوظ وافتراضياته تظهر بعد إعادة الفتح', r);
  await setSelect(page, '#uRole', 'mandoub');
  await page.evaluate(() => document.getElementById('uSave').click());
  await page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 15000 });

  // سجل التدقيق
  const audit = env.DB.tables.get('permission_audit').filter((a) => a.target_user_id === '2');
  ok(audit.filter((a) => a.change_type === 'permission').length === 2 && audit.some((a) => a.change_type === 'defaults_restore' && a.actor_user_id === '1'), 'd1: سجل التدقيق يحوي الحفظ والإعادة باسم المدير', audit.map((a) => a.change_type));

  /* ----- المدير المسحوبة منه permissions.manage ----- */
  const a2 = await loginPage('admin2');
  // المدير العادي: لا تعديل للمستخدمين أصلاً (users.edit للمالك أو بمنحه) فلا نافذة صلاحيات تُفتح
  await a2.page.evaluate(() => document.querySelector('[data-page="users"]').click());
  await a2.page.waitForSelector('#usersTable tbody tr', { visible: true });
  ok(!(await a2.page.$('#usersTable [data-edit]')) && !(await a2.page.$('#uPermSection')), 'ui/admin2: لا أزرار تعديل ولا قسم صلاحيات للمدير العادي');
  ok(await a2.page.evaluate(() => Store.can('permissions.manage') === false), 'ui/admin2: Store.can يرفض');

  /* ----- الموظف والمندوب ----- */
  for (const n of ['staff1', 'mand1']) {
    const s = await loginPage(n);
    ok(!(await visible(s.page, '[data-page="users"]')), `ui/${n}: صفحة المستخدمين غير ظاهرة`);
    ok(await s.page.evaluate(() => Store.can('permissions.manage') === false && Store.can('orders.view_own') === true), `ui/${n}: Store.can يعكس صلاحياته الفعّالة`);
  }
} catch (e) {
  fail++; console.log('FAIL  تعذّر إكمال سيناريو الواجهة  -> ' + String(e && e.message).split('\n')[0]);
  console.log(String(e && e.stack).split('\n').filter((l) => l.includes('user-permissions-ui-e2e')).slice(0, 2).join('\n'));
  for (const p of await browser.pages()) {
    console.log('      #uErr=', await text(p, '#uErr').catch(() => null), ' #uPermErr=', await text(p, '#uPermErr').catch(() => null),
      await p.evaluate(() => JSON.stringify({ users: (Store.db.users || []).map((x) => [x.id, x.username]), u: (document.getElementById('uUser') || {}).value })).catch(() => null));
  }
}

ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript في الصفحة', pageErrors);
await browser.close();
server.close();
console.log(`\n=== user-permissions-ui: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
