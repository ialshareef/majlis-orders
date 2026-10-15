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
const htmlSrc = grab(/function shopSocialHtml\(list\) \{[\s\S]*?\n  \}/, 'shopSocialHtml');
const qrListSrc = grab(/async function socialQrList\(\) \{[\s\S]*?\n  \}/, 'socialQrList');

const esc = new Function(escSrc + '; return esc;')();
const SOCIAL_CHANS = new Function(chansSrc + '; return SOCIAL_CHANS;')();
const validSocialUrl = new Function('esc', validSrc + '; return validSocialUrl;')(esc);
const shopSocialList = new Function('esc', 'SOCIAL_CHANS', 'validSocialUrl', listSrc + '; return shopSocialList;')(esc, SOCIAL_CHANS, validSocialUrl);
const shopSocialHtml = new Function('esc', htmlSrc + '; return shopSocialHtml;')(esc);

console.log('== 1) الترشيح من نفس مصدر الإعدادات ==');
{
  const s = { instagram: 'https://instagram.com/asalhnajd', tiktok: 'https://tiktok.com/@asalhnajd', snapchat: 'https://snapchat.com/add/asalhnajd' };
  const list = shopSocialList(s);
  t('الحسابات الثلاثة كلها', list.length === 3, JSON.stringify(list.map((a) => a.key)));
  t('التسميات العربية', list.map((a) => a.label).join(',') === 'إنستقرام,تيك توك,سناب شات', list.map((a) => a.label).join(','));
  t('الروابط نفسها بلا تغيير', list[0].url === s.instagram && list[1].url === s.tiktok && list[2].url === s.snapchat, JSON.stringify(list.map((a) => a.url)));
  t('بلا إعدادات = بلا قائمة', shopSocialList({}).length === 0 && shopSocialList(null).length === 0);
  t('الفارغ يُتجاهل', shopSocialList({ instagram: '', tiktok: 'https://tiktok.com/@x' }).length === 1);
  t('غير https يُرفض', shopSocialList({ instagram: 'instagram.com/x', tiktok: 'http://tiktok.com/@x' }).length === 0);
  t('الروابط التجريبية تُرفض', shopSocialList({ instagram: 'https://example.com/x', tiktok: 'https://tiktok.com/test', snapchat: 'http://localhost:9/x' }).length === 0);
  t('المكرر مرة واحدة', shopSocialList({ instagram: 'https://x.com/a', tiktok: 'https://x.com/a' }).length === 1);
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
  t('تلميح المسح', h.includes('امسح رمز QR'));
  t('البطاقتان حاضرتان', (h.match(/class="inv-chan"/g) || []).length === 2, h.length);
  t('الروابط في href', h.includes('href="https://instagram.com/asalhnajd"') && h.includes('href="https://tiktok.com/@asalhnajd"'));
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
}

const report = lines.join('\n') + '\n\n=== PASS=' + pass + '  FAIL=' + fail + ' ===';
const out = process.env.SQ_OUT;
if (out) fs.writeFileSync(out, report, 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
