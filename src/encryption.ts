import { readPrivateKey } from 'openpgp';
import { api, HttpError, type Message, type User } from './api';
import type { EncryptedEnvelope, EncryptionDevice, EncryptionState } from './crypto-types';
import { base64ToBytes, bytesToBase64, ciphertextHash, sessionKeyFor, decryptBackup, decryptImage, encryptBackup, encryptImage, generateDeviceKey, openEnvelope, seal, type SecretPayload } from './e2ee-crypto';
import { loadVault, saveVault, type Vault } from './e2ee-vault';

const locks = <T>(name: string, work: () => Promise<T>) => {
  if (!navigator.locks) throw Error('Этот браузер не поддерживает безопасное хранилище Круга. Обновите приложение.');
  return navigator.locks.request(`krug-e2ee-${name}`, work);
};
export class EncryptionManager extends EventTarget {
  state: EncryptionState = { enabled: false, roster: '', devices: [] };
  private vault!: Vault;
  private publicDevices = new Map<string, EncryptionDevice>();
  private recovered = new Map<number, { key: string; sender: EncryptionDevice }>();
  private sharing = false;
  historyShared = 0;
  private stopped = false;
  private opening = new Map<string, Promise<SecretPayload>>();
  constructor(readonly user: User, readonly sessionId: string) { super(); }
  private notify() { this.dispatchEvent(new Event('change')); }
  private async mutate(work: (vault: Vault) => void) {
    await locks(this.user.id, async () => { const next = await loadVault(this.user.id); work(next); await saveVault(next); this.vault = next; });
    this.opening.clear(); this.notify();
  }
  async initialize() {
    await locks(this.user.id, async () => {
      this.vault = await loadVault(this.user.id);
      const state = await api<EncryptionState>('/encryption');
      const remote = state.devices.find(d => d.current);
      let record = this.vault.records.find(r => r.sessionId === this.sessionId);
      if (remote && (!record || remote.fingerprint !== record.device.fingerprint)) throw Error('На этом устройстве потерян ключ текущей сессии. Выйдите и войдите заново, затем импортируйте резервную копию истории.');
      if (!record) {
        const keys = await generateDeviceKey();
        const label = /Android/i.test(navigator.userAgent) ? 'Android' : window.krugDesktop ? 'Круг для Windows' : 'Браузер';
        record = { sessionId: this.sessionId, privateKey: keys.privateKey, device: { id: crypto.randomUUID(), userId: this.user.id, name: this.user.displayName, label, fingerprint: keys.fingerprint, publicKey: keys.publicKey, createdAt: Date.now(), identity: '' } };
        this.vault.records.push(record);
        // Persist before registering: a failed response must not strand a key on the server.
        await saveVault(this.vault);
      }
      const { device } = await api<{ device: EncryptionDevice }>('/encryption/devices', 'POST', { publicKey: record.device.publicKey, label: record.device.label });
      if (device.fingerprint !== record.device.fingerprint || device.userId !== this.user.id) throw Error('Ключ устройства подменён сервером.');
      record.device = device; this.vault.trusted[device.id] = device.fingerprint;
      await saveVault(this.vault);
    });
    await this.refresh(); return this;
  }
  get current() { const record = this.vault.records.find(r => r.sessionId === this.sessionId); if (!record) throw Error('Нет ключа текущей сессии.'); return record; }
  get pending() { return this.state.devices.filter(d => !this.trusted(d)); }
  trusted(device: EncryptionDevice) { return this.vault.trusted[device.id] === device.fingerprint; }
  async trust(id: string, fingerprint: string) {
    await this.refresh(); const device = this.state.devices.find(d => d.id === id);
    if (!device || device.fingerprint !== fingerprint.replace(/\s/g, '').toLowerCase()) throw Error('Отпечаток не совпадает. Получите код непосредственно у владельца устройства.');
    await this.mutate(vault => { vault.trusted[id] = device.fingerprint; });
    void this.shareHistory();
  }
  async refresh() {
    const state = await api<EncryptionState>('/encryption');
    const vault = await loadVault(this.user.id); const trustChanged = JSON.stringify(vault.trusted) !== JSON.stringify(this.vault.trusted); this.vault = vault;
    if (vault.enabled && !state.enabled) throw Error('Сервер пытается отключить ранее включённое шифрование. Отправка остановлена.');
    if (!state.devices.some(d => d.id === this.current.device.id && d.fingerprint === this.current.device.fingerprint && d.current)) throw Error('Ключ этой сессии больше не активен.');
    if (state.enabled && !vault.enabled) await this.mutate(v => { v.enabled = true; });
    for (const d of state.devices) this.publicDevices.set(d.id, d);
    if (trustChanged || JSON.stringify(state) !== JSON.stringify(this.state)) { this.state = state; this.opening.clear(); this.notify(); setTimeout(() => void this.shareHistory(), 0); }
    return state;
  }
  async enable() { await api('/encryption/enable', 'POST'); await this.refresh(); }
  private async recipients() {
    await this.refresh();
    if (!this.state.enabled) throw Error('Сквозное шифрование не включено.');
    if (this.pending.length) throw Error(`Подтвердите ключи устройств в настройках: ${[...new Set(this.pending.map(d => d.name))].join(', ')}.`);
    return this.state.devices;
  }
  private payload(kind: SecretPayload['kind'], channelId: string): SecretPayload {
    return { v: 1, kind, origin: location.origin, channelId, roster: this.state.roster, deviceId: this.current.device.id, clientId: crypto.randomUUID(), userId: this.user.id, body: '' };
  }
  async encryptMessage(channelId: string, body: string, image?: { bytes: Uint8Array<ArrayBuffer>; mime: string }, migration?: Message) {
    const recipients = await this.recipients();
    const payload = { ...this.payload('message', channelId), body, ...(migration ? { migrationOf: migration.id, originalAuthorId: migration.user.id, originalCreatedAt: migration.createdAt } : {}) };
    const attachment = image ? await encryptImage(image.bytes, image.mime, location.origin, channelId, payload.clientId) : undefined;
    if (attachment) payload.image = attachment.descriptor;
    const encrypted = await seal(payload, this.current.privateKey, recipients);
    return { encrypted, ...(attachment ? { image: attachment.data } : {}) };
  }
  private async sender(id: string) {
    const device = this.publicDevices.get(id) ?? (await api<{ device: EncryptionDevice }>(`/encryption/devices/${id}`)).device;
    if (device.id !== id || !this.trusted(device)) throw Error('Ключ отправителя не подтверждён. Сверьте его в настройках.');
    this.publicDevices.set(id, device); return device;
  }
  private async open(envelope: EncryptedEnvelope, channelId: string, kind: SecretPayload['kind']) {
    const key = `${kind}:${channelId}:${envelope.deviceId}:${envelope.clientId}:${envelope.ciphertext}`;
    let value = this.opening.get(key);
    if (!value) {
      value = this.sender(envelope.deviceId).then(sender => openEnvelope(envelope, this.vault.records.map(r => r.privateKey), sender, { origin: location.origin, channelId, kind }));
      this.opening.set(key, value);
      if (this.opening.size > 250) this.opening.delete(this.opening.keys().next().value!);
      value.catch(() => this.opening.delete(key));
    }
    return value;
  }
  async decryptMessage(message: Message) {
    if (!message.encrypted) return undefined;
    let value: SecretPayload;
    try { value = await this.open(message.encrypted, message.channelId, 'message'); }
    catch (originalError) {
      const grants = await api<{ grants: EncryptedEnvelope[] }>(`/messages/${message.id}/key-grants`);
      let restored: SecretPayload | undefined;
      for (const envelope of grants.grants) {
        try {
          const transfer = await this.open(envelope, message.channelId, 'history');
          const grant = transfer.grant;
          if (!grant || grant.messageId !== message.id || grant.ciphertextHash !== await ciphertextHash(message.encrypted)) continue;
          const pin = this.vault.trusted[grant.sender.id];
          if (pin && pin !== grant.sender.fingerprint) continue;
          restored = await openEnvelope(message.encrypted, [], grant.sender, { origin: location.origin, channelId: message.channelId, kind: 'message' }, base64ToBytes(grant.key));
          this.recovered.set(message.id, { key: grant.key, sender: grant.sender });
          if (this.recovered.size > 250) this.recovered.delete(this.recovered.keys().next().value!);
          break;
        } catch { /* A malformed grant must not prevent trying another trusted sender. */ }
      }
      if (!restored) throw originalError;
      value = restored;
    }
    if (value.migrationOf !== undefined ? value.migrationOf !== message.id : message.user.id !== '__deleted_user__' && value.userId !== message.user.id) throw Error('Автор сообщения или номер истории подменён.');
    if (value.migrationOf && (value.originalCreatedAt !== message.createdAt || (message.user.id !== '__deleted_user__' && value.originalAuthorId !== message.user.id))) throw Error('Старая запись была подменена.');
    if (Boolean(value.image) !== Boolean(message.image)) throw Error('Состав сообщения подменён.');
    return value;
  }
  historyChanged() { this.opening.clear(); this.notify(); }
  stop() { this.stopped = true; this.opening.clear(); this.recovered.clear(); }
  async shareHistory(retry = false) {
    if (this.stopped || this.sharing || !this.state.enabled || this.pending.length) return;
    this.sharing = true;
    const initialRoster = this.state.roster;
    let after = 0;
    try {
      while (!this.stopped && !this.pending.length && this.state.roster === initialRoster) {
        const page = await api<{ messages: Message[] }>(`/encryption/history-needed?after=${after}${retry ? '&retry=1' : ''}`);
        if (!page.messages.length) break;
        for (const message of page.messages) {
          if (this.stopped || this.state.roster !== initialRoster || this.pending.length) return;
          after = message.id;
          if (!message.encrypted) continue;
          try {
            await this.decryptMessage(message);
            const restored = this.recovered.get(message.id);
            const key = restored?.key ?? await sessionKeyFor(message.encrypted, this.vault.records.map(r => r.privateKey));
            const sender = restored?.sender ?? await this.sender(message.encrypted.deviceId);
            const payload: SecretPayload = { ...this.payload('history', message.channelId), grant: { messageId: message.id, ciphertextHash: await ciphertextHash(message.encrypted), key, sender } };
            const envelope = await seal(payload, this.current.privateKey, this.state.devices);
            await api(`/messages/${message.id}/key-grants`, 'POST', envelope);
            this.historyShared++; this.notify();
          } catch (e) { if (e instanceof HttpError && [401, 409, 429].includes(e.status)) return; }
          await new Promise(resolve => setTimeout(resolve, 650));
        }
      }
    } catch { /* Reconnect/confirmation retries the transfer; ciphertext remains intact. */ }
    finally { this.sharing = false; }
  }
  async image(message: Message, payload: SecretPayload) {
    if (!payload.image) throw Error('Нет изображения.');
    const response = await fetch(`/api/messages/${message.id}/image`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error('Изображение недоступно.');
    const plain = await decryptImage(await response.arrayBuffer(), payload.image, location.origin, message.channelId, payload.clientId);
    return new Blob([plain], { type: payload.image.mime });
  }
  async roomKey(channelId: string) {
    const recipients = await this.recipients(); const roster = this.state.roster;
    let result = await api<{ envelope: EncryptedEnvelope | null; roster: string }>(`/encryption/rooms/${channelId}`);
    if (!result.envelope) {
      const payload = { ...this.payload('room', channelId), roomKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))) };
      const envelope = await seal(payload, this.current.privateKey, recipients);
      try { await api(`/encryption/rooms/${channelId}`, 'POST', envelope); result = { envelope, roster }; }
      catch (e) { if (!(e instanceof HttpError && e.status === 409)) throw e; result = await api(`/encryption/rooms/${channelId}`); }
    }
    if (!result.envelope || result.roster !== roster || result.envelope.roster !== roster) throw Error('Состав комнаты изменился. Повторите подключение.');
    const payload = await this.open(result.envelope, channelId, 'room');
    if (!payload.roomKey || base64ToBytes(payload.roomKey).length !== 32) throw Error('Некорректный ключ звонка.');
    return { key: base64ToBytes(payload.roomKey).buffer, roster };
  }
  async backup(password: string) {
    this.vault = await loadVault(this.user.id);
    return encryptBackup(JSON.stringify({ origin: location.origin, vault: this.vault }), password);
  }
  async restore(text: string, password: string) {
    const data = JSON.parse(await decryptBackup(text, password)) as { origin: string; vault: Vault };
    if (data.origin !== location.origin || data.vault?.version !== 1 || data.vault.userId !== this.user.id || !Array.isArray(data.vault.records) || data.vault.records.length > 200 || !data.vault.trusted || typeof data.vault.trusted !== 'object') throw Error('Это резервная копия другого аккаунта или сервера.');
    for (const record of data.vault.records) {
      const key = await readPrivateKey({ armoredKey: record.privateKey });
      if (key.getFingerprint() !== record.device.fingerprint || record.device.userId !== this.user.id) throw Error('Копия содержит некорректный ключ.');
    }
    await this.mutate(vault => {
      for (const record of data.vault.records) if (!vault.records.some(r => r.device.fingerprint === record.device.fingerprint)) vault.records.push({ ...record, sessionId: `archive:${record.device.id}` });
      for (const [id, fingerprint] of Object.entries(data.vault.trusted)) if (/^[a-f0-9]{40,64}$/.test(fingerprint)) vault.trusted[id] = fingerprint;
      vault.enabled ||= Boolean(data.vault.enabled);
    });
    await this.refresh();
  }
  async migrate(channelId: string, progress: (count: number) => void) {
    let before: number | undefined, count = 0;
    do {
      const page = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${channelId}/messages${before ? `?before=${before}` : ''}`);
      for (const message of page.messages) if (!message.encrypted) {
        let image;
        if (message.image) { const response = await fetch(`/api/messages/${message.id}/image`, { credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw Error('Не удалось прочитать старое изображение.'); image = { bytes: new Uint8Array(await response.arrayBuffer()), mime: response.headers.get('Content-Type')?.split(';')[0] || '' }; }
        await api(`/messages/${message.id}/encryption`, 'PUT', await this.encryptMessage(channelId, message.body, image, message));
        progress(++count);
      }
      before = page.hasMore ? page.messages[0]?.id : undefined;
    } while (before);
    return count;
  }
}
const managers = new Map<string, Promise<EncryptionManager>>();
export async function initializeEncryption(user: User) {
  const { sessions } = await api<{ sessions: { id: string; current: number }[] }>('/sessions');
  const current = sessions.find(s => s.current); if (!current) throw Error('Сессия завершилась. Войдите снова.');
  const key = `${user.id}:${current.id}`;
  if (!managers.has(key)) { const pending = new EncryptionManager(user, current.id).initialize(); managers.set(key, pending); pending.catch(() => managers.delete(key)); }
  return managers.get(key)!;
}
export function forgetEncryptionMemory() { for (const manager of managers.values()) void manager.then(m => m.stop()).catch(() => {}); managers.clear(); }
