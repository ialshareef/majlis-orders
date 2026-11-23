/* المشتريات (فواتير الموردين) على الخادم: الاستيراد بلا تكرار، الصلاحية للإدارة فقط، الربط بالأصناف، والتحقق.
   بيانات تجريبية فقط (المستودع عام: لا أسعار موردين حقيقية). الاستخدام: node test/purchases.test.mjs */
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



const INV = (no, date, unitNet = 50) => ({ supplier: 'مورد تجريبي', invoice_no: no, invoice_date: date, lines: [
  { name: 'قماش تجريبي', code: 'T-1', category: 'fabric', unit: 'متر', qty: 10, unitNet, net: unitNet * 10, vat: unitNet * 1.5, total: unitNet * 11.5 },
  { name: 'موكيت تجريبي', code: 'M-1', category: '', unit: 'م²', qty: 5, unitNet: 20, net: 100, vat: 15, total: 115 },
], totals: { net: unitNet * 10 + 100, vat: unitNet * 1.5 + 15, total: unitNet * 11.5 + 115 } });

await ta('المالك/المدير: استيراد فواتير، وإعادة الاستيراد لا تكرر', async () => {
  const env = mk();
  let r = await call(env, '/api/purchases/import', '1', { purchases: [INV('A-1', '2026-11-01'), INV('A-2', '2026-11-05', 55)] });
  assert.strictEqual(r.s, 200, JSON.stringify(r.d)); assert.strictEqual(r.d.added, 2);
  r = await call(env, '/api/purchases/import', '5', { purchases: [INV('A-1', '2026-11-01'), INV('A-3', '2026-11-07')] });
  assert.strictEqual(r.d.added, 1); assert.strictEqual(r.d.skipped, 1);
  const l = await call(env, '/api/purchases', '1');
  assert.strictEqual(l.d.purchases.length, 3);
  assert.strictEqual(l.d.purchases[0].invoice_no, 'A-3', 'الأحدث أولاً');
  assert.strictEqual(l.d.purchases[0].lines.length, 2);
});
await ta('الموظف والمندوب: لا يرون المشتريات ولا يستوردونها', async () => {
  const env = mk();
  await call(env, '/api/purchases/import', '1', { purchases: [INV('B-1', '2026-11-01')] });
  for (const u of ['2', '3']) {
    assert.strictEqual((await call(env, '/api/purchases', u)).s, 403, u);
    assert.strictEqual((await call(env, '/api/purchases/import', u, { purchases: [INV('B-2', '2026-11-01')] })).s, 403, u);
  }
});
await ta('ربط البنود بالأصناف، والحذف', async () => {
  const env = mk();
  await call(env, '/api/purchases/import', '1', { purchases: [INV('C-1', '2026-11-01')] });
  const id = (await call(env, '/api/purchases', '1')).d.purchases[0].id;
  assert.strictEqual((await call(env, '/api/purchases/' + id, '1', { itemIds: ['it-1', ''] }, 'PUT')).s, 200);
  assert.strictEqual((await call(env, '/api/purchases', '1')).d.purchases[0].lines[0].itemId, 'it-1');
  assert.strictEqual((await call(env, '/api/purchases/' + id, '1', { itemIds: ['x'] }, 'PUT')).s, 400, 'عدد الروابط لا يطابق البنود');
  assert.strictEqual((await call(env, '/api/purchases/' + id, '2', null, 'DELETE')).s, 403);
  assert.strictEqual((await call(env, '/api/purchases/' + id, '1', null, 'DELETE')).s, 200);
  assert.strictEqual((await call(env, '/api/purchases', '1')).d.purchases.length, 0);
});
await ta('فواتير غير صالحة تُرفض (بلا مورد، بلا بنود، فئة مجهولة، تاريخ خاطئ، أرقام غير رقمية)', async () => {
  const env = mk();
  const bad = [{ ...INV('D', '2026-11-01'), supplier: '' }, { ...INV('D', '2026-11-01'), lines: [] }, { ...INV('D', '2026-11-01'), invoice_date: '1/11/2026' },
    { ...INV('D', '2026-11-01'), lines: [{ name: 'x', category: 'car', qty: 1 }] }, { ...INV('D', '2026-11-01'), lines: [{ name: 'x', category: 'fabric', qty: 'abc' }] }];
  for (const b of bad) assert.strictEqual((await call(env, '/api/purchases/import', '1', { purchases: [b] })).s, 400, JSON.stringify(b).slice(0, 80));
  assert.strictEqual((await call(env, '/api/purchases', '1')).d.purchases.length, 0);
});
await ta('الجدول في schema.sql والهجرة 009، ويُنشأ تلقائياً عند أول استخدام', async () => {
  const root = path.join(here, '..');
  assert.ok(/CREATE TABLE IF NOT EXISTS purchases/.test(fs.readFileSync(path.join(root, 'worker', 'schema.sql'), 'utf8')));
  assert.ok(fs.existsSync(path.join(root, 'worker', 'migrations', '009_purchases.sql')));
  const env = mk(); env.DB.tables.delete('purchases');
  assert.strictEqual((await call(env, '/api/purchases', '1')).s, 200);
  assert.ok(env.DB.tables.has('purchases'));
});

await ta('ربط الفاتورة بطلب: يُحفظ order_id، ويُرفض طلب غير موجود، ويُلغى بقيمة فارغة', async () => {
  const env = mk();
  env.DB.tables.get('orders').push({ id: 'ord-1', number: 1001, status: 'new', customer_name: 'C', created_by: '1', created_at: past, updated_at: past, data: JSON.stringify({ id: 'ord-1', number: 1001 }) });
  await call(env, '/api/purchases/import', '1', { purchases: [Object.assign(INV('L-1', '2026-11-05'), { order_id: 'ord-1' })] });
  let P = (await call(env, '/api/purchases', '1')).d.purchases;
  assert.equal(P[0].order_id, 'ord-1', 'الاستيراد يحفظ الطلب المرتبط');
  assert.equal((await call(env, '/api/purchases/' + P[0].id, '1', { orderId: 'nope' }, 'PUT')).s, 400, 'طلب غير موجود: 400');
  assert.equal((await call(env, '/api/purchases/' + P[0].id, '1', { orderId: '' }, 'PUT')).s, 200);
  P = (await call(env, '/api/purchases', '1')).d.purchases;
  assert.equal(P[0].order_id, '', 'أُلغي الربط');
  assert.equal((await call(env, '/api/purchases/' + P[0].id, '1', { orderId: 'ord-1', itemIds: ['', ''] }, 'PUT')).s, 200);
  P = (await call(env, '/api/purchases', '1')).d.purchases;
  assert.equal(P[0].order_id, 'ord-1');
  assert.equal((await call(env, '/api/purchases/' + P[0].id, '2', { orderId: 'ord-1' }, 'PUT')).s, 403, 'الموظف لا يربط');
});

await ta('اقتراحات الربط: مطابقة المبلغ (صافي/إجمالي/بند) والنوع مع تاريخ متقارب، للإدارة فقط وبالمفتاح المؤقت', async () => {
  const env = mk();
  const O = (id, number, date, extras) => ({ id, number, status: 'new', customer_name: 'C' + number, created_by: '1', created_at: date, updated_at: date,
    data: JSON.stringify({ id, number, createdAt: date + 'T10:00:00Z', costUpdatedAt: date + 'T12:00:00Z', customer: { name: 'عميل ' + number }, extraCosts: extras }) });
  env.DB.tables.get('orders').push(
    O('a', 1001, '2026-11-06', [{ name: 'قماش الطلب', amount: 600 }, { name: 'توصيل', amount: 150 }]),   // 600 = صافي INV(L-1, 50) = 500+100
    O('b', 1002, '2026-11-08', [{ name: 'اسفنج', amount: 999 }]),                                        // نوع: لا فاتورة إسفنج
    O('c', 1003, '2026-11-09', [{ name: 'قماش إضافي', amount: 77 }]),                                     // نوع قماش وتاريخ قريب
    O('d', 1004, '2026-03-01', [{ name: 'قماش قديم', amount: 600 }]));                                   // المبلغ نفسه لكن بعيد جداً
  await call(env, '/api/purchases/import', '1', { purchases: [INV('L-1', '2026-11-05', 50)] });
  const r = await call(env, '/api/purchases/matches', '1');
  assert.equal(r.s, 200, JSON.stringify(r.d));
  const M = r.d.matches;
  const a = M.find((m) => m.order.number === 1001 && m.cost.name === 'قماش الطلب');
  assert.ok(a && a.strength === 'amount' && a.days === 1 && /صافي الفاتورة/.test(a.basis), JSON.stringify(M));
  assert.ok(M.some((m) => m.order.number === 1003 && m.strength === 'kind'), 'نوع وتاريخ');
  assert.ok(!M.some((m) => m.order.number === 1004) && !M.some((m) => m.order.number === 1002) && !M.some((m) => m.cost.name === 'توصيل'), 'لا اقتراحات بعيدة أو بلا صلة');
  assert.equal((await call(env, '/api/purchases/matches', '2')).s, 403, 'الموظف ممنوع');
  assert.equal((await call(env, '/api/purchases/matches-key', null)).s, 404, 'بلا Secret: 404');
  env.PURCHASE_IMPORT_KEY = 'z'.repeat(40);
  assert.equal((await call(env, '/api/purchases/matches-key', null, undefined, 'GET', { 'X-Import-Key': 'z'.repeat(40) })).s, 200);
});

await ta('الاستيراد بمفتاح مؤقت: مغلق بلا Secret، ويرفض المفتاح الخاطئ، وينشئ الأصناف مخفية ويحدّث سعر الجملة بلا تكرار', async () => {
  const env = mk();
  env.DB.tables.set('items', [{ id: 'f-old', data: JSON.stringify({ id: 'f-old', name: 'قائم', category: 'fabric', price: 90, active: true, purchaseCodes: ['مورد تجريبي|T-1'], cost: 40, costDate: '2026-01-01' }), updated_at: past }]);
  const K = 'k'.repeat(40);
  const body = { purchases: [INV('K-1', '2026-11-02', 52), { supplier: 'مورد آخر', invoice_no: 'K-2', invoice_date: '2026-11-03', lines: [{ name: 'إسفنج تجريبي', itemName: 'إسفنج ت', code: 'S-1', category: 'foam', unit: 'لوح', qty: 2, unitNet: 100, net: 200, vat: 30, total: 230, sheetLen: 2 }], totals: { net: 200, vat: 30, total: 230 } }] };
  assert.equal((await call(env, '/api/purchases/import-key', null, body, 'POST', { 'X-Import-Key': K })).s, 404, 'بلا Secret: 404');
  env.PURCHASE_IMPORT_KEY = 'short';
  assert.equal((await call(env, '/api/purchases/import-key', null, body, 'POST', { 'X-Import-Key': 'short' })).s, 404, 'Secret قصير: 404');
  env.PURCHASE_IMPORT_KEY = K;
  assert.equal((await call(env, '/api/purchases/import-key', null, body, 'POST', { 'X-Import-Key': 'x'.repeat(40) })).s, 403, 'مفتاح خاطئ: 403');
  const r = await call(env, '/api/purchases/import-key', null, body, 'POST', { 'X-Import-Key': K });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.added, r.d.itemsCreated], [2, 1]);
  const items = env.DB.tables.get('items').map((x) => JSON.parse(x.data));
  const old = items.find((i) => i.id === 'f-old'), foam = items.find((i) => i.name === 'إسفنج ت');
  assert.ok(old.cost === 52 && old.costDate === '2026-11-02' && old.supplier === 'مورد تجريبي' && old.price === 90 && old.active === true, JSON.stringify(old));
  assert.ok(foam && foam.active === false && foam.price === 0 && foam.cost === 100 && foam.sheetLen === 2 && foam.purchaseCodes[0] === 'مورد آخر|S-1', JSON.stringify(foam));
  assert.ok(!items.some((i) => /موكيت/.test(i.name)), 'بنود «أخرى» بلا صنف');
  const P = env.DB.tables.get('purchases');
  assert.ok(P.length === 2 && P.every((x) => x.created_by === '1'), 'باسم المالك');
  assert.ok(JSON.parse(P.find((x) => x.invoice_no === 'K-1').data).lines[0].itemId === 'f-old', 'البند مربوط بصنفه');
  const r2 = await call(env, '/api/purchases/import-key', null, body, 'POST', { 'X-Import-Key': K });
  assert.ok(r2.d.added === 0 && r2.d.skipped === 2 && r2.d.itemsCreated === 0 && env.DB.tables.get('items').length === 2, 'إعادة الإرسال: لا تكرار');
  // الموظف لا تصله أسعار الجملة من الأصناف المنشأة
  const b = (await call(env, '/api/bootstrap', '2')).d;
  assert.ok(!JSON.stringify(b.items).includes('"cost"'), 'الموظف بلا أسعار جملة');
});

console.log(`\n=== purchases: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
