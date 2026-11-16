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
import type { EncryptionDevice, EncryptionState, EncryptedEnvelope } from '../src/crypto-types.ts';
import { base64ToBytes, ciphertextHash, decryptBackup, decryptImage, encryptBackup, encryptImage, generateDeviceKey, openEnvelope, seal, sessionKeyFor, type SecretPayload } from '../src/e2ee-crypto.ts';

const origin = 'http://localhost:5173', password = 'test-password-that-is-long', invite = 'test-bootstrap-invite-with-32-characters';
const cfg = (path = ':memory:', mode: 'automatic' | 'manual' = 'automatic') => readConfig({ NODE_ENV: 'test', E2EE_MODE: mode, APP_ORIGIN: origin, DATABASE_PATH: path, LIVEKIT_API_KEY: 'test-api-key', LIVEKIT_API_SECRET: 'test-api-secret-long-enough-for-tests', BOOTSTRAP_INVITE: invite });
type App = Awaited<ReturnType<typeof buildApp>>;
const headers = (cookie: string) => ({ origin, cookie });
const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.map(c => `${c.name}=${c.value}`).join('; ');
async function appFor(t: { after: (fn: () => Promise<void>) => void }, media: Partial<MediaService> = {}, path?: string, mode: 'automatic' | 'manual' = 'automatic') {
  const app = await buildApp(cfg(path, mode), { async deleteRoom() {}, async removeParticipant() {}, async participants() { return {}; }, ...media });
  t.after(() => app.close()); return app;
}
async function register(app: App, username: string, admin?: string) {
  let code = invite;
  if (admin) { const result = await app.inject({ method: 'POST', url: '/api/invites', headers: headers(admin) }); code = new URLSearchParams(new URL(result.json().url).hash.slice(1)).get('invite')!; }
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(''), payload: { username, displayName: username, password, invite: code } });
  assert.equal(response.statusCode, 201, response.body); return { cookie: cookieOf(response), user: response.json().user };
}
async function login(app: App, username: string) { const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...headers(''), 'user-agent': 'Test second device' }, payload: { username, password } }); assert.equal(r.statusCode, 200); return cookieOf(r); }
async function device(app: App, cookie: string) {
  const key = await generateDeviceKey();
  const r = await app.inject({ method: 'POST', url: '/api/encryption/devices', headers: headers(cookie), payload: { publicKey: key.publicKey, label: 'Test' } });
  assert.equal(r.statusCode, 200, r.body); return { ...key, device: r.json().device as EncryptionDevice };
}
const state = async (app: App, cookie: string) => (await app.inject({ url: '/api/encryption', headers: headers(cookie) })).json<EncryptionState>();
const payload = (d: EncryptionDevice, roster: string, body = 'private text'): SecretPayload => ({ v: 1, kind: 'message', origin, channelId: 'general', roster, deviceId: d.id, userId: d.userId, clientId: crypto.randomUUID(), body });
const context = { origin, channelId: 'general', kind: 'message' as const };

test('voice access checks authenticate the session and report current key membership without exposing keys', async t => {
  const app = await appFor(t), owner = await register(app, 'owner');
  const url = '/api/channels/lounge/voice-access';
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: headers(owner.cookie) })).statusCode, 409);
  await device(app, owner.cookie);
  const access = await app.inject({ url, headers: headers(owner.cookie) });
  assert.deepEqual(access.json(), { enabled: true, roster: (await state(app, owner.cookie)).roster });
  assert.equal(access.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ url: '/api/channels/general/voice-access', headers: headers(owner.cookie) })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/channels/missing/voice-access', headers: headers(owner.cookie) })).statusCode, 404);
  const second = await login(app, 'owner'); await device(app, second);
  assert.notEqual((await app.inject({ url, headers: headers(owner.cookie) })).json().roster, access.json().roster);
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(second) });
  assert.equal((await app.inject({ url, headers: headers(second) })).statusCode, 401);
});

test('ordinary API traffic and another device behind the same IP cannot consume the call heartbeat budget', async t => {
  const app = await appFor(t), owner = await register(app, 'owner'); await device(app, owner.cookie);
  const second = await login(app, 'owner'); await device(app, second);
  let limited = false;
  for (let i = 0; i < 185; i++) {
    const response = await app.inject({ url: '/api/encryption', headers: headers(owner.cookie) });
    if (response.statusCode === 429) { limited = true; break; }
  }
  assert(limited);
  const url = '/api/channels/lounge/voice-access';
  for (let i = 0; i < 30; i++) assert.equal((await app.inject({ url, headers: headers(owner.cookie) })).statusCode, 200);
  assert.equal((await app.inject({ url, headers: headers(owner.cookie) })).statusCode, 429);
  assert.equal((await app.inject({ url, headers: headers(second) })).statusCode, 200);
  for (let i = 0; i < 30; i++) assert.equal((await app.inject({ url, headers: { cookie: `krug_session=fake-${i}`, 'x-forwarded-for': `198.51.100.${i}` } })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { cookie: 'krug_session=another-fake', 'x-forwarded-for': '198.51.100.250' } })).statusCode, 429);
});

test('server stores ciphertext only, rejects downgrade/replay/stale rosters and grants encrypted calls to the current session', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-e2ee-')); const path = join(directory, 'test.db');
  const app = await appFor(t, {}, path), owner = await register(app, 'owner'), friend = await register(app, 'friend', owner.cookie);
  const a = await device(app, owner.cookie), b = await device(app, friend.cookie);
  assert.equal((await state(app, owner.cookie)).enabled, true);
  assert.equal((await state(app, owner.cookie)).automatic, true);
  assert.equal((await app.inject({ url: '/api/encryption' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/encryption/enable', headers: headers(friend.cookie) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/encryption/enable', headers: headers(owner.cookie) })).statusCode, 200);
  const s = await state(app, owner.cookie), p = payload(a.device, s.roster, 'secret-only-on-clients');
  const envelope = await seal(p, a.privateKey, s.devices);
  const send = (cookie: string, body: object) => app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(cookie), payload: body });
  assert.equal((await send(owner.cookie, { body: p.body })).statusCode, 409);
  assert.equal((await send(friend.cookie, { encrypted: envelope })).statusCode, 403);
  const result = await send(owner.cookie, { encrypted: envelope }); assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.json().message.body, ''); assert.ok(!result.body.includes(p.body));
  assert.equal((await send(owner.cookie, { encrypted: envelope })).statusCode, 409);
  assert.equal((await openEnvelope(result.json().message.encrypted, [b.privateKey], a.device, context)).body, p.body);
  const db = new DatabaseSync(path); t.after(() => db.close()); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const row = db.prepare('SELECT body,encrypted FROM messages').get()!;
  assert.equal(row.body, ''); assert.ok(!String(row.encrypted).includes(p.body));
  const token = await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(owner.cookie), payload: { roster: s.roster } });
  assert.equal(token.statusCode, 200);
  const claims = await new TokenVerifier(cfg().LIVEKIT_API_KEY, cfg().LIVEKIT_API_SECRET).verify(token.json().token);
  assert.equal(claims.sub, a.device.identity); assert.equal(claims.video?.room, `lounge.e2ee.${s.roster}`);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(owner.cookie) })).statusCode, 400);
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(friend.cookie) });
  assert.notEqual((await state(app, owner.cookie)).roster, s.roster);
  assert.equal((await send(owner.cookie, { encrypted: { ...envelope, clientId: crypto.randomUUID() } })).statusCode, 409);
  assert.equal((await app.inject({ url: '/api/encryption', headers: headers(friend.cookie) })).statusCode, 401);
});

test('automatic E2EE is the default and enables existing installations without deleting their old history or sessions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-auto-e2ee-')); const path = join(directory, 'test.db');
  const media = { async deleteRoom() {}, async removeParticipant() {}, async participants() { return {}; } };
  const old = await buildApp(cfg(path, 'manual'), media);
  const owner = await register(old, 'owner');
  const posted = await old.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(owner.cookie), payload: { body: 'history before upgrade' } });
  assert.equal(posted.statusCode, 201);
  await old.close();
  const defaults = readConfig({ ...cfg(path), E2EE_MODE: undefined } as unknown as NodeJS.ProcessEnv);
  assert.equal(defaults.E2EE_MODE, 'automatic');
  const upgraded = await buildApp(defaults, media);
  t.after(async () => { await upgraded.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await state(upgraded, owner.cookie)).enabled, true);
  const legacy = (await upgraded.inject({ url: '/api/encryption/legacy-history', headers: headers(owner.cookie) })).json();
  assert.equal(legacy.remaining, 1);
  assert.equal(legacy.messages[0].body, 'history before upgrade');
  const rejected = await upgraded.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(owner.cookie), payload: { body: 'old client sending plaintext' } });
  assert.equal(rejected.statusCode, 409); assert.match(rejected.body, /Обновите приложение/);
});

test('new members receive the full old history through signed encrypted key grants without replacing original messages', async t => {
  const app = await appFor(t), owner = await register(app, 'owner');
  const a = await device(app, owner.cookie);
  await app.inject({ method: 'POST', url: '/api/encryption/enable', headers: headers(owner.cookie) });
  let s = await state(app, owner.cookie);
  const envelope = await seal(payload(a.device, s.roster, 'old history'), a.privateKey, s.devices);
  const posted = await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(owner.cookie), payload: { encrypted: envelope } });
  const message = posted.json().message;
  const newcomer = await register(app, 'newcomer', owner.cookie), b = await device(app, newcomer.cookie);
  s = await state(app, owner.cookie);
  await assert.rejects(openEnvelope(envelope, [b.privateKey], a.device, context));
  const needed = (await app.inject({ url: '/api/encryption/history-needed', headers: headers(owner.cookie) })).json();
  assert.deepEqual(needed.messages.map((m: { id: number }) => m.id), [message.id]);
  const grant: SecretPayload = { ...payload(a.device, s.roster, ''), kind: 'history', grant: { messageId: message.id, ciphertextHash: await ciphertextHash(envelope), key: await sessionKeyFor(envelope, [a.privateKey]), sender: a.device } };
  const encryptedGrant = await seal(grant, a.privateKey, s.devices);
  const put = await app.inject({ method: 'POST', url: `/api/messages/${message.id}/key-grants`, headers: headers(owner.cookie), payload: encryptedGrant });
  assert.equal(put.statusCode, 200, put.body);
  const available = (await app.inject({ url: `/api/messages/${message.id}/key-grants`, headers: headers(newcomer.cookie) })).json<{ grants: EncryptedEnvelope[] }>();
  assert.equal(available.grants.length, 1);
  const shared = await openEnvelope(available.grants[0], [b.privateKey], a.device, { ...context, kind: 'history' });
  assert.equal(shared.grant?.ciphertextHash, await ciphertextHash(envelope));
  assert.equal((await openEnvelope(envelope, [], shared.grant!.sender, context, base64ToBytes(shared.grant!.key))).body, 'old history');
  assert.deepEqual((await app.inject({ url: '/api/encryption/history-needed', headers: headers(owner.cookie) })).json().messages, []);
  assert.equal((await app.inject({ url: '/api/encryption/history-needed?retry=1', headers: headers(owner.cookie) })).json().messages.length, 1);
  assert.deepEqual((await app.inject({ url: '/api/channels/general/messages', headers: headers(owner.cookie) })).json().messages[0].encrypted, envelope);
});

test('legacy history migration preserves image bytes and message metadata, and cannot be performed by members', async t => {
  const app = await appFor(t, {}, undefined, 'manual'), owner = await register(app, 'owner'), friend = await register(app, 'friend', owner.cookie);
  const a = await device(app, owner.cookie), b = await device(app, friend.cookie);
  const raw = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const before = (await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(friend.cookie), payload: { body: 'old message', image: raw } })).json().message;
  assert.equal((await app.inject({ url: '/api/encryption/legacy-history', headers: headers(friend.cookie) })).statusCode, 403);
  const legacy = (await app.inject({ url: '/api/encryption/legacy-history', headers: headers(owner.cookie) })).json();
  assert.equal(legacy.remaining, 1); assert.equal(legacy.messages[0].id, before.id);
  await app.inject({ method: 'POST', url: '/api/encryption/enable', headers: headers(owner.cookie) });
  const s = await state(app, owner.cookie);
  const plain: SecretPayload = { ...payload(a.device, s.roster, before.body), migrationOf: before.id, originalAuthorId: before.user.id, originalCreatedAt: before.createdAt };
  const image = await encryptImage(base64ToBytes(raw), 'image/png', origin, 'general', plain.clientId); plain.image = image.descriptor;
  const encrypted = await seal(plain, a.privateKey, s.devices);
  const migrate = (cookie: string, withImage = true) => app.inject({ method: 'PUT', url: `/api/messages/${before.id}/encryption`, headers: headers(cookie), payload: { encrypted, ...(withImage ? { image: image.data } : {}) } });
  assert.equal((await migrate(friend.cookie)).statusCode, 403);
  assert.equal((await migrate(owner.cookie, false)).statusCode, 400);
  assert.equal((await migrate(owner.cookie)).statusCode, 200);
  assert.equal((await migrate(owner.cookie)).statusCode, 409);
  assert.equal((await app.inject({ url: '/api/encryption/legacy-history', headers: headers(owner.cookie) })).json().remaining, 0);
  const after = (await app.inject({ url: '/api/channels/general/messages', headers: headers(friend.cookie) })).json().messages[0];
  assert.equal(after.body, ''); assert.equal(after.user.id, before.user.id); assert.equal(after.createdAt, before.createdAt);
  assert.equal((await openEnvelope(after.encrypted, [b.privateKey], a.device, context)).body, before.body);
  const storedImage = await app.inject({ url: `/api/messages/${before.id}/image`, headers: headers(friend.cookie) });
  assert.equal(storedImage.headers['content-type'], 'application/octet-stream');
  const buffer = Uint8Array.from(storedImage.rawPayload).buffer;
  assert.deepEqual(new Uint8Array(await decryptImage(buffer, plain.image!, origin, 'general', plain.clientId)), base64ToBytes(raw));
});

test('rotating a call removes the old room connection without kicking the same session from its new room', async t => {
  let people: { identity: string; microphoneEnabled: boolean; room: string }[] = [];
  const removed: string[] = [];
  const app = await appFor(t, { async participants() { return { lounge: people }; }, async removeParticipant(room, identity) { removed.push(`${room}:${identity}`); } });
  const owner = await register(app, 'owner'), a = await device(app, owner.cookie);
  await app.inject({ method: 'POST', url: '/api/encryption/enable', headers: headers(owner.cookie) });
  const old = await state(app, owner.cookie);
  const friend = await register(app, 'friend', owner.cookie); await device(app, friend.cookie);
  const current = await state(app, owner.cookie);
  const oldRoom = `lounge.e2ee.${old.roster}`, newRoom = `lounge.e2ee.${current.roster}`;
  people = [oldRoom, newRoom].map(room => ({ room, identity: a.device.identity, microphoneEnabled: true }));
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.ok(removed.includes(`${oldRoom}:${a.device.identity}`));
  assert.ok(!removed.includes(`${newRoom}:${a.device.identity}`));
});

test('adding a device allows encrypted handover but revoking a key immediately invalidates that room', async t => {
  let people: { identity: string; microphoneEnabled: boolean; room: string }[] = [];
  const removed: string[] = [];
  const app = await appFor(t, { async participants() { return { lounge: people }; }, async removeParticipant(room) { removed.push(room); } });
  const owner = await register(app, 'owner'), a = await device(app, owner.cookie);
  const friend = await register(app, 'friend', owner.cookie), b = await device(app, friend.cookie);
  const before = await state(app, owner.cookie);
  const envelope = await seal({ ...payload(a.device, before.roster), kind: 'room', channelId: 'lounge', roomKey: 'A'.repeat(43) + '=' }, a.privateKey, before.devices);
  assert.equal((await app.inject({ method: 'POST', url: '/api/encryption/rooms/lounge', headers: headers(owner.cookie), payload: envelope })).statusCode, 200);
  const oldRoom = `lounge.e2ee.${before.roster}`;
  people = [{ identity: a.device.identity, room: oldRoom, microphoneEnabled: true }];
  const second = await login(app, 'owner'); await device(app, second);
  await new Promise(resolve => setTimeout(resolve, 3200)); assert(!removed.includes(oldRoom));
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(friend.cookie) });
  await new Promise(resolve => setTimeout(resolve, 3200)); assert(removed.includes(oldRoom));
});
