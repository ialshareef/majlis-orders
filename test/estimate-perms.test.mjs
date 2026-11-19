/* أسعار الجملة والتكلفة التقديرية على الخادم: تصل لمن يرى تكاليف الجميع فقط، ولا يمحوها حفظ من لا يراها، والتحقق من القيم.
   الاستخدام: node test/estimate-perms.test.mjs */
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



const ITEMS = [
  { id: 'w1', name: 'كنب سويدي', category: 'wood', price: 300, cost: 100, seatType: 'sofa', fabricPerM: 2.8, active: true },
  { id: 'f1', name: 'شمواه', category: 'fabric', price: 100, cost: 50, active: true },
];
const withItems = (opts) => { const e = mk(opts); e.DB.tables.set('items', ITEMS.map((i) => ({ id: i.id, data: JSON.stringify(i), updated_at: '2026-11-01' }))); return e; };
const itemsOf = async (env, uid) => (await call(env, '/api/bootstrap', uid)).d;
const rowOf = (env, id) => JSON.parse(env.DB.tables.get('items').find((r) => r.id === id).data);

await ta('المالك/المدير: يرى أسعار الجملة ومعدّلات الاستهلاك وإعدادات التقدير', async () => {
  const env = withItems();
  env.DB.tables.set('settings', [{ id: 1, data: JSON.stringify({ sellerRate: 2, estimate: { types: { sofa: { fabric: 2.5, foam: 2, labor: 70 } }, waste: 10, workshops: [{ id: 'x', name: 'مشغل الرياض', sofa: 90 }] } }), updated_at: '2026-11-01' }]);
  for (const u of ['1', '5']) {
    const d = await itemsOf(env, u);
    const w = d.items.find((i) => i.id === 'w1');
    assert.strictEqual(w.cost, 100, u); assert.strictEqual(w.fabricPerM, 2.8, u);
    assert.ok(d.settings.estimate && d.settings.estimate.workshops[0].name === 'مشغل الرياض', u);
  }
});
await ta('الموظف والمندوب: لا تصلهم أسعار الجملة ولا إعدادات التقدير (حتى مع «تكاليف طلباته»)', async () => {
  const env = withItems();
  env.DB.tables.set('settings', [{ id: 1, data: JSON.stringify({ sellerRate: 2, estimate: { waste: 10 } }), updated_at: '2026-11-01' }]);
  for (const u of ['2', '3']) {
    const d = await itemsOf(env, u);
    const w = d.items.find((i) => i.id === 'w1');
    assert.strictEqual(w.name, 'كنب سويدي'); assert.strictEqual(w.price, 300);
    assert.ok(!('cost' in w) && !('fabricPerM' in w), u + ' ' + JSON.stringify(w));
    assert.ok(!('estimate' in d.settings), u);
  }
});
await ta('مستخدم يدير الأصناف بلا رؤية تكاليف الجميع: حفظه للصنف لا يمحو سعر الجملة', async () => {
  const env = withItems({ grants: [['2', 'items.manage', 1]] });
  const r = await call(env, '/api/sync', '2', { items: { upsert: [{ id: 'w1', name: 'كنب سويدي ملكي', category: 'wood', price: 320, active: true }] } });
  assert.strictEqual(r.s, 200, JSON.stringify(r.d));
  const w = rowOf(env, 'w1');
  assert.strictEqual(w.name, 'كنب سويدي ملكي'); assert.strictEqual(w.price, 320);
  assert.strictEqual(w.cost, 100); assert.strictEqual(w.fabricPerM, 2.8);
  // ولا يستطيع تغييره بإرساله
  await call(env, '/api/sync', '2', { items: { upsert: [{ id: 'w1', name: 'x', category: 'wood', price: 1, cost: 1, active: true }] } });
  assert.strictEqual(rowOf(env, 'w1').cost, 100);
});
await ta('قيم غير صالحة لسعر الجملة تُرفض، وإعدادات تقدير مشوّهة تُرفض', async () => {
  const env = withItems();
  for (const v of [-1, 'abc', 1e9]) assert.strictEqual((await call(env, '/api/sync', '1', { items: { upsert: [{ id: 'f1', name: 'شمواه', category: 'fabric', price: 100, cost: v }] } })).s, 400, String(v));
  assert.strictEqual((await call(env, '/api/sync', '1', { settings: { estimate: 'x' } })).s, 400);
  assert.strictEqual((await call(env, '/api/sync', '1', { settings: { estimate: { workshops: 'x' } } })).s, 400);
  assert.strictEqual(rowOf(env, 'f1').cost, 50);
});

console.log(`\n=== estimate-perms: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
