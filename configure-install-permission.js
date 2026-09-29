// =============================================================================
//  configure-install-permission.js — يضيف إذن REQUEST_INSTALL_PACKAGES إلى
//  AndroidManifest.xml المولَّد (idempotent: لا يكرر الإذن).
//  يُشغَّل بعد `npx cap add android` (انظر .github/workflows/build-apk.yml).
//  السبب: التحديث الذاتي يفتح APK عبر مثبّت النظام الرسمي (ACTION_VIEW)،
//  وهذا يتطلب ظهور التطبيق في قائمة «تثبيت التطبيقات غير المعروفة» ليمنح
//  المستخدم السماح من الإعدادات — آلية أندرويد الرسمية، بلا أي تجاوز.
// =============================================================================
const fs = require('fs');
const p = 'android/app/src/main/AndroidManifest.xml';
let x = fs.readFileSync(p, 'utf8');

const perm = 'android.permission.REQUEST_INSTALL_PACKAGES';
if (!x.includes(perm)) {
  x = x.replace(
    /<manifest([^>]*)>/,
    `<manifest$1>\n    <uses-permission android:name="${perm}" />`
  );
  if (!x.includes(perm)) throw new Error('manifest tag not found in ' + p);
  fs.writeFileSync(p, x);
  console.log('install permission added');
} else {
  console.log('install permission already present');
}
