import type { EncryptionDevice } from './crypto-types';
export type Vault = { version: 1; userId: string; records: { sessionId: string; device: EncryptionDevice; privateKey: string }[]; trusted: Record<string, string>; verified?: Record<string, string>; enabled: boolean };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('krug-encryption-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vaults');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Недоступно хранилище ключей. Разрешите хранение данных приложения.'));
  });
}
async function read(userId: string) {
  const db = await database();
  try { return await new Promise<{ key: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>((resolve, reject) => { const request = db.transaction('vaults').objectStore('vaults').get(userId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
export async function loadVault(userId: string): Promise<Vault> {
  const record = await read(userId);
  if (!record) return { version: 1, userId, records: [], trusted: {}, verified: {}, enabled: false };
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(userId) }, record.key, record.data);
  const vault = JSON.parse(new TextDecoder().decode(plain)) as Vault;
  // Pins written before automatic trust were explicitly confirmed (or own keys).
  vault.verified ??= { ...vault.trusted };
  return vault;
}
export async function saveVault(vault: Vault) {
  const previous = await read(vault.userId);
  const key = previous?.key ?? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(vault.userId) }, key, new TextEncoder().encode(JSON.stringify(vault)));
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('vaults', 'readwrite'); tx.objectStore('vaults').put({ key, iv, data }, vault.userId); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
