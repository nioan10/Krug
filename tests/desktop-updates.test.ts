import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateController } = require('../desktop/update-controller.cjs') as { createUpdateController: (options: { install: () => void; report: (state: { state: string }) => void; schedule: (fn: () => void) => void; prepare?: () => Promise<void>; onPrepareError?: () => void }) => { setCallActive(active: boolean): void; downloaded(): void; resetCallState(): void } };

test('native update waits for call to end, including a call started before the scheduled restart', () => {
  const scheduled: (() => void)[] = [], states: string[] = [];
  let installs = 0;
  const controller = createUpdateController({ install: () => { installs++; }, report: status => states.push(status.state), schedule: fn => { scheduled.push(fn); } });
  controller.downloaded();
  assert.equal(scheduled.length, 0, 'unknown call state must not restart');
  controller.setCallActive(true);
  assert.equal(scheduled.length, 0);
  controller.setCallActive(false);
  controller.setCallActive(true);
  scheduled.shift()!();
  assert.equal(installs, 0);
  controller.setCallActive(false);
  scheduled.shift()!();
  assert.equal(installs, 1);
  assert.ok(states.includes('queued'));
});

test('navigation requires a new call-state report before installing', () => {
  const scheduled: (() => void)[] = [];
  let installs = 0;
  const controller = createUpdateController({ install: () => { installs++; }, report: () => {}, schedule: fn => { scheduled.push(fn); } });
  controller.setCallActive(false); controller.downloaded(); controller.resetCallState();
  scheduled.shift()!(); assert.equal(installs, 0);
  controller.setCallActive(false); scheduled.shift()!(); assert.equal(installs, 1);
});

test('session preparation never interrupts a call that starts while it runs', async () => {
  const scheduled: (() => void)[] = [], finish: (() => void)[] = [];
  let installs = 0;
  const controller = createUpdateController({
    install: () => { installs++; }, report: () => {}, schedule: fn => scheduled.push(fn),
    prepare: () => new Promise<void>(resolve => finish.push(resolve)),
  });
  controller.setCallActive(false); controller.downloaded(); scheduled.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.setCallActive(true); finish.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(installs, 0);
  controller.setCallActive(false); scheduled.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  finish.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(installs, 1);
});

test('failed session preparation does not install and allows retry', async () => {
  const scheduled: (() => void)[] = [], states: string[] = [];
  let installs = 0, failures = 0;
  const controller = createUpdateController({
    install: () => { installs++; }, report: state => states.push(state.state), schedule: fn => scheduled.push(fn),
    prepare: async () => { throw new Error('fixture'); }, onPrepareError: () => { failures++; },
  });
  controller.setCallActive(false); controller.downloaded(); scheduled.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(installs, 0); assert.equal(failures, 1); assert.equal(states.at(-1), 'error');
});
