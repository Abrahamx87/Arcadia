// Service worker de Arcadia: guarda la app para que abra rápido y funcione sin internet.
// Siempre pregunta primero al servidor si hay una versión nueva (sin usar copias viejas).
const CACHE = 'arcadia-v13';
const FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './css/app.css',
  './js/app.js', './js/engine.js', './js/effects.js', './js/store.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })          // revalida con GitHub: si cambió, baja lo nuevo
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
