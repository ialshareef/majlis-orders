/* ربط رقم واتساب بالمستخدم (الهجرة 006: wa_recipient_users) — الخادم الحقيقي على SQLite مؤقتة:
   إضافة الرقم من نافذة المستخدم تُنشئ مستلماً مرتبطاً يُستخدم في الإرسال · التعديل/الاسم/التعطيل يتزامن ·
   التكرار يُرفض ذرّياً (لا يُحفظ المستخدم) · تبنّي مستلم قائم بالرقم نفسه · المسح والحذف يزيلان المستلم ·
   الصلاحيات: الرقم لا يظهر ولا يُحفظ بلا صلاحيات واتساب. لا اتصال بأي خدمة ولا بقاعدة الإنتاج.
   node test/wa-user-link.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from './_d1-sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(read('worker/worker.js') + '\n// wa-user-link', 'utf8').toString('base64'));
const worker = mod.default;

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const T0 = '2026-11-01T08:00:00.000Z';
const FUT = new Date(Date.now() + 86400000).toISOString();
const SCHEMA = read('worker/schema.sql');

function makeEnv() {
  const DB = new SqliteD1();
  DB.exec(SCHEMA);
  DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  const U = [['u-own', 'owner', 'المالك', 'admin'], ['u-st', 'st', 'موظف', 'staff'], ['u-mb', 'mb', 'مندوب', 'mandoub'], ['u-st2', 'st2', 'موظف ثان', 'staff'],
    ['u-ed', 'ed', 'مدير بلا واتساب', 'admin']];
  for (const [id, un, n, r] of U) {
    DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES (?,?,?,?,?,1,?)').run(id, un, n, 'x', r, T0);
    DB.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run('t-' + un, id, T0, FUT);
  }
  // مدير يدير المستخدمين لكن صلاحيات واتساب الثلاث ممنوعة عنه صراحة
  for (const p of ['users.view', 'users.edit']) DB.db.prepare('INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,1,?,?)').run('u-ed', p, 'u-own', T0);
  for (const p of ['notifications.whatsapp.view', 'notifications.whatsapp.manage', 'notifications.whatsapp.send']) DB.db.prepare('INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,0,?,?)').run('u-ed', p, 'u-own', T0);
  return { DB, OWNER_USER_ID: 'u-own', ALLOWED_ORIGIN: 'https://x.test' };
}
const call = async (env, method, p, token, body) => {
  const res = await worker.fetch(new Request('https://x.test' + p, {
    method, headers: { 'x-session-token': token || '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), env);
  let data = null; try { data = await res.json(); } catch (_) { /* */ }
  return { status: res.status, data };
};
const rows = (env, sql, ...a) => env.DB.db.prepare(sql).all(...a);
const one = (env, sql, ...a) => env.DB.db.prepare(sql).get(...a);
const save = (env, token, id, extra) => {
  const u = one(env, 'SELECT * FROM users WHERE id = ?', id);
  return call(env, 'POST', '/api/users', token, { id, name: u.name, username: u.username, role: u.role, active: !!u.active, ...extra });
};
const linkOf = (env, uid) => one(env, 'SELECT r.*, l.user_id FROM wa_recipient_users l JOIN wa_recipients r ON r.id = l.recipient_id WHERE l.user_id = ?', uid);
const evOf = (env, rid) => rows(env, 'SELECT event_type FROM wa_event_recipients WHERE recipient_id = ? ORDER BY event_type', rid).map((r) => r.event_type).join(',');

const env = makeEnv();

/* 1) الجدول */
{
  const t = rows(env, "SELECT name FROM sqlite_master WHERE type='table' AND name = 'wa_recipient_users'");
  ok(t.length === 1, 'schema: جدول الربط wa_recipient_users موجود في schema.sql');
  const m = read('worker/migrations/006_wa_recipient_users.sql');
  ok(/CREATE TABLE IF NOT EXISTS wa_recipient_users/.test(m) && !/ALTER TABLE|DROP|DELETE|UPDATE /i.test(m.replace(/--[^\n]*/g, '')), 'migration 006: جدول جديد فقط (لا تعديل ولا حذف لجداول قائمة) وقابلة للتكرار');
}

/* 2) إضافة رقم من نافذة المستخدم */
let rid;
{
  const r = await save(env, 't-owner', 'u-st', { wa: { phone: '0551234567', events: ['order_created', 'order_status'] } });
  ok(r.status === 200, 'save: المالك يضيف رقم واتساب للموظف', r);
  const L = linkOf(env, 'u-st');
  ok(L && L.phone === '966551234567' && L.name === 'موظف' && L.active === 1, 'save: مستلم مرتبط بالاسم والرقم الدولي', L);
  rid = L && L.id;
  ok(evOf(env, rid) === 'order_created,order_status', 'save: التنبيهات المختارة محفوظة', evOf(env, rid));
  const u = (r.data.users || []).find((x) => x.id === 'u-st');
  ok(u && u.wa && u.wa.phone === '966551234567' && u.wa.events.length === 2, 'list: قائمة المستخدمين تحمل الرقم المرتبط للمالك', u && u.wa);
  const st = await call(env, 'GET', '/api/wa', 't-owner');
  const rc = st.data.recipients.find((x) => x.id === rid);
  ok(rc && rc.user && rc.user.id === 'u-st' && rc.user.name === 'موظف', 'wa: المستلم يظهر في «المستلمين» مع المستخدم المرتبط', rc);
  ok(st.data.templates.order_created.recipients.includes(rid), 'wa: يُختار تلقائياً لتنبيه «طلب جديد»');
  const sd = await call(env, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', message: 'طلب جديد', recipientIds: [rid] });
  ok(sd.status === 200 && JSON.stringify(sd.data).includes('966551234567'), 'send: الرقم يُستخدم فعلاً عند إرسال التنبيه', sd.status);
}

/* 3) تعديل الرقم والتنبيهات — نفس المستلم */
{
  const r = await save(env, 't-owner', 'u-st', { wa: { phone: '+966 55 999 8877', events: ['payment_received'] } });
  const L = linkOf(env, 'u-st');
  ok(r.status === 200 && L.id === rid && L.phone === '966559998877', 'edit: تغيير الرقم يحدّث المستلم نفسه (لا تكرار)', L);
  ok(evOf(env, rid) === 'payment_received', 'edit: التنبيهات تُستبدل', evOf(env, rid));
  ok(one(env, 'SELECT COUNT(*) n FROM wa_recipients').n === 1, 'edit: مستلم واحد فقط');
}

/* 4) الاسم والتعطيل يتزامنان دون إرسال wa */
{
  await call(env, 'POST', '/api/users', 't-owner', { id: 'u-st', name: 'موظف المبيعات', username: 'st', role: 'staff', active: true });
  ok(linkOf(env, 'u-st').name === 'موظف المبيعات' && linkOf(env, 'u-st').phone === '966559998877', 'sync: تغيير اسم المستخدم يغيّر اسم المستلم ويبقي الرقم');
  await call(env, 'POST', '/api/users', 't-owner', { id: 'u-st', name: 'موظف المبيعات', username: 'st', role: 'staff', active: false });
  ok(linkOf(env, 'u-st').active === 0, 'sync: إيقاف الحساب يعطّل تنبيهاته');
  const r = await save(env, 't-owner', 'u-st', { active: true, wa: { phone: '0559998877', events: ['payment_received'] } });
  ok(r.status === 200 && linkOf(env, 'u-st').active === 1, 'sync: إعادة التفعيل مع الحفظ من النافذة تفعّل التنبيهات');
}

/* 5) التكرار مع مستخدم آخر: رفض ذرّي */
{
  const r = await call(env, 'POST', '/api/users', 't-owner', { id: 'u-st2', name: 'اسم جديد', username: 'st2', role: 'staff', active: true, wa: { phone: '0559998877', events: [] } });
  ok(r.status === 409 && /مسجّل لمستخدم آخر/.test(r.data.error || ''), 'dup: رقم مستخدم آخر ← 409 برسالة واضحة', r);
  ok(one(env, 'SELECT name FROM users WHERE id = ?', 'u-st2').name === 'موظف ثان', 'dup: لم يُحفظ أي تعديل على المستخدم (ذرّي)');
  ok(!linkOf(env, 'u-st2'), 'dup: لا ربط للمستخدم الثاني');
}

/* 6) تبنّي مستلم قائم بالرقم نفسه */
{
  const add = await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'أبو محمد', phone: '0501112222', events: ['expense_created'] });
  ok(add.status === 200, 'adopt: مستلم يدوي قائم', add);
  const before = one(env, 'SELECT COUNT(*) n FROM wa_recipients').n;
  const r = await save(env, 't-owner', 'u-st2', { wa: { phone: '0501112222', events: ['order_created'] } });
  const L = linkOf(env, 'u-st2');
  ok(r.status === 200 && L && L.id === add.data.recipient.id && L.name === 'موظف ثان', 'adopt: الرقم نفسه يربط المستلم القائم بالمستخدم بدل إنشاء مكرر', L);
  ok(one(env, 'SELECT COUNT(*) n FROM wa_recipients').n === before, 'adopt: عدد المستلمين لم يتغير');
}

/* 7) رقم غير صالح / تنبيهات بلا رقم */
{
  const r = await call(env, 'POST', '/api/users', 't-owner', { id: 'u-mb', name: 'مندوب معدّل', username: 'mb', role: 'mandoub', active: true, wa: { phone: '12345', events: [] } });
  ok(r.status === 400 && /رقم واتساب/.test(r.data.error || ''), 'invalid: رقم غير صحيح ← 400', r);
  ok(one(env, 'SELECT name FROM users WHERE id = ?', 'u-mb').name === 'مندوب', 'invalid: المستخدم لم يُحفظ');
  const r2 = await call(env, 'POST', '/api/users', 't-owner', { id: 'u-mb', name: 'مندوب', username: 'mb', role: 'mandoub', active: true, wa: { phone: '0503334444', events: ['bogus'] } });
  ok(r2.status === 400, 'invalid: نوع تنبيه مجهول ← 400', r2.status);
}

/* 8) الصلاحيات */
{
  const r = await call(env, 'GET', '/api/users', 't-ed');
  ok(r.status === 200 && r.data.users.every((u) => !('wa' in u)), 'perm: مدير ممنوع من واتساب لا يرى الأرقام في قائمة المستخدمين', r.data.users && r.data.users[0]);
  const s = await call(env, 'POST', '/api/users', 't-ed', { id: 'u-mb', name: 'مندوب', username: 'mb', role: 'mandoub', active: true, wa: { phone: '0507778888', events: ['order_created'] } });
  ok(s.status === 200 && !linkOf(env, 'u-mb'), 'perm: حقل الرقم يُتجاهَل بلا notifications.whatsapp.manage (لا يُضاف مستلم)', s);
  const m = await call(env, 'GET', '/api/users', 't-mb');
  ok(m.status === 403, 'perm: المندوب لا يرى قائمة المستخدمين', m.status);
}

/* 9) مستخدم جديد مع رقم */
{
  const r = await call(env, 'POST', '/api/users', 't-owner', { name: 'جديد', username: 'newu', password: 'Najd#2026x', role: 'staff', active: true, wa: { phone: '0566667777', events: ['order_status'] } });
  const id = one(env, "SELECT id FROM users WHERE username = 'newu'").id;
  const L = linkOf(env, id);
  ok(r.status === 200 && L && L.phone === '966566667777' && evOf(env, L.id) === 'order_status', 'new: إنشاء مستخدم مع رقم يضيفه للمستلمين', r.status);
}

/* 10) مسح الرقم يزيل المستلم، وحذف المستخدم يزيل مستلمه */
{
  const L = linkOf(env, 'u-st');
  const r = await save(env, 't-owner', 'u-st', { wa: { phone: '', events: [] } });
  ok(r.status === 200 && !linkOf(env, 'u-st') && !one(env, 'SELECT id FROM wa_recipients WHERE id = ?', L.id) && evOf(env, L.id) === '', 'clear: مسح الرقم يحذف المستلم وتنبيهاته وربطه');
  const L2 = linkOf(env, 'u-st2');
  const d = await call(env, 'DELETE', '/api/users/u-st2', 't-owner');
  ok(d.status === 200 && !one(env, 'SELECT id FROM wa_recipients WHERE id = ?', L2.id) && !one(env, "SELECT * FROM wa_recipient_users WHERE user_id = 'u-st2'"), 'delete: حذف المستخدم يحذف مستلمه المرتبط', d.status);
  // حذف المستلم من «إشعارات واتساب» يزيل الربط أيضاً
  const id = one(env, "SELECT id FROM users WHERE username = 'newu'").id;
  const L3 = linkOf(env, id);
  const dr = await call(env, 'DELETE', '/api/wa/recipients/' + L3.id, 't-owner');
  ok(dr.status === 200 && !one(env, 'SELECT * FROM wa_recipient_users WHERE recipient_id = ?', L3.id), 'delete: حذف المستلم يزيل ربطه بالمستخدم', dr.status);
  ok(one(env, 'PRAGMA integrity_check').integrity_check === 'ok', 'db: سلامة القاعدة');
}

/* 11) الحد الأقصى 20: لا يُحفظ المستخدم */
{
  const E = makeEnv();
  for (let i = 0; i < 20; i++) E.DB.db.prepare('INSERT INTO wa_recipients (id, name, phone, active, created_at, updated_at) VALUES (?,?,?,1,?,?)').run('r' + i, 'n' + i, '9665000000' + String(i).padStart(2, '0'), T0, T0);
  const r = await call(E, 'POST', '/api/users', 't-owner', { id: 'u-mb', name: 'مندوب ممتلئ', username: 'mb', role: 'mandoub', active: true, wa: { phone: '0509990000', events: [] } });
  ok(r.status === 400 && /الحد الأقصى/.test(r.data.error || ''), 'limit: القائمة ممتلئة ← 400 برسالة واضحة', r);
  ok(one(E, 'SELECT name FROM users WHERE id = ?', 'u-mb').name === 'مندوب', 'limit: المستخدم لم يُحفظ');
}

/* 12) قاعدة قديمة بلا جدول الربط: الخدمة لا تتعطل */
{
  const E = makeEnv();
  E.DB.exec('DROP TABLE wa_recipient_users');
  const st = await call(E, 'GET', '/api/wa', 't-owner');
  ok(st.status === 200 && Array.isArray(st.data.recipients), 'compat: «إشعارات واتساب» تعمل قبل إنشاء جدول الربط', st.status);
  const us = await call(E, 'GET', '/api/users', 't-owner');
  ok(us.status === 200, 'compat: قائمة المستخدمين تعمل قبل إنشاء جدول الربط', us.status);
}

console.log(`\n=== wa-user-link: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
