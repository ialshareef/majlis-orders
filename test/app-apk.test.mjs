/* ملف التحديث عبر الخادم (/api/app-apk): الإصدار الحالي فقط، بطوله ونوعه، بلا تحويل، وليس وكيلاً لأي رابط.
   الاستخدام: node test/app-apk.test.mjs */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'worker', 'worker.js'), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);
const ver = src.match(/const UPDATE_FALLBACK_VERSION = '([^']+)'/)[1];

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + String(e && e.message).split('\n')[0]); } };
const env = () => { const e = envWith({ users: [], sessions: [], orders: [], counters: [], settings: [], items: [] }); e.ALLOWED_ORIGIN = 'https://localhost'; return e; };
const BYTES = new Uint8Array(4096).map((_, i) => i % 251);
const realFetch = globalThis.fetch;
let asked = [];
globalThis.fetch = async (u, o) => { asked.push(String(u)); return new Response(BYTES, { status: 200, headers: { 'content-length': String(BYTES.length) } }); };
const get = (p, origin) => worker.fetch(new Request('https://x.test' + p, { headers: origin ? { Origin: origin } : {} }), env());

await t('الملف الحالي: 200، نوع APK، الطول، CORS للتطبيق، ومن رابط GitHub الرسمي', async () => {
  asked = [];
  const r = await get('/api/app-apk/asalh-najd-' + ver + '.apk', 'https://localhost');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.strictEqual(r.headers.get('content-length'), String(BYTES.length));
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.deepStrictEqual(new Uint8Array(await r.arrayBuffer()), BYTES);
  assert.deepStrictEqual(asked, ['https://github.com/ialshareef/majlis-orders/releases/download/v' + ver + '/asalh-najd-' + ver + '.apk']);
});
await t('اسم ملف إصدار آخر: 409 بلا جلب', async () => {
  asked = [];
  const r = await get('/api/app-apk/asalh-najd-0.0.1.apk');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(asked.length, 0);
});
await t('ليس وكيلاً: لا يقبل رابطاً آخر ولا مساراً أعمق', async () => {
  asked = [];
  await get('/api/app-apk/../../evil');   // يُطبَّع إلى /evil فلا يصل لمسار التحديث أصلاً
  assert.notStrictEqual((await get('/api/app-apk/x/y.apk')).status, 200);
  assert.ok(asked.every((u) => u.startsWith('https://github.com/ialshareef/majlis-orders/releases/download/')));
});
await t('مصدر غير مسموح: بلا ترويسة CORS', async () => {
  const r = await get('/api/app-apk/asalh-najd-' + ver + '.apk', 'https://evil.test');
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
});
await t('فشل GitHub: 502 برسالة عربية', async () => {
  globalThis.fetch = async () => new Response('nf', { status: 404 });
  const r = await get('/api/app-apk/asalh-najd-' + ver + '.apk');
  assert.strictEqual(r.status, 502);
  assert.ok(/تعذّر/.test((await r.json()).error));
});
globalThis.fetch = realFetch;
console.log(`\n=== app-apk: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
