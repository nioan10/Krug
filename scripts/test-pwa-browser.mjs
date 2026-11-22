import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['tests/pwa-browser.cjs'], { env, stdio: 'inherit', windowsHide: true });
const timeout = setTimeout(() => { console.error('PWA browser test timed out'); child.kill(); }, 45000);
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
