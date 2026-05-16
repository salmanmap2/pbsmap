/**
 * PBS Map — Service Worker (minimal)
 * শুধু PWA install support — কোনো request intercept করে না
 */

const CACHE_NAME = 'pbsmap-v2';

self.addEventListener('install', e => {
  // পুরনো SW কে সরিয়ে সাথে সাথে active হও
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // সব পুরনো cache মুছে দাও
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// fetch handler নেই — কোনো request intercept হবে না
