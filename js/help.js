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
     ====================================================================== */
  const CUSTOMER = {
    role: 'customer',
    title: 'دليل مصمم المجالس',
    intro: 'صمّم مجلسك خطوة بخطوة، ثم أرسله للمحل ليصير طلبًا.',
    steps: [
      {
        h: 'أهلًا بك في مصمم المجالس 👋',
        p: 'من هنا تصمّم مجلسك خطوة بخطوة: تُدخل مقاسات الغرفة، تختار نوع المجلس، تضيف الكنب والإكسسوارات، ثم تراجع التصميم وترسله للمحل.',
        tip: 'يمكنك الرجوع لأي خطوة والتعديل قبل الإرسال. لا تحتاج حسابًا.',
      },
      {
        h: '١. الغرفة',
        p: 'اكتب عرض الغرفة وطولها بالمتر — يتغيّر الرسم أمامك مباشرة.',
        tip: 'قِس من الحائط إلى الحائط. تقرب المقاسات تعطي نتيجة أدق.',
      },
      {
        h: '٢. العناصر المعمارية',
        p: 'اختر الجدار أولاً ثم اضف الباب أو المشب (الفتحة الزجاجية) عليه.',
        tip: 'المشب هو الفتحة الكبيرة المعتادة في المجالس العربية.',
      },
      {
        h: '٣. المجلس',
        p: 'اختر نوع الجلسة المناسب لغرفتك (أرضي أو كنب عربي أو مرتفع)، وسيُطبَّق على كل كنبة تضيفها.',
        tip: 'إذا كنت ستخلط أنواعًا مختلفة، أضف كل نوع على حدة بعد تغيير الاختيار.',
      },
      {
        h: '٤. الأثاث والإكسسوارات',
        p: 'أضف الكنب والإكسسوارات، ثم المس أي قطعة لتعديلها أو حذفها.',
        tip: 'يمكنك التكبير والتصغير وسحب القطع داخل الغرفة بحرية.',
      },
      {
        h: '٥. المراجعة والإرسال',
        p: 'شاهد تصميمك كاملًا، ثم اضغط «إنهاء التصميم» لتحصل على رقم طلبك.',
        tip: 'يمكنك إضافة بياناتك (الاسم والجوال) ليوصلك المحل أسرع — وهي اختيارية.',
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
     محرك الشرح (Tour) — نافذة خطوات مع «التالي / السابق / تخطّي / إغلاق»
     ====================================================================== */
  class Tour {
    constructor(opts) {
      this.key = opts.key;              // مفتاح التفضيل الفريد
      this.steps = opts.steps || [];
      this.title = opts.title || '';
      this.onFinish = opts.onFinish || null;
      this.i = 0;
      this.el = null;
    }

    shouldShow() {
      // نعرض مرة واحدة فقط لكل مفتاح؛ الاختيار «عدم الإظهار» أو «تخطي» يوقفها
      return LS.get('mj_help_seen_' + this.key) !== '1';
    }

    markSeen() { LS.set('mj_help_seen_' + this.key, '1'); }

    /** نافذة الشرح: عنصر واحد مشترك في الصفحة يُعاد استخدامه لكل مفتاح،
        فلا تتراكم النوافذ في DOM عند إعادة التشغيل أو تبديل الدور. */
    build() {
      if (this.el) return this.el;
      const wrap = Tour.sharedEl || (Tour.sharedEl = document.createElement('div'));
      wrap.className = 'hj-tour';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      if (!wrap.dataset.hjBuilt) {
        wrap.innerHTML = [
          '<div class="hj-tour-card">',
          '  <div class="hj-tour-head">',
          '    <span class="hj-dots" aria-hidden="true"></span>',
          '    <button type="button" class="hj-x" data-hj="close" aria-label="إغلاق الشرح">×</button>',
          '  </div>',
          '  <div class="hj-tour-body"></div>',
          '  <div class="hj-tour-foot">',
          '    <button type="button" class="hj-btn hj-ghost" data-hj="skip">تخطّي الشرح</button>',
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
          if (!b) { if (e.target === wrap) active.finish(false); return; }
          const a = b.getAttribute('data-hj');
          if (a === 'next') active.next();
          else if (a === 'prev') active.prev();
          else if (a === 'skip' || a === 'close') active.finish(a === 'skip');
        });
        wrap.dataset.hjBuilt = '1';
      }
      wrap.setAttribute('aria-label', this.title || 'شرح');
      // إعادة ضبط خانة «عدم الإظهار» عند كل عرض جديد
      const nf = wrap.querySelector('[data-hj="nofilter"]');
      if (nf) nf.checked = false;
      Tour.active = this;
      this.el = wrap;
      return wrap;
    }

    noFilter() {
      const c = this.el && this.el.querySelector('[data-hj="nofilter"]');
      return !!(c && c.checked);
    }

    render() {
      const s = this.steps[this.i];
      const body = $('.hj-tour-body', this.el);
      body.innerHTML =
        '<h3 class="hj-h">' + esc(s.h) + '</h3>' +
        '<p class="hj-p">' + esc(s.p) + '</p>' +
        (s.tip ? '<p class="hj-tip">💡 ' + esc(s.tip) + '</p>' : '');

      // نقاط التقدم
      const dots = $('.hj-dots', this.el);
      dots.innerHTML = this.steps.map((_, idx) =>
        '<i class="' + (idx === this.i ? 'on' : '') + '"></i>').join('');

      // أزرار التنقل حسب الموضع
      const isLast = this.i === this.steps.length - 1;
      $('[data-hj="prev"]', this.el).disabled = this.i === 0;
      $('[data-hj="next"]', this.el).textContent = isLast ? 'تم' : 'التالي';
    }

    open() {
      this.build();
      this.i = 0;
      this.render();
      this.el.classList.add('show');
      document.documentElement.classList.add('hj-lock');
      const next = this.el.querySelector('[data-hj="next"]');
      if (next) next.focus();
    }

    next() {
      if (this.i < this.steps.length - 1) { this.i++; this.render(); }
      else this.finish(false);
    }

    prev() {
      if (this.i > 0) { this.i--; this.render(); }
    }

    /** إغلاق مع حفظ التفضيل: «تخطّي» و«×» و«تم» كلها تعني أن الشرح تمّت رؤيته،
        فلا يُعاد عرضه تلقائياً. إعادة الشرح ممكنة دائماً عبر زر «إعادة الشرح» في الدليل. */
    finish(skipped) {
      this.markSeen();
      this.el.classList.remove('show');
      document.documentElement.classList.remove('hj-lock');
      if (this.onFinish) this.onFinish(true);
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

  const API = { init, manualOpen, CONTENT, Tour, Manual, version: '1.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.MajlisHelp = API;
})(typeof window !== 'undefined' ? window : this);
