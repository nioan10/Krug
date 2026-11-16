import test from 'node:test';
import assert from 'node:assert/strict';
import type { Room, ExternalE2EEKeyProvider } from 'livekit-client';
import { VoiceRekey } from '../src/voice-rekey.ts';

test('rekey stops old publication before changing key, retains muted mic and screen capture', async () => {
  const calls: string[] = [];
  const tracks = ['mic', 'screen'].map(name => ({ name, isMuted: name === 'mic', mediaStreamTrack: { readyState: 'live' }, stop() { calls.push(`stop:${name}`); } }));
  const room = { localParticipant: {
    trackPublications: new Map(tracks.map(track => [track.name, { track, source: track.name }])),
    async unpublishTrack(track: typeof tracks[0], stop: boolean) { assert.equal(stop, false); calls.push(`unpublish:${track.name}`); },
    async publishTrack(track: typeof tracks[0]) { calls.push(`publish:${track.name}`); },
  }, async disconnect(stop: boolean) { assert.equal(stop, false); calls.push('disconnect'); }, async setE2EEEnabled(value: boolean) { assert(value); calls.push('e2ee'); }, async connect() { calls.push('connect'); } };
  const provider = { async setKey() { calls.push('key'); } };
  const handover = new VoiceRekey(room as unknown as Room, provider as unknown as ExternalE2EEKeyProvider);
  await handover.switch(new ArrayBuffer(32), 'url', 'token', new AbortController().signal);
  assert.deepEqual(calls, ['unpublish:mic', 'unpublish:screen', 'disconnect', 'key', 'e2ee', 'connect', 'publish:mic', 'publish:screen']);
  assert(tracks[0].isMuted); handover.stop(); assert(!calls.some(c => c.startsWith('stop:')));
});

test('leaving during a delayed key change stops retained captures and prevents reconnect', async () => {
  const controller = new AbortController(); let connected = false, stopped = false;
  let release!: () => void;
  const track = { mediaStreamTrack: { readyState: 'live' }, stop() { stopped = true; } };
  const room = { localParticipant: { trackPublications: new Map([['mic', { track, source: 'mic' }]]), async unpublishTrack() {}, async publishTrack() { throw Error('Should not publish'); } }, async disconnect() {}, async setE2EEEnabled() {}, async connect() { connected = true; } };
  const provider = { async setKey() { await new Promise<void>(resolve => { release = resolve; }); } };
  const handover = new VoiceRekey(room as unknown as Room, provider as unknown as ExternalE2EEKeyProvider);
  const pending = handover.switch(new ArrayBuffer(32), 'url', 'token', controller.signal);
  while (!release) await Promise.resolve();
  controller.abort(); handover.stop(); release();
  await assert.rejects(pending); assert(stopped); assert(!connected);
});
