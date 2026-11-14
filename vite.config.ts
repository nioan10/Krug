import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const desktopProject = readFileSync(new URL('./desktop/webview/desktop/Krug.Desktop.csproj', import.meta.url), 'utf8');
const productVersion = desktopProject.match(/<Version>([^<]+)<\/Version>/)?.[1];
if (!productVersion) throw new Error('Desktop product version is missing');

export default defineConfig({
  define: { __KRUG_VERSION__: JSON.stringify(productVersion) },
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', ws: true } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 1100 },
});
