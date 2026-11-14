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
      const rooms = await client.listRooms();
      for (const room of rooms.filter(r => r.name === id || r.name.startsWith(`${id}.e2ee.`))) {
        try { await client.deleteRoom(room.name); } catch (error) { if (!missing(error)) throw error; }
      }
    },
    async removeParticipant(channelId, userId) {
      const rooms = await client.listRooms();
      for (const room of rooms.filter(r => r.name === channelId || r.name.startsWith(`${channelId}.e2ee.`))) {
        try { await client.removeParticipant(room.name, userId); } catch (error) { if (!missing(error)) throw error; }
      }
    },
    async participants(channelIds) {
      if (!channelIds.length) return {};
      const rooms = await client.listRooms();
      const result: Record<string, VoiceOccupant[]> = {};
      await Promise.all(rooms.filter(room => room.numParticipants > 0).map(async room => {
        const channel = channelIds.find(id => room.name === id || room.name.startsWith(`${id}.e2ee.`));
        if (!channel) return;
        try { const people = (await client.listParticipants(room.name)).map(p => ({ ...voiceOccupant(p), room: room.name })); (result[channel] ??= []).push(...people); }
        catch (error) { if (!missing(error)) throw error; }
      }));
      return result;
    },
  };
}
