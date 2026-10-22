/* اختبارات روابط PDF ورقة التصميم (العميل والموظف وأمر الشراء)
   ---------------------------------------------------------------
   1) ترتيب دورة الحياة في design-sheet.js: قياس addLinks يجب أن يقع
      والورقة موصولة بالوثيقة (قبل release()) — هذا هو سبب فقدان النقر
      بعد cbe9ad4 (getBoundingClientRect ترجع أصفاراً للعناصر المفصولة).
   2) توصيل مساري التصدير الثلاثة بـ addLinks وشريط data-url.
   3) تشغيل دالة addPdfLinksToDoc الحقيقية (مستخرجة من js/app.js، لا نسخة)
      وaddPdfLinks الحقيقية من js/portal.js على jsPDF حقيقي: تُفحص تعليقات
      /Link و /URI داخل ملف PDF الناتج فعلياً + الهندسة (الحدود، عدم التداخل،
      بطاقة مستقلة لكل رابط) + آلية العنصر المفصول (أصفار = صفر روابط).

   node test/pdf-links-test.mjs                                                        */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ds = fs.readFileSync(path.join(root, 'js', 'design-sheet.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'js', 'portal.js'), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

/* ============ 1) ترتيب دورة الحياة (design-sheet.js) ============ */
console.log('== 1) الترتيب: قياس الروابط قبل فصل العنصر ==');
const shootSlice = ds.slice(ds.indexOf('function shoot('), ds.indexOf('function stamp('));
const pdfBlobSlice = ds.slice(ds.indexOf('function pdfBlob('), ds.indexOf('function addPage('));
const addPageSlice = ds.slice(ds.indexOf('function addPage('), ds.indexOf('var api ='));
const afterH2c = shootSlice.slice(shootSlice.indexOf('html2canvas('));
t('shoot: ترجع release مع الورقة', /return \{\s*canvas: canvas,\s*el: el,\s*release: release\s*\}/.test(shootSlice));
t('shoot: بعد html2canvas لا استدعاء restore() مباشر', !afterH2c.includes('restore()'), afterH2c.match(/restore\(\)/) ? 'restore() بعد html2canvas' : '');
t('shoot: فشل الالتقاط يحرّر بـ release()', /function \(e\) \{ release\(\); throw e; \}/.test(shootSlice));
t('pdfBlob: stamp قبل release', pdfBlobSlice.indexOf('stamp(pdf, shot, opts)') > -1
  && pdfBlobSlice.indexOf('shot.release()') > pdfBlobSlice.indexOf('stamp(pdf, shot, opts)'));
t('pdfBlob: تحرير مضمون في finally', /finally \{\s*shot\.release\(\);?\s*\}/.test(pdfBlobSlice));
t('addPage: stamp قبل release', addPageSlice.indexOf('stamp(pdf, shot, opts)') > -1
  && addPageSlice.indexOf('shot.release()') > addPageSlice.indexOf('stamp(pdf, shot, opts)'));
t('addPage: تحرير مضمون في finally', /finally \{\s*shot\.release\(\);?\s*\}/.test(addPageSlice));
const stampSlice = ds.slice(ds.indexOf('function stamp('), ds.indexOf('function pdfBlob('));
t('stamp: تستدعي addLinks بالورقة الحية', /opts\.addLinks\(pdf, shot\.el, 10, 10, SHEET_W\)/.test(stampSlice));
t('release: idempotent ويجري مرة واحدة', /var released = false;\s*function release\(\) \{ if \(released\) return; released = true; restore\(\); \}/.test(shootSlice));
t('shoot: release معرّف قبل الإعداد المتصلاً', shootSlice.indexOf('function release()') > -1
  && shootSlice.indexOf('function release()') < shootSlice.indexOf("area.innerHTML = ''"));
t('shoot: فشل الإعداد المزامني يُعيد رفضاً بعد release()',
  /catch \(e\) \{[\s\S]{0,200}?try \{ release\(\); \} catch \(_\) \{[\s\S]{0,80}?\}[\s\S]{0,80}?return Promise\.reject\(e\);/.test(shootSlice)
  && shootSlice.indexOf('return Promise.reject(e)') < shootSlice.indexOf('return Promise.resolve()'));

/* ============ 2) توصيل المسارات ومصادر الروابط ============ */
console.log('== 2) مساري التصدير ومصادر الروابط ==');
t('app: مسار الموظف makeDesignSheetBlob يمرّر addLinks',
  /return DesignSheet\.pdfBlob\(\{[\s\S]{0,700}?addLinks: \(pdf, el, x0, y0, wMm\) => addPdfLinksToDoc\(pdf, el, x0, y0, wMm, DesignSheet\.SHEET_H\)/.test(app));
t('app: صفحة ورقة التصميم في أمر الشراء تمرّر addLinks',
  /addLinks: \(p2, el, x0, y0, wMm\) => addPdfLinksToDoc\(p2, el, x0, y0, wMm, DesignSheet\.SHEET_H\)/.test(app));
t('app: كلا المسارين يمرّران footHtml الشريط',
  (app.match(/footHtml: await sheetFootHtml\(\)/g) || []).length === 2);
t('portal: مسار العميل يمرّر addLinks ثم pdfBlob',
  /o\.addLinks = function \(pdf, el, x0, y0, wMm\) \{ addPdfLinks\(pdf, el, x0, y0, wMm\); \}/.test(portal)
  && /return DesignSheet\.pdfBlob\(o\)/.test(portal));
t('portal: footHtml الشريط في مسار العميل', /o\.footHtml = await designContactHtml\(\)/.test(portal));
t('شريط الموظف: بطاقات inv-chan بـ data-url', /class="inv-chan" data-url="\$\{esc\(a\.url\)\}"/.test(app));
t('شريط العميل: بطاقات inv-chan بـ data-url', /'<div class="inv-chan" data-url="' \+ esc\(c\.url\)/.test(portal));
t('قنوات حقيقية في مصدر شريط الموظف', ['instagram', 'tiktok', 'snapchat'].every((k) => app.includes(`key: '${k}'`))
  && app.includes("key: 'wa'") && app.includes("key: 'mapsUrl'"));
t('قنوات حقيقية في مصدر شريط العميل', /out\.push\(\{ key: 'in', label: 'إنستقرام', url: httpsUrl\(s\.instagram\) \}\)/.test(portal)
  && /out\.push\(\{ key: 'tt', label: 'تيكتوك', url: httpsUrl\(s\.tiktok\) \}\)/.test(portal)
  && /out\.push\(\{ key: 'sn', label: 'سناب شات', url: safeHref\(s\.snapchat\) \}\)/.test(portal));
t('الفحص يقرأ data-url لكل عنصر على حدة (بلا تراكب موحّد)',
  /r = nodes\[i\]\.getBoundingClientRect\(\)/.test(app) && /pdf\.link\(x, y, w, hh, \{ url \}\)/.test(app)
  && /r = nodes\[i\]\.getBoundingClientRect\(\)/.test(portal) && /pdf\.link\(x, y, w, hh, \{ url: url \}\)/.test(portal));

/* ============ 3) دوال حقيقية + jsPDF حقيقي ============ */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, mode = 'code', quote = '';
  const open = src.indexOf('{', start);
  for (let j = open; j < src.length; j++) {
    const c = src[j], p = src[j + 1];
    if (mode === 'code') {
      if (c === '/' && p === '/') { mode = 'line'; j++; continue; }
      if (c === '/' && p === '*') { mode = 'block'; j++; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = 'str'; quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    } else if (mode === 'line') { if (c === '\n') mode = 'code'; }
    else if (mode === 'block') { if (c === '*' && p === '/') { mode = 'code'; j++; } }
    else if (mode === 'str') { if (c === '\\') { j++; continue; } if (c === quote) mode = 'code'; }
  }
  return null;
}
const addPdfLinksToDocSrc = extractFn(app, 'addPdfLinksToDoc');
const addPdfLinksSrc = extractFn(portal, 'addPdfLinks');
t('استخراج addPdfLinksToDoc من app.js', !!addPdfLinksToDocSrc);
t('استخراج addPdfLinks من portal.js', !!addPdfLinksSrc);

let jsPDF = null;
try {
  const mod = await import('jspdf');
  jsPDF = mod.jsPDF || (mod.default && mod.default.jsPDF) || mod.default;
} catch (_) { /* يُبلَّغ أدناه */ }
t('مكتبة jsPDF متاحة لفحص PDF الناتج', !!jsPDF, 'npm i --no-save --no-package-lock jspdf');

/* الوجهات المعتمدة: القيم الحيّة من /api/portal/settings (فحص ميداني 2026-10-22)
   — واتساب/جوال/إنستقرام/تيك توك/خرائط كما هي على الخادم فعلًا، وسناب شات
   (غير مفعّل حيًّا: snapchat = فارغ) بنموذج الرابط المعتمد في واجهة
   الإعدادات placeholder «https://snapchat.com/…» لتغطية فرع القناة السادسة. */
const URLS = [
  'https://wa.me/966533724290',
  'https://www.instagram.com/asalanajd_vip',
  'https://www.tiktok.com/@asalahnajed',
  'https://snapchat.com/add/asalhnajd',
  'https://maps.app.goo.gl/QoVTZK6KtxLS1AEi8?g_st=ac',
  'tel:+966533724290',
];
const MM = 72 / 25.4;
const PAGE_W = 841.89, PAGE_H = 595.28;          // A4 أفقي بالنقاط
const IMG = { x0: 10, y0: 10, w: 277, h: 190 };   // موضع الورقة داخل الصفحة (مم)

function attachedFixture(extraNode) {
  // 1108×760 بكسل = نفس نسبة الورقة 277×190مم (k = 0.25 مم/بكسل)
  const base = { left: -10000, top: 0, width: 1108, height: 760 };
  const nodes = URLS.map((url, i) => ({
    url,
    rect: { left: base.left + 15 + i * 181, top: 600, width: 171, height: 130 },
  }));
  const nodesOut = nodes.map((n) => ({
    getAttribute: (a) => (a === 'data-url' ? n.url : null),
    getBoundingClientRect: () => n.rect,
  }));
  if (extraNode) nodesOut.push(extraNode);
  return {
    base,
    nodes: nodesOut,
    el: {
      getBoundingClientRect: () => base,
      querySelectorAll: (sel) => (sel === '[data-url]' ? nodesOut : []),
    },
    expected: nodes.map((n, i) => ({
      url: n.url,
      x: IMG.x0 + (n.rect.left - base.left) * (IMG.w / base.width),
      y: IMG.y0 + (n.rect.top - base.top) * (IMG.h / base.height),
      w: n.rect.width * (IMG.w / base.width),
      h: n.rect.height * (IMG.h / base.height),
      i,
    })),
  };
}

function pdfText(buf) { return Buffer.from(buf).toString('latin1'); }
function parseLinks(text) {
  const out = [];
  const re = /\/Subtype \/Link \/Rect \[([^\]]*)\][\s\S]{0,420}?\/URI \(([^)]*)\) >>/g;
  let m;
  while ((m = re.exec(text))) {
    const r = m[1].trim().split(/\s+/).map(Number);
    // jsPDF يكتب y العلوي قبل السفلي دون ترتيب تصاعدي — نُطبّع للمقارنات
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
const near = (a, b, eps = 0.08) => Math.abs(a - b) <= eps;

if (jsPDF) {
  console.log('== 3) PDF حقيقي: الدوال المستخرجة + jsPDF ==');
  const addDoc = new Function('return ' + addPdfLinksToDocSrc)();
  const addPortal = new Function('return ' + addPdfLinksSrc)();

  // (أ) مسار الموظف/العميل: الدالة الحقيقية على عنصر موصول
  {
    const fx = attachedFixture();
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    const n = addDoc(pdf, fx.el, IMG.x0, IMG.y0, IMG.w, IMG.h);
    const links = parseLinks(pdfText(pdf.output('arraybuffer')));
    t('الموظف/العميل: عدد التعليقات = عدد البطاقات (6)', n === 6 && links.length === 6, 'n=' + n + ' links=' + links.length);
    t('كل URI في الملف = الوجهة المعتمدة حرفياً (بلا تحريف ولا روابط تجريبية)',
      URLS.every((u, i) => links[i] && links[i].uri === u), JSON.stringify(links.map((l) => l.uri)));
    // الهندسة: الحدود داخل مساحة الورقة + عدم التداخل + بطاقة مستقلة لكل رابط
    let inBounds = true, nonOverlap = true, perCard = true;
    for (const l of links) {
      const r = l.rect;
      const x0mm = r.llx / MM, x1mm = r.urx / MM;
      const y0mm = (PAGE_H - r.ury) / MM, y1mm = (PAGE_H - r.lly) / MM;
      if (x0mm < IMG.x0 - 0.5 || x1mm > IMG.x0 + IMG.w + 0.5 || y0mm < IMG.y0 - 0.5 || y1mm > IMG.y0 + IMG.h + 0.5) inBounds = false;
      if (x1mm - x0mm > 60) perCard = false;   // لا مستطيل يغطي الشريط كله
    }
    for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
      const a = links[i].rect, b = links[j].rect;
      const overlap = a.llx < b.urx - 0.5 && b.llx < a.urx - 0.5 && a.lly < b.ury - 0.5 && b.lly < a.ury - 0.5;
      if (overlap) nonOverlap = false;
    }
    t('التعليقات ضمن حدود صفحة A4 أفقي', inBounds);
    t('لا تداخل بين مستطيلات النقر', nonOverlap);
    t('كل ربط بمساحة بطاقة مستقلة (بلا تغطية عامة)', perCard);
    let geomOk = true;
    for (const e of fx.expected) {
      const l = links[e.i];
      if (!l) { geomOk = false; continue; }
      const x0mm = l.rect.llx / MM, y0mm = (PAGE_H - l.rect.ury) / MM;
      const wmm = (l.rect.urx - l.rect.llx) / MM, hmm = (l.rect.ury - l.rect.lly) / MM;
      if (!near(x0mm, e.x) || !near(y0mm, e.y) || !near(wmm, e.w) || !near(hmm, e.h)) geomOk = false;
    }
    t('المواقع بالملليمترات مطابقة لمعادلة التحويل', geomOk);
    t('بطاقة فارغة data-url تُستبعد', (() => {
      const f2 = attachedFixture({ getAttribute: (a) => (a === 'data-url' ? '' : null), getBoundingClientRect: () => ({ left: -10000 + 200, top: 600, width: 171, height: 130 }) });
      const p2 = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
      const n2 = addDoc(p2, f2.el, IMG.x0, IMG.y0, IMG.w, IMG.h);
      return n2 === 6 && parseLinks(pdfText(p2.output('arraybuffer'))).length === 6;
    })());
    t('عنصر خارج حدود الصفحة يُستبعد (بلا قفز خارج الورقة)', (() => {
      const f3 = attachedFixture({ getAttribute: (a) => (a === 'data-url' ? 'https://evil.example/out' : null), getBoundingClientRect: () => ({ left: -10000 + 1090, top: 600, width: 171, height: 130 }) });
      const p3 = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
      const n3 = addDoc(p3, f3.el, IMG.x0, IMG.y0, IMG.w, IMG.h);
      const txt = pdfText(p3.output('arraybuffer'));
      return n3 === 6 && !txt.includes('evil.example');
    })());
  }

  // (ب) مسار العميل في portal: الدالة الحقيقيةportal
  {
    const fx = attachedFixture();
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    const n = addPortal(pdf, fx.el, IMG.x0, IMG.y0, IMG.w);
    const links = parseLinks(pdfText(pdf.output('arraybuffer')));
    t('portal: 6 تعليقات بنفس الوجهات', n === links.length && links.length === 6, 'n=' + n);
    t('portal: URI الملف = الوجهات المعتمدة حرفياً', URLS.every((u, i) => links[i] && links[i].uri === u));
    let inBounds = true;
    for (const l of links) {
      const x0mm = l.rect.llx / MM, x1mm = l.rect.urx / MM;
      const y0mm = (PAGE_H - l.rect.ury) / MM, y1mm = (PAGE_H - l.rect.lly) / MM;
      if (x0mm < IMG.x0 - 0.5 || x1mm > IMG.x0 + IMG.w + 0.5 || y0mm < IMG.y0 - 0.5 || y1mm > IMG.y0 + IMG.h + 0.5) inBounds = false;
    }
    t('portal: التعليقات ضمن حدود الورقة', inBounds);
  }

  // (ج) صفحة ورقة التصميم الثانية (أمر الشراء): تعليقاتها على الصفحة 2
  {
    const fx = attachedFixture();
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    pdf.addPage('a4', 'landscape');
    const n = addDoc(pdf, fx.el, IMG.x0, IMG.y0, IMG.w, IMG.h);
    const txt = pdfText(pdf.output('arraybuffer'));
    const pages = (txt.match(/\/Type \/Page[^s]/g) || []).length;
    const links = parseLinks(txt);
    t('أمر الشراء: صفحتان (فاتورة + ورقة تصميم)', pages === 2, 'pages=' + pages);
    t('أمر الشراء: 6 تعليقات على الصفحة الثانية', n === 6 && links.length === 6, 'n=' + n);
    const annotBlocks = (txt.match(/\/Annots \[[\s\S]*?\]/g) || []);
    const urisInFirst = annotBlocks.length > 1 ? (annotBlocks[0].match(/\/URI \(/g) || []).length : 0;
    t('الصفحة الأولى بلا روابط (الروابط في ورقة التصميم)', urisInFirst === 0, 'blocks=' + annotBlocks.length);
  }

  // (د) آلة الحالة الفاشلة: عنصر مفصول (أصفار) = صفر روابط — سبب الانكسار السابق
  {
    const deadEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
      querySelectorAll: (sel) => (sel === '[data-url]'
        ? URLS.map((u) => ({ getAttribute: () => u, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }))
        : []),
    };
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    const n = addDoc(pdf, deadEl, IMG.x0, IMG.y0, IMG.w, IMG.h);
    const links = parseLinks(pdfText(pdf.output('arraybuffer')));
    t('العنصر المفصول يعطي صفر روابط (توضيح سبب cbe9ad4)', n === 0 && links.length === 0, 'n=' + n);
  }
}

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
const out = process.env.PDF_LINKS_OUT;
if (out) fs.writeFileSync(out, report, 'utf8');
console.log(report);
process.exit(fail ? 1 : 0);
