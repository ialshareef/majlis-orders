/* محادثة التصميم بالذكاء الاصطناعي في الصفحة الحقيقية (portal.html) مع Worker حقيقي ونموذج وهمي (env.AI):
   - عدة أسئلة: لكل سؤال إجابته، والسؤال المتعدد يقبل أكثر من إجابة، وكلها تُرسل معاً بزر واحد
   - شريط التقدّم يوضح ما عُرف وما بقي، وزر «إنشاء التصميم الآن» متى عُرف المقاس
   - بعد جولتي أسئلة يصبح التصميم جاهزاً (نهاية واضحة) ← معاينة ← تطبيق على المصمم
   - التخطيط سليم على الجوال والحاسوب
   node test/ai-chat-e2e.mjs [--save <مجلد لقطات>] */
import fs from 'node:fs';
import path from 'node:path';
import { startApp, sleep } from './_app-harness.mjs';

const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 500) : '')); } };
const shot = async (page, name) => { if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await page.screenshot({ path: path.join(saveDir, name + '.png') }); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin']], 'aichat');
/* نموذج وهمي يتصرف كالنموذج الحقيقي السيئ: يسأل كثيراً وينسى ما سبق — والخادم يجب أن يعالج ذلك */
const seen = [];
app.env.AI = {
  run: async (model, input) => {
    const user = input.messages[1].content;
    seen.push(user);
    const n = seen.length;
    if (n === 1) return { response: JSON.stringify({ status: 'need_answers', note: 'أهلاً! أحتاج بعض التفاصيل.', spec: {},
      questions: [
        { id: 'seat', q: 'ما نوع الجلسة؟', options: ['جلسة عربية', 'أرضي', 'كنب'] },
        { id: 'door', q: 'أين الباب؟', options: ['الجدار السفلي', 'الجدار الأيمن', 'الجدار الأيسر'] },
        { id: 'acc', q: 'ما الإكسسوارات التي تريدها؟', options: ['مركى', 'طاولة وسط', 'مسند ظهر'], multi: true },
      ] }) };
    // الجولة 2: النموذج «ينسى» المقاس ويعيد جزءاً من المواصفات فقط
    if (n === 2) return { response: JSON.stringify({ status: 'need_answers', note: 'ممتاز، سؤال أخير.', spec: { seating: 'arabic', door: { wall: 1, w: 1 }, accessories: [{ name: 'مركى', qty: 2 }, { name: 'طاولة وسط', qty: 1 }] },
      questions: [{ id: 'fab', q: 'ما لون القماش؟', options: ['بني', 'بيج', 'رمادي'] }] }) };
    return { response: JSON.stringify({ status: 'need_answers', note: 'سؤال آخر؟', spec: {}, questions: [{ id: 'x', q: 'هل تريد شباكاً؟', options: ['نعم', 'لا'] }] }) };
  },
};

const errs = [];
async function open(vp) {
  const ctx = await app.browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]));
  await p.setViewport(vp);
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem('mj_help_seen_customer@v2', '1'); } catch (_) {} });
  await p.goto(app.origin + '/portal.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#pStart', { visible: true }); await sleep(900);
  return p;
}
const S = (p) => p.evaluate(() => window.AiDesign.state());
const waitIdle = (p, n) => p.waitForFunction((k) => { const s = window.AiDesign.state(); return !s.busy && s.msgs >= k; }, { timeout: 20000 }, n);
const layout = (p) => p.evaluate(() => {
  const card = document.querySelector('#aiModal .ai-card').getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  const ab = document.getElementById('aiAnswer');
  const chips = [...document.querySelectorAll('#aiBody .ai-chip')].map((c) => c.getBoundingClientRect());
  return {
    cardIn: card.left >= -1 && card.right <= vw + 1 && card.top >= -1 && card.bottom <= vh + 1,
    hscroll: document.documentElement.scrollWidth > vw + 1 || document.querySelector('#aiModal .ai-card').scrollWidth > card.width + 1,
    chipsIn: chips.every((r) => r.left >= card.left - 1 && r.right <= card.right + 1),
    chipH: chips.length ? Math.min(...chips.map((r) => r.height)) : 0,
    answerBtn: !!ab, rect: [card.left, card.top, card.right, card.bottom, vw, vh].map(Math.round),
  };
});

for (const [label, vp] of [['desktop', { width: 1366, height: 860 }], ['mobile', { width: 375, height: 760, isMobile: true, hasTouch: true }]]) {
  seen.length = 0;
  const p = await open(vp);
  await p.evaluate(() => document.getElementById('pAiBtn').click());
  await p.waitForSelector('#aiModal:not([hidden])'); await sleep(450);   // انتهاء حركة فتح الورقة
  const prog0 = await p.evaluate(() => document.getElementById('aiProg').textContent);
  ok(/٣ معلومات|المقاس/.test(prog0), `${label}: شريط التقدّم يوضح ما يحتاجه البوت من البداية`, prog0);

  await p.type('#aiText', 'أبي مجلس 6×4');
  await p.click('#aiSend');
  await waitIdle(p, 3);
  let s = await S(p);
  ok(s.status === 'need_answers' && s.questions === 3, `${label}: ثلاثة أسئلة بخيارات`, s);
  const prog1 = await p.evaluate(() => [...document.querySelectorAll('#aiProg .ai-steps li')].map((l) => l.className + ':' + l.textContent));
  ok(prog1[0].startsWith('done') && !prog1[1].startsWith('done'), `${label}: المقاس ✓ (قُرئ من النص) والباقي ناقص`, prog1);
  ok(await p.evaluate(() => !!document.getElementById('aiCreate') && /الآن/.test(document.getElementById('aiCreate').textContent)), `${label}: «إنشاء التصميم الآن» متاح بعد معرفة المقاس`);
  const L1 = await layout(p);
  ok(L1.cardIn && !L1.hscroll && L1.chipsIn, `${label}: النافذة والخيارات داخل الشاشة بلا تمرير أفقي`, L1);
  ok(L1.chipH >= 30, `${label}: أزرار الخيارات بحجم مناسب للمس`, L1.chipH);
  await shot(p, `${label}-1-questions`);

  // اختيار إجابة لكل سؤال، وإجابتين للسؤال المتعدد
  const click = (qi, oi) => p.evaluate((a, b) => document.querySelector(`#aiBody .ai-chip[data-ai-q="${a}"][data-ai-o="${b}"]:not([disabled])`).click(), qi, oi);
  await click(0, 2); await click(0, 0);          // تغيير الرأي في سؤال مفرد
  await click(1, 1);
  await click(2, 0); await click(2, 1);
  s = await S(p);
  ok(JSON.stringify(s.answers) === JSON.stringify({ 0: ['جلسة عربية'], 1: ['الجدار الأيمن'], 2: ['مركى', 'طاولة وسط'] }), `${label}: كل الإجابات محفوظة (لا تُستبدل بآخر اختيار)`, s.answers);
  const cnt = await p.evaluate(() => document.getElementById('aiQCount').textContent);
  ok(/3 من 3/.test(cnt), `${label}: عدّاد «أجبت عن 3 من 3»`, cnt);
  await shot(p, `${label}-2-picked`);
  await p.evaluate(() => document.getElementById('aiAnswer').click());
  await waitIdle(p, 5);
  ok(/جلسة عربية/.test(seen[1]) && /الجدار الأيمن/.test(seen[1]) && /مركى، طاولة وسط/.test(seen[1]), `${label}: الإجابات الثلاث وصلت للنموذج معاً`, seen[1] && seen[1].slice(-200));
  s = await S(p);
  const spec = await p.evaluate(() => window.AiDesign.spec());
  ok(spec && spec.roomW === 6 && spec.roomH === 4 && spec.seating === 'arabic' && spec.door && spec.door.wall === 1, `${label}: المقاس لم يضِع رغم أن النموذج نسيه`, spec);

  // الجولة الثانية: سؤال واحد ← إجابة ← النهاية (ready) حتى لو أراد النموذج سؤالاً ثالثاً
  ok(s.status === 'need_answers' && s.questions === 1, `${label}: جولة ثانية بسؤال واحد`, s);
  await click(0, 1);
  await p.evaluate(() => document.getElementById('aiAnswer').click());
  await waitIdle(p, 7);
  s = await S(p);
  ok(s.status === 'ready' && s.questions === 0, `${label}: بعد جولتين ينتهي السؤال ويصبح التصميم جاهزاً`, s);
  const extra = await p.evaluate(() => document.getElementById('aiExtra').textContent);
  ok(/المواصفات المفهومة/.test(extra) && /خيارات شائعة/.test(extra), `${label}: ملخص المواصفات مع توضيح الافتراضات`, extra.slice(0, 200));
  ok(await p.evaluate(() => { const b = document.getElementById('aiCreate').getBoundingClientRect(), x = document.getElementById('aiExtra').getBoundingClientRect(); return b.top >= x.top && b.bottom <= x.bottom; }), `${label}: زر «إنشاء التصميم» ظاهر بلا تمرير`);
  ok(!/سؤال آخر/.test(await p.evaluate(() => [...document.querySelectorAll('#aiBody .ai-msg.bot')].pop().textContent)), `${label}: رسالة الجاهزية لا تَعِد بسؤال جديد`);
  const prog2 = await p.evaluate(() => document.getElementById('aiProg').textContent);
  ok(/المعلومات كافية/.test(prog2), `${label}: شريط التقدّم يقول إن المعلومات كافية`, prog2);
  await shot(p, `${label}-3-ready`);

  // إنشاء ← تطبيق
  await p.evaluate(() => document.getElementById('aiCreate').click());
  await p.waitForFunction(() => window.AiDesign.state().hasPreview, { timeout: 20000 });
  ok(await p.evaluate(() => /^data:image/.test(document.querySelector('.ai-preview img').src)), `${label}: معاينة صورة التصميم`);
  await shot(p, `${label}-4-preview`);
  await p.evaluate(() => document.getElementById('aiApply').click());
  await p.waitForFunction(() => window.AiDesign.state().applied, { timeout: 20000 });
  const st = await p.evaluate(() => { const d = window.PortalAI.designer().getState(); return { w: d.room && d.room.w, pieces: (d.pieces || []).length, openings: (d.openings || []).length }; });
  ok(st.pieces > 0 && st.openings >= 1, `${label}: التصميم طُبّق على المصمم (قطع + باب)`, st);
  ok(seen.length === 3, `${label}: ثلاث رسائل فقط من البداية حتى التصميم الجاهز`, seen.length);
  await p.close();
}

ok(!errs.length, 'js: لا أخطاء JavaScript', errs);
await app.close();
console.log(`\n=== ai-chat: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
