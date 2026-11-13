import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateManager } from '../src/pwa-updates.ts';

class Worker extends EventTarget {
  state = 'installed';
  messages: unknown[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  change(state: string) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
class Registration extends EventTarget {
  waiting: Worker | null = null;
  installing: Worker | null = null;
  checks = 0;
  async update() { this.checks++; return this; }
  found(worker: Worker) { this.installing = worker; this.dispatchEvent(new Event('updatefound')); }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(t: TestContext, firstInstall = false) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const registration = new Registration();
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: firstInstall ? null : new Worker(), attempts: 0, fail: false,
    async register(_path: string, options: RegistrationOptions) {
      assert.equal(options.updateViaCache, 'none'); this.attempts++;
      if (this.fail) throw new Error('offline');
      return registration;
    },
  });
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const events = new EventTarget(); let reloads = 0; let online = true;
  const manager = createUpdateManager({ serviceWorker: serviceWorker as unknown as ServiceWorkerContainer, page: page as Document, events, online: () => online, reload: () => { reloads++; } });
  t.after(() => manager.stop());
  function activate(worker: Worker) { registration.waiting = null; worker.change('activated'); serviceWorker.controller = worker; serviceWorker.dispatchEvent(new Event('controllerchange')); }
  return { manager, registration, serviceWorker, page, events, activate, reloads: () => reloads, offline: () => { online = false; }, online: () => { online = true; } };
}

test('checks periodically without page navigation and checks again on focus or reconnect', async t => {
  const qa = setup(t); qa.manager.start(); await settle();
  assert.equal(qa.serviceWorker.attempts, 1);
  t.mock.timers.tick(60_000); await settle(); assert.equal(qa.registration.checks, 1);
  qa.events.dispatchEvent(new Event('focus')); await settle(); assert.equal(qa.registration.checks, 1);
  t.mock.timers.tick(16_000); qa.events.dispatchEvent(new Event('focus')); await settle(); assert.equal(qa.registration.checks, 2);
  qa.page.visibilityState = 'hidden'; t.mock.timers.tick(60_000); await settle(); assert.equal(qa.registration.checks, 2);
  qa.page.visibilityState = 'visible'; qa.page.dispatchEvent(new Event('visibilitychange')); await settle(); assert.equal(qa.registration.checks, 3);
  qa.offline(); t.mock.timers.tick(60_000); await settle(); assert.equal(qa.registration.checks, 3);
  qa.online(); qa.events.dispatchEvent(new Event('online')); await settle(); assert.equal(qa.registration.checks, 4);
});

test('failed initial registration recovers when the network returns', async t => {
  const qa = setup(t); qa.serviceWorker.fail = true; qa.manager.start(); await settle();
  qa.serviceWorker.fail = false; qa.events.dispatchEvent(new Event('online')); await settle();
  assert.equal(qa.serviceWorker.attempts, 2);
  t.mock.timers.tick(60_000); await settle(); assert.equal(qa.registration.checks, 1);
});

test('detects workers already waiting or installing when registration resolves', async t => {
  const qa = setup(t); const worker = new Worker(); worker.state = 'installing'; qa.registration.installing = worker;
  qa.manager.start(); await settle(); assert.equal(qa.manager.getSnapshot().available, false);
  qa.registration.waiting = worker; worker.change('installed');
  assert.equal(qa.manager.getSnapshot().available, true);
  await qa.manager.request(false); assert.deepEqual(worker.messages, [{ type: 'APPLY_UPDATE' }]);
  qa.activate(worker); assert.equal(qa.reloads(), 1);
  qa.serviceWorker.dispatchEvent(new Event('controllerchange')); assert.equal(qa.reloads(), 1);
});

test('a call can queue or cancel an update, and leaving installs it with one reload', async t => {
  const qa = setup(t); const worker = new Worker(); qa.registration.waiting = worker; qa.manager.start(); await settle();
  await qa.manager.request(true); assert.equal(qa.manager.getSnapshot().queued, true); assert.equal(worker.messages.length, 0);
  qa.manager.cancel(); qa.manager.setInCall(false); await settle(); assert.equal(worker.messages.length, 0);
  await qa.manager.request(true); qa.manager.setInCall(false); await settle(); assert.equal(worker.messages.length, 1);
  qa.activate(worker); assert.equal(qa.reloads(), 1);
});

test('another tab activating an update does not interrupt a call or strand the update button', async t => {
  const qa = setup(t); const worker = new Worker(); qa.registration.waiting = worker; qa.manager.start(); await settle();
  qa.manager.setInCall(true); qa.activate(worker);
  assert.equal(qa.reloads(), 0); assert.equal(qa.manager.getSnapshot().available, true);
  await qa.manager.request(true); assert.equal(qa.manager.getSnapshot().queued, true);
  qa.manager.setInCall(false); await settle(); assert.equal(qa.reloads(), 1);
});

test('a call started during activation postpones the reload until the call ends', async t => {
  const qa = setup(t); const worker = new Worker(); qa.registration.waiting = worker; qa.manager.start(); await settle();
  await qa.manager.request(false); qa.manager.setInCall(true); qa.activate(worker);
  assert.equal(qa.reloads(), 0); assert.equal(qa.manager.getSnapshot().queued, true);
  qa.manager.setInCall(false); await settle(); assert.equal(qa.reloads(), 1);
});

test('activation timeout releases the button and allows a successful retry', async t => {
  const qa = setup(t); const worker = new Worker(); qa.registration.waiting = worker; qa.manager.start(); await settle();
  await qa.manager.request(false); assert.equal(qa.manager.getSnapshot().applying, true);
  t.mock.timers.tick(15_000); assert.equal(qa.manager.getSnapshot().applying, false); assert.ok(qa.manager.getSnapshot().error);
  await qa.manager.request(false); qa.activate(worker); assert.equal(qa.reloads(), 1);
});

test('first installation does not show a false update or reload the page', async t => {
  const qa = setup(t, true); qa.manager.start(); await settle();
  const worker = new Worker(); worker.state = 'installing'; qa.registration.found(worker); worker.change('installed'); qa.activate(worker);
  assert.equal(qa.manager.getSnapshot().available, false); assert.equal(qa.reloads(), 0);
});
