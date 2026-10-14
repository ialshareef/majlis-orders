/* مُشغّل عام لاختبارات node في هذا المشروع.
   الخادم (worker/worker.js) ملف ESM، لكن الحزمة بلا "type": module فيتعامل Node
   مع الامتداد .js كـ CommonJS. الحل: ننسخ الخادم بامتداد .mjs ونبدّل مسار
   الاستيراد في نسخة الاختبار في مجلد مؤقت — بلا تعديل المشروع ولا package.json.

   الاستخدام: node run-mjs-test.cjs <مسار ملف الاختبار> [مجلد المشروع] */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TEST = path.resolve(process.argv[2]);
const ROOT = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();
const WORKER = path.join(ROOT, 'worker', 'worker.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mjs-run-'));

fs.copyFileSync(WORKER, path.join(TMP, 'worker.mjs'));
const src = fs.readFileSync(TEST, 'utf8');
const fixed = src.replace(/from\s+(['"])[^'"]*worker(\.js|\.mjs)\1/g, "from './worker.mjs'");
const copy = path.join(TMP, 'test.mjs');
fs.writeFileSync(copy, fixed, 'utf8');

const res = spawnSync(process.execPath, [copy], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);