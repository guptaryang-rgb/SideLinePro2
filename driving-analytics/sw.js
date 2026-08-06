// sw.js — network-first service worker for the Overtaker app shell, falling back to cache
// only when offline. Deliberately does NOT cache the TensorFlow.js / coco-ssd CDN scripts —
// those are left to the network and the browser's own HTTP cache.
//
// Bump CACHE_NAME whenever the app shell changes so browsers reliably pick up the new
// service worker (they only re-check when this file's own bytes differ) — but the
// network-first fetch strategy below means an app-shell update reaches users on their very
// next load even if this version bump is ever forgotten.

const CACHE_NAME = 'overtaker-v5';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app.js',
  '/js/detection.js',
  '/js/trip.js',
  '/js/motion.js',
  '/js/report.js',
  '/manifest.json',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
