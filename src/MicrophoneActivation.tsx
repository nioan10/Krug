import { useEffect, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { LocalAudioTrack } from 'livekit-client';
import { MicrophoneGain } from './MicrophoneGain';
import { loadActivation, saveActivation, type MicrophoneActivationSettings } from './microphone-activation';

export function MicrophoneActivation() {
  const { microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  const [settings, setSettings] = useState(loadActivation);
  const [activity, setActivity] = useState({ db: -90, open: false });
  const track = microphoneTrack?.track;
  const processor = () => { const p = track instanceof LocalAudioTrack ? track.getProcessor() : undefined; return p instanceof MicrophoneGain ? p : undefined; };
  function update(next: MicrophoneActivationSettings) { setSettings(next); saveActivation(next); processor()?.setActivation(next); }
  useEffect(() => {
    const timer = setInterval(() => setActivity(isMicrophoneEnabled ? processor()?.activity ?? { db: -90, open: false } : { db: -90, open: false }), 70);
    return () => clearInterval(timer);
  }, [track, isMicrophoneEnabled]);
  const position = (db: number) => Math.max(0, Math.min(100, (db + 70) / 60 * 100));
  return <div className="microphone-activation">
    <label className="noise-setting"><span><strong>Порог активации микрофона</strong><small>Передавать голос, когда он громче порога</small></span><input type="checkbox" checked={settings.enabled} onChange={e => update({ ...settings, enabled: e.target.checked })} /></label>
    <div className="microphone-meter" role="meter" aria-label="Уровень микрофона" aria-valuemin={-70} aria-valuemax={-10} aria-valuenow={Math.max(-70, Math.min(-10, activity.db))}>
      <span className={activity.open ? 'gate-open' : ''} style={{ width: `${position(activity.db)}%` }} />
      {settings.enabled && <i style={{ left: `${position(settings.threshold)}%` }} />}
    </div>
    <label className="microphone-threshold"><span>Порог <output>{settings.threshold} дБ</output></span><input aria-label="Порог активации микрофона" type="range" min={-70} max={-10} step={1} value={settings.threshold} disabled={!settings.enabled} onChange={e => update({ ...settings, threshold: Number(e.target.value) })} /></label>
    <div className="microphone-threshold-scale"><span>Тише</span><span>Громче</span></div>
    <p className="tiny" aria-live="polite">{!isMicrophoneEnabled ? 'Включите микрофон, чтобы видеть уровень.' : !settings.enabled ? 'Порог выключен — звук передаётся постоянно.' : activity.open ? 'Голос проходит' : 'Ниже порога — микрофон молчит'}</p>
    <p className="tiny">Говорите и двигайте ползунок: изменения слышны сразу. Поставьте отметку чуть выше фонового шума.</p>
  </div>;
}
