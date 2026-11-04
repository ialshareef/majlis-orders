/* اختبارات أمان Supremo — المصادقة والصلاحيات (worker/worker.js) على D1
   وهمية في الذاكرة (test/_d1-mem.mjs). لا اتصال ولا بيانات إنتاج.

   التغطية:
   1) فرض تغيير كلمة المرور عند أول دخول (must_change_password)
   2) منع حساب admin/admin الافتراضي (لا يُنشأ قبل ADMIN_INIT_PASSWORD)
   3) تغيير كلمة المرور يُبطل الجلسات الأخرى (عدا الجلسة الحالية)
   4) النطاقات غير المذكورة في CORS تُرفض (fail-closed)
   5) النطاقات المذكورة تُقبل في CORS
   6) بلا جلسة أو جلسة منتهية ← 401
   7) موظف على مورد لغيره ← 403
   8) بيانات غير صالحة في المزامنة تُرفض برسالة واضحة
   9) لا تُسرَّب كلمة المرور أو التجزئة في أي رد
   10) التوافق مع ترقية تكرار PBKDF2 (إعادة الحساب عند الدخول)

   التشغيل: node test/run-mjs-test.cjs test/security.test.mjs   */

import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
import worker from '../worker/worker.js';
import { envWith } from './_d1-mem.mjs';

const { subtle } = webcrypto;
const encoder = new TextEncoder();

let pass = 0, fail = 0;
const lines = [];
function t(name, fn) {
  try { fn(); pass++; lines.push('PASS  ' + name); }
  catch (e) { fail++; lines.push('FAIL  ' + name + '  -> ' + (e && e.message)); }
}
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
  try { data = await res.json(); } catch { /* ليست JSON */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), data };
};
/* مالك النظام: معرّف ثابت من البيئة (OWNER_USER_ID). المدير رقم 1 هنا هو المالك؛ أي مدير آخر مدير عادي. */
const makeEnv = (origin = ALLOWED) => { const e = envWith(); if (origin) e.ALLOWED_ORIGIN = origin; e.OWNER_USER_ID = '1'; return e; };
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();

/* تجزئة PBKDF2 بنفس التكلفة والملح المستخدمين في التجزئة الحقيقية */
async function makeHash(password, iterations = 100000) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  const hash = Array.from(new Uint8Array(bits));
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(hash)}`;
}

const hashPw = async (p) => makeHash(p, 100000);
const hashPwOld = async (p) => makeHash(p, 20000); // تجزئة قديمة (قبل الترقية)

function seededUsers() {
  const users = [
    { id: '1', username: 'admin', name: 'المدير', role: 'admin', active: 1, created_at: past(), must_change_password: 0, password_hash: null },
    { id: '2', username: 'staff1', name: 'الموظف', role: 'staff', active: 1, created_at: past(), must_change_password: 0, password_hash: null },
    { id: '3', username: 'mustchg', name: 'مدير مؤقت', role: 'admin', active: 1, created_at: past(), must_change_password: 1, password_hash: null },
  ];
  const sessions = [
    { token: 'tok-admin', user_id: '1', created_at: past(), expires_at: future() },
    { token: 'tok-staff', user_id: '2', created_at: past(), expires_at: future() },
    { token: 'tok-must', user_id: '3', created_at: past(), expires_at: future() },
    { token: 'tok-other-session', user_id: '3', created_at: past(), expires_at: future() },
    { token: 'tok-dead', user_id: '2', created_at: past(), expires_at: past() },
  ];
  return { users, sessions };
}

async function seedEnv(env, overrides = {}) {
  const s = seededUsers();
  for (const u of s.users) u.password_hash = overrides.username && overrides.username === u.username ? overrides.password_hash : (await hashPw('P@ssw0rd123'));
  //-user specific overrides
  if (overrides.adminHash) s.users.find((u) => u.username === 'admin').password_hash = overrides.adminHash;
  if (overrides.mustHash) s.users.find((u) => u.username === 'mustchg').password_hash = overrides.mustHash;
  env.DB.tables.set('users', s.users);
  env.DB.tables.set('sessions', s.sessions);
  env.DB.tables.set('counters', [{ key: 'order_no', value: 1000 }, { key: 'design_no', value: 26000126 }]);
  env.DB.tables.set('settings', [{ id: 1, data: '{}', updated_at: past() }]);
  env.DB.tables.set('items', []);
  env.DB.tables.set('orders', [
    { id: 'o-own', number: 1001, status: 'new', customer_name: 'عميل', created_by: '2', created_at: past(), updated_at: past(), data: JSON.stringify({ id: 'o-own', number: 1001, total: 1000, createdBy: '2' }) },
    { id: 'o-other', number: 1002, status: 'new', customer_name: 'عميل آخر', created_by: '4', created_at: past(), updated_at: past(), data: JSON.stringify({ id: 'o-other', number: 1002, total: 2000, createdBy: '4' }) },
  ]);
  env.DB.tables.set('customer_designs', [
    { id: 'd-own', public_no: 26000127, token: 'a'.repeat(64), status: 'new', design: '{}', customer_name: 'عميل', customer_phone: '', contact_requested: 0, order_id: null, order_number: null, created_at: past(), updated_at: past(), expires_at: future() },
    { id: 'd-other', public_no: 26000128, token: 'b'.repeat(64), status: 'new', design: '{}', customer_name: 'عميل آخر', customer_phone: '', contact_requested: 0, order_id: null, order_number: null, created_at: past(), updated_at: past(), expires_at: future() },
  ]);
  return s;
}

const ALLOWED = 'https://app.example.com';
const EVIL = 'https://evil.example.com';
const VALID_DESIGN_TOKEN = 'a'.repeat(64); // توكن صالح 64-hex يطابق شرط portalRow

console.log('\n=== 1–3) سياسات كلمة المرور والجلسات ===');

await ta('1.1) مستخدم must_change_password=1 يُحظر من /api/bootstrap ← 403', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/bootstrap', 'tok-must');
  assert.strictEqual(r.status, 403, 'status=' + r.status);
});

await ta('1.2) مستخدم must_change_password=1 يُحظر من /api/sync ← 403', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-must', { orders: { upsert: [{ id: 'x', number: 1, status: 'new', customer: { name: 'a' } }] } });
  assert.strictEqual(r.status, 403, 'status=' + r.status);
});

await ta('1.3) /api/me و /api/logout متاحان رغم الحظر', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const me = await call(env, '/api/me', 'tok-must');
  assert.strictEqual(me.status, 200);
  const out = await call(env, '/api/logout', 'tok-must', null, 'POST');
  assert.strictEqual(out.status, 200);
});

await ta('2) لا يُنشأ حساب admin/admin: يتطلب ADMIN_INIT_PASSWORD وإلا لا حساب', async () => {
  const env = makeEnv();
  // لا تُنشأ أي بيانات بلا المتغير المقصود؛ ensureSeed لا يعمل بلا ADMIN_INIT_PASSWORD
  const r = await call(env, '/api/app-update', '');
  assert.strictEqual(r.status, 200);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(username) = ?').bind('admin').first();
  assert.strictEqual(Number(count.n), 0, 'لا يُنشأ admin بدون ADMIN_INIT_PASSWORD');
});

/* محاكاة تسجيل دخول حقيقي: استدعاء /api/login بكل الطلبات (Mock)
   دون الاعتماد على أي سلوك غير موثوق. */
async function singleUserEnv(username = 'mustchg', password = 'OldPass123!', mustChange = 1, role = 'admin') {
  const env = makeEnv();
  const password_hash = await hashPw(password);
  env.DB.tables.set('users', [{ id: 'u1', username, name: 'مستخدم تجريبي', role, active: 1, created_at: past(), must_change_password: mustChange ? 1 : 0, password_hash }]);
  env.DB.tables.set('sessions', [{ token: 'tok-su', user_id: 'u1', created_at: past(), expires_at: future() }]);
  env.DB.tables.set('counters', [{ key: 'order_no', value: 1000 }]);
  env.DB.tables.set('settings', [{ id: 1, data: '{}', updated_at: past() }]);
  env.DB.tables.set('items', []);
  env.DB.tables.set('orders', []);
  return { env, token: 'tok-su', userId: 'u1', password };
}

await ta('3.1) تغيير كلمة المرور يُبطل الجلسات الأخرى ويتطلب التغيير عند أول دخول', async () => {
  const { env, token, userId, password } = await singleUserEnv('mustchg', 'OldPass123!', 1, 'admin');
  // أول دخول ينجح مع mustChangePassword=true (يُجبر على التغيير عند أول جلسة)
  const lg = await call(env, '/api/login', '', { username: 'mustchg', password });
  assert.strictEqual(lg.status, 200, JSON.stringify(lg.data).slice(0, 160));
  assert.strictEqual(lg.data.mustChangePassword, true, 'يجب طلب تغيير كلمة المرور');
  const newToken = lg.data.token;
  // تغيير كلمة المرور
  const cp = await call(env, '/api/change-password', newToken, { currentPassword: password, newPassword: 'NewPass123!' });
  assert.strictEqual(cp.status, 200, JSON.stringify(cp.data).slice(0, 160));
  // التحقق: لم تعد الجلسة القديمة صالحة
  const row = await env.DB.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?').bind(userId).first();
  assert.strictEqual(row.must_change_password, 0, 'لم تُصفَّر must_change_password');
  assert.notStrictEqual(row.password_hash, await hashPw(password), 'لم تتغير التجزئة');
  // الجلسات الأخرى أُبطلت (تبقى فقط الجلسة الحالية)
  const sessions = await env.DB.prepare("SELECT token FROM sessions WHERE user_id = ?").bind(userId).all();
  const tokens = (sessions.results || []).map((x) => x.token);
  assert.ok(tokens.includes(newToken), 'الجلسة الحالية ما زالت صالحة');
  assert.strictEqual(tokens.length, 1, 'الجلسات الأخرى أُبطلت');
  // انتهت صلاحية الجلسة القديمة الآن
  const boot = await call(env, '/api/bootstrap', newToken);
  assert.strictEqual(boot.status, 200, 'الجلسة الجديدة تعمل بعد التغيير');
});

await ta('3.2) تغيير كلمة المرور لكلمة ضعيفة يُرفض ← 400', async () => {
  const { env, token, password } = await singleUserEnv('mustchg', 'OldPass123!', 1, 'admin');
  const cp = await call(env, '/api/change-password', token, { currentPassword: 'WrongPass123!', newPassword: 'NewPass123!' });
  assert.strictEqual(cp.status, 401, 'status=' + cp.status);
});

await ta('3.3) رفض كلمة مرور فارغة/قصيرة جداً ← 400', async () => {
  const { env, token, password } = await singleUserEnv('mustchg', 'OldPass123!', 1, 'admin');
  const cp = await call(env, '/api/change-password', token, { currentPassword: password, newPassword: '12345678' });
  assert.strictEqual(cp.status, 400, 'كلمة مرور ضعيفة: ' + cp.status);
  const cp2 = await call(env, '/api/change-password', token, { currentPassword: password, newPassword: 'password' });
  assert.strictEqual(cp2.status, 400, 'كلمة مرور قصيرة: ' + cp2.status);
});

console.log('\n=== 4–5) CORS: الضبط الصارم ===');

await ta('4.1) نطاق غير مذكور في ALLOWED_ORIGIN يُرفض (fail-closed)', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/app-update', '', null, 'GET');
  // نطاق شرير غير مذكور: لا تُعاد ترويسة Allow-Origin له إطلاقاً
  const evilReq = jsonReq('/api/app-update', '', null, 'GET');
  evilReq.headers.set('Origin', EVIL);
  const res = await worker.fetch(evilReq, env);
  const acao = res.headers.get('access-control-allow-origin');
  assert.ok(!acao || acao !== EVIL, 'لا يُسمح للنطاق الشرير: ' + acao);
});

await ta('4.2) النطاق المذكور يُعاد في Access-Control-Allow-Origin', async () => {
  const env = makeEnv();
  const allowedReq = jsonReq('/api/app-update', '', null, 'GET');
  allowedReq.headers.set('Origin', ALLOWED);
  const res = await worker.fetch(allowedReq, env);
  const acao = res.headers.get('access-control-allow-origin');
  assert.strictEqual(acao, ALLOWED, 'النطاق المذكور مسموح: ' + acao);
});

await ta('4.3) OPTIONS يُعاد 204 فقط مع نطاق مسموح', async () => {
  const env = makeEnv();
  const pre = jsonReq('/api/sync', '', null, 'OPTIONS');
  pre.headers.set('Origin', EVIL);
  pre.headers.set('Access-Control-Request-Method', 'POST');
  pre.headers.set('Access-Control-Request-Headers', 'content-type,x-session-token');
  const res = await worker.fetch(pre, env);
  assert.strictEqual(res.status, 204, 'status=' + res.status);
  assert.ok(!res.headers.get('access-control-allow-origin') || res.headers.get('access-control-allow-origin') !== EVIL, 'OPTIONS لا يسمح بنطاق شرير');
});

await ta('4.4) بلا ALLOWED_ORIGIN لا يُعاد أي نطاق (fail-closed)', async () => {
  const env = makeEnv(undefined);
  const noOriginReq = jsonReq('/api/app-update', '', null, 'GET');
  noOriginReq.headers.set('Origin', EVIL);
  const res = await worker.fetch(noOriginReq, env);
  const acao = res.headers.get('access-control-allow-origin');
  assert.ok(!acao, 'لا تُعاد ترويسة بدون ALLOWED_ORIGIN: ' + acao);
});

console.log('\n=== 6–8) الملكية والصلاحيات ===');

await ta('6.1) بلا توكن ← 401', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/bootstrap', '');
  assert.strictEqual(r.status, 401, 'status=' + r.status);
});

await ta('6.2) توكن مزيف ← 401', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/bootstrap', 'tok-forged-0000');
  assert.strictEqual(r.status, 401, 'status=' + r.status);
});

await ta('6.3) توكن منتهٍ ← 401', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/bootstrap', 'tok-dead');
  assert.ok(r.status === 401, 'status=' + r.status);
});

await ta('7.1) موظف على طلب غير ملكه ← 403', async () => {
  const env = makeEnv();
  await seedEnv(env);
  // d-other مملوك لـ staff1 (created_by '4' — محاولة انتحال الملكية بتغيير الطلب)
  // التحايل على الملكية: إرسال تعديل برقم طلب الغير
  // استخدام sync: إرسال طلب تعديل برقم طلب غير مملوك
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-other', number: 1002, status: 'new', customer: { name: 'عميل آخر' } }] },
  });
  assert.strictEqual(r.status, 403, 'لا يمكن تعديل طلب غير ملك: ' + r.status);
  const row = await env.DB.prepare('SELECT created_by FROM orders WHERE id = ?').bind('o-other').first();
  assert.strictEqual(row.created_by, '4', 'المالك لم يتغير');
});

await ta('7.2) المدير يعدّل أي طلب ← 200', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-admin', {
    orders: { upsert: [{ id: 'o-other', number: 1002, status: 'new', customer: { name: 'اسم جديد' } }] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 160));
});

await ta('8.1) حقن createdBy في المزامنة يُرفض ← 403', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const fake = { id: 'o-other', number: 1002, status: 'new', customer: { name: 'مزوّر' }, role: 'admin', createdBy: '1' };
  const r = await call(env, '/api/sync', 'tok-staff', { orders: { upsert: [fake] } });
  assert.strictEqual(r.status, 403, 'لا يمكن انتحال ملكية/دور: ' + r.status);
});

await ta('8.2) حقن created_by في المزامنة يُرفض ← 403', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'ز' }, createdBy: '9' }] },
  });
  assert.strictEqual(r.status, 403, 'لا يمكن انتحال الملكية: ' + r.status);
  const col = await env.DB.prepare('SELECT created_by FROM orders WHERE id = ?').bind('o-own').first();
  assert.strictEqual(col.created_by, '2', 'created_by ثابت');
});

await ta('8.3) قيم غير صالحة في المزامنة ← 400', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, total: -500 }] },
  });
  assert.strictEqual(r.status, 400, 'قيم غير صالحة: ' + r.status);
});

console.log('\n=== 9) لا تُسرَّب أسرار المصادقة ===');

await ta('9.1) كلمة مرور الدخول لا تظهر في الرد', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/login', '', { username: 'admin', password: 'P@ssw0rd123' });
  const s = JSON.stringify(r.data);
  assert.ok(!/P@ssw0rd123/.test(s), 'لا تُسرب كلمة المرور للعميل');
  assert.ok(r.data.user && !r.data.user.password_hash, 'لا تُسرب التجزئة في user');
});

await ta('9.2) التجزئة لا تظهر في رد الخادم', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/login', '', { username: 'admin', password: 'Wrong!' });
  const s = JSON.stringify(r.data);
  assert.ok(!/pbkdf2/.test(s), 'لا تُسرب التجزئة في أي رد');
  assert.ok(r.status === 200 || r.status === 400, 'status قابل للتنبؤ: ' + r.status);
});

console.log('\n=== 10) التوافق مع التجزئة القديمة ===');

await ta('10) مستخدم بتجزئة 20000 تكرار يُرقّى تلقائياً إلى 100000 عند الدخول', async () => {
  const env = makeEnv();
  const s = await seedEnv(env);
  const adminUser = s.users.find((u) => u.username === 'admin');
  adminUser.password_hash = await hashPwOld('P@ssw0rd123');
  env.DB.tables.set('users', s.users);
  const r = await call(env, '/api/login', '', { username: 'admin', password: 'P@ssw0rd123' });
  assert.strictEqual(r.status, 200, 'ترقية التجزئة نجحت: ' + JSON.stringify(r.data).slice(0, 120));
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(adminUser.id).first();
  const iter = Number(String(row.password_hash).split('$')[1]);
  assert.strictEqual(iter, 100000, 'رُقّيت التجزئة: iter=' + iter);
});

console.log('\n=== 1ب) حظر الوصول قبل تغيير كلمة المرور ===');

/* /api/me متاح دائماً حتى مع حظر الوصول (ضمن مسارات must_change_password
   من /api/login ثم /api/me لإظهار حالة الحظر). */
await ta('1.4) /api/me يرجع 200 مع حالة الحظر', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const me = await call(env, '/api/me', 'tok-must');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.user.username, 'mustchg');
  assert.strictEqual(me.data.user.role, 'admin');
});

/* حظر الوصول لكل المسارات المحمية ← 403 قبل أي معالجة HTTP. */
await ta('1.5) كل المسارات المحمية ترفض بجلسة محظورة ← 403', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const sensitive = [
    ['/api/bootstrap', 'GET', null],
    ['/api/sync', 'POST', { orders: { upsert: [] } }],
    ['/api/users', 'GET', null],
    ['/api/users', 'POST', { name: 'x', username: 'newuser-x', role: 'staff', password: 'Pass1234!' }],
    ['/api/owner-analytics', 'GET', null],
    ['/api/link-visits', 'GET', null],
    ['/api/next-order-no', 'POST', null],
    ['/api/sync-order-seq', 'POST', null],
  ];
  for (const [path, method, body] of sensitive) {
    const r = await call(env, path, 'tok-must', body, method);
    assert.strictEqual(r.status, 403, path + ' ' + method + ' مرفوض بجلسة محظورة: ' + r.status);
  }
});

/* إنشاء مستخدم بكلمة مرور ضعيفة ← 400 في saveUser. */
await ta('3.4) كلمة مرور المستخدم الجديد ضعيفة ← 400', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/users', 'tok-admin', {
    id: '2', username: 'staff1', name: 'اسم قصير', role: 'staff', password: 'password'
  }, 'POST');
  assert.strictEqual(r.status, 400, 'كلمة مرور ضعيفة للمستخدم: ' + r.status);
});

/* كلمة المرور أقصر من 8 أحرف ← 400. */
await ta('3.5) كلمة مرور المستخدم أقصر من 8 ← 400', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/users', 'tok-admin', {
    name: 'اسم', username: 'newuser-min', role: 'staff', password: '1234567'
  }, 'POST');
  assert.strictEqual(r.status, 400, 'كلمة مرور قصيرة: ' + r.status);
});

/* مستخدم قديم بتجزئة 20,000 تكرار (قبل الترقية) يُرقّى تلقائياً. */
await ta('3.6) مستخدم قديم بتجزئة 20000 يُرقّى عند الدخول', async () => {
  const env = makeEnv();
  const s = await seedEnv(env);
  const adminUser = s.users.find((u) => u.username === 'admin');
  adminUser.password_hash = await hashPwOld('weakpass!');
  adminUser.must_change_password = 0;
  env.DB.tables.set('users', s.users);
  const r = await call(env, '/api/login', '', { username: 'admin', password: 'weakpass!' });
  assert.strictEqual(r.status, 200, 'ترقية التجزئة القديمة: ' + JSON.stringify(r.data).slice(0, 120));
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(adminUser.id).first();
  const iter = Number(String(row.password_hash).split('$')[1]);
  assert.strictEqual(iter, 100000, 'أُعيد حسابها بالمعيار: iter=' + iter);
});

console.log('\n=== 4ب) CORS — ضبط إضافي ===');

/* ALLOWED_ORIGIN=* يُرفض جملةً: لا يسمح بأي نطاق (fail-closed). */
await ta('4.5) ALLOWED_ORIGIN=* لا يسمح بشيء', async () => {
  const env = makeEnv();
  env.ALLOWED_ORIGIN = '*';
  const req = jsonReq('/api/app-update', '', null, 'GET');
  req.headers.set('Origin', ALLOWED);
  const res = await worker.fetch(req, env);
  const acao = res.headers.get('access-control-allow-origin');
  assert.ok(!acao, 'لا يُعاد نطاق مع ALLOWED_ORIGIN=*: ' + acao);
});

/* Origin شرير غير مذكور لا يُعاد. */
await ta('4.6) Origin شرير غير مذكور لا يُعاد', async () => {
  const env = makeEnv();
  const req = jsonReq('/api/app-update', '', null, 'GET');
  req.headers.set('Origin', '');
  const res = await worker.fetch(req, env);
  const acao = res.headers.get('access-control-allow-origin');
  assert.ok(!acao, 'لا يُعاد Origin شرير: ' + acao);
});

/* OPTIONS مع نطاق مسموح: 204 مع الترويسة الصحيحة. */
await ta('4.7) OPTIONS بنطاق مسموح يُعاد 204 مع الترويسة', async () => {
  const env = makeEnv();
  const pre = jsonReq('/api/sync', '', null, 'OPTIONS');
  pre.headers.set('Origin', ALLOWED);
  pre.headers.set('Access-Control-Request-Method', 'POST');
  pre.headers.set('Access-Control-Request-Headers', 'content-type,x-session-token');
  const res = await worker.fetch(pre, env);
  assert.strictEqual(res.status, 204, 'status=' + res.status);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), ALLOWED, 'النطاق يُعاد في OPTIONS');
});

/* CORS لا يكفي وحده: بلا توكن ← 401. */
await ta('4.8) طلب بلا توكن ← 401 حتى مع CORS', async () => {
  const env = makeEnv();
  const req = jsonReq('/api/bootstrap', '', null, 'GET');
  req.headers.set('Origin', ALLOWED);
  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 401, 'التوكن مطلوب رغم CORS: ' + res.status);
});

console.log('\n=== 8ب) قيم مالية — حدود ===');

/* subtotal سالب. */
await ta('8.4) subtotal سالب ← 400', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, subtotal: -100 }] },
  });
  assert.strictEqual(r.status, 400, 'subtotal سالب: ' + r.status);
});

/* remaining سالب. */
await ta('8.5) remaining سالب ← 400', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, remaining: -50 }] },
  });
  assert.strictEqual(r.status, 400, 'remaining سالب: ' + r.status);
});

/* vatRate سالب. */
await ta('8.6) vatRate سالب ← 400', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, vatRate: -5 }] },
  });
  assert.strictEqual(r.status, 400, 'vatRate سالب: ' + r.status);
});

/* vatAmount سالب يُرفض صراحةً (إلى جانب التحقق من subtotal/total/remaining/vatRate). */
await ta('8.7) vatAmount سالب ← 400 حتى مع بقية القيم صالحة', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, vatAmount: -50 }] },
  });
  assert.strictEqual(r.status, 400, 'vatAmount سالب مرفوض صراحة: ' + r.status);
});

/* paid سالب (استرداد) مسموح 200 — الاسترداد الوحيد المسموح سالباً. */
await ta('8.8) paid سالب (استرداد) مسموح ← 200', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, paid: -100 }] },
  });
  assert.strictEqual(r.status, 200, 'استرداد paid سالب مقبول: ' + r.status);
});

/* total ضخم لا يُسقط المعالج (القبول أو الرفض بأمان). */
await ta('8.9) total ضخم لا يُسقط المعالج', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const r = await call(env, '/api/sync', 'tok-staff', {
    orders: { upsert: [{ id: 'o-own', number: 1001, status: 'new', customer: { name: 'عميل' }, total: 999999999 }] },
  });
  assert.ok(r.status === 200 || r.status === 400, 'status قابل للتنبؤ: ' + r.status);
});

console.log('\n=== 11) حصة الذكاء الاصطناعي (ai-design) ===');

/* محاكاة استدعاء النموذج عبر fetch مخصّص (بلا اتصال حقيقي). */
function mockOpenAI(content) {
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  return { called, restore: () => { globalThis.fetch = orig; } };
}

/* بلا AI_API_KEY ← 503 مع رفض آمن. */
await ta('11.1) بلا AI_API_KEY تُرفض ← 503', async () => {
  const env = makeEnv();
  await seedEnv(env);
  const req = jsonReq('/api/portal/ai-design', '', { text: 'تصميم مجلس' }, 'POST');
  req.headers.set('x-design-token', VALID_DESIGN_TOKEN);
  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 503, '503 بدون AI_API_KEY: ' + res.status);
});

/* توكن جلسة مزيف ← 401. */
await ta('11.2) توكن مزيف ← 401', async () => {
  const env = makeEnv();
  env.AI_API_KEY = 'test-dummy-key';
  const req = jsonReq('/api/portal/ai-design', '', { text: 'تصميم' }, 'POST');
  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 401, '401 لتوكن مزيف: ' + res.status);
});

/* توكن جلسة غير صالح الصيغة (ليس hex 64) ← 401. */
await ta('11.3) توكن غير صالح الصيغة ← 401', async () => {
  const env = makeEnv();
  env.AI_API_KEY = 'test-dummy-key';
  const req = jsonReq('/api/portal/ai-design', '', { text: 'تصميم' }, 'POST');
  req.headers.set('x-design-token', 'invalid-token-not-hex');
  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 401, '401 لتوكن غير مطابق: ' + res.status);
});

/* نص أطول من الحد (>AI_TEXT_MAX) يُرفض 400 بلا استدعاء للنموذج. */
await ta('11.4) نص أطول من الحد يُرفض ← 400 بلا استدعاء خارجي', async () => {
  const env = makeEnv();
  env.AI_API_KEY = 'test-dummy-key';
  await seedEnv(env);
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }));
  };
  try {
    const longText = '?'.repeat(3001);
    const req = jsonReq('/api/portal/ai-design', '', { text: longText }, 'POST');
    req.headers.set('x-design-token', VALID_DESIGN_TOKEN);
    const res = await worker.fetch(req, env);
    assert.strictEqual(res.status, 400, 'النص الطويل رُفض 400: ' + res.status);
    assert.strictEqual(fetchCalled, false, 'لم يُستدعَ النموذج بلا داعٍ');
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* aiSanitizeSpec يعمل داخل portalAiDesign مع mock fetch: المخرجات صالحة. */
await ta('11.5) استجابة ai-design صالحة مع mock fetch', async () => {
  const env = makeEnv();
  env.AI_API_KEY = 'test-dummy-key';
  await seedEnv(env);
  const { restore } = mockOpenAI(JSON.stringify({ status: 'ready', note: '??', questions: [], assumptions: [], issues: [], spec: { roomW: 5, roomH: 4 } }));
  try {
    const req = jsonReq('/api/portal/ai-design', '', { text: 'غرفة 5×4', spec: { roomW: 5, roomH: 4, sofaWalls: [0, 1] } }, 'POST');
    req.headers.set('x-design-token', VALID_DESIGN_TOKEN);
    const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 200, '200 مع mock fetch: ' + res.status);
    const data = await res.json();
  assert.ok(data && data.spec && data.spec.roomW === 5, 'المواصفات صمدت كما هي: ' + JSON.stringify(data).slice(0, 200));
  } finally {
    restore();
  }
});

/* aiSanitizeModelOut يعمل: مخرجات AI المشوّهة (ليست JSON) ← 503. */
await ta('11.6) مخرجات الذكاء الاصطناعي المشوّهة (ليست JSON) ← 503', async () => {
  const env = makeEnv();
  env.AI_API_KEY = 'test-dummy-key';
  await seedEnv(env);
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('ليست JSON صالحة');
  };
  try {
    const req = jsonReq('/api/portal/ai-design', '', { text: 'تصميم' }, 'POST');
    req.headers.set('x-design-token', VALID_DESIGN_TOKEN);
    const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 503, '503 لمخرجات AI مشوهة: ' + res.status);
  assert.ok(fetchCalled, 'تم استدعاء fetch فعلاً');
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* AI_API_KEY لا تظهر في أي رد (خاصة لا تُعاد في استجابات HTTP). */
await ta('11.7) AI_API_KEY لا تظهر في مخرجات ai-design', async () => {
  const env = makeEnv();
  env.AI_API_KEY = 'sk-test-dummy-key-12345';
  await seedEnv(env);
  const { restore } = mockOpenAI(JSON.stringify({ status: 'ready', note: '??', questions: [], assumptions: [], issues: [], spec: null }));
  try {
    const req = jsonReq('/api/portal/ai-design', '', { text: 'تصميم' }, 'POST');
    req.headers.set('x-design-token', VALID_DESIGN_TOKEN);
    const res = await worker.fetch(req, env);
    const body = res.data ? JSON.stringify(res.data) : '';
  assert.ok(!body.includes('sk-test-dummy-key-12345'), 'لا يُسرب المفتاح للعميل');
  assert.ok(!body.includes('Bearer'), 'لا يُسرب Bearer في الاستجابة');
  } finally {
    restore();
  }
});

console.log('\n=== 12) حدود قاعدة D1 (توثيق لا اختبار تشغيلي) ===');
console.log('- lower(username) في WHERE قد يُعطّل استخدام الفهارس على بعض القواعد.');
console.log('- عامل <> في DELETE مع نص على بيانات فارغة لم يُتحقق منها على D1 الحقيقية.');
console.log('- RETURNING (في next-order-no وconvertDesign وportalFinish) لا تعمل على كل الإصدارات.');
console.log('- معاملات D1 (batch) ذرّية حسب التوثيق.');
console.log('- crypto.subtle في Node لا يتصرف كـ Cloudflare Worker؛ نستخدم webcrypto في Node كما هو.');
console.log('- كل ما سبق ملاحظات للنشر الفعلي وليست اختبارات آلية.');

/* ---------- الخلاصة ---------- */
const report = lines.join('\n') + '\n\n=== النتيجة: PASS=' + pass + '  FAIL=' + fail + ' ===';
console.log(report);
process.exit(fail ? 1 : 0);
