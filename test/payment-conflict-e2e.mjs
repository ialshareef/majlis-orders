/* اختبار واجهة آلي: الدفع السريع من «المتبقي»، ونافذة التعارض (دمج ثلاثي، وكتابة فوق محذّرة).
   حالة حقيقية (طلب #1021): نصف المبلغ ثم «كامل المبلغ» فصار المدفوع أكبر من الإجمالي؛ ثم تعارض
   بين نسخة المالك ونسخة الموظف، والزر البارز كان «اكتب فوق نسخة الخادم» فيمحو دفعة الموظف.
   الخادم الحقيقي على D1 وهمية + index.html في Chrome headless.
   الاستخدام: node test/payment-conflict-e2e.mjs */
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
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); }
};

const PW = 'test1234';
const salt = crypto.randomBytes(16);
const H = `pbkdf2$100000$${salt.toString('base64')}$${crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256').toString('base64')}`;
const past = new Date(Date.now() - 86400000 * 30).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();
const U = (id, username, name, role) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H });
const at = new Date(Date.now() - 86400000).toISOString();
const ord = (id, number) => {
  const d = { id, number, status: 'new', createdBy: '2', createdByName: 'عاصم', createdAt: at, updatedAt: at, updatedByName: 'عاصم',
    customer: { name: 'عميل ' + number, phone: '05000000' + String(number).slice(-2) }, design: { walls: [], pieces: [] }, lines: [],
    manualRows: [{ name: 'خدمة', qty: 1, unit: 'خدمة', price: 1000 }], priceOverrides: {},
    subtotal: 1000, discount: 0, vat: { enabled: true, rate: 15 }, vatRate: 15, vatAmount: 150, total: 1150, paid: 0, remaining: 1150, payments: [] };
  return { id, number, status: 'new', customer_name: d.customer.name, created_by: '2', created_at: at, updated_at: at, data: JSON.stringify(d) };
};
const env = envWith({
  users: [U('1', 'owner', 'فواز', 'admin'), U('2', 'asim', 'عاصم', 'staff')],
  sessions: [{ token: 'tok-asim', user_id: '2', created_at: past, expires_at: future }],
  counters: [{ key: 'order_no', value: 1030 }],
  settings: [{ id: 1, data: JSON.stringify({ shopName: 'أصالة نجد', depositPct: 25 }), updated_at: past }],
  items: [], orders: [ord('o1', 1021), ord('o2', 1022), ord('o3', 1023)],
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions']) env.DB.tables.set(t, []);
env.ADMIN_INIT_PASSWORD = '';
env.OWNER_USER_ID = '1';
{ const prep = env.DB.prepare.bind(env.DB); env.DB.prepare = (sql) => prep(String(sql).replace(/lower\(username\)\s*=\s*\?/i, 'username = ?').replace(/\bid IS NOT \?/i, 'id <> ?')); }
const srv = (id) => JSON.parse(env.DB.tables.get('orders').find((r) => r.id === id).data);

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

/** تعديل يحفظه الموظف من جهازه (عبر الخادم الحقيقي بجلسته): دفعة نقدية جديدة */
async function asimAddsPayment(id, amount) {
  const o = srv(id);
  const base = o.updatedAt;
  const p = { id: 'pa-' + id, at: '2026-10-07', amount, method: 'cash', note: '', by: 'عاصم', byId: '2', createdAt: new Date().toISOString() };
  const next = { ...o, payments: [...(o.payments || []), p], paid: money(num(o.paid) + amount), updatedAt: new Date().toISOString(), updatedByName: 'عاصم', _base: base };
  next.remaining = Math.max(0, money(next.total - next.paid));   // كما يحفظه التطبيق (لا سالب)
  const r = await worker.fetch(new Request(origin + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': 'tok-asim' }, body: JSON.stringify({ orders: { upsert: [next], delete: [] } }) }), env);
  if (r.status !== 200) console.log('asim sync', r.status, (await r.text()).slice(0, 200));
  return r.status;
}
/** تعديل آخر من جهاز الموظف لا يمسّ الدفعات: الملاحظات */
async function asimEditsNotes(id, notes) {
  const o = srv(id);
  const next = { ...o, notes, updatedAt: new Date().toISOString(), updatedByName: 'عاصم', _base: o.updatedAt };
  const r = await worker.fetch(new Request(origin + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': 'tok-asim' }, body: JSON.stringify({ orders: { upsert: [next], delete: [] } }) }), env);
  return r.status;
}
const num = (v) => Number(v) || 0;
const money = (v) => Math.round(num(v) * 100) / 100;

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي اختبار الواجهة'); server.close(); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
routeDownloads(browser);
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message).split('\n')[0]));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', 'owner'); await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
  await sleep(2500);
  const closeModal = () => page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  await closeModal();

  const openOrder = async (id) => {
    await page.evaluate(() => { const b = [...document.querySelectorAll('[data-page="orders"]')].find((x) => x.offsetParent !== null); b.click(); });
    await sleep(800);
    await page.evaluate((i) => document.querySelector(`#ordersTable [data-open="${i}"]`).click(), id);
    await sleep(1200);
    await page.evaluate(() => document.querySelector('#stepNav a[data-stage="pay"]').click());
    await sleep(500);
  };
  const toastTxt = () => page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  const paidOf = () => page.evaluate(() => window.MajlisApp.order.payments.reduce((s, p) => s + Number(p.amount), 0));

  /* ----- 1) الدفع السريع: نصف الإجمالي ثم «المتبقي» = الإجمالي بالضبط (لا ضعفه) ----- */
  await openOrder('o1');
  await page.evaluate(() => document.querySelector('[data-pay="0.5"]').click());
  ok(await page.$eval('#payAmount', (e) => e.value) === '575', 'quick: نصف الإجمالي = 575');
  await page.evaluate(() => document.getElementById('btnAddPay').click());
  await page.waitForFunction(() => /سُجّلت دفعة 575/.test(document.getElementById('toast').textContent), { timeout: 20000 });
  const remLbl = await page.$eval('#payRemBtn', (e) => e.textContent.trim());
  ok(/المتبقي 575\.00/.test(remLbl), 'quick: الزر يعرض «المتبقي 575.00» بعد الدفعة الأولى', remLbl);
  await page.evaluate(() => document.querySelector('[data-pay="rem"]').click());
  ok(await page.$eval('#payAmount', (e) => e.value) === '575', 'quick: «المتبقي» يملأ 575 (كان «كامل المبلغ» يملأ 1150)', await page.$eval('#payAmount', (e) => e.value));
  await page.evaluate(() => document.getElementById('btnAddPay').click());
  await page.waitForFunction(() => /سُجّلت دفعة 575/.test(document.getElementById('toast').textContent) && window.MajlisApp.order.payments.length === 2, { timeout: 20000 });
  ok(await paidOf() === 1150 && srv('o1').paid === 1150, 'quick: المدفوع = الإجمالي 1150 تماماً (على الجهاز والخادم)', { local: await paidOf(), server: srv('o1').paid });
  ok(await page.$eval('#payRemBtn', (e) => e.disabled), 'quick: «المتبقي» معطّل بعد السداد الكامل');
  await page.evaluate(() => document.querySelector('[data-pay="0.5"]').click());
  ok(await page.$eval('#payAmount', (e) => e.value) === '', 'quick: «نصف الإجمالي» لا يقترح مبلغاً بعد السداد', await page.$eval('#payAmount', (e) => e.value));

  /* ----- 2) دفعة أكبر من المتبقي: تأكيد صريح، والإلغاء لا يسجّل شيئاً ----- */
  await page.evaluate(() => { const el = document.getElementById('payAmount'); el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnAddPay').click(); });
  await page.waitForFunction(() => !document.getElementById('modal').hidden && /أكبر من المتبقي/.test(document.getElementById('modalTitle').textContent), { timeout: 10000 });
  const overMsg = await page.$eval('#modalBody', (e) => e.textContent);
  ok(/المتبقي على الطلب 0\.00/.test(overMsg) && /بـ 100\.00/.test(overMsg), 'over: الرسالة تذكر المتبقي والزيادة', overMsg.slice(0, 160));
  await page.evaluate(() => document.getElementById('cNo').click());
  await sleep(600);
  ok((await page.evaluate(() => window.MajlisApp.order.payments.length)) === 2 && srv('o1').payments.length === 2, 'over: الإلغاء لم يسجّل الدفعة');

  /* ----- 3) تعارض + دمج: الموظف أضاف دفعة، والمالك غيّر الحالة على نسخة أقدم ----- */
  await openOrder('o2');
  ok(await asimAddsPayment('o2', 6500) === 200, 'merge: الموظف حفظ دفعة 6,500 من جهازه');
  await page.select('#orderStatus', 'delivered');
  await sleep(500);
  for (let i = 0; i < 3; i++) {   // تأكيدات تغيير الحالة (إن ظهرت)
    const t = await page.evaluate(() => { const m = document.getElementById('modal'); return m.hidden ? '' : document.getElementById('modalTitle').textContent; });
    if (!t || /تعارض/.test(t)) break;
    await page.evaluate(() => { const y = document.getElementById('cYes'); if (y) y.click(); }); await sleep(500);
  }
  await page.evaluate(() => document.getElementById('btnSaveOrder').click());
  await page.waitForFunction(() => !document.getElementById('modal').hidden && /تعارض/.test(document.getElementById('modalTitle').textContent), { timeout: 20000 });
  const dlg = await page.evaluate(() => ({
    primary: (document.querySelector('.conflict-actions .btn.primary') || {}).id,
    keepGhost: document.getElementById('cfKeep').classList.contains('ghost'),
    list: [...document.querySelectorAll('.conflict-list li')].map((l) => l.textContent),
  }));
  ok(dlg.primary === 'cfMerge' && dlg.keepGhost, 'dialog: «ادمج التعديلين» هو الزر الرئيسي، والكتابة فوقها زر باهت', dlg);
  ok(dlg.list.some((l) => /على الخادم «جديد» • عندك «تم التوصيل»/.test(l)) && dlg.list.some((l) => /على الخادم فقط \(ليست عندك\): دفعة 6,500\.00 نقداً/.test(l)), 'dialog: الفروق تقول أي القيمتين على الخادم وأيهما عندك', dlg.list);
  await page.evaluate(() => document.getElementById('cfMerge').click());
  await page.waitForFunction(() => /دُمج التعديلان/.test(document.getElementById('toast').textContent), { timeout: 20000 });
  const m2 = srv('o2');
  ok(m2.status === 'delivered' && m2.payments.some((p) => p.id === 'pa-o2' && p.amount === 6500) && m2.paid === 6500, 'merge: على الخادم حالة «تم التوصيل» ودفعة الموظف 6,500 معاً', { status: m2.status, paid: m2.paid, pays: m2.payments.map((p) => p.amount) });
  ok(m2.updatedByName === 'فواز', 'merge: الحفظ باسم من دمج', m2.updatedByName);

  /* ----- 4) الكتابة فوق نسخة الخادم: تحذير صريح بالدفعة التي ستُحذف، والإلغاء يعيد النافذة ----- */
  await openOrder('o3');
  ok(await asimAddsPayment('o3', 300) === 200, 'overwrite: الموظف حفظ دفعة 300');
  await page.evaluate(() => { const n = document.getElementById('orderNotes'); n.value = 'ملاحظة المالك'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => document.getElementById('btnSaveOrder').click());
  await page.waitForFunction(() => !document.getElementById('modal').hidden && /تعارض/.test(document.getElementById('modalTitle').textContent), { timeout: 20000 });
  await page.evaluate(() => document.getElementById('cfKeep').click());
  await page.waitForFunction(() => /الكتابة فوق/.test(document.getElementById('modalTitle').textContent), { timeout: 10000 });
  const warn = await page.$eval('#modalBody', (e) => e.textContent);
  ok(/سيُحذف من الخادم: دفعة 300\.00 نقداً/.test(warn), 'overwrite: التحذير يذكر الدفعة التي ستُحذف', warn.slice(0, 200));
  await page.evaluate(() => document.getElementById('cNo').click());
  await page.waitForFunction(() => !!document.getElementById('cfMerge'), { timeout: 20000 });
  ok(srv('o3').payments.length === 1, 'overwrite: الإلغاء لم يكتب شيئاً، ونافذة التعارض عادت بزر الدمج');
  await page.evaluate(() => document.getElementById('cfMerge').click());
  await page.waitForFunction(() => /دُمج التعديلان/.test(document.getElementById('toast').textContent), { timeout: 20000 });
  const m3 = srv('o3');
  ok(m3.notes === 'ملاحظة المالك' && m3.payments.length === 1 && m3.paid === 300, 'overwrite→merge: ملاحظة المالك ودفعة الموظف معاً', { notes: m3.notes, paid: m3.paid });

  /* ----- 5) حالة #1021: المالك يحذف دفعة زائدة، والموظف عدّل شيئاً آخر — الدمج يُبقي الحذف ----- */
  await openOrder('o1');
  ok(await asimEditsNotes('o1', 'ملاحظة عاصم') === 200, 'delete-merge: الموظف عدّل الملاحظات من جهازه');
  const delId = await page.evaluate(() => window.MajlisApp.order.payments[1].id);
  await page.evaluate((i) => document.querySelector(`[data-paydel="${i}"]`).click(), delId);
  await page.waitForFunction(() => /حذف دفعة/.test(document.getElementById('modalTitle').textContent), { timeout: 10000 });
  await page.evaluate(() => document.getElementById('cYes').click());
  await page.waitForFunction(() => !document.getElementById('modal').hidden && /تعارض/.test(document.getElementById('modalTitle').textContent), { timeout: 20000 });
  await page.evaluate(() => document.getElementById('cfMerge').click());
  await page.waitForFunction(() => /دُمج التعديلان/.test(document.getElementById('toast').textContent), { timeout: 20000 });
  const m1 = srv('o1');
  ok(m1.payments.length === 1 && m1.paid === 575 && m1.notes === 'ملاحظة عاصم', 'delete-merge: الدفعة المحذوفة لم تعد، وملاحظة الموظف بقيت', { paid: m1.paid, n: m1.payments.length, notes: m1.notes });

  await ctx.close();
  ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript في الصفحة', pageErrors);
} catch (e) {
  fail++; console.log('FAIL  harness :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally {
  await browser.close();
  server.close();
}
console.log(`=== payment-conflict: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
