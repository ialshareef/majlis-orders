/* إشعارات واتساب اليدوية — اختبار واجهة من البداية للنهاية (كمبيوتر وجوال).
   الخادم الحقيقي (worker/worker.js) على SQLite حقيقية مؤقتة (_d1-sqlite.mjs) + الواجهة الحقيقية (index.html)
   في Chrome/Edge headless. لا اتصال بالإنتاج ولا بواتساب: window.open مُعترَض فيُسجَّل الرابط ولا يُفتح.

   يغطي: إدارة المستلمين من الشاشة (إضافة/تكرار/رقم خاطئ/تعديل/تعطيل/العدّاد) · تحديد مستلمين لكل حدث ·
   تعديل القالب ومعاينته · حدث حقيقي (حفظ مصروف من شاشة المصروفات) ← تنبيه «جاهز» ← نافذة التجهيز بنص الحدث
   والمستلمين المحددين ← إرسال متتابع «المستلم 1 من N» بفتح محادثة واحدة لكل ضغطة · التخطي · الإيقاف والاستئناف ·
   منع النوافذ المنبثقة ← «فشل فتح الرابط» · السجل بلا ادعاء تأكيد · ترميز العربية الطويلة في الرابط ·
   الصلاحيات في الواجهة (إخفاء) · الجوال 375px بلا تمرير أفقي · لا أخطاء JavaScript.

   الاستخدام: node test/whatsapp-ui-e2e.mjs */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from './_d1-sqlite.mjs';
import { routeDownloads, TEST_DL } from './_downloads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const workerMod = await import('data:text/javascript;base64,' + Buffer.from(read('worker/worker.js')).toString('base64'));
const worker = workerMod.default;

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 500) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// لقطات اختيارية للمراجعة البصرية: WA_SHOTS=<مجلد>
const SHOTS = process.env.WA_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };

/* ---------------- 0) نسخة الواجهة من قواعد الأرقام والروابط = نسخة الخادم ---------------- */
{
  const ctx = { window: {} };
  vm.runInNewContext(read('js/wa-notify.js'), ctx);
  const W = ctx.window.WaNotify;
  const cases = ['0501234567', '501234567', '+966 50 123 4567', '00966501234567', '966501234567', '+9660501234567', '٠٥٠١٢٣٤٥٦٧', '۰۵۰۱۲۳۴۵۶۷',
    '+971501234567', '+1 (415) 555-2671', '+44 20 7946 0958', '0112345678', '+96650123', 'abc', '+0123456789', '971501234567', '', '+12345678901234567', '+1234567'];
  const diff = cases.filter((c) => JSON.stringify(W.normalizePhone(c)) !== JSON.stringify(workerMod.waNormalizePhone(c)));
  ok(!diff.length, 'parity: تطبيع الأرقام في الواجهة يطابق الخادم في ' + cases.length + ' حالة', diff);
  const msg = '🔔 تنبيه – أصالة نجد\r\nرقم الطلب: 1001\n& ? # % + «» ✅ ' + 'نص '.repeat(300);
  ok(W.link('966501234567', msg) === workerMod.waLink('966501234567', msg), 'parity: رابط wa.me في الواجهة يطابق الخادم (عربي طويل ورموز)');
  ok(W.render('{order_number} {customer_name} {x}', { order_number: 7, customer_name: '' }) === workerMod.waRender('{order_number} {customer_name} {x}', { order_number: 7, customer_name: '' }), 'parity: تعبئة القالب مطابقة');
  ok(W.formatPhone('966501234567') === '+966 50 123 4567' && W.formatPhone('971501234567') === '+971501234567', 'ui: عرض الرقم الدولي مقروءاً');
}

/* ---------------- بيئة: SQLite حقيقية + مستخدمون ---------------- */
const PW = 'test1234';
const H = (() => { const salt = crypto.randomBytes(16); const h = crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256'); return `pbkdf2$100000$${salt.toString('base64')}$${h.toString('base64')}`; })();
const DB = new SqliteD1();
DB.exec(read('worker/schema.sql'));
DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
const T0 = new Date(Date.now() - 86400000).toISOString();
for (const [id, un, n, r] of [['1', 'owner', 'المالك', 'admin'], ['2', 'staff1', 'موظف', 'staff'], ['3', 'sender1', 'مرسل فقط', 'staff']]) {
  DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at, must_change_password) VALUES (?,?,?,?,?,1,?,0)').run(id, un, n, H, r, T0);
}
DB.db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('3','notifications.whatsapp.send',1,'1',?)").run(T0);
const env = { DB, OWNER_USER_ID: '1', ALLOWED_ORIGIN: 'http://127.0.0.1' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let origin = '';
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      const request = new Request(origin + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks).toString('utf8') });
      try { const r = await worker.fetch(request, env); res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer())); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message) })); }
      return;
    }
    if (u.pathname === '/config.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(`window.APP_CONFIG = { apiUrl: ${JSON.stringify(origin)} };`); return; }
    if (u.pathname === '/sw.js') { res.writeHead(404); res.end(); return; }
    let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = 'http://127.0.0.1:' + server.address().port;
env.ALLOWED_ORIGIN = origin;

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي اختبار الواجهة'); server.close(); process.exit(fail ? 1 : 2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
routeDownloads(browser);
const pageErrors = [];

async function loginPage(username, vp = { width: 1280, height: 900 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(username + ': ' + String(e.message).split('\n')[0]));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.setViewport(vp);
  await page.evaluateOnNewDocument(() => {
    // اعتراض فتح واتساب: يُسجَّل الرابط ولا يُفتح شيء. __block=true يحاكي مانع النوافذ المنبثقة
    window.__opened = []; window.__block = false;
    window.open = (u, t) => { window.__opened.push(String(u)); return window.__block ? null : { opener: window, closed: false }; };
    try { localStorage.setItem('majlis_tour_seen', '1'); } catch (_) { /* */ }
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loginUser', { visible: true });
  await page.type('#loginUser', username);
  await page.type('#loginPass', PW);
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => { const a = document.getElementById('app'); return a && !a.hidden; }, { timeout: 30000 });
  await sleep(3200);
  await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); document.querySelectorAll('.tour, .spot-tour, [class*="tour-"]').forEach((el) => el.remove()); });
  return { page, ctx };
}
const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); }, sel);
const txt = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const vis = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getClientRects().length > 0; }, sel);
const setVal = (page, sel, v) => page.evaluate((s, val) => { const el = document.querySelector(s); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, sel, v);
const modalOpen = (page) => page.evaluate(() => !document.getElementById('modal').hidden);
const waitModalClosed = (page) => page.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 10000 });
const noHScroll = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll('#page-whatsapp *, #modal *')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > w + 1 && !el.closest('.table-wrap, .wa-rc-list, .wa-run-list, pre'));
  return { sw: document.documentElement.scrollWidth, w, over: over.slice(0, 5).map((e) => e.tagName + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().right)) };
});

/* ---------------- 1) المالك على الكمبيوتر ---------------- */
const { page: P } = await loginPage('owner');
ok(await vis(P, '#mainNav [data-page="whatsapp"]'), 'nav: زر «إشعارات واتساب» ظاهر للمالك');
await click(P, '#mainNav [data-page="whatsapp"]');
await P.waitForSelector('#page-whatsapp.active');
await P.waitForFunction(() => /المستلمون النشطون/.test(document.getElementById('waPanelSend').textContent), { timeout: 10000 });
ok(/لا يوجد مستلمون بعد/.test(await txt(P, '#waPanelSend')), 'send-tab: رسالة إرشاد عند عدم وجود مستلمين');
ok((await P.evaluate(() => [...document.querySelectorAll('#waTabs [data-watab]')].filter((b) => !b.hidden).length)) === 4, 'tabs: الأقسام الأربعة ظاهرة للمالك');

// المستلمون
await click(P, '#waTabs [data-watab="recipients"]');
await P.waitForSelector('#waAddR', { visible: true });
ok(/0 \/ 20/.test(await txt(P, '#waRcCount')), 'recipients: العدّاد 0 / 20');
async function addRecipient(name, phone, events) {
  await click(P, '#waAddR');
  await P.waitForSelector('#waRName', { visible: true });
  await setVal(P, '#waRName', name);
  await setVal(P, '#waRPhone', phone);
  await P.evaluate((evs) => document.querySelectorAll('[data-waev]').forEach((c) => { c.checked = evs.includes(c.dataset.waev); }), events);
  await click(P, '#waRSave');
}
await addRecipient('أبو فهد — المدير', '0501234567', ['order_created', 'payment_received', 'expense_created', 'order_status']);
await waitModalClosed(P);
await P.waitForFunction(() => /1 \/ 20/.test(document.getElementById('waRcCount').textContent));
await addRecipient('المحاسب', '+966 55 765 4321', ['payment_received', 'expense_created']);
await waitModalClosed(P);
await addRecipient('Dubai office', '+971 50 111 2222', ['order_status']);
await waitModalClosed(P);
await P.waitForFunction(() => /3 \/ 20/.test(document.getElementById('waRcCount').textContent));
ok(true, 'recipients: إضافة 3 مستلمين من الشاشة — العدّاد 3 / 20');
await shot(P, 'desktop-recipients');
ok(/\+966 50 123 4567/.test(await txt(P, '#waRcTable')) && /\+971501112222/.test(await txt(P, '#waRcTable')), 'recipients: الأرقام بصيغة دولية (السعودي المحلي ← +966)');
// تكرار ورقم خاطئ
await click(P, '#waAddR'); await P.waitForSelector('#waRName', { visible: true });
await setVal(P, '#waRName', 'مكرر'); await setVal(P, '#waRPhone', '+966501234567');
await click(P, '#waRSave'); await sleep(300);
ok(/مسجّل مسبقاً/.test(await txt(P, '#waRErr')) && await modalOpen(P), 'recipients: الشاشة تمنع الرقم المكرر برسالة واضحة');
await setVal(P, '#waRPhone', '0112345678'); await sleep(100);
ok(/رمز الدولة/.test(await txt(P, '#waRPrev')), 'recipients: معاينة فورية لخطأ صيغة الرقم');
await setVal(P, '#waRPhone', '٠٥٥٠٠٠٠٠٠٠'); await sleep(100);
ok(/\+966 55 000 0000/.test(await txt(P, '#waRPrev')), 'recipients: الأرقام العربية تُحوَّل وتُعرض «سيُحفظ: +966 55 000 0000»');
await click(P, '#waRCancel'); await waitModalClosed(P);
// تعديل الاسم وتعطيل/تفعيل
const idOf = (name) => P.evaluate((n) => { const tr = [...document.querySelectorAll('#waRcTable tbody tr')].find((r) => r.textContent.includes(n)); return tr && tr.querySelector('[data-waedit]').dataset.waedit; }, name);
const accId = await idOf('المحاسب');
await click(P, `[data-waedit="${accId}"]`); await P.waitForSelector('#waRName', { visible: true });
await setVal(P, '#waRName', 'المحاسب الرئيسي'); await click(P, '#waRSave'); await waitModalClosed(P);
await P.waitForFunction(() => /المحاسب الرئيسي/.test(document.getElementById('waRcTable').textContent));
ok(true, 'recipients: تعديل اسم المستلم');
const dubId = await idOf('Dubai office');
await click(P, `[data-waactive="${dubId}"]`);
await P.waitForFunction((id) => !document.querySelector(`[data-waactive="${id}"]`).checked, {}, dubId);
ok(DB.db.prepare('SELECT active FROM wa_recipients WHERE id = ?').get(dubId).active === 0, 'recipients: تعطيل مستلم من الشاشة يُحفظ في الخادم');
await click(P, `[data-waactive="${dubId}"]`);
await P.waitForFunction((id) => document.querySelector(`[data-waactive="${id}"]`).checked, {}, dubId);

// القوالب: تعديل نص «مصروف» والمعاينة
await click(P, '#waTabs [data-watab="templates"]');
await P.waitForSelector('[data-watpl="expense_created"] [data-watbody]', { visible: true });
await P.evaluate(() => { const c = document.querySelector('[data-watpl="expense_created"]'); const ta = c.querySelector('[data-watbody]'); ta.value = '🧾 مصروف جديد – أصالة نجد\nالبيان: {description}\nالمبلغ: {amount}\nالموظف: {employee}\nالتاريخ: {date}'; ta.dispatchEvent(new Event('input')); });
ok(/مصروف جديد/.test(await txt(P, '[data-watpl="expense_created"] [data-waprev]')), 'templates: المعاينة تتحدث فور الكتابة');
const recChecks = await P.evaluate(() => [...document.querySelectorAll('[data-watpl="expense_created"] [data-wartpl]')].filter((c) => c.checked).length);
ok(recChecks === 2, 'templates: مستلمو «المصروف» المحددون = المدير والمحاسب', recChecks);
await click(P, '[data-watpl="expense_created"] [data-wasave]');
await P.waitForFunction(() => /معدّل/.test((document.querySelector('[data-watpl="expense_created"]') || {}).textContent || ''), { timeout: 10000 });
ok(DB.db.prepare("SELECT body FROM wa_templates WHERE event_type = 'expense_created'").get().body.startsWith('🧾 مصروف جديد'), 'templates: حفظ القالب في الخادم');
await shot(P, 'desktop-templates');

// حدث حقيقي: حفظ مصروف من شاشة المصروفات
await P.evaluate(() => document.querySelector('[data-page="expenses"]').click());
await P.waitForSelector('#btnAddExpense', { visible: true });
await click(P, '#btnAddExpense'); await P.waitForSelector('#exName', { visible: true });
await setVal(P, '#exName', 'نقل وتركيب — حي الملقا'); await setVal(P, '#exAmount', '350'); await setVal(P, '#exCat', 'نقل');
ok(!(await P.evaluate(() => { const n = document.getElementById('waNudge'); return n && !n.hidden; })), 'nudge: لا تنبيه قبل الحفظ');
await click(P, '#exSave');
await P.waitForFunction(() => { const n = document.getElementById('waNudge'); return n && !n.hidden; }, { timeout: 10000 });
ok(/تنبيه واتساب جاهز/.test(await txt(P, '#waNudge')) && /تسجيل مصروف/.test(await txt(P, '#waNudge')), 'nudge: بعد نجاح حفظ المصروف يظهر «تنبيه واتساب جاهز — تسجيل مصروف»');
ok(DB.db.prepare("SELECT COUNT(*) n FROM wa_events WHERE type = 'expense_created'").get().n === 1, 'event: تنبيه واحد في الخادم للمصروف المحفوظ');
ok((await P.evaluate(() => window.__opened.length)) === 0, 'popup: لا تُفتح أي محادثة تلقائياً');
await shot(P, 'desktop-nudge');
await click(P, '#waNudgeGo');
await P.waitForSelector('#waCMsg', { visible: true });
const composed = await P.evaluate(() => document.getElementById('waCMsg').value);
ok(/البيان: نقل وتركيب — حي الملقا/.test(composed) && /350\.00 ر\.س/.test(composed) && /الموظف: المالك/.test(composed), 'composer: الرسالة معبّأة من المصروف المحفوظ وبالقالب المعدّل', composed);
ok(/المحدد: 2 من 3/.test(await txt(P, '#waCCount')), 'composer: المستلمون المحددون مسبقاً لهذا الحدث (2 من 3)', await txt(P, '#waCCount'));
await shot(P, 'desktop-composer');
await click(P, '#waCNone');
ok(/المحدد: 0 من 3/.test(await txt(P, '#waCCount')) && await P.evaluate(() => document.getElementById('waCStart').disabled), 'composer: إلغاء التحديد يعطّل «بدء الإرسال»');
await click(P, '#waCAll');
ok(/المحدد: 3 من 3/.test(await txt(P, '#waCCount')), 'composer: تحديد الكل');
// تعديل الرسالة قبل الإرسال (عربي طويل ورموز)
const LONG = composed + '\n\nملاحظة: «يرجى التأكد» & المراجعة؟ #عاجل ✅ ' + 'تفاصيل إضافية '.repeat(40);
await setVal(P, '#waCMsg', LONG);
ok(new RegExp(LONG.length + ' / 2000').test(await txt(P, '#waCLen')), 'composer: عدّاد الأحرف');
await click(P, '#waCStart');
await P.waitForSelector('#waProgTxt', { visible: true });
ok(/المستلم 1 من 3/.test(await txt(P, '#waProgTxt')), 'runner: «المستلم 1 من 3»');
ok((await P.evaluate(() => window.__opened.length)) === 0, 'runner: لا فتح قبل ضغط المستخدم');
ok(!(await vis(P, '#waRConfirm')), 'runner: لا زر «أرسلتُها» قبل فتح المحادثة');
await click(P, '#waROpen');
await P.waitForSelector('#waRConfirm', { visible: true });
const op = await P.evaluate(() => window.__opened.slice());
const u1 = new URL(op[0]);
ok(op.length === 1 && u1.hostname === 'wa.me' && u1.pathname === '/966501234567', 'runner: ضغطة واحدة = محادثة واحدة للمستلم الأول (wa.me/966501234567)', op.map((x) => x.slice(0, 40)));
ok(u1.searchParams.get('text') === LONG.trim(), 'encoding: نص الرابط المفتوح = الرسالة المعدّلة حرفياً (عربي طويل ورموز وأسطر؛ بلا مسافات طرفية)', [u1.searchParams.get('text').length, LONG.trim().length]);
ok(/تم فتح واتساب/.test(await txt(P, '.wa-cur')), 'runner: الحالة «تم فتح واتساب»');
await shot(P, 'desktop-runner');
await click(P, '#waRConfirm');
await P.waitForFunction(() => /المستلم 2 من 3/.test(document.getElementById('waProgTxt').textContent));
ok(true, 'runner: بعد التأكيد اليدوي ← «المستلم 2 من 3»');
await click(P, '#waRSkip');
await P.waitForFunction(() => /المستلم 3 من 3/.test(document.getElementById('waProgTxt').textContent));
ok(true, 'runner: التخطي ← «المستلم 3 من 3»');
await P.evaluate(() => { window.__block = true; });
await click(P, '#waROpen');
await P.waitForFunction(() => /اكتمل|منع المتصفح/.test(document.getElementById('waRun').textContent), { timeout: 10000 });
const st3 = DB.db.prepare("SELECT status FROM wa_log ORDER BY seq").all().map((r) => r.status);
ok(st3.join() === 'confirmed,skipped,failed', 'runner: منع النافذة المنبثقة ← «فشل فتح الرابط» (لا ادعاء فتح)', st3);
ok(/اكتمل: عولج 3 من 3/.test(await txt(P, '#waProgTxt')) && /أكدتَ الإرسال لـ 1/.test(await txt(P, '#waRun')), 'runner: ملخص نهاية الجلسة');
await P.evaluate(() => { window.__block = false; });
await click(P, '#waRClose'); await waitModalClosed(P);
ok(DB.db.prepare("SELECT status FROM wa_events WHERE type='expense_created'").get().status === 'done', 'event: التنبيه صار «تمت معالجته» بعد اكتمال الجلسة');

// الإيقاف المؤقت والاستئناف (تغيير حالة طلب عبر المزامنة الحقيقية)
const tokOwner = await P.evaluate(() => Store.token);
const sync = async (o) => (await fetch(origin + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': tokOwner }, body: JSON.stringify({ orders: { upsert: [o], delete: [] } }) })).json();
const o0 = { id: 'o-ui', status: 'new', customer: { name: 'سلطان' }, items: [], payments: [], total: 1200, subtotal: 1200, vatAmount: 0, paid: 0, remaining: 1200, createdAt: T0, updatedAt: T0 };
await sync(o0);
const saved = JSON.parse(DB.db.prepare("SELECT data FROM orders WHERE id='o-ui'").get().data);
await sync({ ...saved, status: 'progress', updatedAt: new Date().toISOString(), _base: saved.updatedAt });
const syncOk = DB.db.prepare("SELECT COUNT(*) n FROM wa_events WHERE order_id = 'o-ui'").get().n;
ok(syncOk === 2, 'event: طلب جديد + تغيير حالته عبر المزامنة الحقيقية = تنبيهان', syncOk);
await click(P, '#mainNav [data-page="whatsapp"]');
await P.waitForSelector('#page-whatsapp.active');
await click(P, '#waTabs [data-watab="send"]');
await P.waitForFunction(() => document.querySelectorAll('#waPanelSend [data-wasend]').length >= 2, { timeout: 10000 });
ok(/تغيير حالة طلب/.test(await txt(P, '#waPanelSend')) && /جديد ← قيد التنفيذ/.test(await txt(P, '#waPanelSend')), 'send-tab: تنبيه تغيير الحالة الحقيقي ظاهر بالحالتين');
ok((await P.evaluate(() => document.getElementById('waBadge').textContent)) === '2' && await vis(P, '#waBadge'), 'badge: شارة القائمة بعدد التنبيهات المعلّقة (طلب جديد + تغيير حالة = 2)', await txt(P, '#waBadge'));
await P.evaluate(() => [...document.querySelectorAll('#waPanelSend .wa-row')].find((r) => /تغيير حالة طلب/.test(r.textContent)).querySelector('[data-wasend]').click());
await P.waitForSelector('#waCMsg', { visible: true });
ok(/الحالة السابقة: جديد/.test(await P.evaluate(() => document.getElementById('waCMsg').value)) && /المحدد: 2 من 3/.test(await txt(P, '#waCCount')), 'composer: تغيير الحالة بمستلميه المحددين (المدير ودبي)');
await click(P, '#waCStart');
await P.waitForSelector('#waROpen', { visible: true });
await click(P, '#waROpen'); await P.waitForSelector('#waRConfirm', { visible: true });
await click(P, '#waRPause'); await waitModalClosed(P);
await P.waitForFunction(() => /جلسات إرسال لم تكتمل/.test(document.getElementById('waPanelSend').textContent), { timeout: 10000 });
ok(/موقوفة مؤقتاً/.test(await txt(P, '#waPanelSend')) && /عولج 0 من 2/.test(await txt(P, '#waPanelSend')), 'pause: الجلسة الموقوفة ظاهرة «عولج 0 من 2»');
await click(P, '[data-waresume]');
await P.waitForSelector('#waProgTxt', { visible: true });
ok(/المستلم 1 من 2/.test(await txt(P, '#waProgTxt')) && await vis(P, '#waRConfirm'), 'resume: الاستئناف من حيث توقف (المستلم 1 مفتوح بانتظار التأكيد)');
await click(P, '#waRConfirm');
await P.waitForFunction(() => /المستلم 2 من 2/.test(document.getElementById('waProgTxt').textContent));
await click(P, '#waRSkip');
await P.waitForFunction(() => /اكتمل/.test(document.getElementById('waProgTxt').textContent));
ok(true, 'resume: إكمال الجلسة بعد الاستئناف');
await click(P, '#waRClose'); await waitModalClosed(P);

// السجل
await click(P, '#waTabs [data-watab="log"]');
await P.waitForSelector('#waLogTable', { visible: true });
await shot(P, 'desktop-log');
const logTxt = await txt(P, '#waLogTable');
ok(/أكد المستخدم الإرسال يدويًا/.test(logTxt) && /تم التخطي/.test(logTxt) && /فشل فتح الرابط/.test(logTxt), 'log: الحالات الدقيقة ظاهرة');
ok(!/تم التسليم|تم الإرسال بنجاح|وصلت|delivered/i.test(logTxt) && /لا يرسل أي تأكيد/.test(await txt(P, '#waPanelLog')), 'log: لا ادعاء بوصول الرسالة، مع توضيح صريح');
ok((await P.evaluate(() => document.querySelectorAll('#waLogTable tbody tr').length)) === 5, 'log: 5 أسطر (3 + 2)');
ok(/تسجيل مصروف/.test(logTxt) && /تغيير حالة طلب/.test(logTxt) && /#\d+/.test(logTxt), 'log: نوع التنبيه ورقم الطلب المرتبط');

/* ---------------- 2) الجوال 375px ---------------- */
const { page: M } = await loginPage('owner', { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await M.evaluate(() => document.querySelector('#mainNav [data-page="whatsapp"]').click());
await M.waitForSelector('#page-whatsapp.active');
await M.waitForFunction(() => /المستلمون النشطون/.test(document.getElementById('waPanelSend').textContent), { timeout: 10000 });
for (const t of ['send', 'recipients', 'templates', 'log']) {
  await M.evaluate((x) => document.querySelector(`#waTabs [data-watab="${x}"]`).click(), t);
  await sleep(250);
  const h = await noHScroll(M);
  ok(h.sw <= h.w + 1 && !h.over.length, `mobile: تبويب ${t} بلا تمرير أفقي عند 375px`, h);
  await shot(M, 'mobile-' + t);
}
await M.evaluate(() => document.querySelector('#waTabs [data-watab="send"]').click());
await M.evaluate(() => document.getElementById('waNewSend').click());
await M.waitForSelector('#waCMsg', { visible: true });
await M.evaluate(() => { const c = [...document.querySelectorAll('[data-wactype]')].find((x) => x.dataset.wactype === 'order_created'); c.click(); });
await sleep(200);
let h = await noHScroll(M);
ok(h.sw <= h.w + 1 && !h.over.length, 'mobile: نافذة تجهيز الرسالة بلا تمرير أفقي', h);
await M.evaluate(() => document.getElementById('waCAll').click());
await M.evaluate(() => document.getElementById('waCStart').click());
await M.waitForSelector('#waROpen', { visible: true });
h = await noHScroll(M);
const btnBox = await M.evaluate(() => { const b = document.getElementById('waROpen').getBoundingClientRect(); return { w: b.width, h: b.height, r: b.right, vw: innerWidth }; });
ok(h.sw <= h.w + 1 && btnBox.h >= 36 && btnBox.r <= btnBox.vw, 'mobile: مشغّل الإرسال بأزرار واضحة داخل الشاشة', { h, btnBox });
// ضغط مزدوج سريع (شائع على اللمس): محادثة واحدة فقط
await M.evaluate(() => { const b = document.getElementById('waROpen'); b.click(); b.click(); });
await M.waitForSelector('#waRConfirm', { visible: true });
await sleep(300);
ok((await M.evaluate(() => window.__opened.length)) === 1, 'mobile: ضغط مزدوج سريع يفتح محادثة واحدة فقط');
await shot(M, 'mobile-runner');
// العودة من واتساب: التطبيق يعود للواجهة ← الحالة تُقرأ من الخادم ويبقى المستلم الحالي
const reqs = [];
M.on('request', (r) => { if (/\/api\/wa\/sends\//.test(r.url()) && r.method() === 'GET') reqs.push(r.url()); });
const before = await txt(M, '#waProgTxt');
await M.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await sleep(800);
ok(reqs.length === 1 && (await txt(M, '#waProgTxt')) === before && /المستلم 1 من/.test(before) && await vis(M, '#waRConfirm'),
  'android-flow: العودة للتطبيق تحدّث الجلسة من الخادم وتبقي «المستلم 1» وزر التأكيد', { reqs: reqs.length, before });
ok((await M.evaluate(() => window.__opened.length)) === 1, 'android-flow: العودة لا تفتح أي محادثة إضافية');
await M.evaluate(() => document.getElementById('waRPause').click());
await M.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 10000 });
// التطبيق أُغلق كلياً ثم فُتح من جديد: الجلسة محفوظة في الخادم وتُعرض للاستئناف بعد الدخول
const { page: M2 } = await loginPage('owner', { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await M2.waitForFunction(() => { const n = document.getElementById('waNudge'); return n && !n.hidden && /جلسة إرسال لم تكتمل/.test(n.textContent); }, { timeout: 10000 }).catch(() => {});
ok(await M2.evaluate(() => { const n = document.getElementById('waNudge'); return !!n && !n.hidden && /جلسة إرسال لم تكتمل/.test(n.textContent); }), 'android-flow: بعد إعادة فتح التطبيق تظهر «جلسة إرسال لم تكتمل»');
await M2.evaluate(() => document.getElementById('waNudgeGo').click());
await M2.waitForSelector('#waProgTxt', { visible: true });
ok(/المستلم 1 من/.test(await txt(M2, '#waProgTxt')) && await vis(M2, '#waRConfirm') && (await M2.evaluate(() => window.__opened.length)) === 0,
  'android-flow: الاستئناف عند المستلم نفسه (مفتوح بانتظار التأكيد) دون فتح أي محادثة تلقائياً');
await M2.evaluate(() => document.getElementById('waRConfirm').click());
await M2.waitForFunction(() => /المستلم 2 من/.test(document.getElementById('waProgTxt').textContent), { timeout: 10000 });
ok((await M2.evaluate(() => window.__opened.length)) === 0, 'android-flow: الانتقال للمستلم التالي لا يفتح محادثته قبل ضغطة المستخدم');

// الرابط البديل عند منع النافذة: ضغط مزدوج = تسجيل «فتح» واحد فقط
{
  const logPosts = [];
  P.on('request', (r) => { if (/\/api\/wa\/log\//.test(r.url()) && r.method() === 'POST') logPosts.push(r.postData()); });
  // لا اتصال بالإنترنت من الاختبار: يُمنع انتقال الرابط نفسه، ومعالج الواجهة يعمل كما هو
  await P.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#waRDirect')) e.preventDefault(); }, true));
  await click(P, '#waNewSend'); await P.waitForSelector('#waCMsg', { visible: true });
  await click(P, '#waCAll'); await click(P, '#waCStart');
  await P.waitForSelector('#waROpen', { visible: true });
  await P.evaluate(() => { window.__block = true; });
  logPosts.length = 0;
  await click(P, '#waROpen');
  await P.waitForSelector('#waRDirect', { visible: true });
  ok(logPosts.length === 1 && /failed/.test(logPosts[0]), 'fallback: منع النافذة ← «فشل فتح الرابط» ويظهر الرابط المباشر', logPosts);
  logPosts.length = 0;
  await P.evaluate(() => { const a = document.getElementById('waRDirect'); a.click(); a.click(); a.click(); });
  await sleep(900);
  ok(logPosts.length === 1 && /opened/.test(logPosts[0]), 'fallback: ضغط ثلاثي سريع على الرابط البديل ← تسجيل «فتح» واحد فقط', logPosts);
  await P.evaluate(() => { window.__block = false; });
  // 409: الحالة تغيّرت خارج هذه النافذة ← الواجهة تقرأها من الخادم ولا تبقى على نسخة قديمة
  await P.waitForSelector('#waRConfirm', { visible: true });
  const sendId = DB.db.prepare("SELECT id FROM wa_sends ORDER BY created_at DESC LIMIT 1").get().id;
  const firstId = DB.db.prepare('SELECT id FROM wa_log WHERE send_id = ? AND seq = 1').get(sendId).id;
  await fetch(origin + '/api/wa/log/' + firstId, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': tokOwner }, body: JSON.stringify({ status: 'skipped' }) });
  await click(P, '#waRConfirm');
  await P.waitForFunction(() => /تم التخطي/.test(document.querySelector('.wa-run-list li').textContent), { timeout: 10000 }).catch(() => {});
  ok(/تم التخطي/.test(await txt(P, '.wa-run-list li')) && DB.db.prepare('SELECT status FROM wa_log WHERE id = ?').get(firstId).status === 'skipped', 'conflict: تأكيد بعد تخطٍّ من مكان آخر ← 409 والواجهة تعرض الحالة الحقيقية «تم التخطي»');
  await P.evaluate(() => { const b = document.getElementById('waRPause'); if (b) b.click(); else document.getElementById('modalClose').click(); });
  await P.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 10000 });
}

/* ---------------- 3) الصلاحيات في الواجهة ---------------- */
const { page: S } = await loginPage('staff1');
ok(!(await vis(S, '#mainNav [data-page="whatsapp"]')), 'perm-ui: الموظف بلا صلاحية لا يرى «إشعارات واتساب»');
await S.evaluate(() => { const b = document.querySelector('#mainNav [data-page="whatsapp"]'); b.hidden = false; b.click(); });
ok(!(await S.evaluate(() => document.getElementById('page-whatsapp').classList.contains('active'))), 'perm-ui: فتح الصفحة قسراً يُعاد للطلب الحالي');
const st403 = await S.evaluate(async () => (await fetch('/api/wa', { headers: { 'x-session-token': Store.token } })).status);
ok(st403 === 403, 'perm-ui: الخادم يرفض الموظف حتى لو أُظهر الزر (403)');
const { page: SD } = await loginPage('sender1');
await SD.evaluate(() => document.querySelector('#mainNav [data-page="whatsapp"]').click());
await SD.waitForSelector('#page-whatsapp.active');
await sleep(800);
const tabsSD = await SD.evaluate(() => [...document.querySelectorAll('#waTabs [data-watab]')].filter((b) => !b.hidden).map((b) => b.dataset.watab));
ok(tabsSD.join() === 'send' && await vis(SD, '#waNewSend'), 'perm-ui: صاحب «الإرسال» وحده يرى التنبيهات والإرسال فقط (لا المستلمين ولا القوالب ولا السجل)', tabsSD);
const r403 = await SD.evaluate(async () => (await fetch('/api/wa/recipients', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': Store.token }, body: JSON.stringify({ name: 'x', phone: '0509999999' }) })).status);
ok(r403 === 403, 'perm-ui: صاحب «الإرسال» لا يضيف مستلماً عبر الخادم (403)');
// الخصوصية في الواجهة: المُرسِل بلا رؤية الطلبات لا يرى تنبيهات طلبات المالك ولا عملاءها ولا مبالغها
const sdTxt = await SD.evaluate(() => document.getElementById('page-whatsapp').textContent);
ok(/لا توجد تنبيهات بانتظار الإرسال/.test(sdTxt) && !/سلطان|1,200|نقل وتركيب|350\.00/.test(sdTxt), 'privacy-ui: المُرسِل وحده لا يرى أي تنبيه أو اسم عميل أو مبلغ لطلبات غيره');
await SD.evaluate(() => document.getElementById('waNewSend').click());
await SD.waitForSelector('#waCMsg', { visible: true });
const sdMsg = await SD.evaluate(() => ({ v: document.getElementById('waCMsg').value, ev: [...document.querySelectorAll('#waCEv option')].map((o) => o.value) }));
ok(sdMsg.ev.join() === '' && !/سلطان|1,200|350\.00/.test(sdMsg.v) && /\{order_number\}/.test(sdMsg.v), 'privacy-ui: نافذة التجهيز بلا أحداث — القالب بمتغيراته فقط بلا بيانات', sdMsg);

/* ---------------- 4) إصلاحات اختبار أندرويد: التحقق قبل الفتح · رسالة الرفض وإغلاق النافذة · بطاقة الاستئناف ---------------- */
{
  const grantSend = (v) => DB.db.prepare("INSERT OR REPLACE INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('3','notifications.whatsapp.send',?,'1',?)").run(v, T0);
  const startFree = async (pg) => {
    await pg.evaluate(() => document.getElementById('waNewSend').click());
    await pg.waitForSelector('#waCMsg', { visible: true });
    await pg.evaluate(() => { document.getElementById('waCAll').click(); document.getElementById('waCStart').click(); });
    await pg.waitForSelector('#waROpen', { visible: true });
  };
  // أ) أندرويد (window.Capacitor): التحقق من الخادم أولاً ثم فتح محادثة واحدة — والضغط المزدوج يبقى فتحاً واحداً
  const reqs = [];
  SD.on('request', (r) => { if (/\/api\/wa\/(sends\/|log\/)/.test(r.url())) reqs.push(r.method() + ' ' + new URL(r.url()).pathname.replace(/[^/]+$/, ':id')); });
  await SD.evaluate(() => { window.Capacitor = {}; window.__opened = []; });
  await startFree(SD);
  reqs.length = 0;
  await SD.evaluate(() => { const b = document.getElementById('waROpen'); b.click(); b.click(); });
  await SD.waitForSelector('#waRConfirm', { visible: true });
  await sleep(400);
  const opened = await SD.evaluate(() => window.__opened.slice());
  ok(reqs[0] === 'GET /api/wa/sends/:id' && reqs[1] === 'POST /api/wa/log/:id' && reqs.length === 2 && opened.length === 1, 'android-fix: في التطبيق يُتحقق من الجلسة في الخادم قبل الفتح، ثم محادثة واحدة رغم الضغط المزدوج', { reqs, opened: opened.length });
  // ب) سُحبت صلاحية الإرسال والنافذة مفتوحة ← «فتح واتساب» لا يفتح شيئاً، والنافذة تُغلق برسالة الخادم
  grantSend(0);
  await SD.evaluate(() => { window.__opened = []; });
  await SD.evaluate(() => document.getElementById('waROpen').click());
  await SD.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 10000 }).catch(() => {});
  const t1 = await SD.evaluate(() => ({ opened: window.__opened.length, modalClosed: document.getElementById('modal').hidden, toast: document.getElementById('toast').innerText }));
  ok(t1.opened === 0 && t1.modalClosed && /غير مصرح/.test(t1.toast), 'android-fix: بعد سحب الصلاحية لا تُفتح واتساب إطلاقاً، وتُغلق النافذة برسالة الخادم الواضحة', t1);
  grantSend(1);
  // ج) المتصفح: سحب الصلاحية ثم «تخطي» ← رسالة الخادم (لا «تعذّر حفظ الحالة») وإغلاق النافذة
  await SD.evaluate(() => { delete window.Capacitor; });
  await startFree(SD);
  grantSend(0);
  await SD.evaluate(() => document.getElementById('waRSkip').click());
  await SD.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 10000 }).catch(() => {});
  const t2 = await SD.evaluate(() => ({ modalClosed: document.getElementById('modal').hidden, toast: document.getElementById('toast').innerText, runner: !!document.getElementById('waRun') }));
  ok(t2.modalClosed && !t2.runner && /غير مصرح/.test(t2.toast) && !/تعذّر حفظ الحالة/.test(t2.toast), 'ui-fix: رفض الخادم (403) يعرض رسالته ويغلق النافذة فلا تبقى بيانات الجلسة معروضة', t2);
  grantSend(1);
  // د) العودة للتطبيق بعد سحب الصلاحية ← تُغلق النافذة فوراً
  await startFree(SD);
  grantSend(0);
  await SD.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await SD.waitForFunction(() => document.getElementById('modal').hidden, { timeout: 10000 }).catch(() => {});
  ok(await SD.evaluate(() => document.getElementById('modal').hidden), 'ui-fix: العودة للتطبيق بعد سحب الصلاحية تغلق نافذة الإرسال فوراً');
  grantSend(1);
  // هـ) بطاقة الاستئناف تبقى بعد 15 ثانية حتى يختار المستخدم
  const { page: R } = await loginPage('owner');
  await R.waitForFunction(() => { const n = document.getElementById('waNudge'); return n && !n.hidden && /جلسة إرسال لم تكتمل/.test(n.textContent); }, { timeout: 15000 }).catch(() => {});
  const shown = await R.evaluate(() => { const n = document.getElementById('waNudge'); return !!n && !n.hidden && /جلسة إرسال لم تكتمل/.test(n.textContent); });
  await sleep(16500);
  const still = await R.evaluate(() => { const n = document.getElementById('waNudge'); return !!n && !n.hidden && /جلسة إرسال لم تكتمل/.test(n.textContent); });
  ok(shown && still, 'resume-fix: بطاقة «جلسة إرسال لم تكتمل» ما زالت ظاهرة بعد 16 ثانية', { shown, still });
  await R.evaluate(() => document.getElementById('waNudgeX').click());
  ok(await R.evaluate(() => document.getElementById('waNudge').hidden), 'resume-fix: «لاحقاً» يخفيها');
}

ok(!pageErrors.length, 'js: لا أخطاء JavaScript في الصفحات', pageErrors);

await browser.close();
server.close();
console.log(`\n=== whatsapp-ui-e2e: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
