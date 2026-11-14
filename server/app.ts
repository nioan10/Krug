import Fastify, { LogController, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { AccessToken } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { Config } from './config.ts';
import { openStore, DAY, type User } from './store.ts';
import { ApiError, digest, hashPassword, newSecret, verifyPassword } from './security.ts';
import { createMediaService, type MediaService } from './media.ts';
import { createSessionTransfers } from './session-transfer.ts';
import { mentionNames } from './mentions.ts';
import { decodeImage } from './image-attachment.ts';
import { registerBroadcasts } from './broadcast-routes.ts';
import type { StreamMedia } from './stream-media.ts';

declare module 'fastify' { interface FastifyRequest { user: User | null; sessionHash: string | null } }
const credentials = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/), password: z.string().min(12).max(128) });
const channelId = (request: FastifyRequest) => z.object({ id: z.string().min(1).max(64) }).parse(request.params).id;

export async function buildApp(config: Config, media: MediaService = createMediaService(config), streamMedia?: StreamMedia) {
  const app = Fastify({
    logger: config.NODE_ENV !== 'test' ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16 * 1024,
    trustProxy: config.NODE_ENV === 'production' ? ['127.0.0.1', '::1'] : false,
  });
  const store = openStore(config);
  const { db } = store;
  const sockets = new Map<WebSocket, { user: User; hash: string; alive: boolean }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const updateTokens = new Map<string, { expires: number; migrationAware: boolean }>();
  const sessionTransfers = createSessionTransfers();
  const voiceAudioStates = new Map<string, { channelId: string; deafened: boolean; expiresAt: number }>();
  const deletingChannels = new Set<string>();
  const dummy = await hashPassword(newSecret());
  const sessionCookie = config.NODE_ENV === 'production' ? '__Host-krug' : 'krug_session';
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: config.NODE_ENV === 'production', path: '/', maxAge: 7 * DAY / 1000 };

  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute', errorResponseBuilder: () => new ApiError(429, 'Слишком много запросов. Подождите и повторите попытку.') });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", config.LIVEKIT_URL, config.LIVEKIT_URL.replace(/^ws/, 'http'), ...(config.STREAM_ORIGIN ? [config.STREAM_ORIGIN, config.STREAM_ORIGIN.replace(/^http/, 'ws'), config.STREAM_LIVEKIT_URL, config.STREAM_LIVEKIT_URL.replace(/^ws/, 'http')] : [])],
      imgSrc: ["'self'", 'data:'], mediaSrc: ["'self'", 'blob:'], workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
    } },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(websocket, { options: { maxPayload: 1024, perMessageDeflate: false } });
  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    if (req.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    if ((!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers.upgrade?.toLowerCase() === 'websocket') && req.headers.origin !== config.APP_ORIGIN) {
      throw new ApiError(403, 'Запрос с другого сайта отклонён.');
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: 'Проверьте введённые данные.' });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error({ err: error }, 'Request failed');
    reply.code(status).send({ message: status >= 500 ? 'Ошибка сервера. Попробуйте ещё раз.' : (error as Error).message });
  });
  const auth = async (req: FastifyRequest) => {
    const token = req.cookies[sessionCookie];
    const hash = token ? digest(token) : '';
    const user = hash ? store.sessionUser(hash) : undefined;
    if (!user) throw new ApiError(401, 'Войдите в свой аккаунт.');
    req.user = user; req.sessionHash = hash;
  };
  const admin = async (req: FastifyRequest) => { await auth(req); if (req.user!.role !== 'admin') throw new ApiError(403, 'Это действие доступно владельцу.'); };
  await registerBroadcasts(app, config, auth, streamMedia);
  const createSession = (user: User, reply: FastifyReply) => {
    const token = newSecret();
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, Date.now() + 7 * DAY);
    reply.setCookie(sessionCookie, token, cookieOptions);
    return { user };
  };
  const send = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow connection'); return; }
    socket.send(JSON.stringify(payload));
  };
  const broadcast = (payload: unknown) => {
    for (const [socket, state] of sockets) {
      if (store.sessionUser(state.hash)) send(socket, payload);
      else socket.close(1008, 'Session expired');
    }
  };
  const presence = () => broadcast({ type: 'presence', users: [...new Map([...sockets.values()].map(s => [s.user.id, s.user])).values()] });
  const sendUnread = (userId?: string) => {
    const snapshots = new Map<string, ReturnType<typeof store.unread>>();
    for (const [socket, state] of sockets) {
      if (userId && state.user.id !== userId) continue;
      if (!store.sessionUser(state.hash)) { socket.close(1008, 'Session expired'); continue; }
      if (!snapshots.has(state.user.id)) snapshots.set(state.user.id, store.unread(state.user.id));
      send(socket, { type: 'unread', channels: snapshots.get(state.user.id) });
    }
  };
  const requireChannel = (id: string) => { const channel = store.channel(id); if (!channel) throw new ApiError(404, 'Канал не найден.'); if (deletingChannels.has(id)) throw new ApiError(409, 'Канал удаляется.'); return channel; };
  const authRate = { rateLimit: { max: 12, timeWindow: '15 minutes' } };
  let voicePresence: { rooms: Record<string, (User & { microphoneEnabled: boolean; deafened: boolean | null })[]>; available: boolean } = { rooms: {}, available: false };
  let presenceRequest: Promise<void> | undefined;
  let presenceCheckedAt = 0;
  let closing = false;
  function refreshVoicePresence() {
    if (closing) return Promise.resolve();
    if (presenceRequest) return presenceRequest;
    if (Date.now() - presenceCheckedAt < 2500) return Promise.resolve();
    presenceRequest = (async () => {
      let next: typeof voicePresence;
      try {
        const occupants = await media.participants(store.channels().filter(channel => channel.kind === 'voice').map(channel => channel.id));
        const rooms = Object.fromEntries(store.channels().filter(channel => channel.kind === 'voice' && !deletingChannels.has(channel.id)).map(channel => [channel.id,
          [...new Map((occupants[channel.id] ?? []).map(person => [person.identity, person])).values()].sort((a, b) => a.identity.localeCompare(b.identity)).flatMap(person => {
            const user = store.publicUser(person.identity);
            const audioState = voiceAudioStates.get(person.identity);
            const deafened = audioState && audioState.channelId === channel.id && audioState.expiresAt > Date.now() ? audioState.deafened : null;
            return user ? [{ ...user, microphoneEnabled: person.microphoneEnabled, deafened }] : [];
          }),
        ]));
        next = { rooms, available: true };
      } catch {
        next = { rooms: {}, available: false };
      }
      if (JSON.stringify(next) !== JSON.stringify(voicePresence)) {
        voicePresence = next;
        broadcast({ type: 'voice-presence', ...voicePresence });
      }
      presenceCheckedAt = Date.now();
    })().finally(() => { presenceRequest = undefined; });
    return presenceRequest;
  }

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.post('/api/auth/register', { config: authRate }, async (req, reply) => {
    const input = credentials.extend({ displayName: z.string().trim().min(1).max(32), invite: z.string().min(32).max(128) }).parse(req.body);
    const inviteHash = digest(input.invite);
    const invite = db.prepare('SELECT * FROM invites WHERE hash = ? AND usedAt IS NULL AND expiresAt > ?').get(inviteHash, Date.now()) as { id: string; role: User['role'] } | undefined;
    if (!invite) throw new ApiError(400, 'Приглашение недействительно, истекло или уже использовано.');
    if ((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n >= 100) throw new ApiError(409, 'Достигнут лимит сервера: 100 аккаунтов.');
    const password = await hashPassword(input.password);
    const user: User = { id: randomUUID(), username: input.username, displayName: input.displayName, role: invite.role };
    db.exec('BEGIN IMMEDIATE');
    try {
      const used = db.prepare('UPDATE invites SET usedAt = ? WHERE id = ? AND usedAt IS NULL AND expiresAt > ?').run(Date.now(), invite.id, Date.now());
      if (!used.changes) throw new ApiError(400, 'Приглашение уже использовано или истекло.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username)) throw new ApiError(409, 'Этот логин уже занят.');
      db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(user.id, user.username, user.displayName, password, user.role, Date.now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return reply.code(201).send(createSession(user, reply));
  });
  app.post('/api/auth/login', { config: authRate }, async (req, reply) => {
    const input = credentials.parse(req.body);
    const key = digest(input.username);
    const old = attempts.get(key);
    const attempt = old && old.expires > Date.now() ? old : { count: 0, expires: Date.now() + 15 * 60_000 };
    if (attempt.count >= 12) throw new ApiError(429, 'Слишком много попыток. Повторите вход через 15 минут.');
    attempt.count++; attempts.set(key, attempt);
    if (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!);
    const user = db.prepare('SELECT id, password FROM users WHERE username = ?').get(input.username) as { id: string; password: string } | undefined;
    const matches = await verifyPassword(input.password, user?.password ?? dummy);
    if (!user || !matches) throw new ApiError(401, 'Неверный логин или пароль.');
    attempts.delete(key);
    return createSession(store.publicUser(user.id)!, reply);
  });
  app.post('/api/auth/logout', { preHandler: auth }, async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE hash = ?').run(req.sessionHash!);
    for (const [socket, state] of sockets) if (state.hash === req.sessionHash) socket.close(1008, 'Logged out');
    reply.clearCookie(sessionCookie, { path: '/', secure: cookieOptions.secure, sameSite: 'strict' });
    return { ok: true };
  });
  app.post('/api/desktop-migration/issue', { preHandler: auth, config: authRate }, async req => {
    try { return { token: sessionTransfers.issue(req.sessionHash!) }; }
    catch { throw new ApiError(429, 'Повторите попытку позже.'); }
  });
  app.post('/api/desktop-migration/redeem', { config: authRate }, async (req, reply) => {
    const { token } = z.object({ token: z.string().length(43) }).parse(req.body);
    const source = sessionTransfers.consume(token);
    const user = source ? store.sessionUser(source) : undefined;
    const session = source ? db.prepare('SELECT expiresAt FROM sessions WHERE hash = ? AND expiresAt > ?').get(source, Date.now()) as { expiresAt: number } | undefined : undefined;
    if (!user || !session) throw new ApiError(401, 'Перенос сессии недоступен.');
    const newToken = newSecret();
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(newToken), user.id, session.expiresAt);
    reply.setCookie(sessionCookie, newToken, { ...cookieOptions, maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)) });
    return { user };
  });
  app.post('/api/auth/password', { preHandler: auth, config: authRate }, async (req, reply) => {
    const input = z.object({ currentPassword: z.string().max(128), password: z.string().min(12).max(128) }).parse(req.body);
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user!.id) as { password: string };
    if (!await verifyPassword(input.currentPassword, row.password)) throw new ApiError(400, 'Текущий пароль неверен.');
    const hashed = await hashPassword(input.password);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user!.id);
    db.prepare('DELETE FROM sessions WHERE userId = ?').run(req.user!.id);
    for (const [socket, state] of sockets) if (state.user.id === req.user!.id) socket.close(1008, 'Password changed');
    reply.clearCookie(sessionCookie, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', { preHandler: auth }, async req => ({ user: req.user }));
  app.get('/api/desktop-installer', { preHandler: auth }, async (_req, reply) => {
    let manifest: string;
    try { manifest = await readFile(resolve(config.DESKTOP_UPDATE_DIR, 'latest.yml'), 'utf8'); }
    catch { throw new ApiError(404, 'Установщик пока недоступен.'); }
    const file = /^path:\s*(Krug-Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe)\s*$/m.exec(manifest)?.[1];
    if (!file) throw new ApiError(503, 'Установщик пока недоступен.');
    const path = resolve(config.DESKTOP_UPDATE_DIR, file);
    let info; try { info = await stat(path); } catch { throw new ApiError(404, 'Установщик пока недоступен.'); }
    if (!info.isFile()) throw new ApiError(404, 'Установщик пока недоступен.');
    reply.header('Content-Length', info.size).header('Content-Disposition', 'attachment; filename="Okrug-Setup.exe"').type('application/octet-stream');
    return reply.send(createReadStream(path));
  });
  app.get('/api/desktop-updates/access', { preHandler: auth }, async req => {
    const now = Date.now();
    for (const [token, state] of updateTokens) if (state.expires <= now) updateTokens.delete(token);
    if (updateTokens.size >= 1000) throw new ApiError(429, 'Повторите попытку позже.');
    const token = newSecret(); updateTokens.set(digest(token), { expires: now + 10 * 60 * 1000, migrationAware: req.headers['x-krug-desktop-capability'] === 'migration-v1' });
    return { token };
  });
  app.get('/api/desktop-updates/:file', async (req, reply) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const access = token ? updateTokens.get(digest(token)) : undefined;
    if (!access || access.expires <= Date.now()) throw new ApiError(401, 'Обновление недоступно.');
    const { file } = z.object({ file: z.string() }).parse(req.params);
    if (file !== 'latest.yml' && !/^Krug-Setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/.test(file)) throw new ApiError(404, 'Обновление не найдено.');
    let selected = file;
    if (file === 'latest.yml' && !access.migrationAware) {
      // Old Electron clients must first receive a migration-aware Electron
      // release, including clients that have been offline for a long time.
      if (existsSync(resolve(config.DESKTOP_UPDATE_DIR, 'legacy.yml'))) selected = 'legacy.yml';
      else {
        let latest: string;
        try { latest = await readFile(resolve(config.DESKTOP_UPDATE_DIR, 'latest.yml'), 'utf8'); }
        catch { throw new ApiError(404, 'Обновление не найдено.'); }
        if (/^krugRuntime:\s*webview2\s*$/m.test(latest)) selected = 'legacy.yml';
      }
    }
    const path = resolve(config.DESKTOP_UPDATE_DIR, selected);
    let info; try { info = await stat(path); } catch { throw new ApiError(404, 'Обновление не найдено.'); }
    if (!info.isFile()) throw new ApiError(404, 'Обновление не найдено.');
    reply.header('Content-Length', info.size).type(file.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream');
    return reply.send(createReadStream(path));
  });
  app.get('/api/channels', { preHandler: auth }, async () => ({ channels: store.channels() }));
  app.get('/api/users', { preHandler: auth }, async () => ({ users: db.prepare('SELECT id, username, displayName, role FROM users ORDER BY displayName COLLATE NOCASE').all() }));
  app.get('/api/unread', { preHandler: auth }, async req => ({ channels: store.unread(req.user!.id) }));
  app.post('/api/channels/:id/read', { preHandler: auth }, async req => {
    const id = channelId(req); requireChannel(id);
    const { messageId } = z.object({ messageId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(req.body);
    store.markRead(req.user!.id, id, messageId);
    sendUnread(req.user!.id);
    return { ok: true };
  });
  app.get('/api/voice-presence', { preHandler: auth }, async () => { await refreshVoicePresence(); return voicePresence; });
  app.post('/api/voice-state', { preHandler: auth }, async req => {
    const { channelId: id, deafened } = z.object({ channelId: z.string().min(1).max(64), deafened: z.boolean() }).parse(req.body);
    const channel = requireChannel(id);
    if (channel.kind !== 'voice') throw new ApiError(400, 'Это текстовый канал.');
    voiceAudioStates.set(req.user!.id, { channelId: id, deafened, expiresAt: Date.now() + 30_000 });
    void refreshVoicePresence();
    return { ok: true };
  });
  app.post('/api/channels', { preHandler: admin }, async (req, reply) => {
    const input = z.object({ name: z.string().trim().min(1).max(32), kind: z.enum(['text', 'voice']), description: z.string().trim().max(120).default('') }).parse(req.body);
    if (store.channels().length >= 40) throw new ApiError(409, 'Можно создать до 40 каналов.');
    if (db.prepare('SELECT 1 FROM channels WHERE name = ?').get(input.name)) throw new ApiError(409, 'Такой канал уже есть.');
    const channel = { id: randomUUID(), ...input };
    db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?)').run(channel.id, channel.name, channel.kind, channel.description);
    broadcast({ type: 'channels', channels: store.channels() });
    return reply.code(201).send({ channel });
  });
  app.delete('/api/channels/:id', { preHandler: admin }, async req => {
    const id = channelId(req); const channel = requireChannel(id);
    const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
    if (confirmation !== channel.name) throw new ApiError(400, 'Введите название канала для подтверждения.');
    deletingChannels.add(id);
    try {
      if (channel.kind === 'voice') {
        try { await media.deleteRoom(id); }
        catch { throw new ApiError(503, 'Не удалось завершить звонок. Канал сохранён, попробуйте ещё раз.'); }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM messages WHERE channelId = ?').run(id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const channels = store.channels();
      broadcast({ type: 'channel-deleted', channelId: id });
      sendUnread();
      broadcast({ type: 'channels', channels });
      delete voicePresence.rooms[id];
      broadcast({ type: 'voice-presence', ...voicePresence });
      return { ok: true, channels };
    } finally { deletingChannels.delete(id); }
  });
  app.get('/api/channels/:id/messages', { preHandler: auth }, async req => {
    const id = channelId(req); requireChannel(id);
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(req.query);
    const ids = db.prepare('SELECT id FROM messages WHERE channelId = ? AND id < ? ORDER BY id DESC LIMIT 51').all(id, before ?? Number.MAX_SAFE_INTEGER) as { id: number }[];
    return { messages: ids.slice(0, 50).reverse().map(row => store.message(row.id)), hasMore: ids.length > 50 };
  });
  app.post('/api/channels/:id/messages', { preHandler: auth, bodyLimit: 7 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = channelId(req); requireChannel(id);
    const { body, image } = z.object({ body: z.string().trim().max(4000), image: z.string().max(7 * 1024 * 1024).optional() }).parse(req.body);
    if (!body && !image) throw new ApiError(400, 'Напишите сообщение или прикрепите изображение.');
    const attachment = image ? decodeImage(image) : null;
    db.exec('BEGIN IMMEDIATE');
    let message;
    try {
      const inserted = db.prepare('INSERT INTO messages (channelId, userId, body, createdAt) VALUES (?, ?, ?, ?)').run(id, req.user!.id, body, Date.now());
      if (attachment) db.prepare('INSERT INTO message_images (messageId, mime, data) VALUES (?, ?, ?)').run(Number(inserted.lastInsertRowid), attachment.mime, attachment.data);
      message = store.message(Number(inserted.lastInsertRowid));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    broadcast({ type: 'message', message });
    const mentions = new Set(mentionNames(body));
    if (mentions.size) for (const [socket, state] of sockets) {
      if (state.user.id !== req.user!.id && mentions.has(state.user.username) && store.sessionUser(state.hash)) {
        send(socket, { type: 'mention', channelId: id, channelName: requireChannel(id).name, author: req.user!.displayName });
      }
    }
    sendUnread();
    return reply.code(201).send({ message });
  });
  app.get('/api/messages/:id/image', { preHandler: auth }, async (req, reply) => {
    const id = z.coerce.number().int().positive().parse(channelId(req));
    const image = db.prepare('SELECT mime, data FROM message_images WHERE messageId = ?').get(id) as { mime: string; data: Uint8Array } | undefined;
    if (!image) throw new ApiError(404, 'Изображение не найдено.');
    return reply.header('X-Content-Type-Options', 'nosniff').type(image.mime).send(Buffer.from(image.data));
  });
  app.delete('/api/messages/:id', { preHandler: auth }, async req => {
    const id = z.coerce.number().int().positive().parse(channelId(req));
    const message = store.message(id);
    if (!message) throw new ApiError(404, 'Сообщение не найдено.');
    if (req.user!.role !== 'admin' && message.user.id !== req.user!.id) throw new ApiError(403, 'Нельзя удалить чужое сообщение.');
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    broadcast({ type: 'message-deleted', id, channelId: message.channelId });
    sendUnread();
    return { ok: true };
  });
  app.delete('/api/channels/:id/messages', { preHandler: admin }, async req => {
    const id = channelId(req); const channel = requireChannel(id);
    const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
    if (confirmation !== channel.name) throw new ApiError(400, 'Введите название канала для подтверждения.');
    db.prepare('DELETE FROM messages WHERE channelId = ?').run(id);
    broadcast({ type: 'history-cleared', channelId: id });
    sendUnread();
    return { ok: true };
  });
  app.post('/api/channels/:id/voice-token', { preHandler: auth, config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async req => {
    const channel = requireChannel(channelId(req));
    if (channel.kind !== 'voice') throw new ApiError(400, 'Это текстовый канал.');
    const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { identity: req.user!.id, name: req.user!.displayName, ttl: '2m' });
    token.addGrant({ roomJoin: true, room: channel.id, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
    return { token: await token.toJwt(), url: config.LIVEKIT_URL };
  });
  app.get('/api/invites', { preHandler: admin }, async () => ({ invites: db.prepare('SELECT id, expiresAt, usedAt, createdAt FROM invites WHERE role = ? ORDER BY createdAt DESC LIMIT 100').all('member') }));
  app.post('/api/invites', { preHandler: admin, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (_req, reply) => {
    const secret = newSecret(); const id = randomUUID(); const expiresAt = Date.now() + 7 * DAY;
    db.prepare('INSERT INTO invites VALUES (?, ?, ?, ?, ?, NULL, ?)').run(id, digest(secret), 'member', _req.user!.id, expiresAt, Date.now());
    // Fragment keeps the invitation out of HTTP requests and server logs.
    return reply.code(201).send({ id, url: `${config.APP_ORIGIN}/#invite=${secret}`, expiresAt });
  });
  app.delete('/api/invites/:id', { preHandler: admin }, async req => {
    db.prepare('DELETE FROM invites WHERE id = ? AND role = ?').run(channelId(req), 'member');
    return { ok: true };
  });
  app.get('/api/events', { websocket: true, preHandler: auth }, (socket, req) => {
    if ([...sockets.values()].filter(s => s.user.id === req.user!.id).length >= 5) { socket.close(1008, 'Too many tabs'); return; }
    sockets.set(socket, { user: req.user!, hash: req.sessionHash!, alive: true });
    socket.on('pong', () => { const state = sockets.get(socket); if (state) state.alive = true; });
    socket.on('message', () => socket.close(1008, 'Read-only stream'));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { sockets.delete(socket); presence(); });
    send(socket, { type: 'ready' }); presence();
    send(socket, { type: 'unread', channels: store.unread(req.user!.id) });
    send(socket, { type: 'voice-presence', ...voicePresence });
    void refreshVoicePresence();
  });
  const voiceHeartbeat = setInterval(() => { if (sockets.size) void refreshVoicePresence(); }, 3000);
  voiceHeartbeat.unref();
  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.alive) { socket.terminate(); continue; }
      if (!store.sessionUser(state.hash)) { socket.close(1008, 'Session expired'); continue; }
      state.alive = false; socket.ping();
    }
    for (const [key, value] of attempts) if (value.expires < Date.now()) attempts.delete(key);
    for (const [key, value] of voiceAudioStates) if (value.expiresAt <= Date.now()) voiceAudioStates.delete(key);
    store.cleanup();
  }, 30_000);
  heartbeat.unref();
  const dist = resolve('dist');
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist, maxAge: 0 });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.headers.accept?.includes('text/html')) return reply.sendFile('index.html');
      return reply.code(404).send({ message: 'Не найдено.' });
    });
  }
  app.addHook('preClose', async () => { closing = true; clearInterval(voiceHeartbeat); for (const socket of sockets.keys()) socket.terminate(); await presenceRequest; });
  app.addHook('onClose', async () => { clearInterval(heartbeat); db.close(); });
  return app;
}
