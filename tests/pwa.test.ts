import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('PWA manifest has standalone launch and valid PNG app icons', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((i: { sizes: string; purpose: string }) => i.sizes === `${size}x${size}` && i.purpose === 'any');
    assert.ok(icon);
    const png = readFileSync(`public${icon.src}`);
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  assert.ok(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable'));
});
test('service worker keeps the old shell across automatic activation until explicit approval', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    keys: async () => [...stores.keys()],
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return { match: async (key: string) => store.get(key)?.clone(), put: async (key: string, response: Response) => { store.set(key, response.clone()); } };
    },
  };
  (await caches.open('krug-static-old')).put('/', new Response('<html><head></head>old</html>'));
  (await caches.open('krug-static-new')).put('/', new Response('<html><head></head>new</html>'));
  let activated = false;
  let fetches = 0;
  vm.runInNewContext(readFileSync('scripts/sw-template.js', 'utf8').replace('__VERSION__', 'new').replace('__PRECACHE__', '[]'), {
    self: { location: { origin: 'https://chat.example.com' }, addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; }, clients: { claim: async () => {} }, skipWaiting: async () => { activated = true; } },
    URL, Response, Headers, caches, fetch: async () => { fetches++; throw new Error('offline'); },
  });
  let lifetime!: Promise<void>;
  handlers.activate({ waitUntil: (promise: Promise<void>) => { lifetime = promise; } }); await lifetime;
  for (const [url, method] of [['https://chat.example.com/api/me', 'GET'], ['https://chat.example.com/api/voice', 'POST'], ['https://media.example.com/rtc', 'GET']]) {
    handlers.fetch({ request: { url, method }, respondWith: () => assert.fail('Private or foreign request intercepted') });
  }
  const navigate = async () => { let response!: Promise<Response>; handlers.fetch({ request: { url: 'https://chat.example.com/', method: 'GET', mode: 'navigate' }, respondWith: (p: Promise<Response>) => { response = p; } }); return (await response).text(); };
  assert.match(await navigate(), /old/);
  assert.match(await navigate(), /__krug_update_notice__/);
  assert.equal(fetches, 0); assert.equal(activated, false);
  let acknowledged = false;
  handlers.message({ data: { type: 'APPLY_UPDATE' }, ports: [{ postMessage: () => { acknowledged = true; } }], waitUntil: (promise: Promise<void>) => { lifetime = promise; } });
  await lifetime;
  assert.equal(activated, true); assert.equal(acknowledged, true);
  assert.match(await navigate(), /new/);
  assert.ok(stores.has('krug-static-old'));
});

test('service worker fetches uncached microphone scripts and missing update notices, preserving cached responses', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const stored = new Map<string, Response>([['/cached.js', new Response('cached')]]);
  const requested: string[] = [];
  vm.runInNewContext(readFileSync('scripts/sw-template.js', 'utf8').replace('__VERSION__', 'test').replace('__PRECACHE__', '[]'), {
    self: { location: { origin: 'https://chat.example.com' }, addEventListener(type: string, handler: (event: any) => void) { handlers[type] = handler; } },
    URL, Response, Headers,
    caches: { keys: async () => ['krug-static-test'], open: async () => ({
      match: async (key: string) => stored.get(key)?.clone(),
      put: async (key: string, response: Response) => { stored.set(key, response); },
    }) },
    fetch: async (request: Request) => { requested.push(request.url); return new Response('network'); },
  });
  const read = async (path: string) => {
    let result!: Promise<Response>;
    handlers.fetch({ request: new Request(`https://chat.example.com${path}`), respondWith(response: Promise<Response>) { result = response; } });
    const response = await result;
    assert.ok(response instanceof Response, 'cache miss must resolve to a Response, not undefined');
    return response.text();
  };
  assert.equal(await read('/cached.js'), 'cached'); assert.deepEqual(requested, []);
  assert.equal(await read('/microphone-gate-worklet.js'), 'network');
  assert.equal(await read('/__krug_update_notice__.js'), 'network');
  assert.deepEqual(requested, ['https://chat.example.com/microphone-gate-worklet.js', 'https://chat.example.com/__krug_update_notice__.js']);
});
