import test from 'node:test';
import assert from 'node:assert/strict';
import type { Room } from 'livekit-client';
import { selectOutput, supportsOutputSelection } from '../src/AudioOutput.tsx';

function outputRoom() {
  const context = { sinkId: 'old', async setSinkId(id: string) { if (id === 'denied') throw new Error('Not allowed'); this.sinkId = id; } };
  const participant = { deviceId: 'old', async setAudioOutput({ deviceId }: { deviceId: string }) { this.deviceId = deviceId; } };
  const room = { options: { webAudioMix: { audioContext: context }, audioOutput: { deviceId: 'old' } }, remoteParticipants: new Map([['friend', participant]]), getActiveDevice: () => 'default' };
  return { context, participant, room: room as unknown as Room };
}
test('speaker selection changes the amplified destination and media elements; default resets both', async () => {
  const { context, participant, room } = outputRoom();
  assert.equal(supportsOutputSelection(room), true);
  await selectOutput(room, 'headphones');
  assert.equal(context.sinkId, 'headphones'); assert.equal(participant.deviceId, 'headphones'); assert.equal(room.options.audioOutput?.deviceId, 'headphones');
  await selectOutput(room, 'default');
  assert.equal(context.sinkId, ''); assert.equal(participant.deviceId, 'default');
});
test('permission denial and partial switching failures keep the previous output', async () => {
  const { context, participant, room } = outputRoom();
  await assert.rejects(selectOutput(room, 'denied'));
  assert.equal(context.sinkId, 'old'); assert.equal(room.options.audioOutput?.deviceId, 'old');
  participant.setAudioOutput = async ({ deviceId }) => { if (deviceId === 'disconnected') throw new Error('Unplugged'); participant.deviceId = deviceId; };
  await assert.rejects(selectOutput(room, 'disconnected'));
  assert.equal(context.sinkId, 'old'); assert.equal(participant.deviceId, 'old'); assert.equal(room.options.audioOutput?.deviceId, 'old');
});
