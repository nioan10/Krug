import { RoomServiceClient, ServerError } from 'livekit-server-sdk';
import type { Config } from './config.ts';

export interface MediaService {
  deleteRoom(id: string): Promise<void>;
}

export function createMediaService(config: Config): MediaService {
  const client = new RoomServiceClient(config.LIVEKIT_URL.replace(/^ws/, 'http'), config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { requestTimeout: 8 });
  const missing = (error: unknown) => error instanceof ServerError && error.code === 'not_found';
  return {
    async deleteRoom(id) {
      try { await client.deleteRoom(id); }
      catch (error) { if (!missing(error)) throw error; }
    },
  };
}
