import { createMessage, decrypt, decryptSessionKeys, encrypt, enums, generateKey, readKey, readMessage, readPrivateKey } from 'openpgp';
import { z } from 'zod';
import type { EncryptedEnvelope, EncryptionDevice } from './crypto-types';

const pgpConfig = { preferredSymmetricAlgorithm: enums.symmetric.aes256, preferredCompressionAlgorithm: enums.compression.uncompressed, maxDecompressedMessageSize: 1_048_576 };
const imageSchema = z.object({ key: z.string().length(44), iv: z.string().length(16), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) }).strict();
const senderSchema = z.object({ id: z.string().uuid(), userId: z.string().max(64), name: z.string().max(64), label: z.string().max(80), publicKey: z.string().max(16000), fingerprint: z.string().max(64), createdAt: z.number(), identity: z.string().max(128) });
const payloadSchema = z.object({ v: z.literal(1), kind: z.enum(['message', 'room', 'history']), origin: z.string().max(256), channelId: z.string().max(64), roster: z.string().length(64), deviceId: z.string().uuid(), clientId: z.string().uuid(), userId: z.string().max(64), body: z.string().max(4000), image: imageSchema.optional(), roomKey: z.string().length(44).optional(), migrationOf: z.number().int().positive().optional(), originalAuthorId: z.string().max(64).optional(), originalCreatedAt: z.number().int().nonnegative().optional(), grant: z.object({ messageId: z.number().int().positive(), ciphertextHash: z.string().length(64), key: z.string().length(44), sender: senderSchema }).strict().optional() }).strict();
export type SecretPayload = z.infer<typeof payloadSchema>;
export const bytesToBase64 = (bytes: Uint8Array) => { let result = ''; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(result); };
export const base64ToBytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function generateDeviceKey() {
  const keys = await generateKey({ type: 'ecc', curve: 'nistP256', userIDs: [{ name: `Krug device ${crypto.randomUUID()}` }], format: 'armored', config: pgpConfig });
  return { privateKey: keys.privateKey, publicKey: keys.publicKey, fingerprint: (await readKey({ armoredKey: keys.publicKey })).getFingerprint() };
}
export async function seal(payload: SecretPayload, privateKey: string, recipients: EncryptionDevice[]): Promise<EncryptedEnvelope> {
  payloadSchema.parse(payload);
  if (!recipients.length || recipients.length > 80) throw Error('Некорректный список получателей.');
  const keys = await Promise.all(recipients.map(async d => {
    const key = await readKey({ armoredKey: d.publicKey });
    if (key.getFingerprint() !== d.fingerprint || key.isPrivate()) throw Error('Публичный ключ устройства подменён.');
    return key;
  }));
  const ciphertext = await encrypt({ message: await createMessage({ text: JSON.stringify(payload) }), encryptionKeys: keys, signingKeys: await readPrivateKey({ armoredKey: privateKey }), format: 'armored', config: pgpConfig });
  return { v: 1, deviceId: payload.deviceId, clientId: payload.clientId, roster: payload.roster, ciphertext };
}
export async function openEnvelope(envelope: EncryptedEnvelope, privateKeys: string[], sender: EncryptionDevice, context: { origin: string; channelId: string; kind: SecretPayload['kind'] }, sessionKey?: Uint8Array): Promise<SecretPayload> {
  if (envelope.v !== 1 || envelope.deviceId !== sender.id || envelope.ciphertext.length > 100_000) throw Error('Некорректное зашифрованное сообщение.');
  const key = await readKey({ armoredKey: sender.publicKey });
  if (key.getFingerprint() !== sender.fingerprint) throw Error('Ключ отправителя подменён.');
  const result = await decrypt({ message: await readMessage({ armoredMessage: envelope.ciphertext, config: pgpConfig }), ...(sessionKey ? { sessionKeys: [{ data: sessionKey, algorithm: 'aes256' as const }] } : { decryptionKeys: await Promise.all(privateKeys.map(armoredKey => readPrivateKey({ armoredKey }))) }), verificationKeys: key, expectSigned: true, format: 'utf8', config: pgpConfig });
  await Promise.all(result.signatures.map(signature => signature.verified));
  if (!result.signatures.length) throw Error('Нет подписи отправителя.');
  const payload = payloadSchema.parse(JSON.parse(result.data));
  if (payload.origin !== context.origin || payload.channelId !== context.channelId || payload.kind !== context.kind || payload.deviceId !== envelope.deviceId || payload.clientId !== envelope.clientId || payload.roster !== envelope.roster || payload.userId !== sender.userId) throw Error('Подпись не соответствует каналу или отправителю.');
  return payload;
}
export async function sessionKeyFor(envelope: EncryptedEnvelope, privateKeys: string[]) {
  const keys = await decryptSessionKeys({ message: await readMessage({ armoredMessage: envelope.ciphertext, config: pgpConfig }), decryptionKeys: await Promise.all(privateKeys.map(armoredKey => readPrivateKey({ armoredKey }))), config: pgpConfig });
  const key = keys.find(k => (k.algorithm === 'aes256' || k.algorithm === null) && k.data.length === 32);
  if (!key) throw Error('Не удалось открыть ключ истории.');
  return bytesToBase64(key.data);
}
export async function ciphertextHash(envelope: EncryptedEnvelope) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envelope.ciphertext)))].map(v => v.toString(16).padStart(2, '0')).join(''); }
const imageContext = (origin: string, channelId: string, clientId: string) => new TextEncoder().encode(JSON.stringify(['krug-image-v1', origin, channelId, clientId]));
export async function encryptImage(bytes: Uint8Array<ArrayBuffer>, mime: string, origin: string, channelId: string, clientId: string) {
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw Error('Размер изображения не должен превышать 5 МБ.');
  const rawKey = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: imageContext(origin, channelId, clientId) }, key, bytes);
  return { data: bytesToBase64(new Uint8Array(data)), descriptor: imageSchema.parse({ key: bytesToBase64(rawKey), iv: bytesToBase64(iv), mime }) };
}
export async function decryptImage(data: ArrayBuffer, image: NonNullable<SecretPayload['image']>, origin: string, channelId: string, clientId: string) {
  imageSchema.parse(image);
  if (data.byteLength > 5 * 1024 * 1024 + 16) throw Error('Изображение слишком большое.');
  const key = await crypto.subtle.importKey('raw', base64ToBytes(image.key), 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(image.iv), additionalData: imageContext(origin, channelId, clientId) }, key, data);
}
export async function encryptBackup(text: string, password: string) {
  if (password.length < 16) throw Error('Для резервной копии нужен отдельный пароль от 16 символов.');
  return encrypt({ message: await createMessage({ text }), passwords: [password], format: 'armored', config: pgpConfig });
}
export async function decryptBackup(text: string, password: string) {
  if (text.length > 2_000_000) throw Error('Резервная копия слишком большая.');
  return (await decrypt({ message: await readMessage({ armoredMessage: text, config: pgpConfig }), passwords: [password], format: 'utf8', config: pgpConfig })).data;
}
