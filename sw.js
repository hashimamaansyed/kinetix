/**
 * @file sw.js
 * @description KINETIX Service Worker — 100% Offline PWA Engine
 * Caches core application shell assets and provides seamless offline fallback
 * for local audio scanning, IndexedDB audio persistence, 5-band EQ, and 8D spatial DSP.
 */

const CACHE_NAME = 'kinetix-cache-v1';

// Core Application Shell Assets to Pre-cache on Install
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './index.css',
  './app.js',
  './audioEngine.js',
  './db.js',
  './storageScanner.js',
  './id3Parser.js',
  './manifest.json',
  './icon.svg'
];

// ─── Install Event: Pre-cache App Shell ───────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[KINETIX SW] Pre-caching offline application shell…');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// ─── Activate Event: Clean Legacy Caches & Claim Clients ──────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[KINETIX SW] Removing legacy cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// ─── Fetch Event (Offline-First with Dynamic Fallback) ─────────────────────────
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. Bypass non-HTTP schemes (blob:, mediastream:, data:, chrome-extension:)
  // Crucial: Keeps local audio Blobs & Web Audio streams fast and unintercepted
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // 2. Only cache GET requests
  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached shell asset immediately for offline instant start
        return cachedResponse;
      }

      // If not in cache, fetch from network and dynamically store in cache
      return fetch(request)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }

          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });

          return networkResponse;
        })
        .catch(() => {
          // If offline and navigating to a page, fall back to cached index.html
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});
