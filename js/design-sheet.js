/* =====================================================================
   ورقة التصميم المشتركة (DesignSheet)
   ---------------------------------------------------------------------
   مخرج واحد يتقاسمه مسارات PDF الثلاثة: العميل (portal.js)، الموظف
   (app.js)، والتصميم الموسّع (portal-expanded.js) — بالبنية نفسها
   وبالقياسات نفسها حتى لا يختلف مخططان لنفس الغرفة في ورقتين.

   القواعد المتفق عليها:
   - صفحة واحدة دائماً: A4 أفقي، وإن لم يتّسع المحتوى بخطوطه الثابتة فـA3 ثم A2
     ثم مقاس مخصص — لا تقسيم على صفحات ولا تصغير خطوط (انظر layout).
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

  /* مقاس الورقة الافتراضي بالمليمتر (A4 أفقي بهامش 10مم من كل جهة) — المقاس
     الفعلي لكل ورقة يُختار في layout ويُحمل على العنصر (__paper/__size) */
  var SHEET_W = 277, SHEET_H = 190;

  /* صندوق المخطط المرجعي على A4 (للمستدعين القدامى فقط) — الصندوق الفعلي
     يُقاس بعد بناء الورقة في fitPlan، فيكبر مع المقاس وينقص بشريط التواصل */
  var PLAN_BOX = { w: 178, h: 153 };

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

  /** نص مختلط عربي/لاتيني: كل مقطع لاتيني (مع أقواسه وأرقامه) يُعزل اتجاهياً
      فلا تنقلب الأقواس ولا يتبعثر الاسم الإنجليزي داخل الجملة العربية */
  function mixed(s) {
    return esc(s).replace(/\(?[A-Za-z][A-Za-z0-9 .,'&+\/-]*[A-Za-z0-9.]\)?|\(?[A-Za-z]\)?/g, function (m) {
      return '<bdi dir="ltr" class="lat">' + m + '</bdi>';
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
    /* إعادة رسم بتسميات أكبر (يستدعيها fitPlan حين يصغر صندوق الصورة على الورق) */
    var relabel = function (k) { return off.toImage(W, H, { labelScale: k }); };

    /* نفس حساب toImage تماماً: scale = W / (bbW + 2*pad) */
    var view = null;
    try { view = off._fitView(W, H); } catch (_) { view = null; }
    var out = { img: img, W: W, H: H, room: null, scale: view ? view.scale : 0, relabel: relabel };
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

  /* ================= مقاس الورقة: صفحة واحدة دائماً =================
     الورقة لا تُقسَّم على صفحات ولا تُصغَّر خطوطها لتتسع: تُبنى بالخطوط
     والمسافات الثابتة نفسها على A4 أفقي، فإن لم يتّسع العمود الجانبي (جدول
     الأثاث والدليل والحاشية والمساحات) بوضوح تُعاد على A3 ثم A2، وما بعد A2
     صفحة مخصصة بعرض A2 وارتفاع يكفي المحتوى. المخطط يملأ ما يبقى من المساحة
     فيكبر مع الورقة. الهامش 10مم من كل جهة، والورقة نفسها = الصفحة − الهامشين. */
  var MARGIN = 10;
  /* side = عرض عمود الجدول الواحد، cols = أقصى عدد أعمدة للجدول على المقاس
     (الجدول الطويل يُقسَّم أعمدة متجاورة برأس مكرر بدل صفحة طويلة جداً) */
  var PAPERS = [
    { id: 'a4', label: 'A4 أفقي', w: 297, h: 210, side: 72, cols: 1 },
    { id: 'a3', label: 'A3 أفقي', w: 420, h: 297, side: 84, cols: 2 },
    { id: 'a2', label: 'A2 أفقي', w: 594, h: 420, side: 92, cols: 3 }
  ];
  var TOL_MM = 0.4;     // سماحية القياس (مم)
  var SAFE_MM = 1.2;    // هامش أمان أسفل العمود قبل العائق (مم)

  function sizeOf(paper) {
    var p = paper || PAPERS[0];
    return { w: p.w - 2 * MARGIN, h: p.h - 2 * MARGIN };
  }
  /** ورقة مخصصة: عرض A2 وارتفاع يكفي المحتوى (يُقرَّب لأعلى 5مم) */
  function customPaper(hMm) {
    var base = PAPERS[PAPERS.length - 1];
    var h = Math.max(base.h, Math.ceil((hMm + 2 * MARGIN) / 5) * 5);
    /* الأبعاد معزولة باتجاه يسار←يمين (LRI…PDI) فلا تنقلب «594×700» داخل الجملة العربية */
    var LRI = String.fromCharCode(0x2066), PDI = String.fromCharCode(0x2069);
    return { id: 'custom', label: 'مقاس مخصص ' + LRI + base.w + '×' + h + PDI + ' مم', w: base.w, h: h, side: base.side, cols: base.cols };
  }

  /* مقياس الرسم: الشريط يمثّل m متراً أرضياً.
     الحساب: طول الشريط بالبكسل = m × pl.scale (بكسل/م من _fitView)،
     وعرض الحاوية = طول الشريط ÷ عرض صورة المخطط (كسر) → تُكتب كنسبة من
     عرض صندوق الصورة؛ والصورة تملأ صندوقها بنسبتها نفسها فيصحّ القياس. */
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

  /** صورة المخطط داخل صندوقها (المقاس الفعلي يُضبط بعد القياس في fitPlan) */
  function planHtml(pl) {
    return pl && pl.img
      ? '<span class="ds-img"><img src="' + pl.img + '" alt="مخطط المجلس">' + scaleBlock(pl) + '</span>'
      : '<span class="ds-img ds-img-empty">لا يوجد مخطط</span>';
  }

  /** صفوف الجدول مقسّمة على cols أعمدة متساوية تقريباً (بالترتيب نفسه) */
  function chunk(rows, cols) {
    cols = Math.max(1, Math.min(cols || 1, rows.length || 1));
    var out = [], per = Math.ceil(rows.length / cols), i;
    for (i = 0; i < cols; i++) out.push(rows.slice(i * per, (i + 1) * per));
    return out.filter(function (c, j) { return c.length || j === 0; });
  }

  /** العمود الجانبي: جدول الأثاث (عمود أو أكثر برأس مكرر) ← السعة ← ملخص المساحات.
      كله دائماً على الصفحة نفسها — بلا أي معلومة مالية. */
  function sideHtml(f, cols, noAreas) {
    var tables = chunk(f.rows, cols).map(function (part) {
      var rows = part.map(function (r) {
        return '<tr><td class="c-name">' + mixed(r.name) + '</td>'
          + '<td class="c-dims"><bdi class="num">' + esc(r.dims) + '</bdi></td>'
          + '<td class="c-qty num">' + r.qty + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="ds-empty">لا توجد قطع على المخطط</td></tr>';
      return '<table class="ds-tbl"><thead><tr><th>القطعة</th><th>المقاس (سم)</th><th class="c-qty">العدد</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table>';
    });
    var cap = f.capacity > 0
      ? '<div class="ds-cap"><b class="num">' + f.capacity + '</b><span>مقعداً – سعة الجلوس</span></div>'
      : '';
    return '<h2 class="ds-h ds-h-tbl">جداول الأثاث</h2>'
      + '<div class="ds-tbls" style="--ds-cols:' + tables.length + '">' + tables.join('') + '</div>'
      + cap + (noAreas ? '' : areasHtml(f));
  }

  /** صندوق ملخص المساحات (فقط عند اكتمال البيانات) */
  function areasHtml(f) {
    var areas = '';
    if (f.areas) {
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
    return areas;
  }

  /** شريط أسفل المخطط: دليل الألوان (عناصر متدفقة) + حاشية القياسات */
  function legendHtml(f) {
    var legend = f.legend.map(function (e) {
      var cls = 'sw' + (e.shape === 'circle' ? ' circle' : '') + (e.shape === 'outline' ? ' outline' : '');
      var style = e.shape === 'outline' ? '' : ' style="background:' + esc(e.color) + '"';
      return '<li><span class="' + cls + '"' + style + '></span>'
        + '<span class="lb">' + mixed(e.label) + '</span>'
        + (e.sub ? '<span class="sb">' + esc(e.sub) + '</span>' : '') + '</li>';
    }).join('');
    return (legend ? '<div class="ds-leg-wrap"><h2 class="ds-h ds-h-leg">دليل الألوان والمواد</h2><ul class="ds-legend">' + legend + '</ul></div>' : '')
      + '<p class="ds-note">' + esc(f.note) + '</p>';
  }

  /** HTML الورقة كاملة على مقاس paper (سلسلة — قابلة للاختبار بلا متصفح) */
  function render(f, pl, opts, paper, cols, leg) {
    opts = opts || {};
    paper = paper && paper.w ? paper : PAPERS[0];
    var sz = sizeOf(paper);
    var meta = (opts.meta || []).slice();
    /* الترتيب عرض × طول — نفس اتجاه roomSummary والجداول (walls[0] × walls[1]) */
    var roomTxt = f.room && f.room.w > 0
      ? cm(f.room.w) + ' × ' + cm(f.room.h) + ' سم' : '—';
    var head = [{ label: 'التاريخ', value: fmtDate(opts.date) },
      { label: 'الغرفة', value: roomTxt }].concat(meta);
    var sideW = paper.side * (cols || 1) + 4 * ((cols || 1) - 1);
    return '<div class="dsheet" data-paper="' + esc(paper.id) + '" style="--ds-w:' + sz.w + 'mm;--ds-h:' + sz.h + 'mm;--ds-side:' + sideW + 'mm">'
      + '<div class="ds-head">'
      + '<div class="ds-titles"><p class="ds-caption">' + esc(opts.caption || DEFAULT_CAPTION) + '</p>'
      + '<h1 class="ds-title">' + esc(opts.title || DEFAULT_TITLE) + '</h1></div>'
      + '<dl class="ds-meta">' + head.map(function (m) {
        return '<div class="ds-meta-i"><dt>' + esc(m.label) + '</dt>'
          + '<dd class="num">' + mixed(m.value) + '</dd></div>';
      }).join('') + '</dl>'
      + '</div>'
      + '<div class="ds-body">'
      + '<aside class="ds-side">' + sideHtml(f, cols || 1) + (leg === 'side' ? '<div class="ds-side-leg">' + legendHtml(f) + '</div>' : '') + '</aside>'
      + '<div class="ds-main"><div class="ds-plan">' + planHtml(pl) + '</div>' + (leg === 'side' ? '' : legendHtml(f)) + '</div>'
      + '</div>'
      + (opts.footHtml ? '<div class="ds-foot">' + opts.footHtml + '</div>' : '')
      + '</div>';
  }

  /** مم لكل بكسل داخل عنصر عرضه wMm */
  function pxmmOf(el, wMm) {
    var w = el && el.getBoundingClientRect ? el.getBoundingClientRect().width : 0;
    return w > 0 ? w / (wMm || SHEET_W) : 0;
  }

  /** ضبط صورة المخطط على صندوقها الفعلي (بعد القياس) بنسبتها نفسها — فلا
      تُشوَّه ولا تُقصّ، وتكبر تلقائياً مع الورقة. container يحتوي .ds-plan */
  function fitPlan(container, pl, wMm) {
    if (!container || !container.querySelector || !pl || !pl.img || !(pl.W > 0) || !(pl.H > 0)) return null;
    var box = container.querySelector('.ds-plan');
    var img = container.querySelector('.ds-img');
    if (!box || !img) return null;
    var k = pxmmOf(container, wMm);
    if (!(k > 0)) return null;
    var cs = window.getComputedStyle ? window.getComputedStyle(box) : null;
    var padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
    var padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
    var bw = (box.clientWidth - padX) / k, bh = (box.clientHeight - padY) / k;
    if (!(bw > 0) || !(bh > 0)) return null;
    var s = Math.min(bw / pl.W, bh / pl.H);
    img.style.width = r2(pl.W * s) + 'mm';
    img.style.height = r2(pl.H * s) + 'mm';
    /* التسميات المرسومة داخل الصورة (الجدران والمقاسات) تصغر مع صندوقها: إن كان
       الصندوق أصغر من أن تبقى ≥ 2.6مم تُعاد الصورة بتسميات أكبر بالنسبة نفسها
       (النص في المحرّك ≤ 13k بكسل حيث k = W/720 ⇒ ارتفاعه ≈ 13/720 من العرض) */
    var wImg = pl.W * s;
    var want = LABEL_MM * 720 / (13 * wImg);
    var lk = want > 1.05 ? Math.min(2.6, r2(want)) : 1;
    if (typeof pl.relabel === 'function' && lk !== (pl.__lk || 1)) {
      try { pl.img = pl.relabel(lk); pl.__lk = lk; } catch (_) { /* تبقى الصورة الأصلية */ }
      var im = img.querySelector('img');
      if (im) im.src = pl.img;
    }
    return { w: r2(wImg), h: r2(pl.H * s), labelScale: pl.__lk || 1 };
  }

  /** أصغر ارتفاع مقبول لتسميات المخطط على الورق (مم ≈ 7.5pt) */
  var LABEL_MM = 2.6;

  /** ارتفاع عنصر مع هوامشه بالمليمتر */
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

  /** قياس ورقة موصولة بالمليمتر: تجاوز العمود الجانبي حتى العائق الفعلي أسفله
      (بداية شريط التواصل إن وُجد وإلا حافة الورقة)، وتجاوز الترويسة. */
  function measureSheet(el) {
    var wMm = (el && el.__size && el.__size.w) || SHEET_W;
    var k = pxmmOf(el, wMm);
    if (!(k > 0)) return null;
    var body = el.querySelector('.ds-body'), side = el.querySelector('.ds-side');
    if (!body || !side) return null;
    var foot = el.querySelector('.ds-foot');
    var obstacle = foot ? foot.getBoundingClientRect().top : el.getBoundingClientRect().bottom;
    var limit = obstacle - SAFE_MM * k;
    var bottom = 0, i;
    for (i = 0; i < side.children.length; i++) {
      bottom = Math.max(bottom, side.children[i].getBoundingClientRect().bottom);
    }
    var main = el.querySelector('.ds-main');
    if (main) for (i = 0; i < main.children.length; i++) {
      bottom = Math.max(bottom, main.children[i].getBoundingClientRect().bottom);
    }
    var sheetBottom = el.getBoundingClientRect().bottom;
    var footOver = foot ? (foot.getBoundingClientRect().bottom - sheetBottom) / k : 0;
    var plan = el.querySelector('.ds-plan');
    return {
      k: k,
      avail: Math.max(0, (limit - side.getBoundingClientRect().top) / k),
      overflow: Math.max((bottom - limit) / k, footOver),
      planH: plan ? plan.getBoundingClientRect().height / k : 0,
      planW: plan ? plan.getBoundingClientRect().width / k : 0,
      rowsN: el.querySelectorAll('.ds-tbl tbody tr').length
    };
  }

  function tempHost() {
    var h = document.createElement('div');
    h.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;';
    if (document.body) document.body.appendChild(h);
    return h;
  }

  function buildOn(h, opts, f, pl, paper, cols, leg) {
    var wrap = document.createElement('div');
    wrap.innerHTML = render(f, pl, opts, paper, cols, leg);
    var el = wrap.firstChild;
    el.__facts = f; el.__pl = pl; el.__paper = paper; el.__size = sizeOf(paper); el.__cols = cols || 1;
    h.appendChild(el);
    fitPlan(el, pl, el.__size.w);
    return el;
  }

  /** المخطط لا يجوز أن يضيق إلى حدّ لا يُقرأ: أصغر صندوق مقبول (مم) */
  var PLAN_MIN = { w: 120, h: 90 };

  /** اختيار المقاس وبناء الورقة الواحدة داخل host (موصول، قياس حقيقي).
      المرشّحون بالترتيب: A4 عمود واحد، A3 بعمود ثم عمودين، A2 بعمودين ثم ثلاثة،
      ثم مقاس مخصص بعرض A2 وثلاثة أعمدة وارتفاع يكفي. يُقبل أول مرشّح لا يتجاوز
      محتواه الورقة ويبقى مخططه بحجم مقروء — الخطوط لا تتغير في أي مرشّح.
      يُعيد العنصر وعليه __paper و__size و__cols. */
  function candidates(opts) {
    var list = opts.paper ? [opts.paper] : PAPERS;
    var out = [];
    list.forEach(function (p) {
      var from = p.cols > 1 ? Math.max(1, p.cols - 1) : 1;
      for (var c = from; c <= (p.cols || 1); c++) { out.push({ paper: p, cols: c, leg: 'side' }); out.push({ paper: p, cols: c, leg: 'main' }); }
    });
    return out;
  }
  function layout(opts, h, f, pl) {
    var list = candidates(opts);
    var el = null, m = null, need = 0;
    for (var i = 0; i < list.length; i++) {
      if (el && el.parentNode === h) h.removeChild(el);
      el = buildOn(h, opts, f, pl, list[i].paper, list[i].cols, list[i].leg);
      m = measureSheet(el);
      if (!m) return el;
      var planOk = !pl || !pl.img || (m.planW >= PLAN_MIN.w && m.planH >= PLAN_MIN.h);
      if (m.overflow <= TOL_MM && planOk) return el;
      need = sizeOf(list[i].paper).h + Math.max(m.overflow, planOk ? 0 : PLAN_MIN.h - m.planH) + 4;
    }
    if (opts.paper) return el;
    /* ما بعد A2: صفحة مخصصة بارتفاع يكفي (حتى ثلاث محاولات لتصحيح القياس) */
    var last = PAPERS[PAPERS.length - 1];
    for (var t = 0; t < 3; t++) {
      if (el && el.parentNode === h) h.removeChild(el);
      el = buildOn(h, opts, f, pl, customPaper(need), last.cols, 'main');
      m = measureSheet(el);
      if (!m || m.overflow <= TOL_MM) return el;
      need = el.__size.h + m.overflow + 4;
    }
    return el;
  }

  /** عرض صورة المخطط بالبكسل: يكفي لدقة ~300 نقطة/بوصة على أكبر ورقة مرشّحة */
  function planPx(opts) {
    return opts.imgW || 3200;
  }

  /** الورقة الواحدة داخل host (وإلا مضيف مؤقت تُرفع منه بعد البناء).
      تُعيد مصفوفة بعنصر واحد دائماً (واجهة buildPages محفوظة للمستدعين). */
  function buildPages(opts, host) {
    opts = opts || {};
    var f = facts(opts.design, opts);
    var pl = opts.img === null ? null : plan(opts.design, opts, planPx(opts));
    var own = !host;
    var h = host || tempHost();
    if (!own && document.body && h.isConnected === false) {
      try { document.body.appendChild(h); } catch (_) { /* noop */ }
    }
    try {
      var el = layout(opts, h, f, pl);
      if (own) { try { h.removeChild(el); } catch (_) { /* noop */ } try { h.parentNode.removeChild(h); } catch (_) { /* noop */ } }
      return [el];
    } catch (e) {
      if (own) { try { if (h.parentNode) h.parentNode.removeChild(h); } catch (_) { /* noop */ } }
      throw e;
    }
  }

  /** الورقة الواحدة (للمعاينة على الشاشة) — نفس عنصر PDF حرفياً */
  function build(opts) {
    return buildPages(opts, null)[0];
  }

  /** مقياس التصوير: ~300 نقطة/بوصة (11.8 بكسل/مم) مع سقف لمساحة اللوحة —
      الجوال أقل ذاكرة فسقفه أخفض، ولا يقل عن 2× (الدقة القديمة) أبداً */
  var DPMM = 11.8, CSS_PXMM = 96 / 25.4;
  function shotScale(el) {
    var r = el.getBoundingClientRect();
    var want = DPMM / CSS_PXMM;
    var coarse = !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
    var maxPix = coarse ? 18e6 : 36e6;
    var cap = Math.sqrt(maxPix / Math.max(1, r.width * r.height));
    return Math.max(2, Math.min(want, cap));
  }

  /* رفع الورقة إلى موضع خارج الشاشة وتصويرها بدقة عالية. el يبقى موصولاً
     حتى يقيس addLinks مواقع البطاقات، ثم release() تعيد الموضع كما كان. */
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
      area.style.cssText = 'display:block;position:fixed;top:0;left:-20000px;background:#fff;z-index:-1';
    } catch (e) {
      try { release(); } catch (_) { /* noop */ }
      return Promise.reject(e);
    }
    return Promise.resolve()
      .then(function () { return document.fonts && document.fonts.ready ? document.fonts.ready : null; })
      .then(function () {
        var el = buildPages(opts, area)[0];
        return window.html2canvas(el, { scale: shotScale(el), backgroundColor: '#ffffff', useCORS: true, logging: false })
          .then(function (canvas) { return { shots: [{ canvas: canvas, el: el }], release: release }; });
      })
      .then(null, function (e) { release(); throw e; });
  }

  /** مقاس صفحة PDF لورقة مبنية: {w,h} بالمم واتجاهها */
  function pageOf(el) {
    var p = (el && el.__paper) || PAPERS[0];
    return { w: p.w, h: p.h, id: p.id, label: p.label, orientation: p.w > p.h ? 'landscape' : 'portrait' };
  }

  /** ختم لقطة الورقة على الصفحة الحالية بهامش 10مم */
  function stamp(pdf, shot, opts) {
    var sz = (shot.el && shot.el.__size) || { w: SHEET_W, h: SHEET_H };
    var jpg = shot.canvas.toDataURL('image/jpeg', 0.95);
    pdf.addImage(jpg, 'JPEG', MARGIN, MARGIN, sz.w, sz.h, undefined, 'FAST');
    if (typeof (opts && opts.addLinks) === 'function') {
      try { opts.addLinks(pdf, shot.el, MARGIN, MARGIN, sz.w, sz.h); } catch (_) { /* noop */ }
    }
    return pdf;
  }

  /** PDF من صفحة واحدة بالضبط، بمقاس الورقة المختارة (A4/A3/A2/مخصص).
      release() بعد الختم: قياس الروابط يقع والورقة موصولة. */
  function pdfBlob(opts) {
    return shoot(opts).then(function (s) {
      try {
        var pg = pageOf(s.shots[0].el);
        var jsPDF = window.jspdf.jsPDF;
        var pdf = new jsPDF({ unit: 'mm', format: [pg.w, pg.h], orientation: pg.orientation });
        stamp(pdf, s.shots[0], opts);
        return pdf.output('blob');
      } finally {
        s.release();
      }
    });
  }

  /** إضافة الورقة كصفحة جديدة (بمقاسها) إلى PDF قائم — للمستدعين القدامى */
  function addPage(pdf, opts) {
    if (!pdf) return Promise.reject(new Error('لا يوجد موضع لعرض الورقة.'));
    return shoot(opts).then(function (s) {
      try {
        var pg = pageOf(s.shots[0].el);
        pdf.addPage([pg.w, pg.h], pg.orientation);
        stamp(pdf, s.shots[0], opts);
        return pdf;
      } finally {
        s.release();
      }
    });
  }

  var api = {
    SHEET_W: SHEET_W,
    SHEET_H: SHEET_H,
    MARGIN: MARGIN,
    PAPERS: PAPERS,
    PLAN_BOX: PLAN_BOX,
    PLAN_MIN: PLAN_MIN,
    SEAT_M: SEAT_M,
    SEATING: SEATING,
    seatsOf: seatsOf,
    roomOf: roomOf,
    polyBox: polyBox,
    facts: facts,
    plan: plan,
    planHtml: planHtml,
    sideHtml: sideHtml,
    legendHtml: legendHtml,
    areasHtml: areasHtml,
    fitPlan: fitPlan,
    render: render,
    build: build,
    buildPages: buildPages,
    measureSheet: measureSheet,
    sizeOf: sizeOf,
    pageOf: pageOf,
    customPaper: customPaper,
    shotScale: shotScale,
    pdfBlob: pdfBlob,
    addPage: addPage,
    fmtDate: fmtDate,
    pickScaleMeters: pickScaleMeters,
    mixed: mixed
  };

  global.DesignSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
