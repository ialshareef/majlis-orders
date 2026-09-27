// =============================================================================
//  configure-version.js — يضبط versionCode و versionName في android/app/build.gradle
//  يُشغَّل بعد `npx cap add android`، ويقرأ الإصدار من متغير البيئة APP_VERSION
// =============================================================================
const fs = require('fs');
const p = 'android/app/build.gradle';
let g = fs.readFileSync(p, 'utf8');

const raw = String(process.env.APP_VERSION || '').trim();
const parts = raw.split('.').map((n) => parseInt(n, 10));

// versionCode رقمية متزايدة: رئيسي*10000 + فرعي*100 + تصحيح (1.0.10 -> 10010)
let versionCode = 1;
if (parts.length >= 2 && parts.every((n) => Number.isInteger(n) && n >= 0)) {
  versionCode = parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}
if (versionCode < 1) versionCode = 1;

const versionName = raw || '1.0.0';

g = g.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
g = g.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

fs.writeFileSync(p, g);
console.log(`version set: ${versionName} (code ${versionCode})`);
