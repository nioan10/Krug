import { useCallback, useEffect, useState } from 'react';
import { LiveKitRoom, TrackToggle, useParticipants, useTracks, VideoTrack, useIsSpeaking, useConnectionState, StartAudio } from '@livekit/components-react';
import { Track, ConnectionState, type Participant, type RoomOptions } from 'livekit-client';
import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Settings2, Video, Maximize2, Radio, Volume2 } from 'lucide-react';
import { Avatar, Modal } from './ui';
import { IncomingAudio, MicrophoneToggle, VolumeSlider } from './AudioControls';
import { loadAudioLevels, saveAudioLevels } from './audio-levels';
import { DeviceSettings } from './DeviceSettings';
import type { Channel } from './api';

export type Call = { channel: Channel; token: string; url: string };
const options: RoomOptions = {
  adaptiveStream: true, dynacast: true,
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
};
function Person({ participant, onVolume }: { participant: Participant; onVolume: () => void }) {
  const speaking = useIsSpeaking(participant);
  return <div className={`person-tile ${speaking ? 'speaking' : ''}`}><Avatar name={participant.name || participant.identity} size="large" /><span className="person-name">{participant.name || 'Участник'}{participant.isLocal && <small>вы</small>}</span><span className="mic-state">{participant.isMicrophoneEnabled ? <Mic size={15} /> : <MicOff size={15} />}</span><button className="participant-volume icon-button" title={participant.isLocal ? 'Громкость микрофона' : `Громкость: ${participant.name || participant.identity}`} aria-label={participant.isLocal ? 'Громкость микрофона' : `Громкость: ${participant.name || participant.identity}`} onClick={onVolume}><Volume2 size={16} /></button>{speaking && <span className="speaking-label">Говорит</span>}</div>;
}
function CallContent({ onLeave, notify }: { onLeave: () => void; notify: (message: string) => void }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.Camera], { onlySubscribed: true });
  const state = useConnectionState();
  const [deafened, setDeafened] = useState(false);
  const [devices, setDevices] = useState(false);
  const [levels, setLevels] = useState(loadAudioLevels);
  const [volumeTarget, setVolumeTarget] = useState<string | null>(null);
  const closeVolume = useCallback(() => setVolumeTarget(null), []);
  useEffect(() => { saveAudioLevels(levels); }, [levels]);
  const target = participants.find(p => p.identity === volumeTarget);
  function openVolume(participant: Participant) { if (participant.isLocal) setDevices(true); else setVolumeTarget(participant.identity); }
  const closeDevices = useCallback(() => setDevices(false), []);
  const screens = tracks.filter(t => t.source === Track.Source.ScreenShare);
  const cameras = tracks.filter(t => t.source === Track.Source.Camera);
  return <div className="call-content">
    <IncomingAudio levels={levels} muted={deafened} />
    <div className="call-overline"><span className={`connection-label ${state === ConnectionState.Connected ? 'good' : ''}`}><span className="live-dot" />{state === ConnectionState.Connected ? 'Подключено' : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? 'Восстанавливаем связь…' : 'Подключаемся…'}</span><span>{participants.length} в комнате</span></div>
    <div className="call-stage">
      {screens.map(track => <div className="screen-tile" key={track.publication.trackSid}><VideoTrack trackRef={track} /><div className="screen-caption"><MonitorUp size={15} /><span>Экран · {track.participant.name}</span><button className="icon-button" aria-label="На весь экран" onClick={e => void e.currentTarget.closest('.screen-tile')?.requestFullscreen().catch(() => notify('Полноэкранный режим недоступен.'))}><Maximize2 size={16} /></button></div></div>)}
      <div className={`people-grid ${screens.length ? 'with-screen' : ''}`}>{participants.map(p => {
        const camera = cameras.find(t => t.participant.identity === p.identity);
        return camera ? <div className="camera-tile" key={p.identity}><VideoTrack trackRef={camera} /><span>{p.name}{p.isLocal ? ' · вы' : ''}</span><button className="participant-volume icon-button" title={`Громкость: ${p.name || p.identity}`} aria-label={`Громкость: ${p.name || p.identity}`} onClick={() => openVolume(p)}><Volume2 size={16} /></button></div> : <Person participant={p} key={p.identity} onVolume={() => openVolume(p)} />;
      })}</div>
      {participants.length === 1 && !screens.length && <div className="waiting-note"><Radio size={18} /><span>В комнате пока только вы.</span></div>}
    </div>
    <div className="call-controls"><div className="control-group">
      <MicrophoneToggle volume={levels.microphone} notify={notify} />
      <button className={deafened ? 'control-off' : ''} title={deafened ? 'Включить звук' : 'Выключить входящий звук'} aria-label={deafened ? 'Включить звук' : 'Выключить входящий звук'} aria-pressed={deafened} onClick={() => setDeafened(!deafened)}>{deafened ? <HeadphoneOff size={21} /> : <Headphones size={21} />}</button>
      <TrackToggle source={Track.Source.Camera} showIcon={false} aria-label="Включить или выключить камеру" title="Камера" onDeviceError={() => notify('Нет доступа к камере. Проверьте разрешения браузера.')}><Video size={21} /></TrackToggle>
      <TrackToggle source={Track.Source.ScreenShare} showIcon={false} aria-label="Демонстрация экрана" title="Демонстрация экрана" captureOptions={{ audio: true, resolution: { width: 1920, height: 1080, frameRate: 30 } }} onDeviceError={() => notify('Демонстрация не началась. Выберите экран или окно в диалоге браузера.')}><MonitorUp size={21} /><span>Поделиться</span></TrackToggle>
      <button title="Устройства" aria-label="Настроить устройства" onClick={() => setDevices(true)}><Settings2 size={20} /></button>
      <button className="hangup" title="Выйти из звонка" aria-label="Выйти из звонка" onClick={onLeave}><PhoneOff size={21} /></button>
    </div><StartAudio label="Нажмите, чтобы включить звук" /></div>
    {devices && <DeviceSettings onClose={closeDevices} notify={notify}><VolumeSlider label="Входящий звук" value={levels.master} onChange={master => setLevels(old => ({ ...old, master }))} /><VolumeSlider label="Громкость микрофона" value={levels.microphone} max={2} onChange={microphone => setLevels(old => ({ ...old, microphone }))} /><p className="tiny">Уровень микрофона меняет то, как вас слышат другие. Выше 100% — усиление; если голос искажается, уменьшите уровень.</p></DeviceSettings>}
    {volumeTarget && <Modal title="Громкость участника" onClose={closeVolume}><div className="form-stack"><VolumeSlider label={target?.name || 'Участник'} value={levels.participants[volumeTarget] ?? 1} onChange={value => setLevels(old => ({ ...old, participants: { ...old.participants, [volumeTarget]: value } }))} /><p className="muted">Меняет только то, как вы слышите этого участника, включая звук его демонстрации экрана.</p>{!target && <p className="tiny">Участник вышел из комнаты. Настройка сохранена.</p>}<button className="secondary" onClick={() => setLevels(old => ({ ...old, participants: { ...old.participants, [volumeTarget]: 1 } }))}>Сбросить до 100%</button></div></Modal>}
  </div>;
}
export function Voice({ call, onLeave, notify }: { call: Call; onLeave: () => void; notify: (s: string) => void }) {
  const onError = useCallback(() => notify('Не удалось подключиться к медиасерверу. Проверьте соединение и попробуйте снова.'), [notify]);
  const onMediaDeviceFailure = useCallback(() => notify('Браузер не дал доступ к устройству. Можно остаться слушателем и включить микрофон позже.'), [notify]);
  return <LiveKitRoom token={call.token} serverUrl={call.url} options={options} connect audio={false} video={false} onDisconnected={onLeave} onError={onError} onMediaDeviceFailure={onMediaDeviceFailure}><CallContent onLeave={onLeave} notify={notify} /></LiveKitRoom>;
}
