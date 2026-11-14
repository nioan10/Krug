import { RoomServiceClient, ServerError, TrackSource, type ParticipantInfo } from 'livekit-server-sdk';
import type { Config } from './config.ts';

export type VoiceOccupant = { identity: string; microphoneEnabled: boolean; room?: string };
export function voiceOccupant(participant: Pick<ParticipantInfo, 'identity' | 'tracks'>): VoiceOccupant {
  return {
    identity: participant.identity,
    microphoneEnabled: participant.tracks.some(track => track.source === TrackSource.MICROPHONE && !track.muted),
  };
}
export interface MediaService {
  deleteRoom(id: string): Promise<void>;
  participants(channelIds: string[]): Promise<Record<string, VoiceOccupant[]>>;
  removeParticipant(channelId: string, userId: string): Promise<void>;
}

export function createMediaService(config: Config): MediaService {
  const client = new RoomServiceClient(config.LIVEKIT_URL.replace(/^ws/, 'http'), config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { requestTimeout: 8 });
  const missing = (error: unknown) => error instanceof ServerError && error.code === 'not_found';
  return {
    async deleteRoom(id) {
      try { await client.deleteRoom(id); }
      catch (error) { if (!missing(error)) throw error; }
    },
    async removeParticipant(channelId, userId) {
      try { await client.removeParticipant(channelId, userId); }
      catch (error) { if (!missing(error)) throw error; }
    },
    async participants(channelIds) {
      if (!channelIds.length) return {};
      const rooms = await client.listRooms(channelIds);
      return Object.fromEntries(await Promise.all(rooms.filter(room => channelIds.includes(room.name) && room.numParticipants > 0).map(async room => {
        try { return [room.name, (await client.listParticipants(room.name)).map(voiceOccupant)]; }
        catch (error) { if (missing(error)) return [room.name, []]; throw error; }
      })));
    },
  };
}
