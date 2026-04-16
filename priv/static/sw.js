// SPDX-FileCopyrightText: 2026 sTELgano Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// sTELgano Service Worker
//
// Privacy-first caching strategy:
//   - App shell (CSS, JS, fonts, images) — cache-first for fast loads
//   - Navigation & API requests — network-first, never cached
//   - Sensitive routes (/chat, /steg-number) — network-only, never cached
//   - Panic route (/x) — handled immediately, clears all caches

"use strict";

const CACHE_NAME = "stelgano-v2";

// App shell resources to pre-cache on install
const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/favicon.ico",
];

// Routes that must NEVER be cached (privacy-sensitive)
const NO_CACHE_PATHS = ["/chat", "/steg-number", "/admin", "/x"];

// ---------------------------------------------------------------------------
// Install — pre-cache app shell
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Activate immediately without waiting for old SW to finish
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate — clean up old caches
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open tabs immediately
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// Fetch — route-aware caching
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Panic route — clear everything and let the request through
  if (url.pathname === "/x") {
    event.respondWith(
      caches.delete(CACHE_NAME).then(() => fetch(event.request))
    );
    return;
  }

  if (NO_CACHE_PATHS.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(fetch(event.request).catch(() => {}));
    return;
  }

  // Never cache WebSocket upgrade or LiveView long-poll requests
  if (
    url.pathname.startsWith("/live") ||
    url.pathname.startsWith("/phoenix") ||
    url.pathname.startsWith("/socket")
  ) {
    return;
  }

  // Static assets (JS, CSS, images, fonts) — cache-first
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/images/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;

        return fetch(event.request).then((response) => {
          // Only cache successful responses
          if (!response || response.status !== 200) return response;

          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Navigation requests (HTML pages) — network-first with cache fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // If response is valid, update the cache and return it
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          }
          // If response is not valid (e.g. 404, 500), try fallback to cache
          return caches.match(event.request).then((cached) => cached || response);
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
