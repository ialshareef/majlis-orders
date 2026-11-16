/* عهدة الموظف (الاستلام) على الخادم الحقيقي بقاعدة D1 وهمية: من يسجّل ومن يرى ومن يعدّل ويحذف، والتحقق من المبلغ.
   الاستخدام: node test/custody.test.mjs */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(here, '..', 'worker', 'worker.js'), 'utf8')).toString('base64'))).default;
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);

let pass = 0, fail = 0;
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + String(e && e.message).split('\n')[0]); }
};
const PW = 'Str0ng!Pass2026';
const salt = crypto.randomBytes(16);
const H = `pbkdf2$100000$${salt.toString('base64')}$${crypto.pbkdf2Sync(PW, salt, 100000, 32, 'sha256').toString('base64')}`;
const past = new Date(Date.now() - 86400000).toISOString(), future = new Date(Date.now() + 86400000).toISOString();
const U = (id, username, role, extra = {}) => Object.assign({ id, username, name: username, role, active: 1, created_at: past, must_change_password: 0, password_hash: H }, extra);
const ADMIN_ONLY = ['admin.core', 'permissions.manage', 'users.create', 'users.edit', 'users.disable', 'settings.manage'];

/** 1 = المالك، 5 و6 مديران عاديان، 2 و4 موظفان، 3 و7 مندوبان (7 تابع لـ3) */
function mk({ grants = [], owner = '1', settings = { sellerRate: 2, mandoubRate: 5, shareRate: 4, mandoubParentRate: 1 } } = {}) {
  const env = envWith({
    users: [U('1', 'owner', 'admin'), U('2', 'staff1', 'staff'), U('3', 'mand1', 'mandoub', { rate: 7 }), U('4', 'staff2', 'staff'),
      U('5', 'admin2', 'admin'), U('6', 'admin3', 'admin'), U('7', 'mand2', 'mandoub', { rate: 6, parent_id: '3', parent_rate: 2 })],
    sessions: ['1', '2', '3', '4', '5', '6', '7'].map((u) => ({ token: 'tok-' + u, user_id: u, created_at: past, expires_at: future })),
    orders: [], counters: [{ key: 'order_no', value: 1000 }], settings: [{ id: 1, data: JSON.stringify(settings), updated_at: past }], items: [],
  });
  for (const t of ['permission_audit', 'activity', 'expenses', 'login_fail']) env.DB.tables.set(t, []);
  env.DB.tables.set('customer_designs', [{ id: 'd1', public_no: 26000300, token: 't', status: 'new', design: JSON.stringify({ walls: [], pieces: [] }), customer_name: 'C', customer_phone: '', contact_requested: 0, order_id: null, order_number: null, created_at: past, updated_at: past, expires_at: future }]);
  env.DB.tables.set('user_permissions', grants.map(([user_id, permission, value, by]) => ({ user_id, permission, value, updated_by: by === undefined ? '1' : by, updated_at: past })));
  if (owner !== null) env.OWNER_USER_ID = owner;
  // D1 الوهمية لا تدعم lower(col) ولا IS NOT — صيغة مكافئة هنا فقط
  const prep = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => prep(String(sql).replace(/lower\(username\)\s*=\s*\?/i, 'username = ?').replace(/\bid IS NOT \?/i, 'id <> ?'));
  return env;
}
const call = async (env, p, uid, body, method, headers = {}) => {
  const r = await worker.fetch(new Request('https://x.test' + p, { method: method || (body ? 'POST' : 'GET'),
    headers: Object.assign({ 'content-type': 'application/json', 'x-session-token': uid ? ((String(uid).startsWith('tok') || String(uid).length > 20) ? uid : 'tok-' + uid) : '' }, headers),
    body: body ? JSON.stringify(body) : undefined }), env);
  let d = null; try { d = await r.json(); } catch (_) {}
  return { s: r.status, d };
};
const perms = async (env, uid) => ((await call(env, '/api/bootstrap', uid)).d || {}).permissions || [];
const userRow = (env, id) => env.DB.tables.get('users').find((u) => String(u.id) === String(id));
const newUser = (role, extra = {}) => Object.assign({ name: 'New ' + role, username: 'new_' + role + '_' + Math.random().toString(36).slice(2, 7), role, password: PW, active: true }, extra);
const editUser = (env, id, changes) => { const u = userRow(env, id); return Object.assign({ id, name: u.name, username: u.username, role: u.role, active: !!u.active }, changes); };


const G = (u, ...ps) => ps.map((p) => [u, p, 1]);
// الموظف 2 والموظف 4 يملكان مصروفاتهما (عرض وإضافة وتعديل وحذف لأنفسهم)
const OWN = ['expenses.view_own', 'expenses.add_own', 'expenses.edit_own', 'expenses.delete_own'];
const env0 = () => { const e = mk({ grants: [...G('2', ...OWN), ...G('4', ...OWN)] }); return e; };
const rows = (env) => env.DB.tables.get('custody_receipts') || [];

await ta('الموظف يسجّل استلاماً لنفسه: التاريخ والوقت من الخادم، والمسجِّل هو', async () => {
  const env = env0();
  const t0 = Date.now();
  const r = await call(env, '/api/custody', '2', { amount: 1500, note: 'من المدير' });
  assert.strictEqual(r.s, 200, JSON.stringify(r.d));
  const x = rows(env)[0];
  assert.strictEqual(x.user_id, '2'); assert.strictEqual(x.created_by, '2'); assert.strictEqual(Number(x.amount), 1500);
  assert.ok(Date.parse(x.created_at) >= t0 - 1000, 'created_at تلقائي');
  const l = await call(env, '/api/custody', '2');
  assert.strictEqual(l.s, 200); assert.strictEqual(l.d.receipts.length, 1); assert.strictEqual(l.d.receipts[0].can_delete, true);
});
await ta('الموظف لا يسجّل استلاماً باسم غيره، ولا يرى عهدة غيره، ولا يعدّلها أو يحذفها', async () => {
  const env = env0();
  assert.strictEqual((await call(env, '/api/custody', '2', { amount: 100, user_id: '4' })).s, 403);
  await call(env, '/api/custody', '4', { amount: 300 });
  const id = rows(env)[0].id;
  assert.strictEqual((await call(env, '/api/custody', '2')).d.receipts.length, 0);
  assert.strictEqual((await call(env, '/api/custody/' + id, '2', { amount: 1 }, 'PUT')).s, 403);
  assert.strictEqual((await call(env, '/api/custody/' + id, '2', null, 'DELETE')).s, 403);
  assert.strictEqual(Number(rows(env)[0].amount), 300);
});
await ta('المالك يسجّل استلاماً باسم موظف ويرى عهد الجميع ويعدّلها ويحذفها', async () => {
  const env = env0();
  assert.strictEqual((await call(env, '/api/custody', '1', { amount: 1500, user_id: '2', note: 'عهدة تركيب' })).s, 200);
  const x = rows(env)[0];
  assert.strictEqual(x.user_id, '2'); assert.strictEqual(x.created_by, '1');
  await call(env, '/api/custody', '4', { amount: 50 });
  const l = await call(env, '/api/custody', '1');
  assert.strictEqual(l.d.receipts.length, 2);
  assert.ok(l.d.receipts.find((r) => r.user_id === '2').user_name === 'staff1');
  assert.strictEqual((await call(env, '/api/custody/' + x.id, '1', { amount: 1200 }, 'PUT')).s, 200);
  assert.strictEqual(Number(rows(env).find((r) => r.id === x.id).amount), 1200);
  assert.strictEqual((await call(env, '/api/custody/' + x.id, '1', null, 'DELETE')).s, 200);
  assert.strictEqual(rows(env).length, 1);
});
await ta('مبلغ غير صحيح يُرفض (صفر، سالب، نص، أكبر من الحد) وموظف غير موجود يُرفض', async () => {
  const env = env0();
  for (const a of [0, -5, 'abc', 1e9, null]) assert.strictEqual((await call(env, '/api/custody', '2', { amount: a })).s, 400, String(a));
  assert.strictEqual((await call(env, '/api/custody', '1', { amount: 10, user_id: 'ghost' })).s, 400);
  assert.strictEqual(rows(env).length, 0);
});
await ta('افتراضياً: الموظف والمندوب يسجّلان عهدتهما (المصروفات متاحة للجميع)', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/custody', '2', { amount: 10 })).s, 200);
  assert.strictEqual((await call(env, '/api/custody', '3', { amount: 20 })).s, 200);
  assert.strictEqual((await call(env, '/api/custody', '2')).d.receipts.length, 1);
});
await ta('سحب صلاحيات المصروفات من مستخدم: لا عرض ولا تسجيل', async () => {
  const env = mk({ grants: OWN.map((p) => ['2', p, 0]) });
  assert.strictEqual((await call(env, '/api/custody', '2')).s, 403);
  assert.strictEqual((await call(env, '/api/custody', '2', { amount: 10 })).s, 403);
});
await ta('الجدول يُنشأ تلقائياً عند أول استخدام (لا خطوة يدوية)', async () => {
  const env = env0();
  env.DB.tables.delete('custody_receipts');
  assert.strictEqual((await call(env, '/api/custody', '2')).s, 200);
  assert.ok(env.DB.tables.has('custody_receipts'));
});
await ta('schema.sql والهجرة 008 فيهما جدول custody_receipts', async () => {
  const root = path.join(here, '..');
  assert.ok(/CREATE TABLE IF NOT EXISTS custody_receipts/.test(fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8')));
  assert.ok(fs.existsSync(path.join(root, 'worker', 'migrations', '008_custody_receipts.sql')));
});

console.log(`\n=== custody: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
