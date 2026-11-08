// Service worker: guarda la app para que abra rápido y funcione sin internet.
const CACHE = 'arcadia-v2';
const FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './css/app.css',
  './js/app.js', './js/engine.js', './js/effects.js', './js/store.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Primero la red (para ver los cambios nuevos al instante); si no hay internet, la copia guardada.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
