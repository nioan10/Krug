import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAudioLevels, incomingLevel, parseAudioLevels, screenLevel } from '../src/audio-levels.ts';

test('stored audio settings reject invalid values and keep legitimate silence', () => {
  for (const raw of [null, 'invalid', 'null']) assert.deepEqual(parseAudioLevels(raw), defaultAudioLevels());
  const values = parseAudioLevels('{"master":0,"microphone":20,"participants":{"one":-3,"two":"loud","three":0.5}}');
  assert.deepEqual(values, { master: 0, microphone: 2, participants: { one: 0, two: 1, three: 0.5 }, screens: {}, screenDefaults: { one: 0, two: 1, three: 0.5 } });
});
test('participant volume combines with master volume and does not change microphone level', () => {
  const values = { ...defaultAudioLevels(), master: 0.5, microphone: 2, participants: { quiet: 0.4, silent: 0 } };
  assert.equal(incomingLevel(values, 'quiet'), 0.2);
  assert.equal(incomingLevel(values, 'silent'), 0);
  assert.equal(incomingLevel(values, 'new-person'), 0.5);
  assert.equal(values.microphone, 2);
});

test('screen audio is independent of voice and of a second device sharing on the same account', () => {
  const values = { ...defaultAudioLevels(), master: 0.5, participants: { user: 0 }, screens: { desktop: 1.501, laptop: 0 } };
  assert.equal(incomingLevel(values, 'user'), 0);
  assert.equal(incomingLevel(values, 'user', 'desktop'), 0.7505);
  assert.equal(incomingLevel(values, 'user', 'laptop'), 0);
  values.participants.user = 2;
  assert.equal(incomingLevel(values, 'user', 'desktop'), 0.7505);
  values.master = 0;
  assert.equal(incomingLevel(values, 'user', 'desktop'), 0);
});

test('upgrade preserves old muted screen audio without coupling it to later voice changes', () => {
  const values = parseAudioLevels('{"participants":{"silent":0,"quiet":0.333}}');
  values.participants.silent = 1;
  assert.equal(screenLevel(values, 'session-a', 'silent'), 0);
  values.screens['session-a'] = 1.251;
  const restored = parseAudioLevels(JSON.stringify(values));
  assert.equal(screenLevel(restored, 'session-a', 'silent'), 1.251);
  assert.equal(screenLevel(restored, 'session-b', 'silent'), 0);
  assert.equal(screenLevel(restored, 'session-c', 'quiet'), 0.333);
  assert.equal(screenLevel(restored, 'session-d', 'new'), 1);
});

test('amplification survives storage and combines without the media-element 100% ceiling', () => {
  const values = parseAudioLevels('{"master":1.501,"microphone":1.251,"participants":{"loud":2,"quiet":0.333}}');
  assert.equal(values.master, 1.501); assert.equal(values.microphone, 1.251);
  assert.equal(incomingLevel(values, 'loud'), 3.002);
  assert.equal(incomingLevel(values, 'quiet'), 1.501 * 0.333);
  assert.equal(parseAudioLevels('{"master":9,"participants":{"loud":9}}').participants.loud, 2);
});
