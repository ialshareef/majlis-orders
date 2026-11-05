/* ======================================================================
   إشعارات واتساب اليدوية — دوال مساعدة نقية للواجهة (بلا DOM)
   - نفس قواعد الخادم (worker.js ‏waNormalizePhone/waLink/waRender) لمعاينة فورية قبل الحفظ؛
     الخادم يبقى المرجع ويعيد التحقق دائماً. اختبار test/whatsapp-ui-e2e.mjs يقارن النسختين.
   - Click to Chat فقط (https://wa.me/<رقم>?text=…): لا API ولا أتمتة، والإرسال بيد المستخدم.
   ====================================================================== */
(function (global) {
  'use strict';

  var TYPES = ['order_created', 'payment_received', 'expense_created', 'order_status'];
  var TYPE_LABELS = {
    order_created: 'تسجيل طلب جديد',
    payment_received: 'استلام دفعة مالية',
    expense_created: 'تسجيل مصروف',
    order_status: 'تغيير حالة طلب',
  };
  var TYPE_ICONS = { order_created: '🔔', payment_received: '💰', expense_created: '🧾', order_status: '🔄' };
  // الحالات الخمس كما هي — لا «تم التسليم» ولا «تمت القراءة»: Click to Chat لا يعطي أي تأكيد
  var LOG_LABELS = {
    ready: 'جاهز للإرسال',
    opened: 'تم فتح واتساب',
    confirmed: 'أكد المستخدم الإرسال يدويًا',
    skipped: 'تم التخطي',
    failed: 'فشل فتح الرابط',
  };
  var VAR_LABELS = {
    order_number: 'رقم الطلب', customer_name: 'اسم العميل', total: 'إجمالي الطلب', status: 'حالة الطلب',
    employee: 'الموظف', date: 'التاريخ', payment_amount: 'مبلغ الدفعة', payment_method: 'طريقة الدفع',
    description: 'بيان المصروف', category: 'التصنيف', amount: 'المبلغ', old_status: 'الحالة السابقة', new_status: 'الحالة الجديدة',
  };
  var MAX_RECIPIENTS = 20;
  var MSG_MAX = 2000;

  function normalizePhone(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { error: 'رقم الهاتف مطلوب' };
    s = s.replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x6F0); })
      .replace(/[\s\-(). ‎‏‪-‮⁦-⁩]/g, '');
    if (s.length > 20) return { error: 'رقم الهاتف طويل جداً' };
    var intl = false;
    if (s.charAt(0) === '+') { intl = true; s = s.slice(1); }
    else if (s.slice(0, 2) === '00') { intl = true; s = s.slice(2); }
    if (!/^\d+$/.test(s)) return { error: 'رقم الهاتف يحتوي رموزاً غير مسموحة — أرقام فقط مع + في البداية' };
    if (!intl) {
      if (/^05\d{8}$/.test(s)) s = '966' + s.slice(1);
      else if (/^5\d{8}$/.test(s)) s = '966' + s;
      else if (s.slice(0, 3) !== '966') return { error: 'أدخل الرقم مع رمز الدولة (مثل ‎+971…)، أو جوالاً سعودياً يبدأ بـ 05' };
    }
    if (/^9660\d{9}$/.test(s)) s = '966' + s.slice(4);
    if (s.slice(0, 3) === '966') {
      if (!/^9665\d{8}$/.test(s)) return { error: 'رقم سعودي غير صحيح: الجوال 9 أرقام تبدأ بـ 5 بعد 966' };
      return { phone: s };
    }
    if (s.charAt(0) === '0') return { error: 'رمز الدولة لا يبدأ بصفر' };
    if (s.length < 8 || s.length > 15) return { error: 'طول الرقم الدولي غير صحيح (8 إلى 15 رقماً مع رمز الدولة)' };
    return { phone: s };
  }

  /** عرض الرقم الدولي مقروءاً: ‎+966 50 123 4567 (السعودي) أو ‎+<الأرقام> */
  function formatPhone(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (/^9665\d{8}$/.test(d)) return '+966 ' + d.slice(3, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8);
    return d ? '+' + d : '';
  }

  function cleanText(t) {
    return String(t == null ? '' : t).replace(/\r\n?/g, '\n')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  function link(phone, text) {
    return 'https://wa.me/' + String(phone).replace(/\D/g, '') + '?text=' + encodeURIComponent(cleanText(text));
  }

  function render(body, vars) {
    var has = function (k) { return !!vars && Object.prototype.hasOwnProperty.call(vars, k); };
    return String(body || '').replace(/\{(\w+)\}/g, function (m, k) {
      if (!has(k)) return m;
      var v = vars[k];
      return v === null || v === undefined || v === '' ? '—' : String(v);
    });
  }

  /** وصف قصير للتنبيه في القوائم: «طلب #1001 — عبدالله» */
  function describe(ev) {
    var v = (ev && ev.vars) || {};
    var no = ev && ev.order_number ? '#' + ev.order_number : '';
    if (!ev) return '';
    if (ev.type === 'expense_created') return (v.description || 'مصروف') + (v.amount ? ' — ' + v.amount : '');
    if (ev.type === 'payment_received') return 'طلب ' + no + (v.payment_amount ? ' — ' + v.payment_amount : '');
    if (ev.type === 'order_status') return 'طلب ' + no + ' — ' + (v.old_status || '') + ' ← ' + (v.new_status || '');
    return 'طلب ' + no + (v.customer_name ? ' — ' + v.customer_name : '');
  }

  global.WaNotify = {
    TYPES: TYPES, TYPE_LABELS: TYPE_LABELS, TYPE_ICONS: TYPE_ICONS, LOG_LABELS: LOG_LABELS, VAR_LABELS: VAR_LABELS,
    MAX_RECIPIENTS: MAX_RECIPIENTS, MSG_MAX: MSG_MAX,
    normalizePhone: normalizePhone, formatPhone: formatPhone, cleanText: cleanText, link: link, render: render, describe: describe,
  };
})(typeof window !== 'undefined' ? window : globalThis);
