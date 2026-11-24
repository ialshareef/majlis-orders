/* تحديث نسب العمولة بعد تغيير نسبة الموظف أو النسب الافتراضية: الطلبات غير المصروفة تتبع النسبة الجديدة،
   والمصروفة والمخصّصة لطلب بعينه والملغاة كما هي. بيانات تجريبية. الاستخدام: node test/comm-refresh.test.mjs */
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




const ord = (env, id, by, rates, extra = {}) => env.DB.tables.get('orders').push({ id, number: 1000 + env.DB.tables.get('orders').length, status: extra.status || 'new', customer_name: 'C', created_by: by, created_at: past, updated_at: past,
  data: JSON.stringify(Object.assign({ id, number: 1000, status: extra.status || 'new', createdBy: by, createdAt: past, updatedAt: past, customer: { name: 'C' }, commRates: rates }, extra)) });
const rates = (env, id) => JSON.parse(env.DB.tables.get('orders').find((o) => o.id === id).data).commRates;

await ta('تغيير نسبة الموظف: تُحدَّث عمولة طلباته غير المصروفة فقط (المصروفة والمخصّصة والملغاة كما هي)', async () => {
  const env = mk({ settings: { sellerRate: 2, mandoubRate: 5, shareRate: 4, mandoubParentRate: 1 } });
  userRow(env, '2').rate = 2;
  const R = { ownerRate: 2, parentId: null, parentRate: null, shareRate: 4 };
  ord(env, 'A', '2', R);                                                                   // غير مصروفة
  ord(env, 'B', '2', R, { commPaid: { owner: { at: past, amount: 20 } } });                // مصروفة
  ord(env, 'C', '2', { ...R, ownerRate: 5 }, { sellerRate: 5 });                           // نسبة مخصّصة للطلب
  ord(env, 'D', '2', R, { status: 'cancelled' });                                          // ملغاة
  ord(env, 'E', '4', R);                                                                   // موظف آخر
  const r = await call(env, '/api/users', '1', editUser(env, '2', { rate: 3 }));
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.commUpdated, 1);
  assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map((id) => rates(env, id).ownerRate), [3, 2, 5, 2, 2]);
  assert.equal(rates(env, 'A').shareRate, 4, 'حصة المشاركة لا تتغير');
});

await ta('تغيير النسبة الافتراضية في الإعدادات: يسري على غير المصروفة لمن ليس له نسبة خاصة', async () => {
  const env = mk({ settings: { sellerRate: 2, mandoubRate: 5, shareRate: 4, mandoubParentRate: 1 } });
  userRow(env, '2').rate = 3;                     // له نسبة خاصة: لا يتأثر بالافتراضي
  const R = { ownerRate: 2, parentId: null, parentRate: null, shareRate: 4 };
  ord(env, 'A', '2', { ...R, ownerRate: 3 });
  ord(env, 'E', '4', R);                          // بلا نسبة خاصة: يتبع الافتراضي
  ord(env, 'F', '4', R, { commPaid: { owner: { at: past, amount: 10 } } });
  ord(env, 'M', '7', { ownerRate: 6, parentId: '3', parentRate: 2, shareRate: 4 });   // مندوب تابع بنسبتيه الخاصتين
  const r = await call(env, '/api/sync', '1', { settings: { sellerRate: 4, mandoubRate: 5, shareRate: 4, mandoubParentRate: 1 } });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.deepEqual(['A', 'E', 'F', 'M'].map((id) => rates(env, id).ownerRate), [3, 4, 2, 6], JSON.stringify([['A', 'E', 'F', 'M'].map((id) => rates(env, id).ownerRate), r.d]));
  assert.equal(r.d.commUpdated, 1);
  // تغيير نسبة المندوب الأعلى على التابع يحدّث parentRate لغير المصروفة
  userRow(env, '7').parent_rate = 3;
  const r2 = await call(env, '/api/users', '1', editUser(env, '7', { parentId: '3', rate: 6, parentRate: 3 }));
  assert.equal(r2.s, 200, JSON.stringify(r2.d));
  assert.equal(rates(env, 'M').parentRate, 3);
});

await ta('تصحيح لمرة واحدة بعد النشر: نسبة غُيّرت قبل التحديث التلقائي تُطبَّق على غير المصروفة، والتقرير يذكر المتخطّى وسببه', async () => {
  const env = mk({ settings: { sellerRate: 2, mandoubRate: 5, shareRate: 4, mandoubParentRate: 1 } });
  userRow(env, '2').rate = 3;   // غُيّرت من 2 إلى 3 قبل الإصدار، وبقيت الطلبات على 2
  const R = { ownerRate: 2, parentId: null, parentRate: null, shareRate: 4 };
  ord(env, 'A', '2', R);
  ord(env, 'B', '2', R, { commPaid: { owner: { at: past, amount: 20 } } });
  ord(env, 'C', '2', R, { sellerRate: 2 });
  await call(env, '/api/bootstrap', '1');       // أول طلب بعد النشر
  assert.deepEqual(['A', 'B', 'C'].map((id) => rates(env, id).ownerRate), [3, 2, 2]);
  assert.ok(env.DB.tables.get('counters').some((c) => c.key === 'comm_refresh_once_v1'), 'علامة التشغيل مرة واحدة');
  env.PURCHASE_IMPORT_KEY = 'q'.repeat(40);
  const r = await call(env, '/api/comm-refresh-key', null, {}, 'POST', { 'X-Import-Key': 'q'.repeat(40) });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.ok(r.d.report.some((x) => x.kept === 'مصروفة') && r.d.report.some((x) => x.kept === 'نسبة مخصّصة لهذا الطلب' && x.rate === 2 && x.live === 3), JSON.stringify(r.d.report));
});

console.log(`\n=== comm-refresh: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
