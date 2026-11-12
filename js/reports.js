/* =============================================================================
   محرك التقارير — حسابات نقية بلا DOM (تُختبر في Node وتُستخدم في صفحة «التقارير»).

   Reports.build(id, ctx) → { id, title, subtitle, summary:[{label,value,kind}],
                              tables:[{title, columns:[{key,label,kind}], rows:[{}], totals:{}}],
                              notes:[] }
   kind: 'money' | 'num' | 'pct' | 'date' | 'text'

   ctx (يجهّزه app.js من بيانات المستخدم المرئية له فقط — الخادم يصفّي الطلبات والتكاليف):
     orders, expenses, users            مصفوفات
     from, to                           'YYYY-MM-DD' أو '' (بلا حد)
     userId                             تصفية بمستخدم ('' = الكل)
     status                             '' = الطلبات الفعلية، 'all' = الكل، أو حالة محددة
     today                              'YYYY-MM-DD'
     me, scopeAll                       المستخدم الحالي، وهل يرى تقارير الجميع (reports.view_all)
     perms: { profitAny, commAny, expenses, profit(o), comm(o) }
     calc:  { revenue(o), cost(o)→number|null, breakdown(o)→{profit, base, rows:[{kind,userId,who,rate,amount}]}|null,
              ordDate(o), payDay(p), expDay(e),
              commBase: 'profit' | 'total' }   أساس احتساب النسب (صافي الربح أو الإجمالي شامل الضريبة)
     labels:{ STATUS, PAY_METHOD, ROLES }
     userName(id, fallback), userRole(id)
   ============================================================================= */
(function (root) {
  'use strict';

  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const money = (v) => Math.round((num(v) + 1e-9) * 100) / 100;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);
  const isSale = (o) => !!o && o.status !== 'cancelled' && o.status !== 'quote';
  /* «يشمل التقرير»: ctx.include = { statuses: ['progress','done','delivered'], paidOnly: false }
     يحدد أي الطلبات تُحسب مبيعاتٍ وأرباحاً وعمولات (افتراضياً بلا «جديد» لأنه لم يبدأ بعد).
     عروض الأسعار والملغاة خارج المبيعات دائماً. بلا ctx.include ← السلوك القديم (كل طلب فعلي). */
  const INCLUDE_STATUSES = ['new', 'progress', 'done', 'delivered'];
  const DEFAULT_INCLUDE = { statuses: ['progress', 'done', 'delivered'], paidOnly: false };
  const fullyPaid = (o) => money(num(o.total) - num(o.paid)) <= 0.004;
  const counted = (ctx, o, ignorePaid) => {
    if (!isSale(o)) return false;
    const inc = ctx.include;
    if (!inc) return true;
    if (Array.isArray(inc.statuses) && inc.statuses.indexOf(o.status) < 0) return false;
    if (inc.paidOnly && !ignorePaid && !fullyPaid(o)) return false;
    return true;
  };
  /** وصف ما يشمله التقرير بالعربية (للملاحظات ورأس PDF) */
  function includeText(ctx) {
    const inc = ctx.include;
    if (!inc) return 'كل الطلبات الفعلية';
    const L = (ctx.labels && ctx.labels.STATUS) || {};
    const st = INCLUDE_STATUSES.filter((k) => (inc.statuses || []).indexOf(k) >= 0).map((k) => L[k] || k);
    return (st.length ? st.join('، ') : 'لا حالات') + (inc.paidOnly ? ' — المدفوعة بالكامل فقط' : '');
  }
  const inRange = (d, from, to) => !!d && (!from || d >= from) && (!to || d <= to);
  const daysBetween = (a, b) => {
    const pa = Date.parse(a + 'T00:00:00Z'), pb = Date.parse(b + 'T00:00:00Z');
    return Number.isFinite(pa) && Number.isFinite(pb) ? Math.round((pa - pb) / 86400000) : null;
  };
  const sum = (arr, f) => money(arr.reduce((s, x) => s + num(f(x)), 0));
  const col = (key, label, kind = 'text') => ({ key, label, kind });
  const byTotal = (ctx) => !!(ctx.calc && ctx.calc.commBase === 'total');
  const baseLabel = (ctx) => (byTotal(ctx) ? 'الإجمالي شامل الضريبة' : 'صافي الربح');

  /* ---------------- الطلبات ضمن الفترة والنطاق ---------------- */
  function scopedOrders(ctx, { byDate = true, statusMode = 'filter' } = {}) {
    let list = (ctx.orders || []).filter((o) => o && o.createdAt);
    if (!ctx.scopeAll) list = list.filter((o) => o.createdBy === ctx.me);
    if (byDate) list = list.filter((o) => inRange(ctx.calc.ordDate(o), ctx.from, ctx.to));
    if (statusMode === 'filter') {
      const st = ctx.status || '';
      if (st === '') list = list.filter((o) => counted(ctx, o));
      else if (st !== 'all') list = list.filter((o) => o.status === st);
    } else if (statusMode === 'sales') list = list.filter((o) => counted(ctx, o));
    else if (statusMode === 'salesStatus') list = list.filter((o) => counted(ctx, o, true));   // المديونيات: «المدفوعة بالكامل» لا معنى له هنا
    return list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  const byUser = (ctx, list) => (ctx.userId ? list.filter((o) => o.createdBy === ctx.userId) : list);

  /** أرقام طلب واحد — الربح والعمولات تظهر فقط لمن يملك صلاحيتها على هذا الطلب */
  function orderFigures(ctx, o) {
    const revenue = money(ctx.calc.revenue(o));
    const total = money(o.total);
    const paid = money(o.paid);
    const canProfit = !!(ctx.perms.profit && ctx.perms.profit(o));
    const canComm = !!(ctx.perms.comm && ctx.perms.comm(o));
    // التكلفة تُحسب داخلياً لمن يرى الربح أو العمولة (العمولة تُشتق من الربح)،
    // لكن الربح والتكلفة لا يُعرضان إلا لمن يملك صلاحية الربح على هذا الطلب.
    const rawCost = (canProfit || canComm) ? ctx.calc.cost(o) : null;
    const hasCost = rawCost !== null && rawCost !== undefined;
    const rawProfit = hasCost ? money(revenue - rawCost) : null;
    const profit = canProfit ? rawProfit : null;
    // العمولة تحتاج الربح إن كان أساسها صافي الربح؛ وأساس «الإجمالي» لا يحتاج تكاليف
    const bd = (canComm && (rawProfit !== null || byTotal(ctx))) ? ctx.calc.breakdown(o) : null;
    const part = (k) => (bd ? money(bd.rows.filter((r) => r.kind === k).reduce((s, r) => s + num(r.amount), 0)) : null);
    const ownerComm = part('owner'), parentComm = part('parent'), share = part('share');
    return {
      revenue, total, paid, vat: money(total - revenue), discount: money(o.discount),
      remaining: money(total - paid), hasCost,
      cost: canProfit && hasCost ? money(rawCost) : null,
      profit, margin: profit === null ? null : pct(profit, revenue),
      ownerComm, parentComm, share, bd,
      afterComm: (profit !== null && bd) ? money(profit - ownerComm - parentComm - share) : null,
    };
  }

  function periodText(ctx) {
    return `من ${ctx.from || 'أول سجل'} إلى ${ctx.to || ctx.today || 'اليوم'}`;
  }

  /* ============================ التقارير ============================ */
  const R = {};

  /* 1) تفصيل الطلبات */
  R.orders = {
    title: 'تفصيل الطلبات',
    desc: 'كل طلب ببياناته: الموظف أو المندوب، البيع، التكاليف، صافي الربح، العمولات، والتحصيل',
    usesStatus: true, usesInclude: true,
    build(ctx) {
      const list = byUser(ctx, scopedOrders(ctx));
      const L = ctx.labels;
      const showP = !!ctx.perms.profitAny, showC = !!ctx.perms.commAny;
      const rows = list.map((o) => {
        const f = orderFigures(ctx, o);
        const c = o.customer || {};
        const role = ctx.userRole(o.createdBy);
        const parent = f.bd && f.bd.rows.find((r) => r.kind === 'parent');
        return {
          number: o.number != null ? '#' + o.number : '—', date: ctx.calc.ordDate(o), customer: c.name || '—', phone: c.phone || '',
          status: L.STATUS[o.status] || o.status || '', by: ctx.userName(o.createdBy, o.createdByName), role: L.ROLES[role] || '',
          parent: parent ? parent.who : '',
          revenue: f.revenue, discount: f.discount, vat: f.vat, total: f.total,
          cost: f.cost, profit: f.profit, margin: f.margin,
          ownerComm: f.ownerComm, parentComm: f.parentComm, share: f.share, afterComm: f.afterComm,
          paid: f.paid, remaining: f.remaining, _sale: counted(ctx, o),
        };
      });
      const columns = [col('number', 'رقم الطلب'), col('date', 'التاريخ', 'date'), col('customer', 'العميل'), col('phone', 'الجوال'),
        col('status', 'الحالة'), col('by', 'الموظف / المندوب'), col('role', 'الدور')];
      if (showC) columns.push(col('parent', 'المندوب الأعلى'));
      columns.push(col('revenue', 'البيع قبل الضريبة', 'money'), col('discount', 'الخصم', 'money'), col('vat', 'الضريبة', 'money'), col('total', 'الإجمالي', 'money'));
      if (showP) columns.push(col('cost', 'التكاليف', 'money'), col('profit', 'صافي الربح', 'money'), col('margin', 'الهامش ٪', 'pct'));
      if (showC) columns.push(col('ownerComm', 'عمولة صاحب الطلب', 'money'), col('parentComm', 'عمولة المندوب الأعلى', 'money'), col('share', 'حصة موظفي المحل', 'money'));
      if (showP && showC) columns.push(col('afterComm', 'الربح بعد العمولات', 'money'));
      columns.push(col('paid', 'المحصّل', 'money'), col('remaining', 'المتبقي', 'money'));

      const sales = rows.filter((r) => r._sale);
      const tot = {};
      ['revenue', 'discount', 'vat', 'total', 'cost', 'profit', 'ownerComm', 'parentComm', 'share', 'afterComm', 'paid', 'remaining']
        .forEach((k) => { const v = sales.filter((r) => r[k] !== null && r[k] !== undefined); tot[k] = v.length ? sum(v, (r) => r[k]) : null; });
      const costedRev = sum(sales.filter((r) => r.profit !== null), (r) => r.revenue);
      tot.margin = tot.profit !== null ? pct(tot.profit, costedRev) : null;
      tot.number = 'الإجمالي'; tot.customer = `${sales.length} طلب فعلي`;

      const summary = [
        { label: 'عدد الطلبات', value: rows.length, kind: 'num' },
        { label: 'المبيعات قبل الضريبة', value: tot.revenue || 0, kind: 'money' },
        { label: 'الإجمالي شامل الضريبة', value: tot.total || 0, kind: 'money' },
      ];
      if (showP) summary.push({ label: 'التكاليف', value: tot.cost || 0, kind: 'money' }, { label: 'صافي الربح', value: tot.profit || 0, kind: 'money' });
      if (showC) summary.push({ label: 'إجمالي العمولات والحصص', value: money((tot.ownerComm || 0) + (tot.parentComm || 0) + (tot.share || 0)), kind: 'money' });
      summary.push({ label: 'المحصّل', value: tot.paid || 0, kind: 'money' }, { label: 'المتبقي على العملاء', value: tot.remaining || 0, kind: 'money' });
      const notes = ['المبالغ الإجمالية تشمل: ' + includeText(ctx) + ' (بلا عروض الأسعار والملغاة).'];
      const noCost = sales.filter((r) => showP && r.profit === null).length;
      if (noCost) notes.push(byTotal(ctx) ? `${noCost} طلب بلا تكاليف مُدخلة: لا يُحسب له ربح (العمولة محسوبة من الإجمالي شامل الضريبة).` : `${noCost} طلب بلا تكاليف مُدخلة: لا يُحسب له ربح ولا عمولة.`);
      return { summary, tables: [{ title: 'الطلبات', columns, rows, totals: tot }], notes };
    },
  };

  /* 1ب) الطلبات الجديدة: لم يبدأ تنفيذها بعد — مبيعات قادمة لا محقّقة (خارج «يشمل التقرير») */
  R.pending = {
    title: 'الطلبات الجديدة',
    desc: 'طلبات لم يبدأ تنفيذها بعد: قيمتها والعربون المدفوع ومنذ متى تنتظر — مبيعات قادمة لا تدخل في الأرباح',
    build(ctx) {
      const list = byUser(ctx, scopedOrders(ctx, { statusMode: 'none' })).filter((o) => o.status === 'new');
      const rows = list.map((o) => {
        const f = orderFigures(ctx, o); const c = o.customer || {}; const d = ctx.calc.ordDate(o);
        return { number: o.number != null ? '#' + o.number : '—', date: d, customer: c.name || '—', phone: c.phone || '', by: ctx.userName(o.createdBy, o.createdByName), total: f.total, paid: f.paid, remaining: f.remaining, age: daysBetween(ctx.today, d) };
      }).sort((a, b) => (b.age || 0) - (a.age || 0));
      const tot = { number: 'الإجمالي', customer: rows.length + ' طلب', total: sum(rows, (r) => r.total), paid: sum(rows, (r) => r.paid), remaining: sum(rows, (r) => r.remaining) };
      const oldest = rows.reduce((m, r) => Math.max(m, r.age || 0), 0);
      return {
        summary: [
          { label: 'عدد الطلبات الجديدة', value: rows.length, kind: 'num' },
          { label: 'القيمة المتوقعة', value: tot.total, kind: 'money' },
          { label: 'العربون المحصّل', value: tot.paid, kind: 'money' },
          { label: 'المتبقي عند التنفيذ', value: tot.remaining, kind: 'money' },
          { label: 'أقدم طلب ينتظر (يوم)', value: rows.length ? oldest : null, kind: 'num' },
        ],
        notes: ['هذه الطلبات لم يبدأ تنفيذها بعد، فلا تُحسب في المبيعات والأرباح والعمولات إلا إذا اخترت «جديد» في «يشمل التقرير».', 'الأقدم أولاً: الطلب الذي ينتظر طويلاً يحتاج متابعة مع العميل.'],
        tables: [{ title: 'الطلبات الجديدة', columns: [col('number', 'رقم الطلب'), col('date', 'تاريخ الطلب', 'date'), col('customer', 'العميل'), col('phone', 'الجوال'), col('by', 'الموظف / المندوب'), col('total', 'الإجمالي', 'money'), col('paid', 'العربون المدفوع', 'money'), col('remaining', 'المتبقي', 'money'), col('age', 'ينتظر منذ (يوم)', 'num')], rows, totals: tot }],
      };
    },
  };

  /* 2) العمولات */
  R.commissions = {
    title: 'عمولات الموظفين والمناديب',
    desc: 'مستحقات كل موظف ومندوب: عمولة طلباته، وعمولته من طلبات تابعيه، وحصة المشاركة',
    need: (ctx) => ctx.perms.commAny, usesInclude: true,
    build(ctx) {
      const list = scopedOrders(ctx, { statusMode: 'sales' });
      const people = new Map();
      const person = (id, name) => {
        const k = id || 'none';
        if (!people.has(k)) people.set(k, { id: k, name: name || ctx.userName(id, 'غير محدد'), role: ctx.labels.ROLES[ctx.userRole(id)] || '', orders: 0, revenue: 0, profit: 0, base: 0, ownComm: 0, subsComm: 0, share: 0 });
        return people.get(k);
      };
      const detail = [];
      let sharePool = 0, uncosted = 0;
      for (const o of list) {
        const f = orderFigures(ctx, o);
        const owner = person(o.createdBy, ctx.userName(o.createdBy, o.createdByName));
        owner.orders++; owner.revenue += f.revenue;
        if (!f.bd) { if (ctx.perms.comm(o) && !f.hasCost) uncosted++; continue; }
        if (f.profit !== null) owner.profit += f.profit;
        const bAmt = f.bd.base !== undefined && f.bd.base !== null ? money(f.bd.base) : f.profit;
        owner.base += num(bAmt);
        const base = { number: o.number != null ? '#' + o.number : '—', date: ctx.calc.ordDate(o), customer: (o.customer || {}).name || '—', profit: f.profit, base: bAmt };
        for (const r of f.bd.rows) {
          if (r.kind === 'owner') { owner.ownComm += num(r.amount); detail.push({ ...base, _uid: owner.id, who: owner.name, type: 'عمولة طلبه', rate: num(r.rate), src: r.src || '', amount: money(r.amount) }); }
          else if (r.kind === 'parent') { const p = person(r.userId, r.who); p.subsComm += num(r.amount); detail.push({ ...base, _uid: p.id, who: p.name, type: 'عمولة من طلب تابع', rate: num(r.rate), src: r.src || '', amount: money(r.amount) }); }
          else if (r.kind === 'share') { sharePool += num(r.amount); detail.push({ ...base, _uid: null, who: 'موظفو المحل', type: 'حصة المشاركة', rate: num(r.rate), src: r.src || '', amount: money(r.amount) }); }
        }
      }
      // حصة المشاركة تُقسم بالتساوي على موظفي المحل النشطين (موظف/مدير) — نفس قاعدة «ذكاء الأعمال»
      const internal = (ctx.users || []).filter((u) => u.active !== false && (u.role === 'staff' || u.role === 'admin'));
      const perShare = internal.length ? money(sharePool / internal.length) : 0;
      if (ctx.scopeAll) internal.forEach((u) => { person(u.id, u.name).share = perShare; });
      else if (internal.some((u) => u.id === ctx.me)) person(ctx.me).share = perShare;
      let rows = [...people.values()].map((p) => ({
        name: p.name, role: p.role, orders: p.orders, revenue: money(p.revenue), profit: money(p.profit), base: money(p.base),
        // نسبة عمولة طلباته: هي نسبته إن كانت واحدة، ومتوسطها المرجّح بالمبالغ إن اختلفت بين الطلبات
        rate: p.base ? pct(p.ownComm, p.base) : null,
        ownComm: money(p.ownComm), subsComm: money(p.subsComm), share: money(p.share),
        total: money(p.ownComm + p.subsComm + p.share), _id: p.id,
      }));
      if (!ctx.scopeAll) rows = rows.filter((r) => r._id === ctx.me);
      if (ctx.userId) rows = rows.filter((r) => r._id === ctx.userId);
      rows = rows.filter((r) => r.orders || r.total).sort((a, b) => b.total - a.total);
      const keepIds = new Set(rows.map((r) => r._id));
      const det = (ctx.userId || !ctx.scopeAll) ? detail.filter((d) => d._uid && keepIds.has(d._uid)) : detail;
      const tot = { name: 'الإجمالي' };
      ['orders', 'revenue', 'profit', 'base', 'ownComm', 'subsComm', 'share', 'total'].forEach((k) => { tot[k] = k === 'orders' ? rows.reduce((s, r) => s + r[k], 0) : sum(rows, (r) => r[k]); });
      tot.rate = tot.base ? pct(tot.ownComm, tot.base) : null;
      const summary = [
        { label: 'عمولات الطلبات', value: tot.ownComm, kind: 'money' },
        { label: 'عمولات المناديب الأعلى', value: tot.subsComm, kind: 'money' },
        { label: 'حصص المشاركة', value: ctx.scopeAll && !ctx.userId ? money(sharePool) : tot.share, kind: 'money' },
        { label: 'إجمالي المستحق', value: ctx.scopeAll && !ctx.userId ? money(tot.ownComm + tot.subsComm + sharePool) : tot.total, kind: 'money' },
      ];
      const notes = [(byTotal(ctx) ? 'العمولة = نسبة المستفيد × إجمالي الطلب شامل الضريبة (بعد الخصم)' : 'العمولة = نسبة المستفيد × صافي ربح الطلب (البيع قبل الضريبة − التكاليف)') + '، بالنسب المحفوظة على الطلب وقت اعتماده؛ والنسبة المخصّصة لطلب بعينه (من «نسبة البائع/المندوب») تغلب.',
        'مصدر النسبة: «مخصّصة لهذا الطلب» من نافذة الطلب، «نسبة المندوب الخاصة» من صفحة المناديب، «افتراضية» من الإعدادات، «محفوظة على الطلب وقت اعتماده» = نسبة سابقة تغيّر مصدرها بعد ذلك.',
        `حصة المشاركة تُقسم بالتساوي على موظفي المحل النشطين (${internal.length}).`];
      if (uncosted) notes.push(`${uncosted} طلب بلا تكاليف مُدخلة لم تُحسب له عمولة.`);
      const showP = !!ctx.perms.profitAny;
      // صافي الربح لمن يملك صلاحيته فقط؛ وعمود «أساس العمولة» يظهر حين يختلف عن صافي الربح (أساس الإجمالي)
      const noP = (cols) => cols.filter((c) => (c.key !== 'profit' || showP) && (c.key !== 'base' || byTotal(ctx)));
      const BL = 'أساس العمولة (' + baseLabel(ctx) + ')';
      return {
        summary, notes,
        tables: [
          { title: 'المستحقات حسب الشخص', columns: noP([col('name', 'الاسم'), col('role', 'الدور'), col('orders', 'الطلبات', 'num'), col('revenue', 'المبيعات', 'money'), col('profit', 'صافي ربح طلباته', 'money'), col('base', BL, 'money'), col('rate', 'النسبة ٪', 'pct'), col('ownComm', 'عمولة طلباته', 'money'), col('subsComm', 'من طلبات تابعيه', 'money'), col('share', 'حصة المشاركة', 'money'), col('total', 'إجمالي المستحق', 'money')]), rows, totals: tot },
          { title: 'تفصيل العمولات لكل طلب', columns: noP([col('number', 'رقم الطلب'), col('date', 'التاريخ', 'date'), col('customer', 'العميل'), col('who', 'المستفيد'), col('type', 'النوع'), col('rate', 'النسبة ٪', 'pct'), col('src', 'مصدر النسبة'), col('profit', 'صافي ربح الطلب', 'money'), col('base', BL, 'money'), col('amount', 'المبلغ', 'money')]), rows: det, totals: { number: 'الإجمالي', amount: sum(det, (d) => d.amount) } },
        ],
      };
    },
  };

  /* 3) صافي الأرباح */
  R.pnl = {
    title: 'صافي الأرباح',
    desc: 'المبيعات − التكاليف − العمولات − المصروفات، مع تفصيل شهري',
    need: (ctx) => ctx.perms.profitAny, usesInclude: true,
    build(ctx) {
      const list = byUser(ctx, scopedOrders(ctx, { statusMode: 'sales' }));
      let exps = [];
      if (ctx.perms.expenses) {
        exps = (ctx.expenses || []).filter((e) => inRange(ctx.calc.expDay(e), ctx.from, ctx.to));
        if (!ctx.scopeAll) exps = exps.filter((e) => e.created_by === ctx.me);
        if (ctx.userId) exps = exps.filter((e) => e.created_by === ctx.userId);
      }
      const months = new Map();
      const bucket = (k) => { if (!months.has(k)) months.set(k, { month: k, orders: 0, revenue: 0, uncostedRev: 0, cost: 0, profit: 0, comm: 0, expenses: 0 }); return months.get(k); };
      for (const o of list) {
        const f = orderFigures(ctx, o);
        const b = bucket(ctx.calc.ordDate(o).slice(0, 7));
        b.orders++; b.revenue += f.revenue;
        if (f.profit === null) { b.uncostedRev += f.revenue; continue; }
        b.cost += f.cost; b.profit += f.profit;
        if (f.bd) b.comm += num(f.ownerComm) + num(f.parentComm) + num(f.share);
      }
      for (const e of exps) bucket(ctx.calc.expDay(e).slice(0, 7)).expenses += num(e.amount);
      const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((b) => ({
        month: b.month, orders: b.orders, revenue: money(b.revenue), uncostedRev: money(b.uncostedRev), cost: money(b.cost), profit: money(b.profit),
        comm: money(b.comm), expenses: money(b.expenses), net: money(b.profit - b.comm - b.expenses), margin: pct(b.profit - b.comm - b.expenses, b.revenue - b.uncostedRev),
      }));
      const T = (k) => sum(rows, (r) => r[k]);
      const tot = { month: 'الإجمالي', orders: rows.reduce((s, r) => s + r.orders, 0), revenue: T('revenue'), uncostedRev: T('uncostedRev'), cost: T('cost'), profit: T('profit'), comm: T('comm'), expenses: T('expenses'), net: T('net') };
      tot.margin = pct(tot.net, tot.revenue - tot.uncostedRev);
      const summary = [
        { label: 'المبيعات قبل الضريبة', value: tot.revenue, kind: 'money' },
        { label: 'التكاليف', value: tot.cost, kind: 'money' },
        { label: 'صافي ربح الطلبات', value: tot.profit, kind: 'money' },
        { label: 'العمولات والحصص', value: tot.comm, kind: 'money' },
      ];
      if (ctx.perms.expenses) summary.push({ label: 'المصروفات', value: tot.expenses, kind: 'money' });
      summary.push({ label: 'صافي الربح النهائي', value: tot.net, kind: 'money' }, { label: 'الهامش الصافي ٪', value: tot.margin, kind: 'pct' });
      const columns = [col('month', 'الشهر'), col('orders', 'الطلبات', 'num'), col('revenue', 'المبيعات', 'money'), col('uncostedRev', 'مبيعات بلا تكاليف', 'money'), col('cost', 'التكاليف', 'money'), col('profit', 'ربح الطلبات', 'money'), col('comm', 'العمولات والحصص', 'money')];
      if (ctx.perms.expenses) columns.push(col('expenses', 'المصروفات', 'money'));
      columns.push(col('net', 'صافي الربح النهائي', 'money'), col('margin', 'الهامش ٪', 'pct'));
      const notes = ['صافي الربح النهائي = ربح الطلبات (البيع قبل الضريبة − التكاليف) − العمولات والحصص' + (ctx.perms.expenses ? ' − المصروفات.' : '.'),
        'الطلبات الفعلية فقط؛ الطلبات بلا تكاليف مُدخلة تظهر في المبيعات ولا تدخل في الربح.'];
      if (!ctx.perms.expenses) notes.push('المصروفات غير مشمولة: لا تملك صلاحية عرضها.');
      return { summary, notes, tables: [{ title: 'التفصيل الشهري', columns, rows, totals: tot }] };
    },
  };

  /* 4) أداء الموظفين والمناديب */
  R.staff = {
    title: 'أداء الموظفين والمناديب',
    desc: 'عدد الطلبات والمبيعات والربح والتحصيل لكل موظف ومندوب', usesInclude: true,
    build(ctx) {
      const all = byUser(ctx, scopedOrders(ctx, { statusMode: 'none' }));
      const g = new Map();
      for (const o of all) {
        const k = o.createdBy || 'none';
        if (!g.has(k)) g.set(k, { name: ctx.userName(o.createdBy, o.createdByName), role: ctx.labels.ROLES[ctx.userRole(o.createdBy)] || '', orders: 0, quotes: 0, cancelled: 0, pending: 0, revenue: 0, profit: 0, costedRev: 0, costed: 0, paid: 0, remaining: 0 });
        const e = g.get(k);
        if (o.status === 'quote') { e.quotes++; continue; }
        if (o.status === 'cancelled') { e.cancelled++; continue; }
        if (!counted(ctx, o)) { e.pending++; continue; }   // جديد أو غير مدفوع بالكامل حسب «يشمل التقرير»
        const f = orderFigures(ctx, o);
        e.orders++; e.revenue += f.revenue; e.paid += f.paid; e.remaining += f.remaining;
        if (f.profit !== null) { e.profit += f.profit; e.costedRev += f.revenue; e.costed++; }
      }
      const showP = !!ctx.perms.profitAny;
      const rows = [...g.values()].map((e) => ({
        name: e.name, role: e.role, orders: e.orders, quotes: e.quotes, cancelled: e.cancelled, pending: e.pending, revenue: money(e.revenue),
        avg: e.orders ? money(e.revenue / e.orders) : 0, profit: e.costed ? money(e.profit) : null, margin: e.costed ? pct(e.profit, e.costedRev) : null,
        paid: money(e.paid), remaining: money(e.remaining),
      })).sort((a, b) => b.revenue - a.revenue);
      const columns = [col('name', 'الاسم'), col('role', 'الدور'), col('orders', 'الطلبات الفعلية', 'num'), col('pending', 'غير محتسبة', 'num'), col('quotes', 'عروض الأسعار', 'num'), col('cancelled', 'الملغاة', 'num'), col('revenue', 'المبيعات', 'money'), col('avg', 'متوسط الطلب', 'money')];
      if (showP) columns.push(col('profit', 'صافي الربح', 'money'), col('margin', 'الهامش ٪', 'pct'));
      columns.push(col('paid', 'المحصّل', 'money'), col('remaining', 'المتبقي', 'money'));
      const tot = { name: 'الإجمالي' };
      ['orders', 'pending', 'quotes', 'cancelled'].forEach((k) => { tot[k] = rows.reduce((s, r) => s + r[k], 0); });
      ['revenue', 'paid', 'remaining'].forEach((k) => { tot[k] = sum(rows, (r) => r[k]); });
      tot.avg = tot.orders ? money(tot.revenue / tot.orders) : 0;
      if (showP) tot.profit = sum(rows.filter((r) => r.profit !== null), (r) => r.profit);
      const summary = [{ label: 'الطلبات الفعلية', value: tot.orders, kind: 'num' }, { label: 'المبيعات', value: tot.revenue, kind: 'money' }, { label: 'متوسط الطلب', value: tot.avg, kind: 'money' }];
      if (showP) summary.push({ label: 'صافي الربح', value: tot.profit, kind: 'money' });
      summary.push({ label: 'المتبقي على العملاء', value: tot.remaining, kind: 'money' });
      return { summary, notes: ['«الطلبات الفعلية» والمبيعات تشمل: ' + includeText(ctx) + '. «غير محتسبة» = طلبات خارج هذا الاختيار (مثل الجديدة).'], tables: [{ title: 'الأداء حسب الشخص', columns, rows, totals: tot }] };
    },
  };

  /* 5) التحصيل والدفعات */
  R.payments = {
    title: 'التحصيل والدفعات',
    desc: 'كل دفعة مستلمة (أو مستردة) في الفترة حسب تاريخ الدفعة وطريقتها',
    build(ctx) {
      const orders = byUser(ctx, scopedOrders(ctx, { byDate: false, statusMode: 'none' }));
      const rows = [];
      for (const o of orders) {
        for (const p of (Array.isArray(o.payments) ? o.payments : [])) {
          const d = ctx.calc.payDay(p);
          if (!inRange(d, ctx.from, ctx.to)) continue;
          rows.push({ date: d, number: o.number != null ? '#' + o.number : '—', customer: (o.customer || {}).name || '—', method: ctx.labels.PAY_METHOD[p.method] || p.method || '', amount: money(p.amount), by: p.by || '', note: p.note || '' });
        }
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const byMethod = new Map();
      rows.forEach((r) => { const m = byMethod.get(r.method) || { method: r.method, count: 0, amount: 0 }; m.count++; m.amount += r.amount; byMethod.set(r.method, m); });
      const mRows = [...byMethod.values()].map((m) => ({ method: m.method, count: m.count, amount: money(m.amount) })).sort((a, b) => b.amount - a.amount);
      const total = sum(rows, (r) => r.amount);
      const refunds = sum(rows.filter((r) => r.amount < 0), (r) => r.amount);
      return {
        summary: [{ label: 'صافي المحصّل', value: total, kind: 'money' }, { label: 'عدد الدفعات', value: rows.length, kind: 'num' }, { label: 'المستردّ', value: refunds, kind: 'money' }],
        notes: ['الفترة هنا حسب تاريخ الدفعة لا تاريخ الطلب. المبالغ السالبة استردادات.'],
        tables: [
          { title: 'حسب طريقة الدفع', columns: [col('method', 'الطريقة'), col('count', 'العدد', 'num'), col('amount', 'المبلغ', 'money')], rows: mRows, totals: { method: 'الإجمالي', count: rows.length, amount: total } },
          { title: 'الدفعات', columns: [col('date', 'التاريخ', 'date'), col('number', 'رقم الطلب'), col('customer', 'العميل'), col('method', 'الطريقة'), col('amount', 'المبلغ', 'money'), col('by', 'سجّلها'), col('note', 'ملاحظة')], rows, totals: { date: 'الإجمالي', amount: total } },
        ],
      };
    },
  };

  /* 6) المتبقي على العملاء */
  R.receivables = {
    title: 'المتبقي على العملاء',
    desc: 'الطلبات التي عليها مبالغ غير محصّلة، مع عمر الدين بالأيام', usesInclude: true, includeNoPaid: true,
    build(ctx) {
      const list = byUser(ctx, scopedOrders(ctx, { statusMode: 'salesStatus' }));
      const rows = list.map((o) => {
        const f = orderFigures(ctx, o); const c = o.customer || {}; const d = ctx.calc.ordDate(o);
        return { number: o.number != null ? '#' + o.number : '—', date: d, customer: c.name || '—', phone: c.phone || '', status: ctx.labels.STATUS[o.status] || '', by: ctx.userName(o.createdBy, o.createdByName), total: f.total, paid: f.paid, remaining: f.remaining, age: daysBetween(ctx.today, d) };
      }).filter((r) => r.remaining > 0.009).sort((a, b) => b.remaining - a.remaining);
      const tot = { number: 'الإجمالي', total: sum(rows, (r) => r.total), paid: sum(rows, (r) => r.paid), remaining: sum(rows, (r) => r.remaining) };
      const old = rows.filter((r) => r.age !== null && r.age > 30);
      return {
        summary: [{ label: 'إجمالي المتبقي', value: tot.remaining, kind: 'money' }, { label: 'عدد الطلبات', value: rows.length, kind: 'num' }, { label: 'متأخر أكثر من 30 يوماً', value: sum(old, (r) => r.remaining), kind: 'money' }],
        notes: [],
        tables: [{ title: 'المديونيات', columns: [col('number', 'رقم الطلب'), col('date', 'تاريخ الطلب', 'date'), col('customer', 'العميل'), col('phone', 'الجوال'), col('status', 'الحالة'), col('by', 'الموظف / المندوب'), col('total', 'الإجمالي', 'money'), col('paid', 'المحصّل', 'money'), col('remaining', 'المتبقي', 'money'), col('age', 'العمر (يوم)', 'num')], rows, totals: tot }],
      };
    },
  };

  /* 7) المصروفات */
  R.expenses = {
    title: 'المصروفات',
    desc: 'المصروفات بتاريخها وتصنيفها ومن سجّلها والطلب المرتبط بها',
    need: (ctx) => ctx.perms.expenses,
    build(ctx) {
      let list = (ctx.expenses || []).filter((e) => inRange(ctx.calc.expDay(e), ctx.from, ctx.to));
      if (!ctx.scopeAll) list = list.filter((e) => e.created_by === ctx.me);
      if (ctx.userId) list = list.filter((e) => e.created_by === ctx.userId);
      const numOf = new Map((ctx.orders || []).map((o) => [o.id, o.number]));
      const rows = list.map((e) => ({ date: ctx.calc.expDay(e), category: e.category || 'غير مصنّف', name: e.name || '', note: e.note || '', amount: money(e.amount), by: ctx.userName(e.created_by, e.created_by_name), order: e.order_id ? (numOf.has(e.order_id) && numOf.get(e.order_id) != null ? '#' + numOf.get(e.order_id) : 'طلب مرتبط') : '' }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const cats = new Map();
      rows.forEach((r) => { const c = cats.get(r.category) || { category: r.category, count: 0, amount: 0 }; c.count++; c.amount += r.amount; cats.set(r.category, c); });
      const total = sum(rows, (r) => r.amount);
      const cRows = [...cats.values()].map((c) => ({ category: c.category, count: c.count, amount: money(c.amount), share: pct(c.amount, total) })).sort((a, b) => b.amount - a.amount);
      return {
        summary: [{ label: 'إجمالي المصروفات', value: total, kind: 'money' }, { label: 'عدد المصروفات', value: rows.length, kind: 'num' }, { label: 'عدد التصنيفات', value: cRows.length, kind: 'num' }],
        notes: [],
        tables: [
          { title: 'حسب التصنيف', columns: [col('category', 'التصنيف'), col('count', 'العدد', 'num'), col('amount', 'المبلغ', 'money'), col('share', 'النسبة ٪', 'pct')], rows: cRows, totals: { category: 'الإجمالي', count: rows.length, amount: total } },
          { title: 'المصروفات', columns: [col('date', 'التاريخ', 'date'), col('category', 'التصنيف'), col('name', 'الوصف'), col('amount', 'المبلغ', 'money'), col('by', 'سجّله'), col('order', 'الطلب'), col('note', 'ملاحظة')], rows, totals: { date: 'الإجمالي', amount: total } },
        ],
      };
    },
  };

  /* 8) المبيعات حسب العميل */
  R.customers = {
    title: 'المبيعات حسب العميل',
    desc: 'لكل عميل: عدد طلباته ومبيعاته والمحصّل والمتبقي وآخر طلب', usesInclude: true,
    build(ctx) {
      const list = byUser(ctx, scopedOrders(ctx, { statusMode: 'sales' }));
      const g = new Map();
      for (const o of list) {
        const c = o.customer || {};
        const k = String(c.phone || '').replace(/\D/g, '') || ('n:' + (c.name || '—'));
        const f = orderFigures(ctx, o);
        const e = g.get(k) || { customer: c.name || '—', phone: c.phone || '', orders: 0, revenue: 0, total: 0, paid: 0, remaining: 0, last: '' };
        e.orders++; e.revenue += f.revenue; e.total += f.total; e.paid += f.paid; e.remaining += f.remaining;
        const d = ctx.calc.ordDate(o); if (d > e.last) { e.last = d; if (c.name) e.customer = c.name; }
        g.set(k, e);
      }
      const rows = [...g.values()].map((e) => ({ ...e, revenue: money(e.revenue), total: money(e.total), paid: money(e.paid), remaining: money(e.remaining) })).sort((a, b) => b.revenue - a.revenue);
      const tot = { customer: 'الإجمالي', orders: rows.reduce((s, r) => s + r.orders, 0), revenue: sum(rows, (r) => r.revenue), total: sum(rows, (r) => r.total), paid: sum(rows, (r) => r.paid), remaining: sum(rows, (r) => r.remaining) };
      return {
        summary: [{ label: 'عدد العملاء', value: rows.length, kind: 'num' }, { label: 'المبيعات قبل الضريبة', value: tot.revenue, kind: 'money' }, { label: 'المتبقي', value: tot.remaining, kind: 'money' }],
        notes: [],
        tables: [{ title: 'العملاء', columns: [col('customer', 'العميل'), col('phone', 'الجوال'), col('orders', 'الطلبات', 'num'), col('revenue', 'المبيعات قبل الضريبة', 'money'), col('total', 'الإجمالي', 'money'), col('paid', 'المحصّل', 'money'), col('remaining', 'المتبقي', 'money'), col('last', 'آخر طلب', 'date')], rows, totals: tot }],
      };
    },
  };

  /* 9) زيارات الموقع — لمالك النظام فقط (البيانات من الخادم: /api/owner-analytics، والحماية هناك)
     ctx.visits = { ready, error, visitsDaily:[{day,link,n}], visitorsDaily:[{day,u}], visitorsKeptFrom, funnel, links }
     كل رقم مجموع فعلي من السجلات — لا تقدير ولا أرقام وهمية، واليوم بلا زيارات صفر. */
  /* أسماء قنوات مصدر الزيارة (?src=…) — أي اسم آخر (حملة مخصّصة) يظهر كما كُتب */
  const SRC_LABELS = { direct: 'مباشر (بلا رابط مصدر)', whatsapp: 'واتساب', instagram: 'إنستغرام', tiktok: 'تيك توك', snapchat: 'سناب شات',
    x: 'إكس (تويتر)', facebook: 'فيسبوك', google: 'خرائط وبحث Google', qr: 'رمز QR (المعرض والمطبوعات)', sms: 'رسالة نصية', ads: 'إعلان ممول' };
  const srcLabel = (k) => SRC_LABELS[k] || k;
  const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const dayIdx = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  R.visits = {
    title: 'زيارات الموقع',
    desc: 'زيارات صفحات العملاء يوماً بيوم، والزوار، ودخول الموظفين للتطبيق، وأيام الذروة، ومسار التصميم حتى الطلب',
    need: (ctx) => !!(ctx.perms && ctx.perms.visits),
    build(ctx) {
      const v = ctx.visits;
      if (!v || !v.ready) {
        return { summary: [{ label: 'الحالة', value: v && v.error ? 'تعذّر تحميل الزيارات' : 'جارٍ تحميل الزيارات…', kind: 'text' }], tables: [], notes: [v && v.error ? v.error : 'تُجلب بيانات الزيارات من الخادم.'] };
      }
      const links = v.links || { customer: 'بوابة العميل' };
      const lk = Object.keys(links);
      const byDay = new Map();
      (v.visitsDaily || []).forEach((r) => { if (inRange(r.day, ctx.from, ctx.to)) { const e = byDay.get(r.day) || {}; e[r.link] = (e[r.link] || 0) + num(r.n); byDay.set(r.day, e); } });
      const uOf = new Map((v.visitorsDaily || []).map((r) => [r.day, num(r.u)]));
      const sOf = new Map((v.staffDaily || []).map((r) => [r.day, num(r.users)]));
      const staffRows = (v.staffByUser || []).map((u) => ({ name: u.name, days: num(u.days), opens: num(u.opens), last: u.lastAt ? String(u.lastAt).slice(0, 10) : '' }));
      // كل أيام الفترة (حتى أيام الصفر): من بداية الفترة أو أول يوم فيه بيانات، حتى نهايتها
      const to = ctx.to || ctx.today;
      const firstData = [...byDay.keys()].sort()[0];
      let from = ctx.from || firstData || to;
      if (daysBetween(to, from) > 730) from = addDays(to, -730);   // سقف معقول للجدول اليومي
      const kept = v.visitorsKeptFrom || '';
      const rows = [];
      for (let d = from; d && d <= to; d = addDays(d, 1)) {
        const e = byDay.get(d) || {};
        const r = { date: d, weekday: WEEKDAYS[dayIdx(d)], total: 0 };
        lk.forEach((k) => { r[k] = num(e[k]); r.total += r[k]; });
        r.visitors = kept && d < kept ? null : (uOf.get(d) || 0);
        r.staff = sOf.get(d) || 0;
        rows.push(r);
      }
      const total = rows.reduce((s, r) => s + r.total, 0);
      const visitors = rows.reduce((s, r) => s + (r.visitors || 0), 0);
      const peak = rows.reduce((a, r) => (r.total > (a ? a.total : 0) ? r : a), null);
      const wk = WEEKDAYS.map((w, i) => ({ weekday: w, days: 0, visits: 0, i }));
      rows.forEach((r) => { const x = wk[dayIdx(r.date)]; x.days++; x.visits += r.total; });
      const wRows = wk.filter((x) => x.days).map((x) => ({ weekday: x.weekday, days: x.days, visits: x.visits, avg: Math.round((x.visits / x.days) * 10) / 10, share: pct(x.visits, total) }))
        .sort((a, b) => b.avg - a.avg);
      const F = ((v.funnel && v.funnel.steps) || []);
      const fBy = Object.fromEntries(F.map((s) => [s.key, s]));
      const orders = fBy.order ? num(fBy.order.n) : 0;
      const started = fBy.start ? num(fBy.start.n) : 0;
      const totals = { date: 'الإجمالي', total, visitors: rows.some((r) => r.visitors !== null) ? visitors : null, staff: staffRows.length };
      // حسب المصدر: الزيارات والتصاميم والطلبات والمبيعات الفعلية لكل قناة
      const srcRows = (v.sources || []).map((x) => ({ source: srcLabel(x.src), visits: num(x.visits), started: num(x.started), finished: num(x.finished), contact: num(x.contact), orders: num(x.orders), revenue: money(x.revenue), conv: pct(num(x.orders), num(x.visits)) }));
      const sT = { source: 'الإجمالي', visits: 0, started: 0, finished: 0, contact: 0, orders: 0, revenue: 0 };
      srcRows.forEach((r) => { ['visits', 'started', 'finished', 'contact', 'orders'].forEach((k) => { sT[k] += r[k]; }); sT.revenue = money(sT.revenue + r.revenue); });
      sT.conv = pct(sT.orders, sT.visits);
      const bestSrc = srcRows.filter((r) => r.orders > 0).sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)[0];
      lk.forEach((k) => { totals[k] = rows.reduce((s, r) => s + r[k], 0); });
      return {
        summary: [
          { label: 'إجمالي الزيارات', value: total, kind: 'num' },
          { label: 'الزوار (جهاز/يوم)', value: totals.visitors, kind: 'num' },
          { label: 'متوسط الزيارات اليومي', value: rows.length ? Math.round((total / rows.length) * 10) / 10 : 0, kind: 'num' },
          { label: 'أعلى يوم', value: peak && peak.total ? `${peak.date} (${peak.total})` : null, kind: 'text' },
          { label: 'أنشط يوم في الأسبوع', value: wRows.length && wRows[0].visits ? wRows[0].weekday : null, kind: 'text' },
          { label: 'بدء تصميم', value: started, kind: 'num' },
          { label: 'طلبات مؤكدة من التصاميم', value: orders, kind: 'num' },
          { label: 'التحويل: زيارة ← طلب', value: pct(orders, total), kind: 'pct' },
          { label: 'أفضل مصدر (طلبات)', value: bestSrc ? `${bestSrc.source} (${bestSrc.orders})` : null, kind: 'text' },
          { label: 'موظفون دخلوا التطبيق', value: staffRows.length, kind: 'num' },
        ],
        notes: [
          'الزيارة = كل فتح لصفحة عامة. الزائر = جهاز واحد في اليوم (لا يُحتسب مرتين في اليوم نفسه، ولو فتح الصفحتين).',
          'الروبوتات ومعاينات الروابط (واتساب، تيليجرام…) مستبعدة. الأيام بتوقيت المحل.',
          kept ? `عدد الزوار محفوظ لآخر 40 يوماً فقط (منذ ${kept}) — قبله تظهر الزيارات بلا عدد زوار («—»).` : '',
          'عمود «الموظفون» = عدد الموظفين الذين فتحوا تطبيق الموظفين في ذلك اليوم (بدأ العدّ مع تحديث 1.0.90). «مرة فتح» = فتح بعد غياب نصف ساعة أو أكثر.',
          'المصدر يُعرف من رابط القناة (?src=…) في «عن التطبيق». الزيارة تُنسب لرابطها، والتصميم يُنسب للمصدر المحفوظ على جهاز العميل 7 أيام، والطلب يرث مصدر تصميمه.',
        ].filter(Boolean),
        tables: [
          { title: 'الزيارات يوماً بيوم', columns: [col('date', 'التاريخ', 'date'), col('weekday', 'اليوم'), ...lk.map((k) => col(k, links[k], 'num')), col('total', 'إجمالي الزيارات', 'num'), col('visitors', 'الزوار', 'num'), col('staff', 'الموظفون', 'num')], rows: rows.slice().reverse(), totals },
          { title: 'حسب مصدر الزيارة (أي قناة تجلب الطلبات)', columns: [col('source', 'المصدر'), col('visits', 'الزيارات', 'num'), col('started', 'بدء تصميم', 'num'), col('finished', 'تصميم مكتمل', 'num'), col('contact', 'طلب تواصل', 'num'), col('orders', 'طلبات مؤكدة', 'num'), col('revenue', 'المبيعات', 'money'), col('conv', 'زيارة ← طلب ٪', 'pct')], rows: srcRows, totals: sT },
          { title: 'حسب يوم الأسبوع (أفضل يوم للنشر والإعلان)', columns: [col('weekday', 'اليوم'), col('days', 'عدد الأيام', 'num'), col('visits', 'الزيارات', 'num'), col('avg', 'متوسط اليوم', 'num'), col('share', 'النسبة ٪', 'pct')], rows: wRows, totals: { weekday: 'الإجمالي', days: rows.length, visits: total } },
          { title: 'مسار العميل: من الزيارة إلى الطلب', columns: [col('step', 'المرحلة'), col('n', 'العدد', 'num'), col('rate', 'النسبة ٪', 'pct')], rows: F.map((s) => ({ step: s.label, n: num(s.n), rate: s.rate })) },
          { title: 'دخول الموظفين للتطبيق', columns: [col('name', 'الموظف'), col('days', 'أيام الدخول', 'num'), col('opens', 'مرات الفتح', 'num'), col('last', 'آخر دخول', 'date')], rows: staffRows, totals: { name: 'الإجمالي', days: staffRows.reduce((s, r) => s + r.days, 0), opens: staffRows.reduce((s, r) => s + r.opens, 0) } },
        ],
      };
    },
  };

  const ORDER = ['orders', 'pending', 'commissions', 'pnl', 'staff', 'payments', 'receivables', 'expenses', 'customers', 'visits'];

  function catalog(ctx) {
    return ORDER.filter((id) => !R[id].need || R[id].need(ctx)).map((id) => ({ id, title: R[id].title, desc: R[id].desc, usesStatus: !!R[id].usesStatus, usesInclude: !!R[id].usesInclude, includeNoPaid: !!R[id].includeNoPaid }));
  }

  function build(id, ctx) {
    const def = R[id];
    if (!def || (def.need && !def.need(ctx))) throw new Error('تقرير غير متاح');
    // تصفية بمستخدم آخر لمن يملك reports.view_all فقط — وإلا تُتجاهل (النطاق طلباته هو)
    if (!ctx.scopeAll && ctx.userId) ctx = { ...ctx, userId: '' };
    const out = def.build(ctx);
    // ما يشمله التقرير يُذكر أول الملاحظات (يظهر في الشاشة وPDF وExcel) — تقرير الطلبات والأداء يذكرانه بأنفسهما
    if (def.usesInclude && ctx.include && id !== 'orders' && id !== 'staff') {
      out.notes = ['يشمل التقرير: ' + (def.includeNoPaid ? includeText({ ...ctx, include: { ...ctx.include, paidOnly: false } }) : includeText(ctx)) + ' (بلا عروض الأسعار والملغاة).'].concat(out.notes || []);
    }
    return { id, title: def.title, period: periodText(ctx), from: ctx.from || '', to: ctx.to || ctx.today || '', ...out };
  }

  /* ---------------- تحويل للتصدير ---------------- */
  /** قيمة الخلية للتصدير: الأرقام تبقى أرقاماً (يجمعها Excel)، والفارغ نص فارغ */
  function cellValue(v, kind) {
    if (v === null || v === undefined || v === '') return '';
    if (kind === 'money' || kind === 'num' || kind === 'pct') return typeof v === 'number' ? v : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : String(v));
    return String(v);
  }
  /** جدول ← مصفوفة صفوف (رأس + بيانات + إجمالي) */
  function tableAoa(t) {
    const aoa = [t.columns.map((c) => c.label)];
    t.rows.forEach((r) => aoa.push(t.columns.map((c) => cellValue(r[c.key], c.kind))));
    if (t.totals) aoa.push(t.columns.map((c) => cellValue(t.totals[c.key], c.kind)));
    return aoa;
  }
  function headerAoa(rep, meta) {
    const a = [[rep.title], ['الفترة', rep.period]];
    (meta || []).forEach(([k, v]) => a.push([k, v]));
    return a;
  }
  function summaryAoa(rep) { return rep.summary.map((s) => [s.label, cellValue(s.value, s.kind)]); }

  function toCsv(rep, meta) {
    // حماية من حقن الصيغ: نص يبدأ بـ = + - @ (وليس رقماً) يُسبق بفاصلة عليا
    const q = (v) => {
      if (typeof v === 'number') return String(v);
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const lines = [];
    const push = (row) => lines.push(row.map(q).join(','));
    headerAoa(rep, meta).forEach(push);
    lines.push('');
    push(['الملخص']); summaryAoa(rep).forEach(push);
    rep.tables.forEach((t) => { lines.push(''); push([t.title]); tableAoa(t).forEach(push); });
    if (rep.notes && rep.notes.length) { lines.push(''); rep.notes.forEach((n) => push([n])); }
    return '﻿' + lines.join('\r\n');
  }

  const api = { build, catalog, tableAoa, headerAoa, summaryAoa, toCsv, cellValue, isSale, counted, includeText, INCLUDE_STATUSES, DEFAULT_INCLUDE, SRC_LABELS, srcLabel, _defs: R };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Reports = api;
})(typeof window !== 'undefined' ? window : globalThis);
