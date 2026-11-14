import { digest, newSecret } from './security.ts';

// Short-lived, single-use credentials for migrating a session between desktop
// runtimes. A restart invalidates outstanding transfers rather than persisting them.
export function createSessionTransfers(now = Date.now) {
  const pending = new Map<string, { sessionHash: string; expires: number }>();
  return {
    issue(sessionHash: string) {
      const time = now();
      for (const [key, item] of pending) if (item.expires <= time || item.sessionHash === sessionHash) pending.delete(key);
      if (pending.size >= 1000) throw new Error('Too many pending session transfers');
      const token = newSecret();
      pending.set(digest(token), { sessionHash, expires: time + 10 * 60_000 });
      return token;
    },
    consume(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      const key = digest(token);
      const item = pending.get(key);
      pending.delete(key);
      return item && item.expires > now() ? item.sessionHash : undefined;
    },
  };
}
