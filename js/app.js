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
  /** كل مبلغ في النظام عدد صحيح بلا كسور: تقريب للأقرب (12.49 ← 12 و12.50 ← 13) */
  const money = (v) => Math.round(num(v));
  const fmt = (v) => money(v).toLocaleString('en-US');
  /** الكميات بالمتر والنسب المئوية تبقى بكسرين */
  const fmtQty = (v) => r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const STATUS = { new: 'جديد', progress: 'قيد التنفيذ', done: 'اكتمال التنفيذ', delivered: 'تم التوصيل', cancelled: 'ملغي' };

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
  const ROLES = { admin: 'مدير', staff: 'موظف' };
  const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
  const currency = () => Store.db.settings.currency || 'ر.س';
  const isMobile = () => window.matchMedia('(max-width: 960px)').matches;
  const isCoarse = window.matchMedia('(pointer: coarse)').matches;

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  let modalReturnFocus = null;
  /** cls: صنف إضافي على النافذة (مثل wide للجداول العريضة)، يُزال عند الإغلاق */
  function openModal(title, bodyHtml, onMount, cls = '') {
    modalReturnFocus = document.activeElement;
    document.body.classList.add('modal-open');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modal').className = 'modal' + (cls ? ' ' + cls : '');
    $('#modal').hidden = false;
    if (onMount) onMount($('#modalBody'));
    requestAnimationFrame(() => $('#modalClose').focus({preventScroll:true}));
  }
  function closeModal() {
    $('#modal').hidden = true; $('#modal').className = 'modal'; $('#modalBody').innerHTML = '';
    document.body.classList.remove('modal-open');
    if (modalReturnFocus && modalReturnFocus.isConnected) modalReturnFocus.focus({preventScroll:true});
  }
  $('#modal').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); const cancel = $('#cNo'); if (cancel) cancel.click(); else closeModal(); }
    if (e.key !== 'Tab') return;
    const controls = [...$('#modal').querySelectorAll('button,input,select,textarea,a[href]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

  function confirmDlg(title, msg) {
    return new Promise((res) => {
      openModal(title, `<p>${esc(msg)}</p><div class="btn-row"><button class="btn" id="cNo">إلغاء</button><button class="btn danger" id="cYes">تأكيد</button></div>`, (b) => {
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

  function applyPermissions() {
    $$('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
    $('#currentUserName').textContent = `${currentUser.name} • ${ROLES[currentUser.role] || currentUser.role}`;
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
    const pending = readDraft();   // يُقرأ قبل أن يمسحه الطلب الجديد
    startNewOrder(true);
    resetNotifState();
    renderNotifications();
    showPage('order');
    requestAnimationFrame(() => designer.resize());
    setTimeout(() => offerDraftRestore(pending), 400);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const un = $('#loginUser').value.trim();
    const pw = $('#loginPass').value;
    const btn = $('#loginForm button[type=submit]');
    btn.disabled = true; $('#loginError').textContent = '';
    let r;
    try { r = await Store.login(un, pw); }
    catch (e) { r = { ok: false, error: e.message }; }
    btn.disabled = false;
    if (!r.ok) {
      $('#loginError').textContent = r.error === 'bad_credentials' ? 'اسم المستخدم أو كلمة المرور غير صحيحة' : r.error === 'inactive' ? 'هذا الحساب موقوف' : (r.error || 'تعذر الدخول');
      return;
    }
    $('#loginPass').value = '';
    enterApp(r.user);
  });

  $('#btnLogout').addEventListener('click', async () => {
    if (dirty && !(await confirmDlg('خروج', 'لديك تغييرات غير محفوظة في الطلب الحالي. هل تريد الخروج؟'))) return;
    await Store.logout();
    currentUser = null;
    cur = newOrder(); setDirty(false);
    closeNotifPanel();
    resetNotifState();
    $('#app').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginUser').focus();
  });

  /* ---------------- التنقل ---------------- */
  function showPage(name) {
    if ((name === 'items' || name === 'users' || name === 'activity') && !isAdmin()) name = 'order';
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
    $$('#mainNav button, #bottomNav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.page === name);
      if (b.dataset.page === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (name !== 'order') designer.select(null);
    if (name === 'orders') renderOrders();
    if (name === 'activity') renderActivity();
    if (['orders', 'activity', 'items', 'users'].includes(name)) syncFromServer();
    if (name === 'items') renderItems();
    if (name === 'users') renderUsers();
    if (name === 'order') requestAnimationFrame(() => { designer.resize(); positionInspector(); });
    window.scrollTo({ top: 0 });
    requestAnimationFrame(trackStep);
  }
  $$('#mainNav button, #bottomNav button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
  $$('#stepNav a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    designer.select(null);
    setCanvasEditing(false);
    const el = $(a.getAttribute('href'));
    if (el) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
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
  let readOnly = false;   // الطلب مملوك لموظف آخر: عرض فقط

  /** الموظف يعدّل طلباته فقط، والمدير يعدّل الجميع */
  function canEditOrder(o) {
    if (!o || !o.createdBy) return true;
    return isAdmin() || o.createdBy === currentUser.id;
  }

  /** قفل/فتح كل عناصر تحرير الطلب حسب الملكية */
  const LOCKABLE = [
    '#m-customer input', '#m-customer select', '#m-customer textarea',
    '#orderStatus', '#m-pay input', '#m-pay button',
    '#m-price input', '#m-price select', '#m-price button',
    '#m-att input', '#m-att button',
    '.designer-panel input', '.designer-panel select', '.designer-panel button',
    '#tbAddSofa', '#tbAddDoor', '#tbAddWindow', '#tbFillAll', '#btnAddManual',
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
      customer: { name: '', phone: '', address: '' },
      deliveryDate: '', paid: 0, notes: '', attachments: emptyAttachments(),
      vat: { enabled: settings().vatEnabled !== false, rate: num(settings().vatRate ?? 15) },
      createdBy: null, createdByName: '', createdAt: null, updatedAt: null,
      total: 0,
    };
  }

  function setDirty(v) {
    dirty = v;
    $('#orderDirty').hidden = !v;
    if (v) scheduleDraft(); else clearDraft();
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

    const who = (o.customer && o.customer.name) ? `للعميل <b>${esc(o.customer.name)}</b>` : 'بدون اسم عميل';
    openModal('مسودة لم تُحفظ', `
      <p>وجدنا ${o.number ? `الطلب <b>#${o.number}</b>` : 'طلباً جديداً'} ${who} بتعديلات لم تصل إلى الخادم.</p>
      <p class="hint">آخر تعديل: ${fmtDateTime(d.at)} • ${((o.design && o.design.pieces) || []).length} قطعة في التصميم</p>
      <p class="hint">قد يكون السبب انقطاع الإنترنت أو إغلاق الصفحة قبل الحفظ.</p>
      <div class="btn-row">
        <button class="btn danger" id="drDrop">تجاهل المسودة</button>
        <button class="btn primary" id="drKeep">${icon('save')} استعادة ومتابعة التعديل</button>
      </div>`, (b) => {
      $('#drDrop', b).onclick = () => { clearDraft(); closeModal(); };
      $('#drKeep', b).onclick = () => {
        closeModal();
        loadOrder(o);
        if (!readOnly) { setDirty(true); toast('تمت استعادة المسودة. اضغط حفظ لإرسالها.'); }
      };
    });
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
  let inspOpen = false;   // اللوحة مفتوحة؟ لا تُفتح إلا بطلب صريح من المستخدم

  /** طلب قديم: قطعة كنب مرتبطة بصنف من فئة "كنب" ملغاة */
  function legacySofaItem(p) {
    if (!p || p.kind !== 'sofa' || !p.itemId) return null;
    const it = Store.getItem(p.itemId);
    return it && it.category === 'sofa' ? it : null;
  }

  /** اسم القطعة ولونها وعمقها للمخطط — الكنبة تركيب لا صنف */
  function pieceStyle(p) {
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
    onSelect(info) { renderInspector(info); syncWallSel(); },
    onRender() { positionInspector(); },
    onWallDblClick(i) { addSofaOnWall(i); },
  });

  function updateOverlapWarn() { $('#overlapWarn').hidden = designer.overlaps().size === 0; }

  /* --- تبويبات اللوحة الجانبية --- */
  $$('#panelTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#panelTabs button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    $$('.ptab').forEach((p) => p.classList.toggle('active', p.dataset.tab === b.dataset.tab));
  }));

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
    $('#canvasHint').textContent = designer.sel ? 'اضغط «تحرير» في الشريط أو انقر نقرة مزدوجة لفتح الخصائص' : 'اضغط على جدار أو قطعة لتحديده';
    $('#canvasHint').hidden = false;
    syncEditBtn();
  }

  $('#btnApplyRect').addEventListener('click', () => {
    designer.setRect(Math.max(0.5, num($('#roomW').value)), Math.max(0.5, num($('#roomH').value)));
    designer.fitView();
  });
  $('#btnAddWall').addEventListener('click', () => { const i = designer.addWall(); designer.select({ type: 'wall', index: i }); });
  $('#wallSel').addEventListener('change', () => designer.select({ type: 'wall', index: +$('#wallSel').value }));

  /* --- طريقة القياس --- */
  const CORNER_HINT = {
    deduct: 'لا تداخل: الزاوية تُحسب مرة واحدة للجدار الأطول، وتُخصم من الجدار المجاور (جدار 4 م بجانب كنبة عمقها 0.8 = 3.2 م).',
    full: 'كل جدار يُحسب بطوله كاملاً حتى في الزوايا (الزاوية تُحسب مرتين وتظهر القطع متشاركة فيها).',
  };
  function syncCornerMode() {
    const m = designer.state.cornerMode;
    $$('#cornerMode button').forEach((b) => b.classList.toggle('active', b.dataset.v === m));
    $('#cornerHint').textContent = CORNER_HINT[m];
  }
  $$('#cornerMode button').forEach((b) => b.addEventListener('click', () => designer.setCornerMode(b.dataset.v)));

  /* --- الكنب --- */
  function renderItemSelects() {

    // الكنبة تُركَّب من خشب وقماش وإسفنج — لا صنف واحد اسمه "كنب"
    SPECS.forEach((s) => {
      const sel = $('#sofa' + s.key.charAt(0).toUpperCase() + s.key.slice(1) + 'Sel');
      if (!sel) return;
      const list = activeItems(s.cat);
      const prev = sel.value;
      sel.innerHTML = list.length
        ? list.map((i) => `<option value="${i.id}">${esc(i.name)} — ${fmt(i.price)} ${currency()}/م</option>`).join('')
        : `<option value="">لا توجد أصناف ${esc(s.label)}</option>`;
      if (list.some((i) => i.id === prev)) sel.value = prev;
    });
    updateSofaPriceHint();

    const accs = activeItems('acc');
    $('#accButtons').innerHTML = accs.length
      ? accs.map((i) => `<button class="btn" data-acc="${i.id}"><span class="sw" style="background:${esc(i.color || '#888')}"></span>${esc(i.name)}</button>`).join('')
      : '<span class="hint">لا توجد إكسسوارات. أضفها من صفحة الأصناف.</span>';
    $$('#accButtons button').forEach((b) => b.addEventListener('click', () => {
      const it = Store.getItem(b.dataset.acc);
      if (it) designer.addAccessory(it);
    }));
  }

  const SOFA_SEL = { wood: '#sofaWoodSel', fabric: '#sofaFabricSel', foam: '#sofaFoamSel' };

  /** تركيبة الكنب المختارة: الثلاثة مطلوبة، وسعر المتر مجموع أسعارها */
  function selectedSofaSpec(silent = false) {
    const spec = { depth: Math.max(0.3, num($('#sofaDepth').value) || 0.8) };
    const missing = [];
    for (const s of SPECS) {
      const rec = Store.getItem($(SOFA_SEL[s.key]).value);
      if (!rec || rec.category !== s.cat) { missing.push(s.label); continue; }
      spec[s.field] = rec.id;
    }
    if (missing.length) {
      if (!silent) toast(`اختر ${missing.join(' و')} أولاً — أضفها من صفحة الأصناف`, true);
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
    toast(n ? `تمت إضافة ${n} قطعة` : 'لا توجد مساحات فارغة على الجدران', !n);
  }
  SPECS.forEach((s) => { const el = $(SOFA_SEL[s.key]); if (el) el.addEventListener('change', updateSofaPriceHint); });

  $('#btnAddSofaWall').addEventListener('click', () => addSofaOnWall(targetWall()));
  $('#btnFillAll').addEventListener('click', fillAll);
  $('#tbFillAll').addEventListener('click', fillAll);
  $('#btnAddSofaFree').addEventListener('click', () => { const s = selectedSofaSpec(); if (s) designer.addSofaFree(s); });
  $('#tbAddSofa').addEventListener('click', () => addSofaOnWall(targetWall()));
  $('#tbAddDoor').addEventListener('click', () => designer.addOpening(targetWall(), 'door'));
  $('#tbAddWindow').addEventListener('click', () => designer.addOpening(targetWall(), 'window'));
  /* --- التراجع والإعادة --- */
  function updateUndoButtons() {
    $('#tbUndo').disabled = readOnly || !designer.canUndo();
    $('#tbRedo').disabled = readOnly || !designer.canRedo();
  }
  function doUndo() { if (readOnly) return; if (designer.undo()) toast('تم التراجع'); else toast('لا يوجد ما يُتراجع عنه', true); }
  function doRedo() { if (readOnly) return; if (designer.redo()) toast('تمت الإعادة'); else toast('لا يوجد ما يُعاد', true); }
  $('#tbUndo').addEventListener('click', doUndo);
  $('#tbRedo').addEventListener('click', doRedo);

  $('#tbZoomIn').addEventListener('click', () => designer.zoomAt(1.25));
  $('#tbZoomOut').addEventListener('click', () => designer.zoomAt(0.8));
  $('#tbFit').addEventListener('click', () => designer.fitView());

  /* --- لوحة الخصائص العائمة (Inspector) --- */
  /** لوحة الخصائص لا تُفتح بمجرّد التحديد، بل بزر «تحرير» أو بنقرة مزدوجة */
  function openInspector() {
    const info = designer.selectionInfo();
    if (!info) return;
    inspOpen = true;
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
  // تُقفل اللوحة بمجرّد بدء سحب القطعة حتى لا تحجب المخطط
  designer.canvas.addEventListener('pointermove', () => {
    if (insp.hidden) return;
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
          <button class="btn small primary" data-act="sofa">${icon('sofa')} كنب</button>
          <button class="btn small" data-act="door">${icon('door')} باب</button>
          <button class="btn small" data-act="window">${icon('window')} شباك</button>
          <button class="btn small danger" data-act="delwall" ${nWalls <= 3 ? 'disabled' : ''} title="حذف الجدار">${icon('trash')}</button>
        </div>`;
    } else if (info.type === 'opening') {
      const o = info.opening;
      html += `
        <div class="insp-head"><b>${icon(o.type === 'door' ? 'door' : 'window')} ${o.type === 'door' ? 'باب' : 'شباك'} <small>على جدار ${o.wall + 1}</small></b><button class="btn small" data-close aria-label="إنهاء تعديل القطعة">تم ${icon('check')}</button></div>
        <div class="row2">
          <label>النوع <select id="inspType"><option value="door" ${o.type === 'door' ? 'selected' : ''}>باب</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>شباك</option></select></label>
          <label>العرض (م) <input id="inspOW" type="number" step="0.05" min="0.3" value="${Designer.util.round(o.w, 2)}"></label>
        </div>
        <label>البُعد من بداية الجدار (م) <input id="inspOT" type="number" step="0.05" min="0" value="${Designer.util.round(o.t - o.w / 2, 2)}"></label>
        <label class="check"><input id="inspBlocks" type="checkbox" ${o.blocks ? 'checked' : ''}> لا يوضع كنب أمامه</label>
        <div class="insp-actions"><button class="btn small danger" data-act="del">${icon('trash')} حذف</button></div>`;
    } else {
      const p = info.piece;
      const isSofa = p.kind === 'sofa';
      const legacy = legacySofaItem(p);
      // الكنبة تركيب من ثلاثة، فلا قائمة "صنف" لها. الإكسسوار صنف واحد كما كان.
      const items = isSofa ? [] : activeItems('acc');
      const curItem = isSofa ? (pieceStyle(p) || { name: 'كنب' }) : getItem(p.itemId);
      const opts = items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`);
      if (!isSofa && !items.some((i) => i.id === p.itemId)) opts.unshift(`<option value="${esc(p.itemId)}">${esc(curItem.name)}</option>`);
      html += `
        <div class="insp-head"><b>${icon(isSofa ? 'sofa' : 'pillow')} ${esc(curItem.name)} <small id="inspWallLbl">${p.wall != null ? 'على جدار ' + (p.wall + 1) : 'قطعة حرة'}</small></b><button class="btn small" data-close aria-label="إنهاء تعديل القطعة">تم ${icon('check')}</button></div>
        <div class="insp-main">
          ${isSofa ? '' : `<label>الصنف <select id="selItem">${opts.join('')}</select></label>`}
          ${isSofa && legacy ? `<p class="hint">هذه القطعة من طلب قديم مرتبط بصنف «${esc(legacy.name)}». اختر الخشب والقماش والإسفنج لتحويلها.</p>` : ''}
          ${isSofa ? SPECS.map((s) => `<label>${s.label} ${specSelect('sel_' + s.key, s, p[s.field] || '', '')}</label>`).join('') : ''}
        </div>
        <div class="row2">
          <label>الطول (م) <input id="selW" type="number" step="0.05" min="0.2" value="${Designer.util.round(p.w, 2)}" ${isSofa ? '' : 'readonly tabindex="-1"'}></label>
          <label>${isSofa ? 'العمق' : 'العرض'} (م) <input id="selH" type="number" step="0.05" min="0.2" value="${Designer.util.round(p.h, 2)}" ${isSofa ? '' : 'readonly tabindex="-1"'}></label>
        </div>
        ${isSofa ? '' : '<p class="hint">مقاس الإكسسوار ثابت من بطاقة الصنف في صفحة «الأصناف». لتغييره، عدّل الصنف هناك أو اختر صنفاً آخر من القائمة أعلاه.</p>'}
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
        </div>`;
    }
    insp.innerHTML = html;
    prepareControls(insp);
    insp.hidden = false;
    document.body.classList.toggle('inspector-open', isMobile());
    if (info.type === 'piece' && $('#selItem', insp)) $('#selItem', insp).value = info.piece.itemId;
    bindInspector(info);
    syncMobileSheet();
    positionInspector();
    if (info.type === 'wall' && !isCoarse) { const li = $('#inspLen', insp); li.focus(); li.select(); }
  }

  function refreshInspectorValues(info) {
    const active = document.activeElement;
    const setIf = (id, v) => { const el = $('#' + id, insp); if (el && el !== active) el.value = v; };
    if (info.type === 'wall') { setIf('inspLen', Designer.util.round(info.wall.len, 3)); setIf('inspAng', info.wall.angle); }
    else if (info.type === 'opening') { const o = info.opening; setIf('inspOW', Designer.util.round(o.w, 2)); setIf('inspOT', Designer.util.round(o.t - o.w / 2, 2)); }
    else {
      const p = info.piece;
      setIf('selW', Designer.util.round(p.w, 2)); setIf('selH', Designer.util.round(p.h, 2)); setIf('selRot', Math.round(p.rot));
      const lbl = $('#inspWallLbl', insp); if (lbl) lbl.textContent = p.wall != null ? 'على جدار ' + (p.wall + 1) : 'قطعة حرة';
    }
  }

  function bindInspector(info) {
    const closeBtn = $('[data-close]', insp);
    if (closeBtn) closeBtn.onclick = () => closeInspector();
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
        else if (a === 'delwall') { if (designer.removeWall(i)) { designer.select(null); toast('تم حذف الجدار'); } }
      }));
    } else if (info.type === 'opening') {
      const id = info.opening.id;
      const apply = () => {
        const o = designer.opening(id); if (!o) return;
        const w = Math.max(0.3, num($('#inspOW', insp).value));
        const start = Math.max(0, num($('#inspOT', insp).value));
        designer.updateOpening(id, { type: $('#inspType', insp).value, w, t: start + w / 2, blocks: $('#inspBlocks', insp).checked });
        renderInspector(designer.selectionInfo());
      };
      ['inspType', 'inspOW', 'inspOT', 'inspBlocks'].forEach((k) => { const el = $('#' + k, insp); el.addEventListener('change', apply); if (el.tagName === 'INPUT' && el.type !== 'checkbox') onEnter(el, apply); });
      $('[data-act="del"]', insp).addEventListener('click', () => { designer.removeOpening(id); designer.select(null); });
    } else {
      const apply = () => {
        const p = designer.selectedPiece(); if (!p) return;
        const props = { rot: num($('#selRot', insp).value), note: $('#selNote', insp).value.trim() };
        // الكنب يُقاس يدوياً؛ الإكسسوار مقاسه من بطاقة الصنف فلا يُرسل من الحقول
        if (p.kind === 'sofa') { props.w = num($('#selW', insp).value); props.h = num($('#selH', insp).value); }
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

  function positionInspector() {
    if (insp.hidden) return;
    // على الجوال تُعرض كورقة سفلية بعرض الشاشة: تُمسح الإحداثيات السطرية
    if (isMobile()) { insp.style.left = ''; insp.style.top = ''; return; }
    const pos = designer.selectionScreenPos();
    if (!pos) return;
    const wrap = insp.parentElement;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const w = insp.offsetWidth, h = insp.offsetHeight;
    let left = Math.min(Math.max(pos.x - w / 2, 8), Math.max(8, W - w - 8));
    let top = pos.y + 14;
    if (top + h > H - 8) top = Math.max(8, pos.top - h - 14);
    if (top + h > H - 8) top = Math.max(8, H - h - 8);
    insp.style.left = left + 'px';
    insp.style.top = top + 'px';
  }

  function splitDialog() {
    const p = designer.selectedPiece();
    if (!p) return;
    openModal('تقسيم القطعة', `
      <label>عدد القطع <input id="splitN" type="number" min="2" max="10" value="2"></label>
      <p class="hint">الطول الحالي ${Designer.util.round(p.w, 2)} م سيُقسّم إلى قطع منفردة متساوية يمكن تعديل كل منها لاحقاً.</p>
      <div class="btn-row"><button class="btn" id="spCancel">إلغاء</button><button class="btn primary" id="spOk">تقسيم</button></div>`, (b) => {
      $('#spCancel', b).onclick = closeModal;
      $('#spOk', b).onclick = () => { designer.splitSelected(num($('#splitN', b).value)); closeModal(); };
    });
  }

  document.addEventListener('keydown', (e) => {
    if ($('#app').hidden || !$('#page-order').classList.contains('active')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || !$('#modal').hidden) return;
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
    const subtotal = money(lines.reduce((s, l) => s + l.total, 0));
    const vat = order.vat || { enabled: false, rate: 15 };
    const vatRate = vat.enabled ? Math.min(100, Math.max(0, num(vat.rate))) : 0;
    const vatAmount = money(subtotal * vatRate / 100);
    const total = money(subtotal + vatAmount);
    return { lines, subtotal, vatEnabled: !!vat.enabled, vatRate, vatAmount, total };
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
   * الربح = المبيعات قبل الضريبة − (تكاليف الأصناف + التكاليف الإضافية).
   * الضريبة تُحصَّل للدولة وليست إيراداً فلا تدخل الحساب.
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
    const profit = money(subtotal - costTotal);
    return {
      rows, subtotal, vatEnabled, total, costTotal, profit,
      linesCost, extras, extrasCost,
      entered: filled.length + extras.length, missing: rows.length - filled.length,
      margin: subtotal > 0 ? r2((profit / subtotal) * 100) : 0,
    };
  }

  /** إجمالي تكلفة الطلب كما حُفظ، أو null إن لم تُدخل تكاليف */
  function orderCost(o) {
    return (o && o.costTotal !== undefined && o.costTotal !== null) ? money(o.costTotal) : null;
  }

  /** المبيعات قبل الضريبة: أساس حساب الربح (الطلبات القديمة تُشتق من المجموع) */
  function orderRevenue(o) {
    if (o.subtotal !== undefined && o.subtotal !== null) return money(o.subtotal);
    const rate = (o.vat && o.vat.enabled) ? num(o.vatRate != null ? o.vatRate : o.vat.rate) : 0;
    return money(num(o.total) / (1 + rate / 100));
  }

  /** صافي ربح الطلب، أو null إن لم تُدخل تكاليفه */
  function orderProfit(o) {
    const c = orderCost(o);
    return c === null ? null : money(orderRevenue(o) - c);
  }

  /** تحديث إجمالي التكلفة المخزّن في الطلب (يُحذف الحقل إن لم تبقَ أي تكلفة) */
  function syncCostTotal(o) {
    const info = computeCosts(o);
    if (info.entered) o.costTotal = info.costTotal; else delete o.costTotal;
    return info;
  }

  function renderPricing() {
    const { lines, total } = computeLines(cur);
    const tb = $('#priceTable tbody');
    if (!lines.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">أضف قطع كنب أو إكسسوارات في التصميم لتظهر هنا</td></tr>';
    } else {
      tb.innerHTML = lines.map((l, i) => {
        const overridden = l.kind !== 'manual' && Math.abs(l.price - l.basePrice) > 0.004;
        const nameCell = l.kind === 'manual'
          ? `<input class="inline wide" data-m="${l.idx}" data-k="name" value="${esc(l.name)}" placeholder="اسم الصنف">`
          : `${esc(l.name)}${l.sub ? `<span class="sub">${esc(l.sub)}</span>` : ''}`;
        // كمية الإكسسوار تُكتب هنا وتنعكس على التصميم: تُضاف القطع أو تُحذف
        const qtyCell = l.kind === 'manual'
          ? `<input class="inline num" type="number" step="0.01" min="0" data-m="${l.idx}" data-k="qty" value="${l.qty}">`
          : l.kind === 'acc'
            ? `<input aria-label="عدد ${esc(l.name || 'الإكسسوار')}" title="تعديل العدد يضيف القطع أو يحذفها من التصميم" class="inline num" type="number" step="1" min="0" max="${ACC_MAX}" inputmode="numeric" data-accqty="${esc(l.itemId)}" value="${l.qty}">`
            : `<span class="num">${fmtQty(l.qty)}</span>`;
        const unitCell = l.kind === 'manual'
          ? `<select class="inline" data-m="${l.idx}" data-k="unit" style="width:90px"><option ${l.unit === 'قطعة' ? 'selected' : ''}>قطعة</option><option ${l.unit === 'متر' ? 'selected' : ''}>متر</option><option ${l.unit === 'خدمة' ? 'selected' : ''}>خدمة</option></select>`
          : l.unit;
        return `<tr>
          <td class="price-index">${i + 1}</td>
          <td class="price-name" data-label="الصنف">${nameCell}</td>
          <td class="price-unit" data-label="الوحدة">${unitCell}</td>
          <td class="price-qty" data-label="الكمية">${qtyCell}</td>
          <td class="price-edit" data-label="سعر الوحدة"><input aria-label="سعر ${esc(l.name || 'الصنف')}" inputmode="numeric" class="inline num" type="number" step="1" min="0" data-price="${esc(l.key)}" value="${l.price}">
              ${overridden ? `<button type="button" class="overridden" data-reset="${esc(l.key)}" title="إعادة السعر الأصلي">↺ الأصلي ${fmt(l.basePrice)}</button>` : ''}</td>
          <td class="num price-total" data-label="الإجمالي"><b>${fmt(l.total)}</b></td>
          <td class="row-actions">${l.kind === 'manual' ? `<button class="icon-btn" aria-label="حذف الصنف الإضافي" data-mdel="${l.idx}">${icon('x')}</button>` : ''}</td>
        </tr>`;
      }).join('');
    }
    const { subtotal, vatEnabled, vatRate, vatAmount } = computeLines(cur);
    $('#priceSubtotal').textContent = `${fmt(subtotal)} ${currency()}`;
    $('#priceVat').textContent = vatEnabled ? `${fmt(vatAmount)} ${currency()}` : '—';
    $('#priceTotal').textContent = `${fmt(total)} ${currency()}`;
    $('#vatEnabled').checked = vatEnabled;
    $('#vatRate').value = num(cur.vat ? cur.vat.rate : vatRate);
    $('#vatRate').disabled = !vatEnabled;
    $('#priceTable tfoot .vat-row').style.opacity = vatEnabled ? '' : '.55';
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
      designer.setAccessoryCount(it, n); // onChange يحدّث الطلب ويعيد رسم التسعير
      const d = n - have;
      toast(d > 0 ? `أُضيفت ${d} من «${it.name}» إلى التصميم` : `حُذفت ${-d} من «${it.name}» من التصميم`);
    }));
    $$('[data-reset]', tb).forEach((el) => el.addEventListener('click', () => { delete cur.priceOverrides[el.dataset.reset]; setDirty(true); renderPricing(); }));
    $$('[data-m]', tb).forEach((el) => el.addEventListener('change', () => {
      const r = cur.manualRows[+el.dataset.m];
      if (!r) return;
      r[el.dataset.k] = el.dataset.k === 'qty' ? Math.max(0, num(el.value)) : el.value;
      setDirty(true); renderPricing();
    }));
    $$('button[data-mdel]', tb).forEach((b) => b.addEventListener('click', () => { cur.manualRows.splice(+b.dataset.mdel, 1); setDirty(true); renderPricing(); }));

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
    cur.manualRows.push({ name: '', qty: 1, price: 0, unit: 'قطعة' });
    setDirty(true);
    renderPricing();
    const inputs = $$('#priceTable input[data-k="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  /* --- ضريبة القيمة المضافة --- */
  const ensureVat = () => { if (!cur.vat) cur.vat = { enabled: false, rate: num(settings().vatRate ?? 15) }; return cur.vat; };
  $('#vatEnabled').addEventListener('change', () => { ensureVat().enabled = $('#vatEnabled').checked; setDirty(true); renderPricing(); });
  $('#vatRate').addEventListener('change', () => { ensureVat().rate = Math.min(100, Math.max(0, num($('#vatRate').value))); setDirty(true); renderPricing(); });

  /* ---------------- العميل والدفع ---------------- */
  const fieldMap = {
    custName: (v) => (cur.customer.name = v), custPhone: (v) => (cur.customer.phone = v), custAddress: (v) => (cur.customer.address = v),
    deliveryDate: (v) => (cur.deliveryDate = v), orderStatus: (v) => (cur.status = v), orderNotes: (v) => (cur.notes = v),
    payPaid: (v) => (cur.paid = Math.max(0, money(String(v).replace(/,/g, '')))),
  };
  Object.keys(fieldMap).forEach((id) => $('#' + id).addEventListener('input', () => {
    fieldMap[id]($('#' + id).value);
    setDirty(true);
    if (id === 'payPaid') renderPayment();
    if (id === 'orderStatus') syncStatusChip();
    if (id === 'custAddress' || id === 'orderNotes') autoGrow($('#' + id));
    if (id === 'deliveryDate') syncDeliveryEcho();
  }));

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

  /* النص متعدّد الأسطر ينمو مع محتواه بدل شريط تمرير داخل حقل قصير */
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 132);
    el.style.height = h + 'px';
    el.style.overflowY = el.scrollHeight > 132 ? 'auto' : 'hidden';
  }

  const PAY_STATES = {
    none: 'غير مدفوع', partial: 'مدفوع جزئياً',
    full: 'مدفوع بالكامل', over: 'زائد عن المطلوب',
  };

  function renderPayment() {
    const total = cur.total || 0;
    const paid = num(cur.paid);
    const rem = total - paid;
    // العملة في العنوان لا بجانب كل رقم: يوفّر عرضاً ويمنع قصّ الأرقام في الجوال
    const cu = currency();
    $('#payTotalLbl').textContent = `الإجمالي (${cu})`;
    $('#payPaidLbl').textContent = `المدفوع (${cu})`;
    $('#payRemLbl').textContent = `المتبقي (${cu})`;
    $('#payTotal').textContent = fmt(total);
    const vt = computeLines(cur);
    $('#payVatNote').textContent = vt.vatEnabled ? `شامل ضريبة ${num(vt.vatRate)}%` : 'بدون ضريبة';
    $('#payRemaining').textContent = fmt(rem);
    $('#barTotal').textContent = fmt(total);
    $('#barRemaining').textContent = fmt(rem);

    // الحالة: لا شيء / جزئي / مكتمل / زائد — تُلوّن الشريط والشارة والمتبقي معاً
    let state = 'none';
    if (rem < -0.004) state = 'over';
    else if (total > 0 && rem <= 0.004) state = 'full';
    else if (paid > 0.004) state = 'partial';

    const pct = total > 0 ? Math.min(100, (paid / total) * 100) : (paid > 0 ? 100 : 0);
    $('#payFill').style.width = pct.toFixed(2) + '%';
    $('#payBlock').dataset.state = state;
    const badge = $('#payBadge');
    badge.dataset.state = state;
    badge.textContent = state === 'partial' ? `${PAY_STATES.partial} • ${Math.round(pct)}%` : PAY_STATES[state];
  }

  /* المدفوع يُعرض منسّقاً كجيرانه (3,829.50)، ويصير رقماً خاماً أثناء الكتابة فقط */
  $('#payPaid').addEventListener('focus', () => { $('#payPaid').value = money(cur.paid) || 0; });
  $('#payPaid').addEventListener('blur', () => { $('#payPaid').value = fmt(cur.paid); });

  /* اختصارات الدفعات: العربون نصف أو ربع المبلغ بضغطة واحدة */
  $('#payQuick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pay]');
    if (!btn || readOnly) return;
    const f = parseFloat(btn.dataset.pay);
    const v = Math.max(0, money((cur.total || 0) * f));
    cur.paid = v;
    $('#payPaid').value = fmt(v);
    setDirty(true);
    renderPayment();
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
    });
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
    $('#deliveryDate').value = cur.deliveryDate || '';
    $('#orderStatus').value = cur.status || 'new';
    $('#orderNotes').value = cur.notes || '';
    $('#payPaid').value = fmt(cur.paid || 0);
    syncStatusChip();
    syncDeliveryEcho();
    autoGrow($('#custAddress'));
    autoGrow($('#orderNotes'));
    renderAttachments();
    $('#orderTitle').textContent = cur.number ? `الطلب #${cur.number}` : 'طلب جديد';
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
    cur.attachments = normalizeAttachments(cur.attachments);
    // الطلبات القديمة المحفوظة بدون ضريبة تبقى كما هي
    cur.vat = cur.vat || { enabled: false, rate: num(settings().vatRate ?? 15) };
    readOnly = !canEditOrder(cur);
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
    designer.setState(cur.design);
    $('#roomW').value = 5; $('#roomH').value = 4;
    fillOrderForm();
    setDirty(false);
    clearDraft();
  }
  $('#btnNewOrder').addEventListener('click', () => startNewOrder());

  async function saveOrder(silent = false) {
    if (readOnly) { if (!silent) toast('هذا الطلب لموظف آخر: لا يمكن حفظ التعديلات', true); return false; }
    cur.design = designer.getState();
    const { lines, total, subtotal, vatAmount, vatRate } = computeLines(cur);
    cur.subtotal = subtotal; cur.vatAmount = vatAmount; cur.vatRate = vatRate;
    if (!cur.customer.name.trim()) {
      if (!silent) { toast('أدخل اسم العميل قبل الحفظ', true); $('#m-customer').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); $('#custName').focus(); }
      return false;
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
    cur.remaining = money(total - num(cur.paid));
    const nowIso = Store.now();
    if (!cur.id) {
      let no;
      try { no = await Store.nextOrderNo(); } catch (e) { toast('تعذر الحفظ: ' + e.message, true); return false; }
      cur.id = Store.uid();
      cur.number = no;
      cur.createdAt = nowIso;
      cur.createdBy = currentUser.id;
      cur.createdByName = currentUser.name;
    }
    cur.updatedAt = nowIso;
    cur.updatedByName = currentUser.name;
    const idx = db().orders.findIndex((o) => o.id === cur.id);
    const prev = idx >= 0 ? db().orders[idx] : null;
    // وقت آخر تغيير للحالة: عليه تقوم تنبيهات المراحل، ويُشتق من الطلب نفسه
    // لا من سجل التحديثات لأن السجل لا يصل الموظفين في الوضع السحابي.
    if (!prev || (prev.status || 'new') !== (cur.status || 'new')) {
      cur.statusAt = nowIso;
      cur.statusByName = currentUser.name;
    }
    const copy = JSON.parse(JSON.stringify(cur));
    if (idx >= 0) db().orders[idx] = copy; else db().orders.push(copy);
    // سجل التحديثات
    if (!prev) logActivity('create', copy, [`الإجمالي ${fmt(total)}`, `المدفوع ${fmt(num(copy.paid))}`, `${lines.length} صنف`]);
    else { const ch = diffOrder(prev, copy); if (ch.length) logActivity('update', copy, ch); }
    if (!(await Store.save())) {
      setDirty(true); saveDraft();
      if (Store.lastStatus === 409) { await resolveConflict(copy); return false; }
      setNetState(Store.lastStatus === -1 ? 'off' : 'err');
      toast('تعذر الحفظ على الخادم: ' + (Store.lastError || '') + ' — حُفظت نسخة محلية', true);
      return false;
    }
    setNetState('ok');
    setDirty(false);
    $('#orderTitle').textContent = `الطلب #${cur.number}`;
    renderOrderMeta();
    renderNotifications();
    if (!silent) toast(`تم حفظ الطلب #${cur.number}`);
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
    try {
      await Store.refresh();
      remote = db().orders.find((o) => o.id === localCopy.id) || null;
      setNetState('ok');
    } catch (e) {
      toast('تعذّر جلب نسخة الخادم: ' + e.message, true);
      return;
    }
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
        if (idx >= 0) db().orders[idx] = copy; else db().orders.push(copy);
        if (remote) { const d = diffOrder(remote, copy); if (d.length) logActivity('update', copy, d.concat('كتابة فوق تعديل من جهاز آخر')); }
        if (await Store.save()) { setNetState('ok'); setDirty(false); renderOrderMeta(); toast('حُفظ تعديلك فوق نسخة الخادم'); }
        else toast('ما زال الحفظ متعذّراً: ' + (Store.lastError || ''), true);
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

  /* الزاوية الفاضية قيد تصنيع لا تفصيل بصري: تُكتب نصاً في الفاتورة
     حتى لا تعتمد الورشة على ملاحظة فراغ في الصورة. */
  function cornerSpec(design) {
    const spots = (design && design.cornerSpots) || [];
    if (!spots.length) return '';
    const n = (design.walls || []).length;
    const txt = spots.slice().sort((a, b) => a.at - b.at).map((c) => {
      const prev = ((c.at - 1 + n) % n) + 1, next = (c.at % n) + 1;
      return `الزاوية ${c.at + 1} (جدار ${prev} × جدار ${next}) تُترك فاضية ${Designer.util.round(c.size, 2)} م`;
    }).join('، ');
    return `<b>الزوايا:</b> ${esc(txt)}<br>`;
  }

  function buildPrintDoc(order) {
    printDesigner.setState(order.design);
    const aspect = printDesigner.aspect();
    const W = 1800, H = Math.round(Math.min(1500, Math.max(650, W / aspect)));
    const img = printDesigner.toImage(W, H);
    const { lines, total, subtotal, vatEnabled, vatRate, vatAmount } = computeLines(order);
    const paid = num(order.paid);
    const s = settings();
    const cur$ = currency();
    const emp = order.createdByName || (Store.getUser(order.createdBy) || {}).name || currentUser.name;
    const c = order.customer || {};
    const atts = filledAttachments(order);
    const dense = lines.length > 12;
    return `
    <div class="inv ${dense ? 'dense' : ''}">
      <div class="inv-head">
        <div class="inv-brand">
          <div class="mark"><svg viewBox="0 0 24 24"><path d="M6 11V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4"/><path d="M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5H3z"/><path d="M5 18v2M19 18v2M3 15h18"/></svg></div>
          <div><h1>${esc(s.shopName || 'أصالة نجد')}</h1><small>${esc([s.phone, s.address].filter(Boolean).join(' • ')) || '&nbsp;'}</small>${s.vatNumber ? `<small>الرقم الضريبي: <span class="num">${esc(s.vatNumber)}</span></small>` : ''}</div>
        </div>
        <div class="inv-title-box"><div class="inv-title">فاتورة طلب</div><div class="inv-no">${order.number ? '#' + order.number : 'مسودة'}</div></div>
      </div>
      <div class="inv-info">
        <div><span>العميل</span><b title="${esc(c.name)}">${esc(c.name) || '—'}</b></div>
        <div><span>الجوال</span><b class="num">${esc(c.phone) || '—'}</b></div>
        <div style="grid-column: span 2"><span>مكان التوصيل</span><b class="wrap">${esc(c.address) || '—'}</b></div>
        <div><span>تاريخ الطلب</span><b class="num">${fmtDate(order.createdAt || Store.now())}</b></div>
        <div><span>تاريخ التوصيل المتوقع</span><b class="num">${order.deliveryDate ? fmtDate(order.deliveryDate) : 'غير محدد'}</b></div>
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
          <thead><tr><th style="width:7mm">#</th><th>الصنف</th><th style="width:16mm">الوحدة</th><th style="width:18mm">الكمية</th><th style="width:24mm">السعر (${cur$})</th><th style="width:28mm">الإجمالي (${cur$})</th></tr></thead>
          <tbody>${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}${l.sub ? ` <small>— ${esc(l.sub)}</small>` : ''}</td><td>${esc(l.unit)}</td><td class="num">${l.kind === 'sofa' ? fmtQty(l.qty) : l.qty}</td><td class="num">${fmt(l.price)}</td><td class="num">${fmt(l.total)}</td></tr>`).join('') || '<tr><td colspan="6">لا توجد أصناف</td></tr>'}</tbody>
        </table>
      </div>
      <div class="inv-bottom">
        <div class="inv-notes">${cornerSpec(order.design)}${order.notes ? `<b>ملاحظات:</b> ${esc(order.notes).replace(/\n/g, '<br>')}` : ''}${s.invoiceNote ? `${order.notes ? '<br>' : ''}<b>شروط:</b> ${esc(s.invoiceNote)}` : ''}${!order.notes && !s.invoiceNote ? '<b>ملاحظات:</b> —' : ''}</div>
        <div class="inv-totals">
          ${vatEnabled ? `<div><span>المجموع قبل الضريبة</span><span class="num">${fmt(subtotal)} ${cur$}</span></div>
          <div><span>ضريبة القيمة المضافة ${num(vatRate)}%</span><span class="num">${fmt(vatAmount)} ${cur$}</span></div>` : ''}
          <div class="total"><span>الإجمالي${vatEnabled ? ' شامل الضريبة' : ''}</span><span class="num">${fmt(total)} ${cur$}</span></div>
          <div><span>المدفوع</span><span class="num">${fmt(paid)} ${cur$}</span></div>
          <div class="rem"><span>المتبقي</span><span class="num">${fmt(total - paid)} ${cur$}</span></div>
        </div>
      </div>
      <div class="inv-foot">
        <div class="inv-sign"><i></i><span>توقيع العميل</span></div>
        <div>الحالة: ${STATUS[order.status] || order.status} • طريقة القياس: ${order.design.cornerMode === 'deduct' ? 'خصم الزوايا' : 'بطول الجدار'}</div>
        <div class="inv-sign"><i></i><span>الموظف: ${esc(emp)}</span></div>
      </div>
    </div>`;
  }

  /* ارتفاع ‎.inv‎ ثابت (277مم) و overflow مخفي، فطلب بأصناف كثيرة كان تُقصّ
     أسطره الأخيرة بلا إنذار. نضيّق جدول التسعير — وهو الجزء الوحيد الذي ينمو
     بعدد الأصناف — ثم مربّع التصميم، درجة درجة حتى تدخل الصفحة. */
  function fitOnePage(area) {
    const inv = $('.inv', area);
    if (!inv) return;
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
    area.style.cssText = keep;
  }

  /** بناء الفاتورة في منطقة الطباعة وانتظار تحميل صورة التصميم والمرفقات */
  function renderPrintArea(order) {
    const area = $('#printArea');
    area.innerHTML = buildPrintDoc(order);
    // صورة التصميم والمرفقات معاً: html2canvas يرسم الفراغ إن صوّر قبل اكتمالها
    const imgs = $$('img', area).filter((im) => !im.complete);
    if (!imgs.length) { fitOnePage(area); return Promise.resolve(); }
    return new Promise((res) => {
      let left = imgs.length, done = false;
      const fin = () => { if (done) return; done = true; fitOnePage(area); res(); };
      const one = () => { if (--left <= 0) fin(); };
      imgs.forEach((im) => { im.onload = one; im.onerror = one; });
      setTimeout(fin, 1500);
    });
  }

  /** المسار الأساسي: تجهيز الفاتورة ثم عرض نافذة التصدير والمشاركة */
  async function shareOrder(order) {
    if (order.id) { logActivity('export', order, [`الإجمالي ${fmt(order.total)}`]); Store.save(); }
    await renderPrintArea(order);
    exportShareModal(order);
  }

  /* ---------------- تصدير PDF ومشاركته مع العميل ---------------- */
  const H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[data-lib="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.dataset.lib = src;
      s.onload = () => res();
      s.onerror = () => rej(new Error('تعذّر تحميل مكتبة إنشاء PDF. تحقق من الاتصال بالإنترنت.'));
      document.head.appendChild(s);
    });
  }

  /** تحويل فاتورة الصفحة الواحدة إلى ملف PDF حقيقي (صورة عالية الدقة تحفظ العربية كما تُعرض) */
  async function makePdfBlob() {
    await loadScript(H2C_URL);
    await loadScript(JSPDF_URL);
    const area = $('#printArea');
    const inv = $('.inv', area);
    if (!inv) throw new Error('تعذّر تجهيز الفاتورة');
    // إظهار مؤقت خارج الشاشة حتى يتمكّن html2canvas من قياسها
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    try {
      const canvas = await window.html2canvas(inv, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const img = canvas.toDataURL('image/jpeg', 0.94);
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      pdf.addImage(img, 'JPEG', 10, 10, 190, 277, undefined, 'FAST');
      return pdf.output('blob');
    } finally {
      area.style.cssText = '';
    }
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /** توحيد رقم الجوال السعودي إلى صيغة 9665xxxxxxxx */
  function waPhone(raw) {
    let d = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('966')) return d;
    if (d.startsWith('0')) return '966' + d.slice(1);
    if (/^5\d{8}$/.test(d)) return '966' + d;
    return d;
  }

  /** رسالة مرافقة قصيرة تُرسل مع الملف */
  function waCaption(order) {
    const { total } = computeLines(order);
    const paid = num(order.paid);
    const s = settings();
    const L = [`*${s.shopName || 'أصالة نجد'}*`];
    L.push(order.number ? `فاتورة الطلب رقم *#${order.number}*` : 'فاتورة الطلب');
    L.push(`الإجمالي: ${fmt(total)} ${currency()} • المتبقي: ${fmt(total - paid)} ${currency()}`);
    if (order.deliveryDate) L.push(`موعد التوصيل المتوقع: ${fmtDate(order.deliveryDate)}`);
    return L.join('\n');
  }


  /** فتح رابط خارجي بتبويب جديد (أكثر موثوقية من window.open مع مانع النوافذ) */
  function openExternal(url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /** فتح محادثة العميل على واتساب (بدون ملف: المتصفح لا يسمح بإرفاقه لرقم محدد) */
  function openCustomerChat(order) {
    const p = waPhone(order.customer && order.customer.phone);
    openExternal(`https://wa.me/${p}?text=${encodeURIComponent(waCaption(order))}`);
  }

  /** نافذة التصدير والمشاركة */
  function exportShareModal(order) {
    const rawPhone = (order.customer && order.customer.phone) || '';
    const phone = waPhone(rawPhone);
    const cname = (order.customer && order.customer.name) || '';
    const fileName = `طلب-${order.number || 'جديد'}.pdf`;
    let pdfFile = null;

    openModal(`تصدير ومشاركة الطلب ${order.number ? '#' + order.number : ''}`, `
      <div class="share-target">
        <span class="share-avatar">${icon('user')}</span>
        <div>
          <b>${esc(cname) || 'بدون اسم عميل'}</b>
          <small class="${rawPhone ? 'num' : 'warn-text'}">${esc(rawPhone) || 'لا يوجد رقم جوال مسجّل'}</small>
        </div>
      </div>
      <p id="pdfState" class="pdf-state">${icon('clock')} جاري تجهيز ملف PDF…</p>
      <div class="share-actions">
        <button class="btn primary block lg" id="shWa" disabled>${icon('whatsapp')} مشاركة الملف عبر واتساب</button>
        ${phone ? `<button class="btn block" id="shChat">${icon('whatsapp')} فتح محادثة ${esc(cname || 'العميل')}</button>` : ''}
        <button class="btn block" id="shSave" disabled>${icon('download')} حفظ الملف على الجهاز</button>
        <button class="btn block ghost" id="shPrint">${icon('print')} طباعة</button>
      </div>
      <p class="hint" id="shNote">واتساب لا يسمح للمتصفح بإرفاق ملف برقم محدد تلقائياً، لذلك ستظهر قائمة المشاركة لتختار محادثة ${esc(cname || 'العميل')} منها.</p>`, (b) => {

      const state = $('#pdfState', b);
      const btnWa = $('#shWa', b);
      const btnSave = $('#shSave', b);

      $('#shPrint', b).onclick = () => { closeModal(); setTimeout(() => window.print(), 60); };
      if ($('#shChat', b)) $('#shChat', b).onclick = () => openCustomerChat(order);

      // التجهيز يبدأ فوراً حتى تكون المشاركة استجابة مباشرة لنقرة المستخدم
      makePdfBlob().then((blob) => {
        const kb = Math.round(blob.size / 1024);
        pdfFile = new File([blob], fileName, { type: 'application/pdf' });
        state.className = 'pdf-state ready';
        state.innerHTML = `${icon('check')} الملف جاهز: <b>${esc(fileName)}</b> (${kb} كيلوبايت)`;
        btnWa.disabled = false; btnSave.disabled = false;
        btnSave.onclick = () => downloadBlob(blob, fileName);
        btnWa.onclick = () => {
          const canFiles = navigator.canShare && navigator.canShare({ files: [pdfFile] });
          if (canFiles) {
            navigator.share({ files: [pdfFile], title: fileName, text: waCaption(order) })
              .then(() => { closeModal(); toast('تمت المشاركة'); })
              .catch((e) => { if (e && e.name !== 'AbortError') toast('تعذّرت المشاركة: ' + e.message, true); });
          } else {
            // جهاز لا يدعم مشاركة الملفات: يُحفظ الملف وتُفتح محادثة العميل لإرفاقه
            downloadBlob(blob, fileName);
            if (phone) openCustomerChat(order);
            $('#shNote', b).innerHTML = `هذا المتصفح لا يدعم إرسال الملف مباشرة. حُفظ <b>${esc(fileName)}</b> في مجلد التنزيلات، أرفقه في محادثة ${esc(cname || 'العميل')}.`;
          }
        };
      }).catch((err) => {
        state.className = 'pdf-state err';
        state.innerHTML = `${icon('alert')} ${esc(err.message)}`;
        $('#shNote', b).textContent = 'يمكنك استخدام زر الطباعة ثم اختيار "حفظ كـ PDF".';
      });
    });
  }

  async function exportCurrent() {
    cur.design = designer.getState();
    if (!readOnly && cur.customer.name.trim()) await saveOrder(true);
    await shareOrder(cur);
  }
  $('#btnExportPdf').addEventListener('click', exportCurrent);
  $('#btnExportPdfTop').addEventListener('click', exportCurrent);

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

  function renderOrders() {
    const f = ordFilters();
    const filtering = !!(f.q || f.from || f.to || f.statuses.size);
    let list = filteredOrders();

    $$('#ordStatusChips .chip').forEach((c) => {
      const on = ordStatuses.has(c.dataset.stf);
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('#ordClearFilters').hidden = !filtering;
    const note = $('#ordersFilterNote');
    note.hidden = !filtering;
    if (filtering) note.textContent = `الملخص والجدول محسوبان على الطلبات المطابقة للفلتر: ${list.length} من ${db().orders.length}.`;

    // المبالغ لا تشمل الطلبات الملغية إلا إذا اختارها المستخدم صراحةً
    const money = ordStatuses.has('cancelled') ? list : list.filter((o) => o.status !== 'cancelled');
    const sum = (f2) => money.reduce((s, o) => s + num(f2(o)), 0);
    const costed = money.filter((o) => orderCost(o) !== null);
    const costSum = money(costed.reduce((s, o) => s + orderCost(o), 0));
    const profitSum = money(costed.reduce((s, o) => s + orderProfit(o), 0));
    const costedRevenue = money(costed.reduce((s, o) => s + orderRevenue(o), 0));
    const marginPct = costedRevenue > 0 ? r2((profitSum / costedRevenue) * 100) : 0;
    const noCost = money.length - costed.length;
    $('#ordersStats').innerHTML = `
      <div class="stat"><span>عدد الطلبات</span><b>${list.length}</b></div>
      <div class="stat"><span>إجمالي المبيعات</span><b>${fmt(sum((o) => o.total))}</b></div>
      <div class="stat"><span>المدفوع</span><b>${fmt(sum((o) => o.paid))}</b></div>
      <div class="stat remaining"><span>المتبقي على العملاء</span><b>${fmt(sum((o) => num(o.total) - num(o.paid)))}</b></div>
      <div class="stat"><span>قيد التنفيذ</span><b>${list.filter((o) => o.status === 'progress').length}</b></div>
      <div class="stat"><span>اكتمال التنفيذ</span><b>${list.filter((o) => o.status === 'done').length}</b></div>
      ${canSeeCosts() ? `
      <div class="stat cost"><span>إجمالي التكاليف</span><b>${costed.length ? fmt(costSum) : '—'}</b><small>بتكلفة: ${costed.length}${noCost ? ` • بلا تكلفة: ${noCost}` : ''}</small></div>
      <div class="stat profit"><span>إجمالي الربح <small>(قبل الضريبة)</small></span><b class="${costed.length ? (profitSum < 0 ? 'neg' : 'pos') : ''}">${costed.length ? fmt(profitSum) : '—'}</b><small>${costed.length ? `هامش ${fmtQty(marginPct)}٪` : 'أدخل التكاليف لحساب الربح'}</small></div>` : ''}`;

    const tb = $('#ordersTable tbody');
    $('#ordersEmpty').hidden = list.length > 0;
    // عرض تدريجي: رسم مئات الصفوف دفعة واحدة يُبطئ الجوال بلا فائدة
    const matched = list.length;
    list = list.slice(0, ordersShown);
    tb.innerHTML = list.map((o) => {
      const rem = num(o.total) - num(o.paid);
      const cost = orderCost(o);
      const profit = orderProfit(o);
      const dash = '<span class="hint">—</span>';
      return `
      <tr>
        <td data-label="رقم الطلب"><b>#${o.number}</b></td>
        <td data-label="التاريخ" class="num">${fmtDateTime(o.createdAt)}</td>
        <td data-label="العميل">${esc(o.customer?.name)}</td>
        <td data-label="الجوال" class="num">${esc(o.customer?.phone)}</td>
        <td data-label="المجموع" class="num">${fmt(o.total)}</td>
        ${canSeeCosts() ? `
        <td data-label="التكلفة" class="num">${cost === null ? dash : fmt(cost)}</td>
        <td data-label="صافي الربح" class="num ${profit === null ? '' : profit < 0 ? 'neg' : 'pos'}">${profit === null ? dash : fmt(profit)}</td>` : ''}
        <td data-label="المدفوع" class="num">${fmt(o.paid)}</td>
        <td data-label="المتبقي" class="num" style="color:${rem > 0.004 ? 'var(--warn)' : 'inherit'}">${fmt(rem)}</td>
        <td data-label="التوصيل" class="num">${o.deliveryDate ? fmtDate(o.deliveryDate) : '—'}</td>
        <td data-label="الحالة"><select class="inline" data-st="${o.id}" style="width:auto">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td data-label="الموظف">${esc(o.createdByName || '')}</td>
        <td class="row-actions">
          <button class="btn small" data-open="${o.id}">${canEditOrder(o) ? `${icon('pen')} فتح` : `${icon('lock')} عرض`}</button>
          <button class="btn small" data-print="${o.id}" title="تصدير PDF ومشاركته">${icon('file')} PDF</button>
          ${canSeeCosts() ? `<button class="btn small ${cost === null ? 'cost-cta' : ''}" data-cost="${o.id}" title="تكلفة كل صنف وصافي الربح">${icon('wallet')} ${cost === null ? 'إضافة التكاليف' : 'تعديل التكاليف'}</button>` : ''}
          ${isAdmin() ? `<button class="btn small" data-owner="${o.id}" title="نقل ملكية الطلب">${icon('swap')}</button>` : ''}
          ${isAdmin() ? `<button class="btn small danger" data-delo="${o.id}" title="حذف">${icon('trash')}</button>` : ''}
        </td>
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
    $$('[data-owner]', tb).forEach((b) => b.addEventListener('click', () => transferOwner(find(b.dataset.owner))));
    $$('[data-delo]', tb).forEach((b) => b.addEventListener('click', async () => {
      const o = find(b.dataset.delo);
      if (!(await confirmDlg('حذف الطلب', `حذف الطلب #${o.number} للعميل ${o.customer?.name}؟ لا يمكن التراجع.`))) return;
      db().orders = db().orders.filter((x) => x.id !== o.id);
      logActivity('delete', o, [`الإجمالي ${fmt(o.total)}`, `الحالة ${STATUS[o.status] || o.status}`]);
      if (!(await Store.save())) { toast('فشل الحذف على الخادم: ' + Store.lastError, true); await Store.refresh().catch(() => {}); renderOrders(); return; }
      if (cur.id === o.id) startNewOrder(true);
      renderOrders();
      renderNotifications();
      toast('تم حذف الطلب');
    }));
    $$('select[data-st]', tb).forEach((s) => s.addEventListener('change', async () => {
      const o = find(s.dataset.st);
      const oldSt = o.status;
      o.status = s.value; o.updatedAt = Store.now(); o.updatedByName = currentUser.name;
      o.statusAt = o.updatedAt; o.statusByName = currentUser.name;
      logActivity('status', o, [`الحالة: من ${STATUS[oldSt] || oldSt} إلى ${STATUS[o.status]}`]);
      if (!(await Store.save())) { toast('فشل الحفظ على الخادم: ' + Store.lastError, true); return; }
      if (cur.id === o.id) { cur.status = o.status; cur.statusAt = o.statusAt; cur.statusByName = o.statusByName; $('#orderStatus').value = o.status; syncStatusChip(); }
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
      <p>الطلب <b>#${o.number}</b> للعميل <b>${esc(o.customer?.name || '—')}</b></p>
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
        o.createdBy = u.id; o.createdByName = u.name;
        o.updatedAt = Store.now(); o.updatedByName = currentUser.name;
        logActivity('owner', o, [`الملكية: من ${from} إلى ${u.name}`]);
        if (!(await Store.save())) { $('#ownErr', b).textContent = 'فشل الحفظ: ' + Store.lastError; return; }
        if (cur.id === o.id) { cur.createdBy = o.createdBy; cur.createdByName = o.createdByName; readOnly = !canEditOrder(cur); setOrderOwnerLabel(cur); applyOrderLock(); renderOrderMeta(); }
        closeModal(); renderOrders();
        toast(`نُقلت ملكية الطلب #${o.number} إلى ${u.name}`);
      };
    });
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
      <p class="hint">العميل <b>${esc(o.customer?.name || '—')}</b> • المجموع ${fmt(o.total)} ${cur$} • ${STATUS[o.status] || o.status}${o.costUpdatedByName ? ` • آخر تعديل للتكاليف: ${esc(o.costUpdatedByName)} ${fmtDateTime(o.costUpdatedAt)}` : ''}</p>
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
        return Number.isFinite(v) && v >= 0 ? Math.round(v) : NaN;
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
        const profit = money(info.subtotal - costTotal);
        const margin = info.subtotal > 0 ? r2((profit / info.subtotal) * 100) : 0;
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
          $('#costErr', b).textContent = 'فشل الحفظ: ' + Store.lastError;
          return;
        }
        // مزامنة الطلب المفتوح في صفحة التصميم إن كان نفسه
        if (cur.id === o.id) {
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
    }, 'wide');
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

  /* ---------------- صفحة الأصناف ---------------- */
  function catLabel(cat) {
    if (cat === 'sofa') return 'كنب';
    if (cat === 'acc') return 'إكسسوار';
    const s = SPECS.find((x) => x.cat === cat);
    return s ? s.label : cat;
  }
  function renderItems() {
    const tb = $('#itemsTable tbody');
    const all = db().items.slice().sort((a, b) => (a.category > b.category ? 1 : a.category < b.category ? -1 : a.name.localeCompare(b.name, 'ar')));
    const items = all.slice(0, itemsShown);
    tb.innerHTML = items.map((i) => `
      <tr style="${i.active === false ? 'opacity:.55' : ''}">
        <td data-label="الصنف" class="span2"><b>${esc(i.name)}</b></td>
        <td data-label="الفئة">${catLabel(i.category)}</td>
        <td data-label="ملاحظة">${i.category === 'sofa' ? '<span class="hint">فئة قديمة</span>' : '—'}</td>
        <td data-label="الوحدة">${i.category === 'acc' ? 'قطعة' : 'متر'}</td>
        <td data-label="السعر" class="num">${fmt(i.price)} ${currency()}</td>
        <td data-label="الأبعاد الافتراضية" class="num">${i.category === 'acc' ? `${i.w || 0.5} × ${i.h || 0.5} م ${i.shape === 'circle' ? '(دائري)' : ''}` : (i.category === 'wood' || i.category === 'sofa' ? `عمق ${i.depth || 0.8} م` : '—')}</td>
        <td data-label="اللون"><span class="color-dot" style="background:${esc(i.color || '#888')}"></span></td>
        <td data-label="الحالة"><span class="badge ${i.active === false ? '' : 'st-delivered'}">${i.active === false ? 'موقوف' : 'نشط'}</span></td>
        <td class="row-actions">
          <button class="btn small" data-edit="${i.id}">${icon('pen')} تعديل</button>
          <button class="btn small" data-toggle="${i.id}">${i.active === false ? 'تفعيل' : 'إيقاف'}</button>
          <button class="btn small danger" data-del="${i.id}">${icon('trash')}</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">لا توجد أصناف</td></tr>';

    renderMoreBar($('#itemsMore'), items.length, all.length, () => { itemsShown += PAGE_STEP; renderItems(); });

    $$('[data-edit]', tb).forEach((b) => b.addEventListener('click', () => itemForm(Store.getItem(b.dataset.edit))));
    $$('[data-toggle]', tb).forEach((b) => b.addEventListener('click', async () => {
      const it = Store.getItem(b.dataset.toggle);
      it.active = it.active === false;
      if (!(await Store.save())) toast('فشل الحفظ على الخادم: ' + Store.lastError, true);
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
      if (!(await Store.save())) { toast('فشل الحذف على الخادم: ' + Store.lastError, true); await Store.refresh().catch(() => {}); afterItemsChange(); return; }
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

  function itemForm(item) {
    const it = item || { name: '', category: 'wood', price: 0, depth: 0.8, w: 0.5, h: 0.5, shape: 'rect', color: '#8b5a2b', active: true };
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
        if (!(await Store.save())) { $('#fErr', b).textContent = 'فشل الحفظ على الخادم: ' + Store.lastError; return; }
        closeModal(); afterItemsChange();
        toast('تم حفظ الصنف');
      };
    });
  }
  $('#btnAddItem').addEventListener('click', () => itemForm(null));

  /* ---------------- صفحة المستخدمين ---------------- */
  function renderUsers() {
    const tb = $('#usersTable tbody');
    tb.innerHTML = db().users.map((u) => `
      <tr style="${u.active === false ? 'opacity:.55' : ''}">
        <td data-label="الاسم"><b>${esc(u.name)}</b>${u.id === currentUser.id ? ' <span class="badge">أنت</span>' : ''}</td>
        <td data-label="اسم المستخدم" class="num">${esc(u.username)}</td>
        <td data-label="الدور">${ROLES[u.role] || u.role}</td>
        <td data-label="الحالة"><span class="badge ${u.active === false ? '' : 'st-delivered'}">${u.active === false ? 'موقوف' : 'نشط'}</span></td>
        <td data-label="عدد الطلبات" class="num">${db().orders.filter((o) => o.createdBy === u.id).length}</td>
        <td class="row-actions">
          <button class="btn small" data-edit="${u.id}">${icon('pen')} تعديل</button>
          ${u.id !== currentUser.id ? `<button class="btn small danger" data-del="${u.id}">${icon('trash')}</button>` : ''}
        </td>
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
        <label>اسم المستخدم <input id="uUser" value="${esc(u.username)}" autocomplete="off" style="direction:ltr"></label>
        <label>${user ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور'} <input id="uPass" type="password" autocomplete="new-password"></label>
      </div>
      <div class="row2">
        <label>الدور <select id="uRole"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>موظف</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مدير</option></select></label>
        <label>الحالة <select id="uActive"><option value="1" ${u.active !== false ? 'selected' : ''}>نشط</option><option value="0" ${u.active === false ? 'selected' : ''}>موقوف</option></select></label>
      </div>
      <p class="hint">المدير يستطيع إدارة الأصناف والمستخدمين وحذف الطلبات. الموظف يستطيع إنشاء الطلبات وتعديلها واستعراضها.</p>
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
    });
  }
  $('#btnAddUser').addEventListener('click', () => userForm(null));

  /* ---------------- سجل تحديثات الطلبات (مدير) ---------------- */
  const ACTIONS = { create: 'إنشاء طلب', update: 'تعديل طلب', status: 'تغيير الحالة', cost: 'تعديل التكاليف', owner: 'نقل الملكية', export: 'تصدير PDF', delete: 'حذف طلب' };
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
    userSel.innerHTML = '<option value="">كل الموظفين</option>' + [...names.entries()].map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
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
      <div class="stat"><span>الأكثر نشاطاً</span><b style="font-size:1rem;direction:rtl;text-align:right">${top ? esc(top[0]) : '—'}</b>${top ? `<small>${top[1]} تحديث</small>` : ''}</div>
      <div class="stat"><span>آخر تحديث</span><b style="font-size:1rem;direction:rtl;text-align:right">${last ? esc(last.userName || '—') : '—'}</b>${last ? `<small>${fmtDateTime(last.at)}</small>` : ''}</div>`;

    const list = filteredActivity();
    const tb = $('#actTable tbody');
    $('#actEmpty').hidden = list.length > 0;
    tb.innerHTML = list.slice(0, 500).map((e) => {
      const exists = db().orders.some((o) => o.id === e.orderId);
      const orderCell = e.orderNo
        ? (exists ? `<button class="link-btn" data-open="${esc(e.orderId)}">#${e.orderNo}</button>` : `<span title="الطلب محذوف">#${e.orderNo}</span>`)
        : 'مسودة';
      return `
      <tr>
        <td data-label="الوقت" class="act-time num">${localDate(e.at)}<small>${localTime(e.at)}</small></td>
        <td data-label="الموظف"><b>${esc(e.userName || '—')}</b></td>
        <td data-label="الطلب">${orderCell}</td>
        <td data-label="العميل">${esc(e.customer || '—')}</td>
        <td data-label="الإجراء"><span class="badge ${ACTION_CLASS[e.action] || ''}">${ACTIONS[e.action] || e.action}</span></td>
        <td data-label="التفاصيل" class="span2">${(e.details || []).map((d) => `<span class="chg">${esc(d)}</span>`).join('') || '<span class="hint">—</span>'}</td>
      </tr>`;
    }).join('');
    if (list.length > 500) tb.insertAdjacentHTML('beforeend', `<tr><td colspan="6" class="hint" style="text-align:center">يُعرض أول 500 من ${list.length} تحديث. استخدم الفلاتر أو صدّر CSV للكل.</td></tr>`);
    $$('[data-open]', tb).forEach((b) => b.addEventListener('click', async () => {
      const o = db().orders.find((x) => x.id === b.dataset.open);
      if (!o) return;
      if (dirty && !(await confirmDlg('فتح طلب', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) return;
      loadOrder(o);
    }));
  }
  ['actSearch', 'actUser', 'actType', 'actFrom', 'actTo'].forEach((id) => $('#' + id).addEventListener(id === 'actSearch' ? 'input' : 'change', renderActivity));

  $('#btnActCsv').addEventListener('click', () => {
    const list = filteredActivity();
    if (!list.length) { toast('لا توجد بيانات للتصدير', true); return; }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['التاريخ', 'الوقت', 'الموظف', 'رقم الطلب', 'العميل', 'الإجراء', 'التفاصيل'].map(cell).join(',')];
    list.forEach((e) => rows.push([localDate(e.at), localTime(e.at), e.userName || '', e.orderNo || '', e.customer || '', ACTIONS[e.action] || e.action, (e.details || []).join(' | ')].map(cell).join(',')));
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `orders-activity-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('#btnActClear').addEventListener('click', async () => {
    if (!db().activity.length) return;
    if (!(await confirmDlg('مسح السجل', `سيتم حذف ${db().activity.length} تحديث من السجل نهائياً. الطلبات نفسها لن تتأثر. متابعة؟`))) return;
    db().activity = [];
    if (!(await Store.save())) { toast('فشل المسح على الخادم: ' + Store.lastError, true); await Store.refresh().catch(() => {}); renderActivity(); return; }
    renderActivity();
    toast('تم مسح السجل');
  });

  /* ---------------- الإعدادات والنسخ الاحتياطي ---------------- */
  $('#btnSettings').addEventListener('click', () => {
    const s = settings();
    openModal('الإعدادات والنسخ الاحتياطي', `
      <label>اسم المحل (يظهر في الفاتورة) <input id="sName" value="${esc(s.shopName || '')}"></label>
      <div class="row2">
        <label>الجوال <input id="sPhone" value="${esc(s.phone || '')}"></label>
        <label>العملة <input id="sCur" value="${esc(s.currency || 'ر.س')}"></label>
      </div>
      <label>العنوان <input id="sAddr" value="${esc(s.address || '')}"></label>
      <label>شروط تظهر في الفاتورة (اختياري) <input id="sInvNote" value="${esc(s.invoiceNote || '')}" placeholder="مثال: العربون غير مسترد، مدة التنفيذ 10 أيام"></label>
      <div class="row2">
        <label>الرقم الضريبي (يظهر في الفاتورة) <input id="sVatNo" value="${esc(s.vatNumber || '')}" style="direction:ltr"></label>
        <label>نسبة ضريبة القيمة المضافة % <input id="sVatRate" type="number" min="0" max="100" step="0.5" value="${num(s.vatRate ?? 15)}"></label>
      </div>
      <label class="inline-check" style="margin-bottom:12px"><input id="sVatOn" type="checkbox" ${s.vatEnabled !== false ? 'checked' : ''}> تفعيل الضريبة افتراضياً في الطلبات الجديدة (يمكن إلغاؤها لكل طلب)</label>
      <label>طريقة قياس الكنب الافتراضية للطلبات الجديدة
        <select id="sCorner"><option value="deduct" ${s.cornerMode !== 'full' ? 'selected' : ''}>بدون تكرار الزوايا (موصى به)</option><option value="full" ${s.cornerMode === 'full' ? 'selected' : ''}>بطول الجدار كامل (الزاوية تُحسب مرتين)</option></select>
      </label>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn primary" id="sSave">${icon('check')} حفظ الإعدادات</button></div>
      <hr>
      <h3>النسخ الاحتياطي</h3>
      <p class="hint"><b>وضع التخزين:</b> ${Store.isRemote ? 'سحابي (Cloudflare Worker + D1) — الطلبات مشتركة بين كل الأجهزة والموظفين، وتتزامن كل 30 ثانية.' : 'محلي — البيانات محفوظة في هذا المتصفح على هذا الجهاز فقط. لمشاركة الطلبات بين عدة أجهزة راجع ملف SETUP-CLOUDFLARE.md.'} صدّر نسخة احتياطية بانتظام واحتفظ بها في مكان آمن.</p>
      <div class="btn-row" style="justify-content:flex-start">
        <button class="btn" id="sExport">${icon('download')} تصدير نسخة (JSON)</button>
        <label class="btn" style="display:inline-flex;margin:0">${icon('upload')} استيراد نسخة <input id="sImport" type="file" accept="application/json,.json" hidden></label>
        <button class="btn danger" id="sReset" ${Store.isRemote ? 'disabled title="في الوضع السحابي تُمسح البيانات من لوحة Cloudflare (D1)"' : ''}>${icon('trash')} مسح كل البيانات</button>
      </div>
      <p class="hint" style="margin-top:8px">الطلبات: ${db().orders.length} • الأصناف: ${db().items.length} • المستخدمون: ${db().users.length}</p>`, (b) => {
      $('#sSave', b).onclick = async () => {
        // يُقرأ كائن الإعدادات الآن لا عند فتح النافذة: أي مزامنة تستبدله بكائن جديد
        const s = settings();
        Object.assign(s, {
          shopName: $('#sName', b).value.trim(), phone: $('#sPhone', b).value.trim(), address: $('#sAddr', b).value.trim(),
          currency: $('#sCur', b).value.trim() || 'ر.س', invoiceNote: $('#sInvNote', b).value.trim(), cornerMode: $('#sCorner', b).value, cornerModeChosen: true,
          vatNumber: $('#sVatNo', b).value.trim(), vatRate: Math.min(100, Math.max(0, num($('#sVatRate', b).value))), vatEnabled: $('#sVatOn', b).checked,
        });
        if (!(await Store.save())) { toast('فشل الحفظ على الخادم: ' + Store.lastError, true); return; }
        applyPermissions(); renderItemSelects(); renderPricing(); closeModal(); toast('تم حفظ الإعدادات');
      };
      $('#sExport', b).onclick = () => {
        const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `majlis-backup-${today()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
      $('#sImport', b).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (!(await confirmDlg('استيراد نسخة', 'سيتم استبدال كل البيانات الحالية بمحتوى الملف. متابعة؟'))) return;
        try {
          await Store.importJSON(await f.text());
          currentUser = Store.getUser(currentUser.id) || currentUser;
          closeModal(); applyPermissions(); renderItemSelects(); startNewOrder(true); showPage('orders');
          toast(Store.isRemote ? 'تم استيراد الأصناف والطلبات والإعدادات والسجل (المستخدمون لا يُستوردون في الوضع السحابي)' : 'تم استيراد البيانات');
        } catch (err) { toast('فشل الاستيراد: ' + err.message, true); }
      });
      $('#sReset', b).onclick = async () => {
        if (!(await confirmDlg('مسح البيانات', 'سيتم حذف كل الطلبات والأصناف والمستخدمين نهائياً وإعادة النظام لحالته الأولى. هل أنت متأكد؟'))) return;
        try { await Store.reset(); await Store.logout(); location.reload(); }
        catch (e) { toast(e.message, true); }
      };
    });
  });

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
  const NOTIF_ICON = { create: 'plus', progress: 'rotate', done: 'check', delivered: 'pin', due: 'calendar' };
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
          title: `طلب جديد #${o.number}`,
          text: `${who} • ${fmt(o.total)} ${cur$}${o.createdByName ? ` • بواسطة ${o.createdByName}` : ''}`,
        });
      }

      // 2) المرحلة الحالية. الطلب يحمل حالته لا تاريخها، فيظهر آخر انتقال فقط —
      //    وهو المطلوب في مركز التنبيهات: أين يقف الطلب الآن.
      const stAt = o.statusAt || o.updatedAt;
      if (NOTIF_ICON[o.status] && stAt && new Date(stAt).getTime() >= cutoff) {
        const titles = { progress: 'بدأ تنفيذه', done: 'اكتمل تنفيذه', delivered: 'تم توصيله' };
        out.push({
          id: `st:${o.id}:${o.status}:${stAt}`, kind: o.status, at: stAt, orderId: o.id, orderNo: o.number,
          title: `الطلب #${o.number} ${titles[o.status]}`,
          text: `${who}${o.statusByName ? ` • بواسطة ${o.statusByName}` : ''}`,
        });
      }

      // 3) تذكير قبل موعد التوصيل بثلاثة أيام (ويبقى ظاهراً إن فات الموعد ولم يُسلَّم)
      if (o.deliveryDate && o.status !== 'delivered' && o.status !== 'cancelled') {
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
    const o = db().orders.find((x) => x.id === oid);
    if (!o) { toast('هذا الطلب لم يعد موجوداً', true); renderNotifications(); return; }
    closeNotifPanel();
    if (dirty && !(await confirmDlg('فتح طلب', 'سيتم تجاهل التغييرات غير المحفوظة في الطلب الحالي. متابعة؟'))) { renderNotifications(); return; }
    loadOrder(o);
    renderNotifications();
  }

  function onNotifOutside(e) {
    const t = e.target;
    if (t && t.closest && t.closest('.notif-wrap')) return;
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

  /* ---------------- المزامنة مع الخادم (الوضع السحابي) ---------------- */
  let syncing = false;
  async function syncFromServer() {
    if (!Store.isRemote || syncing || !currentUser || $('#app').hidden) return;
    // نافذة منبثقة مفتوحة (إعدادات، صنف، تكاليف): المزامنة تستبدل كائنات البيانات
    // فتصير المراجع التي التقطتها النافذة يتيمة ويضيع ما يُحفظ. تُؤجَّل حتى تُغلق.
    if (!$('#modal').hidden) return;
    if (!navigator.onLine) { setNetState('off'); return; }
    syncing = true;
    setNetState('sync');
    try {
      const before = cur.id ? db().orders.find((o) => o.id === cur.id) : null;
      const beforeUpdated = before ? before.updatedAt : null;
      await Store.refresh();
      const active = ($('.page.active') || {}).id || '';
      if (active === 'page-orders') renderOrders();
      else if (active === 'page-activity') renderActivity();
      else if (active === 'page-items') renderItems();
      else if (active === 'page-users') renderUsers();
      renderItemSelects();
      applyPermissions();
      renderNotifications();
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
      setNetState('ok');
    } catch (e) {
      // كان هذا صامتاً تماماً: الموظف يظنّ أنه على أحدث البيانات وهو على لقطة قديمة
      console.warn('sync failed', e);
      setNetState(e && e.offline ? 'off' : 'err');
    } finally {
      syncing = false;
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
  let canvasEditing = false;
  function setCanvasEditing(editing) {
    canvasEditing = editing;
    const touchLayout = isMobile() || isCoarse;
    designer.scrollTouch = touchLayout && !editing;
    designer.canvas.style.touchAction = designer.scrollTouch ? 'pan-y pinch-zoom' : 'none';
    $('#btnCanvasMode').setAttribute('aria-pressed', String(editing));
    $('#btnCanvasMode').textContent = editing ? 'إنهاء التحرير' : 'تحرير المخطط';
    $('#canvasModeHint').textContent = editing ? 'اسحب القطع • كبّر المخطط بإصبعين' : 'اسحب بإصبعك لتمرير الصفحة';
    $('.canvas-wrap').classList.toggle('editing', editing);
    if (!editing) designer.select(null);
  }
  $('#btnCanvasMode').addEventListener('click', () => setCanvasEditing(!canvasEditing));
  window.addEventListener('resize', () => setCanvasEditing(canvasEditing));
  prepareControls();
  setCanvasEditing(false);
  $$('#panelTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('active'))));
  const stepLinks = $$('#stepNav a');
  function trackStep() {
    if ($('#app').hidden || !$('#page-order').classList.contains('active')) return;
    const threshold = isMobile() ? 180 : 230;
    let selected = stepLinks[0];
    for (const link of stepLinks) if ($(link.getAttribute('href')).getBoundingClientRect().top <= threshold) selected = link;
    stepLinks.forEach(link => {
      link.classList.toggle('active', link === selected);
      if (link === selected) link.setAttribute('aria-current', 'step'); else link.removeAttribute('aria-current');
    });
  }
  let stepFrame;
  window.addEventListener('scroll', () => { if (!stepFrame) stepFrame = requestAnimationFrame(() => { trackStep(); stepFrame = null; }); }, {passive:true});
  trackStep();

  /* ---------------- التشغيل ---------------- */
  window.MajlisApp = { designer, get order() { return cur; }, computeLines, syncFromServer };
  window.addEventListener('resize', () => { syncMobileSheet(); positionInspector(); });
  renderItemSelects();
  fillOrderForm();
  // انتهاء الجلسة على الخادم (الوضع السحابي): العودة لشاشة الدخول
  Store.onSessionLost = () => {
    if ($('#app').hidden) return;
    currentUser = null;
    closeNotifPanel();
    resetNotifState();
    $('#app').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginError').textContent = 'انتهت الجلسة. سجّل الدخول مجدداً.';
  };
  const su = await Store.restoreSession();
  if (su) enterApp(su);
  else {
    $('#loginUser').focus();
    if (Store.isRemote && Store.lastError) $('#loginError').textContent = Store.lastError;
  }
})();
