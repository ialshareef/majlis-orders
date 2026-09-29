/* ======================================================================
   Service Worker — يجعل التطبيق يعمل دون اتصال ويُثبَّت على الجهاز.
   - الشبكة أولاً: تعكس التحديثات فوراً، والكاش احتياطي عند انقطاع الاتصال.
   - لا يخزّن طلبات /api/* (بيانات حيّة من الخادم).
   ====================================================================== */
const CACHE = 'majlis-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/store.js',
  '/js/designer.js',
  '/js/update.js',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // بيانات الخادم تبقى حيّة: لا تُخزَّن ولا يُقدَّم لها نسخة قديمة
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error()))
  );
});
