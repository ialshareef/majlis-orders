#!/usr/bin/env node
/* تشغيل كل اختبارات المشروع (ويندوز وLinux والسحابة):
     npm test                       كل الاختبارات: ملفات test/*.mjs ثم اختبارات HTML في المتصفح
     node tools/run-tests.mjs --quick   اختبارات الخادم والمنطق فقط (بلا متصفح) — أسرع
   المتصفح: Chrome/Chromium/Edge يُعثر عليه تلقائياً، أو حدّده بـ CHROME_PATH.
   رمز الخروج 2 من اختبار = تخطٍّ (لا متصفح على الجهاز) ويُعرض «تخطّى» لا «نجح». */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const BROWSER = /puppeteer-core/;
const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run-html-tests.mjs').sort();

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: root, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); out += '\n[timeout]'; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code === null ? 124 : code, out }); });
  });
}

let failed = 0, skipped = 0, passed = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(root, 'test', f), 'utf8');
  if (quick && (BROWSER.test(src) || /_app-harness/.test(src))) continue;
  const r = await run([path.join('test', f)], 400000);
  const last = (r.out.split('\n').filter((l) => /PASS|FAIL|نجح/.test(l)).pop() || '').slice(0, 110);
  if (r.code === 0) { passed++; console.log(`[ok]   ${f}  ${last}`); }
  else if (r.code === 2) { skipped++; console.log(`[skip] ${f}  (لا متصفح)`); }
  else { failed++; console.log(`[FAIL] ${f} (code ${r.code})\n${r.out.split('\n').filter((l) => /FAIL|Error|استثناء/.test(l)).slice(0, 15).join('\n')}`); }
}
if (!quick) {
  const r = await run([path.join('test', 'run-html-tests.mjs'), '--timeout', '300000'], 1500000);
  const sum = r.out.split('\n').filter((l) => /^FAIL|===/.test(l)).join('\n');
  console.log('=== html\n' + sum);
  if (r.code === 2) skipped++;
  else if (r.code !== 0) failed++;
}
console.log(`\n=== ملفات ناجحة=${passed}  متخطّاة=${skipped}  فاشلة=${failed} ===`);
process.exit(failed ? 1 : 0);
