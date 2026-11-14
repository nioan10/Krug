import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

test('stream setup preserves private keys and routes, creates separate media credentials, refuses repeat setup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-stream-setup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  function setup(file: string, domains: string[]) { return spawnSync(process.execPath, [resolve(file), '--domain', domains[0], '--media-domain', domains[1], '--turn-domain', domains[2], '--public-ip', '203.0.113.10'], { cwd: directory, encoding: 'utf8' }); }
  assert.equal(setup('scripts/setup.mjs', ['chat.example.com', 'rtc.example.com', 'turn.example.com']).status, 0);
  const privateEnv = parseEnv(readFileSync(join(directory, '.env'), 'utf8'));
  const caddyBefore = JSON.parse(readFileSync(join(directory, 'deploy/caddy.json'), 'utf8'));
  const result = setup('scripts/setup-streams.mjs', ['stream.example.com', 'stream-rtc.example.com', 'stream-turn.example.com']);
  assert.equal(result.status, 0, result.stderr);
  const envText = readFileSync(join(directory, '.env'), 'utf8'), env = parseEnv(envText);
  for (const key of Object.keys(privateEnv)) assert.equal(env[key], privateEnv[key]);
  assert.notEqual(env.LIVEKIT_API_KEY, env.STREAM_LIVEKIT_API_KEY); assert.notEqual(env.LIVEKIT_API_SECRET, env.STREAM_LIVEKIT_API_SECRET);
  const caddy = JSON.parse(readFileSync(join(directory, 'deploy/caddy.json'), 'utf8'));
  assert.deepEqual(caddy.apps.http.servers.main.routes.slice(0, 2), caddyBefore.apps.http.servers.main.routes);
  assert.equal(caddy.apps.http.servers.main.routes.length, 4);
  assert.equal(caddy.apps.http.servers.main.listener_wrappers[0].routes[1].handle[1].upstreams[0].dial[0], '127.0.0.1:5350');
  assert.equal(caddy.apps.tls.certificates.automate.length, 6);
  assert.ok(env.STREAM_LIVEKIT_API_SECRET); assert.doesNotMatch(result.stdout, new RegExp(env.STREAM_LIVEKIT_API_SECRET));
  assert.equal(setup('scripts/setup-streams.mjs', ['stream.example.com', 'stream-rtc.example.com', 'stream-turn.example.com']).status, 1);
  assert.equal(readFileSync(join(directory, '.env'), 'utf8'), envText);
});
