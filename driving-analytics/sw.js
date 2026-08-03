// sw.js — minimal cache-first service worker for the Overtaker app shell.
// Deliberately does NOT cache the TensorFlow.js / coco-ssd CDN scripts —
// those are left to the network and the browser's own HTTP cache.

const CACHE_NAME = 'overtaker-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app.js',
  '/js/detection.js',
  '/js/trip.js',
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
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => cached);
    })
  );
});
