// A local server .env may contain NODE_ENV=development. Release builds must still
// exercise the production React bundle and service worker, just like the VPS.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build();
await import('./build-sw.mjs');
