import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { activationSettings } from '../src/microphone-activation.ts';

function gate() {
  let Constructor: any;
  runInNewContext(readFileSync(new URL('../public/microphone-gate-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage() {} }; }, sampleRate: 48000,
    registerProcessor(_name: string, value: any) { Constructor = value; },
  });
  const instance = new Constructor();
  const run = (amplitude: number, seconds: number, threshold = -45, enabled = 1) => {
    let output!: Float32Array;
    for (let i = 0; i < Math.ceil(seconds * 48000 / 128); i++) {
      output = new Float32Array(128);
      instance.process([[new Float32Array(128).fill(amplitude)]], [[output]], { enabled: [enabled], threshold: [threshold] });
    }
    return Math.max(...output.map(Math.abs));
  };
  return { instance, run };
}
test('activation suppresses background noise and opens for speech without cutting short pauses', () => {
  const g = gate(); assert.equal(g.run(.001, .1), 0);
  assert(g.run(.1, .1) > .099);
  assert(g.run(.001, .05) > .0009);
  assert.equal(g.run(.001, 1), 0);
});
test('threshold changes apply during processing and disabling the gate restores exact audio', () => {
  const g = gate(); assert.equal(g.run(.1, .1, -10), 0);
  assert(g.run(.1, .1, -40) > .099);
  assert.equal(g.run(.1, 1, -10), 0);
  assert(Math.abs(g.run(.001, .01, -10, 0) - .001) < 1e-9);
});
test('activation settings default off and clamp corrupt persisted values', () => {
  assert.deepEqual(activationSettings(), { enabled: false, threshold: -45 });
  assert.deepEqual(activationSettings({ enabled: true, threshold: NaN }), { enabled: true, threshold: -45 });
  assert.equal(activationSettings({ threshold: -100 }).threshold, -70);
  assert.equal(activationSettings({ threshold: 10 }).threshold, -10);
});
