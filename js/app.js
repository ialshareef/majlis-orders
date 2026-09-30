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
  const STATUS = { quote: 'عرض سعر', new: 'جديد', progress: 'قيد التنفيذ', done: 'اكتمال التنفيذ', delivered: 'تم التوصيل', cancelled: 'ملغي' };
  /** عرض السعر ليس بيعاً بعد، والملغي لم يعد بيعاً: كلاهما خارج كل مبلغ مبيعات */
  const isSale = (o) => !!o && o.status !== 'cancelled' && o.status !== 'quote';
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
  const APP_VERSION = '1.0.23';
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
    // لاحقاً فاتورة طلب قديم. زر «طباعة» وحده يُبقيه حتى تنتهي الطباعة.
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

  function applyPermissions() {
    $$('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
    $$('[data-designs]').forEach((el) => (el.hidden = !isStaff()));
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
    requestAnimationFrame(() => designer.resize());
    setTimeout(() => offerDraftRestore(pending), 400);
  }

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
        : (r.error || 'تعذر الدخول');
      return;
    }
    $('#loginPass').value = '';
    // كلمة المرور الأولية: بوابة إجبارية قبل دخول التطبيق — لا يدخل النظام قبل تغييرها
    if (r.mustChangePassword) { forcePasswordChange(r.user, () => enterApp(r.user)); return; }
    enterApp(r.user);
  });

  /* الحساب بكلمة مرور أولية لا يدخل التطبيق قبل تغييرها: خطوة onboarding مؤقتة
     بلا زر تجاوز ولا إغلاق (X/الخارج/Escape)، ولا تُكشف الكلمة الأولية في أي رسالة.
     من غيّر كلمته سابقاً لا يمر من هنا أصلاً (mustChangePassword=false). */
  function forcePasswordChange(pendingUser, onDone) {
    if (!pendingUser) return;
    lockModal(true);
    openModal('إنشاء كلمة مرور جديدة', `
      <p>هذا الحساب ما زال يستخدم كلمة المرور الأولية. اختر كلمة مرور جديدة قبل المتابعة — لن تتمكن من استخدام النظام قبل ذلك.</p>
      <label>كلمة المرور الجديدة <input id="fpNew" type="password" autocomplete="new-password" minlength="6"></label>
      <label>تأكيد كلمة المرور <input id="fpNew2" type="password" autocomplete="new-password"></label>
      <p id="fpErr" class="error" role="alert"></p>
      <div class="btn-row"><button class="btn primary" id="fpOk">${icon('lock')} حفظ والدخول</button></div>`, (b) => {
      $('#fpOk', b).onclick = async () => {
        const p1 = $('#fpNew', b).value, p2 = $('#fpNew2', b).value;
        const err = $('#fpErr', b);
        if (p1.length < 6) { err.textContent = 'كلمة المرور 6 أحرف فأكثر'; return; }
        if (p1 !== p2) { err.textContent = 'كلمتا المرور غير متطابقتين'; return; }
        // المقارنة في الكود فقط: تمنع إعادة استخدام الكلمة الأولية المعروفة دون كشفها في أي رسالة
        if (p1 === 'admin') { err.textContent = 'اختر كلمة مرور مختلفة'; return; }
        const u = Store.getUser(pendingUser.id) || pendingUser;
        try { await Store.saveUser({ id: pendingUser.id, name: u.name, username: u.username, role: u.role, active: true }, p1); }
        catch (e) { err.textContent = e.message || 'تعذر الحفظ'; return; }
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
  const ADMIN_PAGES = ['items', 'users', 'activity', 'bi', 'settings', 'mandoubs'];
  const DESIGN_PAGES = ['designs'];
  function showPage(name) {
    if (ADMIN_PAGES.includes(name) && !isAdmin()) name = 'order';
    if (DESIGN_PAGES.includes(name) && !isStaff()) name = 'order';
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
    $$('#mainNav button[data-page], #bottomNav button[data-page]').forEach((b) => {
      b.classList.toggle('active', b.dataset.page === name);
      if (b.dataset.page === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
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
    if (name === 'settings') renderSettings();
    if (name === 'mandoubs') renderMandoubs();
    if (name === 'designs') renderDesigns();
    if (name === 'about') renderAbout();
    if (['orders', 'customers', 'activity', 'items', 'users', 'bi', 'mandoubs', 'designs'].includes(name)) syncFromServer();
    if (name === 'items') renderItems();
    if (name === 'users') renderUsers();
    if (name === 'order') requestAnimationFrame(() => { designer.resize(); positionInspector(); });
    window.scrollTo({ top: 0 });
  }
  $$('#mainNav button[data-page], #bottomNav button[data-page]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

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

  /* ---------------- المرفقات (صورتان تظهران في الفاتورة) ----------------
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

  /** المرفقات التي تحمل صورة فعلاً — وهي وحدها ما يدخل الفاتورة */
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

  /** الموظف يعدّل طلباته فقط، والمدير يعدّل الجميع */
function canEditOrder(o) {
  if (!o || !o.id) return true;   // طلب جديد لم يُحفظ: الإنشاء للجميع
  if (!o.createdBy) return isAdmin();   // بلا مالك (قديم): المدير فقط، لا يُفتح لأي موظف
  return isAdmin() || o.createdBy === currentUser.id;
}

  /** قفل/فتح كل عناصر تحرير الطلب حسب الملكية */
  const LOCKABLE = [
    '#m-customer input', '#m-customer select', '#m-customer textarea',
    '#orderStatus', '#m-pay input', '#m-pay select', '#btnAddPay', '#btnRefund', '#payQuick button',
    '#m-price input', '#m-price select', '#m-price button',
    '#attList input', '#attList button',
    '.designer-panel input', '.designer-panel select', '.designer-panel button',
    '#tbAddSofa', '#tbAddDoor', '#tbAddWindow', '#tbAddMashab', '#tbAddWall', '#tbAddColumn', '#tbFillAll', '#btnAddManual', '#btnPickMap',
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
  /** وصف المواصفات لسطر الفاتورة */
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
  // عناصر تعديل طول الجدار المباشر (تُعلَّن قبل المصمم لأن onRender يُستدعى أثناء إنشائه)
  const wallInlineBox = $('#wallInlineEdit');
  const wallInlineInp = $('#wallInlineLen');
  let wallInlineFocusTimer = null;   // تأخير التركيز حتى لا تفتح لوحة المفاتيح قبل اللمسة الثانية (الكنب)

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
    onChange() {
      cur.design = designer.getState();
      setDirty(true);
      renderPricing();
      renderWalls();
      syncCornerMode();
      updateOverlapWarn();
      updateUndoButtons();
    },
    onSelect(info) {
      // على الحاسوب تعرض اللوحة الجانبية خصائص القطعة أو الفتحة فور تحديدها، فهي لا تحجب المخطط.
      // أما الجدار فتُعدَّل مقاساته مباشرة فوق تسميته (خانة فوق المخطط) في الحاسوب والجوال معاً.
      // تُفتح اللوحة عند تحديد عنصر جديد فقط: من أغلقها بزر «تم» لا تعود إليه أثناء سحب العنصر نفسه.
      const k = selKey(info);
      if (k && k !== lastSelKey && !isMobile() && !readOnly && (!info || info.type !== 'wall')) { inspOpen = true; inspAuto = true; }
      lastSelKey = k;
      renderInspector(info);
      syncWallSel();
    },
    onRender() { positionInspector(); positionWallInline(); },
    onWallDblClick(i) { addSofaOnWall(i); },
    onRevert(why) {
      toast(why === 'column' ? 'لا يمكن وضع العنصر فوق العامود — أُعيد إلى مكانه' : 'يبقى العنصر داخل حدود الغرفة', true);
    },
  });

  function updateOverlapWarn() { $('#overlapWarn').hidden = designer.overlaps().size === 0; }

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
        <td>${i + 1}</td>
        <td><input type="number" step="0.05" min="0.3" data-i="${i}" data-k="len" value="${Designer.util.round(w.len, 3)}"></td>
        <td><input type="number" step="5" data-i="${i}" data-k="angle" value="${w.angle}"></td>
        <td><button class="icon-btn" data-del="${i}" title="حذف الجدار" ${walls.length <= 3 ? 'disabled' : ''}>${icon('x')}</button></td>
      </tr>`).join('');
    $$('input', tb).forEach((inp) => inp.addEventListener('change', () => {
      const i = +inp.dataset.i;
      if (inp.dataset.k === 'len') designer.setWallLength(i, num(inp.value));
      else designer.setWallAngle(i, num(inp.value));
    }));
    $$('button[data-del]', tb).forEach((b) => b.addEventListener('click', () => designer.removeWall(+b.dataset.del)));
    const g = designer.geometry();
    $('#wallsWarn').textContent = g.closed ? '' : `الجدران لا تُغلق الغرفة (فجوة ${Designer.util.round(g.gap, 2)} م). عدّل الأطوال أو الاتجاهات.`;

    const sel = $('#wallSel');
    const prev = sel.value;
    sel.innerHTML = walls.map((w, i) => `<option value="${i}">جدار ${i + 1} (${Designer.util.round(w.len, 2)} م)</option>`).join('');
    sel.value = selWall >= 0 ? String(selWall) : (prev !== '' && +prev < walls.length ? prev : '0');

    if (walls.length === 4 && walls[0].angle === 0 && walls[1].angle === 90 && walls[2].angle === 180 && walls[3].angle === 270) {
      $('#roomW').value = Designer.util.round(walls[0].len, 3);
      $('#roomH').value = Designer.util.round(walls[1].len, 3);
    }
  }

  function syncWallSel() {
    const i = designer.selectedWallIndex();
    if (i >= 0) $('#wallSel').value = String(i);
    $$('#wallsBody tr').forEach((tr, k) => tr.classList.toggle('sel', k === i));
    $('#canvasHint').textContent = designer.sel ? 'اسحب للتحريك، والمقابض لتغيير المقاس والتدوير' : 'اضغط على جدار أو قطعة لتحديده';
    $('#canvasHint').hidden = false;
    syncEditBtn();
    showWallInline(i);
  }

  /* --- تعديل طول الجدار مباشرة فوق تسميته في المخطط (الجوال) --- */

  function hideWallInline() {
    if (wallInlineFocusTimer) { clearTimeout(wallInlineFocusTimer); wallInlineFocusTimer = null; }
    if (!wallInlineBox.hidden) wallInlineBox.hidden = true;
  }
  function positionWallInline() {
    if (wallInlineBox.hidden) return;
    const pos = designer.wallLabelPos(+wallInlineInp.dataset.i || 0);
    if (!pos) { hideWallInline(); return; }
    wallInlineBox.style.left = pos.x + 'px';
    wallInlineBox.style.top = pos.y + 'px';
  }
  function showWallInline(i) {
    if (i < 0 || readOnly || inspOpen) { hideWallInline(); return; }
    const w = designer.state.walls[i];
    if (!w) { hideWallInline(); return; }
    wallInlineInp.dataset.i = String(i);
    if (document.activeElement !== wallInlineInp) wallInlineInp.value = Designer.util.round(w.len, 3);
    wallInlineBox.hidden = false;
    positionWallInline();
    // يُؤجَّل التركيز قليلاً: اللمسة الثانية (لوضع الكنب) تكتمل قبل أن تفتح لوحة المفاتيح
    wallInlineFocusTimer = setTimeout(() => {
      wallInlineFocusTimer = null;
      if (!wallInlineBox.hidden) { wallInlineInp.focus(); wallInlineInp.select(); }
    }, 400);
  }
  wallInlineInp.addEventListener('change', () => {
    const i = +wallInlineInp.dataset.i;
    if (Number.isFinite(i) && designer.state.walls[i]) designer.setWallLength(i, num(wallInlineInp.value));
  });
  wallInlineInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); wallInlineInp.blur(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      const i = +wallInlineInp.dataset.i;
      if (Number.isFinite(i) && designer.state.walls[i]) wallInlineInp.value = Designer.util.round(designer.state.walls[i].len, 3);
      hideWallInline();
    } else if (e.key === 'Tab') {
      hideWallInline();
    }
  });
  wallInlineInp.addEventListener('blur', () => { hideWallInline(); });

  $('#btnApplyRect').addEventListener('click', () => {
    let w = Math.max(0.5, num($('#roomW').value));
    let h = Math.max(0.5, num($('#roomH').value));
    // الجدار الأطول يُرسم أفقيًا (عرضاً) لتكون الصورة أوضح
    if (h > w) { const t = w; w = h; h = t; }
    designer.setRect(w, h);
    designer.fitView();
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

  $('#btnAddWall').addEventListener('click', addWallWithSize);
  $('#tbAddWall').addEventListener('click', addWallWithSize);
  $('#wallSel').addEventListener('change', () => designer.select({ type: 'wall', index: +$('#wallSel').value }));

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
    $('#accButtons').innerHTML = '<button class="btn" data-free="1"><span class="sw sw-free"></span>مساحة أرضية</button>'
      + (accs.length
        ? accs.map((i) => `<button class="btn" data-acc="${i.id}"><span class="sw" style="background:${esc(i.color || '#888')}"></span>${esc(i.name)}</button>`).join('')
        : '<span class="hint">لا توجد إكسسوارات مسعّرة. أضفها من صفحة الأصناف.</span>');
    $$('#accButtons button[data-acc]').forEach((b) => b.addEventListener('click', () => {
      const it = Store.getItem(b.dataset.acc);
      if (it) addAccessoryWithQty(it);
    }));
    $('#accButtons button[data-free]').addEventListener('click', () => designer.addFreeSpace());
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

  /* --- لوحة الخصائص العائمة (Inspector) --- */
  /** لوحة الخصائص لا تُفتح بمجرّد التحديد، بل بزر «تحرير» أو بنقرة مزدوجة */
  function openInspector() {
    const info = designer.selectionInfo();
    if (!info) return;
    inspOpen = true;
    hideWallInline();
    inspAuto = false;
    inspKey = null;   // فتح صريح: تُرسم اللوحة من جديد ويُنقل التركيز إلى أول حقل
    renderInspector(info);
  }
  function closeInspector() {
    inspOpen = false;
    renderInspector(null);
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
          <label>الطول (م) <input id="inspLen" type="number" step="0.05" min="0.3" value="${Designer.util.round(info.wall.len, 3)}"></label>
          <label>الاتجاه° <input id="inspAng" type="number" step="5" value="${info.wall.angle}"></label>
        </div>
        <div class="insp-actions">
          <button class="btn small primary" data-act="sofa">${icon('sofa')} أثاث</button>
          <button class="btn small" data-act="door">${icon('door')} باب</button>
          <button class="btn small" data-act="window">${icon('window')} شباك</button>
          <button class="btn small" data-act="mashab">${icon('fire')} مشب</button>
          <button class="btn small danger" data-act="delwall" ${nWalls <= 3 ? 'disabled' : ''} title="حذف الجدار">${icon('trash')}</button>
        </div>
        ${readOnly ? '' : `<button type="button" class="btn primary block insp-save" data-save>${icon('save')} حفظ الطلب</button>`}`;
    } else if (info.type === 'opening') {
      const o = info.opening;
      html += `
        <div class="insp-head"><b>${icon(o.type === 'door' ? 'door' : o.type === 'mashab' ? 'fire' : 'window')} ${o.type === 'door' ? 'باب' : o.type === 'mashab' ? 'مشب' : 'شباك'} <small>على جدار ${o.wall + 1}</small></b><button class="btn small" data-close aria-label="إنهاء تعديل القطعة">تم ${icon('check')}</button></div>
        <div class="row2">
          <label>النوع <select id="inspType"><option value="door" ${o.type === 'door' ? 'selected' : ''}>باب</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>شباك</option><option value="mashab" ${o.type === 'mashab' ? 'selected' : ''}>مشب</option></select></label>
          <label>العرض (م) <input id="inspOW" type="number" step="0.05" min="0.3" value="${Designer.util.round(o.w, 2)}"></label>
        </div>
        <label>البُعد من بداية الجدار (م) <input id="inspOT" type="number" step="0.05" min="0" value="${Designer.util.round(o.t - o.w / 2, 2)}"></label>
        <label ${o.type === 'mashab' ? '' : 'hidden'}>العمق داخل الغرفة (م) <input id="inspDepth" type="number" step="0.05" min="0.15" max="1" value="${Designer.util.round(o.depth || 0.5, 2)}"></label>
        <label class="check"><input id="inspBlocks" type="checkbox" ${o.blocks ? 'checked' : ''}> لا يوضع كنب أمامه</label>
        <div class="insp-actions"><button class="btn small danger" data-act="del">${icon('trash')} حذف</button></div>
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
          ${canSize ? '' : `<div class="row2"><label>الصنف <select id="selItem">${opts.join('')}</select></label><label>الكمية <span class="p-qty"><button type="button" class="btn" data-selminus aria-label="إنقاص">−</button><input id="selQty" type="number" min="1" step="1" value="${accCount}" inputmode="numeric"><button type="button" class="btn" data-selplus aria-label="زيادة">+</button></span></label></div>`}
          ${isSofa && legacy ? `<p class="hint">هذه القطعة من طلب قديم مرتبط بصنف «${esc(legacy.name)}». اختر الخشب والقماش والإسفنج لتحويلها.</p>` : ''}
          ${isSofa ? SPECS.map((s) => `<label>${s.label} ${specSelect('sel_' + s.key, s, p[s.field] || '', '')}</label>`).join('') : ''}
        </div>
        <div class="row2">
          <label>الطول (م) <input id="selW" type="number" step="0.05" min="0.2" value="${Designer.util.round(p.w, 2)}" ${canSize ? '' : 'readonly tabindex="-1"'}></label>
          <label>${isSofa ? 'العمق' : 'العرض'} (م) <input id="selH" type="number" step="0.05" min="0.2" value="${Designer.util.round(p.h, 2)}" ${canSize ? '' : 'readonly tabindex="-1"'}></label>
        </div>
        ${isFree ? '<p class="hint">مساحة أرضية تُعلّم فراغاً في المجلس. بلا سعر: لا تدخل جدول التسعير ولا الفاتورة، وتُكتب في أمر التصنيع بمقاسها.</p>' : ''}
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
    if (info.type === 'wall' && !isCoarse && !inspAuto) { const li = $('#inspLen', insp); li.focus(); li.select(); }
  }

  function refreshInspectorValues(info) {
    const active = document.activeElement;
    const setIf = (id, v) => { const el = $('#' + id, insp); if (el && el !== active) el.value = v; };
    if (info.type === 'wall') { setIf('inspLen', Designer.util.round(info.wall.len, 3)); setIf('inspAng', info.wall.angle); }
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
      const len = $('#inspLen', insp), ang = $('#inspAng', insp);
      const applyLen = () => designer.setWallLength(i, num(len.value));
      const applyAng = () => designer.setWallAngle(i, num(ang.value));
      len.addEventListener('change', applyLen); onEnter(len, applyLen);
      ang.addEventListener('change', applyAng); onEnter(ang, applyAng);
      $$('[data-act]', insp).forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'sofa') addSofaOnWall(i);
        else if (a === 'door') designer.addOpening(i, 'door');
        else if (a === 'window') designer.addOpening(i, 'window');
        else if (a === 'mashab') designer.addOpening(i, 'mashab');
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
        designer.updateOpening(id, props);
        renderInspector(designer.selectionInfo());
      };
      ['inspOW', 'inspOT', 'inspBlocks', 'inspDepth'].forEach((k) => { const el = $('#' + k, insp); if (!el) return; el.addEventListener('change', apply); if (el.tagName === 'INPUT' && el.type !== 'checkbox') onEnter(el, apply); });
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
          const want = Math.max(1, Math.min(ACC_MAX, Math.round(num(raw !== undefined ? raw : qtyEl.value)) || 1));
          const placed = designer.setAccessoryCount(it, want);
          qtyEl.value = placed;
          if (placed < want) toast(`المساحة المتاحة لا تكفي لـ ${want} ${it.name}، تم وضع ${placed}. يمكنك تعديل التوزيع يدويًا.`, true);
        };
        qtyEl.addEventListener('change', () => applyQty());
        onEnter(qtyEl, () => applyQty());
        const qm = $('[data-selminus]', insp), qp = $('[data-selplus]', insp);
        if (qm) qm.onclick = () => applyQty(num(qtyEl.value) - 1);
        if (qp) qp.onclick = () => applyQty(num(qtyEl.value) + 1);
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

  /* ---------------- التكاليف والربح (للمدير فقط) ---------------- */
  /** من يرى التكاليف وصافي الربح ويعدّلهما */
  const canSeeCosts = () => isAdmin();

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
  /** النسبة التي تُطبَّق على صاحب الطلب: المندوب يأخذ نسبته، والبائع نسبة البائع */
  function orderOwnerRate(o) {
    if (isMandoub(o)) return mandoubOwnerRateOf(Store.getUser(o.createdBy));
    return sellerRateOf(o);
  }
  /** عمولة صاحب الطلب = نسبته × صافي الربح، أو null إن لم تُدخل التكاليف */
  function orderCommission(o) {
    const p = orderProfit(o);
    return p === null ? null : money(p * orderOwnerRate(o) / 100);
  }
  /** عمولة المندوب الأعلى المباشر من طلب تابعه، أو null */
  function orderParentCommission(o) {
    if (!isMandoub(o) || !mandoubParentOf(o)) return null;
    const u = Store.getUser(o.createdBy);
    const p = orderProfit(o);
    return p === null ? null : money(p * mandoubParentRateOf(u) / 100);
  }
  /** حصة موظفي المحل من الطلب (البائع والمندوب معاً) */
  function orderShareAmount(o) {
    const p = orderProfit(o);
    return p === null ? 0 : money(p * shareRateOf(o) / 100);
  }
  /** لقطة نسب العمولة على الطلب عند اعتماده، حتى لا يؤثر تعديل النسب لاحقاً في الطلبات السابقة */
  function snapshotOrderCommission(o) {
    const owner = Store.getUser(o && o.createdBy);
    const isMan = !!(owner && owner.role === 'mandoub');
    const parent = (isMan && owner.parentId) ? Store.getUser(owner.parentId) : null;
    o.commRates = {
      ownerRate: isMan ? mandoubOwnerRateOf(owner) : sellerRateOf(o),
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
  /** المتبقي = الإجمالي − المدفوع، بلا تقييد بالصفر: السالب دفعة زائدة تُظهرها الشارة والحالة.
      الدفع الزائد مسموح (دفعة مقدمة) ولا يُمنع هنا — التعريف الوحيد المعتمد (F4). */
  const remainingOf = (total, paid) => money(num(total) - num(paid));

  function renderPayment() {
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
          <button type="button" class="icon-btn" data-paydel="${esc(p.id)}" title="حذف الدفعة">${icon('trash')}</button>
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

  /* اختصارات الدفعة: تملأ خانة المبلغ فقط ولا تسجّل شيئاً قبل الضغط على «تسجيل».
     زر «تسجيل المتبقي كاملاً» المنفصل هو وحده من يملأ ويسجّل معاً. */
  $('#payQuick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pay]');
    if (!btn || readOnly) return;
    const total = cur.total || 0;
    const k = btn.dataset.pay;
    const v = k === 'dep' ? money(total * num(settings().depositPct) / 100) : money(total * num(k));
    $('#payAmount').value = v || '';
    $('#payAmount').focus();
  });

  let paying = false;   // منع التسجيل المزدوج من الضغط المتكرر أو Enter مع الزر معاً
  /** تسجيل المتبقي كاملاً بخطوة واحدة: تعبئة المبلغ ثم نفس مسار التسجيل */
  $('#btnPayRem').addEventListener('click', async () => {
    if (readOnly || paying) return;
    const rem = Math.max(0, remainingOf(cur.total || 0, paidOf(cur)));
    if (rem <= 0) { toast('لا يوجد مبلغ متبقٍّ لتسجيله', 'info'); return; }
    $('#payAmount').value = rem;
    await addPayment(false);
  });

  async function addPayment(refund) {
    if (readOnly || paying) return;
    paying = true;
    try {
    const el = $('#payAmount');
    const amt = readAmount(el.value);
    if (amt === null) { setFieldError(el, 'مبلغ غير صالح — أدخل أرقاماً فقط'); el.focus(); return; }
    if (!amt || amt < 0) { setFieldError(el, 'أدخل مبلغاً أكبر من صفر'); el.focus(); return; }
    if (refund && amt > paidOf(cur)) { setFieldError(el, `لا يمكن استرداد أكثر من المدفوع (${fmt(paidOf(cur))})`); el.focus(); return; }
    setFieldError(el, '');
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
    if (!del || readOnly) return;
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
    $('#orderTitle').textContent = cur.number ? `${kind} #${cur.number}` : (cur.id ? `${kind} (بانتظار الرقم)` : (cur.status === 'quote' ? 'عرض سعر جديد' : 'طلب جديد'));
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
    cur.remaining = remainingOf(total, cur.paid);
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
  async function resolveConflict(localCopy) {
    let remote = null;
    // جلب فقط (بلا دفع): الدفع هنا مرفوض أصلاً (409)، وrefresh() الجديد يُجهض الجلب عند فشله
    if (!(await Store.fetchLatest())) {
      toast(humanError(Store.lastError, 'تعذّر جلب نسخة الخادم. تحقق من الاتصال وحاول مجدداً.'), true);
      return;
    }
    remote = db().orders.find((o) => o.id === localCopy.id) || null;
    setNetState('ok');
    const who = (remote && remote.updatedByName) || 'موظف آخر';
    const when = remote && remote.updatedAt ? fmtDateTime(remote.updatedAt) : '';
    const ch = remote ? diffOrder(remote, localCopy) : [];
    openModal('تعارض في التعديل', `
      <p class="conflict-lead">عُدِّل الطلب ${localCopy.number ? '#' + localCopy.number : ''} على الخادم بواسطة <b>${esc(who)}</b>${when ? ' • ' + esc(when) : ''} بعد أن فتحتَه.
      <b>لم يُحفظ تعديلك</b> حتى لا يُمحى عملهم.</p>
      ${ch.length ? `<div class="field-group"><span class="field-label">ما يختلف بين نسختك ونسخة الخادم</span>
        <ul class="conflict-list">${ch.slice(0, 8).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        ${ch.length > 8 ? `<p class="hint">و${ch.length - 8} فرقاً آخر.</p>` : ''}</div>` : '<p class="hint">لا فروق ظاهرة في الحقول الأساسية.</p>'}
      <div class="conflict-actions">
        <button id="cfKeep" class="btn primary block lg">احتفظ بتعديلي واكتب فوق نسخة الخادم</button>
        <button id="cfTake" class="btn block">افتح نسخة الخادم وألغِ تعديلي</button>
      </div>`, () => {
      $('#cfKeep').addEventListener('click', async () => {
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
    el.title = state === 'ok' && lastSyncAt ? `آخر تحديث ${fmtDateTime(new Date(lastSyncAt).toISOString())}` : (labels[state] || '');
  }
  function refreshNetAge() {
    const el = $('#netState');
    if (!el || el.dataset.state !== 'ok' || !lastSyncAt) return;
    const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
    $('#netLabel').textContent = mins < 1 ? 'محدّث' : (mins < 60 ? `قبل ${mins} د` : `قبل ${Math.floor(mins / 60)} س`);
    // تحذير بصري إذا طال انقطاع التحديث دون أن يعلن المتصفح انقطاعاً
    el.dataset.stale = mins >= 5 ? '1' : '';
  }

  /* ---------------- التصدير PDF (فاتورة صفحة واحدة) ---------------- */
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

  /** عنوان المستند حسب حالة الطلب والضريبة */
  function docTitle(order) {
    if (order.status === 'quote') return 'عرض سعر';
    const s = settings();
    return computeLines(order).vatEnabled && String(s.vatNumber || '').trim() ? 'فاتورة ضريبية مبسطة' : 'فاتورة طلب';
  }

  const INV_MARK = '<div class="mark"><svg viewBox="0 0 24 24"><path d="M6 11V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4"/><path d="M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5H3z"/><path d="M5 18v2M19 18v2M3 15h18"/></svg></div>';
  function invHead(title, no) {
    const s = settings();
    return `
      <div class="inv-head">
        <div class="inv-brand">
          ${INV_MARK}
          <div><h1>${esc(s.shopName || 'أصالة نجد')}</h1><small>${esc([s.phone, s.address].filter(Boolean).join(' • ')) || '&nbsp;'}</small>${s.vatNumber ? `<small>الرقم الضريبي: <span class="num">${esc(s.vatNumber)}</span></small>` : ''}</div>
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

  /** فاتورة العميل (أو عرض السعر) */
  function buildPrintDoc(order, qrSrc = '') {
    const img = designImage(order);
    const { lines, total, subtotal, vatEnabled, vatRate, vatAmount, discount } = computeLines(order);
    const paid = paidOf(order);
    const s = settings();
    const cur$ = esc(currency());
    const emp = orderEmployee(order);
    const c = order.customer || {};
    const atts = filledAttachments(order);
    const dense = lines.length > 12;
    const quote = order.status === 'quote';
    const nPays = (order.payments || []).filter((p) => money(p.amount) > 0).length;
    return `
    <div class="inv ${dense ? 'dense' : ''}">
      ${invHead(docTitle(order), order.number ? '#' + order.number : 'مسودة')}
      <div class="inv-info">
        <div><span>العميل</span><b>${esc(c.name) || '—'}</b></div>
        <div><span>الجوال</span><b class="num">${esc(c.phone) || '—'}</b></div>
        <div class="span2"><span>مكان التوصيل</span><b>${esc(c.address) || '—'}</b></div>
        <div><span>${quote ? 'تاريخ العرض' : 'تاريخ الإصدار'}</span><b class="num">${fmtDate(order.createdAt || Store.now())}</b></div>
        ${quote
          ? `<div><span>العرض صالح حتى</span><b class="num">${order.validUntil ? esc(fmtDate(order.validUntil)) : '—'}</b></div>`
          : `<div><span>تاريخ التوصيل المتوقع</span><b class="num">${order.deliveryDate ? esc(fmtDate(order.deliveryDate)) : 'غير محدد'}</b></div>`}
        <div><span>الموظف</span><b>${esc(emp)}</b></div>
        <div><span>مقاس الغرفة (داخلي)</span><b>${roomSummary(order.design)}</b></div>
      </div>
      <div class="inv-visuals">
        <div class="inv-design"><h2>التصميم</h2><div class="imgbox"><img src="${img}" alt="التصميم"></div></div>
        ${atts.length ? `<div class="inv-atts"><h2>المرفقات</h2><div class="att-col">${atts.map((a, i) => `
          <figure><div class="imgbox"><img src="${a.src}" alt="مرفق ${i + 1}"></div><figcaption>${esc(a.name) || `مرفق ${i + 1}`}</figcaption></figure>`).join('')}</div></div>` : ''}
      </div>
      <div class="inv-items">
        <h2>التسعير</h2>
        <table>
          <thead><tr><th class="c-idx">#</th><th>الصنف</th><th class="c-unit">الوحدة</th><th class="c-qty">الكمية</th><th class="c-price">السعر (${cur$})</th><th class="c-total">الإجمالي (${cur$})</th></tr></thead>
          <tbody>${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}${l.sub ? ` <small>— ${esc(l.sub)}</small>` : ''}</td><td>${esc(l.unit)}</td><td class="num">${l.kind === 'sofa' ? fmtQty(l.qty) : esc(l.qty)}</td><td class="num">${fmt(l.price)}</td><td class="num">${fmt(l.total)}</td></tr>`).join('') || '<tr><td colspan="6">لا توجد أصناف</td></tr>'}</tbody>
        </table>
      </div>
      <div class="inv-bottom">
        <div class="inv-notes">${order.notes ? `<b>ملاحظات:</b> ${esc(order.notes).replace(/\n/g, '<br>')}` : ''}${s.invoiceNote ? `${order.notes ? '<br>' : ''}<b>شروط:</b> ${esc(s.invoiceNote)}` : ''}${!order.notes && !s.invoiceNote ? '<b>ملاحظات:</b> —' : ''}</div>
        ${qrSrc ? `<div class="inv-qr"><img src="${qrSrc}" alt="رمز الفاتورة الضريبية"><small>رمز الفاتورة الضريبية</small></div>` : ''}
        <div class="inv-totals">
          <div><span>المجموع قبل الخصم</span><span class="num">${fmt(subtotal)} ${cur$}</span></div>
          ${discount > 0.004 ? `<div><span>الخصم</span><span class="num">- ${fmt(discount)} ${cur$}</span></div>` : ''}
          ${vatEnabled ? `<div><span>ضريبة القيمة المضافة ${num(vatRate)}%</span><span class="num">${fmt(vatAmount)} ${cur$}</span></div>` : ''}
          <div class="total"><span>الإجمالي${vatEnabled ? ' شامل الضريبة' : ''}</span><span class="num">${fmt(total)} ${cur$}</span></div>
          ${quote ? '' : `<div><span>المدفوع${nPays > 1 ? ` (${nPays} دفعات)` : ''}</span><span class="num">${fmt(paid)} ${cur$}</span></div>
          <div class="rem"><span>المتبقي</span><span class="num">${fmt(remainingOf(total, paid))} ${cur$}</span></div>`}
        </div>
      </div>
      <div class="inv-foot">
        <div class="inv-sign"><i></i><span>توقيع العميل</span></div>
        <div>${quote ? 'هذا عرض سعر وليس فاتورة' : `الحالة: ${esc(STATUS[order.status] || order.status)}`} • طريقة القياس: ${order.design.cornerMode === 'deduct' ? 'بدون تكرار الزوايا' : 'بطول الجدار كامل'}</div>
        <div class="inv-sign"><i></i><span>الموظف: ${esc(emp)}</span></div>
      </div>
    </div>`;
  }

  /** أمر التصنيع للورشة: المقاسات والمواصفات والقيود، بلا أي سعر */
  function buildWorkshopDoc(order) {
    const img = designImage(order);
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
    const openings = (d.openings || []).map((o) => `${o.type === 'door' ? 'باب' : o.type === 'mashab' ? 'مشب' : 'شباك'} ${Designer.util.round(o.w, 2)} م على جدار ${o.wall + 1}`).join('، ');
    return `
    <div class="inv work ${sofas.length > 12 ? 'dense' : ''}">
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
      <div class="inv-visuals"><div class="inv-design"><h2>المخطط</h2><div class="imgbox"><img src="${img}" alt="المخطط"></div></div></div>
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

  /* ارتفاع ‎.inv‎ ثابت و overflow مخفي، فطلب بأصناف كثيرة كان تُقصّ أسطره الأخيرة
     بلا إنذار. نضيّق جدول التسعير ثم مربّع التصميم درجة درجة حتى تدخل الصفحة.
     تُعيد true إن بقي شيء لا يتسع بعد أقصى تضييق — فيُنبَّه المستخدم. */
  function fitOnePage(area) {
    const inv = $('.inv', area);
    if (!inv) return false;
    const keep = area.style.cssText;
    // القياس يحتاج عنصراً معروضاً: نعرضه خارج الشاشة لا أمام المستخدم
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff';
    const dense = inv.classList.contains('dense');
    let fs = dense ? 8.5 : 9.5, pad = dense ? 0.8 : 1.4, vis = 40;
    for (let i = 0; i < 24 && inv.scrollHeight > inv.clientHeight + 1; i++) {
      fs = Math.max(5.8, fs - 0.28);
      pad = Math.max(0.2, pad - 0.1);
      if (fs <= 7.6) vis = Math.max(20, vis - 2);   // مربّع التصميم آخر ما يُضغط
      inv.style.setProperty('--row-fs', fs.toFixed(2) + 'pt');
      inv.style.setProperty('--row-pad', pad.toFixed(2) + 'mm');
      inv.style.setProperty('--vis-min', vis + 'mm');
    }
    const overflow = inv.scrollHeight > inv.clientHeight + 1;
    area.style.cssText = keep;
    return overflow;
  }

  /** بناء المستند في منطقة الطباعة وانتظار الصور والخط. تُعيد true إن لم يتسع كاملاً */
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
    return fitOnePage(area);
  }

  /* لا تُصدَّر فاتورة من طلب غير محفوظ: الورقة التي تصل العميل يجب أن تطابق
     ما في النظام — مسودة بلا رقم أو تعديلات لم تصل الخادم تعني فاتورة لا أثر لها. */
  function requireSavedOrder(order) {
    if (!order || !order.id) {
      toast('لا يمكن إصدار الفاتورة قبل حفظ الطلب — اضغط «حفظ الطلب» أولاً', true);
      return false;
    }
    if (cur.id === order.id && dirty) {
      toast('توجد تعديلات غير محفوظة — احفظ الطلب أولاً ثم أصدر الفاتورة', true);
      return false;
    }
    if (!order.number) {
      toast('الطلب محفوظ على هذا الجهاز ولم يصل الخادم بعد، فلا رقم له. تحقق من الاتصال ثم أعد المحاولة.', true);
      return false;
    }
    return true;
  }

  /** المستندات الممكنة لطلب: فاتورة العميل وأمر التصنيع */
  const ORDER_DOCS = {
    invoice: { label: (o) => (o.status === 'quote' ? 'عرض السعر' : 'فاتورة العميل'), file: (o) => `${o.status === 'quote' ? 'عرض-سعر' : 'طلب'}-${o.number}.pdf`, build: async (o) => buildPrintDoc(o, await zatcaQr(o)), share: true },
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

  /** تحويل مستند الصفحة الواحدة إلى ملف PDF حقيقي (صورة عالية الدقة تحفظ العربية كما تُعرض) */
  async function makePdfBlob() {
    await loadScript(H2C_URL);
    await loadScript(JSPDF_URL);
    const area = $('#printArea');
    const inv = $('.inv', area);
    if (!inv) throw new Error('تعذّر تجهيز المستند');
    // إظهار مؤقت خارج الشاشة حتى يتمكّن html2canvas من قياسها
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    try {
      const canvas = await window.html2canvas(inv, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const img = canvas.toDataURL('image/jpeg', 0.94);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      // الصورة تُوضع بنسبة أبعاد المستند نفسه (السند أقصر من الفاتورة)
      const h = Math.min(276, 190 * (canvas.height / canvas.width));
      pdf.addImage(img, 'JPEG', 10, 10, 190, h, undefined, 'FAST');
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
    L.push(order.status === 'quote' ? `عرض سعر رقم *#${order.number}*` : `فاتورة الطلب رقم *#${order.number}*`);
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

  /** نافذة التصدير والمشاركة لأي مستند: فاتورة، أمر تصنيع، سند */
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
        ${Object.entries(ORDER_DOCS).map(([k, d]) => `<button type="button" data-doc="${k}" class="${k === kind ? 'active' : ''}" aria-pressed="${k === kind}">${esc(d.label(order))}</button>`).join('')}
      </div>`}
      <p id="pdfState" class="pdf-state" role="status">${icon('clock')} جاري تجهيز ملف PDF…</p>
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
        ? 'أمر التصنيع للورشة: المقاسات والمواصفات والقيود بلا أي سعر. لا تُرسله للعميل.'
        : `واتساب لا يسمح للمتصفح بإرفاق ملف برقم محدد تلقائياً، لذلك ستظهر قائمة المشاركة لتختار محادثة ${cname || 'العميل'} منها.`);

      btnPrint.onclick = () => { keepPrintArea = true; closeModal(); setTimeout(() => window.print(), 60); };
      if ($('#shChat', b)) $('#shChat', b).onclick = () => openCustomerChat(order, curKind, payment);

      async function prepare() {
        // إنشاء PDF يحتاج مكتبات من الإنترنت: رسالة واضحة مبكراً بدل خطأ تقني لاحق
        if (!navigator.onLine) {
          state.className = 'pdf-state err';
          state.innerHTML = `${icon('alert')} تصدير PDF يحتاج اتصالًا بالإنترنت.`;
          note.textContent = 'تحقق من الاتصال ثم أعد فتح النافذة.';
          return;
        }
        const my = ++run;
        const fileName = isReceipt ? `${money(payment.amount) < 0 ? 'سند-صرف' : 'سند-قبض'}-${order.number}.pdf` : ORDER_DOCS[curKind].file(order);
        btnWa.disabled = btnSave.disabled = btnPrint.disabled = true;
        state.className = 'pdf-state';
        state.innerHTML = `${icon('clock')} جاري تجهيز ملف PDF…`;
        note.textContent = defaultNote();
        // الورشة لا تُرسَل للعميل: يُخفى زرّا واتساب
        const forCustomer = isReceipt || ORDER_DOCS[curKind].share;
        btnWa.hidden = !forCustomer;
        if ($('#shChat', b)) $('#shChat', b).hidden = !forCustomer;
        try {
          const html = isReceipt ? buildReceiptDoc(order, payment) : await ORDER_DOCS[curKind].build(order);
          if (my !== run) return;
          const overflow = await renderPrintArea(html);
          if (my !== run) return;
          btnPrint.disabled = false;
          const blob = await makePdfBlob();
          if (my !== run) return;
          const kb = Math.round(blob.size / 1024);
          const pdfFile = new File([blob], fileName, { type: 'application/pdf' });
          state.className = 'pdf-state ready';
          state.innerHTML = `${icon('check')} الملف جاهز: <b>${esc(fileName)}</b> (${kb} كيلوبايت)`;
          if (overflow) note.innerHTML = `<span class="warn-text">${icon('alert')} المحتوى كثير على صفحة واحدة وقد يُقصّ آخر الجدول. راجع الملف قبل إرساله، أو قسّم الأصناف الإضافية.</span>`;
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
            // 3) متصفح لا يدعم مشاركة الملفات: يُحفظ الملف وتُفتح محادثة العميل لإرفاقه
            downloadBlob(blob, fileName);
            if (phone) openCustomerChat(order, curKind, payment);
            note.innerHTML = `هذا المتصفح لا يدعم إرسال الملف مباشرة. حُفظ <b>${esc(fileName)}</b> في مجلد التنزيلات، أرفقه في محادثة ${esc(cname || 'العميل')}.`;
          };
          btnWa.onclick = sendViaWhatsapp;
          const btnChat = $('#shChat', b);
          if (btnChat) btnChat.onclick = sendViaWhatsapp;
        } catch (err) {
          if (my !== run) return;
          state.className = 'pdf-state err';
          state.innerHTML = `${icon('alert')} ${esc(err.message)}`;
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
    { k: 'cost', label: 'التكلفة', admin: true },
    { k: 'profit', label: 'صافي الربح', admin: true },
    { k: 'comm', label: 'العمولة', admin: true },
    { k: 'paid', label: 'المدفوع' },
    { k: 'deliv', label: 'التوصيل' },
  ];
  let ordHidden = [];
  try { const v = JSON.parse(localStorage.getItem(ORD_COLS_KEY) || '[]'); if (Array.isArray(v)) ordHidden = v; } catch (_) { /* ignore */ }

  function renderOrdCols() {
    $('#ordersTable').setAttribute('data-hide', ordHidden.join(' '));
    const menu = $('#ordColsMenu');
    menu.innerHTML = ORD_COLS.filter((c) => !c.admin || canSeeCosts()).map((c) => {
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
    const filtering = !!(f.q || f.from || f.to || f.statuses.size);
    let list = filteredOrders();
    renderOrdCols();

    $$('#ordStatusChips .chip').forEach((c) => {
      const on = ordStatuses.has(c.dataset.stf);
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
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
      ${canSeeCosts() ? `
      <div class="stat cost"><span>إجمالي التكاليف</span><b class="${costed.length ? '' : 'is-na'}">${costed.length ? fmt(costSum) : '—'}</b><small class="${costed.length ? '' : 'na-note'}">بتكلفة: ${costed.length}${noCost ? ` • بلا تكلفة: ${noCost}` : ''}</small></div>
      <div class="stat profit"><span>إجمالي الربح <small>(قبل الضريبة)</small></span><b class="${costed.length ? (profitSum < 0 ? 'neg' : 'pos') : 'is-na'}">${costed.length ? fmt(profitSum) : '—'}</b><small class="${costed.length ? '' : 'na-note'}">${costed.length ? `هامش ${fmtQty(marginPct)}٪` : 'يُحسب بعد إدخال تكاليف الطلبات'}</small></div>` : ''}`;

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
        <td data-label="رقم الطلب" class="c-no"><b class="num">#${esc(o.number || '—')}</b>${o.status === 'quote' ? ' <span class="badge st-quote">عرض سعر</span>' : ''}<span class="sub"><bdi class="num" title="${esc(fmtDateTime(o.createdAt))}">${fmtDate(o.createdAt)}</bdi>${o.createdByName ? ` • ${esc(o.createdByName)}` : ''}</span></td>
        <td data-label="العميل" class="c-cust"><b title="${esc(o.customer?.name) || ''}">${esc(o.customer?.name) || '—'}</b>${o.customer?.phone ? `<span class="sub num">${esc(o.customer.phone)}</span>` : ''}</td>
        <td data-label="المجموع" class="num c-money c-total">${fmt(o.total)}</td>
        ${canSeeCosts() ? `
        <td data-label="التكلفة" class="num c-money c-cost">${cost === null ? dash : fmt(cost)}</td>
        <td data-label="صافي الربح" class="num c-money c-cost c-profit ${profit === null ? '' : profit < 0 ? 'neg' : 'pos'}">${profit === null ? dash : fmt(profit)}</td>
        <td data-label="العمولة" class="num c-money c-comm">${comm === null ? dash : fmt(comm)}</td>` : ''}
        <td data-label="المدفوع" class="num c-money c-paid">${fmt(o.paid)}</td>
        <td data-label="المتبقي" class="num c-money c-rem ${rem > 0.004 && o.status !== 'quote' ? 'warn-num' : ''}">${fmt(rem)}</td>
        <td data-label="التوصيل" class="c-deliv ${late ? 'late' : ''}"><span class="num">${o.deliveryDate ? esc(fmtDate(o.deliveryDate)) : '—'}</span>${late ? '<span class="late-tag">متأخر</span>' : ''}</td>
        <td data-label="الحالة" class="c-status"><label class="status-chip sm" data-status="${st}"><i class="status-dot"></i><select data-st="${oid}" aria-label="حالة الطلب ${esc(o.number || '')}" ${canEditOrder(o) ? '' : 'disabled title="الطلب لموظف آخر"'}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select><svg class="status-caret"><use href="#i-chevron-down"/></svg></label></td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-open="${oid}">${canEditOrder(o) ? `${icon('pen')} فتح` : `${icon('lock')} عرض`}</button>
          ${rowMenu([
            menuItem(`data-print="${oid}"`, 'file', 'تصدير PDF ومشاركته'),
            canSeeCosts() ? menuItem(`data-cost="${oid}"`, 'wallet', cost === null ? 'إضافة التكاليف' : 'تعديل التكاليف') : '',
            canSeeCosts() ? menuItem(`data-comm="${oid}"`, 'trend', `${isMandoub(o) ? 'نسبة المندوب' : 'نسبة البائع'} ${fmtQty(orderOwnerRate(o))}٪`) : '',
            isAdmin() ? menuItem(`data-owner="${oid}"`, 'swap', 'نقل ملكية الطلب') : '',
            isAdmin() ? '<hr>' + menuItem(`data-delo="${oid}"`, 'trash', 'حذف الطلب', true) : '',
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
    if (!o || !isAdmin()) return;
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

  /** نافذة إدخال تكلفة كل صنف في الطلب مع حساب الربح مباشرة */
  function costForm(o) {
    if (!o || !canSeeCosts()) return;
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
    if (!o || !canSeeCosts()) return;
    const profit = orderProfit(o);
    const cur$ = esc(currency());
    const seller = esc(o.createdByName || 'غير محدد');
    const isMan = isMandoub(o);
    const actor = isMan ? 'المندوب' : 'البائع';
    const ownerRate = orderOwnerRate(o);
    const shareRate = shareRateOf(o);
    const ownerLabel = isMan ? 'نسبة المناديب' : 'نسبة البائع';
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
        const prevShare = shareRateOf(o);
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
  $('#ordClearFilters').addEventListener('click', () => {
    ordStatuses.clear();
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
    tb.innerHTML = db().users.map((u) => `
      <tr class="${u.active === false ? 'is-off' : ''}">
        <td data-label="الاسم"><b>${esc(u.name)}</b>${u.id === currentUser.id ? ' <span class="badge">أنت</span>' : ''}</td>
        <td data-label="اسم المستخدم" class="num">${esc(u.username)}</td>
        <td data-label="الدور">${ROLES[u.role] || u.role}</td>
        <td data-label="الحالة"><span class="badge ${u.active === false ? 'st-quote' : 'st-delivered'}">${u.active === false ? 'موقوف' : 'نشط'}</span></td>
        <td data-label="عدد الطلبات" class="num">${db().orders.filter((o) => o.createdBy === u.id).length}</td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-edit="${u.id}">${icon('pen')} تعديل</button>
          ${u.id !== currentUser.id ? rowMenu([menuItem(`data-del="${u.id}"`, 'trash', 'حذف المستخدم', true)], `إجراءات المستخدم ${esc(u.name)}`) : ''}
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

  function userForm(user) {
    const u = user || { name: '', username: '', role: 'staff', active: true };
    openModal(user ? 'تعديل مستخدم' : 'مستخدم جديد', `
      <label>الاسم الكامل <input id="uName" value="${esc(u.name)}"></label>
      <div class="row2">
        <label>اسم المستخدم <input id="uUser" value="${esc(u.username)}" autocomplete="off" class="ltr"></label>
        <label>${user ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور'} <input id="uPass" type="password" autocomplete="new-password"></label>
      </div>
      <div class="row2">
        <label>الدور <select id="uRole"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>موظف</option><option value="mandoub" ${u.role === 'mandoub' ? 'selected' : ''}>مندوب</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مدير</option></select></label>
        <label>الحالة <select id="uActive"><option value="1" ${u.active !== false ? 'selected' : ''}>نشط</option><option value="0" ${u.active === false ? 'selected' : ''}>موقوف</option></select></label>
      </div>
      <p class="hint">المدير يستطيع إدارة الأصناف والمستخدمين وحذف الطلبات. الموظف يستطيع إنشاء الطلبات وتعديلها واستعراضها. المندوب مثل الموظف لكنه فئة مستقلة تُحسب عمولته بنسبة المناديب لا بنسبة البائع.</p>
      <p id="uErr" class="error"></p>
      <div class="btn-row"><button class="btn" id="uCancel">إلغاء</button><button class="btn primary" id="uSave">حفظ</button></div>`, (b) => {
      $('#uCancel', b).onclick = closeModal;
      $('#uSave', b).onclick = async () => {
        const name = $('#uName', b).value.trim(), username = $('#uUser', b).value.trim(), pass = $('#uPass', b).value;
        const role = $('#uRole', b).value, active = $('#uActive', b).value === '1';
        const err = $('#uErr', b);
        if (!name || !username) { err.textContent = 'الاسم واسم المستخدم مطلوبان'; return; }
        if (!/^[a-zA-Z0-9_.@-]{3,}$/.test(username)) { err.textContent = 'اسم المستخدم: 3 أحرف فأكثر (أحرف إنجليزية وأرقام)'; return; }
        if (db().users.some((x) => x.username.toLowerCase() === username.toLowerCase() && x.id !== u.id)) { err.textContent = 'اسم المستخدم مستخدم من قبل'; return; }
        if (!user && pass.length < 4) { err.textContent = 'كلمة المرور 4 أحرف فأكثر'; return; }
        if (pass && pass.length < 4) { err.textContent = 'كلمة المرور 4 أحرف فأكثر'; return; }
        if (user && user.id === currentUser.id && (role !== 'admin' || !active) && db().users.filter((x) => x.role === 'admin' && x.active !== false && x.id !== user.id).length === 0) {
          err.textContent = 'لا يمكن إزالة صلاحية آخر مدير أو إيقافه'; return;
        }
        try {
          await Store.saveUser({ id: user ? user.id : null, name, username, role, active }, pass);
        } catch (e) { err.textContent = e.message; return; }
        closeModal(); renderUsers();
        if (user && user.id === currentUser.id) { Object.assign(currentUser, { name, username, role }); applyPermissions(); }
        toast('تم حفظ المستخدم');
      };
    }, 'drawer');
  }
  $('#btnAddUser').addEventListener('click', () => userForm(null));

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
    const p = orderProfit(o);
    if (p === null) return null;
    const owner = Store.getUser(o.createdBy);
    const isMan = !!(owner && owner.role === 'mandoub');
    const parent = (isMan && owner && owner.parentId) ? Store.getUser(owner.parentId) : null;
    const r = o.commRates || {
      ownerRate: isMan ? mandoubOwnerRateOf(owner) : sellerRateOf(o),
      parentId: parent ? parent.id : null,
      parentRate: (isMan && parent) ? mandoubParentRateOf(owner) : null,
      shareRate: shareRateOf(o),
    };
    const rows = [];
    rows.push({ who: owner ? owner.name : 'المندوب', rate: r.ownerRate, amount: money(p * r.ownerRate / 100), userId: o.createdBy });
    if (r.parentId) {
      const par = Store.getUser(r.parentId);
      rows.push({ who: par ? par.name : 'المندوب الأعلى', rate: r.parentRate || 0, amount: money(p * (r.parentRate || 0) / 100), userId: r.parentId });
    }
    rows.push({ who: 'موظفو المحل', rate: r.shareRate, amount: money(p * r.shareRate / 100), userId: null });
    return { profit: p, rows };
  }

  function renderMandoubs() {
    if (!isAdmin()) return;
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
    const manOrders = db().orders.filter((o) => isMandoub(o) && orderProfit(o) !== null).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const logTb = $('#mandoubLogTable tbody');
    const logRows = [];
    manOrders.slice(0, 200).forEach((o) => {
      const bd = orderCommBreakdown(o);
      bd.rows.forEach((r) => logRows.push({ order: o, ...r }));
    });
    logTb.innerHTML = logRows.length ? logRows.map((r) => `
      <tr>
        <td data-label="الطلب" class="num">#${esc(r.order.number || '—')}</td>
        <td data-label="صافي الربح" class="num">${fmt(r.profit)}</td>
        <td data-label="المستفيد">${esc(r.who)}</td>
        <td data-label="النسبة" class="num">${fmtQty(r.rate)}٪</td>
        <td data-label="المبلغ" class="num">${fmt(r.amount)}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">لا توجد عمولات محسوبة بعد (تحتاج طلبات مناديب بتكاليف مسجّلة).</td></tr>';
    $('#mandoubLogNote').textContent = manOrders.length ? `يعرض آخر 200 سطر من عمولات ${manOrders.length} طلب مناديب. النسب مأخوذة من لقطة كل طلب عند اعتماده.` : '';
  }

  function mandoubForm(m) {
    if (!m || !isAdmin()) return;
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
    if (!isAdmin()) return;
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

  async function fetchDesigns() {
    const r = await Store.api('GET', '/api/designs');
    designsCache = Array.isArray(r.designs) ? r.designs : [];
    return designsCache;
  }

  function desMatches(d) {
    if (desFilter.status && d.status !== desFilter.status) return false;
    const q = desFilter.q.trim();
    if (!q) return true;
    return (d.number || '').includes(q) || (d.name || '').includes(q) || (d.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, ''));
  }

  async function renderDesigns() {
    if (!isStaff()) return;
    if (!desBound) {
      desBound = true;
      $('#desSearch').addEventListener('input', () => renderDesigns());
      $$('#desStatusChips .chip').forEach((c) => c.addEventListener('click', () => {
        $$('#desStatusChips .chip').forEach((x) => { const on = x === c; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        desFilter.status = c.dataset.dstf || '';
        renderDesigns();
      }));
    }
    desFilter.q = $('#desSearch').value || '';
    try { await fetchDesigns(); } catch (e) { toast('تعذّر جلب التصاميم: ' + humanError(Store.lastError), true); return; }
    const fresh = designsCache.filter((d) => d.status === 'new').length;
    const badge = $('#desBadge');
    if (badge) badge.hidden = !fresh;
    if (badge) badge.textContent = fresh > 99 ? '99+' : String(fresh);
    const list = designsCache.filter(desMatches);
    const tb = $('#desTable tbody');
    tb.innerHTML = list.map((d) => {
      const oid = esc(d.id);
      return `<tr>
        <td data-label="التصميم" class="c-no"><b class="num" dir="ltr">${esc(d.number)}</b><span class="sub"><bdi class="num">${esc(fmtDate(d.createdAt))}</bdi></span></td>
        <td data-label="الحالة" class="c-status"><span class="badge">${esc(DESIGN_STATUS[d.status] || d.status)}</span></td>
        <td data-label="العميل" class="c-cust"><b>${esc(d.name || '—')}</b>${d.phone ? `<span class="sub num">${esc(d.phone)}</span>` : ''}</td>
        <td data-label="التواصل">${d.contactRequested ? '<span class="badge st-delivered">طلب التواصل</span>' : '<span class="hint">—</span>'}</td>
        <td data-label="الطلب" class="num">${d.orderNumber ? '#' + esc(d.orderNumber) : '<span class="hint">—</span>'}</td>
        <td data-label="آخر تحديث"><bdi class="num">${esc(fmtDate(d.updatedAt))}</bdi></td>
        <td class="row-actions"><span class="ra">
          <button class="btn small" data-desopen="${oid}">${icon('pen')} فتح ومراجعة</button>
          ${d.orderId ? '' : rowMenu([menuItem(`data-desconv="${oid}"`, 'swap', 'تحويل إلى طلب')], `تحويل ${esc(d.number)}`)}
        </span></td>
      </tr>`;
    }).join('');
    const portalUrl = window.location.origin + '/customer-design';
    $('#desPortalUrl').textContent = portalUrl;
    $('#desEmpty').hidden = list.length > 0;
    $$('[data-desopen]', tb).forEach((b) => b.addEventListener('click', () => openDesign(b.dataset.desopen)));
    $$('[data-desconv]', tb).forEach((b) => b.addEventListener('click', () => convertDesignFlow(b.dataset.desconv)));
    prepareControls(tb);
  }

  /** ملخص هندسي للعرض (أسماء فقط، بلا أسعار) */
  function desFacts(design) {
    const d = design || { walls: [], openings: [], pieces: [] };
    const walls = (d.walls || []).map((w) => w.len + 'م').join(' × ');
    let doors = 0, wins = 0, meters = 0;
    const accs = {};
    (d.openings || []).forEach((o) => { if (o.type === 'door') doors++; else if (o.type === 'window') wins++; });
    (d.pieces || []).forEach((p) => {
      if (p.kind === 'sofa') meters += num(p.w);
      else if (p.kind === 'acc') { const n = (getItem(p.itemId) || {}).name || 'إكسسوار'; accs[n] = (accs[n] || 0) + 1; }
    });
    return { walls: walls || '—', doors, wins, meters: Math.round(meters * 100) / 100, accs };
  }

  async function openDesign(id) {
    let d;
    try {
      const r = await Store.api('GET', '/api/designs/' + encodeURIComponent(id));
      d = r.design;
    } catch (e) { toast('تعذّر فتح التصميم: ' + humanError(Store.lastError), true); return; }
    if (!d) return;
    const f = desFacts(d.design);
    openModal(`تصميم ${d.number || ''}`, `
      <div class="des-view">
        <div class="des-canvasbar">
          <button type="button" class="btn small" id="dvUndo">تراجع</button>
          <button type="button" class="btn small" id="dvFit">ملاءمة</button>
          <button type="button" class="btn small danger" id="dvDel">حذف المحدد</button>
          <button type="button" class="btn small primary" id="dvSaveGeo">حفظ التعديل</button>
        </div>
        <div class="canvas-wrap des-canvas"><canvas id="dvCanvas"></canvas></div>
        <dl class="p-facts">
          <div><dt>الحالة</dt><dd><select id="dvStatus" aria-label="حالة التصميم">${Object.entries(DESIGN_STATUS).map(([k, v]) => `<option value="${k}"${d.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></dd></div>
          <div><dt>العميل</dt><dd>${esc(d.name || '—')}${d.phone ? ` <span class="num">${esc(d.phone)}</span>` : ''}${d.contactRequested ? ' <span class="badge st-delivered">طلب التواصل</span>' : ''}</dd></div>
          <div><dt>الغرفة</dt><dd>${esc(f.walls)}</dd></div>
          <div><dt>أبواب/شبابيك</dt><dd>${f.doors} / ${f.wins}</dd></div>
          <div><dt>أمتار الكنب</dt><dd>${f.meters} م</dd></div>
          <div><dt>الطلب المرتبط</dt><dd>${d.orderNumber ? '#' + esc(d.orderNumber) : '—'}</dd></div>
        </dl>
        <div class="btn-row">
          ${d.phone ? `<button type="button" class="btn" id="dvWa">${icon('whatsapp')} واتساب</button><button type="button" class="btn" id="dvCall">${icon('phone')} اتصال</button>` : ''}
          <button type="button" class="btn" id="dvPdf">${icon('file')} PDF التصميم</button>
          ${d.orderId ? '' : `<button type="button" class="btn primary" id="dvConvert">تحويل إلى طلب</button>`}
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
        } catch (e) { $('#dvErr', b).textContent = humanError(Store.lastError); }
      };
      $('#dvStatus', b).onchange = async (e) => {
        try {
          await Store.api('PUT', '/api/designs/' + encodeURIComponent(id), { status: e.target.value });
          toast('حُدّثت الحالة');
          renderDesigns();
        } catch (err) { $('#dvErr', b).textContent = humanError(Store.lastError); e.target.value = d.status; }
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

  /** ورقة PDF للتصميم من جهة الموظف (هندسة فقط، بلا مالية) */
  async function makeDesignSheetBlob(d) {
    if (!navigator.onLine) throw new Error('تصدير PDF يحتاج اتصالًا بالإنترنت.');
    try { await loadScript(H2C_URL); await loadScript(JSPDF_URL); }
    catch (_) { throw new Error('تعذّر تحميل مكتبة PDF. تحقق من الاتصال.'); }
    const f = desFacts(d.design);
    const off = new Designer(document.createElement('canvas'), { getItem, pieceSpecLabel: () => '', pieceStyle: (typeof pieceStyle === 'function' ? pieceStyle : undefined) });
    off.setState(JSON.parse(JSON.stringify(d.design || {})));
    const W = 1600, H = Math.max(500, Math.round(W / off.aspect()));
    const img = off.toImage(W, H);
    const el = document.createElement('div');
    el.className = 'inv';
    el.innerHTML = ''
      + '<div class="inv-head"><div class="inv-brand"><span class="mark"></span><div><h1>' + esc(settings().shopName || 'أصالة نجد') + '</h1><small>ورقة تصميم عميل</small></div></div>'
      + '<div class="inv-title-box"><div class="inv-title">تصميم</div><div class="inv-no">' + esc(d.number || '') + '</div></div></div>'
      + '<div class="inv-info"><div><span>التصميم</span><b class="num">' + esc(d.number || '') + '</b></div>'
      + '<div><span>العميل</span><b>' + esc(d.name || '—') + '</b></div>'
      + '<div><span>الجوال</span><b class="num">' + esc(d.phone || '—') + '</b></div>'
      + '<div><span>الحالة</span><b>' + esc(DESIGN_STATUS[d.status] || '') + '</b></div></div>'
      + '<div class="inv-visuals"><div class="inv-design"><div class="imgbox"><img src="' + img + '" alt="مخطط"></div></div></div>'
      + '<div class="inv-items"><table><thead><tr><th>البند</th><th>التفاصيل</th></tr></thead><tbody>'
      + '<tr><td>الغرفة</td><td>' + esc(f.walls) + '</td></tr>'
      + '<tr><td>الأبواب/الشبابيك</td><td>' + f.doors + ' / ' + f.wins + '</td></tr>'
      + '<tr><td>أمتار الكنب</td><td>' + f.meters + ' م</td></tr>'
      + '</tbody></table></div>';
    const area = $('#printArea');
    area.innerHTML = '';
    area.appendChild(el);
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    try {
      const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const im = canvas.toDataURL('image/jpeg', 0.94);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const h = Math.min(276, 190 * (canvas.height / canvas.width));
      pdf.addImage(im, 'JPEG', 10, 10, 190, h, undefined, 'FAST');
      return pdf.output('blob');
    } finally {
      area.style.cssText = '';
      area.innerHTML = '';
    }
  }

  async function convertDesignFlow(id) {
    const d = designsCache.find((x) => x.id === id);
    if (d && d.orderId) { toast(`محوَّل مسبقاً للطلب #${d.orderNumber}`); return; }
    if (!(await confirmDlg('تحويل إلى طلب', `إنشاء طلب جديد من التصميم ${d ? d.number : ''}؟ يبقى التصميم الأصلي محفوظاً.`))) return;
    let r;
    try {
      r = await Store.api('POST', '/api/designs/' + encodeURIComponent(id) + '/convert');
    } catch (e) { toast('تعذّر التحويل: ' + humanError(Store.lastError), true); return; }
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

  /* روابط الوصول الرسمية الثابتة (من إعداد النشر: Worker majlis-api + مستودع ialshareef/majlis-orders).
     ثابتة عمداً: لا تتغير بين المحلي والتجريبي والإنتاج، ولا تُبنى من location.origin. */
  const ACCESS_LINKS = {
    customer: 'https://majlis-api.asalh-najd.workers.dev/customer-design',
    staff: 'https://majlis-api.asalh-najd.workers.dev/',
  };

  /** روابط العميل والموظفين: فتح/نسخ/مشاركة (Web Share API مع بديل النسخ) */
  let linksWired = false;
  function wireAccessLinks() {
    const box = $('#linksBox');
    if (!box || linksWired) return;
    const urls = { customerLink: ACCESS_LINKS.customer, staffLink: ACCESS_LINKS.staff };
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
    const bind = (btn, fn) => { const b = document.getElementById(btn); if (b) b.onclick = fn; };
    bind('btnOpenCustomer', () => open('customerLink'));
    bind('btnCopyCustomer', () => copy('customerLink'));
    bind('btnShareCustomer', () => share('customerLink', 'واجهة العميل — مصمم المجالس'));
    bind('btnOpenStaff', () => open('staffLink'));
    bind('btnCopyStaff', () => copy('staffLink'));
    bind('btnShareStaff', () => share('staffLink', 'واجهة الموظفين والمناديب'));
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
    el.textContent = `آخر تحديث: ${who} • ${fmtDateTime(cur.updatedAt || cur.createdAt)} • أُنشئ بواسطة ${cur.createdByName || '—'}`;
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
      <div class="stat"><span>آخر تحديث</span><b class="stat-text">${last ? esc(last.userName || '—') : '—'}</b>${last ? `<small>${fmtDateTime(last.at)}</small>` : ''}</div>`;

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
    if (!isAdmin()) return;
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
    if (!isAdmin()) return;
    const s = settings();
    const b = $('#settingsBody');
    b.innerHTML = `
      <section class="set-section">
        <div class="set-head"><h3>بيانات المحل</h3><p>تظهر في رأس الفاتورة وأمر التصنيع والسندات.</p></div>
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
            <label>واتساب المحل <input id="sWa" dir="ltr" value="${esc(s.whatsapp || '')}" placeholder=https://wa.me/9665… أو الرقم فقط"></label>
            <label>Instagram <input id="sIg" dir="ltr" value="${esc(s.instagram || '')}" placeholder="https://instagram.com/…"></label>
          </div>
          <div class="row2">
            <label>TikTok <input id="sTik" dir="ltr" value="${esc(s.tiktok || '')}" placeholder="https://tiktok.com/…"></label>
            <label>Snapchat <input id="sSnap" dir="ltr" value="${esc(s.snapchat || '')}" placeholder="https://snapchat.com/…"></label>
          </div>
          <p class="hint">رابط البوابة للعملاء: <bdi class="num">${esc(window.location.origin + '/customer-design')}</bdi></p>
        </div>
      </section>
      <section class="set-section">
        <div class="set-head"><h3>الفاتورة والضريبة</h3><p>حين تُفعَّل الضريبة ويُسجَّل الرقم الضريبي تصير الفاتورة «فاتورة ضريبية مبسطة» برمز QR.</p></div>
        <div class="set-body">
          <label>شروط تظهر في الفاتورة (اختياري) <input id="sInvNote" value="${esc(s.invoiceNote || '')}" placeholder="مثال: العربون غير مسترد، مدة التنفيذ 10 أيام"></label>
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
            <label>العربون المطلوب قبل التنفيذ % <input id="sDeposit" type="number" min="0" max="100" step="5" value="${num(s.depositPct ?? 25)}"><small class="hint">يُطلب تأكيد عند بدء تنفيذ طلب مدفوعه أقل. 0 = بلا تنبيه.</small></label>
            <label>صلاحية عرض السعر (أيام) <input id="sQuoteDays" type="number" min="1" max="90" step="1" value="${num(s.quoteDays) || 7}"></label>
          </div>
          <div class="row2">
            <label>نسبة عمولة البائع % <input id="sSellerRate" type="number" min="0" max="100" step="0.5" value="${num(s.sellerRate ?? 10)}"><small class="hint">تُطبَّق افتراضياً على طلبات البائع، ويمكن تغييرها لكل طلب من زر «نسبة البائع».</small></label>
            <label>نسبة عمولة المناديب % <input id="sMandoubRate" type="number" min="0" max="100" step="0.5" value="${num(s.mandoubRate ?? 5)}"><small class="hint">نسبة مستقلة للمناديب (خارج الشركة)، لا تُشارك مع الفريق الداخلي.</small></label>
          </div>
          <div class="row2">
            <label>نسبة المشاركة (باقي البائعين والإدارة) % <input id="sShareRate" type="number" min="0" max="100" step="0.5" value="${num(s.shareRate ?? 5)}"><small class="hint">تُخصم من مبيعات البائع وتُوزَّع بالتساوي على الفريق الداخلي آخر الشهر.</small></label>
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
            <span>آخر نسخة احتياطية ${s.lastBackupAt ? `<b>${esc(fmtDateTime(s.lastBackupAt))}</b>` : '<b class="warn-text">لم تُصدَّر بعد</b>'}</span>
          </div>
        </div>
      </section>
      <section class="set-section">
        <div class="set-head"><h3>المظهر</h3><p>يُحفظ لهذا الجهاز فقط. الفاتورة وملف PDF يبقيان بخلفية بيضاء دائماً.</p></div>
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
  const NOTIF_ICON = { create: 'plus', progress: 'rotate', done: 'check', delivered: 'pin', due: 'calendar', quote: 'file', backup: 'download' };
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
    return fmtDateTime(iso);
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
    if (isAdmin()) {
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
    const live = list.filter(isSale);
    const costed = live.filter((o) => orderCost(o) !== null);
    const sum = (arr, f) => money(arr.reduce((s, o) => s + num(f(o)), 0));
    const revenue = sum(live, orderRevenue);
    const profit = sum(costed, orderProfit);
    const costedRevenue = sum(costed, orderRevenue);
    return {
      list, live, costed,
      count: live.length,
      cancelled: list.filter((o) => o.status === 'cancelled').length,
      quotes: list.filter((o) => o.status === 'quote').length,
      revenue,
      gross: sum(live, (o) => o.total),
      paid: sum(live, (o) => o.paid),
      remaining: sum(live, (o) => remainingOf(o.total, o.paid)),
      cost: sum(costed, orderCost),
      profit, costedRevenue,
      commission: sum(costed, orderCommission),
      share: sum(costed, orderShareAmount),
      margin: costedRevenue > 0 ? r2((profit / costedRevenue) * 100) : 0,
      avg: live.length ? money(revenue / live.length) : 0,
      meters: r2(live.reduce((s, o) => s + biMeters(o), 0)),
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
    a.costed.forEach((o) => { sharePool += orderShareAmount(o); });
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
  function renderBI() {
    if (!isAdmin()) return;
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
      <div class="stat"><span>عدد الطلبات</span><b>${a.count}</b>${biDeltaTag(a.count, pv && pv.count)}</div>`;

    $('#biKpisSub').innerHTML = `
      <div class="stat profit"><span>صافي الربح</span><b class="${a.costed.length ? (a.profit < 0 ? 'neg' : 'pos') : 'is-na'}">${a.costed.length ? fmt(a.profit) : '—'}</b><small class="${a.costed.length ? '' : 'na-note'}">${a.costed.length ? `هامش ${fmtQty(a.margin)}٪` : 'يُحسب بعد إدخال تكاليف الطلبات'}</small></div>
      <div class="stat"><span>إجمالي العمولات</span><b class="${a.costed.length ? 'pos' : 'is-na'}">${a.costed.length ? fmt(money(a.commission + a.share)) : '—'}</b><small>${a.costed.length ? `عمولات ${fmt(a.commission)} + مشاركة ${fmt(a.share)}` : ''}</small></div>
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
    push('إجمالي العمولات', a.costed.length ? money(a.commission + a.share) : '');
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

  $$('#biRangeChips .chip').forEach((c) => c.addEventListener('click', () => { biRange = c.dataset.rg; renderBI(); }));
  ['biFrom', 'biTo'].forEach((id) => $('#' + id).addEventListener('change', () => { biRange = 'custom'; renderBI(); }));
  $('#biUser').addEventListener('change', renderBI);
  $$('#biGranChips .chip').forEach((c) => c.addEventListener('click', () => { biGran = c.dataset.gr; renderBI(); }));
  $$('#biTopChips .chip').forEach((c) => c.addEventListener('click', () => { biTopTab = c.dataset.tp; renderBI(); }));
  $('#btnBiCsv').addEventListener('click', biExportCsv);
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
    $('#netState').addEventListener('click', () => syncFromServer());
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
    if (total - paid > 0.004) return { text: `صدّر الفاتورة وشاركها مع العميل — المتبقي ${fmt(total - paid)} ${currency()}.`, go: 'export', btn: 'التصدير' };
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
      es.innerHTML = `${icon('alert')}<span>${!cur.id ? 'احفظ الطلب أولاً: لا تُصدر فاتورة من طلب غير محفوظ.' : dirty ? 'توجد تعديلات غير محفوظة — احفظ الطلب ثم أصدر المستند.' : 'الطلب محفوظ على هذا الجهاز بانتظار رقم من الخادم. تحقق من الاتصال.'}</span>`;
    }
    $('#docInvoiceTitle').textContent = cur.status === 'quote' ? 'عرض السعر' : 'فاتورة العميل';
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
  window.MajlisApp = { designer, get order() { return cur; }, computeLines, syncFromServer, humanError };
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
