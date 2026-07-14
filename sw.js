/*
 * Stellar Forge service worker — runtime caching, dependency-free (PWA §H.1.3).
 *
 * Strategy (engine-programmer spec):
 *   - Navigations / HTML  → NETWORK-FIRST (the anti-brick guarantee: every online launch pulls the
 *     fresh index.html + revalidates this worker, so a bad deploy self-heals; the cache is only used
 *     when the network genuinely fails — offline still works).
 *   - /assets/* hashed     → CACHE-FIRST (content-hashed → immutable → a hit is always correct).
 *   - other same-origin    → STALE-WHILE-REVALIDATE (manifest/icons — not hashed, so edits propagate).
 *   - non-GET / cross-origin / Range → pass through, never cache.
 *
 * Update policy: NO skipWaiting / NO clients.claim — a new worker waits until all tabs close before
 * activating. On GitHub Pages old hashed assets are purged on redeploy; claiming mid-session would let
 * a running old page reach for a purged hash and hard-fail. HTML is network-first, so the next cold
 * load gets the newest app anyway — no user-visible staleness cost.
 *
 * Base-agnostic: the worker sits at <base>sw.js, so `./` resolves to <base> ('/' locally,
 * '/stellar-forge-demo/' on Pages) — nothing is hardcoded.
 */
const BASE = new URL('./', self.location.href).pathname;
const CACHE = 'stellar-forge-v1'; // bump to force a hard flush (activate deletes non-current caches)
const START_URL = BASE;

self.addEventListener('install', (event) => {
  // Warm only the shell (the navigation root). Hashed chunks fill in on first load via cacheFirst —
  // no build-time precache manifest, and GLBs stay lazy (don't bloat the cold-install footprint).
  event.waitUntil(caches.open(CACHE).then((c) => c.add(START_URL)).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Guard first: mutations must hit network; cross-origin/opaque can't be validated and bloat quota;
  // the Cache API can't store a 206 partial.
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    request.headers.has('range')
  ) {
    return; // no respondWith → default browser fetch
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    // Only cache a genuine 200 — never a redeploy-window 404/500 or an opaqueredirect (which would
    // poison the offline shell so a later offline launch serves the error page). Matches the other two.
    if (fresh.ok && fresh.type !== 'opaqueredirect') void cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(request)) || (await cache.match(START_URL)) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const fetching = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fetching;
}
