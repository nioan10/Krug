// Real Chromium + production service worker + AudioWorklet. No hardware capture or accounts.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'krug-pwa-test-')));
const root = path.resolve('dist');
let requests = 0, blockWorklet = false, window;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/qa.html') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>PWA microphone test</title>'); }
  if (pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"live":true}'); }
  if (pathname === '/microphone-gate-worklet.js') { requests++; if (blockWorklet) { res.writeHead(503); return res.end(); } }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
const run = code => window.webContents.executeJavaScript(`(async()=>{${code}})()`, true);
const worklet = `const context = new AudioContext(); try { await context.audioWorklet.addModule('/microphone-gate-worklet.js'); const gate = new AudioWorkletNode(context, 'krug-microphone-gate'); gate.port.close(); return true; } finally { await context.close(); }`;
(async () => {
  try {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, partition: 'krug-pwa-test', backgroundThrottling: false } });
    await window.loadURL(`http://127.0.0.1:${server.address().port}/qa.html`);
    await run(`await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true})); return true;`);
    assert.equal(requests, 1, 'microphone worklet must be precached during installation');
    blockWorklet = true;
    assert.equal(await run(worklet), true, 'cached processor must initialize with unavailable network');
    assert.equal(requests, 1, 'cached microphone must not use the network');
    blockWorklet = false;
    await run(`for (const name of await caches.keys()) if (name.startsWith('krug-static-')) await (await caches.open(name)).delete('/microphone-gate-worklet.js'); return true;`);
    assert.equal(await run(worklet), true, 'uncached processor must initialize through network fallback');
    assert.equal(requests, 2, 'a cache miss must reach the server');
    assert.equal(await run(`return (await (await fetch('/api/test')).json()).live;`), true);
    console.log('PASS production service worker: cached and uncached AudioWorklet initializes; API bypasses cache');
    window.destroy(); server.close(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); server.close(); app.exit(1); }
})();
