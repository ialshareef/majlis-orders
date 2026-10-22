/* فحص E2E حقيقي لمتصفح: يشغّل test/pdf-links-harness.html في Chrome/Edge
   (headless) — مسارات الإنتاج الفعلية الثلاثة داخلاً:
     js/app.js  makeDesignSheetBlob  (الموظف)
     js/portal.js makeDesignPdfBlob  (العميل)
     js/app.js  makePdfBlob          (أمر الشراء: فاتورة + ورقة)
   ثم يستخرج ملفات PDF الناتجة فعلياً ويفحص:
     - عدّاد addLinks (n) والبطاقات الموصولة (dom) لحظة القياس
     - تعليقات /URI داخل كل صفحة ومقارنتها بقيم متوقعة مشتقّة باستقلال
       عن مصادر الإعدادات الحيّة (GET /api/portal/settings)
     - الهندسة: حدود كل صفحة، عدم التداخل، بطاقة مستقلة لكل رابط
     - بلا روابط تجريبية/محظورة (validSocialUrl/httpsUrl)
     - إعادة تشغيل كاملة مع حجب كل طلب شبكة خارجي (إثبات عدم الحاجة
       للإنترنت أثناء إنشاء PDF بعد تحميل المكتبات — data-ok مثل الإنتاج)

   يعتمد: node_modules/puppeteer-core (npm i --no-save --no-package-lock
   puppeteer-core jspdf sql.js html2canvas — الحزم الأربع معاً لأن npm يقصّ
   غير المدرجة) + Chrome أو Edge + شبكة للإعدادات الحيّة والمكتبات CDN.

   node test/pdf-links-e2e.mjs                                                        */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };
const finish = () => {
  const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
  console.log(report);
  process.exit(fail ? 1 : 0);
};
const skip = (why) => { lines.push('SKIP  E2E غير منفَّذ: ' + why); console.log('E2E=SKIPPED — ' + why); console.log(lines.join('\n')); process.exit(0); };

let puppeteer = null;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch (_) {
  skip('puppeteer-core غير مثبّت — npm i --no-save --no-package-lock puppeteer-core jspdf sql.js html2canvas');
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) skip('لا يوجد Chrome/Edge على الجهاز');

/* ---- الإعدادات الحيّة: وجهات المشروع الفعلية لا الافتراضات ---- */
const LIVE_URL = 'https://majlis-api.asalh-najd.workers.dev/api/portal/settings';
let liveCfg = null;
try {
  const r = await fetch(LIVE_URL, { signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!r.ok || !j.settings) throw new Error('bad response');
  liveCfg = j.settings;
} catch (e) {
  console.log('E2E=FAILED — تعذّر جلب الإعدادات الحيّة من الخادم: ' + e.message);
  process.exit(1);
}
const SNAP_FIXTURE = 'https://snapchat.com/add/asalhnajd';   // بنموذج واجهة الإعدادات (حيًّا snapchat فارغ)
const cfgs = { live: liveCfg, snap: { ...liveCfg, snapchat: SNAP_FIXTURE } };

/* ---- قيم متوقعة: مرآة مستقلة لقواعد الإنتاج (app: validSocialUrl+waPhone) ---- */
function expectedURIs(cfg) {
  const out = [];
  const forbidden = (u) => !/^https:\/\//i.test(u) || /[\s<>"]/.test(u)
    || /example\.com|localhost|127\.0\.0\.1|\/test(\/|$)/i.test(u);
  const wa = String(cfg.whatsapp || '').trim();
  if (wa && !forbidden(wa)) out.push(wa);
  let d = String(cfg.phone || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) { /* كما هو */ }
  else if (d.startsWith('0')) d = '966' + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = '966' + d;
  if (d.length >= 7) out.push('tel:+' + d);
  for (const k of ['instagram', 'tiktok', 'snapchat', 'mapsUrl']) {
    const v = String(cfg[k] || '').trim();
    if (v && !forbidden(v)) out.push(v);
  }
  return [...new Set(out)].sort();
}
const expLive = expectedURIs(liveCfg);
const expSnap = expectedURIs(cfgs.snap);
lines.push('INFO  وجهات حيّة متوقعة (' + expLive.length + '): ' + JSON.stringify(expLive));
lines.push('INFO  وجهات مع سناب (' + expSnap.length + '): ' + JSON.stringify(expSnap));
if (expLive.length < 4) { console.log('E2E=FAILED — الإعدادات الحيّة ناقصة بشكل غير منطقي'); process.exit(1); }

/* ---- فحص PDF: صفحات + تعليقات + هندسة ---- */
const MM = 72 / 25.4;
const PAGE_H = 595.28;
const SHEET_BOX = { x0: 10, y0: 10, w: 277, h: 190 };   // ورقة التصميم A4 أفقي
const INV_BOX = { x0: 10, y0: 10, w: 190, h: 276 };     // الفاتورة A4 عمودي

function parseLinks(text) {
  const out = [];
  const re = /\/Subtype \/Link \/Rect \[([^\]]*)\][\s\S]{0,420}?\/URI \(([^)]*)\) >>/g;
  let m;
  while ((m = re.exec(text))) {
    const r = m[1].trim().split(/\s+/).map(Number);
    out.push({
      uri: m[2],
      rect: {
        llx: Math.min(r[0], r[2]), urx: Math.max(r[0], r[2]),
        lly: Math.min(r[1], r[3]), ury: Math.max(r[1], r[3]),
      },
    });
  }
  return out;
}
function pageSegments(text) {
  const idx = [];
  const re = /\/Type \/Page(?!s)/g;
  let m;
  while ((m = re.exec(text))) idx.push(m.index);
  if (!idx.length) return [text];
  return idx.map((v, i) => text.slice(v, i + 1 < idx.length ? idx[i + 1] : text.length));
}
function geomOk(links, box) {
  for (const l of links) {
    const x0mm = l.rect.llx / MM, x1mm = l.rect.urx / MM;
    const y0mm = (PAGE_H - l.rect.ury) / MM, y1mm = (PAGE_H - l.rect.lly) / MM;
    if (x0mm < box.x0 - 1 || x1mm > box.x0 + box.w + 1 || y0mm < box.y0 - 1 || y1mm > box.y0 + box.h + 1) return false;
    if (x1mm - x0mm > 70 || y1mm - y0mm > 60) return false;    // بطاقة مستقلة لا تغطية عامة
  }
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    const a = links[i].rect, b = links[j].rect;
    if (a.llx < b.urx - 0.5 && b.llx < a.urx - 0.5 && a.lly < b.ury - 0.5 && b.lly < a.ury - 0.5) return false;
  }
  return true;
}
function checkPdf(tag, buf, exp, boxes) {
  const text = buf.toString('latin1');
  const pageCount = (text.match(/\/Type \/Page(?!s)/g) || []).length;
  t(tag + ': عدد الصفحات = ' + boxes.length, pageCount === boxes.length, 'pages=' + pageCount);
  const segs = pageSegments(text);
  let countsOk = true, setsOk = true, geom = true, noDemo = true;
  const details = [];
  boxes.forEach((box, i) => {
    const links = parseLinks(segs[i] || '');
    const uris = links.map((l) => l.uri).sort();
    if (links.length !== exp.length) { countsOk = false; details.push('p' + i + '=' + links.length); }
    if (JSON.stringify(uris) !== JSON.stringify(exp)) { setsOk = false; details.push('p' + i + ':' + JSON.stringify(uris)); }
    if (uris.some((u) => /example\.com|localhost|127\.0\.0\.1|\/test(\/|$)/i.test(u))) noDemo = false;
    if (!geomOk(links, box)) geom = false;
  });
  t(tag + ': لكل رابط /URI صحيح بعدد القنوات (' + exp.length + ')', countsOk, details.join(' ') || '');
  t(tag + ': مجموع URI على كل صفحة = القيم الفعلية بالضبط', setsOk, details.join(' | ') || '');
  t(tag + ': بلا روابط تجريبية أو محظورة', noDemo);
  t(tag + ': الهندسة (حدود الصفحة + بلا تداخل + بطاقة مستقلة)', geom);
}

const outDir = path.join(os.tmpdir(), 'majlis-pdf-links');
fs.mkdirSync(outDir, { recursive: true });
function save(name, b64) {
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(outDir, name), buf);
  return buf;
}
function checkScenario(name, tag, r, exp, boxes) {
  t(tag + ': بلا خطأ تشغيل', !r || !r.err, r && r.err ? String(r.err).slice(0, 300) : '');
  if (!r || r.err || !r.b64) return;
  t(tag + ': استخراج دوال الإنتاج كامل (بلا نقص)', Array.isArray(r.missing) && r.missing.length === 0,
    r.missing ? r.missing.join(' | ') : '');
  const c0 = r.caps && r.caps[0];
  // مسار العميل: غلاف addLinks الإنتاجي لا يُرجع العدد (addPdfLinks تحديداً) —
  // الدليل النهائي على العدد هو /URI داخل الملف أدناه، وdom لحظة القياس واجب.
  t(tag + ': قياس addLinks لحظة الاتصال = dom = المتوقع',
    !!c0 && (c0.n === exp.length || c0.n === undefined) && c0.dom === exp.length,
    c0 ? 'n=' + c0.n + ' dom=' + c0.dom : 'لا قياس');
  const buf = save(name + '.pdf', r.b64);
  lines.push('INFO  حُفظ ' + name + '.pdf (' + buf.length + ' بايت)');
  checkPdf(tag, buf, exp, boxes);
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-web-security'],
});
try {
  const page = await browser.newPage();
  const pageErrs = [];
  page.on('pageerror', (e) => pageErrs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrs.push('console: ' + m.text()); });
  const fileUrl = 'file:///' + path.join(root, 'test', 'pdf-links-harness.html').split(path.sep).join('/');
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 60000 });

  /* ---- المرحلة 1: أولاين — مسارات الإنتاج بقيم حيّة + تفعيل سناب ---- */
  lines.push('== المرحلة 1: تشغيل مسارات الإنتاج (أولاين) ==');
  const res1 = await page.evaluate((c) => window.__runAll(c), cfgs);
  t('المِسبار اكتمل بلا أخطاء متصفح (مرحلة 1)', pageErrs.length === 0, pageErrs[0] || '');

  const sheetBoxes = [SHEET_BOX];
  const orderBoxes = [INV_BOX, SHEET_BOX];
  checkScenario('staff-live', 'الموظف-حي', res1.live.staff, expLive, sheetBoxes);
  checkScenario('client-live', 'العميل-حي', res1.live.client, expLive, sheetBoxes);
  checkScenario('order-live', 'أمر-حي', res1.live.order, expLive, orderBoxes);
  checkScenario('staff-snap', 'الموظف-مع-سناب', res1.snap.staff, expSnap, sheetBoxes);
  checkScenario('client-snap', 'العميل-مع-سناب', res1.snap.client, expSnap, sheetBoxes);
  checkScenario('order-snap', 'أمر-مع-سناب', res1.snap.order, expSnap, orderBoxes);

  /* ---- المرحلة 2: حجب كل طلب شبكة خارجي — الإنشاء بلا إنترنت ---- */
  lines.push('== المرحلة 2: إعادة التشغيل مع حجب كل طلب شبكة خارجي ==');
  const external = [];
  const onReq = (req) => {
    const u = req.url();
    // ملف محلي أو data:/blob: داخلية — ليست طلبات شبكة أصلاً
    if (!/^https?:\/\//.test(u)) req.continue();
    else { external.push(u); req.abort(); }
  };
  page.on('request', onReq);
  await page.setRequestInterception(true);
  let res2 = null, phaseErr = null;
  try {
    res2 = await page.evaluate((c) => window.__runAll(c), { live: liveCfg });
  } catch (e) {
    phaseErr = String(e);
  }
  await page.setRequestInterception(false);
  page.off('request', onReq);

  t('المرحلة الثانية بلا خطأ استثناء', !phaseErr, phaseErr || '');
  t('بلا أي طلب شبكة خارجي أثناء التصدير (المكتبات محمّلة مسبقاً data-ok)',
    external.length === 0, JSON.stringify(external.slice(0, 5)));
  if (res2) {
    t('المِسبار اكتمل بلا أخطاء متصفح (مرحلة 2)', pageErrs.length === 0, pageErrs[0] || '');
    checkScenario('staff-offline', 'الموظف-بلا-إنترنت', res2.live.staff, expLive, sheetBoxes);
    checkScenario('client-offline', 'العميل-بلا-إنترنت', res2.live.client, expLive, sheetBoxes);
    checkScenario('order-offline', 'أمر-بلا-إنترنت', res2.live.order, expLive, orderBoxes);
  }
} finally {
  await browser.close();
}
lines.push('INFO  مجلد ملفات PDF المفحوصة: ' + outDir);
finish();
