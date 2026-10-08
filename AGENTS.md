# تعليمات العمل على هذا المشروع (أصالة نجد | نظام إدارة طلبات المجالس)

مشروع تطبيق ويب + خادم Cloudflare Worker (D1) + تطبيق أندرويد (PWA/APK عبر Capacitor).

## قاعدة النشر الدائمة (مهمة جداً)
عند إجراء **أي تعديل** ثم طلب المستخدم النشر (أو: انشره، اعمل النشر، حدّث كل شيء) — يجب تنفيذ **الثلاثة معاً**، مع **رفع رقم إصدار التطبيق** في كل مرة:

### 0) رفع الإصدار
- اقرأ آخر وسم (tag) موجود في المستودع (`git tag`)، وزد آخر رقم بواحد (مثال: من `v1.0.1` إلى `v1.0.2`).

### 1) Cloudflare — تحديث الموقع الحيّ
- يتطلب ملف `.cf-token` (رمز Cloudflare API). **الملف موجود ومحفوظ بشكل دائم — لا تحذفه ولا تسأ�� عن إنشائه** (قرار صريح من المستخدم في 2026-10-09). إن غاب فجأة فاطلب من المستخدم إعادة حفظه فيه، ولا تلصق الرمز في المحادثة.
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
- ملف APK: `asalh-najd-<الإصدار>.apk` (مثال: `asalh-najd-1.0.6.apk` — اسم الملف يتضمّن رقم الإصدار للتمييز).
- المستودع: `https://github.com/ialshareef/majlis-orders`
- الإصدارات: `https://github.com/ialshareef/majlis-orders/releases`

## ملاحظات
- لا ترفع `.cf-token` أبداً (مُدرج في `.gitignore` عند السطر 2). **يُحفظ في الجهاز ولا يُحذف** بقرار المستخدم — الحذف بعد النشر ملغى.
- الوضع السحابي: البيانات في Cloudflare D1، والتطبيق يعمل دون اتصال (نسخة محلية) مع مزامنة.
- الـ Service Worker «الشبكة أولاً» لتعكس التحديثات فوراً.
- خادم محلي للتجربة: `powershell -ExecutionPolicy Bypass -File serve.ps1` (منفذ 8090).
