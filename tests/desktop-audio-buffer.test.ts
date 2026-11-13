import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopAudioBuffer } from '../src/desktop-audio-buffer.ts';

test('desktop PCM preserves stereo frames split across arbitrary IPC packets', () => {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  [0.25, -0.5, 0.75, -1].forEach((v, i) => view.setFloat32(i * 4, v, true));
  const buffer = new DesktopAudioBuffer(3);
  buffer.push(bytes.slice(0, 3)); buffer.push(bytes.slice(3, 11)); buffer.push(bytes.slice(11));
  const left = new Float32Array(3), right = new Float32Array(3);
  buffer.pull(left, right);
  assert.deepEqual([...left], [0.25, 0.75, 0]);
  assert.deepEqual([...right], [-0.5, -1, 0]);
});

test('desktop PCM discards oldest frames when the renderer falls behind', () => {
  const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
  [1, 11, 2, 12, 3, 13].forEach((v, i) => view.setFloat32(i * 4, v, true));
  const buffer = new DesktopAudioBuffer(2); buffer.push(bytes);
  const left = new Float32Array(2), right = new Float32Array(2); buffer.pull(left, right);
  assert.deepEqual([...left], [2, 3]); assert.deepEqual([...right], [12, 13]);
});
