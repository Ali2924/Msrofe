/* ==================================================================
   Service Worker — مصروفي
   يخزّن الملفات مؤقتاً ليعمل التطبيق بدون إنترنت
   ================================================================== */

const CACHE_NAME = 'mishwar-v2';
const CACHE_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

/* التثبيت: تخزين كل الملفات مسبقاً */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_FILES).catch(err => {
        console.warn('بعض الملفات لم تُخزّن:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

/* التنشيط: حذف النسخ القديمة */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* الجلب: Cache First مع تحديث في الخلفية */
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // تجاهل طلبات Apps Script (يجب أن تكون مباشرة)
  if (url.includes('script.google.com') || url.includes('googleusercontent.com')) {
    return;
  }

  // تجاهل طلبات POST
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
