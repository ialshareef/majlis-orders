/* ======================================================================
   أصالة نجد | نظام إدارة طلبات المجالس — الخادم (Cloudflare Worker + D1)
   - يُلصق كاملاً في محرر الـ Worker في لوحة Cloudflare
   - يحتاج ربط قاعدة D1 باسم المتغيّر: DB   (Settings > Bindings > D1 database)
   - متغيّرات اختيارية: ALLOWED_ORIGIN (نطاق الواجهة بدل *)، PBKDF2_ITER (افتراضي 100000)
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

/* ------------------------------ Permission Manager (Phase 2: constants + resolver) ------------------------------ */
// الصلاحيات المعتمدة في النظام — المرجع الوحيد لأسماء الصلاحيات.
const PERMISSIONS = Object.freeze({
  'orders.view_own': true,
  'orders.view_all': true,
  'orders.create': true,
  'orders.edit_own': true,
  'orders.edit_all': true,
  'orders.delete_own': true,
  'orders.delete_all': true,
  'costs.view_own': true,
  'costs.view_all': true,
  'costs.add_own': true,
  'costs.add_all': true,
  'costs.edit_own': true,
  'costs.edit_all': true,
  'costs.delete_own': true,
  'costs.delete_all': true,
  'profit.view_own': true,
  'profit.view_all': true,
  'commission.view_own': true,
  'commission.view_all': true,
  'reports.view_own': true,
  'reports.view_all': true,
  'expenses.view_own': true,
  'expenses.view_all': true,
  'expenses.add_own': true,
  'expenses.add_all': true,
  'expenses.edit_own': true,
  'expenses.edit_all': true,
  'expenses.delete_own': true,
  'expenses.delete_all': true,
  'payments.add': true,
  'payments.edit': true,
  'payments.delete': true,
  'reports.export': true,
  'items.manage': true,
  'designs.view': true,
  'designs.edit': true,
  'designs.convert': true,
  'designs.delete': true,
  'users.view': true,
  'users.create': true,
  'users.edit': true,
  'users.disable': true,
  'permissions.manage': true,
  'settings.manage': true,
  'admin.core': true,
});

/* الإدارة الكاملة لمالك النظام وحده (لا لدور «مدير»):
   - المالك مستخدم واحد ثابت: معرّفه في متغير Cloudflare ‏OWNER_USER_ID (لا في القاعدة ولا في
     الدور)، فلا يغيّره API ولا مدير ولا مزامنة — تغييره يتطلب حساب Cloudflare نفسه.
     غير مضبوط/غير صالح = لا مالك (فشل مُغلق: لا أحد يملك الصلاحيات المحمية).
   - admin.core للمالك وحده ولا تُمنح لأحد.
   - البقية تُمنح من المالك لمدير عادي فقط (لا لموظف أو مندوب)، ويُعتدّ بالمنح فقط إن سجّله
     المالك نفسه (updated_by = المالك) — صف مزوَّر أو قديم لا يعطي شيئاً.
   users.* هنا لأن تعديل المستخدمين يغيّر الأدوار — منحها بلا قيد = ترقية النفس أو الغير. */
const ADMIN_ONLY_PERMISSIONS = Object.freeze(['admin.core', 'permissions.manage', 'users.create', 'users.edit', 'users.disable', 'settings.manage']);

/** معرّف المالك من البيئة فقط (نص مقصوص)، أو null */
function ownerIdOf(env) {
  const v = env && env.OWNER_USER_ID != null ? String(env.OWNER_USER_ID).trim() : '';
  return v || null;
}

// الدور يحدد صلاحياته الافتراضية؛ أي دور أو صلاحية غير معروفة => مرفوضة افتراضياً (default deny).
// الافتراضيات تطابق ما يتيحه التطبيق فعلاً للدور — لا تُمنح شاشة أو عملية جديدة تلقائياً،
// والمدير يضيف ما يريده لكل مستخدم من نافذة صلاحياته. المدير العادي: كل التشغيلي بلا الإدارة
// الكاملة؛ المالك: كل شيء (يُحسم في hasPerm بهويته لا بهذه القائمة).
const ROLE_PERMISSIONS = Object.freeze({
  admin: new Set(Object.keys(PERMISSIONS).filter((p) => !ADMIN_ONLY_PERMISSIONS.includes(p))),
  staff: new Set([
    'orders.view_own', 'orders.create', 'orders.edit_own',
    'costs.view_own', 'costs.add_own', 'costs.edit_own',
    'profit.view_own',
    'payments.add',
    'designs.view',
  ]),
  mandoub: new Set([
    'orders.view_own', 'orders.create', 'orders.edit_own',
    'costs.view_own', 'costs.add_own', 'costs.edit_own',
    'commission.view_own',
    'payments.add',
  ]),
});
// hasPerm: defaults + overrides; fail-closed on load failure.
function hasPerm(user, permission, overrides = null) {
  if (!user || typeof user !== "object") return false;
  if (typeof permission !== "string" || !Object.prototype.hasOwnProperty.call(PERMISSIONS, permission)) return false;
  const defaults = ROLE_PERMISSIONS[user.role];
  if (!defaults) return false;
  const active = (user.active === true || user.active === 1);
  if (!active) return false;

  let source = null;
  let grantedBy = null;
  let loadFailed = false;
  const holder = (overrides && typeof overrides === "object") ? overrides
    : (user.permissions && typeof user.permissions === "object") ? user.permissions : null;
  if (holder) {
    if (Object.prototype.hasOwnProperty.call(holder, "ok") && Object.prototype.hasOwnProperty.call(holder, "overrides")) {
      if (holder.ok !== true) loadFailed = true;
      source = (holder.overrides && typeof holder.overrides === "object") ? holder.overrides : {};
      grantedBy = (holder.grantedBy && typeof holder.grantedBy === "object") ? holder.grantedBy : null;
    } else {
      source = holder;
    }
  }

  if (loadFailed) return false;

  // المالك: كل الصلاحيات (هويته ثابتة من البيئة، ولا تقيّده تجاوزات قابلة للكتابة)
  const isOwner = user.isOwner === true && user.role === "admin";
  if (isOwner) return true;
  // admin.core للمالك وحده — لا تُمنح بأي تجاوز
  if (permission === "admin.core") return false;
  // بقية الإدارة الكاملة: لغير المدير ممنوعة دائماً؛ وللمدير العادي فقط بمنح صريح سجّله المالك
  if (ADMIN_ONLY_PERMISSIONS.includes(permission)) {
    if (user.role !== "admin" || !source || !user.ownerId) return false;
    const v = source[permission];
    const granted = v === true || v === 1 || v === "1" || v === "true";
    return granted && !!grantedBy && grantedBy[permission] === String(user.ownerId);
  }

  if (source && Object.prototype.hasOwnProperty.call(source, permission)) {
    const v = source[permission];
    if (v === false || v === 0 || v === "0" || v === "false") return false;
    if (v === true || v === 1 || v === "1" || v === "true") return true;
  }

  return defaults.has(permission);
}

function effectivePermissions(user, overrides = null) {
  const out = new Set();
  if (!user || typeof user !== "object") return out;
  // hasPerm يفسّر بنية التجاوزات (ومعها من سجّل كل منح) ويطبّق فشل التحميل المُغلق
  for (const p of Object.keys(PERMISSIONS)) {
    if (hasPerm(user, p, overrides)) out.add(p);
  }
  return out;
}

async function loadUserPermissions(env, userId) {
  if (!env || !env.DB || !userId) return { ok: false, overrides: {} };
  try {
    const r = await env.DB.prepare("SELECT permission, value, updated_by FROM user_permissions WHERE user_id = ?").bind(userId).all();
    const out = {};
    const grantedBy = {}; // من سجّل كل تجاوز — منح الإدارة الكاملة لا يُعتدّ به إلا من المالك
    for (const row of (r && r.results) || []) {
      if (Object.prototype.hasOwnProperty.call(PERMISSIONS, row.permission)) {
        out[row.permission] = (row.value === 1 || row.value === true);
        grantedBy[row.permission] = row.updated_by == null ? null : String(row.updated_by);
      }
    }
    return { ok: true, overrides: out, grantedBy };
  } catch (e) {
    return { ok: false, overrides: {} };
  }
}

// D2: central ownership check (ownership only; permissions are checked separately).
async function verifyOrderOwnership(env, user, orderId) {
  if (!user || typeof user !== "object" || typeof user.id !== "string" || user.id === "") {
    return { allowed: false, reason: "invalid_user", ownerId: null };
  }
  if (typeof orderId !== "string" || orderId === "") {
    return { allowed: false, reason: "invalid_order_id", ownerId: null };
  }
  if (!env || !env.DB || typeof env.DB.prepare !== "function") {
    return { allowed: false, reason: "db_error", ownerId: null };
  }
  try {
    const row = await env.DB.prepare("SELECT created_by FROM orders WHERE id = ?").bind(orderId).first();
    if (!row) return { allowed: false, reason: "not_found", ownerId: null };
    const ownerId = row.created_by;
    if (typeof ownerId !== "string" || ownerId === "") {
      return { allowed: false, reason: "invalid_owner", ownerId: null };
    }
    if (ownerId !== user.id) {
      return { allowed: false, reason: "not_owned", ownerId };
    }
    return { allowed: true, reason: "owned", ownerId };
  } catch (e) {
    return { allowed: false, reason: "db_error", ownerId: null };
  }
}

const PROTECTED_ADMIN_PERMISSIONS = Object.freeze(["admin.core"]);

export { PERMISSIONS, ROLE_PERMISSIONS, hasPerm, effectivePermissions, loadUserPermissions, verifyOrderOwnership, PROTECTED_ADMIN_PERMISSIONS, ADMIN_ONLY_PERMISSIONS, ownerIdOf };

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
  // استرداد حساب المالك: مغلق ما لم يضبط صاحب حساب Cloudflare سراً مؤقتاً (انظر ownerRecover)
  if (path === '/api/owner/recover' && method === 'POST') return ownerRecover(env, body, request);

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
  if (path === '/api/portal/ai-design' && method === 'POST') return portalAiDesign(env, request, body);

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

  // فرض تغيير كلمة المرور المؤقتة قبل أي طلب آخر (يبقى تغييرها وتسجيل الخروج فقط)
  if (user.must_change_password === 1 && path !== '/api/logout' && path !== '/api/change-password') {
    throw new HttpError(403, 'يجب تغيير كلمة المرور أولاً قبل المتابعة');
  }

  if (path === '/api/change-password' && method === 'POST') return changePassword(env, user, token, body);
  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return { ok: true };
  }
  if (path === '/api/bootstrap' && method === 'GET') return bootstrap(env, user);
  if (path === '/api/sync' && method === 'POST') return sync(env, user, body);
  if (path === '/api/next-order-no' && method === 'POST') { requirePerm(user, 'orders.create'); const r = await env.DB.prepare("UPDATE counters SET value = value + 1 WHERE key = 'order_no' RETURNING value").first();
    return { number: r ? r.value : null };
  }
  if (path === '/api/sync-order-seq' && method === 'POST') { requireAdmin(user); const m = await env.DB.prepare('SELECT COALESCE(MAX(number), 1000) AS m FROM orders').first();
    await env.DB.prepare("UPDATE counters SET value = ? WHERE key = 'order_no'").bind(Math.max(Number(m.m) || 1000, 1000)).run();
    return { ok: true };
  }
  if (path === '/api/users' && method === 'GET') { requirePerm(user, 'users.view'); return { users: await listUsers(env) }; }
  if (path === '/api/users' && method === 'POST') { if (body && body.id) requirePerm(user, 'users.edit'); else requirePerm(user, 'users.create'); return saveUser(env, user, body, token); }
  // --- صلاحيات المستخدم التفصيلية (مدير بصلاحيات permissions.manage) ---
  const mPerms = path.match(/^\/api\/users\/([^/]+)\/permissions$/);
  if (mPerms && method === 'GET') return getUserPermissions(env, user, decodeURIComponent(mPerms[1]));
  if (mPerms && method === 'POST') return saveUserPermissions(env, user, decodeURIComponent(mPerms[1]), body);
  if (mPerms && method === 'DELETE') return resetUserPermissions(env, user, decodeURIComponent(mPerms[1]), body);
  // زيارات الرابط ولوحة التحليل: للمدير فقط (بيانات التتبع لا تُعرض لغيره)
  if (path === '/api/link-visits' && method === 'GET') { requireAdmin(user); return linkVisits(env); }
  // لوحة تحليلات المالك: للمدير فقط على مستوى الخادم — الموظف والمندوب يُرفضان (403)
  if (path === '/api/owner-analytics' && method === 'GET') { requireAdmin(user); return ownerAnalytics(env, new URL(request.url).searchParams); }
  const mUser = path.match(/^\/api\/users\/([^/]+)$/);
  if (mUser && method === 'DELETE') { requirePerm(user, 'users.disable'); return deleteUser(env, user, decodeURIComponent(mUser[1])); }

  // تصاميم العملاء (بلا كشف للتوكن أبداً): العرض منفصل عن التعديل والتحويل والحذف
  if (path === '/api/designs' && method === 'GET') { requirePerm(user, 'designs.view'); return { designs: await listDesigns(env) }; }
  // حذف جملة: ids مصفوفة معرّفات. التحقق من الشكل والحدّ قبل التنفيذ.
  if (path === '/api/designs/bulk-delete' && method === 'POST') { requirePerm(user, 'designs.delete'); return bulkDeleteDesigns(env, body, user); }
  const mConv = path.match(/^\/api\/designs\/([^/]+)\/convert$/);
  if (mConv && method === 'POST') { requirePerm(user, 'designs.convert'); return convertDesign(env, decodeURIComponent(mConv[1]), user); }
  const mDes = path.match(/^\/api\/designs\/([^/]+)$/);
  if (mDes && method === 'GET') { requirePerm(user, 'designs.view'); return { design: await getDesign(env, decodeURIComponent(mDes[1])) }; }
  if (mDes && (method === 'PUT' || method === 'POST')) { requirePerm(user, 'designs.edit'); return updateDesign(env, decodeURIComponent(mDes[1]), body); }
  if (mDes && method === 'DELETE') { requirePerm(user, 'designs.delete'); return deleteDesign(env, decodeURIComponent(mDes[1]), user); }

  // --- المصروفات: ‎_own لمصروفاتك، ‎_all لمصروفات الجميع (الفحص الدقيق للملكية داخل كل دالة) ---
  if (path === '/api/expenses' && method === 'GET') { requireAnyPerm(user, ['expenses.view_own', 'expenses.view_all']); return listExpenses(env, user, new URL(request.url).searchParams); }
  if (path === '/api/expenses' && method === 'POST') { requireAnyPerm(user, ['expenses.add_own', 'expenses.add_all']); return saveExpense(env, user, body); }
  const mExp = path.match(/^\/api\/expenses\/([^/]+)$/);
  if (mExp && method === 'PUT') { requireAnyPerm(user, ['expenses.edit_own', 'expenses.edit_all']); return updateExpense(env, user, decodeURIComponent(mExp[1]), body); }
  if (mExp && method === 'DELETE') { requireAnyPerm(user, ['expenses.delete_own', 'expenses.delete_all']); return deleteExpense(env, user, decodeURIComponent(mExp[1])); }
  if (path === '/api/reports/expenses-summary' && method === 'GET') {
    requireAnyPerm(user, ['expenses.view_own', 'expenses.view_all']);
    return expensesSummary(env, user, new URL(request.url).searchParams);
  }

  // --- تقارير المناديب ---
  if (path === '/api/reports/mandoubs' && method === 'GET') { requirePerm(user, 'reports.view_all'); return mandoubsReport(env, user, new URL(request.url).searchParams); }
  // --- تقرير الطلبات والمدفوعات ---
  if (path === '/api/reports/orders-summary' && method === 'GET') { requireAnyPerm(user, ['reports.view_own', 'reports.view_all']); return ordersSummary(env, user, new URL(request.url).searchParams); }

  throw new HttpError(404, 'المسار غير موجود');
}

/* ------------------------------ بيانات تحديث التطبيق ------------------------------
   المصدر الرسمي الوحيد لملف APK هو إصدارات GitHub لهذا المستودع (HTTPS).
   الأولوية لمتغيّرات البيئة (تُضبط من لوحة Cloudflare):
     APP_UPDATE_VERSION  اسم الإصدار (مثال 1.0.13)
     APP_UPDATE_CODE     رقم البناء (مثال 10013) — يُقبل فقط إن وافق معادلة الإصدار
     APP_UPDATE_URL      رابط APK — يجب أن ينتهي بـ asalh-najd-<الإصدار>.apk ضمن مسار الإصدارات
     APP_UPDATE_SHA256   بصمة SHA-256 لنفس الإصدار (64 خانة hex)؛ غيابها = null
   وإلا تُستخدم القيم الافتراضية المضمّنة (UPDATE_FALLBACK_*) — تُحدَّث في إجراء
   نشر الإصدار بعد بناء APK والتحقق منه وحساب بصمته الفعلية (لا بصمة قبلها).
   اتساق صارم: بيانات جزئية أو متضاربة لا تُقدَّم كاستجابة سليمة —
   بصمة إصدار آخر لا تُستخدم مع إصدار آخر (null ترفض التنزيل)، ورابط لا يطابق
   الإصدار = apkUrl فارغ (التطبيق يعرض خطأ لا تنزيلًا خاطئاً).
   fail-closed: رابط خارج المسار الرسمي يُصفَّر، وبصمة فاسدة تُهمل (null)
   فيرفض التطبيق التنزيل بدل تثبيت ملف غير موثوق. */
const UPDATE_APK_ALLOW = 'https://github.com/ialshareef/majlis-orders/releases/download/';
const UPDATE_FALLBACK_VERSION = '1.0.76';
// بصمة asalh-najd-1.0.76.apk (إصدار GitHub v1.0.76، بناء CI الموقّع — مُتحقَّق منها بعد التنزيل:
// تطابق digest الإصدار، وversionName 1.0.76 وversionCode 10076، ونفس شهادة توقيع 1.0.75).
const UPDATE_FALLBACK_SHA256 = '859c4e9f07ae69dabf4624f0f8572bc2fd4ea14eca01d9b8e9473a687c1727d4';
const UPDATE_FALLBACK_NOTES = [
  'ملف PDF للطلب صفحة واحدة دائماً: التصميم وجدول الأثاث مع التسعير في الصفحة نفسها، والخط بحجمه الطبيعي',
  'المقاس يكبر تلقائياً (A4 ثم A3) حين يكثر المحتوى بدل تصغير النص، والملف أوضح عند التكبير والطباعة',
  'معاينة ملف PDF نفسه في صفحة تصميم العميل قبل الإنهاء',
];

function versionCodeOfName(v) {
  const p = String(v || '').split('.').map((n) => parseInt(n, 10));
  if (p.length >= 2 && p.every((n) => Number.isInteger(n) && n >= 0)) {
    return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0);
  }
  return 1;
}

function shaOk(s) { return /^[0-9a-f]{64}$/.test(String(s || '').trim().toLowerCase()); }

function appUpdateMeta(env) {
  const e = env || {};
  const envVer = String(e.APP_UPDATE_VERSION || '').trim();
  const usingEnv = !!envVer && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.\-]+)?$/.test(envVer);
  const versionName = usingEnv ? envVer : UPDATE_FALLBACK_VERSION;
  // رقم البناء يُشتق من اسم الإصدار بمعادلة الإصدار نفسها؛
  // APP_UPDATE_CODE يُقبل فقط إن وافق المعادلة (بيانات متضاربة = تُهمَل)
  const derivedCode = versionCodeOfName(versionName);
  let versionCode = Number(e.APP_UPDATE_CODE);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode !== derivedCode) {
    versionCode = derivedCode;
  }
  // الرابط: من البيئة إن كان متسقاً مع الإصدار، وإلا يُبنى من الإصدار؛
  // أي خيار لا ينتهي بـ asalh-najd-<الإصدار>.apk أو خارج المسار الرسمي = فارغ
  const envUrl = String(e.APP_UPDATE_URL || '').trim();
  const wantedUrl = envUrl || (UPDATE_APK_ALLOW + 'v' + versionName + '/asalh-najd-' + versionName + '.apk');
  let apkUrl = '';
  if (wantedUrl.startsWith(UPDATE_APK_ALLOW) && wantedUrl.endsWith('/asalh-najd-' + versionName + '.apk')) {
    apkUrl = wantedUrl;
  }
  // البصمة: من نفس الإصدار حصراً — إصدار البيئة بلا بصمة = null (لا تُستعمل
  // بصمة الافتراضي مع إصدار آخر)، وملاحظات الإصدار تُعرض فقط عند تطابقها
  let sha = null;
  const rawSha = usingEnv ? e.APP_UPDATE_SHA256 : UPDATE_FALLBACK_SHA256;
  if (shaOk(rawSha)) sha = String(rawSha).trim().toLowerCase();
  const notes = (!usingEnv || envVer === UPDATE_FALLBACK_VERSION) ? UPDATE_FALLBACK_NOTES.slice() : [];
  return {
    versionName,
    versionCode,
    apkUrl,
    sha256: sha,
    mandatory: false,
    releaseNotes: notes,
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
      aiDesign: { enabled: !!(env && env.AI_API_KEY && s.aiDesignEnabled !== false) },
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
      if (!['door', 'window', 'mashab', 'tv'].includes(o.type)) bad();
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

/* ------------------------------ مصمّم الذكاء الاصطناعي (AI) ------------------------------
   بوابة العميل الذكي: POST /api/portal/ai-design — لا يكتب شيئاً في قاعدة البيانات إلا عدّاد المعدل:
   - بحد أقصى 15 طلباً في الساعة لكل IP+توكن (يُخزَّن في login_fail)
   - يعمل فقط عند توفّر المفتاح السري: AI_API_KEY / AI_BASE_URL / AI_MODEL
   - يُقيَّد النص والرد بحدود قصوى ويمرّ عبر التحقق قبل الحفظ. */
const AI_TEXT_MAX = 3000;
const AI_HISTORY_MAX = 8;
const AI_SPEC_MAX = 20000;
const AI_CONTENT_MAX = 64000;
const AI_RATE_LIMIT = 15;

async function aiThrottle(env, request, token) {
  const ip = (request && request.headers.get('CF-Connecting-IP')) || 'unknown';
  const k = 'ai:' + ip + ':' + String(token || '').slice(0, 12);
  const t = now();
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const row = await env.DB.prepare('SELECT n, first_at FROM login_fail WHERE k = ?').bind(k).first();
  const n = row && row.first_at > hourAgo ? Number(row.n) + 1 : 1;
  const first = row && row.first_at > hourAgo ? row.first_at : t;
  if (n > AI_RATE_LIMIT) throw new HttpError(429, 'عدد طلبات التصميم الذكي كثير. حاول لاحقاً.');
  await env.DB.prepare('INSERT INTO login_fail (k, n, first_at, until) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = excluded.n, first_at = excluded.first_at, until = excluded.until')
    .bind(k, n, first, null).run();
}

function aiNum(v, lo, hi, dflt) {
  if (v == null || v === '') return dflt === undefined ? null : dflt;
  if (typeof v === 'string') v = v.replace(/[\u0660-\u0669]/g, (c) => c.charCodeAt(0) - 0x0660).replace(/[\u06F0-\u06F9]/g, (c) => c.charCodeAt(0) - 0x06F0);
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/\u066B/g, '.'));
  if (!Number.isFinite(n)) return dflt === undefined ? null : dflt;
  return Math.min(hi, Math.max(lo, n));
}

function aiStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

function aiSanitizeSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = {};
  const rw = aiNum(raw.roomW, 0.5, 30), rh = aiNum(raw.roomH, 0.5, 30);
  if (rw != null) s.roomW = rw;
  if (rh != null) s.roomH = rh;
  if (['floor', 'sofa', 'arabic', 'raised'].includes(raw.seating)) s.seating = raw.seating;
  const depth = aiNum(raw.depth, 0.3, 1.5);
  if (depth != null) s.depth = depth;
  const LIM = { door: [0.6, 2.5], window: [0.4, 4], tv: [0.8, 4], mashab: [0.6, 2.5] };
  for (const type of Object.keys(LIM)) {
    const o = raw[type];
    if (!o || typeof o !== 'object' || !Number.isInteger(o.wall) || o.wall < 0 || o.wall > 3) continue;
    const out = { wall: o.wall, w: aiNum(o.w, LIM[type][0], LIM[type][1], LIM[type][0]), side: o.side === 'end' ? 'end' : 'start' };
    const d = aiNum(o.distFromCorner, 0, 30);
    if (d != null && o.distFromCorner != null) out.distFromCorner = d;
    if (type === 'door') { out.swing = o.swing === 'out' ? 'out' : 'in'; out.hinge = o.hinge === 'left' ? 'left' : 'right'; }
    s[type] = out;
  }
  if (Array.isArray(raw.sofaWalls)) {
    const ws = [];
    for (const w of raw.sofaWalls) if (Number.isInteger(w) && w >= 0 && w <= 3 && ws.indexOf(w) < 0) ws.push(w);
    s.sofaWalls = ws.slice(0, 4);
  }
  if (raw.fabric != null && raw.fabric !== '') s.fabric = aiStr(raw.fabric, 60);
  if (raw.foam != null && raw.foam !== '') s.foam = aiStr(raw.foam, 60);
  if (Array.isArray(raw.accessories)) {
    const acc = [];
    for (const a of raw.accessories) {
      if (!a || typeof a !== 'object' || acc.length >= 12) continue;
      const name = aiStr(a.name, 60);
      if (!name) continue;
      acc.push({ name, qty: aiNum(a.qty, 1, 99, 1) });
    }
    s.accessories = acc;
  }
  const notes = aiStr(raw.notes, 400);
  if (notes) s.notes = notes;
  return s;
}

function aiSanitizeModelOut(parsed) {
  const out = { status: 'need_answers', note: '', questions: [], assumptions: [], issues: [], spec: null };
  if (!parsed || typeof parsed !== 'object') return out;
  out.status = ['ready', 'need_answers', 'invalid'].includes(parsed.status) ? parsed.status : 'need_answers';
  out.note = aiStr(parsed.note, 240).replace(/[`{}\[\]]/g, '');
  if (Array.isArray(parsed.questions)) {
    for (const q of parsed.questions) {
      if (out.questions.length >= 4) break;
      if (!q || typeof q !== 'object') continue;
      const text = aiStr(q.q, 300);
      if (!text) continue;
      const options = Array.isArray(q.options) ? q.options.slice(0, 4).map((x) => aiStr(x, 80)).filter(Boolean) : [];
      out.questions.push({ id: aiStr(q.id, 24) || 'q' + (out.questions.length + 1), q: text, options });
    }
  }
  if (Array.isArray(parsed.assumptions)) out.assumptions = parsed.assumptions.slice(0, 8).map((x) => aiStr(x, 200)).filter(Boolean);
  if (Array.isArray(parsed.issues)) out.issues = parsed.issues.slice(0, 6).map((x) => aiStr(x, 200)).filter(Boolean);
  out.spec = aiSanitizeSpec(parsed.spec);
  if (out.status === 'ready' && !out.spec) out.status = 'need_answers';
  return out;
}

async function aiCatalogBrief(env) {
  const brief = { fabrics: [], foams: [], accessories: [] };
  const specs = [
    { cat: 'fabric', key: 'fabrics', limit: 30 },
    { cat: 'foam', key: 'foams', limit: 10 },
    { cat: 'acc', key: 'accessories', limit: 40 },
  ];
  for (const { cat, key, limit } of specs) {
    const r = await env.DB.prepare(
      "SELECT data FROM items " +
      "WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.category') END) = ? " +
      "AND json_valid(data) = 1 " +
      "AND (CASE WHEN json_valid(data) THEN json_type(data, '$.active') END) IS NOT 'false' " +
      "AND (CASE WHEN json_valid(data) THEN json_type(data, '$.id') END) IS NOT NULL " +
      "AND (CASE WHEN json_valid(data) THEN json_type(data, '$.id') END) != 'null' " +
      "AND NOT ((CASE WHEN json_valid(data) THEN json_type(data, '$.id') END) = 'text' AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.id') END) = '') " +
      "AND NOT ((CASE WHEN json_valid(data) THEN json_type(data, '$.id') END) IN ('integer', 'real', 'false') AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.id') END) = 0) " +
      "AND (CASE WHEN json_valid(data) THEN json_type(data, '$.name') END) IS NOT NULL " +
      "AND (CASE WHEN json_valid(data) THEN json_type(data, '$.name') END) != 'null' " +
      "AND NOT ((CASE WHEN json_valid(data) THEN json_type(data, '$.name') END) = 'text' AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.name') END) = '') " +
      "AND NOT ((CASE WHEN json_valid(data) THEN json_type(data, '$.name') END) IN ('integer', 'real', 'false') AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.name') END) = 0) " +
      "ORDER BY updated_at DESC LIMIT ?"
    ).bind(cat, limit).all();
    for (const row of r.results) {
      const i = safeParse(row.data);
      if (!i || typeof i !== 'object' || !i.id || i.active === false || !i.name) continue;
      const name = String(i.name).slice(0, 60);
      if (brief[key].length < limit) brief[key].push(name);
    }
  }
  return brief;
}

function aiSystemPrompt(brief) {
  return [
    'أنت مصمّم مجالس محترف تعمل لصالح أصالة نجد. أجب دائماً بصيغة JSON فقط وفق التعليمات التالية.',
    'أعد JSON بالشكل التالي بالضبط: status ? note ? questions ? assumptions ? issues ? spec.',
    'status: "ready" عندما تكون البيانات كافية، أو "need_answers" عند الحاجة لأسئلة، أو "invalid" إذا تعذّر تنفيذ الطلب.',
    'note: ملخص قصير للعميل (200 حرف كحد أقصى) — لا تذكر فيه JSON أو تفاصيل تقنية.',
    'questions: حتى 4 أسئلة فقط عند نقص المعلومات، بصيغة {id, q, options} مع خيارات مقترحة لكل سؤال.',
    'assumptions: الافتراضات التي اعتمدتها عند نقص الطلب. issues: تعارضات أو ملاحظات تحتاج انتباه العميل.',
    'المواصفات spec بالتفصيل (الأقسام التالية):',
    '- roomW عرض الغرفة (0.5–30) و roomH طول الغرفة (0.5–30) بالمتر.',
    '- seating: "floor" أرضي أو "sofa" كنب أو "arabic" جلسة عربية أو "raised" جلسة مرتفعة. depth عمق الجلسة (0.3–1.5، الافتراضي 0.8).',
    '- الجدران (جميع القياسات بالمتر): door عرض (0.6–2.5)، window عرض (0.4–4)، tv عرض (0.8–4)، mashab عرض (0.6–2.5).',
    '- كل عنصر {wall, w, distFromCorner, side}: wall 0 للحائط الأمامي، 1 الأيمن، 2 الخلفي، 3 الأيسر؛ side "start" أو "end"؛ distFromCorner المسافة من الزاوية بالمتر — وإن تعذّر تحديده ضعه في assumptions.',
    '- حركة الباب: swing "in"/"out" و hinge "left"/"right" (الافتراضي in و right).',
    '- sofaWalls: جدران الكنب كقائمة أرقام من 0 إلى 3 (مثل [0,2]) دون تكرار؛ اختر الجدران الأنسب لوضع الكنب.',
    '- fabric و foam: اختر من مكتبة الأقمشة والإسفنج المعروضة؛ وإن لم يتوفر مطلوب العميل أضفه في note.',
    '- accessories: مصفوفة {name, qty} من الإكسسوارات المطلوبة (qty من 1 إلى 99)؛ وإن تجاوز الطلب ذلك اذكره في issues.',
    '- لا تتجاوز حدود spec المذكورة؛ وعند نقص البيانات اسأل في questions أو افترض وضعها في assumptions.',
    'صيغة الرد: JSON صالح فقط؛ لا تكتب أي نص قبله أو بعده، ولا تستخدم أي صيغة أخرى غير JSON.',
    'الأقمشة المتاحة: ' + (brief.fabrics.join('، ') || 'لا توجد أقمشة محددة') + '.',
    'الإسفنج المتاح: ' + (brief.foams.join('، ') || 'لا يوجد إسفنج محدد') + '.',
    'الإكسسوارات المتاحة: ' + (brief.accessories.join('، ') || 'لا توجد إكسسوارات محددة') + '.',
  ].join('\n');
}

function aiUserMessage(text, spec, history) {
  const parts = ['المواصفات الحالية: ' + (spec ? JSON.stringify(spec) : 'لا توجد')];
  if (history.length) {
    parts.push('سجل المحادثة:');
    for (const h of history) parts.push((h.r === 'b' ? 'العميل: ' : 'المساعد: ') + h.t);
  }
  parts.push('طلب العميل الآن: ' + text);
  return parts.join('\n');
}

async function aiCallModel(env, system, user) {
  const base = String(env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(env.AI_MODEL || 'gpt-4o-mini');
  const attempt = async (useFormat) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const payload = { model, temperature: 0.2, max_tokens: 1600, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      if (useFormat) payload.response_format = { type: 'json_object' };
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.AI_API_KEY },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) { const err = new Error('provider'); err.pStatus = res.status; throw err; }
      const data = await res.json().catch(() => null);
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim() || content.length > AI_CONTENT_MAX) { const err = new Error('provider content'); err.pStatus = 502; throw err; }
      return content;
    } finally { clearTimeout(timer); }
  };
  let err = null;
  for (const useFormat of [true, false]) {
    try { return await attempt(useFormat); }
    catch (e) {
      err = e;
      const st = e && e.pStatus;
      if (st && st >= 400 && st < 500 && st !== 400) break;
      if (!useFormat) break;
    }
  }
  console.warn('ai-design failed: ' + (err && err.name === 'AbortError' ? 'timeout' : err && err.pStatus ? 'status-' + err.pStatus : 'network'));
  throw new HttpError(503, 'تعذّرت الاستجابة من خدمة التصميم حالياً. حاول مرة أخرى بعد قليل.');
}

async function portalAiDesign(env, request, body) {
  const token = designTokenOf(request);
  await portalRow(env, token);
  await aiThrottle(env, request, token);
  if (!env || !env.AI_API_KEY) throw new HttpError(503, 'خدمة التصميم بالذكاء الاصطناعي غير مفعّلة حالياً.');
  const settings = await shopSettings(env);
  if (settings.aiDesignEnabled === false) throw new HttpError(503, 'خدمة التصميم بالذكاء الاصطناعي غير مفعّلة حالياً.');
  const rawText = body && body.text != null ? String(body.text) : '';
  if (rawText.trim().length > AI_TEXT_MAX) throw new HttpError(400, 'النص أطول من الحد المسموح (3000 حرف).');
  const text = aiStr(rawText, AI_TEXT_MAX);
  if (!text) throw new HttpError(400, 'اكتب وصفًا للطلب.');
  const history = [];
  if (Array.isArray(body.history)) {
    for (const h of body.history) {
      if (history.length >= AI_HISTORY_MAX) break;
      if (!h || typeof h !== 'object') continue;
      const t = aiStr(h.t, 200);
      if (t) history.push({ r: h.r === 'b' ? 'b' : 'u', t });
    }
  }
  let spec = null;
  if (body.spec && typeof body.spec === 'object' && JSON.stringify(body.spec).length <= AI_SPEC_MAX) spec = aiSanitizeSpec(body.spec);
  const brief = await aiCatalogBrief(env);
  const content = await aiCallModel(env, aiSystemPrompt(brief), aiUserMessage(text, spec, history));
  let parsed = null;
  try { parsed = JSON.parse(String(content).replace(/^\uFEFF/, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('ai-design failed: bad-json');
    throw new HttpError(503, 'تعذّرت الاستجابة من خدمة التصميم. حاول مرة أخرى.');
  }
  const out = aiSanitizeModelOut(parsed);
  console.warn('ai-design ok status=' + out.status);
  return { ok: true, status: out.status, note: out.note, questions: out.questions, assumptions: out.assumptions, issues: out.issues, spec: out.spec };
}

/* ------------------------------ التصميم الموسّع (نسخة تجريبية) ------------------------------
   نفس قواعد أمان البوابة، لكن على جدول customer_designs_exp وبادجة token 'x':
   - لا يختلط ببيانات العملاء الحقيقيين ولا يستهلك أرقام MJ
   - لا تختلط ببيانات العملاء الحقيقية (جدول customer_designs)
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

/* ------------------------------ المصروفات ------------------------------ */

/* المصروف: البيان (name) والمبلغ والتاريخ (expense_date) والتصنيف والملاحظة، ومن سجّله
   (created_by — دائماً المُسجِّل، أو موظف آخر لمن يملك expenses.add_all)، وطلب مرتبط اختياري.
   ‎_own = مصروفاتك فقط، ‎_all = مصروفات الجميع — كل عملية بصلاحيتها (لا العرض بدل التعديل). */
const EXPENSE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const expenseDay = (e) => String(e.expense_date || e.created_at || '').slice(0, 10);
const expPerm = (user, action, row) => hasPerm(user, 'expenses.' + action + (row && row.created_by === user.id ? '_own' : '_all'), user.permissions);

/** قراءة الصفوف المرئية للمستخدم بعد تصفية الفترة (بتاريخ المصروف، وللقديم تاريخ إنشائه) */
async function visibleExpenses(env, user, query) {
  const from = String(query.get('from') || '');
  const to = String(query.get('to') || '');
  const userId = String(query.get('userId') || '');
  const canViewAll = hasPerm(user, 'expenses.view_all', user.permissions);
  const canViewOwn = hasPerm(user, 'expenses.view_own', user.permissions);
  if (!canViewAll && !canViewOwn) throw new HttpError(403, 'غير مصرح');
  const r = canViewAll
    ? await env.DB.prepare('SELECT * FROM expenses ORDER BY created_at DESC').all()
    : await env.DB.prepare('SELECT * FROM expenses WHERE created_by = ? ORDER BY created_at DESC').bind(user.id).all();
  return (r.results || []).filter((e) => {
    const d = expenseDay(e);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (userId && e.created_by !== userId) return false;
    return true;
  }).sort((a, b) => expenseDay(b).localeCompare(expenseDay(a)) || String(b.created_at).localeCompare(String(a.created_at)));
}

async function listExpenses(env, user, query) {
  const rows = await visibleExpenses(env, user, query);
  const users = new Map(((await env.DB.prepare('SELECT id, name FROM users').all()).results || []).map((u) => [u.id, u.name]));
  const orderIds = [...new Set(rows.map((e) => e.order_id).filter(Boolean))];
  const numbers = new Map();
  for (let i = 0; i < orderIds.length; i += 50) {
    const chunk = orderIds.slice(i, i + 50);
    const o = await env.DB.prepare(`SELECT id, number FROM orders WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const x of o.results || []) numbers.set(x.id, x.number);
  }
  return { ok: true, expenses: rows.map((e) => ({
    id: e.id, name: e.name, amount: Number(e.amount) || 0, category: e.category, note: e.note,
    expense_date: expenseDay(e), order_id: e.order_id || null, order_number: e.order_id ? (numbers.get(e.order_id) ?? null) : null,
    created_by: e.created_by, created_by_name: users.get(e.created_by) || '',
    created_at: e.created_at, updated_at: e.updated_at,
    can_edit: expPerm(user, 'edit', e), can_delete: expPerm(user, 'delete', e),
  })) };
}

/** التحقق من حقول المصروف (جديد أو تعديل فوق صف قائم) */
async function cleanExpense(env, user, body, row) {
  const b = body && typeof body === 'object' ? body : {};
  const pick = (k, fallback) => (b[k] !== undefined ? b[k] : fallback);
  const name = String(pick('name', row ? row.name : '') || '').trim().slice(0, 200);
  const amount = Number(pick('amount', row ? row.amount : NaN));
  const category = String(pick('category', row ? row.category : '') || '').trim().slice(0, 60) || null;
  const note = String(pick('note', row ? row.note : '') || '').trim().slice(0, 500) || null;
  const expenseDate = String(pick('expense_date', row ? expenseDay(row) : now().slice(0, 10)) || '').trim();
  let orderId = pick('order_id', row ? row.order_id : null);
  orderId = orderId ? String(orderId) : null;
  if (!name) throw new HttpError(400, 'البيان مطلوب');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'مبلغ غير صحيح — أدخل مبلغاً أكبر من صفر');
  if (!EXPENSE_DATE_RE.test(expenseDate) || isNaN(Date.parse(expenseDate))) throw new HttpError(400, 'تاريخ غير صالح');
  if (orderId && (!row || orderId !== row.order_id)) {
    const o = await env.DB.prepare('SELECT id, created_by FROM orders WHERE id = ?').bind(orderId).first();
    if (!o) throw new HttpError(400, 'الطلب المرتبط غير موجود');
    // الربط بطلب لا يكشف طلباً لا يحق للمستخدم رؤيته
    const own = o.created_by === user.id;
    if (!hasPerm(user, own ? 'orders.view_own' : 'orders.view_all', user.permissions)) throw new HttpError(403, 'لا يمكنك ربط المصروف بهذا الطلب');
  }
  return { name, amount, category, note, expenseDate, orderId };
}

async function saveExpense(env, user, body) {
  const f = await cleanExpense(env, user, body, null);
  let createdBy = user.id;
  if (body && body.created_by && body.created_by !== user.id) {
    // التسجيل باسم موظف آخر: لمن يملك add_all فقط، والموظف يجب أن يكون موجوداً
    if (!hasPerm(user, 'expenses.add_all', user.permissions)) throw new HttpError(403, 'غير مصرح');
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(String(body.created_by)).first();
    if (!u) throw new HttpError(400, 'الموظف غير موجود');
    createdBy = u.id;
  } else if (!hasPerm(user, 'expenses.add_own', user.permissions)) {
    throw new HttpError(403, 'غير مصرح');
  }
  const id = uid();
  const t = now();
  await env.DB.prepare('INSERT INTO expenses (id, name, amount, category, note, created_by, created_at, updated_at, expense_date, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, f.name, f.amount, f.category, f.note, createdBy, t, t, f.expenseDate, f.orderId).run();
  return { ok: true, expense: { id, name: f.name, amount: f.amount, category: f.category, note: f.note, expense_date: f.expenseDate, order_id: f.orderId, created_by: createdBy, created_at: t, updated_at: t } };
}

async function updateExpense(env, user, id, body) {
  const row = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'المصروف غير موجود');
  // مصروف غيرك: لا تعديل بلا edit_all (ولا يُكشف وجوده لمن لا يرى إلا مصروفاته)
  if (!expPerm(user, 'edit', row)) throw new HttpError(403, 'غير مصرح');
  const f = await cleanExpense(env, user, body, row);
  const t = now();
  await env.DB.prepare('UPDATE expenses SET name = ?, amount = ?, category = ?, note = ?, expense_date = ?, order_id = ?, updated_at = ? WHERE id = ?')
    .bind(f.name, f.amount, f.category, f.note, f.expenseDate, f.orderId, t, id).run();
  return { ok: true, expense: { id, name: f.name, amount: f.amount, category: f.category, note: f.note, expense_date: f.expenseDate, order_id: f.orderId, created_by: row.created_by, created_at: row.created_at, updated_at: t } };
}

async function deleteExpense(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'المصروف غير موجود');
  if (!expPerm(user, 'delete', row)) throw new HttpError(403, 'غير مصرح');
  await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();
  return { ok: true };
}

async function expensesSummary(env, user, query) {
  const rows = await visibleExpenses(env, user, query);
  let total = 0;
  const byCategory = {};
  for (const e of rows) {
    const a = Number(e.amount || 0);
    total += a;
    const c = e.category || 'بلا تصنيف';
    byCategory[c] = (byCategory[c] || 0) + a;
  }
  return { ok: true, total_amount: total, count: rows.length, by_category: byCategory };
}

/* ------------------------------ دوال مساعدة لحساب التكاليف والإيرادات ------------------------------ */

function computeOrderCost(d) {
  let cost = 0;
  if (d && d.costs && typeof d.costs === 'object') {
    for (const k of Object.keys(d.costs)) {
      const v = Number(d.costs[k] || 0);
      if (Number.isFinite(v)) cost += v;
    }
  }
  if (d && Array.isArray(d.extraCosts)) {
    for (const e of d.extraCosts) {
      const v = Number(e && e.amount || 0);
      if (Number.isFinite(v)) cost += v;
    }
  }
  if (d && Array.isArray(d.manualRows)) {
    for (const m of d.manualRows) {
      const v = Number(m && m.cost || 0);
      if (Number.isFinite(v)) cost += v;
    }
  }
  return cost;
}

function orderRevenueFromData(d) {
  if (!d) return 0;
  if (d.subtotal !== undefined && d.subtotal !== null) {
    return Number(d.subtotal) - Number(d.discount || 0);
  }
  if (d.total !== undefined && d.total !== null) {
    const rate = (d.vat && d.vat.enabled) ? Number(d.vat.rate || 0) : 0;
    return Number(d.total) / (1 + rate / 100);
  }
  return 0;
}

function commRateForOrder(d, user) {
  if (d && d.commRates && d.commRates.ownerRate !== undefined) return Number(d.commRates.ownerRate);
  if (user && user.rate !== undefined) return Number(user.rate);
  return 0;
}

function shareRateForOrder(d) {
  if (d && d.commRates && d.commRates.shareRate !== undefined) return Number(d.commRates.shareRate);
  return 0;
}

/* ------------------------------ تقرير المناديب ------------------------------ */

async function mandoubsReport(env, user, query) {
  const canViewAll = hasPerm(user, 'reports.view_all', user.permissions);
  if (!canViewAll) throw new HttpError(403, 'غير مصرح');

  const from = String(query.get('from') || '');
  const to = String(query.get('to') || '');

  // جميع المناديب (الدور mandoub)
  const users = await env.DB.prepare('SELECT id, name, username, parent_id FROM users WHERE role = ? AND active = 1').bind('mandoub').all();
  const mandoubs = (users.results || []).map((u) => ({
    id: u.id, name: u.name, username: u.username, parent_id: u.parent_id,
    count: 0, revenue: 0, cost: 0, profit: 0, commission: 0, share: 0,
    directCount: 0, directRevenue: 0, directCost: 0, directProfit: 0,
  }));

  // بناء خريطة الآباء والأبناء للتسلسل الهرمي
  const childrenMap = new Map(); // parent_id -> [childIds]
  const mandoubMap = new Map();  // id -> mandoub entry
  for (const m of mandoubs) {
    mandoubMap.set(m.id, m);
    if (!childrenMap.has(m.parent_id)) childrenMap.set(m.parent_id, []);
    if (m.parent_id) childrenMap.get(m.parent_id).push(m.id);
  }

  // جلب الطلبات المصدّقة في الفترة (تُحسب لكل مندوب مرة واحدة فقط לפי المالك المباشر)
  let sql = 'SELECT id, created_by, data FROM orders WHERE status = ?';
  const binds = ['delivered'];
  if (from) { sql += ' AND date(created_at) >= ?'; binds.push(from); }
  if (to) { sql += ' AND date(created_at) <= ?'; binds.push(to); }
  const rows = await env.DB.prepare(sql).bind(...binds).all();

  const ordersByOwner = new Map(); // ownerId -> orders[]
  for (const r of (rows.results || [])) {
    let d;
    try { d = JSON.parse(r.data); } catch { d = {}; }
    const createdBy = r.created_by;
    if (!ordersByOwner.has(createdBy)) ordersByOwner.set(createdBy, []);
    const revenue = orderRevenueFromData(d);
    const cost = computeOrderCost(d);
    ordersByOwner.get(createdBy).push({
      id: r.id, number: r.number, status: r.status,
      revenue, cost,
      profit: revenue - cost,
      commission: revenue > 0 ? (revenue - cost) * commRateForOrder(d, { rate: 0 }) / 100 : 0,
      share: revenue > 0 ? (revenue - cost) * shareRateForOrder(d) / 100 : 0,
    });
  }

  // دالة تجميعentzia من الأسفل إلى الأعلى (post-order traversal)
  function aggregateMandoub(mid) {
    const m = mandoubMap.get(mid);
    if (!m) return { count: 0, revenue: 0, cost: 0, profit: 0, commission: 0, share: 0 };
    let rev = 0, cost = 0, profit = 0, commission = 0, share = 0, count = 0;

    // طلبات هذا المندوب مباشرة
    const ownOrders = ordersByOwner.get(mid) || [];
    for (const o of ownOrders) {
      rev += o.revenue; cost += o.cost; profit += o.profit;
      commission += o.commission; share += o.share; count += 1;
    }

    // طلبات الأبناء (التسلسل الهرمي) - يُضاف للمندوب الحالي دون تكرار مع المندوب الابن نفسه
    const children = childrenMap.get(m.id) || [];
    for (const childId of children) {
      const childAgg = aggregateMandoub(childId);
      rev += childAgg.revenue; cost += childAgg.cost; profit += childAgg.profit;
      commission += childAgg.commission; share += childAgg.share; count += childAgg.count;
    }

    m.count = count; m.revenue = rev; m.cost = cost; m.profit = profit;
    m.commission = commission; m.share = share;
    m.directCount = ownOrders.length;
    m.directRevenue = ownOrders.reduce((s, o) => s + o.revenue, 0);
    m.directCost = ownOrders.reduce((s, o) => s + o.cost, 0);
    m.directProfit = ownOrders.reduce((s, o) => s + o.profit, 0);

    return { count, revenue: rev, cost, profit, commission, share };
  }

  // 시작 من الجذور (المندوبون الذين ليس لهم أب)
  const result = [];
  for (const m of mandoubs) {
    if (!m.parent_id || !mandoubMap.has(m.parent_id)) {
      aggregateMandoub(m.id);
      result.push({
        id: m.id, name: m.name, username: m.username, parent_id: m.parent_id,
        count: m.count, revenue: m.revenue, cost: m.cost, profit: m.profit,
        commission: m.commission, share: m.share,
        directCount: m.directCount, directRevenue: m.directRevenue,
        directCost: m.directCost, directProfit: m.directProfit,
      });
    }
  }

  // أيضًا أضف المناديب الذين لديهم أب (كEntries فرعية)، لكن بعرض مستوياتهم
  for (const m of mandoubs) {
    if (m.parent_id && mandoubMap.has(m.parent_id)) {
      //已 processed via aggregation above, but include in result for flat listing
      const existing = result.find(r => r.id === m.id);
      if (!existing) {
        result.push({
          id: m.id, name: m.name, username: m.username, parent_id: m.parent_id,
          count: m.count, revenue: m.revenue, cost: m.cost, profit: m.profit,
          commission: m.commission, share: m.share,
          directCount: m.directCount, directRevenue: m.directRevenue,
          directCost: m.directCost, directProfit: m.directProfit,
        });
      }
    }
  }

  // التقرير لكل المناديب: الأرقام الحساسة تتبع صلاحيات «الكل» لمن يطلبه
  return { ok: true, mandoubs: result.map((m) => redactMoney(user, m, false)) };
}

/** حجب التكلفة/الربح/العمولة عمّن لا يملك صلاحيتها — التقارير لا تتجاوز ما تحجبه المزامنة.
    own = السجل يخص المستخدم نفسه (فتكفي ‎_own)، وإلا تلزم ‎_all. null = محجوب (لا صفر مضلِّل). */
function redactMoney(user, rec, own) {
  const can = (p) => hasPerm(user, p + (own ? '_own' : '_all'), user.permissions) || (own && hasPerm(user, p + '_all', user.permissions));
  const out = { ...rec };
  if (!can('costs.view')) for (const k of ['cost', 'directCost', 'totalCost']) if (k in out) out[k] = null;
  if (!can('costs.view') || !can('profit.view')) for (const k of ['profit', 'directProfit', 'totalProfit']) if (k in out) out[k] = null;
  if (!can('commission.view')) for (const k of ['commission', 'share']) if (k in out) out[k] = null;
  return out;
}

/* ------------------------------ تقرير الطلبات والمدفوعات ------------------------------ */

async function ordersSummary(env, user, query) {
  const canViewAll = hasPerm(user, 'reports.view_all', user.permissions);
  const canViewOwn = hasPerm(user, 'reports.view_own', user.permissions);
  if (!canViewAll && !canViewOwn) throw new HttpError(403, 'غير مصرح');

  const from = String(query.get('from') || '');
  const to = String(query.get('to') || '');
  const statusFilter = String(query.get('status') || '');
  const userFilter = String(query.get('userId') || '');
  const dRe = /^\d{4}-\d{2}-\d{2}$/;
  if (from && !dRe.test(from)) throw new HttpError(400, 'صيغة التاريخ غير صحيحة (from)');
  if (to && !dRe.test(to)) throw new HttpError(400, 'صيغة التاريخ غير صحيحة (to)');

  let sql = 'SELECT id, number, status, customer_name, created_by, created_at, data, updated_at FROM orders';
  const binds = [];
  const wh = [];
  if (!canViewAll) {
    // مقيّد برؤية طلباته فقط
    wh.push('created_by = ?');
    binds.push(user.id);
  } else if (userFilter) {
    wh.push('created_by = ?');
    binds.push(userFilter);
  }
  if (from) { wh.push('date(created_at) >= ?'); binds.push(from); }
  if (to) { wh.push('date(created_at) <= ?'); binds.push(to); }
  if (statusFilter) { wh.push('status = ?'); binds.push(statusFilter); }
  if (wh.length) sql += ' WHERE ' + wh.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  const rows = await env.DB.prepare(sql).bind(...binds).all();

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const out = [];
  let totalRevenue = 0, totalPaid = 0, totalRemaining = 0, totalCost = 0;
  const byStatus = {};
  for (const r of (rows.results || [])) {
    let d;
    try { d = JSON.parse(r.data || '{}'); } catch { d = {}; }
    const st = String(d.status || r.status || 'new');
    const revenue = orderRevenueFromData(d);
    const cost = computeOrderCost(d);
    const paid = num(d.paid);
    const remaining = num(d.remaining);
    if (!byStatus[st]) byStatus[st] = { count: 0, revenue: 0, paid: 0, remaining: 0, cost: 0 };
    byStatus[st].count++;
    byStatus[st].revenue += revenue;
    byStatus[st].paid += paid;
    byStatus[st].remaining += remaining;
    byStatus[st].cost += cost;
    totalRevenue += revenue; totalPaid += paid; totalRemaining += remaining; totalCost += cost;
    out.push(redactMoney(user, {
      id: r.id, number: r.number, status: st, customer: d.customer || {},
      created_by: r.created_by, created_at: d.createdAt || r.created_at, updated_at: r.updated_at,
      subtotal: num(d.subtotal), total: num(d.total), paid, remaining,
      discount: num(d.discount), vatRate: num(d.vatRate), vatAmount: num(d.vatAmount),
      cost, profit: revenue - cost,
      payments: Array.isArray(d.payments) ? d.payments : [],
    }, r.created_by === user.id));
  }
  // أي طلب حُجبت تكلفته/ربحه يحجب الإجمالي أيضاً — وإلا يُستنتج المحجوب بالطرح
  const costHidden = out.some((o) => o.cost === null);
  const profitHidden = out.some((o) => o.profit === null);
  if (costHidden) for (const s of Object.values(byStatus)) s.cost = null;

  return {
    ok: true,
    from, to,
    count: out.length,
    totalRevenue, totalPaid, totalRemaining,
    totalCost: costHidden ? null : totalCost,
    netProfit: (costHidden || profitHidden) ? null : totalRevenue - totalCost,
    byStatus,
    orders: out,
  };
}

/* ------------------------------ المصادقة والصلاحيات ------------------------------ */
function tokenOf(request) {
  const h = request.headers.get('x-session-token');
  if (h) return h;
  const a = request.headers.get('authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7) : null;
}

async function currentUser(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.name, u.role, u.active, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1'
  ).bind(token, now()).first();
  if (!row) return null;
  const permissions = await loadUserPermissions(env, row.id);
  // هوية المالك من البيئة وحدها (لا من الطلب ولا من القاعدة)، وبدور مدير ونشِط
  const ownerId = ownerIdOf(env);
  const isOwner = !!ownerId && String(row.id) === ownerId && row.role === 'admin';
  return Object.assign({}, row, { permissions, ownerId, isOwner });
}

function requireAdmin(user) {
  if (!user || !hasPerm(user, 'admin.core', user.permissions)) throw new HttpError(403, 'هذه العملية لمالك النظام فقط');
}

function requireOwner(user) {
  if (!user || user.isOwner !== true) throw new HttpError(403, 'هذه العملية لمالك النظام فقط');
}

function requirePerm(user, perm) {
  if (!user || !hasPerm(user, perm, user.permissions)) throw new HttpError(403, 'غير مصرح');
}

function requireAnyPerm(user, perms) {
  if (!user || !perms.some((p) => hasPerm(user, p, user.permissions))) throw new HttpError(403, 'غير مصرح');
}

const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active, isOwner: u.isOwner === true });

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
  if (!u) { await loginFailed(env, keys); return { ok: false, error: 'bad_credentials' }; }
  const parts = String(u.password_hash || '').split('$');
  const storedIter = parts.length === 4 && parts[0] === 'pbkdf2' ? Number(parts[1]) || DEFAULT_ITER : DEFAULT_ITER;
  if (storedIter > 100000) { return { ok: false, error: 'password_needs_reset', minutes: 0 }; }
  if (!(await verifyPassword(password, u.password_hash))) { await loginFailed(env, keys); return { ok: false, error: 'bad_credentials' }; }
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
  // ترقية كلمة المرور تلقائياً عند الحاجة قبل إنشاء الجلسة
  await maybeUpgradePassword(env, u.id, password, u.password_hash);
  // تُنهى الجلسات الأخرى عند تغيير كلمة المرور أو إيقاف الحساب
  const mustChangePassword = u.must_change_password === 1;
  return { ok: true, token, user: publicUser(u), mustChangePassword };
}

/* ------------------------------ البيانات ------------------------------ */
async function bootstrap(env, user) {
  const canViewAllOrders = hasPerm(user, "orders.view_all", user.permissions);
  const canViewOwnOrders = hasPerm(user, "orders.view_own", user.permissions);
  const canViewAllCosts = hasPerm(user, "costs.view_all", user.permissions);
  const canViewOwnCosts = hasPerm(user, "costs.view_own", user.permissions);
  const ordersQuery = (canViewAllOrders || canViewOwnOrders)
    ? (canViewAllOrders
        ? env.DB.prepare('SELECT data, created_by FROM orders ORDER BY created_at').all()
        : env.DB.prepare('SELECT data, created_by FROM orders WHERE created_by = ? ORDER BY created_at').bind(user.id).all())
    : Promise.resolve({ results: [] });
  const [settings, items, orders] = await Promise.all([
    env.DB.prepare('SELECT data FROM settings WHERE id = 1').first(),
    env.DB.prepare('SELECT data FROM items ORDER BY updated_at').all(),
    ordersQuery,
  ]);
  // الإدارة الكاملة (السجل ونسب العمولة) للمالك وحده — لا لدور «مدير»
  const admin = hasPerm(user, 'admin.core', user.permissions);
  const out = {
    // قدرات هذا الخادم: الواجهة الأحدث لا تعتمد على ميزة لم يُنشر خادمها بعد
    features: { serverNumbers: true, costsHidden: true },
    user: publicUser(user),
    // صلاحيات المستخدم الحالي الفعّالة: للواجهة لإخفاء ما لا يملكه فقط (الفرض في الخادم دائماً)
    permissions: [...effectivePermissions(user, user.permissions)],
    settings: settings ? safeParse(settings.data, {}) : {},
    items: items.results.map((r) => safeParse(r.data)),
    // الملكية مصفّاة أعلاه من عمود قاعدة البيانات الموثوق، لا من بيانات الطلب.
    // لا نعيد صفوفاً جزئية للغير؛ ذلك يمنع التسريب عبر التفاصيل أو التصدير.
    // لا نعيد للغير إلا طلباته؛ والتكاليف لا تظهر إلا لمن يملك صلاحية رؤيتها.
    orders: orders.results.map((r) => {
      const o = safeParse(r.data, null);
      if (!o) return null;
      const owner = !!(r.created_by && r.created_by === user.id);
      const canViewCosts = canViewAllCosts || (canViewOwnCosts && owner);
      return canViewCosts ? o : stripCosts(o);
    }).filter(Boolean),
    users: [],
  };
  if (admin) {
    // آخر 3000 حدث فقط: السجل ينمو بلا حد، وتحميله كاملاً مع كل مزامنة يُبطئها
    const act = await env.DB.prepare('SELECT data FROM (SELECT data, at FROM activity ORDER BY at DESC LIMIT 3000) ORDER BY at').all();
    out.activity = act.results.map((r) => safeParse(r.data));
  }
  // قائمة المستخدمين لمن يملك users.view (لا الدور). نسب العمولة للمدير وحده.
  if (hasPerm(user, 'users.view', user.permissions)) {
    const users = await listUsers(env);
    out.users = admin ? users : users.map((u) => ({ ...u, rate: null, parentRate: null }));
  }
  // للمديرين: هل حُدِّد مالك النظام؟ (الواجهة تنبّه إن لم يُضبط OWNER_USER_ID أو كان غير صالح)
  if (user.role === 'admin') {
    const ownerId = ownerIdOf(env);
    const ownerRow = ownerId ? await env.DB.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin' AND active = 1").bind(ownerId).first() : null;
    out.owner = { configured: !!ownerRow };
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
  // القيم غير السالبة في الطلبات (الخصم والنسب وغيرها لا تقبل أقل من صفر)
  for (const f of ['subtotal', 'total', 'remaining', 'vatRate', 'vatAmount']) {
    if (o[f] !== undefined && o[f] !== null && o[f] !== '' && !(isFinNum(o[f]) && o[f] >= 0)) finErr('order.' + f);
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
   نفس المصير لأي فشل لاحق — التغيير كله أو لا شيء. عند تجاوز الحد (50 عملية)
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
    // الأصناف والأسعار صلاحية مستقلة عن إعدادات المحل
    requirePerm(user, 'items.manage');
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
  // الإدارة الكاملة (نسب العمولة، ونسب الطلب لغيرك عند الإنشاء) للمالك وحده — لا لدور «مدير»
  const admin = hasPerm(user, 'admin.core', user.permissions);
  // نسب العمولة لغير المالك يحسبها الخادم من القاعدة (لا ما يرسله العميل): الإعدادات + صاحب الطلب
  let commCtx = null;
  if (!admin && (od.upsert || []).length) {
    const srow = await env.DB.prepare('SELECT data FROM settings WHERE id = 1').first();
    const ownerIds = [...new Set(od.upsert.map((o) => (existing.get(o.id) || {}).owner || user.id).filter(Boolean))];
    const owners = new Map();
    for (let i = 0; i < ownerIds.length; i += 50) {
      const chunk = ownerIds.slice(i, i + 50);
      const rows = await env.DB.prepare(`SELECT id, role, rate, parent_id, parent_rate FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const r of rows.results || []) owners.set(r.id, r);
    }
    commCtx = { settings: (srow && safeParse(srow.data, {})) || {}, owners };
  }

  /* ملكية الطلبات: تعديل طلب غيرك (أو طلب قديم بلا مالك) يتطلب orders.edit_all — يفرضه فحص
     الصلاحيات أدناه، لا الدور. نقل الملكية (تغيير createdBy) للمدير وحده. */
  if (!hasPerm(user, 'admin.core', user.permissions) && (od.upsert || []).length) {
    for (const o of od.upsert) {
      const row = existing.get(o.id);
      const expected = row ? row.owner : user.id;
      if (o.createdBy && o.createdBy !== expected) throw new HttpError(403, 'لا يمكن نسب الطلب إلى موظف آخر');
    }
  }

  // فحص الصلاحيات أولاً: قبل أي تحقق يكشف معلومة (أرقام، تعارض) عن طلب لا يحق للمستخدم تعديله
  // D3 permission checks for order upserts.
  const hasCostData = (x) => {
    if (!x || typeof x !== "object") return false;
    if (x.costs && Object.keys(x.costs).length) return true;
    if (Array.isArray(x.extraCosts) && x.extraCosts.length) return true;
    if (x.costTotal !== undefined && x.costTotal !== null && x.costTotal !== "") return true;
    if (Array.isArray(x.manualRows) && x.manualRows.some((m) => m && m.cost !== undefined && m.cost !== null && m.cost !== "")) return true;
    return false;
  };
  for (const o of (od.upsert || [])) {
    const row = existing.get(o.id);
    const owner = !row || row.owner === user.id;
    if (!row) {
      if (!hasPerm(user, "orders.create", user.permissions)) throw new HttpError(403, "غير مصرح");
    } else if (owner) {
      if (!hasPerm(user, "orders.edit_own", user.permissions)) throw new HttpError(403, "غير مصرح");
    } else {
      if (!hasPerm(user, "orders.edit_all", user.permissions)) throw new HttpError(403, "غير مصرح");
    }
    if (hasCostIntent(o)) {
      const existingHadCosts = !!(row && hasCostData(row.data));
      const newHasCosts = hasCostData(o);
      const clearing = !newHasCosts;
      const perm = clearing
        ? (owner ? "costs.delete_own" : "costs.delete_all")
        : (existingHadCosts ? (owner ? "costs.edit_own" : "costs.edit_all") : (owner ? "costs.add_own" : "costs.add_all"));
      if (!hasPerm(user, perm, user.permissions)) throw new HttpError(403, "غير مصرح");
    }
    // الدفعات مال مستلَم: الإضافة والتعديل والحذف صلاحيات مستقلة (داخل حدود ملكية الطلب أعلاه)
    const pc = paymentChanges(row ? row.data : null, o);
    if (pc.added && !hasPerm(user, 'payments.add', user.permissions)) throw new HttpError(403, 'لا تملك صلاحية إضافة دفعة');
    if (pc.edited && !hasPerm(user, 'payments.edit', user.permissions)) throw new HttpError(403, 'لا تملك صلاحية تعديل الدفعات');
    if (pc.removed && !hasPerm(user, 'payments.delete', user.permissions)) throw new HttpError(403, 'لا تملك صلاحية حذف الدفعات');
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
    // التكاليف والأرباح: فحص الملكية أعلاه يرفض طلبات الغير (403) قبل هنا،
    // فما يصل من موظف أو مندوب هو طلباته الخاصة — حفظ التكاليف فيها مسموح.
    // ما يرسله بلا أي أثر تكلفة ليس حذفاً: نسخه المحلية قد لم ترَ التكاليف
    // أصلاً (كانت مخفية عن الموظفين قديماً)، فتُستعاد من المخزّن لا تُمحى.
    if (!admin && !hasCostIntent(rec)) restoreCosts(rec, existing.has(rec.id) ? existing.get(rec.id).data : {});
    // نسب العمولة: غير المالك لا يغيّرها — تُستعاد من المخزّن، أو يحسبها الخادم لطلب بلا لقطة
    if (!admin) lockCommission(rec, existing.has(rec.id) ? existing.get(rec.id).data : null,
      commCtx.owners.get((existing.get(rec.id) || {}).owner || user.id) || null, commCtx.settings);
    // created_by يُحدَّث أيضاً: بدونه يبقى نقل الملكية في JSON فقط، ويرفض فحص الملكية
    // (المبني على العمود) تعديلات المالك الجديد. COALESCE تحمي الطلبات القديمة بلا مالك.
    q(
      'INSERT INTO orders (id, number, status, customer_name, created_by, created_at, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET number = excluded.number, status = excluded.status, customer_name = excluded.customer_name, created_by = COALESCE(excluded.created_by, orders.created_by), data = excluded.data, updated_at = excluded.updated_at',
      rec.id, rec.number ?? null, rec.status ?? null, (rec.customer && rec.customer.name) || '', rec.createdBy ?? null, rec.createdAt ?? ts, JSON.stringify(rec), ts
    );
  });
  if (od.delete && od.delete.length) {
    // حذف طلبك: orders.delete_own، وطلب غيرك (أو بلا مالك): orders.delete_all
    if (!hasPerm(user, 'orders.delete_all', user.permissions)) {
      if (!hasPerm(user, 'orders.delete_own', user.permissions)) throw new HttpError(403, 'غير مصرح');
      for (let i = 0; i < od.delete.length; i += 50) {
        const chunk = od.delete.slice(i, i + 50);
        const rows = await env.DB.prepare(`SELECT id, created_by FROM orders WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
        if (rows.results.some((r) => r.created_by !== user.id)) throw new HttpError(403, 'غير مصرح');
      }
    }
    od.delete.forEach((id) => q('DELETE FROM orders WHERE id = ?', id));
  }

  const ac = body.activity || {};
  // سجل التحديثات سجل تدقيق: الموظف يضيف أحداثاً باسمه فقط ولا يعدّل حدثاً موجوداً.
  // المدير وحده يكتب فوقها (الاستيراد يعيد أحداث الجميع بأسمائهم الأصلية).
  const staff = !admin;
  // D3 permission checks for activity upserts.
  for (const a of (ac.upsert || [])) {
    if (a && a.orderId) {
      const own = await verifyOrderOwnership(env, user, a.orderId);
      if (own.allowed) {
        if (!hasPerm(user, "orders.edit_own", user.permissions)) throw new HttpError(403, "غير مصرح");
      } else {
        if (!hasPerm(user, "orders.edit_all", user.permissions)) throw new HttpError(403, "غير مصرح");
      }
    } else if (user.role !== "admin") {
      if (!hasPerm(user, "orders.edit_own", user.permissions)) throw new HttpError(403, "غير مصرح");
    }
  }

  (ac.upsert || []).forEach((a) => {
    const rec = staff ? { ...a, userId: user.id, userName: user.name } : { ...a };
    // حدث إنشاء طلب جديد يُكتب قبل أن يُعرف رقمه
    if (rec.orderId && numbers[rec.orderId] !== undefined && !rec.orderNo) rec.orderNo = numbers[rec.orderId];
    q(`INSERT INTO activity (id, at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO ${staff ? 'NOTHING' : 'UPDATE SET data = excluded.data'}`, rec.id, rec.at || ts, JSON.stringify(rec));
  });
  if (ac.clear) { requirePerm(user, 'orders.delete_all'); q('DELETE FROM activity'); }
  else if (ac.delete && ac.delete.length) { requirePerm(user, 'orders.delete_all'); ac.delete.forEach((id) => q('DELETE FROM activity WHERE id = ?', id)); }

  if (body.settings) {
    requirePerm(user, 'settings.manage');
    q('INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', JSON.stringify(body.settings), ts);
  }

  // الدفعة الواحدة ذرية: أي فشل (بما فيه سجل التدقيق) يُسقط العملية كلها قبل أي كتابة
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, applied: stmts.length, numbers };
}

/* --------------------- التكاليف: رؤية مملوكة وحفظ مقصود ---------------------
   المدير يرى التكاليف ويدخلها في كل الطلبات. والموظف والمندوب يُضافون
   التكاليف ويعدّلونها في طلباتهم الخاصة فقط: الملكية تُقرأ من العمود
   created_by في جدول orders (وهو نفسه أساس فحص الملكية في sync)، وطلب
   الغير يصل مكسوفاً stripCosts في bootstrap، وأي محاولة تعديله عبر /api/sync
   تُرفض 403 قبل الكتابة. الهوية والدور يأتان من جلسة الخادم لا من الحمولة. */
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

/* هل ما أرسله الموظف يحمل نيةً واضحة لتعديل التكاليف؟
   - ختم التكاليف (costUpdatedAt / costUpdatedByName) لا يكتبه في الواجهة
      لا تكتبها الواجهة إطلاقاً — لا يمكن تزويرها من جانب الموظف.
   - أمّا محتوى غير فارغ (تكاليف أصناف، بنود إضافية، تكلفة صنف يدوي،
     إجمالي) فلا يأتِ إلا من نسخة رأت التكاليف — أي تعديل مقصود أيضاً.
   - وانعدام الأثر كله يعني نسخة لم ترَ التكاليف (كانت مخفية عن الموظف
     قديماً، أو طلب جديد): لا تُعتبر حذفاً، وتُستعاد من المخزّن. */
function hasCostIntent(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.costUpdatedAt !== undefined || o.costUpdatedByName !== undefined) return true;
  if (o.costs && typeof o.costs === 'object' && Object.keys(o.costs).length > 0) return true;
  if (Array.isArray(o.extraCosts) && o.extraCosts.length > 0) return true;
  if (o.costTotal !== undefined && o.costTotal !== null && o.costTotal !== '') return true;
  if (Array.isArray(o.manualRows) && o.manualRows.some((m) => m && m.cost !== undefined && m.cost !== null && m.cost !== '')) return true;
  return false;
}

/* نسب العمولة في الطلب (لقطة commRates ونسب البائع/المندوب/المشاركة): يحددها المالك وحده.
   لغيره: تُستعاد القيم المخزّنة كما هي (ما يرسله العميل يُهمل)، وطلب بلا لقطة تُحسب لقطته هنا من
   القاعدة بنفس معادلات الواجهة (sellerRateOf/mandoubOwnerRateOf/mandoubParentRateOf/shareRateOf). */
const COMMISSION_FIELDS = ['commRates', 'sellerRate', 'mandoubRate', 'shareRate', 'othersRate'];
const rateOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
function serverCommSnapshot(o, owner, s) {
  const isMan = !!(owner && owner.role === 'mandoub');
  const parentId = isMan && owner.parent_id ? String(owner.parent_id) : null;
  return {
    ownerRate: isMan ? (rateOrNull(owner.rate) ?? rateOrNull(s.mandoubRate) ?? 0) : (rateOrNull(o.sellerRate) ?? rateOrNull(s.sellerRate) ?? 0),
    parentId,
    parentRate: parentId ? (rateOrNull(owner.parent_rate) ?? rateOrNull(s.mandoubParentRate) ?? 0) : null,
    shareRate: rateOrNull(o.shareRate !== undefined ? o.shareRate : o.othersRate) ?? rateOrNull(s.shareRate) ?? 0,
  };
}
function lockCommission(rec, prev, owner, s) {
  for (const k of COMMISSION_FIELDS) { if (prev && prev[k] !== undefined) rec[k] = prev[k]; else delete rec[k]; }
  if (!rec.commRates) rec.commRates = serverCommSnapshot(rec, owner, s || {});
}

/** الفرق بين دفعات النسخة المخزّنة والمرسلة (بالمعرّف): ما أُضيف، وما عُدِّل، وما حُذف.
    الدفعة «legacy» يولّدها العميل من المبلغ المدفوع لطلب قديم بلا سجل دفعات — ليست إضافة. */
function paymentChanges(prev, next) {
  const oldList = (prev && Array.isArray(prev.payments)) ? prev.payments.filter((p) => p && p.id) : [];
  const newList = (next && Array.isArray(next.payments)) ? next.payments.filter((p) => p && p.id) : [];
  const oldById = new Map(oldList.map((p) => [String(p.id), p]));
  const newIds = new Set(newList.map((p) => String(p.id)));
  const same = (a, b) => Number(a.amount) === Number(b.amount) && String(a.method || '') === String(b.method || '')
    && String(a.at || '') === String(b.at || '') && String(a.note || '') === String(b.note || '');
  let added = false, edited = false;
  for (const p of newList) {
    const o = oldById.get(String(p.id));
    if (!o) { if (!(p.id === 'legacy' && !oldList.length)) added = true; }
    else if (!same(o, p)) edited = true;
  }
  const removed = oldList.some((p) => !newIds.has(String(p.id)));
  return { added, edited, removed };
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
/* ---------------- زوار الروابط العامة ----------------
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
    لا UTC — أي يوم يبدأ من منتصف الليل بتوقيت المحل لا بتوقيت غرينتش. */
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
  /* بصمة الزائر اليومية: مشتقة من اليوم (لا من الرابط) — تُخزَّن كبصمة مُبهمة.
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
    لا نعرف هوية أي زائر: لا نخزّن أي شيء يدل على 'زائر فردي' إلا:
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
      فلا تُعرض 'لا بيانات' (null) ولا 'صفر'. */
  if (!r || r.m === null || r.m === undefined) return null;
  const m = Number(r.m);
  return Number.isFinite(m) && m >= 0 ? Math.round(m) : null;
}

/** مسار التحويل: زيارة ← بدء ← إكمال ← واتساب ← طلب مؤكد.
    لا نسبة لمن لم يبدأ. 'الزيارة' = من رأى الصفحة دون بدء تصميم. */
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
          ولا تُحسب من أكمل فقط — من يضغط واتساب ثم يغلق الموقع لا يصل أبداً إلى 100%. */
      { key: 'whatsapp', label: 'ضغط واتساب', n: wa, rate: pct(wa, started) },
      { key: 'sent', label: 'إرسال التصميم', n: sent, rate: pct(sent, started) },
      { key: 'order', label: 'طلب مؤكد', n: orders, rate: pct(orders, started) },
    ],
    note: 'النسب مقامها "من بدأ التصميم" لا "من أكمله". "ضغط واتساب" لكل من بدأ لا لمن أكمل.',
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
    'الزيارات' (مجموع مرات الفتح) و'الزوار' (عدد البصمات الفريدة في اليوم).
    لا أرقام وهمية: كل قيمة مجموع فعلي من السجلات، وغياب البيانات يعطي صفراً. */
/** إحصاءات الروابط للمدير — ثلاثة نطاقات زمنية واضحة، كلها بتوقيت المحل:
    اليوم / آخر ٧ أيام / آخر ٣٠ يوماً. لكل نطاق رقمان مستقلان:
    'الزيارات' (مجموع مرات الفتح) و'الزوار' (عدد البصمات الفريدة في اليوم).
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
  const ownerId = ownerIdOf(env);
  return r.results.map((u) => ({
    id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.created_at,
    isOwner: !!ownerId && String(u.id) === ownerId && u.role === 'admin',
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
  let parentId = body.parentId || null;
  let rate = body.rate == null || body.rate === '' ? null : Math.max(0, Math.min(100, Number(body.rate)));
  let parentRate = body.parentRate == null || body.parentRate === '' ? null : Math.max(0, Math.min(100, Number(body.parentRate)));
  if (!name || !username) throw new HttpError(400, 'الاسم واسم المستخدم مطلوبان');
  if (!role) throw new HttpError(400, 'دور غير صالح');

  /* حماية المالك والمديرين (في الخادم، لا الواجهة):
     - دور «مدير» (إنشاءً أو ترقيةً) وأي تعديل على حساب مدير قائم — كلمة مرور أو تفعيل أو دور
       أو اسم — للمالك وحده؛ فلا يصنع مدير عادي مديراً بديلاً ولا يستولي على حساب مدير.
     - المالك نفسه لا يُخفَّض دوره ولا يُعطَّل عبر العمليات العادية (حتى بطلب منه).
     - نسب العمولة وشجرة المناديب للمالك وحده: غيره يحتفظ بالقيم المخزّنة. */
  const ownerId = ownerIdOf(env);
  const actorIsOwner = me && me.isOwner === true;
  let existing = null;
  if (body.id) {
    existing = await env.DB.prepare('SELECT id, role, active, parent_id, rate, parent_rate FROM users WHERE id = ?').bind(body.id).first();
    if (!existing) throw new HttpError(404, 'المستخدم غير موجود');
  }
  if (existing && ownerId && String(existing.id) === ownerId) {
    if (!actorIsOwner) throw new HttpError(403, 'حساب مالك النظام لا يعدّله غيره');
    if (role !== 'admin' || !active) throw new HttpError(400, 'مالك النظام لا يُخفَّض دوره ولا يُعطَّل');
  }
  if (!actorIsOwner && (role === 'admin' || (existing && existing.role === 'admin'))) {
    throw new HttpError(403, 'إنشاء المديرين وتعديل حساباتهم لمالك النظام وحده');
  }
  if (!actorIsOwner) {
    parentId = existing ? (existing.parent_id || null) : null;
    rate = existing ? (existing.rate == null ? null : Number(existing.rate)) : null;
    parentRate = existing ? (existing.parent_rate == null ? null : Number(existing.parent_rate)) : null;
  }
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
    validatePassword(password, username);
    await env.DB.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at, parent_id, rate, parent_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), username, name, await hashPassword(password), role, active ? 1 : 0, now(), parentId, rate, parentRate).run();
  } else {
    const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").bind(body.id).first();
    if (Number(admins.n) === 0 && (role !== 'admin' || !active)) throw new HttpError(400, 'لا يمكن إزالة صلاحية آخر مدير أو إيقافه');
    if (password) validatePassword(password, username);
    const stmts = [];
    if (password) stmts.push(env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, active = ?, password_hash = ?, must_change_password = 0, parent_id = ?, rate = ?, parent_rate = ? WHERE id = ?').bind(name, username, role, active ? 1 : 0, await hashPassword(password), parentId, rate, parentRate, body.id));
    else stmts.push(env.DB.prepare('UPDATE users SET name = ?, username = ?, role = ?, active = ?, parent_id = ?, rate = ?, parent_rate = ? WHERE id = ?').bind(name, username, role, active ? 1 : 0, parentId, rate, parentRate, body.id));
    // إنهاء الجلسات الأخرى عند تغيير كلمة المرور أو الإيقاف
    if (password || !active) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').bind(body.id, myToken || ''));
    await env.DB.batch(stmts);
  }
  return { ok: true, users: await listUsers(env) };
}

async function deleteUser(env, me, id) {
  if (id === me.id) throw new HttpError(400, 'لا يمكنك حذف حسابك الحالي');
  const ownerId = ownerIdOf(env);
  if (ownerId && String(id) === ownerId) throw new HttpError(400, 'لا يمكن حذف مالك النظام');
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
  // حذف أي مدير للمالك وحده
  if (target && target.role === 'admin' && !(me && me.isOwner === true)) throw new HttpError(403, 'حذف المديرين لمالك النظام وحده');
  const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").bind(id).first();
  if (Number(admins.n) === 0) throw new HttpError(400, 'لا يمكن حذف آخر مدير في النظام');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return { ok: true, users: await listUsers(env) };
}

/* ------------------------------ صلاحيات المستخدم التفصيلية (admin) ------------------------------
   تجاوزات لكل مستخدم فوق افتراضيات الدور، مخزّنة في user_permissions.
   - Deny يتقدّم على السماح؛ admin.core لا يُمنح ولا يُسحب (دور فقط).
   - fail-closed: تعذّر القراءة = لا صلاحيات (انظر loadUserPermissions).
   - كل تعديل يُسجَّل في permission_audit (ذرّي مع التنفيذ عبر batch واحد).
   - التغييرات تسري فوراً على الطلبات اللاحقة (تُقرأ الصلاحيات مع كل طلب). */

/** حدود إدارة الصلاحيات: صلاحيات المالك ثابتة (كاملة) لا تُعدَّل، وصلاحيات أي مدير يديرها
    المالك وحده — مدير عادي ممنوح permissions.manage يدير الموظفين والمناديب فقط. */
function assertPermTarget(env, actor, row, writing) {
  const ownerId = ownerIdOf(env);
  if (ownerId && String(row.id) === ownerId) {
    if (writing) throw new HttpError(400, 'صلاحيات مالك النظام كاملة وثابتة — لا تُعدَّل');
    return;
  }
  if (row.role === 'admin' && !(actor && actor.isOwner === true)) throw new HttpError(403, 'صلاحيات المديرين يديرها مالك النظام وحده');
}

/** قراءة صلاحيات مستخدم: الافتراضيات والتجاوزات والفعّالة */
async function getUserPermissions(env, actor, targetId) {
  requirePerm(actor, 'permissions.manage');
  const row = await env.DB.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').bind(targetId).first();
  if (!row) throw new HttpError(404, 'المستخدم غير موجود');
  assertPermTarget(env, actor, row, false);
  const load = await loadUserPermissions(env, targetId);
  const loadFailed = !(load && load.ok);
  const overrides = (load && load.ok && load.overrides) ? load.overrides : {};
  const defaults = ROLE_PERMISSIONS[row.role] ? [...ROLE_PERMISSIONS[row.role]] : [];
  return {
    ok: true,
    userId: row.id, name: row.name, role: row.role, active: !!row.active,
    permissionsLoadFailed: loadFailed,
    defaults,
    // افتراضيات كل الأدوار: تعرض الواجهة أثر تغيير الدور قبل حفظه (عرض فقط؛ الفرض هنا في الخادم)
    roleDefaults: Object.fromEntries(Object.keys(ROLE_PERMISSIONS).map((r) => [r, [...ROLE_PERMISSIONS[r]]])),
    overrides,
    protected: PROTECTED_ADMIN_PERMISSIONS.slice(),
    adminOnly: ADMIN_ONLY_PERMISSIONS.slice(),
    catalog: Object.keys(PERMISSIONS),
    // للعرض فقط: المالك بصلاحيات كاملة ثابتة، ومن يطلب هل هو المالك (يقرر قفل الإدارية في النافذة)
    targetIsOwner: !!ownerIdOf(env) && String(row.id) === ownerIdOf(env),
    actorIsOwner: actor && actor.isOwner === true,
  };
}

/** استبدال تجاوزات المستخدم بالكامل (ما ليس في القائمة = افتراضي الدور) */
async function saveUserPermissions(env, actor, targetId, body) {
  requirePerm(actor, 'permissions.manage');
  const row = await env.DB.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').bind(targetId).first();
  if (!row) throw new HttpError(404, 'المستخدم غير موجود');
  assertPermTarget(env, actor, row, true);

  const raw = body && typeof body === 'object' && body.overrides && typeof body.overrides === 'object' ? body.overrides : null;
  if (!raw) throw new HttpError(400, 'صيغة غير صالحة: overrides مطلوبة');

  const clean = {};
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, key)) throw new HttpError(400, 'صلاحية غير معروفة: ' + key);
    if (PROTECTED_ADMIN_PERMISSIONS.includes(key)) throw new HttpError(400, 'صلاحية ' + key + ' لا تُمنح ولا تُسحب — تُعطى بالدور فقط');
    const v = raw[key];
    if (!(v === 0 || v === 1 || v === '0' || v === '1' || v === true || v === false)) throw new HttpError(400, 'قيمة غير صالحة للصلاحية: ' + key);
    clean[key] = (v === true || v === 1 || v === '1') ? 1 : 0;
    if (ADMIN_ONLY_PERMISSIONS.includes(key)) {
      // منح الإدارة الكاملة وسحبها لمالك النظام وحده، ومنحها لمدير عادي فقط
      if (!(actor && actor.isOwner === true)) throw new HttpError(403, 'صلاحية ' + key + ' يديرها مالك النظام وحده');
      if (clean[key] === 1 && row.role !== 'admin') throw new HttpError(400, 'صلاحية ' + key + ' للمدير فقط — لا تُمنح لموظف أو مندوب');
    }
  }
  // قفل ذاتي ممنوع: لا يسحب أحدٌ إدارة الصلاحيات من نفسه
  if (actor.id === targetId && clean['permissions.manage'] === 0) {
    throw new HttpError(400, 'لا يمكنك سحب إدارة الصلاحيات من نفسك');
  }

  const before = await loadUserPermissions(env, targetId);
  const beforeMap = (before && before.ok && before.overrides) ? before.overrides : {};
  const t = now();
  const reason = body && body.reason ? String(body.reason).slice(0, 200) : null;
  const stmts = [env.DB.prepare('DELETE FROM user_permissions WHERE user_id = ?').bind(targetId)];
  const changed = [];
  for (const key of Object.keys(clean)) {
    stmts.push(env.DB.prepare('INSERT INTO user_permissions (user_id, permission, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(targetId, key, clean[key], actor.id, t));
    const oldV = Object.prototype.hasOwnProperty.call(beforeMap, key) ? beforeMap[key] : null;
    if (String(oldV) !== String(clean[key])) changed.push({ permission: key, oldValue: oldV, newValue: clean[key] });
  }
  // الصلاحيات التي كانت متجاوزة وأُزيلت = عادت إلى افتراضي الدور
  for (const key of Object.keys(beforeMap)) {
    if (!Object.prototype.hasOwnProperty.call(clean, key)) changed.push({ permission: key, oldValue: beforeMap[key], newValue: 'default' });
  }
  for (const c of changed) {
    stmts.push(env.DB.prepare('INSERT INTO permission_audit (id, at, actor_user_id, actor_name, target_user_id, target_name, change_type, permission, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), t, actor.id, actor.name || '', targetId, row.name, 'permission', c.permission, c.oldValue == null ? null : String(c.oldValue), String(c.newValue), reason));
  }
  await env.DB.batch(stmts);
  return { ok: true, saved: Object.keys(clean).length, changed: changed.length };
}

/** إعادة الصلاحيات إلى افتراضي الدور (مسح كل التجاوزات) */
async function resetUserPermissions(env, actor, targetId, body) {
  requirePerm(actor, 'permissions.manage');
  const row = await env.DB.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').bind(targetId).first();
  if (!row) throw new HttpError(404, 'المستخدم غير موجود');
  assertPermTarget(env, actor, row, true);
  const before = await loadUserPermissions(env, targetId);
  const beforeMap = (before && before.ok && before.overrides) ? before.overrides : {};
  const t = now();
  const reason = body && body.reason ? String(body.reason).slice(0, 200) : null;
  const stmts = [env.DB.prepare('DELETE FROM user_permissions WHERE user_id = ?').bind(targetId)];
  stmts.push(env.DB.prepare('INSERT INTO permission_audit (id, at, actor_user_id, actor_name, target_user_id, target_name, change_type, permission, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uid(), t, actor.id, actor.name || '', targetId, row.name, 'defaults_restore', null, JSON.stringify(beforeMap), 'default', reason));
  await env.DB.batch(stmts);
  return { ok: true, restored: Object.keys(beforeMap).length };
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
  // لا يُعاد إلا مرة واحدة (أول تشغيل فقط على قاعدة فارغة)
  if (seeded) {
    try {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      if (Number(c && c.n) > 0) return;
    } catch (e) { /* fall through to re-seed */ }
    seeded = false;
  }
  if (seeded) return;
  /* جداول القياس تُنشأ أولاً لأنها لا تعتمد على أي جدول آخر: إن فشل أي تعديل
     أعمدة أدناه (قاعدة ناقصة/غير مهيّأة) لا يُسقط إنشاء جدول الزيارات. */
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS link_visits (day TEXT NOT NULL, link TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, link))').run().catch(ignoreExistsObject);
  // جداول وأعمدة جديدة بعد النشر الأول: تُنشأ هنا حتى لا يحتاج صاحب المحل إعادة تشغيل schema.sql
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS login_fail (k TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at TEXT NOT NULL, until TEXT)').run();
  /* ===== تحليلات لوحة المالك =====
      لا نسجّل أي شيء يكشف الهوية — لا ربط بين الحدث وIP أو
     بصمة جهاز. المفتاح مركّب من (يوم، نوع الحدث، البُعد اختياري) والعداد رقم فقط.
     بهذا الشكل لا يمكن ربط أي حدث بهوية عميل من الجدول نفسه إطلاقاً، ولا يمكن
     استخدام البيانات للتسويق، ولا يتجاوز السجل عدداً ثابتاً من الصفوف. */
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS analytics_events (day TEXT NOT NULL, name TEXT NOT NULL, dim TEXT NOT NULL DEFAULT \'\', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name, dim))').run().catch(ignoreExistsObject);
  // أعمدة المندوب (هيكل متعدد المستويات ونسب العمولة)
  await env.DB.prepare('ALTER TABLE users ADD COLUMN parent_id TEXT').run().catch(ignoreExistsColumn);
  await env.DB.prepare('ALTER TABLE users ADD COLUMN rate REAL').run().catch(ignoreExistsColumn);
  await env.DB.prepare('ALTER TABLE users ADD COLUMN parent_rate REAL').run().catch(ignoreExistsColumn);
  // إجبار تغيير كلمة المرور للحسابات الجديدة فقط: الافتراضي = 0
  await env.DB.prepare('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0').run().catch(ignoreExistsColumn);
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
    // كلمة المرور المؤقتة: تُؤخذ من البيئة لا من الكود، وتُلزم بالتغيير عند أول دخول (ADMIN_INIT_PASSWORD).
    // لا تُنشأ كلمة مرور افتراضية إطلاقاً؛ وغيابها يترك النظام بلا مدير حتى يضبطه المالك.
    const initPassword = env && env.ADMIN_INIT_PASSWORD ? String(env.ADMIN_INIT_PASSWORD) : null;
    if (initPassword) {
      validatePassword(initPassword);
      await env.DB.prepare(`INSERT INTO users (id, username, name, password_hash, role, active, created_at, must_change_password)
        SELECT ?, ?, ?, ?, ?, 1, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`)
        .bind(uid(), 'admin', 'مدير النظام', await hashPassword(initPassword), 'admin', now()).run();
    }
  }
  seeded = true;
}

/* ------------------------------ كلمات المرور (PBKDF2) ------------------------------ */
const DEFAULT_ITER = 100000; // Cloudflare Workers limit: crypto.subtle.deriveBits(PBKDF2) max 100000 iterations

/* كلمات المرور الشائعة ممنوعة — قائمة الحظر تغطي الأشهر عالمياً. */
const COMMON_PASSWORDS = new Set([
  '123456','password','admin','12345678','qwerty','123456789','12345','1234567890','111111','123123',
  'abc123','password1','iloveyou','welcome','monkey','dragon','football','shadow','master','michael',
  'superman','qazwsx','trustno1','batman','letmein','000000','654321','7777777','987654321',
  'qwertyuiop','asdfghjkl','zxcvbnm','pass','root','toor','administrator','guest','user','test','demo',
  '1234','1234567','ali','ahmed','mohammed','saudi','riyadh','majlis','asalh','najd',
]);

function validatePassword(password, username) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) throw new HttpError(400, 'كلمة المرور شائعة جداً — اختر غيرها');
  if (username && lower === String(username).toLowerCase()) throw new HttpError(400, 'لا يجوز أن تكون كلمة المرور هي اسم المستخدم');
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, DEFAULT_ITER);
  return `pbkdf2$${DEFAULT_ITER}$${b64(salt)}$${b64(hash)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]) || DEFAULT_ITER;
  if (iter > 100000) return false; // Cloudflare Workers limit: cannot verify >100000 iterations
  const hash = await pbkdf2(password, unb64(parts[2]), iter);
  return timingSafeEqual(b64(hash), parts[3]);
}

/* ترقية تجزئة كلمة المرور عند الدخول: تُحدَّث الخوارزمية دون تغيير كلمة المرور نفسها. */
async function maybeUpgradePassword(env, userId, password, stored) {
  const parts = String(stored || '').split('$');
  const storedIter = parts.length === 4 && parts[0] === 'pbkdf2' ? Number(parts[1]) || DEFAULT_ITER : DEFAULT_ITER;
  if (storedIter < DEFAULT_ITER && storedIter <= 100000) {
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), userId).run();
  }
}

async function changePassword(env, user, myToken, body) {
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (!currentPassword || !newPassword) throw new HttpError(400, 'أدخل كلمة المرور الحالية والجديدة');
  const u = await env.DB.prepare('SELECT id, username, password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!u || !(await verifyPassword(currentPassword, u.password_hash))) throw new HttpError(401, 'كلمة المرور الحالية غير صحيحة');
  validatePassword(newPassword, u.username);
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').bind(await hashPassword(newPassword), u.id),
    // إنهاء الجلسات الأخرى عند تغيير كلمة المرور؛ الجلسة الحالية تبقى
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').bind(u.id, myToken || ''),
  ]);
  return { ok: true };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* استرداد حساب مالك النظام عند فقدان الوصول — بلا أي سر في الكود:
   1) صاحب حساب Cloudflare يضبط Secret مؤقتاً OWNER_RECOVERY_CODE (16 حرفاً فأكثر يختارها).
   2) POST /api/owner/recover { code, newPassword }: يعيد كلمة مرور المالك وحده (المعرّف من
      OWNER_USER_ID)، ويعيد تفعيله ودوره مديراً، وينهي كل جلساته.
   3) كل رمز يُقبل مرة واحدة (تُحفظ بصمته في counters)، والمحاولات محدودة كالدخول.
   4) يُحذف الـ Secret بعد الاستخدام. بلا السرّين معاً المسار غير موجود (404). */
async function ownerRecover(env, body, request) {
  const ownerId = ownerIdOf(env);
  const secret = env && env.OWNER_RECOVERY_CODE != null ? String(env.OWNER_RECOVERY_CODE) : '';
  if (!ownerId || secret.length < 16) throw new HttpError(404, 'المسار غير موجود');
  const ip = (request && request.headers.get('CF-Connecting-IP')) || '';
  const keys = ['recover:owner'].concat(ip ? ['recover:ip:' + ip] : []);
  const mins = await loginLocked(env, keys);
  if (mins) throw new HttpError(429, `محاولات كثيرة — أعد المحاولة بعد ${mins} دقيقة`);
  const given = await sha256Hex(String((body && body.code) || ''));
  const expected = await sha256Hex(secret);
  if (!timingSafeEqual(given, expected)) { await loginFailed(env, keys); throw new HttpError(403, 'رمز الاسترداد غير صحيح'); }
  const usedKey = 'owner_recovery:' + expected;
  const used = await env.DB.prepare('SELECT value FROM counters WHERE key = ?').bind(usedKey).first();
  if (used) throw new HttpError(410, 'هذا الرمز استُخدم من قبل — اضبط رمزاً جديداً في Cloudflare');
  const owner = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(ownerId).first();
  if (!owner) throw new HttpError(400, 'حساب المالك المحدد في OWNER_USER_ID غير موجود');
  const newPassword = String((body && body.newPassword) || '');
  validatePassword(newPassword, owner.username);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, active = 1, role = 'admin' WHERE id = ?").bind(await hashPassword(newPassword), ownerId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(ownerId),
    env.DB.prepare('INSERT INTO counters (key, value) VALUES (?, 1)').bind(usedKey),
    ...keys.map((k) => env.DB.prepare('DELETE FROM login_fail WHERE k = ?').bind(k)),
  ]);
  return { ok: true, username: owner.username };
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
      'Cache-Control': (key === '/index.html' || key === '/sw.js' || key.endsWith('.js')) ? 'no-cache' : 'public, max-age=300',
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
/* سياسة CORS صارمة: لا يُقبل إلا النطاقات المذكورة في ALLOWED_ORIGIN (بدونها لا شيء).
    '*' لا يُقبل؛ النطاقات تُفصل بفواصل وكل نطاق مستقل — وتُعاد فقط الترويسة المطابقة للأمان.
    (Authorization? x-session-token) مع نطاق مذكور فقط — فلا تتسرب الجلسة لنطاق غير مصرّح. */
function parseAllowedOrigins(env) {
  const raw = env && env.ALLOWED_ORIGIN ? String(env.ALLOWED_ORIGIN) : '';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.includes('*')) return null;
  return new Set(parts);
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = parseAllowedOrigins(env);
  const headers = {
    // PUT مطلوب: الواجهة تعدّل التصاميم والمصروفات بـ PUT، وتطبيق أندرويد (المصدر https://localhost) يمرّ بفحص مسبق
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // fail-closed: لا تُعاد أي ترويسة سماح إلا لمطابقة النطاق المسموح
  if (origin && allowed && allowed.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
