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
  t('خطوط قياس الغرفة بالسنتيمتر', /600 سم/.test(html) && /400 سم/.test(html), html.match(/\d+ سم/g));
  t('مقياس الرسم بثلاثة أقسام', /ds-scale-bar/.test(html) && /سم/.test(html));
  t('حقل رقم التصميم في الصدر', /رقم التصميم/.test(html) && /D-101/.test(html));
  t('بلا أي بيانات مالية', !/ر\.س|السعر|الإجمالي|دفعة|price/i.test(html));
  t('تهريب قيمة meta', !/<script>/.test(DS.render(f, pl, { meta: [{ label: 'x', value: '<script>' }] })));
}

/* ---------- 5) المسارات الثلاثة تستخدم الوحدة نفسها ---------- */
console.log('== 5) الربط ==');
{
  const portal = read('js/portal.js');
  const app = read('js/app.js');
  const expanded = read('js/portal-expanded.js');
  t('portal.js: DesignSheet.build + pdfBlob', /DesignSheet\.build\(/.test(portal) && /DesignSheet\.pdfBlob\(/.test(portal));
  t('app.js: makeDesignSheetBlob تستخدم DesignSheet.pdfBlob', /DesignSheet\.pdfBlob\(/.test(app));
  t('portal-expanded.js: وصفحة الغلاف والختام تبقيان عموديتين', /DesignSheet\.build\(/.test(expanded) && /addPage\('a4', 'landscape'\)/.test(expanded));
  for (const f of ['index.html', 'portal.html', 'portal-expanded.html']) {
    t(f + ' يحمّل design-sheet.js', /js\/design-sheet\.js/.test(read(f)));
  }
  t('sw.js يضع design-sheet.js في الكاش', /\/js\/design-sheet\.js/.test(read('sw.js')));
  t('build-worker.ps1 يضمّنه في الحزمة', /design-sheet\.js/.test(read('build-worker.ps1')));
  const css = read('css/style.css');
  t('style.css: ورقة 277×190مم', /\.dsheet\s*\{[^}]*width:\s*277mm[^}]*height:\s*190mm/s.test(css));
  t('style.css: صندوق المخطط 178مم', /\.ds-side\s*\{[^}]*width:\s*72mm/s.test(css) && /\.ds-body\s*\{[^}]*gap:\s*7mm/s.test(css));
}

/* ---------- ---------- */
console.log('');
console.log(lines.join('\n'));
console.log(`\n${pass} نجح، ${fail} فشل`);
if (fail) process.exitCode = 1;
