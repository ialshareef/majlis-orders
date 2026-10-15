/* اختبار أبعاد الجدار/الباب في تصدير PDF — يشغّل js/designer.js الحقيقي
   في سياق canvas وهمي (بلا متصفح وبلا حزم): نلتقط نداءات fillText التي يرسمها
   المصمم، فنتأكد أن الأرقام الظاهرة في ورقة PDF هي نفسها قيم openingGaps
   المحسوبة من الحالة المحفوظة — لا حساباً موازياً ولا أرقاماً ثابتة.

   node test/pdf-opening-dims.mjs                                        */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'designer.js'), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };
const eq = (n, a, b) => t(n, Object.is(a, b), `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

/* ---- سياق canvas وهمي: يسجّل كل نص يُرسم مع موضعه ---- */
function makeCtx() {
  const texts = [];
  const noop = () => {};
  return {
    texts,
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, rect: noop, fill: noop, stroke: noop,
    clip: noop, setLineDash: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    drawImage: noop, rotate: noop, ellipse: noop, roundRect: noop,
    fillText(s, x, y) { texts.push({ text: String(s), x, y }); },
    strokeText: noop,
    measureText(s) { return { width: String(s).length * 6 }; },
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
}
function makeCanvas(ctx) {
  return { width: 1400, height: 900, getContext: () => ctx, style: {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }), toDataURL: () => 'data:image/png;base64,' };
}

const sandbox = {
  console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Map, Set, isNaN, parseFloat, parseInt,
  document: {
    createElement(tag) {
      if (tag === 'canvas') return makeCanvas(makeCtx());
      return { style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) };
    },
    addEventListener() {}, body: { appendChild() {} },
  },
  navigator: { userAgent: 'node' },
  devicePixelRatio: 1,
  requestAnimationFrame: (f) => f(),
  Image: function Image() {},
  Path2D: function Path2D() { this.moveTo = () => {}; this.lineTo = () => {}; this.arc = () => {}; this.closePath = () => {}; this.rect = () => {}; this.addPath = () => {}; },
  DOMMatrix: function DOMMatrix() {},
  OffscreenCanvas: function OffscreenCanvas() { return makeCanvas(makeCtx()); },
  ResizeObserver: function ResizeObserver() { this.observe = () => {}; this.disconnect = () => {}; },
  MutationObserver: function MutationObserver() { this.observe = () => {}; this.disconnect = () => {}; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
/* toImage() ينشئ لوحته الخاصة ويهمل اللوحة المرفقة بالمصمم — فنلتقط السياق
   الذي ينشئه المصنع نفسه، لا سياقاً آخر. */
let lastCtx = null;
const origCreate = sandbox.document.createElement;
sandbox.document.createElement = (tag) => {
  if (String(tag).toLowerCase() === 'canvas') { lastCtx = makeCtx(); return makeCanvas(lastCtx); }
  return origCreate(tag);
};

sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'designer.js' });
const Designer = sandbox.Designer;
if (!Designer) { console.error('Designer لم يُحمَّل'); process.exit(2); }

/* ---- أدوات البناء ----
   نستخدم rectWalls من المصمم نفسه: يجب أن يحوي التصميم ثلاثة جدران فأكثر، وإلا
   استبدله المصمم بالمستطيل الافتراضي 5×4 — وهو ما وقع في أول محاولة. */
function rect(w, h) { return Designer.rectWalls(w, h); }
function mkDesign(wallLen, height, doors) {
  const walls = rect(wallLen, height);
  return {
    roomDims: { w: wallLen, h: height },
    walls,
    openings: doors,
    pieces: [],
    cornerMode: 'deduct',
  };
}
/** طول الجدار رقم i بعد التطبيع — هو المرجع الذي يحسب عليه المصمم */
function wallLenOf(design, i) {
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
  dz.setState(JSON.parse(JSON.stringify(design)));
  return dz.geometry().walls[i].len;
}
/** يبني مصمماً في الذاكرة ويصدّره تماماً كما يفعل مسار PDF، ثم يع��د
    النصوص التي رُسمت فعلاً على اللوحة المصدَّرة. */
function exportTexts(design, opts = {}) {
  lastCtx = null;
  const dz = new Designer(makeCanvas(makeCtx()), Object.assign({
    getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {},
  }, opts));
  dz.setState(JSON.parse(JSON.stringify(design)));
  lastCtx = null;                       // نتجاهل رسم setState ونراقب التصدير وحده
  dz.toImage(1400, 900);
  return (lastCtx ? lastCtx.texts : []).map((x) => x.text);
}
const numTexts = (arr) => arr.filter((s) => /سم$/.test(s)).map((s) => parseInt(s, 10));

console.log('== 1) باب في منتصف جدار 6م (عرض 0.9م) ==');
{
  const wallLen = 6, dw = 0.9;
  const d = mkDesign(wallLen, 4, [{ id: 'd1', wall: 0, t: 3, w: dw, h: 2.1, type: 'door' }]);
  const probe = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
  probe.setState(JSON.parse(JSON.stringify(d)));
  const gaps = probe.openingGaps('d1');
  eq('المصدر: يسار = 2.55م', gaps.left, 2.55);
  eq('المصدر: يمين = 2.55م', gaps.right, 2.55);
  eq('المصدر: طول الجدار = 6م', gaps.wallLen, 6);
  const shown = numTexts(exportTexts(d));
  t('PDF يعرض المسافة يساراً', shown.includes(255), shown.join(','));
  t('PDF يعرض المسافة يميناً', shown.includes(255), shown.join(','));
  t('PDF يعرض عرض الفتحة 90 سم', shown.includes(90), shown.join(','));
  t('PDF يعرض طول الجدار 600 سم', shown.includes(600), shown.join(','));
  t('كل القيم بالسنتيمتر فقط', exportTexts(d).filter((s) => /سم$/.test(s)).every((s) => /^\d+ سم$/.test(s)));
}

console.log('== 2) باب قرب طرف الجدار (0.4م من البداية) ==');
{
  const wallLen = 5, dw = 1.0;
  const d = mkDesign(wallLen, 4, [{ id: 'd1', wall: 0, t: 0.4 + dw / 2, w: dw, h: 2.1, type: 'door' }]);
  const probe = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
  probe.setState(JSON.parse(JSON.stringify(d)));
  const g = probe.openingGaps('d1');
  eq('المصدر: يسار = 0.4م', g.left, 0.4);
  eq('المصدر: يمين = 3.6م', g.right, 3.6);
  const shown = numTexts(exportTexts(d));
  t('PDF يعرض 40 سم', shown.includes(40), shown.join(','));
  t('PDF يعرض 360 سم', shown.includes(360), shown.join(','));
  t('PDF يعرض 100 سم (عرض الباب)', shown.includes(100), shown.join(','));
  t('PDF يعرض 500 سم (طول الجدار)', shown.includes(500), shown.join(','));
  t('لا رسم قياس صفري', !shown.includes(0), shown.join(','));
}

console.log('== 3) تحريك الباب ثم إعادة التصدير ==');
{
  const before = mkDesign(6, 4, [{ id: 'd1', wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  const after = mkDesign(6, 4, [{ id: 'd1', wall: 0, t: 1.2, w: 0.9, h: 2.1, type: 'door' }]);
  const a = numTexts(exportTexts(before)), b = numTexts(exportTexts(after));
  t('قبل: 255 سم', a.includes(255), a.join(','));
  t('بعد: 75 سم (يسار جديد)', b.includes(75), b.join(','));
  t('بعد: 435 سم (يمين جديد)', b.includes(435), b.join(','));
  t('بعد: لا القيمة القديمة 255', !b.includes(255), b.join(','));
  t('طول الجدار ثابت 600', b.includes(600));
}

console.log('== 4) عدة فتحات في عدة جدران ==');
{
  const d = {
    roomDims: { w: 6, h: 4 },
    walls: rect(6, 4).map((w, i) => Object.assign({ id: 'w' + i }, w)),
    openings: [
      { id: 'd1', wall: 0, t: 1.5, w: 0.9, h: 2.1, type: 'door' },
      { id: 'd2', wall: 1, t: 2, w: 0.6, h: 1.2, type: 'mashab' },
      { id: 'd3', wall: 2, t: 4.5, w: 1.0, h: 2.1, type: 'door' },
    ],
    pieces: [], cornerMode: 'deduct',
  };
  const shown = numTexts(exportTexts(d));
  t('باب الجدار الأول: 105 سم', shown.includes(105), shown.join(','));
  t('مشب الجدار الثاني: 60 سم', shown.includes(60), shown.join(','));
  t('باب الجدار الثالث: 400 سم', shown.includes(400), shown.join(','));
  t('أطوال الجدران 600/400 موجودة', shown.includes(600) && shown.includes(400), shown.join(','));
}

console.log('== 5) تصميمات قديمة/ناقصة لا تُسقط التصدير ==');
{
  const cases = [
    ['بلا فتحات', mkDesign(5, 4, [])],
    ['بلا حقل openings', { roomDims: { w: 5, h: 4 }, walls: rect(5, 4), pieces: [] }],
    ['بلا قطع', mkDesign(5, 4, [{ id: 'x', wall: 0, t: 2.5, w: 0.9, h: 2.1, type: 'door' }])],
    ['فتحة بعرض صفر', mkDesign(5, 4, [{ id: 'x', wall: 0, t: 2.5, w: 0, h: 2.1, type: 'door' }])],
    ['فتحة نوعها غير معروف', mkDesign(5, 4, [{ id: 'x', wall: 0, t: 2.5, w: 0.9, h: 2.1, type: 'zzz' }])],
    ['جدار بلا طول صالح', { roomDims: { w: 5, h: 4 }, walls: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }], openings: [], pieces: [] }],
    ['شباك فقط', mkDesign(5, 4, [{ id: 'w', wall: 0, t: 2, w: 1, h: 1, type: 'window' }])],
  ];
  for (const [name, d] of cases) {
    let ok = true, err = '';
    try { const r = exportTexts(d); ok = Array.isArray(r); } catch (e) { ok = false; err = e.message; }
    t('لا يتعطل التصدير: ' + name, ok, err);
  }
  // الشباك ليس باباً/مشباً: لا مسافة قبل/بعد ولا عرض فتحة له.
  // ويبقى قياس طول الجدران (٤ قراءات لكل جدار مرة واحدة) — سلوك مقصود.
  const winOnly = numTexts(exportTexts(mkDesign(5, 4, [{ id: 'w', wall: 0, t: 2, w: 1, h: 1, type: 'window' }])));
  t('الشباك بلا قياسات فتحة (لا 100 سم ولا 200/300 سم)',
    !winOnly.includes(100) && !winOnly.includes(200) && !winOnly.includes(300), winOnly.join(','));
  t('طول الجدار يبقى معروضاً رغم الشباك', winOnly.includes(500), winOnly.join(','));
}

console.log('== 6) المصمم والتصدير متساويان ==');
{
  const d = mkDesign(7.2, 4, [{ id: 'd1', wall: 0, t: 2.35, w: 0.9, h: 2.1, type: 'door' }]);
  const probe = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {}, dimsOnTop: true });
  probe.setState(JSON.parse(JSON.stringify(d)));
  probe.select({ type: 'opening', id: 'd1' });
  const g = probe.openingGaps('d1');
  const want = [Math.round(g.left * 100), Math.round(g.right * 100), Math.round(g.wallLen * 100)];
  const shown = numTexts(exportTexts(d));
  for (const v of want) t('PDF يطابق المصمم: ' + v + ' سم', shown.includes(v), shown.join(','));
  t('تسلسل متطابق تماماً', want.every((v) => shown.includes(v)));
}

console.log('== 7) كنبة أعمق من مسافة القياس: الخط يخرج خارج الغرفة ==');
{
  // جدار 6م، باب في منتصفه، وكنبة على نفس الجدار بعمق 1.2م — أي أعمق من
  // خط القياس 0.34م — فلا بد أن يخرج الخط ولا يغطي الكنبة.
  const wallLen = 6, sofaDepth = 1.2;
  const d = mkDesign(wallLen, 4, [{ id: 'd1', wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  d.pieces = [{ id: 'sofa1', kind: 'sofa', seating: 'floor', w: 2.6, h: sofaDepth, wall: 0, t: 3, x: 0, y: 0, rot: 0 }];
  lastCtx = null;
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
  dz.setState(JSON.parse(JSON.stringify(d)));
  const g = dz.geometry();
  const w0 = g.walls[0];
  const pr = dz._projectOnWall(dz.state.pieces[0], w0);
  t('الكنبة تمتد حتى عمق 1.2م', pr.smax > 1.1, 'smax=' + pr.smax);
  const v = dz._fitView(1400, 900);
  const plan = dz._dimOffsetPlan(makeCtx(), g, v, 1400, { export: true });
  const pp = plan.openings['d1'];
  t('المخطط: الخط يخرج خارج الغرفة', !!(pp && pp.outside && pp.s < 0), JSON.stringify(pp));
  t('المخطط: طول الجدار يزيح موضعين للخارج', plan.walls[0].sLen < -0.45, String(plan.walls[0].sLen));
  // الشارة كاملةً خارج حزام الجدار (الحزام من -0.2م إلى +0.2م حول محور الجدار)
  const bhW = plan.metrics.bhW;
  t('المخطط: الشارة لا تمسّ حزام الجدار', !!(pp && pp.s + bhW / 2 <= -0.2 + 1e-9),
    's=' + (pp && pp.s) + ' half=' + (bhW / 2).toFixed(3) + ' inner=' + ((pp ? pp.s + bhW / 2 : 0).toFixed(3)));
  t('المخطط: وتبقى ملاصقة للجدار (أقل من 0.5م)', !!(pp && pp.s >= -0.5), 's=' + (pp && pp.s));
  // التصدير الفعلي: نلتقط مواضع النصوص المرسومة ونحولها إلى إحداثيات الجدار
  lastCtx = null;
  dz.toImage(1400, 900);
  const v2 = dz._fitView(1400, 900);
  const texts = lastCtx ? lastCtx.texts : [];
  const at = (label) => texts.filter((x) => x.text === label).map((x) => dz.wallCoords(w0, { x: (x.x - v2.ox) / v2.scale, y: (x.y - v2.oy) / v2.scale }));
  const s255 = at('255 سم'), sW = at('90 سم');
  t('شارتا المسافة يساراً ويميناً خارج الغرفة', s255.length === 2 && s255.every((q) => q.s < -0.05), JSON.stringify(s255));
  t('شارة عرض الفتحة تبقى داخل الغرفة عند الفتحة', sW.length > 0 && sW.every((q) => q.s > 0.5 && Math.abs(q.t - 3) < 0.3), JSON.stringify(sW));
  // القيم لا تتغير: نفس openingGaps
  const shown = numTexts(texts.map((x) => x.text));
  t('القيم نفسها معروضة: 255/255/90/600', shown.includes(255) && shown.includes(90) && shown.includes(600), shown.join(','));
  // لا شارة قياس تسقط داخل مستطيل الكنبة نفسه (بالإحداثيات الدقيقة)
  const inSofa = texts.filter((x) => /سم$/.test(x.text)).filter((x) => {
    const q = dz.wallCoords(w0, { x: (x.x - v2.ox) / v2.scale, y: (x.y - v2.oy) / v2.scale });
    return q.t > pr.tmin && q.t < pr.tmax && q.s > pr.smin && q.s < pr.smax;
  });
  t('لا شارة قياس داخل مستطيل الكنبة', inSofa.length === 0, JSON.stringify(inSofa));
}

console.log('== 8) بلا أثاث: الخط يبقى داخل الغرفة كما كان ==');
{
  const d = mkDesign(6, 4, [{ id: 'd1', wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
  dz.setState(JSON.parse(JSON.stringify(d)));
  const g = dz.geometry();
  const v = dz._fitView(1400, 900);
  const plan = dz._dimOffsetPlan(makeCtx(), g, v, 1400, { export: true });
  const pp = plan.openings['d1'];
  t('المخطط: الخط داخل الغرفة عند 0.34م', !!(pp && !pp.outside && Math.abs(pp.s - 0.34) < 1e-9), JSON.stringify(pp));
  t('المخطط: طول الجدار يبقى في مساره المعتاد', Math.abs(plan.walls[0].sLen + 0.38) < 1e-9, String(plan.walls[0].sLen));
  const shown = numTexts(exportTexts(d));
  t('القيم نفسها: 255/255/90/600', shown.includes(255) && shown.includes(90) && shown.includes(600), shown.join(','));
}

console.log('== 9) كنبة لا تعترض الممر: الخط يبقى حيث كان ==');
{
  // كنبة على جدار آخر (بعيد عن جدار الباب): لا سبب لتحريك الخط
  const d = mkDesign(6, 4, [{ id: 'd1', wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  d.pieces = [{ id: 'sofa1', kind: 'sofa', seating: 'floor', w: 2.2, h: 0.95, wall: 2, t: 3, x: 0, y: 0, rot: 0 }];
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
  dz.setState(JSON.parse(JSON.stringify(d)));
  const g = dz.geometry();
  const v = dz._fitView(1400, 900);
  const plan = dz._dimOffsetPlan(makeCtx(), g, v, 1400, { export: true });
  const pp = plan.openings['d1'];
  t('الخط عند الباب يبقى داخل الغرفة', !!(pp && !pp.outside && Math.abs(pp.s - 0.34) < 1e-9), JSON.stringify(pp));
}

console.log('== 10) الشارة داخل الغرفة لا تقع على حزام الجدار في أي اتجاه ==');
{
  // الباب على كل جدار من الجدران الأربعة، بلا أثاث: المسار يبقى داخلياً
  // (0.34م) والشارة ملاصقة للخط على عمود الجدار — فلا تقفز إلى حزام الجدار
  // في اتجاه وتبتعد عنه في آخر كما كانت تفعل بإزاحة رأسية على الشاشة.
  let allClear = true, allInside = true, detail = [];
  for (let wallIndex = 0; wallIndex < 4; wallIndex++) {
    const d = mkDesign(6, 4, [{ id: 'd1', wall: wallIndex, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
    const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, pieceSpecLabel: () => '', onChange() {}, onSelect() {} });
    dz.setState(JSON.parse(JSON.stringify(d)));
    const g = dz.geometry();
    const w = g.walls[wallIndex];
    const W = 1400, H = Math.max(650, Math.round(W / dz.aspect()));
    lastCtx = null;
    dz.toImage(W, H);
    const v = dz._fitView(W, H);
    const texts = lastCtx ? lastCtx.texts : [];
    // شارتا المسافة: «255 سم» مرتان على هذا الجدار (يسار/يمين)
    const onWall = texts.filter((x) => x.text === '255 سم').map((x) => dz.wallCoords(w, {
      x: (x.x - v.ox) / v.scale, y: (x.y - v.oy) / v.scale,
    }));
    // الحزام من -WALL_T إلى +WALL_T حول محور الجدار؛ الشارة بارتفاع bhW
    const bhW = (Math.max(9 * Math.max(1.8, W / 720), Math.min(13 * Math.max(1.8, W / 720), v.scale * 0.2)) * 1.7) / v.scale;
    for (const q of onWall) {
      if (q.s - bhW / 2 <= 0.2 + 1e-9) { allClear = false; detail.push('w' + (wallIndex + 1) + ' s=' + q.s.toFixed(3)); }
      if (q.s < 0.34 - 1e-9 || q.s > 1.2) { allInside = false; detail.push('w' + (wallIndex + 1) + ' s=' + q.s.toFixed(3) + '(out of lane)'); }
    }
  }
  t('كل الشرائح خارج حزام الجدار في الاتجاهات الأربعة', allClear, detail.join(', '));
  t('والشرائح كلها داخل ممر الغرفة (0.34م)', allInside, detail.join(', '));
}

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
const out = process.env.PD_OUT;
if (out) fs.writeFileSync(out, report, 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);