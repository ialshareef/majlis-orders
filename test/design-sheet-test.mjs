/* ورقة التصميم المشتركة (js/design-sheet.js):
   - سعة الجلوس = max(1, round(العرض / 0.8م)) — نفس معيار رسم الوسائد.
   - جدول الأثاث والدليل يعكسان القطع الفعلية ولا يخترعان بيانات.
   - الورقة بلا أي بيانات مالية (مسارات العميل والموظف والموسّع كلها).
   - المسارات الثلاثة وكل HTML وsw وbuild-worker يستدعيان الوحدة نفسها.

   node test/design-sheet-test.mjs                                         */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const require = createRequire(import.meta.url);
const DS = require(path.join(root, 'js', 'design-sheet.js'));

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

/* قطع نموذجية: كنبتان بمقياس 0.8م + إكسسوار + قطعة حرة + عمود + فتحات */
const design = {
  walls: [
    { len: 6, angle: 0 }, { len: 4, angle: 90 },
    { len: 6, angle: 180 }, { len: 4, angle: 270 }
  ],
  openings: [{ type: 'door' }, { type: 'mashab' }, { type: 'window' }],
  pieces: [
    { kind: 'sofa', w: 2.4, h: 0.8, seating: 'sofa' },   // 3 مقاعد
    { kind: 'sofa', w: 1.6, h: 0.8, seating: 'floor' },  // 2 مقاعد
    { kind: 'sofa', w: 0.7, h: 0.8, seating: 'arabic' }, // مقعد واحد (minimum)
    { kind: 'acc', itemId: 'a1', w: 0.5, h: 0.5 },
    { kind: 'free', w: 1, h: 1 },
    { kind: 'column', w: 0.3, h: 0.3 }
  ]
};
const getItem = (id) => (id === 'a1' ? { name: 'مزهرية', color: '#2f6f4f', shape: 'circle' } : null);

/* ---------- 1) سعة الجلوس = معيار 0.8م للفرد ---------- */
console.log('== 1) سعة الجلوس ==');
t('2.4م = 3 مقاعد', DS.seatsOf({ kind: 'sofa', w: 2.4 }) === 3);
t('1.6م = مقعدان', DS.seatsOf({ kind: 'sofa', w: 1.6 }) === 2);
t('0.7م = مقعد واحد على الأقل', DS.seatsOf({ kind: 'sofa', w: 0.7 }) === 1);
t('قطعة غير كنب = صفر', DS.seatsOf({ kind: 'acc', w: 2 }) === 0);
t('السعة الكلية = 6 (3+2+1)', DS.facts(design, { getItem }).capacity === 6);

/* ---------- 2) أبعاد الغرفة من سلسلة الجدران ---------- */
console.log('== 2) أبعاد الغرفة ==');
{
  const r = DS.roomOf(design);
  t('عرض 6م وطول 4م', r.w === 6 && r.h === 4, JSON.stringify(r));
  t('المساحة 24 م²', r.area === 24, JSON.stringify(r.area));
}

/* ---------- 3) صفوف الجدول والدليل ---------- */
console.log('== 3) الجدول والدليل ==');
{
  const f = DS.facts(design, { getItem });
  t('أربعة صفوف (3 كنب + إكسسوار)', f.rows.length === 4, JSON.stringify(f.rows.map(r => r.name)));
  const sofas = f.rows.filter(r => r.kind === 'sofa');
  t('الكنب تصاعدياً بعرضها', sofas.map(r => r.dims).join('|') === '70 × 80|160 × 80|240 × 80', JSON.stringify(sofas.map(r => r.dims)));
  t('مقاس 2.4م يظهر 240 سم', sofas[2].dims === '240 × 80', sofas[2].dims);
  t('الإكسسوار باسمه ولونه من الكتالوج', f.rows.some(r => r.name === 'مزهرية' && r.color === '#2f6f4f'));
  t('الدليل يضم المقاعد والمزهرية وقطعة حرة والعمود', f.legend.map(e => e.label).join(',') === 'المقاعد,مزهرية,قطعة حرة,عمود', JSON.stringify(f.legend.map(e => e.label)));
  t('فرع المقاعد يذكر أنواع الجلسات', /جلسة كنب/.test(f.legend[0].sub) && /جلسة أرضية/.test(f.legend[0].sub), f.legend[0].sub);
  t('الأبواب والمشب والشبابيك معدودة', f.doors === 1 && f.mashabs === 1 && f.windows === 1);
}

/* ---------- 4) HTML الورقة: عنوان ومقاسات ومقياس رسم ---------- */
console.log('== 4) HTML الورقة ==');
{
  const f = DS.facts(design, { getItem });
  const pl = { img: 'data:image/png;base64,x', W: 1200, H: 800, scale: 10, room: { l: 10, t: 8, w: 80, h: 60 } };
  const html = DS.render(f, pl, { meta: [{ label: 'رقم التصميم', value: 'D-101' }] });
  t('عنوان المرجع', /مقرّر توزيع الأثاث الداخلي/.test(html));
  t('جدول الأثاث + دليل الألوان', /جداول الأثاث/.test(html) && /دليل الألوان والمواد/.test(html));
  t('بطاقة السعة بالمعيار', /مقعداً – سعة الجلوس/.test(html) && />6</.test(html));
  /* D4: عرض × طول (walls[0] × walls[1]) متسقة مع roomSummary والجداول */
  t('أبعاد الغرفة عرض × طول', /600 × 400 سم/.test(html), (html.match(/<dd class="num">[^<]*سم/) || [])[0]);
  /* D5: لا طبقة قياس HTML فوق الصورة — الشارات داخل صورة التصدير نفسها */
  t('بلا تكرار خطوط القياس فوق الصورة', !/ds-dim/.test(html));
  const scStyle = ((/class="ds-scale" style="([^"]*)"/.exec(html) || [])[1]) || '';
  const scNums = ((/class="ds-scale-n">([\s\S]*?)<\/span>/.exec(html) || [])[1] || '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  /* D3: الحاوية بعرض محسوب (15م × 10px/م ÷ 1200px = 12.5%) والشريط 100% منها */
  t('مقياس الرسم: حاوية بعرض محسوب في الزاوية', /right:3\.5%/.test(scStyle) && /width:12\.5%/.test(scStyle), scStyle);
  t('مقياس الرسم: أقسام 0/500/1000/1500 سم', scNums === '0 500 1000 1500', scNums);
  t('حقل رقم التصميم في الصدر', /رقم التصميم/.test(html) && /D-101/.test(html));
  t('بلا أي بيانات مالية', !/ر\.س|السعر|الإجمالي|دفعة|price/i.test(html));
  t('تهريب قيمة meta', !/<script>/.test(DS.render(f, pl, { meta: [{ label: 'x', value: '<script>' }] })));

  /* D1: الشريط بلا ارتفاع ثابت يقصّ المحتوى، والمرور يقيس ارتفاعه فعلياً */
  const css = read('css/style.css');
  const footRule = (/\.ds-foot\s*\{[^}]*\}/s.exec(css) || [''])[0];
  t('style.css: شريط تواصل بارتفاع مرن (min-height بلا قصّ)', /min-height:\s*16mm/.test(footRule) && /height:\s*auto/.test(footRule) && !/[^-]height:\s*16mm/.test(footRule), footRule);
  t('js/design-sheet.js: قياس ارتفاع الشريط وضبط صندوق المخطط', /function fitFoot\(/.test(read('js/design-sheet.js')) && /planBoxStyle\(pl, opts, footMm\)/.test(read('js/design-sheet.js')));
}

/* ---------- 5) المسارات الثلاثة تستخدم الوحدة نفسها ---------- */
console.log('== 5) الربط ==');
{
  const portal = read('js/portal.js');
  const app = read('js/app.js');
  const expanded = read('js/portal-expanded.js');
  t('portal.js: DesignSheet.build + pdfBlob', /DesignSheet\.build\(/.test(portal) && /DesignSheet\.pdfBlob\(/.test(portal));
  t('app.js: makeDesignSheetBlob تستخدم DesignSheet.pdfBlob', /DesignSheet\.pdfBlob\(/.test(app));
  t('portal-expanded.js: وصفحة الغلاف والختام تبقيان عموديتين', /DesignSheet\.buildPages\(/.test(expanded) && /addPage\('a4', 'landscape'\)/.test(expanded));
  for (const f of ['index.html', 'portal.html', 'portal-expanded.html']) {
    t(f + ' يحمّل design-sheet.js', /js\/design-sheet\.js/.test(read(f)));
  }
  t('sw.js يضع design-sheet.js في الكاش', /\/js\/design-sheet\.js/.test(read('sw.js')));
  t('build-worker.ps1 يضمّنه في الحزمة', /design-sheet\.js/.test(read('build-worker.ps1')));
  const css = read('css/style.css');
  t('style.css: ورقة 277×190مم', /\.dsheet\s*\{[^}]*width:\s*277mm[^}]*height:\s*190mm/s.test(css));
  t('style.css: صندوق المخطط 178مم', /\.ds-side\s*\{[^}]*width:\s*72mm/s.test(css) && /\.ds-body\s*\{[^}]*gap:\s*7mm/s.test(css));
}

/* ---------- 6) ملخص المساحات: غرفة المثال 500×400 ---------- */
console.log('== 6) ملخص المساحات ==');
{
  const ex54 = {
    walls: [
      { len: 5, angle: 0 }, { len: 4, angle: 90 },
      { len: 5, angle: 180 }, { len: 4, angle: 270 }
    ],
    pieces: [
      { kind: 'sofa', w: 2.17, h: 0.8, seating: 'floor' },
      { kind: 'sofa', w: 2.6, h: 0.8, seating: 'floor' },
      { kind: 'sofa', w: 3.2, h: 0.8, seating: 'floor' },
      { kind: 'sofa', w: 3.2, h: 0.8, seating: 'floor' },
      { kind: 'acc', itemId: 'a1', w: 0.5, h: 0.5 },
      { kind: 'free', w: 1, h: 1 },
      { kind: 'column', w: 0.3, h: 0.3 }
    ]
  };
  const pl = { img: 'data:image/png;base64,x', W: 1200, H: 800, scale: 10, room: null };
  const fa = DS.facts(ex54, { getItem });
  t('طول الجلسة = 11.17 م (2.17+2.6+3.2×2)', fa.areas && fa.areas.len === 11.17, JSON.stringify(fa.areas));
  t('مساحة الارتكاز = 8.94 م² (0.8×11.17 ثم ر2)', fa.areas && fa.areas.area === 8.94, JSON.stringify(fa.areas));
  t('مساحة الغرفة = 20 م² (5×4)', fa.areas && fa.areas.room === 20);
  t('المساحة المتبقية = 11.06 م² من القيم الخام', fa.areas && fa.areas.rest === 11.06, JSON.stringify(fa.areas && fa.areas.rest));
  t('كسر النسبة خام (44.68%)', fa.areas && Math.round(fa.areas.frac * 10000) === 4468, fa.areas && fa.areas.frac);

  const html = DS.render(fa, pl, {});
  t('HTML بقيم المواصفة كاملة', /11\.17 م</.test(html) && /8\.94 م²/.test(html) && /20\.00 م²/.test(html)
    && /44\.7%/.test(html) && /11\.06 م²/.test(html), (html.match(/ds-areas[\s\S]{0,600}/) || [''])[0].slice(0, 300));
  t('الحاشية المطلوبة بالضبط', /مجموع مساقط القطع وقد تتداخل/.test(html));
  t('طول الجلسة بالمتر لا بالمتر المربع', /<dt>طول الجلسة<\/dt><dd class="num">11\.17 م<\/dd>/.test(html));
  t('لا يبقى أثر لصيغة «الجلوس» في أي قالب', !/طول الجلوس/.test(read('js/design-sheet.js')));
  t('عنوان القسم وفئاته', /ملخص المساحات/.test(html) && /ds-areas-h/.test(html));
  t('بلا أي بيانات مالية في المساحات', !/ر\.س|السعر|الإجمالي|دفعة|price/i.test(html));
  /* الحصر: الكنب فقط وبأبعاد كاملة وبغرفة معلومة */
  const f2 = DS.facts(design, { getItem });
  t('القالب القديم يعرض المساحات (4.7م من 24م²)', f2.areas && f2.areas.len === 4.7 && f2.areas.room === 24, JSON.stringify(f2.areas));
  t('نسبة القالب القديم 15.7%', /15\.7%/.test(DS.render(f2, pl, {})));
  const noSofa = DS.facts({ walls: design.walls, pieces: [{ kind: 'acc', itemId: 'a1', w: .5, h: .5 }] }, { getItem });
  t('بلا كنب = بلا صندوق', noSofa.areas === null && !/ds-areas/.test(DS.render(noSofa, pl, {})));
  const noRoom = DS.facts({ pieces: [{ kind: 'sofa', w: 2.4, h: 0.8 }] }, { getItem });
  t('بلا غرفة معلومة = بلا صندوق', !noRoom.areas);
  const partial = DS.facts({ walls: design.walls, pieces: [{ kind: 'sofa', w: 2, seating: 'floor' }] }, { getItem });
  t('كنب بلا عمق لا يُخمَّن له عمق', !partial.areas, JSON.stringify(partial.areas));
}

/* ---------- 7) صفحة الموظف الأفقية + شريط موحّد ---------- */
console.log('== 7) ورقة الموظف الأفقية ==');
{
  const dsjs = read('js/design-sheet.js');
  const app = read('js/app.js');
  const portal = read('js/portal.js');
  t('design-sheet.js: واجهة addPage', typeof DS.addPage === 'function');
  t('design-sheet.js: internals مشتركة shoot/stamp', /function shoot\(/.test(dsjs) && /function stamp\(/.test(dsjs));
  t('design-sheet.js: addPage تفتح صفحة أفقية', /pdf\.addPage\('a4', 'landscape'\)/.test(dsjs));
  t('app.js: makePdfBlob(order)', /async function makePdfBlob\(order\)/.test(app));
  t('app.js: الاستدعاء يمرّر الطلب', /await makePdfBlob\(order\)/.test(app));
  t('app.js: DesignSheet.addPage في الفاتورة', /DesignSheet\.addPage\(pdf/.test(app));
  t('app.js: sheetFootHtml معرّفة', /async function sheetFootHtml\(/.test(app));
  t('app.js: الورقة تمرّر footHtml', /footHtml: await sheetFootHtml\(\)/.test(app));
  t('app.js: إخفاء صور التصميم وقت التصوير', /\.inv-visuals/.test(app) && /display = 'none'/.test(app));
  t('app.js: استعادة الصور في finally', /finally\s*\{\s*showHidden\(\)/.test(app));
  t('app.js: روابط الصفحة الأفقية بارتفاع الورقة', /addPdfLinksToDoc\(p2, el, x0, y0, wMm, DesignSheet\.SHEET_H\)/.test(app));
  t('app.js: حالة الطلب من STATUS', /STATUS\[order\.status\] \|\| '—'/.test(app));
  t('بنية الشريط متطابقة portal/app', /class="inv-contact"><b>تواصل معنا<\/b>/.test(portal) && /class="inv-contact"><b>تواصل معنا<\/b>/.test(app));
  t('ملاحظة التذكرة في الاثنين', /احتفظ برقم التصميم لمراجعته مع المحل/.test(portal) && /احتفظ برقم التصميم لمراجعته مع المحل/.test(app));
  t('app: بطاقات data-url لروابط PDF', /class="inv-chan" data-url=/.test(app));
  t('preview: نسخة الموظف بها الشريط الآن', /kind === 'staff'\)[\s\S]{0,220}opts\.footHtml/.test(read('test/design-sheet-preview.html')));
}

/* ---------- 8) ألوان البستيل في style.css ---------- */
console.log('== 8) ألوان البستيل ==');
{
  const css = read('css/style.css');
  const sheetRule = (/\.dsheet\s*\{[\s\S]*?\}/.exec(css) || [''])[0];
  t('متغيّرات البستيل في .dsheet', /--ds-tbl-bg/.test(sheetRule) && /--ds-leg-bg/.test(sheetRule)
    && /--ds-plan-bg/.test(sheetRule) && /--ds-areas-bg/.test(sheetRule) && /--ds-foot-bg/.test(sheetRule));
  t('style.css: جدول أخضر فاتح وعنوان أخضر أغمق', /\.ds-tbl\s*\{[^}]*background: var\(--ds-tbl-bg\)/.test(css)
    && /\.ds-tbl th\s*\{[\s\S]*?background: var\(--ds-tbl-head\)/.test(css));
  t('style.css: دليل أزرق فاتح', /\.ds-legend\s*\{[\s\S]*?background: var\(--ds-leg-bg\)/.test(css));
  t('style.css: خطة بلون عاجي دافئ', /\.ds-plan\s*\{[\s\S]*?background: var\(--ds-plan-bg\)/.test(css));
  t('style.css: صندوق المساحات بنفسجي فاتح', /\.ds-areas-wrap\s*\{[\s\S]*?background: var\(--ds-areas-bg\)/.test(css));
  t('style.css: شريط تواصل رمادي-أزرق', /\.ds-foot\s*\{[^}]*background: var\(--ds-foot-bg\)/s.test(css));
  t('style.css: رؤوس الأقسام أغمق من أقسامها', /\.ds-h-tbl\s*\{[^}]*var\(--ds-h-tbl-bg\)/.test(css)
    && /\.ds-h-leg\s*\{[^}]*var\(--ds-h-leg-bg\)/.test(css));
  t('style.css: عنوان المساحات بنفسجي أغمق داخل الصندوق', /\.ds-areas-h\s*\{[\s\S]*?background: var\(--ds-h-areas-bg\)/.test(css));
  t('style.css: عناصر صندوق المساحات بشبكة عمودين', /\.ds-areas\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(css)
    && /\.ds-areas-i\b/.test(css) && /\.ds-areas-i\.hl\s*\{[^}]*grid-column:\s*1 \/ -1/.test(css));
  t('style.css: .inv.no-design يثبت التوقيعات أسفل الصفحة', /\.inv\.no-design \.inv-foot\s*\{\s*margin-top:\s*auto/.test(css));
  t('style.css: شارة السعة بالأخضر الفاتح', /\.ds-cap\s*\{[\s\S]*?background: var\(--ds-tbl-bg\)/.test(css));
  const f = DS.facts(design, { getItem });
  const html = DS.render(f, { img: 'data:image/png;base64,x', W: 1200, H: 800, scale: 10, room: null }, {});
  t('HTML: رؤوس الأقسام بفئات الألوان', /class="ds-h ds-h-tbl"/.test(html) && /class="ds-h ds-h-leg"/.test(html));
}

/* ---------- ---------- */
console.log('');
console.log(lines.join('\n'));
console.log(`\n${pass} نجح، ${fail} فشل`);
if (fail) process.exitCode = 1;
