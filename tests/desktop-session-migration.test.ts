import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepareMigration } = require('../desktop/session-migration.cjs');
const token = 'a'.repeat(43);
const origin = 'https://example.invalid';
const testRoot = resolve('.local');
mkdirSync(testRoot, { recursive: true });
const fetchFixture = async (url: string, options: any) => {
  assert.equal(url, `${origin}/api/desktop-migration/issue`);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Origin, origin);
  assert.equal(options.redirect, 'error');
  return { ok: true, json: async () => ({ token }) };
};

test('migration persists only the protected ticket and rejects unsafe inputs', async t => {
  const directory = mkdtempSync(join(testRoot, 'krug-migration-'));
  t.after(() => { rmSync(join(directory, 'migration.ticket'), { force: true }); rmdirSync(directory); });
  await prepareMigration({ origin, sessionFetch: fetchFixture, helper: 'fixture', directory,
    checkRuntime: async () => {},
    protect: async (_helper: string, actual: string) => { assert.equal(actual, token); return 'cHJvdGVjdGVk'; } });
  assert.equal(readFileSync(join(directory, 'migration.ticket'), 'utf8'), 'cHJvdGVjdGVk');
  await prepareMigration({ origin, directory, helper: 'fixture', checkRuntime: async () => {},
    sessionFetch: fetchFixture, protect: async () => 'bmV3dGlja2V0' });
  assert.equal(readFileSync(join(directory, 'migration.ticket'), 'utf8'), 'bmV3dGlja2V0');
  await assert.rejects(prepareMigration({ origin: 'http://example.invalid', sessionFetch: fetchFixture, directory }), /origin/);
  await assert.rejects(prepareMigration({ origin, directory, checkRuntime: async () => {}, sessionFetch: async () => ({ ok: true, json: async () => ({ token: 'bad' }) }) }), /response/);
  await assert.rejects(prepareMigration({ origin, directory, sessionFetch: fetchFixture, checkRuntime: async () => { throw new Error('runtime missing'); } }), /runtime missing/);
});

const helper = resolve('desktop/session-helper/bin/Release/net48/Krug.SessionHelper.exe');
test('migration helper encrypts a synthetic token via a pipe', { skip: process.platform !== 'win32' || !existsSync(helper) }, async t => {
  const directory = mkdtempSync(join(testRoot, 'krug-migration-helper-'));
  t.after(() => { rmSync(join(directory, 'migration.ticket'), { force: true }); rmdirSync(directory); });
  await prepareMigration({ origin, sessionFetch: fetchFixture, helper, directory, checkRuntime: async () => {} });
  const ticket = readFileSync(join(directory, 'migration.ticket'), 'utf8');
  assert.match(ticket, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(ticket.includes(token), false);
});
