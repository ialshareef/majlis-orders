/* تثبيت تطبيق الويب + رابط APK في «عن التطبيق» — الصفحة الحقيقية (index.html):
   - أندرويد/حاسوب: شريط «ثبّت تطبيق أصالة نجد» عند فتح الرابط (حتى في شاشة الدخول) وزر «تثبيت» يفتح نافذة التثبيت
   - «ليس الآن» يخفيه 14 يوماً · لا يظهر في التطبيق المثبّت ولا داخل تطبيق أندرويد (APK)
   - آيفون: شرح بخطوتين (مشاركة ← إضافة إلى الشاشة الرئيسية)
   - الجوال: الشريط داخل الشاشة ولا يغطي شريط التنقل السفلي
   - «عن التطبيق»: صف تطبيق أندرويد برابط GitHub وصف «تطبيق الويب» بزر تثبيت
   node test/install-e2e.mjs [--save <مجلد لقطات>] */
import fs from 'node:fs';
import path from 'node:path';
import { startApp, sleep, PW } from './_app-harness.mjs';

const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const shot = async (page, name) => { if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await page.screenshot({ path: path.join(saveDir, name + '.png') }); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin']], 'install');
const errs = [];
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/* حدث تثبيت وهمي بنفس واجهة Chrome: prompt() + userChoice */
const fakePrompt = (outcome) => `(() => {
  window.__prompted = 0;
  const fire = () => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__prompted++; return Promise.resolve(); };
    e.userChoice = Promise.resolve({ outcome: '${outcome}' }); window.dispatchEvent(e); };
  window.addEventListener('load', () => setTimeout(fire, 300));
})();`;

async function open(vp, pre, ua) {
  const ctx = await app.browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]));
  if (ua) await p.setUserAgent(ua);
  await p.setViewport(vp);
  for (const s of [].concat(pre || [])) await p.evaluateOnNewDocument(s);
  await p.goto(app.origin + '/index.html', { waitUntil: 'load' });
  await p.waitForSelector('#loginUser', { visible: true }); await sleep(900);
  return p;
}
const bar = (p) => p.evaluate(() => {
  const b = document.getElementById('installBar');
  if (!b || b.hidden) return null;
  const r = b.getBoundingClientRect();
  return { text: b.innerText.replace(/\s+/g, ' ').trim(), btns: [...b.querySelectorAll('button')].map((x) => x.textContent.trim()),
    inView: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, top: Math.round(r.top), bottom: Math.round(r.bottom), hscroll: document.documentElement.scrollWidth > innerWidth + 1 };
});

/* 1) حاسوب (Chrome): شريط عند فتح الرابط ← تثبيت */
let p = await open({ width: 1366, height: 860 }, fakePrompt('accepted'));
let b = await bar(p);
ok(b && /ثبّت تطبيق أصالة نجد/.test(b.text) && b.btns.join('|') === 'تثبيت|ليس الآن', 'desktop: شريط «ثبّت تطبيق أصالة نجد» في شاشة الدخول بزري «تثبيت» و«ليس الآن»', b);
ok(b && b.inView && !b.hscroll, 'desktop: الشريط داخل الشاشة', b);
await shot(p, 'desktop-bar');
await p.evaluate(() => document.querySelector('#installBar [data-inst="go"]').click()); await sleep(300);
ok(await p.evaluate(() => window.__prompted === 1) && !(await bar(p)), 'desktop: «تثبيت» يفتح نافذة التثبيت الأصلية ويُخفي الشريط');

/* 2) «ليس الآن» يخفيه ولا يعود بعد إعادة الفتح */
p = await open({ width: 1366, height: 860 }, fakePrompt('dismissed'));
ok(!!(await bar(p)), 'later: الشريط ظاهر لزائر جديد');
await p.evaluate(() => document.querySelector('#installBar [data-inst="later"]').click()); await sleep(200);
ok(!(await bar(p)) && await p.evaluate(() => !!localStorage.getItem('mj_install_dismissed_at')), 'later: «ليس الآن» يخفيه ويحفظ الاختيار');
await p.reload({ waitUntil: 'load' }); await sleep(1200);
ok(!(await bar(p)), 'later: بعد إعادة الفتح لا يظهر (مؤجّل 14 يوماً)');
await p.evaluate(() => localStorage.setItem('mj_install_dismissed_at', String(Date.now() - 15 * 864e5)));
await p.reload({ waitUntil: 'load' }); await sleep(1200);
ok(!!(await bar(p)), 'later: بعد 15 يوماً يظهر مرة أخرى');

/* 3) لا يظهر في التطبيق المثبّت ولا في تطبيق أندرويد */
p = await open({ width: 412, height: 860, isMobile: true, hasTouch: true }, [fakePrompt('accepted'), `(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => /display-mode: standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q); })();`]);
ok(!(await bar(p)), 'standalone: لا شريط داخل التطبيق المثبّت');
p = await open({ width: 412, height: 860, isMobile: true, hasTouch: true }, [fakePrompt('accepted'), `window.Capacitor = { isNativePlatform: () => true, Plugins: {} };`]);
ok(!(await bar(p)), 'apk: لا شريط داخل تطبيق أندرويد');

/* 4) آيفون: شرح بخطوتين */
p = await open({ width: 390, height: 844, isMobile: true, hasTouch: true }, null, IOS_UA);
b = await bar(p);
ok(b && /مشاركة/.test(b.text) && /إضافة إلى الشاشة الرئيسية/.test(b.text) && b.btns.join('|') === 'حسناً', 'ios: شرح «المشاركة ← إضافة إلى الشاشة الرئيسية» بزر «حسناً»', b);
ok(b && b.inView && !b.hscroll, 'ios: الشريط داخل الشاشة بلا تمرير أفقي', b);
await shot(p, 'ios-bar');
await p.evaluate(() => document.querySelector('#installBar [data-inst="later"]').click()); await sleep(200);
ok(!(await bar(p)), 'ios: «حسناً» يخفيه');

/* 5) الجوال بعد الدخول: لا يغطي شريط التنقل + «عن التطبيق» */
p = await open({ width: 390, height: 844, isMobile: true, hasTouch: true }, fakePrompt('accepted'));
await p.evaluate(() => { try { ['staff', 'mandoub'].forEach((k) => localStorage.setItem('mj_help_seen_' + k + '@v2', '1')); } catch (_) {} });
await p.type('#loginUser', 'owner'); await p.type('#loginPass', PW);
await p.click('#loginForm button[type=submit]');
await p.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 }); await sleep(2500);
await p.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
b = await bar(p);
const nav = await p.evaluate(() => { const n = document.getElementById('bottomNav').getBoundingClientRect(); return { top: Math.round(n.top), shown: n.height > 0 && getComputedStyle(document.getElementById('bottomNav')).display !== 'none' }; });
ok(b && b.inView && (!nav.shown || b.bottom <= nav.top + 1), 'mobile: الشريط فوق شريط التنقل السفلي لا يغطيه', { b, nav });
await shot(p, 'mobile-app-bar');
await p.evaluate(() => document.querySelector('#installBar [data-inst="later"]').click());
await p.evaluate(() => { const b2 = document.querySelector('[data-page="about"]'); if (b2) b2.click(); });
await p.waitForFunction(() => document.getElementById('page-about').classList.contains('active'), { timeout: 10000 }).catch(() => {});
await sleep(2500);
const about = await p.evaluate(() => ({
  apk: document.getElementById('apkLink') && document.getElementById('apkLink').value,
  apkBtns: ['btnOpenApk', 'btnCopyApk', 'btnShareApk'].every((id) => !!document.getElementById(id)),
  info: document.getElementById('apkLinkInfo') && document.getElementById('apkLinkInfo').textContent,
  web: document.getElementById('btnInstallWeb') && document.getElementById('btnInstallWeb').textContent.trim(),
  webVisible: !document.getElementById('installWebRow').hidden,
  hscroll: document.documentElement.scrollWidth > innerWidth + 1,
}));
ok(/^https:\/\/github\.com\/ialshareef\/majlis-orders\/releases\/(latest|download\/v[\d.]+\/asalh-najd-[\d.]+\.apk)$/.test(about.apk || '') && about.apkBtns, 'about: صف «تطبيق أندرويد (APK)» برابط GitHub وأزرار تنزيل/نسخ/مشاركة', about);
ok(about.web === 'تثبيت تطبيق الويب' && about.webVisible && !about.hscroll, 'about: صف «تطبيق الويب» بزر «تثبيت تطبيق الويب» بلا تمرير أفقي', about);
await p.evaluate(() => document.getElementById('installWebRow').scrollIntoView({ block: 'center' })); await sleep(300);
await shot(p, 'mobile-about');
// الزر يعيد فتح نافذة التثبيت حتى بعد «ليس الآن» (الحدث لم يُستهلك)
const before = await p.evaluate(() => window.__prompted);
await p.evaluate(() => document.getElementById('btnInstallWeb').click()); await sleep(300);
ok(await p.evaluate((n) => window.__prompted === n + 1, before), 'about: «تثبيت تطبيق الويب» يفتح نافذة التثبيت');

ok(!errs.length, 'js: لا أخطاء JavaScript', errs);
await app.close();
console.log(`\n=== install: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
