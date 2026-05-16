/**
 * PBS Map — Service Worker
 */

const CACHE_NAME = 'pbsmap-v1';

const STATIC_ASSETS = [
  './home.html',
  './login.html',
  './index.html',
  './css/style.css',
  './css/home.css',
  './css/auth.css',
  './css/landing.css',
  './js/config.js',
  './js/db.js',
  './js/api.js',
  './js/meter-store.js',
  './js/meter-detail.js',
  './js/home.js',
  './img/favicon.svg',
  './img/icon-192.svg',
  './img/icon-512.svg',
  './img/default-avatar.svg',
  './img/h.svg',
  './img/s.svg',
  './img/irr.svg',
  './img/ind.svg',
  './img/com.svg',
  './img/char.svg',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { request } = e;

  // http/https এবং GET only
  if (!request.url.startsWith('http') || request.method !== 'GET') return;

  const url = new URL(request.url);

  // API calls — SW bypass, সরাসরি network
  if (url.pathname.startsWith('/api/')) return;

  // Map tiles (OSM) — SW bypass, IndexedDB তে আলাদাভাবে cache হয়
  if (url.hostname.includes('tile.openstreetmap.org')) return;

  // Same-origin: cache-first
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          // clone আগে, return পরে
          if (res.ok) {
            const toCache = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, toCache));
          }
          return res;
        }).catch(() => caches.match('./home.html'));
      })
    );
    return;
  }

  // External (Leaflet CDN, Google Fonts): network-first, cache fallback
  // opaque response (cross-origin no-cors) cache করা safe না — skip
  e.respondWith(
    fetch(request).then(res => {
      if (res.ok && res.type !== 'opaque') {
        const toCache = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, toCache));
      }
      return res;
    }).catch(() => caches.match(request))
  );
});
