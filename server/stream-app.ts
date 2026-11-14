import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { StreamConfig } from './stream-config.ts';
import { ApiError } from './security.ts';
import { guestLabel, openStreamStore, publicBroadcast } from './stream-store.ts';
import { createStreamMedia, streamToken, sweepStreams, type StreamMedia } from './stream-media.ts';

/** Public process: no Krug account database, session cookie or private media credentials. */
export async function buildStreamApp(config: StreamConfig, media: StreamMedia = createStreamMedia(config)) {
  const app = Fastify({ bodyLimit: 4096, logger: config.NODE_ENV !== 'test' ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] } : false, logController: new LogController({ disableRequestLogging: true }), trustProxy: config.NODE_ENV === 'production' ? ['127.0.0.1', '::1'] : false });
  const store = openStreamStore(config.STREAM_DATABASE_PATH);
  const allowed = [config.STREAM_ORIGIN, config.APP_ORIGIN];
  const sockets = new Map<WebSocket, { id: string; token: string; guestId: string; last: string; alive: boolean }>();
  const idOf = (req: FastifyRequest) => z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(req.params).id;
  const cookieName = (id: string) => `${config.NODE_ENV === 'production' ? '__Host-' : ''}stream_${id}`;
  function guestOf(req: FastifyRequest, id: string) {
    const token = req.cookies[cookieName(id)] || '';
    const guest = /^[A-Za-z0-9_-]{43}$/.test(token) ? store.guest(id, token) : undefined;
    if (!guest) throw new ApiError(401, 'Гостевая сессия завершилась. Обновите страницу.');
    return { token, guest };
  }
  function snapshot(id: string, token: string) {
    const guest = store.guest(id, token); if (!guest) throw new ApiError(401, 'Гостевая сессия завершилась.');
    return { type: 'snapshot', stream: publicBroadcast(store.require(id)), guest: { id: guest.id, label: guestLabel(guest.id), banned: Boolean(guest.banned) }, messages: store.messages(id) };
  }
  await app.register(cookie);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'", config.STREAM_LIVEKIT_URL, config.STREAM_LIVEKIT_URL.replace(/^ws/, 'http')], imgSrc: ["'self'", 'data:'], mediaSrc: ["'self'", 'blob:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null } }, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'no-referrer' } });
  await app.register(websocket, { options: { maxPayload: 1024, perMessageDeflate: false } });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow').header('Permissions-Policy', 'camera=(), microphone=(), display-capture=(), geolocation=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin').header('Access-Control-Allow-Credentials', 'true');
    }
    if ((!['GET', 'HEAD'].includes(req.method) || req.headers.upgrade?.toLowerCase() === 'websocket') && (!origin || !allowed.includes(origin))) throw new ApiError(403, 'Запрос с другого сайта отклонён.');
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type').header('Access-Control-Max-Age', '600');
      return reply.code(204).send();
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: 'Проверьте введённые данные.' });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error({ err: error }, 'Stream request failed');
    reply.code(status).send({ message: status >= 500 ? 'Сервис временно недоступен.' : (error as Error).message });
  });
  app.get('/api/health', async () => ({ ok: true, service: 'streams' }));
  app.get('/api/streams/:id', async req => ({ stream: publicBroadcast(store.require(idOf(req))) }));
  app.post('/api/streams/:id/guest', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = idOf(req); store.require(id);
    let token = req.cookies[cookieName(id)] || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !store.guest(id, token)) {
      token = store.newGuest(id).token;
      reply.setCookie(cookieName(id), token, { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 7 * 86400 });
    }
    return snapshot(id, token);
  });
  app.post('/api/streams/:id/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const id = idOf(req), stream = store.require(id); const { guest } = guestOf(req, id);
    if (stream.state !== 'live' || stream.leaseUntil <= Date.now()) throw new ApiError(409, 'Эфир ещё не начался или уже завершён.');
    return streamToken(config, stream, guest.id, false);
  });
  app.post('/api/streams/:id/messages', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = idOf(req), stream = store.require(id); const { guest } = guestOf(req, id);
    if (guest.banned) throw new ApiError(403, 'Вам запрещено писать в этом эфире.');
    if (stream.state !== 'live' || stream.leaseUntil <= Date.now()) throw new ApiError(409, 'Чат этого эфира закрыт.');
    const { body } = z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body);
    store.send(id, guest.id, body); return reply.code(201).send({ ok: true });
  });
  app.get('/api/streams/:id/events', { websocket: true, preHandler: async req => { const id = idOf(req); store.require(id); guestOf(req, id); } }, (socket, req) => {
    const id = idOf(req), { guest, token } = guestOf(req, id);
    if (sockets.size >= 150 || [...sockets.values()].filter(state => state.id === id && state.guestId === guest.id).length >= 3) { socket.close(1008, 'Too many tabs'); return; }
    const last = JSON.stringify(snapshot(id, token));
    sockets.set(socket, { id, token, guestId: guest.id, last, alive: true }); socket.send(last);
    socket.on('pong', () => { const state = sockets.get(socket); if (state) state.alive = true; });
    socket.on('message', () => socket.close(1008, 'Read-only connection'));
    socket.on('error', () => socket.terminate()); socket.on('close', () => sockets.delete(socket));
  });
  const snapshots = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (socket.readyState !== 1) continue;
      if (socket.bufferedAmount > 512 * 1024) { socket.close(1013, 'Slow connection'); continue; }
      try {
        const next = JSON.stringify(snapshot(state.id, state.token));
        if (next !== state.last) { socket.send(next); state.last = next; }
      } catch { socket.close(1008, 'Session ended'); }
    }
  }, 1000);
  let closing = false; let maintenance: Promise<void> | undefined;
  function maintain() {
    if (closing || maintenance) return;
    maintenance = (async () => {
      await sweepStreams(store, media);
      for (const stream of store.active()) {
        try {
          const info = await media.inspect(stream.id, stream.publisherId);
          store.db.prepare("UPDATE broadcasts SET publishing=?,viewers=? WHERE id=? AND state!='ended'").run(Number(info.publishing), info.viewers, stream.id);
        } catch { store.db.prepare("UPDATE broadcasts SET publishing=0 WHERE id=? AND state!='ended'").run(stream.id); }
      }
    })().catch(error => app.log.error({ err: error }, 'Stream maintenance failed')).finally(() => { maintenance = undefined; });
  }
  const sweep = setInterval(maintain, 5000); maintain();
  const heartbeat = setInterval(() => { for (const [socket, state] of sockets) { if (!state.alive) socket.terminate(); else { state.alive = false; socket.ping(); } } }, 30_000);
  for (const timer of [snapshots, sweep, heartbeat]) timer.unref();
  const dist = resolve('dist');
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist, maxAge: 0, index: false });
    app.get('/', async (_req, reply) => reply.sendFile('stream.html'));
    app.get('/s/:id', async (req, reply) => { store.require(idOf(req)); return reply.sendFile('stream.html'); });
    app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  }
  app.addHook('preClose', async () => { closing = true; for (const timer of [snapshots, sweep, heartbeat]) clearInterval(timer); for (const socket of sockets.keys()) socket.terminate(); await maintenance; });
  app.addHook('onClose', async () => store.db.close());
  return app;
}
