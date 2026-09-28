/* ======================================================================
   أصالة نجد | نظام إدارة طلبات المجالس — الخادم (Cloudflare Worker + D1)
   - يُلصق كاملاً في محرر الـ Worker في لوحة Cloudflare
   - يحتاج ربط قاعدة D1 باسم المتغيّر: DB   (Settings > Bindings > D1 database)
   - متغيّرات اختيارية: ALLOWED_ORIGIN (نطاق الواجهة بدل *)، PBKDF2_ITER (افتراضي 20000)
   المسارات:
     POST /api/login            {username, password}  -> {ok, token, user}
     POST /api/logout
     GET  /api/me
     GET  /api/bootstrap        كل البيانات (settings, items, orders, activity*, users*)  * للمدير
     POST /api/sync             {items:{upsert,delete}, orders:{upsert,delete}, activity:{upsert,delete,clear}, settings}
                                -> {ok, numbers:{orderId: رقم}}  أرقام الطلبات الجديدة تُمنح هنا
     POST /api/next-order-no    -> {number}
     POST /api/sync-order-seq   (مدير) بعد الاستيراد
     GET  /api/users            (مدير)
     POST /api/users            (مدير) {id?, name, username, password?, role, active}
     DELETE /api/users/:id      (مدير)
   ====================================================================== */

const SESSION_DAYS = 30;

// ملفات الواجهة المضمّنة (يملؤها build-worker.ps1 عند بناء النسخة المنشورة)
const ASSETS = null; /* __ASSETS__ */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let seeded = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!url.pathname.startsWith('/api/')) {
      if (ASSETS) return serveAsset(url.pathname);
      return json({ ok: true, service: 'majlis-api', hint: 'ضع هذا الرابط في config.js (apiUrl)' }, 200, cors);
    }
    try {
      if (!env.DB) throw new HttpError(500, 'قاعدة D1 غير مربوطة: أضف Binding باسم DB في إعدادات الـ Worker');
      await ensureSeed(env);
      const result = await route(request, env, url);
      return json(result, 200, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: e.message || 'خطأ في الخادم' }, status, cors);
    }
  },
};

/* ------------------------------ التوجيه ------------------------------ */
async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const body = (method === 'POST' || method === 'PUT') ? await request.json().catch(() => ({})) : {};

  if (path === '/api/login' && method === 'POST') return login(env, body, request);

  const token = tokenOf(request);
  const user = await currentUser(env, token);
  if (path === '/api/me' && method === 'GET') return { user: user ? publicUser(user) : null };
  if (!user) throw new HttpError(401, 'غير مسجّل الدخول أو انتهت الجلسة');

  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return { ok: true };
  }
  if (path === '/api/bootstrap' && method === 'GET') return bootstrap(env, user);
  if (path === '/api/sync' && method === 'POST') return sync(env, user, body);
  if (path === '/api/next-order-no' && method === 'POST') {
    const r = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE key = 'order_no' RETURNING value").first();
    return { number: r ? r.value : null };
  }
  if (path === '/api/sync-order-seq' && method === 'POST') {
    requireAdmin(user);
    const m = await env.DB.prepare('SELECT COALESCE(MAX(number), 1000) AS m FROM orders').first();
    await env.DB.prepare("UPDATE counters SET value = ? WHERE key = 'order_no'").bind(Math.max(Number(m.m) || 1000, 1000)).run();
    return { ok: true };
  }
  if (path === '/api/users' && method === 'GET') { requireAdmin(user); return { users: await listUsers(env) }; }
  if (path === '/api/users' && method === 'POST') { requireAdmin(user); return saveUser(env, user, body, token); }
  const mUser = path.match(/^\/api\/users\/([^/]+)$/);
  if (mUser && method === 'DELETE') { requireAdmin(user); return deleteUser(env, user, decodeURIComponent(mUser[1])); }

  throw new HttpError(404, 'المسار غير موجود');
}

/* ------------------------------ الجلسات ------------------------------ */
function tokenOf(request) {
  const h = request.headers.get('x-session-token');
  if (h) return h;
  const a = request.headers.get('authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7) : null;
}

async function currentUser(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.name, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1'
  ).bind(token, now()).first();
  return row || null;
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new HttpError(403, 'هذه العملية للمدير فقط');
}

const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active });

/* الحد من تخمين كلمات المرور: 5 محاولات فاشلة لاسم المستخدم أو 20 من نفس
   العنوان خلال 15 دقيقة تُقفل الدخول 15 دقيقة. */
const LOCK_MIN = 15;
const LOCK_LIMITS = { u: 5, ip: 20 };

async function loginLocked(env, keys) {
  const rows = await env.DB.prepare(`SELECT k, until FROM login_fail WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  const t = now();
  const lock = rows.results.filter((r) => r.until && r.until > t).sort((a, b) => (a.until < b.until ? 1 : -1))[0];
  return lock ? Math.max(1, Math.ceil((new Date(lock.until) - Date.now()) / 60000)) : 0;
}

async function loginFailed(env, keys) {
  const t = now();
  const windowStart = new Date(Date.now() - LOCK_MIN * 60000).toISOString();
  const until = new Date(Date.now() + LOCK_MIN * 60000).toISOString();
  for (const k of keys) {
    const row = await env.DB.prepare('SELECT n, first_at FROM login_fail WHERE k = ?').bind(k).first();
    // محاولة قديمة خارج النافذة لا تُحسب: يبدأ العدّ من جديد
    const n = row && row.first_at > windowStart ? Number(row.n) + 1 : 1;
    const first = row && row.first_at > windowStart ? row.first_at : t;
    const limit = LOCK_LIMITS[k.split(':')[0]] || 5;
    await env.DB.prepare('INSERT INTO login_fail (k, n, first_at, until) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, first_at = excluded.first_at, until = excluded.until')
      .bind(k, n, first, n >= limit ? until : null).run();
  }
}

async function login(env, body, request) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = (request && request.headers.get('CF-Connecting-IP')) || '';
  const keys = ['u:' + username].concat(ip ? ['ip:' + ip] : []);
  const mins = await loginLocked(env, keys);
  if (mins) return { ok: false, error: 'locked', minutes: mins };
  const u = await env.DB.prepare('SELECT * FROM users WHERE lower(username) = ?').bind(username).first();
  if (!u || !(await verifyPassword(password, u.password_hash))) { await loginFailed(env, keys); return { ok: false, error: 'bad_credentials' }; }
  if (!u.active) return { ok: false, error: 'inactive' };
  await env.DB.prepare('DELETE FROM login_fail WHERE k = ?').bind('u:' + username).run();
  const token = randomToken();
  const created = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(created),
    env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(token, u.id, created, expires),
  ]);
  // كلمة المرور الافتراضية معروفة لكل من قرأ التوثيق: تُفرض تغييرها عند أول دخول
  const mustChangePassword = username === 'admin' && password === 'admin';
  return { ok: true, token, user: publicUser(u), mustChangePassword };
}

/* ------------------------------ البيانات ------------------------------ */
async function bootstrap(env, user) {
  const admin = user.role === 'admin';
  const [settings, items, orders] = await Promise.all([
    env.DB.prepare('SELECT data FROM settings WHERE id = 1').first(),
    env.DB.prepare('SELECT data FROM items ORDER BY updated_at').all(),
    env.DB.prepare('SELECT data FROM orders ORDER BY created_at').all(),
  ]);
  const out = {
    // قدرات هذا الخادم: الواجهة الأحدث لا تعتمد على ميزة لم يُنشر خادمها بعد
    features: { serverNumbers: true, costsHidden: true },
    user: publicUser(user),
    settings: settings ? safeParse(settings.data, {}) : {},
    items: items.results.map((r) => safeParse(r.data)),
    // التكاليف والربح لا تُرسل للموظف: إخفاؤها في الواجهة وحدها يتركها مقروءة من أدوات المتصفح
    orders: orders.results.map((r) => { const o = safeParse(r.data); return admin ? o : stripCosts(o); }),
    activity: [],
    users: [],
  };
  if (admin) {
    // آخر 3000 حدث فقط: السجل ينمو بلا حد، وتحميله كاملاً مع كل مزامنة يُبطئها
    const [act, users] = await Promise.all([
      env.DB.prepare('SELECT data FROM (SELECT data, at FROM activity ORDER BY at DESC LIMIT 3000) ORDER BY at').all(),
      listUsers(env),
    ]);
    out.activity = act.results.map((r) => safeParse(r.data));
    out.users = users;
  }
  return out;
}

/* ------------------------------ التحقق المالي ------------------------------
   فحص الشكل قبل أي كتابة: أرقام حقيقية محدودة فقط — يُرفض NaN وInfinity
   والنصوص الجزئية مثل "10abc" (JSON يحوّل NaN إلى null فيُرفض حيث يلزم رقم).
   السياسات المعتمدة هنا: لا سالب في الأسعار/الكميات/التكاليف/الخصم/النسب،
   والخصم بين صفر والمجموع. إشارة مبلغ الدفعة وحدها مسموحة (الاسترداد سالب). */
const isFinNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isOptNum = (v) => v === undefined || v === null || v === '' || isFinNum(v);
const isOptNonNeg = (v) => v === undefined || v === null || v === '' || (isFinNum(v) && v >= 0);
const finErr = (f) => { throw new HttpError(400, 'قيمة مالية غير صالحة: ' + f); };

function checkOrderFin(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id) finErr('order.id');
  if (!(o.number === null || o.number === undefined || o.number === '' ||
        (isFinNum(o.number) && Number.isInteger(o.number) && o.number >= 0))) finErr('order.number');
  for (const f of ['subtotal', 'vatAmount', 'total', 'paid', 'remaining', 'costTotal', 'vatRate']) {
    if (!isOptNum(o[f])) finErr('order.' + f);
  }
  // الخصم والنسب: أرقام غير سالبة، والخصم لا يتجاوز المجموع عند توفره
  for (const f of ['sellerRate', 'shareRate', 'othersRate']) {
    if (!isOptNonNeg(o[f])) finErr('order.' + f);
  }
  if (o.discount !== undefined && o.discount !== null && o.discount !== '') {
    if (!isFinNum(o.discount) || o.discount < 0) finErr('order.discount');
    if (isFinNum(o.subtotal) && o.discount > o.subtotal) finErr('order.discount');
  }
  if (o.vat !== undefined && o.vat !== null) {
    if (typeof o.vat !== 'object' || !isOptNum(o.vat.rate)) finErr('order.vat');
  }
  if (o.customer !== undefined && o.customer !== null) {
    if (typeof o.customer !== 'object') finErr('order.customer');
    else for (const f of ['name', 'phone', 'address', 'mapsUrl']) {
      const v = o.customer[f];
      if (v !== undefined && v !== null && typeof v !== 'string') finErr('order.customer.' + f);
    }
  }
  if (o.payments !== undefined && o.payments !== null) {
    if (!Array.isArray(o.payments)) finErr('order.payments');
    else for (const p of o.payments) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string') finErr('order.payments[]');
      if (!isFinNum(p.amount)) finErr('order.payments.amount');
    }
  }
  if (o.manualRows !== undefined && o.manualRows !== null) {
    if (!Array.isArray(o.manualRows)) finErr('order.manualRows');
    else for (const r of o.manualRows) {
      if (!r || typeof r !== 'object' || !isOptNonNeg(r.qty) || !isOptNonNeg(r.price) || !isOptNonNeg(r.cost)) finErr('order.manualRows');
    }
  }
  if (o.costs !== undefined && o.costs !== null) {
    if (typeof o.costs !== 'object') finErr('order.costs');
    else for (const k of Object.keys(o.costs)) { if (!isOptNonNeg(o.costs[k])) finErr('order.costs'); }
  }
  if (o.extraCosts !== undefined && o.extraCosts !== null) {
    if (!Array.isArray(o.extraCosts)) finErr('order.extraCosts');
    else for (const e of o.extraCosts) {
      if (!e || typeof e !== 'object' || !isOptNonNeg(e.amount)) finErr('order.extraCosts');
    }
  }
  if (o.commRates !== undefined && o.commRates !== null) {
    if (typeof o.commRates !== 'object') finErr('order.commRates');
    else {
      for (const f of ['ownerRate', 'parentRate', 'shareRate']) if (!isOptNonNeg(o.commRates[f])) finErr('order.commRates.' + f);
      const pid = o.commRates.parentId;
      if (pid !== undefined && pid !== null && typeof pid !== 'string') finErr('order.commRates.parentId');
    }
  }
  for (const f of ['updatedAt', 'createdAt']) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string') finErr('order.' + f);
  }
}

function checkItemFin(i) {
  if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !i.id) finErr('item.id');
  if (i.price !== undefined && !(isFinNum(i.price) && i.price >= 0)) finErr('item.price');
  for (const f of ['w', 'h', 'depth']) {
    if (i[f] !== undefined && i[f] !== null && !(isFinNum(i[f]) && i[f] >= 0)) finErr('item.' + f);
  }
}

/* ذرية التدقيق (Phase 3.1): الطفرة الخاضعة للتدقيق وسجلها في نفس دفعة D1.
   استدعاء batch() واحد ذري (الكل أو لا شيء): فشل إدراج السجل يُسقط العملية
   الأساسية معه، فلا يوجد أبداً «طلب محفوظ بلا سجل». عبر المقاطع (50 بياناً)
   لا ضمان عابر — حفظ الطلب الواحد (~3-10 بيانات) دائماً داخل مقطع واحد. */
async function sync(env, user, body) {
  const ts = now();
  const stmts = [];
  const q = (sql, ...args) => stmts.push(env.DB.prepare(sql).bind(...args));

  // تحقق شكلي أولاً: أي حمولة مالية فاسدة تُرفض قبل منح الأرقام وقبل أي كتابة
  const it0 = body.items || {}, od0 = body.orders || {}, ac0 = body.activity || {};
  (it0.upsert || []).forEach(checkItemFin);
  (od0.upsert || []).forEach(checkOrderFin);
  for (const id of [...(it0.delete || []), ...(od0.delete || []), ...(ac0.delete || [])]) {
    if (typeof id !== 'string') finErr('delete id');
  }
  for (const a of (ac0.upsert || [])) {
    if (!a || typeof a.id !== 'string' || typeof a.at !== 'string') finErr('activity');
  }
  if (body.settings) {
    for (const f of ['vatRate', 'depositPct', 'quoteDays', 'sellerRate', 'shareRate', 'mandoubRate', 'mandoubParentRate']) {
      const v = body.settings[f];
      if (v !== undefined && v !== null && !(isFinNum(v) && v >= 0)) finErr('settings.' + f);
    }
  }

  const it = body.items || {};
  if ((it.upsert && it.upsert.length) || (it.delete && it.delete.length)) {
    requireAdmin(user);
    (it.upsert || []).forEach((i) => q('INSERT INTO items (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', i.id, JSON.stringify(i), ts));
    (it.delete || []).forEach((id) => q('DELETE FROM items WHERE id = ?', id));
  }

  const od = body.orders || {};
  // قراءة واحدة تخدم فحصين: الملكية، وحماية التعارض
  const existing = new Map();
  if ((od.upsert || []).length) {
    const ids = od.upsert.map((o) => o.id);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const rows = await env.DB.prepare(`SELECT id, created_by, data FROM orders WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      rows.results.forEach((r) => {
        const data = safeParse(r.data, {}) || {};
        existing.set(r.id, { owner: r.created_by, updatedAt: data.updatedAt || null, data });
      });
    }
  }
  const admin = user.role === 'admin';

  // ملكية الطلبات: الموظف يعدّل طلباته فقط، والمدير يعدّل الجميع وينقل الملكية
  if (user.role !== 'admin' && (od.upsert || []).length) {
    for (const o of od.upsert) {
      const row = existing.get(o.id);
      // طلب بلا مالك (قديم): المدير فقط — لا يصبح تلقائياً قابلاً للتعديل من أي موظف
      if (row && row.owner !== user.id) throw new HttpError(403, `لا يمكنك تعديل الطلب ${o.number ? '#' + o.number : ''} لأنه من إنشاء موظف آخر`);
      if (o.createdBy && o.createdBy !== user.id) throw new HttpError(403, 'لا يمكن نسب الطلب إلى موظف آخر');
    }
  }

  // أرقام صريحة (طلبات قائمة): لا رقمين متماثلين لطلبين مختلفين — لا في الدفعة ولا في المخزّن
  const explicit = (od.upsert || []).filter((o) => o.number !== null && o.number !== undefined && o.number !== '');
  if (explicit.length) {
    const seenNums = new Map();
    for (const o of explicit) {
      if (seenNums.has(o.number) && seenNums.get(o.number) !== o.id) throw new HttpError(400, 'رقم طلب مكرر في الدفعة');
      seenNums.set(o.number, o.id);
    }
    const nums = [...new Set(explicit.map((o) => o.number))];
    for (let i = 0; i < nums.length; i += 50) {
      const chunk = nums.slice(i, i + 50);
      const rows = await env.DB.prepare(`SELECT id, number FROM orders WHERE number IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const r of rows.results) {
        if (!explicit.some((o) => o.id === r.id)) throw new HttpError(400, `رقم الطلب ${r.number} مستخدم في طلب آخر`);
      }
    }
  }

  // حماية التعارض: يرسل العميل النسخة التي انطلق منها (_base). إن كان على الخادم
  // نسخة أحدث فقد عدّله جهاز آخر بعد آخر مزامنة — نرفض بدل الكتابة فوقه صامتين.
  for (const o of od.upsert || []) {
    const row = existing.get(o.id);
    if (!row || !row.updatedAt) continue;          // طلب جديد أو بلا نسخة سابقة
    if (o._base === undefined) continue;           // عميل قديم: لا نكسره
    if (row.updatedAt !== o._base) {
      throw new HttpError(409, `الطلب ${o.number ? '#' + o.number : ''} عُدِّل من جهاز آخر بعد فتحك له`);
    }
  }

  // رقم الطلب يُمنح هنا عند أول حفظ ناجح لا قبله: كان يُحجز بطلب مستقل، فكل حفظ
  // يفشل بعده (انقطاع، خطأ) يترك فجوة في تسلسل أرقام الفواتير.
  const numbers = {};
  for (const o of od.upsert || []) {
    if (existing.has(o.id) || (o.number !== null && o.number !== undefined && o.number !== '')) continue;
    const r = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE key = 'order_no' RETURNING value").first();
    if (!r) throw new HttpError(500, 'عدّاد أرقام الطلبات غير موجود — شغّل schema.sql');
    numbers[o.id] = Number(r.value);
  }

  (od.upsert || []).forEach((o) => {
    const rec = { ...o };
    delete rec._base;                              // حقل نقل لا يُخزَّن
    if (numbers[rec.id] !== undefined) rec.number = numbers[rec.id];
    // طلب جديد من موظف: مالكه هو مرسله دائماً، لا ما يدّعيه الطلب
    if (!admin && !existing.has(rec.id)) { rec.createdBy = user.id; rec.createdByName = user.name; }
    // التكاليف والأرباح للمدير وحده: لا تصل الموظف أصلاً (bootstrap يحذفها)، فما
    // يرسله الموظف بلا تكاليف لا يعني أنها حُذفت — تُعاد من النسخة المخزّنة.
    if (!admin) restoreCosts(rec, existing.has(rec.id) ? existing.get(rec.id).data : {});
    // created_by يُحدَّث أيضاً: بدونه يبقى نقل الملكية في JSON فقط، ويرفض فحص الملكية
    // (المبني على العمود) تعديلات المالك الجديد. COALESCE تحمي الطلبات القديمة بلا مالك.
    q(
      'INSERT INTO orders (id, number, status, customer_name, created_by, created_at, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET number = excluded.number, status = excluded.status, customer_name = excluded.customer_name, created_by = COALESCE(excluded.created_by, orders.created_by), data = excluded.data, updated_at = excluded.updated_at',
      rec.id, rec.number ?? null, rec.status ?? null, (rec.customer && rec.customer.name) || '', rec.createdBy ?? null, rec.createdAt ?? ts, JSON.stringify(rec), ts
    );
  });
  if (od.delete && od.delete.length) { requireAdmin(user); od.delete.forEach((id) => q('DELETE FROM orders WHERE id = ?', id)); }

  const ac = body.activity || {};
  // سجل التحديثات سجل تدقيق: الموظف يضيف أحداثاً باسمه فقط ولا يعدّل حدثاً موجوداً.
  // المدير وحده يكتب فوقها (الاستيراد يعيد أحداث الجميع بأسمائهم الأصلية).
  const staff = !admin;
  (ac.upsert || []).forEach((a) => {
    const rec = staff ? { ...a, userId: user.id, userName: user.name } : { ...a };
    // حدث إنشاء طلب جديد يُكتب قبل أن يُعرف رقمه
    if (rec.orderId && numbers[rec.orderId] !== undefined && !rec.orderNo) rec.orderNo = numbers[rec.orderId];
    q(`INSERT INTO activity (id, at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO ${staff ? 'NOTHING' : 'UPDATE SET data = excluded.data'}`, rec.id, rec.at || ts, JSON.stringify(rec));
  });
  if (ac.clear) { requireAdmin(user); q('DELETE FROM activity'); }
  else if (ac.delete && ac.delete.length) { requireAdmin(user); ac.delete.forEach((id) => q('DELETE FROM activity WHERE id = ?', id)); }

  if (body.settings) {
    requireAdmin(user);
    q('INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', JSON.stringify(body.settings), ts);
  }

  // الدفعة الواحدة ذرية: أي فشل (بما فيه سجل التدقيق) يُسقط العملية كلها قبل أي كتابة
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, applied: stmts.length, numbers };
}

/* ------------------------------ إخفاء التكاليف عن الموظفين ------------------------------ */
const COST_FIELDS = ['costs', 'costTotal', 'extraCosts', 'costUpdatedAt', 'costUpdatedByName'];

/** نسخة الطلب كما تصل الموظف: بلا تكلفة ولا ربح */
function stripCosts(o) {
  if (!o || typeof o !== 'object') return o;
  const r = { ...o };
  COST_FIELDS.forEach((k) => delete r[k]);
  if (Array.isArray(r.manualRows)) {
    r.manualRows = r.manualRows.map((m) => {
      if (!m || m.cost === undefined) return m;
      const c = { ...m }; delete c.cost; return c;
    });
  }
  return r;
}

/** إعادة تكاليف النسخة المخزّنة إلى ما أرسله الموظف (وإسقاط أي تكلفة ادّعاها) */
function restoreCosts(rec, prev) {
  COST_FIELDS.forEach((k) => { if (prev && prev[k] !== undefined) rec[k] = prev[k]; else delete rec[k]; });
  const old = (prev && Array.isArray(prev.manualRows)) ? prev.manualRows : [];
  if (Array.isArray(rec.manualRows)) {
    rec.manualRows = rec.manualRows.map((m, i) => {
      if (!m || typeof m !== 'object') return m;
      const c = { ...m }; delete c.cost;
      // الصنف الإضافي يُطابَق بمعرّفه، والقديم بلا معرّف بموضعه واسمه معاً
      const src = (m.id && old.find((x) => x && x.id === m.id))
        || (old[i] && old[i].name === m.name && (!old[i].id || old[i].id === m.id) ? old[i] : null);
      if (src && src.cost !== undefined) c.cost = src.cost;
      return c;
    });
  }
  return rec;
}

/* ------------------------------ المستخدمون ------------------------------ */
async function listUsers(env) {
  const r = await env.DB.prepare('SELECT id, username, name, role, active, created_at, parent_id, rate, parent_rate FROM users ORDER BY created_at').all();
  return r.results.map((u) => ({
    id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.created_at,
    parentId: u.parent_id || null,
    rate: u.rate == null ? null : Number(u.rate),
    parentRate: u.parent_rate == null ? null : Number(u.parent_rate),
  }));
}

async function saveUser(env, me, body, myToken) {
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim();
  const role = body.role === 'admin' ? 'admin' : body.role === 'staff' ? 'staff' : body.role === 'mandoub' ? 'mandoub' : null;
  const active = body.active !== false;
  const password = body.password ? String(body.password) : '';
  const parentId = body.parentId || null;
  const rate = body.rate == null || body.rate === '' ? null : Math.max(0, Math.min(100, Number(body.rate)));
  const parentRate = body.parentRate == null || body.parentRate === '' ? null : Math.max(0, Math.min(100, Number(body.parentRate)));
  if (!name || !username) throw new HttpError(400, 'الاسم واسم المستخدم مطلوبان');
  if (!role) throw new HttpError(400, 'دور غير صالح');
  // سلامة شجرة المناديب (server-side ولا يعتمد على الواجهة): لا أب ذاتي، لا دورة، لا أب مجهول
  if (parentId) {
    if (body.id && parentId === body.id) throw new HttpError(400, 'لا يمكن أن يكون المستخدم أباً لنفسه');
    const prow = await env.DB.prepare('SELECT parent_id FROM users WHERE id = ?').bind(parentId).first();
    if (!prow) throw new HttpError(400, 'المندوب الأعلى المحدد غير موجود');
    const seen = new Set([body.id || null, parentId]);
    let cur = prow.parent_id || null, guard = 0;
    while (cur) {
      if (cur === body.id || seen.has(cur)) throw new HttpError(400, 'تعيين الأب هذا يُنشئ دورة في شجرة المناديب');
      seen.add(cur);
      if (++guard > 1000) throw new HttpError(400, 'تعيين الأب هذا يُنشئ دورة في شجرة المناديب');
      const r = await env.DB.prepare('SELECT parent_id FROM users WHERE id = ?').bind(cur).first();
      if (!r) break;
      cur = r.parent_id || null;
    }
  }
  const dup = await env.DB.prepare('SELECT id FROM users WHERE lower(username) = ? AND id IS NOT ?').bind(username.toLowerCase(), body.id || null).first();
  if (dup) throw new HttpError(400, 'اسم المستخدم مستخدم من قبل');

  if (!body.id) {
    if (password.length < 4) throw new HttpError(400, 'كلمة المرور 4 أحرف فأكثر');
    await env.DB.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at, parent_id, rate, parent_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), username, name, await hashPassword(password), role, active ? 1 : 0, now(), parentId, rate, parentRate).run();
  } else {
    const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").bind(body.id).first();
    if (Number(admins.n) === 0 && (role !== 'admin' || !active)) throw new HttpError(400, 'لا يمكن إزالة صلاحية آخر مدير أو إيقافه');
    if (password && password.length < 4) throw new HttpError(400, 'كلمة المرور 4 أحرف فأكثر');
    const stmts = [];
    if (password) stmts.push(env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, active = ?, password_hash = ?, parent_id = ?, rate = ?, parent_rate = ? WHERE id = ?').bind(name, username, role, active ? 1 : 0, await hashPassword(password), parentId, rate, parentRate, body.id));
    else stmts.push(env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, active = ?, parent_id = ?, rate = ?, parent_rate = ? WHERE id = ?').bind(name, username, role, active ? 1 : 0, parentId, rate, parentRate, body.id));
    // إنهاء الجلسات الأخرى عند تغيير كلمة المرور أو الإيقاف
    if (password || !active) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').bind(body.id, myToken || ''));
    await env.DB.batch(stmts);
  }
  return { ok: true, users: await listUsers(env) };
}

async function deleteUser(env, me, id) {
  if (id === me.id) throw new HttpError(400, 'لا يمكنك حذف حسابك الحالي');
  const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").bind(id).first();
  if (Number(admins.n) === 0) throw new HttpError(400, 'لا يمكن حذف آخر مدير في النظام');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return { ok: true, users: await listUsers(env) };
}

/* ------------------------------ التهيئة الأولى ------------------------------ */
// عند أول تشغيل: إنشاء المستخدم admin / admin إن لم يوجد مستخدمون
/* خطأ "العمود موجود" متوقع عند التهيئة المتزامنة؛ أي خطأ آخر حقيقي ويُرمى */
function ignoreExistsColumn(e) {
  if (/duplicate column|already exists/i.test(String((e && e.message) || e || ''))) return;
  throw e;
}
async function ensureSeed(env) {
  if (seeded) return;
  // جداول وأعمدة جديدة بعد النشر الأول: تُنشأ هنا حتى لا يحتاج صاحب المحل إعادة تشغيل schema.sql
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS login_fail (k TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at TEXT NOT NULL, until TEXT)').run();
  // أعمدة المندوب (هيكل متعدد المستويات ونسب العمولة)
  await env.DB.prepare('ALTER TABLE users ADD COLUMN parent_id TEXT').run().catch(ignoreExistsColumn);
  await env.DB.prepare('ALTER TABLE users ADD COLUMN rate REAL').run().catch(ignoreExistsColumn);
  await env.DB.prepare('ALTER TABLE users ADD COLUMN parent_rate REAL').run().catch(ignoreExistsColumn);
  // إدراج مشروط لا متزامن آمن: طلبان باردان معاً لا ينتجان مديرين مكررين ولا خطأ
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (Number(c.n) === 0) {
    await env.DB.prepare(`INSERT INTO users (id, username, name, password_hash, role, active, created_at)
      SELECT ?, ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)`)
      .bind(uid(), 'admin', 'مدير النظام', await hashPassword('admin'), 'admin', now()).run();
  }
  seeded = true;
}

/* ------------------------------ كلمات المرور (PBKDF2) ------------------------------ */
const DEFAULT_ITER = 20000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const iter = DEFAULT_ITER;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iter);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(hash)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const hash = await pbkdf2(password, unb64(parts[2]), Number(parts[1]) || DEFAULT_ITER);
  return timingSafeEqual(b64(hash), parts[3]);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------ خدمة ملفات الواجهة ------------------------------ */
function serveAsset(pathname) {
  const key = pathname === '/' ? '/index.html' : pathname.replace(/\/+$/, '');
  const a = ASSETS[key] || ASSETS[key + '/index.html'] || (key.includes('.') ? null : ASSETS['/index.html']);
  if (!a) return new Response('404', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  let body = a.body;
  if (a.b64) body = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': a.ct,
      'Cache-Control': key === '/index.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* ------------------------------ أدوات ------------------------------ */
const now = () => new Date().toISOString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function randomToken() { const a = crypto.getRandomValues(new Uint8Array(32)); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); }
function b64(bytes) { let s = ''; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); }
function unb64(str) { const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function safeParse(text, fallback = null) { try { return JSON.parse(text); } catch (_) { return fallback; } }
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers) });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '*';
  const allowed = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' ? env.ALLOWED_ORIGIN : origin;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
