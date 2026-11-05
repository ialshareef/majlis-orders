/* جاهزية النشر: CORS (تطبيق أندرويد https://localhost وطلبات OPTIONS) · سكربت النشر
   (الوضع الآمن الافتراضي وحفظ متغيرات اللوحة) · أمر النشر في AGENTS.md · توافق schema.sql
   مع الهجرات وترتيب إنشاء الجداول على SQLite حقيقية (node:sqlite) مع فرض المفاتيح الأجنبية
   كما تفعل D1. بلا شبكة ولا أسرار ولا حزم إضافية.

   الاستخدام: node test/deploy-readiness.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(read('worker/worker.js')).toString('base64'));
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

/* ---------------- 1) CORS ---------------- */
const ANDROID = 'https://localhost';
const SITE = 'https://majlis-api.asalh-najd.workers.dev';
const send = async (allowed, method, origin, p = '/api/me', extra = {}) => {
  const env = envWith();
  if (allowed === undefined) delete env.ALLOWED_ORIGIN; else env.ALLOWED_ORIGIN = allowed;
  const headers = Object.assign(origin ? { Origin: origin } : {}, extra);
  const r = await worker.fetch(new Request('https://majlis.test' + p, { method, headers }), env);
  return { status: r.status, acao: r.headers.get('access-control-allow-origin'), h: r.headers };
};
const LIST = ` ${ANDROID} , ${SITE} `; // مسافات حول الفواصل تُتجاهل

let r = await send(LIST, 'OPTIONS', ANDROID, '/api/sync', { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-session-token' });
ok(r.status === 204 && r.acao === ANDROID, 'cors: OPTIONS من تطبيق أندرويد (https://localhost) مسموح 204', r);
const methods = (r.h.get('access-control-allow-methods') || '').split(',').map((s) => s.trim());
ok(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'].every((m) => methods.includes(m)), 'cors: الفحص المسبق يسمح بـ GET/POST/PUT/DELETE (الواجهة تستعمل PUT)', methods);
const allowH = (r.h.get('access-control-allow-headers') || '').toLowerCase();
ok(allowH.includes('x-session-token') && allowH.includes('content-type'), 'cors: الفحص المسبق يسمح بترويسة الجلسة وContent-Type', allowH);
ok(/origin/i.test(r.h.get('vary') || ''), 'cors: Vary: Origin (لا يخلط الكاش بين المصادر)');
ok(!r.h.get('access-control-allow-credentials'), 'cors: لا Allow-Credentials (الجلسة ترويسة لا كوكي)');

r = await send(LIST, 'OPTIONS', SITE, '/api/designs/x', { 'Access-Control-Request-Method': 'PUT' });
ok(r.status === 204 && r.acao === SITE, 'cors: أكثر من مصدر: المصدر الثاني في القائمة مسموح أيضاً', r.acao);

for (const bad of ['https://evil.example', 'http://localhost', 'https://localhost:8443', 'https://localhost.evil.example', 'null', SITE + '.evil.example']) {
  r = await send(LIST, 'OPTIONS', bad, '/api/sync', { 'Access-Control-Request-Method': 'POST' });
  ok(!r.acao, `cors: OPTIONS من مصدر غير مدرج يُرفض (${bad})`, r.acao);
}

r = await send(LIST, 'GET', ANDROID);
ok(r.status === 200 && r.acao === ANDROID, 'cors: طلب فعلي من أندرويد يحمل الترويسة', r);
r = await send(LIST, 'GET', 'https://evil.example');
ok(!r.acao, 'cors: طلب فعلي من مصدر غير مدرج بلا ترويسة', r.acao);
r = await send(LIST, 'GET', ANDROID, '/api/bootstrap');
ok(r.status === 401 && r.acao === ANDROID, 'cors: رد الخطأ (401) لمصدر مسموح يحمل الترويسة (الواجهة تقرأ الخطأ)', r);
r = await send(LIST, 'GET', null);
ok(r.status === 200 && !r.acao, 'cors: طلب من نفس الموقع (بلا Origin) يعمل دون ترويسة', r);

r = await send(undefined, 'OPTIONS', ANDROID);
ok(!r.acao, 'cors: بلا ALLOWED_ORIGIN يُرفض كل مصدر (فشل مُغلق)', r.acao);
r = await send('*', 'OPTIONS', ANDROID);
ok(!r.acao, 'cors: ALLOWED_ORIGIN=* لا يفتح الوصول لكل المصادر', r.acao);
r = await send(`*, ${ANDROID}`, 'OPTIONS', ANDROID);
ok(!r.acao, 'cors: وجود * داخل القائمة يرفضها كلها (لا فتح بالخطأ)', r.acao);
r = await send(ANDROID, 'OPTIONS', ANDROID);
ok(r.acao === ANDROID, 'cors: مصدر واحد بلا فواصل يعمل', r.acao);

/* ---------------- 2) سكربت النشر ---------------- */
const ps = read('deploy-cloudflare.ps1');
ok(/\[string\]\$Environment\s*=\s*'test'/.test(ps) && /\[switch\]\$Preview\s*=\s*\$true/.test(ps), 'deploy: الافتراضي آمن (test + Preview)');
const keep = (ps.match(/keep_bindings\s*=\s*@\(([^)]*)\)/) || [])[1] || '';
ok(/'plain_text'/.test(keep) && /'secret_text'/.test(keep), 'deploy: الرفع يحافظ على متغيرات اللوحة وأسرارها (keep_bindings)', keep);
ok(/@\{ type = 'ai'; name = 'AI' \}/.test(ps), 'deploy: ربط Cloudflare Workers AI (بوت تصميم العميل المجاني) باسم AI');
ok(!/ALLOWED_ORIGIN\s*=|ADMIN_INIT_PASSWORD\s*=|AI_API_KEY\s*=/.test(ps) && !/type\s*=\s*'(plain_text|secret_text)'/.test(ps), 'deploy: السكربت لا يكتب قيم المتغيرات أو الأسرار');
ok(ps.indexOf("worker\\schema.sql") > 0 && ps.indexOf("worker\\schema.sql") < ps.indexOf("Step 'Uploading worker'"), 'deploy: schema.sql يُنفَّذ قبل رفع الكود');
const guardAt = ps.indexOf("Step 'Checking table definitions'");
ok(guardAt > ps.indexOf("worker\\schema.sql") && guardAt < ps.indexOf("Step 'Uploading worker'") && /REFERENCES\\s\+users/.test(ps) && /003_fix_user_delete_fks\.sql/.test(ps),
  'deploy: حارس التعريفات القديمة بعد schema.sql وقبل الرفع، ويدلّ على الهجرة 003');
const guard004 = ps.indexOf('004_expense_fields.sql');
ok(guard004 > guardAt && guard004 < ps.indexOf("Step 'Uploading worker'") && /expense_date/.test(ps.slice(guardAt, guard004)) && /order_id/.test(ps.slice(guardAt, guard004)),
  'deploy: حارس حقول المصروفات (004) بعد schema.sql وقبل الرفع');

/* ---------------- 3) AGENTS.md ---------------- */
const ag = read('AGENTS.md');
const codeLines = [...ag.matchAll(/^\s*(powershell[^\n]*deploy-cloudflare\.ps1[^\n]*)$/gm)].map((m) => m[1].trim());
const prodCmd = codeLines.find((l) => /-Environment production\b/.test(l) && /-Preview:\$false/.test(l));
ok(!!prodCmd && /-Command\b/.test(prodCmd) && !/-File\b/.test(prodCmd), 'agents: أمر النشر الإنتاجي يستخدم -Command (لا -File)', codeLines);

// -Preview:$false لا يُمرَّر عبر -File في أي أمر موثّق (PowerShell 5.1 يرفضه قبل بدء السكربت)
const docs = ['AGENTS.md', 'README.md', 'SETUP-CLOUDFLARE.md', 'deploy-cloudflare.ps1'];
const badFile = docs.flatMap((f) => read(f).split('\n').filter((l) => /powershell[^`\n]*-File[^`\n]*-Preview:\$false/.test(l)).map((l) => f + ': ' + l.trim()));
ok(badFile.length === 0, 'docs: لا أمر موثّق يمرّر -Preview:$false عبر -File', badFile);

/* تشغيل فعلي لأمر النشر الموثّق كما يُكتب في PowerShell، على سكربت بديل يطبع المعاملات فقط
   (في مجلد مؤقت — لا اتصال ولا رمز ولا نشر). Windows فقط. */
if (process.platform === 'win32' && prodCmd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-cmd-'));
  fs.writeFileSync(path.join(tmp, 'deploy-cloudflare.ps1'),
    "param([string]$Environment = 'test', [switch]$Preview = $true, [switch]$Confirm = $true)\n\"BOUND Environment=$Environment Preview=$([bool]$Preview)\"\n", 'ascii');
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', prodCmd], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  const out = String(run.stdout || '') + String(run.stderr || '');
  ok(/BOUND Environment=production Preview=False/.test(out), 'agents: أمر النشر الموثّق يعمل فعلاً في PowerShell (Preview=False، production)', out.trim().slice(0, 200));
  fs.rmSync(tmp, { recursive: true, force: true });
} else console.log('SKIP  ليس Windows — تخطّي التشغيل الفعلي لأمر النشر');
ok(codeLines.some((l) => /-Environment production\b/.test(l) && !/-Preview/.test(l)), 'agents: أمر المعاينة منفصل عن النشر', codeLines);
ok(codeLines.some((l) => /-Environment test\b/.test(l) && /-AccountId/.test(l)), 'agents: أمر بيئة الاختبار منفصل', codeLines);
ok(!codeLines.some((l) => /deploy-cloudflare\.ps1$/.test(l)), 'agents: لا أمر نشر بلا معاملات (يعمل كمعاينة اختبار لا كنشر)', codeLines);
ok(/ALLOWED_ORIGIN/.test(ag) && ag.includes(ANDROID) && /ADMIN_INIT_PASSWORD[^\n]*Secret/.test(ag), 'agents: ALLOWED_ORIGIN (أندرويد) وADMIN_INIT_PASSWORD كسر موثّقان');
ok(!/git add -A/.test(ag.replace(/لا `git add -A`/g, '')), 'agents: لا تعليمات git add -A');

/* ---------------- 4) schema.sql والهجرات (SQLite حقيقية) ---------------- */
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (_) { /* إصدار Node أقدم */ }
if (!sqlite) {
  console.log('SKIP  node:sqlite غير متوفر — تخطّي فحوص القاعدة');
} else {
  const { DatabaseSync } = sqlite;
  const schema = read('worker/schema.sql');
  const migs = fs.readdirSync(path.join(root, 'worker', 'migrations')).filter((f) => /\.sql$/.test(f)).sort();
  const fresh = () => { const d = new DatabaseSync(':memory:'); d.exec('PRAGMA foreign_keys = ON'); return d; };
  const tryExec = (d, sql) => { try { d.exec(sql); return null; } catch (e) { return e.message; } };
  const objs = (d) => d.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((o) => o.type + ':' + o.name + ':' + String(o.sql || '').replace(/--[^\n]*/g, '').replace(/IF NOT EXISTS /gi, '').replace(/"/g, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim());
  const userDefs = (d) => d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('permission_audit', 'expenses')").all();
  const hasBlockingFk = (d) => userDefs(d).some((r) => /REFERENCES\s+users/i.test(r.sql)); // نفس فحص سكربت النشر
  const hasExpenseCols = (d) => userDefs(d).some((r) => r.name === 'expenses' && /\bexpense_date\b/.test(r.sql) && /\border_id\b/.test(r.sql)); // فحص 004 في السكربت

  // الهجرات بالترتيب (001 ← 004) تنتهي بالتعريفات نفسها التي ينشئها schema.sql مباشرة
  ok(migs.join(',') === '001_permission_tables.sql,002_expenses.sql,003_fix_user_delete_fks.sql,004_expense_fields.sql,005_whatsapp_notifications.sql', 'schema: الهجرات 001 و002 كما هي، والتصحيح في 003، وحقول المصروفات في 004، وإشعارات واتساب في 005', migs);
  const viaSchema = fresh(); viaSchema.exec(schema);
  const viaMigs = fresh();
  viaMigs.exec(schema.split('-- Permission Manager tables')[0]); // الجداول الأساسية فقط
  for (const m of migs) ok(tryExec(viaMigs, read('worker/migrations/' + m)) === null, 'schema: الهجرة ' + m + ' تُطبَّق على قاعدة قائمة');
  const sObjs = new Set(objs(viaSchema));
  const missing = objs(viaMigs).filter((o) => !sObjs.has(o));
  ok(missing.length === 0, 'schema: 001+002+003+004 = تعريفات schema.sql حرفياً', missing);
  ok(objs(viaSchema).length === objs(viaMigs).length, 'schema: لا كائنات زائدة أو ناقصة بين المسارين');
  ok(!hasBlockingFk(viaSchema), 'fresh: التثبيت الجديد (schema.sql) بلا مفاتيح أجنبية معطِّلة — حارس النشر يمر');
  ok(hasExpenseCols(viaSchema), 'fresh: التثبيت الجديد فيه حقول المصروفات — لا يحتاج 003 ولا 004 (الحارس يمر)');
  const m004 = read('worker/migrations/004_expense_fields.sql');
  ok(/NOT re-runnable/.test(m004) && /Do not run 003 after this file/.test(m004), '004: موثَّق أنها لا تُعاد، ولا تُشغَّل 003 بعدها');

  /* مسار الترقية: قاعدة طُبِّقت عليها 001/002 القديمة وفيها بيانات ← schema.sql (النشر) ← 003 */
  const upgraded = () => {
    const d = fresh();
    d.exec(schema.split('-- Permission Manager tables')[0]);
    d.exec(read('worker/migrations/001_permission_tables.sql'));
    d.exec(read('worker/migrations/002_expenses.sql'));
    d.exec("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('a','admin','A','x','admin',1,'t'),('s','staff','S','x','staff',1,'t')");
    d.exec("INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('s','orders.view_all',1,'a','t')");
    d.exec("INSERT INTO permission_audit (id, at, actor_user_id, actor_name, target_user_id, target_name, change_type, permission, old_value, new_value, reason) VALUES ('p1','2026-11-01','a','A','s','S','permission','orders.view_all',NULL,'1','r'),('p2','2026-11-02','a','A','s','S','defaults_restore',NULL,'{}','default',NULL)");
    d.exec("INSERT INTO expenses (id, name, amount, category, note, created_by, created_at, updated_at) VALUES ('e1','وقود',120.5,'نقل','ملاحظة','s','2026-11-01','2026-11-01'),('e2','x',3,NULL,NULL,'a','2026-11-02','2026-11-02')");
    return d;
  };
  let u = upgraded();
  ok(hasBlockingFk(u) && /append-only|NOT NULL constraint failed: expenses\.created_by/.test(tryExec(u, "DELETE FROM users WHERE id = 's'") || ''), 'upgrade: التعريفات القديمة تمنع حذف المستخدم (العطل مُثبت قبل التصحيح)');
  ok(tryExec(u, schema) === null && hasBlockingFk(u), 'upgrade: schema.sql وحده لا يصلح الجداول القائمة — لذلك حارس النشر يتوقف');
  const before = { audit: u.prepare('SELECT * FROM permission_audit ORDER BY id').all(), exp: u.prepare('SELECT * FROM expenses ORDER BY id').all() };
  ok(tryExec(u, read('worker/migrations/003_fix_user_delete_fks.sql')) === null, 'upgrade: 003 تُطبَّق على القاعدة المرقّاة بلا خطأ');
  ok(JSON.stringify(u.prepare('SELECT * FROM permission_audit ORDER BY id').all()) === JSON.stringify(before.audit), 'upgrade: صفوف سجل التدقيق محفوظة كما هي بكل أعمدتها');
  ok(JSON.stringify(u.prepare('SELECT * FROM expenses ORDER BY id').all()) === JSON.stringify(before.exp), 'upgrade: صفوف المصروفات محفوظة كما هي بكل أعمدتها');
  ok(!u.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__old003%'").all().length, 'upgrade: لا جداول مؤقتة متبقية');
  ok(/append-only/.test(tryExec(u, "UPDATE permission_audit SET reason = 'x'") || '') && /append-only/.test(tryExec(u, 'DELETE FROM permission_audit') || ''), 'upgrade: سجل التدقيق ما زال للإلحاق فقط بعد 003');
  ok(tryExec(u, read('worker/migrations/003_fix_user_delete_fks.sql')) === null && u.prepare('SELECT COUNT(*) n FROM permission_audit').get().n === 2, 'upgrade: إعادة تشغيل 003 قبل 004 آمنة (لا فقد ولا تكرار)');
  ok(!hasExpenseCols(u) && tryExec(u, m004) === null && hasExpenseCols(u), 'upgrade: 004 تضيف حقول المصروفات (الحارس كان سيتوقف قبلها)');
  ok(u.prepare("SELECT expense_date FROM expenses WHERE id='e1'").get().expense_date === '2026-11-01' && u.prepare("SELECT amount FROM expenses WHERE id='e1'").get().amount === 120.5, 'upgrade: 004 تملأ تاريخ المصروف من created_at ولا تغيّر البيانات');
  ok(!hasBlockingFk(u) && objs(u).join() === [...sObjs].join(), 'upgrade: بعد 003+004 التعريفات = schema.sql حرفياً (فهارس ومشغّلات) — حارس النشر يمر');
  ok(tryExec(u, "DELETE FROM users WHERE id = 's'") === null && u.prepare('SELECT COUNT(*) n FROM permission_audit').get().n === 2 && u.prepare("SELECT created_by FROM expenses WHERE id='e1'").get().created_by === 's' && u.prepare('SELECT COUNT(*) n FROM user_permissions').get().n === 0, 'upgrade: حذف المستخدم ينجح بعد 003 والسجل والمصروف يبقيان');
  ok(u.prepare('PRAGMA foreign_key_check').all().length === 0 && u.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'upgrade: سلامة القاعدة والمفاتيح بعد 003');

  // مسار النشر: schema.sql على قاعدة الإنتاج الحالية (نسخة HEAD) ثم إعادة تشغيله
  let headSchema = null;
  try { headSchema = execFileSync('git', ['show', 'HEAD:worker/schema.sql'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { /* لا git */ }
  if (headSchema) {
    const d = fresh(); d.exec(headSchema);
    d.exec("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('old','old','قديم','x','admin',1,'t')");
    ok(tryExec(d, schema) === null, 'schema: schema.sql يُطبَّق على قاعدة الإنتاج الحالية (HEAD) بلا خطأ');
    ok(tryExec(d, schema) === null, 'schema: إعادة تشغيل schema.sql آمنة (idempotent)');
    const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_permissions','permission_audit','expenses')").all();
    ok(t.length === 3, 'schema: الجداول الجديدة موجودة بعد النشر وقبل أن يحتاجها الكود');
    ok(d.prepare('SELECT COUNT(*) n FROM users').get().n === 1, 'schema: البيانات القائمة لم تُمس');
    // قاعدة HEAD التي جدول مصروفاتها بلا الحقول الجديدة: الحارس يتوقف، ثم 004 تكمل المخطط
    if (!hasExpenseCols(d)) {
      d.exec("INSERT INTO expenses (id, name, amount, created_by, created_at, updated_at) VALUES ('h1','قديم',10,'old','2026-11-03T10:00:00.000Z','2026-11-03T10:00:00.000Z')");
      ok(!hasBlockingFk(d) && !hasExpenseCols(d), 'prod-path: بعد schema.sql الحارس يتوقف لنقص حقول المصروفات (لا رفع للكود)');
      ok(tryExec(d, m004) === null && hasExpenseCols(d) && d.prepare("SELECT expense_date FROM expenses WHERE id='h1'").get().expense_date === '2026-11-03', 'prod-path: 004 تكمل الحقول وتملأ التاريخ');
      ok(objs(d).join() === [...sObjs].join(), 'prod-path: بعد 004 المخطط = schema.sql حرفياً — الحارس يمر');
    } else console.log('NOTE  قاعدة HEAD فيها حقول المصروفات مسبقاً — مسار 004 غير مطلوب');
  } else console.log('SKIP  git غير متوفر — تخطّي فحص قاعدة HEAD');

  // حذف المستخدم مع المفاتيح الأجنبية مفعّلة (كما في D1)
  const base = () => { const d = fresh(); d.exec(schema);
    d.exec("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('a','admin','A','x','admin',1,'t'),('s','staff','S','x','staff',1,'t')"); return d; };
  let d = base();
  d.exec("INSERT INTO permission_audit (id, at, actor_user_id, actor_name, target_user_id, target_name, change_type) VALUES ('p1','t','a','A','s','S','permission')");
  ok(tryExec(d, "DELETE FROM users WHERE id = 's'") === null, 'schema: حذف مستخدم ورد في سجل التدقيق ينجح');
  ok(d.prepare("SELECT target_user_id, target_name FROM permission_audit").get().target_name === 'S', 'schema: سجل التدقيق يبقى كاملاً بعد حذف المستخدم');
  ok(/append-only/.test(tryExec(d, "UPDATE permission_audit SET reason = 'x'") || '') && /append-only/.test(tryExec(d, 'DELETE FROM permission_audit') || ''), 'schema: سجل التدقيق للإلحاق فقط (لا تعديل ولا حذف)');
  d = base();
  d.exec("INSERT INTO expenses (id, name, amount, created_by, created_at, updated_at) VALUES ('e1','x',1,'s','t','t')");
  ok(tryExec(d, "DELETE FROM users WHERE id = 's'") === null && d.prepare('SELECT created_by FROM expenses').get().created_by === 's', 'schema: حذف مستخدم له مصروفات ينجح والمصروف يبقى منسوباً له');
  d = base();
  d.exec("INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('s','orders.view_all',1,'a','t')");
  ok(tryExec(d, "DELETE FROM users WHERE id = 's'") === null && d.prepare('SELECT COUNT(*) n FROM user_permissions').get().n === 0, 'schema: تجاوزات المستخدم المحذوف تُحذف معه (CASCADE)');
  d = base();
  d.exec("INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('s','orders.view_all',1,'a','t')");
  ok(tryExec(d, "DELETE FROM users WHERE id = 'a'") === null && d.prepare('SELECT updated_by FROM user_permissions').get().updated_by === null, 'schema: حذف المدير الذي عدّل الصلاحيات ينجح (updated_by ← NULL)');
}

console.log(`\n=== deploy-readiness: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
