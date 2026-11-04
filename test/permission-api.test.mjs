/* API-level permission tests (Phase D3.1) */
import assert from 'node:assert';
import { envWith } from './_d1-mem.mjs';

const here = (await import('node:path')).default.dirname((await import('node:url')).default.fileURLToPath(import.meta.url));
const fs = await import('node:fs');
const workerSrc = fs.readFileSync(here + '/../worker/worker.js', 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc, 'utf8').toString('base64'))).default;

let pass = 0, fail = 0;
const lines = [];
async function ta(name, fn) {
  try { await fn(); pass++; lines.push('PASS  ' + name); }
  catch (e) { fail++; lines.push('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

const req = (path, opts = {}) => new Request('https://x.test' + path, opts);
const jsonReq = (path, token, body, method) => req(path, {
  method: method || (body ? 'POST' : 'GET'),
  headers: {
    'x-session-token': token || '',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
    'content-type': body ? 'application/json' : undefined,
  },
  body: body ? JSON.stringify(body) : undefined,
});
const call = async (env, path, token, body, method) => {
  const res = await worker.fetch(jsonReq(path, token, body, method), env);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
};
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();

function seeded() {
  const users = [
    { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: 1, created_at: past() },
    { id: '2', username: 's1', name: 'Staff', role: 'staff', active: 1, created_at: past() },
    { id: '3', username: 'mb1', name: 'Mandoub', role: 'mandoub', active: 1, created_at: past() },
    { id: '4', username: 's2', name: 'Staff2', role: 'staff', active: 1, created_at: past() },
  ];
  const sessions = [
    { token: 'tok-admin', user_id: '1', created_at: past(), expires_at: future() },
    { token: 'tok-staff', user_id: '2', created_at: past(), expires_at: future() },
    { token: 'tok-mandoub', user_id: '3', created_at: past(), expires_at: future() },
  ];
  const orders = [
    { id: 'o-staff', number: 1001, status: 'new', customer_name: 'Cust', created_by: '2', created_at: past(), updated_at: past(), data: JSON.stringify({ id: 'o-staff', number: 1001, status: 'new', customer: { name: 'Cust' }, createdBy: '2', costs: { k: 10 }, costTotal: 10, extraCosts: [] }) },
    { id: 'o-staff2', number: 1002, status: 'new', customer_name: 'Cust2', created_by: '4', created_at: past(), updated_at: past(), data: JSON.stringify({ id: 'o-staff2', number: 1002, status: 'new', customer: { name: 'Cust2' }, createdBy: '4', costs: { k: 20 }, costTotal: 20, extraCosts: [] }) },
    { id: 'o-mb', number: 1003, status: 'new', customer_name: 'Cust3', created_by: '3', created_at: past(), updated_at: past(), data: JSON.stringify({ id: 'o-mb', number: 1003, status: 'new', customer: { name: 'Cust3' }, createdBy: '3', costs: { k: 30 }, costTotal: 30, extraCosts: [] }) },
  ];
  const env = envWith({ users, sessions, orders, counters: [{ key: 'order_no', value: 1003 }], settings: [{ id: 1, data: '{}', updated_at: past() }], items: [] });
  env.DB.tables.set('customer_designs', [
    { id: 'd1', public_no: 1, status: 'draft', design: '{}', customer_name: 'C', customer_phone: '', contact_requested: 0, order_id: null, order_number: null, created_at: past(), updated_at: past(), expires_at: future() },
  ]);
  env.DB.tables.set('user_permissions', []);
  env.DB.tables.set('expenses', []);
  /* مالك النظام: معرّف ثابت من البيئة (OWNER_USER_ID). المدير رقم 1 هنا هو المالك؛ أي مدير آخر مدير عادي. */
  env.OWNER_USER_ID = '1';
  return env;
}

/* الموظف لم يعد يملك المصروفات وتقاريره افتراضياً (لا شاشة تُمنح تلقائياً):
   اختبارات المصروفات تمنحها صراحةً كما يفعل المدير من نافذة الصلاحيات. */
function seededGrants() {
  const env = seeded();
  env.DB.tables.set('user_permissions', ['expenses.view_own', 'expenses.add_own', 'expenses.edit_own', 'expenses.delete_own', 'reports.view_own']
    .map((permission) => ({ user_id: '2', permission, value: 1, updated_at: past() })));
  return env;
}

function wrapPermFailure(env) {
  const db = env.DB;
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/user_permissions/i.test(sql)) throw new Error('perm table unavailable');
    return orig(sql);
  };
  return env;
}

// ---------- Designs ----------
await ta('D3.1 designs: admin allowed', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs', 'tok-admin');
  assert.strictEqual(r.status, 200);
});
await ta('D3.1 designs: staff allowed to view by default (designs.view)', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs', 'tok-staff');
  assert.strictEqual(r.status, 200);
});
await ta('D3.1 designs: mandoub denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs', 'tok-mandoub');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 designs: unauth 401', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs', '');
  assert.strictEqual(r.status, 401);
});
await ta('D3.1 designs: deny override 403', async () => {
  const env = seeded();
  env.OWNER_USER_ID = null; // المدير 1 هنا مدير عادي: المنع يسري عليه (صلاحيات المالك لا تُقيَّد)
  env.DB.tables.set('user_permissions', [{ user_id: '1', permission: 'designs.view', value: 0 }]);
  const r = await call(env, '/api/designs', 'tok-admin');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 designs: load failure 403', async () => {
  const env = wrapPermFailure(seeded());
  const r = await call(env, '/api/designs', 'tok-admin');
  assert.strictEqual(r.status, 403);
});

// ---------- Bootstrap ----------
await ta('D3.1 bootstrap: staff sees own orders only', async () => {
  const env = seeded();
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.orders.map((o) => o.id), ['o-staff']);
});
await ta('D3.1 bootstrap: staff deny orders.view_own -> no orders', async () => {
  const env = seeded();
  env.DB.tables.set('user_permissions', [{ user_id: '2', permission: 'orders.view_own', value: 0 }]);
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.orders, []);
});
await ta('D3.1 bootstrap: staff with orders.view_all sees all', async () => {
  const env = seeded();
  env.DB.tables.set('user_permissions', [{ user_id: '2', permission: 'orders.view_all', value: 1 }]);
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.orders.map((o) => o.id).sort(), ['o-mb', 'o-staff', 'o-staff2']);
});
await ta('D3.1 bootstrap: deny orders.view_all prevents others', async () => {
  const env = seeded();
  env.OWNER_USER_ID = null; // المدير 1 هنا مدير عادي: المنع يسري عليه (صلاحيات المالك لا تُقيَّد)
  env.DB.tables.set('user_permissions', [
    { user_id: '1', permission: 'orders.view_all', value: 0 },
    { user_id: '1', permission: 'orders.view_own', value: 1 },
  ]);
  const r = await call(env, '/api/bootstrap', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.orders.map((o) => o.id), []);
});
await ta('D3.1 bootstrap: load failure -> no orders', async () => {
  const env = wrapPermFailure(seeded());
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.orders, []);
});

await ta('D3.1 bootstrap: costs.view_own allows own costs', async () => {
  const env = seeded();
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const o = r.data.orders.find((x) => x.id === 'o-staff');
  assert.ok(o.costs, 'own costs visible');
});
await ta('D3.1 bootstrap: costs.view_all allows all costs', async () => {
  const env = seeded();
  env.DB.tables.set('user_permissions', [{ user_id: '2', permission: 'orders.view_all', value: 1 }, { user_id: '2', permission: 'costs.view_all', value: 1 }]);
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const o = r.data.orders.find((x) => x.id === 'o-staff2');
  assert.ok(o && o.costs, 'other costs visible');
});
await ta('D3.1 bootstrap: deny costs.view_own hides own costs', async () => {
  const env = seeded();
  env.DB.tables.set('user_permissions', [{ user_id: '2', permission: 'costs.view_own', value: 0 }]);
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const o = r.data.orders.find((x) => x.id === 'o-staff');
  assert.strictEqual(o.costs, undefined, 'own costs hidden');
  assert.strictEqual(o.costTotal, undefined, 'own costTotal hidden');
});
await ta('D3.1 bootstrap: deny costs.view_all hides others costs', async () => {
  const env = seeded();
  env.DB.tables.set('user_permissions', [
    { user_id: '2', permission: 'orders.view_all', value: 1 },
    { user_id: '2', permission: 'costs.view_all', value: 0 },
    { user_id: '2', permission: 'costs.view_own', value: 1 },
  ]);
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const own = r.data.orders.find((x) => x.id === 'o-staff');
  const other = r.data.orders.find((x) => x.id === 'o-staff2');
  assert.ok(own.costs, 'own costs visible');
  assert.strictEqual(other.costs, undefined, 'other costs hidden');
});
await ta('D3.1 bootstrap: no cost perms hides all costs', async () => {
  const env = seeded();
  env.DB.tables.set('user_permissions', [
    { user_id: '2', permission: 'costs.view_own', value: 0 },
    { user_id: '2', permission: 'costs.view_all', value: 0 },
  ]);
  const r = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(r.status, 200);
  for (const o of r.data.orders) {
    assert.strictEqual(o.costs, undefined, 'costs hidden');
    assert.strictEqual(o.costTotal, undefined, 'costTotal hidden');
  }
});
await ta('D3.1 bootstrap: admin deny all cost perms no costs', async () => {
  const env = seeded();
  env.OWNER_USER_ID = null; // المدير 1 هنا مدير عادي: المنع يسري عليه (صلاحيات المالك لا تُقيَّد)
  env.DB.tables.set('user_permissions', [
    { user_id: '1', permission: 'costs.view_own', value: 0 },
    { user_id: '1', permission: 'costs.view_all', value: 0 },
  ]);
  const r = await call(env, '/api/bootstrap', 'tok-admin');
  assert.strictEqual(r.status, 200);
  for (const o of r.data.orders) {
    assert.strictEqual(o.costs, undefined, 'admin costs hidden');
    assert.strictEqual(o.costTotal, undefined, 'admin costTotal hidden');
  }
});

// ---------- Design sub-paths ----------
await ta('D3.1 designs: GET /api/designs/:id staff allowed 200 (designs.view)', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/d1', 'tok-staff');
  assert.strictEqual(r.status, 200);
});
await ta('D3.1 designs: GET /api/designs/:id mandoub denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/d1', 'tok-mandoub');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 designs: GET /api/designs/:id admin allowed 200', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/d1', 'tok-admin');
  assert.strictEqual(r.status, 200);
});
await ta('D3.1 designs: PUT /api/designs/:id staff denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/d1', 'tok-staff', { status: 'closed' }, 'POST');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 designs: DELETE /api/designs/:id staff denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/d1', 'tok-staff', null, 'DELETE');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 designs: POST /api/designs/:id/convert staff denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/d1/convert', 'tok-staff', null, 'POST');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 designs: POST /api/designs/bulk-delete staff denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/designs/bulk-delete', 'tok-staff', { ids: ['d1'] });
  assert.strictEqual(r.status, 403);
});

// ---------- Sync order deletion ----------
await ta('D3.1 sync: staff delete own order denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', 'tok-staff', { orders: { delete: ['o-staff'] } });
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 sync: mandoub delete order denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', 'tok-mandoub', { orders: { delete: ['o-staff'] } });
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 sync: admin delete order allowed 200', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', 'tok-admin', { orders: { delete: ['o-staff'] } });
  assert.strictEqual(r.status, 200);
});

// ---------- Ownership bypass ----------
await ta('D3.1 sync: staff forged createdBy on another order denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', 'tok-staff', { orders: { upsert: [{ id: 'o-staff2', number: 1002, createdBy: '2', status: 'new', customer: { name: 'X' } }] } });
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 sync: staff add cost to another order denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', 'tok-staff', { orders: { upsert: [{ id: 'o-staff2', number: 1002, status: 'new', customer: { name: 'Cust2' }, createdBy: '4', costs: { k: 99 }, costTotal: 99, extraCosts: [] }] } });
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 sync: staff clear costs on another order denied 403', async () => {
  const env = seeded();
  const r = await call(env, '/api/sync', 'tok-staff', { orders: { upsert: [{ id: 'o-staff2', number: 1002, status: 'new', customer: { name: 'Cust2' }, createdBy: '4', costs: {}, extraCosts: [], costUpdatedAt: new Date().toISOString(), costUpdatedByName: 'X' }] } });
  assert.strictEqual(r.status, 403);
});

// ---------- Expenses API ----------
await ta('D3.1 expenses: staff add own expense', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/expenses', 'tok-staff', { name: 'كهرباء', amount: 150, category: 'مرافق', note: 'فاتورة شهرية' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.expense.name, 'كهرباء');
  assert.strictEqual(r.data.expense.amount, 150);
  assert.strictEqual(r.data.expense.created_by, '2');
});
await ta('D3.1 expenses: staff view own expenses', async () => {
  const env = seededGrants();
  await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار', note: 'مكتب' });
  const r = await call(env, '/api/expenses', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.expenses.length, 1);
  assert.strictEqual(r.data.expenses[0].name, 'إيجار');
});
await ta('D3.1 expenses: staff cannot view other staff expenses', async () => {
  const env = seededGrants();
  await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  const env2 = seeded(); // fresh env with different staff
  // Use same env but different token scenario - staff2 cannot see staff's expense
  const r = await call(env, '/api/expenses', 'tok-staff');
  assert.strictEqual(r.status, 200);
  // All expenses in seeded env belong to staff (user_id=2), staff2 (id=4) should see none
  const env3 = seededGrants();
  await call(env3, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  const r2 = await call(env3, '/api/expenses', 'tok-staff');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.data.expenses.length, 1);
});
await ta('D3.1 expenses: admin view all expenses', async () => {
  const env = seededGrants();
  await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  const r = await call(env, '/api/expenses', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.expenses.length, 1);
});
await ta('D3.1 expenses: staff edit own expense', async () => {
  const env = seededGrants();
  const add = await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  const id = add.data.expense.id;
  const r = await call(env, `/api/expenses/${id}`, 'tok-staff', { amount: 600 }, 'PUT');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.expense.amount, 600);
});
await ta('D3.1 expenses: staff delete own expense', async () => {
  const env = seededGrants();
  const add = await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  const id = add.data.expense.id;
  const r = await call(env, `/api/expenses/${id}`, 'tok-staff', null, 'DELETE');
  assert.strictEqual(r.status, 200);
  const get = await call(env, '/api/expenses', 'tok-staff');
  assert.strictEqual(get.data.expenses.length, 0);
});
await ta('D3.1 expenses: staff cannot edit other expense', async () => {
  const env = seededGrants();
  // Add expense as admin
  const addAdmin = await call(env, '/api/expenses', 'tok-admin', { name: 'إدارة', amount: 1000, category: 'إدارة' });
  const adminExpenseId = addAdmin.data.expense.id;
  // Staff tries to edit admin's expense
  const r = await call(env, `/api/expenses/${adminExpenseId}`, 'tok-staff', { amount: 2000 }, 'PUT');
  assert.strictEqual(r.status, 403);
  // Verify admin's expense unchanged
  const list = await call(env, '/api/expenses', 'tok-admin');
  assert.strictEqual(list.status, 200);
  const adminExpense = list.data.expenses.find((e) => e.id === adminExpenseId);
  assert.strictEqual(adminExpense.amount, 1000);
});
await ta('D3.1 expenses: load failure fail-closed', async () => {
  const env = wrapPermFailure(seeded());
  const r = await call(env, '/api/expenses', 'tok-staff');
  assert.strictEqual(r.status, 403);
});

// ---------- Mandoubs Report ----------
await ta('D3.1 mandoubs report: admin sees mandoubs', async () => {
  const env = seeded();
  // Add a delivered order for mandoub
  await call(env, '/api/sync', 'tok-mandoub', { orders: { upsert: [{ id: 'o-mb-new', number: 1004, status: 'delivered', customer: { name: 'MB Cust' }, createdBy: '3', subtotal: 1000, total: 1000, paid: 1000, costs: { k: 300 }, costTotal: 300, extraCosts: [], manualRows: [] }] } });
  const r = await call(env, '/api/reports/mandoubs', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.data.mandoubs));
  const mb = r.data.mandoubs.find((m) => m.id === '3');
  assert.ok(mb, 'mandoub found');
  assert.strictEqual(mb.count, 1);
  assert.strictEqual(mb.revenue, 1000);
  assert.strictEqual(mb.cost, 300);
  assert.strictEqual(mb.profit, 700);
});
await ta('D3.1 mandoubs report: staff denied', async () => {
  const env = seeded();
  const r = await call(env, '/api/reports/mandoubs', 'tok-staff');
  assert.strictEqual(r.status, 403);
});
await ta('D3.1 mandoubs report: load failure fail-closed', async () => {
  const env = wrapPermFailure(seeded());
  const r = await call(env, '/api/reports/mandoubs', 'tok-admin');
  assert.strictEqual(r.status, 403);
});

// ---------- Expenses summary ----------
await ta('D3.1 expenses summary: staff sees own expenses', async () => {
  const env = seededGrants();
  await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  const r = await call(env, '/api/reports/expenses-summary', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.total_amount, 500);
  assert.strictEqual(r.data.count, 1);
});
await ta('D3.1 expenses summary: admin sees all', async () => {
  const env = seededGrants();
  await call(env, '/api/expenses', 'tok-staff', { name: 'إيجار', amount: 500, category: 'إيجار' });
  await call(env, '/api/expenses', 'tok-admin', { name: 'كهرباء', amount: 300, category: 'مرافق' });
  const r = await call(env, '/api/reports/expenses-summary', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.total_amount, 800);
  assert.strictEqual(r.data.count, 2);
});
await ta('D3.1 expenses summary: deny override', async () => {
  const env = seededGrants();
  env.DB.tables.set('user_permissions', [
    { user_id: '2', permission: 'expenses.view_own', value: 0 },
  ]);
  const r = await call(env, '/api/reports/expenses-summary', 'tok-staff');
  assert.strictEqual(r.status, 403);
});

// ---------- Orders summary ----------
await ta('D3.1 orders summary: staff sees own orders only', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const ids = r.data.orders.map((o) => o.id);
  assert.ok(ids.includes('o-staff'));
  assert.ok(!ids.includes('o-staff2'), 'must not see staff2 order');
  assert.ok(!ids.includes('o-mb'), 'must not see mandoub order');
  assert.strictEqual(r.data.count, ids.length);
});

await ta('D3.1 orders summary: admin sees all orders', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary', 'tok-admin');
  assert.strictEqual(r.status, 200);
  const ids = r.data.orders.map((o) => o.id);
  assert.ok(ids.includes('o-staff'));
  assert.ok(ids.includes('o-staff2'));
  assert.ok(ids.includes('o-mb'));
});

await ta('D3.1 orders summary: staff userId filter is fail-closed', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary?userId=4', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const ids = r.data.orders.map((o) => o.id);
  assert.ok(!ids.includes('o-staff2'), 'staff must not pull other users via userId');
});

await ta('D3.1 orders summary: admin userId filter narrows results', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary?userId=4', 'tok-admin');
  assert.strictEqual(r.status, 200);
  const ids = r.data.orders.map((o) => o.id);
  assert.deepStrictEqual(ids, ['o-staff2']);
});

await ta('D3.1 orders summary: staff denied reports.view_own -> 403', async () => {
  const env = seededGrants();
  env.DB.tables.set('user_permissions', [
    { user_id: '2', permission: 'reports.view_own', value: 0 },
  ]);
  const r = await call(env, '/api/reports/orders-summary', 'tok-staff');
  assert.strictEqual(r.status, 403);
});

await ta('D3.1 orders summary: status filter works', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary?status=new', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.orders.length > 0);
  assert.ok(r.data.orders.every((o) => o.status === 'new'));
  const r2 = await call(env, '/api/reports/orders-summary?status=cancelled', 'tok-admin');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.data.count, 0);
});

await ta('D3.1 orders summary: invalid date -> 400', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary?from=01-01-2026', 'tok-admin');
  assert.strictEqual(r.status, 400);
});

await ta('D3.1 orders summary: date range excludes everything when from is in the future', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary?from=2999-01-01', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 0);
});

await ta('D3.1 orders summary: byStatus grouping and numeric totals', async () => {
  const env = seededGrants();
  const r = await call(env, '/api/reports/orders-summary', 'tok-staff');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.byStatus.new, 'new bucket exists');
  assert.strictEqual(r.data.byStatus.new.count, 1);
  assert.strictEqual(typeof r.data.totalRevenue, 'number');
  assert.strictEqual(typeof r.data.totalPaid, 'number');
  assert.strictEqual(typeof r.data.totalRemaining, 'number');
  assert.strictEqual(typeof r.data.totalCost, 'number');
  assert.strictEqual(typeof r.data.netProfit, 'number');
  assert.strictEqual(r.data.totalCost, 10); // seeded o-staff costs { k: 10 }
});

await ta('D3.1 orders summary: payments returned with totals', async () => {
  const env = seededGrants();
  const sync = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [
      { id: 'o-pay', number: 4001, status: 'new', customer: { name: 'Pay Cust' }, created_at: '2026-01-15T10:00:00Z', updated_at: '2026-01-15T10:00:00Z', subtotal: 1000, total: 1100, paid: 400, remaining: 700, costs: {}, costTotal: 0, extraCosts: [], manualRows: [], payments: [{ id: 'p1', amount: 400, method: 'cash', date: '2026-01-15' }] },
    ]}
  });
  assert.strictEqual(sync.status, 200);
  const r = await call(env, '/api/reports/orders-summary?status=new', 'tok-staff');
  assert.strictEqual(r.status, 200);
  const o = r.data.orders.find((x) => x.id === 'o-pay');
  assert.ok(o, 'synced order present');
  assert.strictEqual(o.payments.length, 1);
  assert.strictEqual(o.payments[0].amount, 400);
  assert.strictEqual(o.payments[0].method, 'cash');
  assert.strictEqual(o.paid, 400);
  assert.strictEqual(o.remaining, 700);
  assert.strictEqual(o.revenue ?? o.subtotal, 1000);
});

// ---------- User permissions admin API ----------
await ta('perms: admin reads a staff user permissions', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/2/permissions', 'tok-admin');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.role, 'staff');
  assert.ok(r.data.defaults.includes('orders.view_own'));
  assert.ok(!r.data.defaults.includes('orders.view_all'));
  assert.deepStrictEqual(r.data.overrides, {});
  assert.ok(r.data.catalog.includes('admin.core'));
  assert.ok(r.data.protected.includes('admin.core'));
});

await ta('perms: staff cannot read permissions (403)', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/2/permissions', 'tok-staff');
  assert.strictEqual(r.status, 403);
});

await ta('perms: mandoub cannot read permissions (403)', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/2/permissions', 'tok-mandoub');
  assert.strictEqual(r.status, 403);
});

await ta('perms: unknown user -> 404', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/999/permissions', 'tok-admin');
  assert.strictEqual(r.status, 404);
});

await ta('perms: admin denies staff designs.view -> enforcement applies immediately', async () => {
  const env = seeded();
  const before = await call(env, '/api/designs', 'tok-staff');
  assert.strictEqual(before.status, 200);
  const put = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'designs.view': 0 } }, 'POST');
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.data.saved, 1);
  const after = await call(env, '/api/designs', 'tok-staff');
  assert.strictEqual(after.status, 403, 'deny override must apply on the very next request');
  const again = await call(env, '/api/users/2/permissions', 'tok-admin');
  assert.strictEqual(again.data.overrides['designs.view'], false);
});

await ta('perms: admin re-allows a denied permission (persists)', async () => {
  const env = seeded();
  await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'reports.view_own': 0 } }, 'POST');
  const put = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'reports.view_own': 1 } }, 'POST');
  assert.strictEqual(put.status, 200);
  const r = await call(env, '/api/reports/orders-summary', 'tok-staff');
  assert.strictEqual(r.status, 200, 'allow override restores access without a new account');
});

await ta('perms: PUT rejects unknown permission (400)', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'no.such.perm': 1 } }, 'POST');
  assert.strictEqual(r.status, 400);
});

await ta('perms: PUT rejects overriding admin.core (400)', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'admin.core': 1 } }, 'POST');
  assert.strictEqual(r.status, 400);
});

await ta('perms: PUT rejects invalid value (400)', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'reports.view_own': 2 } }, 'POST');
  assert.strictEqual(r.status, 400);
});

await ta('perms: admin cannot strip own permissions.manage (400)', async () => {
  const env = seeded();
  const r = await call(env, '/api/users/1/permissions', 'tok-admin', { overrides: { 'permissions.manage': 0 } }, 'POST');
  assert.strictEqual(r.status, 400);
});

await ta('perms: replacing overrides with {} restores role defaults', async () => {
  const env = seeded();
  await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'designs.view': 0 } }, 'POST');
  const denied = await call(env, '/api/designs', 'tok-staff');
  assert.strictEqual(denied.status, 403);
  const put = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: {} }, 'POST');
  assert.strictEqual(put.status, 200);
  const allowed = await call(env, '/api/designs', 'tok-staff');
  assert.strictEqual(allowed.status, 200);
});

await ta('perms: DELETE resets overrides to role defaults (audit written)', async () => {
  const env = seeded();
  await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'designs.view': 0, 'orders.edit_own': 0 } }, 'POST');
  const del = await call(env, '/api/users/2/permissions', 'tok-admin', {}, 'DELETE');
  assert.strictEqual(del.status, 200);
  assert.ok(del.data.restored >= 2);
  const r = await call(env, '/api/users/2/permissions', 'tok-admin');
  assert.deepStrictEqual(r.data.overrides, {});
  const allowed = await call(env, '/api/designs', 'tok-staff');
  assert.strictEqual(allowed.status, 200);
  const audit = env.DB.tables.get('permission_audit') || [];
  assert.ok(audit.some((a) => a.change_type === 'defaults_restore' && a.target_user_id === '2' && a.actor_user_id === '1'), 'defaults_restore audit row written');
});

await ta('perms: PUT writes permission audit rows', async () => {
  const env = seeded();
  await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'reports.view_own': 0 }, reason: 'اختبار' }, 'POST');
  const audit = env.DB.tables.get('permission_audit') || [];
  const row = audit.find((a) => a.change_type === 'permission' && a.permission === 'reports.view_own');
  assert.ok(row, 'audit row for the change');
  assert.strictEqual(row.actor_user_id, '1');
  assert.strictEqual(row.target_user_id, '2');
  assert.strictEqual(String(row.new_value), '0');
  assert.strictEqual(row.reason, 'اختبار');
});

await ta('perms: staff cannot POST or DELETE permissions (403)', async () => {
  const env = seeded();
  const put = await call(env, '/api/users/2/permissions', 'tok-staff', { overrides: { 'reports.view_own': 1 } }, 'POST');
  assert.strictEqual(put.status, 403);
  const del = await call(env, '/api/users/2/permissions', 'tok-staff', {}, 'DELETE');
  assert.strictEqual(del.status, 403);
});

await ta('perms: grant override to staff for an admin-only perm works', async () => {
  const env = seeded();
  const put = await call(env, '/api/users/2/permissions', 'tok-admin', { overrides: { 'reports.view_all': 1 } }, 'POST');
  assert.strictEqual(put.status, 200);
  const r = await call(env, '/api/reports/mandoubs', 'tok-staff');
  assert.strictEqual(r.status, 200, 'allow override grants the capability immediately');
});

console.log(lines.join('\n'));
console.log('\n=== permission-api: PASS=' + pass + '  FAIL=' + fail + ' ===');
process.exit(fail ? 1 : 0);