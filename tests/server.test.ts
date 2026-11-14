import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Socket } from 'node:net';
import { TokenVerifier } from 'livekit-server-sdk';
import { buildApp as createApp } from '../server/app.ts';
import type { MediaService } from '../server/media.ts';
import { readConfig } from '../server/config.ts';
import { digest, hashPassword, verifyPassword } from '../server/security.ts';

const origin = 'http://localhost:5173';
const bootstrap = 'test-only-bootstrap-invite-32-characters-long';
const password = 'Testing-a-long-password-123!';
const config = (path = ':memory:') => readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_PATH: path, LIVEKIT_API_KEY: 'test-api-key', LIVEKIT_API_SECRET: 'test-api-secret-long-enough-for-tests', BOOTSTRAP_INVITE: bootstrap });
const buildApp = (cfg: ReturnType<typeof config>, media: Partial<MediaService> = {}) => createApp(cfg, { async deleteRoom() {}, async participants() { return {}; }, ...media });
type App = Awaited<ReturnType<typeof buildApp>>;
const headers = (cookie = '') => ({ origin, cookie });
const testSocket = { remoteAddress: '127.0.0.1' } as Socket;
const cookieOf = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map(c => `${c.name}=${c.value}`).join('; ');
async function owner(app: App) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(), payload: { username: 'owner', displayName: 'Владелец', password, invite: bootstrap } });
  assert.equal(response.statusCode, 201, response.body); return cookieOf(response);
}
async function member(app: App, admin: string, username = 'member') {
  const invite = await app.inject({ method: 'POST', url: '/api/invites', headers: headers(admin) });
  assert.equal(invite.statusCode, 201);
  const token = new URLSearchParams(new URL(invite.json().url).hash.slice(1)).get('invite');
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(), payload: { username, displayName: username, password, invite: token } });
  assert.equal(response.statusCode, 201, response.body); return cookieOf(response);
}

test('images are private, persist with their messages and are deleted with them', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  const admin = await owner(app);
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const sent = await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(admin), payload: { body: '', image } });
  assert.equal(sent.statusCode, 201, sent.body);
  const message = sent.json().message;
  assert.equal(message.image, true);
  assert.equal((await app.inject(`/api/messages/${message.id}/image`)).statusCode, 401);
  const fetched = await app.inject({ url: `/api/messages/${message.id}/image`, headers: headers(admin) });
  assert.equal(fetched.statusCode, 200); assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(fetched.rawPayload, Buffer.from(image, 'base64'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(admin), payload: { body: '', image: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64') } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/messages/${message.id}`, headers: headers(admin) })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/messages/${message.id}/image`, headers: headers(admin) })).statusCode, 404);
});

test('member directory requires a session and returns only public fields, including offline members', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  assert.equal((await app.inject('/api/users')).statusCode, 401);
  const admin = await owner(app);
  await member(app, admin);
  const users = (await app.inject({ url: '/api/users', headers: headers(admin) })).json().users;
  assert.equal(users.length, 2);
  assert.deepEqual(Object.keys(users[0]).sort(), ['displayName', 'id', 'role', 'username']);
  assert.ok(users.some((person: { username: string }) => person.username === 'member'));
});

test('desktop update files require a short-lived update-only token and a safe filename', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'krug-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'latest.yml'), 'version: 0.1.1\npath: Krug-Setup-0.1.1.exe\n');
  writeFileSync(join(dir, 'Krug-Setup-0.1.1.exe'), 'fixture');
  const app = await buildApp({ ...config(), DESKTOP_UPDATE_DIR: dir }); t.after(() => app.close());
  assert.equal((await app.inject('/api/desktop-updates/access')).statusCode, 401);
  assert.equal((await app.inject('/api/desktop-updates/latest.yml')).statusCode, 401);
  assert.equal((await app.inject('/api/desktop-installer')).statusCode, 401);
  const admin = await owner(app);
  const download = await app.inject({ url: '/api/desktop-installer', headers: headers(admin) });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, 'fixture');
  assert.match(download.headers['content-disposition'] as string, /attachment/);
  const token = (await app.inject({ url: '/api/desktop-updates/access', headers: headers(admin) })).json().token as string;
  const authorization = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ url: '/api/desktop-updates/latest.yml', headers: authorization })).body, 'version: 0.1.1\npath: Krug-Setup-0.1.1.exe\n');
  assert.equal((await app.inject({ url: '/api/desktop-updates/Krug-Setup-0.1.1.exe', headers: authorization })).body, 'fixture');
  assert.equal((await app.inject({ url: '/api/desktop-updates/secret.txt', headers: authorization })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/channels', headers: authorization })).statusCode, 401);
  writeFileSync(join(dir, 'latest.yml'), 'path: ../../secret.exe\n');
  assert.equal((await app.inject({ url: '/api/desktop-installer', headers: headers(admin) })).statusCode, 503);
  const webviewManifest = 'version: 0.3.0\npath: Krug-Setup-0.3.0.exe\nkrugRuntime: webview2\n';
  writeFileSync(join(dir, 'latest.yml'), webviewManifest);
  assert.equal((await app.inject({ url: '/api/desktop-updates/latest.yml', headers: authorization })).statusCode, 404);
  const legacyManifest = 'version: 0.2.0\npath: Krug-Setup-0.2.0.exe\n';
  writeFileSync(join(dir, 'legacy.yml'), legacyManifest);
  assert.equal((await app.inject({ url: '/api/desktop-updates/latest.yml', headers: authorization })).body, legacyManifest);
  const capable = (await app.inject({ url: '/api/desktop-updates/access', headers: { ...headers(admin), 'x-krug-desktop-capability': 'migration-v1' } })).json().token as string;
  assert.equal((await app.inject({ url: '/api/desktop-updates/latest.yml', headers: { authorization: `Bearer ${capable}` } })).body, webviewManifest);
  writeFileSync(join(dir, 'latest.yml'), 'version: 0.3.0\npath: Krug-Setup-0.3.0.exe\n');
  assert.equal((await app.inject({ url: '/api/desktop-updates/latest.yml', headers: authorization })).body, legacyManifest);
});

test('desktop session migration is same-origin, single-use and bound to a live session', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/desktop-migration/issue', headers: headers() })).statusCode, 401);
  const original = await owner(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/desktop-migration/issue', headers: { cookie: original, origin: 'https://evil.example' } })).statusCode, 403);
  const issued = await app.inject({ method: 'POST', url: '/api/desktop-migration/issue', headers: headers(original) });
  assert.equal(issued.statusCode, 200);
  const token = issued.json().token as string;
  const payload = { token };
  assert.equal((await app.inject({ method: 'POST', url: '/api/desktop-migration/redeem', headers: { origin: 'https://evil.example' }, payload })).statusCode, 403);
  const results = await Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: '/api/desktop-migration/redeem', headers: headers(), payload })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 401]);
  const migrated = cookieOf(results.find(r => r.statusCode === 200)!);
  assert.notEqual(migrated, original);
  assert.equal((await app.inject({ url: '/api/me', headers: headers(migrated) })).json().user.username, 'owner');
  const pending = (await app.inject({ method: 'POST', url: '/api/desktop-migration/issue', headers: headers(original) })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(original) });
  assert.equal((await app.inject({ method: 'POST', url: '/api/desktop-migration/redeem', headers: headers(), payload: { token: pending } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/me', headers: headers(migrated) })).statusCode, 200);
});

test('passwords use unique salts and reject wrong passwords', async () => {
  const first = await hashPassword(password); const second = await hashPassword(password);
  assert.notEqual(first, second); assert.ok(await verifyPassword(password, first)); assert.equal(await verifyPassword('wrong', first), false);
});
test('production rejects cleartext configuration', () => {
  assert.throws(() => readConfig({ ...config(), NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv), /HTTPS/);
});
test('private API requires authentication and mutations require same origin', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  for (const url of ['/api/me', '/api/channels', '/api/channels/general/messages', '/api/invites']) assert.equal((await app.inject(url)).statusCode, 401);
  for (const requestOrigin of ['https://evil.example', undefined]) {
    const result = await app.inject({ method: 'POST', url: '/api/auth/register', headers: requestOrigin ? { origin: requestOrigin } : {}, payload: { username: 'owner', displayName: 'Owner', password, invite: bootstrap } });
    assert.equal(result.statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(), payload: { username: 'owner', displayName: 'Owner', password, invite: 'wrong'.repeat(10) } })).statusCode, 400);
});
test('first invite is admin-only, single-use and atomically consumed', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  const results = await Promise.all(['owner1', 'owner2'].map(username => app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(), payload: { username, displayName: username, password, invite: bootstrap } })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 400]);
  assert.equal(results.find(r => r.statusCode === 201)!.json().user.role, 'admin');
  assert.match(results.find(r => r.statusCode === 201)!.headers['set-cookie'] as string, /HttpOnly/);
  assert.match(results.find(r => r.statusCode === 201)!.headers['set-cookie'] as string, /SameSite=Strict/);
});
test('members cannot create invites/channels or clear history; revoke works', async t => {
  const app = await buildApp(config()); t.after(() => app.close()); const admin = await owner(app); const regular = await member(app, admin);
  for (const [method, url, payload] of [['POST', '/api/invites', undefined], ['POST', '/api/channels', { name: 'hacked', kind: 'text' }], ['DELETE', '/api/channels/general/messages', { confirmation: 'общий' }]] as const) {
    assert.equal((await app.inject({ method, url, payload, headers: headers(regular) })).statusCode, 403);
  }
  const invite = (await app.inject({ method: 'POST', url: '/api/invites', headers: headers(admin) })).json();
  await app.inject({ method: 'DELETE', url: `/api/invites/${invite.id}`, headers: headers(admin) });
  const token = new URLSearchParams(new URL(invite.url).hash.slice(1)).get('invite');
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(), payload: { username: 'third', displayName: 'Third', password, invite: token } })).statusCode, 400);
});
test('messages persist, pagination is bounded, deletion checks authorship and explicit confirmation', async t => {
  const app = await buildApp(config()); t.after(() => app.close()); const admin = await owner(app); const regular = await member(app, admin);
  const created = await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(admin), payload: { body: '<script>alert(1)</script> hello' } });
  assert.equal(created.statusCode, 201); const id = created.json().message.id;
  const history = (await app.inject({ url: '/api/channels/general/messages', headers: headers(regular) })).json();
  assert.equal(history.messages[0].body, '<script>alert(1)</script> hello');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/messages/${id}`, headers: headers(regular) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/channels/general/messages', headers: headers(admin), payload: { confirmation: 'wrong' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/channels/general/messages', headers: headers(admin), payload: { confirmation: 'общий' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/channels/general/messages', headers: headers(admin) })).json().messages.length, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(regular), payload: { body: 'a'.repeat(4001) } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/no-such-room/messages', headers: headers(regular), payload: { body: 'hi' } })).statusCode, 404);
});
test('voice tokens are scoped to a real voice room and short-lived', async t => {
  const cfg = config(); const app = await buildApp(cfg); t.after(() => app.close()); const admin = await owner(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers() })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/general/voice-token', headers: headers(admin) })).statusCode, 400);
  const response = await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(admin) });
  assert.equal(response.statusCode, 200);
  const claims = await new TokenVerifier(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET).verify(response.json().token);
  assert.equal(claims.video?.room, 'lounge'); assert.equal(claims.video?.roomJoin, true); assert.equal(claims.video?.roomAdmin, undefined); assert.equal(claims.video?.canPublishData, false); assert.equal(claims.video?.canUpdateOwnMetadata, false);
  const raw = JSON.parse(Buffer.from(response.json().token.split('.')[1], 'base64url').toString());
  assert.ok(raw.exp - Math.floor(Date.now() / 1000) <= 120);
});
test('websocket sends messages and rejects a foreign origin', async t => {
  const app = await buildApp(config()); t.after(() => app.close()); const admin = await owner(app); const regular = await member(app, admin); await app.ready();
  await assert.rejects(app.injectWS('/api/events', { socket: testSocket, headers: { origin: 'https://evil.example', cookie: regular } }), /403/);
  await assert.rejects(app.injectWS('/api/events', { socket: testSocket, headers: { origin } }), /401/);
  const socket = await app.injectWS('/api/events', { socket: testSocket, headers: headers(regular) });
  t.after(() => socket.terminate());
  const mentioned = new Promise<{ channelId: string; author: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mention not delivered')), 2000);
    socket.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'mention') { clearTimeout(timeout); resolve(event); } });
  });
  const received = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Message not delivered')), 2000);
    socket.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'message') { clearTimeout(timeout); resolve(event.message.body); } });
  });
  await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(admin), payload: { body: 'Привет @member' } });
  assert.equal(await received, 'Привет @member');
  const mentionEvent = await mentioned;
  assert.equal(mentionEvent.channelId, 'general');
  assert.equal(mentionEvent.author, 'Владелец');
  const closed = new Promise<number>(resolve => socket.once('close', resolve));
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(regular) });
  assert.equal(await closed, 1008);
  assert.equal((await app.inject({ url: '/api/me', headers: headers(regular) })).statusCode, 401);
});
test('changing password invalidates all sessions and old password', async t => {
  const app = await buildApp(config()); t.after(() => app.close()); const admin = await owner(app);
  const another = await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { username: 'owner', password } });
  const updated = password + '-new';
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/password', headers: headers(admin), payload: { currentPassword: password, password: updated } })).statusCode, 200);
  for (const token of [admin, cookieOf(another)]) assert.equal((await app.inject({ url: '/api/me', headers: headers(token) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { username: 'owner', password } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { username: 'owner', password: updated } })).statusCode, 200);
});
test('old history survives cleanup and restart; sessions are hashed; pages do not overlap', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-test-')); const path = join(directory, 'test.sqlite');
  let app = await buildApp(config(path));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const admin = await owner(app);
  const user = (await app.inject({ url: '/api/me', headers: headers(admin) })).json().user;
  await app.close();
  const db = new DatabaseSync(path);
  const insert = db.prepare('INSERT INTO messages (channelId,userId,body,createdAt) VALUES (?,?,?,?)');
  for (let i = 0; i < 70; i++) insert.run('general', user.id, `Old message ${i}`, Date.UTC(2020, 0, 1));
  const session = db.prepare('SELECT hash FROM sessions').get() as { hash: string };
  assert.equal(session.hash, digest(admin.split('=')[1]));
  const storedUser = db.prepare('SELECT password FROM users').get() as { password: string }; assert.notEqual(storedUser.password, password);
  db.close();
  app = await buildApp(config(path));
  const recent = (await app.inject({ url: '/api/channels/general/messages', headers: headers(admin) })).json();
  assert.equal(recent.messages.length, 50); assert.equal(recent.hasMore, true);
  const old = (await app.inject({ url: `/api/channels/general/messages?before=${recent.messages[0].id}`, headers: headers(admin) })).json();
  assert.equal(old.messages.length, 20); assert.equal(old.hasMore, false);
  assert.ok(old.messages.at(-1).id < recent.messages[0].id);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', headers: headers(), payload: { username: 'owner2', displayName: 'Owner 2', password, invite: bootstrap } })).statusCode, 400);
});
test('rate limits block repeated login attempts and cannot be bypassed with spoofed forwarding headers', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  let response;
  for (let i = 0; i < 13; i++) response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...headers(), 'x-forwarded-for': `203.0.113.${i}` }, payload: { username: 'absent', password } });
  assert.equal(response!.statusCode, 429);
});

test('deleting a channel requires its owner and name, removes only its messages and notifies clients', async t => {
  const app = await buildApp(config()); t.after(() => app.close());
  const admin = await owner(app); const regular = await member(app, admin);
  const created = (await app.inject({ method: 'POST', url: '/api/channels', headers: headers(admin), payload: { name: 'Удаляемый', kind: 'text' } })).json().channel;
  for (const id of [created.id, 'general']) await app.inject({ method: 'POST', url: `/api/channels/${id}/messages`, headers: headers(admin), payload: { body: 'Сохранённое сообщение' } });
  const url = `/api/channels/${created.id}`; const payload = { confirmation: created.name };
  assert.equal((await app.inject({ method: 'DELETE', url, payload, headers: headers() })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url, payload, headers: headers(regular) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url, payload, headers: { cookie: admin, origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url, payload: { confirmation: 'wrong' }, headers: headers(admin) })).statusCode, 400);
  assert.equal((await app.inject({ url: `${url}/messages`, headers: headers(admin) })).json().messages.length, 1);
  const socket = await app.injectWS('/api/events', { socket: testSocket, headers: headers(regular) }); t.after(() => socket.terminate());
  const received = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Deletion not delivered')), 2000);
    socket.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'channel-deleted') { clearTimeout(timeout); resolve(event.channelId); } });
  });
  const deleted = await app.inject({ method: 'DELETE', url, payload, headers: headers(admin) });
  assert.equal(deleted.statusCode, 200, deleted.body); assert.equal(await received, created.id);
  assert.ok(!deleted.json().channels.some((c: { id: string }) => c.id === created.id));
  assert.equal((await app.inject({ url: `${url}/messages`, headers: headers(admin) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/channels/general/messages', headers: headers(admin) })).json().messages.length, 1);
});

test('voice deletion ends the room before removal, blocks new tokens and preserves the channel on failure', async t => {
  let rejectDeletion = true; let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const app = await buildApp(config(), { async deleteRoom(id) { assert.equal(id, 'lounge'); if (rejectDeletion) throw new Error('Offline'); started(); await new Promise<void>(resolve => { finish = resolve; }); } });
  t.after(() => app.close()); const admin = await owner(app);
  const channels = (await app.inject({ url: '/api/channels', headers: headers(admin) })).json().channels;
  const payload = { confirmation: channels.find((c: { id: string }) => c.id === 'lounge').name };
  const request = { method: 'DELETE' as const, url: '/api/channels/lounge', headers: headers(admin), payload };
  assert.equal((await app.inject(request)).statusCode, 503);
  assert.equal((await app.inject({ url: '/api/channels/lounge/messages', headers: headers(admin) })).statusCode, 200);
  rejectDeletion = false; const pending = app.inject(request).then(r => r); await entered;
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(admin) })).statusCode, 409);
  finish(); assert.equal((await pending).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/lounge/voice-token', headers: headers(admin) })).statusCode, 404);
});

test('an empty channel list survives a restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-empty-')); const path = join(directory, 'test.sqlite');
  let app = await buildApp(config(path), { async deleteRoom() {} });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const admin = await owner(app);
  const channels = (await app.inject({ url: '/api/channels', headers: headers(admin) })).json().channels;
  for (const channel of channels) assert.equal((await app.inject({ method: 'DELETE', url: `/api/channels/${channel.id}`, headers: headers(admin), payload: { confirmation: channel.name } })).statusCode, 200);
  await app.close(); app = await buildApp(config(path));
  assert.deepEqual((await app.inject({ url: '/api/channels', headers: headers(admin) })).json().channels, []);
});

test('room presence reports media participants, deduplicates users and updates connected clients', async t => {
  let identities: { identity: string; microphoneEnabled: boolean }[] = []; let calls = 0;
  const app = await buildApp(config(), { async participants(ids) { calls++; assert.ok(ids.includes('lounge')); assert.ok(!ids.includes('general')); return { lounge: identities, unknown: identities }; } });
  t.after(() => app.close()); const admin = await owner(app); const regular = await member(app, admin);
  const friend = (await app.inject({ url: '/api/me', headers: headers(regular) })).json().user;
  assert.equal((await app.inject('/api/voice-presence')).statusCode, 401);
  identities = [{ identity: friend.id, microphoneEnabled: false }, { identity: friend.id, microphoneEnabled: false }, { identity: 'unknown-user', microphoneEnabled: false }];
  assert.equal((await app.inject({ method: 'POST', url: '/api/voice-state', headers: headers(regular), payload: { channelId: 'lounge', deafened: true, afk: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/voice-state', headers: headers(), payload: { channelId: 'lounge', deafened: true } })).statusCode, 401);
  const first = (await app.inject({ url: '/api/voice-presence', headers: headers(admin) })).json();
  assert.equal(first.available, true); assert.deepEqual(first.rooms.lounge, [{ ...friend, microphoneEnabled: false, deafened: true, afk: true }]); assert.equal(first.rooms.unknown, undefined);
  await app.inject({ url: '/api/voice-presence', headers: headers(admin) }); assert.equal(calls, 1);
  const socket = await app.injectWS('/api/events', { socket: testSocket, headers: headers(admin) }); t.after(() => socket.terminate());
  const returned = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AFK update not delivered')), 2000);
    socket.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'voice-presence' && event.rooms.lounge?.some((person: { id: string; afk: boolean }) => person.id === friend.id && !person.afk)) { clearTimeout(timer); resolve(); } });
  });
  assert.equal((await app.inject({ method: 'POST', url: '/api/voice-state', headers: headers(regular), payload: { channelId: 'lounge', deafened: true, afk: false } })).statusCode, 200);
  await returned;
  identities = [];
  const empty = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Presence update not delivered')), 6500);
    socket.on('message', data => { const event = JSON.parse(data.toString()); if (event.type === 'voice-presence' && event.available && event.rooms.lounge.length === 0) { clearTimeout(timer); resolve(); } });
  });
  await empty;
});

test('media failure is reported as unavailable rather than an empty room', async t => {
  const app = await buildApp(config(), { async participants() { throw new Error('Offline'); } }); t.after(() => app.close());
  const admin = await owner(app);
  assert.deepEqual((await app.inject({ url: '/api/voice-presence', headers: headers(admin) })).json(), { rooms: {}, available: false });
});

test('unread markers are private, ignore own messages, acknowledge only seen history and survive restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'krug-unread-')); const path = join(directory, 'test.sqlite');
  let app = await buildApp(config(path));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const admin = await owner(app); const regular = await member(app, admin);
  const state = async (cookie: string) => (await app.inject({ url: '/api/unread', headers: headers(cookie) })).json().channels;
  const post = async (cookie: string, channelId = 'general') => (await app.inject({ method: 'POST', url: `/api/channels/${channelId}/messages`, headers: headers(cookie), payload: { body: 'Unread test' } })).json().message;
  const read = (cookie: string, messageId: number) => app.inject({ method: 'POST', url: '/api/channels/general/read', headers: headers(cookie), payload: { messageId } });
  assert.equal((await app.inject('/api/unread')).statusCode, 401);
  assert.equal((await read('', 1)).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/channels/general/read', headers: { cookie: admin, origin: 'https://evil.example' }, payload: { messageId: 1 } })).statusCode, 403);
  const first = await post(regular);
  assert.equal((await state(admin)).general, true); assert.equal((await state(regular)).general, false);
  const second = await post(regular);
  assert.equal((await read(admin, first.id)).statusCode, 200); assert.equal((await state(admin)).general, true);
  await read(admin, second.id); await read(admin, first.id); assert.equal((await state(admin)).general, false);
  await app.close(); app = await buildApp(config(path));
  assert.equal((await state(admin)).general, false);
  await read(admin, Number.MAX_SAFE_INTEGER); const third = await post(regular); assert.equal((await state(admin)).general, true);
  await app.inject({ method: 'DELETE', url: `/api/messages/${third.id}`, headers: headers(regular) }); assert.equal((await state(admin)).general, false);
  await post(regular, 'lounge'); assert.equal((await state(admin)).lounge, true);
  assert.equal((await read(admin, -1)).statusCode, 400);
});

test('read updates reach only the same user across tabs and clearing history removes unread state', async t => {
  const app = await buildApp(config()); t.after(() => app.close()); const admin = await owner(app); const regular = await member(app, admin);
  const ownerSocket = await app.injectWS('/api/events', { socket: testSocket, headers: headers(admin) });
  const friendSocket = await app.injectWS('/api/events', { socket: testSocket, headers: headers(regular) });
  t.after(() => { ownerSocket.terminate(); friendSocket.terminate(); });
  const ownerEvents: Record<string, boolean>[] = []; const friendEvents: Record<string, boolean>[] = [];
  ownerSocket.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.type === 'unread') ownerEvents.push(event.channels); });
  friendSocket.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.type === 'unread') friendEvents.push(event.channels); });
  const response = await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(regular), payload: { body: 'For the other account' } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ownerEvents.at(-1)?.general, true); assert.equal(friendEvents.at(-1)?.general, false);
  const before = friendEvents.length;
  await app.inject({ method: 'POST', url: '/api/channels/general/read', headers: headers(admin), payload: { messageId: response.json().message.id } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ownerEvents.at(-1)?.general, false); assert.equal(friendEvents.length, before);
  await app.inject({ method: 'POST', url: '/api/channels/general/messages', headers: headers(regular), payload: { body: 'Another unread' } });
  await app.inject({ method: 'DELETE', url: '/api/channels/general/messages', headers: headers(admin), payload: { confirmation: 'общий' } });
  assert.equal((await app.inject({ url: '/api/unread', headers: headers(admin) })).json().channels.general, false);
  await app.inject({ method: 'DELETE', url: '/api/channels/general', headers: headers(admin), payload: { confirmation: 'общий' } });
  assert.equal((await app.inject({ url: '/api/unread', headers: headers(admin) })).json().channels.general, undefined);
});
