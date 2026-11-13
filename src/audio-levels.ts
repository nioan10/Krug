export type AudioLevels = { master: number; microphone: number; participants: Record<string, number> };
export const defaultAudioLevels = (): AudioLevels => ({ master: 1, microphone: 1, participants: {} });
export function level(value: unknown, maximum = 1): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 1;
}
export function parseAudioLevels(raw: string | null): AudioLevels {
  try {
    const parsed = JSON.parse(raw || '{}');
    return { master: level(parsed.master, 2), microphone: level(parsed.microphone, 2), participants: Object.fromEntries(
      Object.entries(parsed.participants || {}).slice(0, 200).map(([id, value]) => [id, level(value, 2)]),
    ) };
  } catch { return defaultAudioLevels(); }
}
const key = 'krug-audio-levels-v1';
export function loadAudioLevels(): AudioLevels {
  try { return parseAudioLevels(localStorage.getItem(key)); } catch { return defaultAudioLevels(); }
}
export function saveAudioLevels(levels: AudioLevels) {
  try { localStorage.setItem(key, JSON.stringify(levels)); } catch { /* Private browsing may disable storage. */ }
}
export const incomingLevel = (levels: AudioLevels, identity: string) => level(levels.master, 2) * level(levels.participants[identity], 2);
