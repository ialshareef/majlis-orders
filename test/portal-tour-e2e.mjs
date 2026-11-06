/* جولة الشرح في صفحة تصميم العميل (portal.html) — في الصفحة الحقيقية:
   - لا تظهر في صفحة الترحيب، وتبدأ عند فتح شاشة التصميم أول مرة
   - الصفحة مظلّلة عدا العنصر المشروح، والبطاقة داخل الشاشة ولا تغطيه (حاسوب وجوال)
   - «تخطّي الجولة» متاح في كل خطوة ويمنع ظهورها مرة أخرى
   - «إعادة الشرح الأول» من الدليل (حتى من صفحة الترحيب) يفتح شاشة التصميم ويعيد الجولة
   node test/portal-tour-e2e.mjs [--save <مجلد لقطات>] */
import fs from 'node:fs';
import path from 'node:path';
import { startApp, sleep } from './_app-harness.mjs';

const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const shot = async (page, name) => { if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await page.screenshot({ path: path.join(saveDir, name + '.png') }); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin']], 'ptour');
const errs = [];
async function open(vp, pre) {
  const ctx = await app.browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]));
  await p.setViewport(vp);
  if (pre) await p.evaluateOnNewDocument(pre);
  await p.goto(app.origin + '/portal.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#pStart', { visible: true }); await sleep(1200);
  return p;
}
const tourOn = (p) => p.evaluate(() => !!document.querySelector('.hj-tour.show'));
const startDesign = async (p) => { await p.evaluate(() => document.getElementById('pStart').click()); await p.waitForFunction(() => !document.getElementById('pDesign').hidden, { timeout: 15000 }); await sleep(1400); };

const stepState = (page) => page.evaluate(() => {
  const w = document.querySelector('.hj-tour');
  const ring = w.querySelector('.hj-ring'), card = w.querySelector('.hj-tour-card');
  const rr = ring.getBoundingClientRect(), cr = card.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight, centered = w.classList.contains('hj-center');
  const inter = !centered && !(cr.right <= rr.left || cr.left >= rr.right || cr.bottom <= rr.top || cr.top >= rr.bottom);
  const skip = w.querySelector('[data-hj="done"]');
  return {
    centered, title: w.querySelector('.hj-h').textContent.trim(), next: w.querySelector('[data-hj="next"]').textContent.trim(),
    count: w.querySelector('.hj-count').textContent.trim(),
    ringIn: rr.left >= -2 && rr.top >= -2 && rr.right <= vw + 2 && rr.bottom <= vh + 2 && rr.width > 8 && rr.height > 8,
    cardIn: cr.left >= -1 && cr.top >= -1 && cr.right <= vw + 1 && cr.bottom <= vh + 1,
    overlap: inter, dim: centered || getComputedStyle(ring).boxShadow.includes('9999px'),
    skip: !!skip && !skip.hidden && skip.offsetParent !== null && /تخطّي/.test(skip.textContent),
    hscroll: document.documentElement.scrollWidth > vw + 1,
  };
});

async function walk(p, label, tag) {
  await p.waitForFunction(() => document.querySelector('.hj-tour.show'), { timeout: 8000 }); await sleep(450);
  const steps = [];
  for (let i = 0; i < 20; i++) {
    const s = await stepState(p); steps.push(s); await shot(p, `${tag}-${String(i + 1).padStart(2, '0')}`);
    if (s.next === 'تم') break;
    await p.evaluate(() => document.querySelector('.hj-tour [data-hj="next"]').click()); await sleep(450);
  }
  const first = steps[0], last = steps[steps.length - 1], mid = steps.slice(1, -1);
  ok(first.centered && /أهلاً بك/.test(first.title) && first.next === 'ابدأ الجولة' && first.skip, `${label}: ترحيب في المنتصف بزري «ابدأ الجولة» و«تخطّي الجولة»`, first);
  ok(last.centered && /جاهز/.test(last.title), `${label}: ختام «أنت جاهز»`, last.title);
  ok(mid.length >= 5 && mid.every((s) => !s.centered && s.ringIn && s.dim), `${label}: ${mid.length} خطوات كلها تضيء عنصراً ظاهراً والباقي مظلّل`, mid.filter((s) => s.centered || !s.ringIn).map((s) => s.title));
  ok(mid.every((s) => !s.overlap), `${label}: البطاقة لا تغطي العنصر المشروح`, mid.filter((s) => s.overlap).map((s) => s.title));
  ok(steps.every((s) => s.cardIn && !s.hscroll), `${label}: البطاقة داخل الشاشة بلا تمرير أفقي`, steps.filter((s) => !s.cardIn || s.hscroll).map((s) => s.title));
  ok(steps.slice(0, -1).every((s) => s.skip), `${label}: «تخطّي الجولة» ظاهر في كل خطوة`, steps.filter((s) => !s.skip).map((s) => s.title));
  ok(steps.every((s, i) => s.count === `${i + 1} من ${steps.length}`), `${label}: العدّاد متسلسل`, steps.map((s) => s.count));
  return steps;
}

/* 1) حاسوب: لا جولة في الترحيب ← تبدأ مع شاشة التصميم */
// من رأى الجولة القديمة (مفتاح بلا نسخة) يرى الجديدة
const D = await open({ width: 1366, height: 860 }, () => { try { localStorage.setItem('mj_help_seen_customer', '1'); } catch (_) {} });
ok(!(await tourOn(D)), 'landing: لا تظهر الجولة في صفحة الترحيب');
await startDesign(D);
const dSteps = await walk(D, 'desktop', 'desk');
const titles = dSteps.map((s) => s.title);
ok(['خطوات التصميم', 'لوحة الخطوة', 'مخطط الغرفة', 'التالي', 'دليل الاستخدام'].every((t) => titles.includes(t)), 'desktop: تشرح الخطوات واللوحة والمخطط وزر التالي والدليل', titles);
ok(!titles.some((t) => /^الباب|أبعاد الجدران|المسافات حول/.test(t)), 'desktop: لا خطوات الشرح القديم (الباب وأبعاد الجدران)', titles);
await D.evaluate(() => document.querySelector('.hj-tour [data-hj="next"]').click()); await sleep(300);
ok(!(await tourOn(D)) && await D.evaluate(() => !document.documentElement.classList.contains('hj-lock')), 'desktop: «تم» يغلق الجولة');
// بعد الإكمال لا تعود
await D.reload({ waitUntil: 'domcontentloaded' }); await D.waitForSelector('#pStart', { visible: true }); await sleep(800);
await startDesign(D);
ok(!(await tourOn(D)), 'desktop: لا تظهر مرة أخرى بعد إكمالها');
// زر الدليل في شاشة التصميم ← إعادة الشرح
await D.evaluate(() => document.getElementById('pHelpD').click()); await sleep(400);
const man = await D.evaluate(() => ({ open: !!document.querySelector('.hj-manual.show'), tabs: [...document.querySelectorAll('.hj-tabs button')].map((b) => b.textContent.trim()) }));
ok(man.open && man.tabs.includes('الباب والشبابيك') && man.tabs.includes('المراجعة والإرسال') && !man.tabs.some((t) => /أهلاً|جاهز/.test(t)), 'manual: زر الدليل في شاشة التصميم يفتح الدليل بالشرح التفصيلي', man);
await D.evaluate(() => document.querySelector('.hj-manual [data-hm="replay"]').click()); await sleep(600);
ok(await D.evaluate(() => document.querySelector('.hj-tour.show') && /أهلاً/.test(document.querySelector('.hj-tour .hj-h').textContent)), 'manual: «إعادة الشرح الأول» يعيد الجولة من البداية');
await D.evaluate(() => document.querySelector('.hj-tour [data-hj="done"]').click()); await sleep(300);
ok(!(await tourOn(D)), 'desktop: «تخطّي الجولة» يغلقها فوراً');

/* 2) التخطّي من أول بطاقة يحفظ الاختيار */
const S = await open({ width: 1366, height: 860 });
await startDesign(S);
ok(await tourOn(S), 'skip: الجولة تظهر لزائر جديد عند فتح التصميم');
await S.evaluate(() => document.querySelector('.hj-tour [data-hj="done"]').click()); await sleep(300);
ok(!(await tourOn(S)), 'skip: «تخطّي الجولة» من الترحيب يغلقها');
await S.reload({ waitUntil: 'domcontentloaded' }); await S.waitForSelector('#pStart', { visible: true }); await sleep(800);
await startDesign(S);
ok(!(await tourOn(S)), 'skip: بعد التخطّي لا تظهر مرة أخرى');
// إعادة الشرح من صفحة الترحيب: يفتح التصميم ثم الجولة
await S.evaluate(() => document.getElementById('pBack').click()); await sleep(400);
await S.evaluate(() => document.getElementById('pHelp').click()); await sleep(400);
await S.evaluate(() => document.querySelector('.hj-manual [data-hm="replay"]').click());
await S.waitForFunction(() => !document.getElementById('pDesign').hidden && document.querySelector('.hj-tour.show'), { timeout: 15000 }).catch(() => {});
await sleep(500);
ok(await S.evaluate(() => !document.getElementById('pDesign').hidden && !!document.querySelector('.hj-tour.show') && /أهلاً/.test(document.querySelector('.hj-tour .hj-h').textContent)), 'landing/manual: «إعادة الشرح» من الترحيب يفتح شاشة التصميم ويبدأ الجولة');

/* 3) الجوال */
const M = await open({ width: 375, height: 812, isMobile: true, hasTouch: true });
ok(!(await tourOn(M)), 'mobile: لا جولة في صفحة الترحيب');
await startDesign(M);
await walk(M, 'mobile', 'mob');
const bar = await M.evaluate(() => { const b = document.querySelector('#pDesign .p-bar'); const t = b.querySelector('b'); return { h: b.offsetHeight, th: t.offsetHeight, lh: parseFloat(getComputedStyle(t).lineHeight) || 24 }; });
ok(bar.th <= bar.lh * 1.3, 'mobile: عنوان شريط التصميم في سطر واحد مع زر الدليل', bar);

ok(!errs.length, 'js: لا أخطاء JavaScript', errs);
await app.close();
console.log(`\n=== portal-tour: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
