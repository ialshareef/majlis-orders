/* ======================================================================
   التصميم الموسّع — نسخة تجريبية (منفصلة)
   ----------------------------------------------------------------------
   مبادئ العزل:
   - لا يلمس js/portal.js ولا portal.html ولا .inv (فاتورة البوابة الحالية).
   - يعيد استخدام js/designer.js (محرك الرسم) كما هو بلا تعديل.
   - كل المعرّفات هنا مسبوقة بـ px، وكل CSS تحت .px.
   - البيانات: يفصلها الخادم (بادئة token مختلفة + جدول designs منفصل)،
     فلا تختلط تصاميم التجربة بتصاميم العملاء الحقيقيين.
   ====================================================================== */
(function (global) {
  'use strict';

  var API_BASE = '/api/portal-expanded';
  var TOKEN_KEY = 'majlis_expanded_token';
  var SEAT_KEY = 'majlis_expanded_seating';
  var MAX_QTY = 99;          // قاعدة النظام القائمة (worker checkDesign يسمح بـ200 قطعة إجمالاً)
  var CDN = {
    qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
    h2c: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
  };

  var S = {
    settings: null, catalog: [], catMap: {},
    design: null, meta: null, designer: null,
    step: 'room', dirty: false, saveTimer: 0, saving: false, dragHide: false,
    zoom: 100, spreadItem: null
  };

  var SEATING = { floor: 'جلسة أرضية', sofa: 'جلسة كنب', arabic: 'جلسة عربية', raised: 'جلسة مرتفعة' };
  var SEAT_HELP = {
    floor: 'مقاعد أرضية مباشرة بلا كنب — تناسب المجالس المفتوحة.',
    sofa: 'مقاعد مرتفعة مع مسند وظهر.',
    arabic: 'مقاعد أرضية مع مسند جانبي وطاولة وسط.',
    raised: 'دكان مرتفع مع مقاعد على الجانبين.'
  };
  var SEAT_ART = {
    floor: '<path d="M4 30h56v8H4z"/><path d="M8 30V18h48v12"/><path d="M14 18v-6h36v6"/>',
    sofa: '<path d="M8 26v-8a4 4 0 0 1 4-4h40a4 4 0 0 1 4 4v8"/><path d="M4 26a4 4 0 0 1 4 4v6h48v-6a4 4 0 0 1 8 0v10H4z"/>',
    arabic: '<path d="M6 32h52v6H6z"/><path d="M10 32V20h16v12"/><path d="M38 32V22h16v10"/><path d="M26 32v-8h10v8"/>',
    raised: '<path d="M6 34h52v4H6z"/><path d="M12 34V22h20v12"/><path d="M36 34V24h16v10"/><path d="M10 22h24v-4H10z"/>'
  };
  var SEAT_ORDER = ['floor', 'sofa', 'arabic', 'raised'];

  var STEPS = [
    { id: 'room', label: 'الغرفة', title: 'الغرفة',
      lead: 'اكتب عرض الغرفة وطولها بالمتر — يتغيّر المخطط أمامك مباشرة.',
      next: 'التالي → العناصر المعمارية' },
    { id: 'openings', label: 'المعمارية', title: 'العناصر المعمارية',
      lead: 'اختر الجدار ثم أضف الباب أو المشب عليه.',
      next: 'التالي → المجلس' },
    { id: 'majlis', label: 'المجلس', title: 'المجلس',
      lead: 'اختر نوع الجلسة ثم اضبط المقاس و«فرش الكل».',
      next: 'التالي → الأثاث' },
    { id: 'furn', label: 'الأثاث', title: 'الأثاث والإكسسوارات',
      lead: 'اضبط كمية كل إكسسوار بالرقم مباشرة، أو اتركها على صفر.',
      next: 'التالي → المراجعة' },
    { id: 'review', label: 'المراجعة', title: 'المراجعة',
      lead: 'راجع ملخص التصميم، ثم أنهِ الطلب ليصل إلى المحل.',
      next: '' }
  ];
  var STEP_INDEX = {};
  STEPS.forEach(function (s, i) { STEP_INDEX[s.id] = i; });

  /* ------------------------------ أدوات ------------------------------ */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); };
  var clamp = function (n, a, b) { return Math.max(a, Math.min(b, n)); };
  var numOf = function (v) { var n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  var toastTimer = 0;
  function toast(msg, kind) {
    var t = $('#pxToast');
    if (!t) return;
    t.textContent = msg || '';
    t.className = 'toast' + (kind === true ? ' err' : kind === 'info' ? ' info' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  }

  /* ------------------------------ عميل API ------------------------------ */
  var apiToken = '';
  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['x-design-token'] = apiToken;
    var res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
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

  /* ------------------------------ الروابط الآمنة ------------------------------ */
  function safeHref(u) {
    var s = String(u || '').trim();
    if (/^https:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return 'https://' + s;
    if (/^[\w.+-]+@[\w.-]+$/.test(s)) return 'mailto:' + s;
    if (/^[+\d][\d\s-]{6,}$/.test(s)) return 'tel:+' + s.replace(/\D/g, '');
    return '';
  }
  var digits = function (v) { return String(v || '').replace(/\D/g, ''); };
  function saudiIntl(raw) {
    var d = digits(raw);
    if (/^00\d+$/.test(d)) d = d.slice(2);
    if (/^966\d{9}$/.test(d)) return d;
    if (/^0\d{9}$/.test(d)) return '966' + d.slice(1);
    if (/^5\d{8}$/.test(d)) return '966' + d;
    return d;
  }
  function formatSaudiIntl(d) {
    var m = /^(966)(5\d)(\d{3})(\d{4})$/.exec(d || '');
    return m ? '+' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] : (d ? '+' + d : '');
  }
  /* قنوات التواصل: من الإعدادات الرسمية فقط — لا شيء مُختلق */
  function contactChannels() {
    var s = S.settings || {};
    var wa = saudiIntl(s.whatsapp) || saudiIntl(s.phone);
    var tel = saudiIntl(s.phone);
    var out = [];
    if (wa) out.push({ key: 'wa', label: 'واتساب', url: 'https://wa.me/' + wa, text: formatSaudiIntl(wa) });
    if (s.instagram) out.push({ key: 'in', label: 'إنستقرام', url: safeHref(s.instagram) });
    if (s.tiktok) out.push({ key: 'tt', label: 'تيك توك', url: safeHref(s.tiktok) });
    if (s.mapsUrl) out.push({ key: 'map', label: 'الموقع', url: safeHref(s.mapsUrl) });
    if (tel) out.push({ key: 'tel', label: 'اتصال', url: 'tel:+' + tel, text: formatSaudiIntl(tel) });
    return out.filter(function (c) { return !!c.url; });
  }
  var CHAN_ICON = {
    wa: '<svg viewBox="0 0 24 24"><path d="M20.5 11.7a8.4 8.4 0 0 1-12.4 7.4L3 20.6l1.6-4.9A8.4 8.4 0 1 1 20.5 11.7z"/></svg>',
    in: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2"/></svg>',
    tt: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>',
    map: '<svg viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    tel: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 19.8 19.8 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a1.8 1.8 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a1.8 1.8 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a1.8 1.8 0 0 1 1.7 2z"/></svg>'
  };

  /* ------------------------------ الجلسة ------------------------------ */
  function show(view) {
    ['pxLanding', 'pxDesign', 'pxDone'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = id !== view;
    });
    global.scrollTo(0, 0);
  }
  function setBusy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  async function boot() {
    try {
      var st = await api('/settings');
      S.settings = st.settings || {};
    } catch (e) { S.settings = {}; }
    paintLanding();
    var t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch (_) { /* noop */ }
    if (t && /^[0-9a-f]{64}$/.test(t)) {
      apiToken = t;
      try {
        var g = await api('/design');
        if (g && g.design) $('#pxResume').hidden = false;
      } catch (e) {
        apiToken = '';
        try { localStorage.removeItem(TOKEN_KEY); } catch (__) { /* noop */ }
      }
    }
    show('pxLanding');
  }

  function paintLanding() {
    var s = S.settings || {};
    $('#pxShopName').textContent = s.shopName || 'أصالة نجد';
    var logo = $('#pxLogo'), fb = $('#pxLogoFallback');
    if (s.logoUrl && logo) { logo.src = s.logoUrl; logo.hidden = false; if (fb) fb.hidden = true; }
    else { if (logo) logo.hidden = true; if (fb) fb.hidden = false; }
    document.title = 'التصميم الموسّع (تجريبي) | ' + (s.shopName || 'أصالة نجد');
    if (s.tagline) $('#pxTagline').textContent = s.tagline;
    var waNum = saudiIntl(s.whatsapp) || '';
    var waHref = safeHref(s.whatsapp) || (waNum ? 'https://wa.me/' + waNum : '');
    [['xlMaps', safeHref(s.mapsUrl)], ['xlTiktok', safeHref(s.tiktok)], ['xlInsta', safeHref(s.instagram)],
     ['xlSnap', safeHref(s.snapchat)], ['xlWa', waHref]].forEach(function (L) {
      var el = document.getElementById(L[0]);
      if (!el) return;
      if (!L[1]) { el.style.display = 'none'; return; }
      el.href = L[1];
    });
    var ph = $('#xlPhone');
    if (ph) { var t = saudiIntl(s.phone); if (t) ph.href = 'tel:+' + t; else ph.style.display = 'none'; }
  }

  $('#pxStart').addEventListener('click', startNew);
  $('#pxResume').addEventListener('click', resume);
  $('#pxNewDesign').addEventListener('click', startNew);

  async function startNew() {
    setBusy($('#pxStart'), true);
    try {
      var r = await api('/session', { method: 'POST', body: {} });
      apiToken = r.token;
      try { localStorage.setItem(TOKEN_KEY, r.token); } catch (_) { /* noop */ }
      S.meta = { number: null, status: 'draft' };
      await loadCatalog();
      enterDesign(null);
    } catch (e) {
      toast(e.message || 'تعذّر بدء التصميم. تحقق من الاتصال.', true);
    } finally { setBusy($('#pxStart'), false); }
  }

  async function resume() {
    try {
      await loadCatalog();
      var g = await api('/design');
      enterDesign(g.design);
      if (g.number) S.meta = { number: g.number, status: g.status };
      S.cust = { name: g.name || '', phone: g.phone || '' };
    } catch (e) { toast(e.message || 'تعذّر فتح التصميم السابق.', true); }
  }

  async function loadCatalog() {
    if (S.catalog.length) return;
    var c = await api('/catalog');
    S.catalog = Array.isArray(c.items) ? c.items : [];
    S.catMap = {};
    S.catalog.forEach(function (i) { S.catMap[i.id] = i; });
  }
  function catItems(cat) { return S.catalog.filter(function (i) { return i.category === cat; }); }

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
    ['fabricId', 'foamId'].forEach(function (f) { var it = S.catMap[p[f]]; if (it) bits.push(it.name); });
    return bits.join(' + ');
  }

  function getSeating() {
    try { var v = localStorage.getItem(SEAT_KEY); if (v && SEATING[v]) return v; } catch (_) { /* noop */ }
    return 'floor';
  }
  function setSeating(v) {
    if (!SEATING[v]) return;
    try { localStorage.setItem(SEAT_KEY, v); } catch (_) { /* noop */ }
  }

  /* ======================================================================
     الكمية:真正的 عدد قطع في البيانات (مجموعة qg)، لا رقم شكلي
     ====================================================================== */
  function accDims(itemId) {
    var it = S.catMap[itemId] || {};
    return { w: Math.max(0.2, Number(it.w) || 0.5), h: Math.max(0.2, Number(it.h) || 0.5), shape: it.shape || 'rect' };
  }
  function accName(itemId) { var it = S.catMap[itemId]; return it ? it.name : 'القطعة'; }
  /* كل نسخ الإكسسوار في التصميم (كل المجموعات) */
  function accPieces(itemId) {
    return (S.designer && S.designer.state.pieces || []).filter(function (x) {
      return x.kind === 'acc' && x.itemId === itemId;
    });
  }
  function accCount(itemId) { return accPieces(itemId).length; }

  /* توزيع ذكي للنسخ داخل الغرفة بتجنّب الأعمدة والجدران — يبقى المنطق الأصلي */
  function placeAccCopies(keep, need) {
    var dz = S.designer;
    if (need <= 0) return { placed: 0, requested: 0 };
    var d = accDims(keep.itemId);
    var spots = dz.findSpots(d.w, d.h, need, 'acc');
    var gid = keep.qg || uid();
    keep.qg = gid;
    spots.forEach(function (s) {
      dz.state.pieces.push({
        id: uid(), kind: 'acc', itemId: keep.itemId,
        x: s.x, y: s.y, w: d.w, h: d.h, rot: 0, shape: d.shape, qg: gid
      });
    });
    dz.resetHistory();
    if (dz.opts && typeof dz.opts.onChange === 'function') dz.opts.onChange();
    dz.render();
    return { placed: spots.length, requested: need };
  }

  /* اضبط الكمية: n=0 يعني حذف العنصر كلياً. يحافظ على المحدد وموضعه. */
  function setAccQty(itemId, n) {
    var dz = S.designer;
    if (!dz) return 0;
    n = Math.floor(Number(n));
    if (!Number.isFinite(n)) return accCount(itemId);
    n = clamp(n, 0, MAX_QTY);
    var all = accPieces(itemId);
    if (n === 0) {
      all.forEach(function (m) {
        var i = dz.state.pieces.indexOf(m);
        if (i >= 0) dz.state.pieces.splice(i, 1);
      });
      if (S.designer.selectionInfo && S.designer.selectionInfo().type === 'piece') {
        var sel = dz.selectedPiece();
        if (sel && sel.itemId === itemId) dz.select(null);
      }
      dz.resetHistory();
      if (dz.opts && typeof dz.opts.onChange === 'function') dz.opts.onChange();
      dz.render();
      renderSheet(null);
      renderPanel();
      return 0;
    }
    // أبقِ المحددة (أو الأولى) وموضعها، واحذف الباقي من نفس الصنف
    var sel = dz.selectedPiece();
    var keep = (sel && sel.kind === 'acc' && sel.itemId === itemId) ? sel : (all[0] || null);
    if (!keep) {
      var d = accDims(itemId);
      var sp = dz.findSpots(d.w, d.h, 1, 'acc');
      if (!sp.length) { toast('لا توجد مساحة فارغة لإضافة ' + accName(itemId), true); return 0; }
      keep = dz.addPiece({ kind: 'acc', itemId: itemId, x: sp[0].x, y: sp[0].y, w: d.w, h: d.h, rot: 0, shape: d.shape, qg: uid() });
      if (!keep) return 0;
      all = accPieces(itemId);
    }
    var gid = keep.qg || uid();
    keep.qg = gid;
    // احذف النسخ الأخرى من نفس الصنف (كل المجموعات: الصنف واحد = كمية واحدة في الواجهة)
    all.forEach(function (m) {
      if (m.id === keep.id) return;
      var i = dz.state.pieces.indexOf(m);
      if (i >= 0) dz.state.pieces.splice(i, 1);
    });
    var r = placeAccCopies(keep, n - 1);
    var placed = 1 + r.placed;
    if (placed < n) {
      toast('المساحة لا تكفي لـ ' + n + ' ' + accName(itemId) + '، وُضع ' + placed + '. عدّل التوزيع يدويًا.', true);
    }
    dz.select({ type: 'piece', id: keep.id });
    return placed;
  }

  /* توزيع متساوٍ: يعيد نشر النسخ على مواضع متوازنة داخل الغرفة */
  function spreadAcc(itemId) {
    var dz = S.designer;
    var all = accPieces(itemId);
    if (all.length < 2) { toast('يلزم قطعتان على الأقل للتوزيع.', 'info'); return; }
    var d = accDims(itemId);
    var spots = dz.findSpots(d.w, d.h, all.length, 'acc');
    if (spots.length < all.length) {
      toast('المساحة لا تكفي لتوزيع ' + all.length + ' قطعة بالتساوي.', true);
      return;
    }
    all.forEach(function (p, i) {
      p.x = spots[i].x; p.y = spots[i].y; p.w = d.w; p.h = d.h; p.rot = 0; p.shape = d.shape;
    });
    dz.resetHistory();
    if (dz.opts && typeof dz.opts.onChange === 'function') dz.opts.onChange();
    dz.render();
    renderSheet(dz.selectionInfo());
    toast('وُزّع ' + all.length + ' ' + accName(itemId) + ' بالتساوي.');
  }

  function portalAddAcc(itemId) {
    var dz = S.designer;
    var it = S.catMap[itemId];
    if (!dz || !it) return null;
    var d = accDims(itemId);
    var spots = dz.findSpots(d.w, d.h, 1, 'acc');
    if (!spots.length) { toast('لا توجد مساحة فارغة لإضافة ' + it.name, true); return null; }
    return dz.addPiece({
      kind: 'acc', itemId: it.id, x: spots[0].x, y: spots[0].y,
      w: d.w, h: d.h, rot: 0, shape: d.shape, qg: uid()
    });
  }

  /* ======================================================================
     المحرّك والحالة
     ====================================================================== */
  function enterDesign(design) {
    S.design = null; S.dirty = false; S.step = 'room';
    S.cust = S.cust || { name: '', phone: '' };
    show('pxDesign');
    buildSteps();
    wireStatic();
    var dz = new Designer($('#pxCanvas'), {
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
      onSelect: function (info) { renderSheet(info); }
    });
    S.designer = dz;
    dz.canvas.addEventListener('pointermove', function (e) {
      if (!e || e.pointerType !== 'touch') return;
      var d = dz.drag;
      if (!d || d.moved !== true) return;
      if (['move', 'resizeW', 'resizeH', 'rotate', 'opening'].indexOf(d.mode) < 0) return;
      S.dragHide = true;
      var sh = $('#pxSheet');
      if (sh && !sh.hidden) sh.hidden = true;
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
    var el = $('#pxSaveState');
    if (el) el.textContent = 'يُحفظ…';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveDraft, 1200);
  }
  async function saveDraft() {
    if (!apiToken || S.saving || !S.designer) return;
    S.saving = true;
    try {
      await api('/save', { method: 'POST', body: { design: S.designer.getState() } });
      S.dirty = false;
      var el = $('#pxSaveState'); if (el) el.textContent = 'محفوظ ✓';
    } catch (e) {
      var el2 = $('#pxSaveState'); if (el2) el2.textContent = 'تعذّر الحفظ';
    } finally { S.saving = false; }
  }

  function buildSteps() {
    var box = $('#pxSteps');
    box.innerHTML = STEPS.map(function (s, i) {
      return '<button type="button" data-step="' + s.id + '" class="' + (s.id === S.step ? 'active' : '')
        + '" aria-current="' + (s.id === S.step) + '"><i>' + (i + 1) + '</i><span>' + esc(s.label) + '</span></button>';
    }).join('');
    $$('button', box).forEach(function (b) {
      b.addEventListener('click', function () { gotoStep(b.dataset.step); });
    });
  }
  function gotoStep(id) {
    if (!STEP_INDEX.hasOwnProperty(id)) return;
    // نحفظ الاختيارات قبل مغادرة المرحلة (الاسم/الجوال)
    keepCust();
    S.step = id;
    if (id !== 'openings') setChosenWall(null);
    buildSteps();
    renderPanel();
    renderNav();
    if (S.designer) { S.designer.autoFit = true; S.designer.fitView(); }
    renderSheet(null);
  }
  function renderNav() {
    var i = STEP_INDEX[S.step];
    var cur = STEPS[i];
    var host = $('#pxDesign');
    if (host) host.dataset.step = S.step;
    var prev = $('#pxPrevStep'), next = $('#pxNextStep');
    if (prev) prev.hidden = i <= 0;
    if (!next) return;
    if (!STEPS[i + 1]) { next.textContent = 'إنهاء التصميم ↓'; return; }
    next.textContent = (cur && cur.next) || ('التالي → ' + STEPS[i + 1].title);
  }

  function wireStatic() {
    var zl = function () { var e = $('#pxZoomVal'); if (e) e.textContent = S.zoom + '%'; };
    $('#pxZoomIn').onclick = function () {
      if (!S.designer) return;
      S.designer.zoomAt(1.25); S.zoom = Math.min(400, Math.round(S.zoom * 1.25)); zl();
    };
    $('#pxZoomOut').onclick = function () {
      if (!S.designer) return;
      S.designer.zoomAt(0.8); S.zoom = Math.max(25, Math.round(S.zoom * 0.8)); zl();
    };
    $('#pxZoomFit').onclick = function () {
      if (!S.designer) return;
      S.designer.fitView(); S.zoom = 100; zl();
    };
    zl();
    $('#pxUndo').onclick = function () { if (S.designer) S.designer.undo(); };
    $('#pxBack').onclick = function () { show('pxLanding'); };
    $('#pxPrevStep').onclick = function () {
      var i = STEP_INDEX[S.step];
      if (i > 0) gotoStep(STEPS[i - 1].id);
    };
    $('#pxNextStep').onclick = function () {
      var nx = STEPS[STEP_INDEX[S.step] + 1];
      if (nx) { gotoStep(nx.id); return; }
      finishDesign();
    };
  }

  /* الجدار المستهدف: قائمة المرحلة الثانية، أو لمس الجدار، أو الافتراضي */
  var chosenWall = null;
  function setChosenWall(i) { chosenWall = (i == null) ? null : i; }
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

  function currentSpec() {
    var spec = { seating: getSeating(), depth: Math.max(0.3, numOf(($('#pxDepth') || {}).value) || S.majDepth || 0.8) };
    var len = numOf(($('#pxMajLen') || {}).value);
    if (len != null && len >= 0.5) { S.majLen = len; spec.w = len; }
    else if (S.majLen) { spec.w = S.majLen; }
    [['fabricId', 'pxFabric'], ['foamId', 'pxFoam']].forEach(function (pair) {
      var el = document.getElementById(pair[1]);
      var id = el && el.value;
      if (id && S.catMap[id]) spec[pair[0]] = id;
    });
    return spec;
  }
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
    toast(n ? ('تم فرش ' + n + ' من ' + kind + ' — يمكنك تعديل أي قطعة بالسحب') : 'لا توجد مساحات فارغة على الجدران', n ? false : 'info');
    renderSheet(null);
  }

  /* ======================================================================
     لوحات المراحل
     ====================================================================== */
  function renderPanel() {
    var box = $('#pxPanel');
    var dz = S.designer;
    var cur = null;
    STEPS.forEach(function (s) { if (s.id === S.step) cur = s; });
    var ttl = $('#pxStepTitle');
    if (ttl && cur) {
      ttl.textContent = cur.title;
      var old = $('#pxStepLead');
      if (cur.lead) {
        if (!old) { old = document.createElement('p'); old.id = 'pxStepLead'; old.className = 'px-step-lead'; ttl.after(old); }
        old.textContent = cur.lead; old.hidden = false;
      } else if (old) old.hidden = true;
    }
    if (!dz) { box.innerHTML = ''; return; }

    if (S.step === 'room') {
      var ws = (dz.state && dz.state.walls) || [];
      box.innerHTML = ''
        + '<div class="row2">'
        + '<label>عرض الغرفة <span class="px-unit">(متر)</span><input id="pxW" type="number" step="0.1" min="0.5" max="30" inputmode="decimal" value="' + (ws[0] ? ws[0].len : 5) + '"></label>'
        + '<label>طول الغرفة <span class="px-unit">(متر)</span><input id="pxH" type="number" step="0.1" min="0.5" max="30" inputmode="decimal" value="' + (ws[1] ? ws[1].len : 4) + '"></label>'
        + '</div>'
        + '<p class="hint">اضغط على الرقم فيتحدّد كاملًا — اكتب المقاس الجديد. المخطط يتغير فورًا، وأزرار التكبير أعلى الرسم.</p>';
      ['#pxW', '#pxH'].forEach(function (sel) {
        var el = $(sel);
        el.addEventListener('input', function () {
          var v = numOf(el.value);
          if (v == null || v < 0.5 || v > 30) return;
          dz.setWallLength(sel === '#pxW' ? 0 : 1, Math.round(v * 10) / 10);
        });
        el.addEventListener('focus', function () { try { el.select(); } catch (_) { /* noop */ } });
        el.addEventListener('pointerdown', function () { setTimeout(function () { try { el.select(); } catch (_) { /* noop */ } }, 0); });
      });

    } else if (S.step === 'openings') {
      var walls = (dz.state && dz.state.walls) || [];
      var ops = (dz.state && dz.state.openings) || [];
      box.innerHTML = ''
        + '<div class="px-optgrid"><div class="px-opt">'
        + '<label for="pxOWall">الجدار — أين تريد الباب أو المشب؟</label>'
        + '<select id="pxOWall">' + walls.map(function (w, i) {
            return '<option value="' + i + '"' + (i === targetWall() ? ' selected' : '') + '>جدار ' + (i + 1) + '</option>';
          }).join('') + '</select></div></div>'
        + '<div class="px-optgrid two">'
        + '<div class="px-opt"><button type="button" class="btn" data-add="door"><svg><use href="#x-door"/></svg><span>باب</span></button>'
        + '<small>باب على الجدار المختار</small></div>'
        + '<div class="px-opt"><button type="button" class="btn" data-add="mashab"><svg><use href="#x-fire"/></svg><span>مشب</span></button>'
        + '<small>مشب على الجدار المختار</small></div>'
        + '</div>'
        + '<p class="hint">لتغيير موضع الباب أو المشب: اسحبه على الجدار — تظهر المسافات من طرفيه أثناء السحب. لإزالته: المسه ثم «حذف».</p>'
        + '<div id="pxOps">' + (ops.length ? ops.map(function (o) {
            var onm = { door: 'باب', window: 'شباك', mashab: 'مشب' }[o.type] || 'عنصر';
            return '<div class="px-wallrow"><span>' + onm + ' — جدار ' + (o.wall + 1) + '</span>'
              + '<span class="px-opw"><button type="button" class="btn" data-opwminus="' + esc(o.id) + '" aria-label="تضييق">−</button>'
              + '<input type="number" step="0.1" min="0.3" inputmode="decimal" data-opw="' + esc(o.id) + '" value="' + o.w + '" aria-label="عرض ' + onm + '">'
              + '<button type="button" class="btn" data-opwplus="' + esc(o.id) + '" aria-label="توسيع">+</button></span>'
              + '<button type="button" class="icon-btn" data-opdel="' + esc(o.id) + '" aria-label="حذف"><svg><use href="#x-trash"/></svg></button></div>';
          }).join('') : '') + ((!ops.length) ? '<p class="hint">لم تضف بابًا أو مشبًا بعد.</p>' : '') + '</div>';
      $$('button[data-add]', box).forEach(function (b) {
        b.addEventListener('click', function () { addOpeningOf(b.dataset.add); renderPanel(); });
      });
      var owSel = $('#pxOWall', box);
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
          opSetW(b.dataset.opwminus, (numOf(inp.value) || 0) - 0.1);
        });
      });
      $$('button[data-opwplus]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var inp = box.querySelector('input[data-opw="' + b.dataset.opwplus + '"]');
          opSetW(b.dataset.opwplus, (numOf(inp.value) || 0) + 0.1);
        });
      });
      $$('input[data-opw]', box).forEach(function (inp) {
        inp.addEventListener('change', function () { opSetW(inp.dataset.opw, numOf(inp.value)); });
      });
      $$('button[data-opdel]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var o = dz.opening(b.dataset.opdel);
          if (o) { dz.select({ type: 'opening', id: o.id }); dz.removeSelected(); }
          renderPanel();
        });
      });

    } else if (S.step === 'majlis') {
      var seat = getSeating();
      box.innerHTML = ''
        + '<select id="pxSeat" class="px-hidden-sel" aria-hidden="true" tabindex="-1">'
        + SEAT_ORDER.map(function (k) { return '<option value="' + k + '"' + (k === seat ? ' selected' : '') + '>' + SEATING[k] + '</option>'; }).join('')
        + '</select>'
        + '<div class="px-seats" role="group" aria-label="نوع الجلسة">' + SEAT_ORDER.map(function (k) {
            return '<button type="button" class="px-seat" data-seat="' + k + '" aria-pressed="' + (k === seat ? 'true' : 'false') + '">'
              + '<span class="px-seat-art" aria-hidden="true"><svg viewBox="0 0 64 40">' + SEAT_ART[k] + '</svg></span>'
              + '<span>' + SEATING[k] + '</span><small>' + esc(SEAT_HELP[k]) + '</small></button>';
          }).join('') + '</div>'
        + '<div class="row2">'
        + '<label>طول القطعة <span class="px-unit">(متر)</span><input id="pxMajLen" type="number" step="0.1" min="0.5" max="12" inputmode="decimal" value="' + (S.majLen || 3) + '"></label>'
        + '<label>عمق المجلس <span class="px-unit">(متر)</span><input id="pxDepth" type="number" step="0.05" min="0.3" max="2" inputmode="decimal" value="' + (S.majDepth || 0.8) + '"></label>'
        + '</div>'
        + '<div class="px-opt"><button type="button" class="btn primary" id="pxFillMajlis">فرش كل الجدران</button>'
        + '<small>يوزّع المجلس على الجدران الفارغة بالمقاس الذي حددته. بعد الفرش اسحب أي قطعة لتغيير مكانها أو حجمها.</small></div>'
        + '<select id="pxFabric" class="px-hidden-sel" aria-hidden="true" tabindex="-1">' + optList(catItems('fabric')) + '</select>'
        + '<select id="pxFoam" class="px-hidden-sel" aria-hidden="true" tabindex="-1">' + optList(catItems('foam')) + '</select>';
      var saveMaj = function () {
        var L = numOf($('#pxMajLen').value), D = numOf($('#pxDepth').value);
        if (L != null && L >= 0.5) S.majLen = L;
        if (D != null && D >= 0.3) S.majDepth = D;
      };
      [$('#pxMajLen'), $('#pxDepth')].forEach(function (el) {
        el.addEventListener('input', function () { try { el.select(); } catch (_) { /* noop */ } });
        el.addEventListener('change', saveMaj);
      });
      $$('button[data-seat]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          setSeating(b.dataset.seat);
          $$('button[data-seat]', box).forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.seat === b.dataset.seat)); });
          markDirty();
        });
      });
      $('#pxSeat').onchange = function () { setSeating($('#pxSeat').value); };
      $('#pxFillMajlis').onclick = function () { saveMaj(); fillAll(); };

    } else if (S.step === 'furn') {
      var accs = catItems('acc');
      box.innerHTML = ''
        + '<h4 class="px-subhead">الإكسسوارات <small>— ' + accs.length + ' عنصر · اضغط الرقم لتكتب العدد مباشرة</small></h4>'
        + '<div class="px-accgrid" id="pxAccGrid">' + (accs.length ? accs.map(function (a) {
            var n = accCount(a.id);
            return '<div class="px-acc" data-accwrap="' + esc(a.id) + '" aria-pressed="' + (n ? 'true' : 'false') + '">'
              + '<span class="px-acc-art' + (a.shape === 'circle' ? ' circle' : '') + '" style="background:' + esc(a.color || '#7A5230') + '" aria-hidden="true">'
              + (CHAN_ICON[a.shape === 'circle' ? 'map' : 'pin'] || '') + '</span>'
              + '<span class="px-acc-name">' + esc(a.name) + '</span>'
              + '<span class="px-qtybar">'
              + '<button type="button" class="qbtn" data-qtyminus="' + esc(a.id) + '" aria-label="إنقاص ' + esc(a.name) + '"><svg><use href="#x-minus"/></svg></button>'
              + '<input class="px-qtyval num" data-qtyin="' + esc(a.id) + '" type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="0" max="' + MAX_QTY + '" value="' + n + '" aria-label="عدد ' + esc(a.name) + '">'
              + '<button type="button" class="qbtn" data-qtyplus="' + esc(a.id) + '" aria-label="زيادة ' + esc(a.name) + '"><svg><use href="#x-plus"/></svg></button>'
              + '</span>'
              + '<span class="px-acc-foot"><button type="button" class="px-spread" data-spread="' + esc(a.id) + '">توزيع متساوٍ</button></span>'
              + '</div>';
          }).join('') : '<p class="hint">لا توجد إكسسوارات متاحة حالياً.</p>') + '</div>'
        + '<button type="button" class="btn ghost block" id="pxFreeSpace">+ مساحة أرضية فارغة</button>'
        + '<p class="hint">اكتب 0 في مربع العدد لحذف العنصر من التصميم. الحد الأقصى ' + MAX_QTY + ' قطعة.</p>';

      $$('button[data-qtyminus]', box).forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = b.dataset.qtyminus;
          setAccQty(id, Math.max(0, accCount(id) - 1));
          renderPanel();
        });
      });
      $$('button[data-qtyplus]', box).forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = b.dataset.qtyplus;
          var n = Math.min(MAX_QTY, accCount(id) + 1);
          if (accCount(id) === 0) n = 1;
          setAccQty(id, n);
          renderPanel();
        });
      });
      /* الإدخال اليدوي: يُطبَّق عند blur أو Enter (لا استجابة لكل ضغطة مفتاح) */
      $$('input[data-qtyin]', box).forEach(function (inp) {
        inp.addEventListener('click', function (e) { e.stopPropagation(); inp.select(); });
        var commit = function () {
          var id = inp.dataset.qtyin;
          var raw = inp.value.trim();
          var v = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
          if (v == null) {                       // رفض السالب والحروف: نعيد العدد الحقيقي
            inp.value = String(accCount(id));
            if (raw !== '') toast('أدخل عددًا صحيحًا (0 أو أكثر).', true);
            return;
          }
          if (v > MAX_QTY) { toast('الحد الأقصى ' + MAX_QTY + ' قطعة.', true); }
          setAccQty(id, v);
          renderPanel();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('change', commit);
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        });
      });
      $$('button[data-spread]', box).forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); spreadAcc(b.dataset.spread); renderPanel(); });
      });
      $('#pxFreeSpace').onclick = function () { dz.addFreeSpace(); renderPanel(); };

    } else if (S.step === 'review') {
      renderReviewPanel(box, dz);
    }
  }

  function optList(items, val, emptyLabel) {
    return '<option value="">' + esc(emptyLabel || 'غير محدد') + '</option>'
      + items.map(function (i) { return '<option value="' + esc(i.id) + '"' + (i.id === val ? ' selected' : '') + '>' + esc(i.name) + '</option>'; }).join('');
  }

  /* ======================================================================
     أدوات العنصر المحدد: مباشرة تحت المخطط، بلا قوائم إضافية
     ====================================================================== */
  function renderSheet(info) {
    var sh = $('#pxSheet');
    var dz = S.designer;
    if (!dz || !info || S.dragHide) { if (sh) { sh.hidden = true; sh.innerHTML = ''; } return; }
    if (info.type === 'wall') {
      // لا نوافذ للجدار: المقاسات تُعدّل من المرحلة الأولى فقط
      sh.hidden = true; sh.innerHTML = '';
      return;
    }
    var html = '';
    if (info.type === 'opening') {
      var o = info.opening;
      var onm = { door: 'باب', window: 'شباك', mashab: 'مشب' }[o.type] || 'عنصر';
      html += '<div class="px-sheet-head"><b>' + onm + ' — جدار ' + (o.wall + 1) + '</b></div>'
        + '<div class="px-qtybar">'
        + '<button type="button" class="qbtn" data-owminus aria-label="تضييق"><svg><use href="#x-minus"/></svg></button>'
        + '<input class="px-qtyval num" id="pxOW" type="number" step="0.1" min="0.3" inputmode="decimal" value="' + o.w + '" aria-label="عرض بالمتر">'
        + '<button type="button" class="qbtn" data-owplus aria-label="توسيع"><svg><use href="#x-plus"/></svg></button>'
        + '<span class="px-sheet-title">متر</span></div>'
        + '<div class="px-tools">'
        + '<button type="button" class="tbtn" data-odel><svg><use href="#x-trash"/></svg><span>حذف</span></button>'
        + '</div>';
      sh.innerHTML = html; sh.hidden = false;
      var step = function (d) {
        var el = $('#pxOW', sh);
        var v = Math.max(0.3, Math.round(((numOf(el.value) || o.w) + d) * 10) / 10);
        el.value = v; dz.updateOpening(o.id, { w: v }); markDirty();
      };
      var mw = $('[data-owminus]', sh); if (mw) mw.onclick = function () { step(-0.1); };
      var pw = $('[data-owplus]', sh); if (pw) pw.onclick = function () { step(0.1); };
      var ow = $('#pxOW', sh);
      if (ow) ow.addEventListener('change', function () {
        var v = Math.max(0.3, numOf(ow.value) || o.w);
        ow.value = v; dz.updateOpening(o.id, { w: v }); markDirty();
      });
      var odel = $('[data-odel]', sh);
      if (odel) odel.onclick = function () { dz.removeSelected(); renderSheet(null); renderPanel(); };
      return;
    }

    // قطعة (كنب/إكسسوار/مساحة)
    var p = info.piece;
    var nm = pieceLabel(p);
    var count = 0;
    html += '<div class="px-sheet-head"><b>' + esc(nm) + '</b>'
      + '<span class="px-sheet-title">' + (p.kind === 'acc' ? 'إكسسوار' : p.kind === 'sofa' ? 'مجلس' : 'قطعة') + '</span></div>';

    // أدوات مشتركة: نقل بالسحب على الرسم، وهذه أفعال فورية
    html += '<div class="px-tools">'
      + '<button type="button" class="tbtn" data-rot><svg><use href="#x-rot"/></svg><span>تدوير</span></button>'
      + '<button type="button" class="tbtn" data-dup><svg><use href="#x-copy"/></svg><span>نسخ</span></button>'
      + '<button type="button" class="tbtn" data-del><svg><use href="#x-trash"/></svg><span>حذف</span></button>'
      + '<button type="button" class="tbtn" data-done><svg><use href="#x-check"/></svg><span>تم</span></button>'
      + '</div>';
    if (p.kind === 'acc') {
      count = accCount(p.itemId);
      html += '<div class="px-qtybar">'
        + '<button type="button" class="qbtn" data-qminus aria-label="إنقاص"><svg><use href="#x-minus"/></svg></button>'
        + '<input class="px-qtyval num" id="pxQty" type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="0" max="' + MAX_QTY + '" value="' + count + '" aria-label="كمية ' + esc(nm) + '">'
        + '<button type="button" class="qbtn" data-qplus aria-label="زيادة"><svg><use href="#x-plus"/></svg></button>'
        + '<span class="px-sheet-title">قطعة</span></div>';
    }
    if (p.kind !== 'acc') {
      html += '<div class="row2">'
        + '<label>الطول <span class="px-unit">(م)</span><input id="pxPW" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + p.w + '"></label>'
        + '<label>' + (p.kind === 'sofa' ? 'العمق' : 'العرض') + ' <span class="px-unit">(م)</span><input id="pxPH" type="number" step="0.05" min="0.2" inputmode="decimal" value="' + p.h + '"></label>'
        + '</div>';
    }
    sh.innerHTML = html;
    sh.hidden = false;

    var act = function (sel, fn) { var el = $(sel, sh); if (el) el.onclick = function () { fn(); renderSheet(dz.selectionInfo()); renderPanel(); }; };
    act('[data-rot]', function () { dz.rotateSelected(90); });
    act('[data-dup]', function () { dz.duplicateSelected(); });
    act('[data-del]', function () { dz.removeSelected(); renderSheet(null); });
    act('[data-done]', function () { dz.select(null); renderSheet(null); });

    var wIn = $('#pxPW', sh);
    if (wIn) wIn.addEventListener('change', function () { dz.updateSelected({ w: Math.max(0.2, numOf(wIn.value) || 0.2) }); });
    var hIn = $('#pxPH', sh);
    if (hIn) hIn.addEventListener('change', function () { dz.updateSelected({ h: Math.max(0.2, numOf(hIn.value) || 0.2) }); });

    if (p.kind === 'acc') {
      var qtyCommit = function () {
        var q = $('#pxQty', sh);
        if (!q) return;
        var raw = q.value.trim();
        var v = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
        if (v == null) { q.value = String(accCount(p.itemId)); if (raw !== '') toast('أدخل عددًا صحيحًا (0 أو أكثر).', true); return; }
        setAccQty(p.itemId, v);
        renderPanel();
        renderSheet(S.designer.selectionInfo());
      };
      var qm = $('[data-qminus]', sh);
      if (qm) qm.onclick = function () { setAccQty(p.itemId, Math.max(0, accCount(p.itemId) - 1)); renderPanel(); renderSheet(dz.selectionInfo()); };
      var qp = $('[data-qplus]', sh);
      if (qp) qp.onclick = function () { setAccQty(p.itemId, Math.min(MAX_QTY, Math.max(1, accCount(p.itemId) + 1))); renderPanel(); renderSheet(dz.selectionInfo()); };
      var qi = $('#pxQty', sh);
      if (qi) { qi.addEventListener('click', function () { qi.select(); }); qi.addEventListener('blur', qtyCommit); qi.addEventListener('change', qtyCommit);
        qi.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); qi.blur(); } }); }
    }
  }

  /* ======================================================================
     المرحلة ٥: ملخص + رجوع + تحقق + إنهاء واحد
     ====================================================================== */
  function keepCust() {
    var n = $('#pxName'), p = $('#pxPhone');
    S.cust = { name: (n && n.value) || (S.cust && S.cust.name) || '', phone: (p && p.value) || (S.cust && S.cust.phone) || '' };
  }

  /* ملخص التصميم من البيانات الحقيقية فقط */
  function designSummary(st) {
    st = st || (S.designer && S.designer.getState()) || { walls: [], openings: [], pieces: [] };
    var walls = (st.walls || []).map(function (w) { return Number(w.len); });
    var w1 = walls[0] != null ? walls[0] : 0, h1 = walls[1] != null ? walls[1] : 0;
    var doors = 0, mashabs = 0, windows = 0, cols = 0;
    (st.openings || []).forEach(function (o) {
      if (o.type === 'door') doors++; else if (o.type === 'mashab') mashabs++; else if (o.type === 'window') windows++;
    });
    var seats = {}, meters = 0, accs = {}, free = 0;
    (st.pieces || []).forEach(function (p) {
      if (p.kind === 'sofa') { meters += Number(p.w) || 0; var s = SEATING[p.seating] || SEATING.floor; seats[s] = (seats[s] || 0) + 1; }
      else if (p.kind === 'acc') { var a = S.catMap[p.itemId]; var n = a ? a.name : 'إكسسوار'; accs[n] = (accs[n] || 0) + 1; }
      else if (p.kind === 'column') cols++;
      else free++;
    });
    var seatTxt = Object.keys(seats).map(function (k) { return k + ' ×' + seats[k]; }).join('، ');
    var accRows = Object.keys(accs).map(function (k) { return { name: k, qty: accs[k] }; });
    var area = (w1 > 0 && h1 > 0) ? Math.round(w1 * h1 * 100) / 100 : null;
    return {
      w: w1, h: h1, area: area, doors: doors, mashabs: mashabs, windows: windows, cols: cols,
      free: free, meters: Math.round(meters * 100) / 100, seatTxt: seatTxt || 'جلسة أرضية',
      accRows: accRows, total: accRows.reduce(function (s, r) { return s + r.qty; }, 0)
    };
  }

  function renderReviewPanel(box, dz) {
    var cust = S.cust || { name: '', phone: '' };
    var sum = designSummary();
    var rows = sum.accRows.length
      ? sum.accRows.map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td class="num">' + r.qty + '</td></tr>'; }).join('')
      : '<tr><td colspan="2" class="hint">لم تضف إكسسوارات</td></tr>';
    box.innerHTML = ''
      + '<img id="pxReviewImg" class="px-preview" alt="معاينة المخطط">'
      + '<div class="px-summary">'
      + '<div class="srow"><span>مقاسات الغرفة</span><b class="num">' + sum.w + ' × ' + sum.h + ' م</b></div>'
      + (sum.area != null ? '<div class="srow"><span>المساحة</span><b class="num">' + sum.area + ' م²</b></div>' : '')
      + '<div class="srow"><span>نوع الجلسة</span><b>' + esc(sum.seatTxt) + '</b></div>'
      + '<div class="srow"><span>أمتار الكنب</span><b class="num">' + sum.meters + ' م</b></div>'
      + '<div class="srow"><span>الأبواب / المشب</span><b class="num">' + sum.doors + ' / ' + sum.mashabs + '</b></div>'
      + '<div class="srow"><span>إجمالي الإكسسوارات</span><b class="num">' + sum.total + ' قطعة</b></div>'
      + '</div>'
      + '<table class="px-qtable"><thead><tr><th>الإكسسوار</th><th class="num">الكمية</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="row2">'
      + '<label>الاسم (اختياري)<input id="pxName" maxlength="60" placeholder="اسمك" autocomplete="name" value="' + esc(cust.name) + '"></label>'
      + '<label>رقم الجوال (اختياري)<input id="pxPhone" type="tel" inputmode="tel" placeholder="05xxxxxxxx" autocomplete="tel" value="' + esc(cust.phone) + '"></label>'
      + '</div>'
      + '<p class="px-validate" id="pxValidate" role="status"></p>'
      + '<h4 class="px-subhead">العودة لتعديل خطوة</h4>'
      + '<div class="px-backrow">' + STEPS.slice(0, 4).map(function (s, i) {
          return '<button type="button" class="btn" data-back="' + s.id + '">' + (i + 1) + '. ' + esc(s.label) + '</button>';
        }).join('') + '</div>'
      + '<div class="px-acts">'
      + '<button type="button" class="btn" id="pxActPdf">تصدير PDF</button>'
      + '<button type="button" class="btn" id="pxActWa">مشاركة واتساب</button>'
      + '<button type="button" class="btn" id="pxActRefresh">تحديث المعاينة</button>'
      + '<button type="button" class="btn primary" id="pxSubmitDesign">إنهاء التصميم</button>'
      + '</div>'
      + '<p class="error" id="pxReviewErr" role="alert"></p>'
      + '<p class="hint">ملاحظة: هذه نسخة تجريبية — التصميم يُحفظ في مساحة التجربة ولا يصل كطلب مؤكد.</p>';

    var refresh = function () {
      try {
        var st = dz.getState();
        var img = $('#pxReviewImg', box);
        if (img) img.src = designImage(st, 1000);
      } catch (e) { /* noop */ }
    };
    refresh();
    var validate = function () {
      var el = $('#pxValidate', box);
      if (!el) return true;
      var nm = (($('#pxName', box) || {}).value || '').trim();
      var ph = (($('#pxPhone', box) || {}).value || '').trim();
      if (!nm && !ph) { el.className = 'px-validate ok'; el.textContent = 'يمكنك إنهاء التصميم بدون بيانات، أو أضف اسمك ورقمك ليتواصل معك المحل.'; return true; }
      if (nm.length < 2) { el.className = 'px-validate err'; el.textContent = 'الاسم قصير جدًا (حرفان على الأقل).'; return false; }
      if (ph && !/^\+?[\d\s-]{7,16}$/.test(ph)) { el.className = 'px-validate err'; el.textContent = 'رقم الجوال غير صالح.'; return false; }
      el.className = 'px-validate ok'; el.textContent = 'البيانات مقبولة ✓';
      return true;
    };
    ['pxName', 'pxPhone'].forEach(function (id) {
      var el = $('#' + id, box);
      if (el) { el.addEventListener('input', function () { keepCust(); validate(); }); el.addEventListener('blur', validate); }
    });
    validate();
    $$('button[data-back]', box).forEach(function (b) { b.addEventListener('click', function () { gotoStep(b.dataset.back); }); });
    $('#pxActPdf', box).onclick = function () { keepCust(); reviewPdf(); };
    $('#pxActWa', box).onclick = function () { keepCust(); reviewShare(); };
    $('#pxActRefresh', box).onclick = function () { keepCust(); refresh(); toast('حُدّثت المعاينة'); };
    $('#pxSubmitDesign', box).onclick = finishDesign;
  }

  /* الإجراء الوحيد للإنهاء — تستخدمه كل أزرار «إنهاء» (بما فيها السفلي) */
  var finishing = false;
  async function finishDesign() {
    if (finishing) return;
    if (!validateForFinish()) return;
    var box = $('#pxPanel');
    var btns = [$('#pxSubmitDesign', box), $('#pxNextStep')].filter(Boolean);
    if (btns.some(function (b) { return b.disabled; })) return;
    var name = (($('#pxName', box) || {}).value || '').trim();
    var phone = (($('#pxPhone', box) || {}).value || '').trim();
    S.cust = { name: name, phone: phone };
    finishing = true;
    btns.forEach(function (b) { b.disabled = true; });
    var live = $('#pxNextStep');
    var oldTxt = live ? live.textContent : '';
    if (live) live.textContent = 'جارٍ الإنهاء…';
    var errBox = $('#pxReviewErr', box);
    if (errBox) errBox.textContent = '';
    try {
      await saveDraft();
      if (name || phone) {
        await api('/save', { method: 'POST', body: { design: S.designer.getState(), name: name, phone: phone } });
      }
      var r = await api('/finish', { method: 'POST', body: {} });
      S.meta = { number: r.number, status: r.status };
      showDone(r.number);   // رسالة النجاح تظهر بعد نجاح الاستجابة فعليًا
    } catch (e) {
      finishing = false;
      btns.forEach(function (b) { b.disabled = false; });
      if (live) live.textContent = oldTxt;
      if (errBox) { errBox.textContent = e.message || 'تعذّر إنهاء التصميم.'; errBox.scrollIntoView({ block: 'nearest' }); }
    }
  }
  function validateForFinish() {
    var box = $('#pxPanel');
    var el = $('#pxValidate', box);
    var nm = (($('#pxName', box) || {}).value || '').trim();
    var ph = (($('#pxPhone', box) || {}).value || '').trim();
    if (!nm && !ph) return true;
    if (nm.length < 2) {
      if (el) { el.className = 'px-validate err'; el.textContent = 'الاسم قصير جدًا (حرفان على الأقل).'; el.scrollIntoView({ block: 'nearest' }); }
      return false;
    }
    if (ph && !/^\+?[\d\s-]{7,16}$/.test(ph)) {
      if (el) { el.className = 'px-validate err'; el.textContent = 'رقم الجوال غير صالح.'; el.scrollIntoView({ block: 'nearest' }); }
      return false;
    }
    return true;
  }

  function showDone(number) {
    var el = $('#pxDesignNo');
    if (el) el.textContent = number;
    var cb = $('#pxContactBox'); if (cb) cb.hidden = true;
    var co = $('#pxContactOk'); if (co) co.hidden = true;
    var ce = $('#pxContactErr'); if (ce) ce.textContent = '';
    show('pxDone');
  }

  /* ======================================================================
     PDF المحسّن — غلاف + تفاصيل + ختام. بلا أي سعر أو بيانات مُختلقة.
     ====================================================================== */
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
  async function qrDataUrl(text) {
    try { await loadScript(CDN.qr); } catch (_) { return ''; }
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(text); qr.make();
      return qr.createDataURL(4, 0);
    } catch (_) { return ''; }
  }

  function designImage(design, W) {
    W = W || 1400;
    var off = new Designer(document.createElement('canvas'), {
      getItem: getCatItem, pieceSpecLabel: function () { return ''; }, pieceStyle: function () { return null; }
    });
    off.setState(JSON.parse(JSON.stringify(design)));
    var H = Math.max(400, Math.round(W / off.aspect()));
    return off.toImage(W, H);
  }

  /* شعار الغلاف/الختام: نستخدم أيقونة SVG **مضمّنة** (inline paths) لا <use href="#id">،
   لأن <use> لا يعمل داخل حاوية الطباعة offscreen فيلتقطها html2canvas كمستطيل لوني. */
var LOGO_MARK = '<svg viewBox="0 0 24 24"><path d="M6 11V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4"/>'
  + '<path d="M3 13a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5H3z"/><path d="M5 18v2M19 18v2M3 15h18"/></svg>';

async function buildExpandedDoc(number) {
    var s = S.settings || {};
    var st = S.designer.getState();
    var sum = designSummary(st);
    var img = designImage(st, 1600);
    var noTxt = number || 'مسودة (لم يُنهَ بعد)';
    var d = new Date();
    var date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var cust = S.cust || { name: '', phone: '' };

    var chans = contactChannels();
    var chanHtml = '';
    for (var i = 0; i < chans.length; i++) {
      var c = chans[i];
      var cq = await qrDataUrl(c.url);
      chanHtml += '<div class="xp-chan" data-url="' + esc(c.url) + '">'
        + '<span class="xp-chan-ic ' + c.key + '">' + (CHAN_ICON[c.key] || '') + '</span>'
        + '<span class="xp-chan-lb">' + esc(c.label) + '</span>'
        + (cq ? '<img class="xp-chan-qr" src="' + cq + '" alt="">' : '')
        + '</div>';
    }

    var logo = s.logoUrl ? '<img class="xp-cover-art" src="' + esc(s.logoUrl) + '" alt="">'
      : '<span class="xp-cover-mark">' + LOGO_MARK + '</span>';
    var itemRows = sum.accRows.length
      ? sum.accRows.map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td class="num">' + r.qty + '</td></tr>'; }).join('')
      : '<tr><td colspan="2" class="xp-empty">لا توجد إكسسوارات في هذا التصميم</td></tr>';

    var nameRow = cust.name
      ? '<div class="mrow"><span>اسم العميل</span><b>' + esc(cust.name) + '</b></div>' : '';
    var phoneRow = (cust.phone && /^\+?[\d\s-]{7,16}$/.test(cust.phone))
      ? '<div class="mrow"><span>رقم الجوال</span><b>' + esc(cust.phone) + '</b></div>' : '';

    var el = document.createElement('div');
    el.className = 'xp-doc';
    el.innerHTML = ''
      /* --- صفحة ١: الغلاف --- */
      + '<div class="xp-page xp-cover">'
      + logo
      + '<p class="xp-cover-shop">' + esc(s.shopName || 'أصالة نجد') + '</p>'
      + (s.tagline ? '<p class="xp-cover-tag">' + esc(String(s.tagline).slice(0, 140)) + '</p>' : '')
      + '<div class="xp-cover-rule"></div>'
      + '<h1 class="xp-cover-title">تصميم مجلسك الخاص</h1>'
      + '<div class="xp-cover-meta">'
      + '<div class="mrow"><span>الرقم المرجعي</span><b class="num">' + esc(noTxt) + '</b></div>'
      + '<div class="mrow"><span>تاريخ الإنشاء</span><b class="num">' + esc(date) + '</b></div>'
      + nameRow + phoneRow
      + '</div>'
      + '<p class="xp-cover-note">وثيقة مرجعية بمقاسات تصميمك على منصة «' + esc(s.shopName || 'أصالة نجد') + '». '
      + 'لا تحتوي على أسعار — التسعير يُحدَّد بعد مراجعة المحل للتصميم.</p>'
      + '</div>'
      /* --- صفحة ٢: المخطط + الملخص + الكميات --- */
      + '<div class="xp-page">'
      + '<h2 class="xp-h">مخطط المجلس</h2>'
      + '<div class="xp-plan"><img src="' + img + '" alt="مخطط المجلس"></div>'
      + '<h3 class="xp-sub">ملخص التصميم</h3>'
      + '<div class="xp-facts">'
      + '<div class="frow"><span>العرض</span><b class="num">' + sum.w + ' م</b></div>'
      + '<div class="frow"><span>الطول</span><b class="num">' + sum.h + ' م</b></div>'
      + (sum.area != null ? '<div class="frow"><span>المساحة</span><b class="num">' + sum.area + ' م²</b></div>' : '')
      + '<div class="frow"><span>نوع الجلسة</span><b>' + esc(sum.seatTxt) + '</b></div>'
      + '<div class="frow"><span>أمتار الكنب</span><b class="num">' + sum.meters + ' م</b></div>'
      + '<div class="frow"><span>الأبواب</span><b class="num">' + sum.doors + '</b></div>'
      + '<div class="frow"><span>المشب</span><b class="num">' + sum.mashabs + '</b></div>'
      + (sum.windows ? '<div class="frow"><span>الشبابيك</span><b class="num">' + sum.windows + '</b></div>' : '')
      + (sum.cols ? '<div class="frow"><span>الأعمدة</span><b class="num">' + sum.cols + '</b></div>' : '')
      + (sum.free ? '<div class="frow"><span>مساحات فارغة</span><b class="num">' + sum.free + '</b></div>' : '')
      + '</div>'
      + '<h3 class="xp-sub">جدول الإكسسوارات والكميات</h3>'
      + '<table class="xp-items"><thead><tr><th>العنصر</th><th class="num">الكمية</th></tr></thead><tbody>' + itemRows + '</tbody></table>'
      + '</div>'
      /* --- صفحة ٣: الختام والتواصل --- */
      + '<div class="xp-page xp-end">'
      + logo
      + '<h2>شكرًا لثقتك</h2>'
      + '<p>هذا التصميم وثيقة مرجعية يمكن عرضها على المحل. راجعه مع <b>' + esc(s.shopName || 'أصالة نجد') + '</b>'
      + ' واطلب عرض سعر يناسب مقاساتك — التسعير يُحدَّد بعد المراجعة.</p>'
      + (chans.length ? '<p class="xp-hint">اضغط على الأيقونة أو امسح رمز QR لفتح الرابط مباشرة</p>' : '')
      + (chans.length ? '<div class="xp-chans">' + chanHtml + '</div>' : '')
      + (chans.length ? '' : '<p class="xp-empty">لم تُضف قنوات تواصل في إعدادات المحل بعد.</p>')
      + '<div class="xp-endfoot">' + esc(s.shopName || 'أصالة نجد')
      // الرقم داخل span بـ direction:ltr وإلا قلبه RTL فظهر «966…+» في آخر السطر
      + (s.phone && /^\+?[\d\s-]{7,16}$/.test(s.phone) ? ' — <span dir="ltr">' + esc(s.phone.trim()) + '</span>' : '') + '</div>'
      + '</div>';
    return el;
  }

  async function makePdfBlob(number) {
    if (!navigator.onLine) throw new Error('تصدير PDF يحتاج اتصالًا بالإنترنت.');
    try { await loadScript(CDN.h2c); await loadScript(CDN.jspdf); }
    catch (_) { throw new Error('تعذّر تحميل مكتبة PDF. تحقق من الاتصال.'); }
    var area = $('#pxPrint');
    area.innerHTML = '';
    var doc = await buildExpandedDoc(number);
    area.appendChild(doc);
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    try {
      await document.fonts.ready;
      var pages = $$('.xp-page', doc);
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      for (var i = 0; i < pages.length; i++) {
        var canvas = await window.html2canvas(pages[i], { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
        var jpg = canvas.toDataURL('image/jpeg', 0.94);
        if (i > 0) pdf.addPage();
        pdf.addImage(jpg, 'JPEG', 10, 10, 190, 276, undefined, 'FAST');
        // روابط قابلة للنقر: حوّل مواضع data-url إلى مم
        addLinks(pdf, pages[i], canvas, 10, 10, 190, 276);
      }
      return pdf.output('blob');
    } finally {
      area.style.cssText = '';
      area.innerHTML = '';
    }
  }

  /** تحويل [data-url] إلى روابط PDF: إسقاط مواضع الصفحة على الصورة المرفوعة */
  function addLinks(pdf, pageEl, canvas, x0, y0, wMm, hMm) {
    var base = pageEl.getBoundingClientRect();
    if (!base.width || !base.height) return;
    var sx = wMm / base.width, sy = hMm / base.height;
    var nodes = pageEl.querySelectorAll('[data-url]');
    for (var i = 0; i < nodes.length; i++) {
      var url = nodes[i].getAttribute('data-url');
      if (!url) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var x = x0 + (r.left - base.left) * sx;
      var y = y0 + (r.top - base.top) * sy;
      var w = r.width * sx, hh = r.height * sy;
      if (x < x0 || x + w > x0 + wMm + 0.5 || y < y0 || y + hh > y0 + hMm + 0.5) continue;
      try { pdf.link(x, y, w, hh, { url: url }); } catch (_) { /* noop */ }
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
  async function reviewPdf() {
    try {
      var blob = await makePdfBlob(S.meta && S.meta.number);
      downloadBlob(blob, 'expanded-design-' + ((S.meta && S.meta.number) || 'draft') + '.pdf');
    } catch (e) { toast(e.message || 'تعذّر إنشاء PDF.', true); }
  }
  async function reviewShare() {
    var no = S.meta && S.meta.number;
    var text = 'السلام عليكم، هذا تصميم مجلسي من منصة التصميم الموسّع (نسخة تجريبية).'
      + (no ? '\nالرقم المرجعي: ' + no : '');
    try {
      var blob = await makePdfBlob(no);
      var file = new File([blob], 'expanded-design-' + (no || 'draft') + '.pdf', { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'تصميم المجلس', text: text });
        return;
      }
      throw new Error('no-share');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      try { var b2 = await makePdfBlob(no); downloadBlob(b2, 'expanded-design-' + (no || 'draft') + '.pdf'); } catch (_) { /* noop */ }
      var s = S.settings || {};
      var wa = saudiIntl(s.whatsapp) || saudiIntl(s.phone);
      if (wa) global.open('https://wa.me/' + wa + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
      else toast('نُزّل ملف PDF — أرفقه في محادثة المحل.', false);
    }
  }

  $('#pxPdf').addEventListener('click', async function () {
    var btn = $('#pxPdf');
    if (btn.disabled) return;
    btn.disabled = true;
    try { await reviewPdf(); } finally { btn.disabled = false; }
  });
  $('#pxShareWa').addEventListener('click', async function () {
    var btn = $('#pxShareWa');
    if (btn.disabled) return;
    btn.disabled = true;
    try { await reviewShare(); } finally { btn.disabled = false; }
  });
  $('#pxContactBtn').addEventListener('click', function () {
    var box = $('#pxContactBox');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      var n = $('#pxName'); if (n && n.value) $('#pxCName').value = n.value;
      var p = $('#pxPhone'); if (p && p.value) $('#pxCPhone').value = p.value;
      $('#pxCName').focus();
    }
  });
  $('#pxContactSend').addEventListener('click', async function () {
    var btn = $('#pxContactSend');
    if (btn.disabled) return;
    var name = $('#pxCName').value.trim();
    var phone = $('#pxCPhone').value.trim();
    if (name.length < 2) { $('#pxContactErr').textContent = 'فضلاً أدخل الاسم.'; return; }
    if (!/^\+?[\d\s-]{7,16}$/.test(phone)) { $('#pxContactErr').textContent = 'فضلاً أدخل رقم جوال صحيح.'; return; }
    btn.disabled = true;
    $('#pxContactErr').textContent = '';
    try {
      await api('/contact', { method: 'POST', body: { name: name, phone: phone } });
      $('#pxContactOk').hidden = false;
      btn.textContent = 'تم إرسال طلب التواصل ✓';
    } catch (e) {
      btn.disabled = false;
      $('#pxContactErr').textContent = (e && e.status === 401)
        ? 'انتهت الجلسة — ابدأ تصميمًا جديدًا ثم أعد الإرسال.'
        : 'تعذّر الإرسال. تحقق من الاتصال وحاول مجدداً.';
    }
  });

  /* خطاف اختبار (قراءة فقط — لا أسرار) */
  global.PortalExpandedTest = {
    state: function () { return S.designer ? S.designer.getState() : null; },
    designer: function () { return S.designer; },
    summary: designSummary,
    accCount: accCount,
    setAccQty: setAccQty,
    spreadAcc: spreadAcc,
    gotoStep: gotoStep,
    finishDesign: finishDesign,
    makePdfBlob: makePdfBlob,
    contactChannels: contactChannels,
    MAX_QTY: MAX_QTY
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);