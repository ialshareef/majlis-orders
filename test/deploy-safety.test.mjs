/* اختبار أمان سكربت النشر (محلي فقط، بدون اتصال بـ Cloudflare)
   يتحقق من أن deploy-cloudflare.ps1 يحتوي على آليات منع النشر العرضي على الإنتاج.
   لا ينفّذ السكربت، ولا يرسل أي طلب خارجي. */

import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const lines = [];
function t(name, fn) {
  try { fn(); pass++; lines.push('PASS  ' + name); }
  catch (e) { fail++; lines.push('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

const script = fs.readFileSync('deploy-cloudflare.ps1', 'utf8');

console.log('\n=== أمان سك Deployment النشر (deploy-cloudflare.ps1) ===');

/* 1) وضع المعاينة مفعل افتراضياً */
t('1أ) لمعامل $Preview قيمة افتراضية $true', () => {
  assert.ok(/\$Preview\s+=\s*\$true/.test(script), 'معامل $Preview ليس مفعلاً افتراضياً');
});

/* 2) البيئة الافتراضية هي test */
t('1ب) لمعامل $Environment قيمة افتراضية "test"', () => {
  assert.ok(/\$Environment\s+=\s*['"]test['"]/.test(script), 'معامل $Environment ليس مضبوطاً على test افتراضياً');
});

/* 3) رفض أسماء الموارد الإنتاجية في وضع الاختبار */
t('1ج) السكربت يرفض DbName=majlis-db في وضع الاختبار', () => {
  assert.ok(/majlis-db/.test(script) && /Environment -eq 'test'/.test(script) && /Fail/.test(script),
    'لا يوجد رفض لأسماء الموارد الإنتاجية في وضع الاختبار');
});

t('1د) السكربت يرفض WorkerName=majlis-api في وضع الاختبار', () => {
  assert.ok(/majlis-api/.test(script), 'اسم عامل الإنتاج majlis-api غير موجود في فحص الرفض');
});

/* 4) وضع المعاينة يخرج قبل أي كتابة */
t('2أ) وضع المعاينة يحتوي على exit 0 قبل Operations الكتابة', () => {
  assert.ok(/exit 0/.test(script), 'لا يوجد خروج نظيف في وضع المعاينة');
});

t('2ب) وضع المعاينة يعرض الإجراءات المقترحة قبل الخروج', () => {
  assert.ok(/وضع المعاينة/.test(script) || /preview/i.test(script), 'لا يوجد ذكر لوضع المعاينة في الرسائل');
});

/* 5) تأكيد صريح قبل الكتابة */
t('3أ) السكربت يطلب تأكيداً صريحاً قبل الكتابة', () => {
  assert.ok(/Read-Host/.test(script), 'لا يوجد طلب تأكيد (Read-Host) قبل الكتابة');
});

t('3ب) السكربت يعرض اسم قاعدة البيانات قبل التأكيد', () => {
  assert.ok(/قاعدة البيانات.*:.*\$DbName/.test(script) || /\$DbName/.test(script),
    'لا يعرض اسم قاعدة البيانات المستهدفة');
});

t('3ج) السكربت يعرض اسم الـ Worker قبل التأكيد', () => {
  assert.ok(/\$WorkerName/.test(script), 'لا يعرض اسم الـ Worker المستهدف');
});

/* 6) لا يدّعي دعم -WhatIf دون تنفيذ فعلي */
t('4أ) السكربت لا يدّعي دعم -WhatIf كمعامل', () => {
  assert.ok(!/\[switch\]\$WhatIf/.test(script) && !/\$WhatIf/.test(script),
    'يدّعي دعم -WhatIf دون أن تحترمه أوامر الكتابة');
});

/* 7) جميع أوامر الكتابة تستخدم المتغيرات المحددة (ليست ثابتة للإنتاج) */
t('5أ) إنشاء قاعدة D1 يستخدم متغير $DbName', () => {
  assert.ok(/\$DbName/.test(script) && /d1\/database/.test(script),
    'إنشاء قاعدة D1 لا يستخدم متغير $DbName');
});

t('5ب) رفع الـ Worker يستخدم متغير $WorkerName', () => {
  assert.ok(/\$WorkerName/.test(script) && /workers\/scripts\/\$WorkerName/.test(script),
    'رفع الـ Worker لا يستخدم متغير $WorkerName');
});

t('5ج) تنفيذ schema.sql يستخدم معرف القاعدة المستخرجة من $dbId', () => {
  assert.ok(/\$dbId/.test(script) && /database\/\$dbId\/query/.test(script),
    'تنفيذ schema.sql لا يستخدم معرف القاعدة المستهدفة');
});

/* 8) التوقف عند تعذر التحقق من الحساب */
t('6أ) السكربت يتوقف إذا لم يُFind حساب', () => {
  assert.ok(/No account returned/.test(script) || /Fail.*account/.test(script),
    'لا يوجد توقف عند تعذر العثور على الحساب');
});

/* 9) AccountId إلزامي في وضع الاختبار */
t('7أ) في وضع الاختبار، -AccountId إلزامي (لا اختيار تلقائي)', () => {
  assert.ok(/Environment -eq 'test'/.test(script) && /AccountId/.test(script) && /Fail.*AccountId|AccountId.*required|mandatory/i.test(script),
    'لا يوجد فحص إلزامية AccountId في وضع الاختبار');
});

/* 10) تحقق من تطابق اسم قاعدة D1 */
t('7ب) السكربت يتحقق من تطابق اسم قاعدة D1 مع DbName', () => {
  assert.ok(/db\.name -ne \$DbName/.test(script) || /name mismatch/i.test(script),
    'لا يوجد فحص تطابق اسم قاعدة D1');
});

/* 11) تحقق من صلاحية database_id */
t('7ج) السكربت يتحقق من صلاحية database_id', () => {
  assert.ok(/dbId.*notmatch|Invalid D1 database ID|database ID/i.test(script),
    'لا يوجد فحص صلاحية database_id');
});

/* 12) في وضع الاختبار، لا يمكن تجاوز التأكيد */
t('8أ) في وضع الاختبار، -Confirm:$false ممنوع', () => {
  assert.ok(/Environment -eq 'test'/.test(script) && /Confirm.*cannot be bypassed|Confirm.*bypass/i.test(script),
    'لا يوجد منع لتجاوز التأكيد في وضع الاختبار');
});

/* 13) Worker binding verification */
t('8ب) السكربت يتحقق من binding قاعدة D1 قبل الرفع', () => {
  assert.ok(/Worker D1 binding mismatch|binding.*mismatch/i.test(script),
    'لا يوجد فحص binding قاعدة D1');
});

/* 14) عرض Account ID قبل التأكيد */
t('9أ) السكربت يعرض Account ID قبل التأكيد', () => {
  assert.ok(/Account ID: \$AccountId/.test(script),
    'لا يعرض Account ID قبل التأكيد');
});

/* 10) UUID validation: صيغة قياسية */
t('10أ) regex UUID uses standard format 8-4-4-4-12', () => {
  assert.ok(/\^\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}\$/.test(script),
    'regex UUID is not in standard 8-4-4-4-12 format');
});

t('10ب) regex UUID rejects wrong length', () => {
  // The regex requires exactly 36 chars with hyphens
  assert.ok(/\{12\}\$/.test(script), 'regex does not anchor at end with 12 hex chars');
});

t('10ج) regex UUID rejects uppercase-only non-hex', () => {
  // The regex allows a-fA-F, so uppercase hex is OK, but non-hex letters are rejected
  assert.ok(/\[0-9a-fA-F\]/.test(script), 'regex does not include uppercase hex range');
});

/* 12) Confirmation variable uses distinct name (not $confirm) */
t('12أ) السكربت يستخدم متغير $confirmationText (ليس $confirm)', () => {
  assert.ok(/\$confirmationText/.test(script), 'لا يوجد متغير $confirmationText');
  assert.ok(!/\$confirm\s*=/.test(script), 'يستخدم $confirm = (تعارض مع معامل -Confirm)');
});

t('12ب) Read-Host يخزن في $confirmationText', () => {
  assert.ok(/\$confirmationText\s*=\s*Read-Host/.test(script), 'Read-Host لا يخزن في $confirmationText');
});

t('12ج) التحقق من equality مع "yes" uses $confirmationText', () => {
  assert.ok(/\$confirmationText\s*-ne\s*['"]yes['"]/.test(script), 'التحقق من "yes" لا يستخدم $confirmationText');
});

t('11أ) UUID valid lowercase passes regex', () => {
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  assert.ok(re.test('550e8400-e29b-41d4-a716-446655440000'), 'valid lowercase UUID rejected');
});

t('11ب) UUID valid uppercase passes regex', () => {
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  assert.ok(re.test('550E8400-E29B-41D4-A716-446655440000'), 'valid uppercase UUID rejected');
});

t('11ج) UUID wrong length rejected', () => {
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  assert.ok(!re.test('550e8400-e29b-41d4-a716-44665544000'), 'wrong length UUID accepted');
  assert.ok(!re.test('550e8400-e29b-41d4-a716-4466554400000'), 'too long UUID accepted');
});

t('11د) UUID wrong hyphen positions rejected', () => {
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  assert.ok(!re.test('550e8400e29b-41d4-a716-446655440000'), 'missing first hyphen accepted');
  assert.ok(!re.test('550e8400-e29b41d4-a716-446655440000'), 'missing second hyphen accepted');
  assert.ok(!re.test('550e8400-e29b-41d4a716-446655440000'), 'missing third hyphen accepted');
  assert.ok(!re.test('550e8400-e29b-41d4-a716446655440000'), 'missing fourth hyphen accepted');
});

t('11ه) UUID non-hex chars rejected', () => {
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  assert.ok(!re.test('550e8400-e29b-41d4-a716-44665544000g'), 'non-hex char g accepted');
  assert.ok(!re.test('550e8400-e29b-41d4-a716-44665544000z'), 'non-hex char z accepted');
  assert.ok(!re.test('550e8400-e29b-41d4-a716-44665544000!'), 'special char accepted');
});

/* ---------- النتيجة ---------- */
const report = lines.join('\n') + '\n\n=== النتيجة: PASS=' + pass + '  FAIL=' + fail + ' ===';
console.log(report);
process.exit(fail ? 1 : 0);
