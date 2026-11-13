import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const assets = readdirSync('dist/assets').map(file => `/assets/${file}`);
const version = createHash('sha256').update(readFileSync('dist/index.html')).update(assets.join(',')).digest('hex').slice(0, 12);
const precache = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', ...assets];
const source = readFileSync('scripts/sw-template.js', 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache));
writeFileSync('dist/sw.js', source);
console.log(`PWA: cached shell ${version}, ${precache.length} static files. API and messages are never cached.`);
