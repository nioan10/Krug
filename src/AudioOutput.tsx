import { useCallback, useEffect, useState } from 'react';
import { useMediaDeviceSelect, useRoomContext } from '@livekit/components-react';
import type { Room } from 'livekit-client';

const storageKey = 'krug-audio-output';
const readOutput = () => { try { return localStorage.getItem(storageKey) || 'default'; } catch { return 'default'; } };
const rememberOutput = (id: string) => { try { localStorage.setItem(storageKey, id); } catch { /* Storage can be unavailable. */ } };
type OutputContext = AudioContext & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
function playbackContext(room: Room): OutputContext | undefined {
  const mix = room.options.webAudioMix;
  return typeof mix === 'object' ? mix.audioContext : undefined;
}
export function supportsOutputSelection(room: Room) {
  const context = playbackContext(room);
  return context ? typeof context.setSinkId === 'function' : typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}
function currentOutput(room: Room) { return playbackContext(room)?.sinkId || room.getActiveDevice('audiooutput') || 'default'; }
export async function selectOutput(room: Room, id: string) {
  const context = playbackContext(room);
  if (!context) { await room.switchActiveDevice('audiooutput', id); return; }
  if (!context.setSinkId) throw new Error('Output selection is unsupported');
  const previous = currentOutput(room);
  try {
    await context.setSinkId(id === 'default' ? '' : id);
    // Match the muted media elements to the Web Audio destination for echo cancellation.
    await Promise.all([...room.remoteParticipants.values()].map(participant => participant.setAudioOutput({ deviceId: id })));
    room.options.audioOutput = { deviceId: id };
  } catch (error) {
    await context.setSinkId(previous === 'default' ? '' : previous).catch(() => {});
    await Promise.all([...room.remoteParticipants.values()].map(participant => participant.setAudioOutput({ deviceId: previous }).catch(() => {})));
    throw error;
  }
}

/** Restore only an already permitted device; never ask for microphone access on join. */
export function RestoreAudioOutput({ notify }: { notify: (message: string) => void }) {
  const room = useRoomContext();
  useEffect(() => {
    let stopped = false;
    const saved = readOutput();
    if (saved !== 'default' && supportsOutputSelection(room)) {
      void navigator.mediaDevices.enumerateDevices().then(async devices => {
        if (stopped) return;
        if (!devices.some(device => device.kind === 'audiooutput' && device.deviceId === saved)) { rememberOutput('default'); return; }
        await selectOutput(room, saved);
      }).catch(() => { if (!stopped) { rememberOutput('default'); notify('Сохранённые наушники недоступны. Используется устройство по умолчанию.'); } });
    }
    return () => { stopped = true; };
  }, [room, notify]);
  return null;
}

export function AudioOutputPicker({ notify }: { notify: (message: string) => void }) {
  const room = useRoomContext();
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState<MediaDeviceInfo[]>([]);
  const [selection, setSelection] = useState(() => currentOutput(room));
  const onError = useCallback(() => notify('Не удалось переключить динамики. Проверьте подключение устройства и разрешение браузера.'), [notify]);
  const { devices } = useMediaDeviceSelect({ kind: 'audiooutput', requestPermissions: false, onError });
  const supported = supportsOutputSelection(room);
  const choices = [...new Map([...devices, ...extra].filter(device => device.deviceId && device.deviceId !== 'default').map(device => [device.deviceId, device])).values()];
  const selected = choices.some(device => device.deviceId === selection) ? selection : 'default';
  async function change(id: string) {
    setBusy(true);
    try { await selectOutput(room, id); setSelection(id); rememberOutput(id); }
    catch { onError(); }
    finally { setBusy(false); }
  }
  async function reveal() {
    setBusy(true);
    try {
      const media = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
      if (media.selectAudioOutput) {
        const device = await media.selectAudioOutput();
        setExtra([device]);
        await selectOutput(room, device.deviceId); setSelection(device.deviceId); rememberOutput(device.deviceId);
      } else {
        // Chromium exposes the full speaker list after capture permission. Do not publish it.
        const stream = await media.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        setExtra((await media.enumerateDevices()).filter(device => device.kind === 'audiooutput'));
      }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) onError(); }
    finally { setBusy(false); }
  }
  return <div className="audio-output-picker"><label className="device-picker">Наушники / динамики
    <select value={selected} disabled={!supported || busy} aria-busy={busy} onChange={event => void change(event.target.value)}>
      <option value="default">По умолчанию (системное устройство)</option>
      {choices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Устройство вывода ${index + 1}`}</option>)}
    </select></label>
    {!supported ? <p className="tiny">Этот браузер не поддерживает выбор динамиков. Используется устройство из настроек системы.</p> : <><button className="text-button output-permission" type="button" disabled={busy} onClick={() => void reveal()}>Показать другие устройства</button>{choices.length === 0 && <p className="tiny">Браузер может запросить разрешение на микрофон для списка устройств. Микрофон в звонке не включится.</p>}</>}
  </div>;
}
