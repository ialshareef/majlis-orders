/* اختبار مصدر رقم الإصدار الوحيد — وسم Git هو المرجع:
   - configure-version.js يحقن APP_VERSION من متغيّر CI (الوسم) في js/app.js
   - build-worker.ps1 يحقن إصدار الوسم في نسخة الويب عند توفر الوسم
   - القيمة الافتراضية محلياً تطويرية واضحة (0.0.0-dev)
   - معادلة versionCode موحّدة في update.js و worker.js و configure-version.js
   - استجابة /api/app-update متسقة داخلياً (ليست مقارنةً بالمنشور — ذلك اختبار بوابة النشر)
   التشغيل: node test/app-version-test.mjs
   في CI يُشغَّل بعد configure-version.js بمتغيّر APP_VERSION نفسه. */
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (ok || !info ? '' : '  [' + info + ']')); };
const codeOf = (v) => { const p = String(v).split('.').map((n) => parseInt(n, 10)); return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0); };

// ---------- 1) الثابت في التطبيق ----------
const appSrc = read('js/app.js');
const m = /const APP_VERSION = '([^']*)'/.exec(appSrc);
t('app.js يحتوي const APP_VERSION', !!m);
const av = m ? m[1] : '';
const envV = (process.env.APP_VERSION || '').trim();
const ciSha = !!envV && /^[0-9a-f]{7,40}$/i.test(envV);
t('شكل APP_VERSION (x.y.z أو x.y.z-dev أو sha عند بناء فرع)', ciSha || /^\d+\.\d+\.\d+(-dev)?$/.test(av), av);

// ---------- 2) بيئة البناء: التطابق مع وسم البناء إلزامي ----------
if (envV) {
  t('CI: APP_VERSION == إصدار البناء (env)', av === envV, 'app=' + av + ' env=' + envV);
  if (!ciSha) {
    t('CI: ليس نسخة تطويرية', !/-dev$/.test(av), av);
    t('CI: شكل x.y.z', /^\d+\.\d+\.\d+$/.test(av), av);
  }
} else {
  t('محلياً: القيمة الافتراضية تطويرية واضحة', av === '0.0.0-dev', av);
}

// ---------- 3) معادلة versionCode موحّدة في كل مسارات البناء ----------
const updSrc = read('js/update.js');
const wkSrc = read('worker/worker.js');
const cvSrc = read('configure-version.js');
const f1 = 'p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0)';
const f2 = 'parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)';
t('update.js: المعادلة 10000/100', updSrc.includes(f1));
t('worker.js: المعادلة نفسها', wkSrc.includes(f1));
t('configure-version.js: المعادلة نفسها', cvSrc.includes(f2));
t('استقرار المعادلة على 1.0.67 => 10067', codeOf('1.0.67') === 10067 && codeOf('2.3.4') === 20304);

// ---------- 4) آلية الحقن موجودة في CI ومرتّبة قبل مزامنة الويب ----------
const wf = read('.github/workflows/build-apk.yml');
t('workflow: configure-version.js بمتغيّر APP_VERSION من الوسم',
  /APP_VERSION:\s*\$\{\{\s*steps\.ver\.outputs\.version\s*\}\}[\s\S]{0,160}node configure-version\.js/.test(wf));
t('workflow: فحص مصدر الإصدار يُشغَّل في CI', /node test\/app-version-test\.mjs/.test(wf));
const iCfg = wf.indexOf('node configure-version.js');
const iSync = wf.indexOf('npx cap sync android');
const iPrep2 = wf.indexOf('Prepare web assets (with release version)');
t('workflow: الحقن قبل cap sync', iCfg > 0 && iSync > iCfg, 'cfg=' + iCfg + ' sync=' + iSync);
t('workflow: إعادة تجهيز www بعد الحقن قبل cap sync', iPrep2 > iCfg && iPrep2 < iSync, 'prep2=' + iPrep2);

// ---------- 5) configure-version يحقن في js/app.js ----------
t('configure-version: يحدّث js/app.js', cvSrc.includes("js/app.js"));
t('configure-version: يستبدل const APP_VERSION', cvSrc.includes("const APP_VERSION = '${raw}'"));
t('configure-version: يفشل لو غاب النمط (بلا إصدار خاطئ)', /APP_VERSION pattern not found/.test(cvSrc));

// ---------- 6) build-worker يحقن إصدار الوسم في نسخة الويب ----------
const bwSrc = read('build-worker.ps1');
t('build-worker: يقرأ أحدث وسم git', /describe --tags --abbrev=0/.test(bwSrc));
t('build-worker: يستبدل APP_VERSION عند توفر وسم صالح', bwSrc.includes("const APP_VERSION = '[^']*';") && bwSrc.includes('APP_VERSION from git tag'));

// ---------- 7) النسخة التطويرية لا تُظهر تنبيه تحديث تلقائي ----------
t('app.js: تخطّي الفحص التلقائي في نسخة التطوير', /APP_VERSION\.endsWith\('-dev'\)/.test(appSrc));

// ---------- 8) استجابة الخادم متسقة داخلياً (بيانات مستقلة عن أي إصدار) ----------
const mod = await import('data:text/javascript;base64,' + Buffer.from(wkSrc, 'utf8').toString('base64'));
const getMeta = async (env) => {
  const r = await mod.default.fetch(new Request('https://x.test/api/app-update'), env || {});
  return (await r.json()).update;
};
const u = await getMeta({});
t('الاستجابة: versionCode == معادلة versionName', u && u.versionCode === codeOf(u.versionName), u && (u.versionName + '/' + u.versionCode));
t('الاستجابة: apkUrl رسمي وينطوي على نفس الإصدار',
  u && u.apkUrl === 'https://github.com/ialshareef/majlis-orders/releases/download/v' + u.versionName + '/asalh-najd-' + u.versionName + '.apk', u && u.apkUrl);
t('الاستجابة: sha فارغ أو بصمة 64hex سليمة', u && (u.sha256 === null || /^[0-9a-f]{64}$/.test(u.sha256)));
t('الاستجابة: mandatory منطقي', u && u.mandatory === false);

const u2 = await getMeta({ APP_UPDATE_VERSION: '9.9.9' });
t('بيئة بلا بصمة => sha null (لا خلط بصمة إصدار آخر)', u2.versionName === '9.9.9' && u2.versionCode === 90909 && u2.sha256 === null,
  JSON.stringify(u2 && { v: u2.versionName, c: u2.versionCode, sha: u2.sha256 }));
const u3 = await getMeta({ APP_UPDATE_VERSION: '9.9.9', APP_UPDATE_CODE: '123' });
t('رقم بناء متضارب => يُشتق من الإصدار', u3.versionCode === 90909, String(u3.versionCode));
const u4 = await getMeta({ APP_UPDATE_VERSION: '9.9.9', APP_UPDATE_URL: 'https://github.com/ialshareef/majlis-orders/releases/download/v1.0.63/asalh-najd-1.0.63.apk' });
t('رابط يخص إصداراً آخر => apkUrl فارغ', u4.apkUrl === '', u4.apkUrl);
const u5 = await getMeta({ APP_UPDATE_URL: 'https://evil.test/asalh-najd-1.0.63.apk' });
t('رابط خارج المسار الرسمي => apkUrl فارغ', u5.apkUrl === '', u5.apkUrl);
const u6 = await getMeta({
  APP_UPDATE_VERSION: '9.9.9',
  APP_UPDATE_CODE: '90909',
  APP_UPDATE_URL: 'https://github.com/ialshareef/majlis-orders/releases/download/v9.9.9/asalh-najd-9.9.9.apk',
  APP_UPDATE_SHA256: 'a'.repeat(64),
});
t('بيانات بيئة متساقطة كاملة => تُستخدم كما هي',
  u6.versionName === '9.9.9' && u6.versionCode === 90909 && u6.apkUrl.endsWith('/v9.9.9/asalh-najd-9.9.9.apk') && u6.sha256 === 'a'.repeat(64));
t('ملاحظات الإصدار تُحجب عند تضاربها مع الإصدار', Array.isArray(u6.releaseNotes) && u6.releaseNotes.length === 0);

console.log('==== app-version-test: PASS=' + pass + ' FAIL=' + fail + ' ====');
process.exit(fail ? 1 : 0);
