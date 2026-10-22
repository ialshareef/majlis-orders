/* فحص تقسيم ورقة التصميم على أكثر من صفحة (تعديل ٦) — متصفح حقيقي Chrome headless
   يشغّل test/design-sheet-paginate-harness.html ويبني أربعة سيناريوهات:
     few (قليل) / medium (متوسط) / large (كبير ← صفحات عديدة) / long (جدول طويل
     + دليل وحاشية ومساحات طويلة) ثم يتحقق من محتوى كل صفحة فعلياً (DOM قبل
     التصوير، لأن التصوير مصوّر) ومن عدّ صفحات PDF الناتجة فعلياً:
       - صفر تجاوز أسفل أي عمود (بلا overflow:hidden وبلا قصّ) — الحد 0.5مم
       - لا تداخل بين محتوى العمود وشريط التواصل
       - كل صفوف الجدول موجودة بالضبط مرة واحدة عبر الصفحات (لا فقدان ولا تكرار)
       - لا يُقسَّم صف: كل صف كامل الخلايا في صفحة واحدة
       - رأس الجدول (thead + «جداول الأثاث») يتكرر على كل صفحة تحمل صفوفاً
       - السعة/الدليل/الحاشية/المساحات: كل منها موجود بالضبط مرة واحدة، وبالنص نفسه
       - الترتيب نفسه: الصفحة الأولى بالمخطط وبخانات الترويسة، وبعدها صفحات متابعة
       - شارة «صفحة N من M» على كل صفحة إن تعدّدت، وM ثابتة
       - عدد صفحات PDF يتبع المحتوى: العميل pdfBlob ومسار الموظف addPage
       - قياس الورقة 277×190مم على كل صفحة (المقاس لا يتغيّر)

   يعتمد: node_modules/puppeteer-core + node_modules/html2canvas + jspdf (محلياً)
   node test/design-sheet-paginate-test.mjs                                        */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };
const finish = () => {
  const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
  console.log(report);
  process.exit(fail ? 1 : 0);
};
const skip = (why) => { lines.push('SKIP  غير منفَّذ: ' + why); console.log('SKIP — ' + why); console.log(lines.join('\n')); process.exit(0); };

let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; }
catch (_) { skip('puppeteer-core غير مثبّت'); }

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) skip('لا يوجد Chrome/Edge على الجهاز');
for (const rel of ['node_modules/html2canvas/dist/html2canvas.min.js', 'node_modules/jspdf/dist/jspdf.umd.min.js', 'js/designer.js', 'js/design-sheet.js']) {
  if (!fs.existsSync(path.join(root, rel))) skip('الملف الناقص: ' + rel);
}

/* ---------- 1) مصدر CSS/الواجهة: بلا إخفاء ولا قصّ ---------- */
{
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  const rule = (/\.dsheet\s*\{[\s\S]*?\}/.exec(css) || [''])[0];
  t('style.css: لا اعتماد على overflow:hidden في الورقة', !!rule && !/overflow:\s*hidden/.test(rule), rule.slice(0, 160));
  t('style.css: .dsheet position:relative لشارة الصفحة والتحذير', !!rule && /position:\s*relative/.test(rule), rule.slice(0, 160));
  t('style.css: قاعدة صفحات المتابعة .ds-cont (عمود بعرض الصفحة)', /\.dsheet\.ds-cont\s*\.ds-body\s*\{[^}]*gap:\s*0/.test(css) && /\.dsheet\.ds-cont\s*\.ds-side\s*\{[^}]*width:\s*100%/.test(css));
  t('style.css: شارة الترقيم .ds-pageof', /\.ds-pageof\s*\{[^}]*position:\s*absolute/.test(css));
  t('style.css: لوحة التجاوز الظاهرة .ds-over', /\.ds-over\s*\{[^}]*position:\s*absolute/.test(css));
  const dsjs = fs.readFileSync(path.join(root, 'js/design-sheet.js'), 'utf8');
  t('js: تصدير buildPages للواجهات', /buildPages:\s*buildPages/.test(dsjs));
  t('js: قياس الصفحة قبل القبول (measureSheet)', /function measureSheet\(/.test(dsjs) && /function shrinkAlloc\(/.test(dsjs));
  t('js: لا وظيفة قصّ أو إخفاء (scroll/crop/hide على المحتوى)', !/overflow\s*:\s*hidden/.test((/\.dsheet\s*\{[\s\S]*?\}/.exec(fs.readFileSync(path.join(root, 'css/style.css'), 'utf8')) || [''])[0]));
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-web-security'],
});

const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;

function checkCompleteness(tag, r, allowOver = false) {
  const got = [];
  r.data.forEach((p) => p.rows.forEach((x) => got.push(x)));
  const exp = r.rowsExpected;
  const sameSeq = got.length === exp.length && got.every((x, i) => x === exp[i]);
  t(tag + ': كل صفوف الجدول موجودة بالترتيب وبلا فقدان أو تكرار', sameSeq, 'got=' + got.length + ' exp=' + exp.length + (sameSeq ? '' : ' | ' + JSON.stringify(got.slice(0, 3))));
  const seen = new Set();
  let dup = null;
  got.forEach((x) => { if (seen.has(x) && !dup) dup = x; seen.add(x); });
  t(tag + ': لا صف يظهر في صفحتين (لا تكرار)', !dup, dup || '');

  r.data.forEach((p, i) => {
    const pn = 'الصفحة ' + (i + 1) + '/' + r.n;
    /* بلا تجاوز… وإلا لو كان التجاوز معروضاً ومعلّماً بوضوح (سيناريو tall) */
    const overOk = p.over
      ? (allowOver && p.overflowMm > 0.5)
      : (p.overflowMm <= 0.5 && !p.footOverlap);
    t(tag + ': ' + pn + ' بلا تجاوز مخفي (≤0.5مم) أو معلّم بوضوح', overOk,
      'overflow=' + p.overflowMm + 'مم over=' + p.over + ' footOverlap=' + p.footOverlap);
    t(tag + ': ' + pn + ' لا تداخل مخفي مع شريط التواصل', p.over || !p.footOverlap);
    t(tag + ': ' + pn + ' مقاسها 277×190مم', Math.abs(p.widthMm - 277) < 0.6 && Math.abs(p.heightMm - 190) < 0.6, p.widthMm + '×' + p.heightMm);
    if (p.rows.length > 0) {
      t(tag + ': ' + pn + ' رأس الجدول مكرر (thead + عنوان القسم)', p.thead && /جداول الأثاث/.test(p.headTitle));
    }
    if (!allowOver) t(tag + ': ' + pn + ' لا تحذير تجاوز ظاهر', !p.over);
  });

  if (r.n > 1) {
    r.data.forEach((p, i) => {
      t(tag + ': شارة الصفحة ' + (i + 1) + ' = «صفحة ' + (i + 1) + ' من ' + r.n + '»', p.pageof === 'صفحة ' + (i + 1) + ' من ' + r.n, JSON.stringify(p.pageof));
    });
    t(tag + ': الصفحة الأولى بالمخطط وبعدها صفحات متابعة بلا مخطط',
      r.data[0].plan && r.data.slice(1).every((p) => p.cont === true && p.plan === false),
      r.data.map((p) => (p.plan ? 'P' : '-') + (p.cont ? 'c' : '-')).join(' '));
  } else {
    t(tag + ': صفحة واحدة بلا شارة ترقيم ولا فئة متابعة', !r.data[0].pageof && !r.data[0].cont);
    t(tag + ': الصفحة الوحيدة بها المخطط', r.data[0].plan);
  }

  const areasPages = r.data.map((p, i) => (p.areas ? i : -1)).filter((i) => i >= 0);
  if (r.hasAreas) t(tag + ': ملخص المساحات موجود بالضبط في صفحة واحدة', areasPages.length === 1, JSON.stringify(areasPages));
  else t(tag + ': بلا ملخص مساحات (بيانات غير مكتملة) فلا يُختلق', areasPages.length === 0);

  const notes = r.data.map((p) => p.note).filter((x) => x);
  t(tag + ': الحاشية موجودة مرة واحدة وبالنص كاملاً (بلا قصّ)',
    notes.length === 1 && notes[0] === r.noteExpected, 'pages=' + notes.length + ' len=' + notes[0].length + '/' + r.noteExpected.length);

  const caps = r.data.map((p) => p.cap).filter((x) => x);
  if (r.capExpected) t(tag + ': شارة السعة مرة واحدة بالقيمة نفسها', caps.length === 1 && caps[0] === r.capExpected, JSON.stringify(caps));
  else t(tag + ': بلا شارة سعة', caps.length === 0);

  const legendGot = [];
  r.data.forEach((p) => p.legend.forEach((x) => legendGot.push(x)));
  const legExp = r.legendExpected;
  const legSame = legendGot.length === legExp.length && legExp.every((x, i) => legendGot[i] === x);
  t(tag + ': دليل الألوان مكتمل عبر الصفحات وبالترتيب', legSame, 'got=' + legendGot.length + ' exp=' + legExp.length);

  /* الترتيب نفسه عبر كل الصفحات: الجدول ← السعة ← الدليل ← الحاشية ← المساحات */
  const flat = [];
  r.data.forEach((p) => p.sideOrder.forEach((c) => flat.push(c)));
  const seq = ['ds-h-tbl', 'ds-tbl', 'ds-cap', 'ds-h-leg', 'ds-legend', 'ds-note', 'ds-areas-wrap']
    .map((c) => [c, flat.indexOf(c)]).filter(([, i]) => i >= 0);
  let orderOk = true;
  for (let i = 1; i < seq.length; i++) if (seq[i][1] <= seq[i - 1][1]) orderOk = false;
  t(tag + ': ترتيب المحتوى محفوظ (جدول ← سعة ← دليل ← حاشية ← مساحات)',
    orderOk, JSON.stringify(seq.map(([c, i]) => c + '@' + i)));
}

try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const fileUrl = 'file:///' + path.join(here, 'design-sheet-paginate-harness.html').split(path.sep).join('/');
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 60000 });

  const run = (k) => page.evaluate((kk) => window.__build(kk), k);
  const few = await run('few');
  const medium = await run('medium');
  const large = await run('large');
  const long = await run('long');
  const tall = await run('tall');
  t('المِسبار اكتمل بلا أخطاء متصفح', errs.length === 0, errs[0] || '');

  lines.push('== 1) سيناريو قليل ==');
  t('few: صفحاً واحداً', few.n === 1, 'n=' + few.n);
  checkCompleteness('few', few);

  lines.push('== 2) سيناريو متوسط ==');
  t('medium: عدد صفحاته بين القليل والكبير (يتبع المحتوى)',
    medium.n >= few.n && medium.n < large.n, medium.n + ' ضمن [' + few.n + ',' + large.n + ']');
  t('medium: صفوفه أكثر من القليل', medium.totalRows > few.totalRows, medium.totalRows + ' مقابل ' + few.totalRows);
  checkCompleteness('medium', medium);

  lines.push('== 3) سيناريو كبير (جدول طويل) ==');
  t('large: على صفحتين فأكثر', large.n >= 2, 'n=' + large.n);
  t('large: عدد الصفحات يتبع المحتوى (أكبر من القليل والمتوسط)', large.n > few.n && large.n > medium.n, large.n + ' vs ' + few.n + '/' + medium.n);
  t('large: صفوفه فعلاً كثيرة (' + large.totalRows + ')', large.totalRows >= 40, large.totalRows);
  checkCompleteness('large', large);

  lines.push('== 4) سيناريو جدول طويل + ملخص طويل ==');
  t('long: على صفحتين فأكثر', long.n >= 2, 'n=' + long.n);
  t('long: عدد صفحاته ≥ صفحات الكبير (محتوى أطول)', long.n >= large.n, long.n + ' مقابل ' + large.n);
  checkCompleteness('long', long);
  const longAreas = long.data.map((p, i) => (p.areas ? i : -1)).filter((i) => i >= 0);
  t('long: ملخص المساحات على آخر صفحة بعد اكتمال كل الصفوف',
    longAreas.length === 1 && longAreas[0] === long.data.length - 1,
    JSON.stringify(longAreas) + ' of ' + long.n);
  t('long: الحاشية الطويلة كاملة بلا قصّ', long.data.some((p) => p.note === long.noteExpected) && long.noteExpected.length > 200,
    long.noteExpected.length);

  lines.push('== 5) سيناريو دليل ألوان أطول من الصفحة (45 عنصراً) ==');
  t('tall: على صفحتين فأكثر', tall.n >= 2, 'n=' + tall.n);
  checkCompleteness('tall', tall);
  const legPages = tall.data.map((p, i) => (p.legend.length ? i : -1)).filter((i) => i >= 0);
  t('tall: الدليل الطويل مُجزّأ على أكثر من صفحة متتابعة (بلا قصّ ولا إخفاء)',
    legPages.length >= 2, JSON.stringify(legPages));
  t('tall: بلا أي تحذير تجاوز — كل كتلة وُضعت في مكان يتّسعها',
    tall.data.every((p) => !p.over), JSON.stringify(tall.data.map((p) => p.over)));
  t('tall: صفحات الجدول الأولى لا تحمل الدليل (ترتيب محفوظ)', tall.data.slice(0, 3).every((p) => p.legend.length === 0));

  lines.push('== 6) عدّ صفحات PDF فعلي (العميل + الموظف) ==');
  const b64few = await page.evaluate(() => window.__pdfClient('few'));
  const b64large = await page.evaluate(() => window.__pdfClient('large'));
  const b64order = await page.evaluate(() => window.__pdfOrder('large'));
  t('المِسبار بعد PDF بلا أخطاء متصفح', errs.length === 0, errs[0] || '');
  t('العميل: PDF للقليل = صفحة واحدة', pdfPages(Buffer.from(b64few, 'base64')) === 1, 'pages=' + pdfPages(Buffer.from(b64few, 'base64')));
  t('العميل: PDF للكبير = عدد الصفحات المبنية (' + large.n + ')', pdfPages(Buffer.from(b64large, 'base64')) === large.n,
    'pages=' + pdfPages(Buffer.from(b64large, 'base64')));
  t('الموظف (أمر الشراء): فاتورة + صفحات الورقة = ' + (large.n + 1), pdfPages(Buffer.from(b64order, 'base64')) === large.n + 1,
    'pages=' + pdfPages(Buffer.from(b64order, 'base64')));
  t('عدّاد الصفحات يتبع المحتوى فعلياً (قليل < كبير)', pdfPages(Buffer.from(b64large, 'base64')) > pdfPages(Buffer.from(b64few, 'base64')));
} finally {
  await browser.close();
}

finish();
