import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readKey } from 'openpgp';
import { z } from 'zod';
import type { openStore } from './store.ts';
import type { sessionStore } from './sessions.ts';
import { ApiError, digest } from './security.ts';
import type { EncryptionDevice, EncryptedEnvelope } from '../src/crypto-types.ts';

const envelopeSchema = z.object({ v: z.literal(1), deviceId: z.string().uuid(), clientId: z.string().uuid(), roster: z.string().regex(/^[a-f0-9]{64}$/), ciphertext: z.string().min(100).max(100_000).startsWith('-----BEGIN PGP MESSAGE-----') }).strict();
export function registerEncryption(app: FastifyInstance, store: ReturnType<typeof openStore>, sessions: ReturnType<typeof sessionStore>, auth: (r: FastifyRequest) => Promise<void>, admin: (r: FastifyRequest) => Promise<void>, broadcast: (v: unknown) => void, automatic = true) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS encryption_devices (
    id TEXT PRIMARY KEY, sessionHash TEXT NOT NULL UNIQUE, userId TEXT NOT NULL, label TEXT NOT NULL,
    publicKey TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, identity TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS encryption_rooms (
    channelId TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, roster TEXT NOT NULL, envelope TEXT NOT NULL,
    PRIMARY KEY(channelId,roster)
  );
  CREATE TABLE IF NOT EXISTS encryption_rosters (hash TEXT PRIMARY KEY, devices TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS encryption_history_grants (
    messageId INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, roster TEXT NOT NULL, grantor TEXT NOT NULL,
    recipients TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(messageId,roster,grantor)
  );`);
  const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'encrypted')) db.exec('ALTER TABLE messages ADD COLUMN encrypted TEXT');
  if (!columns.some(c => c.name === 'clientId')) db.exec('ALTER TABLE messages ADD COLUMN clientId TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id ON messages(clientId) WHERE clientId IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS messages_legacy_encryption ON messages(id) WHERE encrypted IS NULL');
  if (automatic) db.prepare("INSERT INTO meta VALUES ('encryption.required','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const enabled = () => Boolean(db.prepare("SELECT 1 FROM meta WHERE key='encryption.required' AND value='1'").get());
  const devices = () => db.prepare(`SELECT d.id,d.userId,u.displayName AS name,d.label,d.publicKey,d.fingerprint,d.createdAt,d.identity
    FROM encryption_devices d JOIN sessions s ON s.hash=d.sessionHash JOIN users u ON u.id=d.userId
    WHERE s.expiresAt>? AND u.disabledAt IS NULL ORDER BY d.id`).all(Date.now()) as unknown as EncryptionDevice[];
  const roster = () => digest(JSON.stringify(devices().map(d => [d.id, d.fingerprint])));
  const changed = () => broadcast({ type: 'encryption-changed', roster: roster(), enabled: enabled() });
  const device = (id: string) => db.prepare(`SELECT d.id,d.userId,COALESCE(u.displayName,'Удалённый участник') AS name,d.label,d.publicKey,d.fingerprint,d.createdAt,d.identity
    FROM encryption_devices d LEFT JOIN users u ON u.id=d.userId WHERE d.id=?`).get(id) as EncryptionDevice | undefined;
  function own(req: FastifyRequest) {
    const row = db.prepare('SELECT id FROM encryption_devices WHERE sessionHash=?').get(req.sessionHash!) as { id: string } | undefined;
    if (!row) throw new ApiError(409, 'Подключите шифрование на этом устройстве в настройках.');
    return row.id;
  }
  function validate(req: FastifyRequest, value: unknown): EncryptedEnvelope {
    const envelope = envelopeSchema.parse(value);
    if (!enabled()) throw new ApiError(409, 'Сквозное шифрование ещё не включено владельцем.');
    if (envelope.deviceId !== own(req)) throw new ApiError(403, 'Ключ принадлежит другой сессии.');
    if (envelope.roster !== roster()) throw new ApiError(409, 'Состав устройств изменился. Проверьте ключи и повторите отправку.');
    db.prepare('INSERT OR IGNORE INTO encryption_rosters VALUES (?,?)').run(envelope.roster, JSON.stringify(devices().map(d => d.id)));
    return envelope;
  }
  function cipherImage(value: unknown) {
    if (value === undefined) return null;
    const encoded = z.string().max(7 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/).parse(value);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 17 || bytes.length > 5 * 1024 * 1024 + 16 || bytes.toString('base64') !== encoded) throw new ApiError(400, 'Некорректное зашифрованное изображение.');
    return bytes;
  }
  app.get('/api/channels/:id/encryption-status', { preHandler: admin }, async req => {
    const id = z.object({ id: z.string().max(64) }).parse(req.params).id;
    return db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channelId=? AND encrypted IS NULL').get(id);
  });
  app.get('/api/encryption', { preHandler: auth }, async req => {
    const current = db.prepare('SELECT id FROM encryption_devices WHERE sessionHash=?').get(req.sessionHash!) as { id: string } | undefined;
    return { enabled: enabled(), automatic, roster: roster(), devices: devices().map(d => ({ ...d, current: d.id === current?.id })) };
  });
  app.post('/api/encryption/enable', { preHandler: admin }, async req => {
    own(req); db.prepare("INSERT INTO meta VALUES ('encryption.required','1') ON CONFLICT(key) DO UPDATE SET value='1'").run(); changed(); return { ok: true };
  });
  app.get('/api/encryption/legacy-history', { preHandler: admin }, async () => {
    const rows = db.prepare('SELECT id FROM messages WHERE encrypted IS NULL ORDER BY id LIMIT 20').all() as { id: number }[];
    const { remaining } = db.prepare('SELECT COUNT(*) AS remaining FROM messages WHERE encrypted IS NULL').get() as { remaining: number };
    return { remaining, messages: rows.map(row => store.message(row.id)) };
  });
  app.post('/api/encryption/devices', { preHandler: auth, bodyLimit: 24_000, config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async req => {
    const input = z.object({ publicKey: z.string().max(16_000).startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), label: z.string().trim().min(1).max(80) }).strict().parse(req.body);
    let key;
    try { key = await readKey({ armoredKey: input.publicKey }); if (key.isPrivate()) throw Error(); await key.getEncryptionKey(); await key.getSigningKey(); }
    catch { throw new ApiError(400, 'Некорректный публичный ключ.'); }
    await auth(req);
    const existing = db.prepare('SELECT id,fingerprint FROM encryption_devices WHERE sessionHash=?').get(req.sessionHash!) as { id: string; fingerprint: string } | undefined;
    if (existing) { if (existing.fingerprint !== key.getFingerprint()) throw new ApiError(409, 'Ключ этой сессии уже закреплён. Войдите заново для нового ключа.'); return { device: device(existing.id) }; }
    if (devices().length >= 80) throw new ApiError(409, 'Достигнут лимит устройств. Завершите старые сессии.');
    if (db.prepare('SELECT 1 FROM encryption_devices WHERE fingerprint=?').get(key.getFingerprint())) throw new ApiError(409, 'Для новой сессии нужен новый ключ. Старый ключ можно импортировать только для чтения истории.');
    const id = randomUUID();
    db.prepare('INSERT INTO encryption_devices VALUES (?,?,?,?,?,?,?,?)').run(id, req.sessionHash!, req.user!.id, input.label, input.publicKey, key.getFingerprint(), Date.now(), sessions.identity(req.sessionHash!, req.user!.id));
    changed(); return { device: device(id) };
  });
  app.get('/api/encryption/devices/:id', { preHandler: auth }, async req => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const found = device(id); if (!found) throw new ApiError(404, 'Ключ не найден.'); return { device: found };
  });
  const roomId = (req: FastifyRequest) => { const id = z.object({ id: z.string().min(1).max(64) }).parse(req.params).id; if (store.channel(id)?.kind !== 'voice') throw new ApiError(404, 'Комната не найдена.'); return id; };
  app.get('/api/encryption/rooms/:id', { preHandler: auth }, async req => {
    own(req); const row = db.prepare('SELECT envelope FROM encryption_rooms WHERE channelId=? AND roster=?').get(roomId(req), roster()) as { envelope: string } | undefined;
    return { envelope: row ? JSON.parse(row.envelope) : null, roster: roster() };
  });
  app.post('/api/encryption/rooms/:id', { preHandler: auth, bodyLimit: 120_000 }, async req => {
    const envelope = validate(req, req.body);
    const id = roomId(req);
    const inserted = db.prepare('INSERT OR IGNORE INTO encryption_rooms VALUES (?,?,?)').run(id, envelope.roster, JSON.stringify(envelope));
    if (!inserted.changes) throw new ApiError(409, 'Ключ комнаты уже создан.');
    return { ok: true };
  });
  app.get('/api/encryption/history-needed', { preHandler: auth }, async req => {
    own(req);
    const { after, retry } = z.object({ after: z.coerce.number().int().nonnegative().default(0), retry: z.enum(['0', '1']).default('0') }).parse(req.query);
    const active = JSON.stringify(devices().map(d => d.id));
    const rows = db.prepare(`SELECT m.id FROM messages m WHERE m.encrypted IS NOT NULL AND m.id>? AND EXISTS (
      SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS (
        SELECT 1 FROM encryption_rosters r, json_each(r.devices) original WHERE r.hash=json_extract(m.encrypted,'$.roster') AND original.value=wanted.value
      ) AND (?=1 OR NOT EXISTS (
        SELECT 1 FROM encryption_history_grants g, json_each(g.recipients) given WHERE g.messageId=m.id AND given.value=wanted.value
      ))) ORDER BY m.id LIMIT 20`).all(after, active, Number(retry)) as { id: number }[];
    return { messages: rows.map(row => store.message(row.id)) };
  });
  app.get('/api/messages/:id/key-grants', { preHandler: auth }, async req => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id;
    const rows = db.prepare(`SELECT g.envelope FROM encryption_history_grants g WHERE g.messageId=? AND EXISTS (
      SELECT 1 FROM json_each(g.recipients) r JOIN encryption_devices d ON d.id=r.value WHERE d.userId=?
    ) ORDER BY rowid DESC LIMIT 20`).all(id, req.user!.id) as { envelope: string }[];
    return { grants: rows.map(row => JSON.parse(row.envelope)) };
  });
  app.post('/api/messages/:id/key-grants', { preHandler: auth, bodyLimit: 120_000, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id;
    const envelope = validate(req, req.body);
    if (!store.message(id)?.encrypted) throw new ApiError(404, 'Зашифрованное сообщение не найдено.');
    db.prepare('INSERT INTO encryption_history_grants VALUES (?,?,?,?,?) ON CONFLICT(messageId,roster,grantor) DO UPDATE SET envelope=excluded.envelope').run(id, envelope.roster, envelope.deviceId, JSON.stringify(devices().map(d => d.id)), JSON.stringify(envelope));
    broadcast({ type: 'history-keys', messageId: id }); return { ok: true };
  });
  app.put('/api/messages/:id/encryption', { preHandler: admin, bodyLimit: 8 * 1024 * 1024 }, async req => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id;
    const input = z.object({ encrypted: envelopeSchema, image: z.string().optional() }).strict().parse(req.body);
    const envelope = validate(req, input.encrypted), image = cipherImage(input.image);
    const message = store.message(id);
    if (!message) throw new ApiError(404, 'Сообщение не найдено.');
    if (message.encrypted) throw new ApiError(409, 'Сообщение уже зашифровано.');
    if (Boolean(image) !== message.image) throw new ApiError(400, 'Сохраните изображение при шифровании истории.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE messages SET body='',encrypted=?,clientId=? WHERE id=? AND encrypted IS NULL").run(JSON.stringify(envelope), envelope.clientId, id);
      if (image) db.prepare("UPDATE message_images SET mime='application/octet-stream',data=? WHERE messageId=?").run(image, id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    broadcast({ type: 'message', message: store.message(id) }); return { ok: true };
  });
  return { enabled, devices, roster, changed, own, validate, cipherImage };
}
