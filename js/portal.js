/* ======================================================================
   بوابة العميل: مصمم مجالس عام بلا دخول (صفحة portal.html المستقلة).
   - نفس الأصل: لا config ولا جلسة موظف. التوكن في localStorage فقط.
   - يعيد استخدام محرك js/designer.js كما هو (قراءة/كتابة الحالة فقط).
   - لا أسعار ولا تكاليف ولا بيانات موظفين تصل هذه الصفحة أبداً.
   ====================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.from((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var TOKEN_KEY = 'majlis_design_token';

  var toastTimer = 0;
  function toast(msg, err) {
    var t = $('#pToast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, err ? 5000 : 2800);
  }

  /* ---------------- عميل API (نفس الأصل) ---------------- */
  var apiToken = '';
  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['x-design-token'] = apiToken;
    var res = await fetch('/api/portal' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    var data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      var e = new Error((data && data.error) || ('خطأ ' + res.status));
      e.status = res.status;
      throw e;
    }
    return data || {};
  }

  function safeHref(u) {
    var s = String(u || '').trim();
    if (!/^https:\/\//i.test(s) || /[\s<>"]/.test(s)) return '';
    return s;
  }
  function digits(v) { return String(v || '').replace(/[^\d]/g, ''); }

  /* ---------------- الحالة ---------------- */
  var S = {
    settings: null, catalog: [], catMap: {},
    design: null, meta: null, designer: null,
    step: 'room', dirty: false, saveTimer: 0, saving: false,
    dragHide: false,   // أثناء سحب باللمس: لا تُفتح ورقة الخصائص (تحجب المخطط)
  };

  /* المراحل الخمس. lead = شرح مختصر يظهر تحت العنوان، next = نص زر «التالي».
     bureaucracy: كل مرحلة تعرض خياراتها فقط + الرسم + زر التالي. */
  var STEPS = [
    { id: 'room', label: 'الغرفة', title: 'الغرفة',
      lead: 'اكتب عرض الغرفة وطولها بالمتر، وسيتغيّر الرسم أمامك مباشرة.',
      hint: 'حدد عرض وطول الغرفة فقط — نتكفّل بالباقي.', next: 'التالي → العناصر المعمارية' },
    { id: 'openings', label: 'العناصر المعمارية', title: 'العناصر المعمارية',
      lead: 'اختر الجدار أولاً ثم أضف الباب أو المشب عليه.',
      hint: 'أضف بابًا أو مشبًا على الجدار الذي تريد.', next: 'التالي → المجلس' },
    { id: 'majlis', label: 'المجلس', title: 'المجلس',
      lead: 'اختر نوع الجلسة المناسب لغرفتك، وسيُطبَّق على كل كنبة.',
      hint: 'اختر نوع المجلس — يُستخدم مع كل كنبة جديدة.', next: 'التالي → الأثاث والإكسسوارات' },
    { id: 'furn', label: 'الأثاث والإكسسوارات', title: 'الأثاث والإكسسوارات',
      lead: 'أضف الكنب والإكسسوارات، ثم المس أي قطعة لتعديلها أو حذفها.',
      hint: 'اختر العنصر لإضافته، ثم المسه لتعديله أو حذفه.', next: 'التالي → المراجعة' },
    { id: 'review', label: 'المراجعة', title: 'المراجعة',
      lead: 'شاهد تصميمك، ثم أنهِ الطلب ليصل إلى المحل.',
      hint: 'راجع التصميم وأنهِ الطلب: بياناتك اختيارية.', next: '' },
  ];
  var STEP_INDEX = {};
  STEPS.forEach(function (s, i) { STEP_INDEX[s.id] = i; });
  function stepAt(i) { return STEPS[Math.max(0, Math.min(STEPS.length - 1, i))]; }

  /* أنواع المجلس (تسميات عرض فقط — تُحفظ كرموز ثابتة في القطعة) */
  var SEATING = { floor: 'جلسة أرضية', sofa: 'جلسة كنب', arabic: 'جلسة عربية', raised: 'جلسة مرتفعة' };
  var SEAT_KEY = 'majlis_seating';
  function getSeating() {
    try {
      var v = localStorage.getItem(SEAT_KEY);
      if (v && SEATING[v]) return v;
    } catch (_) { /* noop */ }
    return 'floor';
  }
  function setSeating(v) {
    if (!SEATING[v]) return;
    try { localStorage.setItem(SEAT_KEY, v); } catch (_) { /* noop */ }
  }

  function show(view) {
    ['pLanding', 'pDesign', 'pDone', 'pLook'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = id !== view;
    });
    window.scrollTo(0, 0);
  }

  /* ---------------- الإقلاع والتوجيه ---------------- */
  async function boot() {
    var m = window.location.pathname.match(/^\/customer-design\/view\/([A-Za-z0-9-]+)\/?$/);
    var qn = new URLSearchParams(window.location.search).get('n');
    try {
      var st = await api('/settings');
      S.settings = st.settings || {};
    } catch (e) { S.settings = {}; }
    paintLanding();
    if (m || qn) { await bootLook(m ? m[1] : qn); return; }
    var t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch (_) { /* noop */ }
    if (t && /^[0-9a-f]{64}$/.test(t)) {
      apiToken = t;
      try {
        var g = await api('/design');
        if (g && g.design) { $('#pResume').hidden = false; }
      } catch (_) { apiToken = ''; try { localStorage.removeItem(TOKEN_KEY); } catch (__) { /* noop */ } }
    }
    show('pLanding');
  }

  /* ---------------- الترحيب والتسويق (من الإعدادات فقط، بلا hard-code) ---------------- */
  function paintLanding() {
    var s = S.settings || {};
    $('#pShopName').textContent = s.shopName || 'أصالة نجد';
    var logo = $('#pLogo'), fb = $('#pLogoFallback');
    if (s.logoUrl && logo) { logo.src = s.logoUrl; logo.hidden = false; if (fb) fb.hidden = true; }
    else { if (logo) logo.hidden = true; if (fb) fb.hidden = false; }
    document.title = 'صمّم مجلسك | ' + (s.shopName || 'أصالة نجد');
    if (s.tagline) $('#pTagline').textContent = s.tagline;
    var waNum = digits(s.whatsapp) || '';
    var waHref = safeHref(s.whatsapp) || (digits(s.phone) ? 'https://wa.me/' + digits(s.phone) : '');
    var links = [
      ['plMaps', safeHref(s.mapsUrl), null],
      ['plTiktok', safeHref(s.tiktok), null],
      ['plInsta', safeHref(s.instagram), null],
      ['plSnap', safeHref(s.snapchat), null],
      ['plWa', waHref || (waNum ? 'https://wa.me/' + waNum : ''), null],
      ['plPhone', digits(s.phone) ? 'tel:+' + digits(s.phone).replace(/^00/, '') : '', 'tel'],
    ];
    links.forEach(function (L) {
      var el = document.getElementById(L[0]);
      if (!el) return;
      var href = L[1];
      if (L[2] === 'tel') {
        if (!href) { el.style.display = 'none'; return; }
        el.href = href;
        return;
      }
      if (!href) { el.style.display = 'none'; return; }
      el.href = href;
    });
  }

  $('#pStart').addEventListener('click', startNew);
  $('#pResume').addEventListener('click', resume);
  $('#pLookStart').addEventListener('click', function () { window.location.href = '/customer-design'; });
  $('#pNewDesign').addEventListener('click', startNew);

  async function startNew() {
    setBusy($('#pStart'), true);
    try {
      var r = await api('/session', { method: 'POST', body: {} });
      apiToken = r.token;
      try { localStorage.setItem(TOKEN_KEY, r.token); } catch (_) { /* noop */ }
      S.meta = { number: null, status: 'draft' };
      await loadCatalog();
      enterDesign(null);
    } catch (e) {
      toast(e.message || 'تعذّر بدء التصميم. تحقق من الاتصال.', true);
    } finally {
      setBusy($('#pStart'), false);
    }
  }

  async function resume() {
    try {
      await loadCatalog();
      var g = await api('/design');
      enterDesign(g.design);
      if (g.number) { S.meta = { number: g.number, status: g.status }; }
      S.cust = { name: g.name || '', phone: g.phone || '' };
    } catch (e) {
      toast(e.message || 'تعذّر فتح التصميم السابق.', true);
    }
  }

  function setBusy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  async function loadCatalog() {
    if (S.catalog.length) return;
    var c = await api('/catalog');
    S.catalog = Array.isArray(c.items) ? c.items : [];
    S.catMap = {};
    S.catalog.forEach(function (i) { S.catMap[i.id] = i; });
  }

  function catItems(cat) {
    return S.catalog.filter(function (i) { return i.category === cat; });
  }

  /* ---------------- المصمم (إعادة استخدام المحرك) ---------------- */
  function getCatItem(id) {
    var i = S.catMap[id];
    if (!i) return { id: id, name: 'صنف', price: 0 };
    return { id: i.id, name: i.name, price: 0, color: i.color, fabric: i.fabric, depth: i.depth, w: i.w, h: i.h, shape: i.shape, category: i.category };
  }

  function pieceLabel(p) {
    if (p.kind === 'acc') { var a = S.catMap[p.itemId]; return a ? a.name : 'إكسسوار'; }
    if (p.kind === 'free') return 'مساحة أرضية';
    if (p.kind === 'column') return 'عامود';
    var bits = [SEATING[p.seating] || SEATING.floor];
    ['fabricId', 'foamId'].forEach(function (f) {
      var it = S.catMap[p[f]];
      if (it) bits.push(it.name);
    });
    return bits.join(' + ');
  }

  function portalUid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  /* ---------------- الكمية الحقيقية للإكسسوار ----------------
     الكمية = عدد نسخ حقيقية في البيانات (مجموعة qg واحدة)، لا label شكلي.
     تُحفظ مع التصميم وتُسترجع وتُحتسب في PDF والتسعير اللاحق. */
  function accGroup(p) {
    if (!p || p.kind !== 'acc') return [p];
    var dz = S.designer;
    var gid = p.qg;
    var all = (dz.state.pieces || []).filter(function (x) { return x.kind === 'acc' && x.itemId === p.itemId; });
    if (!gid) return [p];
    var g = all.filter(function (x) { return x.qg === gid; });
    return g.length ? g : [p];
  }

  function accQtyOf(p) {
    return accGroup(p).length;
  }

  function accDims(itemId) {
    var it = S.catMap[itemId] || {};
    return { w: Math.max(0.2, Number(it.w) || 0.5), h: Math.max(0.2, Number(it.h) || 0.5), shape: it.shape || 'rect' };
  }

  function accName(itemId) {
    var it = S.catMap[itemId];
    return it ? it.name : 'القطعة';
  }

  /* توزيع ذكي: يضع النسخ داخل الغرفة مع تجنب الأعمدة والجدران والقطع.
     يعيد {placed, requested} — ولا يُخرج شيئاً خارج الغرفة أبداً. */
  function placeAccCopies(keep, need) {
    var dz = S.designer;
    if (need <= 0) return { placed: 0, requested: 0 };
    var d = accDims(keep.itemId);
    var spots = dz.findSpots(d.w, d.h, need, 'acc');
    var gid = keep.qg || portalUid();
    keep.qg = gid;
    spots.forEach(function (s) {
      dz.state.pieces.push({
        id: portalUid(), kind: 'acc', itemId: keep.itemId,
        x: s.x, y: s.y, w: d.w, h: d.h, rot: 0, shape: d.shape, qg: gid,
      });
    });
    dz.resetHistory();
    if (dz.opts && typeof dz.opts.onChange === 'function') dz.opts.onChange();
    dz.render();
    return { placed: spots.length, requested: need };
  }

  function setAccQty(p, n) {
    var dz = S.designer;
    n = Math.floor(Number(n));
    if (!Number.isFinite(n) || n < 1 || n > 99) throw new Error('الكمية من 1 إلى 99');
    var members = (dz.state.pieces || []).filter(function (x) { return x.kind === 'acc' && x.itemId === p.itemId && (x.qg || '') === (p.qg || ''); });
    if (!p.qg) members = (dz.state.pieces || []).filter(function (x) { return x.id === p.id; });
    // أبقِ المحددة نفسها (أو الأولى) وموضعها، واحذف الباقي من نفس المجموعة فقط
    var keep = members.filter(function (x) { return x.id === p.id; })[0] || members[0] || p;
    var gid = keep.qg || portalUid();
    keep.qg = gid;
    members.forEach(function (m) {
      if (m.id === keep.id) return;
      var i = dz.state.pieces.indexOf(m);
      if (i >= 0) dz.state.pieces.splice(i, 1);
    });
    // وزّع الناقص بذكاء داخل الغرفة
    var r = placeAccCopies(keep, n - 1);
    var placed = 1 + r.placed;
    if (placed < n) {
      toast('المساحة المتاحة لا تكفي لـ ' + n + ' ' + accName(p.itemId) + '، تم وضع ' + placed + '. يمكنك تعديل التوزيع يدويًا.', true);
    }
    dz.select({ type: 'piece', id: keep.id });
    renderSheet(dz.selectionInfo());
    return placed;
  }

  function portalAddAcc(itemId) {
    var dz = S.designer;
    var it = S.catMap[itemId];
    if (!dz || !it) return null;
    var d = accDims(itemId);
    var spots = dz.findSpots(d.w, d.h, 1, 'acc');
    if (!spots.length) { toast('لا توجد مساحة مناسبة داخل الغرفة', true); return null; }
    var gid = portalUid();
    var added = dz.addPiece({
      kind: 'acc', itemId: it.id, x: spots[0].x, y: spots[0].y,
      w: d.w, h: d.h, rot: 0, shape: d.shape, qg: gid,
    });
    return added;
  }

  function enterDesign(design) {
    S.design = null;
    S.dirty = false;
    S.step = 'room';
    S.cust = S.cust || { name: '', phone: '' };
    show('pDesign');
    buildSteps();
    wireStatic();
    var dz = new Designer($('#pCanvas'), {
      getItem: getCatItem,
      onRevert: function (why) {
        toast(why === 'column' ? 'لا يمكن وضع العنصر فوق العامود' : 'يبقى العنصر داخل حدود الغرفة', true);
      },
      pieceSpecLabel: function () { return ''; },
      pieceStyle: function (p) {
        if (p.kind === 'acc') { var a = S.catMap[p.itemId]; return a ? { name: a.name, color: a.color } : null; }
        var f = S.catMap[p.fabricId];
        return { name: pieceLabel(p), color: f && f.color ? f.color : '#8b5a2b' };
      },
      onChange: function () { markDirty(); },
      onSelect: function (info) { renderSheet(info); },
    });
    S.designer = dz;
    /* على اللمس: بمجرد بدء سحب القطعة تُخفى ورقة الخصائص حتى لا تحجب المخطط
       أثناء النقل. المحرك يُعيد onSelect في كل حركة، فالحجب يكون بعلامة
       (S.dragHide) لا بإخفاء مؤقت يُعاد فتحه في الإطار التالي. */
    dz.canvas.addEventListener('pointermove', function (e) {
      if (!e || e.pointerType !== 'touch') return;
      var d = dz.drag;
      if (!d || d.moved !== true) return;
      if (['move', 'resizeW', 'resizeH', 'rotate', 'opening'].indexOf(d.mode) < 0) return;
      S.dragHide = true;
      var sh = $('#pSheet');
      if (sh && !sh.hidden) { sh.hidden = true; sh.innerHTML = ''; sh.removeAttribute('data-compact'); }
    });
    dz.canvas.addEventListener('pointerup', function () { setTimeout(function () { S.dragHide = false; }, 0); });
    dz.canvas.addEventListener('pointercancel', function () { setTimeout(function () { S.dragHide = false; }, 0); });
    try { dz.setState(design || null); } catch (_) { dz.setState(null); }
    dz.fitView();
    renderPanel();
    renderNav();
    renderSheet(null);
  }

  function markDirty() {
    if (!apiToken) return;
    S.dirty = true;
    $('#pSaveState').textContent = 'يُحفظ…';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveDraft, 1500);
  }

  async function saveDraft() {
    if (!apiToken || S.saving || !S.designer) return;
    S.saving = true;
    try {
      var st = S.designer.getState();
      await api('/save', { method: 'POST', body: { design: st } });
      S.dirty = false;
      $('#pSaveState').textContent = 'محفوظ ✓';
    } catch (e) {
      $('#pSaveState').textContent = 'تعذّر الحفظ';
    } finally {
      S.saving = false;
    }
  }

  function buildSteps() {
    var box = $('#pSteps');
    box.innerHTML = STEPS.map(function (s, i) {
      return '<button type="button" data-step="' + s.id + '" class="' + (s.id === S.step ? 'active' : '') + '" aria-current="' + (s.id === S.step) + '"><i>' + (i + 1) + '</i><span>' + s.label + '</span></button>';
    }).join('');
    $$('button', box).forEach(function (b) {
      b.addEventListener('click', function () { gotoStep(b.dataset.step); });
    });
  }

  /* الانتقال بين المراحل: يحدّث المؤشر واللوحة والرسم وأزرار التالي/السابق.
     fitView بعد كل انتقال حتى يظهر الرسم كاملًا داخل الشاشة بلا نزول. */
  function gotoStep(id) {
    if (!STEP_INDEX.hasOwnProperty(id)) return;
    S.step = id;
    if (id !== 'openings') setChosenWall(null);
    buildSteps();
    renderPanel();
    renderNav();
    if (S.designer) { S.designer.autoFit = true; S.designer.fitView(); }
    renderSheet(null);
  }
  function stepMove(n) {
    var i = STEP_INDEX[S.step];
    var t = stepAt(i + n);
    if (t && t.id !== S.step) gotoStep(t.id);
  }

  /* شريط التنقل السفلي: «السابق» + «التالي» باسم المرحلة القادمة */
  function renderNav() {
    var i = STEP_INDEX[S.step];
    var cur = STEPS[i];
    var host = $('#pDesign');
    if (host) host.dataset.step = S.step;   // CSS يتكيّف مع المرحلة (بلا رسم حيّ في المراجعة)
    var prev = $('#pPrevStep'), next = $('#pNextStep');
    if (prev) prev.hidden = i <= 0;
    if (!next) return;
    if (!STEPS[i + 1]) {
      next.textContent = 'إنهاء التصميم ↓';
      next.classList.add('lg');
      return;
    }
    next.textContent = (cur && cur.next) || ('التالي → ' + STEPS[i + 1].title);
  }

  /* لا شريط أدوات عام: كل مرحلة تعرض أزرارها الخاصة — بلا تكرار ولا مفاهيم متداخلة */
  function wireStatic() {
    S.zoom = 100;
    /* أزرار التكبير/التصغير تعرض الغرفة كاملة داخل مساحة الرسم فقط —
       لا تغيّر أبعاد الغرفة إطلاقًا. الوسط = ملاءمة الشاشة. */
    var fitBtn = $('#pZoomFit');
    var zlabel = function () { if (fitBtn) fitBtn.title = 'ملاءمة الشاشة (' + S.zoom + '%)'; };
    $('#pZoomIn').onclick = function () { if (!S.designer) return; S.designer.zoomAt(1.25); S.zoom = Math.min(400, Math.round(S.zoom * 1.25)); zlabel(); };
    $('#pZoomOut').onclick = function () { if (!S.designer) return; S.designer.zoomAt(0.8); S.zoom = Math.max(25, Math.round(S.zoom / 1.25)); zlabel(); };
    fitBtn.onclick = function () { if (!S.designer) return; S.designer.fitView(); S.zoom = 100; zlabel(); };
    zlabel();
    $('#pUndo').onclick = function () { if (S.designer) S.designer.undo(); };
    $('#pBack').onclick = function () { show('pLanding'); };
    $('#pPrevStep').onclick = function () { stepMove(-1); };
    $('#pNextStep').onclick = function () {
      var nx = STEPS[STEP_INDEX[S.step] + 1];
      if (nx) gotoStep(nx.id);
    };
  }

  /* الجدار المستهدف للباب/المشب/الكنبة:
     1) ما اختاره العميل من قائمة «الجدار» (المرجع الأول — بلا مس الجدار)
     2) وإلا الجدار المحدد بالإصبع في المخطط
     3) وإلا جدار الكنبة/الفتحة المحددة، ثم الافتراضي (الأول) */
  var chosenWall = null;   // اختيار القائمة (step openings) — يبقى للخطوة كلها
  function setChosenWall(i) { chosenWall = (i === null || i === undefined) ? null : i; }
  function targetWall() {
    var dz = S.designer;
    if (!dz) return 0;
    var n = (dz.state && dz.state.walls || []).length || 1;
    if (chosenWall != null && chosenWall >= 0 && chosenWall < n) return chosenWall;
    var i = dz.selectedWallIndex();
    if (i >= 0) return i;
    var o = dz.selectedOpening();
    if (o) return o.wall;
    var p = dz.selectedPiece();
    if (p && p.wall != null) return p.wall;
    return 0;
  }

  /* تركيبة الكنبة: نوع المجلس (افتراضي أرضية دائماً) + قماش + إسفنج + عمق.
     لا تُطلب أي خطوة مسبقة من العميل. */
  function currentSpec() {
    var spec = {
      seating: getSeating(),
      depth: Math.max(0.3, parseFloat(($('#pfDepth') || {}).value) || 0.8),
    };
    [['fabricId', 'pfFabric'], ['foamId', 'pfFoam']].forEach(function (pair) {
      var el = document.getElementById(pair[1]);
      var id = el && el.value;
      if (id && S.catMap[id]) spec[pair[0]] = id;
    });
    return spec;
  }

  /* إضافة عنصر من مرحلته: باب أو مشب على الجدار المختار.
     لا «عامود» في واجهة العميل — يبقى في تطبيق الموظفين فقط. */
  function addOpeningOf(type) {
    var dz = S.designer;
    if (!dz) return;
    var p = dz.addOpening(targetWall(), type);
    if (!p) toast('لا توجد مساحة على هذا الجدار', true);
    else renderPanel();
  }

  function fillAll() {
    var dz = S.designer;
    if (!dz) return;
    var spec = currentSpec();
    var n = dz.fillAllWalls(spec);
    var kind = SEATING[spec.seating] || SEATING.floor;
    toast(n ? ('تم فرش ' + n + ' من ' + kind) : 'لا توجد مساحات فارغة على الجدران', n ? false : 'info');
  }

  /* ---------------- لوحات الخطوات ---------------- */
  function optList(items, val, emptyLabel) {
    return '<option value="">' + esc(emptyLabel || 'غير محدد') + '</option>'
      + items.map(function (i) { return '<option value="' + esc(i.id) + '"' + (i.id === val ? ' selected' : '') + '>' + esc(i.name) + '</option>'; }).join('');
  }

  /* أوصاف أنواع المجلس بلغة العميل — فرق واضح بلا مصطلحات */
  var SEAT_HELP = {
    floor: 'جلسة أرضية مباشرة على الأرض بدون كنب — تناسب المجالس المفتوحة.',
    sofa: 'جلسة كنب: مقاعد مرتفعة مع مسند وظهر.',
    arabic: 'جلسة عربية: مقاعد أرضية مع مسند جانبي وطاولة وسط.',
    raised: 'جلسة مرتفعة: دكان مرتفع مع مقاعد على الجانبين.',
  };
  function seatOptions(sel) {
    return Object.keys(SEATING).map(function (k) {
      return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + SEATING[k] + '</option>';
    }).join('');
  }
  function renderPanel() {
    var box = $('#pPanel');
    var dz = S.designer;
    var cur = null;
    STEPS.forEach(function (s) { if (s.id === S.step) cur = s; });
    var ttl = $('#pStepTitle');
    if (ttl && cur) {
      ttl.textContent = cur.title;
      /* شرح مختصر تحت العنوان — خطوة واحدة واضحة بلا مصطلحات */
      var old = $('#pStepLead');
      if (cur.lead) {
        if (!old) { old = document.createElement('p'); old.id = 'pStepLead'; old.className = 'p-step-lead'; ttl.after(old); }
        old.textContent = cur.lead;
        old.hidden = false;
      } else if (old) { old.hidden = true; }
    }
    if (!dz) { box.innerHTML = ''; return; }
    if (S.step === 'room') {
      var ws = (dz.state && dz.state.walls) || [];
      /* المرحلة ١ مبسّطة: العرض والطول فقط. لا قوائم أطوال الجدران ولا زر «إضافة جدار»
         — العميل لا يحتاج التحكم في كل جدار، والغرفة تتحدّد كاملة من المقاسين. */
      box.innerHTML = ''
        + '<div class="row2"><label>عرض الغرفة (متر)<input id="pfW" type="number" step="0.1" min="0.5" max="30" inputmode="decimal" value="' + (ws[0] ? ws[0].len : 5) + '"></label>'
        + '<label>طول الغرفة (متر)<input id="pfH" type="number" step="0.1" min="0.5" max="30" inputmode="decimal" value="' + (ws[1] ? ws[1].len : 4) + '"></label></div>'
        + '<p class="hint">يتغيّر الرسم مباشرة أثناء الكتابة — بلا زر ولا خطوة إضافية.</p>';
      /* تحديث حي: الكتابة تعدّل الجدارين الأولين مباشرة (يحافظ على الغرف
         المخصصة عبر setWallLength)، بلا زر تطبيق وبلا فقدان التركيز */
      var liveDim = function (idx, input) {
        var v = parseFloat(input.value);
        if (!Number.isFinite(v) || v < 0.5 || v > 30) return;
        dz.setWallLength(idx, Math.round(v * 10) / 10);
      };
      $('#pfW').addEventListener('input', function () { liveDim(0, $('#pfW')); });
      $('#pfH').addEventListener('input', function () { liveDim(1, $('#pfH')); });
    } else if (S.step === 'openings') {
      var walls = (dz.state && dz.state.walls) || [];
      var ops = (dz.state && dz.state.openings) || [];
      /* المرحلة ٢: الجدار ثم الباب والمشب فقط. لا «عامود» ولا «شباك»
         كخيار مستقل — والعمود القديم يبقى قابلًا للحذف من خصائصه على الرسم. */
      box.innerHTML = ''
        + '<div class="p-optgrid">'
        + '<div class="p-opt"><label for="pfOWall">الجدار — أين تريد الباب والمشب؟</label>'
        + '<select id="pfOWall">' + walls.map(function (w, i) {
            return '<option value="' + i + '"' + (i === targetWall() ? ' selected' : '') + '>جدار ' + (i + 1) + '</option>';
          }).join('') + '</select></div></div>'
        + '<div class="p-optgrid two">'
        + '<div class="p-opt"><button type="button" class="btn" data-add="door"><svg><use href="#p-door"/></svg><span>باب</span></button>'
        + '<small>باب على الجدار المختار</small></div>'
        + '<div class="p-opt"><button type="button" class="btn" data-add="mashab"><svg><use href="#p-fire"/></svg><span>مشب</span></button>'
        + '<small>مشب على الجدار المختار</small></div>'
        + '</div>'
        + '<div id="pfOps">'
        + (ops.length ? ops.map(function (o) {
          var onm = { door: 'باب', window: 'شباك', mashab: 'مشب' }[o.type] || 'عنصر';
          return '<div class="p-wallrow"><span>' + onm + ' — جدار ' + (o.wall + 1) + '</span>'
            + '<span class="p-opw"><button type="button" class="btn" data-opwminus="' + esc(o.id) + '" aria-label="تضييق">−</button>'
            + '<input type="number" step="0.1" min="0.3" inputmode="decimal" data-opw="' + esc(o.id) + '" value="' + o.w + '" aria-label="عرض ' + onm + '">'
            + '<button type="button" class="btn" data-opwplus="' + esc(o.id) + '" aria-label="توسيع">+</button></span>'
            + '<button type="button" class="icon-btn" data-opdel="' + esc(o.id) + '" aria-label="حذف"><svg><use href="#p-trash"/></svg></button></div>';
        }).join('') : '')
        + ((!ops.length) ? '<p class="hint">لم تضف بابًا أو مشبًا بعد.</p>' : '')
        + '</div>';
      $$('button[data-add]', box).forEach(function (b) {
        b.addEventListener('click', function () { addOpeningOf(b.dataset.add); renderPanel(); });
      });
      // اختيار الجدار من القائمة: يُحفظ في الخطوة، فالزر «باب/مشب» ينفّذ عليه مباشرة
      var owSel = $('#pfOWall', box);
      if (owSel) owSel.addEventListener('change', function () { setChosenWall(Number(owSel.value)); });
      var opSetW = function (id, v) {
        v = Math.max(0.3, Math.round(v * 10) / 10);
        dz.updateOpening(id, { w: v });
        var inp = box.querySelector('input[data-opw="' + id + '"]');
        if (inp && document.activeElement !== inp) inp.value = v;
        markDirty();
      };
      $$('button[data-opwminus]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var inp = box.querySelector('input[data-opw="' + b.dataset.opwminus + '"]');
          opSetW(b.dataset.opwminus, (parseFloat(inp.value) || 0) - 0.1);
        });
      });
      $$('button[data-opwplus]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var inp = box.querySelector('input[data-opw="' + b.dataset.opwplus + '"]');
          opSetW(b.dataset.opwplus, (parseFloat(inp.value) || 0) + 0.1);
        });
      });
      $$('input[data-opw]', box).forEach(function (inp) {
        inp.addEventListener('change', function () { opSetW(inp.dataset.opw, parseFloat(inp.value)); });
      });
      $$('button[data-opdel]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var o = dz.opening(b.dataset.opdel);
          if (o) { dz.select({ type: 'opening', id: o.id }); dz.removeSelected(); }
          renderPanel();
        });
      });
    } else if (S.step === 'majlis') {
      var curSeat = getSeating();
      /* المرحلة ٣: الأنواع الأربعة كبطاقات بوصف مختصر، و«فرش الكل» (النشاط الأساسي)
         بعدها خامات الفرش (تفاصيل اختيارية). */
      box.innerHTML = ''
        + '<div class="p-optgrid two">'
        + Object.keys(SEATING).map(function (k) {
            return '<div class="p-opt">'
              + '<button type="button" class="btn" data-seat="' + k + '"' + (k === curSeat ? ' aria-pressed="true" style="border-color:var(--accent);color:var(--accent)"' : '') + '>' + SEATING[k] + '</button>'
              + '<small>' + SEAT_HELP[k] + '</small></div>';
          }).join('')
        + '</div>'
        + '<select id="pfSeat" class="p-hidden-sel" aria-hidden="true" tabindex="-1">' + seatOptions(curSeat) + '</select>'
        + '<div class="p-opt"><button type="button" class="btn primary" id="pfFillMajlis">فرش الكل (' + SEATING[curSeat] + ')</button>'
        + '<small>يوزّع الفرش تلقائيًا على كل الجدران الفارغة.</small></div>'
        + '<div class="row2"><label>قماش الكنبة<select id="pfFabric">' + optList(catItems('fabric')) + '</select></label>'
        + '<label>الإسفنج<select id="pfFoam">' + optList(catItems('foam')) + '</select></label></div>'
        + '<label>عمق الكنبة (متر)<input id="pfDepth" type="number" step="0.05" min="0.3" inputmode="decimal" value="0.8"></label>';
      $$('button[data-seat]', box).forEach(function (b) {
        b.addEventListener('click', function () { setSeating(b.dataset.seat); renderPanel(); });
      });
      $('#pfSeat').onchange = function () { setSeating($('#pfSeat').value); renderPanel(); };
      $('#pfFillMajlis').onclick = function () { fillAll(); };
    } else if (S.step === 'furn') {
      var accs = catItems('acc');
      /* المرحلة ٤: قسمان واضحان — الأثاث ثم الإكسسوارات — بلا تكرار الأوامر.
         الحذف السريع متاح بعد المس أي قطعة على الرسم (تظهر خصائصها أسفل الرسم). */
      box.innerHTML = ''
        + '<h4 class="p-subhead">الأثاث</h4>'
        + '<div class="p-optgrid three">'
        + '<div class="p-opt"><button type="button" class="btn primary" data-sofa="wall">كنبة</button>'
        + '<small>على الجدار المختار</small></div>'
        + '<div class="p-opt"><button type="button" class="btn" data-sofa="free">كنبة حرة</button>'
        + '<small>في أي مكان</small></div>'
        + '<div class="p-opt"><button type="button" class="btn" data-sofa="fill">فرش الكل</button>'
        + '<small>توزيع تلقائي</small></div>'
        + '</div>'
        + '<h4 class="p-subhead">الإكسسوارات <small>— المس أي قطعة لحذفها</small></h4>'
        + '<div class="p-accgrid">' + (accs.length ? accs.map(function (a) {
          return '<button type="button" class="btn" data-acc="' + esc(a.id) + '">' + esc(a.name) + '</button>';
        }).join('') : '<p class="hint">لا توجد إكسسوارات متاحة حالياً.</p>') + '</div>'
        + '<button type="button" class="btn ghost" id="pfFreeSpace">+ مساحة أرضية فارغة</button>';
      $$('button[data-sofa]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var k = b.dataset.sofa;
          if (k === 'wall') {
            var added = dz.addSofaOnWall(targetWall(), currentSpec());
            if (!added) toast('لا توجد مساحة كافية على هذا الجدار', true);
          } else if (k === 'free') { dz.addSofaFree(currentSpec()); }
          else { fillAll(); }
        });
      });
      $$('button[data-acc]', box).forEach(function (b) {
        b.addEventListener('click', function () { portalAddAcc(b.dataset.acc); });
      });
      $('#pfFreeSpace').onclick = function () { dz.addFreeSpace(); };
    } else if (S.step === 'review') {
      renderReviewPanel(box, dz);
    }
  }

  /* ---------------- الورقة السفلية (خصائص مبسطة) ---------------- */
  function renderSheet(info) {
    var sh = $('#pSheet');
    var dz = S.designer;
    if (!dz || !info || S.dragHide) { sh.hidden = true; sh.innerHTML = ''; sh.removeAttribute('data-compact'); return; }
    var wasHidden = sh.hidden;
    var html = '<span class="sheet-grip"></span>';
    if (info.type === 'wall') {
      html += '<div class="insp-head"><b>جدار ' + (info.index + 1) + '</b><button class="btn small" data-close>تم</button></div>'
        + '<div class="row2"><label>الطول (م)<input id="psLen" type="number" step="0.05" min="0.3" inputmode="decimal" value="' + info.wall.len + '"></label>'
        + '<label>الاتجاه°<input id="psAng" type="number" step="5" inputmode="numeric" value="' + info.wall.angle + '"></label></div>'
        + '<button type="button" class="btn block danger" data-delwall>حذف الجدار</button>';
    } else if (info.type === 'opening') {
      var o = info.opening;
      var onm = { door: 'باب', window: 'شباك', mashab: 'مشب' }[o.type] || 'عنصر';
      // مدمج: سطر واحد (عنوان + عرض + تم) وصف حذف نصي — لا يغطي الرسم
      html += '<div class="opsheet"><b>' + onm + '</b>'
        + '<span class="p-qty op-qty"><button type="button" class="btn" data-owminus aria-label="تضييق">−</button>'
        + '<input id="psOW" type="number" step="0.1" min="0.3" inputmode="decimal" aria-label="العرض بالمتر" value="' + o.w + '">'
        + '<button type="button" class="btn" data-owplus aria-label="توسيع">+</button></span>'
        + '<button type="button" class="btn small" data-close>تم</button>'
        + '<button type="button" class="link-btn danger-text" data-del>حذف</button></div>';
    } else {
      var p = info.piece;
      var nm = pieceLabel(p);
      html += '<div class="insp-head"><b>' + esc(nm) + '</b><button class="btn small" data-close>تم</button></div>';
      if (p.kind === 'sofa') {
        html += '<label>نوع المجلس<select id="psSeat">'
          + Object.keys(SEATING).map(function (k) { return '<option value="' + k + '"' + ((p.seating || 'floor') === k ? ' selected' : '') + '>' + SEATING[k] + '</option>'; }).join('')
          + '</select></label>';
      }
      if (p.kind === 'acc') {
        html += '<label>الكمية<span class="p-qty"><button type="button" class="btn" data-qminus aria-label="إنقاص">−</button>'
          + '<input id="psQty" type="number" step="1" min="1" max="99" inputmode="numeric" value="' + accQtyOf(p) + '">'
          + '<button type="button" class="btn" data-qplus aria-label="زيادة">+</button></span></label>'
          + '<p class="hint">الكمية = عدد القطع الفعلية في الرسم (1–99).</p>';
      }
      if (p.kind !== 'acc') {
        html += '<div class="row2"><label>الطول (م)<input id="psW" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + p.w + '"></label>'
          + '<label>' + (p.kind === 'sofa' ? 'العمق' : 'العرض') + ' (م)<input id="psH" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + p.h + '"></label></div>';
      }
      html += '<div class="p-sheet-actions">'
        + '<button type="button" class="btn small" data-rot>↻ تدوير</button>'
        + '<button type="button" class="btn small" data-dup>نسخ</button>'
        + '<button type="button" class="btn small danger" data-del>حذف</button></div>';
    }
    sh.innerHTML = html;
    sh.hidden = false;
    // محرر الفتحات مدمج: يُعلَّم لتصغير الورقة، وتُمرَّر المنطقة للرسم عند أول فتح
    if (info.type === 'opening') {
      sh.setAttribute('data-compact', '1');
      if (wasHidden) {
        var cvw = document.querySelector('.p-canvas');
        if (cvw && cvw.scrollIntoView) {
          try { cvw.scrollIntoView({ block: 'nearest' }); } catch (_) { /* noop */ }
        }
      }
    } else {
      sh.removeAttribute('data-compact');
    }
    var close = $('[data-close]', sh);
    if (close) close.onclick = function () { dz.select(null); renderSheet(null); };
    var bindNum = function (sel, fn) {
      var el = $(sel, sh);
      if (el) el.addEventListener('change', function () { fn(parseFloat(el.value)); });
    };
    bindNum('#psLen', function (v) { dz.setWallLength(info.index, Math.max(0.3, v || 0.3)); });
    bindNum('#psAng', function (v) { dz.setWallAngle(info.index, v || 0); });
    bindNum('#psOW', function (v) { dz.updateOpening(info.opening.id, { w: Math.max(0.2, v || 0.5) }); });
    var owStep = function (d) {
      if (!info.opening) return;
      var el = $('#psOW', sh);
      var v = Math.max(0.3, Math.round(((parseFloat(el.value) || 0) + d) * 10) / 10);
      el.value = v;
      dz.updateOpening(info.opening.id, { w: v });
      markDirty();
    };
    var owm = $('[data-owminus]', sh);
    if (owm) owm.onclick = function () { owStep(-0.1); };
    var owp = $('[data-owplus]', sh);
    if (owp) owp.onclick = function () { owStep(0.1); };
    bindNum('#psW', function (v) { dz.updateSelected({ w: Math.max(0.2, v || 0.2) }); });
    bindNum('#psH', function (v) { dz.updateSelected({ h: Math.max(0.2, v || 0.2) }); });
    var dw = $('[data-delwall]', sh);
    if (dw) dw.onclick = function () { try { dz.removeWall(info.index); } catch (e) { toast('لا يمكن حذف هذا الجدار', true); } renderSheet(null); renderPanel(); };
    var seatSel = $('#psSeat', sh);
    if (seatSel && info.type === 'piece') {
      seatSel.onchange = function () {
        dz.updateSelected({ seating: seatSel.value });
        renderSheet(dz.selectionInfo());
        markDirty();
      };
    }
    var qtyApply = function (raw) {
      if (info.type !== 'piece') return;
      try {
        var cur = dz.state.pieces.filter(function (x) { return x.id === info.piece.id; })[0] || info.piece;
        var nq = setAccQty(cur, raw);
        var q = $('#psQty', sh);
        if (q) q.value = nq;
        markDirty();
      } catch (e) {
        toast(e.message || 'كمية غير صالحة (1–99)', true);
        var q2 = $('#psQty', sh);
        if (q2) q2.value = accQtyOf(info.piece);
      }
    };
    var qm = $('[data-qminus]', sh);
    if (qm) qm.onclick = function () { var q = $('#psQty', sh); qtyApply((Number(q.value) || 1) - 1); };
    var qp = $('[data-qplus]', sh);
    if (qp) qp.onclick = function () { var q = $('#psQty', sh); qtyApply((Number(q.value) || 1) + 1); };
    var qi = $('#psQty', sh);
    if (qi) qi.addEventListener('change', function () { qtyApply(qi.value); });
    var act = function (sel, fn) { var el = $(sel, sh); if (el) el.onclick = function () { fn(); renderSheet(dz.selectionInfo()); }; };
    act('[data-del]', function () { dz.removeSelected(); renderSheet(null); });
    act('[data-rot]', function () { dz.rotateSelected(90); });
    act('[data-dup]', function () { dz.duplicateSelected(); });
  }

  function openPModal(title, html, onMount) {
    $('#pModalTitle').textContent = title;
    $('#pModalBody').innerHTML = html;
    $('#pModal').hidden = false;
    document.body.classList.add('modal-open');
    if (onMount) onMount($('#pModalBody'));
  }
  function closePModal() {
    $('#pModal').hidden = true;
    $('#pModalBody').innerHTML = '';
    document.body.classList.remove('modal-open');
  }
  $('#pModalClose').addEventListener('click', closePModal);
  $('#pModal').addEventListener('click', function (e) { if (e.target === $('#pModal')) closePModal(); });

  /* ---------------- المراجعة والإنهاء ---------------- */
  function designFacts(design) {
    var d = design || { walls: [], openings: [], pieces: [] };
    var walls = (d.walls || []).map(function (w) { return w.len + 'م'; }).join(' × ');
    var doors = 0, mashabs = 0, cols = 0;
    (d.openings || []).forEach(function (o) { if (o.type === 'door') doors++; else if (o.type === 'mashab') mashabs++; });
    (d.pieces || []).forEach(function (p) { if (p.kind === 'column') cols++; });
    var meters = 0, accs = {}, free = 0, seats = {};
    (d.pieces || []).forEach(function (p) {
      if (p.kind === 'sofa') { meters += Number(p.w) || 0; var sk = SEATING[p.seating] || SEATING.floor; seats[sk] = (seats[sk] || 0) + 1; }
      else if (p.kind === 'acc') { var n = pieceLabel(p); accs[n] = (accs[n] || 0) + 1; }
      else free++;
    });
    var accTxt = Object.keys(accs).map(function (k) { return k + ' ×' + accs[k]; }).join('، ');
    var seatTxt = Object.keys(seats).map(function (k) { return k + ' ×' + seats[k]; }).join('، ');
    return [
      ['مقاسات الغرفة', walls || '—'],
      ['الأبواب', doors ? doors + '' : '—'],
      ['المشب', mashabs ? mashabs + '' : '—'],
      ['الأعمدة', cols ? cols + '' : '—'],
      ['أنواع المجلس', seatTxt || '—'],
      ['أمتار الكنب', meters ? (Math.round(meters * 100) / 100) + ' م' : '—'],
      ['الإكسسوارات', accTxt || '—'],
    ];
  }

  function designImage(design, W) {
    W = W || 1400;
    var off = new Designer(document.createElement('canvas'), { getItem: getCatItem, pieceSpecLabel: function () { return ''; }, pieceStyle: function () { return null; } });
    off.setState(JSON.parse(JSON.stringify(design)));
    var H = Math.max(400, Math.round(W / off.aspect()));
    return off.toImage(W, H);
  }

  /* المراجعة خطوة داخل المصمم: معاينة + بيانات اختيارية + PDF/واتساب/إنهاء */
  function renderReviewPanel(box, dz) {
    var cust = S.cust || { name: '', phone: '' };
    /* المرحلة ٥ مبسّطة: معاينة + بيانات العميل + صف أزرار واحد (معاينة/تصدير/مشاركة/إنهاء)
       وسطر شرح واحد يوضّح وظيفة كل زر — بلا قائمة حقائق طويلة. */
    box.innerHTML = ''
      + '<img id="pReviewImg" class="p-preview" alt="معاينة المخطط">'
      + '<div class="fields">'
      + '<div class="row2">'
      + '<label>الاسم (اختياري)<input id="pName" maxlength="60" placeholder="اسمك" autocomplete="name" value="' + esc(cust.name) + '"></label>'
      + '<label>رقم الجوال (اختياري)<input id="pPhone" type="tel" inputmode="tel" placeholder="05xxxxxxxx" autocomplete="tel" value="' + esc(cust.phone) + '"></label>'
      + '</div>'
      + '</div>'
      + '<div class="p-actrow">'
      + '<button type="button" class="btn" id="pActPreview">معاينة</button>'
      + '<button type="button" class="btn" id="pActPdf">تصدير PDF</button>'
      + '<button type="button" class="btn" id="pActWa">واتساب</button>'
      + '<button type="button" class="btn primary" id="pSubmitDesign">إنهاء التصميم</button>'
      + '</div>'
      + '<p class="p-review-note">معاينة: شاهد التصميم قبل الإنهاء · تصدير PDF: احفظه كملف على جهازك · '
      + 'واتساب: أرسل التصميم عبر واتساب · إنهاء التصميم: يُنهي الطلب ويحفظ التصميم لدى المحل.</p>'
      + '<p class="error" id="pReviewErr" role="alert"></p>';
    var refreshPreview = function () {
      try {
        var st = dz.getState();
        var img = $('#pReviewImg', box);
        if (img) img.src = designImage(st, 1000);
      } catch (e) { /* noop */ }
    };
    refreshPreview();
    var keepCust = function () {
      S.cust = { name: ($('#pName', box) || {}).value || '', phone: ($('#pPhone', box) || {}).value || '' };
    };
    $('#pActPreview', box).onclick = function () { keepCust(); refreshPreview(); toast('حُدّثت المعاينة'); };
    $('#pActPdf', box).onclick = function () { keepCust(); reviewPdf(); };
    $('#pActWa', box).onclick = function () { keepCust(); reviewShare(); };
    $('#pSubmitDesign', box).onclick = function () { keepCust(); submitDesign(box); };
    ['pName', 'pPhone'].forEach(function (id) {
      var el = $('#' + id, box);
      if (el) el.addEventListener('input', keepCust);
    });
  }

  async function reviewPdf() {
    try {
      var blob = await makeDesignPdfBlob(S.meta && S.meta.number);
      downloadBlob(blob, 'design-' + ((S.meta && S.meta.number) || 'draft') + '.pdf');
    } catch (e) {
      toast(e.message || 'تعذّر إنشاء PDF.', true);
    }
  }

  async function reviewShare() {
    var no = S.meta && S.meta.number;
    var text = no
      ? 'السلام عليكم، هذا تصميم مجلسي من خلال منصة التصميم.\nرقم التصميم: ' + no
      : 'السلام عليكم، هذا تصميم مجلسي من خلال منصة التصميم (مسودة قبل الترقيم).';
    try {
      var blob = await makeDesignPdfBlob(no);
      var file = new File([blob], 'design-' + (no || 'draft') + '.pdf', { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'تصميم المجلس', text: text });
        return;
      }
      throw new Error('no-share');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      try {
        var blob2 = await makeDesignPdfBlob(no);
        downloadBlob(blob2, 'design-' + (no || 'draft') + '.pdf');
      } catch (_) { /* noop */ }
      var wa = waNumber();
      if (wa) window.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
      else toast('نُزّل ملف PDF — أرفقه في محادثة المحل.', false);
    }
  }

  async function submitDesign(box) {
    var btn = $('#pSubmitDesign', box);
    if (!btn || btn.disabled) return;
    var name = ($('#pName', box) || {}).value || '';
    var phone = ($('#pPhone', box) || {}).value || '';
    btn.disabled = true;
    try {
      await saveDraft();
      name = name.trim(); phone = phone.trim();
      if (name || phone) {
        await api('/save', { method: 'POST', body: { design: S.designer.getState(), name: name, phone: phone } });
      }
      var r = await api('/finish', { method: 'POST', body: {} });
      S.meta = { number: r.number, status: r.status };
      // يُبقى التوكن ليعمل «طلب التواصل» و«تصميم جديد» يبدأ جلسة أخرى
      showDone(r.number);
    } catch (e) {
      var err = $('#pReviewErr', box);
      if (err) err.textContent = e.message || 'تعذّر إنهاء التصميم.';
    } finally {
      btn.disabled = false;
    }
  }

  function showDone(number) {
    $('#pDesignNo').textContent = number;
    $('#pContactBox').hidden = true;
    $('#pContactOk').hidden = true;
    $('#pContactErr').textContent = '';
    show('pDone');
  }

  /* ---------------- PDF العميل (بلا أي بيانات داخلية) ---------------- */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var had = document.querySelector('script[data-lib="' + src + '"]');
      if (had) { if (had.dataset.ok) return res(); had.addEventListener('load', function () { res(); }); had.addEventListener('error', function () { rej(new Error('net')); }); return; }
      var s = document.createElement('script');
      s.src = src; s.dataset.lib = src;
      s.onload = function () { s.dataset.ok = '1'; res(); };
      s.onerror = function () { s.remove(); rej(new Error('net')); };
      document.head.appendChild(s);
    });
  }
  var QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  var H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  var JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  async function qrDataUrl(text) {
    try { await loadScript(QR_URL); } catch (_) { return ''; }
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createDataURL(4, 0);
    } catch (_) { return ''; }
  }

  /** قنوات التواصل: أيقونة + رابط كامل + باركود يفتح القناة مباشرة */
  function contactChannels() {
    var s = S.settings || {};
    var wa = digits(s.whatsapp) || digits(s.phone);
    var out = [];
    if (wa) out.push({ key: 'wa', label: 'واتساب', url: 'https://wa.me/' + wa });
    if (s.instagram) out.push({ key: 'in', label: 'إنستقرام', url: httpsUrl(s.instagram) });
    if (s.tiktok) out.push({ key: 'tt', label: 'تيكتوك', url: httpsUrl(s.tiktok) });
    if (s.mapsUrl) out.push({ key: 'map', label: 'الموقع', url: httpsUrl(s.mapsUrl) });
    if (digits(s.phone)) out.push({ key: 'tel', label: 'اتصال', url: 'tel:+' + digits(s.phone).replace(/^00/, '') });
    return out.filter(function (c) { return !!c.url; });
  }
  function httpsUrl(u) {
    var s = String(u || '').trim();
    if (/^https:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return 'https://' + s;
    if (/^[\w.+-]+@[\w.-]+$/.test(s)) return 'mailto:' + s;
    if (/^[+\d][\d\s-]{6,}$/.test(s)) return 'tel:+' + s.replace(/\D/g, '');
    return '';
  }
  var CONTACT_ICON = {
    wa: '<svg viewBox="0 0 24 24"><path d="M20.5 11.7a8.4 8.4 0 0 1-12.4 7.4L3 20.6l1.6-4.9A8.4 8.4 0 1 1 20.5 11.7z"/></svg>',
    in: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2"/></svg>',
    tt: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>',
    map: '<svg viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    tel: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  };

  async function buildDesignPdf(number) {
    var s = S.settings || {};
    var st = S.designer.getState();
    var facts = designFacts(st);
    var img = designImage(st, 1600);
    var noTxt = number || 'مسودة';
    var d = new Date();
    var date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    // بطاقات التواصل: أيقونة + باركود لكل قناة (يفتحها المسح مباشرة)
    var chans = contactChannels();
    var chanHtml = '';
    for (var ci = 0; ci < chans.length; ci++) {
      var c = chans[ci];
      var cq = await qrDataUrl(c.url);
      chanHtml += '<div class="inv-chan" data-url="' + esc(c.url) + '">'
        + '<span class="inv-chan-ic ' + c.key + '">' + (CONTACT_ICON[c.key] || '') + '</span>'
        + '<span class="inv-chan-lb">' + esc(c.label) + '</span>'
        + (cq ? '<img class="inv-chan-qr" src="' + cq + '" alt="">' : '')
        + '<span class="inv-chan-url">' + esc(c.url.replace(/^https?:\/\//i, '')) + '</span>'
        + '</div>';
    }
    var el = document.createElement('div');
    el.className = 'inv';
    el.innerHTML = ''
      + '<div class="inv-head"><div class="inv-brand"><img class="inv-mark" src="/icons/icon-512.png" alt="" width="60" height="60">'
      + '<div><h1>' + esc(s.shopName || 'أصالة نجد') + '</h1><small>تصميم مجلس</small></div></div>'
      + '<div class="inv-title-box"><div class="inv-title">تصميم العميل</div></div></div>'
      + '<div class="inv-info">'
      + '<div><span>رقم التصميم</span><b class="num">' + esc(noTxt) + '</b></div>'
      + '<div><span>التاريخ</span><b class="num">' + esc(date) + '</b></div>'
      + '</div>'
      + '<div class="inv-visuals"><div class="inv-design"><div class="imgbox"><img src="' + img + '" alt="مخطط المجلس"></div></div></div>'
      + '<div class="inv-items"><table><thead><tr><th>البند</th><th>التفاصيل</th></tr></thead><tbody>'
      + facts.map(function (f) { return '<tr><td>' + f[0] + '</td><td>' + esc(f[1]) + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + '<div class="inv-bottom"><div class="inv-contact"><b>تواصل معنا</b>'
      + '<div class="inv-chans-hint">اضغط على الباركود أو الرابط لفتحه</div>'
      + '<div class="inv-chans">' + (chanHtml || '') + '</div></div>'
      + '</div>'
      + '</div>'
      + '<div class="inv-foot"><span>احتفظ برقم التصميم لمراجعته مع المحل</span></div>';
    return el;
  }

  async function makeDesignPdfBlob(number) {
    if (!navigator.onLine) throw new Error('تصدير PDF يحتاج اتصالًا بالإنترنت.');
    try { await loadScript(H2C_URL); await loadScript(JSPDF_URL); }
    catch (_) { throw new Error('تعذّر تحميل مكتبة PDF. تحقق من الاتصال.'); }
    var area = $('#pPrint');
    area.innerHTML = '';
    var inv = await buildDesignPdf(number);
    area.appendChild(inv);
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    try {
      var canvas = await window.html2canvas(inv, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      var img = canvas.toDataURL('image/jpeg', 0.94);
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      var h = Math.min(276, 190 * (canvas.height / canvas.width));
      pdf.addImage(img, 'JPEG', 10, 10, 190, h, undefined, 'FAST');
      // الأيقونات والباركود روابط حقيقية: النقر عليها يفتح القناة أو التصميم
      addPdfLinks(pdf, inv, 10, 10, 190);
      return pdf.output('blob');
    } finally {
      area.style.cssText = '';
      area.innerHTML = '';
    }
  }

  /** تحويل مواضع العناصر (data-url) إلى毫米 على صفحة PDF وإضافتها كروابط قابلة للنقر */
  function addPdfLinks(pdf, inv, x0, y0, wMm) {
    var base = inv.getBoundingClientRect();
    if (!base.width) return 0;
    var k = wMm / base.width;                 // مم لكل بكسل CSS
    var nodes = inv.querySelectorAll('[data-url]');
    for (var i = 0; i < nodes.length; i++) {
      var url = nodes[i].getAttribute('data-url');
      if (!url) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var x = x0 + (r.left - base.left) * k;
      var y = y0 + (r.top - base.top) * k;
      var w = r.width * k, hh = r.height * k;
      if (x < x0 || x + w > x0 + wMm + 0.5) continue;   // خارج حدود الصفحة أفقيًا
      try { pdf.link(x, y, w, hh, { url: url }); } catch (_) { /* noop */ }
    }
    return nodes.length;
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (_) { /* noop */ } a.remove(); }, 5000);
  }

  function waNumber() {
    var s = S.settings || {};
    return digits(s.whatsapp) || digits(s.phone);
  }

  $('#pPdf').addEventListener('click', async function () {
    var btn = $('#pPdf');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      var blob = await makeDesignPdfBlob(S.meta.number);
      downloadBlob(blob, 'design-' + S.meta.number + '.pdf');
    } catch (e) {
      toast(e.message || 'تعذّر إنشاء PDF.', true);
    } finally {
      btn.disabled = false;
    }
  });

  $('#pShareWa').addEventListener('click', async function () {
    var btn = $('#pShareWa');
    if (btn.disabled) return;
    btn.disabled = true;
    var text = 'السلام عليكم، هذا تصميم مجلسي من خلال منصة التصميم.\nرقم التصميم: ' + S.meta.number;
    try {
      var blob = await makeDesignPdfBlob(S.meta.number);
      var file = new File([blob], 'design-' + S.meta.number + '.pdf', { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'تصميم ' + S.meta.number, text: text });
        return;
      }
      throw new Error('no-share');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      try {
        var blob2 = await makeDesignPdfBlob(S.meta.number);
        downloadBlob(blob2, 'design-' + S.meta.number + '.pdf');
      } catch (_) { /* noop */ }
      var wa = waNumber();
      var url = wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(text) : null;
      if (url) window.open(url, '_blank', 'noopener');
      else toast('نُزّل ملف PDF — أرفقه في محادثة المحل.', false);
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- طلب التواصل ---------------- */
  $('#pContactBtn').addEventListener('click', function () {
    var box = $('#pContactBox');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      var n = $('#pName');
      if (n && n.value) $('#pCName').value = n.value;
      var p = $('#pPhone');
      if (p && p.value) $('#pCPhone').value = p.value;
      $('#pCName').focus();
    }
  });

  $('#pContactSend').addEventListener('click', async function () {
    var btn = $('#pContactSend');
    if (btn.disabled) return;
    var name = $('#pCName').value.trim();
    var phone = $('#pCPhone').value.trim();
    if (name.length < 2) { $('#pContactErr').textContent = 'فضلاً أدخل الاسم.'; return; }
    if (!/^\+?[\d\s-]{7,16}$/.test(phone)) { $('#pContactErr').textContent = 'فضلاً أدخل رقم جوال صحيح.'; return; }
    btn.disabled = true;
    $('#pContactErr').textContent = '';
    try {
      await api('/contact', { method: 'POST', body: { name: name, phone: phone } });
      $('#pContactOk').hidden = false;
      btn.disabled = true;
      btn.textContent = 'تم إرسال طلب التواصل ✓';
    } catch (e) {
      btn.disabled = false;
      $('#pContactErr').textContent = (e && e.status === 401) ? 'انتهت الجلسة — ابدأ تصميمًا جديدًا ثم أعد الإرسال.' : 'تعذّر الإرسال. تحقق من الاتصال وحاول مجدداً.';
    }
  });

  /* ---------------- العرض العام (QR) ---------------- */
  async function bootLook(number) {
    show('pLook');
    try {
      var res = await fetch('/api/portal/view/' + encodeURIComponent(number), { cache: 'no-store' });
      var v = await res.json();
      if (!res.ok || !v.design) throw new Error((v && v.error) || 'غير موجود');
      $('#pLookShop').textContent = v.shopName || 'أصالة نجد';
      $('#pLookNo').textContent = v.number;
      $('#pLookDate').textContent = 'بتاريخ ' + String(v.createdAt || '').slice(0, 10);
      try { $('#pLookImg').src = designImage(v.design, 1200); } catch (_) { /* noop */ }
      $('#pLookFacts').innerHTML = designFacts(v.design).map(function (f) {
        return '<div><dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd></div>';
      }).join('');
    } catch (e) {
      $('#pLookNo').textContent = number;
      $('#pLookDate').textContent = 'تعذّر تحميل هذا التصميم.';
    }
  }

  // خطاف تشخيص/اختبار (قراءة الحالة وطرق المحرك الموجودة أصلاً — بلا أسرار)
  window.PortalTest = {
    state: function () { return S.designer ? S.designer.getState() : null; },
    designer: function () { return S.designer; },
    seating: getSeating,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
