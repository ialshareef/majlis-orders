/* الملف التعريفي للشركة (/profile و /profile.pdf) — فحوص بلا متصفح:
   كل صورة مذكورة موجودة وفي قائمة بناء الـ Worker، والرقم المعتمد وحده، وملف PDF سليم،
   ومسار /profile.pdf يحوّل إلى نسخة الإصدار المنشور على jsDelivr.
   الاستخدام: node test/profile-page.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); } };

const html = read('profile/index.html');
const bw = read('build-worker.ps1');
const imgs = [...new Set([...html.matchAll(/\/profile\/img\/([a-z0-9-]+\.jpg)/g)].map((m) => m[1]))];
ok(imgs.length >= 12, 'الصفحة تعرض 12 صورة من أعمال الشركة على الأقل', imgs.length);
const missing = imgs.filter((f) => !fs.existsSync(path.join(root, 'profile', 'img', f)));
ok(missing.length === 0, 'كل صورة مذكورة موجودة في profile/img', missing);
const notBuilt = imgs.filter((f) => !bw.includes(`'/profile/img/${f}'`));
ok(notBuilt.length === 0 && bw.includes("'/profile/index.html'"), 'الصفحة وكل صورها في قائمة بناء الـ Worker', notBuilt);
ok(/'\.jpg' = 'image\/jpeg'/.test(bw) && /\$ext -eq '\.jpg'/.test(bw), 'بناء الـ Worker يعرف JPEG ويضمّنه ثنائياً');
const extImg = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('/'));
ok(extImg.length === 0, 'كل الصور من الموقع نفسه (لا روابط صور خارجية تنكسر)', extImg);

// الرقم المعتمد وحده
const digits = html.replace(/\s/g, '');
ok(digits.includes('+966533724290') && digits.includes('wa.me/966533724290') && digits.includes('tel:+966533724290'), 'الرقم المعتمد +966 53 372 4290 للاتصال والواتساب');
ok(!/0549955622|966549955622|0508148108|966508148108/.test(digits), 'لا أرقام قديمة في الملف التعريفي');

// الأمان: مكتبة QR الخارجية الوحيدة ببصمة تحقق
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)].map((m) => m[0]);
ok(scripts.length === 1 && /integrity="sha384-[A-Za-z0-9+/=]+"/.test(scripts[0]) && /crossorigin="anonymous"/.test(scripts[0]), 'السكربت الخارجي الوحيد (QR) ببصمة SRI', scripts);

// ملف PDF
const pdfPath = path.join(root, 'profile', 'asalh-najd-profile.pdf');
const pdf = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : Buffer.alloc(0);
ok(pdf.subarray(0, 5).toString() === '%PDF-', 'ملف PDF موجود وصالح');
ok(pdf.length > 200 * 1024 && pdf.length < 3 * 1024 * 1024, 'حجم PDF مناسب للإرسال بالواتساب (أقل من 3MB)', pdf.length);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
ok(pages === 7, 'PDF من 7 صفحات A4', pages);

// رموز QR قابلة للضغط: كل رمز رابط إلى وجهته نفسها — في الصفحة وفي ملف PDF (روابط PDF حقيقية)
const qrs = [...html.matchAll(/<a class="qr-card" href="([^"]+)"[^>]*><span class="qr" data-qr="([^"]+)"/g)];
const allQr = (html.match(/data-qr="/g) || []).length;
ok(qrs.length === allQr && allQr >= 7 && qrs.every((m) => m[1] === m[2]), 'كل رمز QR رابط يفتح الوجهة نفسها التي يحملها الرمز', { links: qrs.length, all: allQr });
const zlib = await import('node:zlib');
const pdfUris = new Set();
const grab = (txt) => { for (const m of txt.matchAll(/\/URI\s*\(([^)]*)\)/g)) pdfUris.add(m[1]); };
grab(pdf.toString('latin1'));
for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) { try { grab(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')); } catch (_) { /* تيار غير مضغوط أو صورة */ } }
const wantPdf = [...new Set(qrs.map((m) => m[1]))];
const noLink = wantPdf.filter((u) => !pdfUris.has(u));
ok(noLink.length === 0, 'ملف PDF: كل رمز QR رابط قابل للضغط', noLink);

// الوصول إلى الملف التعريفي: بطاقة بارزة في بوابة العميل، وسطر في «عن التطبيق» لدى الموظفين
const portal = read('portal.html'), index = read('index.html'), app = read('js/app.js');
const PROFILE = 'https://majlis-api.asalh-najd.workers.dev/profile';
const iCard = portal.indexOf('id="pProfile"'), iStart = portal.indexOf('id="pStart"'), iLinks = portal.indexOf('id="pLinks"');
ok(iCard > iStart && iCard < iLinks && portal.includes(`href="${PROFILE}"`), 'بوابة العميل: بطاقة الملف التعريفي بعد زر التصميم وقبل روابط التواصل (رابط مطلق يعمل في أندرويد)');
ok(portal.includes('id="pProfileDone"'), 'بوابة العميل: رابط الملف التعريفي في صفحة «تم الانتهاء من التصميم»');
const iRow = index.indexOf('id="profileRow"'), iBox = index.indexOf('id="linksBox"'), iCust = index.indexOf('id="customerLink"');
ok(iRow > iBox && iRow < iCust, '«عن التطبيق»: سطر الملف التعريفي أول روابط الوصول السريع');
ok(['btnOpenProfile', 'btnPdfProfile', 'btnCopyProfile', 'btnShareProfile'].every((b) => index.includes(`id="${b}"`) && app.includes(`bind('${b}'`)) && app.includes(`profile: '${PROFILE}'`) && app.includes(`profilePdf: '${PROFILE}.pdf'`), '«عن التطبيق»: فتح وPDF ونسخ ومشاركة مربوطة بالروابط الرسمية');

// الفيديو التعريفي: في الملف التعريفي (ويب فقط)، وفي البوابة عند الضغط، وفي «عن التطبيق»
const vfile = path.join(root, 'marketing', 'video', 'asalh-najd-promo.mp4');
const vbytes = fs.existsSync(vfile) ? fs.readFileSync(vfile) : Buffer.alloc(0);
ok(vbytes.length > 500 * 1024 && vbytes.length < 20 * 1024 * 1024 && vbytes.subarray(4, 8).toString() === 'ftyp', 'ملف الفيديو MP4 موجود وحجمه ضمن حد jsDelivr (20MB)', vbytes.length);
ok(/<section class="sheet no-print" id="video">/.test(html) && /<video id="promoVideo" src="\/video\.mp4"[^>]*muted[^>]*playsinline[^>]*preload="none"/.test(html), 'الملف التعريفي: فيديو صامت لا يُنزَّل قبل ظهوره، ولا يدخل ملف PDF');
const iVid = portal.indexOf('id="pVideoBtn"');
ok(iVid > iCard && iVid < iLinks && /<video id="pVideo"[^>]*preload="none"/.test(portal) && !/<video id="pVideo"[^>]*\ssrc=/.test(portal) && read('js/portal.js').includes(`'${PROFILE.replace('/profile', '')}/video.mp4'`), 'البوابة: زر الفيديو بعد بطاقة الملف التعريفي، والفيديو يُحمَّل عند الضغط فقط');
ok(index.includes('id="videoRow"') && ['btnOpenVideo', 'btnCopyVideo', 'btnShareVideo'].every((b) => index.includes(`id="${b}"`) && app.includes(`bind('${b}'`)) && app.includes(`video: '${PROFILE.replace('/profile', '')}/video.mp4'`), '«عن التطبيق»: سطر الفيديو بتشغيل ونسخ ومشاركة');

// مسار /profile.pdf في الـ Worker
const wsrc = read('worker/worker.js');
const ver = (wsrc.match(/^const UPDATE_FALLBACK_VERSION = '([^']+)'/m) || [])[1];
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(wsrc).toString('base64'));
const r = await worker.fetch(new Request('https://majlis-api.asalh-najd.workers.dev/profile.pdf'), {});
ok(r.status === 302 && r.headers.get('location') === `https://cdn.jsdelivr.net/gh/ialshareef/majlis-orders@v${ver}/profile/asalh-najd-profile.pdf`, '/profile.pdf يحوّل إلى ملف وسم الإصدار المنشور على jsDelivr', r.headers.get('location'));
const rv = await worker.fetch(new Request('https://majlis-api.asalh-najd.workers.dev/video.mp4'), {});
ok(rv.status === 302 && rv.headers.get('location') === `https://cdn.jsdelivr.net/gh/ialshareef/majlis-orders@v${ver}/marketing/video/asalh-najd-promo.mp4`, '/video.mp4 يحوّل إلى فيديو وسم الإصدار على jsDelivr', rv.headers.get('location'));

// الحزمة المبنية (كما في visit-test.mjs): الصفحة وصورها تُخدَم فعلاً من الـ Worker
const bundlePath = path.join(root, 'worker', 'worker.bundle.js');
if (fs.existsSync(bundlePath)) {
  const { default: bw2 } = await import('data:text/javascript;base64,' + fs.readFileSync(bundlePath).toString('base64'));
  const pg = await bw2.fetch(new Request('https://majlis-api.asalh-najd.workers.dev/profile'), {});
  const body = await pg.text();
  ok(pg.status === 200 && /text\/html/.test(pg.headers.get('content-type')) && body.includes('شركة أصالة نجد للأثاث'), 'الحزمة: /profile صفحة HTML', pg.status);
  const im = await bw2.fetch(new Request('https://majlis-api.asalh-najd.workers.dev/profile/img/' + imgs[0]), {});
  const bytes = new Uint8Array(await im.arrayBuffer());
  ok(im.status === 200 && im.headers.get('content-type') === 'image/jpeg' && bytes[0] === 0xFF && bytes[1] === 0xD8, 'الحزمة: صور البروفايل JPEG سليمة', [im.status, im.headers.get('content-type')]);
} else console.log('NOTE  لا توجد حزمة مبنية — فحص الخدمة من الحزمة تخطّى (يُغطّى عند النشر)');

console.log(`=== profile-page: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
