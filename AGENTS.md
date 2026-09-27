# تعليمات العمل على هذا المشروع (أصالة نجد | نظام إدارة طلبات المجالس)

مشروع تطبيق ويب + خادم Cloudflare Worker (D1) + تطبيق أندرويد (PWA/APK عبر Capacitor).

## قاعدة النشر الدائمة (مهمة جداً)
عند إجراء **أي تعديل** ثم طلب المستخدم النشر (أو: انشره، اعمل النشر، حدّث كل شيء) — يجب تنفيذ **الثلاثة معاً**، مع **رفع رقم إصدار التطبيق** في كل مرة:

### 0) رفع الإصدار
- اقرأ آخر وسم (tag) موجود في المستودع (`git tag`)، وزد آخر رقم بواحد (مثال: من `v1.0.1` إلى `v1.0.2`).

### 1) Cloudflare — تحديث الموقع الحيّ
- يتطلب ملف `.cf-token` (رمز Cloudflare API). إن لم يوجد، اطلب من المستخدم إنشاءه وحفظه في الملف، ولا تلصقه في المحادثة.
- الأمر:
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1
  ```
- الرابط: `https://majlis-api.asalh-najd.workers.dev`

### 2) GitHub — رفع الكود
```powershell
git add -A
git commit -m "<وصف مختصر بالعربية>"
git push origin main
```

### 3) بناء APK جديد + إصدار
- ادفع الوسم الجديد ليُبنى APK تلقائياً ويُنشر في Releases:
  ```powershell
  git tag v<الرقم الجديد>; git push origin v<الرقم الجديد>
  ```
- ملف APK: `asalh-najd.apk`
- المستودع: `https://github.com/ialshareef/majlis-orders`
- الإصدارات: `https://github.com/ialshareef/majlis-orders/releases`

## ملاحظات
- لا ترفع `.cf-token` أبداً (في `.gitignore`). احذفه بعد النشر.
- الوضع السحابي: البيانات في Cloudflare D1، والتطبيق يعمل دون اتصال (نسخة محلية) مع مزامنة.
- الـ Service Worker «الشبكة أولاً» لتعكس التحديثات فوراً.
- خادم محلي للتجربة: `powershell -ExecutionPolicy Bypass -File serve.ps1` (منفذ 8090).
