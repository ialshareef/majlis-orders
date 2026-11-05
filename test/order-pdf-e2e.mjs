/* ملف PDF للطلب (أمر الشراء / أمر التصنيع / السند) = صفحة واحدة دائماً، واضحة وحادة.
   الخادم الحقيقي على D1 وهمية + index.html في Chrome headless، ثم تصدير فعلي من
   نافذة «تصدير ومشاركة» والتقاط ملف PDF الناتج، والتحقق من:
     1) صفحة واحدة بالضبط، ومقاسها (MediaBox) = المقاس المختار، و@page للطباعة نفسه
     2) لا تصغير خطوط: أصغر خط في المستند ≥ 7.5pt، وخط الجدول 10pt مهما كثرت الأصناف
     3) لا عنصر خارج الصفحة ولا صندوق يقصّ محتواه
     4) كل الأصناف والملاحظات واسم العميل والعنوان موجودة كاملة (بلا «…» ولا قصّ)
     5) دقة صورة الصفحة ≥ 250 نقطة/بوصة (حادة عند التكبير)
     6) الطلب البسيط على A4، والطلب الكثيف على مقاس أكبر (لا يُضغط)
   يحتاج اتصالاً بالإنترنت لمكتبات PDF (cdnjs) كما في التطبيق نفسه.
   الاستخدام: node test/order-pdf-e2e.mjs [--save <مجلد>]                                  */
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
const past = new Date(Date.now() - 86400000 * 30).toISOString();
const at = new Date(Date.now() - 86400000).toISOString();
const WALLS = [{ len: 6, angle: 0 }, { len: 4.5, angle: 90 }, { len: 6, angle: 180 }, { len: 4.5, angle: 270 }];
const sofa = (i, wall, t, w) => ({ id: 's' + i, kind: 'sofa', wall, t, w, h: 0.8, rot: 0, x: 0, y: 0, seating: ['floor', 'sofa', 'arabic'][i % 3] });
const acc = (i, itemId) => ({ id: 'a' + i, kind: 'acc', itemId, w: 0.5, h: 0.5, rot: 0, x: 1 + (i % 4) * 0.8, y: 1.5 + Math.floor(i / 4) * 0.7 });
const LONG = 'يرجى التواصل قبل التركيب بيومين، والمدخل ضيق من جهة الدرج الخلفي، ويوجد مصعد للبضائع فقط. '
  + 'Please call the site manager (Eng. Khalid) before delivery — gate code 4471. ';
function orderRow(id, number, d) {
  const data = Object.assign({ id, number, status: 'new', createdBy: '1', createdByName: 'المالك', createdAt: at, updatedAt: at,
    customer: { name: 'عميل', phone: '0550000000', address: '' }, design: { walls: WALLS, pieces: [], openings: [], cornerMode: 'deduct' },
    manualRows: [], payments: [], vat: { enabled: true, rate: 15 }, discount: 0, notes: '', attachments: [] }, d);
  return { id, number, status: data.status, customer_name: data.customer.name, created_by: '1', created_at: at, updated_at: at, data: JSON.stringify(data) };
}
const ITEMS = [
  { id: 'i1', name: 'طاولة بلوت', category: 'acc', unit: 'pc', price: 350, w: 0.9, h: 0.6, shape: 'rect', color: '#6d4c41', active: true },
  { id: 'i2', name: 'مركى', category: 'acc', unit: 'pc', price: 80, w: 0.6, h: 0.35, shape: 'rect', color: '#c0392b', active: true },
  { id: 'i3', name: 'طاولة تقديم خشب جوز طبيعي بحواف نحاسية (Walnut Serving Table)', category: 'acc', unit: 'pc', price: 1250, w: 0.5, h: 0.5, shape: 'circle', color: '#7f8c8d', active: true },
];
const heavyRows = Array.from({ length: 26 }, (_, i) => ({ name: (i % 2 ? 'تفصيل ستارة مزدوجة بقماش مخمل تركي مع بطانة عازلة للحرارة — ' : 'Custom LED cove lighting strip (warm white 3000K) — ') + 'بند ' + (i + 1), qty: (i % 4) + 1, unit: i % 2 ? 'متر' : 'قطعة', price: 135.5 + i * 17 }));
const orders = [
  orderRow('o-simple', 2001, {
    customer: { name: 'فهد سعود الدوسري', phone: '0549955622', address: 'الرياض — حي الملقا' },
    design: { walls: WALLS, cornerMode: 'deduct', openings: [{ id: 'd1', wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }], pieces: [sofa(1, 1, 2.2, 3), sofa(2, 2, 3, 4), acc(1, 'i1'), acc(2, 'i2')] },
    manualRows: [{ name: 'توصيل وتركيب', qty: 1, unit: 'خدمة', price: 250 }],
    payments: [{ id: 'p1', at: at.slice(0, 10), amount: 500, method: 'cash', note: 'عربون', by: 'المالك', createdAt: at }],
    notes: 'التسليم بعد أسبوعين.',
  }),
  orderRow('o-heavy', 2002, {
    customer: { name: 'عبدالرحمن بن عبدالعزيز بن محمد آل الشيخ القحطاني — Mohammed Al-Otaibi (VIP)', phone: '+966 54 995 5622', address: 'الرياض — حي الملقا، شارع الأمير محمد بن سعد، مجمع الواحة السكني، فيلا 14 (بجوار مسجد الإمام)' },
    design: { walls: WALLS, cornerMode: 'full', openings: [{ id: 'd1', wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }, { id: 'w1', wall: 2, t: 2, w: 1.4, h: 1.2, type: 'window' }],
      pieces: [sofa(1, 1, 2.2, 3.4), sofa(2, 3, 2.2, 3.4), sofa(3, 2, 3, 5.2)].concat(Array.from({ length: 9 }, (_, i) => acc(i, ['i1', 'i2', 'i3'][i % 3]))) },
    manualRows: heavyRows, discount: 300,
    payments: [{ id: 'p1', at: at.slice(0, 10), amount: 2500, method: 'transfer', note: 'دفعة أولى', by: 'المالك', createdAt: at }, { id: 'p2', at: at.slice(0, 10), amount: 1500, method: 'cash', note: '', by: 'المالك', createdAt: at }],
    notes: Array(5).join(LONG) + '\nملاحظة أخيرة: الألوان حسب العينة رقم 7.',
  }),
  orderRow('o-empty', 2003, { customer: { name: 'عميل بلا بيانات', phone: '', address: '' }, vat: { enabled: false, rate: 15 } }),
];
const SETTINGS = { shopName: 'أصالة نجد للمجالس العربية والديكور', phone: '0549955622', whatsapp: 'https://wa.me/966549955622', instagram: 'https://www.instagram.com/asalanajd_vip', mapsUrl: 'https://maps.app.goo.gl/QoVTZK6KtxLS1AEi8?g_st=ac', address: 'الرياض', vatNumber: '300000000000003', invoiceNote: 'الأسعار شاملة التركيب داخل الرياض. يُستلم الطلب خلال 21 يوم عمل من اعتماد التصميم.' };
const U = (id, username, name, role) => ({ id, username, name, role, active: 1, created_at: past, must_change_password: 0, password_hash: H });
const env = envWith({
  users: [U('1', 'owner', 'المالك', 'admin')], sessions: [], orders, counters: [{ key: 'order_no', value: 3000 }],
  settings: [{ id: 1, data: JSON.stringify(SETTINGS), updated_at: past }],
  items: ITEMS.map((it) => ({ id: it.id, data: JSON.stringify(it), updated_at: past })),
});
for (const t of ['customer_designs', 'permission_audit', 'activity', 'expenses', 'user_permissions']) env.DB.tables.set(t, []);
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
const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, protocolTimeout: 300000, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
routeDownloads(browser); // تنزيلات الاختبار إلى Documents/majlis-test-downloads لا مجلد التنزيلات
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e.message).split('\n')[0]));
await page.evaluateOnNewDocument(() => {
  try { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return /^mj_help_seen_/.test(k) ? '1' : g.call(this, k); }; } catch (_) { /* noop */ }
  window.__files = [];
  const F = window.File;
  window.File = function (parts, name, o) { const f = new F(parts, name, o); if (/\.pdf$/.test(name)) window.__files.push({ name, f }); return f; };
  window.File.prototype = F.prototype;
});
await page.setViewport({ width: 1366, height: 900 });
await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loginUser', { visible: true });
await page.type('#loginUser', 'owner'); await page.type('#loginPass', PW);
await page.click('#loginForm button[type=submit]');
await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
await sleep(2500);
await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });

/** فتح طلب برقمه ثم تصدير مستند منه، وقياس المستند والملف الناتج */
async function exportDoc(number, kind) {
  await page.evaluate(() => { window.__files = []; const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
  await page.evaluate(() => document.querySelector('#mainNav button[data-page="orders"]').click());
  await sleep(700);
  await page.evaluate((n) => { const r = [...document.querySelectorAll('#ordersTable tbody tr')].find((x) => x.textContent.includes('#' + n)); r.querySelector('[data-open]').click(); }, number);
  await page.waitForFunction((n) => (document.getElementById('orderTitle') || {}).textContent.includes(String(n)), { timeout: 30000 }, number);
  await sleep(800);
  if (kind === 'receipt') {
    await page.evaluate(() => document.querySelector('#stepNav a[data-stage="pay"]').click());
    await sleep(500);
    await page.evaluate(() => document.querySelector('[data-receipt]').click());
  } else {
    await page.evaluate((k) => document.querySelector(`[data-doc-kind="${k}"]`).click(), kind);
  }
  await page.waitForFunction(() => window.__files.length > 0 || /err/.test((document.getElementById('pdfState') || {}).className || ''), { timeout: 180000 });
  return page.evaluate(async () => {
    const st = document.getElementById('pdfState');
    const inv = document.querySelector('#printArea .inv');
    const area = document.getElementById('printArea');
    area.style.cssText = 'display:block;position:fixed;top:0;left:-20000px;background:#fff';
    const p = inv.__paper;
    const R = inv.getBoundingClientRect(), k = R.width / (p.w - 20);
    let minPt = 99, minEl = ''; const outside = [], clipped = [];
    inv.querySelectorAll('*').forEach((e) => {
      const r = e.getBoundingClientRect(); if (!r.width && !r.height) return;
      if (r.right > R.right + 1 || r.left < R.left - 1 || r.bottom > R.bottom + 1 || r.top < R.top - 1) outside.push(String(e.className || e.tagName));
      const cs = getComputedStyle(e);
      if (cs.overflow !== 'visible' && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) clipped.push(String(e.className || e.tagName));
      if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) clipped.push('ellipsis:' + (e.className || e.tagName));
      if ([...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) { const f = parseFloat(cs.fontSize) * 0.75; if (f < minPt) { minPt = f; minEl = (e.className || e.tagName) + ':' + e.textContent.trim().slice(0, 18); } }
    });
    /* تشخيص: ارتفاع كل قسم على عرض A4 (يُطبع عند الفشل) */
    const kw = inv.style.width, kh = inv.style.height;
    inv.style.width = '190mm'; inv.style.height = 'auto';
    const k4 = inv.getBoundingClientRect().width / 190;
    const a4parts = [...inv.children].map((c) => String(c.className || c.tagName).split(' ')[0] + '=' + (c.getBoundingClientRect().height / k4).toFixed(0)).join(' ') + ' | total=' + (inv.scrollHeight / k4).toFixed(0) + '/277';
    inv.style.width = kw; inv.style.height = kh;
    /* كل عنصر داخل صندوقه المرئي (بطاقات التواصل، التوقيعات، الإجماليات): لا يتجاوز حدوده فيتراكب مع جاره */
    const boxes = ['.inv-contact', '.inv-sign', '.inv-totals', '.inv-notes', '.inv-info > div', '.inv-dside', '.ds-areas-wrap'];
    boxes.forEach((sel) => inv.querySelectorAll(sel).forEach((bx) => {
      const B = bx.getBoundingClientRect();
      bx.querySelectorAll('*').forEach((e) => { const r = e.getBoundingClientRect(); if ((r.width || r.height) && (r.left < B.left - 1 || r.right > B.right + 1 || r.bottom > B.bottom + 1)) outside.push(sel + '>' + (e.className || e.tagName)); });
    }));
    /* بطاقة كل قناة: الأيقونة والاسم ورمز QR متجاورة بلا تراكب (الاسم كاملاً لا تحت الرمز) */
    inv.querySelectorAll('.inv-cfoot .inv-chan').forEach((ch) => {
      const parts = [...ch.children].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.getBoundingClientRect());
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], b = parts[j];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) clipped.push('chan-overlap:' + ch.textContent.trim());
      }
      const lb = ch.querySelector('.inv-chan-lb');
      if (lb && lb.scrollWidth > lb.getBoundingClientRect().width + 1) clipped.push('chan-label-cut:' + lb.textContent);
      const ic = ch.querySelector('.inv-chan-ic');
      if (!ic || getComputedStyle(ic).display === 'none' || !ic.querySelector('svg')) clipped.push('chan-no-icon:' + ch.textContent.trim());
    });
    const tbl = inv.querySelector('.inv-items table');
    const file = window.__files[0];
    const buf = file ? new Uint8Array(await file.f.arrayBuffer()) : new Uint8Array();
    let txt = ''; for (let i = 0; i < buf.length; i += 0x8000) txt += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const mb = /\/MediaBox \[([\d.\s]+)\]/.exec(txt);
    let imgW = 0; const re = /\/Width (\d+)/g; let m; while ((m = re.exec(txt))) imgW = Math.max(imgW, +m[1]);
    const out = {
      ok: !!file, name: file && file.name, state: st ? st.textContent.trim() : '', note: (document.getElementById('shNote') || {}).textContent || '',
      a4parts, paper: p, size: [+(R.width / k).toFixed(1), +(R.height / k).toFixed(1)],
      minPt: +minPt.toFixed(2), minEl, outside: outside.slice(0, 6), clipped: clipped.slice(0, 6),
      tableFs: tbl ? parseFloat(getComputedStyle(tbl).fontSize) * 0.75 : null,
      rows: inv.querySelectorAll('.inv-items tbody tr').length,
      text: inv.innerText,
      plan: (() => { const i = inv.querySelector('.inv-dplan .ds-img'); return i ? [+(i.getBoundingClientRect().width / k).toFixed(1), +(i.getBoundingClientRect().height / k).toFixed(1)] : null; })(),
      pages: (txt.match(/\/Type \/Page(?!s)/g) || []).length,
      media: mb ? mb[1].trim().split(/\s+/).slice(2).map((v) => +(v / 72 * 25.4).toFixed(1)) : null,
      imgW, printCss: (document.getElementById('printPageSize') || {}).textContent || '',
      b64: btoa(txt),
    };
    area.style.cssText = '';
    return out;
  });
}

function checkDoc(tag, r, expect = {}) {
  ok(r.ok, tag + ': نُشئ ملف PDF', r.state);
  if (!r.ok) return;
  ok(r.pages === 1, tag + ': صفحة واحدة بالضبط', r.pages);
  ok(r.media && Math.abs(r.media[0] - r.paper.w) < 1 && Math.abs(r.media[1] - r.paper.h) < 1, tag + ': مقاس صفحة PDF = المقاس المختار ' + r.paper.label, { media: r.media, paper: r.paper });
  ok(r.printCss.includes(`size: ${r.paper.w}mm ${r.paper.h}mm`), tag + ': الطباعة بالمقاس نفسه (@page)', r.printCss);
  ok(r.minPt >= 7.45, tag + ': أصغر خط ≥ 7.5pt (لا تصغير)', r.minPt + 'pt ' + r.minEl);
  if (r.tableFs) ok(Math.abs(r.tableFs - 10) < 0.1, tag + ': خط جدول الأصناف ثابت 10pt', r.tableFs);
  ok(r.outside.length === 0, tag + ': لا عنصر خارج الصفحة', r.outside);
  ok(r.clipped.length === 0, tag + ': لا صندوق يقصّ محتواه ولا «…»', r.clipped);
  const dpi = r.imgW / ((r.paper.w - 20) / 25.4);
  ok(dpi >= 250, tag + ': دقة الصفحة ≥ 250 نقطة/بوصة', Math.round(dpi) + 'dpi');
  if (expect.paper) ok(r.paper.id === expect.paper, tag + ': المقاس ' + expect.paper, r.paper.id + ' ' + r.a4parts);
  if (expect.bigger) ok(r.paper.id !== 'a4', tag + ': المحتوى الكثيف على مقاس أكبر من A4 لا مضغوطاً', r.paper.id);
  if (expect.rows != null) ok(r.rows === expect.rows, tag + ': كل الأصناف في الجدول (' + expect.rows + ')', r.rows);
  (expect.texts || []).forEach((s) => ok(r.text.replace(/\s+/g, ' ').includes(s.replace(/\s+/g, ' ')), tag + ': النص كاملاً: ' + s.slice(0, 40), s.slice(0, 60)));
  if (expect.plan) ok(r.plan && r.plan[0] >= 55 && r.plan[1] >= 40, tag + ': المخطط بحجم مقروء', r.plan);
  if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); fs.writeFileSync(path.join(saveDir, tag.replace(/[^\w-]+/g, '_') + '.pdf'), Buffer.from(r.b64, 'base64')); }
}

try {
  let r = await exportDoc(2001, 'invoice');
  checkDoc('invoice-simple', r, { paper: 'a4', rows: 4, plan: true, texts: ['فهد سعود الدوسري', 'التسليم بعد أسبوعين.', 'توصيل وتركيب', 'جداول الأثاث', SETTINGS.invoiceNote, 'جميع القياسات بالسنتيمتر', 'تواصل معنا', 'للاستفسار عن طلبك اذكر رقمه'] });
  r = await exportDoc(2002, 'invoice');
  checkDoc('invoice-heavy', r, { bigger: true, rows: 26 + 3 + 1, plan: true,
    texts: ['عبدالرحمن بن عبدالعزيز بن محمد آل الشيخ القحطاني', 'Mohammed Al-Otaibi (VIP)', 'فيلا 14 (بجوار مسجد الإمام)', 'gate code 4471', 'الألوان حسب العينة رقم 7', heavyRows[25].name, 'Walnut Serving Table'] });
  ok(/ملاءمة للصفحة/.test(r.note), 'invoice-heavy: نافذة التصدير تشرح الطباعة على A4 (ملاءمة للصفحة)', r.note.slice(-120));
  ok(/صفحة واحدة/.test(r.state), 'invoice-heavy: الحالة تذكر «صفحة واحدة» والمقاس', r.state);
  r = await exportDoc(2003, 'invoice');
  checkDoc('invoice-empty', r, { paper: 'a4', rows: 1, texts: ['عميل بلا بيانات', 'لا توجد أصناف', 'لا توجد قطع على المخطط'] });
  r = await exportDoc(2002, 'workshop');
  checkDoc('workshop-heavy', r, { plan: true, texts: ['أمر تصنيع', 'لا يحتوي هذا المستند على أسعار'] });
  ok(!/ر\.س/.test(r.text), 'workshop-heavy: بلا أي سعر', '');
  r = await exportDoc(2001, 'receipt');
  checkDoc('receipt-simple', r, { paper: 'a4', texts: ['سند قبض', 'فهد سعود الدوسري'] });
} catch (e) {
  ok(false, 'تشغيل', String(e && e.stack || e).slice(0, 400));
}
ok(pageErrors.length === 0, 'ui: لا أخطاء JavaScript', pageErrors.slice(0, 3));
await browser.close();
server.close();
console.log(`=== order-pdf: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
