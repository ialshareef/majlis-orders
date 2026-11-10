/* اختبار واجهة: قسم «عن التطبيق» على الجوال —
   زر «تنزيل وتثبيت الإصدار …» عربي فقط ولا يخرج عن حدوده، وشريط التنزيل المتحرك ظاهر،
   وصفّا «تطبيق أندرويد» و«تطبيق الويب» العنوان فيهما سطر واحد والوصف تحته، بلا تمرير أفقي.
   الاستخدام: node test/about-update-ui-e2e.mjs [--save <مجلد>] */
import fs from 'node:fs';
import path from 'node:path';
import { startApp, sleep } from './_app-harness.mjs';

const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin']], 'about-upd');
try {
  for (const vp of [{ width: 360, height: 800, isMobile: true, hasTouch: true }, { width: 412, height: 900, isMobile: true, hasTouch: true }, { width: 1366, height: 900 }]) {
    const p = await app.login('owner', vp);
    await p.evaluate(() => { const b = document.querySelector('[data-page="about"]'); if (b) b.click(); });
    await p.waitForFunction(() => document.getElementById('page-about').classList.contains('active'), { timeout: 10000 }).catch(() => {});
    await sleep(800);
    // حالة «تحديث متاح أثناء التنزيل» كما تظهر للمستخدم (النص من update.js نفسه)
    await p.evaluate(() => {
      const dl = document.getElementById('btnDownloadUpdate');
      dl.hidden = false; dl.textContent = 'تنزيل وتثبيت الإصدار 1.0.97';
      document.getElementById('updateStatus').textContent = 'جارٍ تنزيل الإصدار 1.0.97…';
      const pr = document.getElementById('updateProgress'); pr.hidden = false; pr.classList.add('indet');
      const lab = document.getElementById('updateProgressLabel'); lab.hidden = false;
      lab.textContent = 'جارٍ التنزيل… 7 ث — حجم التحديث نحو 4 ميجابايت، أبقِ التطبيق مفتوحاً';
      document.getElementById('btnDownloadUpdate').scrollIntoView({ block: 'center' });
    });
    await sleep(400);
    const r = await p.evaluate(() => {
      const dl = document.getElementById('btnDownloadUpdate').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(document.getElementById('btnDownloadUpdate'));
      const tx = range.getBoundingClientRect();
      const bar = document.querySelector('#updateProgress > span');
      const head = (id) => { const h = document.querySelector(`#${id} .link-head`); const s = h.querySelector('span').getBoundingClientRect(), sm = h.querySelector('small').getBoundingClientRect(); return { spanLines: Math.round(s.height / parseFloat(getComputedStyle(h.querySelector('span')).lineHeight || 20)), below: sm.top >= s.bottom - 1 }; };
      return {
        w: innerWidth, doc: document.scrollingElement.scrollWidth,
        inside: tx.left >= dl.left - 0.5 && tx.right <= dl.right + 0.5 && dl.left >= 0 && dl.right <= innerWidth,
        latin: /[A-Za-z]/.test(document.getElementById('btnDownloadUpdate').textContent),
        anim: getComputedStyle(bar).animationName, barW: bar.getBoundingClientRect().width,
        apk: head('apkRow'), web: head('installWebRow'),
        dlBox: [dl.left, dl.right], txBox: [tx.left, tx.right],
      };
    });
    const tag = vp.width + 'px';
    ok(r.inside && !r.latin, `${tag}: نص زر «تنزيل وتثبيت الإصدار» عربي وداخل حدود الزر`, r);
    ok(r.anim === 'upd-indet' && r.barW > 5, `${tag}: شريط التنزيل المتحرك ظاهر`, r);
    ok(r.apk.spanLines <= 1 && r.apk.below && r.web.below, `${tag}: عنوان «تطبيق أندرويد (APK)» سطر واحد والوصف تحته`, r);
    ok(r.doc <= r.w + 1, `${tag}: بلا تمرير أفقي`, r);
    if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await p.evaluate(() => document.getElementById('apkRow').scrollIntoView({ block: 'start' })); await sleep(200); await p.screenshot({ path: path.join(saveDir, `about-${tag}.png`) }); }
    await p.browserContext().close();
  }
  ok(!app.errs.length, 'لا أخطاء JavaScript', app.errs);
} catch (e) { fail++; console.log('FAIL  استثناء: ' + (e && e.stack || e)); }
finally {
  await app.close();
  console.log(`\n=== about-update-ui: PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail ? 1 : 0);
}
