// Service worker: permite abrir la app sin señal. Los datos (API) nunca se guardan aquí;
// los conteos sin enviar viven en el teléfono y se mandan al recuperar la señal.
const CACHE = 'mz-v1';
const BASE = ['/', '/manifest.webmanifest', '/icono.svg', '/icono-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Primero la red (para recibir siempre la versión nueva); si no hay señal, lo guardado
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request.mode === 'navigate' ? '/' : e.request, copia)); }
      return r;
    }).catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request).then(r => r || caches.match('/')))
  );
});
