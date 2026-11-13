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
test('service worker never intercepts API, credentials or third-party requests; offline navigation uses static shell', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const shell = new Response('<html>static shell</html>');
  let fetches = 0;
  const context = {
    self: { location: { origin: 'https://chat.example.com' }, addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; } },
    URL,
    fetch: async () => { fetches++; throw new Error('offline'); },
    caches: { open: async () => ({ match: async (path: string) => path === '/' ? shell : undefined }) },
  };
  const source = readFileSync('scripts/sw-template.js', 'utf8').replace('__VERSION__', 'test').replace('__PRECACHE__', JSON.stringify(['/', '/index.html', '/assets/app.js']));
  vm.runInNewContext(source, context);
  for (const [url, method] of [['https://chat.example.com/api/me', 'GET'], ['https://chat.example.com/api/channels/lounge/voice-token', 'POST'], ['https://chat.example.com/api/channels/general/messages', 'GET'], ['https://media.example.com/rtc', 'GET']]) {
    handlers.fetch({ request: { url, method }, respondWith: () => assert.fail('Private or foreign request intercepted') });
  }
  assert.equal(fetches, 0);
  let response: Promise<Response> | undefined;
  handlers.fetch({ request: { url: 'https://chat.example.com/', method: 'GET', mode: 'navigate' }, respondWith: (p: Promise<Response>) => { response = p; } });
  assert.ok(response); assert.equal(await (await response).text(), '<html>static shell</html>');
});

test('explicit update requests keep the worker alive until activation has been requested', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  let activated = false; let lifetime: Promise<void> | undefined;
  vm.runInNewContext(readFileSync('scripts/sw-template.js', 'utf8').replace('__VERSION__', 'test').replace('__PRECACHE__', '[]'), {
    self: { addEventListener: (type: string, listener: (event: any) => void) => { handlers[type] = listener; }, skipWaiting: async () => { activated = true; } },
  });
  handlers.message({ data: { type: 'APPLY_UPDATE' }, waitUntil: (promise: Promise<void>) => { lifetime = promise; } });
  assert.ok(lifetime); await lifetime; assert.equal(activated, true);
});
