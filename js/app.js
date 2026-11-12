/* ======================================================================
   App: منطق التطبيق (الدخول، الطلب، التسعير، الدفع، التصدير، الطلبات، الأصناف، المستخدمون)
   ====================================================================== */
(async function () {
  'use strict';

  /* ---------------- أدوات عامة ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const r2 = (v) => Math.round(num(v) * 100) / 100;
  /** الوحدة الداخلية هللة (0.01): كل مبلغ يُقرَّب لهللتين في الحساب (10.50 تبقى 10.50).
      البيانات القديمة الصحيحة تبقى صحيحة (10 ← 10.00). الفصل: money للحساب، fmt للعرض.
      ‎+1e-9‎ يصحح خطأ التمثيل الثنائي عند حدود النصف تماماً (مثل 1.005←1.01 بدل 1.00)؛
      أصغر بكثير من أي فرق حقيقي، وآمن للمبالغ الواقعية (أقل من الملايين). */
  const money = (v) => Math.round((num(v) + 1e-9) * 100) / 100;
  const fmt = (v) => money(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** الكميات بالمتر والنسب المئوية تبقى بكسرين */
  const fmtQty = (v) => r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** رقم صارم للسياقات المالية: يرفض النصوص الجزئية ("10abc") وNaN وInfinity.
      يُرجع null عند الرفض (لا يُخمَّن صفراً) — والقرار للسياق (خطأ حقلي/تجاهل).
      num() العامة تُترك كما هي (103 مواضع بين هندسة وواجهة) لتفادي كسر غير مالي. */
  function strictNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const pad2 = (n) => String(n).padStart(2, '0');
  // التواريخ تُعرض بالتوقيت المحلي (القيم المخزنة ISO بتوقيت UTC، وتواريخ التوصيل نص YYYY-MM-DD)
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const s = String(iso);
    if (!s.includes('T')) return s.slice(0, 10);
    const d = new Date(s);
    return isNaN(d) ? s.slice(0, 10) : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const fmtDateTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return String(iso); return `${fmtDate(d.toISOString())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  /* للعرض داخل جملة عربية: عزل الاتجاه (LRI…PDI) يبقي «التاريخ ثم الوقت» بترتيبه بدل أن ينقلب إلى «12:41 2026-11-04».
     لا يُستعمل في CSV/Excel/PDF حتى لا تدخل محارف خفية في الملفات. */
  const fmtDateTimeUi = (iso) => String.fromCharCode(0x2066) + fmtDateTime(iso) + String.fromCharCode(0x2069);
  const STATUS = { quote: 'عرض سعر', new: 'جديد', progress: 'قيد التنفيذ', done: 'اكتمال التنفيذ', delivered: 'تم التوصيل', cancelled: 'ملغي' };

  /* ---------------- الصلاحيات: تصنيفات وأسماء عربية للعرض ----------------
     الترتيب يعرض الأقسام بالترتيب المنطقي للعمل. admin.core محمية (دور فقط). */
  const PERM_UI = [
    ['الطلبات', [
      ['orders.view_own', 'عرض طلباته'],
      ['orders.view_all', 'عرض كل الطلبات'],
      ['orders.create', 'إنشاء طلب'],
      ['orders.edit_own', 'تعديل طلباته'],
      ['orders.edit_all', 'تعديل كل الطلبات'],
      ['orders.delete_own', 'حذف طلباته'],
      ['orders.delete_all', 'حذف أي طلب'],
    ]],
    ['التكاليف', [
      ['costs.view_own', 'عرض تكاليفه'],
      ['costs.view_all', 'عرض كل التكاليف'],
      ['costs.add_own', 'إضافة تكاليفه'],
      ['costs.add_all', 'إضافة تكاليف لأي طلب'],
      ['costs.edit_own', 'تعديل تكاليفه'],
      ['costs.edit_all', 'تعديل أي تكاليف'],
      ['costs.delete_own', 'حذف تكاليفه'],
      ['costs.delete_all', 'حذف أي تكاليف'],
    ]],
    ['الأرباح والعمولات', [
      ['profit.view_own', 'عرض أرباحه'],
      ['profit.view_all', 'عرض كل الأرباح'],
      ['commission.view_own', 'عرض عمولاته'],
      ['commission.view_all', 'عرض كل العمولات'],
    ]],
    ['الدفعات', [
      ['payments.add', 'تسجيل دفعة أو استرداد'],
      ['payments.edit', 'تعديل دفعة مسجّلة'],
      ['payments.delete', 'حذف دفعة'],
    ]],
    ['التقارير', [
      ['reports.view_own', 'تقاريره فقط'],
      ['reports.view_all', 'كل التقارير'],
      ['reports.export', 'تصدير التقارير (PDF وExcel)'],
    ]],
    ['المصروفات', [
      ['expenses.view_own', 'عرض مصروفاته'],
      ['expenses.view_all', 'عرض كل المصروفات'],
      ['expenses.add_own', 'إضافة مصروفاته'],
      ['expenses.add_all', 'تسجيل مصروف باسم موظف آخر'],
      ['expenses.edit_own', 'تعديل مصروفاته'],
      ['expenses.edit_all', 'تعديل أي مصروف'],
      ['expenses.delete_own', 'حذف مصروفاته'],
      ['expenses.delete_all', 'حذف أي مصروف'],
    ]],
    ['الأصناف والأسعار', [
      ['items.manage', 'إدارة الأصناف والأسعار'],
    ]],
    ['تصاميم العملاء', [
      ['designs.view', 'عرض تصاميم العملاء'],
      ['designs.edit', 'تعديل التصاميم وحالتها'],
      ['designs.convert', 'تحويل تصميم إلى طلب'],
      ['designs.delete', 'حذف التصاميم'],
    ]],
    ['المستخدمون والصلاحيات', [
      ['users.view', 'عرض المستخدمين'],
      ['users.create', 'إنشاء مستخدم'],
      ['users.edit', 'تعديل مستخدم'],
      ['users.disable', 'إيقاف مستخدم'],
      ['permissions.manage', 'إدارة الصلاحيات'],
    ]],
    ['إشعارات واتساب', [
      ['notifications.whatsapp.view', 'عرض الخدمة وسجل الإرسال (يشمل أرقام الطلبات ومبالغها)'],
      ['notifications.whatsapp.manage', 'إدارة المستلمين والقوالب'],
      ['notifications.whatsapp.send', 'إرسال التنبيهات (فتح واتساب)'],
    ]],
    ['الإعدادات', [
      ['settings.manage', 'إدارة إعدادات المحل'],
    ]],
    ['الإدارة العامة', [
      ['admin.core', 'صلاحيات المدير العام'],
    ]],
  ];
  const PERM_PROTECTED = ['admin.core'];
  /* الإدارة الكاملة للمدير وحده: تُعرض مقفلة لغير المدير (الخادم يرفض منحها ويتجاهل أي منح) */
  const PERM_ADMIN_ONLY = ['admin.core', 'permissions.manage', 'users.create', 'users.edit', 'users.disable', 'settings.manage'];
  /** عرض السعر ليس بيعاً بعد، والملغي لم يعد بيعاً: كلاهما خارج كل مبلغ مبيعات */
  const isSale = (o) => !!o && o.status !== 'cancelled' && o.status !== 'quote';
  /* «يشمل التقرير»: أي الطلبات تُحسب مبيعاتٍ وأرباحاً في التقارير وذكاء الأعمال (اختيار واحد مشترك يُحفظ على الجهاز).
     افتراضياً بلا «جديد» (لم يبدأ تنفيذه بعد). */
  const INC_KEY = 'majlis_rep_inc';
  function getInclude() {
    const D = (window.Reports && Reports.DEFAULT_INCLUDE) || { statuses: ['progress', 'done', 'delivered'], paidOnly: false };
    try {
      const v = JSON.parse(localStorage.getItem(INC_KEY) || 'null');
      if (v && Array.isArray(v.statuses)) return { statuses: v.statuses.filter((s) => ['new', 'progress', 'done', 'delivered'].includes(s)), paidOnly: !!v.paidOnly };
    } catch (_) { /* قيمة تالفة ← الافتراضي */ }
    return { statuses: D.statuses.slice(), paidOnly: !!D.paidOnly };
  }
  function setInclude(inc) { try { localStorage.setItem(INC_KEY, JSON.stringify(inc)); } catch (_) { /* تخزين غير متاح */ } }
  const incCounted = (o) => (window.Reports && Reports.counted ? Reports.counted({ include: getInclude() }, o) : isSale(o));
  const includeLabel = () => (window.Reports && Reports.includeText ? Reports.includeText({ include: getInclude(), labels: { STATUS } }) : '');
  /** أزرار «يشمل التقرير» في حاوية — opts.noPaid يخفي «المدفوعة بالكامل فقط»، وonChange بعد كل تغيير */
  function renderIncludeChips(box, opts) {
    if (!box) return;
    const inc = getInclude();
    const st = ['new', 'progress', 'done', 'delivered'];
    box.innerHTML = '<span class="ri-lbl">يشمل التقرير:</span>'
      + st.map((k) => { const on = inc.statuses.includes(k); return `<button type="button" class="chip${on ? ' on' : ''}" data-inc="${k}" aria-pressed="${on}"><i class="st-dot st-${k}"></i>${esc(STATUS[k])}</button>`; }).join('')
      + (opts && opts.noPaid ? '' : `<span class="ri-sep" aria-hidden="true"></span><button type="button" class="chip${inc.paidOnly ? ' on' : ''}" data-incpay="1" aria-pressed="${inc.paidOnly}">المدفوعة بالكامل فقط</button>`)
      + (inc.statuses.includes('new') ? '' : '<span class="ri-hint">الطلبات الجديدة خارج الأرقام — تجدها في تقرير «الطلبات الجديدة»</span>');
    box.onclick = (e) => {
      const b = e.target.closest ? e.target.closest('[data-inc], [data-incpay]') : null;
      if (!b) return;
      const cur = getInclude();
      if (b.dataset.incpay) cur.paidOnly = !cur.paidOnly;
      else {
        const k = b.dataset.inc, i = cur.statuses.indexOf(k);
        if (i >= 0) { if (cur.statuses.length === 1) { toast('اختر حالة واحدة على الأقل', true); return; } cur.statuses.splice(i, 1); }
        else cur.statuses.push(k);
      }
      setInclude(cur);
      if (opts && opts.onChange) opts.onChange();
    };
  }
  /** طلب مفتوح: بيع لم يُسلَّم بعد */
  const OPEN_STATUSES = ['new', 'progress', 'done'];
  const isOpen = (o) => OPEN_STATUSES.includes((o && o.status) || 'new');
  /** طرق الدفع — الاسترداد دفعة بمبلغ سالب */
  const PAY_METHODS = { cash: 'نقداً', mada: 'مدى / شبكة', transfer: 'تحويل بنكي', card: 'بطاقة ائتمان', other: 'أخرى' };

  /* عرض القوائم على دفعات: الجوال يتعثّر عند رسم مئات الصفوف دفعة واحدة */
  const PAGE_STEP = 50;
  let ordersShown = PAGE_STEP;
  let itemsShown = PAGE_STEP;
  function renderMoreBar(el, shown, matched, onMore) {
    if (!el) return;
    if (shown >= matched) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = `<button class="btn block">عرض المزيد — ${shown} من ${matched}</button>`;
    el.querySelector('button').addEventListener('click', onMore);
  }
  const ROLES = { admin: 'مدير', staff: 'موظف', mandoub: 'مندوب' };
  const APP_VERSION = '0.0.0-dev';
  const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
  const currency = () => Store.db.settings.currency || 'ر.س';
  const isMobile = () => window.matchMedia('(max-width: 960px)').matches;
  const isCoarse = window.matchMedia('(pointer: coarse)').matches;

  /* ---------------- قائمة إجراءات الصف ----------------
     زر «إجراءات» نصي (مع أيقونة ⋯) يجمع الإجراءات الثانوية بدل زر غامض بلا نص.
     عناصر القائمة تبقى داخل الصف نفسه (بسماتها data-*) فتعمل روابط الأحداث
     القائمة عليها كما هي، والقائمة تُعرض بموضع ثابت على الشاشة حتى لا يقصّها
     تمرير الجدول. */
  const menuItem = (attrs, ico, label, danger = false) =>
    `<button type="button" role="menuitem" ${attrs}${danger ? ' class="danger"' : ''}>${icon(ico)}<span>${label}</span></button>`;
  function rowMenu(items, label = 'إجراءات أخرى') {
    const list = items.filter(Boolean);
    if (!list.length) return '';
    return `<span class="rmenu"><button type="button" class="btn small ghost rmenu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${label}" title="${label}">${icon('more')}<span>إجراءات</span></button><span class="rmenu-list" role="menu" hidden>${list.join('')}</span></span>`;
  }
  let openMenu = null;
  function closeRowMenu(refocus = false) {
    if (!openMenu) return;
    const { btn, list } = openMenu;
    openMenu = null;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus && btn.isConnected) btn.focus({ preventScroll: true });
  }
  function openRowMenu(btn) {
    const list = btn.nextElementSibling;
    if (!list) return;
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const lw = list.offsetWidth, lh = list.offsetHeight;
    // RTL: تمتد القائمة من حافة الزر اليسرى نحو داخل الجدول، وتنقلب للأعلى قرب أسفل الشاشة
    list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - lw - 8)) + 'px';
    let top = r.bottom + 6;
    if (top + lh > window.innerHeight - 8) top = Math.max(8, r.top - lh - 6);
    list.style.top = top + 'px';
    openMenu = { btn, list };
    const first = list.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.rmenu-btn');
    if (btn) {
      const same = openMenu && openMenu.btn === btn;
      closeRowMenu();
      if (!same) openRowMenu(btn);
      return;
    }
    // عنصر داخل القائمة: يعمل مستمعه الخاص أولاً (الحدث يصعد إلى هنا بعده) ثم تُغلق.
    // قوائم data-keep (تبديل الأعمدة) تبقى مفتوحة ليُبدَّل أكثر من عمود بفتحة واحدة.
    if (openMenu && e.target.closest('.rmenu-list[data-keep]') === openMenu.list) return;
    if (openMenu) closeRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    const items = [...openMenu.list.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRowMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'Tab') closeRowMenu();
  }, true);
  window.addEventListener('scroll', () => closeRowMenu(), true);
  window.addEventListener('resize', () => closeRowMenu());

  let toastTimer;
  /** kind: false/'ok' نجاح، true/'err' خطأ، 'info' معلومة محايدة.
      الخطأ يبقى أطول ويُعلَن لقارئ الشاشة فوراً (role=alert)، ويُغلق بالضغط عليه. */
  function toast(msg, kind = false) {
    const err = kind === true || kind === 'err';
    const t = $('#toast');
    // أيقونة صغيرة تميّز النجاح من الخطأ من المعلومة دون الاعتماد على اللون وحده
    t.innerHTML = `${icon(err ? 'alert' : kind === 'info' ? 'info' : 'check')}<span></span>`;
    $('span', t).textContent = msg;
    t.className = 'toast show' + (err ? ' err' : kind === 'info' ? ' info' : '');
    if (err) { const a = $('#toastAlert'); a.textContent = ''; requestAnimationFrame(() => (a.textContent = msg)); }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), err ? 7000 : 2800);
  }
  $('#toast').addEventListener('click', () => { clearTimeout(toastTimer); $('#toast').className = 'toast'; });

  /** رسالة بشرية قصيرة بدل نص الخادم الخام. التفاصيل الحقيقية تبقى في
      السجل فقط (console) ولا تُعرض للمستخدم ولا تتضمن أسراراً. */
  function humanError(raw, fallback = 'تعذّر حفظ التغييرات. تحقق من الاتصال وحاول مرة أخرى.') {
    const s = String(raw || '');
    try { console.error('[app-error]', s); } catch (_) { /* noop */ }
    if (!s) return fallback;
    if (/401|session|انتهت الجلسة|غير مسجّل/.test(s)) return 'انتهت الجلسة. سجّل الدخول مرة أخرى.';
    if (/409|conflict|تعارض/.test(s)) return 'وصل تغيير أحدث من جهاز آخر. حدّث الصفحة وحاول مجدداً.';
    if (/network|fetch|Network|اتصال|غير متصل|offline|ENOTFOUND|timed?\s*out/i.test(s)) return 'لا يوجد اتصال بالإنترنت. تحقق من الاتصال وحاول مجدداً.';
    // رسائل الخادم العربية مكتوبة للمستخدم (صلاحية، قيمة غير صالحة…): تُعرض كما هي —
    // كانت تُستبدل بـ«تحقق من الاتصال» فيبدو رفض الصلاحية مشكلة إنترنت
    if (/^غير مصرح$/.test(s.trim())) return 'لا تملك صلاحية هذا الإجراء (غير مصرح).';
    if (/[؀-ۿ]/.test(s) && s.length <= 200) return s.trim();
    return fallback;
  }

  let modalReturnFocus = null;
  let modalLocked = false;     // نافذة إجبارية (كلمة المرور الأولية): لا تُغلق بزر X ولا بالخارج ولا بـ Escape
  let keepPrintArea = false;   // زر «طباعة» يُبقي المستند في منطقة الطباعة حتى تنتهي
  /** قفل/فتح النافذة العامة. المقفلة تُغلق برمجياً فقط (بعد إتمام الخطوة الإجبارية). */
  function lockModal(on) {
    modalLocked = on === true;
    const x = $('#modalClose');
    if (x) x.hidden = modalLocked;
  }
  /** cls: صنف إضافي على النافذة (مثل wide للجداول العريضة)، يُزال عند الإغلاق */
  function openModal(title, bodyHtml, onMount, cls = '') {
    modalReturnFocus = document.activeElement;
    document.body.classList.add('modal-open');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modal').className = 'modal' + (cls ? ' ' + cls : '');
    $('#modal').hidden = false;
    if (onMount) onMount($('#modalBody'));
    // التركيز على أول حقل إدخال (لا زر الإغلاق) لتقليل ضغطات الموظف وفتح الكيبورد الصحيح
    requestAnimationFrame(() => {
      const first = $('#modalBody').querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      ((first && first.getClientRects().length ? first : $('#modalClose')) || {}).focus?.({ preventScroll: true });
    });
  }
  function closeModal() {
    $('#modal').hidden = true; $('#modal').className = 'modal'; $('#modalBody').innerHTML = '';
    // مستند التصدير لا يبقى في منطقة الطباعة بعد إغلاق نافذته: وإلا طبع Ctrl+P
    // لاحقاً أمر شراء قديم. زر «طباعة» وحده يُبقيه حتى تنتهي الطباعة.
    if (!keepPrintArea) $('#printArea').innerHTML = '';
    document.body.classList.remove('modal-open');
    if (modalReturnFocus && modalReturnFocus.isConnected) modalReturnFocus.focus({preventScroll:true});
  }
  $('#modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); if (modalLocked) return; const cancel = $('#cNo'); if (cancel) cancel.click(); else closeModal(); }
    if (e.key !== 'Tab') return;
    const controls = [...$('#modal').querySelectorAll('button,input,select,textarea,a[href]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('#modalClose').addEventListener('click', () => { if (!modalLocked) closeModal(); });
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal') && !modalLocked) closeModal(); });

  /** نافذة تأكيد. danger=false لتنبيه يُتابَع عادةً (زر أساسي لا أحمر) */
  function confirmDlg(title, msg, okLabel = 'تأكيد', danger = true) {
    return new Promise((res) => {
      openModal(title, `<p>${esc(msg)}</p><div class="btn-row"><button class="btn" id="cNo">إلغاء</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cYes">${esc(okLabel)}</button></div>`, (b) => {
        $('#cNo', b).onclick = () => { closeModal(); res(false); };
        $('#cYes', b).onclick = () => { closeModal(); res(true); };
      });
    });
  }

  await Store.init();
  const db = () => Store.db;
  const settings = () => db().settings;

  /* ---------------- الجلسة والدخول ---------------- */
  let currentUser = null;
  const isAdmin = () => currentUser && currentUser.role === 'admin';
  const isStaff = () => currentUser && (currentUser.role === 'admin' || currentUser.role === 'staff');

  /* ---------------- الصلاحيات في الواجهة (عرض فقط — الخادم يفرضها دائماً) ----------------
     المصدر: صلاحيات المستخدم الفعّالة من الخادم (Store.can). الوضع المحلي بلا خادم:
     المدير كل شيء، وغيره افتراضيات دوره (نفس افتراضيات الخادم). */
  const LOCAL_ROLE_DEFAULTS = {
    staff: ['orders.view_own', 'orders.create', 'orders.edit_own', 'costs.view_own', 'costs.add_own', 'costs.edit_own', 'profit.view_own', 'payments.add', 'designs.view'],
    mandoub: ['orders.view_own', 'orders.create', 'orders.edit_own', 'costs.view_own', 'costs.add_own', 'costs.edit_own', 'commission.view_own', 'payments.add'],
  };
  const can = (p) => !!currentUser && (Store.isRemote ? Store.can(p) : (isAdmin() || (LOCAL_ROLE_DEFAULTS[currentUser.role] || []).includes(p)));
  const canAny = (...ps) => ps.some(can);
  const ownsOrder = (o) => !!(o && o.createdBy && currentUser && o.createdBy === currentUser.id);
  /** صلاحية بنطاق الطلب: طلبك ‎_own (أو ‎_all)، وطلب غيرك أو بلا مالك ‎_all فقط */
  const canFor = (o, base) => (ownsOrder(o) && can(base + '_own')) || can(base + '_all');
  /** من يرى كل صفحة — نفس الصلاحية التي يفرضها الخادم على بياناتها */
  const PAGE_PERMS = {
    items: () => can('items.manage'),
    users: () => can('users.view'),
    activity: () => can('admin.core'),
    mandoubs: () => can('admin.core'),
    settings: () => can('settings.manage'),
    bi: () => canAny('reports.view_own', 'reports.view_all'),
    designs: () => can('designs.view'),
    expenses: () => canAny('expenses.view_own', 'expenses.view_all'),
    whatsapp: () => canAny('notifications.whatsapp.view', 'notifications.whatsapp.manage', 'notifications.whatsapp.send'),
    reports: () => canAny('reports.view_own', 'reports.view_all'),
    visits: () => can('admin.core'),
  };
  const canPage = (name) => !PAGE_PERMS[name] || PAGE_PERMS[name]();
  /* أقسام مدمجة: زر واحد في القائمة يفتح مجموعة صفحات تظهر كتبويبات أعلى كل صفحة منها */
  const PAGE_TABS = [
    [['reports', 'التقارير الجاهزة'], ['bi', 'لوحة الأرقام'], ['visits', 'زيارات الموقع']],
    [['users', 'المستخدمون'], ['activity', 'نشاط الموظفين']],
  ];
  // صفحات زر القائمة: صفحته الأساسية ثم الصفحات المدمجة معه (data-also)
  const navPages = (b) => [b.dataset.page].concat((b.dataset.also || '').split(/\s+/).filter(Boolean));
  const navAllowed = (b) => navPages(b).some(canPage);
  const navTarget = (b) => navPages(b).find(canPage) || b.dataset.page;
  function buildPageTabs() {
    PAGE_TABS.forEach((set) => set.forEach(([page]) => {
      const sec = document.getElementById('page-' + page);
      if (!sec || sec.querySelector('.page-tabs')) return;
      const nav = document.createElement('nav');
      nav.className = 'seg-chips page-tabs';
      nav.setAttribute('aria-label', 'أقسام هذه الصفحة');
      nav.innerHTML = set.map(([p, l]) => `<button type="button" class="chip${p === page ? ' on' : ''}" data-goto="${p}"${p === page ? ' aria-current="page"' : ''}>${esc(l)}</button>`).join('');
      const head = sec.querySelector('.page-head');
      if (head) head.after(nav); else sec.prepend(nav);
      nav.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b) showPage(b.dataset.goto); });
    }));
  }

  function applyPermissions() {
    $$('[data-admin]').forEach((el) => (el.hidden = !can('admin.core')));
    $$('[data-designs]').forEach((el) => (el.hidden = !can('designs.view')));
    // أزرار التنقل تتبع صلاحية صفحتها لا الدور
    $$('#mainNav button[data-page], #bottomNav button[data-page]').forEach((b) => { if (navPages(b).some((p) => PAGE_PERMS[p])) b.hidden = !navAllowed(b); });
    // التبويبات: كل تبويب يتبع صلاحية صفحته، والشريط يختفي إن بقي تبويب واحد
    buildPageTabs();
    $$('.page-tabs').forEach((nav) => {
      let shown = 0;
      $$('[data-goto]', nav).forEach((t) => { t.hidden = !canPage(t.dataset.goto); if (!t.hidden) shown++; });
      nav.hidden = shown < 2;
    });
    // عنوان قسم «الإدارة» يظهر فقط إن ظهرت تحته صفحة واحدة على الأقل
    $$('.sb-group').forEach((g) => {
      let n = g.nextElementSibling, any = false;
      // تُحسب الصفحات المقيّدة بصلاحية فقط («عن التطبيق» ظاهرة للجميع ولا تجعل القسم إدارياً)
      while (n && !n.classList.contains('sb-group')) { if (n.matches('button[data-page]') && PAGE_PERMS[n.dataset.page] && !n.hidden) any = true; n = n.nextElementSibling; }
      g.hidden = !any;
    });
    $$('[data-perm-export]').forEach((el) => (el.hidden = !can('reports.export')));
    $$('#ordersTable .c-comm').forEach((el) => (el.hidden = !canAny('commission.view_own', 'commission.view_all')));
    $('#currentUserName').textContent = currentUser.name || '';
    $('#currentUserRole').textContent = ROLES[currentUser.role] || currentUser.role || '';
    $('#userAvatar').textContent = (currentUser.name || '?').trim().charAt(0);
    $('#shopNameLbl').textContent = settings().shopName || 'أصالة نجد';
  }

  function enterApp(user) {
    currentUser = user;
    sessionStorage.setItem('majlis_session', user.id);
    $('#loginScreen').hidden = true;
    $('#app').hidden = false;
    applyPermissions();
    // في الوضع السحابي تصل الأصناف والإعدادات بعد الدخول، فتُبنى القوائم والطلب الجديد الآن
    renderItemSelects();
    renderCustomerSuggestions();
    const pending = readDraft();   // يُقرأ قبل أن يمسحه الطلب الجديد
    startNewOrder(true);
    resetNotifState();
    renderNotifications();
    showPage('order');
    // شارة تنبيهات واتساب الجاهزة — طلب خفيف صامت لمن يملك الخدمة فقط
    // وجلسة إرسال لم تكتمل (أُغلق التطبيق أثناءها) تُعرض للاستئناف
    setTimeout(() => { try { if (Store.isRemote && canPage('whatsapp')) waLoad().then(() => { if (wa.openSends.length && can(WA_P.send)) waResumeNudge(); }).catch(() => {}); } catch (_) { /* */ } }, 1200);
    requestAnimationFrame(() => designer.resize());
    setTimeout(() => offerDraftRestore(pending), 400);
    // فحص تحديث التطبيق تلقائياً: مرة واحدة لكل تشغيل، صامت تماماً عند أي فشل،
    // وبلا أي تأثير على الدخول أو الطلب الحالي (التفاصيل في js/update.js)
    setTimeout(() => {
      try {
        if (APP_VERSION.endsWith('-dev')) return;
        if (window.AppUpdate && typeof window.AppUpdate.initAutoCheck === 'function') {
          const p = window.AppUpdate.initAutoCheck({
            current: { versionName: APP_VERSION, versionCode: window.AppUpdate.versionCodeOf(APP_VERSION) },
          });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (_) { /* silent */ }
    }, 2500);
    // الشرح والمساعدة: يبدأ بعد الدخول فقط، لأن محتوى الدليل يختلف بين الموظف والمندوب.
    // مفتاح التفضيل منفصل لكل دور فيحتفظ كلٌّ منهم بحالته، ولا تتكرر النافذة بعد التخطي.
    setTimeout(() => {
      try {
        if (window.MajlisHelp) {
          window.MajlisHelp.init({
            key: isMandoubRole() ? 'mandoub' : 'staff',
            manualBtn: '#btnHelp',
            designer: (typeof designer !== 'undefined' ? designer : null),
          });
        }
      } catch (_) { /* الشرح لا يعطّل الدخول */ }
    }, 700);
  }

  /** المندوب دور مستقل يختلف محتواه عن الموظف — نتحقق من الدور الفعلي */
  function isMandoubRole() {
    return !!currentUser && currentUser.role === 'mandoub';
  }

  /** رابط صفحة تصميم العميل من شاشة الدخول: نفس المنشأ (يعمل إنتاج/تجريبي/محلي)،
      وداخل التطبيق الأصلي يفتح portal.html المضمّنة. تنقّل كامل بلا اعتماد على التطبيق. */
  function customerDesignUrl() {
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return 'portal.html';
    } catch (_) { /* noop */ }
    return window.location.origin + '/customer-design';
  }
  { const lc = $('#loginCustomer');
    if (lc) {
      const url = customerDesignUrl();
      lc.href = url;
      lc.addEventListener('click', (e) => { e.preventDefault(); window.location.href = url; });
    } }
  /** إظهار/إخفاء كلمة المرور: نص واضح بدل أيقونة غامضة، بلا أي تغيير في المصادقة */
  { const tgl = $('#passToggle'), pw = $('#loginPass');
    if (tgl && pw) tgl.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      tgl.textContent = show ? 'إخفاء' : 'إظهار';
      tgl.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
      tgl.setAttribute('aria-pressed', String(show));
      pw.focus({ preventScroll: true });
    }); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const un = $('#loginUser').value.trim();
    const pw = $('#loginPass').value;
    const btn = $('#loginForm button[type=submit]');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'جارٍ الدخول…';
    $('#loginError').textContent = '';
    let r;
    try { r = await Store.login(un, pw); }
    catch (e) { r = { ok: false, error: e.message }; }
    btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = 'دخول';
    if (!r.ok) {
      $('#loginError').textContent = r.error === 'bad_credentials' ? 'اسم المستخدم أو كلمة المرور غير صحيحة'
        : r.error === 'inactive' ? 'هذا الحساب موقوف'
        : r.error === 'locked' ? `محاولات دخول فاشلة كثيرة. حاول مجدداً بعد ${r.minutes || 15} دقيقة.`
        : r.error === 'password_needs_reset' ? 'كلمة المرور تحتاج إلى إعادة تعيين. تواصل مع المدير.'
        : (r.error || 'تعذر الدخول');
      return;
    }
    $('#loginPass').value = '';
    // كلمة المرور الأولية: بوابة إجبارية قبل دخول التطبيق — لا يدخل النظام قبل تغييرها
    if (r.mustChangePassword) { forcePasswordChange(r.user, pw, () => enterApp(r.user)); return; }
    enterApp(r.user);
  });

  /* الحساب بكلمة مرور أولية لا يدخل التطبيق قبل تغييرها: خطوة onboarding مؤقتة
     بلا زر تجاوز ولا إغلاق (X/الخارج/Escape)، ولا تُكشف الكلمة الأولية في أي رسالة.
     من غيّر كلمته سابقاً لا يمر من هنا أصلاً (mustChangePassword=false). */
  function forcePasswordChange(pendingUser, currentPassword, onDone) {
    if (!pendingUser) return;
    lockModal(true);
    openModal('إنشاء كلمة مرور جديدة', `
      <p>هذا الحساب ما زال يستخدم كلمة المرور الأولية. اختر كلمة مرور جديدة قبل المتابعة — لن تتمكن من استخدام النظام قبل ذلك.</p>
      <label>كلمة المرور الجديدة <input id="fpNew" type="password" autocomplete="new-password" minlength="8"></label>
      <label>تأكيد كلمة المرور <input id="fpNew2" type="password" autocomplete="new-password"></label>
      <p id="fpErr" class="error" role="alert"></p>
      <div class="btn-row"><button class="btn primary" id="fpOk">${icon('lock')} حفظ والدخول</button></div>`, (b) => {
      $('#fpOk', b).onclick = async () => {
        const p1 = $('#fpNew', b).value, p2 = $('#fpNew2', b).value;
        const err = $('#fpErr', b);
        if (p1.length < 8) { err.textContent = 'كلمة المرور 8 أحرف فأكثر'; return; }
        if (p1 !== p2) { err.textContent = 'كلمتا المرور غير متطابقتين'; return; }
        // المقارنة في الكود فقط: تمنع إعادة استخدام الكلمة الأولية المعروفة دون كشفها في أي رسالة
        if (p1 === 'admin') { err.textContent = 'اختر كلمة مرور مختلفة'; return; }
        try { await Store.changePassword(currentPassword, p1); }
        catch (e) { err.textContent = e.message || 'تعذر الحفظ'; return; }
        if (Store.token) localStorage.setItem(Store.TOKEN_KEY || 'majlis_token', Store.token);
        lockModal(false);
        closeModal();
        toast('تم إنشاء كلمة المرور');
        if (onDone) onDone();
      };
      requestAnimationFrame(() => { const el = $('#fpNew', b); if (el) el.focus(); });
    });
  }

  $('#btnLogout').addEventListener('click', async () => {
    if (dirty && !(await confirmDlg('خروج', 'لديك تغييرات غير محفوظة في الطلب الحالي. هل تريد الخروج؟'))) return;
    await Store.logout();
    currentUser = null;
    cur = newOrder(); setDirty(false);
    $('#draftBanner').hidden = true;
    closeDrawer();
    closeNotifPanel();
    resetNotifState();
    $('#app').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginUser').focus();
  });

  /* ---------------- التنقل ---------------- */
  function showPage(name) {
    if (!canPage(name)) name = 'order';
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
    $$('#mainNav button[data-page], #bottomNav button[data-page]').forEach((b) => {
      const on = navPages(b).includes(name);
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    // زر «القائمة» في الشريط السفلي يُضاء حين تكون الصفحة المفتوحة من خارج الشريط
    $('#btnMore').classList.toggle('active', !$(`#bottomNav button[data-page="${name}"]`));
    if (name !== 'order') designer.select(null);
    document.body.dataset.page = name;   // مساحة شريط أزرار الطلب في الجوال تخص صفحة الطلب وحدها
    closeDrawer();
    if (name === 'orders') renderOrders();
    if (name === 'customers') renderCustomers();
    if (name === 'activity') renderActivity();
    if (name === 'bi') renderBI();
    if (name === 'reports') renderReports();
    if (name === 'settings') renderSettings();
    if (name === 'mandoubs') renderMandoubs();
    if (name === 'designs') renderDesigns();
    if (name === 'about') renderAbout();
    if (name === 'visits') { try { renderVisitStats(); } catch (_) { /* noop */ } }
    if (['orders', 'customers', 'activity', 'items', 'users', 'bi', 'reports', 'mandoubs', 'designs'].includes(name)) syncFromServer();
    if (name === 'items') renderItems();
    if (name === 'users') renderUsers();
    if (name === 'expenses') renderExpenses();
    if (name === 'whatsapp') renderWhatsapp();
    if (name === 'order') requestAnimationFrame(() => { designer.resize(); positionInspector(); });
    window.scrollTo({ top: 0 });
  }
  $$('#mainNav button[data-page], #bottomNav button[data-page]').forEach((b) => b.addEventListener('click', () => showPage(navTarget(b))));

  /* القائمة الجانبية في الجوال: رأس الشريط الجانبي شريط علوي، وأقسامه لوحة منزلقة.
     الشريط السفلي يبقي الأكثر استعمالاً، و«القائمة» تفتح بقية الأقسام. */
  let drawerReturn = null;
  let drawerAnim = 0;
  const drawerOpen = () => $('#sbDrawer').classList.contains('open');
  /** الحركة تُفعَّل لحظة الفتح أو الإغلاق فقط (انظر .sb-drawer.anim) */
  function animateDrawer() {
    const d = $('#sbDrawer');
    d.classList.add('anim');
    clearTimeout(drawerAnim);
    drawerAnim = setTimeout(() => d.classList.remove('anim'), 340);
  }
  function openDrawer() {
    if (!isMobile()) return;
    drawerReturn = document.activeElement;
    animateDrawer();
    $('#sbDrawer').classList.add('open');
    $('#sbScrim').hidden = false;
    ['#btnMenu', '#btnMore'].forEach((s) => $(s).setAttribute('aria-expanded', 'true'));
    requestAnimationFrame(() => { const b = $('#mainNav button.active') || $('#mainNav button'); if (b) b.focus({ preventScroll: true }); });
  }
  function closeDrawer() {
    if (!drawerOpen()) return;
    if (isMobile()) animateDrawer();
    $('#sbDrawer').classList.remove('open');
    $('#sbScrim').hidden = true;
    ['#btnMenu', '#btnMore'].forEach((s) => $(s).setAttribute('aria-expanded', 'false'));
    if (drawerReturn && drawerReturn.isConnected && !drawerReturn.closest('#sbDrawer')) drawerReturn.focus({ preventScroll: true });
  }
  $('#btnMenu').addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()));
  $('#btnMore').addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()));
  $('#sbClose').addEventListener('click', closeDrawer);
  $('#sbScrim').addEventListener('click', closeDrawer);
  $('#sbDrawer').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('resize', () => { if (!isMobile()) closeDrawer(); });

  /* طيّ الشريط الجانبي على الحاسوب: تفضيل عرض لهذا الجهاز فقط */
  const SIDEBAR_KEY = 'majlis_sidebar';
  function syncCollapseBtn() {
    const on = document.documentElement.classList.contains('sb-collapsed');
    const b = $('#sbCollapse');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'توسيع الشريط الجانبي' : 'طيّ الشريط الجانبي';
    b.setAttribute('aria-label', b.title);
    $('span', b).textContent = on ? 'توسيع الشريط' : 'طيّ الشريط';
  }
  $('#sbCollapse').addEventListener('click', () => {
    const on = document.documentElement.classList.toggle('sb-collapsed');
    try { localStorage.setItem(SIDEBAR_KEY, on ? 'collapsed' : 'open'); } catch (_) { /* ignore */ }
    syncCollapseBtn();
  });
  syncCollapseBtn();

  $$('#stepNav a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    showStage(a.dataset.stage, { focus: true });
  }));

  /* ---------------- المرفقات (صورتان تظهران في أمر الشراء) ----------------
     الصورة تُخزَّن داخل سجل الطلب نفسه (data URL) لأن النظام بلا مخزن ملفات،
     فتُصغَّر قبل التخزين وإلا ضخّمت السجل وأبطأت المزامنة.
     موضع التعريف هنا مقصود: newOrder() يُستدعى بعدها مباشرة عند الإقلاع. */
  const ATT_COUNT = 2;   // عدد الخانات

  const emptyAttachments = () => Array.from({ length: ATT_COUNT }, () => ({ name: '', src: '' }));

  /** ضمان مصفوفة بطول ATT_COUNT مهما كان شكل الطلب المحفوظ */
  function normalizeAttachments(list) {
    const out = emptyAttachments();
    (Array.isArray(list) ? list : []).slice(0, ATT_COUNT).forEach((a, i) => {
      if (!a) return;
      out[i] = {
        name: String(a.name || '').slice(0, 60),
        src: typeof a.src === 'string' && a.src.startsWith('data:image/') ? a.src : '',
      };
    });
    return out;
  }

  /** المرفقات التي تحمل صورة فعلاً — وهي وحدها ما يدخل أمر الشراء */
  const filledAttachments = (o) => normalizeAttachments(o && o.attachments).filter((a) => a.src);

  /* ---------------- حالة الطلب الحالي ---------------- */
  let cur = newOrder();
  let dirty = false;
  /* نسخ الطلب المفتوح (updatedAt) التي نعرف مصدرها: التي فتحناه عليها أو كتبناها نحن.
     المزامنة الدورية تحدّث نسخة الخادم كل 30 ثانية، فلو اعتمدنا عليها وحدها لصار
     أساس الحفظ نسخة زميل لم نرها، ولمُحي تعديله بصمت. أي نسخة خارج هذه المجموعة تعني تعارضاً. */
  let curVersions = new Set();
  const ownVersion = (v) => { if (v) curVersions.add(v); };
  let readOnly = false;   // الطلب مملوك لموظف آخر: عرض فقط

  /** تعديل الطلب: طلبك بـ orders.edit_own، وطلب غيرك أو بلا مالك بـ orders.edit_all (لا بالدور) */
function canEditOrder(o) {
  if (!o || !o.id) return can('orders.create');   // طلب جديد لم يُحفظ
  return canFor(o, 'orders.edit');
}

  /** قفل/فتح كل عناصر تحرير الطلب حسب الملكية */
  const LOCKABLE = [
    '#m-customer input', '#m-customer select', '#m-customer textarea',
    '#orderStatus', '#m-pay input', '#m-pay select', '#btnAddPay', '#btnRefund', '#payQuick button',
    '#m-price input', '#m-price select', '#m-price button',
    '#attList input', '#attList button',
    '.designer-panel input', '.designer-panel select', '.designer-panel button',
    '#tbAddSofa', '#tbAddDoor', '#tbAddWindow', '#tbAddMashab', '#tbAddTv', '#tbAddColumn', '#tbFillAll', '#btnAddManual', '#btnPickMap',
  ].join(', ');

  function applyOrderLock() {
    $('#orderLockBanner').hidden = !readOnly;
    $('#btnSaveOrder').hidden = readOnly;
    $$(LOCKABLE).forEach((el) => { el.disabled = readOnly; });
    designer.setInteractive(!readOnly);
    if (readOnly) closeInspector();
    syncEditBtn();
    updateUndoButtons();
  }

  function setOrderOwnerLabel(o) {
    const name = (o && (o.createdByName || (Store.getUser(o.createdBy) || {}).name)) || 'موظف آخر';
    $('#lockOwner').textContent = name;
  }

  function newOrder() {
    return {
      id: null, number: null, status: 'new',
      design: Designer.emptyState(5, 4, settings().cornerMode || 'deduct'),
      priceOverrides: {}, manualRows: [], costs: {}, extraCosts: [],
      customer: { name: '', phone: '', address: '', mapsUrl: '' },
      deliveryDate: '', paid: 0, payments: [], notes: '', attachments: emptyAttachments(), discount: 0,
      vat: vatDefaults(),
      createdBy: null, createdByName: '', createdAt: null, updatedAt: null,
      total: 0,
    };
  }

  let wfFrame = 0;   // إطار مؤجَّل لتحديث مؤشر المراحل والملخص (انظر renderWorkflow)
  function setDirty(v) {
    dirty = v;
    $('#orderDirty').hidden = !v;
    if (v) scheduleDraft(); else clearDraft();
    scheduleWorkflow();
  }

  /* ---------------- مسوّدة محلية تحمي العمل عند انقطاع الإنترنت ---------------- */
  const DRAFT_KEY = 'majlis_draft_v1';
  let draftTimer;

  function saveDraft() {
    if (!currentUser || readOnly) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Store.now(), userId: currentUser.id, order: cur })); }
    catch (_) { /* المساحة ممتلئة: تُتجاهل المسودة */ }
  }
  function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 700); }
  function clearDraft() { clearTimeout(draftTimer); try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* ignore */ } }
  function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return null; } }

  /** عند بدء الجلسة: عرض المسودة غير المحفوظة إن وُجدت */
  function offerDraftRestore(draft) {
    const d = draft || readDraft();
    if (!d || !d.order || d.userId !== currentUser.id) return;
    const o = d.order;
    const hasContent = (o.customer && o.customer.name) || ((o.design && o.design.pieces) || []).length || (o.manualRows || []).length;
    if (!hasContent) { clearDraft(); return; }
    // إن كانت النسخة المحفوظة على الخادم أحدث فلا داعي للمسودة
    const saved = o.id ? db().orders.find((x) => x.id === o.id) : null;
    if (saved && saved.updatedAt && String(d.at) <= String(saved.updatedAt)) { clearDraft(); return; }

    // تنبيه داخل الصفحة لا نافذة: القرار لا يستعجل، والعمل على الطلب الجديد يبقى ممكناً
    const who = (o.customer && o.customer.name) ? `للعميل <b>${esc(o.customer.name)}</b>` : 'بدون اسم عميل';
    $('#draftText').innerHTML = `${o.number ? `الطلب <b>#${esc(o.number)}</b>` : 'طلب جديد'} ${who} بتعديلات لم تصل إلى الخادم — آخر تعديل ${fmtDateTime(d.at)} • ${((o.design && o.design.pieces) || []).length} قطعة في التصميم. قد يكون السبب انقطاع الإنترنت أو إغلاق الصفحة قبل الحفظ.`;
    $('#draftBanner').hidden = false;
    $('#drDrop').onclick = () => { clearDraft(); $('#draftBanner').hidden = true; toast('تم تجاهل المسودة', 'info'); };
    $('#drKeep').onclick = async () => {
      if (dirty && !(await confirmDlg('استعادة المسودة', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي واستعادة المسودة مكانه. متابعة؟', 'استعادة'))) return;
      $('#draftBanner').hidden = true;
      loadOrder(o);
      if (!readOnly) { setDirty(true); toast('تمت استعادة المسودة. اضغط حفظ لإرسالها.'); }
    };
  }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------- المصمم ---------------- */
  const getItem = (id) => Store.getItem(id) || { id, name: 'صنف محذوف', price: 0, color: '#9e9e9e', category: 'sofa', unit: 'm', fabric: '' };
  const activeItems = (cat) => db().items.filter((i) => i.category === cat && i.active !== false);

  /* --- مواصفات الكنب الثلاث: نوع الكنب (الخشب)، نوع القماش، الإسفنج ---
     كل واحدة فئة أصناف مستقلة تُدار من صفحة الأصناف. تُضبط على الصنف كافتراضي،
     وتُغيَّر لكل قطعة على حدة من لوحة الخصائص. ولكل خيار سعر إضافي للمتر
     (افتراضياً صفر فلا يغيّر شيئاً) لأن الشمواه والإسفنج قد يختلف سعرهما. */
  const SPECS = [
    { key: 'wood', cat: 'wood', field: 'woodId', label: 'الخشب', ph: 'مثال: سويدي' },
    { key: 'fabric', cat: 'fabric', field: 'fabricId', label: 'القماش', ph: 'مثال: شمواه' },
    { key: 'foam', cat: 'foam', field: 'foamId', label: 'الإسفنج', ph: 'مثال: الراجحي' },
  ];
  const SPEC_BY_KEY = Object.fromEntries(SPECS.map((s) => [s.key, s]));
  const SPEC_CATS = SPECS.map((s) => s.cat);

  const itemFabric = (item) => ((item && item.fabric) || '').trim();

  /** سجل المواصفة الفعلي لقطعة: تجاوز القطعة، ثم افتراضي الصنف */
  function specRecord(p, key) {
    const s = SPEC_BY_KEY[key];
    if (!s) return null;
    const item = getItem(p && p.itemId);
    const id = (p && p[s.field]) || (item && item[s.field]) || '';
    if (!id) return null;
    const rec = Store.getItem(id);
    return rec && rec.category === s.cat ? rec : null;
  }
  /** اسم المواصفة، مع التوافق مع القماش النصّي القديم */
  function specName(p, key) {
    const rec = specRecord(p, key);
    if (rec) return rec.name;
    if (key !== 'fabric') return '';
    return (p && p.fabric ? String(p.fabric).trim() : itemFabric(getItem(p && p.itemId)));
  }
  /** مجموع الزيادات على سعر المتر من المواصفات المختارة */
  function specSurcharge(p) {
    return SPECS.reduce((s, sp) => { const r = specRecord(p, sp.key); return s + (r ? money(r.price) : 0); }, 0);
  }
  /** وصف المواصفات لسطر أمر الشراء */
  function specSummary(p) {
    // سعر المتر مجموع الثلاثة، فغياب أحدها يعني نقصاً في السعر لا تفصيلاً ناقصاً:
    // يُكتب صراحةً حتى لا يمرّ سطر بصفر دون تفسير.
    const legacy = legacySofaItem(p);
    return SPECS.map((sp) => {
      const n = specName(p, sp.key);
      if (n) return `${sp.label} ${n}`;
      if (legacy) return '';
      return p && p[sp.field] ? `${sp.label} (صنف محذوف)` : `${sp.label} غير محدد`;
    }).filter(Boolean);
  }

  /** قائمة اختيار لمواصفة. الخيار الفارغ يعني "حسب الصنف" لا "بلا مواصفة". */
  function specSelect(id, spec, value, inheritedId) {
    const list = activeItems(spec.cat);
    const inherited = inheritedId ? Store.getItem(inheritedId) : null;
    const dflt = inherited ? `حسب الصنف (${inherited.name})` : 'غير محدد';
    let opts = `<option value="">${esc(dflt)}</option>`;
    opts += list.map((i) => `<option value="${i.id}" ${i.id === value ? 'selected' : ''}>${esc(i.name)}${num(i.price) ? ` — ${fmt(i.price)}/م` : ''}</option>`).join('');
    if (value && !list.some((i) => i.id === value)) {
      const miss = Store.getItem(value);
      opts += `<option value="${esc(value)}" selected>${esc(miss ? miss.name : 'خيار محذوف')}</option>`;
    }
    return `<select id="${id}">${opts}</select>`;
  }

  const insp = $('#inspector');
  let inspKey = null;
  let inspOpen = false;   // اللوحة مفتوحة؟ في الجوال لا تُفتح إلا بطلب صريح من المستخدم
  let inspAuto = false;   // فُتحت تلقائياً بالتحديد (الحاسوب): لا يُنقل التركيز إلى حقولها
  let lastSelKey = null;  // آخر عنصر محدد: الفتح التلقائي يكون عند تحديد عنصر جديد فقط

  /** طلب قديم: قطعة كنب مرتبطة بصنف من فئة "كنب" ملغاة */
  function legacySofaItem(p) {
    if (!p || p.kind !== 'sofa' || !p.itemId) return null;
    const it = Store.getItem(p.itemId);
    return it && it.category === 'sofa' ? it : null;
  }

  /** اسم القطعة ولونها وعمقها للمخطط — الكنبة تركيب لا صنف، والمساحة الحرة بلا صنف أصلاً */
  function pieceStyle(p) {
    if (p && p.kind === 'free') return { name: 'مساحة حرة', color: '#5A7486' };
    if (!p || p.kind !== 'sofa') return null;
    const legacy = legacySofaItem(p);
    if (legacy) return legacy;
    const wood = specRecord(p, 'wood'), fab = specRecord(p, 'fabric');
    return {
      name: fab ? `كنب ${fab.name}` : 'كنب',
      color: (fab && fab.color) || (wood && wood.color) || '#8b5a2b',
    };
  }

  /** ما يُكتب على القطعة في المخطط زيادةً على الاسم: الخشب والإسفنج */
  function pieceSpecLabel(p) {
    if (legacySofaItem(p)) return '';
    const wood = specRecord(p, 'wood'), foam = specRecord(p, 'foam');
    return [wood && wood.name, foam && foam.name].filter(Boolean).join(' • ');
  }

  const designer = new Designer($('#designCanvas'), {
    getItem,
    pieceSpecLabel,
    pieceStyle,
    /* قواعد التصميم — مطابقة حرفياً لبوابة العميل (portal.js):
       القواعد نفسها في صفحتي العميل والموظف بلا اختلاف. */
    smartSnap: true,
    boundAware: true,
    noDepthDrag: true,
    noOverlap: true,
    dimsOnTop: true,
    pieceLabelsOnTop: true,
    onBlocked(p, why) {
      toast(Designer.blockingMessage(why), true);
    },
    onChange() {
      cur.design = designer.getState();
      setDirty(true);
      renderPricing();
      renderWalls();
      syncCornerMode();
      updateOverlapWarn();
      markRoomHealth();
      updateUndoButtons();
      renderSelBar(designer.selectionInfo());
    },
    onSelect(info) {
      // على الحاسوب تعرض اللوحة الجانبية خصائص القطعة أو الفتحة فور تحديدها، فهي لا تحجب المخطط.
      // أما الجدار فتُعدَّل مقاساته مباشرة فوق تسميته (خانة فوق المخطط) في الحاسوب والجوال معاً.
      // تُفتح اللوحة عند تحديد عنصر جديد فقط: من أغلقها بزر «تم» لا تعود إليه أثناء سحب العنصر نفسه.
      const k = selKey(info);
      if (k && k !== lastSelKey && !isMobile() && !readOnly && (!info || info.type !== 'wall')) { inspOpen = true; inspAuto = true; }
      lastSelKey = k;
      renderInspector(info);
      renderSelBar(info);
      syncWallSel();
    },
    onRender() { positionInspector(); },
    onWallDblClick(i) { addSofaOnWall(i); },
    onRevert(why) {
      toast(why === 'column' ? 'لا يمكن وضع العنصر فوق العامود — أُعيد إلى مكانه' : 'يبقى العنصر داخل حدود الغرفة', true);
    },
  });

  function updateOverlapWarn() { $('#overlapWarn').hidden = designer.overlaps().size === 0; }

  /** سبب منع الحفظ (فارغ = تصميم صالح). نفس الدالة المستعملة في بوابة العميل.
      تُرجع {err, warn}: err للتعارض الجوهري (يمنع)، وwarn للملامسة على الحد
      (تحذير واضح مع السماح بالحفظ). يُعاد الحساب من الحالة الحالية دائماً. */
  function designBlockReason() {
    const v = designer.validateDesign();
    const msgs = [];
    const seen = {};
    v.issues.forEach((i) => {
      if (i.type === 'opening') {
        const nm = i.openingType === 'mashab' ? 'المشب' : i.openingType === 'window' ? 'الشباك' : i.openingType === 'tv' ? 'التلفاز' : 'الباب';
        if (!seen['o' + nm]) { msgs.push(`كنبة تسدّ ${nm} — انقلها بعيداً عنه`); seen['o' + nm] = 1; }
      } else if (i.type === 'overlap') {
        if (!seen.ov) { msgs.push('تداخل بين قطعتين — أعد توزيعهما'); seen.ov = 1; }
      }
    });
    const warns = [];
    designer.designWarnings().forEach((w) => {
      const nm = w.openingType === 'mashab' ? 'المشب' : w.openingType === 'window' ? 'الشباك' : w.openingType === 'tv' ? 'التلفاز' : 'الباب';
      if (!seen['w' + nm]) { warns.push(`كنبة ملاصقة لمنطقة ${nm} — الموضع مقبول لكن الأفضل إبعادها قليلاً`); seen['w' + nm] = 1; }
    });
    return { err: msgs.join(' · '), warn: warns.join(' · ') };
  }

  /** تنبيه هندسي بعد تغيير أطوال الجدران: فجوة، فتحة خرجت، أو تعارض أثاث.
      يمنع الحفظ ويشرح ما حدث — لا ينقل عنصراً ولا يحذفه بصمت. */
  function markRoomHealth() {
    const el = $('#roomWarn');
    if (!el) return;
    const h = designer.checkRoomHealth();
    if (!h.messages.length) { el.innerHTML = ''; return; }
    const gap = !h.gap.closed;
    el.innerHTML = `<div class="warnbox${gap ? ' warn-gap' : ''}"><p>${
      h.messages.slice(0, 4).map((m) => '• ' + esc(m)).join('<br>')}</p>${
      gap ? '<button type="button" class="btn small" data-close-room>إغلاق الغرفة (ضبط زاوية الجدار الأخير فقط)</button>' : ''}</div>`;
    const cb = $('[data-close-room]', el);
    if (cb) cb.addEventListener('click', () => {
      designer.closeRoom();
      toast('ضُبطت زاوية الجدار الأخير فقط ليغلق الشكل — لم يتغير أي طول.');
      renderWalls();
      markRoomHealth();
      setDirty(true);
    });
  }

  /* --- تبويبات اللوحة الجانبية --- */
  function selectPanelTab(b) {
    $$('#panelTabs button').forEach((x) => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
    });
    $$('.designer-panel .ptab').forEach((p) => p.classList.toggle('active', p.dataset.tab === b.dataset.tab));
  }
  $$('#panelTabs button').forEach((b) => b.addEventListener('click', () => selectPanelTab(b)));
  // تبويبات حقيقية: الأسهم تنقل بينها (RTL: السهم الأيسر للتالي)
  $('#panelTabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = $$('#panelTabs button');
    let i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = tabs.length - 1;
    else i = (i + (e.key === 'ArrowLeft' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[i].focus(); selectPanelTab(tabs[i]);
  });

  /* --- الغرفة والجدران --- */
  function renderWalls() {
    const walls = designer.state.walls;
    const selWall = designer.selectedWallIndex();
    const tb = $('#wallsBody');
    tb.innerHTML = walls.map((w, i) => `
      <tr class="${i === selWall ? 'sel' : ''}">
        <td>${i + 1} <small class="num">${Designer.util.round(w.len, 2)} م</small></td>
        <td><input type="number" step="5" data-i="${i}" data-k="angle" value="${w.angle}"></td>
        <td class="walls-actions">
          <button class="icon-btn" data-del="${i}" title="حذف الجدار" ${walls.length <= 3 ? 'disabled' : ''}>${icon('x')}</button>
        </td>
      </tr>`).join('');
    $$('input', tb).forEach((inp) => inp.addEventListener('change', () => {
      const i = +inp.dataset.i;
      designer.setWallAngle(i, num(inp.value));
    }));
    $$('button[data-del]', tb).forEach((b) => b.addEventListener('click', () => designer.removeWall(+b.dataset.del)));
    const g = designer.geometry();
    $('#wallsWarn').textContent = g.closed ? '' : `الجدران لا تُغلق الغرفة (فجوة ${Designer.util.round(g.gap, 2)} م). عدّل الاتجاهات أو مقاس الغرفة أعلاه.`;

    const sel = $('#wallSel');
    const prev = sel.value;
    sel.innerHTML = walls.map((w, i) => `<option value="${i}">جدار ${i + 1} (${Designer.util.round(w.len, 2)} م)</option>`).join('');
    sel.value = selWall >= 0 ? String(selWall) : (prev !== '' && +prev < walls.length ? prev : '0');
    // شريط الأدوات: نفس القائمة باختصار (بلا أطوال) — يحدّد موضع الباب/المشب/الكنبة
    const selTb = $('#wallSelTb');
    if (selTb) {
      selTb.innerHTML = walls.map((w, i) => `<option value="${i}">جدار ${i + 1}</option>`).join('');
      selTb.value = sel.value;
    }

    // لا نكتب فوق الحقل الذي يكتب فيه المستخدم الآن (تفقد التركيز/الرقم ينتقل لحقله)
    const af = document.activeElement;
    if (walls.length === 4 && walls[0].angle === 0 && walls[1].angle === 90 && walls[2].angle === 180 && walls[3].angle === 270) {
      if (af !== $('#roomW')) $('#roomW').value = Designer.util.round(walls[0].len, 3);
      if (af !== $('#roomH')) $('#roomH').value = Designer.util.round(walls[1].len, 3);
    }
  }

  function syncWallSel() {
    const i = designer.selectedWallIndex();
    if (i >= 0) { $('#wallSel').value = String(i); const tb = $('#wallSelTb'); if (tb) tb.value = String(i); }
    $$('#wallsBody tr').forEach((tr, k) => tr.classList.toggle('sel', k === i));
    $('#canvasHint').textContent = designer.sel ? 'اسحب للتحريك، والمقابض لتغيير المقاس والتدوير' : 'اضغط على جدار أو قطعة لتحديده';
    $('#canvasHint').hidden = false;
    syncEditBtn();
  }

  /** تطبيق مباشر: تغيير العرض/الطول يعيد رسم الغرفة فور الكتابة (بلا زر).
      لا تبديل تلقائي بين الحقلين: العرض يبقى أفقيًا والطول رأسيًا كما كتبه المستخدم،
      لأن التبديل كان ينقل الرقم المُدخل إلى الحقل المجاور في يبدو عشوائيًا. */
  function applyRoomDims(live) {
    const w = Math.max(0.5, num($('#roomW').value));
    const h = Math.max(0.5, num($('#roomH').value));
    const cur = designer.state.walls;
    const rect = cur.length === 4 && cur[0].angle === 0 && cur[1].angle === 90 && cur[2].angle === 180 && cur[3].angle === 270;
    if (rect) {
      /* المقاس الأساسي يحدّث الجدران الأربعة معاً (setRoomDims للغرفة المستطيلة). */
      designer.setRoomDims(w, h);
    } else {
      /* غرفة مخصّصة (بزوايا): نحافظ على شكلها ونحدّث المقاس الأساسي فقط،
         ولا نُصفّرها إلى مستطيل صامتاً. */
      designer.setRoomDims(w, h);
      if (designer.geometry().closed && !designer.state.walls[designer.state.walls.length - 1].fixed) {
        designer.closeRoom();   // ضبط زاوية الجدار الأخير ليغلق الشكل — بلا تغيير أي طول
      }
    }
    designer.autoFit = true;
    designer.fitView();
    renderWalls();
    markRoomHealth();
    if (!live) { syncCornerMode(); updateOverlapWarn(); }
  }
  ['#roomW', '#roomH'].forEach((sel) => {
    const el = $(sel);
    el.addEventListener('input', () => applyRoomDims(true));
    el.addEventListener('change', () => applyRoomDims(false));
  });

  /** إضافة زاوية (جدار) للغرفة غير المستطيلة مع كتابة الطول والاتجاه مباشرة */
  function addWallWithSize() {
    const last = designer.state.walls[designer.state.walls.length - 1];
    const defAngle = Designer.util.norm360((last ? last.angle : 0) + 90);
    openModal('إضافة زاوية', `
      <div class="row2">
        <label>الطول (م) <input id="nwLen" type="number" step="0.05" min="0.3" value="2" inputmode="decimal"></label>
        <label>الاتجاه° <input id="nwAng" type="number" step="5" value="${defAngle}" inputmode="decimal"></label>
      </div>
      <p class="hint">الاتجاه: 0 يمين، 90 أسفل، 180 يسار، 270 أعلى. يمكن تعديله لاحقاً من «الجدران بالتفصيل».</p>
      <div class="btn-row"><button class="btn" id="nwCancel">إلغاء</button><button class="btn primary" id="nwOk">${icon('plus')} إضافة الزاوية</button></div>`, (b) => {
        const lenEl = $('#nwLen', b);
        $('#nwCancel', b).onclick = closeModal;
        const apply = () => {
          const i = designer.addWall(lenEl.value, $('#nwAng', b).value);
          closeModal();
          designer.select({ type: 'wall', index: i });
          toast(`أُضيف جدار ${i + 1} بطول ${Designer.util.round(designer.state.walls[i].len, 2)} م`);
        };
        $('#nwOk', b).onclick = apply;
        lenEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        setTimeout(() => { lenEl.focus(); lenEl.select(); }, 80);
      });
  }

  // زرّا إضافة الجدار أُزيلا من الواجهة — تبقى addWallWithSize والدالة الهندسية
  // designer.addWall للتوافق الداخلي (حذف الجدار delwall ما زال يعمل).
  $('#wallSel').addEventListener('change', () => { designer.select({ type: 'wall', index: +$('#wallSel').value }); });
  // شريط الأدوات: تغيير الجدار هنا يحدّد موضع كل عنصر يُضاف بعده (بلا لمس المخطط)
  { const tbSel = $('#wallSelTb');
    if (tbSel) tbSel.addEventListener('change', () => {
      const i = +tbSel.value;
      $('#wallSel').value = String(i);
      designer.select({ type: 'wall', index: i });
    }); }

  /* --- طريقة القياس --- */
  const CORNER_HINT = {
    deduct: 'لا تداخل: الزاوية تُحسب مرة واحدة للجدار الأطول، وتُخصم من الجدار المجاور (جدار 4 م بجانب كنبة عمقها 0.8 = 3.2 م).',
    full: 'كل جدار يُحسب بطوله كاملاً حتى في الزوايا (الزاوية تُحسب مرتين وتظهر القطع متشاركة فيها).',
  };
  function syncCornerMode() {
    const m = designer.state.cornerMode;
    $$('#cornerMode button').forEach((b) => { b.classList.toggle('active', b.dataset.v === m); b.setAttribute('aria-pressed', String(b.dataset.v === m)); });
    $('#cornerHint').textContent = CORNER_HINT[m];
  }
  $$('#cornerMode button').forEach((b) => b.addEventListener('click', () => designer.setCornerMode(b.dataset.v)));

  /* --- الكنب --- */
  /** إضافة إكسسوار مع اختيار الكمية مباشرة: نافذة صغيرة تحدد العدد الكلي للصنف */
  function addAccessoryWithQty(item) {
    const have = designer.state.pieces.filter((p) => p.kind === 'acc' && p.itemId === item.id).length;
    openModal(`إضافة ${item.name}`, `
      <div class="qty-prompt">
        <label>الكمية (العدد الكلي في التصميم) <input id="accQty" type="number" min="1" max="${ACC_MAX}" step="1" inputmode="numeric" enterkeyhint="done" value="${have ? have + 1 : 1}"></label>
        <div class="btn-row">
          <button class="btn" id="accCancel">إلغاء</button>
          <button class="btn primary" id="accOk">إضافة</button>
        </div>
      </div>`, (b) => {
        const inp = $('#accQty', b);
        $('#accCancel', b).onclick = closeModal;
        const apply = () => {
          const n = Math.max(1, Math.min(ACC_MAX, Math.round(num(inp.value)) || 1));
          closeModal();
          const placed = designer.setAccessoryCount(item, n);
          if (placed < n) toast(`المساحة المتاحة لا تكفي لـ ${n} ${item.name}، تم وضع ${placed}. يمكنك تعديل التوزيع يدويًا.`, true);
        };
        $('#accOk', b).onclick = apply;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        setTimeout(() => { inp.focus(); inp.select(); }, 80);
      });
  }

  /* آخر تركيبة صالحة للكنب (جهاز الموظف فقط، localStorage): تُقترح كافتراضي
     غير إجباري في المرة التالية لتقليل الضغطات. لا تُحفظ في قاعدة البيانات. */
  const SOFA_SPEC_KEY = 'majlis_sofa_spec';
  function loadSofaSpec() {
    try { const v = JSON.parse(localStorage.getItem(SOFA_SPEC_KEY) || 'null'); return v && typeof v === 'object' ? v : null; }
    catch (_) { return null; }
  }
  function persistSofaSpec() {
    try {
      const v = {};
      let any = false;
      for (const s of SPECS) {
        const el = $(SOFA_SEL[s.key]);
        const rec = el && Store.getItem(el.value);
        if (rec && rec.category === s.cat && rec.active !== false) { v[s.key] = rec.id; any = true; }
      }
      const dep = $('#sofaDepth');
      if (dep && num(dep.value) >= 0.3) v.depth = num(dep.value);
      if (any) localStorage.setItem(SOFA_SPEC_KEY, JSON.stringify(v));
    } catch (_) { /* noop */ }
  }

  function renderItemSelects() {

    // الكنبة تُركَّب من خشب وقماش وإسفنج — لا صنف واحد اسمه "كنب".
    // الافتراضي: الاختيار الحالي، ثم آخر تركيبة صالحة على هذا الجهاز، ثم «غير محدد»
    const remembered = loadSofaSpec();
    SPECS.forEach((s) => {
      const sel = $('#sofa' + s.key.charAt(0).toUpperCase() + s.key.slice(1) + 'Sel');
      if (!sel) return;
      const list = activeItems(s.cat);
      const prev = sel.value;
      sel.innerHTML = `<option value="">غير محدد</option>` + (list.length
        ? list.map((i) => `<option value="${i.id}">${esc(i.name)} — ${fmt(i.price)} ${currency()}/م</option>`).join('')
        : '');
      if (prev && list.some((i) => i.id === prev)) sel.value = prev;
      else if (remembered && remembered[s.key] && list.some((i) => i.id === remembered[s.key])) sel.value = remembered[s.key];
      else sel.value = '';
    });
    if (remembered && remembered.depth && $('#sofaDepth') && !num($('#sofaDepth').value)) $('#sofaDepth').value = remembered.depth;
    updateSofaPriceHint();

    const accs = activeItems('acc');
    // «مساحة أرضية» مدمجة لا صنف لها في صفحة الأصناف: تُعلّم فراغاً في المجلس بلا سعر
    renderAccPicker(accs);
    renderAccAdded();
  }

  /* ============ اختيار الإكسسوارات: أيقونة + اسم فقط، والكمية بلوحة إجراءات ============
     (1) قائمة اختيار بسيطة بلا خانة كمية ولا زر إضافة دائم،
     (2) لوحة إجراءات واحدة تُفتح عند الضغط على أي عنصر (كمية/±/تأكيد/حذف/إغلاق)،
     (3) قسم «الإكسسوارات المضافة» يعرض الكميات ويتيح التعديل والحذف الجماعي. */

  // أيقونة إكسسوار موحّدة الأسلوب: شكل هندسي مشتق من لون الصنف (بلا صور خارجية)
  function accIconSvg(color) {
    return `<svg class="acc-ico" viewBox="0 0 40 40" aria-hidden="true">`
      + `<circle cx="20" cy="20" r="15" fill="${color}22"/>`
      + `<circle cx="20" cy="20" r="9.5" fill="${color}"/>`
      + `<circle cx="17" cy="17" r="3" fill="#fff" opacity=".45"/>`
      + `</svg>`;
  }

  function accCountOf(itemId) {
    return designer.state.pieces.filter((p) => p.kind === 'acc' && p.itemId === itemId).length;
  }

  /** قائمة الاختيار: أيقونة + اسم فقط — لا خانة كمية ولا زر إضافة دائم */
  function renderAccPicker(accs) {
    const box = $('#accButtons');
    if (!box) return;
    box.innerHTML = '<button class="acc-tile" data-free="1">'
        + accIconSvg('#8B5E34') + '<span>مساحة أرضية</span></button>'
      + (accs.length
        ? accs.map((i) => {
            const n = accCountOf(i.id);
            return '<button class="acc-tile' + (n ? ' has' : '') + '" data-acc="' + esc(i.id) + '"'
              + ' aria-label="' + esc(i.name) + (n ? ' — ' + n + ' مضاف' : '') + '">'
              + accIconSvg(esc(i.color || '#888')) + '<span>' + esc(i.name) + '</span>'
              + (n ? '<b class="acc-badge num">' + n + '</b>' : '') + '</button>';
          }).join('')
        : '<span class="hint">لا توجد إكسسوارات مسعّرة. أضفها من صفحة الأصناف.</span>');
    $$('#accButtons button[data-acc]').forEach((b) => b.addEventListener('click', () => {
      const it = Store.getItem(b.dataset.acc);
      if (it) openAccPanel(it);
    }));
    const fb = $('#accButtons button[data-free]');
    if (fb) fb.addEventListener('click', () => designer.addFreeSpace());
  }

  /** لوحة إجراءات العنصر: كتابة الكمية، أزرار ±، تأكيد، حذف، إغلاق */
  function openAccPanel(item) {
    const have = accCountOf(item.id);
    openModal(item.name, `
      <div class="acc-panel">
        <label>الكمية (العدد الكلي في التصميم) <input id="accQty" type="number" min="0" max="${ACC_MAX}" step="1" inputmode="numeric" enterkeyhint="done" value="${have}"></label>
        <div class="acc-stepper" role="group" aria-label="تعديل الكمية">
          <button type="button" class="btn" data-accstep="-1" aria-label="إنقاص">−</button>
          <button type="button" class="btn" data-accstep="1" aria-label="زيادة">+</button>
        </div>
        <p class="hint" id="accPanelHint">الكمية صفر تحذف العنصر من التصميم.</p>
        <div class="btn-row acc-actions">
          <button class="btn" id="accClose">إغلاق</button>
          ${have ? '<button class="btn danger" id="accDelete">حذف العنصر</button>' : ''}
          <button class="btn primary" id="accOk">${have ? 'تحديث الكمية' : 'إضافة'}</button>
        </div>
      </div>`, (b) => {
        const inp = $('#accQty', b);
        const clamp = (v) => Math.max(0, Math.min(ACC_MAX, Math.round(num(v)) || 0));
        $$('[data-accstep]', b).forEach((sb) => sb.addEventListener('click', () => {
          inp.value = clamp(num(inp.value) + (+sb.dataset.accstep));
        }));
        inp.addEventListener('change', () => { inp.value = clamp(inp.value); });
        $('#accClose', b).onclick = closeModal;
        const del = $('#accDelete', b);
        if (del) del.onclick = () => { closeModal(); applyAccCount(item, 0); };
        const apply = () => { closeModal(); applyAccCount(item, clamp(inp.value)); };
        $('#accOk', b).onclick = apply;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        setTimeout(() => { inp.focus(); inp.select(); }, 80);
      });
  }

  /** تطبيق الكمية: ٠ يحذف العنصر (القاعدة المعتمدة)، والسالب/الأكبر من الحد يُمنع */
  function applyAccCount(item, n) {
    const want = Math.max(0, Math.min(ACC_MAX, Math.round(num(n)) || 0));
    const placed = designer.setAccessoryCount(item, want);
    if (placed < want) toast(`المساحة المتاحة لا تكفي لـ ${want} ${item.name}، تم وضع ${placed}. يمكنك تعديل التوزيع يدويًا.`, true);
    renderAccPicker(activeItems('acc'));
    renderAccAdded();
  }

  /** قسم «الإكسسوارات المضافة»: الأسماء والكميات + زر التعديل لكل عنصر */
  function renderAccAdded() {
    const box = $('#accAdded');
    const list = $('#accAddedList');
    if (!box || !list) return;
    const added = designer.state.pieces.filter((p) => p.kind === 'acc');
    if (!added.length) { box.hidden = true; list.innerHTML = ''; return; }
    box.hidden = false;
    const byId = {};
    for (const p of added) {
      const k = p.itemId || 'free';
      if (!byId[k]) byId[k] = { item: p.itemId ? Store.getItem(p.itemId) : null, n: 0 };
      byId[k].n++;
    }
    list.innerHTML = Object.keys(byId).map((k) => {
      const r = byId[k];
      const name = r.item ? r.item.name : 'مساحة أرضية';
      const color = (r.item && r.item.color) || '#8B5E34';
      const editable = !!r.item;
      return '<div class="acc-added-row">'
        + accIconSvg(esc(color))
        + '<span class="acc-added-name">' + esc(name) + '</span>'
        + '<b class="acc-added-n num">' + r.n + '</b>'
        + (editable ? `<button type="button" class="icon-btn acc-edit" data-edit="${esc(r.item.id)}" aria-label="تعديل ${esc(name)}"><svg><use href="#i-pen"/></svg></button>` : '')
        + '</div>';
    }).join('');
    $$('#accAddedList button[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const it = Store.getItem(b.dataset.edit);
      if (it) openAccPanel(it);
    }));
  }

  /** تعديل جميع الإكسسوارات: لوحة واحدة بكميات كل عنصر دفعة واحدة */
  function openAccEditAll() {
    const added = designer.state.pieces.filter((p) => p.kind === 'acc');
    if (!added.length) return;
    const byId = {};
    for (const p of added) if (p.itemId) byId[p.itemId] = (byId[p.itemId] || 0) + 1;
    const rows = Object.keys(byId).map((id) => {
      const it = Store.getItem(id);
      if (!it) return '';
      return '<label class="acc-bulk-row">'
        + accIconSvg(esc(it.color || '#888'))
        + '<span>' + esc(it.name) + '</span>'
        + `<input type="number" min="0" max="${ACC_MAX}" step="1" inputmode="numeric" data-q="${esc(id)}" value="${byId[id]}">`
        + '</label>';
    }).join('');
    openModal('تعديل جميع الإكسسوارات', `
      <div class="acc-bulk-list">${rows}</div>
      <p class="hint">الكمية صفر تحذف العنصر. التغيير يُطبَّق دفعة واحدة.</p>
      <div class="btn-row">
        <button class="btn" id="accBulkCancel">إلغاء</button>
        <button class="btn primary" id="accBulkOk">تطبيق</button>
      </div>`, (b) => {
      $('#accBulkCancel', b).onclick = closeModal;
      $('#accBulkOk', b).onclick = () => {
        const jobs = $$('input[data-q]', b).map((inp) => ({
          item: Store.getItem(inp.dataset.q),
          n: Math.max(0, Math.min(ACC_MAX, Math.round(num(inp.value)) || 0)),
        })).filter((j) => j.item);
        closeModal();
        for (const j of jobs) {
          const placed = designer.setAccessoryCount(j.item, j.n);
          if (placed < j.n) toast(`المساحة لا تكفي لـ ${j.n} ${j.item.name}، تم وضع ${placed}.`, true);
        }
        renderAccPicker(activeItems('acc'));
        renderAccAdded();
      };
    });
  }

  /** حذف جميع الإكسسوارات فقط: تأكيد إجباري، ولا يمسّ الأثاث ولا الغرفة ولا الأبواب */
  function deleteAllAccs() {
    const added = designer.state.pieces.filter((p) => p.kind === 'acc');
    if (!added.length) return;
    openModal('حذف جميع الإكسسوارات', `
      <p>سيُحذف <b class="num">${added.length}</b> قطعة إكسسوار من التصميم.</p>
      <p class="hint">لن يتأثر الأثاث (الكنب) ولا أبعاد الغرفة ولا الأبواب والمشب. ويمكنك التراجع بزر «تراجع».</p>
      <div class="btn-row">
        <button class="btn" id="accDelCancel">إلغاء</button>
        <button class="btn danger" id="accDelOk">حذف الإكسسوارات</button>
      </div>`, (b) => {
      $('#accDelCancel', b).onclick = closeModal;
      $('#accDelOk', b).onclick = () => {
        closeModal();
        deleteAllAccessoryPieces();
        renderAccPicker(activeItems('acc'));
        renderAccAdded();
        toast('تم حذف جميع الإكسسوارات');
      };
    });
  }

  const SOFA_SEL = { wood: '#sofaWoodSel', fabric: '#sofaFabricSel', foam: '#sofaFoamSel' };

  /** تركيبة الكنب المختارة: يُسمح بتركيبة جزئية (خشب فقط مثلاً)، وسعر المتر مجموع ما اختير */
  function selectedSofaSpec(silent = false) {
    const spec = { depth: Math.max(0.3, num($('#sofaDepth').value) || 0.8) };
    const missing = [];
    for (const s of SPECS) {
      const rec = Store.getItem($(SOFA_SEL[s.key]).value);
      if (!rec || rec.category !== s.cat) { missing.push(s.label); continue; }
      spec[s.field] = rec.id;
    }
    // الرسالة فقط حين لا يُختار أي مكوّن؛ اختيار الخشب وحده يكفي للفرش
    if (missing.length === SPECS.length) {
      if (!silent) toast('اختر مكوّناً واحداً على الأقل (الخشب أو القماش أو الإسفنج) — أضفه من صفحة الأصناف', true);
      return null;
    }
    return spec;
  }

  /** سعر متر التركيبة المختارة، يُعرض تحت القوائم */
  function updateSofaPriceHint() {
    const el = $('#sofaPriceHint');
    if (!el) return;
    const parts = [];
    let total = 0, ok = true;
    for (const s of SPECS) {
      const rec = Store.getItem($(SOFA_SEL[s.key]).value);
      if (!rec || rec.category !== s.cat) { ok = false; continue; }
      total += money(rec.price);
      parts.push(`${rec.name} ${fmt(rec.price)}`);
    }
    el.textContent = ok ? `سعر المتر: ${parts.join(' + ')} = ${fmt(total)} ${currency()}` : 'اختر الثلاثة لحساب سعر المتر.';
  }
  function targetWall() {
    const i = designer.selectedWallIndex();
    if (i >= 0) return i;
    const o = designer.selectedOpening();
    if (o) return o.wall;
    const p = designer.selectedPiece();
    if (p && p.wall != null) return p.wall;
    return num($('#wallSel').value);
  }
  function addSofaOnWall(i) {
    const spec = selectedSofaSpec();
    if (!spec) return;
    const p = designer.addSofaOnWall(i, spec);
    if (!p) toast('لا توجد مساحة كافية على هذا الجدار', true);
  }
  function fillAll() {
    const spec = selectedSofaSpec();
    if (!spec) return;
    const n = designer.fillAllWalls(spec);
    toast(n ? `تمت إضافة ${n} قطعة` : 'لا توجد مساحات فارغة على الجدران', n ? false : 'info');
  }
  SPECS.forEach((s) => { const el = $(SOFA_SEL[s.key]); if (el) el.addEventListener('change', () => { persistSofaSpec(); updateSofaPriceHint(); }); });
  { const dep = $('#sofaDepth'); if (dep) dep.addEventListener('change', persistSofaSpec); }

  $('#btnAddSofaWall').addEventListener('click', () => addSofaOnWall(targetWall()));
  $('#btnFillAll').addEventListener('click', fillAll);
  $('#tbFillAll').addEventListener('click', fillAll);
  $('#btnAddSofaFree').addEventListener('click', () => { const s = selectedSofaSpec(); if (s) designer.addSofaFree(s); });
  $('#tbAddSofa').addEventListener('click', () => addSofaOnWall(targetWall()));
  $('#tbAddSofaFree').addEventListener('click', () => { const s = selectedSofaSpec(); if (s) designer.addSofaFree(s); });
  $('#tbAddDoor').addEventListener('click', () => designer.addOpening(targetWall(), 'door'));
  $('#tbAddWindow').addEventListener('click', () => designer.addOpening(targetWall(), 'window'));
  $('#tbAddMashab').addEventListener('click', () => designer.addOpening(targetWall(), 'mashab'));
  $('#tbAddTv').addEventListener('click', () => designer.addOpening(targetWall(), 'tv'));
  /* --- التراجع والإعادة --- */
  function updateUndoButtons() {
    $('#tbUndo').disabled = readOnly || !designer.canUndo();
    $('#tbRedo').disabled = readOnly || !designer.canRedo();
  }
  function doUndo() { if (readOnly) return; if (designer.undo()) toast('تم التراجع'); else toast('لا يوجد ما يُتراجع عنه', 'info'); }
  function doRedo() { if (readOnly) return; if (designer.redo()) toast('تمت الإعادة'); else toast('لا يوجد ما يُعاد', 'info'); }
  $('#tbUndo').addEventListener('click', doUndo);
  $('#tbRedo').addEventListener('click', doRedo);

  let zoomPct = 100;
  const syncZoomPct = () => { const el = $('#tbZoomPct'); if (el) el.textContent = zoomPct + '%'; };
  $('#tbZoomIn').addEventListener('click', () => { designer.zoomAt(1.25); zoomPct = Math.min(400, Math.round(zoomPct * 1.25)); syncZoomPct(); });
  $('#tbZoomOut').addEventListener('click', () => { designer.zoomAt(0.8); zoomPct = Math.max(25, Math.round(zoomPct / 1.25)); syncZoomPct(); });
  const zoomFit = () => { designer.fitView(); zoomPct = 100; syncZoomPct(); };
  $('#tbFit').addEventListener('click', zoomFit);
  $('#tbZoomPct').addEventListener('click', zoomFit);
  syncZoomPct();
  $('#tbAddColumn').addEventListener('click', () => {
    const c = designer.addColumn(0.6, 0.6);
    if (c) toast('أُضيف عامود — اسحبه لمكانه وعدّل مقاسه من الخصائص');
  });

  /* --- شريط إجراءات العنصر المحدد (أسفل المخطط): حذف/تدوير/نسخ مباشرة ---
     يظهر فور التحديد بلا فتح «الخصائص» (الخصائص تبقى للضبط المتقدم).
     يُخفى مع فتح الخصائص (فيها كل الإجراءات) وفي وضع القراءة فقط. */
  const selBar = $('#selBar');
  function selBarName(info) {
    if (!info) return '';
    if (info.type === 'wall') return 'جدار ' + (info.index + 1);
    if (info.type === 'opening') {
      const o = info.opening;
      return (o.type === 'door' ? 'باب' : o.type === 'mashab' ? 'مشب' : o.type === 'tv' ? 'تلفاز' : 'شباك') + ' — جدار ' + (o.wall + 1);
    }
    const p = info.piece;
    if (p.kind === 'column') return 'عامود';
    if (p.kind === 'sofa') return ((pieceStyle(p) || {}).name) || 'كنب';
    if (p.kind === 'free') return 'مساحة أرضية';
    return (getItem(p.itemId) || {}).name || 'إكسسوار';
  }
  function selBarQtySet(raw) {
    const p = designer.selectedPiece();
    if (!p) return;
    const it = getItem(p.itemId);
    if (!it) return;
    // الفارغ وغير الرقمي يُرفض ويُعاد العرض الحالي — لا يُفسَّر صفراً ولا واحداً
    const v = /^\d+$/.test(String(raw == null ? '' : raw).trim()) ? parseInt(String(raw).trim(), 10) : NaN;
    if (!Number.isFinite(v) || v < 1 || v > ACC_MAX) {
      if (String(raw == null ? '' : raw).trim() !== '') toast(`أدخل عددًا صحيحًا من 1 إلى ${ACC_MAX}.`, true);
      renderSelBar(designer.selectionInfo());
      return;
    }
    const placed = designer.setAccessoryCount(it, v);
    if (placed < v) toast(`المساحة المتاحة لا تكفي لـ ${v} ${it.name}، تم وضع ${placed}. يمكنك تعديل التوزيع يدويًا.`, true);
    // setAccessoryCount يلغي التحديد: نُبقي الشريط حياً بإعادة تحديد قطعة من الصنف.
    // إعادة التحديد تفتح الورقة تلقائياً على الحاسوب (سلوك مقصود) فيختفي الشريط —
    // نغلقها فوراً لأن المستخدم كان يتعامل مع الشريط أصلاً.
    const rest = designer.state.pieces.filter((x) => x.kind === 'acc' && x.itemId === it.id)[0];
    if (rest) designer.select({ type: 'piece', id: rest.id });
    if (!insp.hidden) closeInspector();
    renderSelBar(designer.selectionInfo());
  }
  function selBarWidth(delta) {
    const o = designer.selectedOpening();
    if (!o) return;
    designer.updateOpening(o.id, { w: Math.max(0.3, Math.round((o.w + delta) * 10) / 10) });
    renderSelBar(designer.selectionInfo());
  }
  function renderSelBar(info) {
    if (!selBar) return;
    if (!info || readOnly || !insp.hidden) { selBar.hidden = true; selBar.innerHTML = ''; return; }
    let mid = '';
    if (info.type === 'piece' && info.piece.kind === 'acc') {
      const it = getItem(info.piece.itemId);
      const n = it ? designer.state.pieces.filter((x) => x.kind === 'acc' && x.itemId === it.id).length : 0;
      mid = `<span class="p-qty"><input type="number" min="1" max="${ACC_MAX}" step="1" value="${n}" inputmode="numeric" aria-label="الكمية — اكتب العدد مباشرة" data-sbqty></span>`;
    } else if (info.type === 'opening') {
      mid = `<span class="p-qty"><button type="button" class="btn" data-sbwminus aria-label="تضييق">−</button><button type="button" class="btn" data-sbwplus aria-label="توسيع">+</button></span>`;
    }
    selBar.innerHTML = `<span class="selbar-name">${esc(selBarName(info))}</span>${mid}`
      + (info.type === 'piece' ? `<button type="button" class="btn small" data-sbrot title="تدوير 90°">${icon('rotate')} 90°</button><button type="button" class="btn small" data-sbdup>${icon('copy')} نسخ</button>` : '')
      + `<button type="button" class="btn small danger del-danger" data-sbdel>${icon('trash')} حذف</button>`
      + `<button type="button" class="btn small" data-sbprops>${icon('pen')} الخصائص</button>`;
    selBar.hidden = false;
    const q = (s) => selBar.querySelector(s);
    if (q('[data-sbdel]')) q('[data-sbdel]').onclick = () => { designer.removeSelected(); renderSelBar(designer.selectionInfo()); };
    if (q('[data-sbrot]')) q('[data-sbrot]').onclick = () => { designer.rotateSelected(90); renderSelBar(designer.selectionInfo()); };
    if (q('[data-sbdup]')) q('[data-sbdup]').onclick = () => { designer.duplicateSelected(); };
    if (q('[data-sbprops]')) q('[data-sbprops]').onclick = () => openInspector();
    const sbq = q('[data-sbqty]');
    if (sbq) sbq.addEventListener('change', () => selBarQtySet(sbq.value));
    if (q('[data-sbwminus]')) q('[data-sbwminus]').onclick = () => selBarWidth(-0.1);
    if (q('[data-sbwplus]')) q('[data-sbwplus]').onclick = () => selBarWidth(0.1);
  }

  /* --- لوحة الخصائص العائمة (Inspector) --- */
  /** لوحة الخصائص لا تُفتح بمجرّد التحديد، بل بزر «تحرير» أو بنقرة مزدوجة */
  function openInspector() {
    const info = designer.selectionInfo();
    if (!info) return;
    inspOpen = true;
    inspAuto = false;
    inspKey = null;   // فتح صريح: تُرسم اللوحة من جديد ويُنقل التركيز إلى أول حقل
    renderInspector(info);
    renderSelBar(designer.selectionInfo());
  }
  function closeInspector() {
    inspOpen = false;
    renderInspector(null);
    renderSelBar(designer.selectionInfo());
  }
  function syncEditBtn() {
    const btn = $('#tbEdit');
    if (btn) btn.disabled = readOnly || !designer.sel;
  }
  $('#tbEdit').addEventListener('click', () => { if (insp.hidden) openInspector(); else closeInspector(); });
  // نقرة مزدوجة على قطعة أو فتحة تفتح خصائصها (وعلى الجدار تضيف كنباً كما كان)
  designer.canvas.addEventListener('dblclick', () => {
    const info = designer.selectionInfo();
    if (info && info.type !== 'wall') openInspector();
  });
  // الجوال: تُقفل الورقة بمجرّد بدء سحب القطعة حتى لا تحجب المخطط (على الحاسوب هي بجانبه)
  designer.canvas.addEventListener('pointermove', () => {
    if (insp.hidden || !isMobile()) return;
    const d = designer.drag;
    if (d && d.moved === true && ['move', 'resizeW', 'resizeH', 'rotate', 'opening'].indexOf(d.mode) >= 0) closeInspector();
  });

  function selKey(info) {
    if (!info) return null;
    if (info.type === 'piece') return 'piece:' + info.piece.id;
    if (info.type === 'wall') return 'wall:' + info.index;
    if (info.type === 'opening') return 'opening:' + info.opening.id;
    return null;
  }

  /** على الجوال: تقليص الكانفس أثناء فتح الورقة ليبقى الرسم ظاهراً فوقها */
  function syncMobileSheet() {
    const wrap = $('.canvas-wrap');
    if (!wrap) return;
    const open = !insp.hidden && isMobile();
    const wasOpen = wrap.classList.contains('sheet-open');
    wrap.classList.toggle('sheet-open', open);
    document.body.classList.toggle('inspector-open', open);
    if (open && !wasOpen) requestAnimationFrame(() => wrap.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  }

  function renderInspector(info) {
    const key = inspOpen ? selKey(info) : null;
    if (!key) { inspOpen = false; insp.hidden = true; inspKey = null; syncMobileSheet(); return; }
    if (key === inspKey && !insp.hidden) { refreshInspectorValues(info); positionInspector(); return; }
    inspKey = key;
    let html = '<div class="sheet-grip"></div>';
    if (info.type === 'wall') {
      const nWalls = designer.state.walls.length;
      html += `
        <div class="insp-head"><b>${icon('ruler')} جدار ${info.index + 1} <small>يُطبّق عند مغادرة الحقل</small></b><button class="btn small" data-close aria-label="إنهاء تعديل القطعة">تم ${icon('check')}</button></div>
        <div class="row2">
          <label>الاتجاه° <input id="inspAng" type="number" step="5" value="${info.wall.angle}"></label>
        </div>
        <div class="insp-actions">
          <button class="btn small primary" data-act="sofa">${icon('sofa')} أثاث</button>
          <button class="btn small" data-act="door">${icon('door')} باب</button>
          <button class="btn small" data-act="window">${icon('window')} شباك</button>
          <button class="btn small" data-act="mashab">${icon('fire')} مشب</button>
          <button class="btn small" data-act="tv">${icon('tv')} تلفاز</button>
          <button class="btn small danger" data-act="delwall" ${nWalls <= 3 ? 'disabled' : ''} title="حذف الجدار">${icon('trash')}</button>
        </div>
        ${readOnly ? '' : `<button type="button" class="btn primary block insp-save" data-save>${icon('save')} حفظ الطلب</button>`}`;
    } else if (info.type === 'opening') {
      const o = info.opening;
      html += `
        <div class="insp-head"><b>${icon(o.type === 'door' ? 'door' : o.type === 'mashab' ? 'fire' : o.type === 'tv' ? 'tv' : 'window')} ${o.type === 'door' ? 'باب' : o.type === 'mashab' ? 'مشب' : o.type === 'tv' ? 'التلفاز' : 'شباك'} <small>على جدار ${o.wall + 1}</small></b><button class="btn small" data-close aria-label="إنهاء تعديل القطعة">تم ${icon('check')}</button></div>
        <div class="row2">
          <label>النوع <select id="inspType"><option value="door" ${o.type === 'door' ? 'selected' : ''}>باب</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>شباك</option><option value="mashab" ${o.type === 'mashab' ? 'selected' : ''}>مشب</option><option value="tv" ${o.type === 'tv' ? 'selected' : ''}>تلفاز</option></select></label>
          <label>العرض (م) <input id="inspOW" type="number" step="0.05" min="0.3" value="${Designer.util.round(o.w, 2)}"></label>
        </div>
        <label>البُعد من بداية الجدار (م) <input id="inspOT" type="number" step="0.05" min="0" value="${Designer.util.round(o.t - o.w / 2, 2)}"></label>
        <label ${o.type === 'mashab' ? '' : 'hidden'}>العمق داخل الغرفة (م) <input id="inspDepth" type="number" step="0.05" min="0.15" max="1" value="${Designer.util.round(o.depth || 0.5, 2)}"></label>
        ${o.type === 'door' ? `<div class="row2">
          <label>جهة المفصلات <select id="inspHinge"><option value="right" ${designer.openingHinge(o) === 'right' ? 'selected' : ''}>يمين</option><option value="left" ${designer.openingHinge(o) === 'left' ? 'selected' : ''}>يسار</option></select></label>
          <label>اتجاه فتح الباب <select id="inspSwing"><option value="in" ${designer.openingSwing(o) !== 'out' ? 'selected' : ''}>للداخل</option><option value="out" ${designer.openingSwing(o) === 'out' ? 'selected' : ''}>للخارج</option></select></label>
        </div>` : ''}
        <label class="check"><input id="inspBlocks" type="checkbox" ${o.blocks ? 'checked' : ''}> لا يوضع كنب أمامه</label>
        <div class="insp-actions"><button class="btn small danger del-danger" data-act="del" aria-label="حذف ${o.type === 'mashab' ? 'المشب' : o.type === 'window' ? 'الشباك' : o.type === 'tv' ? 'التلفاز' : 'الباب'}">${icon('trash')} حذف</button></div>
        ${readOnly ? '' : `<button type="button" class="btn primary block insp-save" data-save>${icon('save')} حفظ الطلب</button>`}`;
    } else {
      const p = info.piece;
      const isSofa = p.kind === 'sofa';
      const isFree = p.kind === 'free';
      const isColumn = p.kind === 'column';
      // المساحة الحرة والكنب والعامود تُقاس يدوياً؛ الإكسسوار وحده مقاسه مثبَّت من بطاقة صنفه
      const canSize = isSofa || isFree || isColumn;
      const legacy = legacySofaItem(p);
      // الكنبة تركيب من ثلاثة، فلا قائمة "صنف" لها. الإكسسوار صنف واحد كما كان.
      const items = canSize ? [] : activeItems('acc');
      const curItem = isColumn ? { name: 'عامود' } : canSize ? (pieceStyle(p) || { name: 'كنب' }) : getItem(p.itemId);
      const opts = items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`);
      if (!canSize && !items.some((i) => i.id === p.itemId)) opts.unshift(`<option value="${esc(p.itemId)}">${esc(curItem.name)}</option>`);
      // عدد قطع الإكسسوار نفسه في التصميم (لإضافة كمية يدوياً)
      const accCount = (!canSize && curItem) ? designer.state.pieces.filter((x) => x.kind === 'acc' && x.itemId === curItem.id).length : 0;
      html += `
        <div class="insp-head"><b>${icon(isSofa ? 'sofa' : isFree ? 'align' : 'pillow')} ${esc(curItem.name)} <small id="inspWallLbl">${p.wall != null ? 'على جدار ' + (p.wall + 1) : 'قطعة حرة'}</small></b><button class="btn small" data-close aria-label="إنهاء تعديل القطعة">تم ${icon('check')}</button></div>
        <div class="insp-main">
          ${canSize ? '' : `<div class="row2"><label>الصنف <select id="selItem">${opts.join('')}</select></label><label>الكمية <span class="p-qty"><input id="selQty" type="number" min="1" max="${ACC_MAX}" step="1" value="${accCount}" inputmode="numeric" aria-label="الكمية — اكتب العدد مباشرة"></span></label></div>`}
          ${isSofa && legacy ? `<p class="hint">هذه القطعة من طلب قديم مرتبط بصنف «${esc(legacy.name)}». اختر الخشب والقماش والإسفنج لتحويلها.</p>` : ''}
          ${isSofa ? SPECS.map((s) => `<label>${s.label} ${specSelect('sel_' + s.key, s, p[s.field] || '', '')}</label>`).join('') : ''}
        </div>
        <div class="row2">
          <label>الطول (م) <input id="selW" type="number" step="0.05" min="0.2" value="${Designer.util.round(p.w, 2)}" ${canSize ? '' : 'readonly tabindex="-1"'}></label>
          <label>${isSofa ? 'العمق' : 'العرض'} (م) <input id="selH" type="number" step="0.05" min="0.2" value="${Designer.util.round(p.h, 2)}" ${canSize ? '' : 'readonly tabindex="-1"'}></label>
        </div>
        ${isFree ? '<p class="hint">مساحة أرضية تُعلّم فراغاً في المجلس. بلا سعر: لا تدخل جدول التسعير ولا أمر الشراء، وتُكتب في أمر التصنيع بمقاسها.</p>' : ''}
        ${canSize ? '' : '<p class="hint">مقاس الإكسسوار ثابت من بطاقة الصنف في صفحة «الأصناف». لتغييره، عدّل الصنف هناك أو اختر صنفاً آخر من القائمة أعلاه.</p>'}
        <div class="row2">
          <label>الزاوية° <input id="selRot" type="number" step="5" value="${Math.round(p.rot)}"></label>
          <label>ملاحظة <input id="selNote" value="${esc(p.note || '')}" placeholder="اختياري"></label>
        </div>
        <div class="insp-actions">
          <button class="btn small" data-act="align" title="محاذاة لأقرب جدار">${icon('align')} محاذاة</button>
          <button class="btn small" data-act="rot" title="تدوير 90°">${icon('rotate')} 90°</button>
          ${p.kind === 'sofa' ? `<button class="btn small" data-act="split">${icon('scissors')} تقسيم</button>` : ''}
          <button class="btn small" data-act="dup">${icon('copy')} نسخ</button>
          <button class="btn small danger" data-act="del">${icon('trash')} حذف</button>
        </div>
        ${readOnly ? '' : `<button type="button" class="btn primary block insp-save" data-save>${icon('save')} حفظ الطلب</button>`}`;
    }
    insp.innerHTML = html;
    try { insp.dataset.kind = (info && info.type) || ''; } catch (_) { /* noop */ }
    prepareControls(insp);
    insp.hidden = false;
    document.body.classList.toggle('inspector-open', isMobile());
    if (info.type === 'piece' && $('#selItem', insp)) $('#selItem', insp).value = info.piece.itemId;
    bindInspector(info);
    syncMobileSheet();
    positionInspector();
    if (info.type === 'wall' && !isCoarse && !inspAuto) { const an = $('#inspAng', insp); if (an) { an.focus(); an.select(); } }
  }

  function refreshInspectorValues(info) {
    const active = document.activeElement;
    const setIf = (id, v) => { const el = $('#' + id, insp); if (el && el !== active) el.value = v; };
    if (info.type === 'wall') { setIf('inspAng', info.wall.angle); }
    else if (info.type === 'opening') { const o = info.opening; setIf('inspOW', Designer.util.round(o.w, 2)); setIf('inspOT', Designer.util.round(o.t - o.w / 2, 2)); setIf('inspDepth', o.depth != null ? Designer.util.round(o.depth, 2) : 0.5); }
    else {
      const p = info.piece;
      setIf('selW', Designer.util.round(p.w, 2)); setIf('selH', Designer.util.round(p.h, 2)); setIf('selRot', Math.round(p.rot));
      if (p.kind === 'acc') { const it = getItem(p.itemId); setIf('selQty', it ? designer.state.pieces.filter((x) => x.kind === 'acc' && x.itemId === it.id).length : 0); }
      const lbl = $('#inspWallLbl', insp); if (lbl) lbl.textContent = p.wall != null ? 'على جدار ' + (p.wall + 1) : 'قطعة حرة';
    }
  }

  function bindInspector(info) {
    const closeBtn = $('[data-close]', insp);
    if (closeBtn) closeBtn.onclick = () => closeInspector();
    // حفظ من داخل الورقة: نفس زر الحفظ الرئيسي (بحمايته من التكرار)، لا مسار حفظ ثانٍ
    const sheetSave = $('[data-save]', insp);
    if (sheetSave) sheetSave.onclick = () => { if (!readOnly) { const main = $('#btnSaveOrder'); if (main && !main.disabled) main.click(); } };
    const onEnter = (el, fn) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); el.blur(); } });

    if (info.type === 'wall') {
      const i = info.index;
      const ang = $('#inspAng', insp);
      const applyAng = () => designer.setWallAngle(i, num(ang.value));
      if (ang) { ang.addEventListener('change', applyAng); onEnter(ang, applyAng); }
      $$('[data-act]', insp).forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'sofa') addSofaOnWall(i);
        else if (a === 'door') designer.addOpening(i, 'door');
        else if (a === 'window') designer.addOpening(i, 'window');
        else if (a === 'mashab') designer.addOpening(i, 'mashab');
        else if (a === 'tv') designer.addOpening(i, 'tv');
        else if (a === 'delwall') { if (designer.removeWall(i)) { designer.select(null); toast('تم حذف الجدار'); } }
      }));
    } else if (info.type === 'opening') {
      const id = info.opening.id;
      const apply = () => {
        const o = designer.opening(id); if (!o) return;
        const w = Math.max(0.3, num($('#inspOW', insp).value));
        const start = Math.max(0, num($('#inspOT', insp).value));
        const props = { type: $('#inspType', insp).value, w, t: start + w / 2, blocks: $('#inspBlocks', insp).checked };
        const depthEl = $('#inspDepth', insp);
        if (depthEl && props.type === 'mashab') props.depth = Math.min(1, Math.max(0.15, num(depthEl.value) || 0.5));
        /* الخياران مستقلان تماماً: يمرَّران كما هما بلا تأثير أحدهما على الآخر */
        const hingeEl = $('#inspHinge', insp), swingEl = $('#inspSwing', insp);
        if (props.type === 'door' && hingeEl && swingEl) { props.hinge = hingeEl.value; props.swing = swingEl.value; }
        designer.updateOpening(id, props);
        renderInspector(designer.selectionInfo());
      };
      ['inspOW', 'inspOT', 'inspBlocks', 'inspDepth', 'inspHinge', 'inspSwing'].forEach((k) => { const el = $('#' + k, insp); if (!el) return; el.addEventListener('change', apply); if (el.tagName === 'INPUT' && el.type !== 'checkbox') onEnter(el, apply); });
      // تغيير النوع يعيد رسم اللوحة كاملة لإظهار/إخفاء حقل العمق
      $('#inspType', insp).addEventListener('change', () => { inspKey = null; apply(); });
      $('[data-act="del"]', insp).addEventListener('click', () => { designer.removeOpening(id); designer.select(null); });
    } else {
      const apply = () => {
        const p = designer.selectedPiece(); if (!p) return;
        const props = { rot: num($('#selRot', insp).value), note: $('#selNote', insp).value.trim() };
        // الكنب والمساحة الحرة يُقاسان يدوياً؛ الإكسسوار مقاسه من بطاقة الصنف فلا يُرسل من الحقول
        if (p.kind === 'sofa' || p.kind === 'free') { props.w = num($('#selW', insp).value); props.h = num($('#selH', insp).value); }
        SPECS.forEach((s) => { const el = $('#sel_' + s.key, insp); if (el) props[s.field] = el.value || ''; });
        const selIt = $('#selItem', insp);
        const it = selIt ? Store.getItem(selIt.value) : null;
        if (it) {
          props.itemId = it.id;
          // تبديل صنف الإكسسوار يجلب مقاس الصنف الجديد
          if (p.kind === 'acc') { props.shape = it.shape || 'rect'; props.w = num(it.w) || p.w; props.h = num(it.h) || p.h; }
        }
        designer.updateSelected(props);
        refreshInspectorValues(designer.selectionInfo());
        const lbl = $('.insp-head b', insp);
        if (lbl && it) lbl.childNodes[1].textContent = ' ' + it.name + ' ';
        renderPricing();
      };
      ['selItem', 'selW', 'selH', 'selRot', 'selNote'].concat(SPECS.map((s) => 'sel_' + s.key))
        .forEach((k) => { const el = $('#' + k, insp); if (!el) return; el.addEventListener('change', apply); if (el.tagName === 'INPUT') onEnter(el, apply); });
      // كمية الإكسسوار: إضافة/إزالة قطع من الصنف نفسه (العدد حقيقي في البيانات)
      const qtyEl = $('#selQty', insp);
      if (qtyEl) {
        const applyQty = (raw) => {
          const itemEl = $('#selItem', insp);
          const p = designer.selectedPiece();
          const code = (itemEl && itemEl.value) || (p && p.itemId);
          const it = code ? getItem(code) : null;
          if (!it) return;
          // الفارغ وغير الرقمي والسالب والصفر مرفوضة: يُعاد العدد الحالي ولا يتغيّر شيء
          const txt = String(raw !== undefined ? raw : qtyEl.value).trim();
          const cur = designer.state.pieces.filter((x) => x.kind === 'acc' && x.itemId === it.id).length;
          if (!/^\d+$/.test(txt)) {
            qtyEl.value = cur;
            if (txt !== '') toast(`أدخل عددًا صحيحًا من 1 إلى ${ACC_MAX}.`, true);
            return;
          }
          const want = Math.max(1, Math.min(ACC_MAX, parseInt(txt, 10)));
          const placed = designer.setAccessoryCount(it, want);
          qtyEl.value = placed;
          if (placed < want) toast(`المساحة المتاحة لا تكفي لـ ${want} ${it.name}، تم وضع ${placed}. يمكنك تعديل التوزيع يدويًا.`, true);
        };
        qtyEl.addEventListener('change', () => applyQty());
        onEnter(qtyEl, () => applyQty());
      }
      $$('[data-act]', insp).forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'align') designer.alignSelectedToWall();
        else if (a === 'rot') designer.rotateSelected(90);
        else if (a === 'dup') designer.duplicateSelected();
        else if (a === 'del') designer.removeSelected();
        else if (a === 'split') splitDialog();
      }));
    }
  }

  /* اللوحة لم تعد عائمة فوق المخطط: صارت في الشريط الجانبي (وورقة سفلية في الجوال)،
     فلا إحداثيات تُحسب. تبقى الدالة لأن الرسم يستدعيها، وتمسح أي موضع سطري قديم. */
  function positionInspector() {
    if (insp.style.left || insp.style.top) { insp.style.left = ''; insp.style.top = ''; }
  }

  /** تقسيم القطعة: حقل صغير داخل لوحة الخصائص بدل نافذة منبثقة لإجراء بسيط */
  function splitDialog() {
    const p = designer.selectedPiece();
    if (!p) return;
    const open = $('.insp-split', insp);
    if (open) { open.remove(); return; }
    const box = document.createElement('div');
    box.className = 'insp-split';
    box.innerHTML = `
      <label>قسّم ${Designer.util.round(p.w, 2)} م إلى <input id="splitN" type="number" min="2" max="10" value="2" inputmode="numeric"></label>
      <button type="button" class="btn small primary" id="spOk">${icon('scissors')} تقسيم</button>
      <button type="button" class="icon-btn" id="spCancel" aria-label="إلغاء التقسيم">${icon('x')}</button>`;
    $('.insp-actions', insp).after(box);
    const n = $('#splitN', box);
    const doSplit = () => { const k = Math.min(10, Math.round(num(n.value))); if (k < 2) { n.focus(); return; } designer.splitSelected(k); toast(`قُسّمت القطعة إلى ${k === 2 ? 'قطعتين متساويتين' : `${k} قطع متساوية`}`); };
    $('#spOk', box).onclick = doSplit;
    $('#spCancel', box).onclick = () => box.remove();
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSplit(); } if (e.key === 'Escape') box.remove(); });
    n.focus(); n.select();
  }

  document.addEventListener('keydown', (e) => {
    // اختصارات المخطط تعمل ومرحلة التصميم ظاهرة فقط: لا يُحذف عنصر لا يراه المستخدم
    if ($('#app').hidden || !$('#page-order').classList.contains('active') || curStage !== 'design') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || !$('#modal').hidden) return;
    // المخطط بلوحة المفاتيح: Tab ينقل التحديد بين القطع ما دام التركيز على المخطط،
    // وبعد آخر قطعة يخرج التركيز كالمعتاد (لا فخّ تركيز)
    if (e.key === 'Tab' && e.target === designer.canvas && designer.interactive) {
      const ps = designer.state.pieces;
      if (ps.length) {
        const i = ps.findIndex((p) => designer.sel && designer.sel.type === 'piece' && p.id === designer.sel.id);
        const j = e.shiftKey ? (i < 0 ? ps.length - 1 : i - 1) : i + 1;
        if (j >= 0 && j < ps.length) {
          e.preventDefault();
          designer.select({ type: 'piece', id: ps[j].id });
          const p = ps[j];
          $('#canvasLive').textContent = `${p.kind === 'sofa' ? 'كنب' : p.kind === 'free' ? 'مساحة حرة' : p.kind === 'column' ? 'عامود' : (getItem(p.itemId) || {}).name || 'إكسسوار'} ${Designer.util.round(p.w, 2)} × ${Designer.util.round(p.h, 2)} م${p.wall != null ? ' على جدار ' + (p.wall + 1) : ''}. الأسهم للتحريك، R للتدوير، Delete للحذف، Enter للخصائص.`;
          return;
        }
        designer.select(null);
      }
      return;
    }
    if (e.key === 'Enter' && e.target === designer.canvas && designer.sel) { e.preventDefault(); openInspector(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
    if (e.key === 'Escape') { designer.select(null); return; }
    if (!designer.sel) return;
    const step = e.shiftKey ? 0.25 : 0.05;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (designer.selectedPiece()) {
      if (map[e.key]) { e.preventDefault(); designer.moveSelected(...map[e.key]); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); designer.removeSelected(); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); designer.rotateSelected(90); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); designer.duplicateSelected(); }
    } else if (designer.selectedOpening() && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); designer.removeSelected(); }
  });

  /* ---------------- التسعير ---------------- */
  /**
   * توقيع نوع الكنبة: نفس الخشب والقماش والإسفنج ونفس العمق = نوع واحد.
   * الكنب من نوع واحد يُجمع في سطر تسعير واحد بسعر متر واحد يُعدَّل مرة واحدة.
   * العمق جزء من النوع لأنه يظهر للعميل وللورشة، فدمج عمقين مختلفين يُخفي الفرق.
   */
  function sofaTypeKey(p) {
    const depth = Designer.util.round(num(p.h), 2);
    const legacy = legacySofaItem(p);
    if (legacy) return `sofa:item:${legacy.id}@${depth}`;
    return `sofa:${SPECS.map((s) => { const r = specRecord(p, s.key); return r ? r.id : ''; }).join('+')}@${depth}`;
  }

  /** المفتاح القديم للقطعة: سطر لكل كنبة. تُقرأ منه أسعار وتكاليف الطلبات المحفوظة قبل الدمج */
  const legacySofaKey = (p) => (p.group ? 'group:' + p.group : 'piece:' + p.id);

  /** قيمة محفوظة لسطر: بمفتاحه الجديد، وإلا بأحد مفاتيحه القديمة */
  function storedFor(map, l) {
    if (!map) return undefined;
    if (map[l.key] !== undefined) return map[l.key];
    for (const k of (l.legacyKeys || [])) if (map[k] !== undefined) return map[k];
    return undefined;
  }

  /** صيغة عدد القطع بالعربية: قطعة، قطعتان، 3 قطع، 11 قطعة */
  const piecesLabel = (n) => (n === 1 ? 'قطعة' : n === 2 ? 'قطعتان' : n <= 10 ? `${n} قطع` : `${n} قطعة`);

  /** سقف عدد قطع الإكسسوار الواحد: رقم مكتوب بالخطأ (500) يملأ المخطط ويُبطئ الرسم */
  const ACC_MAX = 99;

  /** صنف الإكسسوار الذي يُعاد إليه التركيز بعد إعادة رسم جدول التسعير */
  let accQtyFocus = null;

  function computeLines(order) {
    const lines = [];
    const ov = order.priceOverrides || {};
    const sofas = (order.design.pieces || []).filter((p) => p.kind === 'sofa');
    // الكنب المتشابه يُجمع في سطر واحد. وكنب الزاوية قطعة واحدة عند العميل والورشة:
    // ذراعاه يدخلان في مجموع الأمتار ويُعدّان قطعة واحدة في العدّ.
    const sofaTypes = new Map();
    sofas.forEach((p) => {
      const key = sofaTypeKey(p);
      let g = sofaTypes.get(key);
      if (!g) { g = { key, first: p, pieces: [], legacyKeys: [] }; sofaTypes.set(key, g); }
      g.pieces.push(p);
      const lk = legacySofaKey(p);
      if (!g.legacyKeys.includes(lk)) g.legacyKeys.push(lk);
    });
    sofaTypes.forEach((g) => {
      const p = g.first;
      const legacy = legacySofaItem(p);
      // سعر المتر = مجموع أسعار الخشب والقماش والإسفنج.
      // الطلبات القديمة كانت تربط الكنبة بصنف واحد، فتحتفظ بسعره.
      const base = legacy ? money(legacy.price) : money(specSurcharge(p));
      const l = { key: g.key, kind: 'sofa', legacyKeys: g.legacyKeys };
      const saved = storedFor(ov, l);
      const price = saved !== undefined ? money(saved) : base;
      const qty = r2(g.pieces.reduce((s, a) => s + num(a.w), 0));
      const specs = specSummary(p);
      // العدّ بالقطع كما يراها العميل: ذراعا الزاوية قطعة واحدة
      const units = new Set(g.pieces.map((a) => a.group || a.id)).size;
      const corners = new Set(g.pieces.filter((a) => a.group).map((a) => a.group)).size;
      const walls = [...new Set(g.pieces.map((a) => a.wall).filter((w) => w != null))].sort((x, y) => x - y).map((w) => w + 1);
      const free = g.pieces.filter((a) => a.wall == null).length;
      const where = [
        walls.length ? `جدار ${walls.join('، ')}` : '',
        free ? (free === 1 ? 'قطعة حرة' : `${free} قطع حرة`) : '',
      ].filter(Boolean).join(' + ');
      const notes = [...new Set(g.pieces.map((a) => (a.note || '').trim()).filter(Boolean))];
      const sub = [
        units > 1 ? piecesLabel(units) : '',
        where,
        corners ? (corners === 1 ? 'منها كنب زاوية' : `منها ${corners} كنب زاوية`) : '',
        ...specs,
        `عمق ${Designer.util.round(p.h, 2)} م`,
        ...notes,
      ].filter(Boolean).join(' • ');
      const nm = legacy ? legacy.name : 'كنب';
      lines.push(Object.assign(l, { name: nm, sub, unit: 'متر', qty, price, basePrice: base, total: money(qty * price) }));
    });
    const groups = {};
    (order.design.pieces || []).filter((p) => p.kind === 'acc').forEach((p) => { groups[p.itemId] = (groups[p.itemId] || 0) + 1; });
    Object.entries(groups).forEach(([itemId, qty]) => {
      const it = getItem(itemId);
      const key = 'item:' + itemId;
      const price = ov[key] !== undefined ? money(ov[key]) : money(it.price);
      lines.push({ key, kind: 'acc', itemId, name: it.name, sub: '', unit: 'قطعة', qty, price, basePrice: money(it.price), total: money(qty * price) });
    });
    (order.manualRows || []).forEach((r, idx) => {
      lines.push({ key: 'manual:' + idx, kind: 'manual', idx, name: r.name, sub: '', unit: r.unit || 'قطعة', qty: num(r.qty), price: money(r.price), basePrice: money(r.price), total: money(num(r.qty) * money(r.price)) });
    });
    // الخصم BEFORE VAT (سياسة معتمدة): الخاضع = subtotal − discount، والضريبة عليه.
    // الصلاحية تُفرض عند الإدخال والحفظ (0<=discount<=subtotal)؛ هنا حماية عرض فقط.
    const subtotal = money(lines.reduce((s, l) => s + l.total, 0));
    const vat = order.vat || { enabled: false, rate: vatDefaults().rate };
    const vatRate = vat.enabled ? Math.min(100, Math.max(0, num(vat.rate))) : 0;
    const discount = money(order.discount || 0);
    const taxable = money(Math.max(0, subtotal - Math.max(0, discount)));
    const vatAmount = money(taxable * vatRate / 100);
    const total = money(taxable + vatAmount);
    return { lines, subtotal, vatEnabled: !!vat.enabled, vatRate, vatAmount, discount, taxable, total };
  }

  /* ---------------- التكاليف والربح (للمدير، وللمنشئ على طلباته) ---------------- */
  /** من يرى التكاليف وصافي الربح ويعدّلهما: المدير يرى الجميع، والموظف
      والمندوب طلباتهم الخاصة فقط — نفس حدّ الملكية الذي يفرضه الخادم
      من العمود created_by، فالواجهة تخفي هنا ما يرفضه الخادم هناك. */
  const canSeeCosts = (o) => canFor(o, 'costs.view');
  /** الربح يتطلب رؤية التكلفة وصلاحية الربح معاً؛ والعمولة صلاحية مستقلة */
  const canSeeProfit = (o) => canSeeCosts(o) && canFor(o, 'profit.view');
  const canSeeComm = (o) => canFor(o, 'commission.view');
  /** إضافة التكاليف أو تعديلها بحسب وجودها، وحذفها (تفريغها) صلاحية ثالثة */
  const canWriteCosts = (o, hasCosts) => canFor(o, hasCosts ? 'costs.edit' : 'costs.add');
  const canClearCosts = (o) => canFor(o, 'costs.delete');

  /** تكلفة الوحدة المحفوظة لسطر تسعير، أو null إن لم تُدخل بعد */
  function lineCost(order, l) {
    // الأصناف الإضافية تحفظ تكلفتها داخل السطر نفسه: مفتاح "manual:idx" يتزحزح عند الحذف
    const raw = l.kind === 'manual' ? ((order.manualRows || [])[l.idx] || {}).cost : storedFor(order.costs, l);
    if (raw === undefined || raw === null || raw === '') return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? money(n) : null;
  }

  /** هل يستعمل الطلب هذا الصنف؟ الكنبة تشير إلى الخشب والقماش والإسفنج،
      والإكسسوار إلى itemId، والطلبات القديمة إلى صنف كنب واحد. */
  function itemUsedIn(order, itemId) {
    return ((order && order.design && order.design.pieces) || []).some((p) => {
      if (p.itemId === itemId) return true;
      return SPECS.some((s) => p[s.field] === itemId);
    });
  }

  /** بنود التكلفة الإضافية التي يكتبها المستخدم (توصيل، تحميل وتنزيل…) */
  function extraCosts(order) {
    return (order.extraCosts || [])
      .filter((e) => e && (String(e.name || '').trim() || num(e.amount)))
      .map((e) => ({ name: String(e.name || '').trim(), amount: money(e.amount) }));
  }

  /** اقتراحات جاهزة تُسرّع كتابة البنود المتكررة */
  const EXTRA_PRESETS = ['التوصيل', 'تحميل وتنزيل', 'التركيب', 'أجور عمالة', 'نقل ومشاوير'];

  /**
   * تكاليف الطلب وربحه.
   * الربح = الإيراد (المبيعات قبل الضريبة صافية الخصم، calcRevenue) − التكاليف.
   * الضريبة تُحصَّل للدولة وليست إيراداً فلا تدخل الحساب.
   * أرباح الأسطر تبقى على إجمالي السطر (الخصم على مستوى الطلب لا يُوزَّع على الأسطر).
   */
  function computeCosts(order) {
    const { lines, subtotal, vatEnabled, total } = computeLines(order);
    const rows = lines.map((l) => {
      const unitCost = lineCost(order, l);
      return Object.assign({}, l, {
        unitCost,
        costTotal: unitCost === null ? null : money(l.qty * unitCost),
        profit: unitCost === null ? null : money(l.total - money(l.qty * unitCost)),
      });
    });
    const filled = rows.filter((r) => r.unitCost !== null);
    const linesCost = money(filled.reduce((s, r) => s + r.costTotal, 0));
    const extras = extraCosts(order);
    const extrasCost = money(extras.reduce((s, e) => s + e.amount, 0));
    const costTotal = money(linesCost + extrasCost);
    const revenue = calcRevenue(subtotal, order.discount);
    const profit = calcProfit(revenue, costTotal);
    return {
      rows, subtotal, revenue, vatEnabled, total, costTotal, profit,
      linesCost, extras, extrasCost,
      entered: filled.length + extras.length, missing: rows.length - filled.length,
      margin: revenue > 0 && profit !== null ? r2((profit / revenue) * 100) : 0,
    };
  }

  /** إجمالي تكلفة الطلب، أو null إن لم تُدخل تكاليف.
      يُحسب من تكاليف الوحدات لا من costTotal المخزّن: الموظف لا يرى التكاليف، فإذا عدّل
      كميات طلب له تكاليف بقي costTotal على الكميات القديمة. الحساب يُخزَّن مؤقتاً لكل نسخة. */
  const costCache = new Map();
  function orderCost(o) {
    if (!o) return null;
    const has = (o.costs && Object.keys(o.costs).length) || (o.extraCosts && o.extraCosts.length)
      || (o.manualRows || []).some((r) => r && r.cost !== undefined && r.cost !== null && r.cost !== '');
    if (!has) return (o.costTotal !== undefined && o.costTotal !== null) ? money(o.costTotal) : null;
    const key = `${o.id}|${o.updatedAt || ''}|${o.costUpdatedAt || ''}`;
    if (o.id && costCache.has(key)) return costCache.get(key);
    const info = computeCosts(o);
    const v = info.entered ? info.costTotal : null;
    if (o.id) { if (costCache.size > 1500) costCache.clear(); costCache.set(key, v); }
    return v;
  }

  /** السياسة المركزية للضريبة: المعدل الافتراضي للطلبات *الجديدة* من الإعدادات.
      الطلبات المحفوظة تحتفظ بمعدلها (snapshot في vat/vatRate) ولا تتأثر بتغيير
      الإعداد لاحقاً — لا يُعاد حساب طلب قديم تلقائياً. القيمة الاحتياطية للحالات
      الشاذة فقط (إعدادات مفقودة)، وليست مصدراً للحساب. */
  const VAT_POLICY = { fallbackRate: 15 };
  function vatDefaults() {
    return { enabled: settings().vatEnabled !== false, rate: num(settings().vatRate ?? VAT_POLICY.fallbackRate) };
  }
  /** مصدر واحد لنسبة الضريبة المحفوظة: الحقل الصريح أولاً ثم كائن الضريبة (طلبات قديمة).
      بلا migration — قراءة فقط بترتيب ثابت بدل المزج بين o.vatRate وo.vat.rate في كل موضع. */
  function vatRateOf(o) {
    if (o && o.vatRate !== undefined && o.vatRate !== null) return num(o.vatRate);
    return num(o && o.vat ? o.vat.rate : 0);
  }
  /** الإيراد = المبيعات قبل الضريبة صافية الخصم. التعريف الوحيد المعتمد (C9). */
  function calcRevenue(subtotal, discount) {
    return money(money(subtotal) - money(discount || 0));
  }
  /** الربح = الإيراد − التكلفة. التعريف الوحيد المعتمد (C9)؛ null تعني بلا تكاليف مدخلة. */
  function calcProfit(revenue, cost) {
    return cost === null || cost === undefined ? null : money(revenue - cost);
  }
  /** المبيعات قبل الضريبة: أساس حساب الربح.
      الطلبات القديمة بلا subtotal تُشتق من المجموع بعكس معادلة computeLines
      (total = taxable×(1+rate) حيث taxable = subtotal−discount)، أي الإيراد
      = total/(1+rate) مباشرة بلا طرح إضافي (C10). */
  function orderRevenue(o) {
    if (o.subtotal !== undefined && o.subtotal !== null) return calcRevenue(o.subtotal, o.discount);
    const rate = (o.vat && o.vat.enabled) ? vatRateOf(o) : 0;
    return money(num(o.total) / (1 + rate / 100));
  }

  /** صافي ربح الطلب، أو null إن لم تُدخل تكاليفه */
  function orderProfit(o) {
    return calcProfit(orderRevenue(o), orderCost(o));
  }

  /** نسبة عمولة البائع للطلب: قيمة الطلب إن حُدّدت، وإلا الإعداد الافتراضي */
  function sellerRateOf(o) {
    const v = o && o.sellerRate;
    if (v !== undefined && v !== null && v !== '') return num(v);
    return num(settings().sellerRate);
  }
  /** نسبة المشاركة (لباقي البائعين والإدارة): قيمة الطلب إن حُدّدت، وإلا الإعداد الافتراضي */
  function shareRateOf(o) {
    const v = o && (o.shareRate !== undefined ? o.shareRate : o.othersRate);
    if (v !== undefined && v !== null && v !== '') return num(v);
    return num(settings().shareRate);
  }
  /** مستوى المندوب في الهيكل: 1 = مباشر للمحل، وكل مستوى يتبع مندوباً في المستوى السابق */
  function mandoubLevelOf(userId, seen) {
    seen = seen || new Set();
    if (!userId || seen.has(userId)) return 0;
    seen.add(userId);
    const u = Store.getUser(userId);
    if (!u || u.role !== 'mandoub') return 0;
    if (!u.parentId) return 1;
    const pl = mandoubLevelOf(u.parentId, seen);
    return pl ? pl + 1 : 1;
  }
  /** نسبة المندوب (صاحب الطلب) من صافي ربح طلباته */
  function mandoubOwnerRateOf(u) {
    const v = u && u.rate;
    if (v !== undefined && v !== null && v !== '') return num(v);
    return num(settings().mandoubRate);
  }
  /** نسبة المندوب الأعلى المباشر من طلبات من يتبعه */
  function mandoubParentRateOf(u) {
    const v = u && u.parentRate;
    if (v !== undefined && v !== null && v !== '') return num(v);
    return num(settings().mandoubParentRate);
  }
  /** هل منشئ الطلب مندوباً؟ */
  function isMandoub(o) {
    const u = Store.getUser(o && o.createdBy);
    return !!(u && u.role === 'mandoub');
  }
  /** المندوب المباشر الأعلى لصاحب الطلب، أو null */
  function mandoubParentOf(o) {
    if (!isMandoub(o)) return null;
    const u = Store.getUser(o.createdBy);
    return (u && u.parentId) ? Store.getUser(u.parentId) : null;
  }
  const rateSet = (v) => v !== undefined && v !== null && v !== '';
  /** نسبة صاحب الطلب من مصادرها الحالية: نسبة مخصّصة للطلب ← نسبة المندوب الخاصة ← الافتراضي */
  function liveOwnerRate(o) {
    if (isMandoub(o)) return rateSet(o.mandoubRate) ? num(o.mandoubRate) : mandoubOwnerRateOf(Store.getUser(o.createdBy));
    return sellerRateOf(o);
  }
  /**
   * النسب الفعلية لعمولات الطلب — المصدر الوحيد لكل الشاشات والتقارير والملفات:
   * اللقطة المحفوظة على الطلب وقت اعتماده (commRates)، أو النسب الحالية لطلب بلا لقطة،
   * والنسبة المخصّصة لهذا الطلب من نافذة «نسبة البائع/المندوب» تغلب دائماً (قرار صريح من المدير).
   */
  function commRatesOf(o) {
    const owner = Store.getUser(o && o.createdBy);
    const isMan = !!(owner && owner.role === 'mandoub');
    const parent = (isMan && owner.parentId) ? Store.getUser(owner.parentId) : null;
    const base = (o && o.commRates) || {
      ownerRate: liveOwnerRate(o),
      parentId: parent ? parent.id : null,
      parentRate: parent ? mandoubParentRateOf(owner) : null,
      shareRate: shareRateOf(o),
    };
    const r = { ownerRate: num(base.ownerRate), parentId: base.parentId || null, parentRate: base.parentId ? num(base.parentRate) : null, shareRate: num(base.shareRate) };
    if (isMan && rateSet(o.mandoubRate)) r.ownerRate = num(o.mandoubRate);
    if (!isMan && rateSet(o.sellerRate)) r.ownerRate = num(o.sellerRate);
    if (rateSet(o.shareRate !== undefined ? o.shareRate : o.othersRate)) r.shareRate = shareRateOf(o);
    return r;
  }
  /** من أين جاءت كل نسبة؟ (لشرح الأرقام للإدارة في التقارير والملخص) */
  function commRateSources(o, r) {
    r = r || commRatesOf(o);
    const owner = Store.getUser(o && o.createdBy);
    const isMan = !!(owner && owner.role === 'mandoub');
    const s = settings();
    const eq = (a, b) => rateSet(b) && Math.abs(num(a) - num(b)) < 0.0001;
    const SAVED = 'محفوظة على الطلب وقت اعتماده';
    let own;
    if (isMan) own = eq(r.ownerRate, o.mandoubRate) ? 'مخصّصة لهذا الطلب' : eq(r.ownerRate, owner.rate) ? 'نسبة المندوب الخاصة' : eq(r.ownerRate, s.mandoubRate) ? 'افتراضية (إعدادات المناديب)' : SAVED;
    else own = eq(r.ownerRate, o.sellerRate) ? 'مخصّصة لهذا الطلب' : eq(r.ownerRate, s.sellerRate) ? 'افتراضية (الإعدادات)' : SAVED;
    const parent = !r.parentId ? '' : (eq(r.parentRate, owner && owner.parentRate) ? 'نسبة المندوب الخاصة' : eq(r.parentRate, s.mandoubParentRate) ? 'افتراضية (إعدادات المناديب)' : SAVED);
    const shareRaw = o && (o.shareRate !== undefined ? o.shareRate : o.othersRate);
    const share = eq(r.shareRate, shareRaw) ? 'مخصّصة لهذا الطلب' : eq(r.shareRate, s.shareRate) ? 'افتراضية (الإعدادات)' : SAVED;
    return { owner: own, parent, share };
  }
  /* أساس احتساب كل النسب (البائع، المندوب، المندوب الأعلى، حصة المشاركة) — إعداد عام من الإعدادات:
     'profit' = صافي الربح (البيع قبل الضريبة − التكاليف) ويحتاج إدخال التكاليف،
     'total'  = إجمالي الطلب شامل الضريبة بعد الخصم (لا يحتاج تكاليف).
     يُطبَّق على كل الطلبات القديمة والجديدة (قرار المالك: إعادة الحساب لا لقطة). */
  const COMM_BASES = { profit: 'صافي الربح', total: 'الإجمالي شامل الضريبة' };
  function commBaseMode() { return settings().commBase === 'total' ? 'total' : 'profit'; }
  const commBaseLabel = () => COMM_BASES[commBaseMode()];
  /** المبلغ الذي تُحسب منه النسب لهذا الطلب، أو null إن لم يتوفر (صافي ربح بلا تكاليف) */
  function commBaseAmount(o) {
    if (commBaseMode() === 'total') return money(num(o && o.total));
    return orderProfit(o);
  }
  /** النسبة الفعلية المطبّقة على صاحب الطلب */
  function orderOwnerRate(o) { return commRatesOf(o).ownerRate; }
  /** عمولة صاحب الطلب = نسبته × أساس العمولة، أو null إن لم يتوفر الأساس */
  function orderCommission(o) {
    const p = commBaseAmount(o);
    return p === null ? null : money(p * orderOwnerRate(o) / 100);
  }
  /** عمولة المندوب الأعلى المباشر من طلب تابعه، أو null */
  function orderParentCommission(o) {
    const r = commRatesOf(o);
    if (!r.parentId) return null;
    const p = commBaseAmount(o);
    return p === null ? null : money(p * r.parentRate / 100);
  }
  /** حصة موظفي المحل من الطلب (البائع والمندوب معاً) */
  function orderShareAmount(o) {
    const p = commBaseAmount(o);
    return p === null ? 0 : money(p * commRatesOf(o).shareRate / 100);
  }
  /** لقطة نسب العمولة على الطلب عند اعتماده، حتى لا يؤثر تعديل النسب لاحقاً في الطلبات السابقة */
  function snapshotOrderCommission(o) {
    const owner = Store.getUser(o && o.createdBy);
    const isMan = !!(owner && owner.role === 'mandoub');
    const parent = (isMan && owner.parentId) ? Store.getUser(owner.parentId) : null;
    o.commRates = {
      ownerRate: liveOwnerRate(o),
      parentId: parent ? parent.id : null,
      parentRate: (isMan && parent) ? mandoubParentRateOf(owner) : null,
      shareRate: shareRateOf(o),
    };
    return o.commRates;
  }

  /** تحديث إجمالي التكلفة المخزّن في الطلب (يُحذف الحقل إن لم تبقَ أي تكلفة) */
  function syncCostTotal(o) {
    const info = computeCosts(o);
    if (info.entered) o.costTotal = info.costTotal; else delete o.costTotal;
    return info;
  }

  function renderPricing() {
    const { lines, subtotal, vatEnabled, vatRate, vatAmount, discount, total } = computeLines(cur);
    const tb = $('#priceTable tbody');
    if (!lines.length) {
      // حالة فارغة تخصّ التسعير نفسه: عنوان صريح وإجراءان، بلا تعليمات مرحلة التصميم
      tb.innerHTML = `<tr><td colspan="8" class="empty">
        <span class="empty-ico">${icon('tag')}</span>
        <b>لا توجد أصناف للتسعير بعد</b>
        <p>الكنب والإكسسوار يصلان من المخطط مسعّرين، ويمكن كتابة صنف إضافي هنا.</p>
        <div class="empty-actions">
          <button type="button" class="btn" id="priceGoDesign">${icon('arrow-r')} العودة إلى التصميم</button>
          <button type="button" class="btn primary" id="priceAddItem">${icon('plus')} إضافة صنف</button>
        </div></td></tr>`;
      const goD = $('#priceGoDesign', tb), addI = $('#priceAddItem', tb);
      if (goD) goD.addEventListener('click', () => showStage('design', { focus: true }));
      if (addI) addI.addEventListener('click', () => $('#btnAddManual').click());
    } else {
      tb.innerHTML = lines.map((l, i) => {
        const overridden = l.kind !== 'manual' && Math.abs(l.price - l.basePrice) > 0.004;
        const nameCell = l.kind === 'manual'
          ? `<input class="inline wide" data-m="${l.idx}" data-k="name" value="${esc(l.name)}" placeholder="اسم الصنف">`
          : `${esc(l.name)}${l.sub ? `<span class="sub">${esc(l.sub)}</span>` : ''}${overridden ? '<span class="custom-tag">سعر مخصص</span>' : ''}`;
        // كمية الإكسسوار تُكتب هنا وتنعكس على التصميم: تُضاف القطع أو تُحذف
        const qtyCell = l.kind === 'manual'
          ? `<input class="inline num" type="number" step="0.01" min="0" data-m="${l.idx}" data-k="qty" value="${l.qty}">`
          : l.kind === 'acc'
            ? `<input aria-label="عدد ${esc(l.name || 'الإكسسوار')}" title="تعديل العدد يضيف القطع أو يحذفها من التصميم" class="inline num" type="number" step="1" min="0" max="${ACC_MAX}" inputmode="numeric" data-accqty="${esc(l.itemId)}" value="${l.qty}">`
            : `<span class="num">${fmtQty(l.qty)}</span>`;
        const unitCell = l.kind === 'manual'
          ? `<select class="inline" data-m="${l.idx}" data-k="unit" data-w="unit"><option ${l.unit === 'قطعة' ? 'selected' : ''}>قطعة</option><option ${l.unit === 'متر' ? 'selected' : ''}>متر</option><option ${l.unit === 'خدمة' ? 'selected' : ''}>خدمة</option></select>`
          : l.unit;
        // الفئة: الكنبة تركيب بالمتر، والإكسسوار صنف بالقطعة، والإضافي يكتبه الموظف
        const catCell = l.kind === 'sofa' ? 'كنب' : l.kind === 'acc' ? 'إكسسوار' : 'صنف إضافي';
        // التعديل والحذف: الكنب يُعدَّل من المخطط، والإكسسوار يُحذف من التصميم، والإضافي من هنا
        const acts = l.kind === 'sofa'
          ? `<button type="button" class="icon-btn" data-goedit="1" title="تعديل القطع في المخطط">${icon('pen')}</button>`
          : l.kind === 'acc'
            ? `<button type="button" class="icon-btn" data-accdel="${esc(l.itemId)}" title="حذف «${esc(l.name)}» من التصميم">${icon('trash')}</button>`
            : `<button type="button" class="icon-btn" data-mdel="${l.idx}" title="حذف الصنف الإضافي">${icon('trash')}</button>`;
        return `<tr>
          <td class="price-index">${i + 1}</td>
          <td class="price-name" data-label="الصنف">${nameCell}</td>
          <td class="price-cat" data-label="الفئة"><span class="cat-tag">${catCell}</span></td>
          <td class="price-unit" data-label="الوحدة">${unitCell}</td>
          <td class="price-qty" data-label="الكمية">${qtyCell}</td>
          <td class="price-edit" data-label="سعر الوحدة"><input aria-label="سعر ${esc(l.name || 'الصنف')}" inputmode="numeric" class="inline num" type="number" step="1" min="0" data-price="${esc(l.key)}" value="${l.price}">
              ${overridden ? `<button type="button" class="overridden" data-reset="${esc(l.key)}" title="إرجاع للسعر الأصلي">↺ إرجاع للأصلي (${fmt(l.basePrice)})</button>` : ''}</td>
          <td class="num price-total" data-label="الإجمالي"><b>${fmt(l.total)}</b></td>
          <td class="row-actions"><span class="ra">${acts}</span></td>
        </tr>`;
      }).join('');
    }
    $('#priceSubtotal').textContent = `${fmt(subtotal)} ${currency()}`;
    $('#priceVat').textContent = vatEnabled ? `${fmt(vatAmount)} ${currency()}` : '—';
    $('#priceTotal').textContent = `${fmt(total)} ${currency()}`;
    $('#discRow').dataset.state = discount > 0.004 ? 'show' : 'none';
    $('#priceDiscount').textContent = discount > 0.004 ? `- ${fmt(discount)} ${currency()}` : '—';
    // خلاصة الطلب كاملة في مكان واحد: المدفوع والمتبقي تحت الإجمالي مباشرة
    const pPaid = paidOf(cur), pRem = remainingOf(total, pPaid);
    $('#pricePaid').textContent = `${fmt(pPaid)} ${currency()}`;
    $('#priceRem').textContent = `${fmt(pRem)} ${currency()}`;
    $('#priceRemRow').dataset.state = total <= 0 ? 'none' : pRem > 0.004 ? 'due' : pRem < -0.004 ? 'over' : 'clear';
    $('#vatEnabled').checked = vatEnabled;
    $('#vatRate').value = num(cur.vat ? cur.vat.rate : vatRate);
    $('#vatRate').disabled = !vatEnabled;
    $('#vatRow').style.opacity = vatEnabled ? '' : '.6';
    cur.total = total;

    $$('input[data-price]', tb).forEach((inp) => inp.addEventListener('change', () => {
      const key = inp.dataset.price;
      const v = Math.max(0, money(inp.value));
      if (key.startsWith('manual:')) cur.manualRows[+key.split(':')[1]].price = v;
      else cur.priceOverrides[key] = v;
      setDirty(true); renderPricing();
    }));
    $$('input[data-accqty]', tb).forEach((inp) => inp.addEventListener('change', () => {
      const it = getItem(inp.dataset.accqty);
      const have = (cur.design.pieces || []).filter((p) => p.kind === 'acc' && p.itemId === it.id).length;
      let n = Math.max(0, Math.round(num(inp.value)));
      if (n > ACC_MAX) { n = ACC_MAX; toast(`أقصى عدد للصنف الواحد ${ACC_MAX} قطعة`, true); }
      if (n === have) { inp.value = have; return; }
      accQtyFocus = it.id;
      const placed = designer.setAccessoryCount(it, n); // onChange يحدّث الطلب ويعيد رسم التسعير
      inp.value = placed;
      if (placed < n) toast(`المساحة المتاحة لا تكفي لـ ${n} ${it.name}، تم وضع ${placed}. يمكنك تعديل التوزيع يدويًا.`, true);
      else {
        const d = placed - have;
        if (d) toast(d > 0 ? `أُضيفت ${d} من «${it.name}» إلى التصميم` : `حُذفت ${-d} من «${it.name}» من التصميم`);
      }
    }));
    $$('[data-reset]', tb).forEach((el) => el.addEventListener('click', () => { delete cur.priceOverrides[el.dataset.reset]; setDirty(true); renderPricing(); }));
    $$('[data-m]', tb).forEach((el) => el.addEventListener('change', () => {
      const r = cur.manualRows[+el.dataset.m];
      if (!r) return;
      r[el.dataset.k] = el.dataset.k === 'qty' ? Math.max(0, num(el.value)) : el.value;
      setDirty(true); renderPricing();
    }));
    $$('button[data-mdel]', tb).forEach((b) => b.addEventListener('click', () => {
      const r = cur.manualRows[+b.dataset.mdel];
      cur.manualRows.splice(+b.dataset.mdel, 1); setDirty(true); renderPricing();
      toast(`حُذف الصنف الإضافي${r && r.name ? ` «${r.name}»` : ''}`);
    }));
    // حذف إكسسوار من الجدول = تصفير عدده، فتُحذف قطعه من التصميم كما لو كُتب صفر في الكمية
    $$('button[data-accdel]', tb).forEach((b) => b.addEventListener('click', async () => {
      const it = getItem(b.dataset.accdel);
      const have = (cur.design.pieces || []).filter((p) => p.kind === 'acc' && p.itemId === it.id).length;
      if (!have) return;
      if (!(await confirmDlg('حذف من التصميم', `حذف ${have === 1 ? 'قطعة' : have === 2 ? 'قطعتي' : `${have} قطع من`} «${it.name}» من المخطط والتسعير؟ يمكن التراجع من المخطط.`, 'حذف'))) return;
      designer.setAccessoryCount(it, 0);
      toast(`حُذف «${it.name}» من التصميم`);
    }));
    $$('button[data-goedit]', tb).forEach((b) => b.addEventListener('click', () => showStage('design', { focus: true })));

    prepareControls(tb);
    renderPayment();
    if (readOnly) $$(LOCKABLE).forEach((el) => { el.disabled = true; });
    // تعديل الكمية يعيد رسم الجدول: يعود التركيز إلى الحقل نفسه ليُكمل المستخدم بالأسهم
    if (accQtyFocus) {
      const el = $$('input[data-accqty]', tb).find((e) => e.dataset.accqty === accQtyFocus);
      accQtyFocus = null;
      if (el && !el.disabled) { el.focus({ preventScroll: true }); el.select(); }
    }
  }

  $('#btnAddManual').addEventListener('click', () => {
    // المعرّف يربط السطر بتكلفته على الخادم حتى لو تغيّر ترتيب الأسطر
    cur.manualRows.push({ id: Store.uid(), name: '', qty: 1, price: 0, unit: 'قطعة' });
    setDirty(true);
    renderPricing();
    const inputs = $$('#priceTable input[data-k="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  /* --- ضريبة القيمة المضافة --- */
    const ensureVat = () => { if (!cur.vat) cur.vat = { enabled: false, rate: vatDefaults().rate }; return cur.vat; };
  $('#vatEnabled').addEventListener('change', () => { ensureVat().enabled = $('#vatEnabled').checked; setDirty(true); renderPricing(); });
  $('#vatRate').addEventListener('change', () => { ensureVat().rate = Math.min(100, Math.max(0, num($('#vatRate').value))); setDirty(true); renderPricing(); });

  /* ---------------- العميل والدفع ---------------- */
  const fieldMap = {
    custName: (v) => (cur.customer.name = v), custPhone: (v) => (cur.customer.phone = v), custAddress: (v) => (cur.customer.address = v),
    deliveryDate: (v) => (cur.deliveryDate = v), orderNotes: (v) => (cur.notes = v),
  };
  Object.keys(fieldMap).forEach((id) => $('#' + id).addEventListener('input', () => {
    fieldMap[id]($('#' + id).value);
    setDirty(true);
    if (id === 'custName' || id === 'custPhone') setFieldError($('#' + id), '');
    if (id === 'custAddress' || id === 'orderNotes') autoGrow($('#' + id));
    if (id === 'deliveryDate') syncDeliveryEcho();
    if (id === 'custAddress') syncMapsLink();
  }));

  /* ---------------- موقع التوصيل في خرائط جوجل ----------------
     يفتح الموظف الخرائط ليحدّد الموقع، ويصير مكان التوصيل رابطاً
     يُفتح في خرائط جوجل ليقود السائق إليه عند التسليم. */
   function mapsSearchUrl(address) {
     return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(address || '').trim());
   }
   /* رابط خارجي آمن: https فقط. التحليل عبر URL() لا regex، فأي scheme آخر
      (javascript:, data:, blob:, file:, …) أو نص غير صالح يُرفض بإرجاع ''. */
   function safeExternalUrl(raw) {
     const v = String(raw || '').trim();
     if (!v) return '';
     let u;
     try { u = new URL(v); } catch (_) { return ''; }
     if (u.protocol !== 'https:') return '';
     return u.href;
   }
   function syncMapsLink() {
     const el = $('#custMapsLink');
     const pinned = safeExternalUrl(cur.customer.mapsUrl);
     const addr = String(cur.customer.address || '').trim();
     const href = pinned || (addr ? mapsSearchUrl(addr) : '');
     if (href) { el.href = href; el.hidden = false; }
     else { el.removeAttribute('href'); el.hidden = true; }
   }
  $('#btnPickMap').addEventListener('click', () => {
    const addr = $('#custAddress').value.trim();
    const url = addr ? mapsSearchUrl(addr) : 'https://www.google.com/maps';
    openExternal(url);
  });
  $('#custMapsUrl').addEventListener('input', () => {
    const raw = $('#custMapsUrl').value.trim();
    // يُخزَّن الرابط فقط إن كان https صالحاً (أو فارغاً للمسح)؛ غير ذلك خطأ تحت الحقل ولا يُحفظ
    if (!raw || safeExternalUrl(raw)) {
      cur.customer.mapsUrl = safeExternalUrl(raw);
      setFieldError($('#custMapsUrl'), '');
      setDirty(true);
    } else {
      setFieldError($('#custMapsUrl'), 'رابط غير صالح — الصق رابط https كاملاً');
    }
    syncMapsLink();
  });

  /* ---------------- التحقق داخل الحقل ----------------
     كان الخطأ رسالة عابرة تختفي بعد ثانيتين. صار يُكتب تحت الحقل نفسه بإطار أحمر،
     ويُربط بالمدخل (aria-invalid + aria-describedby) ليُقرأ مع الحقل. */
  function setFieldError(el, msg) {
    if (!el) return;
    const host = el.closest('.fld') || el.closest('label') || el.parentElement;
    const body = el.closest('.fld-body') || host;
    let e = $('.fld-err', body);
    if (!e && msg) {
      e = document.createElement('small');
      e.className = 'fld-err';
      e.id = (el.id || 'f' + Store.uid()) + 'Err';
      body.appendChild(e);
    }
    host.classList.toggle('invalid', !!msg);
    if (msg) { e.textContent = msg; el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', e.id); }
    else { if (e) e.remove(); el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
  }

  /** الأرقام الهندية (٠١٢) والفارسية تُحوَّل إلى لاتينية: لوحة المفاتيح العربية تكتبها */
  const latinDigits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 1776);
  /** رسالة خطأ رقم الجوال، أو '' إن كان مقبولاً (الفارغ مقبول: الجوال ليس إلزامياً) */
  function phoneError(raw) {
    const v = latinDigits(raw).trim();
    if (!v) return '';
    if (/[^\d\s+()-]/.test(v)) return 'رقم الجوال يحتوي رموزاً غير صحيحة';
    const d = v.replace(/\D/g, '');
    if (/^05/.test(d) && d.length !== 10) return 'رقم الجوال السعودي 10 أرقام يبدأ بـ 05';
    if (/^9665/.test(d) && d.length !== 12) return 'الرقم الدولي السعودي 12 رقماً يبدأ بـ 9665';
    if (d.length < 9 || d.length > 15) return 'رقم الجوال غير مكتمل';
    return '';
  }
  $('#custPhone').addEventListener('change', () => {
    const el = $('#custPhone');
    const fixed = latinDigits(el.value).trim();
    if (fixed !== el.value) { el.value = fixed; cur.customer.phone = fixed; }
    setFieldError(el, phoneError(fixed));
    suggestKnownCustomer('phone');
  });
  $('#custName').addEventListener('change', () => suggestKnownCustomer('name'));

  /* ---------------- سجل العملاء (مشتق من الطلبات) ----------------
     لا جدول عملاء على الخادم: العميل يُعرَّف برقم جواله (الاسم يتكرر ويُكتب بصيغ
     مختلفة)، ويُبنى سجله من طلباته — فيعمل على البيانات القائمة بلا ترحيل. */
  const phoneKey = (p) => { const d = latinDigits(p).replace(/\D/g, ''); return d ? waPhone(d) : ''; };
  const custKey = (o) => phoneKey(o.customer && o.customer.phone) || ('name:' + String((o.customer && o.customer.name) || '').trim().toLowerCase());
  function customersIndex() {
    const m = new Map();
    db().orders.forEach((o) => {
      if (!o || !o.customer || !(o.customer.name || o.customer.phone)) return;
      const k = custKey(o);
      if (k === 'name:') return;
      let c = m.get(k);
      if (!c) { c = { key: k, name: '', phone: '', address: '', orders: [], sales: 0, remaining: 0, quotes: 0, last: '' }; m.set(k, c); }
      c.orders.push(o);
      const d = o.createdAt || '';
      if (d >= c.last) { c.last = d; c.name = o.customer.name || c.name; c.phone = o.customer.phone || c.phone; c.address = o.customer.address || c.address; }
      if (o.status === 'quote') c.quotes++;
      if (isSale(o)) { c.sales += orderRevenue(o); c.remaining += remainingOf(o.total, o.paid); }
    });
    return m;
  }
  /** قوائم الإكمال التلقائي لاسم العميل وجواله */
  function renderCustomerSuggestions() {
    const list = [...customersIndex().values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 300);
    $('#custNameList').innerHTML = list.map((c) => `<option value="${esc(c.name)}">${esc(c.phone)}</option>`).join('');
    $('#custPhoneList').innerHTML = list.filter((c) => c.phone).map((c) => `<option value="${esc(c.phone)}">${esc(c.name)}</option>`).join('');
  }
  /** عميل سابق: تُكمل بياناته الناقصة ويُعرض ملخّص تاريخه معه */
  function suggestKnownCustomer(by) {
    const known = $('#custKnown');
    const idx = customersIndex();
    let c = null;
    if (by === 'phone') c = idx.get(phoneKey(cur.customer.phone)) || null;
    else {
      const nm = String(cur.customer.name || '').trim().toLowerCase();
      const hits = nm ? [...idx.values()].filter((x) => String(x.name || '').trim().toLowerCase() === nm) : [];
      c = hits.length === 1 ? hits[0] : null;
    }
    // الطلب الحالي نفسه لا يُعدّ "عميلاً سابقاً"
    const others = c ? c.orders.filter((o) => o.id !== cur.id) : [];
    if (!c || !others.length) { known.hidden = true; return; }
    let filled = false;
    if (!cur.customer.name && c.name) { cur.customer.name = c.name; $('#custName').value = c.name; filled = true; }
    if (!cur.customer.phone && c.phone) { cur.customer.phone = c.phone; $('#custPhone').value = c.phone; filled = true; }
    if (!cur.customer.address && c.address) { cur.customer.address = c.address; $('#custAddress').value = c.address; autoGrow($('#custAddress')); filled = true; }
    if (filled) { setDirty(true); syncMapsLink(); }
    known.hidden = false;
    known.innerHTML = `${icon('user')} <span>عميل سابق: <b>${others.length}</b> ${others.length === 1 ? 'طلب' : others.length === 2 ? 'طلبان' : 'طلبات'}${c.remaining > 0.5 ? ` • <b class="warn-text">متبقٍّ عليه ${fmt(c.remaining)} ${esc(currency())}</b>` : ''}${filled ? ' • أُكملت بياناته' : ''}</span>`;
  }

  /* حقل التاريخ يعرض ترتيبه بلغة المتصفح (mm/dd/yyyy مثلاً)، فنكتب التاريخ
     بالعربية تحته ليقرأه الموظف بلا لبس، ومعه اسم اليوم وهو ما يهمّ في التوصيل. */
  function syncDeliveryEcho() {
    const el = $('#deliveryEcho');
    const v = $('#deliveryDate').value;
    if (!v) { el.textContent = ''; return; }
    const d = new Date(v + 'T00:00:00');
    if (isNaN(d)) { el.textContent = ''; return; }
    try {
      // nu-latn: لولاها يعطي المحرّك أرقاماً هندية (٢٠٢٦) وباقي النظام بأرقام عربية
      el.textContent = d.toLocaleDateString('ar-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } catch (_) { el.textContent = v; }
  }

  /* حالة الطلب: لونها في شريط الطلب يتبع الحالة نفسها */
  function syncStatusChip() {
    $('#statusChip').dataset.status = $('#orderStatus').value || 'new';
  }

  /* قاعدة المراحل: بدء التنفيذ بلا عربون، أو التسليم مع مبلغ متبقٍّ، يحتاجان
     تأكيداً صريحاً — لا منعاً، فقد يكون للعميل اتفاق خاص. */
  async function confirmStatusChange(order, next) {
    const prevSt = order.status || 'new';
    if (next === prevSt) return true;
    const { total } = computeLines(order);
    const paid = paidOf(order);
    const dep = Math.max(0, num(settings().depositPct));
    const starting = ['progress', 'done', 'delivered'].includes(next) && ['quote', 'new'].includes(prevSt);
    if (starting && dep > 0 && total > 0 && paid < money(total * dep / 100)) {
      const need = money(total * dep / 100);
      if (!(await confirmDlg('بدء التنفيذ بلا عربون', `المدفوع ${fmt(paid)} من عربون مطلوب ${fmt(need)} ${currency()} (${dep}٪ من الإجمالي). هل تريد نقل الطلب إلى «${STATUS[next]}» على أي حال؟`, 'متابعة', false))) return false;
    }
    let asked = false;
    if (next === 'delivered' && total - paid > 0.5) {
      asked = true;
      if (!(await confirmDlg('تسليم مع مبلغ متبقٍّ', `لم يُحصَّل ${fmt(total - paid)} ${currency()} من هذا الطلب بعد. تأكيد التسليم؟`, 'تأكيد التسليم', false))) return false;
    }
    // الحالات النهائية: التسليم والإلغاء يصعب التراجع عن أثرهما العملي،
    // فيُطلب تأكيد صريح واحد. باقي الحالات الروتينية تبقى فورية بلا إزعاج.
    if (!asked && (next === 'delivered' || next === 'cancelled') && !['delivered', 'cancelled'].includes(prevSt)) {
      if (!(await confirmDlg(next === 'delivered' ? 'تأكيد التسليم' : 'إلغاء الطلب', next === 'delivered' ? `سيُعلَّم الطلب ${order.number ? '#' + order.number : ''} بأنه «تم التوصيل». متابعة؟` : `سيُعلَّم الطلب ${order.number ? '#' + order.number : ''} بأنه «ملغي» ويخرج من المبيعات. متابعة؟`, next === 'delivered' ? 'تأكيد التسليم' : 'تأكيد الإلغاء', false))) return false;
    }
    return true;
  }
  $('#orderStatus').addEventListener('change', async () => {
    const sel = $('#orderStatus');
    const next = sel.value;
    if (!(await confirmStatusChange(cur, next))) { sel.value = cur.status || 'new'; syncStatusChip(); return; }
    cur.status = next;
    setDirty(true);
    syncStatusChip();
  });

  /* النص متعدّد الأسطر ينمو مع محتواه بدل شريط تمرير داخل حقل قصير */
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 132);
    el.style.height = h + 'px';
    el.style.overflowY = el.scrollHeight > 132 ? 'auto' : 'hidden';
  }

  /* ---------------- الدفعات ----------------
     كان المدفوع رقماً واحداً يُكتب فوق نفسه: لا تاريخ ولا طريقة ولا من استلم،
     ولا طريقة لتسجيل استرداد. صار سجلاً من الدفعات، والمدفوع مجموعها
     (يبقى الحقل paid محفوظاً مجموعاً ليقرأه كل ما بُني عليه). */
  const PAY_STATES = {
    none: 'غير مدفوع', partial: 'مدفوع جزئياً',
    full: 'مدفوع بالكامل', over: 'زائد عن المطلوب',
  };

  /** سجل دفعات الطلب؛ الطلبات القديمة (مدفوع بلا سجل) تُحوَّل إلى دفعة واحدة */
  function normalizePayments(o) {
    if (!Array.isArray(o.payments)) {
      const paid = money(o.paid);
      o.payments = paid ? [{ id: 'legacy', at: fmtDate(o.createdAt || Store.now()), amount: paid, method: 'other', note: 'مسجّلة قبل سجل الدفعات', by: o.createdByName || '', legacy: true }] : [];
    }
    o.payments = o.payments.filter((p) => p && Number.isFinite(num(p.amount)) && num(p.amount) !== 0);
    o.paid = money(o.payments.reduce((s, p) => s + money(p.amount), 0));
    return o.payments;
  }
  const paidOf = (o) => (Array.isArray(o.payments) ? money(o.payments.reduce((s, p) => s + money(p.amount), 0)) : money(o.paid));
  /** كم دُفع زيادة على إجمالي الطلب (0 إن لم يُدفع زائد). عروض الأسعار والملغية خارج الحساب —
      الملغي المدفوع يحتاج استرداداً لا تنبيه «زيادة». سببها الشائع: «كامل المبلغ» القديم بعد دفعة سابقة */
  const overpaidBy = (o) => {
    if (!o || o.status === 'quote' || o.status === 'cancelled') return 0;
    const over = money(paidOf(o) - num(o.total));
    return over > 0.004 ? over : 0;
  };
  /** المتبقي = الإجمالي − المدفوع، بلا تقييد بالصفر: السالب دفعة زائدة تُظهرها الشارة والحالة.
      الدفع الزائد مسموح (دفعة مقدمة) ولا يُمنع هنا — التعريف الوحيد المعتمد (F4). */
  const remainingOf = (total, paid) => money(num(total) - num(paid));

  function renderPayment() {
    // تسجيل دفعة أو استرداد: payments.add (الخادم يفرضها أيضاً)
    { const addBox = $('.pay-add'); if (addBox) addBox.hidden = !can('payments.add'); }
    const total = cur.total || 0;
    const paid = paidOf(cur);
    cur.paid = paid;
    const rem = remainingOf(total, paid);
    $('#payDiscount').value = num(cur.discount || 0);
    // العملة في العنوان لا بجانب كل رقم: يوفّر عرضاً ويمنع قصّ الأرقام في الجوال
    const cu = currency();
    $('#payTotalLbl').textContent = `الإجمالي (${cu})`;
    $('#payPaidLbl').textContent = `المدفوع (${cu})`;
    $('#payRemLbl').textContent = `المتبقي (${cu})`;
    $('#payTotal').textContent = fmt(total);
    $('#payPaidSum').textContent = fmt(paid);
    const n = (cur.payments || []).length;
    $('#payCount').textContent = n ? (n === 1 ? 'دفعة واحدة' : n === 2 ? 'دفعتان' : `${n} دفعات`) : 'لا دفعات';
    const vt = computeLines(cur);
    $('#payVatNote').textContent = vt.vatEnabled ? `شامل ضريبة ${num(vt.vatRate)}%` : 'بدون ضريبة';
    $('#payRemaining').textContent = fmt(rem);
    // الملخص الثابت أعلى الطلب (وشريط الجوال السفلي)
    $('#barTotal').textContent = fmt(total);
    $('#barRemaining').textContent = fmt(rem);
    $('#sumPaid').textContent = fmt(paid);
    $('#mobRemaining').textContent = fmt(rem);
    const remState = rem < -0.004 ? 'over' : (total > 0 && rem <= 0.004) ? 'clear' : rem > 0.004 ? 'due' : 'none';
    $('#sumRemBox').dataset.state = cur.status === 'quote' && remState === 'due' ? 'none' : remState;
    $('.mob-sum').classList.toggle('is-clear', remState === 'clear');
    scheduleWorkflow();

    // الحالة: لا شيء / جزئي / مكتمل / زائد — تُلوّن الشريط والشارة والمتبقي معاً
    let state = 'none';
    if (rem < -0.004) state = 'over';
    else if (total > 0 && rem <= 0.004) state = 'full';
    else if (paid > 0.004) state = 'partial';

    const pct = total > 0 ? Math.min(100, (paid / total) * 100) : (paid > 0 ? 100 : 0);
    $('#payFill').style.width = pct.toFixed(2) + '%';
    $('#payTrack').setAttribute('aria-valuenow', String(Math.round(pct)));
    $('#payTrack').setAttribute('aria-valuetext', `مدفوع ${fmt(paid)} من ${fmt(total)}`);
    $('#payBlock').dataset.state = state;
    const badge = $('#payBadge');
    badge.dataset.state = state;
    badge.textContent = state === 'partial' ? `${PAY_STATES.partial} • ${Math.round(pct)}%` : PAY_STATES[state];

    const dep = Math.max(0, num(settings().depositPct));
    $('#payDepBtn').hidden = !dep;
    $('#payDepBtn').textContent = `عربون ${dep}٪`;
    // «المتبقي» = الإجمالي ناقص كل الدفعات السابقة (كان «كامل المبلغ» = الإجمالي كله فيُدفع الطلب مرتين)
    $('#payRemBtn').textContent = rem > 0.004 ? `المتبقي ${fmt(rem)}` : 'لا متبقٍّ';
    $('#payRemBtn').disabled = !(rem > 0.004) || readOnly;
    renderPaymentsList();
  }

  function renderPaymentsList() {
    const box = $('#payList');
    const list = (cur.payments || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (!list.length) { box.innerHTML = '<p class="hint pay-empty">لم تُسجَّل أي دفعة بعد.</p>'; return; }
    box.innerHTML = `<ul class="pay-rows">${list.map((p) => {
      const refund = money(p.amount) < 0;
      return `<li class="pay-row${refund ? ' refund' : ''}">
        <span class="pay-row-main">
          <b class="num">${refund ? '−' : ''}${fmt(Math.abs(money(p.amount)))}</b>
          <small>${refund ? 'استرداد • ' : ''}${esc(PAY_METHODS[p.method] || p.method || '—')} • <bdi>${esc(fmtDate(p.at))}</bdi>${p.by ? ` • ${esc(p.by)}` : ''}</small>
          ${p.note ? `<small class="pay-note">${esc(p.note)}</small>` : ''}
        </span>
        <span class="pay-row-actions">
          <button type="button" class="btn small ghost" data-receipt="${esc(p.id)}" title="${refund ? 'سند صرف' : 'سند قبض'}">${icon('receipt')}<span>${refund ? 'سند صرف' : 'سند قبض'}</span></button>
          ${can('payments.delete') ? `<button type="button" class="icon-btn" data-paydel="${esc(p.id)}" title="حذف الدفعة">${icon('trash')}</button>` : ''}
        </span>
      </li>`;
    }).join('')}</ul>`;
    prepareControls(box);
    if (readOnly) $$('[data-paydel]', box).forEach((b) => { b.disabled = true; });
  }

  /* المبلغ يُكتب بفواصل أو بأرقام هندية: يُقرأ رقماً صحيحاً، وnull عند الإدخال المشوَّه
     ("10abc") بدل تخمين جزء منه — القرار عند الاستدعاء (خطأ حقلي). */
  const readAmount = (v) => {
    const s = latinDigits(v).replace(/[,\s٬]/g, '').trim();
    const n = strictNum(s);
    return n === null ? null : money(n);
  };

  /* اختصارات الدفعة: تملأ خانة المبلغ فقط ولا تسجّل شيئاً قبل الضغط على «تسجيل الدفعة». */
  $('#payQuick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pay]');
    if (!btn || readOnly) return;
    const total = cur.total || 0;
    const rem = Math.max(0, remainingOf(total, paidOf(cur)));
    const k = btn.dataset.pay;
    // كل اختيار سريع بحد أقصى المتبقي: لا يُقترح أبداً مبلغ يجعل المدفوع أكبر من الإجمالي
    const raw = k === 'rem' ? rem : k === 'dep' ? total * num(settings().depositPct) / 100 : total * num(k);
    const v = money(Math.min(raw, rem));
    if (!(v > 0.004)) { toast('لا يوجد مبلغ متبقٍّ على هذا الطلب', 'info'); $('#payAmount').value = ''; return; }
    $('#payAmount').value = v || '';
    $('#payAmount').focus();
  });

  let paying = false;   // منع التسجيل المزدوج من الضغط المتكرر أو Enter مع الزر معاً
  async function addPayment(refund) {
    if (readOnly || paying) return;
    if (!can('payments.add')) return;   // تسجيل الدفعات صلاحية مستقلة (الخادم يفرضها)
    paying = true;
    try {
    const el = $('#payAmount');
    const amt = readAmount(el.value);
    if (amt === null) { setFieldError(el, 'مبلغ غير صالح — أدخل أرقاماً فقط'); el.focus(); return; }
    if (!amt || amt < 0) { setFieldError(el, 'أدخل مبلغاً أكبر من صفر'); el.focus(); return; }
    if (refund && amt > paidOf(cur)) { setFieldError(el, `لا يمكن استرداد أكثر من المدفوع (${fmt(paidOf(cur))})`); el.focus(); return; }
    setFieldError(el, '');
    // دفعة أكبر من المتبقي: تأكيد صريح بالمبلغ الزائد (قد يكون مقصوداً، لكنه غالباً خطأ إدخال)
    if (!refund) {
      const remNow = remainingOf(cur.total || 0, paidOf(cur));
      if (amt - remNow > 0.004) {
        const over = money(amt - Math.max(0, remNow));
        const ok = await confirmDlg('المبلغ أكبر من المتبقي',
          `المتبقي على الطلب ${fmt(Math.max(0, remNow))} ${currency()} بعد الدفعات السابقة، والدفعة ${fmt(amt)}. سيصبح المدفوع أكبر من الإجمالي بـ ${fmt(over)} ${currency()}. هل تريد تسجيلها كما هي؟`,
          'تسجيلها كما هي');
        if (!ok) { el.focus(); return; }
      }
    }
    normalizePayments(cur);
    const p = {
      id: Store.uid(), at: $('#payDate').value || today(), amount: refund ? -amt : amt,
      method: $('#payMethod').value || 'cash', note: $('#payNote').value.trim().slice(0, 120),
      by: currentUser.name, byId: currentUser.id, createdAt: Store.now(),
    };
    cur.payments.push(p);
    setDirty(true);
    renderPayment();
    // الدفعة مال مستلَم: تُثبَّت فوراً بحفظ الطلب لا عند تذكّر الموظف للحفظ
    if (await saveOrder(true)) {
      el.value = ''; $('#payNote').value = '';
      toast(refund ? `سُجّل استرداد ${fmt(amt)} ${currency()}` : `سُجّلت دفعة ${fmt(amt)} ${currency()} وحُفظ الطلب`);
    } else if (!cur.customer.name.trim()) {
      toast('سُجّلت الدفعة محلياً — أدخل اسم العميل ثم احفظ الطلب', true);
    } else {
      // الحفظ الصامت فشل (رقم جوال غير صالح، تعارض في التصميم، انقطاع…): الدفعة ظاهرة محلياً
      // لكنها لم تصل للخادم — يجب أن يعرف الموظف ذلك وسببه بدل أن يظنها حُفظت
      const fe = $$('#m-customer .fld-err, #m-pay .fld-err').map((e) => e.textContent.trim()).find(Boolean);
      const why = fe || (Store.lastError ? humanError(Store.lastError) : '') || (designBlockReason().err || '');
      toast('سُجّلت الدفعة محلياً ولم يُحفظ الطلب بعد' + (why ? ': ' + why : ' — احفظ الطلب'), true);
    }
    } finally { paying = false; }
  }
  $('#btnAddPay').addEventListener('click', () => addPayment(false));
  $('#btnRefund').addEventListener('click', () => addPayment(true));
  $('#payAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPayment(false); } });
  $('#payAmount').addEventListener('input', () => setFieldError($('#payAmount'), ''));

  $('#payDiscount').addEventListener('input', () => {
    const raw = latinDigits($('#payDiscount').value).trim();
    if (!raw) { cur.discount = 0; setFieldError($('#payDiscount'), ''); setDirty(true); renderPricing(); renderPayment(); return; }
    const n = strictNum(raw);
    if (n === null || n < 0) { setFieldError($('#payDiscount'), 'خصم غير صالح — أدخل أرقاماً فقط'); return; }
    // سياسة معتمدة: 0<=discount<=subtotal (لا سالب ولا تجاوز للمجموع)
    const cap = computeLines(cur).subtotal;
    if (money(n) > cap) { setFieldError($('#payDiscount'), `الخصم لا يتجاوز مجموع الأصناف (${fmt(cap)} ${currency()})`); return; }
    setFieldError($('#payDiscount'), '');
    cur.discount = money(n);
    setDirty(true);
    renderPricing();
    renderPayment();
  });

  $('#payList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-paydel]');
    const rc = e.target.closest('[data-receipt]');
    if (rc) { const p = (cur.payments || []).find((x) => x.id === rc.dataset.receipt); if (p) printReceipt(cur, p); return; }
    if (!del || readOnly || !can('payments.delete')) return;
    const p = (cur.payments || []).find((x) => x.id === del.dataset.paydel);
    if (!p) return;
    if (!(await confirmDlg('حذف دفعة', `حذف ${money(p.amount) < 0 ? 'استرداد' : 'دفعة'} بمبلغ ${fmt(Math.abs(money(p.amount)))} ${currency()} بتاريخ ${fmtDate(p.at)}؟ يُسجَّل الحذف في سجل التحديثات.`))) return;
    cur.payments = cur.payments.filter((x) => x.id !== p.id);
    setDirty(true);
    renderPayment();
    if (cur.id) await saveOrder(true);
  });

  /* ---------------- المرفقات: واجهة الخانتين ---------------- */
  const ATT_DIM = 1000;          // أطول ضلع بالبكسل بعد التصغير
  const ATT_TARGET = 130 * 1024; // الحجم المستهدف للصورة الواحدة

  /** حجم الـ data URL بالكيلوبايت (طول Base64 ≈ ٤/٣ حجم البايتات) */
  const dataUrlKB = (src) => Math.round((String(src).length * 0.75) / 1024);

  function decodeImageFile(file) {
    if (window.createImageBitmap) {
      // imageOrientation: صور الجوال تحمل دوراناً في EXIF لا يطبّقه الرسم على الكانفس
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => decodeViaImg(file));
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onerror = () => rej(new Error('تعذّرت قراءة الملف'));
      fr.onload = () => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('الملف ليس صورة صالحة'));
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  async function shrinkImage(file) {
    const im = await decodeImageFile(file);
    const sw = im.width, sh = im.height;
    if (!sw || !sh) throw new Error('الملف ليس صورة صالحة');
    const scale = Math.min(1, ATT_DIM / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    // خلفية بيضاء: شفافية PNG تصير سوداء عند التحويل إلى JPEG
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(im, 0, 0, w, h);
    if (im.close) im.close();
    let out = cv.toDataURL('image/jpeg', 0.82);
    for (let q = 0.7; dataUrlKB(out) * 1024 > ATT_TARGET && q >= 0.42; q -= 0.14) out = cv.toDataURL('image/jpeg', q);
    return out;
  }

  const attSlots = () => $$('#attList .att');

  function renderAttachments() {
    cur.attachments = normalizeAttachments(cur.attachments);
    attSlots().forEach((slot, i) => {
      const a = cur.attachments[i];
      const img = $('.att-img', slot), bar = $('.att-bar', slot);
      $('.att-title', slot).value = a.name || '';
      slot.dataset.has = a.src ? '1' : '';
      img.hidden = !a.src;
      if (a.src) img.src = a.src; else img.removeAttribute('src');
      $('.att-ph', slot).hidden = !!a.src;
      bar.hidden = !a.src;
      $('.att-size', slot).textContent = a.src ? `${dataUrlKB(a.src)} ك.ب` : '';
      // بعد اختيار صورة يختفي نص الزر، فيحتاج اسماً يُقرأ لقارئ الشاشة
      $('.att-pick', slot).setAttribute('aria-label', a.src ? `تغيير صورة ${a.name || 'المرفق ' + (i + 1)}` : `إرفاق صورة للمرفق ${i + 1}`);
      img.alt = a.src ? (a.name || `مرفق ${i + 1}`) : '';
    });
    const filled = filledAttachments(cur).length;
    const badge = $('#attsBadge');
    if (badge) { badge.textContent = filled || ''; badge.hidden = !filled; }
  }

  async function pickAttachment(i, file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('اختر ملف صورة', true); return; }
    const slot = attSlots()[i];
    const order = cur;   // الضغط ليس فورياً: قد يُفتح طلب آخر قبل أن ينتهي
    slot.dataset.busy = '1';
    try {
      const src = await shrinkImage(file);
      if (cur !== order) return;
      // الكتابة بعد الانتظار لا قبله: renderAttachments يستبدل المصفوفة بكائنات
      // جديدة، فصورة تنتهي متأخّرة تضيع لو أمسكنا بالكائن قبل await.
      cur.attachments = normalizeAttachments(cur.attachments);
      cur.attachments[i].src = src;
      setDirty(true);
      renderAttachments();
    } catch (e) {
      toast('تعذّر إرفاق الصورة: ' + e.message, true);
    } finally {
      slot.dataset.busy = '';
    }
  }

  $('#btnGoAtts').addEventListener('click', () => {
    const el = $('#attList');
    if (el) el.scrollIntoView({ behavior: smoothScroll(), block: 'start' });
  });
  // إجراءات جماعية للإكسسوارات (تأكيد مطلوب للحذف الجماعي)
  $('#btnAccEditAll').addEventListener('click', openAccEditAll);
  $('#btnAccDeleteAll').addEventListener('click', deleteAllAccs);

  $('#attList').addEventListener('click', (e) => {
    const slot = e.target.closest('.att');
    if (!slot || readOnly) return;
    const i = +slot.dataset.att;
    if (e.target.closest('.att-pick') || e.target.closest('.att-replace')) $('.att-file', slot).click();
    else if (e.target.closest('.att-remove')) {
      cur.attachments[i] = { name: cur.attachments[i].name, src: '' };
      $('.att-file', slot).value = '';
      setDirty(true);
      renderAttachments();
    }
  });

  $('#attList').addEventListener('change', (e) => {
    const slot = e.target.closest('.att');
    if (!slot || !e.target.classList.contains('att-file')) return;
    pickAttachment(+slot.dataset.att, e.target.files && e.target.files[0]);
    e.target.value = '';   // اختيار الملف نفسه مرة أخرى يجب أن يطلق الحدث
  });

  $('#attList').addEventListener('input', (e) => {
    const slot = e.target.closest('.att');
    if (!slot || !e.target.classList.contains('att-title')) return;
    cur.attachments[+slot.dataset.att].name = e.target.value.slice(0, 60);
    setDirty(true);
  });

  function fillOrderForm() {
    $('#custName').value = cur.customer.name || '';
    $('#custPhone').value = cur.customer.phone || '';
    $('#custAddress').value = cur.customer.address || '';
    $('#custMapsUrl').value = cur.customer.mapsUrl || '';
    $('#deliveryDate').value = cur.deliveryDate || '';
    $('#orderStatus').value = cur.status || 'new';
    $('#orderNotes').value = cur.notes || '';
    normalizePayments(cur);
    $('#payAmount').value = ''; $('#payNote').value = ''; $('#payDate').value = today();
    [$('#custName'), $('#custPhone'), $('#payAmount')].forEach((el) => setFieldError(el, ''));
    $('#custKnown').hidden = true;
    syncStatusChip();
    syncDeliveryEcho();
    syncMapsLink();
    autoGrow($('#custAddress'));
    autoGrow($('#orderNotes'));
    renderAttachments();
    syncOrderTitle();
    renderOrderMeta();
    closeInspector();
    renderWalls();
    syncCornerMode();
    renderPricing();
    updateOverlapWarn();
    syncWallSel();
    setOrderOwnerLabel(cur);
    applyOrderLock();
    updateUndoButtons();
  }

  function loadOrder(order, navigate = true) {
    cur = JSON.parse(JSON.stringify(order));
    cur.priceOverrides = cur.priceOverrides || {};
    cur.manualRows = cur.manualRows || [];
    cur.costs = cur.costs || {};
    cur.extraCosts = cur.extraCosts || [];
    cur.customer = cur.customer || { name: '', phone: '', address: '' };
    // تعقيم القيم القديمة (محلية/مخزّنة): أي رابط غير https يُسقط ولا يُعرض قابلاً للنقر
    cur.customer.mapsUrl = safeExternalUrl(cur.customer.mapsUrl);
    if (cur.discount == null || cur.discount === '') cur.discount = 0;
    else cur.discount = money(cur.discount);
    cur.attachments = normalizeAttachments(cur.attachments);
    // الطلبات القديمة المحفوظة بدون ضريبة تبقى كما هي
    cur.vat = cur.vat || { enabled: false, rate: vatDefaults().rate };
    readOnly = !canEditOrder(cur);
    curVersions = new Set();
    ownVersion(cur.updatedAt);
    designer.setState(cur.design, { cornerMode: settings().cornerMode || 'deduct' });
    cur.design = designer.getState();
    fillOrderForm();
    setDirty(false);
    if (navigate) showPage('order');
    if (readOnly) toast('هذا الطلب لموظف آخر: عرض فقط');
  }

  async function startNewOrder(force = false) {
    if (!force && dirty && !(await confirmDlg('طلب جديد', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) return;
    cur = newOrder();
    readOnly = false;
    curVersions = new Set();
    designer.setState(cur.design);
    $('#roomW').value = 5; $('#roomH').value = 4;
    fillOrderForm();
    setDirty(false);
    clearDraft();
    showStage('design');   // الطلب الجديد يبدأ من أول مرحلة
  }
  $('#btnNewOrder').addEventListener('click', () => startNewOrder());

  /** عنوان الطلب: رقمه، أو «بانتظار الرقم» إن حُفظ محلياً ولم يصل الخادم بعد */
  function syncOrderTitle() {
    const kind = cur.status === 'quote' ? 'عرض السعر' : 'الطلب';
    // الرقم في عزل اتجاه حتى يبقى «#1005» متماسكاً على كل الشاشات (كان يظهر 1005# بجوار النص العربي)
    $('#orderTitle').innerHTML = cur.number ? `${esc(kind)} <bdi dir="ltr">#${esc(cur.number)}</bdi>` : esc( (cur.id ? `${kind} (بانتظار الرقم)` : (cur.status === 'quote' ? 'عرض سعر جديد' : 'طلب جديد')));
  }
  /** الخادم يمنح رقم الطلب عند أول حفظ ناجح: يُنقل إلى الطلب المفتوح */
  function adoptServerNumber() {
    if (!cur.id || cur.number) return;
    const o = db().orders.find((x) => x.id === cur.id);
    if (o && o.number) { cur.number = o.number; syncOrderTitle(); scheduleWorkflow(); }
  }

  const smoothScroll = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');

  async function saveOrder(silent = false) {
    if (readOnly) { if (!silent) toast('هذا الطلب لموظف آخر: لا يمكن حفظ التعديلات', true); return false; }
    cur.design = designer.getState();
    /* رفض حفظ تصميم فيه تعارض هندسي غير مسموح — نفس القواعد المستعملة أثناء
       التعديل في هذه الصفحة وفي بوابة العميل (تعارض قطعتين أو كنبة سدّت باباً/مشباً).
       الملامسة على الحد تحذير واضح مع السماح بالحفظ — لا تمنع وحدها. */
    const designCheck = designBlockReason();
    if (designCheck.err) {
      if (!silent) { toast(designCheck.err, true); markRoomHealth(); showStage('design'); }
      return false;
    }
    if (designCheck.warn && !silent) toast('تنبيه: ' + designCheck.warn, 'info');
    normalizePayments(cur);
    cur.discount = money(cur.discount || 0);
    const { lines, total, subtotal, vatAmount, vatRate } = computeLines(cur);
    cur.subtotal = subtotal; cur.vatAmount = vatAmount; cur.vatRate = vatRate;
    // التحقق يُكتب تحت الحقل نفسه، ويُنقل المستخدم إليه
    const nameErr = cur.customer.name.trim() ? '' : 'اسم العميل مطلوب لحفظ الطلب';
    const phErr = phoneError(cur.customer.phone);
    const discErr = cur.discount < 0 || cur.discount > subtotal ? 'الخصم يجب أن يكون بين صفر ومجموع الأصناف' : '';
    setFieldError($('#custName'), nameErr);
    setFieldError($('#custPhone'), phErr);
    setFieldError($('#payDiscount'), discErr);
    if (nameErr || phErr || discErr) {
      if (!silent) {
        toast(nameErr || phErr || discErr, true);
        if (discErr && !nameErr && !phErr) {
          showStage('pay');
          $('#payDiscount').focus({ preventScroll: true });
        } else {
          showStage('customer');
          $('#m-customer').scrollIntoView({ behavior: smoothScroll(), block: 'nearest' });
          (nameErr ? $('#custName') : $('#custPhone')).focus({ preventScroll: true });
        }
      }
      return false;
    }
    if (cur.status === 'quote' && !cur.validUntil) {
      const d = new Date(); d.setDate(d.getDate() + Math.max(1, num(settings().quoteDays) || 7));
      cur.validUntil = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    if (!lines.length && !silent) toast('تنبيه: الطلب لا يحتوي على أصناف', true);
    lines.filter((l) => l.kind !== 'manual').forEach((l) => (cur.priceOverrides[l.key] = l.price));
    Object.keys(cur.priceOverrides).forEach((k) => { if (!lines.some((l) => l.key === k)) delete cur.priceOverrides[k]; });
    // التكاليف تتبع الأصناف: تُزال تكلفة صنف حُذف، ويُعاد حساب الإجمالي إن تغيّرت الكميات
    cur.costs = cur.costs || {};
    // طلب محفوظ قبل دمج الكنب المتشابه: تُنقل تكلفته من مفتاح القطعة إلى مفتاح النوع قبل التنظيف
    lines.filter((l) => l.kind !== 'manual').forEach((l) => { const c = lineCost(cur, l); if (c !== null) cur.costs[l.key] = c; });
    Object.keys(cur.costs).forEach((k) => { if (!lines.some((l) => l.key === k)) delete cur.costs[k]; });
    cur.extraCosts = extraCosts(cur);
    syncCostTotal(cur);
    cur.total = total;
    // المخزَّن = ما زال مستحقاً على العميل (لا سالب): الخادم يرفض remaining السالب (سياسة مالية)،
    // والدفع الزائد يبقى مسموحاً ويُعرض من (الإجمالي − المدفوع) مباشرة في الواجهة كـ«زائد عن المطلوب».
    cur.remaining = Math.max(0, remainingOf(total, cur.paid));
    const nowIso = Store.now();
    if (!cur.id) {
      // سحابياً يمنح الخادم الرقم عند أول حفظ ناجح، فلا يضيع رقم بحفظ فاشل
      let no = null;
      if (!Store.serverNumbers) {
        try { no = await Store.nextOrderNo(); } catch (e) { toast('تعذر الحفظ: ' + e.message, true); return false; }
      }
      cur.id = Store.uid();
      cur.number = no;
      cur.createdAt = nowIso;
      cur.createdBy = currentUser.id;
      cur.createdByName = currentUser.name;
    }
    const idx = db().orders.findIndex((o) => o.id === cur.id);
    const prev = idx >= 0 ? db().orders[idx] : null;
    // نسخة الخادم ليست التي بدأنا منها: عدّله جهاز آخر أثناء تعديلنا (والمزامنة
    // الدورية جلبتها دون أن تفتحها لأن لدينا تعديلات). نعرض القرار بدل الكتابة فوقه.
    if (prev && prev.updatedAt && !curVersions.has(prev.updatedAt)) {
      setDirty(true); saveDraft();
      await resolveConflict(JSON.parse(JSON.stringify(cur)));
      return false;
    }
    cur.updatedAt = nowIso;
    cur.updatedByName = currentUser.name;
    // لقطة نسب العمولة عند الاعتماد: لا تتأثر طلبات سابقة بتعديل النسب لاحقاً
    snapshotOrderCommission(cur);
    // وقت آخر تغيير للحالة: عليه تقوم تنبيهات المراحل، ويُشتق من الطلب نفسه
    // لا من سجل التحديثات لأن السجل لا يصل الموظفين في الوضع السحابي.
    if (!prev || (prev.status || 'new') !== (cur.status || 'new')) {
      cur.statusAt = nowIso;
      cur.statusByName = currentUser.name;
    }
    const copy = JSON.parse(JSON.stringify(cur));
    if (idx >= 0) db().orders[idx] = copy; else db().orders.push(copy);
    ownVersion(copy.updatedAt);
    // سجل التحديثات
    if (!prev) logActivity('create', copy, [`الإجمالي ${fmt(total)}`, `المدفوع ${fmt(num(copy.paid))}`, `${lines.length} صنف`]);
    else { const ch = diffOrder(prev, copy); if (ch.length) logActivity('update', copy, ch); }
    if (!(await Store.save())) {
      setDirty(true); saveDraft();
      if (Store.lastStatus === 409) { await resolveConflict(copy); return false; }
      setNetState(Store.lastStatus === -1 ? 'off' : 'err');
      toast(humanError(Store.lastError) + ' — حُفظت نسخة محلية', true);
      return false;
    }
    setNetState('ok');
    setDirty(false);
    adoptServerNumber();
    syncOrderTitle();
    renderOrderMeta();
    renderNotifications();
    renderCustomerSuggestions();
    if (!silent) toast(`تم حفظ ${cur.status === 'quote' ? 'عرض السعر' : 'الطلب'} #${cur.number || ''}`);
    return true;
  }
  $('#btnSaveOrder').addEventListener('click', async () => {
    const b = $('#btnSaveOrder');
    if (b.disabled) return;
    b.disabled = true; b.setAttribute('aria-busy', 'true');
    $('span', b).textContent = 'جارٍ الحفظ…';
    try { await saveOrder(); }
    finally { b.disabled = false; b.removeAttribute('aria-busy'); $('span', b).textContent = 'حفظ الطلب'; }
  });

  /* تعارض: عُدِّل الطلب من جهاز آخر بعد فتحنا له. نعرض الفروق ونترك القرار للموظف. */
  /* دمج ثلاثي لطلب متعارض: الأصل (ما فتحه هذا الجهاز) ونسختي ونسخة الخادم.
     الحقل الذي غيّرتُه وحدي يأخذ قيمتي، وما غيّره الآخر وحده يبقى كما على الخادم، وما غيّره
     الاثنان بقيمتين مختلفتين «تعارض» يختار فيه المستخدم. الدفعات بالمعرّف: تُجمع من الطرفين،
     ولا تُحذف دفعة إلا إن حذفتُها أنا (كانت في الأصل وليست عندي). المجاميع تُحسب عند الحفظ. */
  const MERGE_SKIP = new Set(['id', 'number', 'createdAt', 'createdBy', 'createdByName', 'updatedAt', 'updatedByName', 'payments', 'paid', 'remaining',
    'subtotal', 'vatAmount', 'vatRate', 'total', 'costTotal', 'statusAt', 'statusByName', 'commRates', 'sellerRate', 'mandoubRate', 'shareRate', 'othersRate', '_base']);
  const MERGE_LABELS = { status: 'الحالة', deliveryDate: 'تاريخ التوصيل', notes: 'الملاحظات', discount: 'الخصم', vat: 'الضريبة', design: 'التصميم', manualRows: 'الأصناف الإضافية',
    priceOverrides: 'الأسعار', attachments: 'المرفقات', costs: 'التكاليف', extraCosts: 'التكاليف الإضافية', validUntil: 'صلاحية العرض',
    'customer.name': 'اسم العميل', 'customer.phone': 'الجوال', 'customer.address': 'مكان التوصيل', 'customer.mapsUrl': 'رابط الموقع' };
  const mergeVal = (k, v) => {
    if (k === 'status') return STATUS[v || 'new'] || v || '—';
    if (k === 'discount') return fmt(v || 0);
    if (v === undefined || v === null || v === '') return '—';
    return typeof v === 'string' ? (v.length > 40 ? v.slice(0, 40) + '…' : v) : 'نسخة مختلفة';
  };
  function mergeOrders(base, mine, theirs) {
    const J = (v) => JSON.stringify(v === undefined ? null : v);
    const out = JSON.parse(JSON.stringify(theirs));
    const conflicts = [];
    const take = (k, get, set) => {
      const b = get(base), m = get(mine), t = get(theirs);
      if (J(m) === J(b) || J(m) === J(t)) return;            // لم أغيّره، أو غيّرناه للقيمة نفسها
      if (J(t) === J(b)) { set(out, m === undefined ? undefined : JSON.parse(J(m))); return; }   // غيّرتُه وحدي
      conflicts.push({ key: k, label: MERGE_LABELS[k] || k, mine: m, theirs: t, apply: (o) => set(o, m === undefined ? undefined : JSON.parse(J(m))) });
    };
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(mine || {}), ...Object.keys(theirs || {})]);
    keys.forEach((k) => {
      if (MERGE_SKIP.has(k) || k === 'customer') return;
      take(k, (o) => (o || {})[k], (o, v) => {
        if (v === undefined) delete o[k]; else o[k] = v;
        // الحالة ووقتها ومن غيّرها تتبع بعضها
        if (k === 'status') { o.statusAt = mine.statusAt; o.statusByName = mine.statusByName; }
      });
    });
    ['name', 'phone', 'address', 'mapsUrl'].forEach((f) => take('customer.' + f, (o) => ((o || {}).customer || {})[f], (o, v) => { o.customer = o.customer || {}; o.customer[f] = v === undefined ? '' : v; }));
    // الدفعات
    const ids = (o) => new Map(((o && o.payments) || []).filter((p) => p && p.id && p.id !== 'legacy').map((p) => [p.id, p]));
    const B = ids(base), M = ids(mine), T = ids(theirs);
    const pays = new Map(T);
    M.forEach((p, id) => {
      if (!B.has(id) && !T.has(id)) pays.set(id, p);                                   // أضفتُها
      else if (B.has(id) && T.has(id) && J(p) !== J(B.get(id)) && J(T.get(id)) === J(B.get(id))) pays.set(id, p);   // عدّلتُها وحدي
    });
    B.forEach((p, id) => { if (!M.has(id) && T.has(id) && J(T.get(id)) === J(p)) pays.delete(id); });   // حذفتُها ولم يعدّلها الآخر
    out.payments = [...pays.values()];
    out.paid = money(out.payments.reduce((s, p) => s + num(p.amount), 0));
    return { merged: out, conflicts };
  }

  async function resolveConflict(localCopy, keepBase) {
    let remote = null;
    // الأصل الذي فتحه هذا الجهاز (قبل جلب نسخة الخادم الجديدة) — أساس الدمج الثلاثي.
    // يُمرَّر عند إعادة فتح النافذة (بعد جلبٍ صارت فيه اللقطة = الخادم فلم تعد أصلاً)
    const base = keepBase || (Store.baseOf ? Store.baseOf('orders', localCopy.id) : null);
    // جلب فقط (بلا دفع): الدفع هنا مرفوض أصلاً (409)، وrefresh() الجديد يُجهض الجلب عند فشله
    if (!(await Store.fetchLatest())) {
      toast(humanError(Store.lastError, 'تعذّر جلب نسخة الخادم. تحقق من الاتصال وحاول مجدداً.'), true);
      return;
    }
    remote = db().orders.find((o) => o.id === localCopy.id) || null;
    setNetState('ok');
    const who = (remote && remote.updatedByName) || 'موظف آخر';
    const when = remote && remote.updatedAt ? fmtDateTimeUi(remote.updatedAt) : '';
    const ch = remote ? diffOrder(remote, localCopy) : [];
    // صياغة واضحة: أي القيمتين على الخادم وأيهما عندك (كانت «من … إلى» ملتبسة)
    const side = (c) => {
      if (/^حذف /.test(c)) return `على الخادم فقط (ليست عندك): ${c.replace(/^حذف /, '')}`;
      if (/^(دفعة|استرداد) /.test(c)) return `عندك فقط (ليست على الخادم): ${c}`;
      return c.replace(/: من "?(.+?)"? إلى "?(.+?)"?$/, ': على الخادم «$1» • عندك «$2»');
    };
    const mg = remote && base ? mergeOrders(base, localCopy, remote) : null;
    // ما ستحذفه الكتابة فوق نسخة الخادم من مال: دفعات على الخادم ليست في نسختك
    const lost = remote ? (remote.payments || []).filter((p) => p && p.id && p.id !== 'legacy' && !(localCopy.payments || []).some((q) => q.id === p.id)) : [];
    const payTxt = (p) => `${money(p.amount) < 0 ? 'استرداد' : 'دفعة'} ${fmt(Math.abs(money(p.amount)))} ${PAY_METHODS[p.method] || ''} (${fmtDate(p.at)})`;
    openModal('تعارض في التعديل', `
      <p class="conflict-lead">عُدِّل الطلب ${localCopy.number ? '#' + localCopy.number : ''} على الخادم بواسطة <b>${esc(who)}</b>${when ? ' • ' + esc(when) : ''} بعد أن فتحتَه.
      <b>لم يُحفظ تعديلك</b> حتى لا يُمحى عملهم.</p>
      ${ch.length ? `<div class="field-group"><span class="field-label">ما يختلف بين نسختك ونسخة الخادم</span>
        <ul class="conflict-list">${ch.slice(0, 8).map((c) => `<li>${esc(side(c))}</li>`).join('')}</ul>
        ${ch.length > 8 ? `<p class="hint">و${ch.length - 8} فرقاً آخر.</p>` : ''}</div>` : '<p class="hint">لا فروق ظاهرة في الحقول الأساسية.</p>'}
      ${mg && mg.conflicts.length ? `<div class="field-group cf-choices"><span class="field-label">غيّرتَ أنت و${esc(who)} الحقل نفسه — اختر القيمة لكل حقل قبل الدمج</span>
        ${mg.conflicts.map((c, i) => `<div class="cf-choice"><b>${esc(c.label)}</b>
          <label class="check"><input type="radio" name="cf${i}" value="theirs" checked> على الخادم: ${esc(mergeVal(c.key, c.theirs))}</label>
          <label class="check"><input type="radio" name="cf${i}" value="mine"> عندك: ${esc(mergeVal(c.key, c.mine))}</label></div>`).join('')}</div>` : ''}
      <div class="conflict-actions">
        ${mg ? `<button id="cfMerge" class="btn primary block lg">ادمج التعديلين</button>
        <p class="hint">يبقى ما غيّره ${esc(who)}، ويُضاف ما غيّرتَه أنت، والدفعات تُجمع من النسختين (لا تُحذف إلا دفعة حذفتَها أنت).</p>` : ''}
        <button id="cfTake" class="btn block${mg ? '' : ' primary lg'}">افتح نسخة الخادم وألغِ تعديلي</button>
        <button id="cfKeep" class="btn ghost block">اكتب نسختي فوق نسخة الخادم</button>
      </div>`, () => {
      if ($('#cfMerge')) $('#cfMerge').addEventListener('click', async () => {
        const merged = JSON.parse(JSON.stringify(mg.merged));
        mg.conflicts.forEach((c, i) => { const r = document.querySelector(`input[name="cf${i}"]:checked`); if (r && r.value === 'mine') c.apply(merged); });
        closeModal();
        merged.updatedAt = Store.now();
        merged.updatedByName = currentUser.name;
        clearDraft();
        // نسخة الخادم صارت معروفة (أساس الحفظ التالي)، والنسخة المدموجة تُحمَّل ثم تُحفظ بمجاميع محسوبة من جديد
        loadOrder(merged, false);   // يصفّر النسخ المعروفة، فتُضاف بعده
        ownVersion(remote.updatedAt);
        cur.updatedAt = merged.updatedAt;
        ownVersion(cur.updatedAt);
        setDirty(true);
        if (await saveOrder(true)) {
          const d = diffOrder(remote, cur);
          if (d.length) { logActivity('update', cur, d.concat(`دمج تعديلين متعارضين (مع ${who})`)); await Store.save(); }
          toast('دُمج التعديلان وحُفظ الطلب');
        } else toast(humanError(Store.lastError) + ' — النسخة المدموجة مفتوحة، راجعها ثم احفظ', true);
      });
      $('#cfKeep').addEventListener('click', async () => {
        // الكتابة فوق نسخة الخادم تمحو عمل الآخر كله: تأكيد صريح بما سيُحذف من مال
        const warn = lost.length ? `سيُحذف من الخادم: ${lost.map(payTxt).join('، ')}.` : '';
        const ok = await confirmDlg('الكتابة فوق نسخة الخادم', `ستحل نسختك محل نسخة ${who} بالكامل، ويضيع كل ما غيّره. ${warn} هل أنت متأكد؟`, 'اكتب نسختي فوقها');
        if (!ok) { resolveConflict(localCopy, base); return; }
        closeModal();
        // بعد التحديث صارت اللقطة تساوي نسخة الخادم، فالحفظ التالي أساسه صحيح ويمرّ
        const idx = db().orders.findIndex((o) => o.id === cur.id);
        const copy = JSON.parse(JSON.stringify(cur));
        copy.updatedAt = Store.now();
        copy.updatedByName = currentUser.name;
        cur.updatedAt = copy.updatedAt;
        // الموظف رأى نسخة الخادم واختار الكتابة فوقها: صارت نسخة معروفة لا تعارضاً
        if (remote) ownVersion(remote.updatedAt);
        ownVersion(copy.updatedAt);
        if (idx >= 0) db().orders[idx] = copy; else db().orders.push(copy);
        if (remote) { const d = diffOrder(remote, copy); if (d.length) logActivity('update', copy, d.concat('كتابة فوق تعديل من جهاز آخر')); }
        if (await Store.save()) { setNetState('ok'); setDirty(false); renderOrderMeta(); toast('حُفظ تعديلك فوق نسخة الخادم'); }
        else toast(humanError(Store.lastError), true);
      });
      $('#cfTake').addEventListener('click', () => {
        closeModal();
        if (!remote) { startNewOrder(true); return; }
        clearDraft();
        loadOrder(remote, false);
        setDirty(false);
        toast('فُتحت نسخة الخادم');
      });
    });
  }

  /* ---------------- حالة الاتصال ---------------- */
  let lastSyncAt = null;
  function setNetState(state) {
    const el = $('#netState');
    if (!el || !Store.isRemote) return;
    if (state === 'ok') lastSyncAt = Date.now();
    el.dataset.state = state;
    const labels = { ok: 'محدّث', sync: 'يزامن…', off: 'غير متصل', err: 'تعذّر التحديث' };
    $('#netLabel').textContent = labels[state] || '';
    // «تعذّر التحديث» مع سببه الفعلي من الخادم (كان بلا سبب فلا يُعرف ما الخطأ)
    el.title = state === 'ok' && lastSyncAt ? `آخر تحديث ${fmtDateTimeUi(new Date(lastSyncAt).toISOString())}`
      : state === 'err' && Store.lastError ? `تعذّر التحديث: ${humanError(Store.lastError)} — اضغط لإعادة المحاولة` : (labels[state] || '');
    if (state !== 'sync') announceRejected();
  }
  /** تغيير محلي رفضه الخادم (لا صلاحية / بيانات غير صالحة): أُعيدت نسخة الخادم، ويُبلَّغ المستخدم مرة واحدة */
  function announceRejected() {
    const list = Store.takeRejected ? Store.takeRejected() : [];
    if (!list.length) return;
    const what = list.map((r) => (r.coll === 'orders' ? `الطلب${r.number != null ? ' #' + r.number : ''}` : r.coll === 'items' ? 'صنف' : r.coll === 'settings' ? 'الإعدادات' : 'سجل')).filter((v, i, a) => a.indexOf(v) === i).join('، ');
    toast(`لم يقبل الخادم تعديلاً على ${what}: ${humanError(list[0].error)}. أُعيدت النسخة المحفوظة على الخادم، والمزامنة تعمل الآن.`, true);
  }
  function refreshNetAge() {
    const el = $('#netState');
    if (!el || el.dataset.state !== 'ok' || !lastSyncAt) return;
    const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
    $('#netLabel').textContent = mins < 1 ? 'محدّث' : (mins < 60 ? `قبل ${mins} د` : `قبل ${Math.floor(mins / 60)} س`);
    // تحذير بصري إذا طال انقطاع التحديث دون أن يعلن المتصفح انقطاعاً
    el.dataset.stale = mins >= 5 ? '1' : '';
  }

  /* ---------------- التصدير PDF (أمر شراء صفحة واحدة) ---------------- */
  const printDesigner = new Designer(document.createElement("canvas"), { getItem, pieceSpecLabel, pieceStyle });

  function roomSummary(design) {
    const ws = design.walls || [];
    if (ws.length === 4 && ws[0].angle === 0 && ws[1].angle === 90) return `${Designer.util.round(ws[0].len, 2)} × ${Designer.util.round(ws[1].len, 2)} م`;
    return `${ws.length} جدران`;
  }

  /* ---------------- رمز QR للفاتورة الضريبية المبسطة ----------------
     متطلبات الفوترة (المرحلة الأولى): رمز QR يحمل بصيغة TLV مشفّرة Base64 خمسة حقول:
     اسم البائع، الرقم الضريبي، وقت الإصدار، الإجمالي شامل الضريبة، مبلغ الضريبة.
     يُولَّد فقط حين تكون الضريبة مفعّلة والرقم الضريبي مسجّلاً في الإعدادات. */
  const QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  function zatcaTlv(fields) {
    const enc = new TextEncoder();
    const bytes = [];
    fields.forEach((v, i) => {
      const b = enc.encode(String(v));
      bytes.push(i + 1, b.length, ...b);
    });
    let s = '';
    bytes.forEach((x) => (s += String.fromCharCode(x)));
    return btoa(s);
  }
  async function zatcaQr(order) {
    const s = settings();
    const { total, vatAmount, vatEnabled } = computeLines(order);
    if (!vatEnabled || !String(s.vatNumber || '').trim() || order.status === 'quote') return '';
    try { await loadScript(QR_URL); } catch (_) { return ''; }
    if (!window.qrcode) return '';
    const payload = zatcaTlv([
      s.shopName || 'أصالة نجد', String(s.vatNumber).trim(),
      new Date(order.createdAt || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      total.toFixed(2), vatAmount.toFixed(2),
    ]);
    const qr = window.qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    return qr.createDataURL(6, 2);
  }

  /* ---------- قنوات التواصل في مستند العميل ----------
     نفس مصادر صفحة العميل وPDF العميل تماماً (settings) — لا بيانات
     مكررة ولا روابط مختلفة: واتساب والجوال وإنستقرام وتيك توك وسناب شات
     والموقع، كل ما هو مضبوط منها يظهر. تُبنى البطاقات بنفس شكل PDF العميل
     (أيقونة + QR + رابط) وبنفس أصناف CSS الجاهزة (.inv-contact/.inv-chans).
     ملاحظة صريحة: PDF الموظف صورة مُدمجة واحدة (html2canvas + addImage)
     فتُضاف الروابط الحقيقية فوق الصورة عبر addPdfLinksToDoc — أما الوسم <a>
     فيبقى ليعمل في مسار الطباعة. */
  const SOCIAL_CHANS = [
    { key: 'instagram', label: 'إنستقرام', cls: 'in', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2"/></svg>' },
    { key: 'tiktok', label: 'تيك توك', cls: 'tt', icon: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>' },
    { key: 'snapchat', label: 'سناب شات', cls: 'sn', icon: '<svg viewBox="0 0 24 24"><path d="M12 2.5c-3.6 0-5.5 2.3-5.5 5.4v1.9c-1.2.5-2 1.6-2 2.7l1.7.5c-.4 1-.4 1.9.3 2.6l-1.5.9c-.3.2-.3.7.1.8l2.1.5c.5 1.2 1.4 2.2 2.4 2.6.6.3 1.2.4 1.9.5v.6h1v-.6c.7-.1 1.3-.2 1.9-.5 1-.4 1.9-1.4 2.4-2.6l2.1-.5c.4-.1.4-.6.1-.8l-1.5-.9c.7-.7.7-1.6.3-2.6l1.7-.5c0-1.1-.8-2.2-2-2.7V7.9c0-3.1-1.9-5.4-5.5-5.4z"/></svg>' },
    { key: 'mapsUrl', label: 'الموقع', cls: 'map', icon: '<svg viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>' },
  ];
  const WA_ICON = '<svg viewBox="0 0 24 24"><path d="M20.5 11.7a8.4 8.4 0 0 1-12.4 7.4L3 20.6l1.6-4.9A8.4 8.4 0 1 1 20.5 11.7z"/></svg>';
  const TEL_ICON = '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>';
  /* رابط اجتماعي صالح للعرض والترميز: https فقط بلا فراغات، ونرفض القيم
     التجريبية (example/localhost/test) حتى لا يظهر رمز لا يعمل. */
  function validSocialUrl(v) {
    const u = String(v || '').trim();
    if (!/^https:\/\//i.test(u) || /[\s<>"]/.test(u)) return '';
    if (/example\.com|localhost|127\.0\.0\.1|\/test(\/|$)/i.test(u)) return '';
    return u;
  }
  /* عرض الرقم بالصيغة الدولية نفسها في PDF العميل: +966 54 995 5622 للسعودي،
     وإلا +الأرقام كما هي (بعد إسقاط 00 والأصفار المحلية الزائدة عبر waPhone). */
  function fmtIntl(d) {
    const m = /^(966)(5\d)(\d{3})(\d{4})$/.exec(d || '');
    return m ? '+' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] : (d ? '+' + d : '');
  }
  function shopSocialList(s) {
    s = s || {};
    const out = [];
    const push = (e) => { if (e.url && !out.some((o) => o.url === e.url)) out.push(e); };
    // اتصال مباشر أولاً (واتساب مطبّع عند الحفظ، ثم الجوال)، ثم الحسابات، ثم الموقع
    const waUrl = validSocialUrl(s.whatsapp);
    if (waUrl) push({ key: 'wa', label: 'واتساب', cls: 'wa', icon: WA_ICON, url: waUrl, text: waUrl.replace(/^https:\/\/wa\.me\//i, '+') });
    // الجوال يُطبَّع بنفس منطق العميل الموثوق (waPhone): لا رمز مكرر ولا صفر محلي
    // داخل tel:. القصير جداً (<7 أرقام) يُرفض كما كان.
    const telNorm = waPhone(s.phone || '');
    if (telNorm && telNorm.length >= 7) push({ key: 'tel', label: 'اتصال', cls: 'tel', icon: TEL_ICON, url: 'tel:+' + telNorm, text: fmtIntl(telNorm) });
    for (const a of SOCIAL_CHANS) {
      const url = validSocialUrl(s[a.key]);
      if (url) push({ key: a.key, label: a.label, cls: a.cls, icon: a.icon, url });
    }
    return out;
  }
  function shopSocialHtml(list) {
    if (!list || !list.length) return '';
    return `<div class="inv-bottom"><div class="inv-contact"><b>تواصل معنا</b>`
      + `<div class="inv-chans-hint">امسح رمز QR أو اضغط عليها لفتح الحساب مباشرة</div>`
      + `<div class="inv-chans">${list.map((a) => `
        <a class="inv-chan" href="${esc(a.url)}" data-url="${esc(a.url)}" target="_blank" rel="noopener">`
        + `<span class="inv-chan-ic ${a.cls}">${a.icon}</span>`
        + `<span class="inv-chan-lb">${esc(a.label)}</span>`
        + (a.img ? `<img class="inv-chan-qr" src="${a.img}" alt="رمز ${esc(a.label)}">` : '')
        + `<span class="inv-chan-url">${esc(a.text || a.url.replace(/^https?:\/\//i, ''))}</span></a>`).join('')}</div></div></div>`;
  }
  /* رموز QR للحسابات المضبوطة فقط — بنفس مكتبة رمز الفاتورة الضريبية
     (qrcode-generator) وبحدّ أبيض هادئ حول الرمز ليسهل مسحه. */
  async function socialQrList() {
    const list = shopSocialList(settings());
    if (!list.length) return '';
    try { await loadScript(QR_URL); } catch (_) { /* بلا مكتبة: نص وروابط فقط */ }
    for (const a of list) {
      a.img = '';
      if (window.qrcode) {
        try {
          const qr = window.qrcode(0, 'M');
          qr.addData(a.url);
          qr.make();
          a.img = qr.createDataURL(4, 2);
        } catch (_) { a.img = ''; }
      }
    }
    return shopSocialHtml(list);
  }

  /* شريط التواصل في ورقة التصميم: نفس بنية صفحة العميل حرفياً
     (portal.js designContactHtml) — بطاقات div تحمل data-url + ملاحظة
     «احتفظ برقم التصميم» — حتى تتطابقت أبعاد الشريط ومواضع روابط QR
     في ورقتَي العميل والموظف في كل PDF، مع ترتيب قنوات العميل نفسه. */
  /** note: سطر الختام بجانب القنوات (افتراضياً تذكير رقم التصميم في ورقة التصميم).
      inline: يُكتب السطر تحت الإرشاد بدل عمود مستقل (أمر الشراء أضيق من ورقة العميل،
      فتأخذ القنوات العرض كاملاً ولا تتراكب أسماؤها مع رموز QR) */
  async function sheetFootHtml(note = 'احتفظ برقم التصميم لمراجعته مع المحل', inline = false) {
    const list = shopSocialList(settings());
    if (!list.length) return '';
    const ORDER = { wa: 0, instagram: 1, tiktok: 2, snapchat: 3, mapsUrl: 4, tel: 5 };
    list.sort((a, b) => (ORDER[a.key] ?? 9) - (ORDER[b.key] ?? 9));
    try { await loadScript(QR_URL); } catch (_) { /* بلا مكتبة: بطاقات بلا باركود */ }
    let cards = '';
    for (const a of list) {
      let img = '';
      if (window.qrcode) {
        try {
          const qr = window.qrcode(0, 'M');
          qr.addData(a.url);
          qr.make();
          img = qr.createDataURL(4, 2);
        } catch (_) { img = ''; }
      }
      cards += `<div class="inv-chan" data-url="${esc(a.url)}">`
        + `<span class="inv-chan-ic ${a.cls}">${a.icon}</span>`
        + `<span class="inv-chan-lb">${esc(a.label)}</span>`
        + (img ? `<img class="inv-chan-qr" src="${img}" alt="">` : '')
        + `<span class="inv-chan-url">${esc(a.text || a.url.replace(/^https?:\/\//i, ''))}</span></div>`;
    }
    const s = settings();
    return `<div class="inv-contact"><b>تواصل معنا</b>`
      + `<div class="inv-chans-hint">امسح رمز QR أو اضغط عليها لفتح الحساب مباشرة${inline && note ? `<span class="inv-chans-note">${esc(note)}</span>` : ''}</div>`
      + `<div class="inv-chans">${cards}</div></div>`
      + (inline ? '' : `<div class="ds-foot-note"><b>${esc(s.shopName || 'أصالة نجد')}</b>`
      + `${esc(note)}</div>`);
  }

/** عنوان المستند حسب حالة الطلب والضريبة.
    «فاتورة ضريبية مبسطة» مستند ضريبي نظامي برمز QR الضريبي — لا نغيّر مسمّاه.
    أما مستند الطلب نفسه فاسمه «أمر شراء». */
function docTitle(order) {
  if (order.status === 'quote') return 'عرض سعر';
  const s = settings();
  return computeLines(order).vatEnabled && String(s.vatNumber || '').trim() ? 'فاتورة ضريبية مبسطة' : 'أمر شراء';
}

  const INV_MARK = '<div class="mark"><svg viewBox="0 0 24 24"><path d="M6 11V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4"/><path d="M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5H3z"/><path d="M5 18v2M19 18v2M3 15h18"/></svg></div>';
  function invHead(title, no) {
    const s = settings();
    return `
      <div class="inv-head">
        <div class="inv-brand">
          ${INV_MARK}
          <div><h1>${esc(s.shopName || 'أصالة نجد')}</h1><small>${esc([s.phone, s.address].filter(Boolean).join(' • ')) || '&nbsp;'}${s.vatNumber ? ` • الرقم الضريبي: <bdi class="num">${esc(s.vatNumber)}</bdi>` : ''}</small></div>
        </div>
        <div class="inv-title-box"><div class="inv-title">${esc(title)}</div><div class="inv-no">${esc(no)}</div></div>
      </div>`;
  }
  function designImage(order, W = 1800) {
    printDesigner.setState(order.design);
    const aspect = printDesigner.aspect();
    const H = Math.round(Math.min(1500, Math.max(650, W / aspect)));
    return printDesigner.toImage(W, H);
  }
  const orderEmployee = (order) => order.createdByName || (Store.getUser(order.createdBy) || {}).name || (currentUser && currentUser.name) || '';

  /* ---------- مخطط المستند: صورة + جدول أثاث من ورقة التصميم المشتركة ----------
     docPlan يحمل صورة آخر مستند مبني (أبعادها بالبكسل) حتى يضبط layoutDoc
     مقاسها على صندوقها الفعلي بعد اختيار الورقة — بنسبتها نفسها بلا تشويه. */
  let docPlan = null;
  /* حاشية القياسات («جميع القياسات بالسنتيمتر…») تُكتب في صندوق الملاحظات بجانب الإجماليات
     (فيه متّسع) بدل أسفل المخطط — فيكبر المخطط في الصفحة الواحدة */
  let docNote = '';
  function sheetPlan(order) {
    if (!window.DesignSheet || !order.design) return null;
    try { return DesignSheet.plan(order.design, { getItem, pieceStyle: (typeof pieceStyle === 'function' ? pieceStyle : undefined) }, 2800); }
    catch (_) { return null; }
  }
  function designSection(order, title, extraSide = '') {
    const pl = sheetPlan(order);
    docPlan = pl;
    docNote = '';
    if (!window.DesignSheet) return extraSide;
    const f = DesignSheet.facts(order.design, { getItem, pieceStyle: (typeof pieceStyle === 'function' ? pieceStyle : undefined) });
    docNote = f.note || '';
    return `
      <section class="inv-dsec" aria-label="${esc(title)}">
        <div class="inv-dgrid">
          <div class="inv-dmain">
            <div class="ds-plan inv-dplan">${DesignSheet.planHtml(pl)}</div>
            <div class="inv-dmeta"><div class="inv-dleg">${DesignSheet.legendHtml(f, true)}</div></div>
          </div>
          <aside class="inv-dside">${DesignSheet.sideHtml(f, 1)}${extraSide}</aside>
        </div>
      </section>`;
  }

  /** أمر شراء العميل (أو عرض السعر): صفحة واحدة دائماً — المقاس يُختار في layoutDoc */
  function buildPrintDoc(order, qrSrc = '', socialHtml = '') {
    const { lines, total, subtotal, vatEnabled, vatRate, vatAmount, discount } = computeLines(order);
    const paid = paidOf(order);
    const s = settings();
    const cur$ = esc(currency());
    const emp = orderEmployee(order);
    const c = order.customer || {};
    const atts = filledAttachments(order);
    const quote = order.status === 'quote';
    /* المرفقات في العمود الأيسر تحت ملخص المساحات: كل صورة بعرض العمود كاملاً
       (أكبر من صفّ الصور الصغيرة أسفل التصميم) واسمها تحتها يلتف ولا يُقصّ */
    const attsHtml = atts.length ? `<div class="inv-atts"><h3>المرفقات</h3>${atts.map((a, i) => `
          <figure><div class="imgbox"><img src="${a.src}" alt="مرفق ${i + 1}"></div><figcaption dir="auto">${(window.DesignSheet && DesignSheet.mixed ? DesignSheet.mixed(a.name) : esc(a.name)) || `مرفق ${i + 1}`}</figcaption></figure>`).join('')}</div>` : '';
    const nPays = (order.payments || []).filter((p) => money(p.amount) > 0).length;
    /* تفصيل الدفعات تحت «المدفوع»: طريقة كل دفعة وتاريخها ومبلغها (الاسترداد بإشارة سالبة)،
       فلا يُحتاج الرجوع إلى التطبيق لمعرفة كيف دُفع الطلب */
    const payList = quote ? [] : (Array.isArray(order.payments) ? order.payments : []).filter((p) => p && Math.abs(money(p.amount)) > 0.004);
    const payRows = payList.map((p) => {
      const amt = money(p.amount);
      const how = esc(PAY_METHODS[p.method] || p.method || 'غير محدد');
      const when = p.at ? ` <bdi class="num">${esc(fmtDate(p.at))}</bdi>` : '';
      return `<div class="pay"><span>${amt < 0 ? 'استرداد • ' : ''}${how}${when}</span><span class="num">${amt < 0 ? '- ' : ''}${fmt(Math.abs(amt))} ${cur$}</span></div>`;
    }).join('');
    const notes = String(order.notes || '').trim();
    // النص المختلط (عربي + إنجليزي بأقواس) يُعزل اتجاهياً فلا تنقلب الأقواس عند الالتفاف
    const mx = (v) => (window.DesignSheet && DesignSheet.mixed ? DesignSheet.mixed(v) : esc(v));
    return `
    <div class="inv inv-order">
      ${invHead(docTitle(order), order.number ? '#' + order.number : 'مسودة')}
      <div class="inv-info">
        <div class="span2"><span>العميل</span><b dir="auto">${mx(c.name) || '—'}</b></div>
        <div><span>الجوال</span><b class="num">${esc(c.phone) || '—'}</b></div>
        <div><span>${quote ? 'تاريخ العرض' : 'تاريخ الإصدار'}</span><b class="num">${fmtDate(order.createdAt || Store.now())}</b></div>
        <div class="span2"><span>مكان التوصيل</span><b dir="auto">${mx(c.address) || '—'}</b></div>
        ${quote
          ? `<div><span>العرض صالح حتى</span><b class="num">${order.validUntil ? esc(fmtDate(order.validUntil)) : '—'}</b></div>`
          : `<div><span>التوصيل المتوقع</span><b class="num">${order.deliveryDate ? esc(fmtDate(order.deliveryDate)) : 'غير محدد'}</b></div>`}
        <div><span>الموظف</span><b dir="auto">${mx(emp) || '—'}</b></div>
        <div><span>مقاس الغرفة (داخلي)</span><b>${roomSummary(order.design)}</b></div>
        <div><span>الحالة</span><b>${esc(quote ? 'عرض سعر' : (STATUS[order.status] || order.status || '—'))}</b></div>
        <div><span>طريقة القياس</span><b>${order.design.cornerMode === 'deduct' ? 'بدون تكرار الزوايا' : 'بطول الجدار كامل'}</b></div>
      </div>
      ${designSection(order, 'التصميم والمقاسات', attsHtml)}

      <section class="inv-items">
        <h2>التسعير</h2>
        <table>
          <thead><tr><th class="c-idx">#</th><th>الصنف</th><th class="c-unit">الوحدة</th><th class="c-qty">الكمية</th><th class="c-price">السعر (${cur$})</th><th class="c-total">الإجمالي (${cur$})</th></tr></thead>
          <tbody>${lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td dir="auto">${mx(l.name)}${l.sub ? ` <small>— ${mx(l.sub)}</small>` : ''}</td><td>${esc(l.unit)}</td><td class="num">${l.kind === 'sofa' ? fmtQty(l.qty) : esc(l.qty)}</td><td class="num">${fmt(l.price)}</td><td class="num">${fmt(l.total)}</td></tr>`).join('') || '<tr><td colspan="6">لا توجد أصناف</td></tr>'}</tbody>
        </table>
      </section>
      <div class="inv-bottom">
        <div class="inv-notes">
          <p><b>ملاحظات:</b> ${notes ? mx(notes).replace(/\n/g, '<br>') : '—'}</p>
          ${s.invoiceNote ? `<p><b>شروط:</b> ${mx(s.invoiceNote).replace(/\n/g, '<br>')}</p>` : ''}
          ${docNote ? `<p class="inv-mnote">${esc(docNote)}</p>` : ''}
        </div>
        ${qrSrc ? `<div class="inv-qr"><img src="${qrSrc}" alt="رمز الفاتورة الضريبية"><small>رمز الفاتورة الضريبية</small></div>` : ''}
        <div class="inv-totals">
          <div><span>المجموع قبل الخصم</span><span class="num">${fmt(subtotal)} ${cur$}</span></div>
          ${discount > 0.004 ? `<div><span>الخصم</span><span class="num">- ${fmt(discount)} ${cur$}</span></div>` : ''}
          ${vatEnabled ? `<div><span>ضريبة القيمة المضافة ${num(vatRate)}%</span><span class="num">${fmt(vatAmount)} ${cur$}</span></div>` : ''}
          <div class="total"><span>الإجمالي${vatEnabled ? ' شامل الضريبة' : ''}</span><span class="num">${fmt(total)} ${cur$}</span></div>
          ${quote ? '' : `<div><span>المدفوع${nPays > 1 ? ` (${nPays} دفعات)` : ''}</span><span class="num">${fmt(paid)} ${cur$}</span></div>
          ${payRows}
          <div class="rem"><span>المتبقي</span><span class="num">${fmt(remainingOf(total, paid))} ${cur$}</span></div>`}
        </div>
      </div>
      ${socialHtml ? `<div class="ds-foot inv-cfoot">${socialHtml}</div>` : ''}
      <div class="inv-foot">
        <div class="inv-sign"><i></i><span>توقيع العميل</span></div>
        <div class="inv-foot-mid"><p class="inv-foot-note">${quote ? 'هذا عرض سعر وليس أمر شراء' : 'أمر شراء معتمد بعد التوقيع'}</p></div>
        <div class="inv-sign"><i></i><span dir="auto">الموظف: ${mx(emp)}</span></div>
      </div>
    </div>`;
  }

  /** أمر التصنيع للورشة: المقاسات والمواصفات والقيود، بلا أي سعر */
  function buildWorkshopDoc(order) {
    const W = 2800;
    const img = designImage(order, W);
    const aspect = printDesigner.aspect();
    const H = Math.round(Math.min(1500, Math.max(650, W / aspect)));   // نفس حساب designImage
    docPlan = { img, W, H, relabel: (k) => { printDesigner.setState(order.design); return printDesigner.toImage(W, H, { labelScale: k }); } };
    const d = order.design || {};
    const pieces = d.pieces || [];
    const c = order.customer || {};
    const sofas = pieces.filter((p) => p.kind === 'sofa');
    // ذراعا كنب الزاوية يُكتبان متتاليين تحت رقم واحد: قطعة واحدة عند الورشة
    const seen = new Map();
    let unit = 0;
    const rows = sofas.map((p) => {
      let no;
      if (p.group) { if (!seen.has(p.group)) seen.set(p.group, ++unit); no = seen.get(p.group); } else no = ++unit;
      const wood = specName(p, 'wood'), fab = specName(p, 'fabric'), foam = specName(p, 'foam');
      const legacy = legacySofaItem(p);
      return `<tr><td>${no}</td><td>${p.group ? 'كنب زاوية' : 'كنب'}${legacy ? ` <small>(${esc(legacy.name)})</small>` : ''}</td><td>${p.wall != null ? 'جدار ' + (p.wall + 1) : 'حرة'}</td><td class="num">${Designer.util.round(p.w, 2)} × ${Designer.util.round(p.h, 2)}</td><td>${esc(wood || '—')}</td><td>${esc(fab || '—')}</td><td>${esc(foam || '—')}</td><td>${esc(p.note || '')}</td></tr>`;
    }).join('');
    const accs = {};
    pieces.filter((p) => p.kind === 'acc').forEach((p) => { accs[p.itemId] = (accs[p.itemId] || 0) + 1; });
    const accTxt = Object.entries(accs).map(([id, n]) => `${esc(getItem(id).name)} × ${n}`).join('، ');
    // المساحات الحرة قيد على الأرض لا قطعة تُصنَّع: تُكتب بمقاسها حتى تلتزم بها الورشة
    const freeTxt = pieces.filter((p) => p.kind === 'free')
      .map((p) => `${Designer.util.round(p.w, 2)} × ${Designer.util.round(p.h, 2)} م${p.note ? ` (${esc(p.note)})` : ''}`).join('، ');
    const manual = (order.manualRows || []).filter((r) => String(r.name || '').trim()).map((r) => `${esc(r.name)} (${esc(r.qty)} ${esc(r.unit || '')})`).join('، ');
    const meters = Designer.util.round(sofas.reduce((s, p) => s + num(p.w), 0), 2);
    const openings = (d.openings || []).map((o) => `${o.type === 'door' ? 'باب' : o.type === 'mashab' ? 'مشب' : o.type === 'tv' ? 'تلفاز' : 'شباك'} ${Designer.util.round(o.w, 2)} م على جدار ${o.wall + 1}`).join('، ');
    return `
    <div class="inv work">
      ${invHead('أمر تصنيع', order.number ? '#' + order.number : 'مسودة')}
      <div class="inv-info">
        <div><span>العميل</span><b>${esc(c.name) || '—'}</b></div>
        <div><span>تاريخ التوصيل المطلوب</span><b class="num">${order.deliveryDate ? esc(fmtDate(order.deliveryDate)) : 'غير محدد'}</b></div>
        <div><span>مقاس الغرفة (داخلي)</span><b>${roomSummary(d)}</b></div>
        <div><span>إجمالي أمتار الكنب</span><b class="num">${meters} م</b></div>
        <div class="span2"><span>مكان التوصيل</span><b>${esc(c.address) || '—'}</b></div>
        <div><span>الموظف</span><b>${esc(orderEmployee(order))}</b></div>
        <div><span>طريقة القياس</span><b>${d.cornerMode === 'deduct' ? 'بدون تكرار الزوايا' : 'بطول الجدار كامل'}</b></div>
      </div>
      <section class="inv-dsec"><h2>المخطط</h2><div class="ds-plan inv-dplan"><span class="ds-img"><img src="${img}" alt="المخطط"></span></div></section>
      <div class="inv-items">
        <h2>قطع الكنب</h2>
        <table>
          <thead><tr><th class="c-idx">#</th><th>القطعة</th><th>الموضع</th><th class="c-qty">الطول × العمق (م)</th><th>الخشب</th><th>القماش</th><th>الإسفنج</th><th>ملاحظة</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8">لا توجد قطع كنب</td></tr>'}</tbody>
        </table>
      </div>
      <div class="inv-bottom">
        <div class="inv-notes">
          ${accTxt ? `<b>الإكسسوارات:</b> ${accTxt}<br>` : ''}
          ${freeTxt ? `<b>مساحات حرة:</b> ${freeTxt}<br>` : ''}
          ${manual ? `<b>بنود إضافية:</b> ${manual}<br>` : ''}
          ${openings ? `<b>الأبواب والشبابيك:</b> ${esc(openings)}<br>` : ''}
          <b>ملاحظات:</b> ${order.notes ? esc(order.notes).replace(/\n/g, '<br>') : '—'}
        </div>
      </div>
      <div class="inv-foot">
        <div class="inv-sign"><i></i><span>استلام الورشة</span></div>
        <div>أُصدر ${fmtDateTime(Store.now())} • لا يحتوي هذا المستند على أسعار</div>
        <div class="inv-sign"><i></i><span>الموظف: ${esc(orderEmployee(order))}</span></div>
      </div>
    </div>`;
  }

  /** سند قبض (أو سند صرف للاسترداد) لدفعة واحدة */
  function buildReceiptDoc(order, p) {
    const refund = money(p.amount) < 0;
    const { total } = computeLines(order);
    const list = (order.payments || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const idx = list.findIndex((x) => x.id === p.id);
    const upTo = money(list.slice(0, idx + 1).reduce((s, x) => s + money(x.amount), 0));
    const cur$ = esc(currency());
    const c = order.customer || {};
    return `
    <div class="inv receipt">
      ${invHead(refund ? 'سند صرف' : 'سند قبض', `${order.number || ''}-${idx + 1}`)}
      <div class="rc-amount"><span>${refund ? 'المبلغ المصروف' : 'المبلغ المستلَم'}</span><b class="num">${fmt(Math.abs(money(p.amount)))} ${cur$}</b></div>
      <div class="inv-info">
        <div class="span2"><span>${refund ? 'صُرف إلى' : 'استلمنا من'}</span><b>${esc(c.name) || '—'}</b></div>
        <div><span>الجوال</span><b class="num">${esc(c.phone) || '—'}</b></div>
        <div><span>التاريخ</span><b class="num">${esc(fmtDate(p.at))}</b></div>
        <div><span>طريقة ${refund ? 'الصرف' : 'الدفع'}</span><b>${esc(PAY_METHODS[p.method] || p.method || '—')}</b></div>
        <div><span>عن الطلب</span><b class="num">#${esc(order.number || '')}</b></div>
        <div class="span2"><span>البيان</span><b>${esc(p.note) || (refund ? 'استرداد من قيمة الطلب' : 'دفعة من قيمة الطلب')}</b></div>
      </div>
      <div class="inv-totals rc-totals">
        <div><span>إجمالي الطلب</span><span class="num">${fmt(total)} ${cur$}</span></div>
        <div><span>المدفوع حتى هذا السند</span><span class="num">${fmt(upTo)} ${cur$}</span></div>
        <div class="rem"><span>المتبقي بعده</span><span class="num">${fmt(total - upTo)} ${cur$}</span></div>
      </div>
      <div class="inv-foot">
        <div class="inv-sign"><i></i><span>${refund ? 'توقيع المستلِم' : 'توقيع العميل'}</span></div>
        <div>${p.by ? `المستلِم: ${esc(p.by)}` : ''}</div>
        <div class="inv-sign"><i></i><span>الختم</span></div>
      </div>
    </div>`;
  }

  /* ---------- مقاس المستند: صفحة واحدة دائماً، بلا تصغير خطوط ----------
     الخطوط والمسافات ثابتة. يُقاس الارتفاع الطبيعي للمستند على عرض A4 (190مم)
     فإن جاوز ارتفاع الصفحة يُعاد على A3 ثم A2 (أعرض وأطول، فيتّسع المحتوى
     بحجمه نفسه)، وما بعد A2 مقاس مخصص بعرض A2 وارتفاع يكفي. بعدها يثبت
     ارتفاع الصفحة فيأخذ قسم التصميم ما بقي من المساحة (لا فراغ ميت).
     السند قصير بطبيعته: A4 بارتفاع محتواه. */
  const DOC_PAPERS = [
    { id: 'a4', label: 'A4', w: 210, h: 297 },
    { id: 'a3', label: 'A3', w: 297, h: 420 },
    { id: 'a2', label: 'A2', w: 420, h: 594 },
  ];
  const DOC_MARGIN = 10;
  function setPrintPage(p) {
    let st = document.getElementById('printPageSize');
    if (!st) { st = document.createElement('style'); st.id = 'printPageSize'; document.head.appendChild(st); }
    // الطباعة بالمقاس نفسه والهامش نفسه: صفحة واحدة متجهية (نص حقيقي) لا صورة
    st.textContent = `@media print { @page { size: ${p.w}mm ${p.h}mm; margin: ${DOC_MARGIN}mm; } }`;
  }
  function layoutDoc(area) {
    const inv = $('.inv', area);
    if (!inv) return null;
    const keep = area.style.cssText;
    area.style.cssText = 'display:block;position:fixed;top:0;left:-20000px;background:#fff';
    try {
      const receipt = inv.classList.contains('receipt');
      const natural = (p) => {
        const wMm = p.w - 2 * DOC_MARGIN;
        inv.style.width = wMm + 'mm';
        inv.style.height = 'auto';
        const k = inv.getBoundingClientRect().width / wMm;
        return k > 0 ? inv.scrollHeight / k : 0;
      };
      let paper = null, need = 0;
      for (const p of (receipt ? DOC_PAPERS.slice(0, 1) : DOC_PAPERS)) {
        need = natural(p);
        if (receipt || need <= p.h - 2 * DOC_MARGIN + 0.3) { paper = p; break; }
      }
      if (!paper) {
        const base = DOC_PAPERS[DOC_PAPERS.length - 1];
        const h = Math.ceil((need + 2 * DOC_MARGIN + 2) / 5) * 5;
        const LRI = String.fromCharCode(0x2066), PDI = String.fromCharCode(0x2069);   // الأبعاد لا تنقلب داخل الجملة العربية
        paper = { id: 'custom', label: `مقاس مخصص ${LRI}${base.w}×${h}${PDI} مم`, w: base.w, h };
        natural(paper);
      }
      inv.style.width = (paper.w - 2 * DOC_MARGIN) + 'mm';
      inv.style.height = receipt ? 'auto' : (paper.h - 2 * DOC_MARGIN) + 'mm';
      if (docPlan && window.DesignSheet && $('.inv-dplan', inv)) DesignSheet.fitPlan(inv, docPlan, paper.w - 2 * DOC_MARGIN);
      inv.__paper = paper;
      inv.dataset.paper = paper.id;
      setPrintPage(paper);
      return paper;
    } finally {
      area.style.cssText = keep;
    }
  }

  /** بناء المستند في منطقة الطباعة وانتظار الصور والخط، ثم اختيار مقاس الصفحة الواحدة */
  async function renderPrintArea(html) {
    const area = $('#printArea');
    area.innerHTML = html;
    // الخط يجب أن يكتمل قبل التصوير، وإلا رُسمت العربية بخط احتياطي في ملف PDF
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) { /* ignore */ } }
    // صورة التصميم والمرفقات معاً: html2canvas يرسم الفراغ إن صوّر قبل اكتمالها
    const imgs = $$('img', area).filter((im) => !im.complete);
    if (imgs.length) {
      await new Promise((res) => {
        let left = imgs.length, done = false;
        const fin = () => { if (!done) { done = true; res(); } };
        const one = () => { if (--left <= 0) fin(); };
        imgs.forEach((im) => { im.onload = one; im.onerror = one; });
        setTimeout(fin, 1500);
      });
    }
    return layoutDoc(area);
  }

  /* لا تُصدَّر أمر شراء من طلب غير محفوظ: الورقة التي تصل العميل يجب أن تطابق
     ما في النظام — مسودة بلا رقم أو تعديلات لم تصل الخادم تعني أمر شراء لا أثر لها. */
  function requireSavedOrder(order) {
    if (!order || !order.id) {
      toast('لا يمكن إصدار أمر الشراء قبل حفظ الطلب — اضغط «حفظ الطلب» أولاً', true);
      return false;
    }
    if (cur.id === order.id && dirty) {
      toast('توجد تعديلات غير محفوظة — احفظ الطلب أولاً ثم أصدر أمر الشراء', true);
      return false;
    }
    if (!order.number) {
      toast('الطلب محفوظ على هذا الجهاز ولم يصل الخادم بعد، فلا رقم له. تحقق من الاتصال ثم أعد المحاولة.', true);
      return false;
    }
    return true;
  }

  /** المستندات الممكنة لطلب: أمر شراء العميل وأمر التصنيع */
  const ORDER_DOCS = {
    // شريط التواصل نفسه في PDF العميل (أيقونة + الاسم + QR في صف واحد) — مطابق بصرياً للعميل
    invoice: { label: (o) => (o.status === 'quote' ? 'عرض السعر' : 'أمر شراء'), file: (o) => `${o.status === 'quote' ? 'عرض-سعر' : 'طلب'}-${o.number}.pdf`, build: async (o) => buildPrintDoc(o, await zatcaQr(o), await sheetFootHtml(`للاستفسار عن طلبك اذكر رقمه #${o.number}`, true)), share: true },
    workshop: { label: () => 'أمر التصنيع (بلا أسعار)', file: (o) => `أمر-تصنيع-${o.number}.pdf`, build: async (o) => buildWorkshopDoc(o), share: false },
  };

  /** المسار الأساسي: تجهيز المستند ثم عرض نافذة التصدير والمشاركة */
  async function shareOrder(order, kind = 'invoice') {
    if (!requireSavedOrder(order)) return;
    logActivity('export', order, [`${ORDER_DOCS[kind].label(order)}`, `الإجمالي ${fmt(order.total)}`]);
    Store.save();
    docModal(order, kind);
  }

  /** سند القبض يُصدر من دفعة محفوظة فقط */
  function printReceipt(order, p) {
    if (!requireSavedOrder(order)) return;
    if (!(order.payments || []).some((x) => x.id === p.id)) return;
    docModal(order, 'receipt', p);
  }

  /* ---------------- تصدير PDF ومشاركته مع العميل ---------------- */
  const H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  function loadScript(src) {
    return new Promise((res, rej) => {
      const had = document.querySelector(`script[data-lib="${src}"]`);
      if (had) { if (had.dataset.ok) return res(); had.addEventListener('load', () => res()); had.addEventListener('error', () => rej(new Error('تعذّر تحميل مكتبة إنشاء PDF. تحقق من الاتصال بالإنترنت.'))); return; }
      const s = document.createElement('script');
      s.src = src; s.dataset.lib = src;
      s.onload = () => { s.dataset.ok = '1'; res(); };
      s.onerror = () => { s.remove(); rej(new Error('تعذّر تحميل مكتبة إنشاء PDF. تحقق من الاتصال بالإنترنت.')); };
      document.head.appendChild(s);
    });
  }

  /** تحويل مواضع العناصر (data-url) إلى ملليمترات على صفحة PDF وإضافتها
      كروابط قابلة للنقر — لأن الصفحة صورة مدمجة (html2canvas) تفقد الروابط
      لولا ذلك. نفس آلية PDF العميل المجرّبة. */
  function addPdfLinksToDoc(pdf, inv, x0, y0, wMm, hMm) {
    let base = null;
    try { base = inv.getBoundingClientRect(); } catch (_) { return 0; }
    if (!base || !base.width || !base.height) return 0;
    const kx = wMm / base.width, ky = hMm / base.height;
    const nodes = inv.querySelectorAll('[data-url]');
    let n = 0;
    for (let i = 0; i < nodes.length; i++) {
      const url = nodes[i].getAttribute('data-url');
      if (!url) continue;
      let r = null;
      try { r = nodes[i].getBoundingClientRect(); } catch (_) { continue; }
      if (!r || !r.width || !r.height) continue;
      const x = x0 + (r.left - base.left) * kx;
      const y = y0 + (r.top - base.top) * ky;
      const w = r.width * kx, hh = r.height * ky;
      if (x < x0 - 0.5 || x + w > x0 + wMm + 0.5 || y < y0 - 0.5 || y + hh > y0 + hMm + 0.5) continue;
      try { pdf.link(x, y, w, hh, { url }); n++; } catch (_) { /* noop */ }
    }
    return n;
  }

  /** تحويل المستند إلى ملف PDF من صفحة واحدة بالضبط، بمقاس الورقة التي اختارها
      layoutDoc (A4/A3/A2/مخصص). الصفحة تُصوَّر بدقة ~300 نقطة/بوصة (نفس مقياس ورقة
      التصميم) فتبقى حادة عند التكبير، والروابط حقيقية فوق الصورة. التصميم وجدول
      الأثاث جزء من الصفحة نفسها — لا صفحة ثانية. */
  async function makePdfBlob(order) {
    await loadScript(H2C_URL);
    await loadScript(JSPDF_URL);
    const area = $('#printArea');
    const inv = $('.inv', area);
    if (!inv) throw new Error('تعذّر تجهيز المستند');
    area.style.cssText = 'display:block;position:fixed;top:0;left:-20000px;background:#fff;z-index:-1';
    try {
      const paper = inv.__paper || layoutDoc(area) || DOC_PAPERS[0];
      const scale = window.DesignSheet && DesignSheet.shotScale ? DesignSheet.shotScale(inv) : 3;
      const canvas = await window.html2canvas(inv, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const img = canvas.toDataURL('image/jpeg', 0.95);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: [paper.w, paper.h], orientation: paper.w > paper.h ? 'landscape' : 'portrait' });
      const wMm = paper.w - 2 * DOC_MARGIN;
      const hMm = Math.min(paper.h - 2 * DOC_MARGIN, wMm * (canvas.height / canvas.width));
      pdf.addImage(img, 'JPEG', DOC_MARGIN, DOC_MARGIN, wMm, hMm, undefined, 'FAST');
      addPdfLinksToDoc(pdf, inv, DOC_MARGIN, DOC_MARGIN, wMm, hMm);
      return pdf.output('blob');
    } finally {
      area.style.cssText = '';
    }
  }

  function browserDownload(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  /** تنزيل/حفظ ملف: في تطبيق أندرويد يُحفظ عبر Filesystem (WebView لا يدعم a.download) */
  function downloadBlob(blob, name) {
    const P = (window.Capacitor && window.Capacitor.Plugins) || {};
    if (P.Filesystem) {
      blobToBase64(blob)
        .then((data) => P.Filesystem.writeFile({ path: name, data, directory: 'DOCUMENTS', recursive: true }))
        .then(() => toast(`حُفظ ${name} في مستندات الجهاز`))
        .catch(() => browserDownload(blob, name));
      return;
    }
    browserDownload(blob, name);
  }

  /** توحيد رقم الجوال السعودي إلى صيغة 9665xxxxxxxx */
  function waPhone(raw) {
    let d = latinDigits(raw).replace(/[^\d+]/g, '').replace(/^\+/, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('966')) return d;
    if (d.startsWith('0')) return '966' + d.slice(1);
    if (/^5\d{8}$/.test(d)) return '966' + d;
    return d;
  }

  /** رسالة مرافقة قصيرة تُرسل مع الملف */
  function waCaption(order, kind = 'invoice', p = null) {
    const { total } = computeLines(order);
    const paid = paidOf(order);
    const s = settings();
    const cu = currency();
    const L = [`*${s.shopName || 'أصالة نجد'}*`];
    if (kind === 'receipt' && p) {
      L.push(`${money(p.amount) < 0 ? 'سند صرف' : 'سند قبض'} للطلب *#${order.number}*`);
      L.push(`المبلغ: ${fmt(Math.abs(money(p.amount)))} ${cu} • المتبقي: ${fmt(total - paid)} ${cu}`);
      return L.join('\n');
    }
    if (kind === 'workshop') {
      // للورشة: بلا أي مبلغ — رقم الطلب والعميل وموعد التوصيل فقط، والتفاصيل في الملف
      L.push(`أمر تصنيع للطلب *#${order.number}*`);
      if (order.customer && order.customer.name) L.push(`العميل: ${order.customer.name}`);
      if (order.deliveryDate) L.push(`تاريخ التوصيل المطلوب: ${fmtDate(order.deliveryDate)}`);
      L.push('المخطط والمقاسات والمواصفات في الملف المرفق.');
      return L.join('\n');
    }
    L.push(order.status === 'quote' ? `عرض سعر رقم *#${order.number}*` : `أمر الشراء رقم *#${order.number}*`);
    L.push(order.status === 'quote' ? `الإجمالي: ${fmt(total)} ${cu}` : `الإجمالي: ${fmt(total)} ${cu} • المتبقي: ${fmt(total - paid)} ${cu}`);
    if (order.status === 'quote' && order.validUntil) L.push(`العرض صالح حتى: ${fmtDate(order.validUntil)}`);
    else if (order.deliveryDate) L.push(`موعد التوصيل المتوقع: ${fmtDate(order.deliveryDate)}`);
    return L.join('\n');
  }


  /** فتح رابط خارجي: في تطبيق أندرويد يُفتح بالمتصفح الخارجي (وإلا window.open لا يعمل) */
  function openExternal(url) {
    // بوابة مركزية: لا يُفتح أي رابط خارجي غير https صالح
    if (!safeExternalUrl(url)) { toast('رابط غير صالح', true); return; }
    if (window.Capacitor) { window.open(url, '_system'); return; }
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /** فتح محادثة العميل على واتساب (بدون ملف: المتصفح لا يسمح بإرفاقه لرقم محدد) */
  function openCustomerChat(order, kind, p) {
    const ph = waPhone(order.customer && order.customer.phone);
    openExternal(`https://wa.me/${ph}?text=${encodeURIComponent(waCaption(order, kind, p))}`);
  }

  /** تحويل blob إلى base64 */
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('تعذّر قراءة الملف'));
      r.readAsDataURL(blob);
    });
  }

  /** مشاركة أصلية داخل تطبيق أندرويد (Capacitor Share): تحفظ الملف وترسله عبر قائمة المشاركة مع النص */
  async function sharePdfNative(blob, fileName, text) {
    const P = (window.Capacitor && window.Capacitor.Plugins) || {};
    if (!P.Filesystem || !P.Share) return false;
    try {
      const data = await blobToBase64(blob);
      const w = await P.Filesystem.writeFile({ path: fileName, data, directory: 'CACHE' });
      await P.Share.share({ title: fileName, text, files: [w.uri] });
      return true;
    } catch (_) { return false; }
  }

  /** حفظ أصلي لملف PDF على الجهاز داخل تطبيق أندرويد (WebView لا يدعم تنزيل <a download>) */
  async function savePdfNative(blob, fileName) {
    const P = (window.Capacitor && window.Capacitor.Plugins) || {};
    if (!P.Filesystem) return false;
    try {
      const data = await blobToBase64(blob);
      await P.Filesystem.writeFile({ path: fileName, data, directory: 'DOCUMENTS', recursive: true });
      return true;
    } catch (_) { return false; }
  }

  /** نافذة التصدير والمشاركة لأي مستند: أمر شراء، أمر تصنيع، سند */
  // keepPrintArea معرّف أعلى الملف (يقرؤه closeModal)
  function docModal(order, kind, payment = null) {
    const rawPhone = (order.customer && order.customer.phone) || '';
    const phone = waPhone(rawPhone);
    const cname = (order.customer && order.customer.name) || '';
    const isReceipt = kind === 'receipt';
    let curKind = kind;
    let run = 0;   // تبديل المستند أثناء تجهيز سابقه: تُهمل النتيجة القديمة

    const title = isReceipt ? `${money(payment.amount) < 0 ? 'سند صرف' : 'سند قبض'} — الطلب #${order.number}` : `تصدير ومشاركة ${order.status === 'quote' ? 'عرض السعر' : 'الطلب'} #${order.number}`;
    openModal(title, `
      <div class="share-target">
        <span class="share-avatar">${icon('user')}</span>
        <div>
          <b>${esc(cname) || 'بدون اسم عميل'}</b>
          <small class="${rawPhone ? 'num' : 'warn-text'}">${esc(rawPhone) || 'لا يوجد رقم جوال مسجّل'}</small>
        </div>
      </div>
      ${isReceipt ? '' : `<div class="segmented doc-switch" role="group" aria-label="نوع المستند">
        ${Object.entries(ORDER_DOCS).map(([k, d]) => `<button type="button" data-doc="${k}" class="${k === kind ? 'active' : ''}" aria-pressed="${k === kind}"><b>${k === 'workshop' ? 'للورشة' : 'للعميل'}</b><small>${k === 'workshop' ? 'أمر تصنيع بلا أسعار' : esc(d.label(order)) + ' بالأسعار والدفعات'}</small></button>`).join('')}
      </div>`}
      <p id="pdfState" class="pdf-state" role="status">${icon('clock')}<span class="pdf-state-txt">جاري تجهيز ملف PDF…</span></p>
      <div class="share-actions">
        <button class="btn primary block lg" id="shWa" disabled>${icon('whatsapp')} مشاركة الملف عبر واتساب</button>
        ${phone ? `<button class="btn block" id="shChat">${icon('whatsapp')} فتح محادثة ${esc(cname || 'العميل')} (بالملخص)</button>` : ''}
        <button class="btn block" id="shSave" disabled>${icon('download')} حفظ الملف على الجهاز</button>
        <button class="btn block ghost" id="shPrint" disabled>${icon('print')} طباعة</button>
      </div>
      <p class="hint" id="shNote"></p>`, (b) => {

      const state = $('#pdfState', b);
      const btnWa = $('#shWa', b), btnSave = $('#shSave', b), btnPrint = $('#shPrint', b);
      // الطباعة لا تعمل داخل تطبيق أندرويد (WebView): يُخفى الزرّ ويُستعاض عنه بالحفظ/المشاركة
      if (window.Capacitor) btnPrint.hidden = true;
      const note = $('#shNote', b);
      const defaultNote = () => (curKind === 'workshop'
        ? 'ملف PDF للورشة فيه المخطط والمقاسات والمواصفات بلا أي سعر. اضغط «مشاركة ملف الورشة» واختر محادثة الورشة — لا تُرسله للعميل.'
        : `واتساب لا يسمح للمتصفح بإرفاق ملف برقم محدد تلقائياً، لذلك ستظهر قائمة المشاركة لتختار محادثة ${cname || 'العميل'} منها.`);

      btnPrint.onclick = () => { keepPrintArea = true; closeModal(); setTimeout(() => window.print(), 60); };
      if ($('#shChat', b)) $('#shChat', b).onclick = () => openCustomerChat(order, curKind, payment);

      async function prepare() {
        // إنشاء PDF يحتاج مكتبات من الإنترنت: رسالة واضحة مبكراً بدل خطأ تقني لاحق
        if (!navigator.onLine) {
          state.className = 'pdf-state err';
          state.innerHTML = `${icon('alert')}<span class="pdf-state-txt">تصدير PDF يحتاج اتصالًا بالإنترنت.</span>`;
          note.textContent = 'تحقق من الاتصال ثم أعد فتح النافذة.';
          return;
        }
        const my = ++run;
        const fileName = isReceipt ? `${money(payment.amount) < 0 ? 'سند-صرف' : 'سند-قبض'}-${order.number}.pdf` : ORDER_DOCS[curKind].file(order);
        btnWa.disabled = btnSave.disabled = btnPrint.disabled = true;
        state.className = 'pdf-state';
        state.innerHTML = `${icon('clock')}<span class="pdf-state-txt">جاري تجهيز ملف PDF…</span>`;
        note.textContent = defaultNote();
        // ملف الورشة يُشارَك ملفاً (للورشة) لكن لا تُفتح محادثة العميل أبداً
        const forCustomer = isReceipt || ORDER_DOCS[curKind].share;
        btnWa.hidden = false;
        btnWa.innerHTML = forCustomer ? `${icon('whatsapp')} مشاركة الملف عبر واتساب` : `${icon('upload')} مشاركة ملف الورشة (واتساب أو غيره)`;
        btnWa.classList.toggle('is-work', !forCustomer);
        if ($('#shChat', b)) $('#shChat', b).hidden = !forCustomer;
        try {
          const html = isReceipt ? buildReceiptDoc(order, payment) : await ORDER_DOCS[curKind].build(order);
          if (my !== run) return;
          const paper = await renderPrintArea(html);
          if (my !== run) return;
          btnPrint.disabled = false;
          const blob = await makePdfBlob(order);
          if (my !== run) return;
          const kb = Math.round(blob.size / 1024);
          const pdfFile = new File([blob], fileName, { type: 'application/pdf' });
          state.className = 'pdf-state ready';
          // نص الحالة في حاوية واحدة تلتف: في flex كان كل جزء (النص والاسم والمقاس) عموداً مستقلاً فيتّسع الإطار ويقصّ الأزرار
          state.innerHTML = `${icon('check')}<span class="pdf-state-txt">الملف جاهز: <bdi dir="ltr"><b>${esc(fileName)}</b></bdi> (${kb} كيلوبايت) · صفحة واحدة <bdi>${esc((paper && paper.label) || 'A4')}</bdi></span>`;
          if (paper && paper.id !== 'a4') note.innerHTML = `${esc(defaultNote())}<br>${icon('alert')} المحتوى أكبر من A4 فاختير مقاس <bdi>${esc(paper.label)}</bdi> ليبقى النص بحجمه الطبيعي. للطباعة على ورق A4 اختر «ملاءمة للصفحة» (Fit to page) في نافذة الطباعة.`;
          btnWa.disabled = false; btnSave.disabled = false;
          btnSave.onclick = async () => {
            if (await savePdfNative(blob, fileName)) { toast(`تم حفظ ${fileName} في مستندات الجهاز`); return; }
            downloadBlob(blob, fileName);
          };
          const caption = waCaption(order, curKind, payment);
          const sendViaWhatsapp = async () => {
            // 1) مشاركة أصلية داخل تطبيق أندرويد: ترسل ملف PDF فعلاً مع الملخص
            if (await sharePdfNative(blob, fileName, caption)) { closeModal(); toast('تمت المشاركة'); return; }
            // 2) متصفح يدعم مشاركة الملفات
            if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
              navigator.share({ files: [pdfFile], title: fileName, text: caption })
                .then(() => { closeModal(); toast('تمت المشاركة'); })
                .catch((e) => { if (e && e.name !== 'AbortError') toast('تعذّرت المشاركة: ' + e.message, true); });
              return;
            }
            // 3) متصفح لا يدعم مشاركة الملفات: يُحفظ الملف (وتُفتح محادثة العميل لمستند العميل فقط — لا للورشة)
            downloadBlob(blob, fileName);
            if (phone && forCustomer) openCustomerChat(order, curKind, payment);
            note.innerHTML = forCustomer
              ? `هذا المتصفح لا يدعم إرسال الملف مباشرة. حُفظ <b>${esc(fileName)}</b> في مجلد التنزيلات، أرفقه في محادثة ${esc(cname || 'العميل')}.`
              : `هذا المتصفح لا يدعم إرسال الملف مباشرة. حُفظ <b>${esc(fileName)}</b> في مجلد التنزيلات، أرفقه في محادثة الورشة.`;
          };
          btnWa.onclick = sendViaWhatsapp;
          const btnChat = $('#shChat', b);
          if (btnChat) btnChat.onclick = sendViaWhatsapp;
        } catch (err) {
          if (my !== run) return;
          state.className = 'pdf-state err';
          state.innerHTML = `${icon('alert')}<span class="pdf-state-txt">${esc(err.message)}</span>`;
          note.textContent = 'يمكنك استخدام زر الطباعة ثم اختيار "حفظ كـ PDF".';
          btnPrint.disabled = !$('#printArea').innerHTML.trim();
        }
      }
      $$('[data-doc]', b).forEach((btn) => btn.addEventListener('click', () => {
        if (btn.dataset.doc === curKind) return;
        curKind = btn.dataset.doc;
        $$('[data-doc]', b).forEach((x) => { const on = x === btn; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
        prepare();
      }));
      // التجهيز يبدأ فوراً حتى تكون المشاركة استجابة مباشرة لنقرة المستخدم
      prepare();
    });
  }

  window.addEventListener('afterprint', () => { keepPrintArea = false; $('#printArea').innerHTML = ''; });

  async function exportCurrent(kind = 'invoice') {
    cur.design = designer.getState();
    // الحفظ قرار المستخدم لا خطوة صامتة: نوقف التصدير ونوجّهه إلى زر الحفظ
    if (!requireSavedOrder(cur)) {
      const sv = $('#btnSaveOrder');
      if (sv && !sv.hidden) sv.focus();
      return;
    }
    await shareOrder(cur, ORDER_DOCS[kind] ? kind : 'invoice');
  }
  $('#btnExportPdf').addEventListener('click', () => exportCurrent());
  $('#btnExportPdfTop').addEventListener('click', () => exportCurrent());
  // بطاقتا المستند في مرحلة التصدير: تفتح نافذة المشاركة على المستند المختار مباشرة
  $$('[data-doc-kind]').forEach((b) => b.addEventListener('click', () => exportCurrent(b.dataset.docKind)));

  /* ---------------- صفحة الطلبات ---------------- */
  /** الحالات المختارة في الفلتر؛ فارغة = كل الحالات */
  const ordStatuses = new Set();
  let ordOverOnly = false;   // فلتر «مدفوع زائد»
  /* أقسام صفحة الطلبات (تبويبات): كل قسم مجموعة حالات جاهزة لفلتر الحالات نفسه */
  const ORD_TABS = { new: ['new'], work: ['progress', 'done'], delivered: ['delivered'], all: [] };
  function ordTabOf() {
    const cur = [...ordStatuses].sort().join(',');
    return Object.keys(ORD_TABS).find((k) => ORD_TABS[k].slice().sort().join(',') === cur) || '';
  }

  /** تاريخ إنشاء الطلب بالتوقيت المحلي YYYY-MM-DD لمقارنته بمدى التاريخ */
  const ordDate = (o) => (o.createdAt ? localDate(o.createdAt) : '');


  function ordFilters() {
    return {
      q: $('#ordSearch').value.trim().toLowerCase(),
      from: $('#ordFrom').value,
      to: $('#ordTo').value,
      statuses: ordStatuses,
    };
  }

  function filteredOrders() {
    const f = ordFilters();
    let list = db().orders.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (f.statuses.size) list = list.filter((o) => f.statuses.has(o.status));
    if (ordOverOnly) list = list.filter((o) => overpaidBy(o) > 0);
    if (f.from) list = list.filter((o) => ordDate(o) >= f.from);
    if (f.to) list = list.filter((o) => ordDate(o) <= f.to);
    if (f.q) list = list.filter((o) => [o.number, o.customer?.name, o.customer?.phone, o.createdByName].some((v) => String(v || '').toLowerCase().includes(f.q)));
    return list;
  }

  /* ---------------- إظهار وإخفاء أعمدة جدول الطلبات ----------------
     تفضيل عرض لهذا الجهاز فقط: يخفي الأعمدة الأقل أهمية ليتنفّس الجدول،
     ولا يمسّ البيانات ولا يخرج من الجهاز. */
  const ORD_COLS_KEY = 'majlis_order_cols';
  const ORD_COLS = [
    { k: 'cost', label: 'التكلفة' },
    { k: 'profit', label: 'صافي الربح' },
    { k: 'comm', label: 'العمولة', admin: true },
    { k: 'paid', label: 'المدفوع' },
    { k: 'deliv', label: 'التوصيل' },
  ];
  let ordHidden = [];
  try { const v = JSON.parse(localStorage.getItem(ORD_COLS_KEY) || '[]'); if (Array.isArray(v)) ordHidden = v; } catch (_) { /* ignore */ }

  function renderOrdCols() {
    $('#ordersTable').setAttribute('data-hide', ordHidden.join(' '));
    const menu = $('#ordColsMenu');
    menu.innerHTML = ORD_COLS.filter((c) => !c.admin || canAny('commission.view_own', 'commission.view_all')).map((c) => {
      const on = !ordHidden.includes(c.k);
      return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" aria-pressed="${on}" data-col="${c.k}">${icon('check')}<span>${c.label}</span></button>`;
    }).join('');
    $$('[data-col]', menu).forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.col;
      ordHidden = ordHidden.includes(k) ? ordHidden.filter((x) => x !== k) : ordHidden.concat(k);
      try { localStorage.setItem(ORD_COLS_KEY, JSON.stringify(ordHidden)); } catch (_) { /* ignore */ }
      renderOrdCols();
    }));
  }

  function renderOrders() {
    const f = ordFilters();
    const filtering = !!(f.q || f.from || f.to || f.statuses.size || ordOverOnly);
    let list = filteredOrders();
    renderOrdCols();
    // شارة «مدفوع زائد»: تظهر ما دام هناك طلب مدفوعه أكبر من إجماليه (أو الفلتر مفعّل)
    { const nOver = (db().orders || []).filter((o) => overpaidBy(o) > 0).length;
      const chip = $('#ordOverChip');
      if (!nOver && ordOverOnly) ordOverOnly = false;
      chip.hidden = !nOver;
      $('#ordOverN').textContent = nOver;
      chip.classList.toggle('on', ordOverOnly);
      chip.setAttribute('aria-pressed', ordOverOnly ? 'true' : 'false'); }

    $$('#ordStatusChips .chip').forEach((c) => {
      const on = ordStatuses.has(c.dataset.stf);
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // التبويبات: القسم المطابق للفلتر الحالي، وعدد طلبات كل قسم (من كل الطلبات الظاهرة لك)
    const tab = ordTabOf();
    $$('#ordTabs [data-otab]').forEach((b) => { const on = b.dataset.otab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    const allO = db().orders || [];
    const cnt = { new: 0, work: 0, delivered: 0, all: allO.length };
    allO.forEach((o) => { if (o.status === 'new') cnt.new++; else if (o.status === 'progress' || o.status === 'done') cnt.work++; else if (o.status === 'delivered') cnt.delivered++; });
    $$('#ordTabs [data-otn]').forEach((n) => { n.textContent = cnt[n.dataset.otn]; });
    const nb = $('#ordTabs [data-otab="new"]'); if (nb) nb.classList.toggle('has-new', cnt.new > 0);
    $('#ordClearFilters').hidden = !filtering;
    const note = $('#ordersFilterNote');
    note.hidden = !filtering;
    if (filtering) note.textContent = `الملخص والجدول محسوبان على الطلبات المطابقة للفلتر: ${list.length} من ${db().orders.length}.`;

    // المبالغ لا تشمل الملغية ولا عروض الأسعار إلا إذا اختارها المستخدم صراحةً
    // (الاسم moneyList لا money: الأخير يحجب دالة التقريب money المستعملة أسفله)
    const moneyList = list.filter((o) => isSale(o) || ordStatuses.has(o.status));
    const sum = (f2) => moneyList.reduce((s, o) => s + num(f2(o)), 0);
    const costed = moneyList.filter((o) => orderCost(o) !== null);
    const costSum = money(costed.reduce((s, o) => s + orderCost(o), 0));
    const profitSum = money(costed.reduce((s, o) => s + orderProfit(o), 0));
    const costedRevenue = money(costed.reduce((s, o) => s + orderRevenue(o), 0));
    const marginPct = costedRevenue > 0 ? r2((profitSum / costedRevenue) * 100) : 0;
    const noCost = moneyList.length - costed.length;
    $('#ordersStats').innerHTML = `
      <div class="stat"><span>عدد الطلبات</span><b>${list.length}</b></div>
      <div class="stat"><span>إجمالي المبيعات</span><b>${fmt(sum((o) => o.total))}</b></div>
      <div class="stat"><span>المدفوع</span><b>${fmt(sum((o) => o.paid))}</b></div>
      <div class="stat remaining"><span>المتبقي على العملاء</span><b>${fmt(sum((o) => num(o.total) - num(o.paid)))}</b></div>
      <div class="stat"><span>قيد التنفيذ</span><b>${list.filter((o) => o.status === 'progress').length}</b></div>
      <div class="stat"><span>اكتمال التنفيذ</span><b>${list.filter((o) => o.status === 'done').length}</b></div>
      <div class="stat"><span>عروض أسعار مفتوحة</span><b>${list.filter((o) => o.status === 'quote').length}</b><small>لا تدخل في المبيعات</small></div>
      ${(canAny('costs.view_own', 'costs.view_all') && (isAdmin() || costed.length)) ? `
      <div class="stat cost"><span>إجمالي التكاليف</span><b class="${costed.length ? '' : 'is-na'}">${costed.length ? fmt(costSum) : '—'}</b><small class="${costed.length ? '' : 'na-note'}">بتكلفة: ${costed.length}${noCost ? ` • بلا تكلفة: ${noCost}` : ''}</small></div>
      ${canAny('profit.view_own', 'profit.view_all') ? `<div class="stat profit"><span>إجمالي الربح <small>(قبل الضريبة)</small></span><b class="${costed.length ? (profitSum < 0 ? 'neg' : 'pos') : 'is-na'}">${costed.length ? fmt(profitSum) : '—'}</b><small class="${costed.length ? '' : 'na-note'}">${costed.length ? `هامش ${fmtQty(marginPct)}٪` : 'يُحسب بعد إدخال تكاليف الطلبات'}</small></div>` : ''}` : ''}`;

    const tb = $('#ordersTable tbody');
    $('#ordersEmpty').hidden = list.length > 0;
    // حالة فارغة تقول ما الخطوة التالية: مسح الفلاتر إن وُجدت، وإلا إنشاء أول طلب
    $('#ordersEmptyText').textContent = filtering ? 'لا توجد طلبات مطابقة للفلاتر الحالية' : 'لم يُسجَّل أي طلب بعد';
    $('#ordersEmptyClear').hidden = !filtering;
    $('#ordersEmptyNew').hidden = filtering;
    // عرض تدريجي: رسم مئات الصفوف دفعة واحدة يُبطئ الجوال بلا فائدة
    const matched = list.length;
    list = list.slice(0, ordersShown);
    tb.innerHTML = list.map((o) => {
      const rem = remainingOf(o.total, o.paid);
      const cost = orderCost(o);
      const profit = orderProfit(o);
      const comm = orderCommission(o);
      const dash = '<span class="hint">—</span>';
      // المعرّف يصل من الخادم كما كتبه أي عميل: يُهرَّب قبل وضعه في سمة
      const oid = esc(o.id);
      // أسماء الأعمدة (c-*) ترتّب البطاقة في الجوال: رأس (الرقم + العميل + الحالة)،
      // ثم المبالغ متجاورة، ثم التفاصيل، ثم الأزرار
      const late = isOpen(o) && o.deliveryDate && daysUntil(o.deliveryDate) < 0;
      const st = esc(o.status || 'new');
      return `
      <tr data-status="${st}" class="${late ? 'is-late' : ''}">
        <td data-label="رقم الطلب" class="c-no"><b class="num">#${esc(o.number || '—')}</b>${o.status === 'quote' ? ' <span class="badge st-quote">عرض سعر</span>' : ''}${overpaidBy(o) ? ` <span class="badge over" title="المدفوع أكبر من الإجمالي — راجع الدفعات">زيادة ${fmt(overpaidBy(o))}</span>` : ''}<span class="sub"><bdi class="num" title="${esc(fmtDateTime(o.createdAt))}">${fmtDate(o.createdAt)}</bdi>${o.createdByName ? `<span class="sub-by" title="${esc(o.createdByName)}">${esc(o.createdByName)}</span>` : ''}</span></td>
        <td data-label="العميل" class="c-cust"><b dir="auto" title="${esc(o.customer?.name) || ''}">${esc(o.customer?.name) || '—'}</b>${o.customer?.phone ? `<span class="sub num">${esc(o.customer.phone)}</span>` : ''}</td>
        <td data-label="المجموع" class="num c-money c-total">${fmt(o.total)}</td>
        <td data-label="التكلفة" class="num c-money c-cost${canSeeCosts(o) && cost !== null ? '' : ' is-empty'}">${canSeeCosts(o) && cost !== null ? fmt(cost) : dash}</td>
        ${canSeeProfit(o) ? `
        <td data-label="صافي الربح" class="num c-money c-cost c-profit ${profit === null ? 'is-empty' : profit < 0 ? 'neg' : 'pos'}">${profit === null ? dash : fmt(profit)}</td>` : `
        <td data-label="صافي الربح" class="num c-money c-cost c-profit is-empty">${dash}</td>`}
        ${canAny('commission.view_own', 'commission.view_all') ? `<td data-label="العمولة" class="num c-money c-comm${canSeeComm(o) && comm !== null ? '' : ' is-empty'}">${canSeeComm(o) && comm !== null ? fmt(comm) : dash}</td>` : ''}
        <td data-label="المدفوع" class="num c-money c-paid">${fmt(o.paid)}</td>
        <td data-label="المتبقي" class="num c-money c-rem ${rem > 0.004 && o.status !== 'quote' ? 'warn-num' : ''}">${fmt(rem)}</td>
        <td data-label="التوصيل" class="c-deliv ${late ? 'late' : ''}"><span class="num">${o.deliveryDate ? esc(fmtDate(o.deliveryDate)) : '—'}</span>${late ? '<span class="late-tag">متأخر</span>' : ''}</td>
        <td data-label="الحالة" class="c-status"><label class="status-chip sm" data-status="${st}"><i class="status-dot"></i><select data-st="${oid}" aria-label="حالة الطلب ${esc(o.number || '')}" ${canEditOrder(o) ? '' : 'disabled title="الطلب لموظف آخر"'}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select><svg class="status-caret"><use href="#i-chevron-down"/></svg></label></td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-open="${oid}">${canEditOrder(o) ? `${icon('pen')} فتح` : `${icon('lock')} عرض`}</button>
          ${rowMenu([
            menuItem(`data-sum="${oid}"`, 'list', 'ملخص الطلب' + (canSeeCosts(o) ? ' والتكاليف' : '')),
            menuItem(`data-print="${oid}"`, 'file', 'تصدير PDF ومشاركته'),
            (canSeeCosts(o) && canWriteCosts(o, cost !== null)) ? menuItem(`data-cost="${oid}"`, 'wallet', cost === null ? 'إضافة التكاليف' : 'تعديل التكاليف') : '',
            can('admin.core') ? menuItem(`data-comm="${oid}"`, 'trend', `${isMandoub(o) ? 'نسبة المندوب' : 'نسبة البائع'} ${fmtQty(orderOwnerRate(o))}٪`) : '',
            can('admin.core') ? menuItem(`data-owner="${oid}"`, 'swap', 'نقل ملكية الطلب') : '',
            canFor(o, 'orders.delete') ? '<hr>' + menuItem(`data-delo="${oid}"`, 'trash', 'حذف الطلب', true) : '',
          ], `إجراءات الطلب ${esc(o.number || '')}`)}
        </span></td>
      </tr>`;
    }).join('');

    renderMoreBar($('#ordersMore'), list.length, matched, () => { ordersShown += PAGE_STEP; renderOrders(); });

    const find = (id) => db().orders.find((o) => o.id === id);
    $$('[data-open]', tb).forEach((b) => b.addEventListener('click', async () => {
      if (dirty && !(await confirmDlg('فتح طلب', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) return;
      loadOrder(find(b.dataset.open));
    }));
    $$('[data-print]', tb).forEach((b) => b.addEventListener('click', () => shareOrder(find(b.dataset.print))));
    $$('[data-cost]', tb).forEach((b) => b.addEventListener('click', () => costForm(find(b.dataset.cost))));
    $$('[data-sum]', tb).forEach((b) => b.addEventListener('click', () => orderSummary(find(b.dataset.sum))));
    $$('[data-comm]', tb).forEach((b) => b.addEventListener('click', () => commissionForm(find(b.dataset.comm))));
    $$('[data-owner]', tb).forEach((b) => b.addEventListener('click', () => transferOwner(find(b.dataset.owner))));
    $$('[data-delo]', tb).forEach((b) => b.addEventListener('click', async () => {
      const o = find(b.dataset.delo);
      if (!(await confirmDlg('حذف الطلب', `حذف الطلب #${o.number} للعميل ${o.customer?.name}؟ لا يمكن التراجع.`))) return;
      db().orders = db().orders.filter((x) => x.id !== o.id);
      logActivity('delete', o, [`الإجمالي ${fmt(o.total)}`, `الحالة ${STATUS[o.status] || o.status}`]);
      if (!(await Store.save())) { toast(humanError(Store.lastError, 'تعذّر حذف الطلب. تحقق من الاتصال وحاول مرة أخرى.'), true); await Store.refresh().catch(() => {}); renderOrders(); return; }
      if (cur.id === o.id) startNewOrder(true);
      renderOrders();
      renderNotifications();
      toast('تم حذف الطلب');
    }));
    $$('select[data-st]', tb).forEach((s) => s.addEventListener('change', async () => {
      const o = find(s.dataset.st);
      if (!o || !canEditOrder(o)) { renderOrders(); return; }
      if (!(await confirmStatusChange(o, s.value))) { renderOrders(); return; }
      const before = JSON.parse(JSON.stringify(o));
      const oldSt = o.status;
      o.status = s.value; o.updatedAt = Store.now(); o.updatedByName = currentUser.name;
      o.statusAt = o.updatedAt; o.statusByName = currentUser.name;
      const ev = logActivity('status', o, [`الحالة: من ${STATUS[oldSt] || oldSt} إلى ${STATUS[o.status]}`]);
      if (!(await Store.save())) {
        // إرجاع الطلب كما كان: تغيير لم يصل الخادم يبقى معلّقاً ويُفشل كل حفظ بعده
        const i = db().orders.findIndex((x) => x.id === o.id);
        if (i >= 0) db().orders[i] = before;
        if (ev) db().activity = db().activity.filter((x) => x.id !== ev.id);
        toast(humanError(Store.lastError, 'تعذّر حفظ الحالة الجديدة. تحقق من الاتصال وحاول مرة أخرى.'), true);
        renderOrders();
        return;
      }
      if (cur.id === o.id) { cur.status = o.status; cur.statusAt = o.statusAt; cur.statusByName = o.statusByName; ownVersion(o.updatedAt); $('#orderStatus').value = o.status; syncStatusChip(); }
      renderOrders();
      renderNotifications();
      toast('تم تحديث الحالة');
    }));
  }
  /** نقل ملكية الطلب إلى موظف آخر (للمدير فقط) */
  function transferOwner(o) {
    if (!o || !can('admin.core')) return;
    const users = db().users.filter((u) => u.active !== false);
    if (!users.length) { toast('لا يوجد مستخدمون', true); return; }
    openModal('نقل ملكية الطلب', `
      <p>الطلب <b>#${esc(o.number)}</b> للعميل <b>${esc(o.customer?.name || '—')}</b></p>
      <p class="hint">المالك الحالي: <b>${esc(o.createdByName || 'غير محدد')}</b></p>
      <label>الموظف الجديد
        <select id="ownTo">${users.map((u) => `<option value="${u.id}" ${u.id === o.createdBy ? 'selected' : ''}>${esc(u.name)} — ${ROLES[u.role] || u.role}</option>`).join('')}</select>
      </label>
      <p class="hint">سيتمكّن الموظف الجديد من تعديل الطلب، ولن يستطيع المالك السابق تعديله إلا إن كان مديراً.</p>
      <p id="ownErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="ownCancel">إلغاء</button><button class="btn primary" id="ownOk">${icon('swap')} نقل الملكية</button></div>`, (b) => {
      $('#ownCancel', b).onclick = closeModal;
      $('#ownOk', b).onclick = async () => {
        const u = Store.getUser($('#ownTo', b).value);
        if (!u) { $('#ownErr', b).textContent = 'اختر موظفاً'; return; }
        if (u.id === o.createdBy) { closeModal(); return; }
        const from = o.createdByName || '—';
        const before = JSON.parse(JSON.stringify(o));
        o.createdBy = u.id; o.createdByName = u.name;
        o.updatedAt = Store.now(); o.updatedByName = currentUser.name;
        const ev = logActivity('owner', o, [`الملكية: من ${from} إلى ${u.name}`]);
        if (!(await Store.save())) {
          const i = db().orders.findIndex((x) => x.id === o.id);
          if (i >= 0) db().orders[i] = before;
          if (ev) db().activity = db().activity.filter((x) => x.id !== ev.id);
          $('#ownErr', b).textContent = humanError(Store.lastError);
          return;
        }
        if (cur.id === o.id) { cur.createdBy = o.createdBy; cur.createdByName = o.createdByName; ownVersion(o.updatedAt); readOnly = !canEditOrder(cur); setOrderOwnerLabel(cur); applyOrderLock(); renderOrderMeta(); }
        closeModal(); renderOrders();
        toast(`نُقلت ملكية الطلب #${o.number} إلى ${u.name}`);
      };
    }, 'drawer');
  }

  /* ---------------- ملخص الطلب (عرض + PDF داخلي للإدارة) ----------------
     مصدر واحد للأرقام: نفس دوال الحساب (computeLines/computeCosts/orderCommission…)
     فيطابق الملخص الجدول والتقارير. التكاليف والربح والعمولة تظهر بحسب الصلاحية فقط. */
  function orderSummaryRep(o, linkedExp) {
    const L = computeLines(o);
    const seeCost = canSeeCosts(o), seeProfit = canSeeProfit(o), seeComm = canSeeComm(o);
    const info = seeCost ? computeCosts(o) : null;
    // الأرقام الإجمالية من الدوال نفسها التي تعتمدها القائمة والتقارير (orderCost/orderProfit/orderRevenue):
    // طلب قديم بإجمالي تكلفة محفوظ بلا تفصيل يظهر ربحه هنا كما يظهر هناك
    const costAll = seeCost ? orderCost(o) : null;
    const hasCost = costAll !== null;
    const profitAll = hasCost ? orderProfit(o) : null;
    const revAll = orderRevenue(o);
    const marginAll = hasCost && revAll > 0 ? r2((profitAll / revAll) * 100) : 0;
    // تكاليف الأصناف مسجّلة فعلاً؟ (الطلب قد تُسجَّل تكاليفه كلها بنوداً إضافية فقط)
    const linesHave = !!(info && info.rows.some((r) => r.unitCost !== null));
    const paid = paidOf(o);
    const rem = remainingOf(o.total, paid);
    const comm = seeComm ? orderCommission(o) : null;
    const parentComm = seeComm ? orderParentCommission(o) : null;
    const parent = mandoubParentOf(o);
    // عزل اتجاه الأرقام والتواريخ داخل النص العربي (لا ينقلب 2026-11-03 إلى 03-11-2026، ولا «2٪» إلى «٪2»)
    const iso = (x) => '\u2066' + x + '\u2069';
    const pct = (n) => iso(r2(n) + '٪');
    const day = (d) => iso(fmtDate(d));
    // أسماء المبالغ بحسب الطلب: لا «شامل الضريبة» ولا «بعد الخصم» حيث لا ضريبة ولا خصم
    const totalLbl = L.vatEnabled ? 'الإجمالي شامل الضريبة' : 'الإجمالي';
    const revLbl = L.vatEnabled && L.discount ? 'قبل الضريبة (بعد الخصم)' : L.vatEnabled ? 'قبل الضريبة' : L.discount ? 'المبيعات بعد الخصم' : 'المبيعات';
    const revenue = revAll;
    const summary = [{ label: totalLbl, value: money(o.total), kind: 'money' }];
    if (L.vatEnabled || L.discount) summary.push({ label: revLbl, value: revenue, kind: 'money' });
    summary.push({ label: 'المدفوع', value: paid, kind: 'money' }, { label: 'المتبقي', value: rem, kind: 'money' });
    if (seeCost) summary.push({ label: 'إجمالي التكاليف', value: costAll, kind: 'money' });
    if (seeProfit) {
      summary.push({ label: 'صافي الربح', value: profitAll, kind: 'money' });
      summary.push({ label: 'هامش الربح', value: hasCost ? marginAll : null, kind: 'pct' });
    }
    const CR = commRatesOf(o), CS = commRateSources(o, CR);
    const commLbl = `${isMandoub(o) ? 'عمولة المندوب' : 'عمولة البائع'} (${pct(CR.ownerRate)})`;
    if (seeComm) summary.push({ label: commLbl, value: comm, kind: 'money' });

    const tables = [];
    // 1) الأصناف: البيع، ومعه التكلفة والربح لمن يراها (أعمدة قليلة لتُقرأ على الجوال)
    const cols = [{ key: 'name', label: 'الصنف' }, { key: 'qp', label: 'الكمية × السعر' }, { key: 'total', label: 'إجمالي البيع', kind: 'money' }];
    if (seeCost) cols.push({ key: 'uc', label: 'تكلفة الوحدة', kind: 'money' }, { key: 'ct', label: 'إجمالي التكلفة', kind: 'money' });
    if (seeProfit) cols.push({ key: 'pr', label: 'الربح', kind: 'money' });
    const src = seeCost ? info.rows : L.lines;
    tables.push({
      title: 'الأصناف' + (seeCost ? ' وتكاليفها' : ''), columns: cols,
      rows: src.map((r) => ({
        name: r.name + (r.sub ? ' — ' + r.sub : ''),
        qp: `${r.kind === 'sofa' ? fmtQty(r.qty) : r.qty} ${r.unit} × ${fmt(r.price)}`, total: r.total,
        uc: seeCost ? r.unitCost : undefined, ct: seeCost ? r.costTotal : undefined, pr: seeProfit ? r.profit : undefined,
      })),
      totals: src.length ? { name: 'المجموع', total: L.subtotal, ct: seeCost ? (linesHave ? info.linesCost : null) : undefined,
        pr: seeProfit && linesHave && !info.missing ? money(L.subtotal - info.linesCost) : undefined } : null,
      empty: 'لا توجد أصناف في هذا الطلب',
    });
    // 2) التكاليف الإضافية كما سُجّلت بنداً بنداً
    if (seeCost && info.extras.length) {
      tables.push({
        title: 'تكاليف إضافية على الطلب', columns: [{ key: 'name', label: 'البند' }, { key: 'amount', label: 'المبلغ', kind: 'money' }],
        rows: info.extras.map((e) => ({ name: e.name || '—', amount: e.amount })),
        totals: { name: 'المجموع', amount: info.extrasCost },
      });
    }
    // 3) الحساب خطوة بخطوة: من مجموع الأصناف إلى صافي الربح والعمولات
    const acc = [{ k: 'مجموع الأصناف', v: L.subtotal }];
    if (L.discount) acc.push({ k: 'الخصم', v: -L.discount });
    if (L.vatEnabled) acc.push({ k: `ضريبة القيمة المضافة (${pct(L.vatRate)})`, v: L.vatAmount });
    acc.push({ k: totalLbl, v: money(o.total), b: true });
    acc.push({ k: 'المدفوع', v: paid }, { k: 'المتبقي على العميل', v: rem, b: true });
    if (seeCost) {
      acc.push({ k: (L.vatEnabled ? 'المبيعات قبل الضريبة' : 'المبيعات') + ' (أساس الربح)', v: revenue });
      acc.push({ k: linesHave ? 'تكاليف الأصناف' : 'تكاليف الأصناف (لم تُسجَّل تكلفة وحدة)', v: linesHave ? -info.linesCost : null });
      if (info.extras.length) acc.push({ k: 'التكاليف الإضافية', v: -info.extrasCost });
      acc.push({ k: 'إجمالي التكاليف', v: hasCost ? -costAll : null, b: true });
    }
    if (seeProfit) acc.push({ k: 'صافي الربح', v: profitAll, b: true });
    if (seeComm) {
      acc.push({ k: `${isMandoub(o) ? 'عمولة المندوب' : 'عمولة البائع'}${o.createdByName ? ' — ' + o.createdByName : ''} (${pct(CR.ownerRate)} من ${commBaseLabel()} • ${CS.owner})`, v: comm });
      if (CR.parentId) { const par = Store.getUser(CR.parentId) || parent; acc.push({ k: `عمولة المندوب الأعلى — ${(par && par.name) || ''} (${pct(CR.parentRate)} • ${CS.parent})`, v: parentComm }); }
      if (CR.shareRate && commBaseAmount(o) !== null && (commBaseMode() === 'total' || (seeProfit && hasCost))) acc.push({ k: `حصة المشاركة (${pct(CR.shareRate)} • ${CS.share})`, v: orderShareAmount(o) });
    }
    tables.push({ title: 'ملخص الحساب', columns: [{ key: 'k', label: 'البند' }, { key: 'v', label: 'المبلغ', kind: 'money' }], rows: acc, bold: true });
    // 4) الدفعات
    const pays = (Array.isArray(o.payments) ? o.payments : []).filter((p) => p && num(p.amount));
    tables.push({
      title: 'الدفعات', columns: [{ key: 'at', label: 'التاريخ', kind: 'date' }, { key: 'm', label: 'الطريقة' },
        { key: 'amount', label: 'المبلغ', kind: 'money' }, { key: 'note', label: 'ملاحظة' }, { key: 'by', label: 'سجّلها' }],
      rows: pays.map((p) => ({ at: fmtDate(p.at), m: (money(p.amount) < 0 ? 'استرداد • ' : '') + (PAY_METHODS[p.method] || p.method || '—'), amount: money(p.amount), note: p.note || '', by: p.by || '' })),
      totals: pays.length ? { at: 'المجموع', amount: paid } : null,
      empty: 'لا توجد دفعات مسجّلة',
    });
    // 5) مصروفات صفحة «المصروفات» المربوطة بهذا الطلب (للاطلاع؛ صافي الربح أعلاه من تكاليف الطلب)
    if (seeCost && linkedExp && linkedExp.length) {
      tables.push({
        title: 'مصروفات مسجّلة على هذا الطلب (صفحة المصروفات)', columns: [{ key: 'd', label: 'التاريخ', kind: 'date' },
          { key: 'name', label: 'البند' }, { key: 'cat', label: 'التصنيف' }, { key: 'amount', label: 'المبلغ', kind: 'money' }, { key: 'note', label: 'ملاحظة' }],
        rows: linkedExp.map((e) => ({ d: expDay(e), name: e.name || '—', cat: e.category || '', amount: money(e.amount), note: e.note || '' })),
        totals: { d: 'المجموع', amount: money(linkedExp.reduce((s, e) => s + money(e.amount), 0)) },
      });
    }
    const notes = [];
    if (seeCost && info.missing) {
      notes.push(info.extras.length
        ? `${info.missing} من الأصناف بلا تكلفة وحدة مسجّلة — التكاليف المسجّلة بنوداً إضافية (${fmt(info.extrasCost)}) محسوبة في صافي الربح.`
        : `${info.missing} من الأصناف بلا تكلفة وحدة مسجّلة — صافي الربح لا يشمل تكلفتها.`);
    }
    if (seeCost && !hasCost) notes.push('لم تُسجَّل تكاليف لهذا الطلب بعد: أضفها من «تعديل التكاليف» ليظهر صافي الربح.');
    if (seeCost && linkedExp && linkedExp.length) notes.push('المصروفات المسجّلة في صفحة المصروفات تظهر للاطلاع ولا تدخل في صافي ربح الطلب (كما في التقارير).');
    if (seeCost) notes.push('مستند داخلي للإدارة: فيه التكاليف والأرباح — لا يُرسل للعميل.');
    const meta = [['العميل', (o.customer && o.customer.name) || '—'], ['الجوال', (o.customer && o.customer.phone) ? iso(o.customer.phone) : '—'],
      ['الحالة', STATUS[o.status] || o.status || '—'], ['تاريخ الطلب', day(o.createdAt)],
      ['التوصيل', o.deliveryDate ? day(o.deliveryDate) : '—'], ['صاحب الطلب', o.createdByName || '—']];
    if (seeCost && o.costUpdatedByName) meta.push(['آخر تعديل للتكاليف', `${o.costUpdatedByName} • ${iso(fmtDateTime(o.costUpdatedAt))}`]);
    return { id: 'order-summary', portrait: true, title: `ملخص الطلب ${iso('#' + o.number)}`,
      headSub: `العميل: ${(o.customer && o.customer.name) || '—'} • ${STATUS[o.status] || o.status || ''} • ${day(o.createdAt)}`,
      from: '', to: '', summary, tables, notes, meta, seeCost,
      nums: { total: money(o.total), cost: costAll, profit: profitAll } };
  }

  /** نافذة ملخص الطلب المفصّل، ومنها تصدير PDF الإدارة */
  async function orderSummary(o) {
    if (!o) return;
    let linked = [];
    if (canSeeCosts(o) && canAny('expenses.view_own', 'expenses.view_all')) {
      try { linked = (await loadExpenses()).filter((e) => e.order_id === o.id); } catch (_) { linked = []; }
    }
    const rep = orderSummaryRep(o, linked);
    const cell = (v, kind) => repCell(v, kind);
    const cur$ = esc(currency());
    const kpis = rep.summary.map((s) => `<div class="stat${/الربح/.test(s.label) && s.value !== null ? (s.value < 0 ? ' neg' : ' pos') : ''}${s.label === 'المتبقي' && s.value > 0.004 ? ' remaining' : ''}"><span>${esc(s.label)}</span><b>${s.value === null || s.value === undefined ? '—' : s.kind === 'pct' ? r2(s.value) + '٪' : fmt(s.value)}${s.kind === 'money' && s.value !== null && s.value !== undefined ? ` <small class="sum-cur">${cur$}</small>` : ''}</b></div>`).join('');
    const tbl = (t) => {
      /* جدول بعمودين (بند ← مبلغ): أسطر مدمجة «الاسم ……… المبلغ» بلا رأس ولا بطاقات (لا تتكرر «البند/المبلغ» في الجوال).
         الجداول الأعرض: بطاقة مدمجة لكل صف، والعنوان (الصنف/التاريخ) سطر بارز والحقول «اسم ← قيمة» في سطر واحد */
      const list = t.columns.length === 2;
      const head = `<tr>${t.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
      const lead = t.columns[0].key;
      const row = (r, tot) => `<tr class="${tot || r.b ? 'sum-tot' : ''}">${t.columns.map((c) => {
        const v = r[c.key] === undefined || r[c.key] === '' ? '' : cell(r[c.key], c.kind);
        const cls = [isNumKind(c.kind) ? 'num' : '', c.key === lead ? 'sum-lead no-label' : '', v ? '' : 'is-blank'].filter(Boolean).join(' ');
        return `<td data-label="${esc(c.label)}" class="${cls}">${v}</td>`;
      }).join('')}</tr>`;
      const body = t.rows.length ? t.rows.map((r) => row(r, false)).join('') + (t.totals ? row(t.totals, true) : '') : `<tr><td colspan="${t.columns.length}" class="empty no-label">${esc(t.empty || '—')}</td></tr>`;
      return `<h4 class="sum-h">${esc(t.title)}</h4><div class="table-wrap"><table class="table ${list ? 'sum-list' : 'responsive'} sum-table">${list ? '' : `<thead>${head}</thead>`}<tbody>${body}</tbody></table></div>`;
    };
    const canCostEdit = canSeeCosts(o) && canWriteCosts(o, orderCost(o) !== null);
    openModal(rep.title, `
      <dl class="sum-meta">${rep.meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd dir="auto">${esc(String(v))}</dd></div>`).join('')}</dl>
      <div class="cost-sum sum-kpis">${kpis}</div>
      ${rep.tables.map(tbl).join('')}
      ${rep.notes.length ? `<ul class="hint sum-notes">${rep.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${(canCostEdit || rep.seeCost) ? `<div class="btn-row sum-actions${(rep.seeCost ? 1 : 0) + (canCostEdit ? 1 : 0) === 1 ? ' one-small' : ''}">
        ${rep.seeCost ? `<button class="btn primary" id="sumWa">${icon('whatsapp')} مشاركة PDF عبر واتساب</button>` : ''}
        ${rep.seeCost ? `<button class="btn small" id="sumPdf">${icon('download')} تنزيل PDF</button>` : ''}
        ${canCostEdit ? `<button class="btn small" id="sumCost">${icon('wallet')} ${orderCost(o) === null ? 'إضافة التكاليف' : 'تعديل التكاليف'}</button>` : ''}
      </div>` : ''}`, (b) => {
      if ($('#sumCost', b)) $('#sumCost', b).addEventListener('click', () => { closeModal(); costForm(o); });
      if ($('#sumPdf', b)) $('#sumPdf', b).addEventListener('click', () => exportOrderSummaryPdf(o, linked, $('#sumPdf', b)));
      if ($('#sumWa', b)) $('#sumWa', b).addEventListener('click', () => exportOrderSummaryPdf(o, linked, $('#sumWa', b), true));
    }, 'drawer wide');
  }

  /** PDF داخلي للإدارة: ملخص الطلب + كل بند تكلفة كما سُجّل (بمحرّك التقارير نفسه) */
  async function exportOrderSummaryPdf(o, linked, btn, share) {
    if (!o || !canSeeCosts(o)) return;
    const rep = orderSummaryRep(o, linked || []);
    const meta = rep.meta.concat([['صُدِّر في', fmtDateTime(Store.now())], ['أعدّه', (currentUser && currentUser.name) || '']]);
    const fileName = `order-summary-${o.number}.pdf`;
    if (!share) { await repPdfRender(rep, meta, fileName, btn); return; }
    const blob = await repPdfRender(rep, meta, fileName, btn, { returnBlob: true });
    if (!blob) return;
    // نص مرافق قصير: داخلي للإدارة (لا تُفتح محادثة العميل أبداً)
    const v = (n) => (n === null || n === undefined ? '—' : fmt(n));
    const caption = [`ملخص الطلب *#${o.number}* — داخلي للإدارة`, `العميل: ${(o.customer && o.customer.name) || '—'}`,
      `الإجمالي: ${v(rep.nums.total)} • التكاليف: ${v(rep.nums.cost)}${canSeeProfit(o) ? ` • صافي الربح: ${v(rep.nums.profit)}` : ''}`,
      'التفاصيل وكل بند تكلفة في الملف المرفق.'].join('\n');
    if (await sharePdfNative(blob, fileName, caption)) { toast('تمت المشاركة'); return; }
    const file = new File([blob], fileName, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: fileName, text: caption }); toast('تمت المشاركة'); }
      catch (e) { if (e && e.name !== 'AbortError') toast('تعذّرت المشاركة: ' + e.message, true); }
      return;
    }
    downloadBlob(blob, fileName);
    toast(`هذا المتصفح لا يرسل الملفات مباشرة: حُفظ ${fileName} في التنزيلات، أرفقه في واتساب`);
  }

  /** نافذة إدخال تكلفة كل صنف في الطلب مع حساب الربح مباشرة */
  function costForm(o) {
    if (!o || !canSeeCosts(o) || !canWriteCosts(o, orderCost(o) !== null)) return;
    const info = computeCosts(o);
    const cur$ = esc(currency());
    // طلب بلا أصناف يبقى قابلاً لتسجيل التكاليف الإضافية (توصيل ونحوه)
    const rowsHtml = !info.rows.length
      ? '<tr><td colspan="8" class="empty no-label">لا توجد أصناف في هذا الطلب</td></tr>'
      : info.rows.map((r, i) => `
      <tr>
        <td class="no-label price-index">${i + 1}</td>
        <td data-label="الصنف" class="span2">${esc(r.name)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</td>
        <td data-label="الكمية" class="num">${r.kind === 'sofa' ? fmtQty(r.qty) : r.qty} ${esc(r.unit)}</td>
        <td data-label="سعر البيع" class="num">${fmt(r.price)}</td>
        <td data-label="إجمالي البيع" class="num">${fmt(r.total)}</td>
        <td data-label="تكلفة الوحدة"><input class="inline num" type="number" step="1" min="0" inputmode="numeric" data-ck="${esc(r.key)}" value="${r.unitCost === null ? '' : r.unitCost}" placeholder="0" aria-label="تكلفة الوحدة لـ ${esc(r.name)}"></td>
        <td data-label="إجمالي التكلفة" class="num" data-ct="${esc(r.key)}">—</td>
        <td data-label="الربح" class="num" data-cp="${esc(r.key)}">—</td>
      </tr>`).join('');

    openModal(`تكاليف الطلب #${o.number}`, `
      <p class="hint">العميل <b>${esc(o.customer?.name || '—')}</b> • المجموع ${fmt(o.total)} ${cur$} • ${esc(STATUS[o.status] || o.status)}${o.costUpdatedByName ? ` • آخر تعديل للتكاليف: ${esc(o.costUpdatedByName)} ${fmtDateTime(o.costUpdatedAt)}` : ''}</p>
      <div class="table-wrap">
        <table class="table responsive cost-table">
          <thead><tr><th></th><th>الصنف</th><th>الكمية</th><th>سعر البيع</th><th>إجمالي البيع</th><th>تكلفة الوحدة</th><th>إجمالي التكلفة</th><th>الربح</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>

      <div class="extra-costs">
        <div class="extra-head">
          <h4>${icon('wallet')} تكاليف إضافية على الطلب</h4>
          <button type="button" class="btn small" id="extraAdd">${icon('plus')} بند جديد</button>
        </div>
        <p class="hint">بنود لا تخص صنفاً بعينه: التوصيل، التحميل والتنزيل، التركيب، أجور العمالة… تُضاف إلى إجمالي التكاليف وتُخصم من الربح.</p>
        <div class="chip-group extra-presets">${EXTRA_PRESETS.map((p) => `<button type="button" class="chip" data-preset="${esc(p)}">${icon('plus')} ${esc(p)}</button>`).join('')}</div>
        <div id="extraList"></div>
      </div>

      <div class="cost-sum" id="costSum"></div>
      <p class="hint">التكلفة تُدخَل لكل وحدة (متر أو قطعة) وتُضرب في الكمية. صافي الربح = إجمالي البيع قبل الضريبة − (تكاليف الأصناف + التكاليف الإضافية)؛ الضريبة تُحصَّل للدولة فلا تُحتسب ربحاً. لا تظهر التكاليف في ملف PDF الذي يصل العميل.</p>
      <p id="costErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="costCancel">إلغاء</button><button class="btn primary" id="costOk">${icon('save')} حفظ التكاليف</button></div>`, (b) => {
      const inputs = $$('[data-ck]', b);
      const rowOf = (key) => info.rows.find((r) => r.key === key);

      const read = (inp) => {
        const raw = String(inp.value).trim();
        if (raw === '') return null;
        const v = parseFloat(raw);
        return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : NaN;
      };

      /* --- البنود الإضافية: تُدار كقائمة محلية ثم تُحفظ مع الطلب --- */
      let extraRows = info.extras.map((e) => ({ name: e.name, amount: String(e.amount) }));

      /** قراءة ما كتبه المستخدم في الحقول الآن (قبل أي إعادة رسم) */
      function readExtras() {
        return $$('.extra-row', b).map((row) => ({
          name: $('[data-ex="name"]', row).value,
          amount: $('[data-ex="amount"]', row).value,
        }));
      }

      function renderExtras(focusLast = false) {
        const host = $('#extraList', b);
        host.innerHTML = extraRows.length ? extraRows.map((e, i) => `
          <div class="extra-row" data-i="${i}">
            <input class="inline wide" data-ex="name" value="${esc(e.name)}" placeholder="اسم البند (مثل: التوصيل)" aria-label="اسم البند الإضافي">
            <input class="inline num" type="number" step="1" min="0" inputmode="numeric" data-ex="amount" value="${esc(e.amount)}" placeholder="0" aria-label="مبلغ البند الإضافي">
            <button type="button" class="icon-btn" data-exdel="${i}" aria-label="حذف البند">${icon('x')}</button>
          </div>`).join('') : '<p class="hint empty-extras">لا توجد بنود إضافية.</p>';
        $$('[data-ex]', host).forEach((inp) => inp.addEventListener('input', recalc));
        $$('[data-exdel]', host).forEach((btn) => btn.addEventListener('click', () => {
          extraRows = readExtras();
          extraRows.splice(+btn.dataset.exdel, 1);
          renderExtras();
          recalc();
        }));
        if (focusLast) {
          const last = $$('.extra-row [data-ex="name"]', host).pop();
          if (last && !last.value) last.focus({ preventScroll: true });
          else if (last) $('[data-ex="amount"]', last.closest('.extra-row')).focus({ preventScroll: true });
        }
      }

      function addExtra(name = '') {
        extraRows = readExtras();
        extraRows.push({ name, amount: '' });
        renderExtras(true);
        recalc();
      }

      function recalc() {
        let costTotal = 0, filled = 0, bad = 0;
        inputs.forEach((inp) => {
          const key = inp.dataset.ck;
          const r = rowOf(key);
          const v = read(inp);
          const ok = v !== null && !Number.isNaN(v);
          inp.classList.toggle('bad', Number.isNaN(v));
          if (Number.isNaN(v)) bad++;
          const ct = ok ? money(r.qty * v) : null;
          const pf = ok ? money(r.total - ct) : null;
          if (ok) { costTotal += ct; filled++; }
          $(`[data-ct="${key}"]`, b).innerHTML = ok ? fmt(ct) : '<span class="hint">—</span>';
          const cp = $(`[data-cp="${key}"]`, b);
          cp.className = 'num' + (ok ? (pf < 0 ? ' neg' : ' pos') : '');
          cp.innerHTML = ok ? fmt(pf) : '<span class="hint">—</span>';
        });
        const linesCost = money(costTotal);

        // البنود الإضافية
        let extrasCost = 0, extrasCount = 0;
        $$('.extra-row', b).forEach((row) => {
          const amtInp = $('[data-ex="amount"]', row);
          const name = $('[data-ex="name"]', row).value.trim();
          const v = read(amtInp);
          amtInp.classList.toggle('bad', Number.isNaN(v));
          if (Number.isNaN(v)) { bad++; return; }
          if (!name && v === null) return;   // سطر فارغ تماماً: يُتجاهل
          extrasCost += (v || 0);
          extrasCount++;
        });
        extrasCost = money(extrasCost);

        costTotal = money(linesCost + extrasCost);
        const profit = calcProfit(info.revenue, costTotal);
        const margin = info.revenue > 0 && profit !== null ? r2((profit / info.revenue) * 100) : 0;
        const missing = inputs.length - filled;
        const anyCost = filled > 0 || extrasCount > 0;
        // بلا أي تكلفة لا يوجد ربح يُحسب: إظهار المبيعات كاملة كربح مضلّل
        const pcls = profit < 0 ? 'neg' : 'pos';
        const breakdown = [
          missing ? `أصناف بلا تكلفة: ${missing}` : '',
          extrasCount ? `إضافية: ${fmt(extrasCost)}` : '',
        ].filter(Boolean).join(' • ');
        $('#costSum', b).innerHTML = `
          <div class="stat"><span>إجمالي البيع${info.vatEnabled ? ' <small>(قبل الضريبة)</small>' : ''}</span><b>${fmt(info.subtotal)}</b></div>
          <div class="stat"><span>إجمالي التكاليف</span><b>${anyCost ? fmt(costTotal) : '—'}</b>${breakdown ? `<small>${breakdown}</small>` : ''}</div>
          <div class="stat"><span>صافي الربح</span><b class="${anyCost ? pcls : ''}">${anyCost ? fmt(profit) : '—'}</b></div>
          <div class="stat"><span>هامش الربح</span><b class="${anyCost ? pcls : ''}">${anyCost ? fmtQty(margin) + '٪' : '—'}</b></div>`;
        $('#costErr', b).textContent = bad ? 'تكلفة غير صالحة: أدخل رقماً لا يقل عن صفر' : '';
        $('#costOk', b).disabled = bad > 0;
      }

      inputs.forEach((inp) => inp.addEventListener('input', recalc));
      $('#extraAdd', b).onclick = () => addExtra();
      $$('[data-preset]', b).forEach((p) => p.addEventListener('click', () => addExtra(p.dataset.preset)));
      renderExtras();
      recalc();
      requestAnimationFrame(() => { if (inputs[0]) inputs[0].focus({ preventScroll: true }); });

      $('#costCancel', b).onclick = closeModal;
      $('#costOk', b).onclick = async () => {
        const costs = {}, manual = {};
        let bad = false;
        inputs.forEach((inp) => {
          const v = read(inp);
          if (v === null) return;
          if (Number.isNaN(v)) { bad = true; return; }
          const r = rowOf(inp.dataset.ck);
          if (r.kind === 'manual') manual[r.idx] = money(v); else costs[r.key] = money(v);
        });
        // البنود الإضافية: يُحذف الفارغ تماماً، ويُسمّى ما له مبلغ بلا اسم
        const extras = [];
        $$('.extra-row', b).forEach((row) => {
          const name = $('[data-ex="name"]', row).value.trim();
          const v = read($('[data-ex="amount"]', row));
          if (Number.isNaN(v)) { bad = true; return; }
          if (!name && v === null) return;
          extras.push({ name: name || 'تكلفة إضافية', amount: money(v || 0) });
        });
        if (bad) { $('#costErr', b).textContent = 'تكلفة غير صالحة: أدخل رقماً لا يقل عن صفر'; return; }
        // تفريغ كل التكاليف من طلب كانت عليه = حذف تكاليف: صلاحية مستقلة (الخادم يرفضه أيضاً)
        const clearing = !Object.keys(costs).length && !Object.keys(manual).length && !extras.length && orderCost(o) !== null;
        if (clearing && !canClearCosts(o)) { $('#costErr', b).textContent = 'لا تملك صلاحية حذف تكاليف هذا الطلب'; return; }

        const before = JSON.parse(JSON.stringify(o));
        const prevCost = orderCost(o);
        o.costs = costs;
        o.extraCosts = extras;
        (o.manualRows || []).forEach((r, i) => { if (manual[i] !== undefined) r.cost = manual[i]; else delete r.cost; });
        const after = syncCostTotal(o);
        o.costUpdatedAt = Store.now(); o.costUpdatedByName = currentUser.name;
        o.updatedAt = o.costUpdatedAt; o.updatedByName = currentUser.name;

        const newCost = orderCost(o);
        const ev = logActivity('cost', o, [
          `التكاليف: من ${prevCost === null ? 'غير محددة' : fmt(prevCost)} إلى ${newCost === null ? 'غير محددة' : fmt(newCost)}`,
          after.entered ? `صافي الربح ${fmt(after.profit)} (هامش ${fmtQty(after.margin)}٪)` : 'لا تكاليف مسجّلة على الطلب',
          after.entered ? `تكاليف الأصناف ${fmt(after.linesCost)} • إضافية ${fmt(after.extrasCost)}` : '',
          after.extras.length ? `بنود إضافية: ${after.extras.map((e) => `${e.name} ${fmt(e.amount)}`).join('، ')}` : '',
        ].filter(Boolean));
        if (!(await Store.save())) {
          // إرجاع الطلب كما كان حتى لا تبقى أرقام لم تصل الخادم
          const i = db().orders.findIndex((x) => x.id === o.id);
          if (i >= 0) db().orders[i] = before;
          if (ev) db().activity = db().activity.filter((x) => x.id !== ev.id);
          $('#costErr', b).textContent = humanError(Store.lastError);
          return;
        }
        // مزامنة الطلب المفتوح في صفحة التصميم إن كان نفسه
        if (cur.id === o.id) {
          ownVersion(o.updatedAt);   // تعديلنا نحن: لا يُعدّ تعارضاً عند حفظ الطلب المفتوح
          cur.costs = JSON.parse(JSON.stringify(o.costs));
          cur.extraCosts = JSON.parse(JSON.stringify(o.extraCosts));
          if (o.costTotal === undefined) delete cur.costTotal; else cur.costTotal = o.costTotal;
          (cur.manualRows || []).forEach((r, i) => {
            const src = (o.manualRows || [])[i];
            if (src && src.cost !== undefined) r.cost = src.cost; else delete r.cost;
          });
        }
        closeModal();
        renderOrders();
        toast(`حُفظت تكاليف الطلب #${o.number} — صافي الربح ${fmt(after.profit)}`);
      };
    }, 'drawer wide');
  }

  /** نافذة تعديل نسب عمولة الطلب (تحسب على صافي الربح) */
  function commissionForm(o) {
    /* نسب العمولة للمدير وحده — لا تُفتح بتغيّر رؤية التكاليف */
    if (!o || !can('admin.core')) return;
    const profit = orderProfit(o);
    const cur$ = esc(currency());
    const seller = esc(o.createdByName || 'غير محدد');
    const isMan = isMandoub(o);
    const actor = isMan ? 'المندوب' : 'البائع';
    const ownerRate = orderOwnerRate(o);
    const shareRate = commRatesOf(o).shareRate;
    const ownerLabel = isMan ? 'نسبة المندوب لهذا الطلب' : 'نسبة البائع لهذا الطلب';
    const shareField = isMan ? '' : `<label>نسبة المشاركة (لباقي البائعين والإدارة) % <input id="commShare" type="number" min="0" max="100" step="0.5" value="${shareRate}"></label>`;
    openModal(`نسبة العمولة — الطلب #${o.number}`, `
      <p class="hint">العميل <b>${esc(o.customer?.name || '—')}</b> • ${actor} <b>${seller}</b> • صافي الربح ${profit === null ? 'غير محدد (أدخل التكاليف أولاً)' : `<b class="num">${fmt(profit)}</b> ${cur$}`}</p>
      <div class="row2">
        <label>${ownerLabel} % <input id="commOwner" type="number" min="0" max="100" step="0.5" value="${ownerRate}"></label>
        ${shareField}
      </div>
      ${isMan ? '<p class="hint">المندوب خارج الشركة: عمولته مستقلة ولا تُشارك مع الفريق الداخلي.</p>' : '<p class="hint">نسبة المشاركة تُوزَّع بالتساوي على باقي البائعين والإدارة في آخر الشهر.</p>'}
      <div class="cost-sum" id="commSum"></div>
      <p id="commErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="commCancel">إلغاء</button><button class="btn primary" id="commOk">${icon('save')} حفظ</button></div>`, (b) => {
      const inp = $('#commOwner', b);
      const inpShare = isMan ? null : $('#commShare', b);
      const recalc = () => {
        const r = Math.min(100, Math.max(0, num(inp.value)));
        const rs = inpShare ? Math.min(100, Math.max(0, num(inpShare.value))) : 0;
        const amt = profit === null ? null : money(profit * r / 100);
        const sh = profit === null ? 0 : money(profit * rs / 100);
        const rows = [
          `<div class="stat"><span>صافي الربح</span><b>${profit === null ? '—' : fmt(profit)}</b></div>`,
          `<div class="stat"><span>${ownerLabel}</span><b>${fmtQty(r)}٪</b></div>`,
          `<div class="stat"><span>عمولة ${isMan ? 'المندوب' : 'البائع'}</span><b>${amt === null ? '—' : fmt(amt)}</b></div>`,
        ];
        if (!isMan) {
          rows.push(`<div class="stat"><span>نسبة المشاركة</span><b>${fmtQty(rs)}٪</b></div>`);
          rows.push(`<div class="stat"><span>مبلغ المشاركة</span><b>${profit === null ? '—' : fmt(sh)}</b></div>`);
        }
        $('#commSum', b).innerHTML = rows.join('');
      };
      inp.addEventListener('input', recalc);
      if (inpShare) inpShare.addEventListener('input', recalc);
      recalc();
      $('#commCancel', b).onclick = closeModal;
      $('#commOk', b).onclick = async () => {
        const r = Math.min(100, Math.max(0, num(inp.value)));
        const rs = inpShare ? Math.min(100, Math.max(0, num(inpShare.value))) : 0;
        const before = JSON.parse(JSON.stringify(o));
        const prevOwner = orderOwnerRate(o);
        const prevShare = commRatesOf(o).shareRate;
        if (isMan) { o.mandoubRate = r; delete o.sellerRate; }
        else { o.sellerRate = r; o.shareRate = rs; }
        o.updatedAt = Store.now(); o.updatedByName = currentUser.name;
        const details = [`${ownerLabel}: من ${fmtQty(prevOwner)}٪ إلى ${fmtQty(r)}٪`];
        if (!isMan) details.push(`نسبة المشاركة: من ${fmtQty(prevShare)}٪ إلى ${fmtQty(rs)}٪`);
        const ev = logActivity('commission', o, details);
        if (!(await Store.save())) {
          const i = db().orders.findIndex((x) => x.id === o.id);
          if (i >= 0) db().orders[i] = before;
          if (ev) db().activity = db().activity.filter((x) => x.id !== ev.id);
          $('#commErr', b).textContent = humanError(Store.lastError);
          return;
        }
        if (cur.id === o.id) {
          if (isMan) { cur.mandoubRate = o.mandoubRate; }
          else { cur.sellerRate = o.sellerRate; cur.shareRate = o.shareRate; }
          ownVersion(o.updatedAt);
        }
        closeModal();
        renderOrders();
        toast(isMan ? `حُفظت نسبة المندوب ${fmtQty(r)}٪` : `حُفظت النسب — البائع ${fmtQty(r)}٪ • المشاركة ${fmtQty(rs)}٪`);
      };
    }, 'drawer');
  }

  $('#ordSearch').addEventListener('input', () => { ordersShown = PAGE_STEP; renderOrders(); });
  $('#ordFrom').addEventListener('change', () => { ordersShown = PAGE_STEP; renderOrders(); });
  $('#ordTo').addEventListener('change', () => { ordersShown = PAGE_STEP; renderOrders(); });
  $$('#ordStatusChips .chip').forEach((c) => c.addEventListener('click', () => {
    const k = c.dataset.stf;
    if (ordStatuses.has(k)) ordStatuses.delete(k); else ordStatuses.add(k);
    ordersShown = PAGE_STEP;
    renderOrders();
  }));
  $$('#ordTabs [data-otab]').forEach((b) => b.addEventListener('click', () => {
    ordStatuses.clear();
    ORD_TABS[b.dataset.otab].forEach((s) => ordStatuses.add(s));
    ordersShown = PAGE_STEP;
    renderOrders();
  }));
  $('#ordOverChip').addEventListener('click', () => { ordOverOnly = !ordOverOnly; ordersShown = PAGE_STEP; renderOrders(); });
  $('#ordClearFilters').addEventListener('click', () => {
    ordStatuses.clear();
    ordOverOnly = false;
    $('#ordSearch').value = ''; $('#ordFrom').value = ''; $('#ordTo').value = '';
    ordersShown = PAGE_STEP;
    renderOrders();
  });
  $('#ordersEmptyClear').addEventListener('click', () => $('#ordClearFilters').click());
  $('#ordersEmptyNew').addEventListener('click', async () => { await startNewOrder(); showPage('order'); });
  $('#ordersNew').addEventListener('click', async () => { await startNewOrder(); showPage('order'); });

  /* ---------------- صفحة العملاء ----------------
     سجل مشتق من الطلبات (انظر customersIndex): لكل عميل طلباته ومبيعاته والمتبقي
     عليه وآخر طلب، مع فتح طلباته أو بدء طلب جديد له ببياناته. */
  let custShown = PAGE_STEP;
  function renderCustomers() {
    const q = latinDigits($('#custSearch').value).trim().toLowerCase();
    const sort = $('#custSort').value;
    let list = [...customersIndex().values()];
    if (q) list = list.filter((c) => [c.name, c.phone, c.address].some((v) => latinDigits(v).toLowerCase().includes(q)));
    const sorters = {
      last: (a, b) => b.last.localeCompare(a.last),
      sales: (a, b) => b.sales - a.sales,
      remaining: (a, b) => b.remaining - a.remaining,
      orders: (a, b) => b.orders.length - a.orders.length,
    };
    list.sort(sorters[sort] || sorters.last);
    const all = [...customersIndex().values()];
    const owing = all.filter((c) => c.remaining > 0.5);
    $('#custStats').innerHTML = `
      <div class="stat"><span>عدد العملاء</span><b>${all.length}</b></div>
      <div class="stat"><span>عملاء متكررون</span><b>${all.filter((c) => c.orders.filter(isSale).length > 1).length}</b><small>أكثر من طلب</small></div>
      <div class="stat remaining"><span>عملاء عليهم مبالغ</span><b>${owing.length}</b><small>${owing.length ? `بإجمالي ${fmt(owing.reduce((s, c) => s + c.remaining, 0))}` : 'لا متأخرات'}</small></div>
      <div class="stat"><span>عروض أسعار مفتوحة</span><b>${all.reduce((s, c) => s + c.quotes, 0)}</b></div>`;
    const tb = $('#custTable tbody');
    $('#custEmpty').hidden = list.length > 0;
    $('#custEmptyText').textContent = q ? 'لا يوجد عميل يطابق البحث' : 'لا يوجد عملاء بعد — يظهر العميل هنا بعد حفظ أول طلب له';
    const shown = list.slice(0, custShown);
    tb.innerHTML = shown.map((c) => `
      <tr>
        <td data-label="العميل" class="c-cust span2"><b>${esc(c.name || '—')}</b>${c.address ? `<span class="sub">${esc(c.address)}</span>` : ''}</td>
        <td data-label="الجوال" class="num">${esc(c.phone || '—')}</td>
        <td data-label="الطلبات" class="num">${c.orders.filter(isSale).length}${c.quotes ? ` <small class="hint">+ ${c.quotes} عرض</small>` : ''}</td>
        <td data-label="المبيعات" class="num">${fmt(c.sales)}</td>
        <td data-label="المتبقي" class="num ${c.remaining > 0.5 ? 'warn-num' : ''}">${fmt(c.remaining)}</td>
        <td data-label="آخر طلب" class="num">${esc(fmtDate(c.last))}</td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-cust-orders="${esc(c.key)}">${icon('list')} طلباته</button>
          ${rowMenu([
            menuItem(`data-cust-new="${esc(c.key)}"`, 'plus', 'طلب جديد لهذا العميل'),
            c.phone ? menuItem(`data-cust-wa="${esc(c.key)}"`, 'whatsapp', 'محادثة واتساب') : '',
          ], `إجراءات العميل ${esc(c.name || '')}`)}
        </span></td>
      </tr>`).join('');
    renderMoreBar($('#custMore'), shown.length, list.length, () => { custShown += PAGE_STEP; renderCustomers(); });
    const byKey = (k) => customersIndex().get(k);
    $$('[data-cust-orders]', tb).forEach((b) => b.addEventListener('click', () => {
      const c = byKey(b.dataset.custOrders); if (!c) return;
      ordStatuses.clear(); $('#ordFrom').value = ''; $('#ordTo').value = '';
      $('#ordSearch').value = c.phone || c.name;
      ordersShown = PAGE_STEP;
      showPage('orders');
    }));
    $$('[data-cust-new]', tb).forEach((b) => b.addEventListener('click', async () => {
      const c = byKey(b.dataset.custNew); if (!c) return;
      if (dirty && !(await confirmDlg('طلب جديد', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) return;
      await startNewOrder(true);
      cur.customer = { name: c.name, phone: c.phone, address: c.address };
      fillOrderForm();
      setDirty(true);
      showPage('order');
      toast(`طلب جديد للعميل ${c.name}`);
    }));
    $$('[data-cust-wa]', tb).forEach((b) => b.addEventListener('click', () => {
      const c = byKey(b.dataset.custWa); if (!c) return;
      openExternal(`https://wa.me/${waPhone(c.phone)}`);
    }));
    prepareControls(tb);
  }
  $('#custSearch').addEventListener('input', () => { custShown = PAGE_STEP; renderCustomers(); });
  $('#custSort').addEventListener('change', renderCustomers);
  /** عميل جديد: نفس تدفق الطلب الحالي، يفتح مباشرة على مرحلة العميل (بلا منطق مكرر) */
  const btnCustNew = $('#btnCustNew');
  if (btnCustNew) btnCustNew.addEventListener('click', async () => {
    await startNewOrder();
    showStage('customer');
    setTimeout(() => { const n = $('#custName'); if (n) n.focus({ preventScroll: true }); }, 120);
  });
  $('#btnCustCsv').addEventListener('click', () => {
    const list = [...customersIndex().values()].sort((a, b) => b.sales - a.sales);
    if (!list.length) { toast('لا توجد بيانات للتصدير', 'info'); return; }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['العميل', 'الجوال', 'العنوان', 'الطلبات', 'عروض الأسعار', 'المبيعات قبل الضريبة', 'المتبقي', 'آخر طلب'].map(cell).join(',')];
    list.forEach((c) => rows.push([c.name, c.phone, c.address, c.orders.filter(isSale).length, c.quotes, money(c.sales), money(c.remaining), fmtDate(c.last)].map(cell).join(',')));
    downloadBlob(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `customers-${today()}.csv`);
  });

  /* ---------------- صفحة الأصناف ---------------- */
  function catLabel(cat) {
    if (cat === 'sofa') return 'كنب';
    if (cat === 'acc') return 'إكسسوار';
    const s = SPECS.find((x) => x.cat === cat);
    return s ? s.label : cat;
  }

  /* تبويب لكل فئة بدل قائمة واحدة مختلطة: إدارة الأسعار تجري داخل فئة واحدة
     في كل مرة. «كنب» فئة قديمة لا يُنشأ منها جديد، فتبويبها لا يظهر إلا إن
     بقيت أصناف عليها — وإلا صارت أصنافاً لا يمكن الوصول إليها. */
  const ITEM_TABS = [
    { cat: 'wood', label: 'الجلسات' },
    { cat: 'fabric', label: 'الأقمشة' },
    { cat: 'foam', label: 'الإسفنج' },
    { cat: 'acc', label: 'الإكسسوارات' },
  ];
  let itemsCat = ITEM_TABS[0].cat;

  function renderItemTabs(counts) {
    const tabs = ITEM_TABS.concat(counts.sofa ? [{ cat: 'sofa', label: 'كنب (فئة قديمة)' }] : []);
    if (!tabs.some((t) => t.cat === itemsCat)) itemsCat = ITEM_TABS[0].cat;
    const box = $('#itemsTabs');
    box.innerHTML = tabs.map((t) => `
      <button type="button" role="tab" data-cat="${t.cat}" class="${t.cat === itemsCat ? 'active' : ''}" aria-selected="${t.cat === itemsCat}" aria-controls="itemsTable">
        ${t.label}<span class="tab-count">${counts[t.cat] || 0}</span>
      </button>`).join('');
    $$('[data-cat]', box).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.cat === itemsCat) return;
      itemsCat = b.dataset.cat;
      itemsShown = PAGE_STEP;   // التبويب الجديد يبدأ من أوله لا من موضع سابقه
      renderItems();
    }));
  }

  function renderItems() {
    const counts = {};
    db().items.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; });
    renderItemTabs(counts);

    const tb = $('#itemsTable tbody');
    const all = db().items.filter((i) => i.category === itemsCat).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const items = all.slice(0, itemsShown);
    tb.innerHTML = items.map((i) => `
      <tr class="${i.active === false ? 'is-off' : ''}">
        <td data-label="الصنف" class="span2"><b>${esc(i.name)}</b></td>
        <td data-label="الفئة">${catLabel(i.category)}</td>
        <td data-label="ملاحظة">${i.category === 'sofa' ? '<span class="hint">فئة قديمة</span>' : '—'}</td>
        <td data-label="الوحدة">${i.category === 'acc' ? 'قطعة' : 'متر'}</td>
        <td data-label="السعر" class="num">${fmt(i.price)} ${currency()}</td>
        <td data-label="الأبعاد الافتراضية" class="num">${i.category === 'acc' ? `${i.w || 0.5} × ${i.h || 0.5} م ${i.shape === 'circle' ? '(دائري)' : ''}` : (i.category === 'wood' || i.category === 'sofa' ? `عمق ${i.depth || 0.8} م` : '—')}</td>
        <td data-label="اللون"><span class="color-dot" style="background:${esc(i.color || '#888')}"></span></td>
        <td data-label="الحالة"><span class="badge ${i.active === false ? 'st-quote' : 'st-delivered'}">${i.active === false ? 'موقوف' : 'نشط'}</span></td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-edit="${i.id}">${icon('pen')} تعديل</button>
          ${rowMenu([
            menuItem(`data-toggle="${i.id}"`, i.active === false ? 'check' : 'lock', i.active === false ? 'تفعيل الصنف' : 'إيقاف الصنف'),
            '<hr>' + menuItem(`data-del="${i.id}"`, 'trash', 'حذف الصنف', true),
          ], `إجراءات الصنف ${esc(i.name)}`)}
        </span></td>
      </tr>`).join('') || `<tr><td colspan="9" class="empty">لا توجد أصناف في هذه الفئة بعد — أضف أول صنف من زر «صنف جديد».</td></tr>`;

    renderMoreBar($('#itemsMore'), items.length, all.length, () => { itemsShown += PAGE_STEP; renderItems(); });

    $$('[data-edit]', tb).forEach((b) => b.addEventListener('click', () => itemForm(Store.getItem(b.dataset.edit))));
    $$('[data-toggle]', tb).forEach((b) => b.addEventListener('click', async () => {
      const it = Store.getItem(b.dataset.toggle);
      it.active = it.active === false;
      if (!(await Store.save())) { it.active = !it.active; toast(humanError(Store.lastError), true); }
      afterItemsChange();
    }));
    $$('[data-del]', tb).forEach((b) => b.addEventListener('click', async () => {
      const it = Store.getItem(b.dataset.del);
      const used = db().orders.filter((o) => itemUsedIn(o, it.id)).length;
      // الكنبة تشير إلى الخشب والقماش والإسفنج لا إلى itemId، وسعر مترها مجموعها:
      // حذف أحدها يُنقص سعر تلك السطور فعلياً — والتحذير يجب أن يقول ذلك بصراحة.
      const priced = SPEC_CATS.includes(it.category);
      const msg = used
        ? `الصنف "${it.name}" مستخدم في ${used} طلب.` + (priced
          ? ` حذفه سيُنقص سعر متر الكنب في تلك الطلبات بمقدار ${fmt(it.price)} ${currency()}. يُفضّل إيقافه بدلاً من حذفه. حذف نهائي؟`
          : ` عند حذفه سيظهر باسم "صنف محذوف" في تلك الطلبات. يُفضّل إيقافه بدلاً من حذفه. حذف نهائي؟`)
        : `حذف الصنف "${it.name}"؟`;
      if (!(await confirmDlg('حذف صنف', msg))) return;
      db().items = db().items.filter((x) => x.id !== it.id);
      if (!(await Store.save())) { toast(humanError(Store.lastError), true); await Store.refresh().catch(() => {}); afterItemsChange(); return; }
      afterItemsChange();
      toast('تم حذف الصنف');
    }));
  }

  function afterItemsChange() {
    renderItems();
    renderItemSelects();
    renderPricing();
    designer.render();
    renderInspector(designer.selectionInfo());
  }

  /** presetCat: فئة التبويب المفتوح — الصنف الجديد يُنشأ حيث يقف المستخدم */
  function itemForm(item, presetCat) {
    const cat0 = presetCat && presetCat !== 'sofa' ? presetCat : 'wood';
    const it = item || { name: '', category: cat0, price: 0, depth: 0.8, w: 0.5, h: 0.5, shape: 'rect', color: cat0 === 'acc' ? '#7f8c8d' : '#8b5a2b', active: true };
    openModal(item ? 'تعديل صنف' : 'صنف جديد', `
      <label>اسم الصنف <input id="fName" value="${esc(it.name)}" required></label>
      <div class="row2">
        <label>الفئة <select id="fCat">
          ${SPECS.map((s) => `<option value="${s.cat}" ${it.category === s.cat ? 'selected' : ''}>${s.label} (يُسعّر بالمتر)</option>`).join('')}
          <option value="acc" ${it.category === 'acc' ? 'selected' : ''}>إكسسوار (يُسعّر بالقطعة)</option>
          ${it.category === 'sofa' ? '<option value="sofa" selected>كنب (فئة قديمة)</option>' : ''}
        </select></label>
        <label id="fPriceLbl">السعر (${currency()}) <input id="fPrice" type="number" min="0" step="1" value="${it.price}"></label>
      </div>
      <div id="fSofa">
        <div class="row2">
          <label>العمق الافتراضي (م) <input id="fDepth" type="number" min="0.3" step="0.05" value="${it.depth || 0.8}"></label>
          <label>اللون في التصميم <input id="fColor" type="color" value="${esc(it.color || '#8b5a2b')}"></label>
        </div>
        <p class="hint" id="fSofaHint"></p>
      </div>
      <p id="fSpecHint" class="hint" hidden></p>
      <div id="fAcc">
        <div class="row2">
          <label>الطول (م) <input id="fW" type="number" min="0.1" step="0.05" value="${it.w || 0.5}"></label>
          <label>العرض (م) <input id="fH" type="number" min="0.1" step="0.05" value="${it.h || 0.5}"></label>
        </div>
        <div class="row2">
          <label>الشكل <select id="fShape"><option value="rect" ${it.shape !== 'circle' ? 'selected' : ''}>مستطيل</option><option value="circle" ${it.shape === 'circle' ? 'selected' : ''}>دائري</option></select></label>
          <label>اللون في التصميم <input id="fColor2" type="color" value="${esc(it.color || '#7f8c8d')}"></label>
        </div>
      </div>
      <p id="fErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="fCancel">إلغاء</button><button class="btn primary" id="fSave">حفظ</button></div>`, (b) => {
      const sync = () => {
        const cat = $('#fCat', b).value;
        const isSpec = SPEC_CATS.includes(cat);
        // الخشب والقماش والإسفنج تشترك في: سعر بالمتر + لون على المخطط
        $('#fSofa', b).hidden = !(isSpec || cat === 'sofa');
        $('#fAcc', b).hidden = cat !== 'acc';
        $('#fSpecHint', b).hidden = !isSpec;
        const s = SPECS.find((x) => x.cat === cat);
        if (s) $('#fSpecHint', b).textContent = `سعر المتر لهذا الخيار. سعر متر الكنبة = الخشب + القماش + الإسفنج.`;
        $('#fSofaHint', b).textContent = cat === 'fabric'
          ? 'لون القماش هو ما يظهر على قطع الكنب في المخطط.'
          : (cat === 'wood' ? 'العمق الافتراضي يُستعمل عند إضافة كنبة بهذا الخشب.' : '');
        $('#fPriceLbl', b).firstChild.textContent = cat === 'acc' ? `السعر (${currency()}) ` : `سعر المتر (${currency()}) `;
      };
      $('#fCat', b).addEventListener('change', sync); sync();
      $('#fCancel', b).onclick = closeModal;
      $('#fSave', b).onclick = async () => {
        const name = $('#fName', b).value.trim();
        if (!name) { $('#fErr', b).textContent = 'اسم الصنف مطلوب'; return; }
        const cat = $('#fCat', b).value;
        const byMetre = cat !== 'acc';
        const data = {
          name, category: cat, unit: byMetre ? 'm' : 'pc', price: Math.max(0, money($('#fPrice', b).value)),
          depth: Math.max(0.3, num($('#fDepth', b).value) || 0.8),
          w: Math.max(0.1, num($('#fW', b).value) || 0.5), h: Math.max(0.1, num($('#fH', b).value) || 0.5),
          shape: $('#fShape', b).value, color: byMetre ? $('#fColor', b).value : $('#fColor2', b).value,
        };
        // الصنف يُجلب بمعرّفه الآن: المرجع الملتقط عند فتح النافذة قد تكون المزامنة استبدلته
        const live = item ? Store.getItem(item.id) : null;
        if (live) Object.assign(live, data);
        else db().items.push(Object.assign({ id: (item && item.id) || Store.uid(), active: item ? item.active !== false : true }, data));
        if (!(await Store.save())) { $('#fErr', b).textContent = humanError(Store.lastError); return; }
        itemsCat = cat;   // فئة الصنف قد تخالف التبويب المفتوح: نُظهر ما حُفظ للتو
        closeModal(); afterItemsChange();
        toast('تم حفظ الصنف');
      };
    }, 'drawer');
  }
  $('#btnAddItem').addEventListener('click', () => itemForm(null, itemsCat));

  /* ---------------- صفحة المستخدمين ---------------- */
  function renderUsers() {
    const tb = $('#usersTable tbody');
    // الصفحة لمن يملك users.view؛ الإضافة والتعديل والحذف للمدير وحده (صلاحيات لا تُمنح لغيره)
    $('#btnAddUser').hidden = !can('users.create');
    /* حسابات المديرين يعدّلها ويحذفها مالك النظام وحده، والمالك لا يُحذف (الخادم يفرض ذلك) */
    const owner = can('admin.core');
    const canEditU = (u) => can('users.edit') && (u.role !== 'admin' || owner);
    const canDelU = (u) => can('users.disable') && u.id !== currentUser.id && !u.isOwner && (u.role !== 'admin' || owner);
    const note = $('#ownerNote');
    if (note) {
      const notConfigured = isAdmin() && Store.ownerConfigured === false;
      note.hidden = !(notConfigured || owner);
      note.innerHTML = notConfigured
        ? `لم يُحدَّد <b>مالك النظام</b> بعد: إدارة المديرين والصلاحيات المحمية معطّلة. يضبطه صاحب حساب Cloudflare بالمتغير <code>OWNER_USER_ID</code> = معرّف حسابه. معرّف حسابك: <code class="ltr">${esc(currentUser.id)}</code>`
        : 'أنت <b>مالك النظام</b>: وحدك تنشئ المديرين وتعدّل حساباتهم وتمنح الصلاحيات المحمية.';
    }
    tb.innerHTML = db().users.map((u) => `
      <tr class="${u.active === false ? 'is-off' : ''}">
        <td data-label="الاسم"><b>${esc(u.name)}</b>${u.isOwner ? ' <span class="badge st-delivered">مالك النظام</span>' : ''}${u.id === currentUser.id ? ' <span class="badge">أنت</span>' : ''}</td>
        <td data-label="اسم المستخدم" class="num">${esc(u.username)}</td>
        <td data-label="الدور">${ROLES[u.role] || u.role}</td>
        <td data-label="الحالة"><span class="badge ${u.active === false ? 'st-quote' : 'st-delivered'}">${u.active === false ? 'موقوف' : 'نشط'}</span></td>
        <td data-label="عدد الطلبات" class="num">${db().orders.filter((o) => o.createdBy === u.id).length}</td>
        <td class="row-actions"><span class="ra">
          ${canEditU(u) ? `<button class="btn small" data-edit="${u.id}">${icon('pen')} تعديل</button>` : ''}
          ${canDelU(u) ? rowMenu([menuItem(`data-del="${u.id}"`, 'trash', 'حذف المستخدم', true)], `إجراءات المستخدم ${esc(u.name)}`) : ''}
        </span></td>
      </tr>`).join('');
    $$('[data-edit]', tb).forEach((b) => b.addEventListener('click', () => userForm(Store.getUser(b.dataset.edit))));
    $$('[data-del]', tb).forEach((b) => b.addEventListener('click', async () => {
      const u = Store.getUser(b.dataset.del);
      if (u.role === 'admin' && db().users.filter((x) => x.role === 'admin' && x.active !== false).length <= 1) { toast('لا يمكن حذف آخر مدير في النظام', true); return; }
      if (!(await confirmDlg('حذف مستخدم', `حذف المستخدم "${u.name}"؟ ستبقى طلباته محفوظة باسمه.`))) return;
      try { await Store.deleteUser(u.id); renderUsers(); toast('تم حذف المستخدم'); }
      catch (e) { toast(e.message, true); }
    }));
  }

  /** تحميل وعرض تعديل صلاحيات مستخدم قائم — يُستدعى داخل نافذة تعديل المستخدم.
      يعيد isDirty() ليعرف زر «حفظ» المستخدم أن تعديلات الصلاحيات لم تُحفظ بعد. */
  function setupUserPermissions(b, user) {
    const hint = $('#uPermRoleHint', b);
    const err = $('#uPermErr', b);
    if (!hint || !err) return { isDirty: () => false };
    let data = null;
    let savedJson = '{}'; // آخر تجاوزات محفوظة في الخادم: مرجع «غير محفوظ»
    const roleSel = $('#uRole', b), activeSel = $('#uActive', b);
    const ovJson = () => JSON.stringify(Object.keys((data && data.overrides) || {}).sort().map((k) => [k, Number(data.overrides[k])]));
    const isDirty = () => !!data && ovJson() !== savedJson;

    const load = async () => {
      try {
        data = await Store.api('GET', '/api/users/' + encodeURIComponent(user.id) + '/permissions');
      } catch (e) {
        data = null;
        err.textContent = (e && e.message) || 'تعذر تحميل الصلاحيات';
        return null;
      }
      return data;
    };

    const render = () => {
      if (!data) return;
      /* الدور المعروض = المختار في النافذة الآن (قد لا يكون محفوظاً بعد). التجاوزات اليدوية
         لا تُمس عند تغييره: تبقى مستقلة، والافتراضيات وحدها تتبع الدور الجديد.
         خادم أقدم بلا roleDefaults: تبقى افتراضيات الدور المحفوظ. */
      const viewRole = (roleSel && roleSel.value) || data.role;
      const rd = data.roleDefaults && data.roleDefaults[viewRole];
      const pendingRole = viewRole !== data.role;
      const defaults = new Set(rd || data.defaults || []);
      const overrides = data.overrides || {};
      const inactive = !!(activeSel && activeSel.value === '0');
      const roleName = (r) => ({ admin: 'مدير', staff: 'موظف', mandoub: 'مندوب' }[r] || r);
      hint.textContent = '· الدور: ' + roleName(viewRole)
        + (pendingRole ? (rd ? ' (غير محفوظ — احفظ المستخدم لتطبيقه)' : ' (تُحدَّث الافتراضيات بعد حفظ المستخدم)') : '')
        + (inactive ? ' · الحساب موقوف: لا صلاحيات فعّالة' : '');
      const isFalse = (v) => v === false || v === 0 || v === '0' || v === 'false';
      const isTrue = (v) => v === true || v === 1 || v === '1' || v === 'true';
      /* الإدارة الكاملة: لا تُمنح لغير المدير، ويمنحها لمدير عادي مالك النظام وحده (الخادم يفرض ذلك).
         مالك النظام نفسه: كل الصلاحيات ثابتة لا تُعدَّل. */
      const ownerTarget = data.targetIsOwner === true;
      if (ownerTarget) hint.textContent += ' · مالك النظام: كل الصلاحيات كاملة وثابتة';
      const adminLocked = (p) => PERM_ADMIN_ONLY.includes(p) && (viewRole !== 'admin' || data.actorIsOwner !== true);
      const effOf = (p) => {
        if (ownerTarget) return true;
        if (inactive) return false; // الخادم يرفض كل شيء للموقوف
        if (PERM_PROTECTED.includes(p)) return false; // admin.core للمالك وحده
        if (adminLocked(p) && viewRole !== 'admin') return false; // الإدارة الكاملة لا تُمنح لغير المدير
        if (isFalse(overrides[p])) return false;
        if (isTrue(overrides[p])) return true;
        return defaults.has(p);
      };
      const curOf = (p) => (Object.prototype.hasOwnProperty.call(overrides, p) ? (isFalse(overrides[p]) ? '0' : '1') : 'default');
      $('#uPermList', b).innerHTML = PERM_UI.map(([cat, items]) => `
        <div class="perm-cat">${esc(cat)}</div>
        ${items.map(([p, label]) => {
          const prot = ownerTarget || PERM_PROTECTED.includes(p) || adminLocked(p);
          const eff = effOf(p);
          const cur = curOf(p);
          const defLabel = defaults.has(p) ? 'مسموح' : 'ممنوع';
          const lock = (txt, tip) => `<span class="perm-lock" title="${tip}"><svg><use href="#i-lock"/></svg> ${txt}</span>`;
          const ctrls = prot
            ? (ownerTarget ? lock('ثابتة للمالك', 'صلاحيات مالك النظام كاملة ولا تُعدَّل')
              : PERM_PROTECTED.includes(p) ? lock('للمالك وحده', 'admin.core لمالك النظام وحده — لا تُمنح لأحد')
              : viewRole !== 'admin' ? lock('للمدير فقط', 'الإدارة الكاملة لا تُمنح لموظف أو مندوب')
              : lock('يمنحها المالك', 'منح الإدارة الكاملة لمدير عادي وسحبها لمالك النظام وحده'))
            : `<div class="perm-tri" role="group" aria-label="${esc(label)}">
                 <button type="button" data-p="${esc(p)}" data-v="default" class="${cur === 'default' ? 'on' : ''}" title="افتراضي الدور: ${defLabel}">افتراضي</button>
                 <button type="button" data-p="${esc(p)}" data-v="1" class="${cur === '1' ? 'on perm-allow' : ''}">مسموح</button>
                 <button type="button" data-p="${esc(p)}" data-v="0" class="${cur === '0' ? 'on perm-deny' : ''}">ممنوع</button>
               </div>`;
          return `<div class="perm-row${prot ? ' is-locked' : ''}">
            <div class="perm-info"><span class="perm-name">${esc(label)}</span><span class="perm-key">${esc(p)}</span></div>
            <span class="perm-eff ${eff ? 'is-ok' : 'is-no'}">${eff ? 'مسموح' : 'ممنوع'}</span>
            ${ctrls}
          </div>`;
        }).join('')}`).join('');
      $$('#uPermList .perm-tri button', b).forEach((btn) => btn.addEventListener('click', () => {
        const p = btn.dataset.p, v = btn.dataset.v;
        const ov = Object.assign({}, data.overrides || {});
        if (v === 'default') delete ov[p]; else ov[p] = Number(v);
        data = Object.assign({}, data, { overrides: ov });
        render();
      }));
      $('#uPermDirty', b).hidden = !isDirty();
    };

    const setBusy = (off) => { $('#uPermSave', b).disabled = off; $('#uPermReset', b).disabled = off; };
    const reload = async () => {
      setBusy(true);
      if (!(await load())) return; // فشل التحميل: لا تعديل ولا حفظ (يُبقي الأزرار معطّلة)
      /* فشل مُغلق: الخادم لم يستطع قراءة التجاوزات — الحفظ هنا قد يمسح الموجود، فيُمنع. */
      if (data.permissionsLoadFailed) {
        err.textContent = 'تعذرت قراءة الصلاحيات المحفوظة — أعد فتح النافذة لاحقاً (لا يُسمح بالحفظ الآن)';
        data = null; $('#uPermList', b).innerHTML = ''; return;
      }
      err.textContent = '';
      savedJson = ovJson();
      setBusy(data.targetIsOwner === true); // صلاحيات المالك ثابتة: لا حفظ ولا إعادة
      render();
    };
    if (roleSel) roleSel.addEventListener('change', render);
    if (activeSel) activeSel.addEventListener('change', render);
    reload();

    $('#uPermSave', b).onclick = async () => {
      err.textContent = '';
      if (!data) return;
      try {
        /* الصلاحيات الإدارية: يرسلها المالك وحده (الخادم يرفضها من غيره حتى للمنع)، ولا تُرسل
           منحاً لغير مدير (منح قديم مخزّن يُسقط) */
        const ov = Object.fromEntries(Object.entries(data.overrides || {}).filter(([k, v]) => !PERM_ADMIN_ONLY.includes(k)
          || (data.actorIsOwner === true && !(data.role !== 'admin' && Number(v) === 1))));
        await Store.api('POST', '/api/users/' + encodeURIComponent(user.id) + '/permissions', { overrides: ov });
        toast('تم حفظ الصلاحيات');
        await reload();
      } catch (e) { err.textContent = (e && e.message) || 'تعذر حفظ الصلاحيات'; }
    };
    /* تأكيد داخل النافذة بضغطة ثانية: confirmDlg يستبدل محتوى النافذة نفسها فيُغلق نموذج المستخدم */
    const resetBtn = $('#uPermReset', b), resetLabel = resetBtn.textContent;
    let resetTimer = 0;
    const disarmReset = () => { clearTimeout(resetTimer); resetTimer = 0; resetBtn.textContent = resetLabel; resetBtn.classList.remove('danger'); };
    resetBtn.onclick = async () => {
      if (!resetTimer) {
        resetBtn.textContent = 'اضغط مرة أخرى للتأكيد';
        resetBtn.classList.add('danger');
        err.textContent = 'ستُمسح كل تجاوزات هذا المستخدم ويعود إلى افتراضي دوره.';
        resetTimer = setTimeout(() => { disarmReset(); err.textContent = ''; }, 6000);
        return;
      }
      disarmReset();
      err.textContent = '';
      try {
        await Store.api('DELETE', '/api/users/' + encodeURIComponent(user.id) + '/permissions');
        toast('أُعيدت الصلاحيات إلى افتراضي الدور');
        await reload();
      } catch (e) { err.textContent = (e && e.message) || 'تعذرت الإعادة'; }
    };
    return { isDirty };
  }

  function userForm(user) {
    const u = user || { name: '', username: '', role: 'staff', active: true };
    // قسم الصلاحيات لمن يملك permissions.manage فقط (الخادم يرفض غيره بـ 403 على أي حال)
    const canPerms = Store.can('permissions.manage');
    /* رقم واتساب للمستخدم: يربطه بقائمة «المستلمين» فيُستخدم رقمه عند إرسال التنبيهات.
       يظهر لمن يدير إشعارات واتساب ويراها (القائمة تحمل الرقم المرتبط لهذا الصنف فقط). */
    const WAN = window.WaNotify;
    const canWa = !!WAN && Store.isRemote && can('notifications.whatsapp.manage') && can('notifications.whatsapp.view');
    const uw = (u && u.wa) || null;
    const waSec = canWa ? `<div class="perm-section wa-user-sec" id="uWaSec">
        <div class="perm-head"><b>تنبيهات واتساب</b><span class="hint">اختياري</span></div>
        <label>رقم واتساب <input id="uWaPhone" type="tel" inputmode="tel" class="ltr num" autocomplete="off" placeholder="05XXXXXXXX" value="${esc(uw ? WAN.formatPhone(uw.phone) : '')}" aria-describedby="uWaHint"></label>
        <p class="hint" id="uWaHint">يُضاف المستخدم إلى «مستلمي التنبيهات» ويُستخدم رقمه عند إرسال تنبيه واتساب. اتركه فارغاً لإزالته من المستلمين.</p>
        <div class="wa-user-events" role="group" aria-label="التنبيهات التي تصله تلقائياً">
          <span class="hint">التنبيهات التي يُختار لها تلقائياً:</span>
          ${WAN.TYPES.map((t) => `<label class="check"><input type="checkbox" data-uwaev="${t}"${uw && uw.events.includes(t) ? ' checked' : ''}> ${esc(WAN.TYPE_ICONS[t] || '')} ${esc(WAN.TYPE_LABELS[t])}</label>`).join('')}
        </div>
        ${uw && !uw.active ? '<p class="hint">التنبيهات لهذا الرقم <b>معطّلة</b> حالياً — فعّلها من «إشعارات واتساب ← المستلمون».</p>' : ''}
      </div>` : '';
    openModal(user ? 'تعديل مستخدم' : 'مستخدم جديد', `
      <label>الاسم الكامل <input id="uName" value="${esc(u.name)}"></label>
      <div class="row2">
        <label>اسم المستخدم <input id="uUser" value="${esc(u.username)}" autocomplete="off" class="ltr"></label>
        <label>${user ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور'} <input id="uPass" type="password" autocomplete="new-password" minlength="8" aria-describedby="uPassHint"></label>
      </div>
      <p class="hint" id="uPassHint">كلمة المرور: 8 أحرف فأكثر، لا تطابق اسم المستخدم، وليست شائعة مثل 12345678</p>
      <div class="row2">
        <label>الدور <select id="uRole"${u.isOwner ? ' disabled' : ''}><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>موظف</option><option value="mandoub" ${u.role === 'mandoub' ? 'selected' : ''}>مندوب</option>${(can('admin.core') || u.role === 'admin') ? `<option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مدير</option>` : ''}</select></label>
        <label>الحالة <select id="uActive"${u.isOwner ? ' disabled' : ''}><option value="1" ${u.active !== false ? 'selected' : ''}>نشط</option><option value="0" ${u.active === false ? 'selected' : ''}>موقوف</option></select></label>
      </div>
      ${u.isOwner ? '<p class="hint">حساب <b>مالك النظام</b>: دوره «مدير» ونشِط دائماً — لا يُخفَّض ولا يُعطَّل ولا يُحذف.</p>' : ''}
      ${(!can('admin.core') && !u.isOwner) ? '<p class="hint">إنشاء المديرين وتعديل حساباتهم لمالك النظام وحده.</p>' : ''}
      ${waSec}
      ${canPerms ? `<div class="perm-section" id="uPermSection">
        <div class="perm-head"><b>الصلاحيات</b><span class="hint" id="uPermRoleHint"></span><span class="perm-dirty" id="uPermDirty" hidden>تعديلات غير محفوظة</span></div>
        <p class="hint" id="uPermNewHint"${user ? ' hidden' : ''}>احفظ المستخدم أولاً، ثم عدّل صلاحياته من نافذة التعديل.</p>
        <div id="uPermBox"${user ? '' : ' hidden'}>
          <p class="hint">تجاوزات لهذا المستخدم فوق افتراضيات دوره. «افتراضي» = يعود لسلوك الدور؛ «ممنوع» يغلب «مسموح» دائماً. تُطبق فور الحفظ دون الحاجة إلى حساب جديد.</p>
          <div id="uPermList" class="perm-list"></div>
          <p id="uPermErr" class="error"></p>
          <div class="perm-actions">
            <button type="button" class="btn perm-reset" id="uPermReset">إعادة إلى افتراضي الدور</button>
            <button type="button" class="btn primary" id="uPermSave">حفظ الصلاحيات</button>
          </div>
        </div>
      </div>` : ''}
      <p class="hint">المدير يستطيع إدارة الأصناف والمستخدمين وحذف الطلبات. الموظف يستطيع إنشاء الطلبات وتعديلها واستعراضها. المندوب مثل الموظف لكنه فئة مستقلة تُحسب عمولته بنسبة المناديب لا بنسبة البائع.</p>
      <p id="uErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="uCancel">إلغاء</button><button class="btn primary" id="uSave">حفظ</button></div>`, (b) => {
      $('#uCancel', b).onclick = closeModal;
      const perms = (user && canPerms) ? setupUserPermissions(b, user) : { isDirty: () => false };
      let dirtyAck = false;
      $('#uSave', b).onclick = async () => {
        const name = $('#uName', b).value.trim(), username = $('#uUser', b).value.trim(), pass = $('#uPass', b).value;
        const role = $('#uRole', b).value, active = $('#uActive', b).value === '1';
        /* الخطأ يظهر حيث يراه المستخدم: سطر الخطأ أسفل نافذة طويلة (قسم الصلاحيات) كان خارج الشاشة، فبدا أن «حفظ» لا يفعل شيئاً.
           الآن: النص + تمرير إليه + تنبيه على الشاشة، والتركيز على الحقل المعني */
        const errEl = $('#uErr', b);
        const err = { set textContent(m) {
          errEl.textContent = m;
          if (!m) return;
          try { errEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* متصفح قديم */ }
          toast(m, true);
          if (/كلمة المرور/.test(m)) { const pi = $('#uPass', b); if (pi) pi.focus({ preventScroll: true }); }
        } };
        /* حفظ المستخدم لا يحفظ الصلاحيات (زر مستقل) — تنبيه داخل النافذة قبل أن تضيع
           التعديلات بإغلاقها؛ الضغطة الثانية على «حفظ» تتابع دونها. */
        if (perms.isDirty() && !dirtyAck) {
          dirtyAck = true;
          err.textContent = 'عدّلت الصلاحيات ولم تحفظها وستُفقد. اضغط «حفظ الصلاحيات» أولاً، أو «حفظ» مرة أخرى للمتابعة دونها.';
          return;
        }
        if (!name || !username) { err.textContent = 'الاسم واسم المستخدم مطلوبان'; return; }
        if (!/^[a-zA-Z0-9_.@-]{3,}$/.test(username)) { err.textContent = 'اسم المستخدم: 3 أحرف فأكثر (أحرف إنجليزية وأرقام)'; return; }
        if (db().users.some((x) => x.username.toLowerCase() === username.toLowerCase() && x.id !== u.id)) { err.textContent = 'اسم المستخدم مستخدم من قبل'; return; }
        // نفس قواعد الخادم (validatePassword): 8 أحرف فأكثر ولا تطابق اسم المستخدم — والشائعة يرفضها الخادم برسالة ظاهرة
        if (!user && pass.length < 8) { err.textContent = 'كلمة المرور 8 أحرف فأكثر'; return; }
        if (pass && pass.length < 8) { err.textContent = 'كلمة المرور 8 أحرف فأكثر'; return; }
        if (pass && pass.toLowerCase() === username.toLowerCase()) { err.textContent = 'لا يجوز أن تكون كلمة المرور هي اسم المستخدم'; return; }
        if (user && user.id === currentUser.id && (role !== 'admin' || !active) && db().users.filter((x) => x.role === 'admin' && x.active !== false && x.id !== user.id).length === 0) {
          err.textContent = 'لا يمكن إزالة صلاحية آخر مدير أو إيقافه'; return;
        }
        // رقم واتساب: نفس قواعد الخادم (waNormalizePhone) — يُرسل فقط حين يظهر القسم
        let waBody;
        if (canWa) {
          const raw = $('#uWaPhone', b).value.trim();
          const ev = $$('[data-uwaev]', b).filter((c) => c.checked).map((c) => c.dataset.uwaev);
          if (raw) {
            const np = WAN.normalizePhone(raw);
            if (np.error) { err.textContent = 'رقم واتساب: ' + np.error; $('#uWaPhone', b).focus({ preventScroll: true }); return; }
          } else if (ev.length) { err.textContent = 'اكتب رقم واتساب أولاً، أو ألغِ اختيار التنبيهات'; $('#uWaPhone', b).focus({ preventScroll: true }); return; }
          waBody = { phone: raw, events: ev };
        }
        const saveBtn = $('#uSave', b);
        saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true');
        try {
          await Store.saveUser({ id: user ? user.id : null, name, username, role, active, wa: waBody }, pass);
        } catch (e) {
          saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy');
          err.textContent = (e && e.message) || 'تعذّر حفظ المستخدم. تحقق من الاتصال وحاول مرة أخرى.'; return;
        }
        closeModal(); renderUsers();
        if (user && user.id === currentUser.id) { Object.assign(currentUser, { name, username, role }); applyPermissions(); }
        toast('تم حفظ المستخدم');
      };
    }, 'drawer');
  }
  $('#btnAddUser').addEventListener('click', () => userForm(null));

  /* ---------------- المصروفات ----------------
     من الخادم مباشرة (/api/expenses) — لا نسخة محلية تُزامَن. الخادم يحدد ما يُرى ويُعدَّل
     (‎_own لمصروفاتك و‎_all للجميع) ويعيد لكل صف can_edit/can_delete، والواجهة تتبعهما.
     القائمة المحمّلة تُحفظ في db().expenses فيحسبها «ذكاء الأعمال» أيضاً. */
  let expList = [];
  let expLoadedAt = 0;
  let expLoading = null;
  const expDay = (e) => String(e.expense_date || e.created_at || '').slice(0, 10);

  async function loadExpenses() {
    if (!Store.isRemote || !canAny('expenses.view_own', 'expenses.view_all')) { expList = []; db().expenses = []; return expList; }
    if (expLoading) return expLoading;
    expLoading = (async () => {
      try {
        const r = await Store.api('GET', '/api/expenses');
        expList = (r && Array.isArray(r.expenses)) ? r.expenses : [];
        db().expenses = expList;
        expLoadedAt = Date.now();
        return expList;
      } finally { expLoading = null; }
    })();
    return expLoading;
  }

  function expFiltered() {
    const from = $('#expFrom').value, to = $('#expTo').value, cat = $('#expCat').value, uid = $('#expUser').value;
    return expList.filter((e) => (!from || expDay(e) >= from) && (!to || expDay(e) <= to)
      && (!cat || (e.category || '') === cat) && (!uid || e.created_by === uid));
  }

  function renderExpensesTable() {
    const list = expFiltered();
    const cu = currency();
    const total = money(list.reduce((s, e) => s + num(e.amount), 0));
    const byCat = {};
    list.forEach((e) => { const c = e.category || 'بلا تصنيف'; byCat[c] = money((byCat[c] || 0) + num(e.amount)); });
    const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4);
    $('#expStats').innerHTML = `
      <div class="stat"><span>إجمالي المصروفات</span><b>${fmt(total)}</b><small>${esc(cu)}</small></div>
      <div class="stat"><span>عدد المصروفات</span><b>${list.length}</b></div>
      ${topCats.map(([c, v]) => `<div class="stat"><span>${esc(c)}</span><b>${fmt(v)}</b></div>`).join('')}`;
    // قوائم التصفية من البيانات المحمّلة (تبقى الاختيارات الحالية)
    const catSel = $('#expCat'), curCat = catSel.value;
    const cats = [...new Set(expList.map((e) => e.category).filter(Boolean))].sort();
    catSel.innerHTML = '<option value="">كل التصنيفات</option>' + cats.map((c) => `<option value="${esc(c)}"${c === curCat ? ' selected' : ''}>${esc(c)}</option>`).join('');
    const userSel = $('#expUser'), curU = userSel.value;
    const people = [...new Map(expList.map((e) => [e.created_by, e.created_by_name || '—'])).entries()];
    userSel.hidden = !can('expenses.view_all') || people.length < 2;
    userSel.innerHTML = '<option value="">كل الموظفين</option>' + people.map(([id, n]) => `<option value="${esc(id)}"${id === curU ? ' selected' : ''}>${esc(n)}</option>`).join('');

    $('#expEmpty').hidden = list.length > 0;
    $('#expensesTable tbody').innerHTML = list.map((e) => {
      const eid = esc(e.id);
      return `<tr>
        <td data-label="التاريخ" class="num"><bdi>${esc(fmtDate(expDay(e)))}</bdi></td>
        <td data-label="البيان"><b>${esc(e.name)}</b>${e.note ? `<span class="sub">${esc(e.note)}</span>` : ''}</td>
        <td data-label="التصنيف">${e.category ? `<span class="badge">${esc(e.category)}</span>` : '<span class="hint">—</span>'}</td>
        <td data-label="المبلغ" class="num c-money">${fmt(e.amount)}</td>
        <td data-label="سجّله">${esc(e.created_by_name || '—')}</td>
        <td data-label="الطلب" class="num">${e.order_number ? '#' + esc(e.order_number) : (e.order_id ? '<span class="hint">طلب محذوف</span>' : '<span class="hint">—</span>')}</td>
        <td class="row-actions"><span class="ra">
          ${e.can_edit ? `<button class="btn small" data-expedit="${eid}">${icon('pen')} تعديل</button>` : ''}
          ${e.can_delete ? rowMenu([menuItem(`data-expdel="${eid}"`, 'trash', 'حذف المصروف', true)], `إجراءات المصروف ${esc(e.name)}`) : ''}
        </span></td>
      </tr>`;
    }).join('');
    const tb = $('#expensesTable tbody');
    $$('[data-expedit]', tb).forEach((b) => b.addEventListener('click', () => expenseForm(expList.find((x) => x.id === b.dataset.expedit))));
    $$('[data-expdel]', tb).forEach((b) => b.addEventListener('click', () => deleteExpenseFlow(expList.find((x) => x.id === b.dataset.expdel))));
  }

  async function renderExpenses() {
    if (!canPage('expenses')) return;
    $('#btnAddExpense').hidden = !canAny('expenses.add_own', 'expenses.add_all');
    const err = $('#expErr');
    err.hidden = true;
    if (!expLoadedAt) { $('#expensesTable tbody').innerHTML = ''; $('#expEmpty').hidden = true; $('#expStats').innerHTML = '<p class="hint">جارٍ تحميل المصروفات…</p>'; }
    try { await loadExpenses(); }
    catch (e) { err.textContent = humanError(e && e.message, 'تعذّر تحميل المصروفات. تحقق من الاتصال.'); err.hidden = false; }
    renderExpensesTable();
  }

  /** نافذة إضافة/تعديل مصروف: التاريخ والبيان والتصنيف والمبلغ والملاحظة وطلب مرتبط اختياري */
  function expenseForm(e) {
    const isNew = !e;
    if (isNew ? !canAny('expenses.add_own', 'expenses.add_all') : !e.can_edit) return;
    const x = e || { expense_date: today(), name: '', category: '', amount: '', note: '', order_id: null };
    const cats = [...new Set(expList.map((r) => r.category).filter(Boolean))].sort();
    // الطلبات المتاحة للربط هي ما يراه المستخدم أصلاً (الخادم يتحقق من حقه في الطلب أيضاً)
    const orders = db().orders.filter((o) => o.number).slice().sort((a, b) => num(b.number) - num(a.number)).slice(0, 300);
    const others = (isNew && can('expenses.add_all')) ? db().users.filter((u) => u.active !== false && u.id !== currentUser.id) : [];
    openModal(isNew ? 'إضافة مصروف' : 'تعديل مصروف', `
      <div class="row2">
        <label>التاريخ <input id="exDate" type="date" value="${esc(expDay(x) || today())}" required></label>
        <label>المبلغ (${esc(currency())}) <input id="exAmount" type="text" inputmode="decimal" class="num" value="${x.amount === '' ? '' : esc(x.amount)}" placeholder="0" autocomplete="off"></label>
      </div>
      <label>البيان <input id="exName" value="${esc(x.name)}" maxlength="200" placeholder="مثال: نقل وتركيب"></label>
      <label>التصنيف <input id="exCat" value="${esc(x.category || '')}" maxlength="60" list="exCatList" placeholder="مثال: نقل، مشتريات، أجور عمال"><datalist id="exCatList">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label>ملاحظة <input id="exNote" value="${esc(x.note || '')}" maxlength="500"></label>
      <label>ربط بطلب (اختياري)
        <select id="exOrder"><option value="">بلا طلب</option>${orders.map((o) => `<option value="${esc(o.id)}"${o.id === x.order_id ? ' selected' : ''}>#${esc(o.number)} — ${esc(o.customer?.name || '')}</option>`).join('')}</select>
      </label>
      ${others.length ? `<label>سجّله باسم
        <select id="exUser"><option value="">أنا (${esc(currentUser.name)})</option>${others.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} — ${ROLES[u.role] || u.role}</option>`).join('')}</select>
      </label>` : ''}
      <p id="exErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="exCancel">إلغاء</button><button class="btn primary" id="exSave">${icon('save')} حفظ</button></div>`, (b) => {
      $('#exCancel', b).onclick = closeModal;
      $('#exSave', b).onclick = async () => {
        const err = $('#exErr', b);
        const amount = readAmount($('#exAmount', b).value);
        const name = $('#exName', b).value.trim();
        const date = $('#exDate', b).value;
        if (!name) { err.textContent = 'البيان مطلوب'; return; }
        if (amount === null || !(amount > 0)) { err.textContent = 'أدخل مبلغاً أكبر من صفر (أرقام فقط)'; return; }
        if (!date) { err.textContent = 'التاريخ مطلوب'; return; }
        const body = { expense_date: date, name, amount: money(amount), category: $('#exCat', b).value.trim(), note: $('#exNote', b).value.trim(), order_id: $('#exOrder', b).value || null };
        const u = $('#exUser', b);
        if (u && u.value) body.created_by = u.value;
        const btn = $('#exSave', b);
        btn.disabled = true; btn.setAttribute('aria-busy', 'true');
        try {
          if (isNew) await Store.api('POST', '/api/expenses', body);
          else await Store.api('PUT', '/api/expenses/' + encodeURIComponent(e.id), body);
        } catch (ex) {
          err.textContent = humanError(ex && ex.message, 'تعذّر حفظ المصروف. تحقق من الاتصال وحاول مرة أخرى.');
          btn.disabled = false; btn.removeAttribute('aria-busy');
          return;
        }
        closeModal();
        expLoadedAt = 0;
        await renderExpenses();
        toast(isNew ? 'أُضيف المصروف' : 'حُفظ المصروف');
      };
    }, 'drawer');
  }

  async function deleteExpenseFlow(e) {
    if (!e || !e.can_delete) return;
    if (!(await confirmDlg('حذف مصروف', `حذف «${e.name}» بمبلغ ${fmt(e.amount)} ${currency()}؟ لا يمكن التراجع.`))) return;
    try { await Store.api('DELETE', '/api/expenses/' + encodeURIComponent(e.id)); }
    catch (ex) { toast(humanError(ex && ex.message, 'تعذّر حذف المصروف.'), true); return; }
    expLoadedAt = 0;
    await renderExpenses();
    toast('حُذف المصروف');
  }

  $('#btnAddExpense').addEventListener('click', () => expenseForm(null));
  ['#expFrom', '#expTo', '#expCat', '#expUser'].forEach((s) => $(s).addEventListener('change', renderExpensesTable));

  /* ---------------- إشعارات واتساب اليدوية (wa.me — مجاني، الإرسال بيد المستخدم) ----------------
     - الخادم وحده ينشئ التنبيهات عند حفظ ناجح فعلاً (طلب جديد، دفعة، مصروف، تغيير حالة) ويفرض الصلاحيات؛
       الواجهة تعرض ما يعيده فقط. لا نسخة محلية تُزامَن.
     - الإرسال: محادثة واحدة في كل مرة بضغطة المستخدم (لا نوافذ جماعية تمنعها المتصفحات)، ثم يؤكد المستخدم
       بنفسه أنه أرسل أو يتخطى. «أكد المستخدم الإرسال يدويًا» ليست تأكيداً من واتساب — Click to Chat لا يعطي أي تأكيد. */
  const WA = window.WaNotify;
  const WA_P = { view: 'notifications.whatsapp.view', manage: 'notifications.whatsapp.manage', send: 'notifications.whatsapp.send' };
  const wa = { state: null, events: [], openSends: [], log: [], tab: 'send', loading: null, showHandled: false };
  const waTabsFor = () => ['send', 'recipients', 'templates', 'log'].filter((t) => t === 'send' ? canAny(WA_P.send, WA_P.view)
    : t === 'log' ? can(WA_P.view) : t === 'templates' ? canAny(WA_P.manage, WA_P.view) : canAny(WA_P.manage, WA_P.view));
  const waPhoneHtml = (p) => `<bdi dir="ltr" class="num">${esc(WA.formatPhone(p))}</bdi>`;
  const waTypeChip = (t) => `<span class="badge wa-type wa-t-${esc(t)}">${WA.TYPE_ICONS[t] || ''} ${esc(WA.TYPE_LABELS[t] || t)}</span>`;
  const waStatusChip = (s) => `<span class="badge wa-st wa-st-${esc(s)}">${esc(WA.LOG_LABELS[s] || s)}</span>`;

  async function waLoad(force) {
    if (!Store.isRemote || !canAny(WA_P.view, WA_P.manage, WA_P.send)) return;
    if (wa.loading) return wa.loading;
    wa.loading = (async () => {
      try {
        const [st, ev, lg] = await Promise.all([
          Store.api('GET', '/api/wa'),
          canAny(WA_P.view, WA_P.send) ? Store.api('GET', '/api/wa/events') : Promise.resolve(null),
          can(WA_P.view) ? Store.api('GET', '/api/wa/log') : Promise.resolve(null),
        ]);
        wa.state = st;
        wa.events = (ev && ev.events) || [];
        wa.openSends = (ev && ev.openSends) || [];
        wa.log = (lg && lg.log) || [];
        waBadge();
      } finally { wa.loading = null; }
    })();
    return wa.loading;
  }

  function waBadge() {
    const b = $('#waBadge');
    if (!b) return;
    const n = can(WA_P.send) ? wa.events.filter((e) => e.status === 'pending').length : 0;
    b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
  }

  async function renderWhatsapp() {
    if (!canPage('whatsapp')) return;
    const tabs = waTabsFor();
    if (!tabs.includes(wa.tab)) wa.tab = tabs[0] || 'send';
    $$('#waTabs [data-watab]').forEach((b) => { b.hidden = !tabs.includes(b.dataset.watab); });
    $('#waNewSend').hidden = !can(WA_P.send);
    const err = $('#waErr'); err.hidden = true;
    if (!wa.state) $('#waPanelSend').innerHTML = '<p class="hint">جارٍ التحميل…</p>';
    try { await waLoad(true); }
    catch (e) { err.textContent = humanError(e && e.message, 'تعذّر تحميل إشعارات واتساب. تحقق من الاتصال.'); err.hidden = false; }
    waShowTab(wa.tab);
  }

  function waShowTab(t) {
    wa.tab = t;
    $$('#waTabs [data-watab]').forEach((b) => { const on = b.dataset.watab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    const panels = { send: '#waPanelSend', recipients: '#waPanelRecipients', templates: '#waPanelTemplates', log: '#waPanelLog' };
    Object.entries(panels).forEach(([k, sel]) => { $(sel).hidden = k !== t; });
    if (!wa.state) return;
    if (t === 'send') waRenderSendTab();
    if (t === 'recipients') waRenderRecipients();
    if (t === 'templates') waRenderTemplates();
    if (t === 'log') waRenderLog();
  }
  $$('#waTabs [data-watab]').forEach((b) => b.addEventListener('click', () => waShowTab(b.dataset.watab)));
  $('#waNewSend').addEventListener('click', () => waComposer(null));

  /* ---- التبويب 1: التنبيهات الجاهزة والجلسات غير المكتملة ---- */
  function waRenderSendTab() {
    const st = wa.state;
    const active = st.recipients.filter((r) => r.active);
    const list = wa.events.filter((e) => wa.showHandled || e.status === 'pending');
    const canSend = can(WA_P.send);
    $('#waPanelSend').innerHTML = `
      <div class="stats-row">
        <div class="stat"><span>تنبيهات بانتظار الإرسال</span><b>${wa.events.filter((e) => e.status === 'pending').length}</b></div>
        <div class="stat"><span>المستلمون النشطون</span><b>${active.length}</b><small>من ${st.recipients.length} / ${st.max}</small></div>
      </div>
      ${!st.recipients.length ? `<div class="card wa-callout">${icon('info')}<div><b>لا يوجد مستلمون بعد.</b><p>${can(WA_P.manage) ? 'أضف المستلمين من تبويب «المستلمون» وحدد لكل منهم التنبيهات التي تصله.' : 'اطلب من المدير إضافة المستلمين.'} لا يُنشأ تنبيه لحدث ليس له مستلم نشط.</p></div></div>` : ''}
      ${wa.openSends.length && canSend ? `<div class="card"><h3 class="wa-h">جلسات إرسال لم تكتمل</h3><ul class="wa-list">${wa.openSends.map((s) => `
        <li class="wa-row"><div class="wa-row-main">${waTypeChip(s.event_type)}${s.order_number ? ` <b class="num">#${esc(s.order_number)}</b>` : ''}
          <span class="sub">${s.status === 'paused' ? 'موقوفة مؤقتاً' : 'لم تكتمل'} • عولج ${s.handled} من ${s.total} • <bdi>${esc(fmtDateTimeUi(s.created_at))}</bdi>${s.created_by_name ? ' • ' + esc(s.created_by_name) : ''}</span></div>
          <button class="btn small primary" data-waresume="${esc(s.id)}">${icon('whatsapp')} استئناف</button></li>`).join('')}</ul></div>` : ''}
      <div class="card">
        <div class="wa-h-row"><h3 class="wa-h">${wa.showHandled ? 'كل التنبيهات الأخيرة' : 'تنبيهات جاهزة للإرسال'}</h3>
          <label class="check"><input type="checkbox" id="waShowHandled"${wa.showHandled ? ' checked' : ''}> عرض المعالجة أيضاً</label></div>
        ${list.length ? `<ul class="wa-list">${list.map((e) => `
          <li class="wa-row"><div class="wa-row-main">${waTypeChip(e.type)} <span class="wa-desc">${esc(WA.describe(e))}</span>
            <span class="sub"><bdi>${esc(fmtDateTimeUi(e.created_at))}</bdi>${e.created_by_name ? ' • ' + esc(e.created_by_name) : ''}${e.status !== 'pending' ? ' • ' + (e.status === 'done' ? 'تمت معالجته' : 'تم تجاهله') : ''}</span></div>
            ${canSend ? `<span class="ra"><button class="btn small primary" data-wasend="${esc(e.id)}">${icon('whatsapp')} إرسال</button>
              ${e.status === 'pending' ? `<button class="btn small ghost" data-wadismiss="${esc(e.id)}" title="إخفاء التنبيه دون إرسال">تجاهل</button>` : ''}</span>` : ''}</li>`).join('')}</ul>`
        : `<p class="empty">${wa.showHandled ? 'لا توجد تنبيهات بعد.' : 'لا توجد تنبيهات بانتظار الإرسال. تظهر هنا تلقائياً بعد حفظ طلب جديد أو دفعة أو مصروف أو تغيير حالة.'}</p>`}
      </div>`;
    const P = $('#waPanelSend');
    $('#waShowHandled', P).addEventListener('change', (e) => { wa.showHandled = e.target.checked; waRenderSendTab(); });
    $$('[data-wasend]', P).forEach((b) => b.addEventListener('click', () => waComposer(wa.events.find((e) => e.id === b.dataset.wasend))));
    $$('[data-wadismiss]', P).forEach((b) => b.addEventListener('click', async () => {
      try { await Store.api('POST', '/api/wa/events/' + encodeURIComponent(b.dataset.wadismiss), { status: 'dismissed' }); }
      catch (ex) { toast(humanError(ex && ex.message, 'تعذّر تحديث التنبيه.'), true); return; }
      await waLoad(true); waRenderSendTab(); toast('تم تجاهل التنبيه', 'info');
    }));
    $$('[data-waresume]', P).forEach((b) => b.addEventListener('click', () => waResume(b.dataset.waresume)));
  }

  /* ---- التبويب 2: المستلمون (20 كحد أقصى) ---- */
  function waRenderRecipients() {
    const st = wa.state, man = can(WA_P.manage);
    const full = st.recipients.length >= st.max;
    $('#waPanelRecipients').innerHTML = `
      <div class="card">
        <div class="wa-h-row"><h3 class="wa-h">المستلمون <span class="wa-count num" id="waRcCount">${st.recipients.length} / ${st.max}</span></h3>
          ${man ? `<button class="btn primary" id="waAddR"${full ? ' disabled' : ''}>${icon('plus')} إضافة مستلم</button>` : ''}</div>
        ${full && man ? '<p class="hint">وصلت إلى الحد الأقصى (20 مستلماً) — احذف مستلماً لإضافة آخر.</p>' : ''}
        ${st.recipients.length ? `<div class="table-wrap"><table class="table responsive" id="waRcTable">
          <thead><tr><th>الاسم</th><th>الرقم</th><th>التنبيهات التي تصله</th><th>الحالة</th><th><span class="sr-only">إجراءات</span></th></tr></thead>
          <tbody>${st.recipients.map((r) => `<tr class="${r.active ? '' : 'wa-off'}">
            <td data-label="الاسم"><b>${esc(r.name)}</b>${r.user ? ` <span class="badge wa-user-badge" title="الرقم مرتبط بحساب المستخدم ويُعدَّل أيضاً من نافذة تعديله">${icon('user')} مستخدم</span>` : ''}</td>
            <td data-label="الرقم">${waPhoneHtml(r.phone)}</td>
            <td data-label="التنبيهات">${r.events.length ? r.events.map((t) => `<span class="badge">${esc(WA.TYPE_LABELS[t])}</span>`).join(' ') : '<span class="hint">لا شيء</span>'}</td>
            <td data-label="الحالة">${man ? `<label class="check"><input type="checkbox" data-waactive="${esc(r.id)}"${r.active ? ' checked' : ''}> ${r.active ? 'مفعّل' : 'معطّل'}</label>` : (r.active ? 'مفعّل' : 'معطّل')}</td>
            <td class="row-actions">${man ? `<span class="ra"><button class="btn small" data-waedit="${esc(r.id)}">${icon('pen')} تعديل</button>
              ${rowMenu([menuItem(`data-wadel="${esc(r.id)}"`, 'trash', 'حذف المستلم', true)], `إجراءات ${esc(r.name)}`)}</span>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="empty">لا يوجد مستلمون.</p>'}
        <p class="hint">الأرقام تُحفظ بصيغة دولية. الرقم السعودي المحلي (05…) يُحوَّل تلقائياً إلى ‎+966. لا تُضاف أي أرقام افتراضية.</p>
      </div>`;
    const P = $('#waPanelRecipients');
    const add = $('#waAddR', P); if (add) add.addEventListener('click', () => waRecipientForm(null));
    $$('[data-waedit]', P).forEach((b) => b.addEventListener('click', () => waRecipientForm(st.recipients.find((r) => r.id === b.dataset.waedit))));
    $$('[data-wadel]', P).forEach((b) => b.addEventListener('click', async () => {
      const r = st.recipients.find((x) => x.id === b.dataset.wadel);
      if (!r || !(await confirmDlg('حذف مستلم', `حذف «${r.name}» (${WA.formatPhone(r.phone)})؟ يبقى سجل الإرسال السابق كما هو.`, 'حذف'))) return;
      try { await Store.api('DELETE', '/api/wa/recipients/' + encodeURIComponent(r.id)); }
      catch (ex) { toast(humanError(ex && ex.message, 'تعذّر حذف المستلم.'), true); return; }
      await waLoad(true); waRenderRecipients(); toast('حُذف المستلم');
    }));
    $$('[data-waactive]', P).forEach((c) => c.addEventListener('change', async () => {
      try { await Store.api('PUT', '/api/wa/recipients/' + encodeURIComponent(c.dataset.waactive), { active: c.checked }); }
      catch (ex) { c.checked = !c.checked; toast(humanError(ex && ex.message, 'تعذّر الحفظ.'), true); return; }
      await waLoad(true); waRenderRecipients(); toast(c.checked ? 'فُعّل المستلم' : 'عُطّل المستلم');
    }));
  }

  function waRecipientForm(r) {
    if (!can(WA_P.manage)) return;
    const isNew = !r;
    const x = r || { name: '', phone: '', active: true, events: WA.TYPES.slice() };
    openModal(isNew ? 'إضافة مستلم' : 'تعديل مستلم', `
      <label>اسم المستلم <input id="waRName" value="${esc(x.name)}" maxlength="60" autocomplete="off" placeholder="مثال: مدير المبيعات"></label>
      <label>رقم الهاتف مع رمز الدولة <input id="waRPhone" dir="ltr" inputmode="tel" autocomplete="off" value="${esc(x.phone ? WA.formatPhone(x.phone) : '')}" placeholder="05XXXXXXXX أو ‎+9665XXXXXXXX"></label>
      <p class="hint" id="waRPrev" aria-live="polite"></p>
      <label class="check"><input type="checkbox" id="waRActive"${x.active ? ' checked' : ''}> مفعّل (يظهر في قوائم الإرسال)</label>
      <fieldset class="wa-evs"><legend>التنبيهات التي تصله</legend>
        ${WA.TYPES.map((t) => `<label class="check"><input type="checkbox" data-waev="${t}"${x.events.includes(t) ? ' checked' : ''}> ${WA.TYPE_ICONS[t]} ${esc(WA.TYPE_LABELS[t])}</label>`).join('')}
      </fieldset>
      <p id="waRErr" class="error" role="alert"></p>
      <div class="btn-row"><button class="btn" id="waRCancel">إلغاء</button><button class="btn primary" id="waRSave">${icon('save')} حفظ</button></div>`, (b) => {
      const prev = () => {
        const v = $('#waRPhone', b).value;
        const n = WA.normalizePhone(v);
        $('#waRPrev', b).innerHTML = !v.trim() ? '' : n.error ? `<span class="wa-err-txt">${esc(n.error)}</span>` : `سيُحفظ: ${waPhoneHtml(n.phone)}`;
      };
      $('#waRPhone', b).addEventListener('input', prev); prev();
      $('#waRCancel', b).onclick = closeModal;
      $('#waRSave', b).onclick = async () => {
        const err = $('#waRErr', b);
        const name = $('#waRName', b).value.trim();
        const n = WA.normalizePhone($('#waRPhone', b).value);
        if (!name) { err.textContent = 'اسم المستلم مطلوب'; return; }
        if (n.error) { err.textContent = n.error; return; }
        const dup = wa.state.recipients.find((o) => o.phone === n.phone && (!r || o.id !== r.id));
        if (dup) { err.textContent = `الرقم مسجّل مسبقاً للمستلم «${dup.name}»`; return; }
        const body = { name, phone: '+' + n.phone, active: $('#waRActive', b).checked, events: $$('[data-waev]', b).filter((c) => c.checked).map((c) => c.dataset.waev) };
        const btn = $('#waRSave', b); btn.disabled = true;
        try {
          if (isNew) await Store.api('POST', '/api/wa/recipients', body);
          else await Store.api('PUT', '/api/wa/recipients/' + encodeURIComponent(r.id), body);
        } catch (ex) { err.textContent = humanError(ex && ex.message, 'تعذّر حفظ المستلم.'); btn.disabled = false; return; }
        closeModal();
        await waLoad(true); waRenderRecipients(); toast(isNew ? 'أُضيف المستلم' : 'حُفظ المستلم');
      };
    }, 'drawer');
  }

  /* ---- التبويب 3: القوالب واختيار المستلمين لكل حدث ---- */
  function waRenderTemplates() {
    const st = wa.state, man = can(WA_P.manage);
    $('#waPanelTemplates').innerHTML = WA.TYPES.map((t) => {
      const T = st.templates[t];
      const sample = (wa.events.find((e) => e.type === t) || {}).vars;
      return `<div class="card wa-tpl" data-watpl="${t}">
        <div class="wa-h-row"><h3 class="wa-h">${WA.TYPE_ICONS[t]} ${esc(WA.TYPE_LABELS[t])}</h3>${T.isDefault ? '<span class="badge">القالب الافتراضي</span>' : '<span class="badge st-progress">معدّل</span>'}</div>
        <div class="wa-tpl-grid">
          <div>
            <label>نص الرسالة <textarea rows="9" data-watbody maxlength="${st.msgMax}"${man ? '' : ' readonly'}>${esc(T.body)}</textarea></label>
            <div class="wa-vars">${T.vars.map((v) => `<button type="button" class="chip" data-wavar="{${v}}" title="${esc(WA.VAR_LABELS[v] || v)}"${man ? '' : ' disabled'}><bdi dir="ltr">{${v}}</bdi> ${esc(WA.VAR_LABELS[v] || '')}</button>`).join('')}</div>
          </div>
          <div><span class="lbl">معاينة${sample ? ' (بيانات آخر تنبيه من هذا النوع)' : ''}</span><pre class="wa-preview" data-waprev>${esc(WA.render(T.body, sample || {}))}</pre></div>
        </div>
        <fieldset class="wa-evs"><legend>المستلمون لهذا التنبيه</legend>
          ${st.recipients.length ? st.recipients.map((r) => `<label class="check${r.active ? '' : ' wa-off'}"><input type="checkbox" data-wartpl="${esc(r.id)}"${T.recipients.includes(r.id) ? ' checked' : ''}${man ? '' : ' disabled'}> ${esc(r.name)} ${waPhoneHtml(r.phone)}${r.active ? '' : ' <small>(معطّل)</small>'}</label>`).join('') : '<p class="hint">لا يوجد مستلمون.</p>'}
        </fieldset>
        ${man ? `<p class="error" data-waterr role="alert"></p><div class="btn-row"><button class="btn" data-wareset${T.isDefault ? ' disabled' : ''}>استعادة النص الافتراضي</button><button class="btn primary" data-wasave>${icon('save')} حفظ</button></div>` : ''}
      </div>`;
    }).join('');
    $$('#waPanelTemplates [data-watpl]').forEach((card) => {
      const t = card.dataset.watpl;
      const ta = $('[data-watbody]', card);
      const sample = (wa.events.find((e) => e.type === t) || {}).vars || {};
      const upd = () => { $('[data-waprev]', card).textContent = WA.render(ta.value, sample); };
      ta.addEventListener('input', upd);
      $$('[data-wavar]', card).forEach((c) => c.addEventListener('click', () => {
        const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
        ta.value = ta.value.slice(0, s) + c.dataset.wavar + ta.value.slice(e);
        ta.focus(); ta.selectionStart = ta.selectionEnd = s + c.dataset.wavar.length; upd();
      }));
      const save = $('[data-wasave]', card);
      if (save) save.addEventListener('click', async () => {
        const err = $('[data-waterr]', card);
        if (!ta.value.trim()) { err.textContent = 'نص القالب مطلوب'; return; }
        save.disabled = true;
        try { await Store.api('PUT', '/api/wa/templates/' + t, { body: ta.value, recipients: $$('[data-wartpl]', card).filter((c) => c.checked).map((c) => c.dataset.wartpl) }); }
        catch (ex) { err.textContent = humanError(ex && ex.message, 'تعذّر حفظ القالب.'); save.disabled = false; return; }
        await waLoad(true); waRenderTemplates(); toast('حُفظ القالب');
      });
      const reset = $('[data-wareset]', card);
      if (reset) reset.addEventListener('click', async () => {
        try { await Store.api('PUT', '/api/wa/templates/' + t, { reset: true }); }
        catch (ex) { toast(humanError(ex && ex.message, 'تعذّر الاستعادة.'), true); return; }
        await waLoad(true); waRenderTemplates(); toast('استُعيد النص الافتراضي');
      });
    });
  }

  /* ---- التبويب 4: سجل الإرسال ---- */
  function waRenderLog() {
    const L = wa.log;
    $('#waPanelLog').innerHTML = `<div class="card">
      <p class="hint wa-honest">${icon('info')} واتساب لا يرسل أي تأكيد للنظام عبر روابط wa.me. «تم فتح واتساب» تعني أن المحادثة فُتحت، و«أكد المستخدم الإرسال يدويًا» تعني أن المستخدم ضغط زر التأكيد بنفسه — لا أن الرسالة وصلت.</p>
      ${L.length ? `<div class="table-wrap"><table class="table responsive" id="waLogTable">
        <thead><tr><th>الوقت</th><th>نوع التنبيه</th><th>الطلب</th><th>المستلم</th><th>الرقم</th><th>الحالة</th><th>بواسطة</th></tr></thead>
        <tbody>${L.map((x) => `<tr>
          <td data-label="الوقت" class="num"><bdi>${esc(fmtDateTimeUi(x.opened_at || x.created_at))}</bdi>${x.confirmed_at ? `<span class="sub">التأكيد: <bdi>${esc(fmtDateTimeUi(x.confirmed_at))}</bdi></span>` : ''}</td>
          <td data-label="نوع التنبيه">${x.event_type ? esc(WA.TYPE_LABELS[x.event_type] || x.event_type) : '—'}</td>
          <td data-label="الطلب" class="num">${x.order_number ? '#' + esc(x.order_number) : '<span class="hint">—</span>'}</td>
          <td data-label="المستلم">${esc(x.name)}</td>
          <td data-label="الرقم">${waPhoneHtml(x.phone)}</td>
          <td data-label="الحالة">${waStatusChip(x.status)}</td>
          <td data-label="بواسطة">${esc(x.by || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">لا يوجد إرسال بعد.</p>'}
    </div>`;
  }

  /* ---- نافذة تجهيز الرسالة: النوع، الحدث، النص، المستلمون ---- */
  function waComposer(ev) {
    if (!can(WA_P.send) || !wa.state) { if (!wa.state) waLoad(true).then(() => wa.state && waComposer(ev)).catch(() => toast('تعذّر تحميل إشعارات واتساب', true)); return; }
    const st = wa.state;
    let type = ev ? ev.type : (wa.events.find((e) => e.status === 'pending') || {}).type || WA.TYPES[0];
    let evId = ev ? ev.id : '';
    const eventsOf = (t) => wa.events.filter((e) => e.type === t);
    openModal('إرسال تنبيه واتساب', `
      <div class="seg-chips wa-types" role="radiogroup" aria-label="نوع التنبيه">${WA.TYPES.map((t) => `<button type="button" class="chip" role="radio" data-wactype="${t}">${WA.TYPE_ICONS[t]} ${esc(WA.TYPE_LABELS[t])}</button>`).join('')}</div>
      <label>الحدث المرتبط <select id="waCEv"></select></label>
      <label>نص الرسالة (يمكنك تعديله قبل الإرسال) <textarea id="waCMsg" rows="9" maxlength="${st.msgMax}"></textarea></label>
      <div class="wa-msg-meta"><span id="waCLen" class="num"></span><button type="button" class="btn small ghost" id="waCReset">إعادة نص القالب</button></div>
      <fieldset class="wa-evs"><legend>المستلمون <span id="waCCount" class="wa-count num"></span></legend>
        <div class="wa-sel-row"><button type="button" class="btn small" id="waCAll">تحديد الكل</button><button type="button" class="btn small" id="waCNone">إلغاء التحديد</button></div>
        <div id="waCList" class="wa-rc-list"></div>
      </fieldset>
      <p id="waCErr" class="error" role="alert"></p>
      <div class="btn-row"><button class="btn" id="waCCancel">إلغاء</button><button class="btn primary" id="waCStart">${icon('whatsapp')} بدء الإرسال</button></div>`, (b) => {
      const msg = $('#waCMsg', b);
      const varsOf = () => (wa.events.find((e) => e.id === evId) || {}).vars || {};
      const fillMsg = () => { msg.value = WA.render(st.templates[type].body, varsOf()); len(); };
      const len = () => { const n = msg.value.length; $('#waCLen', b).textContent = `${n} / ${st.msgMax}`; $('#waCLen', b).classList.toggle('wa-err-txt', n > st.msgMax); };
      const count = () => {
        const all = $$('[data-wacr]', b), on = all.filter((c) => c.checked);
        $('#waCCount', b).textContent = `المحدد: ${on.length} من ${all.length}`;
        $('#waCStart', b).disabled = !on.length;
      };
      const drawRecipients = () => {
        const act = st.recipients.filter((r) => r.active);
        const pre = st.templates[type].recipients;
        $('#waCList', b).innerHTML = act.length ? act.map((r) => `<label class="check"><input type="checkbox" data-wacr="${esc(r.id)}"${pre.includes(r.id) ? ' checked' : ''}> <b>${esc(r.name)}</b> ${waPhoneHtml(r.phone)}</label>`).join('')
          : '<p class="hint">لا يوجد مستلمون نشطون — أضفهم من تبويب «المستلمون».</p>';
        $$('[data-wacr]', b).forEach((c) => c.addEventListener('change', count));
        count();
      };
      const drawType = () => {
        $$('[data-wactype]', b).forEach((c) => { const on = c.dataset.wactype === type; c.classList.toggle('on', on); c.setAttribute('aria-checked', on ? 'true' : 'false'); });
        const list = eventsOf(type);
        if (!list.some((e) => e.id === evId)) evId = (list.find((e) => e.status === 'pending') || list[0] || {}).id || '';
        $('#waCEv', b).innerHTML = list.map((e) => `<option value="${esc(e.id)}"${e.id === evId ? ' selected' : ''}>${esc(WA.describe(e))} — ${esc(fmtDate(e.created_at))}${e.status === 'pending' ? '' : ' (معالج)'}</option>`).join('')
          + `<option value=""${evId ? '' : ' selected'}>بلا حدث — نص القالب فقط</option>`;
        fillMsg(); drawRecipients();
      };
      $$('[data-wactype]', b).forEach((c) => c.addEventListener('click', () => { type = c.dataset.wactype; evId = ''; drawType(); }));
      $('#waCEv', b).addEventListener('change', (e) => { evId = e.target.value; fillMsg(); });
      msg.addEventListener('input', len);
      $('#waCReset', b).onclick = fillMsg;
      $('#waCAll', b).onclick = () => { $$('[data-wacr]', b).forEach((c) => (c.checked = true)); count(); };
      $('#waCNone', b).onclick = () => { $$('[data-wacr]', b).forEach((c) => (c.checked = false)); count(); };
      $('#waCCancel', b).onclick = closeModal;
      $('#waCStart', b).onclick = async () => {
        const err = $('#waCErr', b);
        const ids = $$('[data-wacr]', b).filter((c) => c.checked).map((c) => c.dataset.wacr);
        if (!msg.value.trim()) { err.textContent = 'نص الرسالة فارغ'; return; }
        if (msg.value.length > st.msgMax) { err.textContent = `الرسالة أطول من ${st.msgMax} حرف — اختصرها`; return; }
        if (!ids.length) { err.textContent = 'اختر مستلماً واحداً على الأقل'; return; }
        // تنبيه سبقت معالجته: ضغطة ثانية للتأكيد بدل إرسال مكرر غير مقصود
        if (evId && wa.events.find((e) => e.id === evId && e.status !== 'pending') && !b.dataset.waAgain) { b.dataset.waAgain = '1'; err.textContent = 'سبقت معالجة هذا التنبيه — اضغط «بدء الإرسال» مرة أخرى لإرساله من جديد.'; return; }
        const btn = $('#waCStart', b); btn.disabled = true;
        let r;
        try { r = await Store.api('POST', '/api/wa/sends', { type, eventId: evId || undefined, message: msg.value, recipientIds: ids }); }
        catch (ex) { err.textContent = humanError(ex && ex.message, 'تعذّر بدء الإرسال.'); btn.disabled = false; return; }
        waRunner(r);
      };
      drawType();
    }, 'drawer');
  }

  async function waResume(id) {
    let r;
    try { r = await Store.api('GET', '/api/wa/sends/' + encodeURIComponent(id)); }
    catch (ex) { toast(waErrMsg(ex, 'تعذّر فتح جلسة الإرسال.'), true); await waLoad(true).catch(() => {}); if (canPage('whatsapp') && $('#page-whatsapp').classList.contains('active')) waShowTab('send'); return; }
    if (r.send.status === 'paused') { try { await Store.api('POST', '/api/wa/sends/' + encodeURIComponent(id), { status: 'active' }); r.send.status = 'active'; } catch (_) { /* يكمل */ } }
    waRunner(r);
  }

  /** رسالة الخطأ المعروضة: رسائل خدمة واتساب (400/403/404/409) عربية مكتوبة للمستخدم في الخادم فتُعرض كما هي،
      وما عداها (الشبكة، 500) يمر على humanError كبقية التطبيق */
  const waErrMsg = (ex, fallback) => (ex && ex.status >= 400 && ex.status < 500 && ex.status !== 401 && ex.message ? ex.message : humanError(ex && ex.message, fallback));

  /** فتح محادثة واحدة بضغطة المستخدم نفسها (يبقى داخل الحدث فلا يمنعه مانع النوافذ المنبثقة) */
  function waOpenChat(url) {
    if (!/^https:\/\/wa\.me\/\d{8,15}\?text=/.test(url)) return false;
    if (window.Capacitor) { window.open(url, '_system'); return true; }   // التطبيق: واتساب أو المتصفح الخارجي
    const w = window.open(url, '_blank');
    if (!w) return false;                                                 // منعه المتصفح
    try { w.opener = null; } catch (_) { /* نطاق آخر */ }
    return true;
  }

  /* ---- مشغّل الإرسال المتتابع: المستلم 1 من N ---- */
  function waRunner(data) {
    const send = data.send;
    const items = data.items.slice();
    const FINAL = ['confirmed', 'skipped', 'failed'];
    let cur = Math.max(0, items.findIndex((x) => !FINAL.includes(x.status)));
    let blocked = false;
    let busy = false;
    const setStatus = async (it, status) => {
      const r = await Store.api('POST', '/api/wa/log/' + encodeURIComponent(it.id), { status });
      it.status = status;
      if (status === 'opened') it.opened_at = new Date().toISOString();
      return r;
    };
    const nextIdx = () => { const i = items.findIndex((x, k) => k > cur && !FINAL.includes(x.status)); return i >= 0 ? i : items.findIndex((x) => !FINAL.includes(x.status)); };
    openModal('إرسال تنبيه واتساب', '<div id="waRun"></div>', (b) => {
      const draw = () => {
        const done = items.filter((x) => FINAL.includes(x.status)).length;
        const finished = done === items.length;
        const it = items[cur];
        const pct = Math.round((done / items.length) * 100);
        $('#waRun', b).innerHTML = `
          <div class="wa-run-head">${waTypeChip(send.event_type)}${send.order_number ? ` <b class="num">#${esc(send.order_number)}</b>` : ''}</div>
          <div class="wa-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${items.length}" aria-valuenow="${done}" aria-label="تقدم الإرسال"><span style="width:${pct}%"></span></div>
          <p class="wa-prog-txt" id="waProgTxt" aria-live="polite">${finished ? `اكتمل: عولج ${items.length} من ${items.length}` : `المستلم ${cur + 1} من ${items.length}`} <small>• عولج ${done}</small></p>
          ${finished ? `<div class="wa-done card">${icon('check')}<div><b>انتهت جلسة الإرسال</b>
              <p>أكدتَ الإرسال لـ ${items.filter((x) => x.status === 'confirmed').length}، وتخطيت ${items.filter((x) => x.status === 'skipped').length}، وتعذّر الفتح لـ ${items.filter((x) => x.status === 'failed').length}.</p></div></div>
              <div class="btn-row"><button class="btn primary" id="waRClose">إغلاق</button></div>`
          : `<div class="wa-cur card">
              <div class="wa-cur-who"><b>${esc(it.name)}</b> ${waPhoneHtml(it.phone)} ${waStatusChip(it.status)}</div>
              ${blocked ? `<p class="error">منع المتصفح فتح النافذة. اضغط الرابط المباشر: <a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer" id="waRDirect">فتح محادثة ${esc(it.name)}</a></p>` : ''}
              <div class="btn-row wa-run-btns">
                <button class="btn primary" id="waROpen">${icon('whatsapp')} ${it.status === 'opened' ? 'إعادة فتح واتساب' : 'فتح واتساب'}</button>
                ${it.status === 'opened' ? `<button class="btn primary wa-ok" id="waRConfirm">${icon('check')} أرسلتُها — التالي</button>` : ''}
                <button class="btn" id="waRSkip">تخطي</button>
                ${it.status === 'opened' ? '<button class="btn ghost" id="waRFail">لم يُفتح واتساب</button>' : ''}
              </div>
              <p class="hint">${it.status === 'opened' ? 'اضغط «إرسال» داخل واتساب، ثم عد هنا واضغط «أرسلتُها — التالي». النظام لا يعرف إن وصلت الرسالة.' : 'تُفتح محادثة هذا المستلم وحده والرسالة مكتوبة فيها — الإرسال بضغطتك في واتساب.'}</p>
            </div>
            <div class="btn-row"><button class="btn ghost" id="waRPause">إيقاف مؤقت</button></div>`}
          <ol class="wa-run-list">${items.map((x, k) => `<li class="${k === cur && !finished ? 'cur' : ''}"><span class="num">${k + 1}</span> ${esc(x.name)} ${waStatusChip(x.status)}</li>`).join('')}</ol>`;
        const on = (id, fn) => { const el = $('#' + id, b); if (el) el.onclick = fn; };
        // ضغطة واحدة = عملية واحدة: busy يُضبط متزامناً قبل أي انتظار، فالضغط المزدوج السريع (شائع على اللمس)
        // لا يفتح محادثتين ولا يرسل حالتين — الأزرار المعطّلة وحدها لا تكفي لأن التعطيل يأتي بعد أول await
        const guard = (fn) => async () => {
          if (busy) return; busy = true;
          $$('#waRun button', b).forEach((x) => (x.disabled = true));
          try { await fn(); } catch (ex) {
            // 403/404: لم يعد المستخدم يملك الجلسة أو رؤية بياناتها (سحب صلاحية، نقل ملكية) — تُغلق النافذة
            // فلا تبقى بيانات التنبيه معروضة ولا يمكن متابعتها، وتُعرض رسالة الخادم الواضحة
            if (ex && (ex.status === 403 || ex.status === 404)) { busy = false; return waDenied(ex); }
            toast(waErrMsg(ex, 'تعذّر حفظ الحالة.'), true);
            // 409: الحالة تغيّرت من نافذة أو جهاز آخر — تُقرأ من الخادم بدل البقاء على نسخة قديمة
            if (ex && ex.status === 409) { busy = false; await wa.runnerRefresh().catch(() => {}); }
          }
          finally { busy = false; }
          if ($('#waRun', b)) draw();
        };
        const waDenied = async (ex) => {
          closeModal();
          toast(waErrMsg(ex, 'لم تعد تملك صلاحية متابعة هذه الجلسة.'), true);
          await waLoad(true).catch(() => {});
          if (canPage('whatsapp') && $('#page-whatsapp').classList.contains('active')) waShowTab('send');
        };
        on('waRClose', async () => { closeModal(); await waLoad(true); if (wa.tab) waShowTab(wa.tab); });
        on('waROpen', async () => {
          if (busy) return;
          if (window.Capacitor) {
            /* التطبيق (أندرويد): لا قيد «ضغطة المستخدم» على فتح الروابط الخارجية، فيُتحقق من الخادم أولاً أن المستخدم
               ما زال يملك الجلسة ورؤية بياناتها الآن (سحب صلاحية أو نقل ملكية بعد فتح النافذة ← لا فتح لواتساب أصلاً) */
            return guard(async () => {
              await Store.api('GET', '/api/wa/sends/' + encodeURIComponent(send.id));
              waOpenChat(it.link);
              await setStatus(it, 'opened');
            })();
          }
          // المتصفح: الفتح أولاً داخل ضغطة المستخدم نفسها (وإلا منعه مانع النوافذ المنبثقة)، ثم تسجيل الحالة في الخادم
          const opened = waOpenChat(it.link);
          blocked = !opened;
          await guard(() => setStatus(it, opened ? 'opened' : 'failed'))();
        });
        const direct = $('#waRDirect', b);
        // الرابط البديل (عند منع المتصفح للنافذة): الضغطة الأولى وحدها تفتح وتسجّل — ما بعدها يُمنع حتى تنتهي
        if (direct) direct.addEventListener('click', (ev) => {
          if (busy) { ev.preventDefault(); return; }
          busy = true; blocked = false;
          setStatus(it, 'opened').then(() => { busy = false; draw(); }).catch((ex) => { busy = false; if (ex && (ex.status === 403 || ex.status === 404)) return waDenied(ex); toast(waErrMsg(ex, 'تعذّر حفظ الحالة.'), true); draw(); });
        });
        on('waRConfirm', guard(async () => { await setStatus(it, 'confirmed'); blocked = false; const n = nextIdx(); if (n >= 0) cur = n; }));
        on('waRSkip', guard(async () => { await setStatus(it, 'skipped'); blocked = false; const n = nextIdx(); if (n >= 0) cur = n; }));
        on('waRFail', guard(async () => { await setStatus(it, 'failed'); blocked = false; const n = nextIdx(); if (n >= 0) cur = n; }));
        on('waRPause', async () => {
          try { await Store.api('POST', '/api/wa/sends/' + encodeURIComponent(send.id), { status: 'paused' }); }
          catch (ex) { if (ex && (ex.status === 403 || ex.status === 404)) return waDenied(ex); toast(waErrMsg(ex, 'تعذّر الإيقاف.'), true); return; }
          closeModal(); toast('أُوقف الإرسال مؤقتاً — استأنفه من «جلسات إرسال لم تكتمل»', 'info');
          await waLoad(true); if (canPage('whatsapp') && $('#page-whatsapp').classList.contains('active')) waShowTab('send');
        });
      };
      draw();
      /* العودة من واتساب (أندرويد: التطبيق يذهب للخلفية ثم يعود): تُقرأ الحالة من الخادم ويبقى المستلم الحالي كما هو.
         إن أُغلق التطبيق كلياً فالجلسة محفوظة في الخادم وتُستأنف من «جلسات إرسال لم تكتمل». */
      wa.runnerRefresh = async () => {
        if (busy || !$('#waRun', b)) return;
        try {
          const r = await Store.api('GET', '/api/wa/sends/' + encodeURIComponent(send.id));
          const byId = new Map(r.items.map((x) => [x.id, x]));
          items.forEach((x) => { const y = byId.get(x.id); if (y) { x.status = y.status; x.opened_at = y.opened_at; } });
          if ($('#waRun', b)) draw();
        } catch (ex) {
          // سُحبت الصلاحية أثناء وجوده في واتساب: تُغلق النافذة ولا تبقى بياناتها معروضة
          if (ex && (ex.status === 403 || ex.status === 404) && $('#waRun', b)) { closeModal(); toast(waErrMsg(ex, 'لم تعد تملك صلاحية متابعة هذه الجلسة.'), true); waLoad(true).catch(() => {}); }
          /* بلا اتصال: تبقى الحالة المحلية */
        }
      };
    }, 'drawer');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wa.runnerRefresh && document.getElementById('waRun')) wa.runnerRefresh();
  });

  /* ---- بعد حفظ ناجح: الخادم أعاد تنبيهات جديدة ← عرض «إرسال تنبيه» دون مقاطعة العمل ---- */
  function waNudge(list) {
    if (!can(WA_P.send) || !list || !list.length) return;
    let el = $('#waNudge');
    if (!el) { el = document.createElement('div'); el.id = 'waNudge'; el.className = 'wa-nudge'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    const one = list.length === 1 ? list[0] : null;
    el.innerHTML = `${icon('whatsapp')}<div class="wa-nudge-txt"><b>${one ? 'تنبيه واتساب جاهز' : list.length + ' تنبيهات واتساب جاهزة'}</b><span>${one ? esc(WA.TYPE_LABELS[one.type] || '') : list.map((x) => esc(WA.TYPE_LABELS[x.type] || '')).join('، ')}</span></div>
      <button class="btn small primary" id="waNudgeGo">${one ? 'إرسال الآن' : 'عرض'}</button><button class="btn small ghost" id="waNudgeX" aria-label="لاحقاً">لاحقاً</button>`;
    el.hidden = false;
    clearTimeout(waNudge.t);
    waNudge.t = setTimeout(() => { el.hidden = true; }, 15000);
    $('#waNudgeX', el).onclick = () => { el.hidden = true; };
    $('#waNudgeGo', el).onclick = async () => {
      el.hidden = true;
      try { await waLoad(true); } catch (ex) { toast(humanError(ex && ex.message, 'تعذّر تحميل التنبيهات.'), true); return; }
      const ev = one && wa.events.find((e) => e.id === one.id);
      if (ev) waComposer(ev); else { wa.tab = 'send'; showPage('whatsapp'); }
    };
    waLoad(true).catch(() => {});
  }
  window.addEventListener('majlis:wa-events', (e) => waNudge(e.detail));

  /** بعد الدخول: جلسة إرسال سابقة لم تكتمل ← «استئناف» من المستلم الذي توقفت عنده */
  function waResumeNudge() {
    const s = wa.openSends[0];
    if (!s) return;
    let el = $('#waNudge');
    if (!el) { el = document.createElement('div'); el.id = 'waNudge'; el.className = 'wa-nudge'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.innerHTML = `${icon('whatsapp')}<div class="wa-nudge-txt"><b>جلسة إرسال لم تكتمل</b><span>${esc(WA.TYPE_LABELS[s.event_type] || '')} • عولج ${s.handled} من ${s.total}</span></div>
      <button class="btn small primary" id="waNudgeGo">استئناف</button><button class="btn small ghost" id="waNudgeX">لاحقاً</button>`;
    el.hidden = false;
    // تذكير الاستئناف لا يختفي وحده (كان 15 ثانية ففات المستخدم): يبقى حتى «استئناف» أو «لاحقاً»
    clearTimeout(waNudge.t);
    $('#waNudgeX', el).onclick = () => { el.hidden = true; };
    $('#waNudgeGo', el).onclick = () => { el.hidden = true; waResume(s.id); };
  }

  /* ---------------- إدارة المناديب (مدير) ---------------- */
  const mandoubUsers = () => db().users.filter((u) => u.role === 'mandoub');
  const mandoubName = (id) => { const u = Store.getUser(id); return u ? u.name : '—'; };

  function mandoubDescendants(id, out, seen) {
    // مقاومة الدورات: أي بيانات شاذة (أب ذاتي أو دورة) تُحتوى بدل تعليق الصفحة
    out = out || [];
    seen = seen || new Set([id]);
    mandoubUsers().forEach((m) => {
      if (m.parentId === id && !seen.has(m.id)) { seen.add(m.id); out.push(m.id); mandoubDescendants(m.id, out, seen); }
    });
    return out;
  }

  /** تفصيل عمولات طلب من لقطة نسبه (أو النسب الحالية إن لم تكن هناك لقطة) */
  function orderCommBreakdown(o) {
    const p = commBaseAmount(o);
    if (p === null) return null;
    const owner = Store.getUser(o.createdBy);
    const isMan = !!(owner && owner.role === 'mandoub');
    const parent = (isMan && owner && owner.parentId) ? Store.getUser(owner.parentId) : null;
    const r = commRatesOf(o);
    const src = commRateSources(o, r);
    const rows = [];
    rows.push({ who: owner ? owner.name : 'المندوب', rate: r.ownerRate, amount: money(p * r.ownerRate / 100), userId: o.createdBy, src: src.owner });
    if (r.parentId) {
      const par = Store.getUser(r.parentId);
      rows.push({ who: par ? par.name : 'المندوب الأعلى', rate: r.parentRate || 0, amount: money(p * (r.parentRate || 0) / 100), userId: r.parentId, src: src.parent });
    }
    rows.push({ who: 'موظفو المحل', rate: r.shareRate, amount: money(p * r.shareRate / 100), userId: null, src: src.share });
    return { profit: orderProfit(o), base: p, baseMode: commBaseMode(), rows };
  }

  function renderMandoubs() {
    if (!can('admin.core')) return;
    const list = mandoubUsers();
    const level1 = list.filter((m) => !m.parentId).length;
    const unassigned = list.filter((m) => !m.active).length;
    const activeMandoub = list.filter((m) => m.active !== false);

    // إحصاءات
    $('#mandoubStats').innerHTML = `
      <div class="stat"><span>إجمالي المناديب</span><b>${list.length}</b></div>
      <div class="stat"><span>مباشرون للمحل (المستوى الأول)</span><b>${level1}</b></div>
      <div class="stat"><span>مفعّلون</span><b>${activeMandoub.length}</b></div>
      <div class="stat"><span>غير مفعّلين</span><b>${unassigned}</b></div>`;

    // قائمة المناديب
    const tb = $('#mandoubTable tbody');
    tb.innerHTML = list.map((m) => {
      const lvl = mandoubLevelOf(m.id);
      return `<tr>
        <td data-label="الاسم"><b>${esc(m.name)}</b>${m.username ? `<span class="sub ltr">${esc(m.username)}</span>` : ''}</td>
        <td data-label="المستوى" class="num">${lvl || '—'}</td>
        <td data-label="المندوب الأعلى">${m.parentId ? esc(mandoubName(m.parentId)) : '<span class="hint">مباشر للمحل</span>'}</td>
        <td data-label="نسبته" class="num">${fmtQty(mandoubOwnerRateOf(m))}٪</td>
        <td data-label="نسبة الأعلى" class="num">${m.parentId ? fmtQty(mandoubParentRateOf(m)) + '٪' : '<span class="hint">—</span>'}</td>
        <td data-label="الحالة"><label class="status-chip sm" data-status="${m.active !== false ? 'new' : 'cancelled'}"><i class="status-dot"></i>${m.active !== false ? 'مفعّل' : 'غير مفعّل'}</label></td>
        <td class="row-actions"><button class="btn small" data-medit="${esc(m.id)}">${icon('pen')} إدارة</button></td>
      </tr>`;
    }).join('');
    $('#mandoubEmpty').hidden = list.length > 0;
    $$('[data-medit]', tb).forEach((b) => b.addEventListener('click', () => mandoubForm(Store.getUser(b.dataset.medit))));

    // الهيكل التنظيمي
    const roots = list.filter((m) => !m.parentId);
    const treeHtml = (id) => {
      const children = list.filter((m) => m.parentId === id);
      return `<li><span class="node"><b>${esc(mandoubName(id))}</b><small>مستوى ${mandoubLevelOf(id)}</small></span>${children.length ? '<ul>' + children.map((c) => treeHtml(c.id)).join('') + '</ul>' : ''}</li>`;
    };
    $('#mandoubTree').innerHTML = roots.length
      ? '<ul class="tree">' + roots.map((r) => treeHtml(r.id)).join('') + '</ul>'
      : '<p class="hint">لا يوجد هيكل بعد — أسند مندوباً للمحل (مستوى أول) أو لمندوب آخر.</p>';

    // سجل العمولات (طلبات المناديب فقط، المرتبة بالأحدث)
    const manOrders = db().orders.filter((o) => isMandoub(o) && commBaseAmount(o) !== null).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const logTb = $('#mandoubLogTable tbody');
    const logRows = [];
    manOrders.slice(0, 200).forEach((o) => {
      const bd = orderCommBreakdown(o);
      bd.rows.forEach((r) => logRows.push({ order: o, base: bd.base, ...r }));
    });
    logTb.innerHTML = logRows.length ? logRows.map((r) => `
      <tr>
        <td data-label="الطلب" class="num">#${esc(r.order.number || '—')}</td>
        <td data-label="أساس العمولة" class="num">${fmt(r.base)}</td>
        <td data-label="المستفيد">${esc(r.who)}</td>
        <td data-label="النسبة" class="num">${fmtQty(r.rate)}٪</td>
        <td data-label="المبلغ" class="num">${fmt(r.amount)}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="empty">لا توجد عمولات محسوبة بعد${commBaseMode() === 'profit' ? ' (تحتاج طلبات مناديب بتكاليف مسجّلة)' : ''}.</td></tr>`;
    $('#mandoubLogNote').textContent = manOrders.length ? `يعرض آخر 200 سطر من عمولات ${manOrders.length} طلب مناديب. النسب مأخوذة من لقطة كل طلب عند اعتماده، وأساس العمولة: ${commBaseLabel()}.` : '';
  }

  function mandoubForm(m) {
    if (!m || !can('admin.core')) return;
    const others = mandoubUsers().filter((x) => x.id !== m.id);
    const excl = new Set([m.id, ...mandoubDescendants(m.id)]);
    const parentOpts = `<option value="">مباشر للمحل (المستوى الأول)</option>` + others
      .filter((x) => !excl.has(x.id))
      .map((x) => `<option value="${esc(x.id)}" ${m.parentId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    openModal(`إدارة المندوب — ${esc(m.name)}`, `
      <p class="hint">المستوى الحالي: <b>${mandoubLevelOf(m.id) || '—'}</b> • الحالة: <b>${m.active !== false ? 'مفعّل' : 'غير مفعّل'}</b></p>
      <label>المندوب الأعلى <select id="mParent">${parentOpts}</select></label>
      <p class="hint">يُحدد المستوى تلقائياً: المندوب المسند تحت مستوى ثانٍ يصبح من المستوى الثالث وهكذا.</p>
      <div class="row2">
        <label>نسبة المندوب من صافي ربح طلباته % <input id="mRate" type="number" min="0" max="100" step="0.5" value="${mandoubOwnerRateOf(m)}"></label>
        <label>نسبة المندوب الأعلى المباشر % <input id="mParentRate" type="number" min="0" max="100" step="0.5" value="${mandoubParentRateOf(m)}"></label>
      </div>
      <label class="check"><input id="mActive" type="checkbox" ${m.active !== false ? 'checked' : ''}> مفعّل لاستقبال الطلبات واحتساب العمولات</label>
      <p id="mErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="mCancel">إلغاء</button><button class="btn primary" id="mSave">${icon('save')} حفظ</button></div>`, (b) => {
      $('#mCancel', b).onclick = closeModal;
      $('#mSave', b).onclick = async () => {
        const parentId = $('#mParent', b).value || null;
        const rate = Math.min(100, Math.max(0, num($('#mRate', b).value)));
        const parentRate = Math.min(100, Math.max(0, num($('#mParentRate', b).value)));
        const active = $('#mActive', b).checked;
        try {
          await Store.saveUser({ id: m.id, name: m.name, username: m.username, role: 'mandoub', active, parentId, rate, parentRate }, '');
        } catch (e) { $('#mErr', b).textContent = e.message; return; }
        closeModal(); renderUsers(); renderMandoubs();
        toast('تم حفظ إعدادات المندوب');
      };
    }, 'drawer');
  }

  $('#btnMandoubDefaults').addEventListener('click', () => {
    if (!can('admin.core')) return;
    const s = settings();
    openModal('الإعدادات الافتراضية لعمولات المناديب', `
      <p class="hint">تُطبَّق كقيم افتراضية عند إنشاء مندوب جديد، ويمكن تجاوزها لكل مندوب من قائمة المناديب.</p>
      <div class="row2">
        <label>نسبة المندوب (صاحب الطلب) % <input id="dMandoubRate" type="number" min="0" max="100" step="0.5" value="${num(s.mandoubRate ?? 5)}"></label>
        <label>نسبة المندوب الأعلى المباشر % <input id="dMandoubParentRate" type="number" min="0" max="100" step="0.5" value="${num(s.mandoubParentRate ?? 5)}"></label>
      </div>
      <label>حصة موظفي المحل % <input id="dShareRate" type="number" min="0" max="100" step="0.5" value="${num(s.shareRate ?? 5)}"></label>
      <div class="btn-row"><button class="btn" id="dCancel">إلغاء</button><button class="btn primary" id="dSave">${icon('save')} حفظ</button></div>`, (b) => {
      $('#dCancel', b).onclick = closeModal;
      $('#dSave', b).onclick = async () => {
        Object.assign(settings(), {
          mandoubRate: Math.min(100, Math.max(0, num($('#dMandoubRate', b).value))),
          mandoubParentRate: Math.min(100, Math.max(0, num($('#dMandoubParentRate', b).value))),
          shareRate: Math.min(100, Math.max(0, num($('#dShareRate', b).value))),
        });
        if (!(await Store.save())) { toast(humanError(Store.lastError), true); return; }
        closeModal(); renderMandoubs();
        toast('تم حفظ الإعدادات الافتراضية');
      };
    }, 'drawer');
  });

  /* ---------------- تصاميم العملاء (واردة من البوابة) ----------------
     قسم مستقل عن الطلبات: مراجعة وتحويل فقط، بلا أي منطق مالي هنا. */
  const DESIGN_STATUS = { draft: 'مسودة', new: 'جديد', reviewing: 'قيد المراجعة', contacted: 'تم التواصل', converted: 'تم تحويله إلى طلب', closed: 'مغلق' };
  let designsCache = [];
  let desBound = false;
  const desFilter = { q: '', status: '' };
  const desSel = { ids: new Set(), edit: false };   // تحديد الصفوف + وضع التعديل (لا حالة عبر التصفية)

  async function fetchDesigns() {
    const r = await Store.api('GET', '/api/designs');
    designsCache = Array.isArray(r.designs) ? r.designs : [];
    return designsCache;
  }

  /** رسالة خطأ التصاميم من الخطأ الملتقط نفسه (e) — لا من Store.lastError التي
      قد تكون قديمة من مزامنة/حفظ متزامن فتُظهر سبباً مضللاً. بلا بيانات حساسة. */
  function designsError(e) {
    const st = e && e.status;
    if (e && e.offline) return 'لا يوجد اتصال بالإنترنت. تحقق من الاتصال وحاول مجدداً.';
    if (st === 0) return 'تعذّر الوصول إلى الخادم. هذه الصفحة تحتاج الاتصال بالإنترنت.';
    if (st === 401) return 'انتهت الجلسة. سجّل الدخول مرة أخرى.';
    if (st === 403) return 'صلاحيتك لا تسمح بعرض تصاميم العملاء.';
    const s = String((e && e.message) || '');
    if (/انتهت الجلسة|غير مسجّل|401/.test(s)) return 'انتهت الجلسة. سجّل الدخول مرة أخرى.';
    if (/صلاحي|403|ممنوع|غير مصرّح/.test(s)) return 'صلاحيتك لا تسمح بعرض تصاميم العملاء.';
    if (/اتصال|إنترنت|غير متصل|offline|network|fetch|timeout/i.test(s)) return 'لا يوجد اتصال بالإنترنت. تحقق من الاتصال وحاول مجدداً.';
    return 'تعذّر جلب البيانات من الخادم. تحقق من الاتصال وحاول مرة أخرى.';
  }

  function desMatches(d) {
    if (desFilter.status && d.status !== desFilter.status) return false;
    const q = desFilter.q.trim();
    if (!q) return true;
    return (d.number || '').includes(q) || (d.name || '').includes(q) || (d.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, ''));
  }

  /** الحذف نهائي من البوابة،hence تأكيد صريح بالعدد وذكر الطلبات المرتبطة. */
  function desSelected() {
    return designsCache.filter((d) => desSel.ids.has(d.id));
  }
  /** وضع التعديل: يفعّل أعمدة التحديد وشريط الجملة. يبقى التصميم محفوظاً حتى التأكيد. */
  function setDesEditMode(on) {
    desSel.edit = on;
    if (!on) desSel.ids.clear();
    const btn = $('#desEditBtn');
    if (btn) { btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('on', on); }
    paintDesigns();
  }
  /** يزامن شريط الجملة + «تحديد الكل» + مربعات الصفوف (بلا إعادة جلب) */
  function syncDesSelection() {
    const list = designsCache.filter(desMatches);
    const ids = list.map((d) => d.id);
    const on = ids.filter((id) => desSel.ids.has(id));
    const bar = $('#desBulk');
    if (bar) {
      bar.hidden = !desSel.edit;
      const n = $('#desBulkCount');
      if (n) n.textContent = on.length === 0 ? 'لم يُحدَّد شيء'
        : (on.length === ids.length && ids.length > 1 ? 'كل التصاميم محدَّدة (' + on.length + ')' : (on.length === 1 ? 'تصميم واحد محدَّد' : on.length + ' تصاميم محدَّدة'));
    }
    const all = $('#desSelAll');
    if (all) {
      all.checked = ids.length > 0 && on.length === ids.length;
      all.indeterminate = on.length > 0 && on.length < ids.length;
      all.disabled = ids.length === 0;
    }
    const del = $('#desBulkDel');
    if (del) del.disabled = on.length === 0;
    $$('#desTable tbody [data-dessel]').forEach((c) => { c.checked = desSel.ids.has(c.dataset.dessel); });
  }
  async function deleteDesignFlow(id) {
    const d = designsCache.find((x) => x.id === id);
    const extra = d && d.orderId ? `\n\nهذا التصميم محوَّل إلى الطلب #${d.orderNumber} — سيبقى الطلب كما هو ولا تتأثر بياناته.` : '';
    if (!(await confirmDlg('حذف التصميم', `سيُحذف التصميم ${d ? d.number : ''} نهائياً من قائمة تصاميم العملاء.${extra}`, 'حذف'))) return;
    try {
      const r = await Store.api('DELETE', '/api/designs/' + encodeURIComponent(id));
      desSel.ids.delete(id);
      toast(r && r.hadOrder ? `حُذف التصميم — الطلب #${r.orderNumber} لم يُمس` : 'حُذف التصميم');
      await renderDesigns();
    } catch (e) { toast('تعذّر الحذف: ' + designsError(e), true); }
  }
  async function deleteSelectedDesigns() {
    const picked = desSelected();
    if (!picked.length) { toast('حدّد تصميماً واحداً على الأقل', true); return; }
    const ids = picked.map((d) => d.id);
    const withOrder = picked.filter((d) => d.orderId).length;
    const extra = withOrder ? `\n\n${withOrder} منها محوَّلة إلى طلبات — الطلبات لن تتأثر.` : '';
    if (!(await confirmDlg('حذف التصاميم المحدَّدة', `سيُحذف ${ids.length} تصميم نهائياً من قائمة تصاميم العملاء.${extra}`, 'حذف الكل'))) return;
    try {
      const r = await Store.api('POST', '/api/designs/bulk-delete', { ids });
      desSel.ids.clear();
      toast(`حُذف ${(r && r.deleted) || ids.length} تصميم`);
      await renderDesigns();
    } catch (e) { toast('تعذّر الحذف: ' + designsError(e), true); }
  }

  /** رسم صفوف القائمة من الذاكرة (بلا شبكة): يُستخدم عند التبديل بين العرض والتعديل */
  function paintDesigns() {
    const list = designsCache.filter(desMatches);
    const tb = $('#desTable tbody');
    tb.innerHTML = list.map((d) => {
      const oid = esc(d.id);
      return `<tr>
        <td data-label="تحديد" class="c-pick"${desSel.edit ? '' : ' hidden'}><input type="checkbox" data-dessel="${oid}" aria-label="تحديد ${esc(d.number)}"${desSel.ids.has(d.id) ? ' checked' : ''}></td>
        <td data-label="التصميم" class="c-no"><b class="num" dir="ltr">${esc(d.number)}</b><span class="sub"><bdi class="num">${esc(fmtDate(d.createdAt))}</bdi></span></td>
        <td data-label="الحالة" class="c-status"><span class="badge">${esc(DESIGN_STATUS[d.status] || d.status)}</span></td>
        <td data-label="العميل" class="c-cust"><b>${esc(d.name || '—')}</b>${d.phone ? `<span class="sub num">${esc(d.phone)}</span>` : ''}</td>
        <td data-label="التواصل">${d.contactRequested ? '<span class="badge st-delivered">طلب التواصل</span>' : '<span class="hint">—</span>'}</td>
        <td data-label="الطلب" class="num">${d.orderNumber ? '#' + esc(d.orderNumber) : '<span class="hint">—</span>'}</td>
        <td data-label="آخر تحديث"><bdi class="num">${esc(fmtDate(d.updatedAt))}</bdi></td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-desopen="${oid}">${icon('pen')} فتح ومراجعة</button>
          ${rowMenu([(d.orderId || !can('designs.convert')) ? null : menuItem(`data-desconv="${oid}"`, 'swap', 'تحويل إلى طلب'), can('designs.delete') ? menuItem(`data-desdel="${oid}"`, 'trash', 'حذف', true) : null], `إجراءات ${esc(d.number)}`)}
        </span></td>
      </tr>`;
    }).join('');
    $('#desPortalUrl').textContent = window.location.origin + '/customer-design';
    $('#desEmpty').hidden = list.length > 0;
    $$('[data-desopen]', tb).forEach((b) => b.addEventListener('click', () => openDesign(b.dataset.desopen)));
    $$('[data-desconv]', tb).forEach((b) => b.addEventListener('click', () => convertDesignFlow(b.dataset.desconv)));
    $$('[data-desdel]', tb).forEach((b) => b.addEventListener('click', () => deleteDesignFlow(b.dataset.desdel)));
    $$('[data-dessel]', tb).forEach((c) => c.addEventListener('change', () => {
      if (c.checked) desSel.ids.add(c.dataset.dessel); else desSel.ids.delete(c.dataset.dessel);
      syncDesSelection();
    }));
    syncDesSelection();
    prepareControls(tb);
  }

  async function renderDesigns() {
    if (!can('designs.view')) return;
    { const eb = $('#desEditBtn'); if (eb) eb.hidden = !can('designs.delete'); }
    if (!desBound) {
      desBound = true;
      $('#desSearch').addEventListener('input', () => renderDesigns());
      $$('#desStatusChips .chip').forEach((c) => c.addEventListener('click', () => {
        $$('#desStatusChips .chip').forEach((x) => { const on = x === c; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        desFilter.status = c.dataset.dstf || '';
        renderDesigns();
      }));
      // وضع التعديل: يعرض خيارات التحديد أعلى القائمة (بلا طلب شبكة)
      const eb = $('#desEditBtn');
      if (eb) eb.addEventListener('click', () => setDesEditMode(!desSel.edit));
      const eo = $('#desEditOff');
      if (eo) eo.addEventListener('click', () => setDesEditMode(false));
      const sa = $('#desSelAll');
      if (sa) sa.addEventListener('change', () => {
        const ids = designsCache.filter(desMatches).map((d) => d.id);
        desSel.ids = sa.checked ? new Set(ids) : new Set();
        syncDesSelection();
      });
      const bd = $('#desBulkDel');
      if (bd) bd.addEventListener('click', () => deleteSelectedDesigns());
    }
    desFilter.q = $('#desSearch').value || '';
    try { await fetchDesigns(); } catch (e) { toast('تعذّر جلب التصاميم: ' + designsError(e), true); return; }
    const fresh = designsCache.filter((d) => d.status === 'new').length;
    const badge = $('#desBadge');
    if (badge) badge.hidden = !fresh;
    if (badge) badge.textContent = fresh > 99 ? '99+' : String(fresh);
    paintDesigns();
  }

  /** ملخص هندسي للعرض (أسماء فقط، بلا أسعار) */
  function desFacts(design) {
    const d = design || { walls: [], openings: [], pieces: [] };
    const walls = (d.walls || []).map((w) => w.len + 'م').join(' × ');
    let doors = 0, wins = 0, tvs = 0, meters = 0;
    const accs = {};
    (d.openings || []).forEach((o) => { if (o.type === 'door') doors++; else if (o.type === 'window') wins++; else if (o.type === 'tv') tvs++; });
    (d.pieces || []).forEach((p) => {
      if (p.kind === 'sofa') meters += num(p.w);
      else if (p.kind === 'acc') { const n = (getItem(p.itemId) || {}).name || 'إكسسوار'; accs[n] = (accs[n] || 0) + 1; }
    });
    return { walls: walls || '—', doors, wins, tvs, meters: Math.round(meters * 100) / 100, accs };
  }

  async function openDesign(id) {
    let d;
    try {
      const r = await Store.api('GET', '/api/designs/' + encodeURIComponent(id));
      d = r.design;
    } catch (e) { toast('تعذّر فتح التصميم: ' + designsError(e), true); return; }
    if (!d) return;
    const f = desFacts(d.design);
    openModal(`تصميم ${d.number || ''}`, `
      <div class="des-view">
        <div class="des-canvasbar">
          ${can('designs.edit') ? '' : '<span class="hint">عرض فقط — التعديل يتطلب صلاحية «تعديل التصاميم»</span>'}
          <button type="button" class="btn small" id="dvUndo"${can('designs.edit') ? '' : ' hidden'}>تراجع</button>
          <button type="button" class="btn small" id="dvFit">ملاءمة</button>
          <button type="button" class="btn small danger" id="dvDel"${can('designs.edit') ? '' : ' hidden'}>حذف المحدد</button>
          <button type="button" class="btn small primary" id="dvSaveGeo"${can('designs.edit') ? '' : ' hidden'}>حفظ التعديل</button>
        </div>
        <div class="canvas-wrap des-canvas"><canvas id="dvCanvas"></canvas></div>
        <dl class="p-facts">
          <div><dt>الحالة</dt><dd><select id="dvStatus" aria-label="حالة التصميم"${can('designs.edit') ? '' : ' disabled'}>${Object.entries(DESIGN_STATUS).map(([k, v]) => `<option value="${k}"${d.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></dd></div>
          <div><dt>العميل</dt><dd>${esc(d.name || '—')}${d.phone ? ` <span class="num">${esc(d.phone)}</span>` : ''}${d.contactRequested ? ' <span class="badge st-delivered">طلب التواصل</span>' : ''}</dd></div>
          <div><dt>الغرفة</dt><dd>${esc(f.walls)}</dd></div>
          <div><dt>أبواب / شبابيك / تلفاز</dt><dd>${f.doors} / ${f.wins} / ${f.tvs}</dd></div>
          <div><dt>أمتار الكنب</dt><dd>${f.meters} م</dd></div>
          <div><dt>الطلب المرتبط</dt><dd>${d.orderNumber ? '#' + esc(d.orderNumber) : '—'}</dd></div>
        </dl>
        <div class="btn-row">
          ${d.phone ? `<button type="button" class="btn" id="dvWa">${icon('whatsapp')} واتساب</button><button type="button" class="btn" id="dvCall">${icon('phone')} اتصال</button>` : ''}
          <button type="button" class="btn" id="dvPdf">${icon('file')} PDF التصميم</button>
          ${(d.orderId || !can('designs.convert')) ? '' : `<button type="button" class="btn primary" id="dvConvert">تحويل إلى طلب</button>`}
        </div>
        <p class="error" id="dvErr" role="alert"></p>
      </div>`, (b) => {
      const cv = $('#dvCanvas', b);
      const viewer = new Designer(cv, { getItem, pieceSpecLabel: () => '', pieceStyle: (typeof pieceStyle === 'function' ? pieceStyle : undefined) });
      try { viewer.setState(JSON.parse(JSON.stringify(d.design || {}))); } catch (_) { /* noop */ }
      viewer.fitView();
      $('#dvUndo', b).onclick = () => viewer.undo();
      $('#dvFit', b).onclick = () => viewer.fitView();
      $('#dvDel', b).onclick = () => { viewer.removeSelected(); };
      $('#dvSaveGeo', b).onclick = async () => {
        try {
          await Store.api('PUT', '/api/designs/' + encodeURIComponent(id), { design: viewer.getState() });
          toast('حُفظ تعديل التصميم');
          renderDesigns();
        } catch (e) { $('#dvErr', b).textContent = designsError(e); }
      };
      $('#dvStatus', b).onchange = async (e) => {
        try {
          await Store.api('PUT', '/api/designs/' + encodeURIComponent(id), { status: e.target.value });
          toast('حُدّثت الحالة');
          renderDesigns();
        } catch (err) { $('#dvErr', b).textContent = designsError(err); e.target.value = d.status; }
      };
      const wa = $('#dvWa', b);
      if (wa) wa.onclick = () => openExternal('https://wa.me/' + String(d.phone).replace(/\D/g, '') + '?text=' + encodeURIComponent(`السلام عليكم${d.name ? ' ' + d.name : ''}، معك ${settings().shopName || 'أصالة نجد'} بخصوص تصميمك ${d.number}.`));
      const call = $('#dvCall', b);
      if (call) call.onclick = () => { window.location.href = 'tel:+' + String(d.phone).replace(/\D/g, '').replace(/^00/, ''); };
      $('#dvPdf', b).onclick = async () => {
        try {
          const blob = await makeDesignSheetBlob(d);
          downloadBlob(blob, `design-${d.number || d.id}.pdf`);
        } catch (e) { $('#dvErr', b).textContent = e.message || 'تعذّر إنشاء PDF.'; }
      };
      const conv = $('#dvConvert', b);
      if (conv) conv.onclick = () => { closeModal(); convertDesignFlow(id); };
    }, 'drawer wide');
  }

  /** ورقة PDF للتصميم من جهة الموظف (هندسة فقط، بلا مالية)
      تُبنى من الوحدة المشتركة js/design-sheet.js — نفس ورقة العميل
      حرفياً، والمكوّنات الإضافية في صدر الصفحة فقط. */
  async function makeDesignSheetBlob(d) {
    if (!navigator.onLine) throw new Error('تصدير PDF يحتاج اتصالًا بالإنترنت.');
    try { await loadScript(H2C_URL); await loadScript(JSPDF_URL); }
    catch (_) { throw new Error('تعذّر تحميل مكتبة PDF. تحقق من الاتصال.'); }
    const meta = [
      { label: 'التصميم', value: d.number || '—' },
      { label: 'العميل', value: d.name || '—' },
      { label: 'الجوال', value: d.phone || '—' },
      { label: 'الحالة', value: DESIGN_STATUS[d.status] || '—' },
    ];
    return DesignSheet.pdfBlob({
      design: d.design,
      getItem,
      pieceStyle: (typeof pieceStyle === 'function' ? pieceStyle : undefined),
      meta,
      footHtml: await sheetFootHtml(),
      mount: $('#printArea'),
      // الورقة بمقاسها المختار: العرض والارتفاع يصلان من stamp (لا ثابت A4)
      addLinks: (pdf, el, x0, y0, wMm, hMm) => addPdfLinksToDoc(pdf, el, x0, y0, wMm, hMm),
    });
  }

  async function convertDesignFlow(id) {
    const d = designsCache.find((x) => x.id === id);
    if (d && d.orderId) { toast(`محوَّل مسبقاً للطلب #${d.orderNumber}`); return; }
    if (!(await confirmDlg('تحويل إلى طلب', `إنشاء طلب جديد من التصميم ${d ? d.number : ''}؟ يبقى التصميم الأصلي محفوظاً.`))) return;
    let r;
    try {
      r = await Store.api('POST', '/api/designs/' + encodeURIComponent(id) + '/convert');
    } catch (e) { toast('تعذّر التحويل: ' + designsError(e), true); return; }
    toast(`أُنشئ الطلب #${r.number} من التصميم`);
    await Store.refresh().catch(() => {});
    const o = db().orders.find((x) => x.id === r.orderId);
    if (o) loadOrder(o);
    renderDesigns();
  }

  /* ---------------- عن التطبيق ---------------- */
  function renderAbout() {
    const s = settings();
    const nm = $('#aboutShopName'); if (nm) nm.textContent = s.shopName || 'أصالة نجد';
    const yr = $('#aboutYear'); if (yr) yr.textContent = new Date().getFullYear();
    const v = $('#aboutVersion'); if (v) v.textContent = APP_VERSION;
    // فحص تحديث التطبيق (يدوي فقط): يعمل متى توفرت js/update.js وخادم بعيد
    try {
      if (window.AppUpdate && typeof window.AppUpdate.versionCodeOf === 'function') {
        window.AppUpdate.initBox({
          current: { versionName: APP_VERSION, versionCode: window.AppUpdate.versionCodeOf(APP_VERSION) },
          els: {
            check: $('#btnCheckUpdate'), status: $('#updateStatus'),
            progress: $('#updateProgress'), bar: $('#updateProgressBar'),
            label: $('#updateProgressLabel'), dl: $('#btnDownloadUpdate'),
          },
          notify: (ev) => { if (ev === 'installed') refreshServiceWorker(); },
        });
      }
    } catch (_) { /* فشل ربط التحديث لا يمنع عرض الصفحة */ }
    // روابط الوصول السريع: تُبنى من نفس الأصل (تعمل إنتاج/تجريبي/محلي بلا hard-code)
    try { wireAccessLinks(); } catch (_) { /* noop */ }
  }
  /* ---------------- إحصاءات حركة الزوار (مدير) ----------------
     مصدران: (1) زيارات فعلية من الخادم لصفحات الزوار العامة،
     و(2) عدّاد نقرات محلي لأزرار «فتح/نسخ/مشاركة» في هذه الصفحة. */
  const VISIT_KEY = 'majlis_visit_clicks_v1';

  function loadVisitClicks() {
    try { return JSON.parse(localStorage.getItem(VISIT_KEY)) || {}; } catch (_) { return {}; }
  }
  function bumpVisitClick(kind) {
    try {
      const c = loadVisitClicks();
      c[kind] = (c[kind] || 0) + 1;
      localStorage.setItem(VISIT_KEY, JSON.stringify(c));
    } catch (_) { /* noop */ }
  }

  async function renderVisitStats() {
    const box = $('#visitStatsBox');
    if (!box) return;
    if (!can('admin.core')) { box.hidden = true; return; }
    box.hidden = false;
    const body = $('#visitStatsBody');
    const clicks = loadVisitClicks(); delete clicks.expanded;   // عدّاد الرابط التجريبي الملغى لا يُحتسب
    const clickTotal = Object.values(clicks).reduce((a, b) => a + (Number(b) || 0), 0);
    let server = null, err = '';
    try { server = (await Store.api('GET', '/api/link-visits')) || null; }
    catch (e) { err = humanError(e && e.message, 'تعذّر تحميل الإحصاءات. تحقق من الاتصال.'); }
    let html = '';
    if (err) {
      html = `<p class="vs-err" role="alert">${esc(err)}</p>`;
    } else {
      /* الصفحات التي يسجّل الخادم زياراتها فعلاً (لا صفوف ثابتة دائماً صفر) */
      const links = (server && server.links) || { customer: 'بوابة العميل' };
      const B = (server && server.byLink) || {};
      const keys = Object.keys(links);
      // الزوار من إجمالي الخادم الفريد عبر الصفحتين (جمع زوار كل صفحة يعدّ الجهاز الذي فتح الصفحتين مرتين)
      const T = (server && server.totals) || null;
      const tot = (p) => keys.reduce((a, k) => {
        const r = B[k] && B[k][p]; return { visits: a.visits + num(r && r.visits), visitors: T ? a.visitors : a.visitors + num(r && r.visitors) };
      }, { visits: 0, visitors: T && T[p] ? num(T[p].visitors) : 0 });
      const allTime = keys.reduce((a, k) => a + num(B[k] && B[k].all), 0);
      const P = [['today', 'اليوم'], ['d7', 'آخر ٧ أيام'], ['d30', 'آخر ٣٠ يوماً']];
      // 1) بطاقات الفترات: الزيارات رقم كبير، والزوار تحته
      html += '<div class="vs-cards">' + P.map(([p, label]) => {
        const t = tot(p);
        return `<div class="vs-card"><span class="vs-card-lbl">${label}</span><b class="num">${num(t.visits).toLocaleString('en-US')}</b><small>زيارة · <bdi class="num">${num(t.visitors).toLocaleString('en-US')}</bdi> زائر</small></div>`;
      }).join('') + `<div class="vs-card vs-card-all"><span class="vs-card-lbl">منذ البداية</span><b class="num">${allTime.toLocaleString('en-US')}</b><small>زيارة</small></div></div>`;
      if (!allTime) html += '<p class="hint">لا توجد زيارات مسجّلة بعد. تظهر الأرقام فور وصول أول زائر لصفحات العملاء.</p>';
      // 2) لكل صفحة: الزيارات والزوار في عمودين واضحين لكل فترة
      html += `<div class="table-wrap"><table class="table compact vs-table"><thead><tr><th>الصفحة</th>${P.map(([, l]) => `<th class="ta-end">${l}</th>`).join('')}<th class="ta-end">منذ البداية</th></tr></thead><tbody>`
        + keys.map((k) => `<tr><td><b>${esc(links[k])}</b></td>${P.map(([p]) => {
          const r = B[k] && B[k][p];
          return `<td class="ta-end"><b class="num">${num(r && r.visits)}</b><small class="vs-sub"><bdi class="num">${num(r && r.visitors)}</bdi> زائر</small></td>`;
        }).join('')}<td class="ta-end"><b class="num">${num(B[k] && B[k].all)}</b></td></tr>`).join('')
        + '</tbody></table></div>';
      // 3) رسم آخر ٣٠ يوماً: عمود لكل يوم (مجموع الصفحتين) — أيام الصفر ظاهرة
      const todayKey = (server && server.today) || today();
      const per = new Map();
      keys.forEach((k) => ((B[k] && B[k].days) || []).forEach((d) => per.set(d.day, (per.get(d.day) || 0) + num(d.n))));
      const days = [];
      for (let i = 29; i >= 0; i--) { const d = new Date(Date.parse(todayKey + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10); days.push({ d, n: per.get(d) || 0 }); }
      const max = Math.max(1, ...days.map((x) => x.n));
      const peak = days.reduce((a, x) => (x.n > a.n ? x : a), { n: 0 });
      const avg = Math.round((days.reduce((s, x) => s + x.n, 0) / 30) * 10) / 10;
      html += `<div class="vs-chart-head"><b>آخر ٣٠ يوماً</b><span class="hint">متوسط <bdi class="num">${avg}</bdi> زيارة يومياً${peak.n ? ` · الأعلى <bdi class="num">${peak.n}</bdi> في <bdi dir="ltr">${esc(peak.d)}</bdi>` : ''}</span></div>`
        + `<div class="vs-chart" role="img" aria-label="الزيارات اليومية لآخر ٣٠ يوماً">${days.map((x) => `<span class="vs-bar${x.d === peak.d && x.n ? ' peak' : ''}" style="height:${Math.max(2, Math.round((x.n / max) * 100))}%" title="${esc(x.d)}: ${x.n} زيارة"></span>`).join('')}</div>`
        + `<div class="vs-axis"><bdi dir="ltr">${esc(days[0].d)}</bdi><bdi dir="ltr">${esc(days[29].d)}</bdi></div>`;
      html += '<p class="hint vs-note">الزيارة = كل فتح للصفحة، والزائر = جهاز واحد في اليوم. الروبوتات ومعاينات الروابط مستبعدة، والأيام بتوقيت المحل.</p>';
      // 4) أهم المصادر لآخر ٣٠ يوماً (من روابط القنوات ?src=…)
      const SRC = (server && server.sources) || [];
      const srcName = (k) => (window.Reports && Reports.srcLabel ? Reports.srcLabel(k) : k);
      const srcMax = Math.max(1, ...SRC.map((x) => num(x.n)));
      html += '<div class="vs-chart-head"><b>من أين جاء الزوار؟ (آخر ٣٠ يوماً)</b></div>'
        + (SRC.length && SRC.some((x) => x.dim !== 'direct')
          ? '<ul class="vs-src">' + SRC.map((x) => `<li><span class="vs-src-name">${esc(srcName(x.dim))}</span><span class="vs-src-bar"><i style="width:${Math.max(3, Math.round((num(x.n) / srcMax) * 100))}%"></i></span><b class="num">${num(x.n)}</b></li>`).join('') + '</ul>'
          : '<p class="hint">لا مصادر مسجّلة بعد — شارك روابط القنوات أدناه بدل الرابط العام لتعرف أي قناة تجلب الزوار والطلبات.</p>');
      // 5) روابط القنوات: رابط لكل قناة + اسم حملة مخصّص
      const CH = [['whatsapp', 'واتساب'], ['instagram', 'إنستغرام'], ['tiktok', 'تيك توك'], ['snapchat', 'سناب شات'], ['x', 'إكس'], ['google', 'خرائط Google'], ['qr', 'رمز QR (المعرض والمطبوعات)'], ['sms', 'رسالة نصية']];
      html += `<details class="vs-links"><summary><b>روابط القنوات</b> <span class="hint">— انشر لكل قناة رابطها لتعرف مصدر كل زائر وطلب</span></summary>
        <div class="vs-links-list">${CH.map(([k, l]) => `<div class="vs-link"><span>${esc(l)}</span><input class="ltr num" readonly value="${esc(srcLink(k))}" aria-label="رابط ${esc(l)}"><button type="button" class="btn small" data-srccopy="${esc(k)}">${icon('copy')}<span>نسخ</span></button><button type="button" class="btn small" data-srcshare="${esc(k)}">${icon('upload')}<span>مشاركة</span></button></div>`).join('')}
          <div class="vs-link vs-link-custom"><span>حملة مخصّصة</span><input id="vsSrcCustom" class="ltr" maxlength="24" placeholder="ramadan_ad" aria-label="اسم الحملة بأحرف لاتينية"><button type="button" class="btn small" id="vsSrcCustomCopy">${icon('copy')}<span>نسخ الرابط</span></button></div>
          <p class="hint">اسم الحملة بأحرف لاتينية وأرقام فقط (مثل ramadan_ad). يظهر في التقرير كما كتبته.</p>
        </div></details>`;
      let staffHtml = '';
      // 6) الموظفون (آخر الصفحة بعد بيانات العملاء): من فتح تطبيق الموظفين (بالاسم — الموظف مسجّل الدخول)
      const SF = (server && server.staff) || null;
      if (SF) {
        staffHtml += '<div class="vs-chart-head vs-staff-head"><b>دخول الموظفين للتطبيق</b><span class="hint">من فتح تطبيق الموظفين ومتى</span></div>';
        staffHtml += '<div class="vs-cards vs-staff-cards">' + P.map(([p, label]) => {
          const r = SF[p] || {};
          return `<div class="vs-card"><span class="vs-card-lbl">${label}</span><b class="num">${num(r.users).toLocaleString('en-US')}</b><small>موظف · <bdi class="num">${num(r.opens).toLocaleString('en-US')}</bdi> مرة فتح</small></div>`;
        }).join('') + '</div>';
        const U = SF.byUser || [];
        const when = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('ar-SA-u-nu-latn', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
        staffHtml += U.length
          ? `<div class="table-wrap"><table class="table compact vs-table vs-staff-table"><thead><tr><th>الموظف</th><th class="ta-end">أيام الدخول</th><th class="ta-end">مرات الفتح</th><th class="ta-end">آخر دخول</th></tr></thead><tbody>`
            + U.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td class="ta-end num">${num(u.days)}</td><td class="ta-end num">${num(u.opens)}</td><td class="ta-end"><bdi>${esc(when(u.lastAt))}</bdi></td></tr>`).join('')
            + '</tbody></table></div><p class="hint vs-note">آخر ٣٠ يوماً. «مرة فتح» = فتح التطبيق بعد غياب نصف ساعة أو أكثر؛ بقاء التطبيق مفتوحاً لا يُحسب مرات إضافية.</p>'
          : '<p class="hint">لم يُسجَّل دخول أي موظف بعد. يبدأ العدّ من تاريخ هذا التحديث.</p>';
      }
      html += staffHtml;
    }
    html += `<div class="vs-foot">${can('reports.view_all') || canAny('reports.view_own', 'reports.view_all') ? '<button type="button" class="btn small primary" id="btnVisitsReport">' + icon('file') + ' تقرير الزيارات المفصّل والطباعة</button>' : ''}<span class="hint">نقراتك على أزرار الفتح/النسخ/المشاركة: <b class="num">${num(clickTotal)}</b> (على هذا الجهاز فقط)</span></div>`;
    if (body) {
      body.innerHTML = html;
      const go = $('#btnVisitsReport', body);
      if (go) go.onclick = () => { repId = 'visits'; repStore.set('id', repId); showPage('reports'); };
      $$('[data-srccopy]', body).forEach((b) => b.addEventListener('click', () => srcCopy(srcLink(b.dataset.srccopy))));
      $$('[data-srcshare]', body).forEach((b) => b.addEventListener('click', async () => {
        const u = srcLink(b.dataset.srcshare);
        if (navigator.share) { try { await navigator.share({ title: settings().shopName || 'أصالة نجد', text: 'صمّم مجلسك بنفسك', url: u }); return; } catch (_) { /* أُلغيت المشاركة */ } }
        srcCopy(u);
      }));
      const cc = $('#vsSrcCustomCopy', body);
      if (cc) cc.addEventListener('click', () => {
        const v = String($('#vsSrcCustom', body).value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
        if (!v) { toast('اكتب اسم الحملة بأحرف لاتينية أو أرقام', true); return; }
        $('#vsSrcCustom', body).value = v;
        srcCopy(srcLink(v));
      });
    }
  }

  /** رابط صفحة العميل لقناة معيّنة (?src=…) — يبني على الرابط الرسمي نفسه */
  const srcLink = (k) => ACCESS_LINKS.customer + '?src=' + encodeURIComponent(k);
  async function srcCopy(u) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(u);
      else { const ta = document.createElement('textarea'); ta.value = u; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      toast('نُسخ الرابط');
    } catch (_) { toast('تعذّر النسخ — انسخ الرابط يدوياً', true); }
  }

  /* روابط الوصول الرسمية الثابتة (من إعداد النشر: Worker majlis-api + مستودع ialshareef/majlis-orders).
     ثابتة عمداً: لا تتغير بين المحلي والتجريبي والإنتاج، ولا تُبنى من location.origin. */
  const ACCESS_LINKS = {
    customer: 'https://majlis-api.asalh-najd.workers.dev/customer-design',
    staff: 'https://majlis-api.asalh-najd.workers.dev/',
  };
  const APK_RELEASES_URL = 'https://github.com/ialshareef/majlis-orders/releases/latest';

  /** روابط العميل والموظفين: فتح/نسخ/مشاركة (Web Share API مع بديل النسخ) */
  let linksWired = false;
  function wireAccessLinks() {
    const box = $('#linksBox');
    if (!box || linksWired) return;
    const urls = {
      customerLink: ACCESS_LINKS.customer,
      staffLink: ACCESS_LINKS.staff,
    };
    Object.entries(urls).forEach(([id, url]) => {
      const inp = document.getElementById(id);
      if (inp) inp.value = url;
    });
    const open = (id) => { const u = document.getElementById(id).value; window.open(u, '_blank', 'noopener'); };
    const copy = async (id) => {
      const u = document.getElementById(id).value;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(u);
        else {
          const ta = document.createElement('textarea');
          ta.value = u; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        toast('تم نسخ الرابط');
      } catch (_) { toast('تعذّر النسخ — انسخ الرابط يدوياً', true); }
    };
    const share = async (id, title) => {
      const u = document.getElementById(id).value;
      try {
        if (navigator.share) { await navigator.share({ title, url: u }); return; }
        throw new Error('no-share');
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        await copy(id);
      }
    };
    const bind = (btn, fn, kind) => {
      const b = document.getElementById(btn);
      if (!b) return;
      b.onclick = () => { if (kind) bumpVisitClick(kind); fn(); };
    };
    bind('btnOpenCustomer', () => open('customerLink'), 'customer');
    bind('btnCopyCustomer', () => copy('customerLink'), 'customer');
    bind('btnShareCustomer', () => share('customerLink', 'واجهة العميل — مصمم المجالس'), 'customer');
    bind('btnOpenStaff', () => open('staffLink'), 'staff');
    bind('btnCopyStaff', () => copy('staffLink'), 'staff');
    bind('btnShareStaff', () => share('staffLink', 'واجهة الموظفين والمناديب'), 'staff');
    // تطبيق أندرويد: رابط ملف APK لآخر إصدار من GitHub (من بيانات التحديث الرسمية)، وصفحة الإصدارات احتياطاً
    const apkInp = document.getElementById('apkLink');
    if (apkInp) {
      apkInp.value = APK_RELEASES_URL;
      fetch(ACCESS_LINKS.staff + 'api/app-update', { cache: 'no-store', credentials: 'omit' }).then((r) => r.json()).then((d) => {
        const u = d && d.update;
        if (u && typeof u.apkUrl === 'string' && u.apkUrl.indexOf('https://github.com/ialshareef/majlis-orders/') === 0) {
          apkInp.value = u.apkUrl;
          const info = document.getElementById('apkLinkInfo');
          if (info && u.versionName) info.textContent = 'الإصدار ' + u.versionName + ' من GitHub — للتثبيت على جوالات أندرويد';
        }
      }).catch(() => { /* يبقى رابط صفحة الإصدارات */ });
    }
    bind('btnOpenApk', () => open('apkLink'));
    bind('btnCopyApk', () => copy('apkLink'));
    bind('btnShareApk', () => share('apkLink', 'تطبيق أصالة نجد لأندرويد'));
    bind('btnInstallWeb', () => {
      if (window.MajlisInstall && window.MajlisInstall.available()) { window.MajlisInstall.open(); return; }
      if (window.MajlisInstall) window.MajlisInstall.open();
      const st = document.getElementById('installWebStatus');
      toast(st ? st.textContent : 'من قائمة المتصفح اختر «تثبيت التطبيق»');
    });
    linksWired = true;
  }

  /** بعد تثبيت تحديث: حدّث الـ Service Worker ليقدّم النسخة الجديدة فوراً */
  function refreshServiceWorker() {
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.update().catch(() => {})));
      }
    } catch (_) { /* noop */ }
  }

  /* ---------------- سجل تحديثات الطلبات (مدير) ---------------- */
  const ACTIONS = { create: 'إنشاء طلب', update: 'تعديل طلب', status: 'تغيير الحالة', cost: 'تعديل التكاليف', commission: 'نسبة البائع', owner: 'نقل الملكية', export: 'تصدير PDF', delete: 'حذف طلب', 'design-convert': 'تحويل تصميم عميل' };
  const ACTION_CLASS = { create: 'st-new', update: 'st-progress', status: '', cost: 'st-progress', owner: 'st-new', export: 'st-delivered', delete: 'st-cancelled' };
  const localDate = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const localTime = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  function logActivity(action, order, details = []) {
    return Store.log({
      action, userId: currentUser ? currentUser.id : null, userName: currentUser ? currentUser.name : '',
      orderId: order.id, orderNo: order.number, customer: (order.customer && order.customer.name) || '', total: num(order.total), details,
    });
  }

  function renderOrderMeta() {
    const el = $('#orderMeta');
    if (!cur.id) { el.textContent = ''; return; }
    const who = cur.updatedByName || cur.createdByName || '';
    el.textContent = `آخر تحديث: ${who} • ${fmtDateTimeUi(cur.updatedAt || cur.createdAt)} • أُنشئ بواسطة ${cur.createdByName || '—'}`;
  }

  /** مقارنة نسختين من الطلب وإرجاع ملخص التغييرات */
  function diffOrder(prev, next) {
    const ch = [];
    const pc = prev.customer || {}, nc = next.customer || {};
    if ((pc.name || '') !== (nc.name || '')) ch.push(`اسم العميل: من "${pc.name || '—'}" إلى "${nc.name || '—'}"`);
    if ((pc.phone || '') !== (nc.phone || '')) ch.push(`الجوال: من ${pc.phone || '—'} إلى ${nc.phone || '—'}`);
    if ((pc.address || '') !== (nc.address || '')) ch.push('تعديل مكان التوصيل');
    if ((prev.deliveryDate || '') !== (next.deliveryDate || '')) ch.push(`تاريخ التوصيل: من ${prev.deliveryDate || 'غير محدد'} إلى ${next.deliveryDate || 'غير محدد'}`);
    if ((prev.status || 'new') !== (next.status || 'new')) ch.push(`الحالة: من ${STATUS[prev.status] || prev.status} إلى ${STATUS[next.status] || next.status}`);
    if (r2(prev.paid) !== r2(next.paid)) ch.push(`المدفوع: من ${fmt(prev.paid)} إلى ${fmt(next.paid)}`);
    // الدفعات: ما أُضيف وما حُذف، بمبالغها وطرقها — لأنها مال لا تفصيل
    const pp = Array.isArray(prev.payments) ? prev.payments : [], np = Array.isArray(next.payments) ? next.payments : [];
    const payTxt = (p) => `${money(p.amount) < 0 ? 'استرداد' : 'دفعة'} ${fmt(Math.abs(money(p.amount)))} ${PAY_METHODS[p.method] || ''}`.trim();
    np.filter((p) => p.id !== 'legacy' && !pp.some((q) => q.id === p.id)).forEach((p) => ch.push(`${payTxt(p)} (${fmtDate(p.at)})`));
    pp.filter((p) => p.id !== 'legacy' && !np.some((q) => q.id === p.id)).forEach((p) => ch.push(`حذف ${payTxt(p)} (${fmtDate(p.at)})`));
    if (r2(prev.total) !== r2(next.total)) ch.push(`الإجمالي: من ${fmt(prev.total)} إلى ${fmt(next.total)}`);
    const pv = prev.vat || { enabled: false, rate: 0 }, nv = next.vat || { enabled: false, rate: 0 };
    if (!!pv.enabled !== !!nv.enabled) ch.push(nv.enabled ? `تفعيل الضريبة ${num(nv.rate)}%` : 'إلغاء الضريبة');
    else if (nv.enabled && num(pv.rate) !== num(nv.rate)) ch.push(`نسبة الضريبة: من ${num(pv.rate)}% إلى ${num(nv.rate)}%`);
    if ((prev.notes || '') !== (next.notes || '')) ch.push('تعديل الملاحظات');
    const pa = filledAttachments(prev), na = filledAttachments(next);
    if (pa.length !== na.length) ch.push(`المرفقات: من ${pa.length} إلى ${na.length} صورة`);
    else if (JSON.stringify(normalizeAttachments(prev.attachments)) !== JSON.stringify(normalizeAttachments(next.attachments))) ch.push('تعديل المرفقات');

    const pd = prev.design || {}, nd = next.design || {};
    const sig = (d) => JSON.stringify((d.walls || []).map((w) => [r2(w.len), w.angle]));
    if (sig(pd) !== sig(nd)) ch.push(`أبعاد الغرفة: من ${roomSummary(pd)} إلى ${roomSummary(nd)}`);
    const sofas = (d) => (d.pieces || []).filter((p) => p.kind === 'sofa');
    const accs = (d) => (d.pieces || []).filter((p) => p.kind === 'acc');
    const meters = (d) => r2(sofas(d).reduce((s, p) => s + num(p.w), 0));
    if (sofas(pd).length !== sofas(nd).length) ch.push(`قطع الكنب: من ${sofas(pd).length} إلى ${sofas(nd).length} (${meters(nd)} م)`);
    else if (meters(pd) !== meters(nd)) ch.push(`أمتار الكنب: من ${meters(pd)} إلى ${meters(nd)} م`);
    else {
      const sig2 = (d) => JSON.stringify(sofas(d).map((p) => [p.itemId, p.fabric || '', r2(p.w), r2(p.h), r2(p.x), r2(p.y), p.rot]));
      if (sig2(pd) !== sig2(nd)) ch.push('تعديل الكنب (الأصناف أو القماش أو المواضع)');
    }
    const fabs = (d) => [...new Set(sofas(d).map((p) => (p.fabric || '').trim()).filter(Boolean))].sort().join('، ');
    if (fabs(pd) !== fabs(nd)) ch.push(`قماش مخصّص: ${fabs(nd) || 'أُزيل'}`);
    if (accs(pd).length !== accs(nd).length) ch.push(`الإكسسوارات: من ${accs(pd).length} إلى ${accs(nd).length}`);
    if ((pd.openings || []).length !== (nd.openings || []).length) ch.push(`الأبواب والشبابيك: من ${(pd.openings || []).length} إلى ${(nd.openings || []).length}`);
    if ((pd.cornerMode || 'deduct') !== (nd.cornerMode || 'deduct')) ch.push(`طريقة القياس: ${nd.cornerMode === 'full' ? 'بطول الجدار كامل' : 'بدون تكرار الزوايا'}`);
    if ((prev.manualRows || []).length !== (next.manualRows || []).length) ch.push(`الأصناف الإضافية: من ${(prev.manualRows || []).length} إلى ${(next.manualRows || []).length}`);
    const po = prev.priceOverrides || {}, no = next.priceOverrides || {};
    const priceEdits = Object.keys(no).filter((k) => po[k] !== undefined && r2(po[k]) !== r2(no[k])).length;
    if (priceEdits) ch.push(`تعديل ${priceEdits} سعر`);
    const pcost = orderCost(prev), ncost = orderCost(next);
    if (pcost !== ncost) ch.push(`التكاليف: من ${pcost === null ? 'غير محددة' : fmt(pcost)} إلى ${ncost === null ? 'غير محددة' : fmt(ncost)}`);
    return ch;
  }

  function filteredActivity() {
    const q = $('#actSearch').value.trim().toLowerCase();
    const user = $('#actUser').value, act = $('#actType').value;
    const from = $('#actFrom').value, to = $('#actTo').value;
    let list = db().activity.slice().reverse();
    if (user) list = list.filter((e) => e.userId === user);
    if (act) list = list.filter((e) => e.action === act);
    if (from) list = list.filter((e) => localDate(e.at) >= from);
    if (to) list = list.filter((e) => localDate(e.at) <= to);
    if (q) list = list.filter((e) => [e.orderNo, e.customer, e.userName, ...(e.details || [])].some((v) => String(v || '').toLowerCase().includes(q)));
    return list;
  }

  function renderActivity() {
    const all = db().activity;
    // خيارات الموظفين (من المستخدمين الحاليين ومن السجل)
    const userSel = $('#actUser');
    const prevUser = userSel.value;
    const names = new Map();
    db().users.forEach((u) => names.set(u.id, u.name));
    all.forEach((e) => { if (e.userId && !names.has(e.userId)) names.set(e.userId, e.userName || 'مستخدم محذوف'); });
    userSel.innerHTML = '<option value="">كل الموظفين</option>' + [...names.entries()].map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    if ([...names.keys()].includes(prevUser)) userSel.value = prevUser;

    // إحصائيات
    const tday = today();
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    const weekStr = localDate(weekAgo.toISOString());
    const byUser = {};
    all.forEach((e) => { const k = e.userName || '—'; byUser[k] = (byUser[k] || 0) + 1; });
    const top = Object.entries(byUser).sort((a, b) => b[1] - a[1])[0];
    const last = all[all.length - 1];
    $('#actStats').innerHTML = `
      <div class="stat"><span>تحديثات اليوم</span><b>${all.filter((e) => localDate(e.at) === tday).length}</b></div>
      <div class="stat"><span>آخر 7 أيام</span><b>${all.filter((e) => localDate(e.at) >= weekStr).length}</b></div>
      <div class="stat"><span>طلبات أُنشئت اليوم</span><b>${all.filter((e) => e.action === 'create' && localDate(e.at) === tday).length}</b></div>
      <div class="stat"><span>الأكثر نشاطاً</span><b class="stat-text">${top ? esc(top[0]) : '—'}</b>${top ? `<small>${top[1]} تحديث</small>` : ''}</div>
      <div class="stat"><span>آخر تحديث</span><b class="stat-text">${last ? esc(last.userName || '—') : '—'}</b>${last ? `<small>${fmtDateTimeUi(last.at)}</small>` : ''}</div>`;

    const list = filteredActivity();
    const tb = $('#actTable tbody');
    $('#actEmpty').hidden = list.length > 0;
    tb.innerHTML = list.slice(0, 500).map((e) => {
      const exists = db().orders.some((o) => o.id === e.orderId);
      const orderCell = e.orderNo
        ? (exists ? `<button class="link-btn" data-open="${esc(e.orderId)}">#${esc(e.orderNo)}</button>` : `<span title="الطلب محذوف">#${esc(e.orderNo)}</span>`)
        : 'مسودة';
      return `
      <tr>
        <td data-label="الوقت" class="act-time num">${localDate(e.at)}<small>${localTime(e.at)}</small></td>
        <td data-label="الموظف"><b>${esc(e.userName || '—')}</b></td>
        <td data-label="الطلب">${orderCell}</td>
        <td data-label="العميل">${esc(e.customer || '—')}</td>
        <td data-label="الإجراء"><span class="badge ${ACTION_CLASS[e.action] || ''}">${esc(ACTIONS[e.action] || e.action)}</span></td>
        <td data-label="التفاصيل" class="span2">${(e.details || []).map((d) => `<span class="chg">${esc(d)}</span>`).join('') || '<span class="hint">—</span>'}</td>
      </tr>`;
    }).join('');
    if (list.length > 500) tb.insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="hint center">يُعرض أول 500 من ${list.length} تحديث. استخدم الفلاتر أو صدّر CSV للكل.</td></tr>`);
    $$('[data-open]', tb).forEach((b) => b.addEventListener('click', async () => {
      const o = db().orders.find((x) => x.id === b.dataset.open);
      if (!o) return;
      if (dirty && !(await confirmDlg('فتح طلب', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) return;
      loadOrder(o);
    }));
  }
  ['actSearch', 'actUser', 'actType', 'actFrom', 'actTo'].forEach((id) => $('#' + id).addEventListener(id === 'actSearch' ? 'input' : 'change', renderActivity));
  $('#actClearFilters').addEventListener('click', () => {
    ['actSearch', 'actUser', 'actType', 'actFrom', 'actTo'].forEach((id) => { $('#' + id).value = ''; });
    renderActivity();
  });

  $('#btnActCsv').addEventListener('click', () => {
    const list = filteredActivity();
    if (!list.length) { toast('لا توجد بيانات للتصدير', true); return; }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['التاريخ', 'الوقت', 'الموظف', 'رقم الطلب', 'العميل', 'الإجراء', 'التفاصيل'].map(cell).join(',')];
    list.forEach((e) => rows.push([localDate(e.at), localTime(e.at), e.userName || '', e.orderNo || '', e.customer || '', ACTIONS[e.action] || e.action, (e.details || []).join(' | ')].map(cell).join(',')));
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `orders-activity-${today()}.csv`);
  });

  $('#btnActClear').addEventListener('click', async () => {
    if (!db().activity.length) return;
    if (!(await confirmDlg('مسح السجل', `سيتم حذف ${db().activity.length} تحديث من السجل نهائياً. الطلبات نفسها لن تتأثر. متابعة؟`))) return;
    db().activity = [];
    if (!(await Store.save())) { toast(humanError(Store.lastError), true); await Store.refresh().catch(() => {}); renderActivity(); return; }
    renderActivity();
    toast('تم مسح السجل');
  });

  /* ---------------- الإعدادات والنسخ الاحتياطي ---------------- */
  /* النسخة الاحتياطية: يُسجَّل وقت آخر تصدير في الإعدادات ليذكّر مركز التنبيهات
     المدير إن طالت المدة (تنبيه «backup»). */
  const BACKUP_DAYS = 7;
  async function exportBackup() {
    downloadBlob(new Blob([Store.exportJSON()], { type: 'application/json' }), `majlis-backup-${today()}.json`);
    if (!can('admin.core')) return;
    settings().lastBackupAt = Store.now();
    if (!(await Store.save())) toast('نُزّلت النسخة، لكن تعذّر تسجيل وقتها على الخادم', true);
    else toast('نُزّلت النسخة الاحتياطية — احفظها في مكان آمن خارج هذا الجهاز');
    renderNotifications();
  }

  /* المظهر: فاتح / داكن / حسب الجهاز — تفضيل عرض لكل جهاز، لا إعداد مشترك */
  const THEME_KEY = 'majlis_theme';
  const themePref = () => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (_) { return 'auto'; } };
  function applyTheme() {
    const p = themePref();
    if (p === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = p;
    const dark = p === 'dark' || (p === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#171411' : '#F6F2EB');
  }
  function setTheme(p) { try { localStorage.setItem(THEME_KEY, p); } catch (_) { /* ignore */ } applyTheme(); }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  applyTheme();

  /* الإعدادات صفحة مستقلة لا نافذة: نموذج طويل بأقسام، والحفظ في مكان ثابت.
     الحقول وأسماؤها كما كانت (sName، sVatNo…)، ويُقرأ كائن الإعدادات عند الحفظ لا عند الفتح. */
  function renderSettings() {
    if (!can('settings.manage')) return;
    const s = settings();
    const b = $('#settingsBody');
    b.innerHTML = `
      <section class="set-section">
        <div class="set-head"><h3>بيانات المحل</h3><p>تظهر في رأس أمر الشراء وأمر التصنيع والسندات.</p></div>
        <div class="set-body">
          <label>اسم المحل <input id="sName" value="${esc(s.shopName || '')}"></label>
          <div class="row2">
            <label>الجوال <input id="sPhone" value="${esc(s.phone || '')}" inputmode="tel"></label>
            <label>العملة <input id="sCur" value="${esc(s.currency || 'ر.س')}"></label>
          </div>
          <label>العنوان <input id="sAddr" value="${esc(s.address || '')}"></label>
        </div>
      </section>
      <section class="set-section">
        <div class="set-head"><h3>بوابة العميل والتسويق</h3><p>تظهر في صفحة التصميم العامة للعملاء. الروابط https فقط — والأرقام وحدها تُحوَّل تلقائياً.</p></div>
        <div class="set-body">
          <label>وصف تسويقي قصير <input id="sTagline" maxlength="140" value="${esc(s.tagline || '')}" placeholder="صمّم مجلسك حسب مقاسات غرفتك"></label>
          <label>شعار المحل (رابط صورة https) <input id="sLogo" dir="ltr" value="${esc(s.logoUrl || '')}" placeholder="https://…/logo.png"></label>
          <label>رابط موقع المحل (خرائط جوجل) <input id="sMaps" dir="ltr" value="${esc(s.mapsUrl || '')}" placeholder="https://maps.google.com/…"></label>
          <div class="row2">
            <label>واتساب المحل <input id="sWa" dir="ltr" value="${esc(s.whatsapp || '')}" placeholder="https://wa.me/9665… أو الرقم فقط"></label>
            <label>Instagram <input id="sIg" dir="ltr" value="${esc(s.instagram || '')}" placeholder="https://instagram.com/…"></label>
          </div>
          <div class="row2">
            <label>TikTok <input id="sTik" dir="ltr" value="${esc(s.tiktok || '')}" placeholder="https://tiktok.com/…"></label>
            <label>Snapchat <input id="sSnap" dir="ltr" value="${esc(s.snapchat || '')}" placeholder="https://snapchat.com/…"></label>
          </div>
          <p class="hint">رابط البوابة للعملاء: <bdi class="num url-line">${esc(window.location.origin + '/customer-design')}</bdi></p>
        </div>
      </section>
      <section class="set-section">
        <div class="set-head"><h3>الضريبة وشروط أمر الشراء</h3><p>حين تُفعَّل الضريبة ويُسجَّل الرقم الضريبي تصير الفاتورة «فاتورة ضريبية مبسطة» برمز QR.</p></div>
        <div class="set-body">
          <label>شروط تظهر في أمر الشراء (اختياري) <input id="sInvNote" value="${esc(s.invoiceNote || '')}" placeholder="مثال: العربون غير مسترد، مدة التنفيذ 10 أيام"></label>
          <div class="row2">
            <label>الرقم الضريبي <input id="sVatNo" value="${esc(s.vatNumber || '')}" class="ltr"></label>
            <label>نسبة ضريبة القيمة المضافة % <input id="sVatRate" type="number" min="0" max="100" step="0.5" value="${num(s.vatRate ?? VAT_POLICY.fallbackRate)}"></label>
          </div>
          <label class="inline-check"><input id="sVatOn" type="checkbox" ${s.vatEnabled !== false ? 'checked' : ''}> تفعيل الضريبة افتراضياً في الطلبات الجديدة (يمكن إلغاؤها لكل طلب)</label>
        </div>
      </section>
      <section class="set-section">
        <div class="set-head"><h3>افتراضيات الطلبات</h3><p>تُطبَّق على الطلبات الجديدة، ويمكن تغييرها داخل كل طلب.</p></div>
        <div class="set-body">
          <label>طريقة قياس الكنب
            <select id="sCorner"><option value="deduct" ${s.cornerMode !== 'full' ? 'selected' : ''}>بدون تكرار الزوايا (موصى به)</option><option value="full" ${s.cornerMode === 'full' ? 'selected' : ''}>بطول الجدار كامل (الزاوية تُحسب مرتين)</option></select>
          </label>
          <div class="row2">
            <label>العربون المطلوب % <input id="sDeposit" type="number" min="0" max="100" step="5" value="${num(s.depositPct ?? 25)}"><small class="hint">يُطلب تأكيد عند بدء تنفيذ طلب مدفوعه أقل. 0 = بلا تنبيه.</small></label>
            <label>صلاحية عرض السعر (أيام) <input id="sQuoteDays" type="number" min="1" max="90" step="1" value="${num(s.quoteDays) || 7}"></label>
          </div>
          <div class="row2">
            <label>نسبة عمولة البائع % <input id="sSellerRate" type="number" min="0" max="100" step="0.5" value="${num(s.sellerRate ?? 10)}"><small class="hint">تُطبَّق افتراضياً على طلبات البائع، ويمكن تغييرها لكل طلب من زر «نسبة البائع».</small></label>
            <label>نسبة عمولة المناديب % <input id="sMandoubRate" type="number" min="0" max="100" step="0.5" value="${num(s.mandoubRate ?? 5)}"><small class="hint">نسبة مستقلة للمناديب (خارج الشركة)، لا تُشارك مع الفريق الداخلي.</small></label>
          </div>
          <div class="row2">
            <label>نسبة المشاركة (باقي البائعين والإدارة) % <input id="sShareRate" type="number" min="0" max="100" step="0.5" value="${num(s.shareRate ?? 5)}"><small class="hint">تُخصم من مبيعات البائع وتُوزَّع بالتساوي على الفريق الداخلي آخر الشهر.</small></label>
            <label>تُحسب كل النسب من
              <select id="sCommBase"><option value="profit" ${s.commBase !== 'total' ? 'selected' : ''}>صافي الربح (البيع قبل الضريبة − التكاليف)</option><option value="total" ${s.commBase === 'total' ? 'selected' : ''}>الإجمالي شامل الضريبة (السعر الشامل)</option></select>
              <small class="hint">ينطبق على عمولة البائع والمندوب والمندوب الأعلى وحصة المشاركة، في كل الطلبات القديمة والجديدة. «الإجمالي» لا يحتاج إدخال التكاليف.</small></label>
          </div>
        </div>
      </section>
      <div class="set-save">
        <p class="hint">التغييرات أعلاه لا تُطبَّق حتى تحفظها.</p>
        <button class="btn primary" id="sSave">${icon('check')} حفظ الإعدادات</button>
      </div>
      <section class="set-section">
        <div class="set-head"><h3>النسخ الاحتياطي</h3><p>${Store.isRemote ? 'التخزين سحابي (Cloudflare Worker + D1): الطلبات مشتركة بين كل الأجهزة والموظفين وتتزامن كل 30 ثانية.' : 'التخزين محلي: البيانات في هذا المتصفح على هذا الجهاز فقط. لمشاركة الطلبات بين عدة أجهزة راجع ملف SETUP-CLOUDFLARE.md.'}</p></div>
        <div class="set-body">
          <p class="hint mb-12">صدّر نسخة احتياطية بانتظام واحتفظ بها في مكان آمن خارج هذا الجهاز.</p>
          <div class="btn-row start">
            <button class="btn" id="sExport">${icon('download')} تصدير نسخة (JSON)</button>
            <label class="btn file-btn">${icon('upload')} استيراد نسخة <input id="sImport" type="file" accept="application/json,.json" hidden></label>
            <button class="btn danger" id="sReset" ${Store.isRemote ? 'disabled title="في الوضع السحابي تُمسح البيانات من لوحة Cloudflare (D1)"' : ''}>${icon('trash')} مسح كل البيانات</button>
          </div>
          <div class="set-stats">
            <span>الطلبات <b class="num">${db().orders.length}</b></span>
            <span>الأصناف <b class="num">${db().items.length}</b></span>
            <span>المستخدمون <b class="num">${db().users.length}</b></span>
            <span>آخر نسخة احتياطية ${s.lastBackupAt ? `<b>${esc(fmtDateTimeUi(s.lastBackupAt))}</b>` : '<b class="warn-text">لم تُصدَّر بعد</b>'}</span>
          </div>
        </div>
      </section>
      <section class="set-section">
        <div class="set-head"><h3>المظهر</h3><p>يُحفظ لهذا الجهاز فقط. أمر الشراء وملف PDF يبقيان بخلفية بيضاء دائماً.</p></div>
        <div class="set-body">
          <div class="segmented" id="sTheme" role="group" aria-label="مظهر الواجهة">
            <button type="button" data-theme-v="auto">حسب الجهاز</button>
            <button type="button" data-theme-v="light">فاتح</button>
            <button type="button" data-theme-v="dark">داكن</button>
          </div>
        </div>
      </section>`;
    prepareControls(b);
    const syncTheme = () => $$('[data-theme-v]', b).forEach((x) => { const on = x.dataset.themeV === themePref(); x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    $$('[data-theme-v]', b).forEach((x) => x.addEventListener('click', () => { setTheme(x.dataset.themeV); syncTheme(); }));
    syncTheme();
    $('#sSave', b).onclick = async () => {
      const btn = $('#sSave', b);
      // يُقرأ كائن الإعدادات الآن لا عند فتح الصفحة: أي مزامنة تستبدله بكائن جديد
      const s = settings();
      // تطبيع روابط التسويق: https صريح يُقبل، والأرقام وحدها تصير wa.me، وغيرها يُرفض برسالة
      const normUrl = (raw, allowDigits) => {
        const v = String(raw || '').trim();
        if (!v) return '';
        if (/^https:\/\//i.test(v) && !/[\s<>"]/.test(v)) return v;
        const d = v.replace(/[^\d]/g, '');
        if (allowDigits && /^\+?\d{7,15}$/.test(v.replace(/[\s-]/g, ''))) return 'https://wa.me/' + d;
        return null;
      };
      const mRaw = {
        tagline: $('#sTagline', b).value.trim().slice(0, 140),
        logoUrl: normUrl($('#sLogo', b).value, false),
        mapsUrl: normUrl($('#sMaps', b).value, false),
        whatsapp: normUrl($('#sWa', b).value, true),
        instagram: normUrl($('#sIg', b).value, false),
        tiktok: normUrl($('#sTik', b).value, false),
        snapchat: normUrl($('#sSnap', b).value, false),
      };
      const badM = Object.entries(mRaw).find(([k, v]) => v === null);
      if (badM) { toast(`رابط غير صالح في حقل التسويق (${badM[0]}): يلزم https صحيح أو رقم فقط للواتساب`, true); btn.disabled = false; btn.removeAttribute('aria-busy'); return; }
      Object.assign(s, {
        shopName: $('#sName', b).value.trim(), phone: $('#sPhone', b).value.trim(), address: $('#sAddr', b).value.trim(),
        currency: $('#sCur', b).value.trim() || 'ر.س', invoiceNote: $('#sInvNote', b).value.trim(), cornerMode: $('#sCorner', b).value, cornerModeChosen: true,
        vatNumber: $('#sVatNo', b).value.trim(), vatRate: Math.min(100, Math.max(0, num($('#sVatRate', b).value))), vatEnabled: $('#sVatOn', b).checked,
        depositPct: Math.min(100, Math.max(0, num($('#sDeposit', b).value))), quoteDays: Math.min(90, Math.max(1, Math.round(num($('#sQuoteDays', b).value) || 7))),
        sellerRate: Math.min(100, Math.max(0, num($('#sSellerRate', b).value))), mandoubRate: Math.min(100, Math.max(0, num($('#sMandoubRate', b).value))), shareRate: Math.min(100, Math.max(0, num($('#sShareRate', b).value))),
        commBase: $('#sCommBase', b).value === 'total' ? 'total' : 'profit',
        tagline: mRaw.tagline, logoUrl: mRaw.logoUrl, mapsUrl: mRaw.mapsUrl, whatsapp: mRaw.whatsapp,
        instagram: mRaw.instagram, tiktok: mRaw.tiktok, snapchat: mRaw.snapchat,
      });
      btn.disabled = true; btn.setAttribute('aria-busy', 'true');
      const ok = await Store.save();
      btn.disabled = false; btn.removeAttribute('aria-busy');
      if (!ok) { toast(humanError(Store.lastError), true); return; }
      applyPermissions(); renderItemSelects(); renderPricing(); toast('تم حفظ الإعدادات');
    };
    $('#sExport', b).onclick = () => exportBackup();
    $('#sImport', b).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const ok = await confirmDlg('استيراد نسخة', 'سيتم استبدال كل البيانات الحالية بمحتوى الملف. متابعة؟', 'استيراد واستبدال');
      e.target.value = '';   // اختيار الملف نفسه مرة أخرى يجب أن يطلق الحدث
      if (!ok) return;
      try {
        await Store.importJSON(await f.text());
        currentUser = Store.getUser(currentUser.id) || currentUser;
        applyPermissions(); renderItemSelects(); startNewOrder(true); showPage('orders');
        toast(Store.isRemote ? 'تم استيراد الأصناف والطلبات والإعدادات والسجل (المستخدمون لا يُستوردون في الوضع السحابي)' : 'تم استيراد البيانات');
      } catch (err) { toast('فشل الاستيراد: ' + err.message, true); }
    });
    $('#sReset', b).onclick = async () => {
      if (!(await confirmDlg('مسح البيانات', 'سيتم حذف كل الطلبات والأصناف والمستخدمين نهائياً وإعادة النظام لحالته الأولى. هل أنت متأكد؟', 'مسح كل البيانات'))) return;
      try { await Store.reset(); await Store.logout(); location.reload(); }
      catch (e) { toast(e.message, true); }
    };
  }

  /* ---------------- مركز التنبيهات ----------------
     التنبيهات ليست جدولاً في قاعدة البيانات، بل تُشتقّ من الطلبات نفسها:
     سجل التحديثات لا يصل الموظفين في الوضع السحابي (bootstrap يعيده للمدير
     فقط)، أما الطلبات فتصل الجميع — فاشتقاقها منها يجعل التنبيه يعمل لكل
     مستخدم بلا أي تغيير في الخادم أو قاعدة D1.
     حالة "مقروء" محلية لكل مستخدم على هذا الجهاز: قرار عرضٍ لا بيانات عمل. */
  const NOTIF_KEY = 'majlis_notif_read_v1';
  const NOTIF_MAX = 60;        // أقصى عدد تنبيهات معروضة
  const NOTIF_DAYS = 45;       // لا تُعرض أحداث أقدم من هذه المدة
  const DUE_AHEAD = 3;         // التذكير بموعد التوصيل قبله بثلاثة أيام
  const NOTIF_ICON = { create: 'plus', progress: 'rotate', done: 'check', delivered: 'pin', due: 'calendar', quote: 'file', backup: 'download', overpay: 'alert' };
  const DAY_MS = 86400000;

  /* تمييز العدد في العربية: مفرد للواحد، مثنّى للاثنين، جمع للثلاثة حتى العشرة،
     ثم مفرد منصوب من أحد عشر فصاعداً. "قبل 2 ساعة" خطأ يلفت النظر في واجهة عربية. */
  const plural = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : (n % 100 >= 3 && n % 100 <= 10) ? `${n} ${few}` : `${n} ${many}`);
  const daysWord = (n) => plural(n, 'يوماً واحداً', 'يومين', 'أيام', 'يوماً');
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  /** كم يوماً يفصلنا عن تاريخ YYYY-MM-DD (سالب = مضى) */
  function daysUntil(dateStr) {
    const d = new Date(String(dateStr) + 'T00:00:00');
    if (isNaN(d)) return null;
    return Math.round((startOfDay(d) - startOfDay(new Date())) / DAY_MS);
  }
  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `قبل ${plural(mins, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `قبل ${plural(hrs, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `قبل ${daysWord(days)}`;
    return fmtDateTimeUi(iso);
  }

  let notifState = null;
  const notifKey = () => `${NOTIF_KEY}:${currentUser ? currentUser.id : 'anon'}`;
  function notifS() {
    if (!notifState) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(notifKey()) || 'null'); } catch (_) { saved = null; }
      // أول تشغيل لهذا المستخدم: كل ما سبق يُعدّ مقروءاً حتى لا ينفجر العدّاد بتاريخ كامل
      notifState = (saved && Array.isArray(saved.read))
        ? { since: saved.since || null, read: new Set(saved.read) }
        : { since: Store.now(), read: new Set() };
      writeNotifState();
    }
    return notifState;
  }
  function writeNotifState() {
    if (!notifState) return;
    try { localStorage.setItem(notifKey(), JSON.stringify({ since: notifState.since, read: [...notifState.read].slice(-400) })); }
    catch (_) { /* التخزين ممتلئ: حالة العرض ليست بيانات عمل، نتجاهل */ }
  }
  function resetNotifState() { notifState = null; }

  /** بناء قائمة التنبيهات من الطلبات الحالية — لا حالة محفوظة ولا تكرار */
  function buildNotifications() {
    const out = [];
    const cutoff = Date.now() - NOTIF_DAYS * DAY_MS;
    const cur$ = currency();
    (db().orders || []).forEach((o) => {
      if (!o || !o.id) return;
      const who = (o.customer && o.customer.name) || 'بدون اسم عميل';

      // 1) إنشاء طلب جديد
      if (o.createdAt && new Date(o.createdAt).getTime() >= cutoff) {
        out.push({
          id: `new:${o.id}`, kind: 'create', at: o.createdAt, orderId: o.id, orderNo: o.number,
          title: `${o.status === 'quote' ? 'عرض سعر جديد' : 'طلب جديد'} #${o.number || ''}`,
          text: `${who} • ${fmt(o.total)} ${cur$}${o.createdByName ? ` • بواسطة ${o.createdByName}` : ''}`,
        });
      }

      // 2) المرحلة الحالية. الطلب يحمل حالته لا تاريخها، فيظهر آخر انتقال فقط —
      //    وهو المطلوب في مركز التنبيهات: أين يقف الطلب الآن.
      const stAt = o.statusAt || o.updatedAt;
      const titles = { progress: 'بدأ تنفيذه', done: 'اكتمل تنفيذه', delivered: 'تم توصيله' };
      if (titles[o.status] && stAt && new Date(stAt).getTime() >= cutoff) {
        out.push({
          id: `st:${o.id}:${o.status}:${stAt}`, kind: o.status, at: stAt, orderId: o.id, orderNo: o.number,
          title: `الطلب #${o.number} ${titles[o.status]}`,
          text: `${who}${o.statusByName ? ` • بواسطة ${o.statusByName}` : ''}`,
        });
      }

      // 4) عرض سعر تقترب صلاحيته أو انتهت: فرصة بيع تضيع إن لم يُتابَع العميل
      if (o.status === 'quote' && o.validUntil) {
        const left = daysUntil(o.validUntil);
        if (left !== null && left <= 2 && left >= -14) {
          out.push({
            id: `quote:${o.id}:${o.validUntil}`, kind: 'quote', at: new Date(Math.min(Date.now(), new Date(o.validUntil + 'T09:00:00').getTime() - 2 * DAY_MS)).toISOString(),
            orderId: o.id, orderNo: o.number, late: left < 0,
            title: left < 0 ? `انتهت صلاحية عرض السعر #${o.number}` : `تنتهي صلاحية عرض السعر #${o.number} قريباً`,
            text: `${who} • ${fmt(o.total)} ${cur$} — تواصل مع العميل`,
            when: left < 0 ? `انتهى قبل ${daysWord(-left)}` : left === 0 ? 'ينتهي اليوم' : left === 1 ? 'ينتهي غداً' : `باقٍ ${daysWord(left)}`,
          });
        }
      }

      // مدفوع أكبر من الإجمالي: يبقى ظاهراً حتى تُصحَّح الدفعات (المعرّف يتغيّر بتغيّر المبالغ)
      const over = overpaidBy(o);
      if (over) {
        out.push({
          id: `over:${o.id}:${paidOf(o)}:${money(o.total)}`, kind: 'overpay', at: o.updatedAt || o.createdAt || Store.now(), orderId: o.id, orderNo: o.number, late: true,
          title: `الطلب #${o.number || ''} مدفوعه أكبر من إجماليه`,
          text: `${who} • المدفوع ${fmt(paidOf(o))} والإجمالي ${fmt(o.total)} — زيادة ${fmt(over)} ${cur$}. راجع الدفعات`,
          when: 'يحتاج مراجعة',
        });
      }

      // 3) تذكير قبل موعد التوصيل بثلاثة أيام (ويبقى ظاهراً إن فات الموعد ولم يُسلَّم)
      if (o.deliveryDate && isOpen(o)) {
        const left = daysUntil(o.deliveryDate);
        if (left !== null && left <= DUE_AHEAD) {
          const fire = new Date(String(o.deliveryDate) + 'T09:00:00').getTime() - DUE_AHEAD * DAY_MS;
          out.push({
            id: `due:${o.id}:${o.deliveryDate}`, kind: 'due', at: new Date(Math.min(fire, Date.now())).toISOString(),
            orderId: o.id, orderNo: o.number, late: left < 0,
            title: left < 0 ? `تأخّر توصيل الطلب #${o.number}` : `اقترب موعد توصيل الطلب #${o.number}`,
            text: `${who} • ${fmtDate(o.deliveryDate)} • الحالة: ${STATUS[o.status] || o.status}`,
            when: left < 0 ? `تأخّر ${daysWord(-left)} عن الموعد` : left === 0 ? 'الموعد اليوم' : left === 1 ? 'الموعد غداً' : `باقٍ ${daysWord(left)}`,
          });
        }
      }
    });
    // 5) تذكير المدير بالنسخة الاحتياطية إن مضى أسبوع (أو لم تُصدَّر قط)
    if (can('admin.core')) {
      const last = settings().lastBackupAt;
      const age = last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY_MS) : null;
      if (age === null || age >= BACKUP_DAYS) {
        const at = last ? new Date(new Date(last).getTime() + BACKUP_DAYS * DAY_MS).toISOString() : (notifS().since || Store.now());
        out.push({
          id: `backup:${last || 'never'}:${Math.floor((age || 0) / BACKUP_DAYS)}`, kind: 'backup', at, orderId: '', late: age !== null && age >= BACKUP_DAYS * 2,
          title: age === null ? 'لم تُصدَّر أي نسخة احتياطية بعد' : `مضى ${daysWord(age)} على آخر نسخة احتياطية`,
          text: 'صدّر نسخة واحفظها خارج هذا الجهاز — اضغط للتصدير الآن',
        });
      }
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return out.slice(0, NOTIF_MAX);
  }

  const notifOpen = () => !$('#notifPanel').hidden;

  function renderNotifications() {
    if (!currentUser) return;
    const list = buildNotifications();
    const st = notifS();
    const since = st.since ? new Date(st.since).getTime() : 0;
    const isUnread = (n) => !st.read.has(n.id) && new Date(n.at).getTime() >= since;
    const unread = list.filter(isUnread).length;

    const btn = $('#btnNotif');
    const badge = $('#notifCount');
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '+99' : String(unread);
    btn.classList.toggle('has-unread', unread > 0);
    btn.title = unread ? `مركز التنبيهات — ${unread} غير مقروء` : 'مركز التنبيهات';
    btn.setAttribute('aria-label', btn.title);

    if (!notifOpen()) return;   // لا نعيد رسم القائمة واللوحة مغلقة
    const box = $('#notifList');
    const top = box.scrollTop;
    $('#notifEmpty').hidden = list.length > 0;
    $('#notifReadAll').hidden = unread === 0;
    box.innerHTML = list.map((n) => `
      <button type="button" class="notif-item${isUnread(n) ? ' unread' : ''}${n.late ? ' is-late' : ''}" data-kind="${n.kind}" data-nid="${esc(n.id)}" data-oid="${esc(n.orderId)}">
        <span class="notif-ico">${icon(NOTIF_ICON[n.kind])}</span>
        <span class="notif-body">
          <b>${esc(n.title)}</b>
          <span>${esc(n.text)}</span>
          <small>${esc(n.when || relTime(n.at))}</small>
        </span>
      </button>`).join('');
    box.scrollTop = top;
    $$('[data-nid]', box).forEach((b) => b.addEventListener('click', () => openNotification(b.dataset.nid, b.dataset.oid)));
    prepareControls(box);
  }

  /** الضغط على تنبيه: يُعلَّم مقروءاً ويفتح صفحة الطلب */
  async function openNotification(nid, oid) {
    const st = notifS();
    st.read.add(nid);
    writeNotifState();
    if (nid.startsWith('backup:')) { closeNotifPanel(); await exportBackup(); return; }
    const o = db().orders.find((x) => x.id === oid);
    if (!o) { toast('هذا الطلب لم يعد موجوداً', true); renderNotifications(); return; }
    closeNotifPanel();
    if (dirty && !(await confirmDlg('فتح طلب', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) { renderNotifications(); return; }
    loadOrder(o);
    if (nid.startsWith('over:')) showStage('pay');
    renderNotifications();
  }

  function onNotifOutside(e) {
    const t = e.target;
    if (t && t.closest && t.closest('.notif-wrap, #notifPanel')) return;
    closeNotifPanel();
  }
  function onNotifKey(e) { if (e.key === 'Escape') { closeNotifPanel(); $('#btnNotif').focus(); } }

  function openNotifPanel() {
    $('#notifPanel').hidden = false;
    $('#btnNotif').setAttribute('aria-expanded', 'true');
    renderNotifications();
    document.addEventListener('click', onNotifOutside, true);
    document.addEventListener('keydown', onNotifKey);
  }
  function closeNotifPanel() {
    $('#notifPanel').hidden = true;
    $('#btnNotif').setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onNotifOutside, true);
    document.removeEventListener('keydown', onNotifKey);
  }

  $('#btnNotif').addEventListener('click', () => (notifOpen() ? closeNotifPanel() : openNotifPanel()));
  $('#notifClose').addEventListener('click', () => { closeNotifPanel(); $('#btnNotif').focus(); });
  $('#notifReadAll').addEventListener('click', () => {
    const st = notifS();
    buildNotifications().forEach((n) => st.read.add(n.id));
    writeNotifState();
    renderNotifications();
  });
  // تذكير التوصيل يتغيّر بمرور اليوم لا بفعل المستخدم، والوضع المحلي بلا مزامنة دورية
  setInterval(() => { if (!document.hidden) renderNotifications(); }, 60000);


  /* ---------------- ذكاء الأعمال (مدير) ----------------
     لوحة تحليلات تُشتقّ بالكامل من الطلبات المحفوظة: لا جدول جديد على الخادم
     ولا حقل إضافي على الطلب، فهي تقرأ ما هو موجود أصلاً ولا تكتب شيئاً.
     الرسوم SVG مكتوبة هنا بلا أي مكتبة خارجية، حفاظاً على قاعدة النظام:
     ملفات ثابتة تعمل بلا تثبيت.
     الأرقام كلها قبل الضريبة (الضريبة تُحصَّل للدولة وليست إيراداً)، والطلبات
     الملغية تخرج من كل مبلغ وتُعدّ وحدها.
     -------------------------------------------------------------------- */
  const BI_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const BI_RANGES = { m: 'هذا الشهر', lm: 'الشهر الماضي', d30: 'آخر 30 يوماً', d90: 'آخر 90 يوماً', y: 'هذه السنة', all: 'كل الفترات', custom: 'فترة مخصصة' };
  /** ألوان الحالات كألوان شاراتها — القيمة تدخل خاصية fill فلا تصلح متغيّرات CSS */
  const BI_STATUS_COLOR = { quote: '#A89F92', new: '#6F818C', progress: '#C0913F', done: '#8B5E34', delivered: '#66804E', cancelled: '#B0584A' };
  const BI_TOP_TABS = { fabric: 'قماش', wood: 'خشب', foam: 'إسفنج', acc: 'إكسسوارات', manual: 'أصناف إضافية' };

  let biRange = 'd30';
  let biGran = 'auto';
  let biTopTab = 'fabric';
  let biMobileAt = null;   // أبعاد الرسم تختلف بين الجوال والشاشة: يُعاد الرسم عند تبدّلهما

  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseDay = (s) => new Date(String(s) + 'T00:00:00');
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const daysBetween = (a, b) => Math.round((parseDay(a) - parseDay(b)) / DAY_MS);
  /** الأسبوع يبدأ السبت */
  const weekStart = (d) => addDays(d, -((d.getDay() + 1) % 7));
  /** هوية العميل: الجوال أولاً لأن الاسم يتكرر ويُكتب بصيغ مختلفة */
  const biCustKey = (o) => String((o.customer && (o.customer.phone || o.customer.name)) || '').trim().toLowerCase();

  /** تسعير وتكاليف طلب محفوظ: حساب ثقيل يُعاد استعماله ما دام الطلب لم يتغيّر */
  const biCache = new Map();
  function biInfo(o) {
    const key = `${o.id}|${o.updatedAt || ''}`;
    const hit = biCache.get(key);
    if (hit) return hit;
    if (biCache.size > 900) biCache.clear();
    const v = computeCosts(o);
    biCache.set(key, v);
    return v;
  }

  /** مدى الفترة المختارة. الفراغ = بلا حد */
  function biPeriod() {
    const t = new Date();
    const to = ymd(t);
    if (biRange === 'm') return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to };
    if (biRange === 'lm') return { from: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: ymd(new Date(t.getFullYear(), t.getMonth(), 0)) };
    if (biRange === 'd30') return { from: ymd(addDays(t, -29)), to };
    if (biRange === 'd90') return { from: ymd(addDays(t, -89)), to };
    if (biRange === 'y') return { from: ymd(new Date(t.getFullYear(), 0, 1)), to };
    if (biRange === 'all') return { from: '', to: '' };
    return { from: $('#biFrom').value, to: $('#biTo').value };
  }

  /** الفترة السابقة المماثلة في الطول — أساس كل مقارنة على هذه الصفحة */
  function biPrevPeriod(p) {
    if (!p.from || !p.to || p.to < p.from) return null;
    const len = daysBetween(p.to, p.from) + 1;
    const to = addDays(parseDay(p.from), -1);
    return { from: ymd(addDays(to, -(len - 1))), to: ymd(to) };
  }

  /** أرقام فترة واحدة */
  function biAgg(from, to, userId) {
    let list = db().orders.filter((o) => o.createdAt);
    if (from) list = list.filter((o) => ordDate(o) >= from);
    if (to) list = list.filter((o) => ordDate(o) <= to);
    if (userId) list = list.filter((o) => o.createdBy === userId);
    // البيع = ليس ملغياً ولا عرض سعر لم يتحوّل بعد
    const live = list.filter(incCounted);   // حسب «يشمل التقرير» (افتراضياً بلا الجديد)
    const costed = live.filter((o) => orderCost(o) !== null);
    // الطلبات التي تُحسب لها عمولة: كلها إن كان الأساس «الإجمالي»، والمسجّلة تكاليفها إن كان «صافي الربح»
    const commOrders = live.filter((o) => commBaseAmount(o) !== null);
    const sum = (arr, f) => money(arr.reduce((s, o) => s + num(f(o)), 0));
    const revenue = sum(live, orderRevenue);
    const profit = sum(costed, orderProfit);
    const costedRevenue = sum(costed, orderRevenue);

    // المصروفات من جدول المصروفات (مصروفات مستقلة عن تكاليف الطلبات)
    // (تُحمَّل من الخادم عند فتح الصفحة لمن يملك صلاحية رؤيتها؛ التاريخ = تاريخ المصروف نفسه)
    let biExp = db().expenses || [];
    if (from) biExp = biExp.filter((e) => expDay(e) >= from);
    if (to) biExp = biExp.filter((e) => expDay(e) <= to);
    if (userId) biExp = biExp.filter((e) => e.created_by === userId);
    const expenses = sum(biExp, (e) => num(e.amount));

    return {
      list, live, costed, commOrders,
      count: live.length,
      cancelled: list.filter((o) => o.status === 'cancelled').length,
      quotes: list.filter((o) => o.status === 'quote').length,
      revenue,
      gross: sum(live, (o) => o.total),
      paid: sum(live, (o) => o.paid),
      remaining: sum(live, (o) => remainingOf(o.total, o.paid)),
      cost: sum(costed, orderCost),
      profit, costedRevenue,
      commission: sum(commOrders, orderCommission),
      share: sum(commOrders, orderShareAmount),
      margin: costedRevenue > 0 ? r2((profit / costedRevenue) * 100) : 0,
      avg: live.length ? money(revenue / live.length) : 0,
      meters: r2(live.reduce((s, o) => s + biMeters(o), 0)),
      expenses,
      net: money(profit - expenses),
    };
  }
  const biMeters = (o) => ((o.design && o.design.pieces) || []).filter((p) => p.kind === 'sofa').reduce((s, p) => s + num(p.w), 0);

  /* --- أدوات الرسم: SVG محسوب بلا مكتبة --- */

  /** سلّم قيم بخطوات مقروءة (1 / 2 / 2.5 / 5 × 10^ن) والمبالغ أعداد صحيحة */
  function biScale(min, max) {
    if (max <= 0 && min >= 0) max = 1;
    if (max === min) max = min + 1;
    const raw = (max - min) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag);
    const lo = Math.floor(min / step) * step;
    let hi = Math.ceil(max / step) * step;
    if (hi === lo) hi = lo + step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
    return { lo, hi, ticks };
  }

  /** أعمدة المبيعات وخط الربح. الأقدم يميناً لأن القراءة تبدأ من اليمين. */
  function biChart(s) {
    const rows = s.rows;
    const mob = isMobile();
    const W = mob ? 430 : 1000, H = mob ? 290 : 280;
    const padL = 10, padT = 16, padB = 38, padR = mob ? 62 : 78;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const vals = [];
    rows.forEach((b) => { vals.push(b.revenue); if (b.costed) vals.push(b.profit); });
    const sc = biScale(Math.min(0, ...vals), Math.max(0, ...vals));
    const y = (v) => r2(padT + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH);
    const step = plotW / rows.length;
    const cx = (i) => r2(padL + plotW - (i + 0.5) * step);
    const bw = Math.max(3, Math.min(mob ? 26 : 46, step * 0.6));
    const every = Math.max(1, Math.ceil(rows.length / (mob ? 5 : 11)));

    // قيمة المحور فوق خطها لا تحتها: وإلا لاصقت تسميةُ أدنى خط تسمياتِ الفترات أسفله
    const grid = sc.ticks.map((t) => `<line class="grid" x1="${padL}" y1="${y(t)}" x2="${padL + plotW}" y2="${y(t)}"/><text x="${W - padR + 9}" y="${y(t) - 5}">${fmt(t)}</text>`).join('');
    const zero = sc.lo < 0 ? `<line class="zero" x1="${padL}" y1="${y(0)}" x2="${padL + plotW}" y2="${y(0)}"/>` : '';
    const bars = rows.map((b, i) => {
      const top = y(Math.max(0, b.revenue)), bot = y(Math.min(0, b.revenue));
      const tip = `${b.label} — مبيعات ${fmt(b.revenue)} • ${b.orders} ${b.orders === 2 ? 'طلبان' : 'طلب'}${b.costed ? ` • ربح ${fmt(b.profit)}` : ''}`;
      return `<g class="bgrp"><title>${esc(tip)}</title>`
        + `<rect class="hit" x="${r2(cx(i) - step / 2)}" y="${padT}" width="${r2(step)}" height="${plotH}"/>`
        + `<rect class="bar" x="${r2(cx(i) - bw / 2)}" y="${top}" width="${r2(bw)}" height="${r2(Math.max(1, bot - top))}" rx="${r2(Math.min(1.5, bw / 4))}"/></g>`;
    }).join('');
    // خط الربح ينقطع عند فترة بلا تكاليف بدل أن يهبط إلى الصفر كأنها بلا ربح
    const segs = [];
    let run = [];
    rows.forEach((b, i) => {
      if (b.costed) run.push(`${cx(i)},${y(b.profit)}`);
      else { if (run.length) segs.push(run); run = []; }
    });
    if (run.length) segs.push(run);
    const line = segs.filter((r) => r.length > 1).map((r) => `<polyline class="line" points="${r.join(' ')}"/>`).join('');
    const dots = rows.map((b, i) => (b.costed ? `<circle class="dot${b.profit < 0 ? ' neg' : ''}" cx="${cx(i)}" cy="${y(b.profit)}" r="${mob ? 2.8 : 3.4}"/>` : '')).join('');
    const xlab = rows.map((b, i) => ((i % every === 0 || i === rows.length - 1) ? `<text class="mid" x="${cx(i)}" y="${padT + plotH + 18}">${esc(b.label)}</text>` : '')).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="المبيعات وصافي الربح عبر الفترة">${grid}${zero}${bars}${line}${dots}${xlab}</svg></div>`;
  }

  /** حلقة نسب — القطاعات تبدأ من أعلى وتدور مع عقارب الساعة */
  function biDonut(segs, total, caption) {
    const C = 90, R = 76, r = 52;
    const live = segs.filter((s) => s.value > 0);
    if (!live.length || !total) return '';
    const pt = (rad, ang) => `${r2(C + rad * Math.cos(ang))} ${r2(C + rad * Math.sin(ang))}`;
    let a = -Math.PI / 2;
    const paths = live.length === 1
      ? `<path fill="${live[0].color}" fill-rule="evenodd" d="M ${C - R} ${C} A ${R} ${R} 0 1 1 ${C + R} ${C} A ${R} ${R} 0 1 1 ${C - R} ${C} Z M ${C - r} ${C} A ${r} ${r} 0 1 0 ${C + r} ${C} A ${r} ${r} 0 1 0 ${C - r} ${C} Z"><title>${esc(live[0].label)}</title></path>`
      : live.map((s) => {
        const sw = (s.value / total) * Math.PI * 2;
        const a1 = a + (sw > 0.06 ? sw - 0.014 : sw);
        const lg = sw > Math.PI ? 1 : 0;
        const d = `M ${pt(R, a)} A ${R} ${R} 0 ${lg} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${lg} 0 ${pt(r, a)} Z`;
        a += sw;
        return `<path fill="${s.color}" d="${d}"><title>${esc(s.label)}: ${s.value}</title></path>`;
      }).join('');
    return `<svg class="donut" viewBox="0 0 180 180" role="img" aria-label="توزيع الطلبات حسب الحالة">${paths}<text class="dn-total" x="${C}" y="${C + 4}">${total}</text><text class="dn-cap" x="${C}" y="${C + 24}">${esc(caption)}</text></svg>`;
  }

  /** أشرطة أفقية: القيمة نسبةً إلى أكبر صف */
  function biBars(rows) {
    const max = Math.max(1, ...rows.map((x) => Math.abs(num(x.value))));
    return `<div class="bars">${rows.map((x) => `
      <div class="bar-row">
        <span class="bar-lbl" title="${esc(x.label)}">${esc(x.label)}</span>
        <span class="bar-track"><i class="bar-fill" style="width:${r2(Math.max(1.5, (Math.abs(num(x.value)) / max) * 100))}%${x.color ? `;background:${x.color}` : ''}"></i></span>
        <span class="bar-val">${x.text}</span>
      </div>`).join('')}</div>`;
  }

  /** تقسيم الفترة إلى أعمدة متساوية مع سدّ الفجوات: يوم بلا طلبات عمود بصفر لا فراغ */
  function biSeries(live, p) {
    const dates = live.map(ordDate).filter(Boolean).sort();
    const from = p.from || dates[0] || today();
    const to = p.to || dates[dates.length - 1] || today();
    if (to < from) return { rows: [], gran: 'day', trimmed: false };
    const span = daysBetween(to, from) + 1;
    const gran = biGran !== 'auto' ? biGran : span <= 62 ? 'day' : span <= 210 ? 'week' : 'month';
    const keys = [];
    const start = parseDay(from), end = parseDay(to);
    if (gran === 'day') for (let d = start; d <= end; d = addDays(d, 1)) keys.push(ymd(d));
    else if (gran === 'week') for (let d = weekStart(start); d <= end; d = addDays(d, 7)) keys.push(ymd(d));
    else for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) keys.push(ymd(d).slice(0, 7));
    const map = new Map(keys.map((k) => [k, { key: k, revenue: 0, profit: 0, orders: 0, costed: 0 }]));
    live.forEach((o) => {
      const b = map.get(biKeyOf(ordDate(o), gran));
      if (!b) return;
      b.revenue += orderRevenue(o);
      b.orders++;
      const pr = orderProfit(o);
      if (pr !== null) { b.profit += pr; b.costed++; }
    });
    let rows = [...map.values()];
    // أربعون عموداً أقصى ما يُقرأ على شاشة واحدة، والأحدث أولى بالعرض
    const trimmed = rows.length > 40;
    if (trimmed) rows = rows.slice(-40);
    rows.forEach((b) => { b.revenue = money(b.revenue); b.profit = money(b.profit); b.label = biLabelOf(b.key, gran); });
    return { rows, gran, trimmed };
  }
  function biKeyOf(date, gran) {
    if (!date) return '';
    if (gran === 'day') return date;
    if (gran === 'month') return date.slice(0, 7);
    return ymd(weekStart(parseDay(date)));
  }
  function biLabelOf(key, gran) {
    const parts = key.split('-');
    if (gran === 'month') return `${BI_MONTHS[+parts[1] - 1]} ${parts[0].slice(2)}`;
    return `${parts[2]}/${parts[1]}`;
  }

  /* --- المقارنة بالفترة السابقة --- */
  function biDeltaTag(now, before, higherIsBad) {
    if (before === null || before === undefined) return '';
    if (!before) return now ? '<small class="delta flat">لا مقارنة ممكنة</small>' : '';
    const pct = r2(((now - before) / Math.abs(before)) * 100);
    if (Math.abs(pct) < 0.5) return '<small class="delta flat">كما الفترة السابقة</small>';
    const up = pct > 0;
    return `<small class="delta ${(higherIsBad ? !up : up) ? 'up' : 'down'}">${up ? 'ارتفاع' : 'انخفاض'} ${fmtQty(Math.abs(pct))}٪</small>`;
  }

  /* --- تجميعات تُستعمل في الجداول وفي ملف CSV معاً --- */
  function biStaffRows(a) {
    const g = new Map();
    a.live.forEach((o) => {
      const k = o.createdBy || 'none';
      const e = g.get(k) || { name: o.createdByName || 'غير محدد', count: 0, revenue: 0, profit: 0, costedRev: 0, costed: 0, paid: 0, remaining: 0, commission: 0 };
      e.count++;
      e.revenue += orderRevenue(o);
      e.paid += num(o.paid);
      e.remaining += remainingOf(o.total, o.paid);
      const pr = orderProfit(o);
      if (pr !== null) { e.profit += pr; e.costedRev += orderRevenue(o); e.costed++; }
      const cm = orderCommission(o);
      if (cm !== null) e.commission += cm;
      g.set(k, e);
    });

    // المشاركة: حصة متساوية لكل داخلي نشط (موظف أو مدير) من مجموع مبالغ المشاركة
    const internal = db().users.filter((u) => u.active !== false && (u.role === 'staff' || u.role === 'admin'));
    let sharePool = 0;
    a.commOrders.forEach((o) => { sharePool += orderShareAmount(o); });
    const perShare = internal.length ? money(sharePool / internal.length) : 0;

    // صف لكل داخلي نشط حتى لو لم يُنشئ طلبات في الفترة
    internal.forEach((u) => { if (!g.has(u.id)) g.set(u.id, { name: u.name, count: 0, revenue: 0, profit: 0, costedRev: 0, costed: 0, paid: 0, remaining: 0, commission: 0 }); });
    g.forEach((e, k) => {
      const isInternal = internal.some((u) => u.id === k);
      e.share = isInternal ? perShare : 0;
    });
    return [...g.values()].sort((x, y) => y.revenue - x.revenue);
  }

  function biCustRows(a) {
    const g = new Map();
    a.live.forEach((o) => {
      const k = biCustKey(o) || 'order:' + o.id;
      const e = g.get(k) || { name: (o.customer && o.customer.name) || '—', phone: (o.customer && o.customer.phone) || '', count: 0, revenue: 0, remaining: 0, last: '' };
      e.count++;
      e.revenue += orderRevenue(o);
      e.remaining += remainingOf(o.total, o.paid);
      const d = ordDate(o);
      if (d > e.last) { e.last = d; e.name = (o.customer && o.customer.name) || e.name; }
      g.set(k, e);
    });
    return [...g.values()].sort((x, y) => y.revenue - x.revenue);
  }

  /* --- أقسام الصفحة --- */
  function biRenderStatus(a) {
    const counts = {}, amount = {};
    a.list.forEach((o) => {
      const k = o.status || 'new';
      counts[k] = (counts[k] || 0) + 1;
      amount[k] = (amount[k] || 0) + num(o.total);
    });
    const total = a.list.length;
    const segs = Object.keys(STATUS).map((k) => ({ label: STATUS[k], value: counts[k] || 0, color: BI_STATUS_COLOR[k] }));
    const open = money((amount.new || 0) + (amount.progress || 0) + (amount.done || 0));
    $('#biStatus').innerHTML = total ? `
      <div class="donut-wrap">
        ${biDonut(segs, total, 'طلب')}
        <div class="dn-legend">${segs.map((s) => `
          <div class="dn-item"><i style="background:${s.color}"></i><span>${s.label}</span><b>${s.value}</b><small>${Math.round((s.value / total) * 100)}٪</small></div>`).join('')}
        </div>
      </div>
      <div class="bi-figs">
        <div class="stat"><span>قيمة الطلبات المفتوحة</span><b>${fmt(open)}</b><small>جديد + قيد التنفيذ + مكتمل</small></div>
        <div class="stat"><span>قيمة ما تم توصيله</span><b>${fmt(money(amount.delivered || 0))}</b><small>${counts.delivered || 0} طلب</small></div>
        <div class="stat"><span>معدل الإلغاء</span><b>${fmtQty(r2(((counts.cancelled || 0) / total) * 100))}٪</b><small>${counts.cancelled || 0} من ${total}</small></div>
        ${counts.quote ? `<div class="stat"><span>عروض أسعار معلّقة</span><b>${counts.quote}</b><small>بقيمة ${fmt(money(amount.quote || 0))}</small></div>` : ''}
      </div>` : '<p class="hint">لا توجد طلبات في هذه الفترة.</p>';
  }

  function biRenderCollect(a) {
    const unpaid = a.live.filter((o) => num(o.total) - num(o.paid) > 0.5);
    const buckets = [
      { label: 'خلال 30 يوماً', min: 0, max: 30, v: 0, n: 0 },
      { label: 'من 31 إلى 60', min: 31, max: 60, v: 0, n: 0 },
      { label: 'من 61 إلى 90', min: 61, max: 90, v: 0, n: 0 },
      { label: 'أكثر من 90 يوماً', min: 91, max: Infinity, v: 0, n: 0 },
    ];
    const t = today();
    unpaid.forEach((o) => {
      const age = Math.max(0, daysBetween(t, ordDate(o)));
      const b = buckets.find((x) => age >= x.min && age <= x.max);
      if (b) { b.v += money(num(o.total) - num(o.paid)); b.n++; }
    });
    const pct = a.gross ? r2((a.paid / a.gross) * 100) : 0;
    $('#biCollect').innerHTML = `
      ${biBars([{ label: 'نسبة التحصيل', value: Math.min(100, pct), text: `<b>${fmtQty(pct)}٪</b> من ${fmt(a.gross)}` }])}
      <div class="bi-figs">
        <div class="stat"><span>المحصّل</span><b>${fmt(a.paid)}</b></div>
        <div class="stat remaining"><span>المتبقي</span><b>${fmt(a.remaining)}</b><small>${unpaid.length} طلب غير مسدّد</small></div>
        <div class="stat"><span>متوسط المتبقي للطلب</span><b>${unpaid.length ? fmt(money(a.remaining / unpaid.length)) : '—'}</b></div>
      </div>
      <p class="hint">أعمار المبالغ المتبقية — محسوبة من تاريخ إنشاء الطلب:</p>
      ${unpaid.length ? biBars(buckets.map((b) => ({
        label: b.label, value: b.v,
        color: b.min >= 91 ? 'var(--danger)' : b.min >= 61 ? 'var(--st-progress)' : undefined,
        text: `<b>${fmt(b.v)}</b> • ${b.n} طلب`,
      }))) : '<p class="hint">لا توجد مبالغ متبقية في هذه الفترة.</p>'}`;
  }

  function biRenderTop(a) {
    let rows = [], note = '';
    if (biTopTab === 'acc' || biTopTab === 'manual') {
      const g = new Map();
      a.live.forEach((o) => biInfo(o).rows.forEach((l) => {
        if (l.kind !== biTopTab) return;
        const name = String(l.name || '').trim() || 'بلا اسم';
        const e = g.get(name) || { qty: 0, total: 0, orders: 0 };
        e.qty += num(l.qty); e.total += num(l.total); e.orders++;
        g.set(name, e);
      }));
      rows = [...g.entries()].sort((x, y) => y[1].total - x[1].total).slice(0, 12).map(([name, e]) => ({
        label: name, value: e.total,
        text: `<b>${fmt(e.total)}</b> • ${fmtQty(e.qty)} ${biTopTab === 'acc' ? 'قطعة' : 'وحدة'} • ${e.orders} طلب`,
      }));
      note = 'مرتّبة بقيمة المبيعات في الفترة.';
    } else {
      const g = new Map();
      let all = 0;
      a.live.forEach((o) => ((o.design && o.design.pieces) || []).forEach((p) => {
        if (p.kind !== 'sofa') return;
        const name = specName(p, biTopTab) || 'غير محدد';
        const rec = specRecord(p, biTopTab);
        const e = g.get(name) || { m: 0, value: 0, orders: new Set() };
        e.m += num(p.w);
        e.value += num(p.w) * (rec ? money(rec.price) : 0);
        e.orders.add(o.id);
        g.set(name, e);
        all += num(p.w);
      }));
      rows = [...g.entries()].sort((x, y) => y[1].m - x[1].m).slice(0, 12).map(([name, e]) => ({
        label: name, value: e.m,
        text: `<b>${fmtQty(r2(e.m))} م</b> • ${all ? Math.round((e.m / all) * 100) : 0}٪ • ${e.orders.size} طلب`,
      }));
      note = `إجمالي أمتار الكنب في الفترة ${fmtQty(r2(all))} م. النسبة من الأمتار لا من المبالغ، وقيمة المتر لهذه المواصفة تظهر في جدول التسعير.`;
    }
    $('#biTop').innerHTML = rows.length
      ? biBars(rows) + `<p class="hint mb-0">${esc(note)}</p>`
      : `<p class="hint">لا توجد بيانات ${esc(BI_TOP_TABS[biTopTab])} في هذه الفترة.</p>`;
  }

  function biRenderStaff(a) {
    const list = biStaffRows(a);
    $('#biStaffTable tbody').innerHTML = list.map((e) => `
      <tr>
        <td data-label="الموظف"><b>${esc(e.name)}</b></td>
        <td data-label="الطلبات" class="num">${e.count}</td>
        <td data-label="المبيعات" class="num">${fmt(money(e.revenue))}</td>
        <td data-label="صافي الربح" class="num ${e.costed ? (e.profit < 0 ? 'neg' : 'pos') : ''}">${e.costed ? fmt(money(e.profit)) : '<span class="hint">—</span>'}</td>
        <td data-label="العمولة" class="num ${e.commission < 0 ? 'neg' : 'pos'}">${e.commission ? fmt(money(e.commission)) : '<span class="hint">—</span>'}</td>
        <td data-label="المشاركة" class="num ${e.share < 0 ? 'neg' : 'pos'}">${e.share ? fmt(money(e.share)) : '<span class="hint">—</span>'}</td>
        <td data-label="الهامش" class="num">${e.costed && e.costedRev > 0 ? fmtQty(r2((e.profit / e.costedRev) * 100)) + '٪' : '<span class="hint">—</span>'}</td>
        <td data-label="متوسط الطلب" class="num">${fmt(money(e.revenue / e.count))}</td>
        <td data-label="المتبقي" class="num">${fmt(money(e.remaining))}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">لا توجد طلبات في هذه الفترة</td></tr>';
  }

  function biRenderCustomers(a) {
    const list = biCustRows(a);
    const top = list.slice(0, 10);
    $('#biCustTable tbody').innerHTML = top.map((e) => `
      <tr>
        <td data-label="العميل"><b>${esc(e.name)}</b></td>
        <td data-label="الجوال" class="num">${esc(e.phone || '—')}</td>
        <td data-label="الطلبات" class="num">${e.count}</td>
        <td data-label="المبيعات" class="num">${fmt(money(e.revenue))}</td>
        <td data-label="المتبقي" class="num ${e.remaining > 0.5 ? 'warn-num' : ''}">${fmt(money(e.remaining))}</td>
        <td data-label="آخر طلب" class="num">${e.last || '—'}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">لا يوجد عملاء في هذه الفترة</td></tr>';
    const five = money(list.slice(0, 5).reduce((s, e) => s + e.revenue, 0));
    const repeat = list.filter((e) => e.count > 1).length;
    $('#biCustNote').innerHTML = list.length
      ? `${list.length} عميل في الفترة، منهم ${repeat} عميلاً متكرراً. أعلى 5 عملاء = <b>${fmt(five)}</b> (${a.revenue ? Math.round((five / a.revenue) * 100) : 0}٪ من المبيعات).`
      : '';
  }

  function biRenderCosts(a) {
    let linesCost = 0;
    const extras = new Map();
    a.costed.forEach((o) => {
      const info = biInfo(o);
      linesCost += info.linesCost;
      info.extras.forEach((e) => {
        const n = e.name || 'بند بلا اسم';
        extras.set(n, (extras.get(n) || 0) + e.amount);
      });
    });
    const rows = [{ label: 'تكلفة الأصناف', value: money(linesCost) }]
      .concat([...extras.entries()].sort((x, y) => y[1] - x[1]).map(([n, v]) => ({ label: n, value: money(v) })));
    const total = money(rows.reduce((s, x) => s + x.value, 0));
    const noCost = a.count - a.costed.length;
    $('#biCosts').innerHTML = a.costed.length ? `
      ${biBars(rows.filter((x) => x.value > 0).map((x) => ({ ...x, text: `<b>${fmt(x.value)}</b> • ${total ? Math.round((x.value / total) * 100) : 0}٪` })))}
      <div class="bi-figs">
        <div class="stat cost"><span>إجمالي التكاليف</span><b>${fmt(a.cost)}</b><small>${a.costed.length} طلب بتكلفة</small></div>
        <div class="stat"><span>التكلفة من المبيعات</span><b>${a.costedRevenue ? fmtQty(r2((a.cost / a.costedRevenue) * 100)) : '0.00'}٪</b><small>هامش ${fmtQty(a.margin)}٪</small></div>
        <div class="stat"><span>متوسط تكلفة الطلب</span><b>${fmt(money(a.cost / a.costed.length))}</b></div>
      </div>
      ${noCost ? `<p class="hint">${noCost} ${noCost === 1 ? 'طلب' : 'طلباً'} بلا تكاليف مسجّلة — لا يدخل في حساب الربح. أدخلها من زر «إضافة التكاليف» في صفحة الطلبات.</p>` : ''}`
      : '<p class="hint">لم تُدخل تكاليف لأي طلب في هذه الفترة، فلا يمكن حساب الربح. أدخلها من زر «إضافة التكاليف» في صفحة الطلبات.</p>';
  }

  function biRenderOps(a, userId) {
    const delivered = a.live.filter((o) => o.status === 'delivered' && o.statusAt && o.createdAt);
    const days = delivered.map((o) => Math.max(0, Math.round((new Date(o.statusAt) - new Date(o.createdAt)) / DAY_MS))).filter((d) => Number.isFinite(d));
    const avgDays = days.length ? r2(days.reduce((s, d) => s + d, 0) / days.length) : null;
    const dued = delivered.filter((o) => o.deliveryDate);
    const onTime = dued.filter((o) => localDate(o.statusAt) <= o.deliveryDate).length;
    // التأخير حالة قائمة الآن لا رقم تاريخي: يُحسب على كل الطلبات المفتوحة مهما كان تاريخها
    let open = db().orders.filter((o) => ['new', 'progress', 'done'].includes(o.status || 'new'));
    if (userId) open = open.filter((o) => o.createdBy === userId);
    const late = open.filter((o) => o.deliveryDate && daysUntil(o.deliveryDate) < 0);
    const soon = open.filter((o) => o.deliveryDate && daysUntil(o.deliveryDate) >= 0 && daysUntil(o.deliveryDate) <= 7);
    const lateAmount = money(late.reduce((s, o) => s + num(o.total), 0));
    $('#biOps').innerHTML = `
      <div class="bi-figs">
        <div class="stat"><span>متوسط زمن التنفيذ</span><b>${avgDays === null ? '—' : fmtQty(avgDays)}</b><small>${avgDays === null ? 'لا توجد طلبات موصّلة' : `يوم — من الإنشاء إلى التوصيل (${days.length} طلب)`}</small></div>
        <div class="stat"><span>التسليم في الموعد</span><b class="${dued.length ? (onTime / dued.length >= 0.8 ? 'pos' : 'neg') : ''}">${dued.length ? Math.round((onTime / dued.length) * 100) + '٪' : '—'}</b><small>${dued.length ? `${onTime} من ${dued.length} طلب له موعد` : 'لا مواعيد مسجّلة'}</small></div>
        <div class="stat"><span>أطول تنفيذ</span><b>${days.length ? Math.max(...days) : '—'}</b><small>${days.length ? 'يوم' : ''}</small></div>
      </div>
      <p class="hint">حالة الطلبات المفتوحة الآن (خارج نطاق الفترة المختارة):</p>
      <div class="bi-figs">
        <div class="stat ${late.length ? 'remaining' : ''}"><span>متأخرة عن موعدها</span><b>${late.length}</b><small>${late.length ? `بقيمة ${fmt(lateAmount)}` : 'لا تأخير'}</small></div>
        <div class="stat"><span>تسليمات خلال 7 أيام</span><b>${soon.length}</b></div>
        <div class="stat"><span>طلبات مفتوحة</span><b>${open.length}</b><small>لم تُسلَّم بعد</small></div>
      </div>`;
  }

  /** ملاحظات مكتوبة بلغة صاحب المحل: ما الرقم المهم ولماذا */
  function biRenderInsights(a, pv, p, userId) {
    const out = [];
    const add = (tone, ico, html) => out.push(`<div class="insight ${tone}">${icon(ico)}<div>${html}</div></div>`);
    if (pv && pv.revenue) {
      const pct = r2(((a.revenue - pv.revenue) / Math.abs(pv.revenue)) * 100);
      if (Math.abs(pct) >= 5) {
        add(pct > 0 ? 'good' : 'bad', pct > 0 ? 'trend' : 'alert',
          `المبيعات <b>${pct > 0 ? 'ارتفعت' : 'انخفضت'} ${fmtQty(Math.abs(pct))}٪</b> عن الفترة السابقة — من ${fmt(pv.revenue)} إلى <b>${fmt(a.revenue)}</b> ${esc(currency())}.`);
      }
    }
    if (a.costed.length) {
      const low = a.margin < 15;
      add(low ? 'warn' : 'good', 'money',
        `هامش الربح <b>${fmtQty(a.margin)}٪</b> (ربح ${fmt(a.profit)} من مبيعات ${fmt(a.costedRevenue)} للطلبات المسجّلة تكاليفها).${low ? ' هامش منخفض — راجع أسعار المتر وبنود التكلفة الإضافية.' : ''}`);
    }
    const noCost = a.count - a.costed.length;
    if (noCost) {
      add('warn', 'wallet', `<b>${noCost}</b> من ${a.count} طلب بلا تكاليف مسجّلة، فالربح أعلاه لا يشملها. إدخالها يجعل رقم الربح حقيقياً.`);
    }
    if (a.gross && a.remaining / a.gross > 0.3) {
      add('warn', 'alert', `المتبقي على العملاء <b>${fmt(a.remaining)}</b> أي ${Math.round((a.remaining / a.gross) * 100)}٪ من قيمة الطلبات. تابع التحصيل قبل تسليم الطلبات الجديدة.`);
    }
    const s = biSeries(a.live, p);
    const best = s.rows.slice().sort((x, y) => y.revenue - x.revenue)[0];
    if (best && best.revenue > 0) {
      const unit = s.gran === 'day' ? 'يوم' : s.gran === 'week' ? 'أسبوع' : 'شهر';
      add('info', 'trend', `أعلى ${unit} مبيعاً: <b>${esc(best.label)}</b> بـ ${fmt(best.revenue)} من ${best.orders} طلب.`);
    }
    const custs = biCustRows(a);
    if (custs.length >= 3) {
      const five = money(custs.slice(0, 5).reduce((x, e) => x + e.revenue, 0));
      const share = a.revenue ? Math.round((five / a.revenue) * 100) : 0;
      add(share > 60 ? 'warn' : 'info', 'user',
        `أعلى 5 عملاء يشكّلون <b>${share}٪</b> من المبيعات.${share > 60 ? ' اعتماد كبير على عدد قليل من العملاء.' : ''}`);
    }
    if (a.meters > 0) {
      const g = new Map();
      a.live.forEach((o) => ((o.design && o.design.pieces) || []).forEach((pc) => {
        if (pc.kind !== 'sofa') return;
        const n = specName(pc, 'fabric') || 'غير محدد';
        g.set(n, (g.get(n) || 0) + num(pc.w));
      }));
      const topFab = [...g.entries()].sort((x, y) => y[1] - x[1])[0];
      if (topFab && topFab[0] !== 'غير محدد') {
        add('info', 'tag', `الأكثر طلباً: قماش <b>${esc(topFab[0])}</b> بـ ${fmtQty(r2(topFab[1]))} م من أصل ${fmtQty(a.meters)} م (${Math.round((topFab[1] / a.meters) * 100)}٪).`);
      }
    }
    let open = db().orders.filter((o) => ['new', 'progress', 'done'].includes(o.status || 'new'));
    if (userId) open = open.filter((o) => o.createdBy === userId);
    const late = open.filter((o) => o.deliveryDate && daysUntil(o.deliveryDate) < 0);
    if (late.length) {
      add('bad', 'clock', `<b>${late.length}</b> ${late.length === 1 ? 'طلب متأخر' : 'طلباً متأخراً'} عن موعد التوصيل الآن، أقدمها #${late.sort((x, y) => (x.deliveryDate > y.deliveryDate ? 1 : -1))[0].number} متأخر ${daysWord(Math.abs(daysUntil(late[0].deliveryDate)))}.`);
    }
    if (a.quotes) {
      const qv = money(a.list.filter((o) => o.status === 'quote').reduce((s, o) => s + orderRevenue(o), 0));
      add('info', 'file', `<b>${a.quotes}</b> ${a.quotes === 1 ? 'عرض سعر لم يتحوّل' : 'عروض أسعار لم تتحوّل'} إلى طلب بعد، بقيمة ${fmt(qv)} ${esc(currency())} قبل الضريبة. متابعتها أقصر طريق لمبيعات جديدة.`);
    }
    if (a.cancelled && a.list.length) {
      const rate = Math.round((a.cancelled / a.list.length) * 100);
      if (rate >= 10) add('warn', 'x', `معدل الإلغاء <b>${rate}٪</b> (${a.cancelled} من ${a.list.length} طلب). راجع أسباب الإلغاء مع الموظفين.`);
    }
    if (!out.length) add('info', 'bulb', 'لا توجد ملاحظات لافتة في هذه الفترة. وسّع المدة الزمنية لترى صورة أشمل.');
    $('#biInsights').innerHTML = out.join('');
  }

  /* --- الصفحة --- */
/* ======================= لوحة تحليلات المالك =======================
   بيانات مجمّعة فقط. الخادم يحمي كل نقطة بـ requireAdmin، فلا يقرأ الموظف
   ولا المندوب ولا أي استدعاء API مباشر. الواجهة هنا للتعرض فقط؛ الحماية ليست
   في إخفاء الزر بل في الخادم. لا أرقام تجريبية: كل قيمة من الخادم أو «—». */
  let ownerRange = 'd30';

  function ownerQuery() {
    const p = new URLSearchParams();
    p.set('range', ownerRange);
    const f = ($('#ownerFrom') || {}).value, t = ($('#ownerTo') || {}).value;
    if (ownerRange === 'custom' && f && t) { p.set('range', 'custom'); p.set('from', f); p.set('to', t); }
    return p.toString();
  }

/** رقم موحّد: قيمة أو شرطة عند الغياب — لا نخترع أصفاراً مضلّلة */
  const ownerNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US'));

  function renderOwnerPanel() {
    wireOwnerPanel();
    const host = $('#ownerPanel');
    if (!host) return;
    // الحماية في الخادم؛ هنا نخفي فقط عندما لا يكون المستخدم مديراً
    host.hidden = !can('admin.core');
    if (!can('admin.core')) return;
    const kpis = $('#ownerKpis'), funnel = $('#ownerFunnel'), trend = $('#ownerTrend');
    const steps = $('#ownerSteps'), prefs = $('#ownerPrefs'), orders = $('#ownerOrders'), sources = $('#ownerSources');
    kpis.innerHTML = '<div class="stat"><span>جارٍ التحميل</span><b>…</b><small>لوحة تحليلات المالك</small></div>';
    funnel.innerHTML = '<p class="owner-empty">جارٍ تحميل…</p>';
    trend.innerHTML = '<p class="owner-empty">جارٍ تحميل…</p>';
    steps.innerHTML = '<p class="owner-empty">جارٍ تحميل…</p>';
    prefs.innerHTML = '<p class="owner-empty">جارٍ تحميل…</p>';
    orders.innerHTML = '<p class="owner-empty">جارٍ تحميل…</p>';
    sources.innerHTML = '<p class="owner-empty">جارٍ تحميل…</p>';

    Store.api('GET', '/api/owner-analytics?' + ownerQuery()).then((r) => {
      if (!r || !r.ok) throw new Error('تعذّر تحميل البيانات');
      const F = r.funnel || { steps: [], note: '' };
      const byKey = {};
      (F.steps || []).forEach((s) => { byKey[s.key] = s; });
      const start = byKey.start ? byKey.start.n : 0;

      /* مؤشرات أعلى اللوحة: كل رقم قابل للقياس يأتي من الخادم، وما لا يُقاس
         يُعرض «—» بصيغة صريحة. الزائر والزيارة رقمان مختلفان ولا يُدمجان:
         الزائر = بصمة اليوم، والزيارة = كل فتح للصفحة. */
      const stat = (label, value, note) => '<div class="stat"><span>' + esc(label) + '</span><b>'
        + (value == null || value === '' ? '—' : esc(String(value))) + '</b>'
        + (note ? '<small>' + (note.html || esc(note)) + '</small>' : '') + '</div>';
      const dur = (r.avgDesignMin == null) ? '—' : (r.avgDesignMin + ' دقيقة');
      kpis.innerHTML = [
        // التاريخان معزولان ولا ينكسران عند الشرطة (كان «2026-» يلتف وحده على الجوال)
        stat('زيارات الروابط', r.visits, { html: 'من <bdi class="num nowrap">' + esc(r.from || '—') + '</bdi> إلى <bdi class="num nowrap">' + esc(r.to || '—') + '</bdi>' }),
        stat('زوار فريدون', r.uniqueVisitors, 'بصمة اليوم — بلا تتبّع أفراد'),
        stat('فتح صفحة التصميم', (byKey.visit || {}).n, 'مستقلة عن زيارات الروابط'),
        stat('بدء تصميم', (byKey.start || {}).n, 'سلّم التحويل'),
        stat('إكمال تصميم', (byKey.finish || {}).n, 'سلّم التحويل'),
        stat('طلبات مؤكَّدة', (byKey.order || {}).n, 'ربط فعلي بطلب في النظام'),
        stat('متوسط مدة التصميم', dur, dur === '—' ? 'لا توجد بيانات كافية' : 'من وقت الإنشاء إلى آخر تحديث'),
      ].join('');

      // قمع التحويل: كل عمود بنسبة حجمه الصحيح
      const maxN = Math.max(1, ...(F.steps || []).map((s) => s.n || 0));
      funnel.innerHTML = '<div class="funnel">' + (F.steps || []).map((s) => {
        const pctW = Math.round(((s.n || 0) / maxN) * 100);
        const rate = s.rate == null ? '' : ' <span class="funnel-rate">' + s.rate + '%</span>';
        return '<div class="funnel-row">'
          + '<span class="funnel-label">' + esc(s.label) + '</span>'
          + '<span class="funnel-n">' + ownerNum(s.n) + rate + '</span>'
          + '<span class="funnel-bar"><i style="width:' + Math.max(1, pctW) + '%"></i></span>'
          + '</div>';
      }).join('') + '</div><p class="funnel-note">' + esc(F.note || '') + '</p>';

      // رسم يومي (بدء/إكمال) بـ CSS بلا مكتبة
      const days = r.daily || [];
      if (days.length) {
        const byDay = {};
        days.forEach((d) => { (byDay[d.day] = byDay[d.day] || { start: 0, finish: 0 })[d.name] = d.n; });
        const keys = Object.keys(byDay).sort();
        const maxV = Math.max(1, ...keys.map((k) => Math.max(byDay[k].start, byDay[k].finish)));
        trend.innerHTML = '<div class="trend">' + keys.map((k) =>
          '<span class="trend-col" title="' + esc(k) + '">'
          + '<i class="trend-bar start" style="height:' + Math.round((byDay[k].start / maxV) * 100) + '%"></i>'
          + '<i class="trend-bar finish" style="height:' + Math.round((byDay[k].finish / maxV) * 100) + '%"></i>'
          + '</span>').join('') + '</div>'
          + '<div class="trend-legend"><span><i style="background:var(--accent)"></i>بدء تصميم</span><span><i style="background:var(--accent-line)"></i>إكمال</span></div>';
      } else {
        trend.innerHTML = '<p class="owner-empty">لا أرقام يومية في هذه الفترة.</p>';
      }

      // مراحل التصميم: الوصول مقابل المغادرة — يفهرس 1..5
      const STEP_LABELS = ['الغرفة', 'العناصر المعمارية', 'المجلس', 'الأثاث والإكسسوارات', 'المراجعة'];
      const rc = {}; (r.stepReached || []).forEach((x) => { rc[x.dim] = x.n; });
      const ex = {}; (r.stepExit || []).forEach((x) => { ex[x.dim] = x.n; });
      const maxS = Math.max(1, ...Object.values(rc), ...Object.values(ex));
      const stepRows = [];
      for (let i = 1; i <= 5; i++) {
        const reached = rc[String(i)] || 0, exited = ex[String(i)] || 0;
        const lab = STEP_LABELS[i - 1] || ('مرحلة ' + i);
        const drop = reached > 0 ? Math.round((exited / reached) * 100) : null;
        stepRows.push('<div class="funnel-row">'
          + '<span class="funnel-label">' + esc(lab) + '</span>'
          + '<span class="funnel-n">' + ownerNum(reached) + (drop == null ? '' : ' <span class="funnel-rate">غادر ' + drop + '%</span>') + '</span>'
          + '<span class="funnel-bar"><i style="width:' + Math.round(((reached || 0) / maxS) * 100) + '%"></i></span>'
          + '</div>');
      }
      steps.innerHTML = '<div class="funnel">' + stepRows.join('') + '</div>'
        + '<p class="funnel-note">الوصول — المرحلة — المغادرة (نسبة من الوصول).</p>';

      // تفضيلات التصميم من بيانات التصاميم المخزّنة أصلاً
      const pr = r.prefs || {};
      const listOf = (arr, lab) => {
        if (!arr || !arr.length) return '<p class="owner-empty">' + lab + ': لا بيانات في هذه الفترة.</p>';
        return '<ul class="dim-list">' + arr.map((x) => '<li><b>' + esc(x.dim || '—') + '</b><span>' + ownerNum(x.n) + '</span></li>').join('') + '</ul>';
      };
      const SEAT = { floor: 'أرضي', raised: 'رفيع', arabic: 'عربي', sofa: 'كنب' };
      prefs.innerHTML =
        '<p class="owner-empty">عدد التصاميم في الفترة: <b>' + ownerNum(pr.designs) + '</b></p>'
        + '<b>متوسط عدد قطع الكنب</b>'
        + (pr.avgSofaPieces == null ? '<p class="owner-empty">لا توجد بيانات كافية.</p>'
          : '<p class="funnel-n">' + pr.avgSofaPieces + ' قطعة كنب في التصميم الواحد (عدد العيّنات: ' + ownerNum(pr.avgSofaPiecesSample) + ')</p>')
        + '<b>أكثر أبعاد الغرفة</b>' + listOf(pr.rooms, 'أبعاد الغرفة')
        + '<b>عدد الجدران</b>' + listOf(pr.walls, 'عدد الجدران')
        + '<b>نوع الكنب</b>' + listOf((pr.sofaKinds || []).map((x) => Object.assign({}, x, { dim: (SEAT[x.dim] || x.dim) })), 'نوع الكنب')
        + '<b>أكثر الإكسسوارات المستخدمة</b>' + listOf(pr.accKinds, 'الإكسسوارات')
        + '<b>أعماق الكنب (م)</b>' + listOf(pr.sofaDepth, 'أعماق الكنب');

      // متابعة الطلبات: مراحل من جدول orders + أسباب الخسارة المسجّلة داخلياً
      const od = r.orders || { total: 0, byStatus: [], lossReasons: [] };
      orders.innerHTML = '<p class="owner-empty">عدد الطلبات: <b>' + ownerNum(od.total) + '</b></p>'
        + (od.byStatus && od.byStatus.length
          ? '<ul class="dim-list">' + od.byStatus.map((x) => '<li><b>' + esc(STATUS[x.dim] || x.dim) + '</b><span>' + ownerNum(x.n) + '</span></li>').join('') + '</ul>'
          : '<p class="owner-empty">لا طلبات في هذه الفترة.</p>')
        + (od.lossReasons && od.lossReasons.length
          ? '<b>أسباب الخسارة (مسجّلة داخلياً)</b>'
            + '<ul class="dim-list">' + od.lossReasons.map((x) => '<li><b>' + esc(x.dim) + '</b><span>' + ownerNum(x.n) + '</span></li>').join('') + '</ul>'
          : '<p class="owner-empty">لا أسباب خسارة مسجلة داخلياً — لا نطلب استبياناً من العميل.</p>');

      // مصادر البيانات وما هو غير متوفر — بلا إخفاء
      const un = r.unavailable || {};
      sources.innerHTML = '<p class="owner-src"><b>مصادر الزيارة:</b> غير متوفّرة — '
        + esc(un.referrer || '') + '</p>'
        + '<p class="owner-src"><b>واتساب:</b> نسجّل ضغط الزر فقط — ولا يعني ذلك أن الرسالة وصلت أو أن بيعاً تمّ. ' + esc(un.whatsappSent || '') + '</p>'
        + '<p class="owner-src"><b>متوسط التصميم:</b> ' + (r.avgDesignMin == null ? '— لا يوجد متوسط محسوب.' : r.avgDesignMin + ' دقيقة') + '</p>'
        + '<p class="owner-src"><b>الخصوصية:</b> لا بصمة جهاز ولا تتبّع يحدّد الأفراد. ' + esc(un.deviceFingerprint || '') + '</p>';
    }).catch((e) => {
      const msg = (e && e.message) || 'تعذّر التحميل';
      [funnel, trend, steps, prefs, orders, sources].forEach((el) => { el.innerHTML = '<p class="owner-empty">' + esc(msg) + '</p>'; });
    });
  }


  /** ربط مرشّحات لوحة المالك — مرة واحدة عند التهيئة */
  function wireOwnerPanel() {
    const chips = $$('#ownerRangeChips .chip');
    if (!chips.length) return;
    if (chips[0].dataset.wired === '1') return;
    chips.forEach((c) => {
      c.dataset.wired = '1';
      c.addEventListener('click', () => {
        ownerRange = c.dataset.og || 'd30';
        chips.forEach((x) => {
          const on = x === c;
          x.classList.toggle('on', on);
          x.setAttribute('aria-pressed', String(on));
        });
        renderOwnerPanel();
      });
    });
    const ap = $('#ownerApply');
    if (ap && !ap.dataset.wired) {
      ap.dataset.wired = '1';
      ap.addEventListener('click', () => {
        ownerRange = 'custom';
        chips.forEach((x) => x.classList.remove('on'));
        renderOwnerPanel();
      });
    }
  }

  function renderBI() {
    renderIncludeChips($('#biInclude'), { onChange: renderBI });
    if (!canPage('bi')) return;
    // المصروفات لا تصل مع المزامنة: تُجلب (مرة كل دقيقة على الأكثر) ثم يُعاد الرسم بها
    if (canAny('expenses.view_own', 'expenses.view_all') && Date.now() - expLoadedAt > 60000 && !expLoading) {
      loadExpenses().then(() => { if (document.body.dataset.page === 'bi') renderBI(); }).catch(() => {});
    }
    renderOwnerPanel();
    biMobileAt = isMobile();

    // خيارات الموظفين: من المستخدمين الحاليين ومن الطلبات (موظف محذوف له طلبات)
    const sel = $('#biUser');
    const prev = sel.value;
    const names = new Map();
    db().users.forEach((u) => names.set(u.id, u.name));
    db().orders.forEach((o) => { if (o.createdBy && !names.has(o.createdBy)) names.set(o.createdBy, o.createdByName || 'مستخدم محذوف'); });
    sel.innerHTML = '<option value="">كل الموظفين</option>' + [...names.entries()].map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    if (names.has(prev)) sel.value = prev;
    const userId = sel.value;

    const p = biPeriod();
    if (biRange !== 'custom') { $('#biFrom').value = p.from; $('#biTo').value = p.to; }
    $$('#biRangeChips .chip').forEach((c) => {
      const on = c.dataset.rg === biRange;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });
    $$('#biGranChips .chip').forEach((c) => {
      const on = c.dataset.gr === biGran;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });
    $$('#biTopChips .chip').forEach((c) => {
      const on = c.dataset.tp === biTopTab;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });

    const a = biAgg(p.from, p.to, userId);
    const pp = biPrevPeriod(p);
    const pv = pp ? biAgg(pp.from, pp.to, userId) : null;

    const who = userId ? ` • الموظف: ${(names.get(userId) || '')}` : '';
    // التواريخ داخل نص عربي تُقلب خانَاتها إن تُركت للخوارزمية ثنائية الاتجاه: تُعزل بـ bdi
    const d = (s) => `<bdi dir="ltr">${esc(s)}</bdi>`;
    $('#biNote').innerHTML = `${esc(BI_RANGES[biRange] || 'فترة')}: ${p.from ? d(p.from) : 'من أول طلب'} إلى ${p.to ? d(p.to) : 'اليوم'}`
      + `${pv ? ` • تُقارن بـ ${d(pp.from)} إلى ${d(pp.to)}` : ' • لا مقارنة بفترة سابقة'}${esc(who)} • ${a.list.length} طلب.`;
    $('#biNote').hidden = false;

    const empty = a.list.length === 0;
    $('#biEmpty').hidden = !empty;
    $('#biBody').hidden = empty;

    // عملاء جدد: أول طلب لهم في النظام يقع داخل الفترة
    const firstSeen = new Map();
    db().orders.forEach((o) => {
      const k = biCustKey(o);
      const d = ordDate(o);
      if (!k || !d) return;
      if (!firstSeen.has(k) || d < firstSeen.get(k)) firstSeen.set(k, d);
    });
    const inPeriod = [...new Set(a.live.map(biCustKey).filter(Boolean))];
    const fresh = inPeriod.filter((k) => !p.from || firstSeen.get(k) >= p.from).length;

    // الصف الأول: أرقام المال والحجم التي تُقرأ أولاً. الصف الثاني: مؤشرات مساندة.
    $('#biKpis').innerHTML = `
      <div class="stat"><span>المبيعات <small>(قبل الضريبة)</small></span><b>${fmt(a.revenue)}</b>${biDeltaTag(a.revenue, pv && pv.revenue)}</div>
      <div class="stat"><span>المحصّل</span><b>${fmt(a.paid)}</b><small>${a.gross ? `${fmtQty(r2((a.paid / a.gross) * 100))}٪ من قيمة الطلبات` : '—'}</small></div>
      <div class="stat remaining"><span>المتبقي على العملاء</span><b>${fmt(a.remaining)}</b>${biDeltaTag(a.remaining, pv && pv.remaining, true)}</div>
      <div class="stat"><span>عدد الطلبات</span><b>${a.count}</b>${biDeltaTag(a.count, pv && pv.count)}</div>
      <div class="stat cost"><span>المصروفات</span><b>${fmt(a.expenses)}</b></div>
      <div class="stat profit"><span>صافي النتيجة</span><b class="${a.net < 0 ? 'neg' : 'pos'}">${fmt(a.net)}</b></div>`;

    $('#biKpisSub').innerHTML = `
      <div class="stat profit"><span>صافي الربح</span><b class="${a.costed.length ? (a.profit < 0 ? 'neg' : 'pos') : 'is-na'}">${a.costed.length ? fmt(a.profit) : '—'}</b><small class="${a.costed.length ? '' : 'na-note'}">${a.costed.length ? `هامش ${fmtQty(a.margin)}٪` : 'يُحسب بعد إدخال تكاليف الطلبات'}</small></div>
      <div class="stat"><span>إجمالي العمولات</span><b class="${a.commOrders.length ? 'pos' : 'is-na'}">${a.commOrders.length ? fmt(money(a.commission + a.share)) : '—'}</b><small>${a.commOrders.length ? `من ${commBaseLabel()}: عمولات ${fmt(a.commission)} + مشاركة ${fmt(a.share)}` : ''}</small></div>
      <div class="stat"><span>متوسط قيمة الطلب</span><b>${fmt(a.avg)}</b>${biDeltaTag(a.avg, pv && pv.avg)}</div>
      <div class="stat"><span>أمتار الكنب</span><b>${fmtQty(a.meters)}</b><small>${a.count ? `${fmtQty(r2(a.meters / a.count))} م لكل طلب` : '—'}</small></div>
      <div class="stat"><span>عملاء جدد</span><b>${fresh}</b><small>من ${inPeriod.length} عميل في الفترة</small></div>`;

    if (empty) return;

    const s = biSeries(a.live, p);
    $('#biTrend').innerHTML = s.rows.length ? biChart(s) + `
      <div class="chart-legend">
        <span><i class="lg-sales"></i> المبيعات قبل الضريبة</span>
        <span><i class="ln lg-profit"></i> صافي الربح</span>
        <span class="hint">${s.gran === 'day' ? 'كل عمود يوم' : s.gran === 'week' ? 'كل عمود أسبوع يبدأ السبت' : 'كل عمود شهر'} • الأقدم إلى اليمين${s.trimmed ? ' • عُرضت آخر 40 فترة فقط' : ''} • خط الربح ينقطع في الفترات التي لم تُدخل تكاليفها</span>
      </div>` : '<p class="hint">لا توجد بيانات كافية للرسم.</p>';

    biRenderStatus(a);
    biRenderCollect(a);
    biRenderTop(a);
    biRenderStaff(a);
    biRenderCustomers(a);
    biRenderCosts(a);
    biRenderOps(a, userId);
    biRenderInsights(a, pv, p, userId);
    biBalance();
    renderOrdersReport();
  }

  /* موازنة العمودين (الشاشات العريضة): أطوال البطاقات تتبع البيانات، فتُوضع بطاقة
     الرؤى حيث يقلّ الفرق بين العمودين — تحت الأقصر أو بعرض كامل أسفلهما —
     حتى لا يبقى فراغ كبير تحت عمود واحد. ترتيب العرض فقط، لا بيانات. */
  function biBalance() {
    const body = $('#biBody'), ins = $('#biInsightsCard');
    if (!body || !ins) return;
    if (ins.parentElement !== body) body.appendChild(ins);   // موضعه الأصلي: بعرض كامل
    if (body.hidden || !window.matchMedia('(min-width: 1440px)').matches) return;
    const main = $('.bi-main', body), side = $('.bi-side', body);
    // تُجرَّب المواضع الثلاثة فعلاً وتُقاس بالطول الطبيعي (بلا مدّ آخر بطاقة):
    // ارتفاع البطاقة يتغيّر بعرض موضعها (عمودا نص حين تكون بعرض كامل)
    body.classList.add('measuring');
    const diffNow = () => Math.abs(main.offsetHeight - side.offsetHeight);
    let best = { el: null, diff: diffNow() };
    [main, side].forEach((col) => {
      col.appendChild(ins);
      const diff = diffNow();
      if (diff < best.diff) best = { el: col, diff };
    });
    if (best.el) best.el.appendChild(ins); else body.appendChild(ins);
    body.classList.remove('measuring');
  }
  let biWideAt = null;
  window.addEventListener('resize', () => {
    const wide = window.matchMedia('(min-width: 1440px)').matches;
    if (wide === biWideAt) return;
    biWideAt = wide;
    if ($('#page-bi').classList.contains('active')) biBalance();
  });

  function biExportCsv() {
    const p = biPeriod();
    const userId = $('#biUser').value;
    const a = biAgg(p.from, p.to, userId);
    if (!a.list.length) { toast('لا توجد بيانات للتصدير', true); return; }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [];
    const push = (...cols) => rows.push(cols.map(cell).join(','));
    push('تقرير ذكاء الأعمال', settings().shopName || '');
    push('الفترة', p.from || 'من أول طلب', p.to || 'اليوم');
    push('الموظف', userId ? (Store.getUser(userId) || {}).name || '' : 'كل الموظفين');
    push('صُدِّر في', fmtDateTime(Store.now()));
    push('');
    push('المؤشر', 'القيمة');
    push('عدد الطلبات', a.count);
    push('طلبات ملغية', a.cancelled);
    push('المبيعات قبل الضريبة', a.revenue);
    push('قيمة الطلبات مع الضريبة', a.gross);
    push('إجمالي التكاليف', a.costed.length ? a.cost : '');
    push('صافي الربح', a.costed.length ? a.profit : '');
    push('إجمالي العمولات', a.commOrders.length ? money(a.commission + a.share) : '');
    push('هامش الربح ٪', a.costed.length ? a.margin : '');
    push('المحصّل', a.paid);
    push('المتبقي على العملاء', a.remaining);
    push('متوسط قيمة الطلب', a.avg);
    push('أمتار الكنب', a.meters);
    push('');
    push('الأداء عبر الزمن');
    push('الفترة', 'المبيعات', 'صافي الربح', 'عدد الطلبات');
    biSeries(a.live, p).rows.forEach((b) => push(b.label, b.revenue, b.costed ? b.profit : '', b.orders));
    push('');
    push('أداء الموظفين');
    push('الموظف', 'الطلبات', 'المبيعات', 'صافي الربح', 'العمولة', 'المشاركة', 'الهامش ٪', 'متوسط الطلب', 'المتبقي');
    biStaffRows(a).forEach((e) => push(e.name, e.count, money(e.revenue), e.costed ? money(e.profit) : '', e.commission ? money(e.commission) : '', e.share ? money(e.share) : '', e.costed && e.costedRev ? r2((e.profit / e.costedRev) * 100) : '', money(e.revenue / e.count), money(e.remaining)));
    push('');
    push('العملاء');
    push('العميل', 'الجوال', 'الطلبات', 'المبيعات', 'المتبقي', 'آخر طلب');
    biCustRows(a).forEach((e) => push(e.name, e.phone, e.count, money(e.revenue), money(e.remaining), e.last));
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `bi-report-${p.from || 'all'}_${p.to || today()}.csv`);
  }

/* ---------------- تصدير تقرير الذكاء التجاري إلى PDF ---------------- */
/* تقارير PDF في «ذكاء الأعمال» تمرّ بمحرّك التقارير نفسه (صفحات HTML تُصوَّر)،
   بدل كتابة النص مباشرة في jsPDF التي تُخرج العربية حروفاً منفصلة ومعكوسة. */
function biPdfMeta(p, userId) {
  return [['المتجر', settings().shopName || 'أصالة نجد'], ['الموظف', userId ? ((Store.getUser(userId) || {}).name || '') : 'كل الموظفين'], ['يشمل', includeLabel()], ['صُدِّر في', fmtDateTime(Store.now())], ['أعدّه', (currentUser && currentUser.name) || '']];
}
const biPdfFile = (base, p) => base + '-' + (p.from || 'all') + '_' + (p.to || today()) + '.pdf';
async function biFetchReport(path, p, userId) {
  const qs = new URLSearchParams();
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (userId) qs.set('userId', userId);
  const res = await fetch((Store.apiBase || '') + path + (qs.toString() ? '?' + qs.toString() : ''), { headers: { 'x-session-token': Store.token || '' } });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function biExportPdf() {
  const p = biPeriod();
  const userId = $('#biUser').value;
  const a = biAgg(p.from, p.to, userId);
  if (!a.list.length) { toast('لا توجد بيانات للتصدير', true); return; }
  const has = a.costed.length > 0;
  const rep = {
    id: 'bi', title: 'تقرير ذكاء الأعمال', from: p.from || '', to: p.to || today(),
    summary: [
      { label: 'المبيعات قبل الضريبة', value: a.revenue, kind: 'money' },
      { label: 'المحصّل', value: a.paid, kind: 'money' },
      { label: 'المتبقي على العملاء', value: a.remaining, kind: 'money' },
      { label: 'عدد الطلبات', value: a.count, kind: 'num' },
      { label: 'إجمالي التكاليف', value: has ? a.cost : null, kind: 'money' },
      { label: 'صافي الربح', value: has ? a.profit : null, kind: 'money' },
      { label: 'إجمالي العمولات', value: a.commOrders.length ? money(a.commission + a.share) : null, kind: 'money' },
      { label: 'إجمالي المصروفات', value: a.expenses, kind: 'money' },
      { label: 'صافي النتيجة بعد المصروفات', value: a.net, kind: 'money' },
    ],
    tables: [
      { title: 'أداء الموظفين', columns: [
        { key: 'name', label: 'الموظف' }, { key: 'count', label: 'الطلبات', kind: 'num' }, { key: 'revenue', label: 'المبيعات', kind: 'money' },
        { key: 'profit', label: 'صافي الربح', kind: 'money' }, { key: 'commission', label: 'العمولة', kind: 'money' }, { key: 'share', label: 'المشاركة', kind: 'money' },
        { key: 'margin', label: 'الهامش', kind: 'pct' }, { key: 'avg', label: 'متوسط الطلب', kind: 'money' }, { key: 'remaining', label: 'المتبقي', kind: 'money' }],
        rows: biStaffRows(a).map((e) => ({ name: e.name, count: e.count, revenue: money(e.revenue), profit: e.costed ? money(e.profit) : null, commission: e.commission ? money(e.commission) : null, share: e.share ? money(e.share) : null, margin: e.costed && e.costedRev ? r2((e.profit / e.costedRev) * 100) : null, avg: money(e.revenue / e.count), remaining: money(e.remaining) })) },
      { title: 'العملاء', columns: [
        { key: 'name', label: 'العميل' }, { key: 'phone', label: 'الجوال', kind: 'num' }, { key: 'count', label: 'الطلبات', kind: 'num' },
        { key: 'revenue', label: 'المبيعات', kind: 'money' }, { key: 'remaining', label: 'المتبقي', kind: 'money' }, { key: 'last', label: 'آخر طلب', kind: 'date' }],
        rows: biCustRows(a).map((e) => ({ name: e.name, phone: e.phone, count: e.count, revenue: money(e.revenue), remaining: money(e.remaining), last: e.last })) },
    ],
    notes: has ? [] : ['لم تُسجَّل تكاليف لطلبات هذه الفترة، فلا يُحسب الربح والعمولات.'],
  };
  await repPdfRender(rep, biPdfMeta(p, userId), biPdfFile('bi-report', p), $('#btnBiPdf'));
}

/* ---------------- تصدير تقرير الذكاء التجاري إلى Excel ---------------- */
async function biExportXlsx() {
  const p = biPeriod();
  const userId = $('#biUser').value;
  const a = biAgg(p.from, p.to, userId);
  if (!a.list.length) { toast('لا توجد بيانات للتصدير', true); return; }
  if (!window.XLSX) { try { await loadScript(XLSX_URL); } catch (_) { toast('تعذّر تحميل مكتبة Excel. تحقق من الاتصال.', true); return; } }
  const { XLSX } = window;
  const wb = XLSX.utils.book_new();
  // Sheet 1: KPIs
  const kpiData = [
    ['المؤشر', 'القيمة'],
    ['المبيعات قبل الضريبة', a.revenue],
    ['المحصّل', a.paid],
    ['المتبقي على العملاء', a.remaining],
    ['عدد الطلبات', a.count],
    ['طلبات ملغية', a.cancelled],
    ['عروض الأسعار', a.quotes],
    ['إجمالي التكاليف', a.costed.length ? a.cost : ''],
    ['صافي الربح', a.costed.length ? a.profit : ''],
    ['إجمالي العمولات', a.commOrders.length ? money(a.commission + a.share) : ''],
    ['هامش الربح %', a.costed.length ? a.margin : ''],
    ['أمتار الكنب', a.meters],
    ['عملاء جدد', a.fresh],
    ['المصروفات', a.expenses],
    ['صافي النتيجة', a.net],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(kpiData);
  XLSX.utils.book_append_sheet(wb, ws1, 'المؤشرات');
  // Sheet 2: الموظفين
  const staffRows = [['الموظف', 'الطلبات', 'المبيعات', 'صافي الربح', 'العمولة', 'المشاركة', 'الهامش %', 'متوسط الطلب', 'المتبقي']];
  biStaffRows(a).forEach((e) => staffRows.push([e.name, e.count, money(e.revenue), e.costed ? money(e.profit) : '', e.commission ? money(e.commission) : '', e.share ? money(e.share) : '', e.costed && e.costedRev ? r2((e.profit / e.costedRev) * 100) : '', money(e.revenue / e.count), money(e.remaining)]));
  const ws2 = XLSX.utils.aoa_to_sheet(staffRows);
  XLSX.utils.book_append_sheet(wb, ws2, 'أداء الموظفين');
  XLSX.writeFile(wb, 'bi-report-' + (p.from || 'all') + '_' + (p.to || today()) + '.xlsx');
}

/* ---------------- تصدير تقرير المناديب إلى PDF ---------------- */
async function exportMandoubsPdf() {
  const p = biPeriod();
  const userId = $('#biUser').value;
  const data = await biFetchReport('/api/reports/mandoubs', p, userId);
  if (!data) { toast('فشل تحميل تقرير المناديب', true); return; }
  if (!data.ok || !data.mandoubs || !data.mandoubs.length) { toast('لا توجد بيانات للتصدير', true); return; }
  const sum = (k) => money(data.mandoubs.reduce((t, m) => t + (Number(m[k]) || 0), 0));
  const cnt = data.mandoubs.reduce((t, m) => t + (Number(m.count) || 0), 0);
  const rep = {
    id: 'mandoubs', title: 'تقرير المناديب', from: p.from || '', to: p.to || today(),
    summary: [
      { label: 'عدد المناديب', value: data.mandoubs.length, kind: 'num' },
      { label: 'الطلبات', value: cnt, kind: 'num' },
      { label: 'الإيرادات', value: sum('revenue'), kind: 'money' },
      { label: 'صافي الربح', value: sum('profit'), kind: 'money' },
    ],
    tables: [{ title: 'المناديب', columns: [
      { key: 'name', label: 'المندوب' }, { key: 'count', label: 'الطلبات', kind: 'num' }, { key: 'revenue', label: 'الإيرادات', kind: 'money' },
      { key: 'cost', label: 'التكاليف', kind: 'money' }, { key: 'profit', label: 'صافي الربح', kind: 'money' }, { key: 'commission', label: 'العمولات', kind: 'money' }, { key: 'share', label: 'المشاركة', kind: 'money' }],
      rows: data.mandoubs.map((m) => ({ name: m.name || 'مندوب غير محدد', count: m.count, revenue: money(m.revenue), cost: money(m.cost), profit: money(m.profit), commission: money(m.commission), share: money(m.share) })),
      totals: { name: 'الإجمالي', count: cnt, revenue: sum('revenue'), cost: sum('cost'), profit: sum('profit'), commission: sum('commission'), share: sum('share') } }],
    notes: [],
  };
  await repPdfRender(rep, biPdfMeta(p, userId), biPdfFile('mandoubs-report', p), $('#btnMandoubsPdf'));
}

/* ---------------- تصدير تقرير المناديب إلى Excel ---------------- */
async function exportMandoubsXlsx() {
  const p = biPeriod();
  const userId = $('#biUser').value;
  const qs = new URLSearchParams();
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (userId) qs.set('userId', userId);
  const url = (Store.apiBase || '') + '/api/reports/mandoubs' + (qs.toString() ? '?' + qs.toString() : '');
  const res = await fetch(url, { headers: { 'x-session-token': Store.token || '' } });
  if (!res.ok) { toast('فشل تحميل تقرير المناديب', true); return; }
  const data = await res.json();
  if (!data.ok || !data.mandoubs || !data.mandoubs.length) { toast('لا توجد بيانات للتصدير', true); return; }
  if (!window.XLSX) { try { await loadScript(XLSX_URL); } catch (_) { toast('تعذّر تحميل مكتبة Excel. تحقق من الاتصال.', true); return; } }
  const { XLSX } = window;
  const wb = XLSX.utils.book_new();
  const rows = [['المندوب', 'الطلبات', 'الإيرادات', 'التكاليف', 'صافي الربح', 'العمولات', 'المشاركة']];
  data.mandoubs.forEach((m) => rows.push([m.name || 'مندوب غير محدد', m.count, money(m.revenue), money(m.cost), money(m.profit), money(m.commission), money(m.share)]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'المناديب');
  XLSX.writeFile(wb, 'mandoubs-report-' + (p.from || 'all') + '_' + (p.to || today()) + '.xlsx');
}

/* ---------------- تصدير تقرير المصروفات إلى PDF ---------------- */
async function exportExpensesPdf() {
  const p = biPeriod();
  const userId = $('#biUser').value;
  const data = await biFetchReport('/api/reports/expenses-summary', p, userId);
  if (!data) { toast('فشل تحميل تقرير المصروفات', true); return; }
  if (!data.ok) { toast('لا توجد بيانات للتصدير', true); return; }
  const rep = {
    id: 'expenses', title: 'تقرير المصروفات', from: p.from || '', to: p.to || today(),
    summary: [{ label: 'إجمالي المصروفات', value: money(data.total_amount), kind: 'money' }, { label: 'عدد المصروفات', value: data.count, kind: 'num' }],
    tables: [], notes: ['تفاصيل كل مصروف في صفحة «التقارير» ← تقرير المصروفات.'],
  };
  await repPdfRender(rep, biPdfMeta(p, userId), biPdfFile('expenses-report', p), $('#btnExpensesPdf'));
}

/* ---------------- تصدير تقرير المصروفات إلى Excel ---------------- */
async function exportExpensesXlsx() {
  const p = biPeriod();
  const userId = $('#biUser').value;
  const qs = new URLSearchParams();
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (userId) qs.set('userId', userId);
  const res = await fetch((Store.apiBase || '') + '/api/reports/expenses-summary' + (qs.toString() ? '?' + qs.toString() : ''), { headers: { 'x-session-token': Store.token || '' } });
  if (!res.ok) { toast('فشل تحميل تقرير المصروفات', true); return; }
  const data = await res.json();
  if (!data.ok) { toast('لا توجد بيانات للتصدير', true); return; }
  if (!window.XLSX) { try { await loadScript(XLSX_URL); } catch (_) { toast('تعذّر تحميل مكتبة Excel. تحقق من الاتصال.', true); return; } }
  const { XLSX } = window;
  const wb = XLSX.utils.book_new();
  const rows = [['إجمالي المصروفات', 'عدد المصروفات']];
  rows.push([data.total_amount, data.count]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'المصروفات');
  XLSX.writeFile(wb, 'expenses-report-' + (p.from || 'all') + '_' + (p.to || today()) + '.xlsx');
}

  /* ---------------- تقرير الطلبات والتحصيل ---------------- */
  const ORD_STATUS_ORDER = ['quote', 'new', 'progress', 'done', 'delivered', 'cancelled'];
  const PAY_METHOD = { cash: 'نقداً', mada: 'مدى / شبكة', transfer: 'تحويل بنكي', card: 'بطاقة ائتمان', other: 'أخرى' };

  /** صفوف التقرير بعد فلاتر اللوحة نفسها + بحث العميل + الحالة (الأحدث أولاً) */
  function ordersReportRows() {
    const p = biPeriod();
    const userId = $('#biUser').value;
    const q = ($('#ordQ').value || '').trim().toLowerCase();
    const st = $('#ordStatus').value;
    let list = db().orders.filter((o) => o.createdAt);
    if (p.from) list = list.filter((o) => ordDate(o) >= p.from);
    if (p.to) list = list.filter((o) => ordDate(o) <= p.to);
    if (userId) list = list.filter((o) => o.createdBy === userId);
    if (st) list = list.filter((o) => o.status === st);
    if (q) {
      list = list.filter((o) => {
        const c = o.customer || {};
        return String(c.name || '').toLowerCase().includes(q) || String(c.phone || '').includes(q);
      });
    }
    list = list.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { list, p, userId };
  }

  function ordersReportCalc() {
    const { list, p, userId } = ordersReportRows();
    const live = list.filter(incCounted); /* عروض الأسعار والملغاة خارج القيم المالية، والباقي حسب «يشمل التقرير» */
    const sumMoney = (arr, f) => money(arr.reduce((s, o) => s + num(f(o)), 0));
    const byStatus = {};
    for (const o of list) {
      const st = o.status || 'new';
      if (!byStatus[st]) byStatus[st] = { count: 0, total: 0, paid: 0, remaining: 0 };
      const b = byStatus[st];
      b.count += 1;
      b.total += num(o.total);
      b.paid += num(o.paid);
      b.remaining += num(o.remaining);
    }
    return {
      list, p, userId, live, byStatus,
      revenue: sumMoney(live, orderRevenue),
      gross: sumMoney(live, (o) => num(o.total)),
      paid: sumMoney(live, (o) => num(o.paid)),
      remaining: sumMoney(live, (o) => num(o.remaining)),
    };
  }

  function renderOrdersReport() {
    if (!canPage('bi')) return;
    const c = ordersReportCalc();
    const userName = c.userId ? ((Store.getUser(c.userId) || {}).name || 'موظف') : 'كل الموظفين';
    $('#ordNote').textContent = `${BI_RANGES[biRange] || 'فترة'} • من ${c.p.from || 'أول طلب'} إلى ${c.p.to || 'اليوم'} • ${userName}`;
    $('#ordKpis').innerHTML = `
      <div class="stat"><span>الطلبات الفعلية</span><b>${c.live.length}</b><small>باستثناء عروض الأسعار والملغاة</small></div>
      <div class="stat"><span>إجمالي القيمة <small>(شامل الضريبة)</small></span><b>${fmt(c.gross)}</b><small>قبل الضريبة ${fmt(c.revenue)}</small></div>
      <div class="stat"><span>المحصّل</span><b>${fmt(c.paid)}</b></div>
      <div class="stat remaining"><span>المتبقي على العملاء</span><b>${fmt(c.remaining)}</b></div>`;
    $('#ordByStatus').innerHTML = ORD_STATUS_ORDER.filter((s) => c.byStatus[s]).map((s) => {
      const b = c.byStatus[s];
      return `<span class="ord-chip"><b>${esc(STATUS[s] || s)}</b> ${b.count} <small>الإجمالي ${fmt(money(b.total))} • المتبقي ${fmt(money(b.remaining))}</small></span>`;
    }).join('') || '<span class="hint">لا توجد طلبات مطابقة</span>';
    const MAX_ROWS = 200;
    const rows = c.list.slice(0, MAX_ROWS).map((o) => {
      const cust = o.customer || {};
      const pays = Array.isArray(o.payments) ? o.payments : [];
      const paysHtml = pays.length
        ? `<details class="ord-pays"><summary>${pays.length} دفعة</summary><ul>${pays.map((p) => `<li><span>${esc(p.at || p.date || '—')}</span><span>${esc(PAY_METHOD[p.method] || p.method || '')}</span><b>${fmt(num(p.amount))}</b></li>`).join('')}</ul></details>`
        : '<span class="hint">لا توجد دفعات</span>';
      return `<tr>
        <td>#${esc(o.number ?? '')}</td>
        <td>${esc(cust.name || '—')}${cust.phone ? `<br><small class="hint" dir="ltr">${esc(cust.phone)}</small>` : ''}</td>
        <td>${esc(STATUS[o.status] || o.status || '')}</td>
        <td>${esc(ordDate(o) || '—')}</td>
        <td class="ta-end">${fmt(num(o.total))}</td>
        <td class="ta-end">${fmt(num(o.paid))}</td>
        <td class="ta-end">${fmt(num(o.remaining))}</td>
        <td>${paysHtml}</td>
        <td><button type="button" class="btn small" data-open-ord="${esc(o.id)}">فتح</button></td>
      </tr>`;
    }).join('');
    $('#ordTable tbody').innerHTML = rows || '<tr><td colspan="9" class="hint">لا توجد طلبات مطابقة للفترة والفلاتر</td></tr>';
    $('#ordCountNote').textContent = c.list.length > MAX_ROWS
      ? `يُعرض أول ${MAX_ROWS} من ${c.list.length} طلب — ضيّق الفترة أو الفلاتر للتفاصيل.`
      : `${c.list.length} طلب مطابق.`;
    $$('#ordTable [data-open-ord]').forEach((b) => b.addEventListener('click', async () => {
      if (dirty && !(await confirmDlg('فتح طلب', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) return;
      const o = db().orders.find((x) => x.id === b.dataset.openOrd);
      if (o) loadOrder(o);
    }));
  }

  async function exportOrdersPdf() {
    const c = ordersReportCalc();
    if (!c.list.length) { toast('لا توجد بيانات للتصدير', true); return; }
    const rows = ORD_STATUS_ORDER.filter((x) => c.byStatus[x]).map((x) => { const b = c.byStatus[x]; return { st: STATUS[x] || x, count: b.count, total: money(b.total), paid: money(b.paid), remaining: money(b.remaining) }; });
    const rep = {
      id: 'orders-bi', title: 'تقرير الطلبات والتحصيل', from: c.p.from || '', to: c.p.to || today(),
      summary: [
        { label: 'الطلبات الفعلية', value: c.live.length, kind: 'num' },
        { label: 'الإجمالي شامل الضريبة', value: c.gross, kind: 'money' },
        { label: 'قبل الضريبة', value: c.revenue, kind: 'money' },
        { label: 'المحصّل', value: c.paid, kind: 'money' },
        { label: 'المتبقي على العملاء', value: c.remaining, kind: 'money' },
      ],
      tables: [{ title: 'التوزيع حسب الحالة', columns: [
        { key: 'st', label: 'الحالة' }, { key: 'count', label: 'الطلبات', kind: 'num' }, { key: 'total', label: 'الإجمالي', kind: 'money' },
        { key: 'paid', label: 'المحصّل', kind: 'money' }, { key: 'remaining', label: 'المتبقي', kind: 'money' }], rows }],
      notes: ['الملخص المالي للطلبات الفعلية فقط (بلا عروض الأسعار والملغاة).', 'التفصيل الكامل للطلبات والدفعات في ملف Excel.'],
    };
    await repPdfRender(rep, biPdfMeta(c.p, c.userId), biPdfFile('orders-report', c.p), $('#btnOrdersPdf'));
  }

  async function exportOrdersXlsx() {
    const c = ordersReportCalc();
    if (!c.list.length) { toast('لا توجد بيانات للتصدير', true); return; }
    if (!window.XLSX) { try { await loadScript(XLSX_URL); } catch (_) { toast('تعذّر تحميل مكتبة Excel. تحقق من الاتصال.', true); return; } }
    const { XLSX } = window;
    const wb = XLSX.utils.book_new();
    const summary = [
      ['تقرير الطلبات والتحصيل'],
      ['الفترة', (c.p.from || 'من أول طلب') + ' إلى ' + (c.p.to || 'اليوم')],
      ['الموظف', c.userId ? ((Store.getUser(c.userId) || {}).name || '') : 'كل الموظفين'],
      ['صُدِّر في', fmtDateTime(Store.now())],
      [],
      ['المؤشر', 'القيمة'],
      ['الطلبات الفعلية (بلا عروض الأسعار والملغاة)', c.live.length],
      ['إجمالي القيمة شامل الضريبة', c.gross],
      ['قبل الضريبة', c.revenue],
      ['المحصّل', c.paid],
      ['المتبقي على العملاء', c.remaining],
      [],
      ['الحالة', 'عدد', 'الإجمالي', 'المحصّل', 'المتبقي'],
    ];
    for (const s of ORD_STATUS_ORDER) {
      const b = c.byStatus[s];
      if (!b) continue;
      summary.push([STATUS[s] || s, b.count, money(b.total), money(b.paid), money(b.remaining)]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'المؤشرات');
    const ordersRows = [['رقم الطلب', 'العميل', 'الجوال', 'الحالة', 'التاريخ', 'الإجمالي', 'المحصّل', 'المتبقي', 'عدد الدفعات']];
    for (const o of c.list) {
      const cust = o.customer || {};
      ordersRows.push([o.number ?? '', cust.name || '', cust.phone || '', STATUS[o.status] || o.status || '', ordDate(o) || '', num(o.total), num(o.paid), num(o.remaining), Array.isArray(o.payments) ? o.payments.length : 0]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ordersRows), 'الطلبات');
    const payRows = [['رقم الطلب', 'العميل', 'تاريخ الدفعة', 'طريقة الدفع', 'المبلغ', 'ملاحظة']];
    for (const o of c.list) {
      const pays = Array.isArray(o.payments) ? o.payments : [];
      const cust = o.customer || {};
      for (const p of pays) {
        payRows.push([o.number ?? '', cust.name || '', p.at || p.date || '', PAY_METHOD[p.method] || p.method || '', num(p.amount), p.note || '']);
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(payRows), 'الدفعات');
    XLSX.writeFile(wb, 'orders-report-' + (c.p.from || 'all') + '_' + (c.p.to || today()) + '.xlsx');
  }



  /* ======================= صفحة «التقارير» =======================
     الحسابات في js/reports.js (نقية ومُختبرة)، وهنا: السياق والصلاحيات والعرض والتصدير.
     البيانات هي ما يراه المستخدم فقط (الخادم يصفّي الطلبات والتكاليف)، والأعمدة الحساسة
     (الربح، التكاليف، العمولات) تتبع صلاحية كل طلب. التصدير بصلاحية reports.export. */
  const REP_RANGES = { d: 'اليوم', m: 'هذا الشهر', lm: 'الشهر الماضي', d30: 'آخر 30 يوماً', q: 'هذا الربع', y: 'هذه السنة', ly: 'السنة الماضية', all: 'كل الفترات', custom: 'فترة مخصصة' };
  const repStore = {
    get(k, d) { try { const v = localStorage.getItem('majlis_rep_' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('majlis_rep_' + k, v); } catch (_) { /* تخزين غير متاح */ } },
  };
  let repId = repStore.get('id', 'orders');
  let repRange = repStore.get('range', 'm');
  let repLast = null;   // آخر تقرير معروض — هو نفسه ما يُصدَّر

  function repPeriod() {
    const t = new Date(), to = ymd(t);
    if (repRange === 'd') return { from: to, to };
    if (repRange === 'm') return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to };
    if (repRange === 'lm') return { from: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: ymd(new Date(t.getFullYear(), t.getMonth(), 0)) };
    if (repRange === 'd30') return { from: ymd(addDays(t, -29)), to };
    if (repRange === 'q') return { from: ymd(new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1)), to };
    if (repRange === 'y') return { from: ymd(new Date(t.getFullYear(), 0, 1)), to };
    if (repRange === 'ly') return { from: ymd(new Date(t.getFullYear() - 1, 0, 1)), to: ymd(new Date(t.getFullYear() - 1, 11, 31)) };
    if (repRange === 'all') return { from: '', to: '' };
    return { from: $('#repFrom').value, to: $('#repTo').value };
  }

  /** تفصيل عمولة الطلب بأنواعها — نفس orderCommBreakdown (النسب المحفوظة على الطلب أولاً) */
  function repBreakdown(o) {
    const b = orderCommBreakdown(o);
    if (!b) return null;
    const hasParent = b.rows.length === 3;
    return { profit: b.profit, base: b.base, rows: b.rows.map((r, i) => ({ ...r, kind: i === 0 ? 'owner' : (hasParent && i === 1 ? 'parent' : 'share') })) };
  }

  /* تقرير «زيارات الموقع»: بيانات الخادم للفترة المختارة (لا تصل مع المزامنة). تُجلب عند فتح التقرير
     أو تغيير الفترة، ثم يُعاد رسم الصفحة. «كل الفترات» = منذ أول زيارة مسجّلة. */
  const repVisits = { key: '', data: null, loading: '' };
  const repVisitsKey = (p) => (p.from || 'all') + '|' + (p.to || today());
  function loadRepVisits(p) {
    const key = repVisitsKey(p);
    if (repVisits.loading === key || (repVisits.key === key && repVisits.data && repVisits.data.ready)) return;
    repVisits.loading = key;
    if (repVisits.key !== key) { repVisits.key = key; repVisits.data = null; }
    const qs = new URLSearchParams({ range: 'custom', from: p.from || '2000-01-01', to: p.to || today() });
    Store.api('GET', '/api/owner-analytics?' + qs.toString())
      .then((r) => { if (repVisits.key === key) repVisits.data = Object.assign({ ready: true }, r); })
      .catch((e) => { if (repVisits.key === key) repVisits.data = { ready: false, error: humanError(e && e.message, 'تعذّر تحميل الزيارات. تحقق من الاتصال.') }; })
      .finally(() => { repVisits.loading = ''; if (document.body.dataset.page === 'reports' && repId === 'visits') renderReports(); });
  }

  function repCtx() {
    const p = repPeriod();
    const scopeAll = can('reports.view_all');
    return {
      orders: db().orders || [], expenses: db().expenses || [], users: db().users || [],
      visits: repVisits.key === repVisitsKey(p) ? repVisits.data : null,
      from: p.from, to: p.to, today: today(),
      userId: scopeAll ? $('#repUser').value : '',
      status: $('#repStatus').value,
      include: getInclude(),
      me: currentUser && currentUser.id, scopeAll,
      perms: {
        profitAny: canAny('profit.view_own', 'profit.view_all'),
        commAny: canAny('commission.view_own', 'commission.view_all'),
        expenses: canAny('expenses.view_own', 'expenses.view_all'),
        visits: can('admin.core'),   // زيارات الموقع للمالك وحده (الخادم يفرضها في /api/owner-analytics)
        profit: (o) => canFor(o, 'profit.view'),
        comm: (o) => canFor(o, 'commission.view'),
      },
      calc: {
        revenue: orderRevenue, cost: orderCost, breakdown: repBreakdown, ordDate,
        payDay: (pm) => String((pm && (pm.at || pm.date || pm.createdAt)) || '').slice(0, 10),
        expDay, commBase: commBaseMode(),
      },
      labels: { STATUS, PAY_METHOD: PAY_METHODS, ROLES },
      userName: (id, fb) => { const u = id && Store.getUser(id); return (u && u.name) || fb || 'غير محدد'; },
      userRole: (id) => { const u = id && Store.getUser(id); return (u && u.role) || (id && currentUser && id === currentUser.id ? currentUser.role : ''); },
    };
  }

  const repCell = (v, kind) => {
    if (v === null || v === undefined || v === '') return '<span class="hint">—</span>';
    if (kind === 'money') return `<bdi>${fmt(v)}</bdi>`;
    if (kind === 'pct') return `<bdi>${r2(v)}٪</bdi>`;
    if (kind === 'num') return `<bdi>${esc(String(v))}</bdi>`;
    if (kind === 'date') return `<bdi>${esc(String(v))}</bdi>`;
    return esc(String(v));
  };
  const isNumKind = (k) => k === 'money' || k === 'num' || k === 'pct';
  /** الفترة بتواريخ معزولة اتجاهياً (تاريخ لاتيني داخل نص عربي لا ينقلب) */
  const repPeriodHtml = (rep) => `من ${rep.from ? `<bdi dir="ltr">${esc(rep.from)}</bdi>` : 'أول سجل'} إلى <bdi dir="ltr">${esc(rep.to)}</bdi>`;

  function repMeta(rep) {
    const ctx = repCtx();
    const meta = [['المتجر', settings().shopName || 'أصالة نجد']];
    if (rep && rep.id === 'visits') meta.push(['النطاق', 'صفحات العملاء العامة']);
    else if (ctx.scopeAll) meta.push(['الموظف / المندوب', ctx.userId ? ctx.userName(ctx.userId) : 'الكل']);
    else meta.push(['النطاق', 'طلباتي فقط (' + ((currentUser && currentUser.name) || '') + ')']);
    const rdef = rep && Reports._defs[rep.id];
    if (rep && rep.id === 'orders' && $('#repStatus').value) meta.push(['الحالة', $('#repStatus').selectedOptions[0] ? $('#repStatus').selectedOptions[0].textContent : '']);
    else if (rdef && rdef.usesInclude) meta.push(['يشمل', rdef.includeNoPaid ? Reports.includeText({ include: { ...getInclude(), paidOnly: false }, labels: { STATUS } }) : includeLabel()]);
    meta.push(['صُدِّر في', fmtDateTime(Store.now())], ['أعدّه', (currentUser && currentUser.name) || '']);
    return meta;
  }

  /* اختيار أعمدة التقرير: تفضيل لهذا الجهاز (لكل تقرير ولكل جدول فيه)، يُطبَّق على الشاشة وعلى
     ملفات PDF وExcel وCSV معاً — لأن التصدير يأخذ آخر تقرير معروض (repLast) بعد التصفية.
     عمود واحد على الأقل يبقى ظاهراً، والأعمدة المحجوبة بالصلاحيات لا تظهر في القائمة أصلاً. */
  function repColsHidden(id) {
    try { const v = JSON.parse(repStore.get('cols_' + id, '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
  }
  function repApplyCols(rep) {
    const hid = repColsHidden(rep.id);
    rep.allTables = rep.tables;
    rep.tables = rep.tables.map((t, i) => {
      const h = Array.isArray(hid[i]) ? hid[i] : [];
      const cols = t.columns.filter((c) => h.indexOf(c.key) < 0);
      return cols.length ? { ...t, columns: cols } : t;
    });
    return rep;
  }
  function repToggleCol(id, ti, key) {
    const hid = repColsHidden(id);
    const h = Array.isArray(hid[ti]) ? hid[ti] : [];
    hid[ti] = h.indexOf(key) >= 0 ? h.filter((k) => k !== key) : h.concat(key);
    repStore.set('cols_' + id, JSON.stringify(hid));
  }
  function repColsMenuHtml(rep, ti) {
    const all = rep.allTables[ti].columns, shown = new Set(rep.tables[ti].columns.map((c) => c.key));
    return all.map((c) => {
      const on = shown.has(c.key);
      const last = on && shown.size === 1;   // لا يُخفى آخر عمود ظاهر
      return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" aria-pressed="${on}" data-repcol="${esc(c.key)}" data-ti="${ti}"${last ? ' disabled' : ''}>${icon('check')}<span>${esc(c.label)}</span></button>`;
    }).join('');
  }

  function renderReports() {
    if (!canPage('reports') || !window.Reports) return;
    // المصروفات لا تصل مع المزامنة: تُجلب (مرة كل دقيقة على الأكثر) ثم يُعاد الرسم
    if (canAny('expenses.view_own', 'expenses.view_all') && Date.now() - expLoadedAt > 60000 && !expLoading) {
      loadExpenses().then(() => { if (document.body.dataset.page === 'reports') renderReports(); }).catch(() => {});
    }
    const ctx = repCtx();
    const cat = Reports.catalog(ctx);
    if (!cat.some((c) => c.id === repId)) repId = cat[0].id;
    $('#repCatalog').innerHTML = cat.map((c) => `<button type="button" class="rep-tab${c.id === repId ? ' on' : ''}" role="tab" aria-selected="${c.id === repId}" data-rep="${esc(c.id)}"><b>${esc(c.title)}</b><small>${esc(c.desc)}</small></button>`).join('');
    $$('#repCatalog [data-rep]').forEach((b) => b.addEventListener('click', () => { repId = b.dataset.rep; repStore.set('id', repId); renderReports(); }));

    // الموظفون والمناديب: من المستخدمين ومن الطلبات (مستخدم محذوف له طلبات)
    const sel = $('#repUser');
    sel.hidden = !ctx.scopeAll;
    if (ctx.scopeAll) {
      const prev = sel.value, names = new Map();
      db().users.forEach((u) => names.set(u.id, `${u.name}${ROLES[u.role] ? ' · ' + ROLES[u.role] : ''}`));
      db().orders.forEach((o) => { if (o.createdBy && !names.has(o.createdBy)) names.set(o.createdBy, o.createdByName || 'مستخدم محذوف'); });
      sel.innerHTML = '<option value="">كل الموظفين والمناديب</option>' + [...names.entries()].map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
      if (names.has(prev)) sel.value = prev;
    }
    const def = cat.find((c) => c.id === repId);
    $('#repStatus').hidden = !def.usesStatus;
    // «يشمل التقرير»: للتقارير المالية فقط، ويختفي حين تختار حالة محددة في تقرير الطلبات
    const incBox = $('#repInclude');
    incBox.hidden = !def.usesInclude || (def.usesStatus && !!$('#repStatus').value);
    if (!incBox.hidden) renderIncludeChips(incBox, { noPaid: def.includeNoPaid, onChange: renderReports });
    // تقرير الزيارات بلا تصفية بالموظف (الزيارات لا تخص موظفاً)
    if (repId === 'visits') { $('#repUser').hidden = true; loadRepVisits(repPeriod()); }

    const p = repPeriod();
    if (repRange !== 'custom') { $('#repFrom').value = p.from; $('#repTo').value = p.to; }
    $$('#repRangeChips .chip').forEach((c) => { const on = c.dataset.rr === repRange; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });

    let rep;
    try { rep = repApplyCols(Reports.build(repId, repCtx())); } catch (e) { toast(e.message || 'تعذّر إعداد التقرير', true); return; }
    repLast = rep;
    $('#repNote').innerHTML = `${esc(rep.title)} • ${esc(REP_RANGES[repRange] || '')} • ${repPeriodHtml(rep)}${ctx.scopeAll ? '' : ' • طلباتي فقط'}`;
    $('#repKpis').innerHTML = rep.summary.map((s) => `<div class="stat"><span>${esc(s.label)}</span><b>${s.value === null || s.value === undefined ? '—' : (s.kind === 'money' ? fmt(s.value) : s.kind === 'pct' ? r2(s.value) + '٪' : esc(String(s.value)))}</b></div>`).join('');
    const MAX = 300;
    $('#repTables').innerHTML = rep.tables.map((t, ti) => `
      <section class="card module rep-table">
        <div class="module-head"><h3>${esc(t.title)}</h3><span class="hint">${t.rows.length} صف</span>
          <span class="rmenu cols-menu" style="margin-inline-start:auto">
            <button type="button" class="btn small ghost rmenu-btn" aria-haspopup="menu" aria-expanded="false" title="اختر الأعمدة التي تظهر في التقرير وفي ملفات التصدير" data-repcols="${ti}">${icon('list')}<span>الأعمدة</span></button>
            <span class="rmenu-list" role="menu" data-keep hidden>${repColsMenuHtml(rep, ti)}</span>
          </span></div>
        <div class="table-wrap"><table class="table compact">
          <thead><tr>${t.columns.map((c) => `<th${isNumKind(c.kind) ? ' class="ta-end"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${t.rows.length ? t.rows.slice(0, MAX).map((r) => `<tr>${t.columns.map((c) => `<td${isNumKind(c.kind) ? ' class="ta-end"' : ''}>${repCell(r[c.key], c.kind)}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${t.columns.length}" class="hint">لا توجد بيانات في هذه الفترة</td></tr>`}</tbody>
          ${t.totals && t.rows.length ? `<tfoot><tr>${t.columns.map((c) => `<td${isNumKind(c.kind) ? ' class="ta-end"' : ''}><b>${t.totals[c.key] === undefined ? '' : repCell(t.totals[c.key], c.kind)}</b></td>`).join('')}</tr></tfoot>` : ''}
        </table></div>
        ${t.rows.length > MAX ? `<p class="hint">يُعرض أول ${MAX} من ${t.rows.length} صفاً — الملف المُصدَّر يحوي الكل.</p>` : ''}
      </section>`).join('');
    $('#repNotes').innerHTML = (rep.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
    $$('#repTables [data-repcol]').forEach((b) => b.addEventListener('click', () => {
      const ti = b.dataset.ti, key = b.dataset.repcol;
      repToggleCol(rep.id, ti, key);
      // بعد انتهاء معالج النقر العام (يترك قوائم data-keep مفتوحة): إعادة الرسم ثم فتح القائمة نفسها
      // ليُبدَّل أكثر من عمود بفتحة واحدة
      setTimeout(() => {
        closeRowMenu();
        renderReports();
        const btn = $(`#repTables [data-repcols="${ti}"]`);
        if (!btn) return;
        openRowMenu(btn);
        const again = [...btn.nextElementSibling.querySelectorAll('[data-repcol]')].find((x) => x.dataset.repcol === key);
        if (again) again.focus({ preventScroll: true });
      }, 0);
    }));
  }

  const repFileName = (rep, ext) => `report-${rep.id}-${repPeriod().from || 'all'}_${repPeriod().to || today()}.${ext}`;
  function repReady() {
    if (!can('reports.export')) { toast('لا تملك صلاحية تصدير التقارير', true); return null; }
    renderReports();
    if (!repLast) { toast('لا يوجد تقرير للتصدير', true); return null; }
    if (!repLast.tables.some((t) => t.rows.length)) { toast('لا توجد بيانات للتصدير في هذه الفترة', true); return null; }
    return repLast;
  }

  function repExportCsv() {
    const rep = repReady(); if (!rep) return;
    downloadBlob(new Blob([Reports.toCsv(rep, repMeta(rep))], { type: 'text/csv;charset=utf-8' }), repFileName(rep, 'csv'));
  }

  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  async function repExportXlsx() {
    const rep = repReady(); if (!rep) return;
    try {
      if (!window.XLSX) await loadScript(XLSX_URL);
      const X = window.XLSX;
      const wb = X.utils.book_new();
      wb.Workbook = { Views: [{ RTL: true }] };
      const widths = (aoa) => aoa[0].map((_, i) => ({ wch: Math.min(40, Math.max(8, ...aoa.map((r) => String(r[i] ?? '').length + 2))) }));
      const head = [...Reports.headerAoa(rep, repMeta(rep)), [], ['الملخص'], ...Reports.summaryAoa(rep), [], ...(rep.notes || []).map((n) => [n])];
      const ws0 = X.utils.aoa_to_sheet(head); ws0['!cols'] = [{ wch: 34 }, { wch: 34 }];
      X.utils.book_append_sheet(wb, ws0, 'الملخص');
      const used = new Set(['الملخص']);
      rep.tables.forEach((t) => {
        let name = String(t.title).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'بيانات';
        while (used.has(name)) name = name.slice(0, 28) + ' ' + used.size;
        used.add(name);
        const aoa = Reports.tableAoa(t);
        const ws = X.utils.aoa_to_sheet(aoa);
        ws['!cols'] = widths(aoa);
        // تنسيق المبالغ برقمين عشريين
        t.columns.forEach((c, ci) => {
          if (c.kind !== 'money' && c.kind !== 'pct') return;
          for (let ri = 1; ri < aoa.length; ri++) { const ref = X.utils.encode_cell({ r: ri, c: ci }); if (ws[ref] && ws[ref].t === 'n') ws[ref].z = '#,##0.00'; }
        });
        X.utils.book_append_sheet(wb, ws, name);
      });
      const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
      downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), repFileName(rep, 'xlsx'));
    } catch (e) { toast(e.message || 'تعذّر إنشاء ملف Excel', true); }
  }

  /* PDF: صفحات HTML بحجم A4 أفقي تُصوَّر (html2canvas) — العربية تُرسم بخط الواجهة صحيحة الاتصال،
     والجدول يُقسَّم صفاً صفاً: رأس الجدول يتكرر في كل صفحة، وترقيم «صفحة N من M» في التذييل. */
  const REP_PAGE = { w: 1123, h: 794 };
  /* صفحة طولية لمستند يُقرأ على الجوال: عرض أضيق (= خط أكبر نسبةً لعرض الشاشة) بنسبة A4 الطولية */
  const REP_PAGE_P = { w: 640, h: 905 };
  async function repExportPdf() {
    const rep = repReady(); if (!rep) return;
    await repPdfRender(rep, repMeta(rep), repFileName(rep, 'pdf'), $('#btnRepPdf'));
  }
  /** محرّك PDF المشترك: كل تقارير PDF (التقارير وذكاء الأعمال) تمرّ من هنا كي تُرسم العربية متصلة */
  async function repPdfRender(rep, meta, fileName, btn, opts = {}) {
    if (btn) btn.disabled = true;
    const host = document.createElement('div');
    host.className = 'rep-print'; host.dir = 'rtl';
    host.style.cssText = 'position:fixed;top:0;left:-20000px;z-index:-1;background:#fff';
    document.body.appendChild(host);
    try {
      toast('جارٍ إنشاء ملف PDF…');
      await loadScript(H2C_URL);
      await loadScript(JSPDF_URL);
      const pages = [];
      /* التذييل يُملأ من البداية بنص بالطول نفسه («صفحة 00 من 00») حتى تُقاس مساحة المحتوى الحقيقية:
         كان فارغاً أثناء التقسيم ثم يُملأ بعده، فيأخذ سطره من آخر صف في كل صفحة فيُقصّ تحته */
      const stamp = fmtDateTime(Store.now());
      // مستند يُقرأ على الجوال (ملخص طلب): صفحة طولية أضيق بخط أكبر، وإلا التقرير الأفقي المعتاد
      const PG = rep.portrait ? REP_PAGE_P : REP_PAGE;
      const footHtml = (i, n) => `<span>${esc(settings().shopName || 'أصالة نجد')} • ${esc(rep.title)}</span><span>صُدِّر في <bdi>${esc(stamp)}</bdi></span><span>صفحة ${i} من ${n}</span>`;
      const newPage = (first) => {
        const pg = document.createElement('div');
        pg.className = 'rep-page' + (rep.portrait ? ' portrait' : '');
        pg.style.cssText = `width:${PG.w}px;height:${PG.h}px`;
        pg.innerHTML = first
          ? `<div class="rp-head"><div><h1>${esc(rep.title)}</h1><p>${rep.headSub ? esc(rep.headSub) : 'الفترة: ' + repPeriodHtml(rep)}</p></div><dl>${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl></div>`
          : `<div class="rp-head small"><b>${esc(rep.title)}</b><span>${rep.headSub ? esc(rep.headSub) : 'الفترة: ' + repPeriodHtml(rep)}</span></div>`;
        const body = document.createElement('div'); body.className = 'rp-body'; pg.appendChild(body);
        const foot = document.createElement('div'); foot.className = 'rp-foot'; foot.innerHTML = footHtml('00', '00'); pg.appendChild(foot);
        host.appendChild(pg); pages.push(pg);
        return body;
      };
      // هامش أمان صغير: اختلاف تقريب الأطوال بين القياس والتصوير لا يقصّ آخر سطر
      // (scrollHeight لا يقلّ عن clientHeight، فيُقاس أسفل آخر عنصر مباشرة)
      const fits = (body) => {
        if (body.scrollHeight > body.clientHeight + 1) return false;
        const last = body.lastElementChild;
        return !last || last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom - 6;
      };
      let body = newPage(true);
      /* القياس قبل اكتمال تحميل الخط يُخطئ في الارتفاعات (الخط البديل أصغر)، فيُقصّ آخر صف تحت الصفحة
         عند التصوير — حدث على الجوال: ضاع أول صف من «ملخص الحساب». ننتظر الخط بأوزانه أولاً */
      try {
        const fam = getComputedStyle(host).fontFamily;
        await Promise.race([
          Promise.all(['400', '600', '700'].map((w) => document.fonts.load(`${w} 16px ${fam}`, 'أبج 0123'))).then(() => document.fonts.ready),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      } catch (_) { /* متصفح بلا document.fonts: نكمل بالقياس كما هو */ }
      const sum = document.createElement('div'); sum.className = 'rp-kpis';
      sum.innerHTML = rep.summary.map((s) => `<div><span>${esc(s.label)}</span><b>${s.value === null || s.value === undefined ? '—' : (s.kind === 'money' ? fmt(s.value) : s.kind === 'pct' ? r2(s.value) + '٪' : esc(String(s.value)))}</b></div>`).join('');
      body.appendChild(sum);
      for (const t of rep.tables) {
        const dense = t.columns.length > 14 ? ' dense' : (t.columns.length > 10 ? ' mid' : '');
        const thead = `<thead><tr>${t.columns.map((c) => `<th${isNumKind(c.kind) ? ' class="n"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>`;
        const rowHtml = (r, bold) => `<tr${bold || r.b ? ' class="tot"' : ''}>${t.columns.map((c) => `<td${isNumKind(c.kind) ? ' class="n"' : ''}>${r[c.key] === undefined ? '' : repCell(r[c.key], c.kind)}</td>`).join('')}</tr>`;
        const startTable = (cont) => {
          const h = document.createElement('h2'); h.textContent = t.title + (cont ? ' (تابع)' : ''); body.appendChild(h);
          const tb = document.createElement('table'); tb.className = 'rp-table' + dense; tb.dataset.t = String(rep.tables.indexOf(t)); tb.innerHTML = thead + '<tbody></tbody>'; body.appendChild(tb);
          return { h, tb, tbody: tb.querySelector('tbody') };
        };
        const all = t.rows.length ? t.rows.map((r) => rowHtml(r, false)) : [`<tr><td colspan="${t.columns.length}">${esc(t.empty || 'لا توجد بيانات في هذه الفترة')}</td></tr>`];
        if (t.totals && t.rows.length) all.push(rowHtml(t.totals, true));
        let cur = startTable(false);
        let started = false;   // هل وُضع صف من هذا الجدول في صفحة سابقة؟
        const hasTot = !!(t.totals && t.rows.length);
        for (let ri = 0; ri < all.length; ri++) {
          const html = all[ri];
          cur.tbody.insertAdjacentHTML('beforeend', html);
          if (fits(body)) continue;
          cur.tbody.lastElementChild.remove();
          // صف المجموع لا ينتقل وحده إلى صفحة جديدة: يرافقه آخر صف قبله
          const carry = [];
          if (hasTot && ri === all.length - 1 && cur.tbody.children.length) carry.push(cur.tbody.lastElementChild.outerHTML), cur.tbody.lastElementChild.remove();
          if (!cur.tbody.children.length) { cur.h.remove(); cur.tb.remove(); } else started = true;
          body = newPage(false);
          cur = startTable(started);
          carry.concat([html]).forEach((h) => cur.tbody.insertAdjacentHTML('beforeend', h));
        }
      }
      if (rep.notes && rep.notes.length) {
        const ul = document.createElement('ul'); ul.className = 'rp-notes';
        ul.innerHTML = rep.notes.map((n) => `<li>${esc(n)}</li>`).join('');
        body.appendChild(ul);
        if (!fits(body)) { ul.remove(); body = newPage(false); body.appendChild(ul); }
      }
      // جدول أعرض من الصفحة (أعمدة كثيرة): يُصغَّر خطه حتى يتسع — التصغير يُقلّل الارتفاع فقط فلا يكسر التقسيم
      // ثم يُوحَّد الخط لكل أجزاء الجدول الواحد عبر الصفحات (أصغر ما احتاجه أي جزء)
      const minFs = {};
      host.querySelectorAll('.rp-table').forEach((tb) => {
        const room = tb.parentElement.clientWidth;
        let fs = parseFloat(getComputedStyle(tb).fontSize) || 11;
        while (tb.scrollWidth > room + 1 && fs > 6.2) { fs -= 0.4; tb.style.fontSize = fs + 'px'; }
        minFs[tb.dataset.t] = Math.min(minFs[tb.dataset.t] ?? fs, fs);
      });
      host.querySelectorAll('.rp-table').forEach((tb) => { tb.style.fontSize = minFs[tb.dataset.t] + 'px'; });
      pages.forEach((pg, i) => { pg.querySelector('.rp-foot').innerHTML = footHtml(i + 1, pages.length); });
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: rep.portrait ? 'portrait' : 'landscape' });
      for (let i = 0; i < pages.length; i++) {
        const canvas = await window.html2canvas(pages[i], { scale: rep.portrait ? 3 : 2, backgroundColor: '#ffffff', logging: false, width: PG.w, height: PG.h });
        if (i) pdf.addPage();
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, rep.portrait ? 210 : 297, rep.portrait ? 297 : 210, undefined, 'FAST');
      }
      const out = pdf.output('blob');
      if (opts.returnBlob) return out;
      downloadBlob(out, fileName);
      return out;
    } catch (e) {
      toast(e.message || 'تعذّر إنشاء ملف PDF', true);
    } finally {
      host.remove();
      if (btn) btn.disabled = false;
    }
  }

  $$('#repRangeChips .chip').forEach((c) => c.addEventListener('click', () => { repRange = c.dataset.rr; repStore.set('range', repRange); renderReports(); }));
  ['repFrom', 'repTo'].forEach((id) => $('#' + id).addEventListener('change', () => { repRange = 'custom'; renderReports(); }));
  $('#repUser').addEventListener('change', renderReports);
  $('#repStatus').addEventListener('change', renderReports);
  $('#btnRepPdf').addEventListener('click', repExportPdf);
  $('#btnRepXlsx').addEventListener('click', repExportXlsx);
  $('#btnRepCsv').addEventListener('click', repExportCsv);

  $$('#biRangeChips .chip').forEach((c) => c.addEventListener('click', () => { biRange = c.dataset.rg; renderBI(); }));
  ['biFrom', 'biTo'].forEach((id) => $('#' + id).addEventListener('change', () => { biRange = 'custom'; renderBI(); }));
  $('#biUser').addEventListener('change', renderBI);
  $$('#biGranChips .chip').forEach((c) => c.addEventListener('click', () => { biGran = c.dataset.gr; renderBI(); }));
  $$('#biTopChips .chip').forEach((c) => c.addEventListener('click', () => { biTopTab = c.dataset.tp; renderBI(); }));
  $('#btnBiCsv').addEventListener('click', biExportCsv);
  $('#btnBiPdf').addEventListener('click', biExportPdf);
  $('#btnBiXlsx').addEventListener('click', biExportXlsx);
  $('#btnMandoubsPdf').addEventListener('click', exportMandoubsPdf);
  $('#btnMandoubsXlsx').addEventListener('click', exportMandoubsXlsx);
  $('#btnExpensesPdf').addEventListener('click', exportExpensesPdf);
  $('#btnExpensesXlsx').addEventListener('click', exportExpensesXlsx);
  $('#btnOrdersPdf').addEventListener('click', exportOrdersPdf);
  $('#btnOrdersXlsx').addEventListener('click', exportOrdersXlsx);
  $('#ordQ').addEventListener('input', renderOrdersReport);
  $('#ordStatus').addEventListener('change', renderOrdersReport);
  $('#biShowAll').addEventListener('click', () => { biRange = 'all'; $('#biUser').value = ''; renderBI(); });
  // أبعاد الرسم تتبع عرض الشاشة: يُعاد الرسم عند عبور حدّ الجوال فقط
  window.addEventListener('resize', () => {
    if (!$('#page-bi').classList.contains('active') || biMobileAt === isMobile()) return;
    renderBI();
  });
  /* ---------------- المزامنة مع الخادم (الوضع السحابي) ---------------- */
  let syncing = false;
  async function syncFromServer() {
    if (!Store.isRemote || syncing || !currentUser || $('#app').hidden) return;
    // نافذة منبثقة مفتوحة (إعدادات، صنف، تكاليف): المزامنة تستبدل كائنات البيانات
    // فتصير المراجع التي التقطتها النافذة يتيمة ويضيع ما يُحفظ. تُؤجَّل حتى تُغلق.
    if (!$('#modal').hidden) return;
    if (!navigator.onLine) { setNetState('off'); return; }
    syncing = true;
    // شريط تحميل رفيع أعلى الصفحة: كانت الجداول تبقى على بياناتها القديمة بلا أي إشارة
    document.body.classList.add('syncing');
    { const pg = $('.page.active'); if (pg) pg.setAttribute('aria-busy', 'true'); }
    setNetState('sync');
    try {
      // تغييرات معلّقة لم تصل الخادم (حفظ فشل أثناء انقطاع): تُرسل قبل الجلب،
      // وإلا استبدلها الجلب بنسخة الخادم وضاعت بصمت
      await Store.save();
      adoptServerNumber();
      const before = cur.id ? db().orders.find((o) => o.id === cur.id) : null;
      const beforeUpdated = before ? before.updatedAt : null;
      const synced = await Store.refresh();
      // الجلب نجح، وما بعده عرض فقط: خطأ في رسم شاشة واحدة كان يُحسب انقطاع
      // مزامنة فيقلب الشارة إلى «تعذّر التحديث» ويُسقط بقية التحديثات معه.
      // لذا تُعلن الحالة هنا، ويُعزل كل رسم عن جاره.
      // refresh() لا يجلب فوق تعديلات معلّقة: الفشل يُبقي المحلي ويُعلَن (لا «محدّث» زائفة)
      setNetState(synced ? 'ok' : (Store.lastStatus === -1 ? 'off' : 'err'));
      const draw = (label, fn) => { try { fn(); } catch (err) { console.error('render failed:', label, err); } };
      const active = ($('.page.active') || {}).id || '';
      if (active === 'page-orders') draw('orders', renderOrders);
      else if (active === 'page-customers') draw('customers', renderCustomers);
      else if (active === 'page-activity') draw('activity', renderActivity);
      else if (active === 'page-items') draw('items', renderItems);
      else if (active === 'page-users') draw('users', renderUsers);
      else if (active === 'page-bi') draw('bi', renderBI);
      else if (active === 'page-reports') draw('reports', renderReports);
      else if (active === 'page-mandoubs') draw('mandoubs', renderMandoubs);
      draw('itemSelects', renderItemSelects);
      draw('permissions', applyPermissions);
      draw('notifications', renderNotifications);
      draw('customerSuggestions', renderCustomerSuggestions);
      draw('currentOrder', () => {
        if (cur.id) {
          const remote = db().orders.find((o) => o.id === cur.id);
          if (!remote) {
            if (!dirty) { toast('تم حذف هذا الطلب من جهاز آخر'); startNewOrder(true); }
          } else if (remote.updatedAt !== beforeUpdated && !dirty) {
            loadOrder(remote, false);
            toast(`تم تحديث الطلب #${remote.number} من جهاز آخر`);
          }
        } else if (active === 'page-order') {
          renderPricing();
        }
      });
    } catch (e) {
      // كان هذا صامتاً تماماً: الموظف يظنّ أنه على أحدث البيانات وهو على لقطة قديمة
      console.warn('sync failed', e);
      setNetState(e && e.offline ? 'off' : 'err');
    } finally {
      syncing = false;
      document.body.classList.remove('syncing');
      const pg = $('.page.active'); if (pg) pg.removeAttribute('aria-busy');
    }
  }
  if (Store.isRemote) {
    setInterval(() => { if (!document.hidden) syncFromServer(); }, 30000);
    setInterval(refreshNetAge, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromServer(); });
    window.addEventListener('online', () => { setNetState('sync'); syncFromServer(); });
    window.addEventListener('offline', () => setNetState('off'));
    $('#netState').hidden = false;
    $('#netState').addEventListener('click', () => {
      // عند الخطأ: يظهر السبب فوراً (على الجوال لا يظهر title)، ثم تُعاد المحاولة
      if ($('#netState').dataset.state === 'err' && Store.lastError) toast('تعذّر التحديث: ' + humanError(Store.lastError) + ' — جارٍ إعادة المحاولة…', true);
      syncFromServer();
    });
    setNetState(navigator.onLine ? 'ok' : 'off');
  }

  /* وضوح أدوات اللمس وتسميات المدخلات، بما فيها المحتوى المنشأ ديناميكياً. */
  function prepareControls(root = document) {
    root.querySelectorAll('button[title]').forEach(b => { if (!b.hasAttribute('aria-label')) b.setAttribute('aria-label', b.title); });
    root.querySelectorAll('input[type="number"]').forEach(el => el.setAttribute('inputmode', 'decimal'));
    root.querySelectorAll('[data-m]').forEach(el => el.setAttribute('aria-label', ({name:'اسم الصنف', qty:'الكمية', unit:'الوحدة'})[el.dataset.k] || 'الصنف'));
  }

  /* عند الدخول إلى خانة أرقام بالنقر أو اللمس: ضع المؤشر بعد آخر رقم (يمينه) بدل بدايته لتسهيل التعديل. */
  const NUM_FIELDS = 'input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"], input[inputmode="tel"], input.num';
  function caretToEnd(el) {
    const v = el.value;
    if (!v) return;
    /* خانات type=number لا تدعم setSelectionRange؛ إعادة كتابة القيمة تنقل المؤشر إلى النهاية. */
    if (el.type === 'number') { el.value = ''; el.value = v; return; }
    try { el.setSelectionRange(v.length, v.length); } catch (_) { /* نوع لا يدعم تحديد النص */ }
  }
  let caretPending = null;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target;
    caretPending = el instanceof HTMLInputElement && !el.readOnly && !el.disabled
      && el.matches(NUM_FIELDS) && document.activeElement !== el ? el : null;
  }, true);
  /* بعد النقرة فقط — النقرات التالية داخل الخانة تبقى حرة لوضع المؤشر حيث يشاء المستخدم. */
  document.addEventListener('click', (e) => {
    const el = caretPending;
    caretPending = null;
    if (el && el === e.target && document.activeElement === el) caretToEnd(el);
  }, true);
  /* المخطط يُحرَّر باللمس مباشرة دائماً بلا زر تبديل: إصبع واحد يحرّك القطع أو
     يمرّر الصفحة من الفراغ، وإصبعان يزيحان ويكبّران المخطط. */
  const CANVAS_HINT = isMobile() || isCoarse
    ? 'اسحب بإصبع واحد لتحريك القطع، أو على الفراغ لتمرير الصفحة • اضغط على جدار لتغيير طوله • إصبعان للتكبير'
    : 'اسحب القطع لتحريكها • اضغط على جدار لتغيير طوله • Ctrl+عجلة الفأرة للتكبير';
  const canvasHintEl = $('#canvasModeHint');
  if (canvasHintEl) canvasHintEl.textContent = CANVAS_HINT;
  const canvasKeysEl = $('#canvasKeys');
  if (canvasKeysEl) canvasKeysEl.textContent = `${CANVAS_HINT}. Tab وShift+Tab للتنقل بين القطع، الأسهم للتحريك، R للتدوير، Delete للحذف، Enter لفتح الخصائص، Esc لإلغاء التحديد.`;
  prepareControls();
  $$('#panelTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('active'))));
  /* ---------------- مسار العمل: مراحل الطلب ----------------
     الطلب يُعرض مرحلة واحدة في كل مرة بدل الأقسام الستة دفعة واحدة. مؤشر المراحل
     يقول ما أُنجز وما ينقص، والملخص الثابت يبقي العميل والحالة والمبالغ والتسليم
     ظاهرة، و«الخطوة التالية» تقترح الإجراء المطلوب الآن. كل ذلك قراءة من الطلب
     نفسه: لا حقل جديد يُحفظ ولا منطق يتغيّر. */
  const STAGES = ['design', 'price', 'customer', 'pay', 'export'];
  const STAGE_LABEL = { design: 'التصميم', price: 'التسعير', customer: 'بيانات العميل', pay: 'الدفع', export: 'التصدير' };
  let curStage = 'design';

  /** إن كان رأس المرحلة فوق حافة الشاشة (بعد تمرير طويل) يُعاد إليه */
  function scrollToStage() {
    const el = $('.stages');
    if (!el) return;
    const top = $('#orderTop');
    const offset = isMobile()
      ? $('#sidebar').offsetHeight + $('#stepNav').offsetHeight + 12
      : (getComputedStyle(top).position === 'sticky' ? top.offsetHeight + 12 : 12);
    const y = el.getBoundingClientRect().top - offset;
    if (y < 0) window.scrollBy({ top: y, behavior: smoothScroll() });
  }

  function showStage(name, opts = {}) {
    if (!STAGES.includes(name)) name = 'design';
    // مغادرة التصميم: يُلغى التحديد حتى لا تبقى ورقة الخصائص أو اختصارات لوحة المفاتيح على عنصر مخفي
    if (curStage === 'design' && name !== 'design') { designer.select(null); }
    const changed = name !== curStage;
    curStage = name;
    $$('.stages > .stage').forEach((s) => {
      const on = s.dataset.stage === name;
      s.hidden = !on;
      s.classList.toggle('active', on);
    });
    const i = STAGES.indexOf(name);
    const prev = STAGES[i - 1], next = STAGES[i + 1];
    $('#stagePrev').hidden = !prev;
    $('#stageNext').hidden = !next;
    if (prev) { $('span', $('#stagePrev')).textContent = `السابق: ${STAGE_LABEL[prev]}`; $('#stagePrev').dataset.go = prev; }
    if (next) { $('span', $('#stageNext')).textContent = `التالي: ${STAGE_LABEL[next]}`; $('#stageNext').dataset.go = next; }
    if (name === 'design') {
      requestAnimationFrame(() => designer.resize());
      // تلميح أول استخدام فقط: الإضافة السريعة لها زر ظاهر، والنقر المزدوج خيار إضافي
      try {
        if (changed && !localStorage.getItem('majlis_hint_dbltap')) {
          localStorage.setItem('majlis_hint_dbltap', '1');
          toast('تلميح: أضف الكنب بزر «أثاث» أو بالنقر المزدوج على الجدار', 'info');
        }
      } catch (_) { /* noop */ }
    }
    renderWorkflow();
    if (changed) {
      scrollToStage();
      if (opts.focus) { const s = $(`.stages > .stage[data-stage="${name}"]`); if (s) { s.tabIndex = -1; s.focus({ preventScroll: true }); } }
    }
  }

  function scheduleWorkflow() {
    if (wfFrame) return;
    wfFrame = requestAnimationFrame(() => { wfFrame = 0; renderWorkflow(); });
  }

  /** تاريخ التسليم بصيغة مقروءة: «الأحد، 5 أكتوبر» (والسنة إن اختلفت) */
  function deliveryLabel(v) {
    const d = new Date(String(v) + 'T00:00:00');
    if (isNaN(d)) return String(v || '');
    try {
      const opts = { weekday: 'long', day: 'numeric', month: 'long' };
      if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
      return d.toLocaleDateString('ar-u-ca-gregory-nu-latn', opts);
    } catch (_) { return String(v); }
  }

  /** حالة كل مرحلة: منجزة، أو ناقصة (مطلوب)، أو جزئية، أو اختيارية — مع سطر يشرحها */
  function stageStates() {
    const pieces = (cur.design && cur.design.pieces) || [];
    const sofas = pieces.filter((p) => p.kind === 'sofa');
    const accs = pieces.length - sofas.length;
    const meters = r2(sofas.reduce((s, p) => s + num(p.w), 0));
    const { lines, total } = computeLines(cur);
    const paid = paidOf(cur);
    const quote = cur.status === 'quote';
    const name = String((cur.customer && cur.customer.name) || '').trim();
    const phoneBad = !!phoneError(cur.customer && cur.customer.phone);
    const closed = designer.geometry().closed;
    const overlaps = designer.overlaps().size;
    const saved = !!(cur.id && cur.number && !dirty);
    const cu = currency();
    const st = {};

    if (!pieces.length) st.design = { cls: 'is-need', sub: 'لم تُضف قطع بعد' };
    else st.design = {
      cls: 'is-done' + ((overlaps || !closed) ? ' is-warn' : ''),
      sub: !closed ? 'الجدران غير مغلقة' : overlaps ? 'تداخل بين القطع'
        : [sofas.length ? `${fmtQty(meters)} م كنب` : '', accs ? `${accs} إكسسوار` : ''].filter(Boolean).join(' • '),
    };

    if (!lines.length) st.price = { cls: '', sub: 'يُحسب من التصميم' };
    else st.price = { cls: total > 0 ? 'is-done' : 'is-warn', sub: total > 0 ? `${fmt(total)} ${cu}` : 'أسعار صفرية' };

    if (!name) st.customer = { cls: 'is-need', sub: 'الاسم مطلوب للحفظ' };
    else st.customer = { cls: 'is-done' + (phoneBad ? ' is-warn' : ''), sub: phoneBad ? 'رقم الجوال غير صحيح' : name };

    if (quote) st.pay = { cls: 'is-optional', sub: 'غير مطلوب لعرض السعر' };
    else if (total <= 0) st.pay = { cls: '', sub: paid > 0 ? `مدفوع ${fmt(paid)}` : 'لا مبلغ بعد' };
    else if (paid - total > 0.004) st.pay = { cls: 'is-done is-warn', sub: 'زائد عن المطلوب' };
    else if (total - paid <= 0.004) st.pay = { cls: 'is-done', sub: 'مدفوع بالكامل' };
    else if (paid > 0.004) st.pay = { cls: 'is-partial', sub: `مدفوع ${Math.round((paid / total) * 100)}٪` };
    else st.pay = { cls: '', sub: 'لا دفعات بعد' };

    st.export = saved ? { cls: 'is-done', sub: 'جاهز للمشاركة' }
      : { cls: '', sub: !cur.id ? 'بعد حفظ الطلب' : dirty ? 'احفظ التعديلات أولاً' : 'بانتظار رقم الطلب' };

    return { st, saved, total, paid, quote, name };
  }

  /** الإجراء التالي المطلوب: أول ما ينقص بالترتيب الطبيعي للعمل */
  function nextStep(w) {
    const { st, saved, total, paid, quote } = w;
    if (readOnly) return { tone: 'lock', text: 'هذا الطلب لموظف آخر ومعروض للاطلاع فقط، ويمكن تصدير مستنداته.', go: 'export', btn: 'التصدير' };
    // داخل التسعير لا تُعاد تعليمات التصميم حرفياً: الرسالة تُصاغ من زاوية المرحلة الحالية
    if (st.design.cls === 'is-need' && curStage === 'price') return { text: 'التسعير يقرأ أصناف المخطط — أضف قطع الكنب أو الإكسسوار في التصميم، أو أضف صنفاً إضافياً من هذه المرحلة.', go: 'design', btn: 'التصميم' };
    if (st.design.cls === 'is-need') return { text: 'ابدأ بمقاسات الغرفة، ثم أضف الكنب والأبواب والشبابيك على المخطط.', go: 'design', btn: 'التصميم' };
    if (st.design.cls.includes('is-warn')) return { text: `راجع المخطط: ${st.design.sub}.`, go: 'design', btn: 'المخطط' };
    if (st.customer.cls === 'is-need') return { text: 'أدخل اسم العميل وجواله — الاسم مطلوب لحفظ الطلب.', go: 'customer', btn: 'بيانات العميل' };
    if (st.customer.cls.includes('is-warn')) return { text: 'رقم جوال العميل غير صحيح — صحّحه قبل الحفظ.', go: 'customer', btn: 'بيانات العميل' };
    if (!saved) {
      if (cur.id && !dirty) return { text: 'الطلب محفوظ على هذا الجهاز بانتظار رقم من الخادم. تحقق من الاتصال ثم أعد الحفظ.', action: 'save', btn: 'إعادة الحفظ' };
      return { text: cur.id ? 'لديك تعديلات لم تُحفظ بعد.' : 'البيانات الأساسية جاهزة — احفظ الطلب ليصبح له رقم.', action: 'save', btn: 'حفظ الطلب' };
    }
    if (!quote && total > 0 && paid <= 0.004) return { text: 'سجّل العربون أو الدفعة الأولى من العميل.', go: 'pay', btn: 'تسجيل دفعة' };
    if (quote) return { text: 'صدّر عرض السعر وأرسله للعميل.', go: 'export', btn: 'التصدير' };
    if (total - paid > 0.004) return { text: `صدّر أمر الشراء وشاركه مع العميل — المتبقي ${fmt(total - paid)} ${currency()}.`, go: 'export', btn: 'التصدير' };
    return { tone: 'done', text: 'الطلب مكتمل البيانات ومدفوع بالكامل. حدّث حالته مع تقدّم التنفيذ حتى التسليم.' };
  }

  function renderWorkflow() {
    if (!currentUser && $('#app').hidden) return;
    const w = stageStates();
    $$('#stepNav a').forEach((a) => {
      const k = a.dataset.stage;
      const s = w.st[k] || { cls: '', sub: '' };
      a.className = [s.cls, k === curStage ? 'is-current' : ''].filter(Boolean).join(' ');
      if (k === curStage) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
      $('.sp-sub', a).textContent = s.sub || '';
      a.title = `${STAGE_LABEL[k]}${s.sub ? ' — ' + s.sub : ''}`;
    });

    // الملخص الثابت: العميل والتسليم (المبالغ يكتبها renderPayment، والحالة شارتها نفسها)
    const sc = $('#sumCustomer');
    sc.textContent = w.name || 'لم يُحدَّد بعد';
    sc.classList.toggle('is-empty', !w.name);
    $('#sumPhone').textContent = (cur.customer && cur.customer.phone) || '';
    const sd = $('#sumDelivery'), sr = $('#sumDeliveryRel');
    if (cur.deliveryDate) {
      sd.textContent = deliveryLabel(cur.deliveryDate);
      sd.classList.remove('is-empty');
      const left = daysUntil(cur.deliveryDate);
      const open = isOpen(cur);
      sr.textContent = left === null || !open ? '' : left < 0 ? `متأخر ${daysWord(-left)}` : left === 0 ? 'اليوم' : left === 1 ? 'غداً' : `بعد ${daysWord(left)}`;
      sr.classList.toggle('late', left !== null && left < 0 && open);
    } else {
      sd.textContent = 'غير محدد'; sd.classList.add('is-empty');
      sr.textContent = ''; sr.classList.remove('late');
    }
    $$('.os-cur').forEach((el) => (el.textContent = `(${currency()})`));

    // الخطوة التالية
    const n = nextStep(w);
    $('#nextAction').dataset.tone = n.tone || '';
    $('#nextActionText').textContent = n.text;
    const btn = $('#nextActionBtn');
    const showBtn = !!n.btn && (!!n.action || n.go !== curStage);
    btn.hidden = !showBtn;
    if (showBtn) {
      $('span', btn).textContent = n.btn;
      btn.dataset.go = n.go || '';
      btn.dataset.action = n.action || '';
      btn.classList.toggle('primary', n.action === 'save');
    }

    // جاهزية التصدير تُقال صراحة قبل الضغط، لا برسالة خطأ بعده
    const es = $('#exportState');
    if (w.saved) {
      es.dataset.state = 'ready';
      es.innerHTML = `${icon('check')}<span>${cur.status === 'quote' ? 'عرض السعر' : 'الطلب'} <b class="num">#${esc(cur.number)}</b> محفوظ وجاهز للتصدير والمشاركة.</span>`;
    } else {
      es.dataset.state = 'pending';
      es.innerHTML = `${icon('alert')}<span>${!cur.id ? 'احفظ الطلب أولاً: لا تُصدر أمر شراء من طلب غير محفوظ.' : dirty ? 'توجد تعديلات غير محفوظة — احفظ الطلب ثم أصدر المستند.' : 'الطلب محفوظ على هذا الجهاز بانتظار رقم من الخادم. تحقق من الاتصال.'}</span>`;
    }
    $('#docInvoiceTitle').textContent = cur.status === 'quote' ? 'عرض السعر — للعميل' : 'أمر شراء — للعميل';
  }

  $('#nextActionBtn').addEventListener('click', () => {
    const b = $('#nextActionBtn');
    if (b.dataset.action === 'save') { $('#btnSaveOrder').click(); return; }
    if (b.dataset.go) showStage(b.dataset.go, { focus: true });
  });
  $('#stagePrev').addEventListener('click', () => showStage($('#stagePrev').dataset.go, { focus: true }));
  $('#stageNext').addEventListener('click', () => showStage($('#stageNext').dataset.go, { focus: true }));
  showStage('design');

  /* ---------------- التشغيل ---------------- */
  window.MajlisApp = { designer, get order() { return cur; }, computeLines, syncFromServer, humanError, sheetFootHtml };
  window.addEventListener('resize', () => { syncMobileSheet(); positionInspector(); });
  renderItemSelects();
  fillOrderForm();
  // انتهاء الجلسة على الخادم (الوضع السحابي): العودة لشاشة الدخول
  Store.onSessionLost = () => {
    if ($('#app').hidden) return;
    currentUser = null;
    closeNotifPanel();
    closeDrawer();
    resetNotifState();
    $('#draftBanner').hidden = true;
    $('#app').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginError').textContent = 'انتهت الجلسة. سجّل الدخول مجدداً.';
  };
  let su = null;
  try { su = await Store.restoreSession(); }
  finally { document.body.classList.remove('booting'); }   // شاشة الإقلاع تُزال بعد معرفة الجلسة، نجحت أو لا
  if (su) enterApp(su);
  else {
    $('#loginUser').focus();
    if (Store.isRemote && Store.lastError) $('#loginError').textContent = humanError(Store.lastError);
  }
})();
