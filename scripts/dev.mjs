import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!existsSync('.env')) { console.error('Сначала выполните node scripts/setup.mjs'); process.exit(1); }
const children = [];
const run = (command, args) => { const child = spawn(command, args, { stdio: 'inherit', windowsHide: true }); children.push(child); child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => { if (!stopping) stop(code || 0); }); };
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill(); process.exitCode = code; }
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
run(process.execPath, ['--env-file=.env', '--import', 'tsx', '--watch', 'server/index.ts']);
run(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1']);
const binary = process.platform === 'win32' ? '.local/bin/livekit-server.exe' : '.local/bin/livekit-server';
if (existsSync(binary)) run(binary, ['--config', 'deploy/livekit.yaml']);
else console.log('Чат запущен. Для голоса отдельно запустите livekit-server --config deploy/livekit.yaml (см. README).');
