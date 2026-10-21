/* اختبار كشف التحديث — مقارنة التطبيق مع بيانات إصدار مستقلة عن أي قيمة في الكود:
   بيانات الخادم في هذا الاختبار مثبّتة يدوياً على 1.0.67 (ليست مشتقة من
   UPDATE_FALLBACK ولا من الوسم) فلا ينجح اختبار بمرآة القيمة الافتراضية.
   الحالات: 63/65/66 => يوجد تحديث · 67 => آخر إصدار · أحدث من المصدر => لا عرض أقدم
            فشل الشبكة/استجابة تالفة => خطأ لا «آخر إصدار» · رابط APK ضمن المسار الرسمي.
   التشغيل: node test/update-detect-test.mjs */
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0, fail = 0;
const t = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (ok || !info ? '' : '  [' + info + ']')); };

const realFetch = globalThis.fetch;
globalThis.window = { APP_CONFIG: { apiUrl: 'https://srv.test' } };
(0, eval)(fs.readFileSync(path.join(root, 'js', 'update.js'), 'utf8'));
const U = window.AppUpdate;

// بيانات الخادم المستقلة لهذا الاختبار فقط
const SERVER = {
  ok: true,
  update: {
    versionName: '1.0.67',
    versionCode: 10067,
    apkUrl: 'https://github.com/ialshareef/majlis-orders/releases/download/v1.0.67/asalh-najd-1.0.67.apk',
    sha256: 'd'.repeat(64),
    mandatory: false,
    releaseNotes: ['ملاحظة اختبار'],
  },
};
const serve = (body, status) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status: status || 200, headers: { 'content-type': 'application/json' },
  });
};
const cur = (v) => ({ versionName: v, versionCode: U.versionCodeOf(v) });

t('versionCodeOf: 1.0.67 => 10067', U.versionCodeOf('1.0.67') === 10067);

serve(SERVER);
let r = await U.checkForUpdate(cur('1.0.63'));
t('1) التطبيق 1.0.63 + الخادم 1.0.67 => يوجد تحديث', r.state === 'available' && r.meta.versionCode === 10067, 'state=' + r.state);
r = await U.checkForUpdate(cur('1.0.65'));
t('2) التطبيق 1.0.65 + الخادم 1.0.67 => يوجد تحديث', r.state === 'available' && r.meta.versionCode === 10067, 'state=' + r.state);
r = await U.checkForUpdate(cur('1.0.66'));
t('3) التطبيق 1.0.66 + الخادم 1.0.67 => يوجد تحديث', r.state === 'available' && r.meta.versionCode === 10067, 'state=' + r.state);
r = await U.checkForUpdate(cur('1.0.67'));
t('4) التطبيق 1.0.67 => آخر إصدار', r.state === 'latest', 'state=' + r.state);
r = await U.checkForUpdate(cur('1.0.70'));
t('5) التطبيق أحدث من المصدر => لا يعرض الأقدم كتحديث', r.state !== 'available', 'state=' + r.state);

globalThis.fetch = () => Promise.reject(new TypeError('network down'));
r = await U.checkForUpdate(cur('1.0.63'));
t('6أ) فشل الشبكة => خطأ لا «آخر إصدار»', r.state === 'error' && !!r.message && !/latest|آخر/.test(r.message || ''), 'state=' + r.state);
serve({ ok: true });
r = await U.checkForUpdate(cur('1.0.63'));
t('6ب) استجابة بلا بيانات => خطأ', r.state === 'error', 'state=' + r.state + ' ' + (r.error || ''));
globalThis.fetch = async () => new Response('<html>bad</html>', { status: 200, headers: { 'content-type': 'application/json' } });
r = await U.checkForUpdate(cur('1.0.63'));
t('6ج) استجابة تالفة => خطأ', r.state === 'error', 'state=' + r.state);

serve(SERVER);
const vOk = U.validUpdateMeta(SERVER.update);
const vEvil = U.validUpdateMeta({ ...SERVER.update, apkUrl: 'https://evil.test/asalh-najd-1.0.67.apk' });
const vHttp = U.validUpdateMeta({ ...SERVER.update, apkUrl: 'http://github.com/ialshareef/majlis-orders/releases/download/v1.0.67/asalh-najd-1.0.67.apk' });
t('7) رابط APK ضمن المسار الرسمي يُقبل', vOk.ok === true);
t('7ب) رابط خارجي يُرفض', vEvil.ok === false && vEvil.error === 'bad-url');
t('7ج) HTTP غير HTTPS يُرفض', vHttp.ok === false);

globalThis.fetch = realFetch;
console.log('==== update-detect-test: PASS=' + pass + ' FAIL=' + fail + ' ====');
process.exit(fail ? 1 : 0);
