# تعليمات العمل على هذا المشروع (أصالة نجد | نظام إدارة طلبات المجالس)

مشروع تطبيق ويب + خادم Cloudflare Worker (D1) + تطبيق أندرويد (PWA/APK عبر Capacitor).

## قاعدة النشر الدائمة (مهمة جداً)
عند إجراء **أي تعديل** ثم طلب المستخدم النشر (أو: انشره، اعمل النشر، حدّث كل شيء) — يجب تنفيذ **الثلاثة معاً**، مع **رفع رقم إصدار التطبيق** في كل مرة:

### 0) رفع الإصدار
- اقرأ آخر وسم (tag) موجود في المستودع (`git tag`)، وزد آخر رقم بواحد (مثال: من `v1.0.1` إلى `v1.0.2`).

### 1) Cloudflare — تحديث الموقع الحيّ
- يتطلب ملف `.cf-token` (رمز Cloudflare API). **الملف موجود ومحفوظ بشكل دائم — لا تحذفه ولا تسأل عن إنشائه** (قرار صريح من المستخدم في 2026-10-09). إن غاب فجأة فاطلب من المستخدم إعادة حفظه فيه، ولا تلصق الرمز في المحادثة.
- الوضع الافتراضي للسكربت **آمن**: `-Environment test` و`-Preview`، فلا يكتب شيئاً. التشغيل بلا معاملات **لا ينشر**، بل يفشل لأن أسماء الإنتاج ممنوعة في وضع الاختبار.
- **معاينة الإنتاج** (عرض الخطة فقط، بلا أي كتابة):
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1 -Environment production
  ```
- **النشر الإنتاجي الفعلي** (يطلب كتابة `yes` للتأكيد — يشغّل `schema.sql` أولاً ثم يرفع الكود):
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1 -Environment production -Preview:$false
  ```
- **بيئة اختبار منفصلة** (لا تمس الإنتاج؛ الأسماء ومعرّف الحساب إلزامية):
  ```powershell
  powershell -ExecutionPolicy Bypass -File deploy-cloudflare.ps1 -Environment test -AccountId <معرّف الحساب> -DbName <قاعدة اختبار> -WorkerName <Worker اختبار> -Preview:$false
  ```
- الرابط: `https://majlis-api.asalh-najd.workers.dev`
- **ترتيب القاعدة**: السكربت يشغّل `worker/schema.sql` (آمن للتكرار) قبل رفع الكود، ثم يفحص تعريفات `permission_audit` و`expenses` (قراءة فقط). إن توقف برسالة `Old definitions with blocking foreign keys` فالقاعدة طُبّقت عليها 001/002 القديمة: خذ نسخة احتياطية، وطبّق `worker/migrations/003_fix_user_delete_fks.sql` مرة واحدة، ثم أعد النشر. لم يُرفع أي كود عند التوقف. **تطبيق أي هجرة على الإنتاج يحتاج موافقة المستخدم الصريحة.**
- **متغيرات الـ Worker** تُضبط مرة واحدة من لوحة Cloudflare (Worker → Settings → Variables and Secrets)، والسكربت يحافظ عليها عند كل نشر ولا يكتب قيمها:
  - `ALLOWED_ORIGIN` (نص عادي، إلزامي): المصادر المسموح لها بالاتصال من خارج الموقع، مفصولة بفواصل. بدونه يُرفض تطبيق أندرويد. القيمة: `https://localhost` (تطبيق أندرويد) ويُضاف أي مصدر آخر يحتاجه الاتصال. `*` مرفوض عمداً.
  - `ADMIN_INIT_PASSWORD` (Secret): يلزم فقط عند تهيئة قاعدة بيانات **فارغة** — كلمة المرور المؤقتة لحساب `admin`، ويُفرض تغييرها عند أول دخول. لا تُكتب في أي ملف ولا في المحادثة.
  - `AI_API_KEY` (Secret) و`AI_BASE_URL` و`AI_MODEL`: اختيارية لبوت التصميم الذكي؛ بدونها يبقى معطلاً.

### 2) GitHub — رفع الكود
- أضف الملفات **بأسمائها** — لا `git add -A` (حتى لا تُرفع ملفات محلية أو مؤقتة):
```powershell
git add <الملفات المقصودة بأسمائها>
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
