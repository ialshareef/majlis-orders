/* اختبار هندسة الجولة التفاعلية — يستخرج الدوال الخالصة من js/help.js
   (نفس المصدر لا نسخة موازية) ويتحقق من:
   - شرائط التعتيم الأربع تغطي الشاشة تماماً حول الفتحة بلا فجوات ولا تداخل
   - موضع البطاقة: تحت الهدف أولاً، ثم فوقه، ثم بجانبه، محصور داخل الشاشة
   - جهة السهم صحيحة لكل موضع

   node test/spotlight-tour-test.mjs                                          */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'help.js'), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

function grab(re, name) {
  const m = src.match(re);
  if (!m) { console.error('missing ' + name); process.exit(2); }
  return m[0];
}
const clampN = new Function(grab(/function clampN\(v, a, b\) \{[\s\S]*?\n  \}/, 'clampN') + '; return clampN;')();
const spotLanes = new Function('clampN', grab(/function spotLanes\(r, vw, vh\) \{[\s\S]*?\n  \}/, 'spotLanes') + '; return spotLanes;')(clampN);
const placeCard = new Function('clampN', grab(/function placeCard\(r, vw, vh, cw, ch\) \{[\s\S]*?\n  \}/, 'placeCard') + '; return placeCard;')(clampN);

console.log('== 1) clampN ==');
t('داخل المجال', clampN(5, 0, 10) === 5);
t('حصر أدنى', clampN(-3, 0, 10) === 0);
t('حصر أقصى', clampN(15, 0, 10) === 10);

console.log('== 2) spotLanes: تغطية كاملة حول الفتحة ==');
function coverCheck(vw, vh, r, label) {
  const L = spotLanes(r, vw, vh);
  const area = (q) => Math.max(0, q.w) * Math.max(0, q.h);
  const hole = { x: Math.min(Math.max(r.x, 0), vw), y: Math.min(Math.max(r.y, 0), vh) };
  hole.w = Math.min(Math.max(r.x + r.w, 0), vw) - hole.x;
  hole.h = Math.min(Math.max(r.y + r.h, 0), vh) - hole.y;
  const total = area(L.top) + area(L.bottom) + area(L.left) + area(L.right);
  const want = vw * vh - Math.max(0, hole.w) * Math.max(0, hole.h);
  t(label + ': المساحة = الشاشة − الفتحة', Math.abs(total - want) < 1e-6, 'got=' + total + ' want=' + want);
  const nonNeg = [L.top, L.bottom, L.left, L.right].every((q) => q.w >= 0 && q.h >= 0 && q.x >= 0 && q.y >= 0);
  t(label + ': أبعاد غير سالبة', nonNeg);
}
coverCheck(1280, 800, { x: 500, y: 300, w: 200, h: 120 }, 'وسط الشاشة');
coverCheck(1280, 800, { x: 0, y: 0, w: 100, h: 100 }, 'زاوية عليا');
coverCheck(1280, 800, { x: 1180, y: 700, w: 200, h: 200 }, 'زاوية سفلية خارجة جزئياً');
coverCheck(390, 844, { x: 100, y: 400, w: 190, h: 60 }, 'جوال عمودي');
coverCheck(1280, 800, { x: -50, y: -50, w: 100, h: 100 }, 'خارج الشاشة جزئياً');
coverCheck(1280, 800, { x: 0, y: 0, w: 1280, h: 800 }, 'فتحة بملء الشاشة');

console.log('== 3) placeCard: الموضع والسهم ==');
function inside(pos, cw, ch, vw, vh, label) {
  const ok = pos.left >= 0 && pos.top >= 0 && pos.left + cw <= vw + 1 && pos.top + ch <= vh + 1;
  t(label + ': داخل الشاشة', ok, JSON.stringify(pos));
  return ok;
}
{
  const vw = 1280, vh = 800, cw = 340, ch = 200;
  const p1 = placeCard({ x: 500, y: 200, w: 200, h: 100 }, vw, vh, cw, ch);
  t('تحت الهدف أولاً', p1.side === 'top' && p1.top === 200 + 100 + 12, JSON.stringify(p1));
  inside(p1, cw, ch, vw, vh, 'تحت الهدف');
  const p2 = placeCard({ x: 500, y: 650, w: 200, h: 100 }, vw, vh, cw, ch);
  t('فوق الهدف عند ضيق الأسفل', p2.side === 'bottom' && p2.top === 650 - 12 - ch, JSON.stringify(p2));
  inside(p2, cw, ch, vw, vh, 'فوق الهدف');
  const p3 = placeCard({ x: 100, y: 100, w: 1080, h: 600 }, vw, vh, cw, ch);
  t('الهدف الكبير: داخل الشاشة', p3.left >= 0 && p3.top >= 0 && p3.left + cw <= vw + 1 && p3.top + ch <= vh + 1, JSON.stringify(p3));
  // أقل تداخل: مساحة التداخل أصغر من وضعها الثابت تحت الهدف
  const ovArea = (p) => {
    const ix = Math.max(0, Math.min(p.left + cw, 100 + 1080) - Math.max(p.left, 100));
    const iy = Math.max(0, Math.min(p.top + ch, 100 + 600) - Math.max(p.top, 100));
    return ix * iy;
  };
  const naiveBelow = { left: 470, top: 590 };
  t('الهدف الكبير: أقل تداخل من الثابت', ovArea(p3) <= ovArea(naiveBelow), 'ov=' + ovArea(p3) + ' vs ' + ovArea(naiveBelow));
  const p4 = placeCard({ x: 1100, y: 300, w: 150, h: 100 }, vw, vh, cw, ch);
  t('حصر أفقي قرب الحافة', p4.left + cw <= vw + 1, JSON.stringify(p4));
  inside(p4, cw, ch, vw, vh, 'قرب الحافة');
  // جوال ضيق: البطاقة أعرض من المساحة؟ تُحصر وتُعرض كورقة سفلية (الورقة من JS لا CSS هنا)
  const pm = placeCard({ x: 100, y: 300, w: 190, h: 60 }, 390, 844, 340, 220);
  inside(pm, 340, 220, 390, 844, 'جوال');
  t('الجوال: تحت الهدف', pm.side === 'top', JSON.stringify(pm));
  // هدف سفلي في الجوال: فوقه
  const pm2 = placeCard({ x: 100, y: 700, w: 190, h: 60 }, 390, 844, 340, 220);
  t('الجوال السفلي: فوق الهدف', pm2.side === 'bottom', JSON.stringify(pm2));
  inside(pm2, 340, 220, 390, 844, 'جوال سفلي');
}

console.log('== 4) ربط المحرك بالمحتوى ==');
t('Tour يستخدم placeCard', /placeCard\(r, vw, vh/.test(src));
t('Tour يستخدم spotLanes', /spotLanes\(r, vw, vh\)/.test(src));
t('خطوات العميل تحمل أهدافاً', /targets:\s*\[/.test(src));
t('الخطوات بلا هدف تُمركز (لا تُحذف)', /side = 'center'|dataset\.side = 'center'/.test(src) || /data-side="center"/.test(src));
t('إغلاق بلوحة المفاتيح', /Escape/.test(src) && /ArrowLeft/.test(src));
t('عدم تكرار العرض (نفس المفتاح)', /mj_help_seen_/.test(src));
t('لا حذف للتصميم من الجولة', !/removeSelected|deleteAll|state\.pieces\s*=/.test(src.split('class Tour')[1].split('class Manual')[0]));

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
const out = process.env.SP_OUT;
if (out) fs.writeFileSync(out, report, 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
