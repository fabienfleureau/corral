// Corral service worker — offline mode.
//
// Strategy per resource class:
//   navigations   network-first (3s), fallback to the cached shell
//   static assets cache-first (hash-named = immutable)
//   API GETs      network-first, fallback to the last cached response
//   /api/events   pass-through (SSE — never cache a stream)
//   mutations     pass-through (network-only)
//
// An API GET is never abandoned early: a slow endpoint is a slow answer, not an
// outage. Cutting every API read off at 3s fabricated `503 {"error":"offline"}`
// for healthy servers whenever a request took a bit long (usage quota, session
// list, tasks with per-session lookups). Only a real network failure falls back
// to the cache, and with no cached copy the request fails like any other
// offline request instead of inventing a response.
//
// Bump CACHE when the caching semantics change (not on every deploy — hashed
// assets and network-first navigations pick up new deploys automatically).

const CACHE = "corral-v4";
const SHELL = ["/"];
/** Navigations: past this, showing the cached shell beats a white screen. */
const NAV_TIMEOUT_MS = 3000;
/** API reads: backstop against a socket that never settles, nothing more. */
const API_TIMEOUT_MS = 60_000;

/** Hashed JS/CSS the shell references: precached so the first offline
 *  reload works (on first visit they load before this worker controls the page). */
function shellAssets(html) {
  const urls = new Set();
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)) {
    const url = new URL(m[1], self.location.origin);
    if (url.origin === self.location.origin && /\.(?:js|css)$/.test(url.pathname)) urls.add(url.pathname);
  }
  return [...urls];
}

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  try {
    const shell = await cache.match("/");
    const assets = shell ? shellAssets(await shell.text()) : [];
    await Promise.all(assets.map((a) => cache.add(a).catch(() => undefined)));
  } catch {
    /* assets get cached on use instead */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** fetch() bounded by a real abort: a request we stop waiting for must also
 *  stop consuming a socket and server work. */
async function fetchTimed(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Best effort: a full or failing cache must never discard a good response. */
function cachePut(request, response) {
  if (response && response.ok && request.method === "GET") {
    const copy = response.clone();
    return caches
      .open(CACHE)
      .then((cache) => cache.put(request, copy))
      .catch(() => undefined);
  }
  return Promise.resolve();
}

/** A cached response, marked so the UI can say "offline — cached data". */
function staleCopy(hit) {
  const headers = new Headers(hit.headers);
  headers.set("X-Corral-Cache", "hit");
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

/** Network-first with a bounded wait; fall back to cache (and optionally the
 *  shell). Returns a network error — never a made-up 503 — when nothing is
 *  cached and the network is really down. */
async function networkFirst(request, { timeoutMs, shell }) {
  try {
    const response = await fetchTimed(request, timeoutMs);
    await cachePut(request, response);
    return response;
  } catch {
    const hit = await caches.match(request);
    if (hit) return staleCopy(hit);
    if (shell) {
      const cachedShell = await caches.match("/");
      if (cachedShell) return cachedShell;
    }
    return Response.error();
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
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin: browser default

  // Mutations are network-only; on success, drop cached API responses so the
  // next read reflects the new server state instead of a stale snapshot.
  if (request.method !== "GET") {
    if (url.pathname.startsWith("/api/")) {
      event.respondWith(
        (async () => {
          const response = await fetch(request);
          if (response.ok) {
            try {
              const cache = await caches.open(CACHE);
              const keys = await cache.keys();
              await Promise.all(
                keys
                  .filter((k) => new URL(k.url).pathname.startsWith("/api/"))
                  .map((k) => cache.delete(k)),
              );
            } catch {
              /* cache invalidation is best effort */
            }
          }
          return response;
        })(),
      );
    }
    return;
  }

  if (url.pathname === "/api/events") return; // SSE stream: never cache

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, { timeoutMs: API_TIMEOUT_MS, shell: false }));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, { timeoutMs: NAV_TIMEOUT_MS, shell: true }));
    return;
  }
  event.respondWith(cacheFirst(request));
});
