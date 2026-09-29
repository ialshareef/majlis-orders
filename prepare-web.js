// =============================================================================
//  prepare-web.js — ينسخ ملفات التطبيق إلى مجلد www/ لبناء تطبيق الأندرويد (Capacitor)
//  يعمل على أي نظام (Windows / Linux / macOS)
//  تشغيل: node prepare-web.js
// =============================================================================
const fs = require('fs');
const path = require('path');

const root = __dirname;
const www = path.join(root, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

for (const f of ['index.html', 'portal.html', 'config.js', 'sw.js', 'manifest.json']) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(www, f));
}
for (const d of ['css', 'js', 'icons']) {
  const src = path.join(root, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(www, d), { recursive: true });
}

console.log('www prepared:', www);
