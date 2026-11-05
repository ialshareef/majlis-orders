/* ورقة التصميم = صفحة واحدة دائماً — متصفح حقيقي Chrome headless
   يشغّل test/design-sheet-paginate-harness.html ويبني ثمانية سيناريوهات
   (فارغ، قليل، متوسط، كبير، طويل، ضخم 120 صفاً، دليل ألوان طويل، ترويسة
   باسم عربي/إنجليزي طويل) ثم يتحقق من الورقة المبنية فعلياً ومن ملف PDF:
     - عنصر واحد وصفحة PDF واحدة بالضبط، بمقاس الورقة المختارة (MediaBox)
     - المقاس يكبر مع المحتوى (A4 ← A3 ← A2 ← مخصص) ولا تُصغَّر الخطوط:
       أصغر خط في الورقة ≥ 7.5pt في كل السيناريوهات
     - لا تجاوز أسفل العمود ولا تداخل مع شريط التواصل ولا عنصر خارج الورقة
     - كل الصفوف والدليل والحاشية والسعة والمساحات موجودة كاملة مرة واحدة
     - الترويسة لا تقصّ القيم الطويلة (تلتف)
     - المخطط لا يضيق دون حدّ مقروء (PLAN_MIN)
     - دقة الصورة في PDF ≥ 250 نقطة/بوصة (حادة عند التكبير)
     - المعاينة (build) تختار المقاس نفسه الذي يختاره الملف

   يعتمد: node_modules/puppeteer-core + node_modules/html2canvas + jspdf (محلياً)
   node test/design-sheet-paginate-test.mjs [--save <مجلد>]                       */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { routeDownloads, TEST_DL } from './_downloads.mjs';
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

/* ---------- 1) المصدر: لا تقسيم ولا تصغير ولا قصّ ---------- */
{
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  const rule = (/\.dsheet\s*\{[\s\S]*?\}/.exec(css) || [''])[0];
  t('style.css: الورقة بلا overflow:hidden', !!rule && !/overflow:\s*hidden/.test(rule), rule.slice(0, 160));
  t('style.css: مقاس الورقة من متغيرات المقاس المختار', /width:\s*var\(--ds-w/.test(rule) && /height:\s*var\(--ds-h/.test(rule));
  t('style.css: لا قواعد صفحات متابعة أو ترقيم', !/\.ds-cont|\.ds-pageof/.test(css));
  t('style.css: قيم الترويسة تلتف ولا تُقصّ', /\.ds-meta dd\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css) && !/\.ds-meta dd\s*\{[^}]*text-overflow/.test(css));
  const dsjs = fs.readFileSync(path.join(root, 'js/design-sheet.js'), 'utf8');
  t('js: مقاسات مرشّحة A4 ← A3 ← A2 ثم مخصص', /id: 'a4'[\s\S]*id: 'a3'[\s\S]*id: 'a2'/.test(dsjs) && /function customPaper\(/.test(dsjs));
  t('js: لا تقسيم صفحات (لا shrinkAlloc ولا tunePage)', !/function shrinkAlloc|function tunePage/.test(dsjs));
  t('js: pdfBlob صفحة واحدة بمقاس الورقة', /format: \[pg\.w, pg\.h\]/.test(dsjs) && !/pdf\.addPage\('a4'/.test(dsjs));
  t('js: دقة تصوير ~300 نقطة/بوصة (shotScale)', /var DPMM = 11\.8/.test(dsjs) && /scale: shotScale\(el\)/.test(dsjs));
}

const browser = await puppeteer.launch({ downloadBehavior: TEST_DL,
  executablePath: chromePath,
  headless: 'new',
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--disable-web-security'],
});
routeDownloads(browser); // تنزيلات الاختبار إلى Documents/majlis-test-downloads لا مجلد التنزيلات

/** صفحات PDF، ومقاس الصفحة (MediaBox بالنقاط)، وأبعاد أكبر صورة */
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type \/Page(?!s)/g) || []).length;
  const mb = /\/MediaBox \[([\d.\s]+)\]/.exec(s);
  const box = mb ? mb[1].trim().split(/\s+/).map(Number) : [];
  let imgW = 0, imgH = 0;
  const re = /\/Width (\d+)[\s\S]{0,200}?\/Height (\d+)/g;
  let m;
  while ((m = re.exec(s))) { if (+m[1] > imgW) { imgW = +m[1]; imgH = +m[2]; } }
  return { pages, wMm: box.length ? +(box[2] / 72 * 25.4).toFixed(1) : 0, hMm: box.length ? +(box[3] / 72 * 25.4).toFixed(1) : 0, imgW, imgH };
}

const EXPECT_PAPER = { empty: 'a4', few: 'a4', medium: 'a4', tall: null, large: null, long: null, huge: null, longmeta: null, bigroom: null };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  const fileUrl = 'file:///' + path.join(here, 'design-sheet-paginate-harness.html').split(path.sep).join('/');
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 60000 });

  /* القياس بخط التطبيق الحقيقي (IBM Plex Sans Arabic) لا بخط احتياطي أضيق — وإلا مرّ نص
     يتجاوز خانته على جهاز العميل (كما حدث في ملخص المساحات) */
  await page.evaluate(async () => { await document.fonts.load('700 10pt "IBM Plex Sans Arabic"', 'م'); await document.fonts.load('400 10pt "IBM Plex Sans Arabic"', 'م'); await document.fonts.ready; });
  t('القياس بخط التطبيق IBM Plex Sans Arabic', await page.evaluate(() => document.fonts.check('700 10pt "IBM Plex Sans Arabic"', 'م')));
  const papers = {};
  for (const kind of Object.keys(EXPECT_PAPER)) {
    const r = await page.evaluate((k) => window.__build(k), kind);
    const m = r.m;
    const tag = kind;
    t(tag + ': عنصر ورقة واحد بالضبط', r.n === 1, 'n=' + r.n);
    if (!m) continue;
    papers[kind] = m.paper;
    if (EXPECT_PAPER[kind]) t(tag + ': المقاس ' + EXPECT_PAPER[kind], m.paper === EXPECT_PAPER[kind], m.paper);
    t(tag + ': مقاس الورقة = الصفحة − هامشين (' + m.paperW + '×' + m.paperH + ')',
      Math.abs(m.widthMm - (m.paperW - 20)) < 0.6 && Math.abs(m.heightMm - (m.paperH - 20)) < 0.6, m.widthMm + '×' + m.heightMm);
    t(tag + ': بلا تجاوز أسفل العمود (≤0.5مم)', m.overflowMm <= 0.5, 'overflow=' + m.overflowMm + ' paper=' + m.paper);
    t(tag + ': شريط التواصل داخل الورقة', m.footInside);
    t(tag + ': لا عنصر خارج حدود الورقة', m.outside.length === 0, JSON.stringify(m.outside));
    t(tag + ': لا نص مقصوص داخل صندوقه', m.clipped.length === 0, JSON.stringify(m.clipped));
    t(tag + ': أصغر خط ≥ 7.5pt (لا تصغير لملاءمة الصفحة)', m.minPt >= 7.45, m.minPt + 'pt ' + m.minPtEl);
    if (kind !== 'empty') t(tag + ': المخطط بحجم مقروء ≥ 120×90مم', m.planW >= 119 || m.planH >= 89, m.planW + '×' + m.planH);
    const same = m.rows.length === r.rowsExpected.length && m.rows.every((x, i) => x === r.rowsExpected[i]);
    t(tag + ': كل صفوف الجدول (' + r.rowsExpected.length + ') بالترتيب', same, 'got=' + m.rows.length);
    t(tag + ': دليل الألوان كاملاً', m.legend.length === r.legendExpected.length && r.legendExpected.every((x, i) => m.legend[i] === x), m.legend.length + '/' + r.legendExpected.length);
    t(tag + ': الحاشية كاملة', m.note === r.noteExpected, m.note.length + '/' + r.noteExpected.length);
    t(tag + ': السعة', m.cap === r.capExpected, JSON.stringify([m.cap, r.capExpected]));
    t(tag + ': ملخص المساحات عند اكتمال البيانات فقط', m.areas === r.hasAreas);
    t(tag + ': الترويسة تعرض القيم كاملة بلا قصّ', !m.metaClipped && r.metaExpected.every((v) => m.meta.indexOf(v) >= 0), JSON.stringify(m.meta));
    t(tag + ': بلا شارة «صفحة N من M»', !m.pageof);
    const prev = await page.evaluate((k) => window.__previewPaper(k), kind);
    t(tag + ': المعاينة على الشاشة تختار المقاس نفسه', prev.startsWith(m.paper + ':'), prev + ' vs ' + m.paper);
  }
  /* المقاس يكبر مع المحتوى: ما لا يتسع على A4 يُنقل لمقاس أكبر لا يُضغط */
  const rank = (p) => ({ a4: 0, a3: 1, a2: 2, custom: 3 }[p] ?? -1);
  t('المقاس يتدرّج مع حجم المحتوى (few ≤ large ≤ long ≤ huge)',
    rank(papers.few) <= rank(papers.large) && rank(papers.large) <= rank(papers.long) && rank(papers.long) <= rank(papers.huge),
    JSON.stringify(papers));
  t('120 صفاً لا تتسع على A4 فتُبنى على مقاس أكبر', rank(papers.huge) >= 1, papers.huge);

  /* ---------- PDF فعلي: صفحة واحدة بمقاس الورقة وبدقة عالية ---------- */
  for (const kind of ['few', 'large', 'huge', 'longmeta']) {
    const b64 = await page.evaluate((k) => window.__pdfClient(k), kind);
    const buf = Buffer.from(b64, 'base64');
    const info = pdfInfo(buf);
    const r = await page.evaluate((k) => window.__build(k), kind);
    t('PDF ' + kind + ': صفحة واحدة بالضبط', info.pages === 1, 'pages=' + info.pages);
    t('PDF ' + kind + ': مقاس الصفحة = المقاس المختار (' + r.m.paperW + '×' + r.m.paperH + ')',
      Math.abs(info.wMm - r.m.paperW) < 1 && Math.abs(info.hMm - r.m.paperH) < 1, info.wMm + '×' + info.hMm);
    const dpi = info.imgW / ((r.m.paperW - 20) / 25.4);
    t('PDF ' + kind + ': دقة الصورة ≥ 250 نقطة/بوصة', dpi >= 250, Math.round(dpi) + 'dpi (' + info.imgW + '×' + info.imgH + ')');
    if (process.argv.includes('--save')) {
      const dir = process.argv[process.argv.indexOf('--save') + 1];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sheet-' + kind + '.pdf'), buf);
    }
  }
  t('لا أخطاء JavaScript في الصفحة', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  t('تشغيل', false, String(e && e.stack || e).slice(0, 400));
} finally {
  await browser.close();
}
finish();
