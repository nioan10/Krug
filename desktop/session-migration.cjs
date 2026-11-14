const { spawn } = require('node:child_process');
const { mkdir, rename, unlink, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// Called only immediately before a WebView2 migration update, never for a
// normal Electron update. The short-lived credential stays out of arguments.
function checkWebViewRuntime(helper) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['--check-runtime'], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(false); }, 10000);
    timer.unref();
    function finish(ok) { if (settled) return; settled = true; clearTimeout(timer); ok ? resolve() : reject(new Error('WebView2 runtime unavailable')); }
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
  });
}

function protectTicket(helper, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['--protect'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let result = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('Session protection timed out')); }, 10000);
    timer.unref();
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result.trim());
    }
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', chunk => {
      result += chunk;
      if (result.length > 4096) { child.kill(); finish(new Error('Invalid protected session')); }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => finish(new Error('Session protection failed')));
    child.once('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.trim())) finish(new Error('Session protection failed'));
      else finish();
    });
    child.stdin.end(token + '\n');
  });
}

async function writeTicket(directory, ticket) {
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `migration-${randomBytes(12).toString('hex')}.tmp`);
  const destination = path.join(directory, 'migration.ticket');
  try {
    await writeFile(temporary, ticket, { encoding: 'ascii', flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function prepareMigration({ origin, sessionFetch, helper, directory, protect = protectTicket, checkRuntime = checkWebViewRuntime }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid migration origin');
  await checkRuntime(helper);
  const response = await sessionFetch(`${origin}/api/desktop-migration/issue`, {
    method: 'POST', credentials: 'include', headers: { Origin: origin }, redirect: 'error',
  });
  if (!response.ok) throw new Error('Session migration unavailable');
  const { token } = await response.json();
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid migration response');
  const ticket = await protect(helper, token);
  if (typeof ticket !== 'string' || ticket.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ticket)) throw new Error('Invalid protected session');
  await writeTicket(directory, ticket);
}

module.exports = { prepareMigration };
