import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAudioLevels, incomingLevel, parseAudioLevels } from '../src/audio-levels.ts';

test('stored audio settings reject invalid values and keep legitimate silence', () => {
  for (const raw of [null, 'invalid', 'null']) assert.deepEqual(parseAudioLevels(raw), defaultAudioLevels());
  const values = parseAudioLevels('{"master":0,"microphone":20,"participants":{"one":-3,"two":"loud","three":0.5}}');
  assert.deepEqual(values, { master: 0, microphone: 2, participants: { one: 0, two: 1, three: 0.5 } });
});
test('participant volume combines with master volume and does not change microphone level', () => {
  const values = { master: 0.5, microphone: 2, participants: { quiet: 0.4, silent: 0 } };
  assert.equal(incomingLevel(values, 'quiet'), 0.2);
  assert.equal(incomingLevel(values, 'silent'), 0);
  assert.equal(incomingLevel(values, 'new-person'), 0.5);
  assert.equal(values.microphone, 2);
});

test('amplification survives storage and combines without the media-element 100% ceiling', () => {
  const values = parseAudioLevels('{"master":1.501,"microphone":1.251,"participants":{"loud":2,"quiet":0.333}}');
  assert.equal(values.master, 1.501); assert.equal(values.microphone, 1.251);
  assert.equal(incomingLevel(values, 'loud'), 3.002);
  assert.equal(incomingLevel(values, 'quiet'), 1.501 * 0.333);
  assert.equal(parseAudioLevels('{"master":9,"participants":{"loud":9}}').participants.loud, 2);
});
