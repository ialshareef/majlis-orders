/* اختبار مرونة «فرش الكل» بجانب الأبواب والمشب — يشغّل js/designer.js
   الحقيقي في سياق canvas وهمي (بلا متصفح وبلا حزم):
   - جدار عليه باب/مشب يُفرش بجانبهما (لا يُستبعد بالكامل)
   - لا قطعة فوق منطقة استخدام فتحة، ولا تداخل بين القطع
   - الأبواب والمشب لا تُحذف ولا تتحرك بالفرش
   - القطعة الموضوعة قابلة للتحديد والحذف والتعديل يدوياً
   - عدد الجدران لا يتغير بالفرش

   node test/fill-flex-test.mjs                                                */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'designer.js'), 'utf8');

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
vm.runInContext(src, sandbox, { filename: 'designer.js' });
const Designer = sandbox.Designer;
if (!Designer) { console.error('Designer لم يُحمَّل'); process.exit(2); }

const SPEC = { depth: 0.8, seating: 'floor' };
function mkDesign(w, h, openings) {
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, onChange() {}, onSelect() {}, noOverlap: true });
  dz.setState({
    roomDims: { w, h },
    walls: [{ len: w, angle: 0 }, { len: h, angle: 90 }, { len: w, angle: 180 }, { len: h, angle: 270 }],
    openings: (openings || []).map((o, i) => Object.assign({ id: 'o' + i }, o)),
    pieces: [], cornerMode: 'deduct',
  });
  return dz;
}
const sofas = (dz) => dz.state.pieces.filter((p) => p.kind === 'sofa');
function pairs(dz) {
  const ps = sofas(dz);
  let n = 0;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    if (Designer.polysOverlap(dz.corners(ps[i]), dz.corners(ps[j]))) n++;
  }
  return n;
}
const hitsAny = (dz) => sofas(dz).filter((p) => dz.hitsOpening(p));

console.log('== 1) غرفة فارغة 6×4: السلوك الكامل كما كان ==');
{
  const dz = mkDesign(6, 4, []);
  const n = dz.fillAllWalls(SPEC);
  t('أربع كنبات', n === 4 && sofas(dz).length === 4, 'n=' + n);
  t('بلا تداخل', pairs(dz) === 0, 'pairs=' + pairs(dz));
  t('كل جدار عليه كنبة', [0, 1, 2, 3].every((w) => sofas(dz).some((p) => p.wall === w)));
  t('عدد الجدران ثابت', dz.state.walls.length === 4);
}

console.log('== 2) باب على الجدار الأول: يُفرش بجانبه لا يُستبعد ==');
{
  const dz = mkDesign(6, 4, [{ wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  const n = dz.fillAllWalls(SPEC);
  t('الجدار صاحب الباب مفروش', sofas(dz).some((p) => p.wall === 0), 'wall0=' + sofas(dz).filter((p) => p.wall === 0).length);
  t('الأربعة مفروشة', n === 4, 'n=' + n + ' skipped=' + JSON.stringify(dz.lastFill.skipped));
  t('بلا تداخل', pairs(dz) === 0, 'pairs=' + pairs(dz));
  t('لا كنبة فوق منطقة الباب', hitsAny(dz).length === 0, JSON.stringify(hitsAny(dz).map((p) => p.id)));
  t('الباب لم يُحذف ولم يتحرك', dz.state.openings.length === 1 && dz.state.openings[0].t === 3);
}

console.log('== 3) باب + مشب على جدارين: الكل مفروش ==');
{
  const dz = mkDesign(6, 4, [
    { wall: 0, t: 1.5, w: 0.9, h: 2.1, type: 'door' },
    { wall: 1, t: 2, w: 0.6, h: 1.2, type: 'mashab', depth: 0.5 },
  ]);
  const n = dz.fillAllWalls(SPEC);
  t('الأربعة مفروشة مع باب ومشب', n === 4, 'n=' + n + ' skipped=' + JSON.stringify(dz.lastFill.skipped));
  t('بلا تداخل', pairs(dz) === 0, 'pairs=' + pairs(dz));
  t('لا كنبة فوق منطقة فتحة', hitsAny(dz).length === 0);
  t('الفتحتان سليمتان', dz.state.openings.length === 2);
}

console.log('== 4) غرفة ضيقة 4×2.5 بباب: فرش مرن لا إلغاء ==');
{
  const dz = mkDesign(4, 2.5, [{ wall: 0, t: 2, w: 0.9, h: 2.1, type: 'door' }]);
  const n = dz.fillAllWalls(SPEC);
  const placed = sofas(dz);
  t('وُضع شيء ما (لا إلغاء كامل)', n >= 1, 'n=' + n);
  t('كل الموضوع صالح هندسياً', placed.every((p) => !dz.hitsOpening(p)) && pairs(dz) === 0,
    'hits=' + hitsAny(dz).length + ' pairs=' + pairs(dz));
  t('الباب سليم', dz.state.openings.length === 1);
  t('تقرير lastFill موجود', dz.lastFill && typeof dz.lastFill.added === 'number' && Array.isArray(dz.lastFill.skipped));
}

console.log('== 5) القطعة الموضوعة قابلة للتعديل اليدوي ==');
{
  const dz = mkDesign(6, 4, [{ wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  dz.fillAllWalls(SPEC);
  const p = sofas(dz).find((x) => x.wall === 0);
  t('توجد كنبة على جدار الباب', !!p);
  dz.select({ type: 'piece', id: p.id });
  const w0 = p.w;
  dz.updateSelected({ w: Math.max(0.5, w0 - 0.5) });
  t('التقصير اليدوي يعمل', Math.abs(p.w - (w0 - 0.5)) < 0.01, 'w=' + w0 + '->' + p.w);
  const id = p.id;
  dz.select({ type: 'piece', id });
  dz.removeSelected();
  t('الحذف اليدوي يعمل', !dz.state.pieces.some((x) => x.id === id));
  t('الباب ما زال موجوداً بعد التعديلات', dz.state.openings.length === 1);
}

console.log('== 6) الفرش لا يغيّر عدد الجدران ولا الأبعاد ==');
{
  const dz = mkDesign(5, 4, [{ wall: 2, t: 2.5, w: 1, h: 2.1, type: 'door' }]);
  dz.fillAllWalls(SPEC);
  t('أربعة جدران', dz.state.walls.length === 4);
  t('الأطوال كما هي', dz.state.walls.map((w) => w.len).join(',') === '5,4,5,4', dz.state.walls.map((w) => w.len).join(','));
}

console.log('== 7) عدد الجدران ثابت بعد التعديل والحفظ وإعادة الفتح ==');
{
  const dz = mkDesign(6, 4, [{ wall: 0, t: 3, w: 0.9, h: 2.1, type: 'door' }]);
  // تعديل الأبعاد عدة مرات + تحريك الباب + تغيير طول جدار + فرش
  dz.setRoomDims(7, 5);
  dz.setRoomDims(6, 4);
  dz.updateOpening('o0', { t: 2 });
  dz.setWallLength(1, 4.5, 'second');
  dz.fillAllWalls(SPEC);
  t('أربعة جدران بعد كل التعديلات', dz.state.walls.length === 4, dz.state.walls.length);
  t('الباب على جداره', dz.state.openings.length === 1 && dz.state.openings[0].wall === 0);
  // حفظ وإعادة فتح: التسلسل الكامل عبر JSON
  const saved = JSON.parse(JSON.stringify(dz.getState()));
  const dz2 = new Designer(makeCanvas(makeCtx()), { getItem: () => null, onChange() {}, onSelect() {}, noOverlap: true });
  dz2.setState(saved);
  t('بعد إعادة الفتح: أربعة جدران', dz2.state.walls.length === 4);
  t('بعد إعادة الفتح: الباب والقطع محفوظة', dz2.state.openings.length === 1 && dz2.state.pieces.length === dz.state.pieces.length,
    'op=' + dz2.state.openings.length + ' pieces=' + dz2.state.pieces.length);
  t('بعد إعادة الفتح: بلا تداخل', pairs(dz2) === 0);
}

console.log('== 8) الغرفة المخصصة (5 جدران) لا تُهدم بتعديل الأبعاد ==');
{
  // addWall ميزة صريحة ومدعومة باختبار R-custom-kept: المحرك يحافظ عليها
  const dz = mkDesign(6, 4, []);
  dz.addWall(2, 45);
  t('جدار خامس مضاف صراحة', dz.state.walls.length === 5);
  dz.setRoomDims(7, 5);
  t('الخمسة باقية بعد تعديل الأبعاد', dz.state.walls.length === 5, dz.state.walls.length);
  dz.fillAllWalls(SPEC);
  t('الفرش يعمل على المخصصة بلا تداخل', pairs(dz) === 0, 'sofas=' + sofas(dz).length);
}

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
const out = process.env.FF_OUT;
if (out) fs.writeFileSync(out, report, 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
