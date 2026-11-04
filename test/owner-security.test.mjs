/* أمن مالك النظام الثابت (OWNER_USER_ID) على الخادم الحقيقي بقاعدة D1 وهمية:
   المالك وحده يدير المديرين والصلاحيات المحمية، والمدير العادي لا يلتفّ على القيود بأي مسار
   (إنشاء حساب بديل، تغيير الدور، كلمة المرور، صفوف الصلاحيات، المزامنة، إعادة الدخول)،
   مع استرداد حساب المالك، وقفل نسب العمولة، وصلاحيات التصاميم الأربع لكل دور.
   الاستخدام: node test/owner-security.test.mjs */
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

/* ---------- 1–7: المالك مقابل المدير العادي ---------- */
await ta('1) المالك ينشئ مديراً جديداً: نجاح، والمدير الجديد مدير عادي بلا الإدارة الكاملة', async () => {
  const env = mk();
  const r = await call(env, '/api/users', '1', newUser('admin', { username: 'newadmin' }));
  assert.strictEqual(r.s, 200);
  const nu = env.DB.tables.get('users').find((u) => u.username === 'newadmin');
  assert.strictEqual(nu.role, 'admin');
  env.DB.tables.get('sessions').push({ token: 'tok-new', user_id: nu.id, created_at: past, expires_at: future });
  const p = await perms(env, 'tok-new');
  assert.ok(!ADMIN_ONLY.some((x) => p.includes(x)), JSON.stringify(p.filter((x) => ADMIN_ONLY.includes(x))));
});
await ta('2) المدير العادي ينشئ مديراً: 403', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/users', '5', newUser('admin'))).s, 403);
  assert.strictEqual(env.DB.tables.get('users').filter((u) => u.role === 'admin').length, 3);
});
await ta('3) المدير العادي يرقّي موظفاً أو مندوباً إلى مدير: 403', async () => {
  const env = mk([...[['5', 'users.edit', 1]]].length ? { grants: [['5', 'users.edit', 1]] } : {});
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '2', { role: 'admin' }))).s, 403);
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '3', { role: 'admin' }))).s, 403);
  assert.strictEqual(userRow(env, '2').role, 'staff');
});
await ta('4) المدير العادي يغيّر كلمة مرور مدير آخر أو المالك: 403 (ولو مُنح users.edit من المالك)', async () => {
  const env = mk({ grants: [['5', 'users.edit', 1]] });
  const before = userRow(env, '6').password_hash;
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '6', { password: 'Other!Pass2026' }))).s, 403);
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '1', { password: 'Other!Pass2026' }))).s, 403);
  assert.strictEqual(userRow(env, '6').password_hash, before);
});
await ta('5) المدير العادي يحذف مديراً آخر أو المالك: رفض (ولو مُنح users.disable)', async () => {
  const env = mk({ grants: [['5', 'users.disable', 1]] });
  assert.strictEqual((await call(env, '/api/users/6', '5', null, 'DELETE')).s, 403);
  assert.ok([400, 403].includes((await call(env, '/api/users/1', '5', null, 'DELETE')).s));
  assert.ok(userRow(env, '6') && userRow(env, '1'));
});
await ta('6) المدير العادي يخفّض المالك إلى موظف: 403', async () => {
  const env = mk({ grants: [['5', 'users.edit', 1]] });
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '1', { role: 'staff' }))).s, 403);
  assert.strictEqual(userRow(env, '1').role, 'admin');
});
await ta('7) المدير العادي يعطّل المالك: 403', async () => {
  const env = mk({ grants: [['5', 'users.edit', 1]] });
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '1', { active: false }))).s, 403);
  assert.strictEqual(userRow(env, '1').active, 1);
});

/* ---------- 8–9: منح الإدارة الكاملة للنفس ---------- */
await ta('8) المدير العادي يمنح نفسه admin.core: رفض', async () => {
  const env = mk({ grants: [['5', 'permissions.manage', 1]] });
  assert.ok([400, 403].includes((await call(env, '/api/users/5/permissions', '5', { overrides: { 'admin.core': 1 } })).s));
  assert.ok(!(await perms(env, '5')).includes('admin.core'));
});
await ta('9) المدير العادي يمنح نفسه أو غيره permissions.manage: رفض', async () => {
  const env = mk({ grants: [['5', 'permissions.manage', 1]] });
  assert.strictEqual((await call(env, '/api/users/5/permissions', '5', { overrides: { 'permissions.manage': 1 } })).s, 403, 'نفسه');
  assert.strictEqual((await call(env, '/api/users/6/permissions', '5', { overrides: { 'permissions.manage': 1 } })).s, 403, 'مدير آخر');
  assert.strictEqual((await call(env, '/api/users/2/permissions', '5', { overrides: { 'permissions.manage': 1 } })).s, 403, 'موظف');
  assert.ok(!(await perms(env, '6')).includes('permissions.manage'));
});

/* ---------- 10–11: الموظف والمندوب ---------- */
await ta('10) الموظف يحاول ترقية نفسه: 403 (ولو بصفوف منح مزوّرة موقّعة باسم المالك)', async () => {
  const env = mk({ grants: ADMIN_ONLY.map((p) => ['2', p, 1, '1']) });
  assert.strictEqual((await call(env, '/api/users', '2', editUser(env, '2', { role: 'admin' }))).s, 403);
  assert.strictEqual((await call(env, '/api/users/2/permissions', '2', { overrides: { 'users.edit': 1 } })).s, 403);
  assert.ok(!(await perms(env, '2')).some((p) => ADMIN_ONLY.includes(p)));
});
await ta('11) المندوب يحاول ترقية نفسه: 403', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/users', '3', editUser(env, '3', { role: 'admin' }))).s, 403);
  assert.strictEqual(userRow(env, '3').role, 'mandoub');
});

/* ---------- 12: الالتفاف بحساب بديل ---------- */
await ta('12) مدير عادي ممنوح users.create من المالك لا ينشئ مديراً بديلاً، وينشئ موظفاً بلا صلاحيات إدارية', async () => {
  const env = mk({ grants: [['5', 'users.create', 1]] });
  assert.strictEqual((await call(env, '/api/users', '5', newUser('admin', { username: 'puppet' }))).s, 403);
  const r = await call(env, '/api/users', '5', newUser('staff', { username: 'helper' }));
  assert.strictEqual(r.s, 200);
  assert.ok(!env.DB.tables.get('users').some((u) => u.username === 'puppet'));
});
await ta('12ب) سحب permissions.manage من مدير عادي ثم محاولة حساب بديل: مغلق', async () => {
  const env = mk({ grants: [['5', 'permissions.manage', 0]] });
  assert.strictEqual((await call(env, '/api/users/2/permissions', '5')).s, 403);
  assert.strictEqual((await call(env, '/api/users', '5', newUser('admin', { username: 'puppet2' }))).s, 403);
});

/* ---------- 13: هوية المالك لا تُغيَّر من API ---------- */
await ta('13) معرّف المالك لا يتغير عبر API: إعادة التسمية أو إرسال isOwner/OWNER_USER_ID أو ترويسات لا تنقل الملكية', async () => {
  const env = mk({ grants: [['5', 'users.edit', 1]] });
  assert.strictEqual((await call(env, '/api/users', '1', editUser(env, '1', { username: 'owner_renamed', name: 'المالك' }))).s, 200);
  assert.ok((await perms(env, '1')).includes('admin.core'), 'المالك يبقى مالكاً بعد إعادة التسمية');
  await call(env, '/api/users', '5', editUser(env, '2', { isOwner: true, OWNER_USER_ID: '5', ownerId: '5' }));
  await call(env, '/api/sync', '5', { settings: { OWNER_USER_ID: '5', ownerUserId: '5' } });
  const viaHeader = await call(env, '/api/bootstrap', '5', null, 'GET', { 'x-owner-user-id': '5', 'OWNER_USER_ID': '5' });
  assert.ok(!(viaHeader.d.permissions || []).includes('admin.core'), 'admin2 ليس مالكاً');
  assert.strictEqual(viaHeader.d.user.isOwner, false);
  assert.strictEqual((await call(env, '/api/bootstrap', '1')).d.user.isOwner, true);
});
await ta('13ب) المالك لا يخفّض دوره ولا يعطّل نفسه، ولا يُحذف', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/users', '1', editUser(env, '1', { role: 'staff' }))).s, 400);
  assert.strictEqual((await call(env, '/api/users', '1', editUser(env, '1', { active: false }))).s, 400);
  assert.strictEqual((await call(env, '/api/users/1', '1', null, 'DELETE')).s, 400);
  assert.strictEqual((await call(env, '/api/users/1/permissions', '1', { overrides: { 'orders.view_all': 0 } })).s, 400, 'صلاحيات المالك ثابتة');
});

/* ---------- 14: صفوف الصلاحيات المزوّرة ---------- */
await ta('14) صف منح لا يوقّعه المالك لا يعطي مديراً عادياً شيئاً؛ والموقّع من المالك يعطيه', async () => {
  let env = mk({ grants: [['5', 'permissions.manage', 1, '5'], ['5', 'users.edit', 1, '6'], ['5', 'settings.manage', 1, null]] });
  assert.ok(!(await perms(env, '5')).some((p) => ADMIN_ONLY.includes(p)), 'توقيع غير المالك يُهمل');
  env = mk({ grants: [['5', 'permissions.manage', 1, '1']] });
  assert.ok((await perms(env, '5')).includes('permissions.manage'), 'منح موقّع من المالك يعمل');
  env = mk({ grants: [['5', 'admin.core', 1, '1']] });
  assert.ok(!(await perms(env, '5')).includes('admin.core'), 'admin.core لا تُمنح ولو بتوقيع المالك');
});
await ta('14ب) تغيير المالك في البيئة يُبطل منح المالك السابق تلقائياً', async () => {
  const env = mk({ grants: [['5', 'permissions.manage', 1, '1']], owner: '6' });
  assert.ok(!(await perms(env, '5')).includes('permissions.manage'));
});

/* ---------- 15: إعادة الدخول ---------- */
await ta('15) إعادة تسجيل الدخول بجلسة جديدة لا تتجاوز المنع', async () => {
  const env = mk({ grants: [['5', 'permissions.manage', 0]] });
  const l = await call(env, '/api/login', null, { username: 'admin2', password: PW });
  assert.ok(l.d && l.d.token, JSON.stringify(l.d));
  assert.strictEqual((await call(env, '/api/users/2/permissions', l.d.token)).s, 403);
  assert.strictEqual((await call(env, '/api/users', l.d.token, newUser('admin'))).s, 403);
  assert.ok(!(await perms(env, l.d.token)).some((p) => ADMIN_ONLY.includes(p)));
});

/* ---------- 16: صلاحيات التصاميم الأربع لكل دور ---------- */
await ta('16) التصاميم: كل صلاحية مستقلة لكل دور (عرض/تعديل/تحويل/حذف)', async () => {
  const ops = {
    'designs.view': (env, u) => call(env, '/api/designs', u),
    'designs.edit': (env, u) => call(env, '/api/designs/d1', u, { status: 'reviewing' }, 'PUT'),
    'designs.convert': (env, u) => call(env, '/api/designs/d1/convert', u, null, 'POST'),
    'designs.delete': (env, u) => call(env, '/api/designs/d1', u, null, 'DELETE'),
  };
  const expected = { '1': [1, 1, 1, 1], '5': [1, 1, 1, 1], '2': [1, 0, 0, 0], '3': [0, 0, 0, 0] };
  for (const [u, exp] of Object.entries(expected)) {
    const got = [];
    for (const op of Object.values(ops)) got.push((await op(mk(), u)).s === 403 ? 0 : 1);
    assert.deepStrictEqual(got, exp, 'user ' + u + ' ' + JSON.stringify(got));
  }
  for (const p of Object.keys(ops)) {
    const env = mk({ grants: [['2', p, 1], ...(p === 'designs.view' ? [] : [['2', 'designs.view', 0]])] });
    const got = []; for (const op of Object.values(ops)) got.push((await op(env, '2')).s === 403 ? 0 : 1);
    const want = Object.keys(ops).map((k) => (k === p ? 1 : 0));
    assert.deepStrictEqual(got, want, 'staff granted only ' + p + ' ' + JSON.stringify(got));
  }
  const envM = mk({ grants: [['3', 'designs.convert', 1]] });
  assert.notStrictEqual((await ops['designs.convert'](envM, '3')).s, 403, 'المندوب الممنوح التحويل وحده');
  assert.strictEqual((await ops['designs.view'](envM, '3')).s, 403);
});

/* ---------- 17: كل مسارات تغيير الدور ---------- */
await ta('17) كل مسارات تغيير الدور: المستخدمون (إنشاء/تعديل/مناديب)، الصلاحيات، المزامنة، كلمة المرور، الحذف', async () => {
  const env = mk({ grants: [['5', 'users.edit', 1], ['5', 'users.create', 1], ['5', 'users.disable', 1], ['5', 'permissions.manage', 1]] });
  // شاشة المناديب تستخدم نفس المسار: ترقية مندوب إلى مدير مرفوضة
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '7', { role: 'admin', parentId: '3' }))).s, 403);
  // تعديل موظف مسموح لكن دون تغيير نسب العمولة أو شجرة المناديب
  assert.strictEqual((await call(env, '/api/users', '5', editUser(env, '7', { name: 'renamed', rate: 99, parentRate: 50, parentId: null }))).s, 200);
  assert.strictEqual(Number(userRow(env, '7').rate), 6); assert.strictEqual(String(userRow(env, '7').parent_id), '3');
  // الصلاحيات لا تغيّر الدور
  const r = await call(env, '/api/users/2/permissions', '5', { overrides: { role: 'admin' } });
  assert.strictEqual(r.s, 400); assert.strictEqual(userRow(env, '2').role, 'staff');
  // المزامنة لا تكتب في المستخدمين
  await call(env, '/api/sync', '5', { users: { upsert: [{ id: '2', role: 'admin' }] }, settings: { users: [{ id: '2', role: 'admin' }] } });
  assert.strictEqual(userRow(env, '2').role, 'staff');
  // تغيير كلمة المرور الذاتي لا يغيّر الدور
  await call(env, '/api/change-password', '2', { currentPassword: PW, newPassword: 'Brand!New2026', role: 'admin' });
  assert.strictEqual(userRow(env, '2').role, 'staff');
  // الحذف: موظف مسموح بـ users.disable، مدير لا
  assert.strictEqual((await call(env, '/api/users/4', '5', null, 'DELETE')).s, 200);
  assert.strictEqual((await call(env, '/api/users/6', '5', null, 'DELETE')).s, 403);
});

/* ---------- حدود المدير العادي الممنوح ---------- */
await ta('مدير عادي ممنوح permissions.manage: يدير الموظفين تشغيلياً فقط، لا المديرين ولا الصلاحيات المحمية', async () => {
  const env = mk({ grants: [['5', 'permissions.manage', 1]] });
  assert.strictEqual((await call(env, '/api/users/2/permissions', '5', { overrides: { 'orders.view_all': 1 } })).s, 200);
  assert.strictEqual((await call(env, '/api/users/6/permissions', '5')).s, 403, 'قراءة صلاحيات مدير');
  assert.strictEqual((await call(env, '/api/users/6/permissions', '5', { overrides: {} })).s, 403);
  assert.strictEqual((await call(env, '/api/users/6/permissions', '5', {}, 'DELETE')).s, 403);
  assert.strictEqual((await call(env, '/api/users/1/permissions', '5', { overrides: {} })).s, 400, 'المالك ثابت');
  assert.strictEqual((await call(env, '/api/users/2/permissions', '5', { overrides: { 'settings.manage': 0 } })).s, 403, 'حتى سحب صلاحية محمية');
});
await ta('المالك يمنح مديراً عادياً صلاحية محمية ويسحبها، ولا يمنحها لموظف', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/users/5/permissions', '1', { overrides: { 'settings.manage': 1 } })).s, 200);
  assert.ok((await perms(env, '5')).includes('settings.manage'));
  assert.strictEqual((await call(env, '/api/sync', '5', { settings: { shopName: 'x' } })).s, 200);
  assert.strictEqual((await call(env, '/api/users/5/permissions', '1', {}, 'DELETE')).s, 200);
  assert.ok(!(await perms(env, '5')).includes('settings.manage'));
  assert.strictEqual((await call(env, '/api/users/2/permissions', '1', { overrides: { 'settings.manage': 1 } })).s, 400);
});

/* ---------- الفشل المُغلق ---------- */
await ta('بلا OWNER_USER_ID: لا مالك — لا أحد يملك الإدارة الكاملة أو ينشئ مديراً', async () => {
  const env = mk({ owner: null });
  assert.ok(!(await perms(env, '1')).some((p) => ADMIN_ONLY.includes(p)));
  assert.strictEqual((await call(env, '/api/users', '1', newUser('admin'))).s, 403);
  assert.strictEqual((await call(env, '/api/owner-analytics', '1')).s, 403);
  assert.strictEqual((await call(env, '/api/bootstrap', '1')).d.owner.configured, false);
});
await ta('OWNER_USER_ID يشير إلى موظف أو مستخدم غير موجود: لا مالك', async () => {
  for (const o of ['2', 'ghost', '  ']) {
    const env = mk({ owner: o });
    assert.ok(!(await perms(env, '1')).includes('admin.core'), o);
    assert.ok(!(await perms(env, '2')).includes('admin.core'), o);
  }
});
await ta('مالك موقوف (بتلاعب مباشر في القاعدة) لا يدخل ولا يملك شيئاً', async () => {
  const env = mk(); userRow(env, '1').active = 0;
  assert.strictEqual((await call(env, '/api/bootstrap', '1')).s, 401);
});

/* ---------- استرداد حساب المالك ---------- */
const CODE = 'recovery-code-2026-abcdef';
await ta('recover: مغلق (404) بلا سرّ أو بسرّ قصير أو بلا مالك', async () => {
  assert.strictEqual((await call(mk(), '/api/owner/recover', null, { code: CODE, newPassword: 'New!Owner2026' })).s, 404);
  let env = mk(); env.OWNER_RECOVERY_CODE = 'short';
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: 'short', newPassword: 'New!Owner2026' })).s, 404);
  env = mk({ owner: null }); env.OWNER_RECOVERY_CODE = CODE;
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: CODE, newPassword: 'New!Owner2026' })).s, 404);
});
await ta('recover: رمز خاطئ 403، وصحيح يعيد كلمة مرور المالك وحده وينهي جلساته، ولا يُعاد استخدامه', async () => {
  const env = mk(); env.OWNER_RECOVERY_CODE = CODE;
  const before6 = userRow(env, '6').password_hash;
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: 'wrong-code-0000000000', newPassword: 'New!Owner2026' })).s, 403);
  const ok = await call(env, '/api/owner/recover', null, { code: CODE, newPassword: 'New!Owner2026' });
  assert.strictEqual(ok.s, 200, JSON.stringify(ok.d));
  assert.ok(!env.DB.tables.get('sessions').some((s) => s.user_id === '1'), 'جلسات المالك أُنهيت');
  assert.strictEqual(userRow(env, '6').password_hash, before6, 'لا يمس غير المالك');
  const l = await call(env, '/api/login', null, { username: 'owner', password: 'New!Owner2026' });
  assert.ok(l.d && l.d.token, 'المالك يدخل بكلمة المرور الجديدة');
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: CODE, newPassword: 'Again!Owner2026' })).s, 410, 'الرمز لمرة واحدة');
});
await ta('recover: يعيد تفعيل المالك ودوره مديراً، ويرفض كلمة مرور ضعيفة', async () => {
  const env = mk(); env.OWNER_RECOVERY_CODE = CODE; userRow(env, '1').active = 0; userRow(env, '1').role = 'staff';
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: CODE, newPassword: '123' })).s, 400);
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: CODE, newPassword: 'New!Owner2026' })).s, 200);
  assert.strictEqual(userRow(env, '1').active, 1); assert.strictEqual(userRow(env, '1').role, 'admin');
});
await ta('recover: المحاولات الخاطئة المتكررة تُقفل (429)', async () => {
  const env = mk(); env.OWNER_RECOVERY_CODE = CODE;
  let last = 0;
  for (let i = 0; i < 7; i++) last = (await call(env, '/api/owner/recover', null, { code: 'nope-nope-nope-nope', newPassword: 'New!Owner2026' })).s;
  assert.strictEqual(last, 429);
  assert.strictEqual((await call(env, '/api/owner/recover', null, { code: CODE, newPassword: 'New!Owner2026' })).s, 429, 'حتى الرمز الصحيح أثناء القفل');
});

/* ---------- نسب العمولة في الطلب ---------- */
// رقم صريح: D1 الوهمية لا تدعم UPDATE … RETURNING لعدّاد الأرقام (كبقية اختبارات المزامنة)
let orderNo = 2000;
const order = (id, by, extra = {}) => Object.assign({ id, number: ++orderNo, status: 'new', customer: { name: 'C' }, createdBy: by, subtotal: 1000, total: 1150, paid: 0, payments: [] }, extra);
const stored = (env, id) => JSON.parse(env.DB.tables.get('orders').find((o) => o.id === id).data);
await ta('commRates: الموظف لا يحدد نسبته — الخادم يحسب اللقطة من الإعدادات', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/sync', '2', { orders: { upsert: [order('n1', '2', { sellerRate: 90, shareRate: 0, commRates: { ownerRate: 100, parentId: null, parentRate: null, shareRate: 0 } })] } })).s, 200);
  const o = stored(env, 'n1');
  assert.deepStrictEqual(o.commRates, { ownerRate: 2, parentId: null, parentRate: null, shareRate: 4 });
  assert.strictEqual(o.sellerRate, undefined);
});
await ta('commRates: المندوب — نسبته ونسبة مندوبه الأعلى من القاعدة لا من الطلب', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/sync', '7', { orders: { upsert: [order('n2', '7', { mandoubRate: 100, commRates: { ownerRate: 100, parentId: null, parentRate: 0, shareRate: 0 } })] } })).s, 200);
  assert.deepStrictEqual(stored(env, 'n2').commRates, { ownerRate: 6, parentId: '3', parentRate: 2, shareRate: 4 });
});
await ta('commRates: تعديل طلب قائم لا يغيّر لقطته المخزّنة', async () => {
  const env = mk();
  await call(env, '/api/sync', '2', { orders: { upsert: [order('n3', '2')] } });
  const first = stored(env, 'n3');
  const again = Object.assign({}, first, { notes: 'x', commRates: { ownerRate: 77, parentId: null, parentRate: null, shareRate: 0 }, sellerRate: 77 });
  assert.strictEqual((await call(env, '/api/sync', '2', { orders: { upsert: [again] } })).s, 200);
  assert.deepStrictEqual(stored(env, 'n3').commRates, first.commRates);
  assert.strictEqual(stored(env, 'n3').sellerRate, undefined);
});
await ta('commRates: المدير العادي لا يغيّرها، والمالك يستطيع', async () => {
  const env = mk();
  await call(env, '/api/sync', '1', { orders: { upsert: [order('n4', '2', { commRates: { ownerRate: 10, parentId: null, parentRate: null, shareRate: 3 } })] } });
  assert.strictEqual(stored(env, 'n4').commRates.ownerRate, 10, 'المالك يحدد');
  const o = Object.assign({}, stored(env, 'n4'), { commRates: { ownerRate: 50, parentId: null, parentRate: null, shareRate: 0 } });
  await call(env, '/api/sync', '5', { orders: { upsert: [o] } });
  assert.strictEqual(stored(env, 'n4').commRates.ownerRate, 10, 'المدير العادي لا يغيّر');
});
await ta('sync: المدير العادي لا ينسب طلباً جديداً لغيره (403 ولا يُحفظ)؛ والمالك يستطيع', async () => {
  const env = mk();
  assert.strictEqual((await call(env, '/api/sync', '5', { orders: { upsert: [order('n5', '2')] } })).s, 403);
  assert.ok(!env.DB.tables.get('orders').some((o) => o.id === 'n5'));
  assert.strictEqual((await call(env, '/api/sync', '5', { orders: { upsert: [order('n5b', '5')] } })).s, 200, 'باسمه مسموح');
  await call(env, '/api/sync', '1', { orders: { upsert: [order('n6', '2')] } });
  assert.strictEqual(String(stored(env, 'n6').createdBy), '2');
});

/* ---------- ما يصل الواجهة ---------- */
await ta('bootstrap: السجل ونسب العمولة للمالك فقط؛ والمدير العادي يرى المستخدمين بلا نسب', async () => {
  const env = mk();
  const o = await call(env, '/api/bootstrap', '1'), a = await call(env, '/api/bootstrap', '5');
  assert.ok(Array.isArray(o.d.activity)); assert.strictEqual(a.d.activity, undefined);
  assert.ok(o.d.users.some((u) => u.rate === 7)); assert.ok(a.d.users.every((u) => u.rate === null));
  assert.ok(o.d.users.find((u) => u.id === '1').isOwner && !a.d.users.find((u) => u.id === '5').isOwner);
  assert.strictEqual(a.d.owner.configured, true);
  assert.strictEqual((await call(env, '/api/bootstrap', '2')).d.owner, undefined, 'الموظف لا يرى حالة المالك');
});

console.log(`\n=== owner-security: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
