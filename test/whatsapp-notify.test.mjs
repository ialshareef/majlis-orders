/* إشعارات واتساب اليدوية (wa.me) — اختبار الخادم الحقيقي (worker/worker.js) على SQLite حقيقية مؤقتة:
   الهجرة 005 · المستلمون (20 حداً، التكرار، الأرقام) · اختيار المستلمين لكل حدث · الأحداث الأربعة
   من الحفظ الفعلي فقط (لا تنبيه عند الفشل ولا تكرار عند إعادة المحاولة) · ترميز العربية والروابط ·
   جلسة الإرسال (التقدم، التخطي، الإيقاف، التأكيد اليدوي فقط) · فرض الصلاحيات في الخادم.
   لا اتصال بأي خدمة ولا بقاعدة الإنتاج. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SqliteD1 } from './_d1-sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const workerSrc = read('worker/worker.js');
const mod = await import('data:text/javascript;base64,' + Buffer.from(workerSrc, 'utf8').toString('base64'));
const worker = mod.default;
const { waNormalizePhone, waLink, waRender, WA_DEFAULT_TEMPLATES, hasPerm, ROLE_PERMISSIONS } = mod;

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); } };

const SCHEMA = read('worker/schema.sql');
const M005 = read('worker/migrations/005_whatsapp_notifications.sql');
const T0 = '2026-11-01T08:00:00.000Z';
const FUT = new Date(Date.now() + 86400000).toISOString();

/* ---------------- 1) الهجرة 005 على نسخة من قاعدة الإنتاج الحالية (مخطط HEAD) ---------------- */
{
  let head = null;
  try { head = execFileSync('git', ['show', 'HEAD:worker/schema.sql'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { /* لا git */ }
  const d = new SqliteD1();
  d.exec(head && !/wa_recipients/.test(head) ? head : SCHEMA.split('-- إشعارات واتساب اليدوية (الهجرة 005)')[0]);
  d.exec("INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES ('u1','a','A','x','admin',1,'t')");
  d.exec("INSERT INTO orders (id, number, status, customer_name, created_by, created_at, data, updated_at) VALUES ('o1',1001,'new','ع','u1','t','{}','t')");
  const before = JSON.stringify(d.db.prepare('SELECT * FROM orders').all()) + JSON.stringify(d.db.prepare('SELECT * FROM users').all());
  let err = null; try { d.exec(M005); } catch (e) { err = e.message; }
  ok(err === null, 'migration: 005 تُطبَّق على قاعدة قائمة (مخطط HEAD) بلا خطأ', err);
  let err2 = null; try { d.exec(M005); } catch (e) { err2 = e.message; }
  ok(err2 === null, 'migration: إعادة تشغيل 005 آمنة (idempotent)', err2);
  const tables = d.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wa_%' ORDER BY name").all().map((r) => r.name);
  ok(tables.join() === 'wa_event_recipients,wa_events,wa_log,wa_recipients,wa_sends,wa_templates', 'migration: الجداول الستة موجودة', tables);
  ok(before === JSON.stringify(d.db.prepare('SELECT * FROM orders').all()) + JSON.stringify(d.db.prepare('SELECT * FROM users').all()), 'migration: البيانات القائمة لم تُمس');
  // القيود على مستوى القاعدة
  const ins = (i, ph) => { try { d.exec(`INSERT INTO wa_recipients (id, name, phone, active, created_at, updated_at) VALUES ('r${i}','n${i}','${ph}',1,'t','t')`); return null; } catch (e) { return e.message; } };
  for (let i = 1; i <= 20; i++) ins(i, '9665000000' + String(i).padStart(2, '0'));
  ok(/limit 20/.test(ins(21, '966500000099') || ''), 'migration: مشغّل القاعدة يرفض المستلم 21');
  d.exec("DELETE FROM wa_recipients WHERE id = 'r20'");
  ok(/UNIQUE/.test(ins(22, '966500000001') || ''), 'migration: UNIQUE يمنع تكرار الرقم في القاعدة');
  ok(/CHECK/.test((() => { try { d.exec("INSERT INTO wa_log (id, send_id, seq, recipient_name, phone, status, updated_at, created_at) VALUES ('l','s',1,'n','1','delivered','t','t')"); } catch (e) { return e.message; } return ''; })()), 'migration: حالة «delivered» غير موجودة أصلاً في السجل (CHECK)');
  ok(d.db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'migration: سلامة القاعدة');
}

/* ---------------- بيئة الخادم ---------------- */
function makeEnv() {
  const DB = new SqliteD1();
  DB.exec(SCHEMA);
  DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  const U = [['u-own', 'owner', 'المالك', 'admin'], ['u-adm', 'adm', 'مدير', 'admin'], ['u-st', 'st', 'موظف', 'staff'], ['u-mb', 'mb', 'مندوب', 'mandoub'],
    ['u-v', 'v', 'مشاهد', 'staff'], ['u-m', 'm', 'مدير الخدمة', 'staff'], ['u-s', 's', 'مُرسِل', 'staff']];
  for (const [id, un, n, r] of U) {
    DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES (?,?,?,?,?,1,?)').run(id, un, n, 'x', r, T0);
    DB.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run('t-' + un, id, T0, FUT);
  }
  // منح مستقل: كل موظف صلاحية واحدة فقط (يمنحها المدير — updated_by مدير)
  const grant = (u, p) => DB.db.prepare('INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,1,?,?)').run(u, p, 'u-own', T0);
  grant('u-v', 'notifications.whatsapp.view');
  grant('u-m', 'notifications.whatsapp.manage');
  grant('u-s', 'notifications.whatsapp.send');
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

/* ---------------- 2) الصلاحيات ---------------- */
{
  const P = ['notifications.whatsapp.view', 'notifications.whatsapp.manage', 'notifications.whatsapp.send'];
  ok(P.every((p) => Object.prototype.hasOwnProperty.call(mod.PERMISSIONS, p)), 'perm: الصلاحيات الثلاث مسجّلة في الكتالوج');
  ok(P.every((p) => ROLE_PERMISSIONS.admin.has(p) && !ROLE_PERMISSIONS.staff.has(p) && !ROLE_PERMISSIONS.mandoub.has(p)), 'perm: افتراضياً للمدير فقط — لا للموظف ولا للمندوب');
  ok(P.every((p) => !mod.ADMIN_ONLY_PERMISSIONS.includes(p)), 'perm: ليست من الصلاحيات الإدارية المحمية (لا تمنح إدارة كاملة)');
  const env = makeEnv();
  const ends = [['GET', '/api/wa'], ['POST', '/api/wa/recipients', { name: 'x', phone: '0501111111' }], ['GET', '/api/wa/events'], ['GET', '/api/wa/log'],
    ['POST', '/api/wa/sends', { type: 'order_created', message: 'x', recipientIds: ['a'] }], ['PUT', '/api/wa/templates/order_created', { body: 'x' }]];
  for (const [m, p, b] of ends) ok((await call(env, m, p, '', b)).status === 401, `perm: بلا جلسة ← 401 (${m} ${p})`);
  for (const [m, p, b] of ends) ok((await call(env, m, p, 't-st', b)).status === 403, `perm: موظف بلا صلاحية ← 403 (${m} ${p})`);
  for (const [m, p, b] of ends) ok((await call(env, m, p, 't-mb', b)).status === 403, `perm: مندوب بلا صلاحية ← 403 (${m} ${p})`);
  // view فقط
  ok((await call(env, 'GET', '/api/wa', 't-v')).status === 200, 'perm: view ← يعرض الخدمة');
  ok((await call(env, 'GET', '/api/wa/log', 't-v')).status === 200, 'perm: view ← يعرض السجل');
  ok((await call(env, 'POST', '/api/wa/recipients', 't-v', { name: 'x', phone: '0501111111' })).status === 403, 'perm: view لا يضيف مستلماً');
  ok((await call(env, 'POST', '/api/wa/sends', 't-v', { type: 'order_created', message: 'x', recipientIds: ['a'] })).status === 403, 'perm: view لا يرسل');
  // manage فقط
  const add = await call(env, 'POST', '/api/wa/recipients', 't-m', { name: 'مستلم', phone: '0501111111', events: ['order_created'] });
  ok(add.status === 200, 'perm: manage ← يضيف مستلماً', add);
  ok((await call(env, 'PUT', '/api/wa/templates/order_created', 't-m', { body: 'قالب {order_number}' })).status === 200, 'perm: manage ← يعدّل القالب');
  ok((await call(env, 'POST', '/api/wa/sends', 't-m', { type: 'order_created', message: 'x', recipientIds: [add.data.recipient.id] })).status === 403, 'perm: manage لا يرسل');
  ok((await call(env, 'GET', '/api/wa/log', 't-m')).status === 403, 'perm: manage لا يعرض السجل بلا view');
  // send فقط
  const sd = await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'order_created', message: 'x', recipientIds: [add.data.recipient.id] });
  ok(sd.status === 200, 'perm: send ← يبدأ جلسة إرسال', sd);
  ok((await call(env, 'POST', '/api/wa/recipients', 't-s', { name: 'y', phone: '0502222222' })).status === 403, 'perm: send لا يضيف مستلماً');
  ok((await call(env, 'DELETE', '/api/wa/recipients/' + add.data.recipient.id, 't-s')).status === 403, 'perm: send لا يحذف مستلماً');
  ok((await call(env, 'PUT', '/api/wa/templates/order_created', 't-s', { body: 'x' })).status === 403, 'perm: send لا يعدّل القوالب');
  // الصلاحيات الجديدة لا تعطي أي صلاحية إدارية
  for (const tk of ['t-v', 't-m', 't-s']) {
    ok((await call(env, 'GET', '/api/users', tk)).status === 403 && (await call(env, 'POST', '/api/users/u-st/permissions', tk, { overrides: { 'orders.view_all': 1 } })).status === 403,
      'perm: ' + tk + ' بلا وصول للمستخدمين أو الصلاحيات');
  }
  const me = await call(env, 'GET', '/api/wa', 't-s');
  ok(me.data.can.send === true && me.data.can.manage === false && me.data.can.view === false, 'perm: can يعكس الصلاحيات الفعلية من الخادم', me.data.can);
  // موظف عُطِّلت صلاحيته صراحةً لا يمر حتى لو كان مديراً عادياً
  env.DB.db.prepare('INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,0,?,?)').run('u-adm', 'notifications.whatsapp.send', 'u-own', T0);
  ok((await call(env, 'POST', '/api/wa/sends', 't-adm', { type: 'order_created', message: 'x', recipientIds: [add.data.recipient.id] })).status === 403, 'perm: سحب send من مدير عادي يُفرض في الخادم');
  ok((await call(env, 'GET', '/api/wa', 't-owner')).status === 200, 'perm: المالك يصل للخدمة');
}

/* ---------------- 3) المستلمون: 20 حداً، التكرار، الأرقام، التعديل والحذف ---------------- */
const env = makeEnv();
// الأقسام 5–8 تختبر تدفق الإرسال نفسه: المُرسِل u-s يُمنح رؤية الطلبات والمصروفات صراحةً، لأن التنبيه
// لا يُعرض إلا لمن يرى سجله الأصلي (القسم 10 يختبر المُرسِل بلا هذه الصلاحيات)
for (const p of ['orders.view_all', 'expenses.view_all']) env.DB.db.prepare('INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,1,?,?)').run('u-s', p, 'u-own', T0);
{
  const ids = [];
  for (let i = 1; i <= 20; i++) {
    const phone = i % 2 ? '05' + String(10000000 + i) : '+971 50 ' + String(1000000 + i);
    const r = await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'مستلم ' + i, phone });
    if (r.status !== 200) ok(false, 'recipients: إضافة المستلم ' + i, r);
    else ids.push(r.data.recipient.id);
  }
  ok(ids.length === 20 && one(env, 'SELECT COUNT(*) n FROM wa_recipients').n === 20, 'recipients: إضافة 20 مستلماً');
  const st = await call(env, 'GET', '/api/wa', 't-owner');
  ok(st.data.recipients.length === 20 && st.data.max === 20, 'recipients: العدد الحالي 20 والحد الأقصى 20', { n: st.data.recipients.length, max: st.data.max });
  const r21 = await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'الحادي والعشرون', phone: '0559999999' });
  ok(r21.status === 400 && /الحد الأقصى/.test(r21.data.error) && one(env, 'SELECT COUNT(*) n FROM wa_recipients').n === 20, 'recipients: رفض المستلم رقم 21', r21);
  // حذف ثم تكرار بصيغ مختلفة لنفس الرقم
  ok((await call(env, 'DELETE', '/api/wa/recipients/' + ids[19], 't-owner')).status === 200 && one(env, 'SELECT COUNT(*) n FROM wa_recipients').n === 19, 'recipients: حذف مستلم');
  for (const dup of ['0510000001', '+966510000001', '00966 51 000 0001', '966510000001', '٠٥١٠٠٠٠٠٠١']) {
    const r = await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'مكرر', phone: dup });
    ok(r.status === 409 && /مسجّل مسبقاً/.test(r.data.error), 'recipients: منع الرقم المكرر بصيغة «' + dup + '»', r);
  }
  const bad = ['', '12345', 'abc', '0112345678', '+96650123', '+0123', '+1234567890123456', '971501234567'];
  for (const b of bad) ok((await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'خطأ', phone: b })).status === 400, 'recipients: رفض الرقم غير الصالح «' + b + '»');
  ok((await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: '', phone: '0533333333' })).status === 400, 'recipients: الاسم مطلوب');
  ok((await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'x'.repeat(61), phone: '0533333333' })).status === 400, 'recipients: اسم أطول من 60 مرفوض');
  ok((await call(env, 'POST', '/api/wa/recipients', 't-owner', { name: 'x', phone: '0533333333', events: ['hack'] })).status === 400, 'recipients: نوع تنبيه غير معروف مرفوض');
  // تعديل الاسم والرقم والتفعيل
  const e1 = await call(env, 'PUT', '/api/wa/recipients/' + ids[0], 't-owner', { name: 'أبو محمد', phone: '+966 55 123 4567', active: false });
  const r0 = one(env, 'SELECT * FROM wa_recipients WHERE id = ?', ids[0]);
  ok(e1.status === 200 && r0.name === 'أبو محمد' && r0.phone === '966551234567' && r0.active === 0, 'recipients: تعديل الاسم والرقم وتعطيل المستلم', r0);
  ok((await call(env, 'PUT', '/api/wa/recipients/' + ids[0], 't-owner', { active: true })).status === 200 && one(env, 'SELECT active FROM wa_recipients WHERE id = ?', ids[0]).active === 1, 'recipients: إعادة التفعيل');
  const e2 = await call(env, 'PUT', '/api/wa/recipients/' + ids[0], 't-owner', { phone: '0510000003' });
  ok(e2.status === 409, 'recipients: تعديل الرقم إلى رقم مستلم آخر مرفوض', e2);
  ok((await call(env, 'PUT', '/api/wa/recipients/' + ids[0], 't-owner', { phone: '0551234567' })).status === 200, 'recipients: حفظ المستلم بنفس رقمه (بصيغة أخرى) ليس تكراراً');
  ok((await call(env, 'PUT', '/api/wa/recipients/nope', 't-owner', { name: 'x' })).status === 404 && (await call(env, 'DELETE', '/api/wa/recipients/nope', 't-owner')).status === 404, 'recipients: مستلم غير موجود ← 404');
  // تنظيف: نبقي 4 مستلمين للاختبارات التالية
  for (const id of ids.slice(4, 19)) await call(env, 'DELETE', '/api/wa/recipients/' + id, 't-owner');
  ok(one(env, 'SELECT COUNT(*) n FROM wa_recipients').n === 4, 'recipients: الحذف المتعدد');
  env.R = ids.slice(0, 4);
}

/* ---------------- 4) اختيار مستلمين مختلفين لكل حدث ---------------- */
{
  const [A, B, C, D] = env.R;
  await call(env, 'PUT', '/api/wa/recipients/' + A, 't-owner', { events: ['order_created', 'order_status'] });
  await call(env, 'PUT', '/api/wa/recipients/' + B, 't-owner', { events: ['payment_received'] });
  await call(env, 'PUT', '/api/wa/recipients/' + C, 't-owner', { events: ['expense_created', 'payment_received'] });
  await call(env, 'PUT', '/api/wa/recipients/' + D, 't-owner', { events: [], active: false });
  const st = (await call(env, 'GET', '/api/wa', 't-owner')).data;
  const T = st.templates;
  ok(T.order_created.recipients.join() === A && T.payment_received.recipients.sort().join() === [B, C].sort().join() && T.expense_created.recipients.join() === C && T.order_status.recipients.join() === A,
    'per-event: كل نوع له مستلموه المستقلون', Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.recipients])));
  // من شاشة القالب: تعيين مستلمي حدث واحد لا يمس الأحداث الأخرى
  ok((await call(env, 'PUT', '/api/wa/templates/order_status', 't-owner', { recipients: [A, B] })).status === 200, 'per-event: تعيين مستلمي «تغيير الحالة» من شاشة القالب');
  const T2 = (await call(env, 'GET', '/api/wa', 't-owner')).data.templates;
  ok(T2.order_status.recipients.sort().join() === [A, B].sort().join() && T2.payment_received.recipients.sort().join() === [B, C].sort().join(), 'per-event: التعيين لم يغيّر حدثاً آخر');
  ok((await call(env, 'PUT', '/api/wa/templates/order_status', 't-owner', { recipients: ['ghost'] })).status === 400, 'per-event: مستلم غير موجود مرفوض');
  ok((await call(env, 'PUT', '/api/wa/templates/unknown', 't-owner', { body: 'x' })).status === 404, 'templates: نوع غير معروف ← 404');
  // القوالب: الافتراضي، التعديل، الاستعادة
  ok(T.order_created.isDefault && T.order_created.body === WA_DEFAULT_TEMPLATES.order_created && /\{order_number\}/.test(T.order_created.body), 'templates: القالب الافتراضي كما طُلب');
  await call(env, 'PUT', '/api/wa/templates/order_created', 't-owner', { body: 'طلب {order_number} للعميل {customer_name}\r\nبمبلغ {total}' });
  const T3 = (await call(env, 'GET', '/api/wa', 't-owner')).data.templates;
  ok(!T3.order_created.isDefault && T3.order_created.body === 'طلب {order_number} للعميل {customer_name}\nبمبلغ {total}', 'templates: حفظ قالب معدّل (الأسطر موحّدة)');
  ok((await call(env, 'PUT', '/api/wa/templates/order_created', 't-owner', { body: 'x'.repeat(2001) })).status === 400 && (await call(env, 'PUT', '/api/wa/templates/order_created', 't-owner', { body: '   ' })).status === 400, 'templates: الفارغ والطويل جداً مرفوضان');
  await call(env, 'PUT', '/api/wa/templates/order_created', 't-owner', { reset: true });
  ok((await call(env, 'GET', '/api/wa', 't-owner')).data.templates.order_created.isDefault, 'templates: استعادة القالب الافتراضي');
  ok(T.expense_created.vars.join() === 'description,category,amount,employee,date,order_number', 'templates: متغيرات المصروف من حقوله الفعلية', T.expense_created.vars);
}

/* ---------------- 5) الأحداث الأربعة من الحفظ الفعلي فقط ---------------- */
const order = (o) => Object.assign({ id: 'o-1', status: 'new', customer: { name: 'عبدالله بن سعود — Al-Otaibi' }, items: [], payments: [], total: 4600, subtotal: 4000, vatAmount: 600, paid: 0, remaining: 4600, createdAt: T0, updatedAt: T0 }, o);
const sync = (tk, upserts) => call(env, 'POST', '/api/sync', tk, { orders: { upsert: upserts, delete: [] } });
const evs = (type) => rows(env, 'SELECT * FROM wa_events WHERE type = ? ORDER BY created_at', type);
{
  // أ) طلب جديد — فشل الحفظ أولاً (دفعة D1 تسقط) ← لا تنبيه
  env.DB.failNextBatch = 'D1_ERROR: simulated network failure';
  const f1 = await sync('t-owner', [order()]);
  ok(f1.status === 500 && evs('order_created').length === 0 && !one(env, "SELECT id FROM orders WHERE id = 'o-1'"), 'order_created: فشل حفظ الطلب ← لا طلب ولا تنبيه', f1);
  const s1 = await sync('t-owner', [order()]);
  const e1 = evs('order_created');
  const v1 = e1[0] && JSON.parse(e1[0].data);
  ok(s1.status === 200 && e1.length === 1 && e1[0].id === 'order_created:o-1' && e1[0].status === 'pending', 'order_created: تنبيه واحد بعد نجاح الحفظ', { s: s1.status, e1 });
  ok(v1 && String(v1.order_number) === String(s1.data.numbers['o-1']) && v1.customer_name === 'عبدالله بن سعود — Al-Otaibi' && v1.total === '4,600.00 ر.س', 'order_created: المتغيرات من الطلب المحفوظ (الرقم الممنوح من الخادم)', v1);
  ok(Array.isArray(s1.data.wa) && s1.data.wa[0].type === 'order_created', 'order_created: استجابة المزامنة تُعلم الواجهة بالتنبيه الجديد', s1.data.wa);
  // إعادة إرسال نفس الحفظ (إعادة محاولة) ← لا تكرار
  const num = s1.data.numbers['o-1'];
  const s1b = await sync('t-owner', [order({ number: num })]);
  ok(s1b.status === 200 && evs('order_created').length === 1 && !s1b.data.wa, 'order_created: إعادة المحاولة لا تكرّر التنبيه');
  // حفظ مرفوض لسبب آخر (رقم مستخدم) ← لا تنبيه
  const s1c = await sync('t-owner', [order({ id: 'o-x', number: num })]);
  ok(s1c.status === 400 && !one(env, "SELECT id FROM wa_events WHERE id = 'order_created:o-x'"), 'order_created: حفظ مرفوض (رقم مكرر) ← لا تنبيه', s1c);
  // موظف بلا صلاحية إنشاء: مرفوض ← لا تنبيه
  env.DB.db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('u-mb','orders.create',0,'u-own',?)").run(T0);
  const s1d = await sync('t-mb', [order({ id: 'o-mb' })]);
  ok(s1d.status === 403 && !one(env, "SELECT id FROM wa_events WHERE id = 'order_created:o-mb'"), 'order_created: حفظ مرفوض بالصلاحيات ← لا تنبيه');
  // موظف عادي ينشئ طلباً ← التنبيه يُنشأ، لكن الاستجابة لا تُظهر زر الإرسال (لا يملك send)
  const s1e = await sync('t-st', [order({ id: 'o-st', customer: { name: 'خالد' } })]);
  ok(s1e.status === 200 && one(env, "SELECT id FROM wa_events WHERE id = 'order_created:o-st'") && !s1e.data.wa, 'order_created: طلب موظف يُنتج تنبيهاً، ولا يُعرض الإرسال لمن لا يملكه', s1e.data);

  // ب) استلام دفعة
  const base = JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data);
  const pay = { id: 'p-1', at: '2026-11-02', amount: 1500, method: 'transfer', note: '', by: 'المالك' };
  env.DB.failNextBatch = 'D1_ERROR: simulated';
  const f2 = await sync('t-owner', [{ ...base, payments: [pay], paid: 1500, remaining: 3100, updatedAt: '2026-11-02T09:00:00.000Z', _base: base.updatedAt }]);
  ok(f2.status === 500 && evs('payment_received').length === 0, 'payment_received: فشل حفظ الدفعة ← لا تنبيه');
  const s2 = await sync('t-owner', [{ ...base, payments: [pay], paid: 1500, remaining: 3100, updatedAt: '2026-11-02T09:00:00.000Z', _base: base.updatedAt }]);
  const e2 = evs('payment_received'); const v2 = e2[0] && JSON.parse(e2[0].data);
  ok(s2.status === 200 && e2.length === 1 && v2.payment_amount === '1,500.00 ر.س' && v2.payment_method === 'تحويل بنكي' && v2.date === '2026-11-02' && String(v2.order_number) === String(num), 'payment_received: تنبيه بالمبلغ والطريقة والتاريخ', { s: s2.status, v2 });
  const b2 = JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data);
  const s2b = await sync('t-owner', [{ ...b2, payments: [{ ...pay, note: 'تعديل' }], updatedAt: '2026-11-02T10:00:00.000Z', _base: b2.updatedAt }]);
  ok(s2b.status === 200 && evs('payment_received').length === 1, 'payment_received: تعديل دفعة قائمة لا يُنتج تنبيه استلام');
  const b3 = JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data);
  const s2c = await sync('t-owner', [{ ...b3, payments: [...b3.payments, { id: 'p-r', at: '2026-11-03', amount: -200, method: 'cash', by: 'x' }], updatedAt: '2026-11-03T10:00:00.000Z', _base: b3.updatedAt }]);
  ok(s2c.status === 200 && evs('payment_received').length === 1, 'payment_received: الاسترداد (سالب) ليس استلاماً');

  // د) تغيير حالة الطلب
  const b4 = JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data);
  env.DB.failNextBatch = 'D1_ERROR: simulated';
  const f4 = await sync('t-owner', [{ ...b4, status: 'progress', updatedAt: '2026-11-04T10:00:00.000Z', _base: b4.updatedAt }]);
  ok(f4.status === 500 && evs('order_status').length === 0 && JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data).status === 'new', 'order_status: فشل حفظ الحالة ← لا تنبيه');
  const s4 = await sync('t-owner', [{ ...b4, status: 'progress', updatedAt: '2026-11-04T10:00:00.000Z', _base: b4.updatedAt }]);
  const e4 = evs('order_status'); const v4 = e4[0] && JSON.parse(e4[0].data);
  ok(s4.status === 200 && e4.length === 1 && v4.old_status === 'جديد' && v4.new_status === 'قيد التنفيذ' && v4.customer_name === 'عبدالله بن سعود — Al-Otaibi', 'order_status: تنبيه بالحالتين بالعربية', v4);
  const b5 = JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data);
  await sync('t-owner', [{ ...b5, notes: 'ملاحظة', updatedAt: '2026-11-04T11:00:00.000Z', _base: b5.updatedAt }]);
  ok(evs('order_status').length === 1, 'order_status: تعديل لا يغيّر الحالة لا يُنتج تنبيهاً');
  const b6 = JSON.parse(one(env, "SELECT data FROM orders WHERE id = 'o-1'").data);
  const conflict = await sync('t-owner', [{ ...b6, status: 'done', updatedAt: '2026-11-04T12:00:00.000Z', _base: 'stale' }]);
  ok(conflict.status === 409 && evs('order_status').length === 1, 'order_status: تعارض (409) ← لا تنبيه');
  await sync('t-owner', [{ ...b6, status: 'done', updatedAt: '2026-11-04T12:00:00.000Z', _base: b6.updatedAt }]);
  ok(evs('order_status').length === 2, 'order_status: تغيير لاحق للحالة تنبيه جديد مستقل');

  // ج) تسجيل مصروف
  env.DB.failNextBatch = 'D1_ERROR: simulated';
  const f3 = await call(env, 'POST', '/api/expenses', 't-owner', { name: 'نقل وتركيب', amount: 350, category: 'نقل', expense_date: '2026-11-05' });
  ok(f3.status === 500 && evs('expense_created').length === 0 && one(env, 'SELECT COUNT(*) n FROM expenses').n === 0, 'expense_created: فشل حفظ المصروف ← لا مصروف ولا تنبيه');
  ok((await call(env, 'POST', '/api/expenses', 't-owner', { name: 'x', amount: 0 })).status === 400 && evs('expense_created').length === 0, 'expense_created: مصروف مرفوض (مبلغ صفر) ← لا تنبيه');
  const s3 = await call(env, 'POST', '/api/expenses', 't-owner', { name: 'نقل وتركيب', amount: 350, category: 'نقل', expense_date: '2026-11-05', order_id: 'o-1' });
  const e3 = evs('expense_created'); const v3 = e3[0] && JSON.parse(e3[0].data);
  ok(s3.status === 200 && e3.length === 1 && v3.description === 'نقل وتركيب' && v3.category === 'نقل' && v3.amount === '350.00 ر.س' && v3.employee === 'المالك' && v3.date === '2026-11-05' && String(v3.order_number) === String(num), 'expense_created: تنبيه بحقول المصروف الفعلية', v3);
  ok(Array.isArray(s3.data.wa) && s3.data.wa[0].id === 'expense_created:' + s3.data.expense.id, 'expense_created: الاستجابة تحمل التنبيه');

  // تحويل تصميم عميل إلى طلب = طلب جديد محفوظ
  env.DB.db.prepare("INSERT INTO customer_designs (id, public_no, token, status, design, customer_name, customer_phone, created_at, updated_at) VALUES ('d1', 26000127, 'tok', 'new', '{}', 'نورة', '0500000000', ?, ?)").run(T0, T0);
  const cv = await call(env, 'POST', '/api/designs/d1/convert', 't-owner');
  ok(cv.status === 200 && one(env, 'SELECT id FROM wa_events WHERE id = ?', 'order_created:' + cv.data.orderId), 'order_created: تحويل تصميم إلى طلب يُنتج تنبيه طلب جديد', cv);

  // نوع بلا مستلم نشط ← لا تنبيه (لا ضجيج)
  const [A] = env.R;
  await call(env, 'PUT', '/api/wa/recipients/' + A, 't-owner', { active: false });
  const s6 = await sync('t-owner', [order({ id: 'o-quiet', customer: { name: 'هادئ' } })]);
  ok(s6.status === 200 && !one(env, "SELECT id FROM wa_events WHERE id = 'order_created:o-quiet'"), 'events: نوع بلا مستلم نشط ← لا تنبيه');
  await call(env, 'PUT', '/api/wa/recipients/' + A, 't-owner', { active: true });

  // قائمة التنبيهات المعلّقة وصلاحياتها
  const pend = await call(env, 'GET', '/api/wa/events?status=pending', 't-s');
  ok(pend.status === 200 && pend.data.events.length >= 5 && pend.data.events.every((e) => e.status === 'pending'), 'events: المعلّقة لمن يملك send', pend.data.events.length);
  ok((await call(env, 'GET', '/api/wa/events', 't-m')).status === 403, 'events: manage وحده لا يرى التنبيهات');
  const dm = await call(env, 'POST', '/api/wa/events/' + encodeURIComponent('order_created:o-st'), 't-s', { status: 'dismissed' });
  ok(dm.status === 200 && one(env, "SELECT status FROM wa_events WHERE id = 'order_created:o-st'").status === 'dismissed', 'events: تجاهل تنبيه');
  ok((await call(env, 'POST', '/api/wa/events/' + encodeURIComponent('order_created:o-st'), 't-s', { status: 'sent' })).status === 400, 'events: حالة غير معروفة مرفوضة');
}

/* ---------------- 6) الترميز والروابط ---------------- */
{
  const long = '🔔 تنبيه – أصالة نجد\n' + 'نص عربي طويل مع رموز: & ? # % + = / " \' < > ، ؛ ؟ «» — '.repeat(25) + '\nنهاية ✅';
  const L = waLink('966501234567', long);
  const u = new URL(L);
  ok(u.protocol === 'https:' && u.hostname === 'wa.me' && u.pathname === '/966501234567', 'link: https://wa.me/<الرقم الدولي>', L.slice(0, 40));
  ok(u.searchParams.get('text') === long, 'link: فك ترميز النص يعيد الرسالة العربية الطويلة حرفياً (رموز تعبيرية وأسطر و& ? #)');
  ok(!/[\s#&?](?![^?]*$)/.test(L.split('?text=')[1]) && !/[ \n#]/.test(L), 'link: لا مسافات ولا أسطر ولا # خام في الرابط');
  ok(new URL(waLink('966501234567', 'a\uD83Db')).searchParams.get('text') === 'ab', 'link: نصف زوج UTF-16 يُحذف بدل أن يُسقط الترميز');
  ok(waRender('رقم {order_number} — {customer_name} {unknown}', { order_number: 1001, customer_name: '' }) === 'رقم 1001 — — {unknown}', 'render: المتغير الفارغ «—» وغير المعروف يبقى كما هو');
  // ترميز الرسالة المرسلة فعلاً عبر الخادم
  const [, B, C] = env.R;
  const sd = await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'payment_received', eventId: 'payment_received:o-1:p-1', message: long, recipientIds: [B, C] });
  ok(sd.status === 200 && sd.data.items.every((it) => new URL(it.link).searchParams.get('text') === long), 'link: روابط جلسة الإرسال تحمل الرسالة كاملة لكل مستلم', sd.status);
  ok((await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'payment_received', message: 'x'.repeat(2001), recipientIds: [B] })).status === 400, 'send: رسالة أطول من 2000 مرفوضة');
  ok((await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'payment_received', message: '  \n ', recipientIds: [B] })).status === 400, 'send: رسالة فارغة مرفوضة');
  ok((await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'payment_received', message: 'x', recipientIds: [] })).status === 400, 'send: بلا مستلمين مرفوض');
  ok((await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'payment_received', message: 'x', recipientIds: [env.R[3]] })).status === 400, 'send: مستلم معطّل مرفوض');
  ok((await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'order_status', eventId: 'payment_received:o-1:p-1', message: 'x', recipientIds: [B] })).status === 400, 'send: نوع لا يطابق الحدث مرفوض');
  ok((await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'hack', message: 'x', recipientIds: [B] })).status === 400, 'send: نوع غير معروف مرفوض');
  env.SEND = sd.data;
}

/* ---------------- 7) جلسة الإرسال: التقدم والتخطي والإيقاف والتأكيد اليدوي ---------------- */
{
  // جلسة بثلاثة مستلمين
  const [A, B, C] = env.R;
  const s = await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'order_status', eventId: rows(env, "SELECT id FROM wa_events WHERE type='order_status'")[0].id, message: 'تحديث حالة', recipientIds: [A, B, C] });
  const it = s.data.items;
  ok(s.status === 200 && it.length === 3 && it.map((x) => x.seq).join() === '1,2,3' && it.every((x) => x.status === 'ready' && !x.opened_at && !x.confirmed_at), 'progress: جلسة 3 مستلمين — كلهم «جاهز للإرسال» بالترتيب 1..3');
  const set = (id, status, tk = 't-s') => call(env, 'POST', '/api/wa/log/' + id, tk, { status });
  const c0 = await set(it[0].id, 'confirmed');
  ok(c0.status === 409 && /قبل فتح/.test(c0.data.error), 'honesty: لا يمكن تأكيد الإرسال قبل فتح المحادثة', c0);
  const o1 = await set(it[0].id, 'opened');
  const r1 = one(env, 'SELECT * FROM wa_log WHERE id = ?', it[0].id);
  ok(o1.status === 200 && r1.status === 'opened' && r1.opened_at && !r1.confirmed_at, 'progress: المستلم 1 من 3 ← «تم فتح واتساب» بوقت الفتح، بلا تأكيد', r1);
  const cf = await set(it[0].id, 'confirmed');
  const r1b = one(env, 'SELECT * FROM wa_log WHERE id = ?', it[0].id);
  ok(cf.status === 200 && r1b.status === 'confirmed' && r1b.confirmed_at && !cf.data.finished, 'progress: تأكيد يدوي للمستلم 1 — الجلسة لم تنتهِ');
  ok((await set(it[0].id, 'skipped')).status === 409, 'honesty: التأكيد نهائي لا يُغيَّر');
  // إيقاف مؤقت ثم استئناف
  ok((await call(env, 'POST', '/api/wa/sends/' + s.data.send.id, 't-s', { status: 'paused' })).status === 200 && one(env, 'SELECT status FROM wa_sends WHERE id = ?', s.data.send.id).status === 'paused', 'pause: إيقاف الجلسة مؤقتاً');
  const resumed = await call(env, 'GET', '/api/wa/sends/' + s.data.send.id, 't-s');
  ok(resumed.status === 200 && resumed.data.send.status === 'paused' && resumed.data.items.map((x) => x.status).join() === 'confirmed,ready,ready', 'pause: الاستئناف يعيد التقدم الحقيقي (1 مؤكد، 2 باقيان)', resumed.data.items.map((x) => x.status));
  ok((await call(env, 'POST', '/api/wa/sends/' + s.data.send.id, 't-s', { status: 'active' })).status === 200, 'pause: استئناف الجلسة');
  // تخطي المستلم 2، وفشل فتح الرابط للمستلم 3 ثم إعادة المحاولة
  ok((await set(it[1].id, 'skipped')).status === 200 && one(env, 'SELECT status FROM wa_log WHERE id = ?', it[1].id).status === 'skipped', 'skip: تخطي المستلم 2 من 3');
  ok((await set(it[2].id, 'failed')).data.finished === true, 'failed: فشل فتح الرابط للمستلم 3 ← كل المستلمين عولجوا فتنتهي الجلسة');
  ok(one(env, 'SELECT status FROM wa_sends WHERE id = ?', s.data.send.id).status === 'finished', 'finish: الجلسة «منتهية»');
  ok(one(env, 'SELECT status FROM wa_events WHERE id = ?', s.data.send.event_id).status === 'done', 'finish: التنبيه المرتبط صار «تمت معالجته»');
  ok((await set(it[2].id, 'opened')).status === 409, 'finish: جلسة منتهية لا تقبل تعديلاً');
  // جلسة أخرى: فشل ثم إعادة فتح ثم تأكيد
  const s2 = await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'order_created', message: 'م', recipientIds: [A] });
  const id2 = s2.data.items[0].id;
  ok((await set(id2, 'failed')).data.finished === true, 'failed: جلسة مستلم واحد تنتهي عند الفشل');
  const s3 = await call(env, 'POST', '/api/wa/sends', 't-s', { type: 'order_created', message: 'م', recipientIds: [A, B] });
  await set(s3.data.items[0].id, 'failed');
  ok((await set(s3.data.items[0].id, 'opened')).status === 200 && (await set(s3.data.items[0].id, 'confirmed')).status === 200, 'retry: بعد «فشل فتح الرابط» يمكن إعادة الفتح ثم التأكيد');
  ok((await set(s3.data.items[1].id, 'ready')).status === 400 && (await set(s3.data.items[1].id, 'delivered')).status === 400, 'honesty: لا حالة «جاهز» يدوية ولا «تم التسليم» مطلقاً');
  ok((await set(s3.data.items[1].id, 'opened', 't-v')).status === 403, 'perm: view لا يغيّر حالة الإرسال');
  // جلسة مُرسِل لا يعبث بها مُرسِل آخر؛ المالك (يملك الإدارة) يستطيع
  env.DB.db.prepare("INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES ('u-st','notifications.whatsapp.send',1,'u-own',?)").run(T0);
  ok((await set(s3.data.items[1].id, 'opened', 't-st')).status === 403, 'perm: مُرسِل آخر لا يغيّر جلسة غيره (403)');
  ok((await call(env, 'GET', '/api/wa/sends/' + s3.data.send.id, 't-st')).status === 403 && (await call(env, 'POST', '/api/wa/sends/' + s3.data.send.id, 't-st', { status: 'paused' })).status === 403, 'perm: ولا يفتحها ولا يوقفها');
  ok(!(await call(env, 'GET', '/api/wa/events', 't-st')).data.openSends.some((x) => x.id === s3.data.send.id), 'perm: جلسات الغير لا تظهر له في «لم تكتمل»');
  ok((await call(env, 'GET', '/api/wa/events', 't-s')).data.openSends.some((x) => x.id === s3.data.send.id), 'perm: صاحب الجلسة يراها للاستئناف');
  ok((await set(s3.data.items[1].id, 'opened', 't-owner')).status === 200, 'perm: صاحب صلاحية الإدارة يكمل جلسة غيره');
}

/* ---------------- 8) السجل ---------------- */
{
  const lg = await call(env, 'GET', '/api/wa/log', 't-v');
  const L = lg.data.log;
  ok(lg.status === 200 && L.length >= 8, 'log: السجل يعرض كل الأسطر', L.length);
  ok(L.every((x) => ['ready', 'opened', 'confirmed', 'skipped', 'failed'].includes(x.status)), 'log: الحالات الخمس فقط — لا «تم التسليم» ولا «تمت القراءة»');
  ok(L.every((x) => x.status === 'confirmed' ? !!x.confirmed_at : !x.confirmed_at), 'log: وقت التأكيد موجود فقط حين أكّد المستخدم يدوياً');
  ok(L.every((x) => x.event_type && x.name && /^\d{8,15}$/.test(x.phone) && x.created_at), 'log: نوع التنبيه والمستلم والرقم والوقت لكل سطر');
  // رقم الطلب يظهر لمن يرى الطلب (المالك)، ويُحجب عن صاحب «العرض» وحده (لا يملك orders.view_all) — سلوك الخصوصية المقصود
  const N = String(rows(env, "SELECT number FROM orders WHERE id='o-1'")[0].number);
  const LO = (await call(env, 'GET', '/api/wa/log', 't-owner')).data.log;
  ok(LO.some((x) => x.event_type === 'payment_received' && String(x.order_number) === N), 'log: رقم الطلب المرتبط ظاهر لمن يرى الطلب');
  ok(L.every((x) => x.order_number === null), 'log: ومحجوب عن صاحب «العرض» الذي لا يرى الطلبات');
  // حذف المستلم لا يمحو تاريخ الإرسال
  const [, B] = env.R;
  await call(env, 'DELETE', '/api/wa/recipients/' + B, 't-owner');
  const L2 = (await call(env, 'GET', '/api/wa/log', 't-v')).data.log;
  ok(L2.length === L.length && L2.some((x) => x.name === 'مستلم 2'), 'log: حذف المستلم يبقي اسمه ورقمه في السجل');
  ok(one(env, 'SELECT COUNT(*) n FROM wa_event_recipients WHERE recipient_id = ?', B).n === 0, 'recipients: حذف المستلم يحذف تعييناته');
}

/* ---------------- 10) الخصوصية: صلاحية واتساب لا تكشف بيانات الطلبات ولا العملاء ولا المبالغ ---------------- */
{
  const E = makeEnv();
  const g = (u, p, v = 1) => E.DB.db.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,?,?,?)').run(u, p, v, 'u-own', T0);
  // u-st: موظف عادي + إرسال (يرى طلباته فقط) · u-s: إرسال فقط (لا يملك أي طلب) · u-v: عرض فقط · u-m: إدارة فقط
  g('u-st', 'notifications.whatsapp.send'); g('u-st', 'expenses.view_own'); g('u-st', 'expenses.add_own');
  // مراقبة كل سجلات الخادم: لا رقم هاتف ولا نص رسالة يُكتب فيها
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.warn = (...a) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  const W = async (m, p, tk, b) => call(E, m, p, tk, b);
  const R = (await W('POST', '/api/wa/recipients', 't-owner', { name: 'سري للمدير', phone: '0581234567', events: ['order_created', 'payment_received', 'expense_created', 'order_status'] })).data.recipient.id;
  const SECRET = 'عميل_سري_جداً';
  const sy = (tk, o) => W('POST', '/api/sync', tk, { orders: { upsert: [o], delete: [] } });
  // طلب المالك O1 (يحمل الاسم السري والمبلغ 98,765.00) + دفعة + تغيير حالة
  const o1 = { id: 'o-sec', status: 'new', customer: { name: SECRET }, items: [], payments: [], total: 98765, subtotal: 98765, vatAmount: 0, paid: 0, remaining: 98765, createdAt: T0, updatedAt: T0 };
  const s1 = await sy('t-owner', o1);
  const N1 = s1.data.numbers['o-sec'];
  let b = JSON.parse(one(E, "SELECT data FROM orders WHERE id='o-sec'").data);
  await sy('t-owner', { ...b, payments: [{ id: 'p-sec', at: '2026-11-05', amount: 43210, method: 'cash', by: 'المالك' }], updatedAt: '2026-11-05T01:00:00.000Z', _base: b.updatedAt });
  b = JSON.parse(one(E, "SELECT data FROM orders WHERE id='o-sec'").data);
  await sy('t-owner', { ...b, status: 'progress', updatedAt: '2026-11-05T02:00:00.000Z', _base: b.updatedAt });
  // طلب الموظف O2 (له) + مصروفان مرتبطان بطلب المالك: للمالك وللموظف
  const s2 = await sy('t-st', { id: 'o-st2', status: 'new', customer: { name: 'عميل الموظف' }, items: [], payments: [], total: 500, subtotal: 500, vatAmount: 0, paid: 0, remaining: 500, createdAt: T0, updatedAt: T0 });
  ok(s2.status === 200 && Array.isArray(s2.data.wa) && s2.data.wa.length === 1, 'privacy: الموظف المُرسِل يرى «إرسال تنبيه» لطلبه هو بعد الحفظ', s2.data);
  const eOwn = await W('POST', '/api/expenses', 't-owner', { name: 'مصروف المالك السري', amount: 7777, category: 'خاص', order_id: 'o-sec' });
  const eSt = await W('POST', '/api/expenses', 't-st', { name: 'وقود الموظف', amount: 55, category: 'نقل', order_id: 'o-sec' });
  ok(eOwn.status === 200 && eSt.status === 403, 'privacy: الموظف لا يربط مصروفه بطلب لا يراه (قيد المصروفات القائم)', eSt);
  const eSt2 = await W('POST', '/api/expenses', 't-st', { name: 'وقود الموظف', amount: 55, category: 'نقل', order_id: 'o-st2' });
  ok(eSt2.status === 200 && eSt2.data.wa && eSt2.data.wa.length === 1, 'privacy: الموظف يرى تنبيه مصروفه بعد الحفظ');
  ok(one(E, 'SELECT COUNT(*) n FROM wa_events').n === 6, 'privacy: 6 تنبيهات في القاعدة (3 طلب المالك + طلب الموظف + مصروفان)', one(E, 'SELECT COUNT(*) n FROM wa_events').n);
  const leaks = (txt) => [SECRET, '98,765', '43,210', '7,777', 'مصروف المالك السري', '#' + N1].filter((x) => txt.includes(x)).concat(new RegExp('"order_number":' + N1 + '\\b').test(txt) ? ['order_number'] : []);

  // أ) إرسال فقط بلا أي طلب: لا يرى شيئاً من بيانات غيره
  const evS = await W('GET', '/api/wa/events', 't-s');
  ok(evS.status === 200 && evS.data.events.length === 0, 'privacy/send-only: قائمة التنبيهات فارغة — لا يرى تنبيهات طلبات ومصروفات غيره', evS.data.events.map((e) => e.id));
  ok(!leaks(JSON.stringify(evS.data)).length, 'privacy/send-only: لا اسم عميل ولا مبلغ ولا رقم طلب في الاستجابة', leaks(JSON.stringify(evS.data)));
  for (const id of ['order_created:o-sec', 'payment_received:o-sec:p-sec']) {
    const st = await W('POST', '/api/wa/sends', 't-s', { type: id.split(':')[0], eventId: id, message: 'x', recipientIds: [R] });
    ok(st.status === 404 && !leaks(JSON.stringify(st.data)).length, 'privacy/send-only: بدء إرسال بتنبيه لا يراه ← 404 بلا كشف (' + id.split(':')[0] + ')', st);
    ok((await W('POST', '/api/wa/events/' + encodeURIComponent(id), 't-s', { status: 'dismissed' })).status === 404, 'privacy/send-only: لا يتجاهل تنبيهاً لا يراه (404)');
  }
  ok(one(E, "SELECT status FROM wa_events WHERE id='order_created:o-sec'").status === 'pending', 'privacy/send-only: التنبيه لم يتغير');
  const free = await W('POST', '/api/wa/sends', 't-s', { type: 'order_created', message: 'رسالة عامة بلا بيانات', recipientIds: [R] });
  ok(free.status === 200 && free.data.send.order_number === null && free.data.send.event_id === null, 'privacy/send-only: يستطيع إرسال رسالة يكتبها بنفسه بلا ربط بحدث');

  // ب) موظف + إرسال: يرى تنبيهات طلبه ومصروفه فقط
  const evT = await W('GET', '/api/wa/events', 't-st');
  const idsT = evT.data.events.map((e) => e.id).sort();
  ok(idsT.join() === ['expense_created:' + eSt2.data.expense.id, 'order_created:o-st2'].sort().join(), 'privacy/own: الموظف يرى تنبيهات طلبه ومصروفه فقط', idsT);
  ok(!leaks(JSON.stringify(evT.data)).length, 'privacy/own: لا شيء من طلب المالك ولا مصروفه', leaks(JSON.stringify(evT.data)));
  ok((await W('POST', '/api/wa/sends', 't-st', { type: 'order_status', eventId: rows(E, "SELECT id FROM wa_events WHERE type='order_status'")[0].id, message: 'x', recipientIds: [R] })).status === 404, 'privacy/own: لا يرسل بتنبيه طلب غيره (404)');
  const okSend = await W('POST', '/api/wa/sends', 't-st', { type: 'order_created', eventId: 'order_created:o-st2', message: 'طلبي', recipientIds: [R] });
  ok(okSend.status === 200 && okSend.data.send.order_number === s2.data.numbers['o-st2'], 'privacy/own: يرسل تنبيه طلبه برقمه');
  // مصروف الموظف المرتبط بطلب لا يراه: نقل ملكية الطلب o-st2 إلى المالك ← رقم الطلب يُحذف من المصروف
  E.DB.db.prepare("UPDATE orders SET created_by = 'u-own' WHERE id = 'o-st2'").run();
  const evT2 = await W('GET', '/api/wa/events', 't-st');
  const ex = evT2.data.events.find((e) => e.type === 'expense_created');
  ok(evT2.data.events.length === 1 && ex && ex.order_id === null && ex.order_number === null && !('order_number' in ex.vars) && ex.vars.amount === '55.00 ر.س',
    'privacy/min: نقل الطلب لغيره ← يبقى تنبيه المصروف بلا رقم الطلب (أقل بيانات)، وتختفي تنبيهات الطلب فوراً', evT2.data.events);
  const exSend = await W('POST', '/api/wa/sends', 't-st', { type: 'expense_created', eventId: ex.id, message: 'مصروف', recipientIds: [R] });
  ok(exSend.status === 200 && exSend.data.send.order_number === null, 'privacy/min: جلسة المصروف لا تحفظ رقم طلب لا يراه');
  E.DB.db.prepare("UPDATE orders SET created_by = 'u-st' WHERE id = 'o-st2'").run();
  // سحب صلاحية رؤية الطلبات يسري فوراً
  g('u-st', 'orders.view_own', 0);
  ok((await W('GET', '/api/wa/events', 't-st')).data.events.every((e) => e.type === 'expense_created'), 'privacy/revoke: سحب orders.view_own يخفي تنبيهات الطلب فوراً');
  const s3 = await sy('t-st', { ...JSON.parse(one(E, "SELECT data FROM orders WHERE id='o-st2'").data), status: 'done', updatedAt: '2026-11-05T05:00:00.000Z', _base: JSON.parse(one(E, "SELECT data FROM orders WHERE id='o-st2'").data).updatedAt });
  ok(!s3.data || !s3.data.wa, 'privacy/revoke: ولا يُعرض له «إرسال تنبيه» بعد الحفظ', s3);
  g('u-st', 'orders.view_own', 1);

  // ج) جلسات الإرسال: الرسالة لصاحبها وللمالك فقط — لا للمدير العادي ولا لصاحب «الإدارة»
  const os = await W('POST', '/api/wa/sends', 't-owner', { type: 'order_created', eventId: 'order_created:o-sec', message: 'العميل ' + SECRET + ' بمبلغ 98,765.00', recipientIds: [R] });
  ok(os.status === 200, 'session: المالك يبدأ جلسة لطلبه');
  for (const tk of ['t-adm', 't-st', 't-s', 't-m', 't-v']) {
    const r = await W('GET', '/api/wa/sends/' + os.data.send.id, tk);
    ok(r.status === 403 && !leaks(JSON.stringify(r.data)).length, 'session: ' + tk + ' لا يقرأ رسالة جلسة غيره (403 بلا بيانات)', r.status);
    ok((await W('POST', '/api/wa/log/' + os.data.items[0].id, tk, { status: 'opened' })).status === 403, 'session: ' + tk + ' لا يغيّر حالة جلسة غيره');
  }
  ok(!(await W('GET', '/api/wa/events', 't-adm')).data.openSends.some((x) => x.id === os.data.send.id), 'session: جلسة المالك غير المكتملة لا تظهر للمدير العادي');
  ok((await W('GET', '/api/wa/sends/' + okSend.data.send.id, 't-owner')).status === 200, 'session: المالك يفتح جلسة موظف (الإدارة الكاملة)');

  // د) السجل: صاحب «العرض» يرى المستلم والحالة فقط — لا الرسالة ولا رقم طلب لا يراه
  const lgV = await W('GET', '/api/wa/log', 't-v');
  ok(lgV.status === 200 && lgV.data.log.length >= 4, 'log: صاحب العرض يقرأ السجل', lgV.data.log.length);
  ok(lgV.data.log.every((x) => !('message' in x) && !('link' in x)), 'log: السجل لا يحمل نص الرسالة ولا الرابط لأي أحد');
  ok(!leaks(JSON.stringify(lgV.data)).length && lgV.data.log.every((x) => x.order_number === null), 'log: رقم الطلب محجوب عمّن لا يرى الطلب', leaks(JSON.stringify(lgV.data)));
  const lgO = await W('GET', '/api/wa/log', 't-owner');
  ok(lgO.data.log.some((x) => x.order_number === N1), 'log: المالك يرى رقم الطلب في السجل');
  for (const tk of ['t-s', 't-m', 't-st']) ok((await W('GET', '/api/wa/log', tk)).status === 403, 'log: ' + tk + ' بلا صلاحية العرض ← 403');

  // هـ) صاحب «الإدارة» فقط: المستلمون والقوالب، ولا تنبيهات ولا سجل ولا إرسال
  ok((await W('GET', '/api/wa/events', 't-m')).status === 403 && (await W('POST', '/api/wa/sends', 't-m', { type: 'order_created', message: 'x', recipientIds: [R] })).status === 403, 'manage-only: لا تنبيهات ولا إرسال');
  const st = (await W('GET', '/api/wa', 't-m')).data;
  ok(!leaks(JSON.stringify(st)).length, 'manage-only: حالة الخدمة بلا أي بيانات طلبات (القوالب نصوص بمتغيرات فقط)');
  // و) تغيير المستلمين بلا «الإدارة» مستحيل من أي مسار
  for (const tk of ['t-s', 't-v', 't-st', 't-adm-x']) {
    const codes = [(await W('POST', '/api/wa/recipients', tk, { name: 'x', phone: '0590000000' })).status, (await W('PUT', '/api/wa/recipients/' + R, tk, { events: [] })).status,
      (await W('DELETE', '/api/wa/recipients/' + R, tk)).status, (await W('PUT', '/api/wa/templates/order_created', tk, { recipients: [] })).status];
    ok(codes.every((c) => c === 403 || c === 401), 'recipients-guard: ' + tk + ' لا يضيف ولا يعدّل ولا يحذف ولا يغيّر قائمة الحدث', codes);
  }
  ok(one(E, 'SELECT COUNT(*) n FROM wa_event_recipients WHERE recipient_id = ?', R).n === 4, 'recipients-guard: تعيينات المستلم لم تتغير');

  // ز) سجلات الخادم: لا رقم هاتف ولا رسالة
  console.warn = orig.warn; console.error = orig.error;
  ok(!logs.some((l) => /0581234567|966581234567|عميل_سري|98,765/.test(l)), 'logs: لا رقم هاتف ولا نص رسالة في سجلات الخادم', logs.filter((l) => /966|عميل/.test(l)).slice(0, 3));
}

/* ---------------- 11) التزامن: حد 20 والتكرار والتنبيه الواحد ---------------- */
{
  const E = makeEnv();
  for (let i = 1; i <= 19; i++) await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م' + i, phone: '05' + String(20000000 + i), events: ['order_created'] });
  const par = await Promise.all([1, 2, 3, 4, 5].map((i) => call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'متزامن' + i, phone: '05' + String(30000000 + i) })));
  ok(par.filter((r) => r.status === 200).length === 1 && one(E, 'SELECT COUNT(*) n FROM wa_recipients').n === 20 && par.filter((r) => r.status === 400).length === 4,
    'concurrency: 5 إضافات متزامنة عند 19 مستلماً ← واحدة فقط تنجح، والعدد 20 بالضبط', par.map((r) => r.status));
  await call(E, 'DELETE', '/api/wa/recipients/' + rows(E, "SELECT id FROM wa_recipients WHERE name LIKE 'متزامن%'")[0].id, 't-owner');
  await call(E, 'DELETE', '/api/wa/recipients/' + rows(E, "SELECT id FROM wa_recipients WHERE name = 'م1'")[0].id, 't-owner');
  const dup = await Promise.all([1, 2, 3, 4].map(() => call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'مكرر', phone: '+966 59 999 8888' })));
  ok(dup.filter((r) => r.status === 200).length === 1 && dup.filter((r) => r.status === 409).length === 3 && one(E, "SELECT COUNT(*) n FROM wa_recipients WHERE phone='966599998888'").n === 1,
    'concurrency: 4 إضافات متزامنة لنفس الرقم ← واحدة تنجح والبقية 409 (UNIQUE)', dup.map((r) => r.status));
  const o = { id: 'o-par', status: 'new', customer: { name: 'ت' }, items: [], payments: [], total: 1, subtotal: 1, vatAmount: 0, paid: 0, remaining: 1, number: 5000, createdAt: T0, updatedAt: T0 };
  E.DB.db.prepare("INSERT OR REPLACE INTO counters (key, value) VALUES ('order_no', 5000)").run();
  const ps = await Promise.all([1, 2, 3].map(() => call(E, 'POST', '/api/sync', 't-owner', { orders: { upsert: [o], delete: [] } })));
  ok(ps.every((r) => r.status === 200) && one(E, "SELECT COUNT(*) n FROM wa_events WHERE id='order_created:o-par'").n === 1, 'concurrency: 3 مزامنات متزامنة لنفس الطلب ← تنبيه واحد فقط', ps.map((r) => r.status));
  const s = await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', eventId: 'order_created:o-par', message: 'م', recipientIds: [rows(E, 'SELECT id FROM wa_recipients LIMIT 1')[0].id] });
  await call(E, 'POST', '/api/wa/log/' + s.data.items[0].id, 't-owner', { status: 'opened' });
  const cf = await Promise.all([1, 2, 3].map(() => call(E, 'POST', '/api/wa/log/' + s.data.items[0].id, 't-owner', { status: 'confirmed' })));
  const row = one(E, 'SELECT status, confirmed_at FROM wa_log WHERE id = ?', s.data.items[0].id);
  ok(row.status === 'confirmed' && row.confirmed_at && one(E, "SELECT status FROM wa_sends WHERE id = ?", s.data.send.id).status === 'finished', 'concurrency: تأكيدات متزامنة ← حالة نهائية واحدة متسقة', cf.map((r) => r.status));
  const emo = '👨‍👩‍👧‍👦 🇸🇦 ✅ 🔔 — «تجربة» ﷺ ١٢٣ 𝔸';
  const se = await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', message: emo, recipientIds: [rows(E, 'SELECT id FROM wa_recipients LIMIT 1')[0].id] });
  ok(se.status === 200 && new URL(se.data.items[0].link).searchParams.get('text') === emo && one(E, 'SELECT message FROM wa_sends WHERE id = ?', se.data.send.id).message === emo,
    'encoding: رموز مركّبة (عائلة، علم، أرقام عربية، حروف خارج BMP) تُحفظ وتُرمَّز حرفياً');
}

/* ---------------- 12) الهجرة 005 = جزء schema.sql حرفياً ---------------- */
{
  const norm = (t) => t.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const mig = M005.slice(M005.indexOf('CREATE TABLE IF NOT EXISTS wa_recipients'));
  const sch = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS wa_recipients'));
  ok(norm(mig) === norm(sch), 'migration: تعريفات 005 مطابقة حرفياً لما في schema.sql');
  for (const f of ['js/wa-notify.js', 'test/_d1-sqlite.mjs', 'test/whatsapp-ui-e2e.mjs', 'worker/migrations/005_whatsapp_notifications.sql']) ok(fs.existsSync(path.join(root, f)), 'files: الملف المذكور في التقرير موجود: ' + f);
}

/* ---------------- 13) إصلاحات المراجعة المستقلة: ع-1 · م-1 · م-2 · م-4 · الدفعات > 50 · صلاحيات المدير ---------------- */
const g13 = (E, u, p, v = 1) => E.DB.db.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?,?,?,?,?)').run(u, p, v, 'u-own', T0);
const countQ = async (E, fn) => { let n = 0; const orig = E.DB.prepare.bind(E.DB); E.DB.prepare = (sql) => { n++; return orig(sql); }; try { const r = await fn(); return { n, r }; } finally { E.DB.prepare = orig; } };
const ord13 = (id, owner, extra = {}) => Object.assign({ id, status: 'new', customer: { name: 'ع ' + id }, items: [], payments: [], total: 100, subtotal: 100, vatAmount: 0, paid: 0, remaining: 100, createdAt: T0, updatedAt: T0 }, extra);

/* ع-1: عدد الاستعلامات ثابت ولا يتجاوز 50 — مع 25 جلسة غير مكتملة و210 تنبيهات، وأسوأ حالة للسجل */
{
  const E = makeEnv();
  g13(E, 'u-st', 'notifications.whatsapp.send');
  const R = (await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م', phone: '0501111111', events: ['order_created', 'expense_created', 'payment_received', 'order_status'] })).data.recipient.id;
  // تنبيه للموظف أقدم من كل تنبيهات المالك، وجلسة له أقدم من جلسات المالك
  await call(E, 'POST', '/api/sync', 't-st', { orders: { upsert: [ord13('st-old', 'u-st')], delete: [] } });
  E.DB.db.prepare("UPDATE wa_events SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = 'order_created:st-old'").run();
  const stSend = (await call(E, 'POST', '/api/wa/sends', 't-st', { type: 'order_created', eventId: 'order_created:st-old', message: 'قديم', recipientIds: [R] })).data.send.id;
  E.DB.db.prepare("UPDATE wa_sends SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(stSend);
  // 210 تنبيهاً للمالك (طلبات ومصروفات) و25 جلسة غير مكتملة
  const ups = []; for (let i = 0; i < 180; i++) ups.push(ord13('ow' + i, 'u-own'));
  for (let i = 0; i < ups.length; i += 60) await call(E, 'POST', '/api/sync', 't-owner', { orders: { upsert: ups.slice(i, i + 60), delete: [] } });
  for (let i = 0; i < 30; i++) await call(E, 'POST', '/api/expenses', 't-owner', { name: 'م' + i, amount: 10 + i, category: 'x' });
  for (let i = 0; i < 25; i++) await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', eventId: 'order_created:ow' + i, message: 'x', recipientIds: [R] });
  ok(one(E, 'SELECT COUNT(*) n FROM wa_events').n === 211 && one(E, "SELECT COUNT(*) n FROM wa_sends WHERE status != 'finished'").n === 26, 'q-count: الإعداد — 211 تنبيهاً و26 جلسة غير مكتملة');
  const a = await countQ(E, () => call(E, 'GET', '/api/wa/events', 't-owner'));
  ok(a.r.status === 200 && a.n <= 50 && a.r.data.events.length === 200 && a.r.data.openSends.length === 20, `q-count: GET /api/wa/events للمالك (25+ جلسة) = ${a.n} استعلاماً (≤ 50، كان 66 مع 20 جلسة)`, { n: a.n, ev: a.r.data.events.length, os: a.r.data.openSends.length });
  const a2 = await countQ(E, () => call(E, 'GET', '/api/wa/events?status=pending', 't-owner'));
  ok(a2.r.status === 200 && a2.n <= 50, `q-count: GET /api/wa/events?status=pending = ${a2.n} استعلاماً`, a2.n);
  const b = await countQ(E, () => call(E, 'GET', '/api/wa/events', 't-st'));
  ok(b.r.status === 200 && b.n <= 50, `q-count: GET /api/wa/events للموظف = ${b.n} استعلاماً`, b.n);
  ok(b.r.data.events.map((e) => e.id).join() === 'order_created:st-old', 'filter-before-limit: تنبيه الموظف الأقدم يظهر رغم 210 تنبيهات أحدث لغيره (التصفية قبل LIMIT 200)', b.r.data.events.map((e) => e.id).slice(0, 3));
  ok(b.r.data.openSends.map((x) => x.id).join() === stSend, 'filter-before-limit: جلسته الأقدم تظهر رغم 25 جلسة أحدث لغيره (التصفية قبل LIMIT 20)', b.r.data.openSends.length);
  const c = await countQ(E, () => call(E, 'GET', '/api/wa', 't-owner'));
  ok(c.r.status === 200 && c.n <= 50, `q-count: GET /api/wa = ${c.n} استعلاماً`, c.n);
  // أسوأ حالة للسجل: 500 سطر في 500 جلسة مرتبطة بـ 500 حدث مختلف
  const ins = E.DB.db.prepare('INSERT INTO wa_events (id, type, order_id, order_number, ref_id, data, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  const insS = E.DB.db.prepare('INSERT INTO wa_sends (id, event_id, event_type, order_number, message, status, created_by, created_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insL = E.DB.db.prepare('INSERT INTO wa_log (id, send_id, seq, recipient_id, recipient_name, phone, status, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  E.DB.db.exec('BEGIN');
  for (let i = 0; i < 500; i++) {
    const t = new Date(Date.parse('2026-12-01T00:00:00Z') + i * 1000).toISOString();
    ins.run('w:' + i, i % 2 ? 'expense_created' : 'order_created', 'ow' + (i % 180), 1000 + i, 'x' + i, '{}', 'done', 'u-own', t);
    insS.run('s:' + i, 'w:' + i, i % 2 ? 'expense_created' : 'order_created', 1000 + i, 'م', 'finished', 'u-own', 'المالك', t, t);
    insL.run('l:' + i, 's:' + i, 1, R, 'م', '966501111111', 'confirmed', t, t);
  }
  E.DB.db.exec('COMMIT');
  const d = await countQ(E, () => call(E, 'GET', '/api/wa/log', 't-owner'));
  ok(d.r.status === 200 && d.n <= 50 && d.r.data.log.length === 500, `q-count: GET /api/wa/log بأسوأ حالة (500 سطر/500 حدث) = ${d.n} استعلاماً`, { n: d.n, rows: d.r.data.log.length });
  const d2 = await countQ(E, () => call(E, 'GET', '/api/wa/log', 't-v'));
  ok(d2.r.status === 200 && d2.n <= 50 && d2.r.data.log.every((x) => x.order_number === null), `q-count: السجل لصاحب العرض = ${d2.n} استعلاماً وبلا أرقام طلبات`, d2.n);
  console.log(`      أرقام الاستعلامات: events(مالك)=${a.n} events(pending)=${a2.n} events(موظف)=${b.n} /api/wa=${c.n} log(500)=${d.n} log(عرض)=${d2.n}`);
}

/* م-1: تأكيد ‖ تخطٍّ متزامنان على المستلم نفسه — ينجح واحد فقط، والجلسة تُنهى مرة واحدة */
{
  const E = makeEnv();
  const R = (await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م', phone: '0501111111' })).data.recipient.id;
  const R2 = (await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'ن', phone: '0502222222' })).data.recipient.id;
  let one200 = 0, finishedOnce = 0, consistent = 0;
  for (let k = 0; k < 20; k++) {
    const s = (await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', message: 'x', recipientIds: [R] })).data;
    const id = s.items[0].id;
    await call(E, 'POST', '/api/wa/log/' + id, 't-owner', { status: 'opened' });
    const [a, b] = await Promise.all([call(E, 'POST', '/api/wa/log/' + id, 't-owner', { status: 'confirmed' }), call(E, 'POST', '/api/wa/log/' + id, 't-owner', { status: 'skipped' })]);
    const st = [a.status, b.status].sort().join();
    if (st === '200,409') one200++;
    const fin = [a, b].filter((r) => r.data && r.data.finished === true).length;
    if (fin === 1) finishedOnce++;
    const row = one(E, 'SELECT status, confirmed_at FROM wa_log WHERE id = ?', id);
    const winner = a.status === 200 ? 'confirmed' : 'skipped';
    if (row.status === winner && (winner === 'confirmed') === !!row.confirmed_at) consistent++;
  }
  ok(one200 === 20, `race: تأكيد ‖ تخطٍّ ×20 ← في كل مرة 200 واحدة و409 واحدة (${one200}/20)`);
  ok(consistent === 20, `race: الحالة النهائية = الطلب الفائز، و«التأكيد» لا يُستبدل بعده (${consistent}/20)`);
  ok(finishedOnce === 20, `race: الجلسة تُنهى مرة واحدة فقط (${finishedOnce}/20)`);
  // مستلمان في جلسة واحدة يُحسمان معاً بالتزامن ← إنهاء واحد وتنبيه «تمت معالجته»
  await call(E, 'POST', '/api/sync', 't-owner', { orders: { upsert: [ord13('rc', 'u-own')], delete: [] } });
  await call(E, 'PUT', '/api/wa/templates/order_created', 't-owner', { recipients: [R, R2] });
  await call(E, 'POST', '/api/sync', 't-owner', { orders: { upsert: [ord13('rc2', 'u-own')], delete: [] } });
  const s2 = (await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', eventId: 'order_created:rc2', message: 'x', recipientIds: [R, R2] })).data;
  for (const it of s2.items) await call(E, 'POST', '/api/wa/log/' + it.id, 't-owner', { status: 'opened' });
  const both = await Promise.all(s2.items.map((it) => call(E, 'POST', '/api/wa/log/' + it.id, 't-owner', { status: 'confirmed' })));
  ok(both.every((r) => r.status === 200) && both.filter((r) => r.data.finished).length === 1 && one(E, "SELECT status FROM wa_events WHERE id='order_created:rc2'").status === 'done',
    'race: إنهاء مستلمَين بالتزامن ← إنهاء الجلسة مرة واحدة والتنبيه «تمت معالجته»', both.map((r) => r.data));
  // بعد الإنهاء: إعادة فتح مستلم «متخطّى» مرفوضة (الشرط داخل التحديث نفسه)
  const s3 = (await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', message: 'x', recipientIds: [R] })).data;
  await call(E, 'POST', '/api/wa/log/' + s3.items[0].id, 't-owner', { status: 'skipped' });
  ok((await call(E, 'POST', '/api/wa/log/' + s3.items[0].id, 't-owner', { status: 'opened' })).status === 409 && (await call(E, 'POST', '/api/wa/sends/' + s3.send.id, 't-owner', { status: 'paused' })).status === 409,
    'race: جلسة منتهية لا تُعاد حالة مستلم فيها ولا تُوقف');
  // فتح ‖ تخطٍّ من «جاهز»: واحد فقط
  const s4 = (await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', message: 'x', recipientIds: [R, R2] })).data;
  const oo = await Promise.all([call(E, 'POST', '/api/wa/log/' + s4.items[0].id, 't-owner', { status: 'opened' }), call(E, 'POST', '/api/wa/log/' + s4.items[0].id, 't-owner', { status: 'skipped' })]);
  ok(oo.map((r) => r.status).sort().join() === '200,409', 'race: فتح ‖ تخطٍّ من «جاهز» ← واحد فقط ينجح', oo.map((r) => r.status));
}

/* م-2: الجلسة القديمة بعد نقل الملكية وسحب الصلاحيات */
{
  const E = makeEnv();
  g13(E, 'u-st', 'notifications.whatsapp.send'); g13(E, 'u-st', 'expenses.view_own'); g13(E, 'u-st', 'expenses.add_own');
  const R = (await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م', phone: '0501111111', events: ['order_created', 'expense_created'] })).data.recipient.id;
  await call(E, 'POST', '/api/sync', 't-st', { orders: { upsert: [ord13('ms', 'u-st', { customer: { name: 'STAFF_CUST' }, total: 1234 })], delete: [] } });
  const sd = (await call(E, 'POST', '/api/wa/sends', 't-st', { type: 'order_created', eventId: 'order_created:ms', message: 'STAFF_CUST 1,234.00', recipientIds: [R] })).data;
  const free = (await call(E, 'POST', '/api/wa/sends', 't-st', { type: 'order_created', message: 'نص حر', recipientIds: [R] })).data;
  const ex = await call(E, 'POST', '/api/expenses', 't-st', { name: 'وقود', amount: 55, order_id: 'ms' });
  const exSend = (await call(E, 'POST', '/api/wa/sends', 't-st', { type: 'expense_created', eventId: 'expense_created:' + ex.data.expense.id, message: 'مصروف لطلب', recipientIds: [R] })).data;
  ok(sd.send.order_number && exSend.send.order_number === sd.send.order_number, 'session: الإعداد — جلسة طلب وجلسة مصروف مرتبط بالطلب، كلتاهما برقم الطلب');
  const probe = async (tk, sid, logId) => ({ get: await call(E, 'GET', '/api/wa/sends/' + sid, tk), log: await call(E, 'POST', '/api/wa/log/' + logId, tk, { status: 'opened' }), pause: await call(E, 'POST', '/api/wa/sends/' + sid, tk, { status: 'paused' }), list: (await call(E, 'GET', '/api/wa/events', tk)).data.openSends.map((x) => x.id) });
  const blocked = (p, sid) => p.get.status === 403 && !/STAFF_CUST|1,234|order_number/.test(JSON.stringify(p.get.data)) && p.log.status === 403 && p.pause.status === 403 && !p.list.includes(sid);
  // نقل ملكية الطلب للمالك
  E.DB.db.prepare("UPDATE orders SET created_by = 'u-own' WHERE id = 'ms'").run();
  ok(blocked(await probe('t-st', sd.send.id, sd.items[0].id), sd.send.id), 'transfer: بعد نقل الملكية ← لا رسالة ولا رقم طلب ولا متابعة ولا ظهور في «لم تكتمل» (403)');
  ok(blocked(await probe('t-st', exSend.send.id, exSend.items[0].id), exSend.send.id), 'transfer: جلسة المصروف المحفوظة برقم الطلب ← محجوبة أيضاً');
  const fr = await call(E, 'GET', '/api/wa/sends/' + free.send.id, 't-st');
  ok(fr.status === 200 && fr.data.send.message === 'نص حر', 'transfer: جلسة النص الحر (بلا حدث) تبقى لصاحبها');
  ok((await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-owner')).status === 200, 'transfer: المالك يفتحها (يرى كل الطلبات)');
  ok((await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-adm')).status === 403, 'transfer: المدير العادي لا يفتح جلسة غيره رغم رؤيته للطلب');
  E.DB.db.prepare("UPDATE orders SET created_by = 'u-st' WHERE id = 'ms'").run();
  ok((await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-st')).status === 200, 'transfer: إعادة الملكية ← يعود الوصول (الفحص لحظي)');
  // سحب صلاحية رؤية الطلبات
  g13(E, 'u-st', 'orders.view_own', 0);
  ok(blocked(await probe('t-st', sd.send.id, sd.items[0].id), sd.send.id), 'revoke-view: سحب orders.view_own ← الجلسة محجوبة كلياً');
  g13(E, 'u-st', 'orders.view_own', 1);
  // سحب رؤية المصروفات: جلسة المصروف محجوبة، وجلسة الطلب لا
  g13(E, 'u-st', 'expenses.view_own', 0);
  ok((await call(E, 'GET', '/api/wa/sends/' + exSend.send.id, 't-st')).status === 403 && (await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-st')).status === 200, 'revoke-view: سحب expenses.view_own يحجب جلسة المصروف وحدها');
  g13(E, 'u-st', 'expenses.view_own', 1);
  // سحب صلاحية الإرسال
  g13(E, 'u-st', 'notifications.whatsapp.send', 0);
  ok((await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-st')).status === 403 && (await call(E, 'POST', '/api/wa/log/' + sd.items[0].id, 't-st', { status: 'opened' })).status === 403 && (await call(E, 'GET', '/api/wa/sends/' + free.send.id, 't-st')).status === 403,
    'revoke-send: سحب الإرسال يغلق كل جلساته بما فيها النص الحر');
  g13(E, 'u-st', 'notifications.whatsapp.send', 1);
  const back = await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-st');
  ok(back.status === 200 && back.data.send.message === 'STAFF_CUST 1,234.00', 'session: بعد استعادة الصلاحيات تعود الجلسة لصاحبها كما هي');
  // حدث محذوف: الجلسة للمالك فقط
  E.DB.db.prepare("DELETE FROM wa_events WHERE id = 'order_created:ms'").run();
  ok((await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-st')).status === 403 && (await call(E, 'GET', '/api/wa/sends/' + sd.send.id, 't-owner')).status === 200, 'session: حدث محذوف ← لا وصول إلا للمالك');
}

/* م-4: التمييز بين التكرار وتجاوز الحد — رسائل SQLite وD1 */
{
  const { waDupErr } = mod;
  const res = (m) => { try { waDupErr(new Error(m)); return 'none'; } catch (e) { return e instanceof Error && e.status ? e.status + ':' + e.message : 'raw:' + e.message; } };
  const sqliteMsg = (() => { const d = new SqliteD1(); d.exec(SCHEMA); for (let i = 0; i < 20; i++) d.exec(`INSERT INTO wa_recipients (id,name,phone,active,created_at,updated_at) VALUES ('r${i}','n','9665000${String(i).padStart(5, '0')}',1,'t','t')`); try { d.exec("INSERT INTO wa_recipients (id,name,phone,active,created_at,updated_at) VALUES ('x','n','966509999999',1,'t','t')"); } catch (e) { return e.message; } return ''; })();
  const sqliteDup = (() => { const d = new SqliteD1(); d.exec(SCHEMA); d.exec("INSERT INTO wa_recipients (id,name,phone,active,created_at,updated_at) VALUES ('a','n','966501111111',1,'t','t')"); try { d.exec("INSERT INTO wa_recipients (id,name,phone,active,created_at,updated_at) VALUES ('b','n','966501111111',1,'t','t')"); } catch (e) { return e.message; } return ''; })();
  const cases = [
    [sqliteMsg, /^400:.*الحد الأقصى/],
    ['D1_ERROR: wa_recipients limit 20: SQLITE_CONSTRAINT', /^400:.*الحد الأقصى/],
    ['D1_ERROR: wa_recipients limit 20: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)', /^400:.*الحد الأقصى/],
    [sqliteDup, /^409:.*مسجّل مسبقاً/],
    ['D1_ERROR: UNIQUE constraint failed: wa_recipients.phone: SQLITE_CONSTRAINT', /^409:.*مسجّل مسبقاً/],
    ['D1_ERROR: CHECK constraint failed: active IN (0, 1): SQLITE_CONSTRAINT', /^raw:/],
    ['D1_ERROR: UNIQUE constraint failed: wa_recipients.id: SQLITE_CONSTRAINT', /^raw:/],
    ['network error', /^raw:/],
  ];
  for (const [m, re] of cases) ok(re.test(res(m)), 'dup-err: «' + m.slice(0, 70) + '» ← ' + res(m).slice(0, 40));
  // عبر الـ API مع رسائل بصيغة D1: الإضافة الـ 21 المتزامنة تعيد «الحد الأقصى» لا «مكرر»
  const E = makeEnv();
  const origBatch = E.DB.batch.bind(E.DB);
  E.DB.batch = async (l) => { try { return await origBatch(l); } catch (e) { throw new Error('D1_ERROR: ' + e.message + ': SQLITE_CONSTRAINT'); } };
  for (let i = 1; i <= 19; i++) await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م' + i, phone: '05' + String(40000000 + i) });
  const par = await Promise.all([1, 2, 3].map((i) => call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'ز' + i, phone: '05' + String(50000000 + i) })));
  ok(par.filter((r) => r.status === 200).length === 1 && par.filter((r) => r.status === 400 && /الحد الأقصى/.test(r.data.error)).length === 2 && !par.some((r) => r.status === 409),
    'dup-err: 21+ متزامنة برسائل D1 ← «الحد الأقصى» (400) لا «الرقم مسجّل مسبقاً»', par.map((r) => r.status + ' ' + (r.data.error || '')));
  // مكان لمستلمَين (لا 1): عند 19 يسبق مشغّلُ الحد (BEFORE INSERT) قيدَ UNIQUE فيكون «الحد» هو الجواب الصحيح للثاني
  for (const nm of ['م1', 'م2']) await call(E, 'DELETE', '/api/wa/recipients/' + rows(E, 'SELECT id FROM wa_recipients WHERE name = ?', nm)[0].id, 't-owner');
  const dd =await Promise.all([1, 2].map(() => call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'ت', phone: '0598887777' })));
  ok(dd.map((r) => r.status).sort().join() === '200,409' && dd.some((r) => r.status === 409 && /مسجّل مسبقاً/.test(r.data.error)), 'dup-err: تكرار متزامن برسائل D1 ← 409 «مسجّل مسبقاً»', dd.map((r) => r.status));
}

/* ملاحظة إضافية: مزامنة تتجاوز 50 عملية — الطلب وتنبيهه في المقطع نفسه، فلا يضيع تنبيه ولا يُنشأ بلا طلب */
{
  const E = makeEnv();
  await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م', phone: '0501111111', events: ['order_created'] });
  E.DB.batchSizes = [];
  const big = []; for (let i = 0; i < 60; i++) big.push(ord13('bg' + i, 'u-own'));
  E.DB.failBatchAt = 2;                      // المقطع الأول يُحفظ، والثاني يسقط
  const f = await call(E, 'POST', '/api/sync', 't-owner', { orders: { upsert: big, delete: [] } });
  const orders = rows(E, "SELECT id FROM orders WHERE id LIKE 'bg%'").map((r) => r.id);
  const events = rows(E, "SELECT order_id FROM wa_events WHERE id LIKE 'order_created:bg%'").map((r) => r.order_id);
  ok(f.status === 500 && orders.length > 0 && orders.length < 60, 'batch>50: فشل المقطع الثاني ← حُفظ جزء من الطلبات (سلوك المزامنة القائم)', { s: f.status, saved: orders.length });
  ok(orders.length === events.length && orders.every((id) => events.includes(id)), 'batch>50: كل طلب محفوظ له تنبيهه — لا تنبيه ضائع', { orders: orders.length, events: events.length });
  ok(events.every((id) => orders.includes(id)), 'batch>50: ولا تنبيه لطلب لم يُحفظ');
  ok(E.DB.batchSizes.every((n) => n <= 50), 'batch>50: المقاطع ≤ 50 بياناً', E.DB.batchSizes);
  const ok2 = await call(E, 'POST', '/api/sync', 't-owner', { orders: { upsert: big.filter((o) => !orders.includes(o.id)), delete: [] } });
  ok(ok2.status === 200 && one(E, "SELECT COUNT(*) n FROM orders WHERE id LIKE 'bg%'").n === 60 && one(E, "SELECT COUNT(*) n FROM wa_events WHERE id LIKE 'order_created:bg%'").n === 60, 'batch>50: إعادة المحاولة تكمل 60 طلباً و60 تنبيهاً بلا تكرار');
}

/* صلاحيات المدير العادي: الثلاث تأتي من دوره، ولا تمنحه شيئاً من صلاحيات المالك */
{
  const E = makeEnv();
  const P3 = ['notifications.whatsapp.view', 'notifications.whatsapp.manage', 'notifications.whatsapp.send'];
  const adm = { id: 'u-adm', role: 'admin', active: 1, permissions: {}, isOwner: false };
  ok(P3.every((p) => hasPerm(adm, p, { ok: true, overrides: {} })), 'admin-perms: المدير العادي يملك الثلاث من افتراضيات دوره (ROLE_PERMISSIONS.admin)');
  ok(!hasPerm(adm, 'admin.core', { ok: true, overrides: { 'admin.core': true } }) && mod.ADMIN_ONLY_PERMISSIONS.every((p) => !P3.includes(p)), 'admin-perms: ليست صلاحيات إدارية، ولا تُعطي admin.core');
  ok((await call(E, 'POST', '/api/users', 't-adm', { name: 'x', username: 'xx', password: 'Strong#Pass2026', role: 'staff' })).status === 403, 'admin-perms: المدير العادي ما زال لا ينشئ مستخدمين (للمالك)');
  ok((await call(E, 'POST', '/api/users/u-st/permissions', 't-adm', { overrides: { 'notifications.whatsapp.send': 1 } })).status === 403, 'admin-perms: ولا يمنح الصلاحيات (permissions.manage للمالك)');
  const os = (await call(E, 'POST', '/api/wa/sends', 't-owner', { type: 'order_created', message: 'x', recipientIds: [(await call(E, 'POST', '/api/wa/recipients', 't-owner', { name: 'م', phone: '0501111111' })).data.recipient.id] })).data.send.id;
  ok((await call(E, 'GET', '/api/wa/sends/' + os, 't-adm')).status === 403, 'admin-perms: ولا يفتح جلسات المالك');
}

/* ---------------- 9) لا أسرار ولا خدمات مدفوعة ---------------- */
{
  const waSrc = workerSrc.slice(workerSrc.indexOf('------------------------------ إشعارات واتساب (Click to Chat'), workerSrc.indexOf('دوال مساعدة لحساب التكاليف'));
  ok(waSrc.length > 1000 && !/graph\.facebook|cloud api|access_token|env\.WA_|fetch\(/i.test(waSrc.replace(/لا WhatsApp Cloud API/g, '')), 'free: لا WhatsApp Cloud API ولا مفاتيح ولا اتصال خارجي من الخادم');
  ok(!/9665\d{8}/.test(read('worker/schema.sql') + M005), 'data: لا أرقام هواتف افتراضية في المخطط أو الهجرة');
}

console.log(`\n=== whatsapp-notify: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
