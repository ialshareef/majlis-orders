/* بوابة نشر الإصدار — تكشف تعارض بيانات الخادم مع الإصدار المنشور:
   1) الخادم يعلن تحديداً أحدث وسم v* موجود محلياً (لا إصدار أقدم منه ولا أحدث غير منشور).
   2) versionCode ورابط APK متسقان مع الإصدار المعلن، وبصمة SHA-256 مكتملة.
   3) إن ضُبط APK_SHA256 (من APK النهائي بعد التحقق منه) تُقارن به بصمة الخادم.
   تنبيه: تفشل عمداً أثناء نشاط إصدار جديد بين دفع الوسم (المرحلة A) وتحديث
   بيانات الخادم (المرحلة C) — هذا هو الكشف المطلوب لا خطأ في الاختبار.
   التشغيل: node test/release-gate-test.mjs
   للتحقق من البصمة: APK_SHA256=<hex> node test/release-gate-test.mjs */
import fs from 'fs';
import path from 'path';
import url from 'url';
import { execSync } from 'child_process';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (ok || !info ? '' : '  [' + info + ']')); };
const codeOf = (v) => { const p = String(v).split('.').map((n) => parseInt(n, 10)); return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0); };

const tags = execSync('git tag --list "v*" --sort=-version:refname', { cwd: root }).toString().split(/\r?\n/);
const latest = tags.find((s) => /^v\d+\.\d+\.\d+$/.test(s.trim())) || '';
const tagVer = latest.replace(/^v/, '');
t('وسم إصدار v* متوفر محلياً', !!tagVer, 'tags=' + tags.slice(0, 3).join(','));
if (!tagVer) { console.log('==== release-gate-test: FAIL=' + fail + ' ===='); process.exit(1); }

const wkSrc = read('worker/worker.js');
const mod = await import('data:text/javascript;base64,' + Buffer.from(wkSrc, 'utf8').toString('base64'));
const r = await mod.default.fetch(new Request('https://x.test/api/app-update'), {});
const u = (await r.json()).update;

t('الخادم يعلن أحدث وسم منشور (لا إصدار أقدم)', u.versionName === tagVer, 'server=' + u.versionName + ' tag=' + tagVer);
t('versionCode == معادلة الإصدار المعلن', u.versionCode === codeOf(u.versionName), String(u.versionCode));
t('apkUrl رسمي وينطوي على الإصدار المعلن',
  u.apkUrl === 'https://github.com/ialshareef/majlis-orders/releases/download/v' + u.versionName + '/asalh-najd-' + u.versionName + '.apk', u.apkUrl);
t('بصمة SHA-256 مكتملة في بيانات النشر', /^[0-9a-f]{64}$/.test(u.sha256 || ''), String(u.sha256).slice(0, 12));

const want = (process.env.APK_SHA256 || '').trim().toLowerCase();
if (want) {
  t('بصمة الخادم == بصمة APK الفعلي المتحقق منه', u.sha256 === want, 'server=' + String(u.sha256).slice(0, 16) + ' apk=' + want.slice(0, 16));
} else {
  console.log('NOTE  APK_SHA256 غير مضبوط — لم تُقارن البصمة بالملف النهائي');
}

console.log('==== release-gate-test: PASS=' + pass + ' FAIL=' + fail + ' ====');
process.exit(fail ? 1 : 0);
