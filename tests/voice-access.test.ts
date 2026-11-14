import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAccessMonitor, type VoiceAccess } from '../src/voice-access.ts';
import { HttpError } from '../src/api.ts';

const valid = { enabled: true, roster: 'current-roster' };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(request: (signal: AbortSignal) => Promise<VoiceAccess>) {
  const waiting: boolean[] = [], denied: string[] = [];
  const monitor = new VoiceAccessMonitor({ expected: valid, request, waiting: value => waiting.push(value), denied: message => denied.push(message) });
  return { monitor, waiting, denied };
}

test('temporary network, HTTP 429 and 503 failures preserve the call and recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [new TypeError('Failed to fetch'), new HttpError(429, 'Slow down'), new HttpError(503, 'Offline')];
  const f = fixture(async () => { const error = failures.shift(); if (error) throw error; return valid; });
  t.after(() => f.monitor.stop());
  f.monitor.check(); await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(3000); await flush(); }
  assert.deepEqual(f.waiting, [true, true, true, false]); assert.deepEqual(f.denied, []);
  t.mock.timers.tick(30_000); await flush(); assert.deepEqual(f.denied, []);
});

test('a sustained outage expires once and repeated checks cannot extend the grace window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => { throw new TypeError('offline'); });
  f.monitor.check(); await flush();
  for (let i = 0; i < 9; i++) { t.mock.timers.tick(3000); f.monitor.check(); await flush(); }
  assert.equal(f.denied.length, 0);
  t.mock.timers.tick(3000); await flush(); assert.equal(f.denied.length, 1);
  assert.match(f.denied[0], /30 секунд/);
  f.monitor.check(); t.mock.timers.tick(60_000); await flush(); assert.equal(f.denied.length, 1);
});

test('hung requests are aborted and cannot defeat the bounded outage timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const f = fixture(signal => { signals.push(signal); return new Promise(() => {}); });
  f.monitor.check(); t.mock.timers.tick(8000); await flush();
  assert.equal(signals[0].aborted, true); assert.deepEqual(f.waiting, [true]);
  t.mock.timers.tick(3000); await flush();
  t.mock.timers.tick(27_000); await flush();
  assert.equal(f.denied.length, 1); assert(signals.every(signal => signal.aborted));
});

test('session revocation, changed roster and encryption downgrade stop immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of [new HttpError(401, 'expired'), new HttpError(403, 'revoked'), new HttpError(404, 'gone'), { enabled: true, roster: 'replacement' }, { enabled: false, roster: valid.roster }, new Error('Known key changed')]) {
    const f = fixture(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
    f.monitor.check(); await flush();
    assert.equal(f.denied.length, 1); assert.deepEqual(f.waiting, []);
  }
});

test('overlapping checks coalesce and a stopped call ignores late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0; let resolve!: (value: VoiceAccess) => void;
  const f = fixture(() => { requests++; return new Promise(done => { resolve = done; }); });
  f.monitor.check(); f.monitor.check(); f.monitor.check(); assert.equal(requests, 1);
  resolve(valid); await flush(); t.mock.timers.tick(0); await flush(); assert.equal(requests, 2);
  f.monitor.stop(); resolve({ enabled: false, roster: '' }); await flush(); t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(f.denied, []); assert.deepEqual(f.waiting, [false]); assert.equal(requests, 2);
});
