/* صلاحيات تكاليف الطلبات — يشغّل الخادم الحقيقي (worker/worker.js) على D1
   وهمية في الذاكرة (test/_d1-mem.mjs). لا اتصال ولا بيانات إنتاج.

   السياسة المختبرة على مستوى الخادم نفسه (لا إخفاء أزرار):
     1) موظف يضيف تكلفة إلى طلبه: مسموح
     2) موظف على طلب موظف آخر: مرفوض (403) — حتى بتغيير رقم الطلب أو دعوى دور
     3) مندوب على طلبه: مسموح
     4) مندوب على طلب مندوب آخر: مرفوض
     5) محاولة تجاوز عبر /api/sync المباشر أو تزوير ملكية/دور: مرفوض
     6) المدير على أي طلب: مسموح
     7) بلا جلسة أو جلسة منتهية: مرفوض (401)
     8) صحة الإجمالي وبقاء البيانات بعد إعادة الفتح والنسخ العمى

   node test/costs-perms.test.mjs                                              */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envWith } from './_d1-mem.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSrc = fs.readFileSync(path.join(here, '..', 'worker', 'worker.js'), 'utf8');
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
  headers: { 'x-session-token': token || '', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();

const call = async (env, path, token, body, method) => {
  const res = await worker.fetch(jsonReq(path, token, body, method), env);
  let data = null;
  try { data = await res.json(); } catch { /* ليست JSON */ }
  return { status: res.status, data };
};

const orderJSON = (id, number, extra = {}) => Object.assign({
  id, number, status: 'new', customer: { name: 'عميل' },
  subtotal: 1000, total: 1000, paid: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
}, extra);

function seeded() {
  const users = [
    { id: '1', username: 'admin', name: 'المدير', role: 'admin', active: 1, created_at: past() },
    { id: '2', username: 's1', name: 'موظف', role: 'staff', active: 1, created_at: past() },
    { id: '3', username: 'mb1', name: 'مندوب', role: 'mandoub', active: 1, created_at: past() },
    { id: '4', username: 's2', name: 'موظف آخر', role: 'staff', active: 1, created_at: past() },
    { id: '5', username: 'mb2', name: 'مندوب آخر', role: 'mandoub', active: 1, created_at: past() },
  ];
  const sessions = [
    { token: 'tok-admin', user_id: '1', created_at: past(), expires_at: future() },
    { token: 'tok-staff', user_id: '2', created_at: past(), expires_at: future() },
    { token: 'tok-mb', user_id: '3', created_at: past(), expires_at: future() },
    { token: 'tok-staff2', user_id: '4', created_at: past(), expires_at: future() },
    { token: 'tok-mb2', user_id: '5', created_at: past(), expires_at: future() },
    { token: 'tok-dead', user_id: '2', created_at: past(), expires_at: past() },
  ];
  const mk = (id, number, createdBy) => ({
    id, number, status: 'new', customer_name: 'عميل', created_by: createdBy,
    created_at: past(), updated_at: past(),
    data: JSON.stringify(orderJSON(id, number, { createdBy })),
  });
  const orders = [
    mk('o-staff', 1001, '2'),
    mk('o-staff2', 1002, '4'),
    mk('o-mb', 1003, '3'),
    mk('o-mb2', 1004, '5'),
    mk('o-admin', 1005, '1'),
    mk('o-orphan', 1006, null),
  ];
  return {
    users, sessions, orders,
    counters: [{ key: 'order_no', value: 1006 }],
    settings: [{ id: 1, data: '{}', updated_at: past() }],
    items: [],
  };
}

const stored = (env, id) => {
  const row = env.DB.tables.get('orders').find((r) => r.id === id);
  return row ? JSON.parse(row.data) : null;
};
const storedCol = (env, id, col) => {
  const row = env.DB.tables.get('orders').find((r) => r.id === id);
  return row ? row[col] : undefined;
};

/* حمولة «نافذة التكاليف» كما ترسلها الواجهة تماماً */
const costPayload = (base, costs, extras, who, total) => Object.assign({}, base, {
  costs, extraCosts: extras, costTotal: total,
  costUpdatedAt: new Date().toISOString(), costUpdatedByName: who.name,
  updatedAt: new Date().toISOString(),
});
const syncUp = (env, token, order) => call(env, '/api/sync', token, { orders: { upsert: [order] } });

/* ============================ 1–2) الموظف ============================ */
await ta('1) موظف يضيف تكلفة إلى طلبه الخاص: مسموح وتُحفظ', async () => {
  const env = envWith(seeded());
  const r = await syncUp(env, 'tok-staff', costPayload(
    orderJSON('o-staff', 1001),
    { 'sofa:w0': 120 }, [{ name: 'التوصيل', amount: 50 }], { name: 'موظف' }, 170,
  ));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 160));
  const o = stored(env, 'o-staff');
  assert.deepStrictEqual(o.costs, { 'sofa:w0': 120 }, 'costs');
  assert.strictEqual(o.extraCosts[0].amount, 50, 'extraCosts');
  assert.strictEqual(o.costTotal, 170, 'costTotal');
  assert.strictEqual(o.costUpdatedByName, 'موظف', 'ختم التعديل');
  assert.strictEqual(storedCol(env, 'o-staff', 'created_by'), '2', 'الملكية لم تتغير');
});

await ta('2) موظف يضيف تكلفة إلى طلب موظف آخر: مرفوض 403 وبلا كتابة', async () => {
  const env = envWith(seeded());
  const before = stored(env, 'o-staff2');
  const r = await syncUp(env, 'tok-staff', costPayload(
    orderJSON('o-staff2', 1002), { x: 1 }, [{ name: 'توصيل', amount: 9 }], { name: 'موظف' }, 10,
  ));
  assert.strictEqual(r.status, 403, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
  assert.deepStrictEqual(stored(env, 'o-staff2'), before, 'الطلب المحمي تغيّر رغم الرفض');
});

await ta('2ب) حتى بمسح التكاليف بلا نية: مرفوض 403 ولا يُمحى شيء', async () => {
  const env = envWith(seeded());
  // نضع تكاليف كمدير أولاً ثم يحاول موظف آخر حذفها بنسخة بلا تكاليف
  await syncUp(env, 'tok-admin', costPayload(orderJSON('o-staff2', 1002), { a: 5 }, [], { name: 'المدير' }, 5));
  const r = await syncUp(env, 'tok-staff', orderJSON('o-staff2', 1002, { customer: { name: 'آخر' } }));
  assert.strictEqual(r.status, 403, 'status=' + r.status);
  assert.deepStrictEqual(stored(env, 'o-staff2').costs, { a: 5 }, 'التكاليف بقيت كما هي');
});

/* ============================ 3–4) المندوب ============================ */
await ta('3) مندوب يضيف تكلفة إلى طلبه الخاص: مسموح', async () => {
  const env = envWith(seeded());
  const r = await syncUp(env, 'tok-mb', costPayload(
    orderJSON('o-mb', 1003), { k: 80 }, [{ name: 'تحميل وتنزيل', amount: 40 }], { name: 'مندوب' }, 120,
  ));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 160));
  const o = stored(env, 'o-mb');
  assert.strictEqual(o.costTotal, 120);
  assert.strictEqual(o.costUpdatedByName, 'مندوب');
});

await ta('4) مندوب يعدّل تكلفة طلب مندوب آخر: مرفوض 403', async () => {
  const env = envWith(seeded());
  const r = await syncUp(env, 'tok-mb', costPayload(
    orderJSON('o-mb2', 1004), { hijack: 1 }, [], { name: 'مندوب' }, 1,
  ));
  assert.strictEqual(r.status, 403, 'status=' + r.status);
  assert.strictEqual(stored(env, 'o-mb2').costs, undefined, 'لا تكاليف مكتوبة');
});

/* ================= 5) محاولات تجاوز الصلاحيات عبر API ================= */
await ta('5أ) تغيير رقم الطلب الآخر مع تكلفة: مرفوض 403 (الملكية من القاعدة)', async () => {
  const env = envWith(seeded());
  const r = await syncUp(env, 'tok-staff', costPayload(
    orderJSON('o-staff2', 9999), { x: 1 }, [], { name: 'موظف' }, 1,
  ));
  assert.strictEqual(r.status, 403, 'status=' + r.status);
  assert.strictEqual(storedCol(env, 'o-staff2', 'number'), 1002, 'الرقم لم يتغير');
});

await ta('5ب) دعوى ملكية صريحة (createdBy: أنا) على طلب الغير: مرفوض 403', async () => {
  const env = envWith(seeded());
  const r = await syncUp(env, 'tok-staff', costPayload(
    orderJSON('o-staff2', 1002, { createdBy: '2' }), { x: 1 }, [], { name: 'موظف' }, 1,
  ));
  assert.strictEqual(r.status, 403, 'status=' + r.status);
  assert.strictEqual(storedCol(env, 'o-staff2', 'created_by'), '4', 'الملكية لم تُنقل');
});

await ta('5ج) تزوير الدور في الحمولة (role: admin) لا ينفع: مرفوض 403', async () => {
  const env = envWith(seeded());
  const fake = Object.assign(orderJSON('o-staff2', 1002, { createdBy: '1', role: 'admin' }), {
    costs: { x: 1 }, costTotal: 1, costUpdatedAt: new Date().toISOString(),
  });
  const r = await syncUp(env, 'tok-staff', fake);
  assert.strictEqual(r.status, 403, 'status=' + r.status);
});

await ta('5د) طلب بلا مالك (قديم): الموظف مرفوض 403 والمدير فقط يملكه', async () => {
  const env = envWith(seeded());
  const r = await syncUp(env, 'tok-staff', costPayload(orderJSON('o-orphan', 1006), { x: 1 }, [], { name: 'موظف' }, 1));
  assert.strictEqual(r.status, 403, 'status=' + r.status);
  const r2 = await syncUp(env, 'tok-admin', costPayload(orderJSON('o-orphan', 1006), { x: 7 }, [], { name: 'المدير' }, 7));
  assert.strictEqual(r2.status, 200, 'status=' + r2.status);
  assert.strictEqual(stored(env, 'o-orphan').costTotal, 7);
});

await ta('5هـ) سجل نشاط مزوَّر الهوية يُصحَّح من الخادم (userId اجباري)', async () => {
  const env = envWith(seeded());
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [orderJSON('o-staff', 1001)] },
    activity: { upsert: [{ id: 'ev1', at: new Date().toISOString(), action: 'cost', userId: '1', userName: 'المدير', orderId: 'o-staff' }] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 160));
  const ev = env.DB.tables.get('activity').find((x) => x.id === 'ev1');
  assert.ok(ev, 'الحدث لم يُحفظ');
  const parsed = JSON.parse(ev.data);
  assert.strictEqual(parsed.userId, '2', 'userId زائف استبدل بصاحب الجلسة');
  assert.strictEqual(parsed.userName, 'موظف');
});

/* ============================ 6) المدير ============================ */
await ta('6) المدير يعدّل تكاليف أي طلب بغضّ النظر عن المالك', async () => {
  const env = envWith(seeded());
  for (const [id, no] of [['o-staff', 1001], ['o-mb', 1003], ['o-staff2', 1002]]) {
    const r = await syncUp(env, 'tok-admin', costPayload(orderJSON(id, no), { [id]: 10 }, [{ name: 'بنود', amount: 5 }], { name: 'المدير' }, 15));
    assert.strictEqual(r.status, 200, id + ' status=' + r.status);
    assert.strictEqual(stored(env, id).costTotal, 15, id);
  }
});

/* ============================ 7) الجلسة ============================ */
await ta('7) بلا جلسة: 401 — وجلسة منتهية: 401 — وتوكن مزوَّر: 401', async () => {
  const env = envWith(seeded());
  const p = costPayload(orderJSON('o-staff', 1001), { x: 1 }, [], { name: 'x' }, 1);
  assert.strictEqual((await syncUp(env, '', p)).status, 401);
  assert.ok([401, 403].includes((await syncUp(env, 'tok-dead', p)).status));
  assert.strictEqual((await syncUp(env, 'tok-forged-0000', p)).status, 401);
});

/* ================= 8) الإجمالي وبقاء البيانات بعد إعادة الفتح ================= */
await ta('8أ) bootstrap للمنشئ: تكاليفه تصله كاملة — وتكاليف الغير مكسوفة', async () => {
  const env = envWith(seeded());
  await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { 'k': 100 }, [{ name: 'توصيل', amount: 70 }], { name: 'موظف' }, 170));
  const boot = await call(env, '/api/bootstrap', 'tok-staff');
  assert.strictEqual(boot.status, 200);
  const mine = boot.data.orders.find((o) => o.id === 'o-staff');
  const theirs = boot.data.orders.find((o) => o.id === 'o-staff2');
  assert.deepStrictEqual(mine.costs, { k: 100 }, 'تكاليف طلبي لا تصلني');
  assert.strictEqual(mine.costTotal, 170);
  assert.strictEqual(mine.extraCosts[0].amount, 70);
  assert.strictEqual(theirs.costs, undefined, 'تكاليف طلب زميل وصلتني');
  assert.strictEqual(theirs.costTotal, undefined);
  assert.strictEqual(theirs.extraCosts, undefined);
  const man = ((theirs.manualRows) || []);
  assert.ok(!man.some((m) => m && m.cost !== undefined), 'تكلفة صنف يدوي تسرّبت');
});

await ta('8ب) الإجمالي متسق مع البنود (50 توصيل + 100 صنف = 150) ويبقى بعد إعادة الفتح', async () => {
  const env = envWith(seeded());
  await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { k: 100 }, [{ name: 'توصيل', amount: 50 }], { name: 'موظف' }, 150));
  // إعادة فتح = bootstrap جديد (جلسة جديدة للنفس)
  const boot = await call(env, '/api/bootstrap', 'tok-staff');
  const o = boot.data.orders.find((x) => x.id === 'o-staff');
  const extrasSum = o.extraCosts.reduce((s, e) => s + e.amount, 0);
  const linesSum = Object.values(o.costs).reduce((s, v) => s + v, 0);
  assert.strictEqual(extrasSum + linesSum, o.costTotal, 'الإجمالي ≠ مجموع البنود');
});

await ta('8ج) نسخة عمياء بلا أي أثر تكلفة لا تمحو التكاليف (تُستعاد من المخزّن)', async () => {
  const env = envWith(seeded());
  await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { k: 100 }, [{ name: 'توصيل', amount: 50 }], { name: 'موظف' }, 150));
  // نسخة قديمة محلية: بلا costs ولا extraCosts ولا ختم — كما كانت قبل رؤية الموظف للتكاليف
  const stale = orderJSON('o-staff', 1001, { customer: { name: 'اسم جديد' } });
  delete stale.costs; delete stale.extraCosts; delete stale.costTotal;
  const r = await syncUp(env, 'tok-staff', stale);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 160));
  const o = stored(env, 'o-staff');
  assert.deepStrictEqual(o.costs, { k: 100 }, 'التكاليف ضاعت بالنسخ العميء');
  assert.strictEqual(o.costTotal, 150);
  assert.strictEqual(o.customer.name, 'اسم جديد', 'تعديل non-cost لم يُحفظ');
});

await ta('8د) مسح مقصود (ختم تكاليف + قوائم فارغة) يُقبل ويمسح', async () => {
  const env = envWith(seeded());
  await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { k: 100 }, [{ name: 'توصيل', amount: 50 }], { name: 'موظف' }, 150));
  const cleared = orderJSON('o-staff', 1001, {
    costs: {}, extraCosts: [],
    costUpdatedAt: new Date().toISOString(), costUpdatedByName: 'موظف',
  });
  delete cleared.costTotal;
  const r = await syncUp(env, 'tok-staff', cleared);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 160));
  const o = stored(env, 'o-staff');
  assert.deepStrictEqual(o.costs, {}, 'لم يُمسح');
  assert.deepStrictEqual(o.extraCosts, [], 'البنود لم تُمسح');
  assert.strictEqual(o.costTotal, undefined, 'الإجمالي لم يُحذف');
});

await ta('8هـ) قيمة مالية فاسدة تُرفض 400 ولا تُكتب', async () => {
  const env = envWith(seeded());
  const r1 = await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { k: -5 }, [], { name: 'موظف' }, 0));
  assert.strictEqual(r1.status, 400, 'سالب: status=' + r1.status);
  const r2 = await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { k: 1 }, [], { name: 'موظف' }, 'abc'));
  assert.strictEqual(r2.status, 400, 'نص: status=' + r2.status);
  assert.strictEqual(stored(env, 'o-staff').costs, undefined, 'كُتب رغم الرفض');
});

await ta('8و) المدير يرى تكاليف الجميع في bootstrap — والمندوب طلبه فقط', async () => {
  const env = envWith(seeded());
  await syncUp(env, 'tok-staff', costPayload(orderJSON('o-staff', 1001), { k: 3 }, [], { name: 'موظف' }, 3));
  const admin = await call(env, '/api/bootstrap', 'tok-admin');
  assert.strictEqual(admin.data.orders.find((o) => o.id === 'o-staff').costs.k, 3, 'المدير لا يرى تكاليف الموظف');
  const mb = await call(env, '/api/bootstrap', 'tok-mb');
  assert.strictEqual(mb.data.orders.find((o) => o.id === 'o-mb').costs, undefined, 'المندوب طلبه بلا تكاليف (لم يدخلها)');
  assert.strictEqual(mb.data.orders.find((o) => o.id === 'o-staff').costs, undefined, 'تكاليف الموظف وصلت المندوب');
});

/* ---------- النتيجة ---------- */
const report = lines.join('\n') + '\n\n=== النتيجة: PASS=' + pass + '  FAIL=' + fail + ' ===';
console.log(report);
process.exit(fail ? 1 : 0);
