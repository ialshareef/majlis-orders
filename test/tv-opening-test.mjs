/* اختبار «التلفاز» و«الشباك» — العنصران المعماريان الجديدان:
   - إضافة التلفاز من واجهة الموظف ومن واجهة العميل (وواجهة النسخة الموسّعة)
   - كنبة أمام التلفاز ممنوعة (نظام مناطق المنع) وفي مكان آخر مسموحة
   - الشباك متاح للعميل ويُسمح بالأثاث أمامه
   - الحفظ وإعادة الفتح: الفتحة وعلم المنع يبقيان كما هما
   - الرسم في المخطط وفي نص PDF: كلا العنصرين ظاهران
   يشغّل js/designer.js الحقيقي في سياق canvas وهمي (بلا متصفح وبلا حزم).

   node test/tv-opening-test.mjs                                                */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = read(path.join('js', 'designer.js'));

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

function newDz() {
  const dz = new Designer(makeCanvas(makeCtx()), { getItem: () => null, onChange() {}, onSelect() {}, noOverlap: true });
  dz.setState(Designer.emptyState(6, 4));
  return dz;
}
const at = (dz, wi, t0, dep) => {
  const w = dz.geometry().walls[wi];
  return { x: w.A.x + w.dir.x * t0 + w.n.x * dep, y: w.A.y + w.dir.y * t0 + w.n.y * dep };
};
const sofaAt = (id, pt, extra) => Object.assign({ id, kind: 'sofa', w: 1.6, h: 0.8, rot: 0, x: pt.x, y: pt.y }, extra || {});

console.log('== 1) إضافة التلفاز: أزرار الواجهات الثلاث ==');
{
  const idx = read('index.html'), app = read('js/app.js');
  t('الموظف: زر tbAddTv في الشريط', /id="tbAddTv"/.test(idx));
  t('الموظف: أيقونة i-tv معرّفة', /symbol id="i-tv"/.test(idx) && /use href="#i-tv"/.test(idx));
  t('الموظف: زر الشباك tbAddWindow موجود', /id="tbAddWindow"/.test(idx));
  t('الموظف: معالج النقر لـ tbAddTv', /\$\('#tbAddTv'\)\.addEventListener\('click'/.test(app));
  t('الموظف: زر التلفاز في خصائص الجدار', /data-act="tv"/.test(app));
  t('الموظف: خيار «تلفاز» في قائمة النوع', /<option value="tv" /.test(app));
  t('الموظف: إضافة من لوحة خصائص الجدار', /addOpening\(i, 'tv'\)/.test(app));

  const pHtml = read('portal.html'), pJs = read('js/portal.js');
  t('العميل: أيقونة p-tv وp-window معرّفتان', /symbol id="p-tv"/.test(pHtml) && /symbol id="p-window"/.test(pHtml));
  t('العميل: زر إضافة تلفاز', /data-add="tv"/.test(pJs));
  t('العميل: زر إضافة شباك', /data-add="window"/.test(pJs));
  t('العميل: استخدام الأيقونة p-tv', /use href="#p-tv"/.test(pJs));

  const xHtml = read('portal-expanded.html'), xJs = read('js/portal-expanded.js');
  t('الموسّعة: أيقونتا x-tv وx-window', /symbol id="x-tv"/.test(xHtml) && /symbol id="x-window"/.test(xHtml));
  t('الموسّعة: زرا تلفاز وشباك', /data-add="tv"/.test(xJs) && /data-add="window"/.test(xJs));
  t('الموسّعة: لا يبقى خيار عامود في واجهة العميل', !/data-add="column"/.test(pJs) && !/data-add="column"/.test(xJs));
}

console.log('== 2) المحرك: إضافة التلفاز والشباك ==');
{
  const dz = newDz();
  const tv = dz.addOpening(0, 'tv');
  t('التلفاز يُضاف بنوعه', tv && tv.type === 'tv', JSON.stringify(tv));
  t('التلفاز مانع افتراضياً (blocks)', tv && tv.blocks === true, String(tv && tv.blocks));
  t('عرضه الافتراضي 1.4م (طاولة تلفاز)', tv && Math.abs(tv.w - 1.4) < 1e-6, String(tv && tv.w));
  t('عمقه صفر (يرسم بالارتفاع لا بالعمق)', tv && Number(tv.depth || 0) === 0, String(tv && tv.depth));
  t('عمق منع التلفاز 0.8م', Designer.OPENING_USE_DEPTH({ type: 'tv' }) === 0.8);
  t('مساحة المنع تُحسب للمشب لا للتلفاز', Designer.OPENING_USE_DEPTH({ type: 'mashab', depth: 0.5 }) >= 0.6);

  const win = dz.addOpening(2, 'window');
  t('الشباك يُضاف بنوعه', win && win.type === 'window', JSON.stringify(win));
  t('الشباك لا يمنع (blocks=false)', win && win.blocks === false, String(win && win.blocks));
  t('عرض الشباك الافتراضي 1.2م', win && Math.abs(win.w - 1.2) < 1e-6, String(win && win.w));
  t('allowlist يقبل التلفاز', ['door', 'window', 'mashab', 'tv'].includes(tv.type));

  const dz2 = newDz();
  const op = dz2.addOpening(0, 'door');
  dz2.updateOpening(op.id, { type: 'tv' });
  t('تحويل باب ← تلفاز عبر الخصائص', dz2.state.openings[0].type === 'tv', dz2.state.openings[0].type);
}

console.log('== 3) لا كنب أمام التلفاز، وفي مكان آخر نعم ==');
{
  const dz = newDz();
  const tv = dz.addOpening(0, 'tv');
  const front = sofaAt('s-front', at(dz, 0, tv.t, 0.4));
  t('كنبة أمام التلفاز ممنوعة', dz.canPlace(front) === false, JSON.stringify(at(dz, 0, tv.t, 0.4)));
  const v = dz.validatePlacement(front);
  t('سبب المنع: الفتحة', v && v.ok === false && v.why === 'opening', JSON.stringify(v && v.why));
  t('والفتحة هي التلفاز', v && v.opening && v.opening.type === 'tv', v && v.opening && v.opening.type);
  const rot = sofaAt('s-rot', at(dz, 0, tv.t, 0.4), { w: 0.8, h: 2, rot: 90 });
  t('كنبة مدوّرة 90° أمام التلفاز ممنوعة', dz.canPlace(rot) === false);
  const deep = sofaAt('s-deep', at(dz, 0, tv.t, 1.6));
  t('كنبة خلف حدّ المشاهدة (1.6م) مسموحة', dz.canPlace(deep) === true);
  const beside = sofaAt('s-side', at(dz, 0, tv.t + 2.2, 0.4));
  t('كنبة بجانب التلفاز مسموحة', dz.canPlace(beside) === true);
  const placed = sofaAt('s-put', at(dz, 0, tv.t, 0.4));
  dz.state.pieces.push(placed);
  const issue = dz.validateDesign().issues.filter((i) => i.type === 'opening' && i.openingType === 'tv');
  t('validateDesign تذكر التلفاز المسدود', issue.length >= 1, String(issue.length));
}

console.log('== 4) الشباك: يُضاف ثم يُوضع الأثاث أمامه بنجاح ==');
{
  const dz = newDz();
  const w = dz.addOpening(1, 'window');
  const front = sofaAt('w-front', at(dz, 1, w.t, 0.4));
  t('كنبة أمام الشباك مسموحة', dz.canPlace(front) === true);
  t('لا تصطدم بمنطقة الشباك', dz.hitsOpening(front) === null);
  t('نطاق المنع لا يحوي الشباك', dz.openingBlockRects().every((b) => b.type !== 'window'),
    JSON.stringify(dz.openingBlockRects().map((b) => b.type)));
  const issues = dz.validateDesign().issues.filter((i) => i.type === 'opening');
  t('validateDesign لا ترفض الشباك', issues.length === 0, JSON.stringify(issues));
  // كنبة أمام الشباك على الجدار نفسه ثم باب على جدار آخر: الاثنان معًا
  const dz2 = newDz();
  const d = dz2.addOpening(0, 'door'), w2 = dz2.addOpening(1, 'window');
  t('باب أمامه ممنوع + شباك أمامه مسموح في التصميم نفسه',
    dz2.canPlace(sofaAt('a', at(dz2, 0, d.t, 0.4))) === false
    && dz2.canPlace(sofaAt('b', at(dz2, 1, w2.t, 0.4))) === true);
}

console.log('== 5) الحفظ وإعادة الفتح ==');
{
  const dz = newDz();
  const tv = dz.addOpening(0, 'tv');
  const w = dz.addOpening(2, 'window');
  const snap = JSON.parse(JSON.stringify(dz.getState()));
  t('الحفظ يتضمّن التلفاز', snap.openings.some((o) => o.type === 'tv' && o.blocks === true));
  t('الحفظ يتضمّن الشباك بلا منع', snap.openings.some((o) => o.type === 'window' && o.blocks === false));

  const dz2 = new Designer(makeCanvas(makeCtx()), { getItem: () => null, onChange() {}, onSelect() {}, noOverlap: true });
  dz2.setState(snap);
  const tv2 = dz2.state.openings.find((o) => o.type === 'tv');
  const w2 = dz2.state.openings.find((o) => o.type === 'window');
  t('إعادة الفتح تحافظ على النوع والعرض والعمق',
    tv2 && tv2.w === tv.w && tv2.t === tv.t && tv2.blocks === true && w2 && w2.blocks === false,
    JSON.stringify({ tv2, w2 }));
  t('بعد إعادة الفتح: أمام التلفاز ما زال ممنوعاً',
    dz2.canPlace(sofaAt('r1', at(dz2, 0, tv2.t, 0.4))) === false);
  t('بعد إعادة الفتح: أمام الشباك ما زال مسموحاً',
    dz2.canPlace(sofaAt('r2', at(dz2, 2, w2.t, 0.4))) === true);
}

console.log('== 6) الرسم في المخطط وفي PDF ==');
{
  const dz = newDz();
  dz.addOpening(0, 'tv');
  dz.addOpening(1, 'window');
  dz.addOpening(2, 'door');
  dz.addOpening(3, 'mashab');
  let drew = true, err = '';
  try { dz.render(); dz.toImage(800, 500); } catch (e) { drew = false; err = e.message; }
  t('رسم غرفة فيها تلفاز وشباك وباب ومشب بلا خطأ', drew, err);

  const app = read('js/app.js');
  t('نص أمر التصنيع يذكر التلفاز', /o\.type === 'tv' \? 'التلفاز'/.test(app));
  t('حقائق تصميم الموظف تعدّ التلفاز', /o\.type === 'tv'\) tvs\+\+/.test(app) && /tvs, meters/.test(app));

  const pJs = read('js/portal.js');
  t('ورقة معاينة العميل تعرض «التلفاز»', /\['التلفاز',/.test(pJs));
  t('ورقة معاينة العميل تعرض «الشباك»', /\['الشباك',/.test(pJs));

  const xJs = read('js/portal-expanded.js');
  t('ملخص النسخة الموسّعة يذكر التلفاز والشباك', /أبواب \/ شبابيك \/ مشب \/ تلفاز/.test(xJs) && /sum\.tvs/.test(xJs));

  const ds = read('js/design-sheet.js');
  t('ورقة التصميم تعدّ التلفاز في حقائقها', /o\.type === 'tv'\) tvs\+\+/.test(ds));

  const dsg = read('js/designer.js');
  t('شارة القياس تُرسم للباب والمشب والتلفاز (الشباك وحده مستثنى)',
    (dsg.match(/o\.type === 'window'\) continue/g) || []).length >= 1);
  t('تسمية التلفاز عند التحديد', /o\.type === 'tv' \? 'تلفاز' : 'شباك'\) \+ ' ' \+ round\(o\.w, 2\)/.test(dsg));
  t('رسالة المنع تذكر التلفاز', /لا يمكن وضع الكنبة أمام الباب أو المشب أو التلفاز/.test(dsg));
  t('فرع رسم التلفاز موجود في المخطط', /else if \(o\.type === 'tv'\)/.test(dsg));
}

console.log('');
console.log('PASS=' + pass + ' FAIL=' + fail);
if (fail) console.log(lines.filter((l) => l.startsWith('FAIL')).join('\n'));
process.exit(fail ? 1 : 0);
