/* اختبار تطبيق الكمية: ضغط Enter وزر «تم/تطبيق الكمية» يطبّقان الكمية مرة واحدة فقط
   (لا تنفيذ مزدوج ولا تنبيه مكرر).
   - portal.js  : لوحة «تطبيق الكمية» (#accqModal) — يستخرج الكود الفعلي ويشغّله بمحاكاة DOM.
   - portal-expanded.js: لوحة كمية البطاقة — يستخرج commitQty ويشغّله بمحاكاة.
   تشغيل: node test/qty-apply-test.mjs                                          */
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const portal = fs.readFileSync(path.join(root, 'js', 'portal.js'), 'utf8');
const px = fs.readFileSync(path.join(root, 'js', 'portal-expanded.js'), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (info ? '  [' + info + ']' : '')); };

function between(src, startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) return null;
  const b = src.indexOf(endMark, a);
  if (b < 0) return null;
  return src.slice(a, b);
}
function extractBlock(src, startMark) {
  const a = src.indexOf(startMark);
  if (a < 0) return null;
  let i = src.indexOf('{', a), depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(a, k + 1); }
  }
  return null;
}

/* ============================================================
   A) portal.js — لوحة «تطبيق الكمية» (#accqModal)
   ============================================================ */
const blockStart = 'var applied = false, lastRaw = null, lastSt';
const B = between(portal, blockStart, "nEl.addEventListener('focus'");
t('A1) استخراج كود openAccQty (commitInput/confirmQty)', !!B, B ? B.length + ' chars' : 'not found');

function portalHarness(initialN) {
  const hooks = { toasts: [], applies: 0, closes: 0, redraws: 0, focus: 0 };
  const listeners = {};
  const nEl = {
    _v: String(initialN),
    get value() { return this._v; },
    set value(x) { this._v = String(x); },
    addEventListener(t2, f) { (listeners[t2] = listeners[t2] || []).push(f); },
    focus() { hooks.focus++; },
    select() {},
  };
  const body = `
    var N = ${JSON.stringify(initialN)};
    ${B}
    function redraw() { hooks.redraws++; nEl.value = String(N); }
    return { confirmQty: confirmQty, commitInput: commitInput,
             getN: function () { return N; }, isApplied: function () { return applied; } };
  `;
  const api = new Function('nEl', 'toast', 'apply', 'closePModal', 'hooks', body)(
    nEl,
    (m) => hooks.toasts.push(String(m)),
    () => { hooks.applies++; },
    () => { hooks.closes++; },
    hooks
  );
  const fire = (type, ev) => { (listeners[type] || []).forEach((f) => f(ev || { preventDefault() {} })); };
  return { hooks, listeners, nEl, api, fire };
}

if (B) {
  // A2) «تطبيق الكمية» على الزر مباشرة (لا كود منفصل عن Enter)
  t('A2) زر #accqOk يستدعي confirmQty نفسه', /querySelector\('#accqOk'\)\.onclick = confirmQty;/.test(portal));
  // A3) Enter يستدعي confirmQty نفسها
  t("A3) Enter يستدعي confirmQty", /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); confirmQty\(\); \}/.test(portal));
  // A4) change محكوم بـ applied
  t('A4) change محمي بـ applied', /addEventListener\('change', function \(\) \{ if \(!applied\) commitInput\(\); \}\)/.test(portal));

  // A5) تسلسل: كتابة رقم + change ثم Enter → تطبيق واحد فقط
  {
    const h = portalHarness(3);
    h.nEl.value = '7';
    h.fire('change');
    h.fire('keydown', { key: 'Enter', preventDefault() {} });
    h.fire('change'); // ما يندفع من متصفح بعد Enter
    t('A5) تطبيق واحد بعد change+Enter+change',
      h.hooks.applies === 1 && h.hooks.closes === 1 && h.hooks.toasts.length === 1 && h.api.getN() === 7,
      `applies=${h.hooks.applies} closes=${h.hooks.closes} toasts=${h.hooks.toasts.length} N=${h.api.getN()}`);
  }
  // A6) مباشرة Enter على قيمة جديدة → تطبيق واحد
  {
    const h = portalHarness(2);
    h.nEl.value = '5';
    h.fire('keydown', { key: 'Enter', preventDefault() {} });
    t('A6) Enter يطبّق ويغلق مرة واحدة',
      h.hooks.applies === 1 && h.hooks.closes === 1 && h.api.getN() === 5 && h.api.isApplied(),
      `applies=${h.hooks.applies} closes=${h.hooks.closes} N=${h.api.getN()}`);
  }
  // A7) قيمة غير صالحة (0) + change ثم Enter → تنبيه واحد ولا تطبيق
  {
    const h = portalHarness(3);
    h.nEl.value = '0';
    h.fire('change');
    h.fire('keydown', { key: 'Enter', preventDefault() {} });
    t('A7) قيمة غير صالحة: تنبيه واحد ولا تطبيق ولا إغلاق',
      h.hooks.toasts.length === 1 && h.hooks.applies === 0 && h.hooks.closes === 0 && h.api.getN() === 3 && h.nEl.value === '3',
      `toasts=${h.hooks.toasts.length} applies=${h.hooks.applies} N=${h.api.getN()} v=${h.nEl.value}`);
  }
  // A8) بعد التطبيق، أي حدث لاحق محجوب
  {
    const h = portalHarness(1);
    h.nEl.value = '4';
    h.fire('keydown', { key: 'Enter', preventDefault() {} });
    h.fire('change');
    h.fire('keydown', { key: 'Enter', preventDefault() {} });
    t('A8) الأحداث اللاحقة كلها محجوبة بعد التطبيق',
      h.hooks.applies === 1 && h.hooks.closes === 1 && h.hooks.toasts.length === 1,
      `applies=${h.hooks.applies} closes=${h.hooks.closes} toasts=${h.hooks.toasts.length}`);
  }
  // A9) قواعد التحقق كما كانت (1–99) ورفض غير الرقمي
  t('A9) قواعد التحقق: 1..99 ورفض غير الرقمي', /v < 1 \|\| v > 99/.test(portal) && /\/\^\\d\+\$\/\.test\(raw\)/.test(portal));
  // A10) الفارغ لا يغيّر العدد ولا ينذر
  {
    const h = portalHarness(6);
    h.nEl.value = '';
    h.fire('change');
    t('A10) حقل فارغ: بلا تنبيه وبقاء العدد',
      h.hooks.toasts.length === 0 && h.api.getN() === 6 && h.nEl.value === '6',
      `toasts=${h.hooks.toasts.length} N=${h.api.getN()} v=${h.nEl.value}`);
  }
  // A11) #psQty (خصائص القطعة): Enter يطبّق + مانع تطبيق مزدوج
  t('A11) #psQty يستمع لـ Enter', /qi\.addEventListener\('keydown', function \(e\) \{\r?\n        if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); qiRun\(\); \}/.test(portal));
  t('A12) #psQty مانع qiLast + فتح بـ input', /var qiLast = null;/.test(portal) && /qi\.addEventListener\('input', function \(\) \{ qiLast = null; \}\)/.test(portal));
}

/* ============================================================
   B) portal-expanded.js — لوحة كمية البطاقة (commitQty المشتركة)
   ============================================================ */
const cq = extractBlock(px, 'function commitQty(inp) {');
t('B1) استخراج commitQty', !!cq, cq ? cq.length + ' chars' : 'not found');

if (cq) {
  const calls = { setAccQty: 0, syncTile: 0, toasts: [] };
  const MAX_QTY = 99;
  const counts = { a1: 3 };
  const make = new Function('accCount', 'setAccQty', 'syncTile', 'toast', 'MAX_QTY', cq + '\nreturn commitQty;')(
    (id) => counts[id] || 0,
    (id, n) => { calls.setAccQty++; counts[id] = Math.max(0, Math.min(MAX_QTY, Math.round(n) || 0)); },
    () => { calls.syncTile++; },
    (m) => calls.toasts.push(String(m)),
    MAX_QTY
  );

  // B2) تسلسل change ثم blur المؤجّل ثم «تم» على نفس القيمة → تطبيق واحد
  {
    const inp = { dataset: { qtyin: 'a1' }, value: '5' };
    const r = [make(inp), make(inp), make(inp)];
    t('B2) الالتزام المتكرر على نفس القيمة يُنفَّذ مرة واحدة',
      r[0] === 'ok' && r[1] === 'blocked' && r[2] === 'blocked' && calls.setAccQty === 1 && counts.a1 === 5,
      `r=${r} setAccQty=${calls.setAccQty} n=${counts.a1}`);
  }
  // B3) تعديل جديد يرفع القفل (input) → تطبيق ثانٍ
  {
    const inp = { dataset: { qtyin: 'a1', qtyLock: '1' }, value: '5' };
    inp.dataset.qtyLock = '0'; // ما يفعله حدث input
    const r = make(inp);
    t('B3) حدث input يرفع القفل فيسمح بقيد جديد', r === 'ok' && calls.setAccQty === 2 && counts.a1 === 5,
      `r=${r} setAccQty=${calls.setAccQty}`);
  }
  // B4) قيمة غير صالحة: تنبيه واحد ثم قفل
  {
    const before = calls.toasts.length;
    const inp = { dataset: { qtyin: 'a1' }, value: '-5' };
    const r1 = make(inp), r2 = make(inp);
    t('B4) رفض غير الرقمي مع تنبيه واحد فقط',
      r1 === 'bad' && r2 === 'blocked' && calls.toasts.length === before + 1 && inp.value === String(counts.a1),
      `r=${r1}/${r2} toasts=+${calls.toasts.length - before} v=${inp.value}`);
  }
  // B5) حقل فارغ بلا تنبيه
  {
    const before = calls.toasts.length;
    const inp = { dataset: { qtyin: 'a1' }, value: '' };
    const r = make(inp);
    t('B5) حقل فارغ: empty بلا تنبيه وبلا تطبيق',
      r === 'empty' && calls.toasts.length === before && inp.value === String(counts.a1),
      `r=${r} toasts=+${calls.toasts.length - before}`);
  }
  // B6) الحد الأقصى
  {
    const inp = { dataset: { qtyin: 'a1' }, value: '250' };
    const r = make(inp);
    t('B6) تجاوز الحد الأقصى يُنذر ثم يُطبَّق مقصوصًا عند setAccQty',
      r === 'ok' && counts.a1 <= MAX_QTY, `r=${r} n=${counts.a1}`);
  }
  // B7) حقل مفقود → blocked (لا انهيار)
  t('B7) حقل مفقود آمن', make(null) === 'blocked');

  // B8) الربط: كل المسارات تمرّ بـ commitQty
  t("B8) change ← commitQty(inp)", /addEventListener\('change', function \(\) \{ commitQty\(inp\); \}\)/.test(px));
  t("B8) blur المؤجّل ← commitQty(el)", /setTimeout\(function \(\) \{ if \(!el\.isConnected\) return; commitQty\(el\); \}, 0\);/.test(px));
  t("B8) Enter ← commitQty(inp) + renderPanel", /if \(e\.key === 'Enter'\) \{\r?\n            e\.preventDefault\(\);\r?\n            commitQty\(inp\);\r?\n            renderPanel\(\);\r?\n          \}/.test(px));
  t('B8) زر «تم» ← commitQty(inp)', /var st = commitQty\(inp\);/.test(px));
  t('B8) تعديل يرفع القفل', /inp\.addEventListener\('input', function \(\) \{ inp\.dataset\.qtyLock = '0'; \}\)/.test(px));
  t('B8) تعريف واحد فقط لـ commitQty', (px.match(/function commitQty\(inp\)/g) || []).length === 1);
  t('B8) لا بقي من commit القديم المنفصل', !/var commit = function \(\)/.test(px));
  t('B8) commitQty تُحدّث الشارة syncTile', /syncTile\(id\);/.test(cq));
}

/* ============================================================
   C) تأكيدات تفادي انجرافات
   ============================================================ */
t('C1) قواعد الرفض في portal-expanded لم تتغير', /'أدخل عددًا صحيحًا \(0 أو أكثر\)\.'/.test(px) && /'الحد الأقصى ' \+ MAX_QTY \+ ' قطعة\.'/.test(px));
t('C2) زر الحذف بقي كما هو', /button\[data-qtydel\]/.test(px) && /setAccQty\(b\.dataset\.qtydel, 0\);/.test(px));
t('C3) MAX_QTY مستمر في حدود حقل العدد الفعلية', /max="' \+ MAX_QTY \+ '"/.test(px));

console.log('\nPASS=' + pass + '  FAIL=' + fail);
process.exit(fail ? 1 : 0);
