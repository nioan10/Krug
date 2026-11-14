import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasVisibleCamera } from '../src/camera-state.ts';

test('muted or detached camera publications fall back to the participant avatar', () => {
  const active = { isMuted: false, track: {} };
  assert.equal(hasVisibleCamera(active, false), true);
  assert.equal(hasVisibleCamera({ ...active, isMuted: true }, false), false);
  assert.equal(hasVisibleCamera(active, true), false);
  assert.equal(hasVisibleCamera({ isMuted: false }, false), false);
  assert.equal(hasVisibleCamera(undefined, false), false);
});
