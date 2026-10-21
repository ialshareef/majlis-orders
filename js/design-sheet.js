/* =====================================================================
   ورقة التصميم المشتركة (DesignSheet)
   ---------------------------------------------------------------------
   مخرج واحد يتقاسمه مسارات PDF الثلاثة: العميل (portal.js)، الموظف
   (app.js)، والتصميم الموسّع (portal-expanded.js) — بالبنية نفسها
   وبالقياسات نفسها حتى لا يختلف مخططان لنفس الغرفة في ورقتين.

   القواعد المتفق عليها:
   - الصفحة A4 أفقي 277×190مم (بلا هوامش داخلية).
   - لا أي بيانات مالية إطلاقاً (لا سعر ولا دفعة ولا إجمالي).
   - «سعة الجلوس» = مجموع مقاعد كل كنبة بمعيار 0.8م للفرد — وهو نفس
     المعيار الذي يرسم به المحرك فواصل الوسائد (designer.js seatLen)
     فلا يعارض الرقم ما يراه العميل على المخطط.
   - الدليل يعكس ألوان القطع الفعلية المستخدمة في الرسم، ولا يغيّر
     لوحة المحرك.
   - المقاسات والترتيب يأتيان من الوحدة نفسها، والمالك يضيف حقائقه
     في صدر الصفحة (meta) دون أن يمسّ الجدول.
   ===================================================================== */
(function (global) {
  'use strict';

  /* مقاس الورقة بالمليمتر: A4 أفقي بهامش 10مم من كل جهة */
  var SHEET_W = 277, SHEET_H = 190;

  /* صندوق المخطط بالمليمتر — محسوب من قياسات .dsheet في css/style.css
     (عرض المحتوى 257 − العمليات 79 = 178، والارتفاع 175 − العنوان 18 −
     الفاصل 4 = 153). تثبيته هنا يجعل نِسَب الطبقة العلوية فوق الصورة
     مطابقة تماماً للصورة مهما اختلف المتصفح. */
  var PLAN_BOX = { w: 178, h: 153 };

  /* ارتفاع شريط التواصل بالمليمتر (قيمة ابتدائية قبل القياس الحيّ):
     16مم محتوى + 2مم فاصل علوي (.ds-foot) — الحقيقية تُقاس في fitFoot */
  var FOOT_H = 18;

  /* عرض المقعد الواحد بالمتر — مطابق لمعيار رسم الوسائد في المحرك */
  var SEAT_M = 0.8;

  /* أسماء أنواع الجلسة (رموز ثابتة محفوظة في القطعة) */
  var SEATING = { floor: 'جلسة أرضية', sofa: 'جلسة كنب', arabic: 'جلسة عربية', raised: 'جلسة مرتفعة' };

  var DEFAULT_CAPTION = 'مقرّر توزيع الأثاث الداخلي';
  var DEFAULT_TITLE = 'المجلس – مخطط الأثاث ثلاثي الأبعاد';
  var DEFAULT_NOTE = 'جميع القياسات بالسنتيمتر. المخطط مرسوم بمقاسات رسم، وتعتمد المقاسات النهائية بعد الرفع في الموقع.';

  /* أسماء الأشهر الميلادية ثابتة (بلا اعتماد على بيانات الجهاز) */
  var MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

  function num(v) { var n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  function r2(v) { return Math.round(num(v) * 100) / 100; }
  function cm(m) { return Math.round(num(m) * 100); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** مقاعد قطعة واحدة: max(1, round(العرض / 0.8)) — نفس عدد الوسائد المرسوم */
  function seatsOf(p) {
    if (!p || p.kind !== 'sofa') return 0;
    return Math.max(1, Math.round(num(p.w) / SEAT_M));
  }

  /** إحداثيات المضلع بإعادة بناء سلسلة الجدران (بلا اعتماد على المحرك) */
  function polyBox(walls) {
    var x = 0, y = 0, minX = 0, minY = 0, maxX = 0, maxY = 0, i, a, len;
    for (i = 0; i < (walls || []).length; i++) {
      a = (num(walls[i].angle) || 0) * Math.PI / 180;
      len = num(walls[i].len);
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { w: maxX - minX, h: maxY - minY };
  }

  /** أبعاد الغرفة بالمتر (عرض × عرض من المضلع، وإلا أول جدارين) */
  function roomOf(design) {
    var d = design || {};
    var ws = d.walls || [];
    var box = polyBox(ws);
    var w = box.w, h = box.h;
    if (!(w > 0) && ws[0]) w = num(ws[0].len);
    if (!(h > 0) && ws[1]) h = num(ws[1].len);
    if (!(w > 0) && d.roomDims && d.roomDims.w) w = num(d.roomDims.w);
    if (!(h > 0) && d.roomDims && d.roomDims.h) h = num(d.roomDims.h);
    return { w: r2(w), h: r2(h), area: (w > 0 && h > 0) ? r2(w * h) : null };
  }

  /** نفس حكم المحرك في لون القطعة: style ثم item ثم اللون الافتراضي */
  function makeCtx(opts) {
    opts = opts || {};
    var getItem = opts.getItem || function () { return null; };
    var pieceStyle = typeof opts.pieceStyle === 'function' ? opts.pieceStyle : null;
    var seating = opts.seating || SEATING;
    function item(p) {
      var it = (pieceStyle && pieceStyle(p)) || getItem(p && p.itemId) || {};
      return it || {};
    }
    return {
      seating: function (p) { return seating[p.seating] || seating.floor || 'جلسة'; },
      item: item,
      color: function (p) {
        var c = item(p).color;
        return c || (p.kind === 'sofa' ? '#8b5a2b' : '#7f8c8d');
      },
      label: function (p) {
        if (p.kind === 'sofa') return this.seating(p);
        if (p.kind === 'column') return 'عمود';
        if (p.kind === 'free') return 'قطعة حرة';
        var nm = item(p).name;
        return nm || 'إكسسوار';
      },
      shape: function (p) { return item(p).shape || p.shape || ''; }
    };
  }

  /** صفوف الجدول + السعة + الدليل — بلا أي معلومة مالية */
  function facts(design, opts) {
    opts = opts || {};
    var d = design || {};
    var pieces = d.pieces || [];
    var ctx = makeCtx(opts);
    var groups = {}, order = [], i, p, key, g;
    var capacity = 0, meters = 0, free = 0, columns = 0;
    var doors = 0, windows = 0, mashabs = 0;

    for (i = 0; i < pieces.length; i++) {
      p = pieces[i];
      if (!p) continue;
      if (p.kind === 'sofa') { capacity += seatsOf(p); meters += num(p.w); }
      else if (p.kind === 'free') { free++; continue; }
      else if (p.kind === 'column') { columns++; continue; }
      var lbl = ctx.label(p);
      var dims = cm(p.w) + ' × ' + cm(p.h);
      key = p.kind + '|' + lbl + '|' + dims;
      g = groups[key];
      if (!g) {
        g = { key: key, kind: p.kind, name: lbl, dims: dims, w: num(p.w), qty: 0, color: ctx.color(p), shape: ctx.shape(p), seats: p.kind === 'sofa' ? seatsOf(p) : 0 };
        groups[key] = g;
        order.push(g);
      }
      g.qty++;
    }

    (d.openings || []).forEach(function (o) {
      if (o.type === 'door') doors++;
      else if (o.type === 'window') windows++;
      else if (o.type === 'mashab') mashabs++;
    });

    /* الترتيب كما في المرجع: المقاعد تصاعدياً بعرضها ثم الإكسسوارات بالاسم */
    order.sort(function (a, b) {
      var ra = a.kind === 'sofa' ? 0 : (a.kind === 'acc' ? 1 : 2);
      var rb = b.kind === 'sofa' ? 0 : (b.kind === 'acc' ? 1 : 2);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return a.w - b.w || a.name.localeCompare(b.name, 'ar');
      return a.name.localeCompare(b.name, 'ar') || a.w - b.w;
    });

    /* الدليل: مجموعات لونية فعلية كما تُرسم، لا ألوان مُختلقة */
    var legend = [], byLabel = {};
    function pushLegend(label, sub, color, shape, add) {
      var k = label + '|' + color + '|' + shape;
      var e = byLabel[k];
      if (e) { if (add) { e.qty += add; e.sub = e.qty + ' قطعة'; } return; }
      e = { label: label, sub: sub, color: color, shape: shape, qty: add || 0 };
      byLabel[k] = e;
      legend.push(e);
    }
    var sofaNames = {}, hasSofa = false, sofaColor = null;
    for (i = 0; i < order.length; i++) {
      g = order[i];
      if (g.kind === 'sofa') {
        hasSofa = true;
        sofaNames[g.name] = 1;
        if (!sofaColor) sofaColor = g.color;
      } else if (g.kind === 'acc') {
        pushLegend(g.name, g.qty + ' قطعة', g.color, g.shape === 'circle' ? 'circle' : '', g.qty);
      }
    }
    if (hasSofa) {
      legend.unshift({
        label: 'المقاعد',
        sub: Object.keys(sofaNames).join('، ') || 'كنب وكراسي',
        color: sofaColor || '#8b5a2b', shape: '', qty: capacity
      });
    }
    if (free) pushLegend('قطعة حرة', free + ' قطعة', 'rgba(90,116,134,0.14)', 'outline', free);
    if (columns) pushLegend('عمود', columns + ' قطعة', '#9aa0a6', '', columns);

    var room = roomOf(d);
    return {
      rows: order.map(function (x) {
        return { kind: x.kind, name: x.name, dims: x.dims, qty: x.qty, color: x.color, seats: x.seats };
      }),
      capacity: capacity,
      meters: r2(meters),
      free: free,
      columns: columns,
      doors: doors,
      windows: windows,
      mashabs: mashabs,
      room: room,
      legend: legend,
      note: opts.note || DEFAULT_NOTE
    };
  }

  /* ---------------- المخطط: صورة + إحداثيات الطبقة العلوية ---------------- */

  /** طول مقياس الرسم بالmetros من بين قيمات م.round */
  function pickScaleMeters(scalePx, targetPx) {
    var cands = [0.3, 0.6, 0.9, 1.2, 1.5, 3, 6, 9, 12, 15];
    var best = null, bestD = Infinity, i, px, dist;
    for (i = 0; i < cands.length; i++) {
      px = cands[i] * scalePx;
      dist = Math.abs(px - targetPx);
      if (px >= targetPx * 0.55 && px <= targetPx * 1.7 && dist < bestD) { bestD = dist; best = cands[i]; }
    }
    if (best == null) {
      var m = Math.max(0.1, targetPx / Math.max(1, scalePx));
      var mag = Math.pow(10, Math.floor(Math.log(m) / Math.LN10));
      best = Math.max(0.1, Math.round(m / mag) * mag);
    }
    return best;
  }

  /** صورة المخطط (بنِسَب من حجم الصورة) — خطوط القياس تُرسم داخل الصورة
      عند التصدير (designer.js _drawOpeningDimsTop لكل جدار) فلا تُكرَّر
      فوقها بطبقة HTML منفصلة */
  function plan(design, opts, W) {
    opts = opts || {};
    W = W || 1600;
    var off = new global.Designer(document.createElement('canvas'), {
      getItem: opts.getItem,
      pieceSpecLabel: function () { return ''; },
      pieceStyle: typeof opts.pieceStyle === 'function' ? opts.pieceStyle : undefined
    });
    off.setState(JSON.parse(JSON.stringify(design || {})));
    var aspect = off.aspect();
    var H = Math.max(400, Math.round(W / aspect));
    var img = off.toImage(W, H);

    /* نفس حساب toImage تماماً: scale = W / (bbW + 2*pad) */
    var view = null;
    try { view = off._fitView(W, H); } catch (_) { view = null; }
    var out = { img: img, W: W, H: H, room: null, scale: view ? view.scale : 0 };
    if (!view) return out;

    var g = off.geometry();
    var x0 = view.ox + g.bb.minX * view.scale, x1 = view.ox + g.bb.maxX * view.scale;
    var y0 = view.oy + g.bb.minY * view.scale, y1 = view.oy + g.bb.maxY * view.scale;
    out.room = {
      l: x0 / W * 100, t: y0 / H * 100,
      w: (x1 - x0) / W * 100, h: (y1 - y0) / H * 100
    };
    return out;
  }

  /* ---------------- بناء الـHTML ---------------- */

  function fmtDate(v) {
    var d = v instanceof Date ? v : new Date(v == null ? Date.now() : v);
    if (isNaN(d.getTime())) d = new Date();
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  /** كسر (0..1) إلى نسبة مئوية بعلامة % — القيم القادمة إلى هنا كسور دائماً */
  function pct(frac) { return (Math.round(num(frac) * 1000) / 10) + '%'; }

  /* مقياس الرسم: الشريط يمثّل m متراً أرضياً.
     الحساب: طول الشريط بالبكسل = m × pl.scale (بكسل/م من _fitView)،
     وعرض الحاوية = طول الشريط ÷ عرض صورة المخطط (كسر) → تُكتب كنسبة من
     عرض صندوق المخطط؛ لأن الصورة ملء عرض الصندوق (تكبير k موحّد) تنطبق
     النسبة نفسها على المم: طول_مم = نسبة × عرض_صندوق_مم، فيصحّ القياس
     في PDF. الزاوية اليمنى السفلية: خارج شارة «المقاسات الداخلية بالمتر»
     (يسار الصورة) وخارج مركز شارات طول الجدران (وسط الحواف). */
  function scaleBlock(pl) {
    if (!pl || !pl.scale || !(pl.scale > 0)) return '';
    var target = pl.W * 0.17;
    var m = pickScaleMeters(pl.scale, target);
    var px = m * pl.scale;
    var wFrac = px / pl.W;
    var third = Math.round(m * 100 / 3);
    var mid = Math.round(m * 100 * 2 / 3);
    var end = Math.round(m * 100);
    return '<span class="ds-scale" style="right:' + pct(0.035) + ';bottom:' + pct(0.035) + ';width:' + pct(wFrac) + '">'
      + '<span class="ds-scale-bar"><i></i><i></i><i></i></span>'
      + '<span class="ds-scale-n"><b class="num">0</b><b class="num">' + third + '</b>'
      + '<b class="num">' + mid + '</b><b class="num">' + end + '</b></span>'
      + '<span class="ds-scale-u">سم</span></span>';
  }

  /* مقطع الصورة بالمليمتر: تُملأ المساحة المتاحة بالكامل مع الحفاظ على
     النسبة — فالصندوق المحتضن للصورة يساوي الصورة تماماً وتصحّ النِسَب.
     ارتفاع شريط التواصل لا يُفترض بثابت: يُقاس في build() بعد بناء
     التخطيط الفعلي (fitFoot) وتُطرح قيمته الفعلية (محتوى + الفاصل 2مم)
     من صندوق المخطط 153مم — أي زيادة في الشريط تُنقص من المخطط بدل أن
     تُقصّ المحتوى أو تُشوّه نسبة الصورة. FOOT_H قيمة ابتدائية قبل القياس. */
  function planBoxStyle(pl, opts, footMm) {
    if (!pl || !pl.img || !(pl.W > 0) || !(pl.H > 0)) return '';
    var footTotal = 0;
    if (opts && opts.footHtml) footTotal = (footMm != null && footMm > 0) ? footMm : FOOT_H;
    var boxH = PLAN_BOX.h - footTotal;
    var k = Math.min(PLAN_BOX.w / pl.W, boxH / pl.H);
    return 'width:' + r2(pl.W * k) + 'mm;height:' + r2(pl.H * k) + 'mm;';
  }

  /** HTML الورقة كاملة (سلسلة — قابلة للاختبار بلا متصفح) */
  function render(f, pl, opts) {
    opts = opts || {};
    var meta = (opts.meta || []).slice();
    /* الترتيب عرض × طول — نفس اتجاه roomSummary والجداول (walls[0] × walls[1]) */
    var roomTxt = f.room && f.room.w > 0
      ? cm(f.room.w) + ' × ' + cm(f.room.h) + ' سم' : '—';
    var head = [{ label: 'التاريخ', value: fmtDate(opts.date) },
      { label: 'الغرفة', value: roomTxt }].concat(meta);

    var rows = f.rows.map(function (r) {
      return '<tr><td class="c-name">' + esc(r.name) + '</td>'
        + '<td class="c-dims"><bdi class="num">' + esc(r.dims) + '</bdi></td>'
        + '<td class="c-qty num">' + r.qty + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="ds-empty">لا توجد قطع على المخطط</td></tr>';

    var legend = f.legend.map(function (e) {
      var cls = 'sw' + (e.shape === 'circle' ? ' circle' : '') + (e.shape === 'outline' ? ' outline' : '');
      var style = e.shape === 'outline' ? '' : ' style="background:' + esc(e.color) + '"';
      return '<li><span class="' + cls + '"' + style + '></span>'
        + '<span class="lb">' + esc(e.label) + '</span>'
        + (e.sub ? '<span class="sb">' + esc(e.sub) + '</span>' : '') + '</li>';
    }).join('');

    var cap = f.capacity > 0
      ? '<div class="ds-cap"><b class="num">' + f.capacity + '</b><span>مقعداً – سعة الجلوس</span></div>'
      : '';

    var box = planBoxStyle(pl, opts);
    var img = pl && pl.img
      ? '<span class="ds-img" style="' + box + '">'
      + '<img src="' + pl.img + '" alt="مخطط المجلس">'
      + scaleBlock(pl) + '</span>'
      : '<span class="ds-img ds-img-empty">لا يوجد مخطط</span>';

    return '<div class="dsheet">'
      + '<div class="ds-head">'
      + '<div class="ds-titles"><p class="ds-caption">' + esc(opts.caption || DEFAULT_CAPTION) + '</p>'
      + '<h1 class="ds-title">' + esc(opts.title || DEFAULT_TITLE) + '</h1></div>'
      + '<dl class="ds-meta">' + head.map(function (m) {
        return '<div class="ds-meta-i"><dt>' + esc(m.label) + '</dt>'
          + '<dd class="num">' + esc(m.value) + '</dd></div>';
      }).join('') + '</dl>'
      + '</div>'
      + '<div class="ds-body">'
      + '<aside class="ds-side">'
      + '<h2 class="ds-h">جداول الأثاث</h2>'
      + '<table class="ds-tbl"><thead><tr><th>القطعة</th><th>المقاس (سم)</th><th class="c-qty">العدد</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + cap
      + '<h2 class="ds-h">دليل الألوان والمواد</h2>'
      + '<ul class="ds-legend">' + legend + '</ul>'
      + '<p class="ds-note">' + esc(f.note) + '</p>'
      + '</aside>'
      + '<div class="ds-plan">' + img + '</div>'
      + '</div>'
      + (opts.footHtml ? '<div class="ds-foot">' + opts.footHtml + '</div>' : '')
      + '</div>';
  }

  /** قياس شريط التواصل فعلياً (محتوى + الفاصل العلوي) بالمليمتر وضبط
      ارتفاع صندوق المخطط — التخطيط يجب أن يكون متصلاً بالصفحة أولاً */
  function fitFoot(el, pl, opts) {
    if (!el || !el.querySelector || !opts || !opts.footHtml || !pl || !pl.img) return;
    var foot = el.querySelector('.ds-foot');
    var img = el.querySelector('.ds-img');
    if (!foot || !img) return;
    var pxmm = el.getBoundingClientRect().width / SHEET_W;
    if (!(pxmm > 0)) return;
    var footMm = foot.getBoundingClientRect().height / pxmm;
    if (window.getComputedStyle) {
      footMm += (parseFloat(window.getComputedStyle(foot).marginTop) || 0) / pxmm;
    }
    if (!(footMm > 0)) return;
    img.style.cssText = planBoxStyle(pl, opts, footMm);
  }

  function build(opts) {
    opts = opts || {};
    var f = facts(opts.design, opts);
    var pl = opts.img === null ? null : plan(opts.design, opts, opts.imgW || 1600);
    var el = document.createElement('div');
    el.innerHTML = render(f, pl, opts);
    el = el.firstChild;
    el.__facts = f;
    el.__pl = pl;
    /* قياس الشريط في تخطيط حقيقي (بلا تغيير على الصفحة المعروضة) ثم إعادة
       قصّ صندوق المخطط حسبه: لا ارتفاع ثابت قد يقصّ محتوى آخر. */
    if (opts.footHtml && pl && pl.img && document.body) {
      var host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;';
      document.body.appendChild(host);
      host.appendChild(el);
      try { fitFoot(el, pl, opts); }
      finally { host.removeChild(el); document.body.removeChild(host); }
    }
    return el;
  }

  /** PDF أفقي 277×190مم — المكتبة نفسها (html2canvas + jsPDF) كما كانت */
  function pdfBlob(opts) {
    opts = opts || {};
    var el = build(opts);
    var area = opts.mount;
    if (!area || !area.appendChild) return Promise.reject(new Error('لا يوجد موضع لعرض الورقة.'));
    var prevHtml = area.innerHTML, prevCss = area.style.cssText;
    area.innerHTML = '';
    area.appendChild(el);
    area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    function restore() { area.style.cssText = prevCss; area.innerHTML = prevHtml; }
    return Promise.resolve()
      .then(function () { return document.fonts && document.fonts.ready ? document.fonts.ready : null; })
      .then(function () {
        /* إعادة القياس بعد تحميل الخطوط: قد يتغيّر التفاف نص الشريط */
        try { fitFoot(el, el.__pl, opts); } catch (_) { /* noop */ }
        return window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      })
      .then(function (canvas) {
        var jpg = canvas.toDataURL('image/jpeg', 0.94);
        var jsPDF = window.jspdf.jsPDF;
        var pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
        pdf.addImage(jpg, 'JPEG', 10, 10, SHEET_W, SHEET_H, undefined, 'FAST');
        if (typeof opts.addLinks === 'function') {
          try { opts.addLinks(pdf, el, 10, 10, SHEET_W); } catch (_) { /* noop */ }
        }
        return pdf.output('blob');
      })
      .then(function (b) { restore(); return b; }, function (e) { restore(); throw e; });
  }

  var api = {
    SHEET_W: SHEET_W,
    SHEET_H: SHEET_H,
    PLAN_BOX: PLAN_BOX,
    FOOT_H: FOOT_H,
    SEAT_M: SEAT_M,
    SEATING: SEATING,
    seatsOf: seatsOf,
    roomOf: roomOf,
    polyBox: polyBox,
    facts: facts,
    plan: plan,
    render: render,
    build: build,
    pdfBlob: pdfBlob,
    fmtDate: fmtDate,
    pickScaleMeters: pickScaleMeters
  };

  global.DesignSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
