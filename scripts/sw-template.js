const CACHE = 'krug-static-__VERSION__';
const PRECACHE = __PRECACHE__;
const META = 'krug-update-metadata';
const PIN = '/__krug_active_version__';
const BOOTSTRAP = '/__krug_update_notice__.js';
async function pinnedCache() {
  const meta = await caches.open(META);
  const stored = await meta.match(PIN);
  const name = stored && await stored.text();
  const keys = await caches.keys();
  if (name && keys.includes(name)) return name;
  const previous = keys.filter(key => key.startsWith('krug-static-') && key !== CACHE).pop();
  const selected = previous || CACHE;
  await meta.put(PIN, new Response(selected));
  return selected;
}
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => { await pinnedCache(); await self.clients.claim(); })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_UPDATE') event.waitUntil((async () => {
    await (await caches.open(META)).put(PIN, new Response(CACHE));
    if (event.ports?.[0]) event.ports[0].postMessage({ applied: true });
    await self.skipWaiting();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Credentials, chat history, voice tokens and API responses must stay out of Cache Storage.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname === BOOTSTRAP) {
    event.respondWith((async () => (await caches.open(CACHE)).match(BOOTSTRAP) || fetch(event.request))());
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const pinned = await pinnedCache();
      const response = await (await caches.open(pinned)).match('/');
      if (!response) return fetch(event.request);
      if (pinned === CACHE) return response;
      // An activated worker can outlive all old tabs: keep the old app and offer an explicit update.
      const html = (await response.text()).replace('</head>', '<script defer src="' + BOOTSTRAP + '"></script></head>');
      const headers = new Headers(response.headers); headers.delete('content-length');
      return new Response(html, { status: response.status, statusText: response.statusText, headers });
    })());
    return;
  }
  event.respondWith((async () => (await caches.open(await pinnedCache())).match(url.pathname) || fetch(event.request))());
});
