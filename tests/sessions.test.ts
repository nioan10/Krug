import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { TokenVerifier } from 'livekit-server-sdk';
import { buildApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import type { MediaService } from '../server/media.ts';

const origin = 'http://localhost:5173', password = 'test-password-that-is-long', invite = 'test-bootstrap-invite-with-32-characters';
const cfg = (path = ':memory:') => readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_PATH: path, LIVEKIT_API_KEY: 'test-api-key', LIVEKIT_API_SECRET: 'test-api-secret-long-enough-for-tests', BOOTSTRAP_INVITE: invite });
type App = Awaited<ReturnType<typeof buildApp>>;
const headers = (cookie: string) => ({ origin, cookie });
const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.map(c => `${c.name}=${c.value}`).join('; ');
async function appFor(t: { after: (fn: () => Promise<void>) => void }, media: Partial<MediaService> = {}, path?: string) {
  const app = await buildApp(cfg(path), { async deleteRoom() {}, async removeParticipant() {}, async participants() { return {}; }, ...media });
  t.after(() => app.close()); return app;
}
async function register(app: App, username: string, admin?: string) {
  let code = invite;
  if (admin) { const result = await app.inject({ method: 'POST', url: '/api/invites', headers: headers(admin) }); code = new URLSearchParams(new URL(result.json().url).hash.slice(1)).get('invite')!; }
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(''), payload: { username, displayName: username, password, invite: code } });
  assert.equal(response.statusCode, 201, response.body); return { cookie: cookieOf(response), user: response.json().user };
}
async function login(app: App, username: string) { const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...headers(''), 'user-agent': 'Test second device' }, payload: { username, password } }); assert.equal(r.statusCode, 200); return cookieOf(r); }
test('sessions are private, revocation closes only the selected session and removes stale media reconnects', async t => {
  const removals: string[] = []; let people: { identity: string; microphoneEnabled: boolean }[] = [];
  const app = await appFor(t, { async participants() { return { lounge: people }; }, async removeParticipant(_room, id) { removals.push(id); } });
  const owner = await register(app, 'owner'), other = await login(app, 'owner'), friend = await register(app, 'friend', owner.cookie);
  const list = (await app.inject({ url: '/api/sessions', headers: headers(owner.cookie) })).json();
  assert.equal(list.sessions.length, 2); assert.equal(list.sessions.filter((s: { current: number }) => s.current).length, 1);
  assert.ok(!JSON.stringify(list).includes('hash')); assert.ok(!JSON.stringify(list).includes(owner.cookie.split('=')[1]));
  const selected = list.sessions.find((s: { current: number }) => !s.current);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/sessions/${selected.id}`, headers: headers(friend.cookie) })).statusCode, 404);
  const tokens = await Promise.all([owner.cookie, other].map(cookie => app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(cookie) })));
  const verifier = new TokenVerifier(cfg().LIVEKIT_API_KEY, cfg().LIVEKIT_API_SECRET);
  const ids = await Promise.all(tokens.map(async r => (await verifier.verify(r.json().token)).sub!));
  assert.notEqual(ids[0], ids[1]); people = ids.map(identity => ({ identity, microphoneEnabled: true }));
  const ws = await app.injectWS('/api/events', { socket: { remoteAddress: '127.0.0.1' } as Socket, headers: headers(other) }); t.after(() => ws.terminate());
  const closed = new Promise<number>(resolve => ws.once('close', resolve));
  const revoke = await app.inject({ method: 'DELETE', url: `/api/sessions/${selected.id}`, headers: headers(owner.cookie) });
  assert.equal(revoke.statusCode, 200); assert.equal(await closed, 1008);
  assert.ok(removals.includes(ids[1])); assert.ok(!removals.includes(ids[0]));
  assert.equal((await app.inject({ url: '/api/me', headers: headers(other) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/me', headers: headers(owner.cookie) })).statusCode, 200);
  const before = removals.length; await new Promise(resolve => setTimeout(resolve, 3100)); assert.ok(removals.length > before);
});

test('expired sessions lose media access without an open websocket', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-sessions-')), path = join(directory, 'test.db');
  let identity = ''; const removed: string[] = [];
  const app = await appFor(t, { async participants() { return { lounge: identity ? [{ identity, microphoneEnabled: true }] : [] }; }, async removeParticipant(_room, id) { removed.push(id); } }, path);
  const owner = await register(app, 'owner');
  const token = (await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(owner.cookie) })).json().token;
  identity = (await new TokenVerifier(cfg().LIVEKIT_API_KEY, cfg().LIVEKIT_API_SECRET).verify(token)).sub!;
  const db = new DatabaseSync(path); t.after(() => db.close()); t.after(() => rmSync(directory, { recursive: true, force: true }));
  db.prepare('UPDATE sessions SET expiresAt=?').run(Date.now() - 1);
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.ok(removed.includes(identity));
  assert.equal((await app.inject({ url: '/api/me', headers: headers(owner.cookie) })).statusCode, 401);
});
