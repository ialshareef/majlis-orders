# تعليمات العمل على هذا المشروع (أصالة نجد | نظام إدارة طلبات المجالس)

مشروع تطبيق ويب + خادم Cloudflare Worker (D1) + تطبيق أندرويد (PWA/APK عبر Capacitor).

## قاعدة النشر (مهمة جداً)
عندما يطلب المستخدم **"النشر"** (أو: انشره، اعمل نشر، نشر) — يجب النشر في **المكانين معاً**، لا مكان واحد:

### 1) Cloudflare — تحديث الموقع الحيّ
- يتطلب ملف `.cf-token` (رمز Cloudflare API). إن لم يوجد، اطلب من المستخدم إنشاءه وحفظه في الملف، ولا تلصقه في المحادثة.
- الأمر:
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1
  ```
- الرابط الناتج: `https://majlis-api.asalh-najd.workers.dev`

### 2) GitHub — رفع الكود + بناء APK + إصدار
- Commit + push إلى فرع `main` (يُشغّل GitHub Actions تلقائياً لبناء APK):
  ```powershell
  git add -A
  git commit -m "<وصف مختصر بالعربية>"
  git push origin main
  ```
- لإنشاء **إصدار (Release) جديد** يحتوي APK: ادفع وسماً جديداً (مثل v1.0.1):
  ```powershell
  git tag v1.0.1; git push origin v1.0.1
  ```
- المستودع: `https://github.com/ialshareef/majlis-orders`
- صفحة الإصدارات: `https://github.com/ialshareef/majlis-orders/releases`

## ملاحظات
- اسم ملف APK النهائي: `asalh-najd.apk` (يُبنى تلقائياً في Releases عند دفع وسم `v*`).
- لا ترفع `.cf-token` أبداً (موجود في `.gitignore`).
- الوضع السحابي: البيانات في Cloudflare D1، والتطبيق يعمل دون اتصال (نسخة محلية) مع مزامنة عند الاتصال.
- خادم محلي للتجربة: `powershell -ExecutionPolicy Bypass -File serve.ps1` (منفذ 8090).
