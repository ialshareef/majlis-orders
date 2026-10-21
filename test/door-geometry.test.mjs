/* شكل الباب المفتوح — استعادة الرسم القديم (الضلفة عمودية على الجدار +
   قوس ربع دائرة إلى الحافة الثانية) مع بقاء خيارات الاتجاه الأربع.

   يشغّل js/designer.js الحقيقي بسياق canvas مسجِّل ويميّز خطوط الباب
   (strokeStyle #8a5a2b) ويقيسها رقمياً — لا مقارنة نصوص ولا بصمات:
     - الضلفة: من المفصلة إلى المفصلة + عمق×العرض، عمودية على الجدار تماماً
     - القوس: مركزه المفصلة، نصف قطره = عرض الفتحة بالبكسل، من الضلفة إلى
       الحافة الثانية
   الصيغة المرجعية «القديمة» (قبل 4fdbad3): hinge=pA leaf=pA+w.n×o.w arc→pB.

   node test/door-geometry.test.mjs                                        */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'designer.js'), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

/* ---------- canvas مسجِّل ---------- */
function makeRecCtx() {
  const rec = { strokes: [] };
  let cur = null, dash = [];
  const noop = () => {};
  const ctx = {
    _rec: rec,
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop, rotate: noop,
    beginPath() { cur = { ops: [] }; },
    closePath() { if (cur) cur.ops.push(['z']); },
    moveTo(x, y) { if (cur) cur.ops.push(['m', x, y]); },
    lineTo(x, y) { if (cur) cur.ops.push(['l', x, y]); },
    arc(x, y, r, a0, a1, ccw) { if (cur) cur.ops.push(['a', x, y, r, a0, a1, !!ccw]); },
    arcTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop, rect: noop, ellipse: noop, roundRect: noop,
    fill: noop,
    stroke() { if (cur) { cur.strokeStyle = ctx.strokeStyle; cur.dash = dash.slice(); rec.strokes.push(cur); cur = null; } },
    clip: noop, setLineDash(d) { dash = d || []; }, clearRect: noop, fillRect: noop, strokeRect: noop,
    drawImage: noop, fillText() {}, strokeText: noop,
    measureText(s) { return { width: String(s).length * 6 }; },
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return ctx;
}
const makeCanvas = (ctx) => {
  const c = {
    width: 900, height: 620, getContext: () => ctx, style: {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620, right: 900, bottom: 620 }),
    toDataURL: () => 'data:image/png;base64,',
  };
  c._rec = ctx._rec;
  return c;
};

let ctx;
const sandbox = {
  console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Map, Set, isNaN, parseFloat, parseInt, Promise, RegExp,
  document: {
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return makeCanvas(makeRecCtx());
      return { style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620 }) };
    },
    addEventListener() {}, body: { appendChild() {} },
    fonts: { ready: Promise.resolve() },
  },
  navigator: { userAgent: 'node' },
  devicePixelRatio: 1,
  requestAnimationFrame: (f) => f(),
  Image: function Image() {},
  Path2D: function Path2D() { this.moveTo = () => {}; this.lineTo = () => {}; this.arc = () => {}; this.closePath = () => {}; this.rect = () => {}; this.addPath = () => {}; },
  DOMMatrix: function DOMMatrix() {},
  OffscreenCanvas: function OffscreenCanvas() { return makeCanvas(makeRecCtx()); },
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

function mkDesign(w, h, openings) {
  const dz = new Designer(makeCanvas(makeRecCtx()), { getItem: () => null, onChange() {}, onSelect() {}, noOverlap: true });
  dz.setState({
    roomDims: { w, h },
    walls: [{ len: w, angle: 0 }, { len: h, angle: 90 }, { len: w, angle: 180 }, { len: h, angle: 270 }],
    openings: (openings || []).map((o, i) => Object.assign({ id: 'o' + i }, o)),
    pieces: [], cornerMode: 'deduct',
  });
  return dz;
}

const DOOR_COLOR = '#8a5a2b';
const EPS = 1e-6;
const close = (a, b, e = EPS) => Math.abs(a - b) <= e;
const closePt = (p, q, e = 1e-5) => close(p.x, q.x, e) && close(p.y, q.y, e);
const normAng = (d) => { let x = d; while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return x; };

/** يرسم ويستخرج خطوط الباب (الضلفة m+l، والقوس a) بالبكسل */
function drawDoor(dz) {
  dz.render();
  const rec = dz.canvas._rec;
  const door = rec.strokes.filter((s) => s.strokeStyle === DOOR_COLOR);
  const leaf = door.find((s) => s.ops.some((o) => o[0] === 'm') && s.ops.some((o) => o[0] === 'l') && !s.ops.some((o) => o[0] === 'a'));
  const arc = door.find((s) => s.ops.some((o) => o[0] === 'a'));
  return { leaf, arc, all: door };
}

/* ---------- الحالات ---------- */
const W = 6, H = 4, T = 3, DW = 0.9;

function geomOf(dz) {
  const g = dz.geometry();
  const w = g.walls[0];
  const t0 = T - DW / 2, t1 = T + DW / 2;
  const pA = { x: w.A.x + w.dir.x * t0, y: w.A.y + w.dir.y * t0 };
  const pB = { x: w.A.x + w.dir.x * t1, y: w.A.y + w.dir.y * t1 };
  return { w, pA, pB };
}

console.log('== الافتراضي (يمين + للداخل) = الصيغة القديمة حرفياً ==');
{
  const dz = mkDesign(W, H, [{ wall: 0, t: T, w: DW, type: 'door', blocks: true }]);
  const { leaf, arc } = drawDoor(dz);
  t('الضلفة والقوس مرسومان بلون الباب', !!leaf && !!arc, 'leaf=' + !!leaf + ' arc=' + !!arc);
  const { w, pA, pB } = geomOf(dz);
  const S = dz.view.scale, to = (p) => dz.toScreen(p.x, p.y);
  const hPx = to(pA);
  const leafEndW = { x: pA.x + w.n.x * DW, y: pA.y + w.n.y * DW };
  const m = leaf.ops.find((o) => o[0] === 'm'), l = leaf.ops.find((o) => o[0] === 'l');
  t('الضلفة تبدأ عند pA (المفصلة القديمة)', closePt({ x: m[1], y: m[2] }, hPx), JSON.stringify({ got: [m[1], m[2]], exp: [hPx.x, hPx.y] }));
  t('الضلفة تنتهي عند pA + w.n×العرض (عمودية للداخل)', closePt({ x: l[1], y: l[2] }, to(leafEndW)), JSON.stringify({ got: [l[1], l[2]], exp: to(leafEndW) }));
  const a = arc.ops.find((o) => o[0] === 'a');
  t('مركز القوس = المفصلة', close(a[1], hPx.x) && close(a[2], hPx.y));
  t('نصف قطر القوس = عرض الفتحة بالبكسل', close(a[3], DW * S), 'r=' + a[3] + ' exp=' + DW * S);
  const lv = { x: l[1] - m[1], y: l[2] - m[2] };
  const a0exp = Math.atan2(lv.y, lv.x);
  const fv = { x: to(pB).x - hPx.x, y: to(pB).y - hPx.y };
  const a1exp = Math.atan2(fv.y, fv.x);
  t('زاوية بداية القوس = اتجاه الضلفة', close(a[4], a0exp), a[4] + ' vs ' + a0exp);
  t('زاوية نهاية القوس = اتجاه الحافة الثانية (pB)', close(a[5], a1exp), a[5] + ' vs ' + a1exp);
  const dexp = normAng(a1exp - a0exp);
  t('القوس ربع دائرة (90°) بالاتجاه الصحيح', close(Math.abs(dexp), Math.PI / 2) && a[6] === (dexp < 0), 'd=' + dexp + ' ccw=' + a[6]);
  t('القوس متقطّع (خط الفتح)', arc.dash.length > 0, JSON.stringify(arc.dash));
  // العمودية: لا أثر لاتجاه الجدار في الضلفة
  const dirPx = { x: to({ x: pA.x + w.dir.x, y: pA.y + w.dir.y }).x - hPx.x, y: to({ x: pA.x + w.dir.x, y: pA.y + w.dir.y }).y - hPx.y };
  const dot = lv.x * dirPx.x + lv.y * dirPx.y;
  const lenL = Math.hypot(lv.x, lv.y), lenD = Math.hypot(dirPx.x, dirPx.y);
  t('الضلفة عمودية على الجدار (الزاوية الحادة ممنوعة)', Math.abs(dot / (lenL * lenD)) < 1e-9, 'cos=' + dot / (lenL * lenD));
  t('طول الضلفة = عرض الفتحة (لا قطرية √2)', close(lenL, DW * S), 'len=' + lenL + ' exp=' + DW * S);
}

console.log('== القيمة الافتراضية بلا الحقلين = يمين + للداخل (طلبات قديمة) ==');
{
  const dzOld = mkDesign(W, H, [{ wall: 0, t: T, w: DW, type: 'door' }]);
  const dzNew = mkDesign(W, H, [{ wall: 0, t: T, w: DW, type: 'door', hinge: 'right', swing: 'in' }]);
  const a = drawDoor(dzOld), b = drawDoor(dzNew);
  const ops = (d) => JSON.stringify([...d.leaf.ops, ...d.arc.ops].map((o) => o.map((v) => typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));
  t('الطلب القديم بلا حقلين يُرسم كـ يمين+داخل', ops(a) === ops(b), ops(a).slice(0, 80) + ' vs ' + ops(b).slice(0, 80));
}

console.log('== الحالات الأربع: موضع المفصلة والضلفة داخل/خارج ==');
{
  for (const [hinge, swing] of [['right', 'in'], ['right', 'out'], ['left', 'in'], ['left', 'out']]) {
    const tag = hinge + '+' + swing;
    const dz = mkDesign(W, H, [{ wall: 0, t: T, w: DW, type: 'door', hinge, swing }]);
    const { leaf, arc } = drawDoor(dz);
    const { w, pA, pB } = geomOf(dz);
    const to = (p) => dz.toScreen(p.x, p.y);
    const hingeW = hinge === 'left' ? pB : pA;
    const farW = hinge === 'left' ? pA : pB;
    const depth = swing === 'out' ? { x: -w.n.x, y: -w.n.y } : w.n;
    const m = leaf.ops.find((o) => o[0] === 'm'), l = leaf.ops.find((o) => o[0] === 'l');
    t(tag + ' المفصلة على الحافة الصحيحة', closePt({ x: m[1], y: m[2] }, to(hingeW), 1e-5), JSON.stringify({ got: [m[1], m[2]], exp: to(hingeW) }));
    t(tag + ' الضلفة عمودية بعمق الاتجاه', closePt({ x: l[1], y: l[2] }, to({ x: hingeW.x + depth.x * DW, y: hingeW.y + depth.y * DW }), 1e-5));
    const a = arc.ops.find((o) => o[0] === 'a');
    const fv = { x: to(farW).x - m[1], y: to(farW).y - m[2] };
    t(tag + ' القوس ينتهي عند الحافة الثانية', close(a[5], Math.atan2(fv.y, fv.x)), a[5] + ' vs ' + Math.atan2(fv.y, fv.x));
    t(tag + ' القوس ربع دائرة', close(a[3], DW * dz.view.scale));
  }
}

console.log('== قاعدة جدارية ثانية (عمودي): نفس الهندسة ==');
{
  const dz = mkDesign(W, H, [{ wall: 1, t: 2, w: DW, type: 'door' }]);
  const { leaf, arc } = drawDoor(dz);
  const g = dz.geometry();
  const w = g.walls[1];
  const t0 = 2 - DW / 2, t1 = 2 + DW / 2;
  const pA = { x: w.A.x + w.dir.x * t0, y: w.A.y + w.dir.y * t0 };
  const pB = { x: w.A.x + w.dir.x * t1, y: w.A.y + w.dir.y * t1 };
  const to = (p) => dz.toScreen(p.x, p.y);
  const m = leaf.ops.find((o) => o[0] === 'm'), l = leaf.ops.find((o) => o[0] === 'l');
  t('جدار 1: الضلفة من pA عمودياً', closePt({ x: m[1], y: m[2] }, to(pA), 1e-5) && closePt({ x: l[1], y: l[2] }, to({ x: pA.x + w.n.x * DW, y: pA.y + w.n.y * DW }), 1e-5));
  const a = arc.ops.find((o) => o[0] === 'a');
  t('جدار 1: القوس من الضلفة إلى pB', close(a[5], Math.atan2(to(pB).y - m[2], to(pB).x - m[1])));
}

/* ---------- النتيجة ---------- */
const report = lines.join('\n') + '\n\n=== النتيجة: PASS=' + pass + '  FAIL=' + fail + ' ===';
console.log(report);
process.exit(fail ? 1 : 0);
