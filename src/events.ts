import type { Channel, Message, User } from './api';
export type ServerEvent =
  | { type: 'ready' }
  | { type: 'presence'; users: User[] }
  | { type: 'channels'; channels: Channel[] }
  | { type: 'channel-deleted'; channelId: string }
  | { type: 'message'; message: Message }
  | { type: 'message-deleted'; id: number; channelId: string }
  | { type: 'history-cleared'; channelId: string };
export const events = new EventTarget();
export const emit = (event: ServerEvent) => events.dispatchEvent(new CustomEvent('event', { detail: event }));
export function subscribe(callback: (event: ServerEvent) => void) {
  const listener = (event: Event) => callback((event as CustomEvent<ServerEvent>).detail);
  events.addEventListener('event', listener);
  return () => events.removeEventListener('event', listener);
}
