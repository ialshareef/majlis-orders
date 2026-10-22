/* مُشغّر اختبارات HTML في متصفح حقيقي بلا يد — بلا حزم إضافية:
   يرفع جذر المشروع على خادم HTTP داخلي ثم يفتح كل اختبار في Chrome/Edge
   headless وينتظر حتى يعلن اكتماله بنفسه بأي من صيغته المعتادة:
     - document.title  = 'DONE p12f0'      (flush())
     - #rep            = 'PASS=12  FAIL=0' (flush())
     - #testResult     = 'PASS 12/12' أو 'FAIL' (نهاية الاختبار)
   ثم يجمع النتائج ويعيد 1 إذا فشل أي اختبار أو تعذّر اكتماله.

   الاستخدام:
     node test/run-html-tests.mjs                       # كل test/*-test.html
     node test/run-html-tests.mjs portal-func-test.html engine-rules-test.html
     node test/run-html-tests.mjs --dir C:\tmp\baseline  # نسخة أخرى من المصدر
     node test/run-html-tests.mjs --timeout 420000 <names...>                     */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let baseDir = path.join(here, '..');
let timeoutMs = 300000;
const names = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') baseDir = path.resolve(argv[++i]);
  else if (argv[i] === '--timeout') timeoutMs = Number(argv[++i]) || timeoutMs;
  else names.push(argv[i]);
}
const tests = names.length ? names
  : fs.readdirSync(path.join(baseDir, 'test')).filter((f) => /-test\.html$/.test(f)).sort();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.sql': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(baseDir, p);
    if (!file.startsWith(baseDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404 ' + p); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('لا يوجد Chrome/Edge'); process.exit(2); }
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--mute-audio', '--font-render-hinting=none', '--hide-scrollbars'] });

/* اكتمال الاختبار بأي من صيغه المعتادة، ثم عدّ النتائج من سطور السجل إن وُجدت
   (أدقّ من اللافتة)، وإلا من العنوان/الـ rep/لافتة النتيجة. */
const isDone = (title, rep, res) =>
  /DONE p\d+f\d+/i.test(title || '') || /PASS=\d+\s+FAIL=\d+/.test(rep || '') || /^(PASS|FAIL)/.test((res || '').trim());
const counts = (txt) => ({
  pass: ((txt || '').match(/^PASS\s/gm) || []).length,
  fail: ((txt || '').match(/^FAIL\s/gm) || []).length,
});
const fallback = (title, rep, res) => {
  let m;
  if ((m = /DONE p(\d+)f(\d+)/i.exec(title || ''))) return { pass: +m[1], fail: +m[2] };
  if ((m = /PASS=(\d+)\s+FAIL=(\d+)/.exec(rep || ''))) return { pass: +m[1], fail: +m[2] };
  if ((m = /PASS (\d+)\/(\d+)/.exec(res || ''))) return { pass: +m[1], fail: +m[1] === +m[2] ? 0 : +m[2] };
  if (/^FAIL/.test((res || '').trim())) return { pass: 0, fail: 1 };
  if (/^PASS/.test((res || '').trim())) return { pass: 1, fail: 0 };
  return { pass: 0, fail: 0 };
};

const rows = [];
let anyFail = 0;
for (const name of tests) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]));
  const t0 = Date.now();
  let outcome = null, note = '', log = '';
  const snapNow = () => page.evaluate(() => ({
    title: document.title || '',
    rep: (document.getElementById('rep') || {}).textContent || '',
    res: (document.getElementById('testResult') || {}).textContent || '',
    log: (document.getElementById('testLog') || {}).textContent || '',
  })).catch(() => null);
  try {
    await page.goto(origin + '/test/' + name.replace(/^test[\\/]/, ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await snapNow();
      if (snap) {
        log = snap.log || '';
        if (isDone(snap.title, snap.rep, snap.res)) {
          const c = counts((snap.rep || '') + '\n' + (snap.log || ''));
          outcome = (c.pass + c.fail > 0) ? c : fallback(snap.title, snap.rep, snap.res);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!outcome) note = 'لم يعلن الاكتمال خلال ' + Math.round(timeoutMs / 1000) + ' ثانية';
  } catch (e) { note = 'خطأ تشغيل: ' + String(e.message).split('\n')[0]; }
  if (!outcome) { anyFail = 1; rows.push({ name, pass: 0, fail: 1, sec: (Date.now() - t0) / 1000, note, errs, log }); }
  else {
    if (outcome.fail > 0) anyFail = 1;
    rows.push({ name, pass: outcome.pass, fail: outcome.fail, sec: (Date.now() - t0) / 1000, note, errs, log });
  }
  await page.close().catch(() => {});
}

for (const r of rows) {
  const st = r.note ? 'TIMEOUT/ERR' : (r.fail ? 'FAIL' : 'PASS');
  console.log(`${st.padEnd(11)} ${r.name.padEnd(30)} PASS=${r.pass} FAIL=${r.fail} (${r.sec.toFixed(1)}s)${r.note ? '  ' + r.note : ''}`);
  if (r.errs && r.errs.length) console.log('             pageerrors: ' + r.errs.slice(0, 3).join(' | '));
  if (r.fail || r.note) {
    const bad = String(r.log || '').split('\n').filter((l) => /FAIL|harness|ERROR/i.test(l)).slice(0, 12);
    if (bad.length) console.log('             ' + bad.join('\n             '));
    if (!bad.length && r.log) console.log('             log tail: ' + String(r.log).split('\n').filter(Boolean).slice(-3).join(' | '));
  }
}
const tp = rows.reduce((s, r) => s + r.pass, 0), tf = rows.reduce((s, r) => s + r.fail, 0);
console.log('\n=== ملفات=' + rows.length + '  PASS=' + tp + '  FAIL=' + tf + ' ===');
await browser.close().catch(() => {});
server.close();
process.exit(anyFail ? 1 : 0);
