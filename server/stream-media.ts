import { AccessToken, RoomServiceClient, ServerError, TrackSource } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import { guestLabel } from './stream-store.ts';
import type { StreamConfig } from './stream-config.ts';
import type { Broadcast, StreamStore } from './stream-store.ts';

export interface StreamMedia {
  create(id: string): Promise<void>;
  close(id: string): Promise<void>;
  inspect(id: string, publisherId: string): Promise<{ publishing: boolean; viewers: number }>;
  prune?(activeRoomIds: () => string[]): Promise<void>;
}
export function createStreamMedia(config: StreamConfig): StreamMedia {
  const client = new RoomServiceClient(config.STREAM_LIVEKIT_URL.replace(/^ws/, 'http'), config.STREAM_LIVEKIT_API_KEY, config.STREAM_LIVEKIT_API_SECRET, { requestTimeout: 5 });
  const missing = (error: unknown) => error instanceof ServerError && error.code === 'not_found';
  return {
    async create(id) { await client.createRoom({ name: id, maxParticipants: 16, emptyTimeout: 120, departureTimeout: 30 }); },
    async close(id) { try { await client.deleteRoom(id); } catch (error) { if (!missing(error)) throw error; } },
    async prune(activeRoomIds) {
      const rooms = await client.listRooms();
      // A stream can start while the media request is in flight. Read the store
      // afterwards so that its newly created room is never treated as abandoned.
      const active = new Set(activeRoomIds());
      for (const room of rooms) if (!active.has(room.name)) {
        try { await client.deleteRoom(room.name); } catch (error) { if (!missing(error)) throw error; }
      }
    },
    async inspect(id, publisherId) {
      try {
        const participants = await client.listParticipants(id);
        return { publishing: Boolean(participants.find(p => p.identity === publisherId)?.tracks.some(t => t.source === TrackSource.SCREEN_SHARE && !t.muted)), viewers: participants.filter(p => p.identity.startsWith('guest-')).length };
      } catch (error) { if (missing(error)) return { publishing: false, viewers: 0 }; throw error; }
    },
  };
}
export async function streamToken(config: StreamConfig, stream: Broadcast, identity: string, publisher: boolean) {
  // Each player tab needs its own media identity; the anonymous chat ID stays stable.
  const token = new AccessToken(config.STREAM_LIVEKIT_API_KEY, config.STREAM_LIVEKIT_API_SECRET, { identity: publisher ? identity : `${identity}.${randomBytes(8).toString('hex')}`, name: publisher ? 'Источник эфира' : guestLabel(identity), ttl: '2m' });
  token.addGrant({ roomJoin: true, room: stream.id, canPublish: publisher, canPublishSources: publisher ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [], canSubscribe: !publisher, canPublishData: false, canUpdateOwnMetadata: false });
  return { token: await token.toJwt(), url: config.STREAM_LIVEKIT_URL };
}
export async function sweepStreams(store: StreamStore, media: StreamMedia) {
  store.expire();
  for (const stream of store.pendingClose()) {
    try { await media.close(stream.id); store.db.prepare('UPDATE broadcasts SET mediaClosed=1 WHERE id=?').run(stream.id); } catch { /* Retry on the next sweep; no new access tokens are issued. */ }
  }
  // A previously issued/reconnected JWT can recreate an ended room. The public
  // media service is dedicated to streams; remove rooms absent from its store.
  await media.prune?.(() => store.active().map(stream => stream.id));
}
