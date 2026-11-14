import { readKey } from 'openpgp';
import type { EncryptionDevice } from './crypto-types';

export type TrustPins = { trusted: Record<string, string>; verified?: Record<string, string> };
const fingerprintPattern = /^[a-f0-9]{40,64}$/;
const deviceIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function mergePins(pins: TrustPins, incoming: Record<string, string>) {
  for (const [id, fingerprint] of Object.entries(incoming)) {
    if (!deviceIdPattern.test(id) || !fingerprintPattern.test(fingerprint)) throw Error('Некорректный отпечаток устройства.');
    if (pins.trusted[id] && pins.trusted[id] !== fingerprint) throw Error('Ключ известного устройства изменился. Отправка остановлена; проверьте устройство и обратитесь к владельцу сервера.');
  }
  const changed = Object.entries(incoming).some(([id, fingerprint]) => pins.trusted[id] !== fingerprint);
  Object.assign(pins.trusted, incoming);
  return changed;
}

// TOFU: the server is trusted for the first key of each device. A pin cannot be
// silently replaced later, including by an imported backup or a concurrent tab.
export async function acceptDeviceKeys(pins: TrustPins, devices: EncryptionDevice[]) {
  const incoming: Record<string, string> = {};
  for (const device of devices) {
    if (!deviceIdPattern.test(device.id) || !fingerprintPattern.test(device.fingerprint)) throw Error('Некорректный отпечаток устройства.');
    if ((incoming[device.id] && incoming[device.id] !== device.fingerprint) || (pins.trusted[device.id] && pins.trusted[device.id] !== device.fingerprint)) throw Error('Ключ известного устройства изменился. Отправка остановлена; проверьте устройство и обратитесь к владельцу сервера.');
    const key = await readKey({ armoredKey: device.publicKey });
    if (key.isPrivate() || key.getFingerprint() !== device.fingerprint) throw Error('Публичный ключ устройства не соответствует отпечатку.');
    await key.getEncryptionKey(); await key.getSigningKey();
    incoming[device.id] = device.fingerprint;
  }
  return mergePins(pins, incoming);
}
