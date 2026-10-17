/* ======================================================================
   أصالة نجد | نظام إدارة طلبات المجالس — الخادم (Cloudflare Worker + D1)
   - يُلصق كاملاً في محرر الـ Worker في لوحة Cloudflare
   - يحتاج ربط قاعدة D1 باسم المتغيّر: DB   (Settings > Bindings > D1 database)
   - متغيّرات اختيارية: ALLOWED_ORIGIN (نطاق الواجهة بدل *)، PBKDF2_ITER (افتراضي 20000)
    المسارات:
      GET  /customer-design      بوابة العميل (واجهة مستقلة بلا دخول)
      GET  /api/app-update       بيانات تحديث التطبيق (عام: بلا دخول وبلا قاعدة)
      POST /api/portal/session   جلسة تصميم للعميل (عام، برقم عشوائي آمن)
      GET  /api/portal/settings  بيانات المحل التسويقية (عام، بلا أسرار)
      GET  /api/portal/catalog   الأصناف العامة (عام، بلا أسعار)
      GET  /api/portal/design    تصميم العميل (بتوكن الجلسة فقط)
      POST /api/portal/save      حفظ التصميم (بتوكن الجلسة فقط)
      POST /api/portal/finish    إنهاء ومنح رقم عام (بتوكن الجلسة فقط)
      POST /api/portal/contact   طلب التواصل (بتوكن الجلسة فقط)
      GET  /api/portal/view/:no  عرض عام للتصميم برقمه (قراءة فقط، بلا توكن)
      GET  /customer-design-expanded   التصميم الموسّع (نسخة تجريبية — جدول وواجهة منفصلة)
      GET  /api/designs          (موظف) قائمة تصاميم العملاء
      GET  /api/designs/:id      (موظف) فتح تصميم
      PUT  /api/designs/:id      (موظف) مراجعة/تعديل
      POST /api/designs/:id/convert  (موظف) تحويل إلى طلب
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
    // فحص تحديث التطبيق: عام تماماً — بلا جلسة، وبلا قاعدة D1 (لا قراءة ولا كتابة
    // لأي بيانات، ولا تهيئة)، فيعمل قبل الدخول ولا يتعطل بغياب الربط.
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/api/app-update') {
      return json({ ok: true, update: appUpdateMeta(env) }, 200, cors);
    }
    // بوابة العميل: مسار مستقل يقدّم portal.html (جاهز لنطاق فرعي لاحقاً دون إعادة بناء)
    if (url.pathname === '/customer-design' || url.pathname.startsWith('/customer-design/')) {
      await recordVisit(env, request, 'customer');
      await recordAnalytics(env, request, 'design_visit');
      if (ASSETS) return serveAsset('/portal.html');
      return json({ ok: true, service: 'majlis-portal' }, 200, cors);
    }
    /* التصميم الموسّع — نسخة تجريبية (منفصلة تماماً عن بوابة العميل):
       صفحة مختلفة بملفها، وواجهة API مختلفة تحفظ في جدول customer_designs_exp
       فلا تختلط تصاميم التجربة بتصاميم العملاء الحقيقيين ولا تستهلك أرقام MJ.
       المسار لا يطابق شرط '/customer-design' أعلاه (يلزم '/' بعده) فلا تعارض. */
    if (url.pathname === '/customer-design-expanded' || url.pathname.startsWith('/customer-design-expanded/')) {
      await recordVisit(env, request, 'expanded');
      if (ASSETS) return serveAsset('/portal-expanded.html');
      return json({ ok: true, service: 'majlis-portal-expanded' }, 200, cors);
    }
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

  // بوابة العميل (عامة): كل مسار يتحقق من customer token ولا يرى إلا صفّه
  if (path === '/api/portal/session' && method === 'POST') return portalSession(env, request);
  if (path === '/api/portal/settings' && method === 'GET') return portalSettings(env);
  if (path === '/api/portal/catalog' && method === 'GET') return portalCatalog(env);
  if (path === '/api/portal/design' && method === 'GET') return portalGet(env, request);
  if (path === '/api/portal/save' && method === 'POST') return portalSave(env, request, body);
  if (path === '/api/portal/finish' && method === 'POST') return portalFinish(env, request, body);
  if (path === '/api/portal/contact' && method === 'POST') return portalContact(env, request, body);
  const mView = path.match(/^\/api\/portal\/view\/([A-Za-z0-9-]+)$/);
  if (mView && method === 'GET') return portalView(env, mView[1], request);

  /* واجهة النسخة التجريبية (التصميم الموسّع): نفس منطق الأمان لكن على جدول
     منفصل (customer_designs_exp) وبادئة توكن x — فالتصميم التجريبي لا يختلط
     ببيانات العملاء ولا بأرقام MJ ولا يظهر في صفحة تصاميم الموظفين. */
  if (path.startsWith('/api/portal-expanded')) {
    const ep = path.slice('/api/portal-expanded'.length) || '/';
    if (ep === '/session' && method === 'POST') return portalExpSession(env, request);
    if (ep === '/settings' && method === 'GET') return portalSettings(env);
    if (ep === '/catalog' && method === 'GET') return portalCatalog(env);
    if (ep === '/design' && method === 'GET') return portalExpGet(env, request);
    if (ep === '/save' && method === 'POST') return portalExpSave(env, request, body);
    if (ep === '/finish' && method === 'POST') return portalExpFinish(env, request);
    if (ep === '/contact' && method === 'POST') return portalExpContact(env, request, body);
    throw new HttpError(404, 'المسار غير موجود');
  }

  /* تسجيل حدث تحليلات مجمّع — عام عمداً لأن بوابة العميل تعمل بلا جلسة مستخدم،
     لكنه محصور جداً: قائمة أسماء بيضاء معرَّفة في السجل + بُعد نصّي مقصوص،
     ولا يُخزَّن معه أي مُعرّف (لا اسم ولا جوال ولا عنوان IP ولا بصمة جهاز).
     كل ما عدا ذلك يُرفض بصمت حتى لا يتحوّل النقطة إلى مخزن عشوائي. */
  if (path === '/api/analytics/event' && method === 'POST') return analyticsEvent(env, request, body);

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
  // إحصاءات زيارات روابط «عن التطبيق»: للمدير فقط (بيانات حركة زيارات لا يراها الموظفون)
  if (path === '/api/link-visits' && method === 'GET') { requireAdmin(user); return linkVisits(env); }
  // لوحة تحليلات المالك: للمدير فقط على مستوى الخادم — الموظف والمندوب يُرفضان (403)
  if (path === '/api/owner-analytics' && method === 'GET') { requireAdmin(user); return ownerAnalytics(env, new URL(request.url).searchParams); }
  const mUser = path.match(/^\/api\/users\/([^/]+)$/);
  if (mUser && method === 'DELETE') { requireAdmin(user); return deleteUser(env, user, decodeURIComponent(mUser[1])); }

  // تصاميم العملاء (موظفون: مدير وموظف — بلا مندوب، وبلا كشف للتوكن أبداً)
  if (path === '/api/designs' && method === 'GET') { requireStaff(user); return { designs: await listDesigns(env) }; }
  // حذف جملة: ids مصفوفة معرّفات. التحقق من الشكل والحدّ قبل التنفيذ.
  if (path === '/api/designs/bulk-delete' && method === 'POST') { requireStaff(user); return bulkDeleteDesigns(env, body, user); }
  const mConv = path.match(/^\/api\/designs\/([^/]+)\/convert$/);
  if (mConv && method === 'POST') { requireStaff(user); return convertDesign(env, decodeURIComponent(mConv[1]), user); }
  const mDes = path.match(/^\/api\/designs\/([^/]+)$/);
  if (mDes && method === 'GET') { requireStaff(user); return { design: await getDesign(env, decodeURIComponent(mDes[1])) }; }
  if (mDes && (method === 'PUT' || method === 'POST')) { requireStaff(user); return updateDesign(env, decodeURIComponent(mDes[1]), body); }
  if (mDes && method === 'DELETE') { requireStaff(user); return deleteDesign(env, decodeURIComponent(mDes[1]), user); }

  throw new HttpError(404, 'المسار غير موجود');
}

/* ------------------------------ بيانات تحديث التطبيق ------------------------------
   المصدر الرسمي الوحيد لملف APK هو إصدارات GitHub لهذا المستودع (HTTPS).
   الأولوية لمتغيرات البيئة (تُضبط من لوحة Cloudflare دون إعادة نشر):
     APP_UPDATE_VERSION  اسم الإصدار (مثال 1.0.13)
     APP_UPDATE_CODE     رقم البناء (مثال 10013)
     APP_UPDATE_URL      رابط APK (يجب أن يكون ضمن مسار الإصدارات الرسمي)
     APP_UPDATE_SHA256   بصمة SHA-256 للملف (64 خانة hex)
   وإلا تُستخدم قيم افتراضية مضمّنة تشير إلى أحدث إصدار معلوم.
   fail-closed: رابط خارج المسار الرسمي يُصفَّر، وبصمة فاسدة تُهمل (null)
   فيرفض التطبيق التنزيل بدل تثبيت ملف غير موثوق. */
const UPDATE_APK_ALLOW = 'https://github.com/ialshareef/majlis-orders/releases/download/';
const UPDATE_FALLBACK_VERSION = '1.0.63';
// بصمة asalh-najd-1.0.63.apk (إصدار GitHub v1.0.63، بناء CI الموقّع).
const UPDATE_FALLBACK_SHA256 = 'e1bae40d3b65a3fb28794e5796056c7462c5cb60509147f3b1ae1c45f0346ef5';
const UPDATE_FALLBACK_NOTES = [
  'شارة عرض الباب في فتحة الجدار بدل الطفو في العمق',
  'كتلة «تواصل معنا» برموز QR حقيقية في أمر الشراء بنفس حسابات صفحة العميل',
  'فرش الكل يفرش بجانب الأبواب والمشب بدل تخطي الجدار',
  'حقول كمية رقمية مباشرة بدل أزرار (+) و(-) في البوابتين والموظف',
];

function versionCodeOfName(v) {
  const p = String(v || '').split('.').map((n) => parseInt(n, 10));
  if (p.length >= 2 && p.every((n) => Number.isInteger(n) && n >= 0)) {
    return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0);
  }
  return 1;
}

function appUpdateMeta(env) {
  const e = env || {};
  const versionName = String(e.APP_UPDATE_VERSION || UPDATE_FALLBACK_VERSION).trim() || UPDATE_FALLBACK_VERSION;
  let versionCode = Number(e.APP_UPDATE_CODE);
  if (!Number.isInteger(versionCode) || versionCode < 1) versionCode = versionCodeOfName(versionName);
  let apkUrl = String(e.APP_UPDATE_URL || '').trim() ||
    (UPDATE_APK_ALLOW + 'v' + versionName + '/asalh-najd-' + versionName + '.apk');
  if (!apkUrl.startsWith(UPDATE_APK_ALLOW)) apkUrl = '';
  const sha = String(e.APP_UPDATE_SHA256 || UPDATE_FALLBACK_SHA256).trim().toLowerCase();
  return {
    versionName,
    versionCode,
    apkUrl,
    sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    mandatory: false,
    releaseNotes: UPDATE_FALLBACK_NOTES.slice(),
  };
}

/* ------------------------------ بوابة العميل ------------------------------
   - التوكن 64-hex عشوائي (crypto) لا يُخمَّن ولا يحمل أي معلومة.
   - الرقم العام (MJ-…) للعرض فقط وليس مفتاح أمان: لا يفتح شيئاً وحده.
   - كل مسار عميل يقرأ صفّه حصراً (WHERE token=?) بعد تحقق الشكل والانتهاء.
   - التوكن لا يظهر أبداً في مسارات الموظفين ولا في العرض العام ولا السجلات. */
const DESIGN_STATUSES = ['new', 'reviewing', 'contacted', 'converted', 'closed'];
const DESIGN_TTL_DAYS = 180;

function requireStaff(user) {
  if (!user || (user.role !== 'admin' && user.role !== 'staff')) throw new HttpError(403, 'هذه العملية للموظفين فقط');
}

function designTokenOf(request) {
  return request.headers.get('x-design-token') || null;
}

async function portalRow(env, token) {
  const t = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(t)) throw new HttpError(401, 'جلسة التصميم غير صالحة');
  const row = await env.DB.prepare('SELECT * FROM customer_designs WHERE token = ?').bind(t).first();
  if (!row) throw new HttpError(401, 'جلسة التصميم غير صالحة');
  if (row.expires_at && row.expires_at < now()) throw new HttpError(401, 'انتهت جلسة التصميم');
  return row;
}

/* حد بسيط ضد الإغراق: 60 جلسة/عرض للعنوان في الساعة (جدول login_fail نفسه) */
async function portalThrottle(env, request) {
  const ip = (request && request.headers.get('CF-Connecting-IP')) || 'unknown';
  const k = 'portal:' + ip;
  const t = now();
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const row = await env.DB.prepare('SELECT n, first_at FROM login_fail WHERE k = ?').bind(k).first();
  const n = row && row.first_at > hourAgo ? Number(row.n) + 1 : 1;
  const first = row && row.first_at > hourAgo ? row.first_at : t;
  if (n > 60) throw new HttpError(429, 'طلبات كثيرة. حاول لاحقاً.');
  await env.DB.prepare('INSERT INTO login_fail (k, n, first_at, until) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, first_at = excluded.first_at, until = excluded.until')
    .bind(k, n, first, null).run();
}

function emptyDesign() {
  return {
    walls: [
      { len: 5, angle: 0 }, { len: 4, angle: 90 },
      { len: 5, angle: 180 }, { len: 4, angle: 270 },
    ],
    openings: [], pieces: [], cornerMode: 'deduct',
  };
}

async function portalSession(env, request) {
  await portalThrottle(env, request);
  const token = randomToken();
  const t = now();
  const exp = new Date(Date.now() + DESIGN_TTL_DAYS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO customer_designs (id, token, status, design, contact_requested, created_at, updated_at, expires_at) VALUES (?, ?, 'draft', ?, 0, ?, ?, ?)")
    .bind(uid(), token, JSON.stringify(emptyDesign()), t, t, exp).run();
  return { ok: true, token, expiresAt: exp };
}

/* روابط آمنة فقط: https بلا مسافات ولا أقواس — تُصفَّر غيرها بدل رفض الطلب كله */
function safeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^https:\/\//i.test(s) || /[\s<>"]/.test(s)) return '';
  try { const u = new URL(s); return u.protocol === 'https:' ? u.href : ''; }
  catch (_) { return ''; }
}

async function shopSettings(env) {
  const r = await env.DB.prepare('SELECT data FROM settings WHERE id = 1').first();
  return safeParse(r && r.data, {}) || {};
}

async function portalSettings(env) {
  const s = await shopSettings(env);
  return {
    ok: true,
    settings: {
      shopName: String(s.shopName || 'أصالة نجد'),
      tagline: String(s.tagline || '').slice(0, 140),
      logoUrl: safeUrl(s.logoUrl),
      phone: String(s.phone || ''),
      mapsUrl: safeUrl(s.mapsUrl),
      whatsapp: safeUrl(s.whatsapp),
      tiktok: safeUrl(s.tiktok),
      instagram: safeUrl(s.instagram),
      snapchat: safeUrl(s.snapchat),
    },
  };
}

async function portalCatalog(env) {
  const r = await env.DB.prepare('SELECT data FROM items ORDER BY updated_at').all();
  const out = [];
  for (const row of r.results) {
    const i = safeParse(row.data);
    if (!i || typeof i !== 'object' || !i.id || i.active === false) continue;
    if (out.length >= 2000) break;
    out.push({
      id: String(i.id).slice(0, 64),
      name: String(i.name || '').slice(0, 80),
      category: String(i.category || ''),
      color: String(i.color || ''),
      fabric: String(i.fabric || '').slice(0, 40),
      depth: i.depth == null ? null : Number(i.depth),
      w: i.w == null ? null : Number(i.w),
      h: i.h == null ? null : Number(i.h),
      shape: String(i.shape || ''),
    });
  }
  return { ok: true, items: out };
}

function portalPublic(row) {
  return {
    id: row.id,
    number: row.public_no ? 'MJ-' + row.public_no : null,
    status: row.status,
    design: safeParse(row.data || row.design, null),
    name: row.customer_name || '',
    phone: row.customer_phone || '',
    contactRequested: !!row.contact_requested,
    orderId: row.order_id || null,
    orderNumber: row.order_number == null ? null : Number(row.order_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function portalGet(env, request) {
  const row = await portalRow(env, designTokenOf(request));
  return Object.assign({ ok: true }, portalPublic(row));
}

/* تحقق هندسي صارم: أرقام حقيقية محدودة فقط، وأعداد عناصر بسقوف معقولة */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function checkDesign(d) {
  const bad = () => { throw new HttpError(400, 'التصميم غير صالح'); };
  if (!d || typeof d !== 'object') bad();
  if (!Array.isArray(d.walls) || d.walls.length > 40) bad();
  for (const w of d.walls) {
    if (!w || typeof w !== 'object' || !isNum(w.len) || w.len < 0.3 || w.len > 50 || !isNum(w.angle)) bad();
  }
  if (d.openings !== undefined) {
    if (!Array.isArray(d.openings) || d.openings.length > 60) bad();
    for (const o of d.openings) {
      if (!o || typeof o !== 'object' || !Number.isInteger(o.wall) || o.wall < 0 || o.wall > 39) bad();
      if (!isNum(o.t) || !isNum(o.w) || o.w <= 0 || o.w > 30) bad();
      if (!['door', 'window', 'mashab'].includes(o.type)) bad();
    }
  }
  if (d.pieces !== undefined) {
    if (!Array.isArray(d.pieces) || d.pieces.length > 200) bad();
    for (const p of d.pieces) {
      if (!p || typeof p !== 'object' || !['sofa', 'acc', 'free', 'column'].includes(p.kind)) bad();
      if (p.kind === 'sofa' && p.seating !== undefined && !['floor', 'sofa', 'arabic', 'raised'].includes(p.seating)) bad();
      for (const f of ['w', 'h']) if (!isNum(p[f]) || p[f] < 0.1 || p[f] > 30) bad();
      for (const f of ['x', 'y', 'rot']) if (p[f] !== undefined && !isNum(p[f])) bad();
      for (const f of ['itemId', 'woodId', 'fabricId', 'foamId']) {
        if (p[f] !== undefined && p[f] !== null && (typeof p[f] !== 'string' || p[f].length > 64)) bad();
      }
    }
  }
  if (d.cornerMode !== undefined && !['deduct', 'full'].includes(d.cornerMode)) bad();
  return true;
}

function cleanName(v) {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  if (s && (s.length < 2 || s.length > 60)) throw new HttpError(400, 'الاسم بين حرفين و60 حرفاً');
  return s;
}

function cleanPhone(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const d = s.replace(/[\s-]/g, '');
  if (!/^\+?\d{7,15}$/.test(d)) throw new HttpError(400, 'رقم الجوال غير صالح');
  return d;
}

async function portalSave(env, request, body) {
  const row = await portalRow(env, designTokenOf(request));
  checkDesign(body.design);
  const name = body.name !== undefined ? cleanName(body.name) : row.customer_name || '';
  const phone = body.phone !== undefined ? cleanPhone(body.phone) : row.customer_phone || '';
  const t = now();
  await env.DB.prepare('UPDATE customer_designs SET design = ?, customer_name = ?, customer_phone = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(body.design), name, phone, t, row.id).run();
  return { ok: true, updatedAt: t };
}

async function portalFinish(env, request) {
  const row = await portalRow(env, designTokenOf(request));
  let no = row.public_no;
  if (no == null) {
    const r = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE key = 'design_no' RETURNING value").first();
    if (!r) throw new HttpError(500, 'عدّاد أرقام التصاميم غير موجود');
    no = Number(r.value);
  }
const t = now();
  const status = row.status === 'draft' ? 'new' : row.status;
  await env.DB.prepare('UPDATE customer_designs SET public_no = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(no, status, t, row.id).run();
  // إكمال التصميم: عدّاد مجمّع فقط (لا اسم ولا جوال ولا معرّف جلسة)
  await recordAnalytics(env, request, 'design_finish');
  return { ok: true, number: 'MJ-' + no, status };
}

async function portalContact(env, request, body) {
  const row = await portalRow(env, designTokenOf(request));
  const name = cleanName(body.name);
  const phone = cleanPhone(body.phone);
  if (!name || !phone) throw new HttpError(400, 'الاسم ورقم الجوال مطلوبان لطلب التواصل');
  const t = now();
const status = row.status === 'draft' ? 'new' : row.status;
  await env.DB.prepare('UPDATE customer_designs SET customer_name = ?, customer_phone = ?, contact_requested = 1, status = ?, updated_at = ? WHERE id = ?')
    .bind(name, phone, status, t, row.id).run();
  // طلب تواصل: عدّاد مجمّع فقط — لا نخزّن أي تفصيل في جدول التحليلات
  await recordAnalytics(env, request, 'contact_request');
  return { ok: true };
}

/* عرض عام برقم التصميم فقط: هندسة + اسم المحل — بلا توكن ولا بيانات تواصل */
async function portalView(env, number, request) {
  await portalThrottle(env, request);
  const m = String(number || '').match(/^MJ-(\d{1,12})$/);
  if (!m) throw new HttpError(404, 'التصميم غير موجود');
  const row = await env.DB.prepare('SELECT public_no, design, created_at FROM customer_designs WHERE public_no = ?').bind(Number(m[1])).first();
  if (!row) throw new HttpError(404, 'التصميم غير موجود');
  const s = await shopSettings(env);
  return {
    ok: true,
    number: 'MJ-' + row.public_no,
    createdAt: row.created_at,
    shopName: String(s.shopName || 'أصالة نجد'),
    design: safeParse(row.design, null),
  };
}

/* ------------------------------ التصميم الموسّع (نسخة تجريبية) ------------------------------
   نفس قواعد أمان البوابة، لكن على جدول customer_designs_exp وبادجة token 'x':
   - لا يختلط ببيانات العملاء الحقيقيين ولا يستهلك أرقام MJ
   - لا يظهر في صفحة «تصاميم العملاء» (تقرأ customer_designs فقط)
   - التوكن يبدأ بـ x فيرفضه جدول البوابة العادية والعكس
 لا تعرض أسعار من الخارج الداخلي — نفس مستوى حماية الحماية. */
const EXP_TOKEN_PREFIX = 'x';

function expTokenOf(request) {
  const t = request.headers.get('x-design-token') || '';
  return /^x[0-9a-f]{64}$/.test(t) ? t : null;
}

async function portalExpRow(env, token) {
  if (!token) throw new HttpError(401, 'جلسة التصميم غير صالحة');
  const row = await env.DB.prepare('SELECT * FROM customer_designs_exp WHERE token = ?').bind(token).first();
  if (!row) throw new HttpError(401, 'جلسة التصميم غير صالحة');
  if (row.expires_at && row.expires_at < now()) throw new HttpError(401, 'انتهت جلسة التصميم');
  return row;
}

async function portalExpSession(env, request) {
  await portalThrottle(env, request);
  const token = EXP_TOKEN_PREFIX + randomToken();
  const t = now();
  const exp = new Date(Date.now() + DESIGN_TTL_DAYS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO customer_designs_exp (id, token, status, design, contact_requested, created_at, updated_at, expires_at) VALUES (?, ?, 'draft', ?, 0, ?, ?, ?)")
    .bind(uid(), token, JSON.stringify(emptyDesign()), t, t, exp).run();
  return { ok: true, token, expiresAt: exp };
}

function portalExpPublic(row) {
  return {
    id: row.id,
    number: row.public_no ? 'EXP-' + row.public_no : null,
    status: row.status,
    design: safeParse(row.design, null),
    name: row.customer_name || '',
    phone: row.customer_phone || '',
    contactRequested: !!row.contact_requested,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function portalExpGet(env, request) {
  const row = await portalExpRow(env, expTokenOf(request));
  return Object.assign({ ok: true }, portalExpPublic(row));
}

async function portalExpSave(env, request, body) {
  const row = await portalExpRow(env, expTokenOf(request));
  checkDesign(body.design);
  const name = body.name !== undefined ? cleanName(body.name) : row.customer_name || '';
  const phone = body.phone !== undefined ? cleanPhone(body.phone) : row.customer_phone || '';
  const t = now();
  await env.DB.prepare('UPDATE customer_designs_exp SET design = ?, customer_name = ?, customer_phone = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(body.design), name, phone, t, row.id).run();
  return { ok: true, updatedAt: t };
}

async function portalExpFinish(env, request) {
  const row = await portalExpRow(env, expTokenOf(request));
  let no = row.public_no;
  if (no == null) {
    const r = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE key = 'design_no_exp' RETURNING value").first();
    if (!r) throw new HttpError(500, 'عدّاد أرقام التصاميم التجريبية غير موجود');
    no = Number(r.value);
  }
  const t = now();
  const status = row.status === 'draft' ? 'new' : row.status;
  await env.DB.prepare('UPDATE customer_designs_exp SET public_no = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(no, status, t, row.id).run();
  return { ok: true, number: 'EXP-' + no, status };
}

async function portalExpContact(env, request, body) {
  const row = await portalExpRow(env, expTokenOf(request));
  const name = cleanName(body.name);
  const phone = cleanPhone(body.phone);
  if (!name || !phone) throw new HttpError(400, 'الاسم ورقم الجوال مطلوبان لطلب التواصل');
  const t = now();
  const status = row.status === 'draft' ? 'new' : row.status;
  await env.DB.prepare('UPDATE customer_designs_exp SET customer_name = ?, customer_phone = ?, contact_requested = 1, status = ?, updated_at = ? WHERE id = ?')
    .bind(name, phone, status, t, row.id).run();
  return { ok: true };
}

/* ------------------------------ تصاميم العملاء (موظفون) ------------------------------ */
async function listDesigns(env) {
  const r = await env.DB.prepare('SELECT id, public_no, status, customer_name, customer_phone, contact_requested, order_id, order_number, created_at, updated_at FROM customer_designs ORDER BY updated_at DESC LIMIT 500').all();
  return r.results.map((row) => ({
    id: row.id,
    number: row.public_no ? 'MJ-' + row.public_no : 'مسودة',
    status: row.status,
    name: row.customer_name || '',
    phone: row.customer_phone || '',
    contactRequested: !!row.contact_requested,
    orderId: row.order_id || null,
    orderNumber: row.order_number == null ? null : Number(row.order_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function getDesign(env, id) {
  if (typeof id !== 'string' || !id) throw new HttpError(404, 'التصميم غير موجود');
  const row = await env.DB.prepare('SELECT * FROM customer_designs WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'التصميم غير موجود');
  return portalPublic(row);
}

async function updateDesign(env, id, body) {
  const row = await getDesign(env, id);
  const t = now();
  let status = row.status;
  if (body.status !== undefined) {
    if (!DESIGN_STATUSES.includes(body.status)) throw new HttpError(400, 'حالة غير صالحة');
    if (row.status === 'converted' && body.status !== 'converted' && body.status !== 'closed') {
      throw new HttpError(400, 'التصميم المحوَّل لطلب لا يعاد فتحه');
    }
    status = body.status;
  }
  let design = row.design;
  if (body.design !== undefined) { checkDesign(body.design); design = body.design; }
  await env.DB.prepare('UPDATE customer_designs SET status = ?, design = ?, updated_at = ? WHERE id = ?')
    .bind(status, JSON.stringify(design), t, row.id).run();
  return Object.assign({ ok: true }, portalPublic(Object.assign({}, row, { status, design: JSON.stringify(design), updated_at: t })));
}

/* حذف تصميم واحد: يزيل صفّه من بوابة العميل فقط.
   إن كان محوَّلاً لطلب فالطلب يحتفظ بنسخته المستقلة (design + fromDesignNo)،
   فالحذف لا يمس الطلب ولا أي بيانات مالية — ويُبلَّغ الواجهة بذلك لتُحذّر. */
async function deleteDesign(env, id, user) {
  const row = await getDesign(env, id);
  const t = now();
  await env.DB.prepare('DELETE FROM customer_designs WHERE id = ?').bind(row.id).run();
  const ev = { id: uid(), at: t, action: 'design-delete', userId: user.id, userName: user.name, designNo: row.number, orderNo: row.orderNumber || null, details: ['حذف تصميم ' + (row.number || '')] };
  await env.DB.prepare('INSERT INTO activity (id, at, data) VALUES (?, ?, ?)').bind(ev.id, t, JSON.stringify(ev)).run();
  return { ok: true, id: row.id, hadOrder: !!row.orderId, orderNumber: row.orderNumber || null };
}

/* حذف جملة: يتخطّى غير الموجود بصمت (سباق مع حذف فردي) ويسجّل حدثاً واحداً */
async function bulkDeleteDesigns(env, body, user) {
  const raw = Array.isArray(body && body.ids) ? body.ids : [];
  const ids = raw.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 200);
  if (!ids.length) throw new HttpError(400, 'لم يُحدَّد أي تصميم للحذف');
  const t = now();
  await env.DB.batch(ids.map((id) => env.DB.prepare('DELETE FROM customer_designs WHERE id = ?').bind(id)));
  const ev = { id: uid(), at: t, action: 'design-delete', userId: user.id, userName: user.name, details: ['حذف ' + ids.length + ' تصميم'] };
  await env.DB.prepare('INSERT INTO activity (id, at, data) VALUES (?, ?, ?)').bind(ev.id, t, JSON.stringify(ev)).run();
  return { ok: true, requested: ids.length, deleted: ids.length };
}

/* التحويل لطلب: صف طلب مالي جديد + ربط، والأصل محفوظ لا يُمسّ ولا يُحذف */
async function convertDesign(env, id, user) {
  const row = await getDesign(env, id);
  if (row.orderId) throw new HttpError(400, 'هذا التصميم محوَّل مسبقاً');
  const s = await shopSettings(env);
  const t = now();
  const r = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE key = 'order_no' RETURNING value").first();
  if (!r) throw new HttpError(500, 'عدّاد أرقام الطلبات غير موجود');
  const number = Number(r.value);
  const rec = {
    id: uid(),
    number,
    status: 'new',
    customer: { name: row.name || '', phone: row.phone || '' },
    design: row.design || emptyDesign(),
    payments: [],
    manualRows: [],
    discount: 0,
    subtotal: 0, vatAmount: 0, total: 0, paid: 0, remaining: 0,
    vat: { enabled: s.vatEnabled !== false, rate: Number(s.vatRate) || 0 },
    createdAt: t, updatedAt: t,
    createdBy: user.id, createdByName: user.name,
    fromDesignId: row.id, fromDesignNo: row.number,
  };
  checkOrderFin(rec);
  const data = JSON.stringify(rec);
  const actEv = { id: uid(), at: t, action: 'design-convert', userId: user.id, userName: user.name, orderId: rec.id, orderNo: number, customer: rec.customer.name || '', total: 0, details: ['تحويل من تصميم ' + (row.number || '')] };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orders (id, number, status, customer_name, created_by, created_at, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(rec.id, number, 'new', rec.customer.name || '', user.id, t, data, t),
    env.DB.prepare('UPDATE customer_designs SET order_id = ?, order_number = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(rec.id, number, 'converted', t, row.id),
    env.DB.prepare('INSERT INTO activity (id, at, data) VALUES (?, ?, ?)').bind(actEv.id, t, JSON.stringify(actEv)),
  ]);
  return { ok: true, orderId: rec.id, number };
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
  // نجاح الدخول يمسح عدّاد اسم المستخدم **و** عدّاد العنوان معاً: فبدون ذلك يبقى
  // فشل مستخدمين آخرين على نفس الشبكة (wifi المكتب/الجوال) متراكماً ويُقفل دخول
  // الجميع من العنوان نفسه رغم صحة كلمة مرورهم.
  await env.DB.batch(keys.map((k) => env.DB.prepare('DELETE FROM login_fail WHERE k = ?').bind(k)));
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
    // روابط التسويق لبوابة العميل: HTTPS فقط بلا مسافات ولا أقواس، والوصف نص قصير
    for (const f of ['mapsUrl', 'whatsapp', 'tiktok', 'instagram', 'snapchat', 'logoUrl']) {
      const v = body.settings[f];
      if (v !== undefined && v !== null && v !== '') {
        if (typeof v !== 'string' || !/^https:\/\//i.test(v.trim()) || /[\s<>"]/.test(v) || v.length > 500) finErr('settings.' + f);
      }
    }
    if (body.settings.tagline !== undefined && body.settings.tagline !== null && (typeof body.settings.tagline !== 'string' || body.settings.tagline.length > 140)) {
      finErr('settings.tagline');
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
/* ---------------- إحصاءات زيارات روابط «عن التطبيق» ----------------
   تُسجَّل الزيارات على الخادم عند تقديم صفحات الزوار العامة (بوابة العميل
   والتصميم الموسّع). تُستثنى واجهة الموظفين (تحتاج جلسة) والروبوتات.
   العدّ يومي مجمّع (day, link) — لا يُخزَّن أي IP ولا بيانات شخصية. */
const VISIT_LINKS = {
  customer: 'بوابة العميل',
  expanded: 'التصميم الموسّع',
};
// روبوتات/مكشّفون شائعون لا تُعدّ زياراتهم (تفقد الدقة إن استُثنوا، فلا تبالَغ)
const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|discordbot|curl\/|wget|python-requests|headlesschrome|lighthouse|uptime|monitor|preview|scrapy|semrush|ahrefs|petalbot|applebot|ia_archiver|semrushbot/i;

/* المنطقة الزمنية: يوم الرياض (UTC+3). كل حدود الفترات تُحسب بتوقيت المحل،
   لا UTC — وإلا انزلق حدّ «اليوم» و«آخر ٧ أيام» بساعة أو ثلث يوم. */
function visitTzOffset(env) { return Number(env && env.VISIT_TZ_OFFSET_MIN) || 180; }

function visitDayKey(env, ts) {
  return new Date((ts || Date.now()) + visitTzOffset(env) * 60000).toISOString().slice(0, 10);
}
/** تاريخ اليوم قبل N يوماً بتوقيت المحل — يُستخدم لحدود الفترات */
function visitDayOffset(env, daysAgo) {
  const t = Date.now() - (Number(daysAgo) || 0) * 86400000;
  return visitDayKey(env, t);
}
/* بصمة زائر مجزّأة: تُبنى من IP + User-Agent + اليوم ثم تُجزّأ بـ SHA-256.
   لا يُخزَّن أي عنوان IP ولا مُعرّف جهاز — بصمة يومية فقط، تنتهي صلاحيتها مع اليوم،
   فلا يمكن التعرّف على شخص من سجل سابق. */
async function visitorFingerprint(request, day) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  const ua = request.headers.get('user-agent') || '';
  const salt = 'majlis-visit-v1|' + day + '|' + ip + '|' + ua;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt));
  return Array.from(new Uint8Array(buf)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** تسجيل زيارة رابط (تجاهل الروبوتات؛ الأخطاء لا تُفشل تقديم الصفحة) */
async function recordVisit(env, request, link) {
  try {
    if (!env.DB || !VISIT_LINKS[link]) return;
    // ضمان الجداول محلياً: لا نعتمد على ensureSeed لأنه قد يتوقف عند خطأ غير متعلق
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS link_visits (day TEXT NOT NULL, link TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, link))').run().catch(ignoreExistsObject);
  /* زوار فريدون: بصمة مجزّأة لكل (يوم، رابط) — تميّز «زائر واحد مرتين» عن «زيارتين».
     لا تُخزَّن عناوين IP ولا مُعرّفات الأجهزة؛ البصمة مشتقة من اليوم فينتهي أثرها مع اليوم.
     يُحذف ما قبل ٤٠ يوماً عند كل تسجيل فلا ينمو الجدول بلا سقف. */
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS link_visitors (day TEXT NOT NULL, link TEXT NOT NULL, fp TEXT NOT NULL, PRIMARY KEY (day, link, fp))').run().catch(ignoreExistsObject);
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS link_visitors (day TEXT NOT NULL, link TEXT NOT NULL, fp TEXT NOT NULL, PRIMARY KEY (day, link, fp))').run().catch(ignoreExistsObject);
    const ua = (request.headers.get('user-agent') || '');
    if (!ua || BOT_RE.test(ua)) return;
    const day = visitDayKey(env);
    // زائر فريد: بصمة اليوم — تحديث الصفحة لا يُنشئ زائراً جديداً لنفس الجهاز
    const fp = await visitorFingerprint(request, day);
    await env.DB.prepare('INSERT OR IGNORE INTO link_visitors (day, link, fp) VALUES (?, ?, ?)').bind(day, link, fp).run();
    // نمط upsert محمول: قراءة الزيادة ثم INSERT OR REPLACE (بدل ON CONFLICT المدعوم في D1 فقط)
    const cur = await env.DB.prepare('SELECT n FROM link_visits WHERE day = ? AND link = ?').bind(day, link).first();
    const next = (Number(cur && cur.n) || 0) + 1;
    await env.DB.prepare('INSERT OR REPLACE INTO link_visits (day, link, n) VALUES (?, ?, ?)').bind(day, link, next).run();
    // تنظيف دوري: بصمة اليوم تكفي للفترات المطلوبة فلا ينمو الجدول بلا سقف
    await env.DB.prepare('DELETE FROM link_visitors WHERE day < ?').bind(visitDayOffset(env, 40)).run();
  } catch (e) { console.warn('recordVisit failed:', e && e.message); /* إحصاء لا يعطّل الخدمة */ }
}

/** قراءة الإحصاءات للمدير: إجمالي لكل رابط + تفصيل آخر ٣٠ يوماً */
/* ======================= تحليلات لوحة المالك =======================
   مبدأ الخصوصية قبل كل شيء: ما يُخزَّن هو «عداد مجمّع» فقط:
     day + اسم الحدث + بُعد اختياري + رقم.
   لا اسم عميل، ولا رقم جوال، ولا عنوان IP، ولا بصمة جهاز، ولا مُعرّف جلسة،
   ولا محتوى محادثة. لا يوجد في الجدول ما يصلح لربط أي حدث بهوية أحد.
   الأثر قد يكون فقط عددياً-يومياً، ولا يُستخدم للتسويق ولا لتتبّع الأفراد.

الأحداث المسجَّلة قليلة ومقصودة — وكلها أحداث يختارها المضيف حتى نعرف أين يتوقف:
     design_visit     فتح صفحة التصميم
     design_start     بدأ تصميماً جديداً
     design_step      وصل إلى مرحلة (البُعد = رقم المرحلة)
     design_step_exit غادر مرحلة (البُعد = رقم المرحلة)
     design_finish    أكمل التصميم
     whatsapp_click   ضغط زر واتساب
     design_sent      أرسل التصميم
     contact_request  طلب التواصل
   لا نسجّل حركة عنصر صغيرة ولا كل نقرة أداة. */

const ANALYTICS_KEEP_DAYS = 400;   // احتفاظ محدود: صف واحد لكل يوم/حدث/بُعد
/* بُعد نصي قصير ومُطبَّع حتى لا يملأ الجدول من مُدخلات عشوائية */
function analyticsDim(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '');
  return s.slice(0, 40);
}

async function ensureAnalytics(env) {
  if (!env.DB) return false;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS analytics_events (day TEXT NOT NULL, name TEXT NOT NULL, dim TEXT NOT NULL DEFAULT \'\', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name, dim))').run().catch(ignoreExistsObject);
  return true;
}

/** زيادة عدّاد مجمّع. اسمح فقط بأسماء معرّفة مسبقاً (قائمة بيضاء) وأبعاد قصيرة. */
const ANALYTICS_NAMES = new Set([
  'design_visit', 'design_start', 'design_step', 'design_step_exit', 'design_finish',
  'whatsapp_click', 'design_sent', 'contact_request',
]);

async function recordAnalytics(env, request, name, dim) {
  try {
    if (!env.DB || !ANALYTICS_NAMES.has(name)) return;
    const ua = (request.headers.get('user-agent') || '');
    if (!ua || BOT_RE.test(ua)) return;      // نتجاهل الروبوتات كما في الزيارات
    // الجدول قد لا يكون موجوداً بعد: أول زائر بعد النشر يكتب قبل أن يفتح المالك
    // اللوحة، فبدون هذا السطر يفشل الإدراج ويُبتلَع بصمت تضيع كل الأحداث الأولى.
    await ensureAnalytics(env);
    const day = visitDayKey(env);
    const d = analyticsDim(dim);
    const cur = await env.DB.prepare('SELECT n FROM analytics_events WHERE day = ? AND name = ? AND dim = ?').bind(day, name, d).first();
    const next = (Number(cur && cur.n) || 0) + 1;
    await env.DB.prepare('INSERT OR REPLACE INTO analytics_events (day, name, dim, n) VALUES (?, ?, ?, ?)').bind(day, name, d, next).run();
    // تنظيف دوري: العدّاد اليومي يكفي للفترات المطلوبة فلا ينمو الجدول بلا سقف
    await env.DB.prepare('DELETE FROM analytics_events WHERE day < ?').bind(visitDayOffset(env, ANALYTICS_KEEP_DAYS)).run();
  } catch (e) { /* إحصاء لا يعطّل الخدمة */ }
}

/** استقبال حدث تحليلات من الواجهة العامة.
    يتجاهل أي حقل لا يحتاجه: لا اسم ولا جوال ولا مُعرّف. يقبل الاسم والبُعد فقط
    ضمن قائمة بيضاء، فلا يمكن استغلاله لتخزين بيانات شخصية. */
async function analyticsEvent(env, request, body) {
  const name = String((body && body.name) || '');
  const dim = String((body && body.dim) || '');
  await recordAnalytics(env, request, name, dim);
  return { ok: true };
}

/** قراءة مجمّعة ضمن نطاق. لا تُرجع شيئاً يربط بهوية أحد. */
async function analyticsSum(env, from, to, name) {
  await ensureAnalytics(env);
  let sql = 'SELECT COALESCE(SUM(n),0) AS n FROM analytics_events WHERE name = ?';
  const binds = [name];
  if (from) { sql += ' AND day >= ?'; binds.push(from); }
  if (to) { sql += ' AND day <= ?'; binds.push(to); }
  const r = await env.DB.prepare(sql).bind(...binds).first();
  return Number(r && r.n) || 0;
}

/** تجميع الأبعاد: مصفوفة { dim, n } مرتّبة تنازلياً. */
async function analyticsByDim(env, from, to, name, limit = 20) {
  await ensureAnalytics(env);
  let sql = 'SELECT dim, COALESCE(SUM(n),0) AS n FROM analytics_events WHERE name = ?';
  const binds = [name];
  if (from) { sql += ' AND day >= ?'; binds.push(from); }
  if (to) { sql += ' AND day <= ?'; binds.push(to); }
  sql += ' GROUP BY dim ORDER BY n DESC, dim ASC LIMIT ?';
  binds.push(Number(limit) || 20);
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return (r.results || []).map((x) => ({ dim: x.dim, n: Number(x.n) || 0 }));
}

/** سلسلة يومية لحث حدث (للرسوم البيانية). */
async function analyticsDaily(env, from, to, names) {
  await ensureAnalytics(env);
  const list = names && names.length ? names : ['design_start', 'design_finish'];
  const ph = list.map(() => '?').join(',');
  let sql = 'SELECT day, name, COALESCE(SUM(n),0) AS n FROM analytics_events WHERE name IN (' + ph + ')';
  const binds = list.slice();
  if (from) { sql += ' AND day >= ?'; binds.push(from); }
  if (to) { sql += ' AND day <= ?'; binds.push(to); }
  sql += ' GROUP BY day, name';
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return (r.results || []).map((x) => ({ day: x.day, name: x.name, n: Number(x.n) || 0 }));
}

/** متوسط مدة التصميم بالدقائق، من created_at إلى updated_at للتصاميم المكتملة. */
async function analyticsAvgDurationMin(env, from, to) {
  let sql = "SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24 * 60) AS m FROM customer_designs WHERE updated_at IS NOT NULL AND status != 'draft'";
  const binds = [];
  if (from) { sql += ' AND date(created_at) >= ?'; binds.push(from); }
  if (to) { sql += ' AND date(created_at) <= ?'; binds.push(to); }
  const r = await env.DB.prepare(sql).bind(...binds).first();
  /* Number(null) = 0 — لوحوّلنا النقص إلى صفر لعرضنا مدةً مُختلقة. غياب البيانات
     يجب أن يُقرأ «غير متاح» (null) لا «صفر دقيقة». */
  if (!r || r.m === null || r.m === undefined) return null;
  const m = Number(r.m);
  return Number.isFinite(m) && m >= 0 ? Math.round(m) : null;
}

/** مسار التحويل: زيارة ← بدء ← إكمال ← واتساب ← طلب مؤكد.
    كل مقام صحيح ومكتوب صراحة. «واتساب» = ضغط الزر فقط، ليس رسالة مُرسلة ولا طلباً. */
async function analyticsFunnel(env, from, to) {
  const visits = await analyticsSum(env, from, to, 'design_visit');
  const started = await analyticsSum(env, from, to, 'design_start');
  const finished = await analyticsSum(env, from, to, 'design_finish');
  const wa = await analyticsSum(env, from, to, 'whatsapp_click');
  const sent = await analyticsSum(env, from, to, 'design_sent');
  /* الطلب المؤكد من جدول customer_designs عبر order_id (ربط فعلي موجود). */
  let ordersSql = 'SELECT COUNT(DISTINCT id) AS n FROM customer_designs WHERE order_id IS NOT NULL';
  const ob = [];
  if (from) { ordersSql += ' AND date(created_at) >= ?'; ob.push(from); }
  if (to) { ordersSql += ' AND date(created_at) <= ?'; ob.push(to); }
  const orow = await env.DB.prepare(ordersSql).bind(...ob).first();
  const orders = Number(orow && orow.n) || 0;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    steps: [
      { key: 'visit', label: 'زيارة', n: visits, rate: null },
      { key: 'start', label: 'بدء تصميم', n: started, rate: pct(started, visits) },
      { key: 'finish', label: 'إكمال التصميم', n: finished, rate: pct(finished, started) },
      /* واتساب والإرسال مقامُهما من بدأ التصميم لا من أكمله: من يضغط زر واتساب قد
         لا يمرّ خطوة الإكمال، فقياسه على «من أكمل» يعطي نسبة فوق 100% وهمية. */
      { key: 'whatsapp', label: 'ضغط واتساب', n: wa, rate: pct(wa, started) },
      { key: 'sent', label: 'إرسال التصميم', n: sent, rate: pct(sent, started) },
      { key: 'order', label: 'طلب مؤكد', n: orders, rate: pct(orders, started) },
    ],
    note: 'كل النسب من «بدء التصميم» إلا بداية السلّم. «ضغط واتساب» ضغطة زر فقط، لا يعني إرسال رسالة ولا إتمام بيع.',
  };
}

/** تفضيلات التصميم المجمّعة من حقول design المخزّنة أصلاً. */
async function analyticsDesignPrefs(env, from, to, limit = 12) {
  let sql = "SELECT design FROM customer_designs WHERE design IS NOT NULL AND design != ''";
  const binds = [];
  if (from) { sql += ' AND date(created_at) >= ?'; binds.push(from); }
  if (to) { sql += ' AND date(created_at) <= ?'; binds.push(to); }
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const agg = {
    designs: 0, rooms: {}, walls: {}, sofaKinds: {}, accKinds: {},
    pieceCountSum: 0, pieceCountN: 0, sofaDepth: {}, accent: {},
  };
  for (const r of (rows.results || [])) {
    let d = null;
    try { d = JSON.parse(r.design); } catch (_) { continue; }
    if (!d || typeof d !== 'object') continue;
    agg.designs++;
    const walls = Array.isArray(d.walls) ? d.walls : [];
    agg.walls[String(walls.length || 0)] = (agg.walls[String(walls.length || 0)] || 0) + 1;
    const rd = d.roomDims || null;
    if (rd && Number.isFinite(+rd.w) && Number.isFinite(+rd.h)) {
      const k = round1(+rd.w) + '×' + round1(+rd.h);
      agg.rooms[k] = (agg.rooms[k] || 0) + 1;
    }
    const pieces = Array.isArray(d.pieces) ? d.pieces : [];
    let nSofa = 0;
    for (const p of pieces) {
      if (!p || typeof p !== 'object') continue;
      if (p.kind === 'sofa') {
        nSofa++;
        const sk = String(p.seating || 'floor');
        agg.sofaKinds[sk] = (agg.sofaKinds[sk] || 0) + 1;
        if (Number.isFinite(+p.h)) {
          const dp = String(round1(+p.h));
          agg.sofaDepth[dp] = (agg.sofaDepth[dp] || 0) + 1;
        }
      } else if (p.kind === 'acc' && p.itemId) {
        agg.accKinds[String(p.itemId)] = (agg.accKinds[String(p.itemId)] || 0) + 1;
      }
    }
    if (nSofa > 0) { agg.pieceCountSum += nSofa; agg.pieceCountN++; }
  }
  const top = (obj) => Object.keys(obj).map((dim) => ({ dim, n: obj[dim] })).sort((a, b) => b.n - a.n).slice(0, limit);
  return {
    designs: agg.designs,
    rooms: top(agg.rooms),
    walls: top(agg.walls),
    sofaKinds: top(agg.sofaKinds),
    accKinds: top(agg.accKinds),
    sofaDepth: top(agg.sofaDepth),
    avgSofaPieces: agg.pieceCountN ? Math.round((agg.pieceCountSum / agg.pieceCountN) * 10) / 10 : null,
    avgSofaPiecesSample: agg.pieceCountN,
  };
}

function round1(n) { return Math.round(Number(n) * 10) / 10; }

/** متابعة الطلبات: مراحل الطلب من جدول orders + أسباب الخسارة المسجّلة داخلياً فقط. */
async function analyticsOrders(env, from, to) {
  let sql = 'SELECT data, status, created_at FROM orders';
  const binds = [];
  const where = [];
  if (from) { where.push('date(created_at) >= ?'); binds.push(from); }
  if (to) { where.push('date(created_at) <= ?'); binds.push(to); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const byStatus = {};
  const lossReasons = {};
  let total = 0;
  for (const r of (rows.results || [])) {
    total++;
    const st = String(r.status || 'unknown');
    byStatus[st] = (byStatus[st] || 0) + 1;
    let d = null;
    try { d = JSON.parse(r.data); } catch (_) { /* قد لا يكون JSON */ }
    /* أسباب الخسارة إن سجّلها الموظف داخل الطلب — لا نطلبها من العميل */
    const reason = d && (d.lossReason || d.lostReason || (d.lost && d.lost.reason));
    if (reason) {
      const k = String(reason).slice(0, 60);
      lossReasons[k] = (lossReasons[k] || 0) + 1;
    }
  }
  const top = (obj) => Object.keys(obj).map((dim) => ({ dim, n: obj[dim] })).sort((a, b) => b.n - a.n);
  return { total, byStatus: top(byStatus), lossReasons: top(lossReasons), lossReasonsAvailable: top(lossReasons).length > 0 };
}

/**
 * لوحة التحليلات للمدير فقط. تتضمّن كل المؤشرات وتوضّح ما هو غير متوفر.
 * تعتمد على مصادر موجودة فعلياً في النظام ولا تخترع أي رقم.
 */
async function ownerAnalytics(env, query) {
  const today = visitDayKey(env);
  const range = String(query.get('range') || 'd30');
  let from = visitDayOffset(env, 29), to = today;
  if (range === 'd7') from = visitDayOffset(env, 6);
  else if (range === 'd') from = today;
  else if (range === 'm') { const d = new Date(); from = visitDayKeyOf(env, new Date(d.getFullYear(), d.getMonth(), 1)); }
  else if (range === 'custom') {
    const f = String(query.get('from') || ''), t = String(query.get('to') || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) from = f;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) to = t;
  }

  // الزوار والزيارات من جدول الزوار القائم (مصدر موثوق قائم)
  const visRow = await env.DB.prepare(
    'SELECT COALESCE(SUM(CASE WHEN day >= ? AND day <= ? THEN n ELSE 0 END),0) AS visits FROM link_visits'
  ).bind(from, to).first();
  const uvRow = await env.DB.prepare(
    'SELECT COUNT(*) AS u FROM link_visitors WHERE day >= ? AND day <= ?'
  ).bind(from, to).first();

  const daily = await analyticsDaily(env, from, to, ['design_start', 'design_finish']);
  const funnel = await analyticsFunnel(env, from, to);
  const stepReached = await analyticsByDim(env, from, to, 'design_step', 10);
  const stepExit = await analyticsByDim(env, from, to, 'design_step_exit', 10);
  const prefs = await analyticsDesignPrefs(env, from, to, 12);
  const orders = await analyticsOrders(env, from, to);
  const avgDur = await analyticsAvgDurationMin(env, from, to);

  return {
    ok: true,
    range, from, to, tzOffsetMin: visitTzOffset(env),
    /* مؤشرات متاحة فعلاً */
    visits: Number(visRow && visRow.visits) || 0,
    uniqueVisitors: Number(uvRow && uvRow.u) || 0,
    avgDesignMin: avgDur,
    funnel,
    daily,
    stepReached,
    stepExit,
    prefs,
    orders,
    /* توثيق الفجوات: أرقام غير متاحة، لا نعرض لها قيماً */
    unavailable: {
      referrer: 'مصدر الزيارة غير متوفر — لا نخزّن عنوان المُحيل ولا مُعرّف Cloak.',
      whatsappSent: 'لا نعرف إن كانت رسالة واتساب أُرسلت فعلاً — نسجّل ضغطة الزر فقط.',
      revenue: 'قيمة المبيعات تُقرأ من الطلبات الموثّقة فقط.',
      deviceFingerprint: 'لا بصمة جهاز ولا تتبّع أفراد في التحليلات.',
    },
  };
}
function visitDayKeyOf(env, d) {
  const off = visitTzOffset(env);
  const t = new Date(d.getTime() + off * 60000);
  return t.toISOString().slice(0, 10);
}


/** إحصاءات الروابط للمدير — ثلاثة نطاقات زمنية واضحة، كلها بتوقيت المحل:
    اليوم / آخر ٧ أيام / آخر ٣٠ يوماً. لكل نطاق رقمان مستقلان:
    «زيارات» (كل فتح للصفحة) و«زوار» (بصمة جهاز واحدة لا تُحتسب مرتين في اليوم).
    لا أرقام وهمية: كل قيمة مجموع فعلي من السجلات، وغياب البيانات يعطي صفراً. */
/** إحصاءات الروابط للمدير — ثلاثة نطاقات زمنية واضحة، كلها بتوقيت المحل:
    اليوم / آخر ٧ أيام / آخر ٣٠ يوماً. لكل نطاق رقمان مستقلان:
    «زيارات» (كل فتح للصفحة) و«زوار» (بصمة جهاز واحدة لا تُحتسب مرتين في اليوم).
    لا أرقام وهمية: كل قيمة مجموع فعلي من السجلات وغياب البيانات = صفر. */
async function linkVisits(env) {
  const today = visitDayKey(env);
  const d7 = visitDayOffset(env, 6);    // اليوم + ٦ أيام سابقة = ٧ أيام تقويمية
  const d30 = visitDayOffset(env, 29);  // اليوم + ٢٩ يوماً سابقاً = ٣٠ يوماً تقويمية
  const vis = await env.DB.prepare(
    `SELECT link,
       COALESCE(SUM(CASE WHEN day = ? THEN n ELSE 0 END), 0) AS today_n,
       COALESCE(SUM(CASE WHEN day >= ? THEN n ELSE 0 END), 0) AS d7_n,
       COALESCE(SUM(CASE WHEN day >= ? THEN n ELSE 0 END), 0) AS d30_n,
       COALESCE(SUM(n), 0) AS all_n
     FROM link_visits GROUP BY link`).bind(today, d7, d30).all();
  const uq = await env.DB.prepare(
    `SELECT link,
       COALESCE(SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), 0) AS today_u,
       COALESCE(SUM(CASE WHEN day >= ? THEN 1 ELSE 0 END), 0) AS d7_u,
       COALESCE(SUM(CASE WHEN day >= ? THEN 1 ELSE 0 END), 0) AS d30_u
     FROM link_visitors WHERE day >= ? GROUP BY link`).bind(today, d7, d30, d30).all();
  const days = await env.DB.prepare('SELECT day, link, SUM(n) AS n FROM link_visits WHERE day >= ? GROUP BY day, link').bind(d30).all();
  const blank = () => ({ today: { visits: 0, visitors: 0 }, d7: { visits: 0, visitors: 0 }, d30: { visits: 0, visitors: 0 }, all: 0, days: [] });
  const byLink = {};
  for (const r of (vis.results || [])) {
    const k = byLink[r.link] || (byLink[r.link] = blank());
    k.today.visits = Number(r.today_n) || 0;
    k.d7.visits = Number(r.d7_n) || 0;
    k.d30.visits = Number(r.d30_n) || 0;
    k.all = Number(r.all_n) || 0;
  }
  for (const r of (uq.results || [])) {
    const k = byLink[r.link] || (byLink[r.link] = blank());
    k.today.visitors = Number(r.today_u) || 0;
    k.d7.visitors = Number(r.d7_u) || 0;
    k.d30.visitors = Number(r.d30_u) || 0;
  }
  for (const r of (days.results || [])) {
    const k = byLink[r.link] || (byLink[r.link] = blank());
    k.days.push({ day: r.day, n: Number(r.n) || 0 });
  }
  for (const k of Object.keys(byLink)) byLink[k].days.sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    ok: true, links: VISIT_LINKS, byLink, today,
    tzOffsetMin: visitTzOffset(env),
    periods: { today: 'اليوم', d7: 'آخر ٧ أيام', d30: 'آخر ٣٠ يوماً' },
    note: 'الزيارات = كل فتح للصفحة. الزوار = بصمة جهاز واحدة في اليوم (لا تُحتسب مرتين). الروبوتات والطلبات بلا متصفح مستبعدة.',
  };
}



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
/* خطأ "الكائن موجود" متوقع أيضاً (جدول/فهرس مُنشأ مسبقاً) */
function ignoreExistsObject(e) {
  if (/already exists/i.test(String((e && e.message) || e || ''))) return;
  throw e;
}
async function ensureSeed(env) {
  if (seeded) return;
  /* جداول القياس تُنشأ أولاً لأنها لا تعتمد على أي جدول آخر: إن فشل أي تعديل
     أعمدة أدناه (قاعدة ناقصة/غير مهيّأة) لا يُسقط إنشاء جدول الزيارات. */
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS link_visits (day TEXT NOT NULL, link TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, link))').run().catch(ignoreExistsObject);
  // جداول وأعمدة جديدة بعد النشر الأول: تُنشأ هنا حتى لا يحتاج صاحب المحل إعادة تشغيل schema.sql
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS login_fail (k TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at TEXT NOT NULL, until TEXT)').run();
  /* ===== تحليلات لوحة المالك =====
     privacy-by-design: جدول «عداد» مجمّع فقط — لا اسم ولا جوال ولا عنوان IP ولا
     بصمة جهاز. المفتاح مركّب من (يوم، نوع الحدث، البُعد اختياري) والعداد رقم فقط.
     بهذا الشكل لا يمكن ربط أي حدث بهوية عميل من الجدول نفسه إطلاقاً، ولا يمكن
     استخدام البيانات للتسويق، ولا يتجاوز السجل عدداً ثابتاً من الصفوف. */
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS analytics_events (day TEXT NOT NULL, name TEXT NOT NULL, dim TEXT NOT NULL DEFAULT \'\', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name, dim))').run().catch(ignoreExistsObject);
  // أعمدة المندوب (هيكل متعدد المستويات ونسب العمولة)
  await env.DB.prepare('ALTER TABLE users ADD COLUMN parent_id TEXT').run().catch(ignoreExistsColumn);
  await env.DB.prepare('ALTER TABLE users ADD COLUMN rate REAL').run().catch(ignoreExistsColumn);
  await env.DB.prepare('ALTER TABLE users ADD COLUMN parent_rate REAL').run().catch(ignoreExistsColumn);
  // بوابة العميل: جدول مستقل تماماً عن الطلبات والمستخدمين (idempotent وآمن للتكرار)
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS customer_designs (id TEXT PRIMARY KEY, public_no INTEGER UNIQUE, token TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'draft', design TEXT NOT NULL, customer_name TEXT, customer_phone TEXT, contact_requested INTEGER NOT NULL DEFAULT 0, order_id TEXT, order_number INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT)").run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS designs_token_idx ON customer_designs(token)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS designs_public_idx ON customer_designs(public_no)').run();
  await env.DB.prepare("INSERT OR IGNORE INTO counters (key, value) VALUES ('design_no', 26000126)").run();
  /* التصميم الموسّع (تجريبي): جدول منفصل تماماً. يُنشأ بـ IF NOT EXISTS فلا يمسّ
     بيانات العملاء ولا يستهلك أرقام MJ ولا يظهر في صفحة تصاميم الموظفين.
     التوكن يبدأ بـ 'x' distinguishingه عن جدول البوابة العادية. */
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS customer_designs_exp (id TEXT PRIMARY KEY, public_no INTEGER UNIQUE, token TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'draft', design TEXT NOT NULL, customer_name TEXT, customer_phone TEXT, contact_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT)").run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS designs_exp_token_idx ON customer_designs_exp(token)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS designs_exp_public_idx ON customer_designs_exp(public_no)').run();
  await env.DB.prepare("INSERT OR IGNORE INTO counters (key, value) VALUES ('design_no_exp', 90000000)").run();
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
  /* مطابقة دقيقة فقط — بلا رجوع إلى index.html لأي مسار مجهول.
     كان السطر القديم: (key.includes('.') ? null : ASSETS['/index.html'])
     فيخدم واجهة الموظفين على أي مسار بلا نقطة (/foo، /anything …)، وهو تسريب
     لواجهة داخلية على رابط عشوائي. لا حاجة للرجوع: التطبيق بلا توجيه بالمسار
     ولا بالـ hash، وكل المسارات المشروعة إما أصول بالاسم أو تُعالَج قبل هذه الدالة
     (/ و /customer-design و /customer-design-expanded و /api/*). */
  const a = ASSETS[key] || ASSETS[key + '/index.html'];
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
