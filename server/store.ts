import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './security.ts';
import type { Config } from './config.ts';

export type User = { id: string; username: string; displayName: string; role: 'admin' | 'member' };
export type Channel = { id: string; name: string; kind: 'text' | 'voice'; description: string };
export type Message = { id: number; channelId: string; body: string; createdAt: number; user: User; image: boolean };
export const DAY = 86400_000;

export function openStore(config: Config) {
  if (config.DATABASE_PATH !== ':memory:') mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  const db = new DatabaseSync(config.DATABASE_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, displayName TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('admin','member')),
      createdBy TEXT REFERENCES users(id), expiresAt INTEGER NOT NULL, usedAt INTEGER, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('text','voice')), description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channelId TEXT NOT NULL REFERENCES channels(id),
      userId TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_images (
      messageId INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_reads (
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channelId TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      messageId INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userId, channelId)
    );
    CREATE TABLE IF NOT EXISTS blocked_voice_identities (userId TEXT PRIMARY KEY, blockedAt INTEGER NOT NULL, needsStream INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS messages_channel_id ON messages(channelId, id DESC);
    CREATE INDEX IF NOT EXISTS messages_created ON messages(createdAt);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userColumns.some(column => column.name === 'disabledAt')) db.exec('ALTER TABLE users ADD COLUMN disabledAt INTEGER');
  const inviteColumns = db.prepare('PRAGMA table_info(invites)').all() as { name: string }[];
  if (!inviteColumns.some(column => column.name === 'usedBy')) db.exec('ALTER TABLE invites ADD COLUMN usedBy TEXT REFERENCES users(id) ON DELETE SET NULL');
  if (!inviteColumns.some(column => column.name === 'revokedAt')) db.exec('ALTER TABLE invites ADD COLUMN revokedAt INTEGER');
  const blockedColumns = db.prepare('PRAGMA table_info(blocked_voice_identities)').all() as { name: string }[];
  if (!blockedColumns.some(column => column.name === 'needsStream')) db.exec('ALTER TABLE blocked_voice_identities ADD COLUMN needsStream INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'initialized'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      db.prepare('INSERT INTO invites (id,hash,role,createdBy,expiresAt,usedAt,createdAt) VALUES (?, ?, ?, NULL, ?, NULL, ?)').run(randomUUID(), digest(config.BOOTSTRAP_INVITE), 'admin', now + 7 * DAY, now);
      const insert = db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?)');
      insert.run('general', 'общий', 'text', 'Общий чат сервера.');
      insert.run('links', 'находки', 'text', 'Ссылки и обсуждения.');
      insert.run('lounge', 'Гостиная', 'voice', 'Основная голосовая комната.');
      insert.run('gaming', 'Игровая', 'voice', 'Голосовой чат для игр.');
      insert.run('quiet', 'Тихая комната', 'voice', 'Отдельная комната для работы и разговоров.');
      db.prepare("INSERT INTO meta VALUES ('initialized', '1')").run();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const publicUser = (id: string) => db.prepare('SELECT id, username, displayName, role FROM users WHERE id = ?').get(id) as User | undefined;
  const sessionUser = (hash: string) => db.prepare(`SELECT u.id, u.username, u.displayName, u.role FROM sessions s JOIN users u ON s.userId = u.id WHERE s.hash = ? AND s.expiresAt > ? AND u.disabledAt IS NULL`).get(hash, Date.now()) as User | undefined;
  const channel = (id: string) => db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Channel | undefined;
  const channels = () => db.prepare('SELECT * FROM channels ORDER BY rowid').all() as Channel[];
  const message = (id: number) => {
    const row = db.prepare('SELECT m.*, EXISTS(SELECT 1 FROM message_images i WHERE i.messageId = m.id) AS image FROM messages m WHERE m.id = ?').get(id) as { id: number; channelId: string; userId: string; body: string; createdAt: number; image: number } | undefined;
    return row ? { id: row.id, channelId: row.channelId, body: row.body, createdAt: row.createdAt, user: publicUser(row.userId)!, image: Boolean(row.image) } : undefined;
  };
  const unread = (userId: string) => {
    const rows = db.prepare(`SELECT c.id,
      EXISTS(SELECT 1 FROM messages m WHERE m.channelId = c.id AND m.id > COALESCE(r.messageId, 0) AND m.userId != ?) AS unread
      FROM channels c LEFT JOIN channel_reads r ON r.channelId = c.id AND r.userId = ?`).all(userId, userId) as { id: string; unread: number }[];
    return Object.fromEntries(rows.map(row => [row.id, Boolean(row.unread)]));
  };
  const markRead = (userId: string, channelId: string, messageId: number) => {
    const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channelId = ?').get(channelId) as { id: number };
    db.prepare(`INSERT INTO channel_reads (userId, channelId, messageId) VALUES (?, ?, ?)
      ON CONFLICT(userId, channelId) DO UPDATE SET messageId = MAX(channel_reads.messageId, excluded.messageId)`)
      .run(userId, channelId, Math.min(messageId, latest.id));
  };
  const cleanup = () => {
    db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now());
  };
  cleanup();
  return { db, publicUser, sessionUser, channel, channels, message, unread, markRead, cleanup };
}
