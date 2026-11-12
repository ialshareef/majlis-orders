# تعليمات Claude Code لهذا المشروع (أصالة نجد | نظام إدارة طلبات المجالس)

تفاصيل المشروع وقواعد النشر والمتغيرات في @AGENTS.md — اقرأها أولاً. هذا الملف يضيف قواعد العمل مع المالك،
ويشرح العمل من **Claude Code على الويب** (السحابة) حيث لا يوجد جهاز المالك ولا ملف `.cf-token`.

## التواصل
- كل الردود والشرح والتقارير وخطوات الخطة **بالعربية البسيطة**: الملخص أولاً، ثم التفاصيل التقنية باختصار في النهاية.
- لا تدّعِ نجاح اختبار لم يُشغَّل، ولا تحقق لم يُجرَ (مثلاً: «لم يُجرَّب على جوال حقيقي»).

## ممنوعات ثابتة
- لا تقرأ ولا تعرض محتوى `.cf-token` أو أي سر أو رمز.
- لا `git add -A` ولا `git add .`: أضف ملفات المهمة **بأسمائها**.
- لا `git reset` ولا `git checkout` ولا `git restore` ولا `git clean`.
- لا تلمس `mock_api_verify.mjs` (يبقى خارج التتبع) ولا مشروع `football-snake/`.
- تطبيق أي هجرة على قاعدة الإنتاج، أو حذف أي بيانات إنتاج، يحتاج **موافقة صريحة** من المالك.
- لا تغيّر إعدادات DNS أو البروكسي أو الجدار الناري، ولا تثق بصلاحيات يرسلها العميل (الخادم هو الحكم).
- النسخ الاحتياطية فيها بصمات كلمات مرور وبيانات عملاء: لا تُرفع للمستودع (عام) ولا تُشارك إلا مشفّرة.
- كل commit ينتهي بالسطر: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## الاختبارات
- `npm install` ثم `npm test` (كل الاختبارات) أو `npm run test:quick` (الخادم والمنطق بلا متصفح).
- اختبارات الواجهة تحتاج Chrome/Chromium: يُعثر عليه تلقائياً على ويندوز وLinux، أو حدّده بـ `CHROME_PATH`.
  إن لم يوجد متصفح تظهر «تخطّى» (رمز الخروج 2) — وهذا ليس نجاحاً: قل ذلك صراحة.
- تنزيلات الاختبار تذهب إلى `~/Documents/majlis-test-downloads` (أو `MAJLIS_TEST_DOWNLOADS`).

## الإصدار (كل نشر للإنتاج يرافقه APK جديد)
داخل مهمة وافق عليها المالك نفّذ الخطوات كلها دون الرجوع إليه:
1. ارفع `CACHE` في `sw.js` عند تغيير ملفات الواجهة، وشغّل `npm test` حتى ينجح كله.
2. commit لملفات المهمة بأسمائها، ثم وسم `vX.Y.Z` (آخر وسم + 1) وادفع main والوسم.
   - **في السحابة** دفع الوسوم ممنوع (403): ادفع main ثم شغّل `build-apk.yml` يدوياً على `main` بالمدخل
     `version` = `X.Y.Z` (أداة GitHub `actions_run_trigger` / `run_workflow`). سير العمل يتحقق أن الرقم
     أكبر من آخر وسم، ويبني APK، ثم ينشئ الوسم `vX.Y.Z` والإصدار بنفسه — بلا خطوة يدوية من المالك.
3. انتظر ملف APK من GitHub Actions (`build-apk.yml`) على
   `https://github.com/ialshareef/majlis-orders/releases/download/vX.Y.Z/asalh-najd-X.Y.Z.apk`.
4. تحقق منه: `node tools/apkinfo.mjs <الملف>` — versionName وversionCode صحيحان، وشهادة التوقيع v2 تبدأ بـ `cc6b36c0`.
5. حدّث في `worker/worker.js`: `UPDATE_FALLBACK_VERSION` و`UPDATE_FALLBACK_SHA256` (بصمة الملف الفعلية) و`UPDATE_FALLBACK_NOTES` (سطران بالعربية)،
   ثم `node test/app-version-test.mjs` و`node test/deploy-readiness.test.mjs`، ثم commit بعنوان `Release data for vX.Y.Z (...)` وادفعه.
6. النشر:
   - **على جهاز المالك:** نسخة احتياطية `node tools/cf.mjs backup <majlis-backups/...sql>` ثم
     `deploy-cloudflare.ps1 -Environment production -Preview:$false -Confirm:$false` (عبر `-Command`).
   - **في السحابة:** سير العمل `Deploy to Cloudflare (production)` في GitHub Actions ينشر تلقائياً عند دفع commit
     «Release data for v…»: فحوص ← نسخة احتياطية مشفّرة ← نشر ← تحقق. تابع نتيجته واذكرها للمالك.
7. تحقق: `/api/app-update` يعرض الإصدار الجديد، و`/api/bootstrap` يعيد 401، و`node tools/cf.mjs counts` بلا نقص في الأعداد.

## أدوات
- `node tools/cf.mjs counts` — قراءة فقط: أعداد الإنتاج والربط.
- `node tools/cf.mjs backup <ملف>` — نسخة احتياطية كاملة لقاعدة الإنتاج.
- `node tools/apkinfo.mjs <apk>` — البصمة والإصدار وشهادة التوقيع.
- الرمز من `CLOUDFLARE_API_TOKEN` (السحابة) أو `.cf-token` (جهاز المالك)، ولا يُطبع أبداً.
