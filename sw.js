/* Camena service worker — makes the installed PWA resilient on flaky networks.
   Strategy:
     - Same-origin app files (index.html, styles.css, js/*): network-first, so testers
       always get the latest build; fall back to cache only when offline.
     - Cross-origin (versioned CDN libs, Google Fonts — all immutable URLs):
       cache-first, so the ~1.5MB of ML JS is fetched once and then served locally.
   Nothing here touches user media: photos are handled as in-memory blob/object URLs,
   never http(s) requests, so they are never seen or cached by this worker. */
const CACHE = 'camena-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const crossOrigin = new URL(req.url).origin !== self.location.origin;

  if (crossOrigin) {
    // Immutable CDN libs + fonts: cache-first.
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Same-origin app shell: network-first (keep cache warm as an offline fallback).
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(m => m || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
