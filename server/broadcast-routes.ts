import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { ApiError } from './security.ts';
import { openStreamStore, publicBroadcast } from './stream-store.ts';
import { createStreamMedia, streamToken, sweepStreams, type StreamMedia } from './stream-media.ts';

export async function registerBroadcasts(app: FastifyInstance, config: Config, auth: (req: FastifyRequest) => Promise<void>, suppliedMedia?: StreamMedia) {
  app.get('/api/broadcasts/config', { preHandler: auth }, async () => ({ enabled: Boolean(config.STREAM_ORIGIN), origin: config.STREAM_ORIGIN }));
  if (!config.STREAM_ORIGIN) return async (_userId: string) => true;
  const store = openStreamStore(config.STREAM_DATABASE_PATH);
  const media = suppliedMedia ?? createStreamMedia(config);
  const idOf = (req: FastifyRequest) => z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(req.params).id;
  const owned = (req: FastifyRequest) => {
    const stream = store.require(idOf(req));
    if (stream.ownerId !== req.user!.id) throw new ApiError(404, 'Эфир не найден.');
    return stream;
  };
  const active = (req: FastifyRequest) => { const stream = owned(req); if (stream.state === 'ended' || stream.leaseUntil <= Date.now()) throw new ApiError(409, 'Эфир уже завершён.'); return stream; };
  const view = (stream: ReturnType<typeof owned>) => ({ ...publicBroadcast(stream), url: `${config.STREAM_ORIGIN}/s/${stream.id}` });
  app.get('/api/broadcasts', { preHandler: auth }, async req => { store.expire(); return { streams: store.mine(req.user!.id).map(view) }; });
  app.post('/api/broadcasts', { preHandler: auth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const input = z.object({ title: z.string().trim().min(1).max(100), quality: z.enum(['720p60', '1080p60']) }).parse(req.body);
    await sweepStreams(store, media);
    await auth(req);
    const stream = store.create(req.user!.id, input.title, input.quality);
    try { await media.create(stream.id); }
    catch { store.end(stream.id); throw new ApiError(503, 'Медиасервер недоступен. Попробуйте позже.'); }
    try {
      const token = await streamToken(config, stream, stream.publisherId, true);
      await auth(req);
      if (store.require(stream.id).state === 'ended') throw new ApiError(401, 'Сессия завершилась.');
      return reply.code(201).send({ stream: view(stream), publisherIdentity: stream.publisherId, ...token });
    } catch (error) { store.end(stream.id); try { await media.close(stream.id); store.db.prepare('UPDATE broadcasts SET mediaClosed=1 WHERE id=?').run(stream.id); } catch { /* The public service retries closing the room. */ } throw error; }
  });
  app.post('/api/broadcasts/:id/live', { preHandler: auth }, async req => {
    const stream = active(req);
    if (!(await media.inspect(stream.id, stream.publisherId)).publishing) throw new ApiError(409, 'Сначала подключите трансляцию окна.');
    store.live(stream.id); store.heartbeat(stream.id); return { stream: view(store.require(stream.id)) };
  });
  app.post('/api/broadcasts/:id/heartbeat', { preHandler: auth }, async req => { const stream = active(req); store.heartbeat(stream.id); return { stream: view(store.require(stream.id)) }; });
  app.post('/api/broadcasts/:id/end', { preHandler: auth }, async req => {
    const stream = owned(req); store.end(stream.id);
    try { await media.close(stream.id); store.db.prepare('UPDATE broadcasts SET mediaClosed=1 WHERE id=?').run(stream.id); }
    catch { throw new ApiError(503, 'Эфир закрыт для новых зрителей. Завершаем медиаподключения.'); }
    return { stream: view(store.require(stream.id)) };
  });
  app.delete('/api/broadcasts/:id/messages/:messageId', { preHandler: auth }, async req => {
    const stream = owned(req); const { messageId } = z.object({ messageId: z.coerce.number().int().positive() }).parse(req.params);
    store.deleteMessage(stream.id, messageId); return { ok: true };
  });
  app.post('/api/broadcasts/:id/ban', { preHandler: auth }, async req => {
    const stream = owned(req); const { guestId } = z.object({ guestId: z.string().regex(/^guest-[a-f0-9]{16}$/) }).parse(req.body);
    store.ban(stream.id, guestId); return { ok: true };
  });
  app.addHook('onClose', async () => { store.db.close(); });
  return async (userId: string) => {
    for (const stream of store.active().filter(item => item.ownerId === userId)) store.end(stream.id);
    if (!store.pendingClose().some(item => item.ownerId === userId)) return true;
    await sweepStreams(store, media);
    return !store.pendingClose().some(item => item.ownerId === userId);
  };
}
