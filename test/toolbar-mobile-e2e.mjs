/* الجوال بشاشة ضيقة أو خط نظام مكبَّر: أزرار شريط التصميم داخل البطاقة، ومبالغ ملخص الدفع غير مقصوصة.
   حالة حقيقية: جوال أندرويد بخط مكبَّر — «تلفاز» آخر سطر الأزرار يُقصّ خارج الشاشة.
   الاستخدام: node test/toolbar-mobile-e2e.mjs */
import { startApp, sleep } from './_app-harness.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin']], 'toolbar');
try {
  // [العرض، تكبير الخط]: جوال عادي، أندرويد شائع 360، وخط مكبَّر كثيراً على شاشة ضيقة
  for (const [w, z] of [[390, 1], [360, 1.3], [320, 1.5]]) {
    const page = await app.login('owner', { width: w, height: 900, isMobile: true, hasTouch: true });
    if (z !== 1) await page.evaluate((k) => { document.documentElement.style.fontSize = (16 * k) + 'px'; }, z);
    await sleep(600);
    const r = await page.evaluate(() => {
      const tb = document.querySelector('.canvas-toolbar .tb-insert');
      const B = tb.getBoundingClientRect();
      const btns = [...tb.querySelectorAll('.tb-btn')];
      const out = btns.filter((b) => { const x = b.getBoundingClientRect(); return x.left < B.left - 0.5 || x.right > B.right + 0.5; }).map((b) => b.textContent.trim());
      const cut = btns.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim());
      const small = btns.filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim());
      return { out, cut, small, hscroll: document.documentElement.scrollWidth > innerWidth + 1, n: btns.length };
    });
    const tag = `${w}px × خط ${z}`;
    ok(r.n === 8 && r.out.length === 0, `${tag}: كل أزرار الإضافة الثمانية داخل البطاقة`, r);
    ok(r.cut.length === 0, `${tag}: لا اسم زر مقصوص`, r.cut);
    ok(r.small.length === 0, `${tag}: كل زر بارتفاع لمس ≥ 44px`, r.small);
    ok(!r.hscroll, `${tag}: لا تمرير أفقي للصفحة`);
    // ملخص الدفع: الإجمالي والمدفوع والمتبقي كاملة بلا «…» (كانت «7,7…» على جوال بخط مكبَّر)
    await page.evaluate(() => document.querySelector('#stepNav a[data-stage="pay"]').click());
    await sleep(400);
    const pay = await page.evaluate(() => {
      document.getElementById('payTotal').textContent = '1,277,772.20'; document.getElementById('payPaidSum').textContent = '1,943.07'; document.getElementById('payRemaining').textContent = '1,275,829.13';
      return ['payTotal', 'payPaidSum', 'payRemaining'].filter((id) => { const b = document.getElementById(id); const box = b.parentElement.getBoundingClientRect(), x = b.getBoundingClientRect(); return b.scrollWidth > b.clientWidth + 1 || x.left < box.left - 0.5 || x.right > box.right + 0.5; });
    });
    ok(pay.length === 0, `${tag}: مبالغ ملخص الدفع كاملة غير مقصوصة (حتى 1,277,772.20)`, pay);
    await page.browserContext().close();
  }
  ok(app.errs.length === 0, 'ui: لا أخطاء JavaScript', app.errs);
} catch (e) {
  fail++; console.log('FAIL  harness :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
} finally { await app.close(); }
console.log(`=== toolbar-mobile: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
