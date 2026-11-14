export type AudioLevels = {
  master: number; microphone: number; participants: Record<string, number>;
  screens: Record<string, number>; screenDefaults: Record<string, number>;
};
export const defaultAudioLevels = (): AudioLevels => ({ master: 1, microphone: 1, participants: {}, screens: {}, screenDefaults: {} });
export function level(value: unknown, maximum = 1): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 1;
}
export function parseAudioLevels(raw: string | null): AudioLevels {
  try {
    const parsed = JSON.parse(raw || '{}');
    const map = (value: unknown) => Object.fromEntries(
      Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).slice(-200).map(([id, value]) => [id, level(value, 2)]),
    );
    return {
      master: level(parsed.master, 2), microphone: level(parsed.microphone, 2), participants: map(parsed.participants), screens: map(parsed.screens),
      // Preserve existing silence/gain on upgrade, independently of subsequent voice changes.
      screenDefaults: map(parsed.screens === undefined ? parsed.participants : parsed.screenDefaults),
    };
  } catch { return defaultAudioLevels(); }
}
const key = 'krug-audio-levels-v1';
export function loadAudioLevels(): AudioLevels {
  try { return parseAudioLevels(localStorage.getItem(key)); } catch { return defaultAudioLevels(); }
}
export function saveAudioLevels(levels: AudioLevels) {
  try { localStorage.setItem(key, JSON.stringify(levels)); } catch { /* Private browsing may disable storage. */ }
}
// Session identities keep two simultaneous shares from the same account independent.
export const screenLevel = (levels: AudioLevels, identity: string, userId: string) => level(levels.screens[identity] ?? levels.screenDefaults[userId], 2);
export const incomingLevel = (levels: AudioLevels, userId: string, screenIdentity?: string) => level(levels.master, 2) *
  (screenIdentity === undefined ? level(levels.participants[userId], 2) : screenLevel(levels, screenIdentity, userId));
