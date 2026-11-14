import type { EncryptedEnvelope } from './crypto-types';
export type AvatarStyle = { kind: 'image'; version: string } | { kind: 'text'; text: string; rotation: number };
export type User = { id: string; username: string; displayName: string; role: 'admin' | 'member' };
export type Channel = { id: string; name: string; kind: 'text' | 'voice'; description: string };
export type Message = { id: number; channelId: string; body: string; createdAt: number; user: User; image?: boolean; encrypted?: EncryptedEnvelope };
export type Invite = { id: string; expiresAt: number; usedAt: number | null; createdAt: number; revokedAt: number | null; usedBy: string | null; usedByUsername: string | null; usedByName: string | null; usedByDisabledAt: number | null };
export type Member = User & { createdAt: number; disabledAt: number | null };
export type VoiceOccupant = User & { identity?: string; microphoneEnabled: boolean; deafened: boolean | null; afk?: boolean };
export type VoicePresence = { rooms: Record<string, VoiceOccupant[]>; available: boolean };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status, result.message || 'Не удалось выполнить запрос.');
  return result;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Что-то пошло не так.';
