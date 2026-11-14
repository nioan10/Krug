import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceKey } from '../src/e2ee-crypto.ts';
import { acceptDeviceKeys, mergePins, type TrustPins } from '../src/e2ee-trust.ts';
import type { EncryptionDevice } from '../src/crypto-types.ts';

async function device(): Promise<EncryptionDevice> {
  const key = await generateDeviceKey();
  return { id: crypto.randomUUID(), userId: crypto.randomUUID(), name: 'Test', label: 'Browser', publicKey: key.publicKey, fingerprint: key.fingerprint, createdAt: Date.now(), identity: 'test' };
}

test('first device keys are accepted automatically without claiming manual verification', async () => {
  const a = await device(), b = await device();
  const pins: TrustPins = { trusted: {}, verified: {} };
  assert.equal(await acceptDeviceKeys(pins, [a, b]), true);
  assert.deepEqual(pins.trusted, { [a.id]: a.fingerprint, [b.id]: b.fingerprint });
  assert.deepEqual(pins.verified, {});
  assert.equal(await acceptDeviceKeys(pins, [a, b]), false);
});

test('a changed pinned key or invalid public key fails before any new pins are saved', async () => {
  const a = await device(), b = await device(), newcomer = await device();
  const pins: TrustPins = { trusted: { [a.id]: a.fingerprint } };
  const initial = { ...pins.trusted };
  await assert.rejects(acceptDeviceKeys(pins, [newcomer, { ...b, id: a.id }]), /изменился/);
  assert.deepEqual(pins.trusted, initial);
  await assert.rejects(acceptDeviceKeys(pins, [newcomer, { ...b, fingerprint: a.fingerprint }]), /отпечатку/);
  assert.deepEqual(pins.trusted, initial);
  await assert.rejects(acceptDeviceKeys(pins, [{ ...b, id: '__proto__' }]), /Некорректный/);
});

test('backup pins cannot override known keys, and merging preserves manual verification', async () => {
  const a = await device(), b = await device();
  const pins: TrustPins = { trusted: { [a.id]: a.fingerprint }, verified: { [a.id]: a.fingerprint } };
  assert.throws(() => mergePins(pins, { [b.id]: b.fingerprint, [a.id]: b.fingerprint }), /изменился/);
  assert.deepEqual(pins.trusted, { [a.id]: a.fingerprint });
  assert.equal(mergePins(pins, { [b.id]: b.fingerprint }), true);
  assert.deepEqual(pins.verified, { [a.id]: a.fingerprint });
});
