// SendTemps service worker — v58.3
//
// Goal: SendTemps should still open at the crag with no signal. We precache
// the static shell on install and use a cache-first strategy for it. Forecast
// API calls go network-first with a cache fallback so we always show the
// freshest data when online and the last-known-good response when offline.
//
// Cache name is bumped per release so old shells get evicted on activate.

const CACHE = 'sendtemps-v64-10';

// Static shell — paths are app-relative so this works under the
// /sendtemps/ GitHub Pages prefix as well as a custom-domain root.
const SHELL = [
  './',
  './index.html',
  './app.js?v=65.0',
  './forecast.js?v=56',
  './crags.js?v=25',
  './style.css?v=63.6',
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

// Stable key for runtime cache — never deleted on SW update so cached
// forecast responses survive version bumps and rate-limit windows.
const RUNTIME_CACHE_STABLE = 'sendtemps-runtime-stable';

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        // Delete old shell caches but always keep the stable runtime cache
        .filter((k) => k !== CACHE && k !== RUNTIME_CACHE_STABLE)
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
  // Covers both the legacy direct Open-Meteo call and the current
  // Worker-proxied /forecast endpoint (api.sendtemps.app), since the app
  // now fetches forecasts through the Worker's edge cache instead of
  // calling Open-Meteo directly from the client.
  const isForecastCall = url.hostname === 'api.open-meteo.com'
    || (url.hostname === 'api.sendtemps.app' && url.pathname === '/forecast');
  if (isForecastCall) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(RUNTIME_CACHE_STABLE);
          cache.put(req, fresh.clone());
          return fresh;
        }
        // 429 rate-limit — serve cached data rather than showing an error
        if (fresh.status === 429) {
          const cached = await caches.match(req);
          if (cached) return cached;
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

  // Same-origin static shell.
  //
  // index.html (and the bare directory request) is treated NETWORK-FIRST so
  // a new build's HTML — which references the new versioned JS/CSS — is seen
  // immediately when online. We only fall back to cache when offline. This is
  // what unsticks the "stale shell" trap: a returning user always pulls the
  // freshest HTML, which then pulls the freshest assets via the bumped
  // ?v=NN query strings.
  //
  // Versioned assets (app.js?v=N, style.css?v=N, etc.) are cache-first with
  // background refresh — the query string changes per release so old entries
  // never collide with new ones, and the next visit gets the new file.
  if (url.origin === self.location.origin) {
    const isShellHtml = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');

    if (isShellHtml) {
      event.respondWith((async () => {
        try {
          const fresh = await fetch(req, { cache: 'no-store' });
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          // Last-ditch: try the cached root.
          const root = await caches.match('./');
          if (root) return root;
          throw _;
        }
      })());
      return;
    }

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

// ─── Web Push handlers ────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch { data = { title: 'SendTemps', body: event.data.text(), url: 'https://sendtemps.app/' }; }

  const title = data.title || 'SendTemps';
  const options = {
    body: data.body || '',
    icon: 'https://sendtemps.app/icon-192.png',
    badge: 'https://sendtemps.app/icon-192.png',
    data: { url: data.url || 'https://sendtemps.app/' },
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://sendtemps.app/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.startsWith('https://sendtemps.app'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
