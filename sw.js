/* sw.js — BulkBGRemover service worker (installable, offline-capable PWA).
   Caches only our own app shell (HTML/CSS/JS/icons). Deliberately passes through
   the cross-origin AI model + Transformers.js (they cache themselves) and Firebase
   (must hit the network to verify keys), plus anything that isn't a GET.
   Strategy: navigations → network-first (fresh online, cached shell offline);
   same-origin static assets → stale-while-revalidate. */

// Bump on every deploy that changes the shell files → old caches are dropped
// and users pick up the new HTML/CSS/JS.
const CACHE_VERSION = 'bulkbg-shell-v2';

// Core files to have ready before the first offline load; everything else is
// cached lazily on first request.
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/bg-engine.js',
  './js/image-utils.js',
  './js/keys.js',
  './js/duration.js',
  './js/firebase-config.js',
  './favicon.svg',
  './site.webmanifest',
];

// A same-origin GET response we're allowed to store. Skip opaque/errored
// responses and partial (206) range responses — caching those corrupts reuse.
function isCacheable(response) {
  return response && response.ok && response.status === 200 && response.type === 'basic';
}

self.addEventListener('install', (event) => {
  // Take over as soon as installed rather than waiting for all tabs to close.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // allSettled, not addAll: one missing file must not fail the whole install.
      Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => (isCacheable(res) ? cache.put(url, res.clone()) : null))
            .catch(() => null)
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache from a previous version so stale shell files go away.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever intercept GETs; POST/PUT (none here today) go straight to network.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (CDN model, jsDelivr, Firebase/Firestore) → don't touch it.
  // Transformers.js manages the model cache; Firestore must reach the network.
  if (url.origin !== self.location.origin) return;

  // Full-page navigations: network-first so an online user always gets fresh
  // HTML, but a cached shell keeps the app usable offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (isCacheable(fresh)) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch (_) {
          // Offline: serve the cached page, then the cached shell as a fallback.
          const cached = (await caches.match(request)) || (await caches.match('./index.html'));
          if (cached) return cached;
          return new Response('Offline — open this page once while online to enable offline use.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate. Serve from cache at once
  // (instant), and refresh the cached copy in the background for next time.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (isCacheable(res)) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })()
  );
});
