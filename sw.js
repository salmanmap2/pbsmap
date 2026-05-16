/**
 * PBS Map — Service Worker
 * Cache-first for static assets, network-first for API calls
 */

const CACHE_NAME = 'pbsmap-v1';

// Install এ static assets cache করো
const STATIC_ASSETS = [
  '/home.html',
  '/login.html',
  '/index.html',
  '/css/style.css',
  '/css/home.css',
  '/css/auth.css',
  '/css/landing.css',
  '/js/config.js',
  '/js/db.js',
  '/js/api.js',
  '/js/meter-store.js',
  '/js/meter-detail.js',
  '/js/home.js',
  '/img/favicon.svg',
  '/img/icon-192.svg',
  '/img/icon-512.svg',
  '/img/default-avatar.svg',
  '/img/h.svg',
  '/img/s.svg',
  '/img/irr.svg',
  '/img/ind.svg',
  '/img/com.svg',
  '/img/char.svg',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // পুরনো cache সরাও
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls — network first, offline এ fail gracefully
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ success: false, message: 'অফলাইন — সার্ভারে পৌঁছানো যাচ্ছে না।' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // External resources (Leaflet, fonts) — network first, cache fallback
  if (!url.origin.includes(self.location.origin)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets — cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
