import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function setup() {
  const sent: any[] = [], timers = new Map<number, () => void>();
  let receive: (event: { data: unknown }) => void = () => {};
  let nextTimer = 0;
  const delays: number[] = [];
  const webview = {
    postMessage: (message: unknown) => sent.push(message),
    addEventListener: (_type: string, callback: typeof receive) => { receive = callback; },
  };
  const window: any = { chrome: { webview } };
  runInNewContext(readFileSync(new URL('../desktop/webview/bridge.js', import.meta.url), 'utf8'), {
    window, Uint8Array, atob,
    setTimeout: (callback: () => void, delay: number) => { delays.push(delay); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { bridge: window.krugDesktop, sent, receive: (data: unknown) => receive({ data }), timers, delays };
}

test('WebView bridge resolves host replies and rejects requests that time out', async () => {
  const { bridge, sent, receive, timers, delays } = setup();
  const first = bridge.startAudio();
  assert.equal(delays[0], 120000);
  assert.equal(sent[0].method, 'audio-start');
  receive({ type: 'result', id: sent[0].id, value: true });
  assert.equal(await first, true);
  assert.equal(timers.size, 0);
  const second = bridge.getUpdateState();
  assert.equal(delays[1], 15000);
  for (const timeout of timers.values()) timeout();
  await assert.rejects(second, /did not respond/);
  receive({ type: 'result', id: sent[1].id, value: 'late' });
});

test('WebView bridge ignores malformed and oversized PCM messages', () => {
  const { bridge, receive } = setup();
  const received: number[][] = [];
  const unsubscribe = bridge.onAudio((bytes: Uint8Array) => received.push([...bytes]));
  receive({ type: 'audio', data: 'invalid!' });
  receive({ type: 'audio', data: 'A'.repeat(128 * 1024 + 4) });
  receive({ type: 'audio', data: 'AQID' });
  unsubscribe();
  receive({ type: 'audio', data: 'BAUG' });
  assert.deepEqual(received, [[1, 2, 3]]);
});
