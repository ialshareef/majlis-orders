#!/usr/bin/env node
/* أداة Cloudflare للإصدار (تعمل على ويندوز وLinux والسحابة):
     node tools/cf.mjs counts            قراءة فقط: أعداد المستخدمين والطلبات والتصاميم والمصروفات + الربط
     node tools/cf.mjs backup <ملف.sql>  نسخة احتياطية كاملة لقاعدة الإنتاج (D1 export)
   الرمز: متغير البيئة CLOUDFLARE_API_TOKEN (في GitHub Actions سرّ بالاسم نفسه)، وإلا ملف .cf-token
   بجذر المشروع. لا يُطبع الرمز أبداً ولا يُكتب في أي ملف.
   تنبيه: ملف النسخة الاحتياطية فيه بيانات حساسة (بصمات كلمات المرور وبيانات العملاء) —
   لا يُرفع إلى المستودع ولا يُشارك، وفي السحابة يُشفَّر قبل حفظه (انظر .github/workflows/deploy.yml). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const DB_NAME = process.env.CF_DB_NAME || 'majlis-db';
const WORKER = process.env.CF_WORKER_NAME || 'majlis-api';

function token() {
  const env = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (env) return env;
  const f = path.join(root, '.cf-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('لا يوجد رمز Cloudflare: اضبط CLOUDFLARE_API_TOKEN أو أنشئ .cf-token');
}
const TOKEN = token();

async function cf(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`CF ${method} ${p} failed: ${r.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j;
}

const acc = (await cf('GET', '/accounts')).result[0].id;
const db = ((await cf('GET', `/accounts/${acc}/d1/database?name=${encodeURIComponent(DB_NAME)}&per_page=50`)).result || []).find((d) => d.name === DB_NAME);
if (!db) throw new Error('قاعدة البيانات غير موجودة: ' + DB_NAME);
const q = async (sql) => (await cf('POST', `/accounts/${acc}/d1/database/${db.uuid}/query`, { sql })).result[0].results;

const [action, arg] = process.argv.slice(2);
if (action === 'counts') {
  const c = (await q("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM customer_designs) AS designs, (SELECT COUNT(*) FROM expenses) AS expenses"))[0];
  console.log('counts: ' + JSON.stringify(c));
  const b = (await cf('GET', `/accounts/${acc}/workers/scripts/${WORKER}/settings`)).result.bindings || [];
  console.log('bindings: ' + b.map((x) => x.type + ' ' + x.name).join(', '));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `users=${c.users}\norders=${c.orders}\ndesigns=${c.designs}\n`);
} else if (action === 'backup') {
  if (!arg) throw new Error('حدّد مسار ملف النسخة: node tools/cf.mjs backup <ملف.sql>');
  const base = `/accounts/${acc}/d1/database/${db.uuid}/export`;
  let r = await cf('POST', base, { output_format: 'polling' });
  const bm = r.result.at_bookmark;
  for (let i = 0; i < 90 && !(r.result.status === 'complete' && r.result.result && r.result.result.signed_url); i++) {
    if (r.result.status === 'error') throw new Error('export error: ' + r.result.error);
    await new Promise((res) => setTimeout(res, 2000));
    r = await cf('POST', base, { output_format: 'polling', current_bookmark: bm });
  }
  const url = r.result.result && r.result.result.signed_url;
  if (!url) throw new Error('لم يكتمل التصدير');
  const dump = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (dump.length < 1000) throw new Error('ملف النسخة صغير على نحو مريب: ' + dump.length + ' بايت');
  fs.mkdirSync(path.dirname(path.resolve(arg)), { recursive: true });
  fs.writeFileSync(arg, dump);
  console.log(`saved ${arg} (${dump.length} bytes)`);
} else {
  console.log('الاستخدام: node tools/cf.mjs counts | backup <ملف.sql>');
  process.exit(2);
}
