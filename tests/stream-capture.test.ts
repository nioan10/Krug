import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireDesktopCapture, captureWindow } from '../src/desktop-capture.ts';

class FakeTrack extends EventTarget {
  readyState = 'live'; contentHint = ''; stopped = 0;
  constructor(public surface = 'window') { super(); }
  getSettings() { return { displaySurface: this.surface }; }
  stop() { this.stopped++; this.readyState = 'ended'; }
}
class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

test('public capture only accepts a window, never requests system audio, and serializes capture ownership', async t => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldMedia = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
  let track = new FakeTrack(), stops = 0, starts = 0, requested: any, resolvePicker: ((s: FakeStream) => void) | undefined;
  const bridge = { async stopAudio() { stops++; }, async startAudio() { starts++; return true; }, onAudioEnded() { return () => {}; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { krugDesktop: bridge } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getDisplayMedia(options: unknown) { requested = options; return resolvePicker === undefined ? new FakeStream([track]) : new Promise<FakeStream>(r => { resolvePicker = r; }); } } } });
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: FakeStream });
  t.after(() => { for (const [key, descriptor] of [['window', oldWindow], ['navigator', oldNavigator], ['MediaStream', oldMedia]] as const) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

  const controller = new AbortController();
  const capture = await captureWindow('720p60', false, controller.signal, () => {});
  assert.equal(requested.audio, false); assert.equal(requested.video.displaySurface, 'window'); assert.equal(starts, 0);
  assert.throws(acquireDesktopCapture, /остановите/);
  await capture.stop(); await capture.stop(); assert.equal(stops, 1); assert.equal(track.stopped, 1);
  const release = acquireDesktopCapture(); release();

  track = new FakeTrack('monitor');
  await assert.rejects(captureWindow('1080p60', false, new AbortController().signal, () => {}), /отдельное окно/);
  assert.equal(track.readyState, 'ended');

  track = new FakeTrack(); resolvePicker = () => {};
  const abort = new AbortController(); const pending = captureWindow('720p60', false, abort.signal, () => {});
  abort.abort(); await Promise.resolve();
  assert.throws(acquireDesktopCapture, /остановите/, 'pending picker must retain the lock after cancellation');
  resolvePicker(new FakeStream([track]));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(track.readyState, 'ended');
  acquireDesktopCapture()();
});
