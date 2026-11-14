import test from 'node:test';
import assert from 'node:assert/strict';
import type { EncryptionDevice } from '../src/crypto-types.ts';
import { base64ToBytes, decryptBackup, decryptImage, encryptBackup, encryptImage, generateDeviceKey, openEnvelope, seal, sessionKeyFor, type SecretPayload } from '../src/e2ee-crypto.ts';
const origin = 'http://localhost:5173';
const payload = (d: EncryptionDevice, roster: string, body = 'private text'): SecretPayload => ({ v: 1, kind: 'message', origin, channelId: 'general', roster, deviceId: d.id, userId: d.userId, clientId: crypto.randomUUID(), body });
const context = { origin, channelId: 'general', kind: 'message' as const };

test('signed E2EE rejects foreign keys, forged senders, changed ciphertext and cross-channel replay', async () => {
  const a = await generateDeviceKey(), b = await generateDeviceKey(), stranger = await generateDeviceKey();
  const make = (key: typeof a): EncryptionDevice => ({ id: crypto.randomUUID(), userId: crypto.randomUUID(), name: 'test', label: 'test', publicKey: key.publicKey, fingerprint: key.fingerprint, createdAt: Date.now(), identity: 'test' });
  const da = make(a), db = make(b), dc = make(stranger);
  const plain = payload(da, 'a'.repeat(64));
  const envelope = await seal(plain, a.privateKey, [da, db]);
  assert.ok(!envelope.ciphertext.includes(plain.body));
  assert.deepEqual(await openEnvelope(envelope, [b.privateKey], da, context), plain);
  await assert.rejects(openEnvelope(envelope, [stranger.privateKey], da, context));
  await assert.rejects(openEnvelope(envelope, [b.privateKey], da, { ...context, channelId: 'other' }));
  await assert.rejects(openEnvelope({ ...envelope, deviceId: dc.id }, [b.privateKey], dc, context));
  await assert.rejects(openEnvelope({ ...envelope, clientId: crypto.randomUUID() }, [b.privateKey], da, context));
  const unsignedClaim = await seal(plain, stranger.privateKey, [db]);
  await assert.rejects(openEnvelope(unsignedClaim, [b.privateKey], da, context));
  const key = await sessionKeyFor(envelope, [a.privateKey]);
  assert.deepEqual(await openEnvelope(envelope, [], da, context, base64ToBytes(key)), plain);
});

test('images authenticate their contents and message context; key backups require their separate password', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const image = await encryptImage(bytes, 'image/png', origin, 'general', 'message-1');
  const ciphertext = base64ToBytes(image.data);
  assert.deepEqual(new Uint8Array(await decryptImage(ciphertext.buffer, image.descriptor, origin, 'general', 'message-1')), bytes);
  await assert.rejects(decryptImage(ciphertext.buffer, image.descriptor, origin, 'general', 'message-2'));
  ciphertext[0] ^= 1;
  await assert.rejects(decryptImage(ciphertext.buffer, image.descriptor, origin, 'general', 'message-1'));
  const backup = await encryptBackup('private-history-key', 'separate-long-recovery-password');
  assert.ok(!backup.includes('private-history-key'));
  assert.equal(await decryptBackup(backup, 'separate-long-recovery-password'), 'private-history-key');
  await assert.rejects(decryptBackup(backup, 'incorrect-password'));
});

