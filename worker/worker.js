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

  if (path === '/api/login' && method === 'POST') return login(env, body);

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

async function login(env, body) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const u = await env.DB.prepare('SELECT * FROM users WHERE lower(username) = ?').bind(username).first();
  if (!u || !(await verifyPassword(password, u.password_hash))) return { ok: false, error: 'bad_credentials' };
  if (!u.active) return { ok: false, error: 'inactive' };
  const token = randomToken();
  const created = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(created),
    env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(token, u.id, created, expires),
  ]);
  return { ok: true, token, user: publicUser(u) };
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
    user: publicUser(user),
    settings: settings ? safeParse(settings.data, {}) : {},
    items: items.results.map((r) => safeParse(r.data)),
    orders: orders.results.map((r) => safeParse(r.data)),
    activity: [],
    users: [],
  };
  if (admin) {
    const [act, users] = await Promise.all([env.DB.prepare('SELECT data FROM activity ORDER BY at').all(), listUsers(env)]);
    out.activity = act.results.map((r) => safeParse(r.data));
    out.users = users;
  }
  return out;
}

async function sync(env, user, body) {
  const ts = now();
  const stmts = [];
  const q = (sql, ...args) => stmts.push(env.DB.prepare(sql).bind(...args));

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
      rows.results.forEach((r) => existing.set(r.id, { owner: r.created_by, updatedAt: (safeParse(r.data, {}) || {}).updatedAt || null }));
    }
  }

  // ملكية الطلبات: الموظف يعدّل طلباته فقط، والمدير يعدّل الجميع وينقل الملكية
  if (user.role !== 'admin' && (od.upsert || []).length) {
    for (const o of od.upsert) {
      const row = existing.get(o.id);
      if (row && row.owner && row.owner !== user.id) throw new HttpError(403, `لا يمكنك تعديل الطلب ${o.number ? '#' + o.number : ''} لأنه من إنشاء موظف آخر`);
      if (o.createdBy && o.createdBy !== user.id) throw new HttpError(403, 'لا يمكن نسب الطلب إلى موظف آخر');
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

  (od.upsert || []).forEach((o) => {
    const rec = { ...o };
    delete rec._base;                              // حقل نقل لا يُخزَّن
    q(
      'INSERT INTO orders (id, number, status, customer_name, created_by, created_at, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET number = excluded.number, status = excluded.status, customer_name = excluded.customer_name, data = excluded.data, updated_at = excluded.updated_at',
      rec.id, rec.number ?? null, rec.status ?? null, (rec.customer && rec.customer.name) || '', rec.createdBy ?? null, rec.createdAt ?? ts, JSON.stringify(rec), ts
    );
  });
  if (od.delete && od.delete.length) { requireAdmin(user); od.delete.forEach((id) => q('DELETE FROM orders WHERE id = ?', id)); }

  const ac = body.activity || {};
  (ac.upsert || []).forEach((a) => q('INSERT INTO activity (id, at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', a.id, a.at || ts, JSON.stringify(a)));
  if (ac.clear) { requireAdmin(user); q('DELETE FROM activity'); }
  else if (ac.delete && ac.delete.length) { requireAdmin(user); ac.delete.forEach((id) => q('DELETE FROM activity WHERE id = ?', id)); }

  if (body.settings) {
    requireAdmin(user);
    q('INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', JSON.stringify(body.settings), ts);
  }

  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, applied: stmts.length };
}

/* ------------------------------ المستخدمون ------------------------------ */
async function listUsers(env) {
  const r = await env.DB.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY created_at').all();
  return r.results.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.created_at }));
}

async function saveUser(env, me, body, myToken) {
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim();
  const role = body.role === 'admin' ? 'admin' : body.role === 'staff' ? 'staff' : null;
  const active = body.active !== false;
  const password = body.password ? String(body.password) : '';
  if (!name || !username) throw new HttpError(400, 'الاسم واسم المستخدم مطلوبان');
  if (!role) throw new HttpError(400, 'دور غير صالح');
  const dup = await env.DB.prepare('SELECT id FROM users WHERE lower(username) = ? AND id IS NOT ?').bind(username.toLowerCase(), body.id || null).first();
  if (dup) throw new HttpError(400, 'اسم المستخدم مستخدم من قبل');

  if (!body.id) {
    if (password.length < 4) throw new HttpError(400, 'كلمة المرور 4 أحرف فأكثر');
    await env.DB.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), username, name, await hashPassword(password), role, active ? 1 : 0, now()).run();
  } else {
    const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").bind(body.id).first();
    if (Number(admins.n) === 0 && (role !== 'admin' || !active)) throw new HttpError(400, 'لا يمكن إزالة صلاحية آخر مدير أو إيقافه');
    if (password && password.length < 4) throw new HttpError(400, 'كلمة المرور 4 أحرف فأكثر');
    const stmts = [];
    if (password) stmts.push(env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, active = ?, password_hash = ? WHERE id = ?').bind(name, username, role, active ? 1 : 0, await hashPassword(password), body.id));
    else stmts.push(env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, active = ? WHERE id = ?').bind(name, username, role, active ? 1 : 0, body.id));
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
async function ensureSeed(env) {
  if (seeded) return;
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (Number(c.n) === 0) {
    await env.DB.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
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
  return new Response(a.body, {
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
