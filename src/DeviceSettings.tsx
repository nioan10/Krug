import { memo, useCallback, useState, type ReactNode } from 'react';
import { useMediaDeviceSelect } from '@livekit/components-react';
import { Modal } from './ui';
import { AudioOutputPicker } from './AudioOutput';

type Notify = (message: string) => void;

function DevicePicker({ kind, label, notify }: { kind: 'audioinput' | 'videoinput'; label: string; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const onError = useCallback(() => notify(`Не удалось выбрать устройство: ${label.toLowerCase()}.`), [label, notify]);
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind, onError, requestPermissions: false,
  });
  const selected = devices.some(device => device.deviceId === activeDeviceId) ? activeDeviceId : devices[0]?.deviceId ?? '';
  async function change(deviceId: string) {
    setBusy(true);
    try { await setActiveMediaDevice(deviceId, { exact: true }); }
    catch { onError(); }
    finally { setBusy(false); }
  }
  return <label className="device-picker">{label}
    <select value={selected} disabled={busy || devices.length === 0} aria-busy={busy} onChange={event => void change(event.target.value)}>
      {devices.length === 0 && <option value="">{label}: нет доступных устройств</option>}
      {devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `${label} ${index + 1}`}</option>)}
    </select>
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
