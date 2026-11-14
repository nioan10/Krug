import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { TokenVerifier } from 'livekit-server-sdk';
import { readConfig } from '../server/config.ts';
import { buildApp } from '../server/app.ts';
import { buildStreamApp } from '../server/stream-app.ts';
import { openStreamStore, publicBroadcast } from '../server/stream-store.ts';
import { sweepStreams, type StreamMedia } from '../server/stream-media.ts';

const origin = 'http://localhost:5173', publicOrigin = 'http://localhost:5174';
const bootstrap = 'test-stream-owner-invitation-123456789';
const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.map(c => `${c.name}=${c.value}`).join('; ');
async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'krug-stream-'));
  const config = readConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_PATH: join(directory, 'private.sqlite'), BOOTSTRAP_INVITE: bootstrap, LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'private-test-key', LIVEKIT_API_SECRET: 'private-test-secret-longer-than-32', STREAM_ORIGIN: publicOrigin, STREAM_DATABASE_PATH: join(directory, 'streams.sqlite'), STREAM_LIVEKIT_URL: 'ws://localhost:7890', STREAM_LIVEKIT_API_KEY: 'public-test-key', STREAM_LIVEKIT_API_SECRET: 'public-test-secret-longer-than-32' });
  let hasVideo = false, failCreate = false, failClose = false; const closed: string[] = [];
  const media: StreamMedia = { async create() { if (failCreate) throw new Error('offline'); }, async close(id) { if (failClose) throw new Error('offline'); closed.push(id); }, async inspect() { return { publishing: hasVideo, viewers: 0 }; } };
  const app = await buildApp(config, { async deleteRoom() {}, async participants() { return {}; }, async removeParticipant() {} }, media);
  const pub = await buildStreamApp(config, media); await pub.ready();
  const store = openStreamStore(config.STREAM_DATABASE_PATH);
  t.after(async () => { await pub.close(); await app.close(); store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  async function register(username: string, invite: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin }, payload: { username, displayName: `SECRET-NAME-${username}`, password: 'Long-test-password-only-123', invite } });
    assert.equal(response.statusCode, 201, response.body); return cookieOf(response);
  }
  const owner = await register('owner', bootstrap);
  const response = await app.inject({ method: 'POST', url: '/api/invites', headers: { origin, cookie: owner } });
  const member = await register('member', new URLSearchParams(new URL(response.json().url).hash.slice(1)).get('invite')!);
  const control = (url: string, payload?: Record<string, unknown>, cookie = owner, method: 'GET' | 'POST' | 'DELETE' = 'POST') => app.inject({ method, url: '/api/broadcasts' + url, headers: { origin, cookie }, payload });
  const request = (url: string, cookie = '', payload?: Record<string, unknown>, from = publicOrigin) => pub.inject({ method: 'POST', url: '/api/streams' + url, headers: { origin: from, cookie }, payload });
  async function create(cookie = owner) { const r = await control('', { title: 'Игра вечером', quality: '720p60' }, cookie); assert.equal(r.statusCode, 201, r.body); return r.json(); }
  async function live(id: string) { hasVideo = true; const r = await control('/' + id + '/live'); assert.equal(r.statusCode, 200, r.body); }
  return { app, pub, store, config, owner, member, control, request, create, live, closed, media, failCreate: () => { failCreate = true; }, failClose: (value: boolean) => { failClose = value; } };
}

test('only authenticated members can publish, two streams maximum, owners control only their streams', async t => {
  const q = await setup(t);
  assert.equal((await q.control('', { title: 'x', quality: '720p60' }, '')).statusCode, 401);
  const first = await q.create(); const second = await q.create(q.member);
  assert.notEqual(first.stream.id, second.stream.id);
  assert.throws(() => q.store.create('third-owner', 'third', '720p60'), /два эфира/);
  assert.equal((await q.control('', { title: 'duplicate', quality: '720p60' })).statusCode, 409);
  assert.equal((await q.control(`/${first.stream.id}/end`, undefined, q.member)).statusCode, 404);
  assert.equal((await q.control(`/${first.stream.id}/live`)).statusCode, 409);
  await q.live(first.stream.id);
  assert.equal((await q.control(`/${first.stream.id}/end`)).statusCode, 200);
  assert.ok(q.closed.includes(first.stream.id));
  assert.equal((await q.control(`/${first.stream.id}/heartbeat`)).statusCode, 409);
});

test('revoking a member closes their active broadcast and denies future control', async t => {
  const q = await setup(t);
  const created = await q.create(q.member);
  const member = (await q.app.inject({ url: '/api/me', headers: { origin, cookie: q.member } })).json().user;
  const revoked = await q.app.inject({ method: 'PATCH', url: `/api/members/${member.id}/access`, headers: { origin, cookie: q.owner }, payload: { enabled: false } });
  assert.equal(revoked.statusCode, 200); assert.equal(revoked.json().disconnected, true);
  assert.equal(q.store.require(created.stream.id).state, 'ended');
  assert.ok(q.closed.includes(created.stream.id));
  assert.equal((await q.control(`/${created.stream.id}/heartbeat`, {}, q.member)).statusCode, 401);
});

test('a broadcast belongs to its publishing session and ended rooms remain subject to stale-token cleanup', async t => {
  const q = await setup(t);
  const second = await q.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'owner', password: 'Long-test-password-only-123' } });
  const otherSession = cookieOf(second);
  const first = await q.create(), otherStream = await q.create(q.member);
  assert.equal((await q.control(`/${first.stream.id}/heartbeat`, {}, otherSession)).statusCode, 403);
  const sessions = (await q.app.inject({ url: '/api/sessions', headers: { origin, cookie: otherSession } })).json().sessions;
  const original = sessions.find((s: { current: number }) => !s.current);
  assert.equal((await q.app.inject({ method: 'DELETE', url: `/api/sessions/${original.id}`, headers: { origin, cookie: otherSession } })).statusCode, 200);
  assert.equal(q.store.require(first.stream.id).state, 'ended');
  assert.notEqual(q.store.require(otherStream.stream.id).state, 'ended');
  const recreated = new Set([first.stream.id, otherStream.stream.id]);
  q.media.prune = async active => { for (const id of recreated) if (!active().includes(id)) recreated.delete(id); };
  await sweepStreams(q.store, q.media);
  assert.deepEqual([...recreated], [otherStream.stream.id]);
  recreated.add(first.stream.id);
  await sweepStreams(q.store, q.media);
  assert.deepEqual([...recreated], [otherStream.stream.id]);
  let startedDuringRequest = '';
  q.media.prune = async active => {
    await Promise.resolve();
    startedDuringRequest = q.store.create('late-owner', 'Started during cleanup', '720p60').id;
    recreated.add(startedDuringRequest);
    for (const id of recreated) if (!active().includes(id)) recreated.delete(id);
  };
  await sweepStreams(q.store, q.media);
  assert.ok(recreated.has(startedDuringRequest), 'cleanup must preserve a stream started while listing media rooms');
});

test('public API has no account routes and leaks no owner identifiers, session data or real names', async t => {
  const q = await setup(t); const { stream } = await q.create();
  for (const path of ['/api/me', '/api/channels', '/api/users', '/api/broadcasts']) assert.equal((await q.pub.inject(path)).statusCode, 404);
  const response = await q.pub.inject('/api/streams/' + stream.id);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json().stream).sort(), ['createdAt', 'endedAt', 'id', 'publishing', 'quality', 'state', 'title', 'viewers']);
  const guest = await q.request(`/${stream.id}/guest`, q.owner);
  assert.equal(guest.statusCode, 200); assert.match(guest.json().guest.label, /^Аноним-[A-F0-9]{16}$/);
  assert.doesNotMatch(guest.body + response.body, /SECRET-NAME|ownerId|publisherId|session|hash|username/);
  assert.notEqual(guest.json().guest.id, q.store.require(stream.id).ownerId);
  const tables = q.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(!tables.includes('users') && !tables.includes('sessions'));
});

test('guest identity persists on reload, differs across streams, and cannot be chosen or impersonated', async t => {
  const q = await setup(t); const a = (await q.create()).stream; const b = (await q.create(q.member)).stream;
  const first = await q.request(`/${a.id}/guest`); const cookie = cookieOf(first);
  const again = await q.request(`/${a.id}/guest`, cookie, { id: 'owner', displayName: 'Owner' });
  assert.equal(again.json().guest.id, first.json().guest.id);
  const other = await q.request(`/${b.id}/guest`, cookie);
  assert.notEqual(other.json().guest.id, first.json().guest.id);
  assert.match(first.headers['set-cookie'] as string, /HttpOnly/);
  assert.match(first.headers['set-cookie'] as string, /SameSite=Strict/);
  assert.equal((await q.request(`/${a.id}/messages`, q.owner, { body: 'x' })).statusCode, 401);
});

test('media grants use separate credentials: anonymous viewers subscribe only; publisher has only screen sources', async t => {
  const q = await setup(t); const created = await q.create(); const id = created.stream.id;
  const verifier = new TokenVerifier(q.config.STREAM_LIVEKIT_API_KEY, q.config.STREAM_LIVEKIT_API_SECRET);
  const publisher = await verifier.verify(created.token);
  assert.equal(publisher.video?.room, id); assert.equal(publisher.video?.canPublish, true); assert.equal(publisher.video?.canSubscribe, false);
  assert.deepEqual(publisher.video?.canPublishSources, ['screen_share', 'screen_share_audio']);
  assert.equal(publisher.video?.canPublishData, false);
  const guest = await q.request(`/${id}/guest`); const cookie = cookieOf(guest);
  assert.equal((await q.request(`/${id}/token`, cookie)).statusCode, 409);
  await q.live(id);
  const token = await q.request(`/${id}/token`, cookie); assert.equal(token.statusCode, 200);
  const claims = await verifier.verify(token.json().token);
  assert.ok(claims.sub?.startsWith(guest.json().guest.id + '.')); assert.equal(claims.video?.room, id);
  const anotherTab = await verifier.verify((await q.request(`/${id}/token`, cookie)).json().token);
  assert.notEqual(claims.sub, anotherTab.sub); assert.equal(claims.name, anotherTab.name);
  assert.equal(claims.video?.canPublish, false); assert.equal(claims.video?.canSubscribe, true); assert.equal(claims.video?.canPublishData, false);
  assert.equal(claims.video?.canUpdateOwnMetadata, false);
  await assert.rejects(new TokenVerifier(q.config.LIVEKIT_API_KEY, q.config.LIVEKIT_API_SECRET).verify(token.json().token));
});

test('chat is anonymous for everyone, rate limited, moderated by its owner and retained after an ended broadcast', async t => {
  const q = await setup(t); const { stream } = await q.create(); await q.live(stream.id);
  const guest = await q.request(`/${stream.id}/guest`); const cookie = cookieOf(guest);
  const sent = await q.request(`/${stream.id}/messages`, cookie, { body: '<script>alert(1)</script>', author: 'SECRET-NAME-owner', authorId: 'owner' });
  assert.equal(sent.statusCode, 201);
  assert.equal((await q.request(`/${stream.id}/messages`, cookie, { body: 'spam' })).statusCode, 429);
  const messages = (await q.request(`/${stream.id}/guest`, cookie)).json().messages;
  assert.equal(messages[0].authorId, guest.json().guest.id); assert.equal(messages[0].author, guest.json().guest.label);
  assert.equal((await q.control(`/${stream.id}/messages/${messages[0].id}`, undefined, q.member, 'DELETE')).statusCode, 404);
  assert.equal((await q.control(`/${stream.id}/ban`, { guestId: guest.json().guest.id })).statusCode, 200);
  assert.equal((await q.request(`/${stream.id}/messages`, cookie, { body: 'banned' })).statusCode, 403);
  await q.control(`/${stream.id}/end`);
  assert.equal((await q.request(`/${stream.id}/token`, cookie)).statusCode, 409);
  assert.equal((await q.request(`/${stream.id}/guest`, cookie)).json().messages.length, 1);
  await q.control(`/${stream.id}/messages/${messages[0].id}`, undefined, q.owner, 'DELETE');
  assert.equal(q.store.messages(stream.id).length, 0);
});

test('origin checks protect anonymous writes and websockets; only the studio gets credentialed CORS', async t => {
  const q = await setup(t); const { stream } = await q.create();
  assert.equal((await q.request(`/${stream.id}/guest`, '', undefined, 'https://evil.example')).statusCode, 403);
  const preflight = await q.pub.inject({ method: 'OPTIONS', url: `/api/streams/${stream.id}/guest`, headers: { origin, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], origin);
  const guest = await q.request(`/${stream.id}/guest`, '', undefined, origin); const cookie = cookieOf(guest);
  assert.equal(guest.headers['access-control-allow-credentials'], 'true');
  const socket = { remoteAddress: '127.0.0.1' } as Socket;
  await assert.rejects(q.pub.injectWS(`/api/streams/${stream.id}/events`, { socket, headers: { origin: 'https://evil.example', cookie } }), /403/);
  await assert.rejects(q.pub.injectWS(`/api/streams/${stream.id}/events`, { socket, headers: { origin: publicOrigin } }), /401/);
});

test('public chat snapshots reflect messages and moderation from the separate control process', async t => {
  const q = await setup(t); const { stream } = await q.create(); await q.live(stream.id);
  const guest = await q.request(`/${stream.id}/guest`); const cookie = cookieOf(guest);
  const ws = await q.pub.injectWS(`/api/streams/${stream.id}/events`, { socket: { remoteAddress: '127.0.0.1' } as Socket, headers: { origin: publicOrigin, cookie } });
  t.after(() => ws.terminate());
  const received = new Promise<any>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Snapshot missing')), 3000); ws.on('message', raw => { const data = JSON.parse(raw.toString()); if (data.messages.length) { clearTimeout(timeout); resolve(data); } }); });
  await q.request(`/${stream.id}/messages`, cookie, { body: 'Anonymous hello' });
  const result = await received; assert.equal(result.messages[0].body, 'Anonymous hello'); assert.doesNotMatch(JSON.stringify(result), /SECRET-NAME|ownerId|username/);
});

test('stale publisher lease closes media; a media failure keeps the stream ended and retries cleanup', async t => {
  const q = await setup(t); const { stream } = await q.create(); await q.live(stream.id);
  q.store.db.prepare('UPDATE broadcasts SET leaseUntil=0 WHERE id=?').run(stream.id);
  q.failClose(true); await sweepStreams(q.store, q.media);
  assert.equal(q.store.require(stream.id).state, 'ended'); assert.equal(q.store.require(stream.id).mediaClosed, 0);
  q.failClose(false); await sweepStreams(q.store, q.media);
  assert.equal(q.store.require(stream.id).mediaClosed, 1);
  assert.equal(publicBroadcast(q.store.require(stream.id)).publishing, false);
});

test('media creation failure releases the broadcast slot and invalid settings cannot reuse private media', async t => {
  const q = await setup(t); q.failCreate();
  assert.equal((await q.control('', { title: 'test', quality: '720p60' })).statusCode, 503);
  assert.equal(q.store.active().length, 0);
  assert.throws(() => readConfig(Object.fromEntries(Object.entries({ ...q.config, STREAM_LIVEKIT_API_KEY: q.config.LIVEKIT_API_KEY }).map(([key, value]) => [key, String(value)]))), /separate media/);
});
