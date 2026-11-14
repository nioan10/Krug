export type User = { id: string; username: string; displayName: string; role: 'admin' | 'member' };
export type Channel = { id: string; name: string; kind: 'text' | 'voice'; description: string };
export type Message = { id: number; channelId: string; body: string; createdAt: number; user: User; image?: boolean };
export type Invite = { id: string; expiresAt: number; usedAt: number | null; createdAt: number };
export type VoiceOccupant = User & { microphoneEnabled: boolean; deafened: boolean | null };
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
