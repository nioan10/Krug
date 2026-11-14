import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export function sessionStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_details (
    hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
    id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS voice_sessions (
    identity TEXT PRIMARY KEY, sessionHash TEXT NOT NULL, userId TEXT NOT NULL
  );`);
  // Keep old cookies valid. Public identifiers must never be session hashes.
  const missing = db.prepare('SELECT hash FROM sessions WHERE hash NOT IN (SELECT hash FROM session_details)').all() as { hash: string }[];
  for (const row of missing) db.prepare('INSERT INTO session_details VALUES (?, ?, ?, ?, ?)').run(row.hash, randomUUID(), 'Ранее подключённое устройство', Date.now(), Date.now());
  const active = (hash: string) => Boolean(db.prepare('SELECT 1 FROM sessions s JOIN users u ON u.id=s.userId WHERE s.hash=? AND s.expiresAt>? AND u.disabledAt IS NULL').get(hash, Date.now()));
  return {
    active,
    add(hash: string, userAgent: string | undefined) {
      db.prepare('INSERT INTO session_details VALUES (?, ?, ?, ?, ?)').run(hash, randomUUID(), (userAgent || 'Неизвестное устройство').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200), Date.now(), Date.now());
    },
    touch(hash: string) { db.prepare('UPDATE session_details SET lastSeenAt=? WHERE hash=? AND lastSeenAt<?').run(Date.now(), hash, Date.now() - 60_000); },
    list(userId: string, current: string) {
      return db.prepare(`SELECT d.id,d.label,d.createdAt,d.lastSeenAt,s.expiresAt,(s.hash=?) AS current
        FROM sessions s JOIN session_details d ON d.hash=s.hash WHERE s.userId=? AND s.expiresAt>? ORDER BY current DESC,d.lastSeenAt DESC`).all(current, userId, Date.now());
    },
    find(userId: string, id: string) { return db.prepare('SELECT s.hash FROM sessions s JOIN session_details d ON d.hash=s.hash WHERE s.userId=? AND d.id=?').get(userId, id) as { hash: string } | undefined; },
    identity(hash: string, userId: string) {
      const row = db.prepare('SELECT id FROM session_details WHERE hash=?').get(hash) as { id: string };
      const identity = `session-${row.id}`;
      db.prepare('INSERT OR IGNORE INTO voice_sessions VALUES (?, ?, ?)').run(identity, hash, userId);
      return identity;
    },
    voice(identity: string) { return db.prepare('SELECT sessionHash,userId FROM voice_sessions WHERE identity=?').get(identity) as { sessionHash: string; userId: string } | undefined; },
  };
}
