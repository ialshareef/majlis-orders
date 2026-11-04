/* اختبار طبقة المواصفات ← أوامر المحرك (js/ai-design-adapter.js):
   - تحويل الأرقام العربية وتطبيع الحدود
   - المخطط الأبيض للمواصفات (لا يمرّ مفتاح خارج العقد)
   - بناء الأوامر (setRoom/فتحات/فرش/إكسسوارات) وحساب مواضع الفتحات
   - التنفيذ على js/designer.js الحقيقي في سياق canvas وهمي (بلا متصفح)
   - فحوص ثابتة لتكامل الواجهة والخادم (أزرار، مسارات، تسجيل الملفات)
   node test/ai-design-adapter-test.mjs */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

function makeCtx() {
  const noop = () => {};
  return {
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, rect: noop, fill: noop, stroke: noop,
    clip: noop, setLineDash: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    drawImage: noop, rotate: noop, ellipse: noop, roundRect: noop,
    fillText() {}, strokeText: noop,
    measureText(s) { return { width: String(s).length * 6 }; },
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
}
function makeCanvas(ctx) {
  return { width: 900, height: 620, getContext: () => ctx, style: {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620, right: 900, bottom: 620 }), toDataURL: () => 'data:image/png;base64,' };
}
const sandbox = {
  console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Map, Set, isNaN, parseFloat, parseInt,
  document: {
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return makeCanvas(makeCtx());
      return { style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620, right: 900, bottom: 620 }) };
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
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/designer.js'), sandbox, { filename: 'designer.js' });
vm.runInContext(read('js/ai-design-adapter.js'), sandbox, { filename: 'ai-design-adapter.js' });
const Designer = sandbox.Designer;
const ad = sandbox.AiDesignAdapter;
if (!Designer || !ad) { console.error('لم يُحمَّل المصمم أو الطبقة'); process.exit(2); }

function newDz() {
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, onChange() {}, onSelect() {}, noOverlap: true, boundAware: true });
  return dz;
}
const CATALOG = [
  { id: 'f1', name: 'كتان بيج', category: 'fabric', w: null, h: null },
  { id: 'fo1', name: 'إسفنج متوسط', category: 'foam' },
  { id: 'a1', name: 'مروحة', category: 'acc', w: 0.5, h: 0.5, shape: 'rect' },
  { id: 's1', name: 'كرسي', category: 'sofa', w: 0.9, h: 0.8 },
];

console.log('== 1) toNum / validateSpec ==');
t('أرقام عربية هندية: ٦٫٥ ← 6.5', ad.toNum('٦٫٥') === 6.5, String(ad.toNum('٦٫٥')));
t('أرقام فارسية: ۱۲ ← 12', ad.toNum('۱۲') === 12, String(ad.toNum('۱۲')));
t('نص غير رقمي ← null', ad.toNum('abc') === null);
t('null/فارغ ← null', ad.toNum(null) === null && ad.toNum('') === null);
t('رقم صحيح يمر كما هو', ad.toNum(7) === 7);

{
  const v = ad.validateSpec({ roomW: '٦', roomH: 4, seating: 'arabic', door: { wall: 1, w: 0.9, distFromCorner: 1, side: 'start' }, evil: {}, price: 99 });
  t('validateSpec ينجح', v.ok === true);
  t('الأرقام العربية تُحوَّل داخل المواصفات', v.spec.roomW === 6);
  t('الباب يأخذ swing و hinge افتراضيين', v.spec.door.swing === 'in' && v.spec.door.hinge === 'right', JSON.stringify(v.spec.door));
  t('المفاتيح خارج العقد تُسقط', !('evil' in v.spec) && !('price' in v.spec), Object.keys(v.spec).join(','));
}
{
  const v = ad.validateSpec({ roomW: 40, roomH: 0.1, seating: 'silky', door: { wall: 9, w: 0.1 }, accessories: [{ name: 'مروحة', qty: '٣' }] });
  t('roomW يُقصّ إلى 30 مع تنبيه', v.spec.roomW === 30 && v.issues.length >= 1, JSON.stringify(v.issues));
  t('roomH يُرفع إلى 0.5', v.spec.roomH === 0.5);
  t('نوع جلسة غير معروف يُسقط مع تنبيه', !v.spec.seating && v.issues.some((x) => /نوع الجلسة/.test(x)), JSON.stringify(v.issues));
  t('باب بجدار 9 يُسقط مع تنبيه', !v.spec.door && v.issues.some((x) => /البيانات|غير مكتملة/.test(x)), JSON.stringify(v.issues));
  t('كمية إكسسوار عربية ← رقم', v.spec.accessories && v.spec.accessories[0].qty === 3, JSON.stringify(v.spec.accessories));
}
{
  const v = ad.validateSpec({ sofaWalls: [0, 0, 5, 2, 'x'], roomW: 6, roomH: 4 });
  t('جدران الكنب: تُنحّى المكررة والخارجية', JSON.stringify(v.spec.sofaWalls) === '[0,2]', JSON.stringify(v.spec.sofaWalls));
  const v2 = ad.validateSpec({ sofaWalls: 'كلها', roomW: 6, roomH: 4 });
  t('sofaWalls غير مصفوفي ← تنبيه', v2.issues.length >= 1, JSON.stringify(v2.issues));
}

console.log('== 2) specReady / openingT / buildOps ==');
t('جاهز بلا مقاس ← false', ad.specReady({ door: { wall: 0 } }) === false);
t('مقاس + باب ← true', ad.specReady({ roomW: 6, roomH: 4, door: { wall: 0 } }) === true);
t('مقاس فقط بلا أي عنصر ← false', ad.specReady({ roomW: 6, roomH: 4, sofaWalls: [] }) === false);
{
  const s = { roomW: 6, roomH: 4 };
  t('t للبداية: 1 + 0.45 ← 1.45', ad.openingT(s, { wall: 0, w: 0.9, distFromCorner: 1, side: 'start' }) === 1.45, String(ad.openingT(s, { wall: 0, w: 0.9, distFromCorner: 1, side: 'start' })));
  t('t للنهاية: 6 − 1 − 0.45 ← 4.55', ad.openingT(s, { wall: 0, w: 0.9, distFromCorner: 1, side: 'end' }) === 4.55, String(ad.openingT(s, { wall: 0, w: 0.9, distFromCorner: 1, side: 'end' })));
  t('بلا مسافة ← وسط الجدار', ad.openingT(s, { wall: 0, w: 1.4, distFromCorner: null, side: 'start' }) === 3);
  t('مسافة أكبر من الجدار ← يُقصّ للنطاق', ad.openingT(s, { wall: 0, w: 1, distFromCorner: 99, side: 'start' }) === 5.5, String(ad.openingT(s, { wall: 0, w: 1, distFromCorner: 99, side: 'start' })));
  t('الجدار الفردي طوله roomH', ad.openingT(s, { wall: 1, w: 0.9, distFromCorner: null, side: 'start' }) === 2);
}
{
  const spec = { roomW: 6, roomH: 4, seating: 'arabic', fabric: ' كتان بيج ', sofaWalls: [0, 1],
    door: { wall: 1, w: 0.9, distFromCorner: 1, side: 'start', swing: 'out', hinge: 'left' },
    accessories: [{ name: 'مروحة', qty: 2 }, { name: 'نيش', qty: 1 }] };
  const built = ad.buildOps(spec, { catalog: CATALOG });
  t('أول أمر setRoom', built.ops[0].op === 'setRoom' && built.ops[0].w === 6, JSON.stringify(built.ops[0]));
  t('القماش يطابق من الكتالوج بالاسم (تبييض)', built.ops.some((o) => o.op === 'fillWalls' && o.fabricId === 'f1'));
  t('الإكسسوار المعروف يتحول إلى أمر setAccessory', built.ops.some((o) => o.op === 'setAccessory' && o.item.id === 'a1' && o.qty === 2));
  t('الإكسسوار المجهول يدخل issues ولا يُبنى', built.issues.some((x) => /نيش/.test(x)) && !built.ops.some((o) => o.op === 'setAccessory' && o.item.name === 'نيش'), JSON.stringify(built.issues));
  t('الباب يحمل swing/hinge المطلوبين', built.ops.some((o) => o.op === 'addOpening' && o.type === 'door' && o.swing === 'out' && o.hinge === 'left'));
  t('فصول الفتحات تُبنى حسب نوعها فقط (لا window)', built.ops.filter((o) => o.op === 'addOpening').map((o) => o.type).join(',') === 'door', JSON.stringify(built.ops.map((o) => o.type)));
}
{
  const built = ad.buildOps({ roomW: 6, roomH: 4, fabric: 'حرير أزرق', foam: 'غير موجود', accessories: [{ name: 'كرسي', qty: 1 }] }, { catalog: CATALOG });
  t('قماش غير موجود ← تحذير لطيف', built.warnings.some((x) => /لم أجد قماشاً/.test(x)), JSON.stringify(built.warnings));
  t('إسفنج غير موجود ← تحذير لطيف', built.warnings.some((x) => /إسفنجاً/.test(x)), JSON.stringify(built.warnings));
  t('صنف فرش ليس إكسسواراً ← تحذير تجاهل', built.warnings.some((x) => /ليس إكسسواراً/.test(x)), JSON.stringify(built.warnings));
}
{
  const built = ad.buildOps({ roomW: 6, roomH: 4 }, { catalog: CATALOG });
  const fill = built.ops.find((o) => o.op === 'fillWalls');
  t('بلا sofaWalls ← كل الجدران', fill && JSON.stringify(fill.walls) === '[0,1,2,3]', JSON.stringify(fill));
}
{
  const built = ad.buildOps({ roomW: 2, roomH: 2, door: { wall: 1, w: 2.5 } }, { catalog: CATALOG });
  const op = built.ops.find((o) => o.op === 'addOpening');
  t('باب أعرض من الجدار ← يُقصّ مع تحذير', op && op.w <= 1.99 && built.warnings.some((x) => /قُصّ/.test(x)), JSON.stringify({ op, w: built.warnings }));
}

console.log('== 3) applyOps على المصمم الحقيقي ==');
{
  const dz = newDz();
  dz.setState(null);
  const spec = {
    roomW: 6, roomH: 4, seating: 'arabic', depth: 0.8, fabric: 'كتان بيج',
    door: { wall: 1, w: 0.9, distFromCorner: 1, side: 'start', swing: 'in', hinge: 'right' },
    tv: { wall: 2, w: 1.4 },
    sofaWalls: [0, 1, 2],
    accessories: [{ name: 'مروحة', qty: 2 }],
  };
  const built = ad.buildOps(spec, { catalog: CATALOG });
  const res = ad.applyOps(dz, built);
  t('validateDesign يمر بلا تعارض', res.valid && res.valid.ok === true, JSON.stringify(res.valid && res.valid.issues));
  t('جدران 6/4/6/4 بعد setRoom', JSON.stringify(dz.state.walls.map((w) => w.len)) === '[6,4,6,4]', JSON.stringify(dz.state.walls.map((w) => w.len)));
  const door = dz.state.openings.find((o) => o.type === 'door');
  const tv = dz.state.openings.find((o) => o.type === 'tv');
  t('الباب على الجدار 1 بموضعه', door && door.wall === 1 && door.w === 0.9 && Math.abs(door.t - 1.45) < 1e-6, JSON.stringify(door));
  t('التلفاز على الجدار 2 في الوسط', tv && tv.wall === 2 && Math.abs(tv.t - 3) < 1e-6 && tv.blocks === true, JSON.stringify(tv));
  const sofas = dz.state.pieces.filter((p) => p.kind === 'sofa');
  t('فرش الجدران المطلوبة وضعت كنبًا (2 فأكثر)', sofas.length >= 2, String(sofas.length));
  t('الكنب على الجدران المطلوبة فقط', sofas.every((p) => [0, 1, 2].includes(p.wall)), JSON.stringify(sofas.map((p) => p.wall)));
  const acc = dz.state.pieces.filter((p) => p.kind === 'acc');
  t('الإكسسوار بعدّاده الحقيقي (2 قطع)', acc.length === 2 && acc.every((p) => p.itemId === 'a1'), String(acc.length));
  t('لا تحذيرات على مواصفات مطابقة', res.warnings.length === 0, JSON.stringify(res.warnings));
  t('حالة قابلة للحفظ وإعادة الفتح', (() => {
    const snap = JSON.parse(JSON.stringify(dz.getState()));
    const dz2 = newDz();
    dz2.setState(snap);
    return dz2.state.openings.length === 2 && dz2.state.pieces.length === sofas.length + acc.length;
  })());
}
{
  const dz = newDz();
  dz.setState(null);
  const built = ad.buildOps({ roomW: 6, roomH: 4, accessories: [{ name: 'شيء مخترع', qty: 1 }] }, { catalog: CATALOG });
  const res = ad.applyOps(dz, built);
  t('إكسسوار مجهول: التصميم يُبنى (valid.ok) مع issue غير مانع',
    res.valid && res.valid.ok === true && res.issues.some((x) => /غير متوفر/.test(x)) && res.ok === false,
    JSON.stringify({ ok: res.ok, issues: res.issues }));
}

console.log('== 4) فحوص ثابتة: تكامل الواجهة والخادم ==');
{
  const pHtml = read('portal.html'), pJs = read('js/portal.js'), aJs = read('js/ai-design.js');
  const wk = read('worker/worker.js'), sw = read('sw.js'), bw = read('build-worker.ps1'), css = read('css/style.css');
  t('portal.html: زر الترحيب #pAiBtn', /id="pAiBtn"/.test(pHtml));
  t('portal.html: زر داخل المصمم #pAiOpen', /id="pAiOpen"/.test(pHtml));
  t('portal.html: أيقونة p-ai معرّفة', /symbol id="p-ai"/.test(pHtml));
  t('portal.html: سكربتا الطبقة والواجهة بعد portal.js', /\/js\/portal\.js"><\/script>\s*<script src="\/js\/ai-design-adapter\.js"><\/script>\s*<script src="\/js\/ai-design\.js"><\/script>/.test(pHtml));
  t('portal.js: خطاف PortalAI معرّف مع applyState', /window\.PortalAI\s*=/.test(pJs) && /applyState:\s*function/.test(pJs));
  t('ai-design.js: زر «إنشاء التصميم»', /إنشاء التصميم/.test(aJs));
  t('ai-design.js: زر «تطبيق التصميم على المصمم»', /تطبيق التصميم على المصمم/.test(aJs));
  t('ai-design.js: مسار الخادم ai-design', /\/api\/portal\/ai-design/.test(aJs));
  t('worker.js: المسار مسجّل في التوجيه', /path === '\/api\/portal\/ai-design' && method === 'POST'/.test(wk));
  t('worker.js: checkDesign يقبل التلفاز', /\['door', 'window', 'mashab', 'tv'\]\.includes\(o\.type\)/.test(wk));
  t('worker.js: علم aiDesign في إعدادات البوابة', /aiDesign:\s*\{\s*enabled:/.test(wk));
  t('worker.js: حدّ الطلبات والتعقيم موجودان', /AI_RATE_LIMIT/.test(wk) && /aiSanitizeModelOut/.test(wk));
  t('sw.js: الملفان في ASSETS مع CACHE جديد', /ai-design-adapter\.js/.test(sw) && /ai-design\.js/.test(sw) && (+((sw.match(/majlis-v(\d+)/) || [])[1]) >= 7));
  t('build-worker.ps1: الملفان في قائمة البناء', /ai-design-adapter\.js/.test(bw) && /ai-design\.js/.test(bw));
  t('style.css: أنماط .ai-card موجودة', /\.ai-card/.test(css));
  t('لا مفتاح مزوّد مكتوب في أي ملف واجهة', !/sk-[A-Za-z0-9]{8,}/.test(pHtml + pJs + aJs + css));
}

console.log('');
console.log('PASS=' + pass + ' FAIL=' + fail);
if (fail) console.log(lines.filter((l) => l.startsWith('FAIL')).join('\n'));
process.exit(fail ? 1 : 0);
