import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const assets = readdirSync('dist/assets').map(file => `/assets/${file}`);
const template = readFileSync('scripts/sw-template.js', 'utf8');
const version = createHash('sha256').update(readFileSync('dist/index.html')).update(assets.join(',')).update(readFileSync('dist/microphone-gate-worklet.js')).update(template).digest('hex').slice(0, 12);
const precache = ['/__krug_update_notice__.js', '/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/microphone-gate-worklet.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', ...assets];
const source = template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache));
writeFileSync('dist/sw.js', source);
console.log(`PWA: cached shell ${version}, ${precache.length} static files. API and messages are never cached.`);
