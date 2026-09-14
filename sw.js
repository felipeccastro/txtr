/* ============================================================================
   BINDERS — sw.js  (offline cache that still prefers the network)

   Installed as a PWA, Binders has to keep working with no connection (spec
   25) — but the whole point of shipping a change is that it reaches people,
   so offline is the fallback here, not the default. Every request goes to
   the network first; only a failed fetch (actually offline) falls back to
   whatever was cached last. Online, the newest file always wins, and the
   cache quietly catches up behind it for the next time there is no network.

   CACHE_NAME does not need bumping on every change — install() overwrites
   the same entries — but it is still a name, in case the caching strategy
   itself ever needs to change out from under old copies of this file.       */

const CACHE_NAME = 'binders-v1';
const CORE = ['./', './index.html', './scripts.js', './styles.css'];

self.addEventListener('install', (e) => {
  self.skipWaiting();   // don't wait for every open tab to close first
  // Promise.allSettled (not addAll, which is all-or-nothing): one bad
  // response — e.g. './' not resolving the way './index.html' does on
  // some hosts — must not sink the whole precache and leave nothing
  // cached for offline use.
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(CORE.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())   // take over any already-open tab
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
