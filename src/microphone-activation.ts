export type MicrophoneActivationSettings = { enabled: boolean; threshold: number };
export function activationSettings(value?: Partial<MicrophoneActivationSettings>): MicrophoneActivationSettings {
  return { enabled: value?.enabled === true, threshold: typeof value?.threshold === 'number' && Number.isFinite(value.threshold) ? Math.max(-70, Math.min(-10, value.threshold)) : -45 };
}
const storageKey = 'krug-microphone-activation-v1';
export function loadActivation() { try { return activationSettings(JSON.parse(localStorage.getItem(storageKey) || '{}')); } catch { return activationSettings(); } }
export function saveActivation(value: MicrophoneActivationSettings) { try { localStorage.setItem(storageKey, JSON.stringify(activationSettings(value))); } catch { /* Storage can be unavailable. */ } }
