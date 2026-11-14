export type StreamInfo = { id: string; title: string; quality: '720p60' | '1080p60'; state: 'starting' | 'live' | 'ended'; createdAt: number; endedAt: number | null; viewers: number; publishing: boolean };
export type StreamMessage = { id: number; authorId: string; author: string; body: string; createdAt: number };
export type StreamSnapshot = { type: 'snapshot'; stream: StreamInfo; guest: { id: string; label: string; banned: boolean }; messages: StreamMessage[] };
export async function streamApi<T>(origin: string, id: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/streams/${id}${path}`, { method: 'POST', credentials: 'include', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'Сервис эфиров недоступен.');
  return result;
}
