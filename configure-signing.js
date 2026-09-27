// =============================================================================
//  configure-signing.js — يضيف إعداد التوقيع (release) إلى تطبيق الأندرويد المولَّد
//  يُشغَّل بعد `npx cap add android`، ويقرأ android/keystore.properties
// =============================================================================
const fs = require('fs');
const p = 'android/app/build.gradle';
let g = fs.readFileSync(p, 'utf8');

if (!g.includes('signingConfigs')) {
  // تحميل خصائص المفتاح قبل كتلة android
  g = `def keystoreProperties = new Properties()\ndef keystorePropertiesFile = rootProject.file("keystore.properties")\nif (keystorePropertiesFile.exists()) { keystoreProperties.load(new FileInputStream(keystorePropertiesFile)) }\n\n` + g;

  // إعداد التوقيع داخل android { }
  g = g.replace(/android\s*\{/, `android {\n    signingConfigs {\n        release {\n            storeFile file(keystoreProperties['storeFile'] ?: 'release.keystore')\n            storePassword keystoreProperties['storePassword']\n            keyAlias keystoreProperties['keyAlias']\n            keyPassword keystoreProperties['keyPassword']\n        }\n    }\n`);

  // ربط التوقيع بنوع الإصدار release
  g = g.replace(/buildTypes\s*\{\s*release\s*\{/, `buildTypes {\n        release {\n            signingConfig signingConfigs.release\n`);
}

fs.writeFileSync(p, g);
console.log('signing configured');
