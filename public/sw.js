/*
 * Air3 Live service worker.
 * Purpose: satisfy PWA installability + cache the app shell so the pages open
 * instantly and survive brief offline blips. We deliberately DO NOT cache the
 * signaling/WebRTC traffic — only the static shell.
 *
 * Network-first for navigations (so config/code updates land immediately),
 * cache-first for the static shell assets.
 */
const CACHE = 'air3-live-v1';
const SHELL = [
  './',
  './index.html',
  './broadcaster.html',
  './viewer.html',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept cross-origin (signaling / ice-config / TURN) requests.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network-first for pages so updates are picked up promptly.
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
