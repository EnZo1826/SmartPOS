// EnZo POS — Service Worker v2.0
const CACHE_NAME = 'enzo-pos-v2';
const OFFLINE_URL = '/index.html';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Install — cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first for API, cache first for assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin API calls
  if (event.request.method !== 'GET') return;

  // For API sync calls — network only, fail gracefully
  if (url.pathname.includes('/api/') || url.pathname.includes('/sync/') || url.pathname.includes('/pos/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // App shell — cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(OFFLINE_URL));
    })
  );
});

// Background sync (when available)
self.addEventListener('sync', event => {
  if (event.tag === 'pos-sync') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'TRIGGER_SYNC' }));
      })
    );
  }
});

// Push notifications (optional)
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'EnZo POS', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-72.png'
    })
  );
});
