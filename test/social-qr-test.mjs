/* اختبار كتلة التواصل الاجتماعي في PDF الموظف — يشغّل الدوال الحقيقية
   من js/app.js (مستخرجة من المصدر نفسه لا نسخة موازية) مع واجهات بديلة:
   - shopSocialList/shopSocialHtml: ترشيح الحسابات وبناء البطاقات
   - socialQrList: توليد QR بنفس مكتبة رمز الفاتورة (qrcode-generator)
     مع qrcode مزيّف يلتقط الحمولة — فيُثبت أن المرمّز هو الرابط نفسه.

   node test/social-qr-test.mjs                                                */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

/* ---- استخراج الدوال الحقيقية من المصدر ---- */
function grab(re, name) {
  const m = src.match(re);
  if (!m) { t('استخراج ' + name + ' من app.js', false, 'not found'); process.exit(2); }
  return m[0];
}
// esc الحقيقية (سطر واحد كامل في أعلى الملف) + الثوابت والدوال
const escSrc = grab(/const esc = [^\n]*\n/, 'esc');
const chansSrc = grab(/const SOCIAL_CHANS = \[[\s\S]*?\];/, 'SOCIAL_CHANS');
const validSrc = grab(/function validSocialUrl\(v\) \{[\s\S]*?\n  \}/, 'validSocialUrl');
const listSrc = grab(/function shopSocialList\(s\) \{[\s\S]*?\n  \}/, 'shopSocialList');
const latinSrc = grab(/const latinDigits = [^\n]*\n/, 'latinDigits');
const waPhoneSrc = grab(/function waPhone\(raw\) \{[\s\S]*?\n  \}/, 'waPhone');
const fmtIntlSrc = grab(/function fmtIntl\(d\) \{[\s\S]*?\n  \}/, 'fmtIntl');
const htmlSrc = grab(/function shopSocialHtml\(list\) \{[\s\S]*?\n  \}/, 'shopSocialHtml');
const qrListSrc = grab(/async function socialQrList\(\) \{[\s\S]*?\n  \}/, 'socialQrList');

const esc = new Function(escSrc + '; return esc;')();
const SOCIAL_CHANS = new Function(chansSrc + '; return SOCIAL_CHANS;')();
const WA_ICON = new Function(grab(/const WA_ICON = .*?;/, 'WA_ICON') + '; return WA_ICON;')();
const TEL_ICON = new Function(grab(/const TEL_ICON = .*?;/, 'TEL_ICON') + '; return TEL_ICON;')();
const validSocialUrl = new Function('esc', validSrc + '; return validSocialUrl;')(esc);
const shopSocialList = new Function('esc', 'SOCIAL_CHANS', 'validSocialUrl', 'WA_ICON', 'TEL_ICON', latinSrc + waPhoneSrc + fmtIntlSrc + listSrc + '; return shopSocialList;')(esc, SOCIAL_CHANS, validSocialUrl, WA_ICON, TEL_ICON);
const shopSocialHtml = new Function('esc', htmlSrc + '; return shopSocialHtml;')(esc);

console.log('== 1) الترشيح من نفس مصدر الإعدادات ==');
{
  const s = {
    whatsapp: 'https://wa.me/966500000001', phone: '0500000001',
    instagram: 'https://instagram.com/asalhnajd', tiktok: 'https://tiktok.com/@asalhnajd',
    snapchat: 'https://snapchat.com/add/asalhnajd', mapsUrl: 'https://maps.google.com/?q=24.7,46.6',
  };
  const list = shopSocialList(s);
  t('القنوات الست كلها', list.length === 6, JSON.stringify(list.map((a) => a.key)));
  t('الترتيب: واتساب ثم اتصال ثم الحسابات ثم الموقع',
    list.map((a) => a.key).join(',') === 'wa,tel,instagram,tiktok,snapchat,mapsUrl', list.map((a) => a.key).join(','));
  t('رابط واتساب كما هو', list[0].url === s.whatsapp, list[0].url);
  t('رابط الاتصال tel: مطبّع دولياً (لا صفر محلي داخل +)', list[1].url === 'tel:+966500000001', list[1].url);
  t('عرض الاتصال بالصيغة الدولية', list[1].text === '+966 50 000 0001', list[1].text);
  t('الـ 966 الموجودة لا تُكرر', shopSocialList({ phone: '966500000001' })[0].url === 'tel:+966500000001');
  t('الـ 00 تُسقط', shopSocialList({ phone: '00966500000001' })[0].url === 'tel:+966500000001');
  t('روابط الحسابات بلا تغيير', list[2].url === s.instagram && list[3].url === s.tiktok && list[4].url === s.snapchat && list[5].url === s.mapsUrl);
  t('بلا إعدادات = بلا قائمة', shopSocialList({}).length === 0 && shopSocialList(null).length === 0);
  t('الفارغ يُتجاهل', shopSocialList({ instagram: '', tiktok: 'https://tiktok.com/@x' }).length === 1);
  t('غير https يُرفض', shopSocialList({ instagram: 'instagram.com/x', tiktok: 'http://tiktok.com/@x' }).length === 0);
  t('الروابط التجريبية تُرفض', shopSocialList({ instagram: 'https://example.com/x', tiktok: 'https://tiktok.com/test', snapchat: 'http://localhost:9/x' }).length === 0);
  t('المكرر مرة واحدة', shopSocialList({ instagram: 'https://x.com/a', tiktok: 'https://x.com/a' }).length === 1);
  t('جوال قصير يُرفض', shopSocialList({ phone: '123' }).length === 0);
}

console.log('== 2) بناء البطاقات ==');
{
  t('بلا قائمة = بلا HTML', shopSocialHtml([]) === '' && shopSocialHtml(null) === '');
  const list = [
    { key: 'instagram', label: 'إنستقرام', cls: 'in', icon: '<svg></svg>', url: 'https://instagram.com/asalhnajd', img: 'data:image/gif;base64,QR1' },
    { key: 'tiktok', label: 'تيك توك', cls: 'tt', icon: '<svg></svg>', url: 'https://tiktok.com/@asalhnajd', img: '' },
  ];
  const h = shopSocialHtml(list);
  t('عنوان الكتلة', h.includes('تواصل معنا'));
  t('العبارة الجديدة حرفياً', h.includes('امسح رمز QR أو اضغط عليها لفتح الحساب مباشرة'));
  t('البطاقتان حاضرتان', (h.match(/class="inv-chan"/g) || []).length === 2, h.length);
  t('الروابط في href وdata-url', h.includes('href="https://instagram.com/asalhnajd"') && h.includes('data-url="https://instagram.com/asalhnajd"')
    && h.includes('data-url="https://tiktok.com/@asalhnajd"'));
  t('QR للمهيأ فقط', h.includes('src="data:image/gif;base64,QR1"') && (h.match(/<img class="inv-chan-qr"/g) || []).length === 1);
  t('أصناف CSS الجاهزة', h.includes('inv-contact') && h.includes('inv-chans') && h.includes('inv-chan-ic in') && h.includes('inv-chan-ic tt'));
  // حقن HTML في الرابط/التسمية يُهرَّب
  const evil = shopSocialHtml([{ key: 'x', label: '<img>', cls: 'in', icon: '', url: 'https://a.com/"><script>', img: '' }]);
  t('تهريب الحقن', !evil.includes('<script>') && evil.includes('&lt;img&gt;'), evil.substring(0, 200));
}

console.log('== 3) حمولة QR = الرابط نفسه (qrcode مزيّف يلتقط) ==');
{
  const seen = [];
  const fakeWindow = {
    qrcode: () => ({
      addData(d) { seen.push(d); },
      make() {},
      createDataURL() { return 'data:image/gif;base64,FAKEQR'; },
    }),
  };
  const settingsStub = () => ({ instagram: 'https://instagram.com/asalhnajd', tiktok: 'not-a-url', snapchat: '' });
  const loadStub = async () => {};
  const socialQrList = new Function('esc', 'SOCIAL_CHANS', 'validSocialUrl', 'shopSocialList', 'shopSocialHtml', 'settings', 'loadScript', 'window', 'QR_URL',
    qrListSrc + '; return socialQrList;')(esc, SOCIAL_CHANS, validSocialUrl, shopSocialList, shopSocialHtml, settingsStub, loadStub, fakeWindow, 'QR_URL');
  const html = await socialQrList();
  t('حمولة واحدة = رابط إنستقرام وحده', seen.length === 1 && seen[0] === 'https://instagram.com/asalhnajd', JSON.stringify(seen));
  t('البطاقة تحمل QR المولّد', html.includes('src="data:image/gif;base64,FAKEQR"') && html.includes('إنستقرام'));
  t('غير الصالح لم يُرمَّز ولم يُعرض', !html.includes('not-a-url') && !html.includes('تيك توك'));
}

console.log('== 4) التوصيل في مسار التصدير ==');
{
  t('build يستدعي socialQrList', /build: async \(o\) => buildPrintDoc\(o, await zatcaQr\(o\), await socialQrList\(\)\)/.test(src));
  t('buildPrintDoc يستقبل الكتلة', /function buildPrintDoc\(order, qrSrc = '', socialHtml = ''\)/.test(src));
  t('الكتلة قبل التوقيعات', src.indexOf('${socialHtml}') > 0 && src.indexOf('${socialHtml}') < src.indexOf('inv-foot'));
  t('أصناف سناب في CSS', /inv-chan-ic\.sn/.test(fs.readFileSync(path.join(here, '..', 'css', 'style.css'), 'utf8')));
  t('الروابط قابلة للنقر (وسم a)', /<a class="inv-chan" href=/.test(src));
  t('تراكب روابط حقيقي في makePdfBlob', /addPdfLinksToDoc\(pdf, inv, 10, 10, 190, h\)/.test(src));
  t('دالة التراكب تقرأ data-url وتستدعي pdf.link', /querySelectorAll\('\[data-url\]'\)/.test(src) && /pdf\.link\(x, y, w, hh, \{ url/.test(src));
  t('أيقونات wa/tel/map موجودة', /const WA_ICON =/.test(src) && /const TEL_ICON =/.test(src) && /key: 'mapsUrl'/.test(src));
}

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
const out = process.env.SQ_OUT;
if (out) fs.writeFileSync(out, report, 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
