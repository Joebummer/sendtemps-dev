// SendTemps service worker — v57
//
// Goal: SendTemps should still open at the crag with no signal. We precache
// the static shell on install and use a cache-first strategy for it. Forecast
// API calls go network-first with a cache fallback so we always show the
// freshest data when online and the last-known-good response when offline.
//
// Cache name is bumped per release so old shells get evicted on activate.

const CACHE = 'sendtemps-v57';
const RUNTIME_CACHE = 'sendtemps-runtime-v57';

// Static shell — paths are app-relative so this works under the
// /sendtemps/ GitHub Pages prefix as well as a custom-domain root.
const SHELL = [
  './',
  './index.html',
  './app.js?v=57',
  './forecast.js?v=34',
  './crags.js?v=22',
  './style.css?v=29',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Forecast API — network-first so fresh data wins, fall back to last
  // successful response when offline so the UI still loads at the crag.
  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (_) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw _;
      }
    })());
    return;
  }

  // Same-origin static shell — cache-first with background refresh so the
  // app boots instantly and a new build streams in for next visit.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.ok) {
          caches.open(CACHE).then((cache) => cache.put(req, res.clone())).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
    return;
  }

  // Cross-origin (e.g. GoatCounter) — pass through; don't cache.
});
