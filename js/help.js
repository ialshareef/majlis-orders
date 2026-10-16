/* ======================================================================
   نظام الشرح والمساعدة — وحدة مشتركة لواجهات Majlis Orders
   - محرك واحد (Tour) لشرح أول الاستخدام + دليل دائم، وبنفس المكوّن.
   - محتوى مستقل لكل واجهة: العميل / الموظف / المندوب.
   - التفضيل يُحفظ محلياً في localStorage فقط (لا قاعدة بيانات).
   - لا يعتمد على إطار عمل: Vanilla JS بأسلوب المشروع (ES modules + IIFE).
   ====================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------ أدوات ------------------------------ */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } },
  };

  /* ======================================================================
     المحتوى: العميل (بوابة التصميم)
     مبني على خطوات التصميم الفعلية في portal.js (room → openings → majlis → furn → review)
     كل خطوة تحمل أهداف استهداف (targets) تُجرَّب بالترتيب: عنصر DOM حقيقي،
     أو منطقة محسوبة على الرسم عبر المصمم (rect)، مع نص بديل (p) لكل هدف
     احتياطي. الخطوة بلا هدف صالح تُعرض كبطاقة في المنتصف — لا تُحذف ولا
     تُعطَّل الجولة. الخطوة ذات skipIf تُتجاوَز بصمت عند غياب شرطها.
     ====================================================================== */
  const CUSTOMER = {
    role: 'customer',
    title: 'دليل مصمم المجالس',
    intro: 'صمّم مجلسك خطوة بخطوة، ثم أرسله للمحل ليصير طلبًا.',
    steps: [
      {
        h: 'مساحة التصميم',
        p: 'هذه مساحة رسم المجلس: شكل الغرفة وتوزيع عناصرها يظهران هنا لحظة بلحظة.',
        tip: 'قرّب بعجلة الفأرة أو بإصبعين، واسحب الخلفية للتحريك.',
        targets: [{ sel: '#pCanvas' }],
      },
      {
        h: 'الباب',
        p: 'يمكنك الضغط على الباب وسحبه لتغيير موقعه على الجدار.',
        tip: 'جرّب سحبه الآن — الإضاءة لا تمنع اللمس — ثم تابع «التالي».',
        targets: [
          { rect: 'door' },
          { sel: '#pSteps button[data-step="openings"]', p: 'لا يوجد باب بعد — من خطوة «العناصر المعمارية» بالأعلى أضف بابًا على الجدار، ثم أكمل الجولة.' },
        ],
        until: 'doorMoved',
      },
      {
        h: 'أبعاد الجدران',
        p: 'أرقام الجدران بالمتر: اكتب الطول هنا فيتحدث الرسم فورًا.',
        tip: 'طول الجدار الكامل يختلف عن المسافات الجزئية حول الباب.',
        targets: [{ sel: '#pfW' }, { rect: 'wall' }],
      },
      {
        h: 'المسافات حول الفتحة',
        p: 'الأرقام حول الباب: المسافة قبله، وعرضه، والمسافة بعده — بالمتر والسنتيمتر.',
        tip: 'تتحدث لحظيًا مع تحريك الباب أو تغيير عرضه.',
        targets: [{ rect: 'doorWide', pad: 30 }],
        skipIf: 'door',
      },
      {
        h: 'الأثاث والإكسسوارات',
        p: 'اختر عنصرًا واكتب عدده مباشرة، أو استخدم «فرش الكل» لتوزيع مبدئي ثم عدّل يدويًا.',
        tip: 'المس أي قطعة في الرسم لتعديلها أو حذفها.',
        targets: [
          { sel: '#pPanel [data-acc]' },
          { sel: '#pfFillMajlis' },
          { sel: '#pSteps button[data-step="furn"]', p: 'انتقل إلى خطوة «الأثاث والإكسسوارات» من الأعلى.' },
        ],
      },
      {
        h: 'المراجعة والإرسال',
        p: 'راجع تصميمك كاملًا، ثم اضغط «إنهاء التصميم» لتحصل على رقم طلبك.',
        tip: 'يمكنك إضافة بياناتك (الاسم والجوال) ليوصلك المحل أسرع — وهي اختيارية.',
        targets: [
          { sel: '#pSubmitDesign' },
          { sel: '#pSteps button[data-step="review"]', p: 'انتقل إلى خطوة «المراجعة» من الأعلى.' },
        ],
      },
      {
        h: 'انتهى الشرح 🎉',
        p: 'الآن أنت جاهز. إذا نسيت خطوة، افتح «الدليل» من زر المساعدة في أي وقت.',
        tip: null,
      },
    ],
  };

  /* ======================================================================
     المحتوى: الموظف
     مبني على القوائم الفعلية في index.html + صلاحيات canSeeCosts/canEditOrder
     ====================================================================== */
  const STAFF = {
    role: 'staff',
    title: 'دليل الموظف',
    intro: 'كيف تسجّل طلباً وتُديره وتتابّع حالته.',
    steps: [
      {
        h: 'أهلًا بك 👋',
        p: 'من الشريط الجانبي تبدأ الطلب الحالي، ثم «جميع الطلبات» و«العملاء». تتبّع المراحل من أعلى الصفحة باستخدام الخطوة الحالية.',
        tip: 'اختصارات: استخدم Buttons داخل تفاصيل الطلب للوصول السريع.',
      },
      {
        h: 'تسجيل طلب جديد',
        p: 'في «الطلب الحالي» أدخل بيانات العميل والجوال والعنوان، ثم اختر الأصناف وأضف الكميات. المبالغ تُحسب تلقائيًا.',
        tip: 'كل طلب جديد يأخذ رقمه تلقائيًا — لا تحتاج لكتابة الرقم.',
      },
      {
        h: 'المتابعة والتعديل',
        p: 'من «جميع الطلبات» افتح أي طلب لتعديل بياناته أو تغيير حالته (جديد ← قيد التنفيذ ← منجز ← تم التسليم).',
        tip: 'يمكنك تعديل الطلبات التي أنشأتها أنت. طلبات الزملاء تظهر للقراءة فقط، وللمدير وحده حق فتحها.',
      },
      {
        h: 'حالات الطلب',
        p: 'الطلب يسير بين الحالات: مسودة عرض، جديد، قيد التنفيذ، منجز، تم التسليم، أو ملغي.',
        tip: 'الحالة «تم التسليم» هي التي تُحتسب ضمن المبيعات والتقارير.',
      },
      {
        h: 'المدفوعات والتكلفة',
        p: 'سجّل الدفعات والدفع السريع أسفل تفاصيل الطلب، وأدخل التكاليف لحساب صافي الربح.',
        tip: 'التكلفة والأرباح تظهر للمدير فقط، وكل عملية تُسجَّل في «سجل التحديثات» باسم من قام بها.',
      },
      {
        h: 'ما تظهره لك الصلاحيات',
        p: 'التكلفة والأرباح والتقارير والإعدادات تظهر للمدير فقط. كل موظف يرى ما أنشأه، والمندوب يرى طلباته المسندة إليه.',
        tip: 'إن احتجت صلاحية أكثر تواصل مع مدير النظام.',
      },
      {
        h: 'انتهى الشرح 🎉',
        p: 'كل شيء جاهز. افتح «الدليل» من زر المساعدة متى احتجته.',
        tip: null,
      },
    ],
  };

  /* ======================================================================
     المحتوى: المندوب
     مبني على canEditOrder: الطلب الذي أنشأه هو فقط قابل للتعديل عليه.
     التكلفة والأرباح والتقارير للمدير فقط (canSeeCosts = isAdmin).
     ====================================================================== */
  const MANDOUB = {
    role: 'mandoub',
    title: 'دليل المندوب',
    intro: 'طلباتك المسندة إليك، وإجراءاتك المسموحة.',
    steps: [
      {
        h: 'أهلًا بك 👋',
        p: 'المندوب مكلَّف بمتابعة طلب أو أكثر. مهمتك متابعة التنفيذ والتواصل مع العميل حتى التسليم.',
        tip: 'ستجد طلباتك المسندة إليك في «جميع الطلبات».',
      },
      {
        h: 'معلومات الطلب',
        p: 'اضغط على الطلب لتظهر بياناته: اسم العميل وجواله وعنوانه، الأصناف والكميات، الإجمالي المدفوع، وحالته الحالية.',
        tip: 'راجع حالة التنفيذ مع العميل قبل التسليم.',
      },
      {
        h: 'ما يمكنك تعديله',
        p: 'الطلب الذي أنشأته أنت قابل للتعديل والتحديث من طرفك، بما فيه تغيير حالته عند تقدّم العمل.',
        tip: 'إن كان الطلب أسنده إليك شخص آخر، فستظهر للقراءة فقط — راجعه مع مدير النظام لأي تعديل.',
      },
      {
        h: 'ما لا يظهر لك',
        p: 'التكاليف والأرباح والتقارير المالية وإدارة الأصناف والمستخدمين فهي للمدير وحده.',
        tip: 'إن احتجت تعديل بيانات الطلب من غيرك، اطلبه من مدير النظام.',
      },
      {
        h: 'نسبتك',
        p: 'لكل مندوب نسبة عمولة على مبيعات طلباته، ويراها المدير في ملفك ضمن «إدارة المناديب».',
        tip: 'التقارير الكاملة متاحة للمدير في «ذكاء الأعمال».',
      },
      {
        h: 'انتهى الشرح 🎉',
        p: 'ابدأ بمراجعة طلباتك المسندة إليك. افتح «الدليل» من زر المساعدة عند الحاجة.',
        tip: null,
      },
    ],
  };

  /* تسجيل نسخة تجريبية مختصرة من دليل العميل (تشرح بنفس الخطوات مع فروق الواجهة) */
  const CUSTOMER_EXP = {
    role: 'customer_exp',
    title: 'دليل التصميم الموسّع',
    intro: 'نسخة تجريبية من المصمم بخطوات مطابقة.',
    steps: CUSTOMER.steps,
  };

  const CONTENT = {
    customer: CUSTOMER,
    customer_exp: CUSTOMER_EXP,
    staff: STAFF,
    mandoub: MANDOUB,
  };

  /* ======================================================================
     هندسة التموضع — دوال خالصة بلا DOM (تُختبر في Node):
     - clampN: حصر رقم في مجال
     - spotLanes: شرائط التعتيم الأربع حول فتحة r داخل شاشة vw×vh
     - placeCard: موضع البطاقة (تحت الهدف أولاً ثم فوقه ثم بجانبه) محصوراً
       داخل الشاشة، مع جهة السهم side
     ====================================================================== */
  function clampN(v, a, b) { return Math.min(Math.max(v, a), b); }

  function spotLanes(r, vw, vh) {
    const x0 = clampN(r.x, 0, vw), y0 = clampN(r.y, 0, vh);
    const x1 = clampN(r.x + r.w, 0, vw), y1 = clampN(r.y + r.h, 0, vh);
    return {
      top: { x: 0, y: 0, w: vw, h: y0 },
      bottom: { x: 0, y: y1, w: vw, h: Math.max(0, vh - y1) },
      left: { x: 0, y: y0, w: x0, h: Math.max(0, y1 - y0) },
      right: { x: x1, y: y0, w: Math.max(0, vw - x1), h: Math.max(0, y1 - y0) },
    };
  }

  function placeCard(r, vw, vh, cw, ch) {
    const m = 10, gap = 12;
    const cx = clampN(r.x + r.w / 2 - cw / 2, m, Math.max(m, vw - cw - m));
    const midY = clampN(r.y + r.h / 2 - ch / 2, m, Math.max(m, vh - ch - m));
    // تحت الهدف أولاً، ثم فوقه، ثم بجانبه — كلها محصورة داخل الشاشة
    if (r.y + r.h + gap + ch <= vh - m) return { left: cx, top: r.y + r.h + gap, side: 'top' };
    if (r.y - gap - ch >= m) return { left: cx, top: r.y - gap - ch, side: 'bottom' };
    const rightW = vw - (r.x + r.w) - gap, leftW = r.x - gap;
    if (rightW >= cw + m && rightW >= leftW) return { left: r.x + r.w + gap, top: midY, side: 'left' };
    if (leftW >= cw + m) return { left: r.x - gap - cw, top: midY, side: 'right' };
    // لا موضع بلا تداخل (هدف يملأ الشاشة): أقل تداخل ممكن
    const cands = [
      { left: cx, top: clampN(r.y + r.h + gap, m, Math.max(m, vh - ch - m)), side: 'top' },
      { left: cx, top: clampN(r.y - gap - ch, m, Math.max(m, vh - ch - m)), side: 'bottom' },
      { left: clampN(r.x + r.w + gap, m, Math.max(m, vw - cw - m)), top: midY, side: 'left' },
      { left: clampN(r.x - gap - cw, m, Math.max(m, vw - cw - m)), top: midY, side: 'right' },
    ];
    const ov = (p) => {
      const ix = Math.max(0, Math.min(p.left + cw, r.x + r.w) - Math.max(p.left, r.x));
      const iy = Math.max(0, Math.min(p.top + ch, r.y + r.h) - Math.max(p.top, r.y));
      return ix * iy;
    };
    cands.sort((a, b) => ov(a) - ov(b));
    return cands[0];
  }

  /* سياق اختياري يضبطه التطبيق (المصمم الحي) — لا يغيّر شيئاً بدونه */
  const HelpCtx = { designer: null };
  function ctxDesigner() {
    try { return HelpCtx.designer || null; } catch (_) { return null; }
  }

  /* مستطيل عنصر DOM في إحداثيات النافذة مع هامش — null إن غائب/مخفي/صفري */
  function targetRect(el, pad) {
    try {
      if (!el || !el.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return null;
      const p = Math.max(0, pad == null ? 8 : pad);
      return { x: r.left - p, y: r.top - p, w: r.width + p * 2, h: r.height + p * 2 };
    } catch (_) { return null; }
  }

  /* منطقة محسوبة على رسم المصمم (الباب/منتصف أطول جدار) بإحداثيات النافذة.
     kind: 'door' (أول باب وإلا أول مشب) أو 'doorWide' (مع القياسات حوله)
     أو 'wall' (منتصف أطول جدار). null عند أي نقص — لا استثناءات للخارج. */
  function designerRect(dz, kind) {
    try {
      if (!dz || typeof dz.geometry !== 'function') return null;
      const cv = dz.canvas;
      if (!cv || !cv.getBoundingClientRect || !cv.width) return null;
      const g = dz.geometry();
      if (!g || !g.walls || !g.walls.length) return null;
      const v = dz.view;
      if (!v || !v.scale) return null;
      let w, t0, t1, s0, s1;
      if (kind === 'door' || kind === 'doorWide') {
        const ops = (dz.state && dz.state.openings) || [];
        const o = ops.find((x) => x && x.type === 'door') || ops.find((x) => x && x.type === 'mashab') || null;
        if (!o) return null;
        w = g.walls[o.wall];
        if (!w) return null;
        t0 = o.t - o.w / 2; t1 = o.t + o.w / 2;
        s0 = -0.35; s1 = Math.max(1.0, (o.w || 0.9) + 0.35);
        if (kind === 'doorWide') { t0 -= 0.8; t1 += 0.8; s1 += 0.4; }
      } else if (kind === 'wall') {
        w = g.walls.slice().sort((a, b) => b.len - a.len)[0];
        if (!w) return null;
        t0 = w.len * 0.3; t1 = w.len * 0.7; s0 = -0.3; s1 = 0.7;
      } else {
        return null;
      }
      const P = (t, s) => ({ x: w.A.x + w.dir.x * t + w.n.x * s, y: w.A.y + w.dir.y * t + w.n.y * s });
      const cr = cv.getBoundingClientRect();
      const kx = cr.width / cv.width, ky = cr.height / cv.height;
      const toClient = (p) => ({ x: cr.left + (v.ox + p.x * v.scale) * kx, y: cr.top + (v.oy + p.y * v.scale) * ky });
      const pts = [P(t0, s0), P(t1, s0), P(t1, s1), P(t0, s1)].map(toClient);
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const pad = 10;
      const r = {
        x: Math.min.apply(null, xs) - pad, y: Math.min.apply(null, ys) - pad,
        w: Math.max.apply(null, xs) - Math.min.apply(null, xs) + pad * 2,
        h: Math.max.apply(null, ys) - Math.min.apply(null, ys) + pad * 2,
      };
      if (!(r.w >= 4 && r.h >= 4)) return null;
      return r;
    } catch (_) { return null; }
  }

  /* أول باب/مشب في التصميم — لمفتاح until وشروط skipIf */
  function firstOpening(dz) {
    try {
      const ops = (dz && dz.state && dz.state.openings) || [];
      return ops.find((x) => x && (x.type === 'door' || x.type === 'mashab')) || null;
    } catch (_) { return null; }
  }

  /* ======================================================================
     محرك الجولة التفاعلية (Spotlight Tour) — نفس واجهة Tour السابقة تماماً
     (constructor/key/steps/title/onFinish + shouldShow/markSeen/open/next/
     prev/finish) فيعمل كل استدعاء قديم بلا تعديل، لكن العرض صار:
     تعتيم كامل للشاشة مع فتحة حقيقية فوق العنصر (اللمس يمرّ منها فيبقى
     الباب قابلاً للسحب أثناء الشرح)، وإطار مضيء، وبطاقة بسهم لا تخرج عن
     الشاشة. الخطوة بلا هدف صالح تُعرض في المنتصف — لا تُحذف ولا تُعطَّل.
     ====================================================================== */
  class Tour {
    constructor(opts) {
      this.key = opts.key;              // مفتاح التفضيل الفريد
      this.steps = opts.steps || [];
      this.title = opts.title || '';
      this.onFinish = opts.onFinish || null;
      this.i = 0;
      this.el = null;
      this._rect = null;                // فتحة الإضاءة الحالية (إحداثيات نافذة)
      this._untilTimer = null;
      this._untilDone = false;
      this._doorKey = null;
      this._rzT = 0;
      this._onKey = null;
      this._onResize = null;
    }

    shouldShow() {
      // نعرض مرة واحدة فقط لكل مفتاح؛ الاختيار «عدم الإظهار» أو «تخطي» يوقفها
      return LS.get('mj_help_seen_' + this.key) !== '1';
    }

    markSeen() { LS.set('mj_help_seen_' + this.key, '1'); }

    /* حلّ هدف الخطوة: أول مرشح صالح (عنصر ثم منطقة رسم). تُعيد
       {rect, p} أو {rect:null, p} (بطاقة م centered) أو null (تجاوز). */
    resolveTarget(step) {
      const dz = ctxDesigner();
      if (step.skipIf === 'door' && !firstOpening(dz)) return null;
      const targets = step.targets || (step.sel ? [{ sel: step.sel }] : []);
      for (const tg of targets) {
        if (tg.sel) {
          const sels = Array.isArray(tg.sel) ? tg.sel : [tg.sel];
          for (const s of sels) {
            let el = null;
            try { el = document.querySelector(s); } catch (_) { el = null; }
            if (!el) continue;
            let vis = false;
            try {
              const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
              vis = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden') : true;
            } catch (_) { vis = true; }
            const r = vis ? targetRect(el, tg.pad) : null;
            if (r) return { rect: r, p: tg.p || null, el };
          }
        }
        if (tg.rect) {
          const r = designerRect(dz, tg.rect);
          if (r) {
            const pad = tg.pad || 0;
            return {
              rect: pad ? { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 } : r,
              p: tg.p || null, el: null,
            };
          }
        }
      }
      return { rect: null, p: null, el: null };
    }

    /** نافذة الشرح: عنصر واحد مشترك في الصفحة يُعاد استخدامه لكل مفتاح،
        فلا تتراكم النوافذ في DOM عند إعادة التشغيل أو تبديل الدور. */
    build() {
      if (this.el) return this.el;
      const wrap = Tour.sharedEl || (Tour.sharedEl = document.createElement('div'));
      wrap.className = 'hj-tour';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', this.title || 'شرح');
      if (!wrap.dataset.hjBuilt) {
        wrap.innerHTML = [
          '<div class="hj-dim" data-dim="top"></div>',
          '<div class="hj-dim" data-dim="bottom"></div>',
          '<div class="hj-dim" data-dim="left"></div>',
          '<div class="hj-dim" data-dim="right"></div>',
          '<div class="hj-ring" hidden></div>',
          '<div class="hj-tour-card" data-side="center">',
          '  <div class="hj-tour-head">',
          '    <span class="hj-dots" aria-hidden="true"></span>',
          '    <span class="hj-count" aria-hidden="true"></span>',
          '    <button type="button" class="hj-x" data-hj="close" aria-label="إغلاق الشرح">×</button>',
          '  </div>',
          '  <div class="hj-tour-body"></div>',
          '  <div class="hj-tour-foot">',
          '    <button type="button" class="hj-btn hj-ghost" data-hj="done">إنهاء الشرح</button>',
          '    <div class="hj-nav">',
          '      <button type="button" class="hj-btn hj-ghost" data-hj="prev">السابق</button>',
          '      <button type="button" class="hj-btn hj-primary" data-hj="next">التالي</button>',
          '    </div>',
          '  </div>',
          '  <label class="hj-nofilter"><input type="checkbox" data-hj="nofilter"> عدم الإظهار مجددًا</label>',
          '</div>',
        ].join('');
        document.body.appendChild(wrap);

        wrap.addEventListener('click', (e) => {
          const active = Tour.active;
          if (!active) return;
          const b = e.target.closest('[data-hj]');
          if (!b) {
            if (e.target.closest && e.target.closest('.hj-dim')) { active.finish(false); return; }
            return;
          }
          const a = b.getAttribute('data-hj');
          if (a === 'next') active.next();
          else if (a === 'prev') active.prev();
          else if (a === 'done' || a === 'close') active.finish(false);
        });
        wrap.dataset.hjBuilt = '1';
      }
      Tour.active = this;
      this.el = wrap;
      return wrap;
    }

    noFilter() {
      const c = this.el && this.el.querySelector('[data-hj="nofilter"]');
      return !!(c && c.checked);
    }

    /* لقطة معرّف موضع الباب لخطوة التفاعل (until) */
    snapDoor() {
      try {
        const o = firstOpening(ctxDesigner());
        this._doorKey = o ? (o.id + ':' + o.t) : null;
      } catch (_) { this._doorKey = null; }
    }

    doorMoved() {
      try {
        if (!this._doorKey) return true;
        const o = firstOpening(ctxDesigner());
        if (!o) return true;
        return (o.id + ':' + o.t) !== this._doorKey;
      } catch (_) { return true; }
    }

    armUntil(step) {
      this.disarmUntil();
      this._untilDone = false;
      if (!step || step.until !== 'doorMoved') return;
      this.snapDoor();
      if (!this._doorKey) { this._untilDone = true; this.paintTick(); return; }
      this._untilTimer = setInterval(() => {
        try {
          if (this.doorMoved()) {
            this._untilDone = true;
            this.disarmUntil();
            this.paintTick();
          }
        } catch (_) { /* تجاهل — التالي متاح دائماً */ }
      }, 450);
    }

    disarmUntil() {
      if (this._untilTimer) { try { clearInterval(this._untilTimer); } catch (_) {} }
      this._untilTimer = null;
    }

    paintTick() {
      try {
        const t = this.el && this.el.querySelector('.hj-done-tick');
        if (t) t.hidden = !this._untilDone;
      } catch (_) {}
    }

    /* الانتقال باتجاه مع تجاوز الخطوات غير القابلة للحل (ذات skipIf) */
    advance(dir) {
      let j = this.i + dir;
      while (j >= 0 && j < this.steps.length) {
        const r = this.resolveTarget(this.steps[j]);
        if (r !== null) { this.show(j); return; }
        j += dir;
      }
      this.finish(false);
    }

    render() {
      const step = this.steps[this.i];
      const body = $('.hj-tour-body', this.el);
      body.innerHTML =
        '<h3 class="hj-h">' + esc(step.h) + '</h3>' +
        '<p class="hj-p">' + esc(this._body || step.p) + '</p>' +
        (step.tip ? '<p class="hj-tip">💡 ' + esc(step.tip) + '</p>' : '') +
        (step.until ? '<p class="hj-done-tick" hidden>✓ تم! تابع «التالي».</p>' : '');

      // نقاط التقدم + العدّاد
      const dots = $('.hj-dots', this.el);
      dots.innerHTML = this.steps.map((_, idx) =>
        '<i class="' + (idx === this.i ? 'on' : '') + '"></i>').join('');
      const count = $('.hj-count', this.el);
      if (count) count.textContent = (this.i + 1) + ' من ' + this.steps.length;

      // أزرار التنقل حسب الموضع
      const isLast = this.i === this.steps.length - 1;
      $('[data-hj="prev"]', this.el).disabled = this.i === 0;
      $('[data-hj="next"]', this.el).textContent = isLast ? 'تم' : 'التالي';
      this.paintTick();
    }

    /* تموضع الطبقة والبطاقة على الفتحة الحالية — آمن دائماً (try/catch)
       فلا يعطّل الصفحة مهما حدث. */
    layout() {
      try {
        const wrap = this.el;
        if (!wrap) return;
        const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
        const dims = wrap.querySelectorAll('.hj-dim');
        const ring = wrap.querySelector('.hj-ring');
        const card = wrap.querySelector('.hj-tour-card');
        const r = this._rect;
        if (!r || vw < 2 || vh < 2) {
          // بلا هدف: شريط واحد يغطي الشاشة (لا تكديس للشفافية)
          dims.forEach((d) => {
            if (d.dataset.dim === 'top') {
              d.style.display = '';
              d.style.cssText = 'left:0;top:0;width:100%;height:100%;';
            } else {
              d.style.display = 'none';
            }
          });
          if (ring) ring.hidden = true;
          if (card) {
            card.dataset.side = 'center';
            card.style.left = '';
            card.style.top = '';
          }
          return;
        }
        const L = spotLanes(r, vw, vh);
        const set = (name, q) => {
          const d = wrap.querySelector('.hj-dim[data-dim="' + name + '"]');
          if (d) {
            d.style.display = '';
            d.style.cssText = 'left:' + q.x + 'px;top:' + q.y + 'px;width:' + q.w + 'px;height:' + q.h + 'px;';
          }
        };
        set('top', L.top); set('bottom', L.bottom); set('left', L.left); set('right', L.right);
        if (ring) {
          ring.hidden = false;
          ring.style.cssText = 'left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px;';
        }
        if (card) {
          card.dataset.side = 'center';
          card.style.visibility = 'hidden';
          card.style.left = '0px';
          card.style.top = '0px';
          card.style.right = '';
          card.style.bottom = '';
          card.style.width = '';
          // الشاشات الضيقة: ورقة سفلية بعرض الشاشة (بلا تمرير أفقي ولا قصّ)
          if (vw <= 640) {
            card.style.visibility = '';
            card.dataset.side = 'sheet';
            card.style.left = '8px';
            card.style.right = '8px';
            card.style.top = 'auto';
            card.style.bottom = '8px';
            card.style.width = 'auto';
            return;
          }
          const cw = Math.min(card.offsetWidth || 320, vw - 16);
          const ch = Math.min(card.offsetHeight || 200, vh - 16);
          card.style.visibility = '';
          const pos = placeCard(r, vw, vh, Math.min(cw, vw - 16), Math.min(ch, vh - 16));
          card.dataset.side = pos.side;
          card.style.left = pos.left + 'px';
          card.style.top = pos.top + 'px';
        }
      } catch (_) { /* التموضع لا يعطّل الصفحة أبداً */ }
    }

    show(i) {
      this.disarmUntil();
      this.i = i;
      const step = this.steps[this.i];
      const tg = this.resolveTarget(step);
      this._rect = tg && tg.rect ? tg.rect : null;
      this._body = (tg && tg.p) || null;
      // مرّر العنصر إلى منتصف الشاشة قبل القياس (بلا حركة ناعمة لضمان الاستقرار)
      try {
        const dz = ctxDesigner();
        if (tg && tg.el && tg.el.scrollIntoView) tg.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        else if (this._rect && dz && dz.canvas && dz.canvas.scrollIntoView) dz.canvas.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      } catch (_) {}
      this.build();
      this.el.classList.add('show');
      document.documentElement.classList.add('hj-lock');
      // إعادة ضبط خانة «عدم الإظهار» عند كل عرض جديد
      const nf = this.el.querySelector('[data-hj="nofilter"]');
      if (nf) nf.checked = false;
      Tour.active = this;
      this.render();
      // تموضع فوري متزامن (لا يعتمد على rAF وحده — قد لا تُطلق إطارات الرسم
      // في الخلفيات وheadless)، ثم تمريرة تثبيت بعد استقرار التمرير والخطوط
      this.layout();
      const self = this;
      setTimeout(() => { try { if (Tour.active === self) self.layout(); } catch (_) {} }, 60);
      this.armUntil(step);
      const next = this.el.querySelector('[data-hj="next"]');
      if (next) { try { next.focus({ preventScroll: true }); } catch (_) { try { next.focus(); } catch (_) {} } }
    }

    open() {
      if (!this.steps.length) { try { this.markSeen(); } catch (_) {} return; }
      // جولة واحدة فقط في كل مرة: إنهاء أي جولة مفتوحة قبلها (يزيل مستمعيها
      // فلا تتضاعف الاستجابة للوحة المفاتيح ولا تتعارض المؤقتات)
      if (Tour.active && Tour.active !== this) {
        try { Tour.active.finish(false); } catch (_) {}
      }
      this.build();
      this._body = null;
      // ابدأ من أول خطوة قابلة للحل (وإلا بطاقة المنتصف لأول خطوة)
      let j = 0;
      while (j < this.steps.length) {
        if (this.resolveTarget(this.steps[j]) !== null) break;
        j++;
      }
      if (j >= this.steps.length) { this.show(0); return; }
      this.show(j);
      if (!this._onKey) {
        this._onKey = (e) => {
          const active = Tour.active;
          if (!active || !active.el || !active.el.classList.contains('show')) return;
          if (e.key === 'Escape') { active.finish(false); return; }
          // RTL: السهم الأيسر = التالي، الأيمن = السابق
          if (e.key === 'ArrowLeft') { e.preventDefault(); active.next(); return; }
          if (e.key === 'ArrowRight') { e.preventDefault(); active.prev(); return; }
        };
        try { document.addEventListener('keydown', this._onKey); } catch (_) {}
      }
      if (!this._onResize) {
        // خنق بمؤقت لا بإطار رسم (rAF قد لا يُطلق في الخلفيات) — والحركة
        // الناعمة تأتي من انتقال CSS على الحلقة أصلاً
        this._onResize = () => {
          const active = Tour.active;
          if (!active || active._rzT) return;
          active._rzT = setTimeout(() => {
            active._rzT = 0;
            try { if (Tour.active === active) active.layout(); } catch (_) {}
          }, 80);
        };
        try {
          window.addEventListener('resize', this._onResize);
          window.addEventListener('scroll', this._onResize, true);
        } catch (_) {}
      }
    }

    next() {
      if (this.i < this.steps.length - 1) { this.advance(1); }
      else this.finish(false);
    }

    prev() {
      if (this.i > 0) { this.advance(-1); }
    }

    /** إغلاق مع حفظ التفضيل: «إنهاء» و«×» و«تم» كلها تعني أن الشرح تمّت رؤيته،
        فلا يُعاد عرضه تلقائياً. إعادة الشرح ممكنة دائماً عبر زر «إعادة الشرح» في الدليل. */
    finish(skipped) {
      this.disarmUntil();
      this.markSeen();
      try {
        if (this._rzT) { clearTimeout(this._rzT); this._rzT = 0; }
      } catch (_) {}
      try {
        if (this.el) this.el.classList.remove('show');
      } catch (_) {}
      try { document.documentElement.classList.remove('hj-lock'); } catch (_) {}
      try {
        if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
      } catch (_) {}
      const cb = this.onFinish;
      this.onFinish = null;
      Tour.active = null;
      if (cb) { try { cb(true); } catch (_) {} }
    }
  }

  /* ======================================================================
     نافذة الدليل الدائم — كل المحتوى في قائمة أقسام قابلة للتصفح
     ====================================================================== */
  class Manual {
    constructor(key) {
      this.key = key;
      this.cfg = CONTENT[key] || CONTENT.customer;
      this.el = null;
      this.section = 0;
    }

    build() {
      if (this.el) return this.el;
      const wrap = Manual.sharedEl || (Manual.sharedEl = document.createElement('div'));
      wrap.className = 'hj-manual';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      if (!wrap.dataset.hjBuilt) {
        wrap.innerHTML = [
          '<div class="hj-manual-card">',
          '  <div class="hj-tour-head">',
          '    <h3 class="hj-mtitle"></h3>',
          '    <button type="button" class="hj-x" data-hm="close" aria-label="إغلاق الدليل">×</button>',
          '  </div>',
          '  <p class="hj-minro"></p>',
          '  <nav class="hj-tabs" role="tablist" aria-label="أقسام الدليل"></nav>',
          '  <div class="hj-manual-body" role="tabpanel"></div>',
          '  <div class="hj-manual-foot">',
          '    <button type="button" class="hj-btn hj-ghost" data-hm="replay">إعادة الشرح الأول</button>',
          '    <button type="button" class="hj-btn hj-primary" data-hm="close">إغلاق</button>',
          '  </div>',
          '</div>',
        ].join('');
        document.body.appendChild(wrap);

        wrap.addEventListener('click', (e) => {
          const active = Manual.active;
          if (!active) return;
          const b = e.target.closest('[data-hm],[data-hs]');
          if (!b) { if (e.target === wrap) active.close(); return; }
          if (b.hasAttribute('data-hm')) {
            const a = b.getAttribute('data-hm');
            if (a === 'close') active.close();
            else if (a === 'replay') active.replay();
            return;
          }
          if (b.hasAttribute('data-hs')) active.show(+b.getAttribute('data-hs'));
        });
        wrap.dataset.hjBuilt = '1';
      }
      // تحديث المحتوى كل مرة (يتبدّل بتبدّل الدور أو المفتاح)
      wrap.setAttribute('aria-label', this.cfg.title);
      $('.hj-mtitle', wrap).textContent = this.cfg.title;
      $('.hj-minro', wrap).textContent = this.cfg.intro;
      $('.hj-tabs', wrap).innerHTML = this.cfg.steps.map((s, idx) =>
        '<button type="button" role="tab" data-hs="' + idx + '" class="' +
        (idx === 0 ? 'on' : '') + '">' + esc(shortTitle(s.h)) + '</button>').join('');

      Manual.active = this;
      this.el = wrap;
      return wrap;
    }

    show(idx) {
      this.section = idx;
      const s = this.cfg.steps[idx];
      $('.hj-manual-body', this.el).innerHTML =
        '<h4 class="hj-h">' + esc(s.h) + '</h4>' +
        '<p class="hj-p">' + esc(s.p) + '</p>' +
        (s.tip ? '<p class="hj-tip">💡 ' + esc(s.tip) + '</p>' : '');
      this.el.querySelectorAll('[data-hs]').forEach((b) =>
        b.classList.toggle('on', +b.getAttribute('data-hs') === idx));
    }

    open() {
      this.build();
      this.show(0);
      this.el.classList.add('show');
      document.documentElement.classList.add('hj-lock');
    }

    close() {
      this.el.classList.remove('show');
      document.documentElement.classList.remove('hj-lock');
    }

    /** إعادة تشغيل الشرح الأول يدويًا (يبقى التفضيل المحفوظ كما هو) */
    replay() {
      this.close();
      const tour = new Tour({ key: this.key, steps: this.cfg.steps, title: this.cfg.title });
      tour.open();
    }
  }

  function shortTitle(h) {
    return String(h).replace(/^[٠-٩0-9]+\.\s*/, '').replace(/\s*🎉.*$/, '').trim();
  }

  /* ======================================================================
     الواجهة العامة: Help.init — يربط زر الدليل + يشغّل الشرح الأول مرة واحدة
     opts: { key, manualBtn (اختياري), auto (افتراضي true) }
     ====================================================================== */
  function init(opts) {
    opts = opts || {};
    const key = opts.key || 'customer';
    if ('designer' in opts) context({ designer: opts.designer });
    const cfg = CONTENT[key] || CONTENT.customer;
    const manual = new Manual(key);

    // زر فتح الدليل (إن وُجد في الصفحة)
    if (opts.manualBtn) {
      const btn = typeof opts.manualBtn === 'string' ? $(opts.manualBtn) : opts.manualBtn;
      if (btn && !btn.dataset.hjBound) {
        btn.addEventListener('click', (e) => { e.preventDefault(); manual.open(); });
        btn.dataset.hjBound = '1';
      }
    }

    // إعادة تشغيل الشرح يدويًا (من زر «إعادة الشرح» في الدليل مثلًا)
    if (opts.replayBtn) {
      const rb = typeof opts.replayBtn === 'string' ? $(opts.replayBtn) : opts.replayBtn;
      if (rb && !rb.dataset.hjBound) {
        rb.addEventListener('click', () => {
          const tour = new Tour({ key, steps: cfg.steps, title: cfg.title });
          tour.open();
        });
        rb.dataset.hjBound = '1';
      }
    }

    // تشغيل الشرح الأول تلقائيًا (مرة واحدة)
    if (opts.auto !== false) {
      const tour = new Tour({ key, steps: cfg.steps, title: cfg.title });
      // نؤجّل التشغيل حتى يجهز DOM (خصوصًا في صفحات العميل ذات الواجهات المتبدّلة)
      const start = () => { if (tour.shouldShow()) tour.open(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
    }
  }

  function manualOpen(key) { const m = new Manual(key); m.open(); return m; }

  /* سياق اختياري (المصمم الحي) لخطوات المناطق المحسوبة على الرسم.
     يضبطه التطبيق مرة واحدة؛ غيابه يعني بطاقات ممركزة لتلك الخطوات فقط. */
  function context(obj) {
    try {
      if (obj && 'designer' in obj) HelpCtx.designer = obj.designer || null;
    } catch (_) {}
  }

  const API = { init, manualOpen, context, CONTENT, Tour, Manual, version: '1.1' };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.MajlisHelp = API;
})(typeof window !== 'undefined' ? window : this);
