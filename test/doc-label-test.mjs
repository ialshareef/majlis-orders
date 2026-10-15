/* فحص تسميات المستند: بعد استبدال «فاتورة» بـ«أمر شراء» في كل ما يظهر
   للمستخدم، مع إبقاء ما هو مستند ضريبي نظامي أو مفتاح داخلي كما هو.

   يشغّل كود النصوص الحقيقي من index.html وjs/app.js — لا يفحص أنماطاً فقط:
   يقرأ قيمة كل تسمية ويعبّئها بدالة ORDER_DOCS نفسها.

   node test/doc-label-test.mjs                                         */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

const html = read('index.html');
const app = read('js/app.js');

/* ---------- 1) لا «فاتورة» في النصوص المرئية ---------- */
console.log('== 1) النصوص المرئية ==');
{
  // نصوص HTML التي يراها المستخدم (نص العنصر أو سمة title/placeholder/alt)
  const visible = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[2] || '', inner = (m[3] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (inner) visible.push({ where: 'index.html <' + m[1] + '>', text: inner });
    for (const a of ['title', 'placeholder', 'alt', 'aria-label'].map((k) => new RegExp(k + '="([^"]*)"', 'i').exec(attrs))) {
      if (a) visible.push({ where: 'index.html ' + a[0].split('=')[0], text: a[1] });
    }
  }
  const bad = visible.filter((v) => /فاتورة/.test(v.text));
  t('index.html: لا «فاتورة» في أي نص مرئي', bad.length === 0, bad.map((b) => b.where + ' → ' + b.text).join(' | '));
  t('index.html: ظهر «أمر شراء»', /أمر\s*شراء/.test(html));
}

/* ---------- 2) نصوص app.js المرئية (سلاسل تُعرض للمستخدم) ---------- */
console.log('== 2) سلاسل app.js المعروضة ==');
{
  // نلتقط السلاسل العربية داخل أقواس مفرد��/مزدوجة فهي النصوص الظاهرة
  const strs = [];
  const re = /(['"])((?:(?!\1)[^\\\n])*[\u0600-\u06FF](?:(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(app))) strs.push({ at: app.slice(0, m.index).split('\n').length, text: m[2] });
  const withInv = strs.filter((s) => /فاتورة/.test(s.text));
  // المسموح: المستند الضريبي النظامي فقط
  const allowed = withInv.filter((s) => /الفاتورة الضريبية|فاتورة ضريبية/.test(s.text));
  const unexpected = withInv.filter((s) => !/الفاتورة الضريبية|فاتورة ضريبية/.test(s.text));
  t('app.js: كل «فاتورة» المتبقية مستند ضريبي نظامي', unexpected.length === 0,
    unexpected.map((s) => 'L' + s.at + ': ' + s.text.slice(0, 70)).join(' | '));
  t('app.js: ذُكر المستند الضريبي (' + allowed.length + ' موضعاً)', allowed.length > 0);
}

/* ---------- 3) دالة التسميات تُخرج «أمر شراء» فعلياً ---------- */
console.log('== 3) دالة التسميات (ORDER_DOCS / docTitle) ==');
{
  // نشغّل الدالة المعزولة من نص app.js: نصبّ على تسمية فارغة ونمنع أي تنفيذ آخر
  const snippet = app.slice(app.indexOf('const ORDER_DOCS'));
  const sandbox = { settings: () => ({}), computeLines: () => ({ vatEnabled: false }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = snippet.slice(0, snippet.indexOf('};') + 2)
    + '\nglobalThis.__docs = ORDER_DOCS;';
  vm.runInContext(src, sandbox, { filename: 'order-docs.js' });
  const docs = sandbox.__docs;
  t('ORDER_DOCS.invoice موجود (توافق مع البيانات)', !!docs.invoice);
  const o = { status: 'confirmed', number: 5 };
  t('طلب مؤكَّد → «أمر شراء»', docs.invoice.label(o) === 'أمر شراء', docs.invoice.label(o));
  t('عرض سعر يبقى «عرض السعر»', docs.invoice.label({ status: 'quote', number: 5 }) === 'عرض السعر');
  t('أمر التصنيع لم يتغيّر', docs.workshop.label() === 'أمر التصنيع (بلا أسعار)');
  t('المفتاح الداخلي ما زال invoice', Object.keys(docs).includes('invoice'));
  t('اسم الملف بلا كلمة فاتورة', !/فاتورة/.test(docs.invoice.file(o)), docs.invoice.file(o));
}

/* ---------- 4) ما لم يُمس: حقول ومفاتيح وتوافق ---------- */
console.log('== 4) التوافق مع البيانات القديمة ==');
{
  t('حقل الإعدادات invoiceNote باقٍ', /invoiceNote/.test(app));
  t('مفتاح data-doc-kind="invoice" باقٍ', /data-doc-kind="invoice"/.test(html));
  t('معرّف docInvoiceTitle باقٍ (الـJS يكتب فيه)', /id="docInvoiceTitle"/.test(html));
  t('دالة exportCurrent開 تستخدم المفتاح invoice', /exportCurrent\(kind = 'invoice'\)|ORDER_DOCS\[kind\] \? kind : 'invoice'/.test(app));
  t('مفاتيح CSS .inv- باقية', /\.inv-/.test(read('css/style.css')));
  t('بيانات QR الضريبية لم تتغير', /رمز الفاتورة الضريبية/.test(app));
  t('worker: مفتاح الإعدادات invoiceNote باقٍ كما هو', /invoiceNote/.test(read('worker/worker.js')) || /invoiceNote/.test(read('worker/schema.sql')));
  t('worker: لا عمود جديد لمستند الطلب', !/purchase_?order|order_doc_type|doc_type/i.test(read('worker/worker.js')));
  t('worker: عمود invoiceNote في البذور كما هو', /invoiceNote/.test(read('worker/schema.sql')));
}

/* ---------- 5) الأبعاد الجديدة في PDF ---------- */
console.log('== 5) أبعاد الجدار/الباب في PDF ==');
{
  const d = read('js/designer.js');
  t('التصدير يرسم الطبقة دائماً (opt.export)', /this\.opts\.dimsOnTop \|\| opt\.export\)/.test(d));
  t('لا تصفية «المحدَّد فقط» في التصدير', !/opt\.export && o\.id !== sel/.test(d));
  t('يعرض طول الجدار لكل جدار مرة واحدة على خط مستقل', /for \(const w of g\.walls\)/.test(d) && /cm\(w\.len\)/.test(d));
  t('لا حلقة إزاحة تدفع طول الجدار لأعلى', !/guard < 4/.test(d) && !/mTot/.test(d));
  t('يعرض عرض الفتحة (o.w)', /cm\(o\.w\)/.test(d));
  t('الوحدة سنتيمتر واحدة فقط', /const cm = \(x\) => Math\.round\(x \* 100\) \+ ' سم'/.test(d));
  t('يستخدم openingGaps (المصدر نفسه للمصمم)', /this\.openingGaps\(o\.id\)/.test(d));
  t('لا حساب موازٍ للأبعاد في PDF', !/gaps\s*=\s*\{/.test(d));
  // تكرار الطول: ثلاثة مصادر كانت ترسمه — خط القياس المستقل، صندوق اسم الجدار،
  // وطبقة _drawDimsTop. في التصدير يجب ألا يرسمه إلا مصدر واحد.
  t('طول الجدار لا يُرسم في صندوق الاسم بالتصدير', /if \(opt\.export\) \{ txt = ''; tw = 0; \}/.test(d));
  t('طبقة القياسات العلوية لا تعمل في التصدير', /_drawDimsTop\(ctx, v, W, opt\) \{\s*if \(opt\.export\) return;/.test(d));
  t('لا قياس لعمق الباب داخل المجلس', !/OPENING_USE_DEPTH\([^)]*\)\s*\)?\s*;/.test(d) || !/cm\(.*useDepth|س\.depth/.test(d));
  t('تسمية الباب/المشب القديمة محصورة بالاختيار (فلا تظهر في PDF)', /const isSel = !opt\.export && this\.sel && this\.sel\.type === 'opening'/.test(d) && /if \(isSel\) \{\s*const lab = \(o\.type === 'door'/.test(d));
}

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
if (process.env.DL_OUT) fs.writeFileSync(process.env.DL_OUT, report, 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);