/* جولة الشرح الأولى في التطبيق الحقيقي: الصفحة كلها مظلّلة عدا العنصر المشروح، والبطاقة لا تغطيه.
   - الحاسوب والجوال (375px) · المالك والموظف والمندوب (خطوات حسب الصلاحيات)
   - كل خطوة: الفتحة فوق عنصر ظاهر فعلاً داخل الشاشة، والبطاقة داخل الشاشة ولا تتقاطع مع الفتحة
   - تظهر مرة واحدة، وتعود من «دليل الاستخدام ← إعادة الشرح الأول»
   node test/tour-ui-e2e.mjs [--save <مجلد لقطات>] */
import fs from 'node:fs';
import path from 'node:path';
import { startApp, sleep } from './_app-harness.mjs';

const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin'], ['2', 'staff1', 'سارة', 'staff'], ['3', 'mand1', 'خالد', 'mandoub']], 'tour');
const shot = async (page, name) => { if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await page.screenshot({ path: path.join(saveDir, name + '.png') }); } };

/* حالة الخطوة الحالية كما يراها المستخدم */
const stepState = (page) => page.evaluate(() => {
  const w = document.querySelector('.hj-tour');
  const ring = w.querySelector('.hj-ring'), card = w.querySelector('.hj-tour-card');
  const rr = ring.getBoundingClientRect(), cr = card.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  const centered = w.classList.contains('hj-center');
  // العنصر الظاهر تحت مركز الفتحة (يُستثنى عنصر الطبقة نفسها)
  let under = null;
  if (!centered) {
    w.style.pointerEvents = 'none'; ring.style.pointerEvents = 'none';
    const el = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
    w.style.pointerEvents = ''; ring.style.pointerEvents = '';
    under = el ? (el.closest('[data-page],#stepNav,#btnNotif,#btnHelp,#btnMore,#btnMenu') || el).id || (el.closest('[data-page]') || {}).dataset?.page || el.tagName : null;
  }
  const inter = !centered && !(cr.right <= rr.left || cr.left >= rr.right || cr.bottom <= rr.top || cr.top >= rr.bottom);
  return {
    show: w.classList.contains('show'), centered, count: w.querySelector('.hj-count').textContent.trim(),
    title: w.querySelector('.hj-h').textContent.trim(), next: w.querySelector('[data-hj="next"]').textContent.trim(),
    ring: { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
    ringIn: rr.left >= -2 && rr.top >= -2 && rr.right <= vw + 2 && rr.bottom <= vh + 2,
    cardIn: cr.left >= -1 && cr.top >= -1 && cr.right <= vw + 1 && cr.bottom <= vh + 1,
    overlap: inter, under, prog: w.querySelector('.hj-prog i').style.width,
    dim: getComputedStyle(ring).boxShadow.includes('9999px') || centered,
  };
});

async function walk(page, label, tag) {
  await page.waitForFunction(() => document.querySelector('.hj-tour.show'), { timeout: 8000 });
  await sleep(450);
  const steps = [];
  for (let i = 0; i < 30; i++) {
    const s = await stepState(page);
    steps.push(s);
    await shot(page, `${tag}-${String(i + 1).padStart(2, '0')}`);
    if (/^تم$/.test(s.next)) break;
    await page.evaluate(() => document.querySelector('.hj-tour [data-hj="next"]').click());
    await sleep(450);
  }
  const first = steps[0], last = steps[steps.length - 1];
  ok(first.centered && /أهلاً بك/.test(first.title) && first.next === 'ابدأ الجولة', `${label}: يبدأ بترحيب في المنتصف وزر «ابدأ الجولة»`, first);
  ok(last.centered && /جاهز/.test(last.title), `${label}: ينتهي ببطاقة «أنت جاهز» في المنتصف`, last.title);
  const mid = steps.slice(1, -1);
  ok(mid.length >= 4 && mid.every((s) => !s.centered), `${label}: كل خطوة وسطى تضيء عنصراً حقيقياً (${mid.length} خطوات)`, mid.filter((s) => s.centered).map((s) => s.title));
  ok(mid.every((s) => s.ringIn && s.dim), `${label}: الفتحة داخل الشاشة والصفحة حولها مظلّلة`, mid.filter((s) => !s.ringIn || !s.dim).map((s) => [s.title, s.ring]));
  ok(steps.every((s) => s.cardIn), `${label}: البطاقة داخل الشاشة دائماً`, steps.filter((s) => !s.cardIn).map((s) => s.title));
  ok(mid.every((s) => !s.overlap), `${label}: البطاقة لا تغطي العنصر المشروح`, mid.filter((s) => s.overlap).map((s) => [s.title, s.ring]));
  ok(steps.every((s, i) => s.count === `${i + 1} من ${steps.length}`), `${label}: العدّاد متسلسل «n من ${steps.length}»`, steps.map((s) => s.count));
  ok(last.prog === '100%', `${label}: شريط التقدم يكتمل في آخر خطوة`, last.prog);
  return steps;
}

/* 1) المالك — حاسوب */
const P = await app.login('owner', { width: 1366, height: 860 }, { keepTour: true });
const ownerSteps = await walk(P, 'owner/desktop', 'owner-desktop');
const titles = ownerSteps.map((s) => s.title);
ok(['التقارير والتحليلات', 'الإدارة', 'المال والمتابعة', 'تصاميم العملاء'].every((t) => titles.includes(t)), 'owner: يرى خطوات التقارير والإدارة والمال والتصاميم', titles);
const byT = Object.fromEntries(ownerSteps.map((s) => [s.title, s.under]));
ok(byT['جميع الطلبات'] === 'orders' && byT['التقارير والتحليلات'] === 'reports' && byT['مراحل الطلب'] === 'stepNav' && byT['مركز التنبيهات'] === 'btnNotif',
  'owner: الفتحة فوق الزر الصحيح لكل خطوة', byT);
await P.evaluate(() => document.querySelector('.hj-tour [data-hj="next"]').click()); await sleep(300);
ok(await P.evaluate(() => !document.querySelector('.hj-tour').classList.contains('show') && !document.documentElement.classList.contains('hj-lock')), 'owner: «تم» يغلق الجولة ويعيد التمرير');
// لا تعود تلقائياً بعد إعادة التحميل
await P.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
ok(await P.evaluate(() => !document.querySelector('.hj-tour.show')), 'owner: لا تظهر مرة أخرى بعد إكمالها');
// إعادة الشرح من الدليل
await P.evaluate(() => document.getElementById('btnHelp').click()); await sleep(400);
const manTabs = await P.evaluate(() => [...document.querySelectorAll('.hj-tabs button')].map((b) => b.textContent.trim()));
ok(!manTabs.some((t) => /أهلاً|جاهز/.test(t)) && manTabs.includes('حالات الطلب'), 'manual: الدليل يحوي الشرح بلا بطاقتي الترحيب والختام', manTabs);
await P.evaluate(() => document.querySelector('.hj-manual [data-hm="replay"]').click()); await sleep(500);
ok(await P.evaluate(() => document.querySelector('.hj-tour.show') && /أهلاً/.test(document.querySelector('.hj-tour .hj-h').textContent)), 'manual: «إعادة الشرح الأول» يعيد الجولة من البداية');
// النقر خارج الفتحة يغلق، والتخطي يحفظ
await P.evaluate(() => document.querySelector('.hj-tour [data-hj="done"]').click()); await sleep(300);
ok(await P.evaluate(() => !document.querySelector('.hj-tour.show')), 'owner: «تخطّي الجولة» يغلقها');

/* 2) الموظف — حاسوب: لا خطوات إدارية */
const S = await app.login('staff1', { width: 1366, height: 860 }, { keepTour: true });
const staffSteps = await walk(S, 'staff/desktop', 'staff-desktop');
const st = staffSteps.map((s) => s.title);
ok(!st.includes('الإدارة') && !st.includes('التقارير والتحليلات') && !st.includes('المال والمتابعة') && staffSteps.length < ownerSteps.length, 'staff: لا يرى خطوات أقسام لا يملك صلاحيتها', st);

/* 3) المندوب — جوال */
const M = await app.login('mand1', { width: 375, height: 812, isMobile: true, hasTouch: true }, { keepTour: true });
const mSteps = await walk(M, 'mandoub/mobile', 'mandoub-mobile');
const mo = Object.fromEntries(mSteps.map((s) => [s.title, s]));
ok(mo['طلباتك'] && mo['طلباتك'].under === 'orders' && mo['طلباتك'].ring.y > 600, 'mobile: «طلباتك» تضيء زر الشريط السفلي', mo['طلباتك']);
ok(mo['دليل الاستخدام'] && ['btnMore', 'btnMenu'].includes(mo['دليل الاستخدام'].under), 'mobile: ما في القائمة المنزلقة يُشرح على زر «القائمة»', mo['دليل الاستخدام'] && mo['دليل الاستخدام'].under);
const sw = await M.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
ok(sw, 'mobile: لا تمرير أفقي أثناء الجولة');

/* 4) المالك — جوال */
const PM = await app.login('owner', { width: 375, height: 812, isMobile: true, hasTouch: true }, { keepTour: true });
await walk(PM, 'owner/mobile', 'owner-mobile');

ok(!app.errs.length, 'js: لا أخطاء JavaScript', app.errs);
await app.close();
console.log(`\n=== tour-ui: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
