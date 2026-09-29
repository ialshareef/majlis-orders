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
  };

  var STEPS = [
    { id: 'room', label: 'الغرفة' },
    { id: 'openings', label: 'الأبواب والشبابيك' },
    { id: 'sofa', label: 'الأثاث' },
    { id: 'seats', label: 'الكنب والمقاعد' },
    { id: 'acc', label: 'الإكسسوارات' },
    { id: 'review', label: 'مراجعة' },
  ];

  function show(view) {
    ['pLanding', 'pDesign', 'pReview', 'pDone', 'pLook'].forEach(function (id) {
      document.getElementById(id).hidden = id !== view;
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
      if (g.name) { var n = $('#pName'); if (n && !n.value) n.value = g.name; }
      if (g.phone) { var p = $('#pPhone'); if (p && !p.value) p.value = g.phone; }
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
    var bits = [];
    ['woodId', 'fabricId', 'foamId'].forEach(function (f) {
      var it = S.catMap[p[f]];
      if (it) bits.push(it.name);
    });
    return bits.length ? bits.join(' + ') : 'كنبة';
  }

  function enterDesign(design) {
    S.design = null;
    S.dirty = false;
    S.step = 'room';
    show('pDesign');
    buildSteps();
    buildTools();
    var dz = new Designer($('#pCanvas'), {
      getItem: getCatItem,
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
    try { dz.setState(design || null); } catch (_) { dz.setState(null); }
    dz.fitView();
    renderPanel();
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
      b.addEventListener('click', function () { S.step = b.dataset.step; buildSteps(); renderPanel(); });
    });
  }

  function buildTools() {
    var box = $('#pTools');
    box.innerHTML = ''
      + '<button type="button" class="tb-btn" data-t="sofa"><svg><use href="#p-sofa"/></svg><span>أثاث</span></button>'
      + '<button type="button" class="tb-btn" data-t="door"><svg><use href="#p-door"/></svg><span>باب</span></button>'
      + '<button type="button" class="tb-btn" data-t="window"><svg><use href="#p-window"/></svg><span>شباك</span></button>'
      + '<button type="button" class="tb-btn" data-t="wall"><svg><use href="#p-plus"/></svg><span>جدار</span></button>'
      + '<button type="button" class="tb-btn" data-t="fill"><svg><use href="#p-home"/></svg><span>فرش الكل</span></button>';
    $$('button', box).forEach(function (b) {
      b.addEventListener('click', function () { toolAct(b.dataset.t); });
    });
    $('#pZoomIn').onclick = function () { S.designer && S.designer.zoomAt(1.25); };
    $('#pZoomOut').onclick = function () { S.designer && S.designer.zoomAt(0.8); };
    $('#pZoomFit').onclick = function () { S.designer && S.designer.fitView(); };
    $('#pUndo').onclick = function () { if (S.designer) S.designer.undo(); };
    $('#pBack').onclick = function () { show('pLanding'); };
    $('#pFinish').onclick = goReview;
  }

  function targetWall() {
    var dz = S.designer;
    if (!dz) return 0;
    var i = dz.selectedWallIndex();
    if (i >= 0) return i;
    var o = dz.selectedOpening();
    if (o) return o.wall;
    var p = dz.selectedPiece();
    if (p && p.wall != null) return p.wall;
    return 0;
  }

  function currentSpec() {
    var spec = { depth: Math.max(0.3, parseFloat(($('#pfDepth') || {}).value) || 0.8) };
    var any = false;
    [['woodId', 'pfWood'], ['fabricId', 'pfFabric'], ['foamId', 'pfFoam']].forEach(function (pair) {
      var el = document.getElementById(pair[1]);
      var id = el && el.value;
      if (id && S.catMap[id]) { spec[pair[0]] = id; any = true; }
    });
    return any ? spec : null;
  }

  function toolAct(t) {
    var dz = S.designer;
    if (!dz) return;
    if (t === 'door' || t === 'window') {
      var p = dz.addOpening(targetWall(), t);
      if (!p) toast('لا توجد مساحة على هذا الجدار', true);
      return;
    }
    if (t === 'wall') { openWallModal(); return; }
    if (t === 'fill') {
      var spec = currentSpec();
      if (!spec) { S.step = 'sofa'; buildSteps(); renderPanel(); toast('اختر الخشب والقماش أولاً من خطوة الأثاث'); return; }
      dz.fillAllWalls(spec);
      return;
    }
    // أثاث: على الجدار المحدد أو قطعة حرة
    var s2 = currentSpec();
    if (!s2) { S.step = 'sofa'; buildSteps(); renderPanel(); toast('اختر الخشب والقماش أولاً من خطوة الأثاث'); return; }
    var wall = targetWall();
    var added = dz.addSofaOnWall(wall, s2);
    if (!added) toast('لا توجد مساحة كافية على هذا الجدار', true);
  }

  /* ---------------- لوحات الخطوات ---------------- */
  function optList(items, val, emptyLabel) {
    return '<option value="">' + esc(emptyLabel || 'غير محدد') + '</option>'
      + items.map(function (i) { return '<option value="' + esc(i.id) + '"' + (i.id === val ? ' selected' : '') + '>' + esc(i.name) + '</option>'; }).join('');
  }

  function renderPanel() {
    var box = $('#pPanel');
    var dz = S.designer;
    if (!dz) { box.innerHTML = ''; return; }
    if (S.step === 'room') {
      var ws = (dz.state && dz.state.walls) || [];
      box.innerHTML = ''
        + '<div class="row2"><label>العرض (م)<input id="pfW" type="number" step="0.1" min="1" inputmode="decimal" value="' + (ws[0] ? ws[0].len : 5) + '"></label>'
        + '<label>الطول (م)<input id="pfH" type="number" step="0.1" min="1" inputmode="decimal" value="' + (ws[1] ? ws[1].len : 4) + '"></label></div>'
        + '<button type="button" class="btn primary block" id="pfRect">تطبيق كغرفة مستطيلة</button>'
        + '<p class="hint">للغرف غير المستطيلة: أضف جدارًا من الأدوات بالأعلى، وعدّل أطوال الجدران من القائمة:</p>'
        + '<div id="pfWalls">' + ws.map(function (w, i) {
          return '<div class="p-wallrow"><span>جدار ' + (i + 1) + '</span>'
            + '<input type="number" step="0.1" min="0.3" inputmode="decimal" data-wall="' + i + '" value="' + w.len + '" aria-label="طول جدار ' + (i + 1) + '">'
            + '<button type="button" class="icon-btn" data-walldel="' + i + '" aria-label="حذف جدار ' + (i + 1) + '"><svg><use href="#p-trash"/></svg></button></div>';
        }).join('') + '</div>';
      $('#pfRect').onclick = function () {
        var w = Math.max(1, parseFloat($('#pfW').value) || 5);
        var h = Math.max(1, parseFloat($('#pfH').value) || 4);
        dz.setRect(w, h);
        dz.fitView();
        renderPanel();
      };
      $$('input[data-wall]', box).forEach(function (inp) {
        inp.addEventListener('change', function () {
          dz.setWallLength(Number(inp.dataset.wall), Math.max(0.3, parseFloat(inp.value) || 0.3));
          renderPanel();
        });
      });
      $$('button[data-walldel]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          try { dz.removeWall(Number(b.dataset.walldel)); } catch (e) { toast('لا يمكن حذف هذا الجدار', true); }
          renderPanel();
        });
      });
    } else if (S.step === 'openings') {
      var walls = (dz.state && dz.state.walls) || [];
      var ops = (dz.state && dz.state.openings) || [];
      box.innerHTML = ''
        + '<div class="row2"><label>الجدار<select id="pfOWall">' + walls.map(function (w, i) { return '<option value="' + i + '">جدار ' + (i + 1) + '</option>'; }).join('') + '</select></label>'
        + '<label>النوع<select id="pfOType"><option value="door">باب</option><option value="window">شباك</option></select></label></div>'
        + '<button type="button" class="btn primary block" id="pfOAdd">إضافة على الجدار</button>'
        + '<div id="pfOps">' + (ops.length ? ops.map(function (o) {
          return '<div class="p-wallrow"><span>' + (o.type === 'door' ? 'باب' : 'شباك') + ' — جدار ' + (o.wall + 1) + '</span>'
            + '<button type="button" class="icon-btn" data-opdel="' + esc(o.id) + '" aria-label="حذف"><svg><use href="#p-trash"/></svg></button></div>';
        }).join('') : '<p class="hint">لا توجد أبواب أو شبابيك بعد.</p>') + '</div>';
      $('#pfOAdd').onclick = function () {
        var p = dz.addOpening(Number($('#pfOWall').value) || 0, $('#pfOType').value);
        if (!p) toast('لا توجد مساحة على هذا الجدار', true);
        renderPanel();
      };
      $$('button[data-opdel]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var o = dz.opening(b.dataset.opdel);
          if (o) { dz.select({ type: 'opening', id: o.id }); dz.removeSelected(); }
          renderPanel();
        });
      });
    } else if (S.step === 'sofa') {
      box.innerHTML = ''
        + '<label>الخشب<select id="pfWood">' + optList(catItems('wood')) + '</select></label>'
        + '<label>القماش<select id="pfFabric">' + optList(catItems('fabric')) + '</select></label>'
        + '<label>الإسفنج<select id="pfFoam">' + optList(catItems('foam')) + '</select></label>'
        + '<label>العمق (م)<input id="pfDepth" type="number" step="0.05" min="0.3" inputmode="decimal" value="0.8"></label>'
        + '<p class="hint">اختر التركيبة ثم اضغط «أثاث» من الأدوات لوضعها على الجدار.</p>';
    } else if (S.step === 'seats') {
      box.innerHTML = ''
        + '<p class="hint">الكنبة تُركَّب من التركيبة المختارة في خطوة الأثاث. اضغط «أثاث» بالأعلى لوضع كنبة جديدة، أو المس أي كنبة لتعديلها.</p>'
        + '<button type="button" class="btn primary block" id="pfAddFree">إضافة كنبة حرة (بدون جدار)</button>';
      $('#pfAddFree').onclick = function () {
        var spec = currentSpec();
        if (!spec) { S.step = 'sofa'; buildSteps(); renderPanel(); toast('اختر التركيبة أولاً من خطوة الأثاث'); return; }
        dz.addSofaFree(spec);
      };
    } else if (S.step === 'acc') {
      var accs = catItems('acc');
      box.innerHTML = '<p class="hint">اضغط القطعة لوضعها وسط الغرفة ثم اسحبها لمكانها.</p>'
        + '<div class="p-accgrid">' + (accs.length ? accs.map(function (a) {
          return '<button type="button" class="btn" data-acc="' + esc(a.id) + '">' + esc(a.name) + '</button>';
        }).join('') : '<p class="hint">لا توجد إكسسوارات متاحة حالياً.</p>') + '</div>'
        + '<button type="button" class="btn block ghost" id="pfFreeSpace">إضافة مساحة أرضية (علامة بلا سعر)</button>';
      $$('button[data-acc]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var it = S.catMap[b.dataset.acc];
          if (it) dz.addAccessory({ id: it.id });
        });
      });
      $('#pfFreeSpace').onclick = function () { dz.addFreeSpace(); };
    } else {
      box.innerHTML = '<p class="hint">راجع مخططك، ثم اضغط «مراجعة وإنهاء التصميم» بالأسفل.</p>';
    }
  }

  /* ---------------- الورقة السفلية (خصائص مبسطة) ---------------- */
  function renderSheet(info) {
    var sh = $('#pSheet');
    var dz = S.designer;
    if (!dz || !info) { sh.hidden = true; sh.innerHTML = ''; return; }
    var html = '<span class="sheet-grip"></span>';
    if (info.type === 'wall') {
      html += '<div class="insp-head"><b>جدار ' + (info.index + 1) + '</b><button class="btn small" data-close>تم</button></div>'
        + '<div class="row2"><label>الطول (م)<input id="psLen" type="number" step="0.05" min="0.3" inputmode="decimal" value="' + info.wall.len + '"></label>'
        + '<label>الاتجاه°<input id="psAng" type="number" step="5" inputmode="numeric" value="' + info.wall.angle + '"></label></div>'
        + '<button type="button" class="btn block danger" data-delwall>حذف الجدار</button>';
    } else if (info.type === 'opening') {
      var o = info.opening;
      html += '<div class="insp-head"><b>' + (o.type === 'door' ? 'باب' : 'شباك') + '</b><button class="btn small" data-close>تم</button></div>'
        + '<label>العرض (م)<input id="psOW" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + o.w + '"></label>'
        + '<button type="button" class="btn block danger" data-del>حذف</button>';
    } else {
      var p = info.piece;
      var nm = pieceLabel(p);
      html += '<div class="insp-head"><b>' + esc(nm) + '</b><button class="btn small" data-close>تم</button></div>';
      if (p.kind !== 'acc') {
        html += '<div class="row2"><label>الطول (م)<input id="psW" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + p.w + '"></label>'
          + '<label>' + (p.kind === 'sofa' ? 'العمق' : 'العرض') + ' (م)<input id="psH" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + p.h + '"></label></div>';
      }
      html += '<div class="p-sheet-actions">'
        + '<button type="button" class="btn small" data-rot>تدوير</button>'
        + '<button type="button" class="btn small" data-dup>نسخ</button>'
        + '<button type="button" class="btn small danger" data-del>حذف</button></div>';
    }
    sh.innerHTML = html;
    sh.hidden = false;
    var close = $('[data-close]', sh);
    if (close) close.onclick = function () { dz.select(null); renderSheet(null); };
    var bindNum = function (sel, fn) {
      var el = $(sel, sh);
      if (el) el.addEventListener('change', function () { fn(parseFloat(el.value)); });
    };
    bindNum('#psLen', function (v) { dz.setWallLength(info.index, Math.max(0.3, v || 0.3)); });
    bindNum('#psAng', function (v) { dz.setWallAngle(info.index, v || 0); });
    bindNum('#psOW', function (v) { dz.updateOpening(info.opening.id, { w: Math.max(0.2, v || 0.5) }); });
    bindNum('#psW', function (v) { dz.updateSelected({ w: Math.max(0.2, v || 0.2) }); });
    bindNum('#psH', function (v) { dz.updateSelected({ h: Math.max(0.2, v || 0.2) }); });
    var dw = $('[data-delwall]', sh);
    if (dw) dw.onclick = function () { try { dz.removeWall(info.index); } catch (e) { toast('لا يمكن حذف هذا الجدار', true); } renderSheet(null); renderPanel(); };
    var act = function (sel, fn) { var el = $(sel, sh); if (el) el.onclick = function () { fn(); renderSheet(dz.selectionInfo()); }; };
    act('[data-del]', function () { dz.removeSelected(); renderSheet(null); });
    act('[data-rot]', function () { dz.rotateSelected(90); });
    act('[data-dup]', function () { dz.duplicateSelected(); });
  }

  function openWallModal() {
    openPModal('إضافة جدار', ''
      + '<div class="row2"><label>الطول (م)<input id="pwLen" type="number" step="0.1" min="0.5" inputmode="decimal" value="3"></label>'
      + '<label>الاتجاه°<input id="pwAng" type="number" step="5" inputmode="numeric" value="0"></label></div>'
      + '<div class="btn-row"><button class="btn" id="pwCancel">إلغاء</button><button class="btn primary" id="pwOk">إضافة</button></div>',
      function (b) {
        $('#pwCancel', b).onclick = closePModal;
        $('#pwOk', b).onclick = function () {
          S.designer.addWall(Math.max(0.5, parseFloat($('#pwLen', b).value) || 3), parseFloat($('#pwAng', b).value) || 0);
          closePModal();
          renderPanel();
        };
        setTimeout(function () { var i = $('#pwLen', b); if (i) { i.focus(); i.select(); } }, 80);
      });
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
    var doors = 0, wins = 0;
    (d.openings || []).forEach(function (o) { if (o.type === 'door') doors++; else if (o.type === 'window') wins++; });
    var meters = 0, accs = {}, free = 0;
    (d.pieces || []).forEach(function (p) {
      if (p.kind === 'sofa') meters += Number(p.w) || 0;
      else if (p.kind === 'acc') { var n = pieceLabel(p); accs[n] = (accs[n] || 0) + 1; }
      else free++;
    });
    var accTxt = Object.keys(accs).map(function (k) { return k + ' ×' + accs[k]; }).join('، ');
    return [
      ['مقاسات الغرفة', walls || '—'],
      ['الأبواب', doors ? doors + '' : '—'],
      ['الشبابيك', wins ? wins + '' : '—'],
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

  async function goReview() {
    await saveDraft();
    var st = S.designer.getState();
    try { $('#pPreviewImg').src = designImage(st, 1200); } catch (e) { $('#pPreviewImg').removeAttribute('src'); }
    $('#pFacts').innerHTML = designFacts(st).map(function (f) {
      return '<div><dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd></div>';
    }).join('');
    $('#pReviewErr').textContent = '';
    $('#pBack2').onclick = function () { show('pDesign'); };
    show('pReview');
  }

  $('#pSubmitDesign').addEventListener('click', async function () {
    var btn = $('#pSubmitDesign');
    if (btn.disabled) return;
    var name = $('#pName').value.trim();
    var phone = $('#pPhone').value.trim();
    btn.disabled = true;
    try {
      await saveDraft();
      if (name || phone) {
        await api('/save', { method: 'POST', body: { design: S.designer.getState(), name: name, phone: phone } });
      }
      var r = await api('/finish', { method: 'POST', body: {} });
      S.meta = { number: r.number, status: r.status };
      // يُبقى التوكن ليعمل «طلب التواصل» و«تصميم جديد» يبدأ جلسة أخرى
      showDone(r.number);
    } catch (e) {
      $('#pReviewErr').textContent = e.message || 'تعذّر إنهاء التصميم.';
    } finally {
      btn.disabled = false;
    }
  });

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

  function contactLines() {
    var s = S.settings || {};
    var wa = digits(s.whatsapp) || digits(s.phone);
    var L = [];
    if (digits(s.phone)) L.push(['اتصال', '+' + digits(s.phone)]);
    if (wa) L.push(['WhatsApp', 'wa.me/' + wa]);
    if (s.instagram) L.push(['Instagram', String(s.instagram).replace(/^https?:\/\//i, '')]);
    if (s.tiktok) L.push(['TikTok', String(s.tiktok).replace(/^https?:\/\//i, '')]);
    if (s.mapsUrl) L.push(['الموقع', 'خرائط جوجل']);
    return L;
  }

  async function buildDesignPdf(number) {
    var s = S.settings || {};
    var st = S.designer.getState();
    var facts = designFacts(st);
    var img = designImage(st, 1600);
    var qr = await qrDataUrl(window.location.origin + '/customer-design/view/' + number);
    var d = new Date();
    var date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var el = document.createElement('div');
    el.className = 'inv';
    el.innerHTML = ''
      + '<div class="inv-head"><div class="inv-brand"><span class="mark"><svg><use href="#p-sofa"/></svg></span>'
      + '<div><h1>' + esc(s.shopName || 'أصالة نجد') + '</h1><small>تصميم مجلس — ' + esc(number) + '</small></div></div>'
      + '<div class="inv-title-box"><div class="inv-title">تصميم العميل</div><div class="inv-no">' + esc(number) + '</div></div></div>'
      + '<div class="inv-info">'
      + '<div><span>رقم التصميم</span><b class="num">' + esc(number) + '</b></div>'
      + '<div><span>التاريخ</span><b class="num">' + esc(date) + '</b></div>'
      + '<div class="span2"><span>المحل</span><b>' + esc(s.shopName || 'أصالة نجد') + '</b></div>'
      + '</div>'
      + '<div class="inv-visuals"><div class="inv-design"><div class="imgbox"><img src="' + img + '" alt="مخطط المجلس"></div></div></div>'
      + '<div class="inv-items"><table><thead><tr><th>البند</th><th>التفاصيل</th></tr></thead><tbody>'
      + facts.map(function (f) { return '<tr><td>' + f[0] + '</td><td>' + esc(f[1]) + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + '<div class="inv-bottom"><div class="inv-notes"><b>تواصل معنا</b><br>'
      + contactLines().map(function (c) { return esc(c[0]) + ': ' + esc(c[1]); }).join('<br>')
      + '</div>'
      + (qr ? '<div class="inv-qr"><img src="' + qr + '" alt="رمز التصميم"><small>امسح لعرض التصميم</small></div>' : '')
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
      return pdf.output('blob');
    } finally {
      area.style.cssText = '';
      area.innerHTML = '';
    }
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

  document.addEventListener('DOMContentLoaded', boot);
})();
