/* مصفوفة الصلاحيات على الخادم (منح/منع لكل صلاحية أُضيفت أو فُصلت):
   الإدارة الكاملة للمدير وحده · الدفعات · الأصناف · التصاميم (عرض/تعديل/تحويل/حذف) ·
   orders.edit_all وdelete_own بلا فحص دور · حجب التكلفة/الربح/العمولة في التقارير ·
   المصروفات (_own/_all لكل عملية، التاريخ، الربط بطلب، التسجيل باسم آخر) · قائمة المستخدمين.
   الخادم الحقيقي على D1 وهمية. الاستخدام: node test/permission-matrix.test.mjs */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'worker', 'worker.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const worker = mod.default;
const { hasPerm, ADMIN_ONLY_PERMISSIONS } = mod;
const { envWith } = await import(pathToFileURL(path.join(here, '_d1-mem.mjs')).href);

let pass = 0, fail = 0;
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + String(e && e.message).split('\n')[0]); }
};
const past = () => new Date(Date.now() - 86400000).toISOString();
const future = () => new Date(Date.now() + 86400000).toISOString();

function seeded(grants = []) {
  const users = [
    { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: 1, created_at: past(), rate: 3 },
    { id: '2', username: 's1', name: 'Staff', role: 'staff', active: 1, created_at: past(), rate: 2 },
    { id: '3', username: 'mb1', name: 'Mandoub', role: 'mandoub', active: 1, created_at: past(), rate: 5 },
    { id: '4', username: 's2', name: 'Staff2', role: 'staff', active: 1, created_at: past() },
    { id: '5', username: 'admin2', name: 'Admin2', role: 'admin', active: 1, created_at: past() },
  ];
  const sessions = ['1', '2', '3', '4', '5'].map((u) => ({ token: 'tok-' + u, user_id: u, created_at: past(), expires_at: future() }));
  const ord = (id, number, by, extra = {}) => ({ id, number, status: 'new', customer_name: 'C' + number, created_by: by, created_at: past(), updated_at: past(),
    data: JSON.stringify(Object.assign({ id, number, status: 'new', customer: { name: 'C' + number }, createdBy: by, subtotal: 1000, total: 1150, paid: 0, costs: { k: 400 }, costTotal: 400, extraCosts: [], payments: [] }, extra)) });
  const env = envWith({
    users, sessions,
    orders: [ord('o2', 1001, '2'), ord('o4', 1002, '4'), ord('o2p', 1003, '2', { paid: 100, payments: [{ id: 'p1', at: '2026-11-01', amount: 100, method: 'cash', note: '' }] })],
    counters: [{ key: 'order_no', value: 1003 }], settings: [{ id: 1, data: '{}', updated_at: past() }], items: [],
  });
  env.DB.tables.set('customer_designs', [{ id: 'd1', public_no: 26000200, token: 't', status: 'new', design: JSON.stringify({ walls: [], pieces: [] }), customer_name: 'C', customer_phone: '', contact_requested: 0, order_id: null, order_number: null, created_at: past(), updated_at: past(), expires_at: future() }]);
  env.DB.tables.set('user_permissions', grants.map(([user_id, permission, value]) => ({ user_id, permission, value, updated_at: past() })));
  env.DB.tables.set('expenses', []);
  env.DB.tables.set('permission_audit', []);
  env.DB.tables.set('activity', []);
  /* مالك النظام: معرّف ثابت من البيئة (OWNER_USER_ID). المدير رقم 1 هنا هو المالك؛ أي مدير آخر مدير عادي. */
  env.OWNER_USER_ID = '1';
  return env;
}
const call = async (env, p, uid, body, method) => {
  const res = await worker.fetch(new Request('https://x.test' + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-session-token': uid ? 'tok-' + uid : '' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};
const order = (env, id) => JSON.parse(env.DB.tables.get('orders').find((o) => o.id === id).data);
const upsert = (o) => ({ orders: { upsert: [o] } });
/** الطلب كما يصل لمن لا يرى تكاليف غيره (bootstrap يحذفها): لا أثر تكلفة فيه */
const stripped = (o) => { const c = { ...o }; for (const k of ['costs', 'costTotal', 'extraCosts', 'costUpdatedAt', 'costUpdatedByName']) delete c[k]; return c; };

/* ---------- الإدارة الكاملة للمدير وحده ---------- */
await ta('admin-only: القائمة تشمل admin.core وإدارة الصلاحيات والمستخدمين والإعدادات', async () => {
  for (const p of ['admin.core', 'permissions.manage', 'users.create', 'users.edit', 'users.disable', 'settings.manage']) assert.ok(ADMIN_ONLY_PERMISSIONS.includes(p), p);
});
await ta('admin-only: منحها لموظف من نافذة الصلاحيات مرفوض (400) ولا يُخزَّن', async () => {
  for (const p of ['permissions.manage', 'users.edit', 'users.create', 'users.disable', 'settings.manage']) {
    const env = seeded();
    const r = await call(env, '/api/users/2/permissions', '1', { overrides: { [p]: 1 } });
    assert.strictEqual(r.status, 400, p);
    assert.strictEqual(env.DB.tables.get('user_permissions').length, 0, p);
  }
});
await ta('admin-only: صف منح مزوَّر في القاعدة لا يعطي الموظف شيئاً (فشل مُغلق)', async () => {
  const staff = { id: '2', role: 'staff', active: 1 };
  for (const p of ADMIN_ONLY_PERMISSIONS) assert.strictEqual(hasPerm(staff, p, { ok: true, overrides: { [p]: true } }), false, p);
  const env = seeded([['2', 'users.edit', 1], ['2', 'permissions.manage', 1], ['2', 'settings.manage', 1]]);
  assert.strictEqual((await call(env, '/api/users', '2', { id: '2', name: 'x', username: 's1', role: 'admin', active: true })).status, 403, 'ترقية نفسه');
  assert.strictEqual((await call(env, '/api/users/4/permissions', '2')).status, 403);
  assert.strictEqual((await call(env, '/api/sync', '2', { settings: { shopName: 'x' } })).status, 403);
});
await ta('admin-only: يمكن سحبها من مدير بعينه (منع) — المدير الآخر يبقى كاملاً', async () => {
  const env = seeded([['5', 'settings.manage', 0]]);
  assert.strictEqual((await call(env, '/api/sync', '5', { settings: { shopName: 'x' } })).status, 403);
  assert.strictEqual((await call(env, '/api/sync', '1', { settings: { shopName: 'y' } })).status, 200);
});

/* ---------- الدفعات ---------- */
const withPayments = (env, id, payments) => Object.assign(order(env, id), { payments, paid: payments.reduce((s, p) => s + p.amount, 0) });
await ta('payments: الموظف يسجّل دفعة على طلبه افتراضياً', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', '2', upsert(withPayments(env, 'o2', [{ id: 'n1', at: '2026-11-04', amount: 50, method: 'cash', note: '' }])));
  assert.strictEqual(r.status, 200);
});
await ta('payments: منع payments.add يرفض تسجيل دفعة (403)', async () => {
  const env = seeded([['2', 'payments.add', 0]]);
  const r = await call(env, '/api/sync', '2', upsert(withPayments(env, 'o2', [{ id: 'n1', at: '2026-11-04', amount: 50, method: 'cash', note: '' }])));
  assert.strictEqual(r.status, 403);
});
await ta('payments: حذف دفعة يتطلب payments.delete (ممنوع افتراضياً، مسموح بالمنح)', async () => {
  let env = seeded();
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(withPayments(env, 'o2p', [])))).status, 403);
  env = seeded([['2', 'payments.delete', 1]]);
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(withPayments(env, 'o2p', [])))).status, 200);
  assert.strictEqual(order(env, 'o2p').payments.length, 0);
});
await ta('payments: تعديل مبلغ دفعة يتطلب payments.edit', async () => {
  let env = seeded();
  const edited = [{ id: 'p1', at: '2026-11-01', amount: 999, method: 'cash', note: '' }];
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(withPayments(env, 'o2p', edited)))).status, 403);
  env = seeded([['2', 'payments.edit', 1]]);
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(withPayments(env, 'o2p', edited)))).status, 200);
});
await ta('payments: حفظ طلب بلا تغيير في الدفعات لا يحتاج أي صلاحية دفعات', async () => {
  const env = seeded([['2', 'payments.add', 0], ['2', 'payments.edit', 0], ['2', 'payments.delete', 0]]);
  const o = Object.assign(order(env, 'o2p'), { notes: 'تعديل ملاحظة فقط' });
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(o))).status, 200);
});
await ta('payments: دفعة legacy المولّدة لطلب قديم ليست «إضافة»', async () => {
  const env = seeded([['2', 'payments.add', 0]]);
  const o = Object.assign(order(env, 'o2'), { paid: 0, payments: [{ id: 'legacy', at: '2026-10-01', amount: 0, method: 'other', note: '' }] });
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(o))).status, 200);
});

/* ---------- الأصناف والأسعار ---------- */
await ta('items: الموظف لا يعدّل الأصناف افتراضياً، وبالمنح items.manage يستطيع', async () => {
  const item = { id: 'i1', name: 'صنف', price: 10 };
  assert.strictEqual((await call(seeded(), '/api/sync', '2', { items: { upsert: [item] } })).status, 403);
  assert.strictEqual((await call(seeded([['2', 'items.manage', 1]]), '/api/sync', '2', { items: { upsert: [item] } })).status, 200);
});
await ta('items: منفصلة عن الإعدادات — مدير مسحوب منه settings.manage يبقى يعدّل الأصناف', async () => {
  const env = seeded([['5', 'settings.manage', 0]]);
  assert.strictEqual((await call(env, '/api/sync', '5', { items: { upsert: [{ id: 'i2', name: 'x', price: 1 }] } })).status, 200);
});

/* ---------- التصاميم ---------- */
await ta('designs: الموظف يعرض افتراضياً، والمندوب لا', async () => {
  assert.strictEqual((await call(seeded(), '/api/designs', '2')).status, 200);
  assert.strictEqual((await call(seeded(), '/api/designs/d1', '2')).status, 200);
  assert.strictEqual((await call(seeded(), '/api/designs', '3')).status, 403);
});
await ta('designs: التعديل والتحويل والحذف كلٌّ بصلاحيته', async () => {
  assert.strictEqual((await call(seeded(), '/api/designs/d1', '2', { status: 'closed' }, 'PUT')).status, 403);
  assert.strictEqual((await call(seeded([['2', 'designs.edit', 1]]), '/api/designs/d1', '2', { status: 'closed' }, 'PUT')).status, 200);
  assert.strictEqual((await call(seeded([['2', 'designs.edit', 1]]), '/api/designs/d1', '2', null, 'DELETE')).status, 403, 'التعديل لا يعطي الحذف');
  assert.strictEqual((await call(seeded([['2', 'designs.delete', 1]]), '/api/designs/d1', '2', null, 'DELETE')).status, 200);
  assert.strictEqual((await call(seeded([['2', 'designs.delete', 1]]), '/api/designs/bulk-delete', '2', { ids: ['d1'] })).status, 200);
  assert.strictEqual((await call(seeded(), '/api/designs/d1/convert', '2', null, 'POST')).status, 403);
  assert.notStrictEqual((await call(seeded([['2', 'designs.convert', 1]]), '/api/designs/d1/convert', '2', null, 'POST')).status, 403);
});

/* ---------- الطلبات: صلاحيات لا دور ---------- */
await ta('orders.edit_all: الموظف الممنوح يعدّل طلب غيره، ودونه يُرفض', async () => {
  const env0 = seeded();
  assert.strictEqual((await call(env0, '/api/sync', '2', upsert(Object.assign(order(env0, 'o4'), { notes: 'x' })))).status, 403);
  const env = seeded([['2', 'orders.edit_all', 1]]);
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(Object.assign(stripped(order(env, 'o4')), { notes: 'x' })))).status, 200);
  assert.strictEqual(order(env, 'o4').costTotal, 400, 'تكاليف المالك محفوظة (تُستعاد من المخزّن)');
  assert.strictEqual(order(env, 'o4').createdBy, '4', 'الملكية لا تتغير');
});
await ta('orders.edit_all: لا يعطي نقل الملكية (للمدير وحده)', async () => {
  const env = seeded([['2', 'orders.edit_all', 1]]);
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(Object.assign(stripped(order(env, 'o4')), { createdBy: '2' })))).status, 403);
});
await ta('orders.edit_all بلا costs.*_all: لا يضيف تكاليف لطلب غيره', async () => {
  const env = seeded([['2', 'orders.edit_all', 1]]);
  const o = Object.assign(order(env, 'o4'), { costs: { k: 999 }, costTotal: 999, costUpdatedAt: new Date().toISOString() });
  assert.strictEqual((await call(env, '/api/sync', '2', upsert(o))).status, 403);
});
await ta('orders.delete_own: الممنوح يحذف طلبه فقط', async () => {
  assert.strictEqual((await call(seeded(), '/api/sync', '2', { orders: { delete: ['o2'] } })).status, 403);
  const env = seeded([['2', 'orders.delete_own', 1]]);
  assert.strictEqual((await call(env, '/api/sync', '2', { orders: { delete: ['o4'] } })).status, 403, 'ليس طلبه');
  assert.strictEqual((await call(env, '/api/sync', '2', { orders: { delete: ['o2'] } })).status, 200);
});

/* ---------- التقارير: حجب التكلفة/الربح ---------- */
await ta('orders-summary: الموظف الممنوح التقارير يرى تكلفة طلباته افتراضياً', async () => {
  const r = await call(seeded([['2', 'reports.view_own', 1]]), '/api/reports/orders-summary', '2');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.orders.find((o) => o.id === 'o2').cost, 400);
});
await ta('orders-summary: منع costs.view_own يحجب التكلفة والربح والإجمالي (لا تسريب عبر التقرير)', async () => {
  const r = await call(seeded([['2', 'reports.view_own', 1], ['2', 'costs.view_own', 0]]), '/api/reports/orders-summary', '2');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.orders.every((o) => o.cost === null && o.profit === null), JSON.stringify(r.data.orders.map((o) => [o.cost, o.profit])));
  assert.strictEqual(r.data.totalCost, null);
  assert.strictEqual(r.data.netProfit, null);
  assert.ok(Object.values(r.data.byStatus).every((s) => s.cost === null));
});
await ta('orders-summary: منع profit.view_own يحجب الربح ويُبقي التكلفة', async () => {
  const r = await call(seeded([['2', 'reports.view_own', 1], ['2', 'profit.view_own', 0]]), '/api/reports/orders-summary', '2');
  const o = r.data.orders.find((x) => x.id === 'o2');
  assert.strictEqual(o.cost, 400);
  assert.strictEqual(o.profit, null);
  assert.strictEqual(r.data.netProfit, null);
});
await ta('orders-summary: reports.view_all بلا costs.view_all لا يكشف تكاليف الغير', async () => {
  const r = await call(seeded([['2', 'reports.view_all', 1]]), '/api/reports/orders-summary', '2');
  assert.strictEqual(r.data.orders.find((o) => o.id === 'o4').cost, null);
  assert.strictEqual(r.data.orders.find((o) => o.id === 'o2').cost, 400, 'طلبه مرئي التكلفة');
});
await ta('mandoubs report: مدير مسحوب منه costs.view_all لا يرى التكاليف والأرباح', async () => {
  const r = await call(seeded([['5', 'costs.view_all', 0]]), '/api/reports/mandoubs', '5');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.mandoubs.every((m) => m.cost === null && m.profit === null));
  const a = await call(seeded(), '/api/reports/mandoubs', '1');
  assert.ok(a.data.mandoubs.every((m) => typeof m.cost === 'number'));
});

/* ---------- المصروفات ---------- */
const exp = (body) => Object.assign({ name: 'نقل وتركيب', amount: 250, category: 'نقل', expense_date: '2026-11-02' }, body);
await ta('expenses: الموظف بلا منح لا يرى ولا يضيف (لا شاشة تُمنح تلقائياً)', async () => {
  assert.strictEqual((await call(seeded(), '/api/expenses', '2')).status, 403);
  assert.strictEqual((await call(seeded(), '/api/expenses', '2', exp())).status, 403);
});
await ta('expenses: الإضافة تحفظ التاريخ والتصنيف والربط بطلب، والقائمة تعيد الاسم ورقم الطلب', async () => {
  const env = seeded();
  const r = await call(env, '/api/expenses', '1', exp({ order_id: 'o2', note: 'ملاحظة' }));
  assert.strictEqual(r.status, 200);
  const l = await call(env, '/api/expenses', '1');
  const e = l.data.expenses[0];
  assert.strictEqual(e.expense_date, '2026-11-02');
  assert.strictEqual(e.order_number, 1001);
  assert.strictEqual(e.created_by_name, 'Admin');
  assert.strictEqual(e.category, 'نقل');
  assert.ok(e.can_edit && e.can_delete);
});
await ta('expenses: التحقق — مبلغ صفر/سالب، تاريخ غير صالح، بيان فارغ، طلب غير موجود', async () => {
  const env = seeded();
  assert.strictEqual((await call(env, '/api/expenses', '1', exp({ amount: 0 }))).status, 400);
  assert.strictEqual((await call(env, '/api/expenses', '1', exp({ amount: -5 }))).status, 400);
  assert.strictEqual((await call(env, '/api/expenses', '1', exp({ expense_date: '2026-13-45' }))).status, 400);
  assert.strictEqual((await call(env, '/api/expenses', '1', exp({ name: '   ' }))).status, 400);
  assert.strictEqual((await call(env, '/api/expenses', '1', exp({ order_id: 'nope' }))).status, 400);
});
await ta('expenses: الموظف لا يربط مصروفه بطلب غيره دون orders.view_all', async () => {
  const env = seeded([['2', 'expenses.add_own', 1]]);
  assert.strictEqual((await call(env, '/api/expenses', '2', exp({ order_id: 'o4' }))).status, 403);
  assert.strictEqual((await call(env, '/api/expenses', '2', exp({ order_id: 'o2' }))).status, 200);
});
await ta('expenses: view_all يعرض مصروفات الجميع لكنه لا يعطي تعديلها أو حذفها', async () => {
  const env = seeded([['2', 'expenses.view_all', 1]]);
  const add = await call(env, '/api/expenses', '1', exp());
  const id = add.data.expense.id;
  const l = await call(env, '/api/expenses', '2');
  assert.strictEqual(l.data.expenses.length, 1);
  assert.ok(!l.data.expenses[0].can_edit && !l.data.expenses[0].can_delete);
  assert.strictEqual((await call(env, '/api/expenses/' + id, '2', { amount: 1 }, 'PUT')).status, 403);
  assert.strictEqual((await call(env, '/api/expenses/' + id, '2', null, 'DELETE')).status, 403);
});
await ta('expenses: edit_all وdelete_all يعدّلان ويحذفان مصروف الغير', async () => {
  const env = seeded([['2', 'expenses.view_all', 1], ['2', 'expenses.edit_all', 1], ['2', 'expenses.delete_all', 1]]);
  const id = (await call(env, '/api/expenses', '1', exp())).data.expense.id;
  const u = await call(env, '/api/expenses/' + id, '2', { amount: 300, expense_date: '2026-11-03' }, 'PUT');
  assert.strictEqual(u.status, 200);
  assert.strictEqual(u.data.expense.amount, 300);
  assert.strictEqual((await call(env, '/api/expenses/' + id, '2', null, 'DELETE')).status, 200);
});
await ta('expenses: edit_own لا يعدّل مصروف الغير حتى لو رآه', async () => {
  const env = seeded([['2', 'expenses.view_all', 1], ['2', 'expenses.edit_own', 1]]);
  const id = (await call(env, '/api/expenses', '1', exp())).data.expense.id;
  assert.strictEqual((await call(env, '/api/expenses/' + id, '2', { amount: 1 }, 'PUT')).status, 403);
});
await ta('expenses: التسجيل باسم موظف آخر يتطلب add_all', async () => {
  let env = seeded([['2', 'expenses.add_own', 1]]);
  assert.strictEqual((await call(env, '/api/expenses', '2', exp({ created_by: '4' }))).status, 403);
  env = seeded([['2', 'expenses.add_all', 1]]);
  const r = await call(env, '/api/expenses', '2', exp({ created_by: '4' }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.expense.created_by, '4');
});
await ta('expenses: التصفية بتاريخ المصروف، والملخص حسب التصنيف', async () => {
  const env = seeded();
  await call(env, '/api/expenses', '1', exp({ expense_date: '2026-10-01', amount: 100, category: 'نقل' }));
  await call(env, '/api/expenses', '1', exp({ expense_date: '2026-11-02', amount: 200, category: 'أجور' }));
  const l = await call(env, '/api/expenses?from=2026-11-01&to=2026-11-30', '1');
  assert.deepStrictEqual(l.data.expenses.map((e) => e.amount), [200]);
  const s = await call(env, '/api/reports/expenses-summary', '1');
  assert.strictEqual(s.data.total_amount, 300);
  assert.deepStrictEqual(s.data.by_category, { 'نقل': 100, 'أجور': 200 });
});

/* ---------- قائمة المستخدمين ---------- */
await ta('bootstrap: users.view الممنوح يعطي قائمة المستخدمين بلا نسب العمولة؛ والمدير يراها كاملة', async () => {
  const s = await call(seeded([['2', 'users.view', 1]]), '/api/bootstrap', '2');
  assert.ok(s.data.users.length >= 5);
  assert.ok(s.data.users.every((u) => u.rate === null));
  assert.strictEqual((await call(seeded(), '/api/bootstrap', '2')).data.users.length, 0);
  assert.ok((await call(seeded(), '/api/bootstrap', '1')).data.users.some((u) => u.rate === 3));
});

console.log(`\n=== permission-matrix: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
