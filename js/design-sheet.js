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
  function n2(v) { return num(v).toFixed(2); }
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
    var doors = 0, windows = 0, mashabs = 0, tvs = 0;
    var sofaLen = 0, sofaArea = 0;

    for (i = 0; i < pieces.length; i++) {
      p = pieces[i];
      if (!p) continue;
      if (p.kind === 'sofa') {
        capacity += seatsOf(p);
        meters += num(p.w);
        /* ملخص المساحات: الكنب فقط وبأبعاد كاملة (لا افتراض لقياس ناقص) */
        if (num(p.w) > 0 && num(p.h) > 0) {
          sofaLen += num(p.w);
          sofaArea += num(p.w) * num(p.h);
        }
      }
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
      else if (o.type === 'tv') tvs++;
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
    /* ملخص المساحات: يُعرض فقط عند اكتمال المعطيات — مساحة الغرفة من
       المضلع نفسه، ومساقط الكنب من عرض×عمق القطع الفعلية (بلا تخمين).
       النِسَب تُحسب من القيم الخام ثم تُقرَّب في العرض: (إجمالي / 20 =
       44.7%) و(20 − إجمالي = 11.06) كما في المواصفة المعتمدة. */
    var areas = null;
    if (room.area > 0 && sofaLen > 0.004) {
      areas = {
        len: r2(sofaLen),
        area: r2(sofaArea),
        room: r2(room.area),
        frac: sofaArea / room.area,
        rest: r2(room.area - sofaArea)
      };
    }
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
      tvs: tvs,
      room: room,
      areas: areas,
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

  /** HTML صفحة واحدة من الورقة (سلسلة — قابلة للاختبار بلا متصفح).
      بلا pg أو بلا alloc → الصفحة الوحيدة بكل المحتوى (سلوك قديم حرفياً).
      pg = { idx, total, alloc } وalloc يحدّد ما تحمله هذه الصفحة:
        { rows: prefix من صفوف الجدول, cap, legend, note, areas, cont, first }
      الصفوف تُقسَّم على صفحات متتابعة برأس جدول مكرّر ولا يُقسَّم صف قطّاعاً،
      وما بعد الجدول (السعة والدليل والحاشية وملخص المساحات) يأتي بعد آخر صف. */
  function render(f, pl, opts, pg) {
    opts = opts || {};
    pg = pg || {};
    var a = pg.alloc || null;
    var cont = !!(a && a.cont);
    var rowsSrc = a ? a.rows : f.rows;
    var showCap = a ? !!a.cap : true;
    var showLegend = a ? !!a.legend : true;
    var showNote = a ? !!a.note : true;
    var showAreas = a ? !!a.areas : true;
    var meta = (opts.meta || []).slice();
    /* الترتيب عرض × طول — نفس اتجاه roomSummary والجداول (walls[0] × walls[1]) */
    var roomTxt = f.room && f.room.w > 0
      ? cm(f.room.w) + ' × ' + cm(f.room.h) + ' سم' : '—';
    var head = [{ label: 'التاريخ', value: fmtDate(opts.date) },
      { label: 'الغرفة', value: roomTxt }].concat(meta);

    var rows = rowsSrc.map(function (r) {
      return '<tr><td class="c-name">' + esc(r.name) + '</td>'
        + '<td class="c-dims"><bdi class="num">' + esc(r.dims) + '</bdi></td>'
        + '<td class="c-qty num">' + r.qty + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="ds-empty">لا توجد قطع على المخطط</td></tr>';
    /* رأس القسم يتكرر على كل صفحة تحمل جدول الأثاث — ما عدا صفحة أولى بلا جدول */
    var showTable = !a || !!a.first || rowsSrc.length > 0;

    var legendSrc = f.legend.slice(a && a.legendFrom ? a.legendFrom : 0,
      a && a.legendTo != null ? a.legendTo : undefined);
    var legend = legendSrc.map(function (e) {
      var cls = 'sw' + (e.shape === 'circle' ? ' circle' : '') + (e.shape === 'outline' ? ' outline' : '');
      var style = e.shape === 'outline' ? '' : ' style="background:' + esc(e.color) + '"';
      return '<li><span class="' + cls + '"' + style + '></span>'
        + '<span class="lb">' + esc(e.label) + '</span>'
        + (e.sub ? '<span class="sb">' + esc(e.sub) + '</span>' : '') + '</li>';
    }).join('');

    var cap = showCap && f.capacity > 0
      ? '<div class="ds-cap"><b class="num">' + f.capacity + '</b><span>مقعداً – سعة الجلوس</span></div>'
      : '';

    /* صندوق ملخص المساحات (يظهر فقط عند اكتمال ف.areas في facts) —
       بالقيم نفسها وبلا معلومات مالية، والحاشية توضّح أن المساقط قد تتداخل.
       التخطيط مضغوط (شريط عنوان + شبكة عمودين) ليبقى ارتفاع العمود
       الجانبي مطابقاً لارتفاعه قبل الإضافة حتى في أكثر الحالات ازدحاماً. */
    var areas = '';
    if (showAreas && f.areas) {
      var ar = f.areas;
      var aitems = [
        ['طول الجلسة', n2(ar.len) + ' م', ''],
        ['مساحة الارتكاز', n2(ar.area) + ' م²', ''],
        ['مساحة الغرفة', n2(ar.room) + ' م²', ''],
        ['المساحة المتبقية', n2(ar.rest) + ' م²', ''],
        ['النسبة المشغولة', pct(ar.frac), ' hl']
      ];
      areas = '<div class="ds-areas-wrap">'
        + '<p class="ds-areas-h"><b>ملخص المساحات</b><span>مجموع مساقط القطع وقد تتداخل</span></p>'
        + '<dl class="ds-areas">'
        + aitems.map(function (a2) {
            return '<div class="ds-areas-i' + a2[2] + '"><dt>' + a2[0] + '</dt>'
              + '<dd class="num">' + a2[1] + '</dd></div>';
          }).join('')
        + '</dl></div>';
    }

    var box = planBoxStyle(pl, opts);
    var img = pl && pl.img
      ? '<span class="ds-img" style="' + box + '">'
      + '<img src="' + pl.img + '" alt="مخطط المجلس">'
      + scaleBlock(pl) + '</span>'
      : '<span class="ds-img ds-img-empty">لا يوجد مخطط</span>';

    return '<div class="dsheet' + (cont ? ' ds-cont' : '') + '">'
      + ((pg.total || 0) > 1 ? '<span class="ds-pageof">صفحة ' + (pg.idx + 1) + ' من ' + pg.total + '</span>' : '')
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
      + (showTable
        ? '<h2 class="ds-h ds-h-tbl">جداول الأثاث</h2>'
          + '<table class="ds-tbl"><thead><tr><th>القطعة</th><th>المقاس (سم)</th><th class="c-qty">العدد</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table>'
        : '')
      + cap
      + (showLegend
        ? '<h2 class="ds-h ds-h-leg">دليل الألوان والمواد</h2>'
          + '<ul class="ds-legend">' + legend + '</ul>'
        : '')
      + (showNote ? '<p class="ds-note">' + esc(f.note) + '</p>' : '')
      + areas
      + '</aside>'
      + (cont ? '' : '<div class="ds-plan">' + img + '</div>')
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

  /* ================= تقسيم الورقة على أكثر من صفحة =================
     لا يُعتمد على overflow:hidden ولا يُقصّ محتوى صامتاً: كل صفحة تُبنى ثم
     تُقاس فعلياً وهي موصولة (خطوط حقيقية وقياس حقيقي)، فإن جاوز محتوى
     العمود أسفله (نحو شريط التواصل) تُنقص مواصفة الصفحة وتُعاد — فلا يتداخل
     الجدول مع التذييل ولا تنقطع معلومة عن ملخص المساحات.
     القواعد: الصفوف تُقصّ من آخر صفوف الصفحة ولا يُقسَّم صف قطّاعاً؛ وما بعد
     الجدول (السعة ← الدليل ← الحاشية ← المساحات) كتل كاملة تنتقل بالترتيب
     نفسه إلى الصفحة التالية؛ ورأس القسم يتكرر على كل صفحة تحمل الجدول. */
  var SAFE_MM = 1.2;    // هامش أمان أسفل محتوى العمود قبل حدّ الصفحة (مم)
  var TOL_MM = 0.4;     // سماحية القياس (مم)
  var MAX_TRIES = 8;    // محاولات ضبط صفحة واحدة
  var MAX_PAGES = 24;   // سقف أمان لعدد الصفحات

  /** مم لكل بكسل داخل الورقة (عرضها ثابت 277مم) */
  function pxmmOf(el) {
    var w = el && el.getBoundingClientRect ? el.getBoundingClientRect().width : 0;
    return w > 0 ? w / SHEET_W : 0;
  }

  /** ارتفاع عنصر مع هوامشه بالمليمتر — الهامش التلقائي لا يضيف ارتفاعاً
      (لا فراغ فيه: لا يُقاس إلا عند تجاوز، حيث يصبح الفراغ سالباً فيُصفَّر) */
  function boxMm(el, k) {
    if (!el || !el.getBoundingClientRect) return 0;
    var mt = 0, mb = 0;
    if (window.getComputedStyle) {
      var cs = window.getComputedStyle(el);
      mt = parseFloat(cs.marginTop) || 0;
      mb = parseFloat(cs.marginBottom) || 0;
    }
    return (el.getBoundingClientRect().height + mt + mb) / k;
  }

  /** قياس صفحة موصولة بالمليمتر: المتاح في العمود حتى العائق الفعلي أسفله
      (بداية شريط التواصل إن وُجد وإلا حافة الصفحة نفسها)، تجاوز محتواه،
      ارتفاع الصف وكتل ما بعد الجدول. */
  function measureSheet(el) {
    var k = pxmmOf(el);
    if (!(k > 0)) return null;
    var body = el.querySelector('.ds-body'), side = el.querySelector('.ds-side');
    if (!body || !side) return null;
    var foot = el.querySelector('.ds-foot');
    /* العائق الفعلي: الشريط لا يُقاس من أسفل الجسم (بينهما هامش 2مم ينتمي
       للشريط)، وبلا شريط يبقى أسفل الصفحة هو الحد الفيزيائي */
    var obstacle = foot ? foot.getBoundingClientRect().top : el.getBoundingClientRect().bottom;
    var limit = obstacle - SAFE_MM * k;
    var sideTop = side.getBoundingClientRect().top;
    var bottom = 0, i;
    for (i = 0; i < side.children.length; i++) {
      bottom = Math.max(bottom, side.children[i].getBoundingClientRect().bottom);
    }
    var rows = el.querySelectorAll('.ds-tbl tbody tr');
    var rowsH = 0;
    for (i = 0; i < rows.length; i++) rowsH += rows[i].getBoundingClientRect().height;
    var thead = el.querySelector('.ds-tbl thead');
    /* كم عنصر دليل يتّسع حتى الحد الفعلي — لتفصيل دليل طويل على صفحات
       متتابعة بدل إخفائه أو إعلان تجاوزه */
    var legFit = null;
    var legEl = el.querySelector('.ds-legend');
    if (legEl) {
      legFit = 0;
      var lis = legEl.querySelectorAll('li');
      for (i = 0; i < lis.length; i++) {
        if (lis[i].getBoundingClientRect().bottom <= limit) legFit = i + 1;
        else break;
      }
    }
    return {
      k: k,
      avail: Math.max(0, (limit - sideTop) / k),
      overflow: (bottom - limit) / k,
      rowsN: rows.length,
      rowH: rows.length ? (rowsH / rows.length) / k : 0,
      tblHead: boxMm(el.querySelector('.ds-h-tbl'), k) + (thead ? thead.getBoundingClientRect().height / k : 0),
      cap: boxMm(el.querySelector('.ds-cap'), k),
      leg: boxMm(el.querySelector('.ds-h-leg'), k) + boxMm(el.querySelector('.ds-legend'), k),
      legFit: legFit,
      note: boxMm(el.querySelector('.ds-note'), k),
      areas: boxMm(el.querySelector('.ds-areas-wrap'), k)
    };
  }

  /** مواصفة الصفحة بعد قياسها: done = تكفي، وإلا مواصفة أصغر تُعاد المحاولة بها.
      الجدول الجاري يُقصّ أولاً، ثم تُهمل الكتل اللاحقة من آخرها، ولا يُحذف
      آخر ما في الصفحة قطّاً (يُوضع ويُعلَم تجاوزه بدل أن يختفي صامتاً). */
  function shrinkAlloc(alloc, m, f) {
    var next = { rows: alloc.rows.slice(), cap: !!alloc.cap, legend: !!alloc.legend,
      legendFrom: alloc.legendFrom || 0, legendTo: alloc.legendTo != null ? alloc.legendTo : null,
      note: !!alloc.note, areas: !!alloc.areas,
      cont: !!alloc.cont, first: !!alloc.first };
    var isEmpty = function (x) {
      return !x.rows.length && !x.cap && !x.legend && !x.note && !x.areas;
    };
    if (m.overflow <= TOL_MM) return { done: true, alloc: next, overflow: 0 };
    /* المتاح يشمل هامش الأمان أصلاً (avail = حتى العائق ناقصه) */
    var room = m.avail - m.tblHead;
    var nFit = m.rowH > 0 ? Math.floor(room / m.rowH) : 0;
    if (next.rows.length > 0 && nFit < next.rows.length) {
      var keep = Math.max(1, Math.min(nFit, next.rows.length - 1));
      if (keep < next.rows.length) {
        next.rows = next.rows.slice(0, keep);
        next.cap = false; next.legend = false; next.note = false; next.areas = false;
        next.legendTo = null;
        return { done: false, alloc: next };
      }
    }
    function drop(key) {
      var probe = { rows: next.rows, cap: next.cap, legend: next.legend,
        legendFrom: next.legendFrom, legendTo: next.legendTo,
        note: next.note, areas: next.areas,
        cont: next.cont, first: next.first };
      probe[key] = false;
      /* آخر ما في الصفحة لا يُحذف أبداً: يُوضع ويُعلَم تجاوزه بدل أن يختفي */
      if (isEmpty(probe)) return { done: true, alloc: next, overflow: m.overflow };
      next = probe;
      return { done: false, alloc: next };
    }
    if (next.areas) return drop('areas');
    if (next.note) return drop('note');
    if (next.legend) {
      var probeL = { rows: next.rows, cap: next.cap, legend: next.legend,
        legendFrom: next.legendFrom, legendTo: next.legendTo,
        note: next.note, areas: next.areas,
        cont: next.cont, first: next.first };
      probeL.legend = false;
      if (isEmpty(probeL)) {
        /* الدليل وحده هو كل ما بقي وهو أطول من الصفحة: نُجزّئه على صفحات
           متتابعة (عناصر تناسقاً) بدل إخفائه أو قصّه */
        var fit = m.legFit | 0;
        var from = next.legendFrom;
        var end = next.legendTo != null ? next.legendTo
          : (f && f.legend && f.legend.length ? f.legend.length : from);
        if (fit >= 1 && from + fit < end) {
          next.legendTo = from + fit;
          return { done: false, alloc: next };
        }
        return { done: true, alloc: next, overflow: m.overflow };
      }
      next = probeL;
      return { done: false, alloc: next };
    }
    if (next.cap) return drop('cap');
    if (next.rows.length > 1) {
      next.rows = next.rows.slice(0, next.rows.length - 1);
      return { done: false, alloc: next };
    }
    /* لا شيء يُحذف: محتوى لا يتّسع حتى مفرداً — يُبقي ويُعلَم بوضوح */
    return { done: true, alloc: next, overflow: m.overflow };
  }

  function tempHost() {
    var h = document.createElement('div');
    h.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;';
    if (document.body) document.body.appendChild(h);
    return h;
  }

  function buildPage(opts, f, pl, alloc, idx, total) {
    var el = document.createElement('div');
    el.innerHTML = render(f, pl, opts, { alloc: alloc, idx: idx, total: total });
    el = el.firstChild;
    el.__facts = f; el.__pl = pl; el.__alloc = alloc; el.__page = idx + 1;
    return el;
  }

  /** لوحة ظاهرة (لا إخفاء ولا قصّ): محتوى الصفحة أطول من مساحتها حتى
      تتحسّن التفاصيل لاحقاً — التقرير لا يكذب ولا يُطمس */
  function markOverflow(el) {
    if (!el || !el.appendChild || el.querySelector('.ds-over')) return;
    var s = document.createElement('span');
    s.className = 'ds-over';
    s.textContent = 'محتوى هذه الصفحة أطول من مساحتها — معروض كاملاً';
    el.appendChild(s);
  }

  /** صفحة واحدة تُبنى وتُقاس وتُضبط مواصفتها حتى تتّسع — المحاولات الفاشلة
      تبقى مرفوعة حتى تُستبدل (قياس الصفحة الجديدة لا يتأثّر بجوارها) ثم تُرفع.
      لو تعذّر الضبط تماماً تُبقي آخر محاولة مع لوحة ظاهرة — لا محتوى مفقود. */
  function tunePage(h, opts, f, pl, alloc, idx, total) {
    var builtEls = [], lastAlloc = alloc;
    function dropExcept(keep) {
      builtEls.forEach(function (x) { if (x !== keep && x.parentNode === h) h.removeChild(x); });
    }
    try {
      for (var t = 0; t < MAX_TRIES; t++) {
        lastAlloc = alloc;
        var el = buildPage(opts, f, pl, alloc, idx, total);
        h.appendChild(el); builtEls.push(el);
        var res = null;
        try {
          if (opts.footHtml && pl && pl.img) { try { fitFoot(el, pl, opts); } catch (_) { /* noop */ } }
          var m = measureSheet(el);
          res = m ? shrinkAlloc(alloc, m, f) : { done: true, alloc: alloc, overflow: 0 };
        } catch (_) { res = { done: true, alloc: alloc, overflow: 0 }; }
        if (res.done) {
          if (res.overflow > TOL_MM) { el.__overflow = res.overflow; markOverflow(el); }
          dropExcept(el);
          return { el: el, alloc: res.alloc };
        }
        alloc = res.alloc;
      }
      /* سقف المحاولات: آخر محاولة تُبقي ويُعلَم تجاوزها ظاهراً */
      var lastEl = builtEls[builtEls.length - 1];
      if (lastEl) {
        if (!lastEl.__overflow) { lastEl.__overflow = TOL_MM + 1; markOverflow(lastEl); }
        dropExcept(lastEl);
        return { el: lastEl, alloc: lastAlloc };
      }
      return null;
    } catch (e) {
      dropExcept(null);
      throw e;
    }
  }

  /** كل صفحات الورقة داخل host (وإلا مضيف مؤقت تُرفع منه الصفحات بعد البناء).
      الصفحات تُقاس وهي موصولة، ثم تُعاد بأرقام صفحاتها إن تعدّدت. */
  function buildPages(opts, host) {
    opts = opts || {};
    var f = facts(opts.design, opts);
    var pl = opts.img === null ? null : plan(opts.design, opts, opts.imgW || 1600);
    var own = !host;
    var h = host || tempHost();
    /* موضع غير موصول لا يقيس شيئاً (أبعاد صفرية) — نرفعه مؤقتاً ليفصل
       الصفحات فعلياً بدل تركها مجتمعة في صفحة واحدة مكتومة */
    if (!own && document.body && h.isConnected === false) {
      try { document.body.appendChild(h); } catch (_) { /* noop */ }
    }
    var pages = [];
    var pendingRows = (f.rows || []).slice();
    var pendingTrail = ['cap', 'legend', 'note'].concat(f.areas ? ['areas'] : []);
    var legendFrom = 0;   /* أول عنصر دليل لم يُوضع بعد (يُنصّب على صفحات) */
    var guard = 0;
    try {
      while ((pendingRows.length || pendingTrail.length) && guard++ < MAX_PAGES) {
        var idx = pages.length;
        var alloc = {
          rows: pendingRows.slice(), cont: idx > 0, first: idx === 0,
          cap: pendingTrail.indexOf('cap') >= 0,
          legend: pendingTrail.indexOf('legend') >= 0,
          legendFrom: legendFrom, legendTo: null,
          note: pendingTrail.indexOf('note') >= 0,
          areas: pendingTrail.indexOf('areas') >= 0
        };
        var built = tunePage(h, opts, f, pl, alloc, idx, 0);
        if (!built) break;
        alloc = built.alloc;
        pages.push(built.el);
        pendingRows = pendingRows.slice(alloc.rows.length);
        if (alloc.legend) {
          /* ما وُضع من الدليل (حتى الجزء المقصوص منه على هذه الصفحة) صار مرفوعاً */
          legendFrom = alloc.legendTo != null ? alloc.legendTo : (f.legend || []).length;
          if (legendFrom >= (f.legend || []).length) {
            pendingTrail = pendingTrail.filter(function (x) { return x !== 'legend'; });
          }
        }
        ['cap', 'note', 'areas'].forEach(function (key) {
          if (alloc[key]) pendingTrail = pendingTrail.filter(function (x) { return x !== key; });
        });
      }
      /* لم يبقَ مكان (سقف الصفحات): لا نُسقط محتوى صامتاً — نعلّم آخر صفحة */
      if ((pendingRows.length || pendingTrail.length) && pages.length) {
        var last = pages[pages.length - 1];
        if (!last.__overflow) { last.__overflow = TOL_MM + 1; markOverflow(last); }
      }
      /* شارة «صفحة N من M» تحتاج العدد النهائي: تُعاد بناء الصفحات بنفس
         المواصفات ويُتحقق منها — وإن خالف القياس الجديد مواصفة قديمة تُرفض
         الشارة لكل الصفحات معاً (توافق تام أجمل من شارات ناقصة)، والصفوف
         لا تُقاس من جديد في أي حال. */
      if (pages.length > 1) {
        var repl = [], ok = true;
        for (var i = 0; i < pages.length; i++) {
          var old = pages[i];
          var again = tunePage(h, opts, f, pl, old.__alloc, i, pages.length);
          if (!again) { ok = false; break; }
          var a1 = again.alloc, a0 = old.__alloc;
          var same = a1.rows.length === a0.rows.length
            && !!a1.cap === !!a0.cap && !!a1.legend === !!a0.legend
            && (a1.legendFrom || 0) === (a0.legendFrom || 0)
            && (a1.legendTo == null ? null : a1.legendTo) === (a0.legendTo == null ? null : a0.legendTo)
            && !!a1.note === !!a0.note && !!a1.areas === !!a0.areas;
          if (!same || again.el.__overflow) {
            ok = false;
            try { if (again.el.parentNode === h) h.removeChild(again.el); } catch (_) { /* noop */ }
            break;
          }
          repl.push(again.el);
        }
        if (ok && repl.length === pages.length) {
          for (var r = 0; r < pages.length; r++) {
            try { if (pages[r].parentNode === h) h.removeChild(pages[r]); } catch (_) { /* noop */ }
            pages[r] = repl[r];
          }
        } else {
          repl.forEach(function (x) { try { if (x.parentNode === h) h.removeChild(x); } catch (_) { /* noop */ } });
        }
      }
      if (own) {
        for (var j = 0; j < pages.length; j++) { try { h.removeChild(pages[j]); } catch (_) { /* noop */ } }
        try { if (h.parentNode) h.parentNode.removeChild(h); } catch (_) { /* noop */ }
      }
      return pages;
    } catch (e) {
      if (own) { try { if (h.parentNode) h.parentNode.removeChild(h); } catch (_) { /* noop */ } }
      throw e;
    }
  }

  /** الصفحة الأولى فقط (للمعاينة على الشاشة) — السلوك القديم لـ build() */
  function build(opts) {
    var pages = buildPages(opts, null);
    return pages.length ? pages[0] : document.createElement('div');
  }

  /* رفع الورقة إلى موضع خارج الشاشة وتصويرها — internals مشتركة بين
     pdfBlob (ملف مستقل) وaddPage (صفحة ثانية داخل أمر قائمة).
     الترتيب حاسم للروابط: el يجب أن يبقى متصلاً بالوثيقة حتى يقيس
     addLinks مواقع البطاقات — فإن فُصل أولاً ترجع getBoundingClientRect
     أصفاراً وتُصفَّر روابط PDF كلها (ما حدث في cbe9ad4).
     release() يستدعي restore() بعد stamp() بترتيب واحد ويمنع التكرار. */
  function shoot(opts) {
    opts = opts || {};
    var area = opts.mount;
    if (!area || !area.appendChild) return Promise.reject(new Error('لا يوجد موضع لعرض الورقة.'));
    var prevHtml = area.innerHTML, prevCss = area.style.cssText;
    function restore() { area.style.cssText = prevCss; area.innerHTML = prevHtml; }
    var released = false;
    function release() { if (released) return; released = true; restore(); }
    try {
      area.innerHTML = '';
      area.style.cssText = 'display:block;position:fixed;top:0;left:-10000px;background:#fff;z-index:-1';
    } catch (e) {
      /* فشل الإعداد المزامني (قبل Promise): لا نترك الواحة مفرّغة */
      try { release(); } catch (_) { /* noop */ }
      return Promise.reject(e);
    }
    return Promise.resolve()
      .then(function () { return document.fonts && document.fonts.ready ? document.fonts.ready : null; })
      .then(function () {
        /* البناء والقياس بعد تحميل الخطوط (التفاف نص الشريط قد يتغيّر) —
           كل الصفحات داخل الواحة نفسها فالقياس حقيقي ومتوافق مع التصوير */
        var els = buildPages(opts, area);
        if (!els.length) { var one = build(opts); area.appendChild(one); els = [one]; }
        var shots = [];
        var chain = Promise.resolve();
        els.forEach(function (el) {
          chain = chain.then(function () {
            return window.html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
          }).then(function (canvas) { shots.push({ canvas: canvas, el: el }); });
        });
        return chain.then(function () { return { shots: shots, release: release }; });
      })
      .then(null, function (e) { release(); throw e; });
  }

  /** تطبيق لقطة الورقة كصفحة A4 أفقي 277×190مم داخل PDF قائمة */
  function stamp(pdf, shot, opts) {
    var jpg = shot.canvas.toDataURL('image/jpeg', 0.94);
    pdf.addImage(jpg, 'JPEG', 10, 10, SHEET_W, SHEET_H, undefined, 'FAST');
    if (typeof (opts && opts.addLinks) === 'function') {
      try { opts.addLinks(pdf, shot.el, 10, 10, SHEET_W); } catch (_) { /* noop */ }
    }
    return pdf;
  }

  /** PDF أفقي 277×190مم — المكتبة نفسها (html2canvas + jsPDF) كما كانت،
      وعدد صفحاته = عدد الصفحات المبنية فعلياً (الصفحة الأولى بلا addPage).
      release() بعد آخر stamp: قياس الروابط يقع والصفحات موصولة. */
  function pdfBlob(opts) {
    return shoot(opts).then(function (s) {
      try {
        var jsPDF = window.jspdf.jsPDF;
        var pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
        for (var i = 0; i < s.shots.length; i++) {
          if (i > 0) pdf.addPage('a4', 'landscape');
          stamp(pdf, s.shots[i], opts);
        }
        return pdf.output('blob');
      } finally {
        s.release();
      }
    });
  }

  /** إضافة ورقة التصميم كصفحات أفقية إلى أمر شراء/تصنيف قائمة
      (نفس صفحات العميل تماماً: المقياس والجدول والألوان وملخص المساحات) */
  function addPage(pdf, opts) {
    if (!pdf) return Promise.reject(new Error('لا يوجد موضع لعرض الورقة.'));
    return shoot(opts).then(function (s) {
      try {
        for (var i = 0; i < s.shots.length; i++) {
          pdf.addPage('a4', 'landscape');
          stamp(pdf, s.shots[i], opts);
        }
        return pdf;
      } finally {
        s.release();
      }
    });
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
    buildPages: buildPages,
    measureSheet: measureSheet,
    pdfBlob: pdfBlob,
    addPage: addPage,
    fmtDate: fmtDate,
    pickScaleMeters: pickScaleMeters
  };

  global.DesignSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
