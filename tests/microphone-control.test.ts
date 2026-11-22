import test from 'node:test';
import assert from 'node:assert/strict';
import type { Room } from 'livekit-client';
import { microphoneErrorMessage, withMicrophoneRecovery } from '../src/microphone-control.ts';

function fixture(device = 'unplugged-usb') {
  const changes: unknown[][] = [];
  const room = {
    options: { audioCaptureDefaults: { deviceId: { exact: device } } },
    getActiveDevice: () => device,
    async switchActiveDevice(...args: unknown[]) { changes.push(args); return true; },
  } as unknown as Pick<Room, 'options' | 'getActiveDevice' | 'switchActiveDevice'>;
  return { room, changes };
}
const missing = () => Object.assign(new Error('missing input'), { name: 'OverconstrainedError', constraint: 'deviceId' });

test('unplugged selected microphone falls back to default once and reports recovery', async () => {
  const { room, changes } = fixture(); let attempts = 0, recovered = 0;
  const result = await withMicrophoneRecovery(room, async () => { if (++attempts === 1) throw missing(); return 'live audio'; }, () => true, () => recovered++);
  assert.equal(result, 'live audio'); assert.equal(attempts, 2); assert.equal(recovered, 1);
  assert.deepEqual(changes, [['audioinput', 'default', false]]);
});

test('denied permission, busy device, and unrelated constraints never retry or switch inputs', async () => {
  for (const error of [new DOMException('denied', 'NotAllowedError'), new DOMException('busy', 'NotReadableError'), Object.assign(new Error(), { name: 'OverconstrainedError', constraint: 'sampleRate' })]) {
    const { room, changes } = fixture(); let attempts = 0;
    await assert.rejects(withMicrophoneRecovery(room, async () => { attempts++; throw error; }, () => true, () => assert.fail('Unexpected recovery')), value => value === error);
    assert.equal(attempts, 1); assert.deepEqual(changes, []);
  }
});

test('missing default input does not retry; missing explicitly selected input does', async () => {
  for (const device of ['default', 'unplugged-usb']) {
    const { room, changes } = fixture(device); let attempts = 0;
    await assert.rejects(withMicrophoneRecovery(room, async () => { attempts++; throw new DOMException('missing', 'NotFoundError'); }, () => true, () => assert.fail('Unexpected recovery')));
    assert.equal(attempts, device === 'default' ? 1 : 2);
    assert.equal(changes.length, device === 'default' ? 0 : 1);
  }
});

test('leaving the call during capture failure prevents a second capture', async () => {
  const { room, changes } = fixture(); let active = true;
  await assert.rejects(withMicrophoneRecovery(room, async () => { active = false; throw missing(); }, () => active, () => assert.fail('Unexpected recovery')), { name: 'AbortError' });
  assert.deepEqual(changes, []);
});

test('microphone errors distinguish access, device, processor and publishing failures', () => {
  const denied = new DOMException('denied', 'NotAllowedError');
  assert.match(microphoneErrorMessage(denied, 'capture'), /Доступ к микрофону запрещён/);
  assert.match(microphoneErrorMessage(new DOMException('', 'NotFoundError'), 'capture'), /Микрофон не найден/);
  assert.match(microphoneErrorMessage(new DOMException('', 'NotReadableError'), 'unmute'), /занят другой программой/);
  assert.match(microphoneErrorMessage(denied, 'processor'), /обработку/);
  assert.match(microphoneErrorMessage(denied, 'publish'), /подключить к звонку/);
  assert.doesNotMatch(microphoneErrorMessage(denied, 'processor'), /запрещён/);
});
