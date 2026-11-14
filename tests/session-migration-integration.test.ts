import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';

const require = createRequire(import.meta.url);
const { prepareMigration } = require('../desktop/session-migration.cjs');
const helper = resolve('desktop/session-helper/bin/Release/net48/Krug.SessionHelper.exe');
const reader = resolve('tests/session-ticket/bin/Debug/net48/SessionTicket.Tests.exe');

test('synthetic account survives encrypted single-use migration between desktop hosts',
  { skip: process.platform !== 'win32' || !existsSync(helper) || !existsSync(reader) }, async t => {
    const origin = 'https://example.invalid';
    const bootstrap = 'test-only-bootstrap-invite-32-characters-long';
    const config = readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_PATH: ':memory:', LIVEKIT_API_KEY: 'test-api-key', LIVEKIT_API_SECRET: 'test-api-secret-long-enough-for-tests', BOOTSTRAP_INVITE: bootstrap });
    const app = await buildApp(config, { async deleteRoom() {}, async participants() { return {}; } });
    t.after(() => app.close());
    const owner = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin }, payload: { username: 'owner', displayName: 'Owner', password: 'Testing-a-long-password-123!', invite: bootstrap } });
    assert.equal(owner.statusCode, 201);
    const oldCookie = owner.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const base = resolve('.local'); mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, 'migration-e2e-'));
    t.after(() => { rmSync(join(directory, 'migration.ticket'), { force: true }); rmdirSync(directory); });
    await prepareMigration({ origin, helper, directory, checkRuntime: async () => {}, sessionFetch: async (_url: string, options: { method: 'POST' }) => {
      const response = await app.inject({ method: options.method, url: '/api/desktop-migration/issue', headers: { origin, cookie: oldCookie } });
      return { ok: response.statusCode === 200, json: async () => response.json() };
    } });
    const protectedTicket = readFileSync(join(directory, 'migration.ticket'), 'utf8');
    const token = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(reader, ['--unprotect-synthetic'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
      child.once('error', reject); child.once('close', code => code === 0 ? resolveResult(output.trim()) : reject(new Error('Synthetic ticket could not be opened')));
      child.stdin.end(protectedTicket + '\n');
    });
    const result = await app.inject({ method: 'POST', url: '/api/desktop-migration/redeem', headers: { origin }, payload: { token } });
    assert.equal(result.statusCode, 200);
    const newCookie = result.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    assert.notEqual(newCookie, oldCookie);
    assert.equal((await app.inject({ url: '/api/me', headers: { origin, cookie: newCookie } })).json().user.username, 'owner');
    assert.equal((await app.inject({ method: 'POST', url: '/api/desktop-migration/redeem', headers: { origin }, payload: { token } })).statusCode, 401);
  });
