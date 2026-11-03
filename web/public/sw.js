// Corral service worker — offline mode.
//
// Strategy per resource class:
//   navigations   network-first (3s), fallback to the cached shell
//   static assets cache-first (hash-named = immutable)
//   API GETs      network-first (3s), fallback to the last cached response
//   /api/events   pass-through (SSE — never cache a stream)
//   mutations     pass-through (network-only)
//
// Bump CACHE when the caching semantics change (not on every deploy — hashed
// assets and network-first navigations pick up new deploys automatically).

const CACHE = "corral-v1";
const SHELL = ["/"];
const TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function cachePut(request, response) {
  if (response && response.ok && request.method === "GET") {
    return caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
  }
  return Promise.resolve();
}

/** Network-first with timeout; fall back to cache (and optionally the shell). */
async function networkFirst(request, fallbackToShell) {
  try {
    const response = await fetchWithTimeout(request, TIMEOUT_MS);
    await cachePut(request, response);
    return response;
  } catch {
    const hit = await caches.match(request);
    if (hit) {
      // Mark the stale response so the UI can say "offline — cached data".
      const headers = new Headers(hit.headers);
      headers.set("X-Corral-Cache", "hit");
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
    if (fallbackToShell) {
      const shell = await caches.match("/");
      if (shell) return shell;
    }
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Corral-Cache": "miss" },
    });
  }
}

/** Cache-first for immutable, hash-named assets. */
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    await cachePut(request, response);
    return response;
  } catch {
    return new Response("", { status: 503, statusText: "offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // mutations: network-only
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin: browser default
  if (url.pathname === "/api/events") return; // SSE stream: never cache

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, false));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, true));
    return;
  }
  event.respondWith(cacheFirst(request));
});
