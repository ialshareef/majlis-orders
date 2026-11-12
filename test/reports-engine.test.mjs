/* اختبار محرك التقارير (js/reports.js) بأرقام محسوبة يدوياً — بلا متصفح.
   الاستخدام: node test/reports-engine.test.mjs */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Reports = require('../js/reports.js');

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.006;

const users = [
  { id: 'a1', name: 'المالك', role: 'admin', active: true },
  { id: 's1', name: 'سالم', role: 'staff', active: true },
  { id: 's2', name: 'سعد', role: 'staff', active: true },
  { id: 'sx', name: 'موقوف', role: 'staff', active: false },
  { id: 'm1', name: 'مندوب أعلى', role: 'mandoub', active: true },
  { id: 'm2', name: 'مندوب تابع', role: 'mandoub', active: true, parentId: 'm1' },
];
const O = (id, number, by, date, status, subtotal, total, paid, cost, commRates, payments = [], extra = {}) => ({
  id, number, createdBy: by, createdByName: (users.find((u) => u.id === by) || {}).name, createdAt: date + 'T10:00:00.000Z', status,
  subtotal, discount: 0, total, paid, _cost: cost, commRates, payments, customer: { name: 'عميل ' + number, phone: '05000000' + number }, ...extra,
});
const orders = [
  O('o1', 1, 's1', '2026-10-05', 'new', 1000, 1150, 500, 600, { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 },
    [{ at: '2026-10-05', amount: 300, method: 'cash', by: 'سالم' }, { at: '2026-11-01', amount: 200, method: 'mada', by: 'سالم' }]),
  O('o2', 2, 'm2', '2026-10-20', 'delivered', 2000, 2300, 2300, 1000, { ownerRate: 20, parentId: 'm1', parentRate: 5, shareRate: 5 },
    [{ at: '2026-10-20', amount: 2300, method: 'transfer', by: 'مندوب تابع' }]),
  O('o3', 3, 's1', '2026-10-21', 'quote', 900, 1035, 0, 100, null),
  O('o4', 4, 's2', '2026-10-22', 'cancelled', 800, 920, 0, 100, null),
  O('o5', 5, 's1', '2026-11-02', 'progress', 500, 575, 0, null, null, [], { customer: { name: '=HYPERLINK("x")', phone: '0500000005' } }),
  O('o6', 6, 's2', '2025-12-30', 'new', 700, 805, 0, 300, { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }),
];
const expenses = [
  { id: 'e1', name: 'إيجار المحل', amount: 100, category: 'إيجار', created_by: 'a1', expense_date: '2026-10-10', order_id: null },
  { id: 'e2', name: 'نقل', amount: 50, category: 'نقل', created_by: 's1', expense_date: '2026-11-03', order_id: 'o1' },
  { id: 'e3', name: 'قديم', amount: 999, category: 'إيجار', created_by: 'a1', expense_date: '2025-01-01' },
];
const breakdown = (o) => {
  const r = o.commRates || { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }; const p = o.subtotal - o.discount - o._cost;
  const rows = [{ kind: 'owner', userId: o.createdBy, who: o.createdByName, rate: r.ownerRate, amount: p * r.ownerRate / 100 }];
  if (r.parentId) rows.push({ kind: 'parent', userId: r.parentId, who: users.find((u) => u.id === r.parentId).name, rate: r.parentRate, amount: p * r.parentRate / 100 });
  rows.push({ kind: 'share', userId: null, who: 'موظفو المحل', rate: r.shareRate, amount: p * r.shareRate / 100 });
  return { profit: p, rows };
};
const ctxOf = (over = {}) => ({
  orders, expenses, users, from: '2026-10-01', to: '2026-11-30', userId: '', status: '', today: '2026-11-04', me: 'a1', scopeAll: true,
  perms: { profitAny: true, commAny: true, expenses: true, profit: () => true, comm: () => true, ...(over.perms || {}) },
  calc: { revenue: (o) => o.subtotal - o.discount, cost: (o) => (o._cost === undefined ? null : o._cost), breakdown, ordDate: (o) => o.createdAt.slice(0, 10), payDay: (p) => p.at, expDay: (e) => e.expense_date },
  labels: { STATUS: { quote: 'عرض سعر', new: 'جديد', progress: 'قيد التنفيذ', done: 'اكتمال', delivered: 'تم التوصيل', cancelled: 'ملغي' }, PAY_METHOD: { cash: 'نقداً', mada: 'مدى', transfer: 'تحويل' }, ROLES: { admin: 'مدير', staff: 'موظف', mandoub: 'مندوب' } },
  userName: (id, fb) => (users.find((u) => u.id === id) || {}).name || fb || 'غير محدد',
  userRole: (id) => (users.find((u) => u.id === id) || {}).role || '',
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'perms')),
});
const S = (rep, label) => (rep.summary.find((s) => s.label === label) || {}).value;

/* ---- الفهرس والصلاحيات ---- */
ok(Reports.catalog(ctxOf()).map((c) => c.id).join() === 'orders,pending,commissions,pnl,staff,payments,receivables,expenses,customers', 'catalog: كل التقارير التسعة للمالك («الطلبات الجديدة» بعد تفصيل الطلبات)');
const noComm = Reports.catalog(ctxOf({ perms: { commAny: false, profitAny: false, expenses: false } })).map((c) => c.id);
ok(!noComm.includes('commissions') && !noComm.includes('pnl') && !noComm.includes('expenses') && noComm.includes('orders'), 'catalog: بلا صلاحية العمولة/الربح/المصروفات تختفي تقاريرها', noComm);
let threw = false; try { Reports.build('pnl', ctxOf({ perms: { profitAny: false } })); } catch (_) { threw = true; }
ok(threw, 'build: تقرير غير مسموح يُرفض حتى لو طُلب مباشرة');

/* ---- تفصيل الطلبات ---- */
let r = Reports.build('orders', ctxOf());
const t = r.tables[0];
ok(t.rows.map((x) => x.number).join() === '#1,#2,#5', 'orders: الفعلية فقط ضمن الفترة (بلا عرض السعر والملغي والقديم)', t.rows.map((x) => x.number));
ok(eq(t.totals.revenue, 3500) && eq(t.totals.cost, 1600) && eq(t.totals.profit, 1400), 'orders: البيع 3500 والتكاليف 1600 والربح 1400', t.totals);
ok(eq(t.totals.ownerComm, 240) && eq(t.totals.parentComm, 50) && eq(t.totals.share, 70) && eq(t.totals.afterComm, 1040), 'orders: العمولات 240/50/70 والربح بعدها 1040', t.totals);
ok(eq(t.totals.vat, 525) && eq(t.totals.total, 4025) && eq(t.totals.paid, 2800) && eq(t.totals.remaining, 1225), 'orders: الضريبة والإجمالي والمحصّل والمتبقي', t.totals);
const r2row = t.rows.find((x) => x.number === '#2');
ok(r2row.by === 'مندوب تابع' && r2row.role === 'مندوب' && r2row.parent === 'مندوب أعلى' && eq(r2row.margin, 50), 'orders: صف المندوب: الدور والمندوب الأعلى والهامش 50٪', r2row);
ok(t.rows.find((x) => x.number === '#5').profit === null && r.notes.some((n) => n.includes('1 طلب بلا تكاليف')), 'orders: طلب بلا تكاليف ربحه فارغ ومذكور في الملاحظات');
r = Reports.build('orders', ctxOf({ status: 'all' }));
ok(r.tables[0].rows.length === 5 && eq(r.tables[0].totals.revenue, 3500), 'orders: «كل الطلبات» تعرض الخمسة والإجماليات للفعلية فقط');
r = Reports.build('orders', ctxOf({ status: 'quote' }));
ok(r.tables[0].rows.length === 1 && r.tables[0].rows[0].number === '#3', 'orders: تصفية بحالة محددة');
r = Reports.build('orders', ctxOf({ userId: 'm2' }));
ok(r.tables[0].rows.length === 1 && r.tables[0].rows[0].number === '#2', 'orders: تصفية بالموظف/المندوب');

/* ---- النطاق: طلباتي فقط ---- */
r = Reports.build('orders', ctxOf({ scopeAll: false, me: 's1', userId: 'm2' }));
ok(r.tables[0].rows.map((x) => x.number).join() === '#1,#5', 'scope: reports.view_own يرى طلباته فقط ويتجاهل تصفية مستخدم آخر', r.tables[0].rows.map((x) => x.number));

/* ---- إخفاء الأعمدة الحساسة ---- */
r = Reports.build('orders', ctxOf({ perms: { profitAny: false, commAny: false, profit: () => false, comm: () => false } }));
const keys = r.tables[0].columns.map((c) => c.key);
ok(!keys.includes('cost') && !keys.includes('profit') && !keys.includes('ownerComm') && !keys.includes('parent'), 'perms: بلا صلاحية الربح والعمولة لا أعمدة تكاليف ولا ربح ولا عمولة', keys);
ok(r.tables[0].rows.every((x) => x.profit === null && x.cost === null && x.ownerComm === null), 'perms: والقيم نفسها فارغة لا مخفية بالعرض فقط');
ok(!r.summary.some((s) => /التكاليف|الربح|العمولات/.test(s.label)), 'perms: والملخص بلا تكاليف ولا ربح ولا عمولات', r.summary.map((s) => s.label));

/* ---- العمولات ---- */
r = Reports.build('commissions', ctxOf());
const by = Object.fromEntries(r.tables[0].rows.map((x) => [x.name, x]));
ok(eq(by['سالم'].ownComm, 40) && eq(by['سالم'].share, 23.33) && eq(by['سالم'].total, 63.33), 'commissions: الموظف: عمولة 40 + حصة 70/3', by['سالم']);
ok(eq(by['مندوب تابع'].ownComm, 200) && eq(by['مندوب أعلى'].subsComm, 50) && eq(by['مندوب أعلى'].total, 50), 'commissions: المندوب 200 والمندوب الأعلى 50 من تابعه');
ok(eq(by['سعد'].share, 23.33) && eq(by['المالك'].share, 23.33) && !by['موقوف'], 'commissions: الحصة على موظفي المحل النشطين فقط (3)');
ok(eq(S(r, 'إجمالي المستحق'), 360) && eq(S(r, 'حصص المشاركة'), 70), 'commissions: إجمالي المستحق 360 = 240 + 50 + 70', r.summary);
ok(r.tables[1].rows.length === 5 && eq(r.tables[1].totals.amount, 360), 'commissions: تفصيل لكل طلب (5 بنود = 360)');
r = Reports.build('commissions', ctxOf({ scopeAll: false, me: 'm2', perms: { profitAny: false, profit: () => false } }));
ok(r.tables[0].rows.length === 1 && r.tables[0].rows[0].name === 'مندوب تابع' && eq(r.tables[0].rows[0].ownComm, 200), 'commissions/mandoub: يرى عمولته فقط (200)', r.tables[0].rows);
ok(!r.tables[0].columns.some((c) => c.key === 'profit') && !r.tables[1].columns.some((c) => c.key === 'profit'), 'commissions/mandoub: بلا عمود الربح لمن لا يملك صلاحيته');
ok(r.tables[1].rows.every((d) => d.who === 'مندوب تابع'), 'commissions/mandoub: التفصيل بنوده هو فقط');

/* ---- صافي الأرباح ---- */
r = Reports.build('pnl', ctxOf());
ok(eq(S(r, 'صافي ربح الطلبات'), 1400) && eq(S(r, 'العمولات والحصص'), 360) && eq(S(r, 'المصروفات'), 150) && eq(S(r, 'صافي الربح النهائي'), 890), 'pnl: 1400 − 360 − 150 = 890', r.summary);
const m10 = r.tables[0].rows.find((x) => x.month === '2026-10'), m11 = r.tables[0].rows.find((x) => x.month === '2026-11');
ok(eq(m10.net, 940) && eq(m10.expenses, 100) && eq(m11.uncostedRev, 500) && eq(m11.net, -50), 'pnl: تفصيل شهري (أكتوبر 940، نوفمبر −50)', r.tables[0].rows);
r = Reports.build('pnl', ctxOf({ perms: { expenses: false } }));
ok(eq(S(r, 'صافي الربح النهائي'), 1040) && !r.tables[0].columns.some((c) => c.key === 'expenses'), 'pnl: بلا صلاحية المصروفات لا تُطرح ولا تظهر');

/* ---- الأداء والدفعات والمديونيات والمصروفات والعملاء ---- */
r = Reports.build('staff', ctxOf());
const st = Object.fromEntries(r.tables[0].rows.map((x) => [x.name, x]));
ok(st['سالم'].orders === 2 && st['سالم'].quotes === 1 && eq(st['سالم'].revenue, 1500) && eq(st['سالم'].profit, 400) && st['سعد'].cancelled === 1, 'staff: الطلبات والعروض والملغاة والمبيعات والربح', st['سالم']);
r = Reports.build('payments', ctxOf({ from: '2026-11-01' }));
ok(r.tables[1].rows.length === 1 && eq(S(r, 'صافي المحصّل'), 200) && r.tables[1].rows[0].method === 'مدى', 'payments: بتاريخ الدفعة لا تاريخ الطلب', r.tables[1].rows);
r = Reports.build('payments', ctxOf());
ok(eq(S(r, 'صافي المحصّل'), 2800) && r.tables[0].rows.length === 3, 'payments: الفترة كاملة 2800 بثلاث طرق');
r = Reports.build('receivables', ctxOf());
ok(r.tables[0].rows.map((x) => x.number).join() === '#1,#5' && eq(r.tables[0].totals.remaining, 1225) && r.tables[0].rows[0].age === 30, 'receivables: المتبقي 650 + 575 وعمر الدين', r.tables[0].rows);
r = Reports.build('expenses', ctxOf());
ok(r.tables[1].rows.length === 2 && eq(S(r, 'إجمالي المصروفات'), 150) && r.tables[1].rows.find((x) => x.name === 'نقل').order === '#1', 'expenses: الفترة فقط مع الطلب المرتبط', r.tables[1].rows);
r = Reports.build('expenses', ctxOf({ scopeAll: false, me: 's1' }));
ok(r.tables[1].rows.length === 1 && r.tables[1].rows[0].by === 'سالم', 'expenses: view_own يرى مصروفاته فقط');
r = Reports.build('customers', ctxOf());
ok(r.tables[0].rows.length === 3 && r.tables[0].rows[0].customer === 'عميل 2', 'customers: عميل لكل جوال مرتّبون بالمبيعات');

/* ---- التصدير ---- */
r = Reports.build('orders', ctxOf());
const csv = Reports.toCsv(r, [['المتجر', 'أصالة نجد']]);
ok(csv.charCodeAt(0) === 0xfeff && csv.includes('\r\n'), 'csv: BOM للعربية في Excel وفواصل أسطر CRLF');
ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'csv: حماية من حقن الصيغ (= يُسبق بفاصلة عليا)', csv.split('\r\n').find((l) => l.includes('HYPERLINK')));
ok(csv.includes(',1000,') && csv.includes('الإجمالي'), 'csv: الأرقام تبقى أرقاماً وصف الإجمالي موجود');
const aoa = Reports.tableAoa(r.tables[0]);
ok(aoa.length === 1 + 3 + 1 && typeof aoa[1][r.tables[0].columns.findIndex((c) => c.key === 'revenue')] === 'number', 'aoa: رأس + 3 صفوف + إجمالي، والمبالغ أرقام لـ Excel');


/* ---- «يشمل التقرير»: الطلبات الجديدة خارج المبيعات افتراضياً ---- */
{
  const DEF = Reports.DEFAULT_INCLUDE;
  ok(JSON.stringify(DEF) === JSON.stringify({ statuses: ['progress', 'done', 'delivered'], paidOnly: false }), 'include: الافتراضي بلا «جديد» وبلا شرط الدفع', DEF);
  const inc = (statuses, paidOnly = false) => ctxOf({ include: { statuses, paidOnly } });
  let r = Reports.build('orders', inc(DEF.statuses));
  ok(r.tables[0].rows.length === 2 && S(r, 'المبيعات قبل الضريبة') === 2500 && !r.tables[0].rows.some((x) => x.number === '#1'), 'include/orders: الافتراضي يستبعد الطلب الجديد #1 (2000 + 500 = 2500)', r.tables[0].rows.map((x) => x.number));
  ok(/قيد التنفيذ، اكتمال، تم التوصيل/.test(r.notes[0]) && !/جديد/.test(r.notes[0]), 'include/orders: الملاحظة تذكر ما يشمله التقرير', r.notes[0]);
  r = Reports.build('orders', inc(['new', 'progress', 'done', 'delivered']));
  ok(S(r, 'المبيعات قبل الضريبة') === 3500 && r.tables[0].rows.length === 3, 'include/orders: اختيار «جديد» يعيده (3500)');
  r = Reports.build('orders', inc(DEF.statuses, true));
  ok(S(r, 'المبيعات قبل الضريبة') === 2000 && r.tables[0].rows.length === 1 && r.tables[0].rows[0].number === '#2', 'include/orders: «المدفوعة بالكامل فقط» ← #2 وحده', r.tables[0].rows.map((x) => x.number));
  r = Reports.build('orders', { ...inc(DEF.statuses), status: 'new' });
  ok(r.tables[0].rows.length === 1 && r.tables[0].rows[0].number === '#1', 'include/orders: اختيار حالة محددة من القائمة يتجاوز «يشمل التقرير»');
  r = Reports.build('pnl', inc(DEF.statuses));
  ok(S(r, 'المبيعات قبل الضريبة') === 2500 && /^يشمل التقرير: قيد التنفيذ/.test(r.notes[0]), 'include/pnl: الأرباح بلا الجديد، وأول ملاحظة تذكر ما يشمله', { s: S(r, 'المبيعات قبل الضريبة'), n: r.notes[0] });
  r = Reports.build('commissions', inc(DEF.statuses));
  const det = r.tables.find((t) => /لكل طلب/.test(t.title));
  ok(det && !det.rows.some((x) => x.number === '#1'), 'include/commissions: لا عمولة على الطلب الجديد');
  r = Reports.build('receivables', inc(DEF.statuses, true));
  ok(r.tables[0].rows.length === 1 && r.tables[0].rows[0].number === '#5' && !/المدفوعة بالكامل/.test(r.notes[0]), 'include/receivables: «المدفوعة بالكامل» لا يُفرغ المديونيات (#5)، والجديد مستبعد', { rows: r.tables[0].rows.map((x) => x.number), n: r.notes[0] });
  r = Reports.build('staff', inc(DEF.statuses));
  const s1 = r.tables[0].rows.find((x) => x.name === 'سالم');
  ok(s1 && s1.orders === 1 && s1.pending === 1 && s1.quotes === 1 && r.tables[0].columns.some((c) => c.key === 'pending'), 'include/staff: سالم = طلب فعلي واحد + «غير محتسبة» 1 (الجديد) + عرض سعر', s1);
  r = Reports.build('customers', inc(DEF.statuses));
  ok(!r.tables[0].rows.some((x) => x.customer === 'عميل 1'), 'include/customers: عميل الطلب الجديد خارج المبيعات');
  const cat = Object.fromEntries(Reports.catalog(ctxOf()).map((c) => [c.id, c]));
  ok(cat.orders.usesInclude && cat.commissions.usesInclude && cat.pnl.usesInclude && cat.receivables.includeNoPaid && !cat.payments.usesInclude && !cat.pending.usesInclude, 'catalog: «يشمل التقرير» للتقارير المالية فقط (لا للدفعات ولا للطلبات الجديدة)', cat);
  ok(Reports.includeText(inc(['new', 'delivered'], true)) === 'جديد، تم التوصيل — المدفوعة بالكامل فقط', 'includeText: وصف عربي مقروء', Reports.includeText(inc(['new', 'delivered'], true)));
  // بلا include (عملاء قدامى للمحرّك): السلوك القديم
  ok(S(Reports.build('orders', ctxOf()), 'المبيعات قبل الضريبة') === 3500, 'include: بلا اختيار ← كل الطلبات الفعلية كما كان');
}

/* ---- أساس العمولة: صافي الربح (افتراضي) أو الإجمالي شامل الضريبة ---- */
{
  // الأساس الافتراضي: عمود «النسبة ٪» لكل شخص، ولا عمود «أساس العمولة» (هو صافي الربح نفسه)
  const rp = Reports.build('commissions', ctxOf());
  const keys = rp.tables[0].columns.map((c) => c.key);
  const salem = rp.tables[0].rows.find((x) => x.name === 'سالم');
  ok(keys.includes('rate') && !keys.includes('base') && eq(salem.rate, 10), 'commBase/profit: عمود النسبة ٪ (سالم 10٪) بلا عمود الأساس', { keys, salem });
  // أساس «الإجمالي»: breakdown يحسب من o.total، ولا يلزم إدخال التكاليف
  const bdTotal = (o) => {
    const r = o.commRates || { ownerRate: 10, parentId: null, parentRate: null, shareRate: 5 }; const p = o.total;
    const rows = [{ kind: 'owner', userId: o.createdBy, who: o.createdByName, rate: r.ownerRate, amount: p * r.ownerRate / 100 }];
    if (r.parentId) rows.push({ kind: 'parent', userId: r.parentId, who: users.find((u) => u.id === r.parentId).name, rate: r.parentRate, amount: p * r.parentRate / 100 });
    rows.push({ kind: 'share', userId: null, who: 'موظفو المحل', rate: r.shareRate, amount: p * r.shareRate / 100 });
    return { profit: o._cost == null ? null : o.subtotal - o.discount - o._cost, base: p, rows };
  };
  const tctx = ctxOf();
  tctx.calc = { ...tctx.calc, breakdown: bdTotal, commBase: 'total' };
  const rt = Reports.build('commissions', tctx);
  const by = Object.fromEntries(rt.tables[0].rows.map((x) => [x.name, x]));
  ok(rt.tables[0].columns.some((c) => c.key === 'base' && /الإجمالي شامل الضريبة/.test(c.label)), 'commBase/total: عمود «أساس العمولة (الإجمالي شامل الضريبة)»');
  ok(eq(by['سالم'].base, 1725) && eq(by['سالم'].ownComm, 172.5) && eq(by['سالم'].rate, 10), 'commBase/total: سالم 10٪ من 1150 + 575 (طلب بلا تكاليف يُحسب) = 172.5', by['سالم']);
  ok(eq(by['مندوب تابع'].ownComm, 460) && eq(by['مندوب تابع'].rate, 20) && eq(by['مندوب أعلى'].subsComm, 115) && by['مندوب أعلى'].rate === null, 'commBase/total: المندوب 460 (20٪) والأعلى 115 بلا نسبة طلبات خاصة', [by['مندوب تابع'], by['مندوب أعلى']]);
  ok(eq(S(rt, 'حصص المشاركة'), 201.25) && eq(S(rt, 'إجمالي المستحق'), 172.5 + 460 + 115 + 201.25), 'commBase/total: الحصص 201.25 وإجمالي المستحق', rt.summary);
  ok(!rt.notes.some((n) => /بلا تكاليف مُدخلة لم تُحسب/.test(n)) && /إجمالي الطلب شامل الضريبة/.test(rt.notes[0]), 'commBase/total: الملاحظات تذكر الأساس ولا «لم تُحسب» للطلب بلا تكاليف', rt.notes);
  const ro = Reports.build('orders', tctx);
  const o5 = ro.tables[0].rows.find((x) => x.number === '#5');
  ok(o5.profit === null && eq(o5.ownerComm, 57.5), 'commBase/total: تفصيل الطلبات — طلب بلا تكاليف بلا ربح وبعمولة 57.5', o5);
}

/* ---- تقرير «الطلبات الجديدة» ---- */
{
  const r = Reports.build('pending', ctxOf({ include: Reports.DEFAULT_INCLUDE }));
  const t = r.tables[0];
  ok(t.rows.length === 1 && t.rows[0].number === '#1' && t.rows[0].total === 1150 && t.rows[0].paid === 500 && t.rows[0].remaining === 650 && t.rows[0].age === 30, 'pending: الطلب الجديد #1 في الفترة — القيمة 1150، العربون 500، ينتظر 30 يوماً', t.rows);
  ok(S(r, 'عدد الطلبات الجديدة') === 1 && S(r, 'القيمة المتوقعة') === 1150 && S(r, 'العربون المحصّل') === 500 && S(r, 'أقدم طلب ينتظر (يوم)') === 30, 'pending: الملخص', r.summary);
  const all = Reports.build('pending', ctxOf({ from: '', to: '2026-11-30' }));
  ok(all.tables[0].rows.length === 2 && all.tables[0].rows[0].number === '#6', 'pending: كل الفترات ← الطلبان الجديدان، الأقدم أولاً', all.tables[0].rows.map((x) => x.number));
  ok(/لا تُحسب في المبيعات/.test(r.notes[0]), 'pending: ملاحظة أنها خارج المبيعات');
}

console.log(`=== reports-engine: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
