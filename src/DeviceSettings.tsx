import { memo, useCallback, useState, type ReactNode } from 'react';
import { useMediaDeviceSelect } from '@livekit/components-react';
import { Modal } from './ui';
import { AudioOutputPicker } from './AudioOutput';
import { microphoneErrorMessage } from './microphone-control';

type Notify = (message: string) => void;

function DevicePicker({ kind, label, notify }: { kind: 'audioinput' | 'videoinput'; label: string; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const onError = useCallback((error?: Error) => notify(kind === 'audioinput' ? microphoneErrorMessage(error, 'capture') : `Не удалось выбрать устройство: ${label.toLowerCase()}.`), [kind, label, notify]);
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind, onError, requestPermissions: false,
  });
  const microphone = kind === 'audioinput';
  const selected = microphone ? activeDeviceId || 'default' : devices.some(device => device.deviceId === activeDeviceId) ? activeDeviceId : devices[0]?.deviceId ?? '';
  const unavailable = microphone && selected !== 'default' && !devices.some(device => device.deviceId === selected);
  async function change(deviceId: string) {
    setBusy(true);
    try { await setActiveMediaDevice(deviceId, { exact: deviceId !== 'default' }); }
    catch (error) { onError(error instanceof Error ? error : undefined); }
    finally { setBusy(false); }
  }
  return <label className="device-picker">{label}
    <select value={selected} disabled={busy || (!microphone && devices.length === 0)} aria-busy={busy} onChange={event => void change(event.target.value)}>
      {microphone && <option value="default">По умолчанию</option>}
      {unavailable && <option value={selected} disabled>Выбранный микрофон недоступен</option>}
      {!microphone && devices.length === 0 && <option value="">{label}: нет доступных устройств</option>}
      {devices.filter(device => !microphone || (device.deviceId && device.deviceId !== 'default')).map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `${label} ${index + 1}`}</option>)}
    </select>
    {microphone && !devices.some(device => device.label) && <small>Включите микрофон и разрешите доступ, чтобы увидеть устройства.</small>}
  </label>;
}

export const DeviceSettings = memo(function DeviceSettings({ onClose, notify, children }: { onClose: () => void; notify: Notify; children?: ReactNode }) {
  return <Modal title="Звук и камера" onClose={onClose} closeOnBackdrop={false}><div className="form-stack">
    <DevicePicker kind="audioinput" label="Микрофон" notify={notify} />
    <AudioOutputPicker notify={notify} />
    <DevicePicker kind="videoinput" label="Камера" notify={notify} />
    {children}
    <p className="muted">«Выключить звук» заглушает собеседников, ваш микрофон управляется отдельно.</p>
  </div></Modal>;
});
