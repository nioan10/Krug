import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiError, digest, newSecret } from './security.ts';

export type Broadcast = { id: string; ownerId: string; ownerSession: string | null; publisherId: string; title: string; quality: '720p60' | '1080p60'; state: 'starting' | 'live' | 'ended'; createdAt: number; endedAt: number | null; leaseUntil: number; viewers: number; publishing: number; mediaClosed: number };
export type Guest = { id: string; streamId: string; banned: number };
export const guestLabel = (id: string) => `Аноним-${id.replace(/^guest-/, '').toUpperCase()}`;
export function publicBroadcast(stream: Broadcast) {
  return { id: stream.id, title: stream.title, quality: stream.quality, state: stream.state, createdAt: stream.createdAt, endedAt: stream.endedAt, viewers: stream.viewers, publishing: Boolean(stream.publishing) };
}
export function openStreamStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, publisherId TEXT NOT NULL, title TEXT NOT NULL,
      quality TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL, endedAt INTEGER,
      leaseUntil INTEGER NOT NULL, viewers INTEGER NOT NULL DEFAULT 0, publishing INTEGER NOT NULL DEFAULT 0, mediaClosed INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS broadcasts_one_per_owner ON broadcasts(ownerId) WHERE state != 'ended';
    CREATE TABLE IF NOT EXISTS stream_guests (
      streamId TEXT NOT NULL REFERENCES broadcasts(id), id TEXT NOT NULL, hash TEXT NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
      PRIMARY KEY(streamId,id), UNIQUE(streamId,hash)
    );
    CREATE TABLE IF NOT EXISTS stream_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, streamId TEXT NOT NULL, guestId TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL,
      FOREIGN KEY(streamId,guestId) REFERENCES stream_guests(streamId,id)
    );
    CREATE INDEX IF NOT EXISTS stream_messages_history ON stream_messages(streamId,id);
  `);
  if (!(db.prepare('PRAGMA table_info(broadcasts)').all() as { name: string }[]).some(c => c.name === 'ownerSession')) db.exec('ALTER TABLE broadcasts ADD COLUMN ownerSession TEXT');
  const get = (id: string) => db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id) as Broadcast | undefined;
  const require = (id: string) => { const row = get(id); if (!row) throw new ApiError(404, 'Эфир не найден.'); return row; };
  const end = (id: string) => db.prepare("UPDATE broadcasts SET state='ended', endedAt=COALESCE(endedAt,?), publishing=0,viewers=0 WHERE id=?").run(Date.now(), id);
  return {
    db, get, require, end,
    create(ownerId: string, title: string, quality: Broadcast['quality'], ownerSession: string | null = null) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare("SELECT id FROM broadcasts WHERE ownerId=? AND state!='ended'").get(ownerId)) throw new ApiError(409, 'У вас уже есть активный эфир.');
        if ((db.prepare("SELECT COUNT(*) AS n FROM broadcasts WHERE state!='ended'").get() as { n: number }).n >= 2) throw new ApiError(409, 'Сейчас уже идут два эфира. Попробуйте позже.');
        const id = randomBytes(16).toString('hex'); const now = Date.now();
        db.prepare('INSERT INTO broadcasts(id,ownerId,publisherId,title,quality,state,createdAt,leaseUntil) VALUES(?,?,?,?,?,?,?,?)').run(id, ownerId, 'source-' + randomBytes(12).toString('hex'), title, quality, 'starting', now, now + 60_000);
        db.prepare('UPDATE broadcasts SET ownerSession=? WHERE id=?').run(ownerSession, id);
        db.exec('COMMIT'); return require(id);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    mine(ownerId: string) { return db.prepare('SELECT * FROM broadcasts WHERE ownerId=? ORDER BY createdAt DESC LIMIT 10').all(ownerId) as Broadcast[]; },
    active() { return db.prepare("SELECT * FROM broadcasts WHERE state!='ended'").all() as Broadcast[]; },
    pendingClose() { return db.prepare("SELECT * FROM broadcasts WHERE state='ended' AND mediaClosed=0 LIMIT 30").all() as Broadcast[]; },
    expire() { db.prepare("UPDATE broadcasts SET state='ended', endedAt=?,publishing=0,viewers=0 WHERE state!='ended' AND leaseUntil<?").run(Date.now(), Date.now()); },
    heartbeat(id: string) { db.prepare("UPDATE broadcasts SET leaseUntil=? WHERE id=? AND state!='ended'").run(Date.now() + 60_000, id); },
    live(id: string) { db.prepare("UPDATE broadcasts SET state='live',publishing=1 WHERE id=? AND state='starting'").run(id); },
    guest(streamId: string, token: string) { return db.prepare('SELECT id,streamId,banned FROM stream_guests WHERE streamId=? AND hash=?').get(streamId, digest(token)) as Guest | undefined; },
    newGuest(streamId: string) {
      require(streamId);
      if ((db.prepare('SELECT COUNT(*) AS n FROM stream_guests WHERE streamId=?').get(streamId) as { n: number }).n >= 5000) throw new ApiError(429, 'В этом эфире слишком много гостевых сессий.');
      const token = newSecret(), id = 'guest-' + randomBytes(8).toString('hex');
      db.prepare('INSERT INTO stream_guests(streamId,id,hash,createdAt) VALUES(?,?,?,?)').run(streamId, id, digest(token), Date.now());
      return { token, guest: { id, streamId, banned: 0 } };
    },
    messages(id: string) {
      return (db.prepare('SELECT id,guestId AS authorId,body,createdAt FROM stream_messages WHERE streamId=? ORDER BY id DESC LIMIT 100').all(id) as { id: number; authorId: string; body: string; createdAt: number }[]).reverse().map(row => ({ ...row, author: guestLabel(row.authorId) }));
    },
    send(streamId: string, guestId: string, body: string) {
      const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const limits = db.prepare('SELECT COUNT(*) AS n, MAX(createdAt) AS last FROM stream_messages WHERE streamId=? AND guestId=? AND createdAt>?').get(streamId, guestId, now - 60_000) as { n: number; last: number | null };
        if (limits.n >= 18 || (limits.last && now - limits.last < 1500)) throw new ApiError(429, 'Слишком часто. Подождите немного.');
        db.prepare('INSERT INTO stream_messages(streamId,guestId,body,createdAt) VALUES(?,?,?,?)').run(streamId, guestId, body, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    deleteMessage(streamId: string, id: number) { db.prepare('DELETE FROM stream_messages WHERE streamId=? AND id=?').run(streamId, id); },
    ban(streamId: string, guestId: string) { db.prepare('UPDATE stream_guests SET banned=1 WHERE streamId=? AND id=?').run(streamId, guestId); },
  };
}
export type StreamStore = ReturnType<typeof openStreamStore>;
