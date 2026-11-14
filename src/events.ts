import type { AvatarStyle, Channel, Message, User, VoicePresence } from './api';
export type ServerEvent =
  | { type: 'ready' }
  | { type: 'unread'; channels: Record<string, boolean> }
  | { type: 'presence'; users: User[] }
  | { type: 'members-updated' }
  | { type: 'avatar-updated'; userId: string; avatar: AvatarStyle | null }
  | { type: 'channels'; channels: Channel[] }
  | { type: 'channel-deleted'; channelId: string }
  | ({ type: 'voice-presence' } & VoicePresence)
  | { type: 'message'; message: Message }
  | { type: 'mention'; channelId: string; channelName: string; author: string }
  | { type: 'message-deleted'; id: number; channelId: string }
  | { type: 'history-cleared'; channelId: string };
export const events = new EventTarget();
export const emit = (event: ServerEvent) => events.dispatchEvent(new CustomEvent('event', { detail: event }));
export function subscribe(callback: (event: ServerEvent) => void) {
  const listener = (event: Event) => callback((event as CustomEvent<ServerEvent>).detail);
  events.addEventListener('event', listener);
  return () => events.removeEventListener('event', listener);
}
