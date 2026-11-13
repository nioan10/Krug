import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateController } = require('../desktop/update-controller.cjs') as { createUpdateController: (options: { install: () => void; report: (state: { state: string }) => void; schedule: (fn: () => void) => void }) => { setCallActive(active: boolean): void; downloaded(): void; resetCallState(): void } };

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
