import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticipantInfo, TrackInfo, TrackSource } from 'livekit-server-sdk';
import { voiceOccupant } from '../server/media.ts';

test('voice presence derives microphone state from the published microphone track', () => {
  const participant = new ParticipantInfo({ identity: 'person', tracks: [], attributes: {} });
  assert.deepEqual(voiceOccupant(participant), { identity: 'person', microphoneEnabled: false });
  participant.tracks.push(new TrackInfo({ source: TrackSource.MICROPHONE, muted: false }));
  assert.deepEqual(voiceOccupant(participant), { identity: 'person', microphoneEnabled: true });
  participant.tracks[0].muted = true;
  assert.deepEqual(voiceOccupant(participant), { identity: 'person', microphoneEnabled: false });
});
