import { useCallback, useState } from 'react';
import { LiveKitRoom, RoomAudioRenderer, TrackToggle, useParticipants, useTracks, VideoTrack, useIsSpeaking, useConnectionState, StartAudio } from '@livekit/components-react';
import { Track, ConnectionState, type Participant, type RoomOptions } from 'livekit-client';
import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Settings2, Video, Maximize2, Radio } from 'lucide-react';
import { Avatar } from './ui';
import { DeviceSettings } from './DeviceSettings';
import type { Channel } from './api';

export type Call = { channel: Channel; token: string; url: string };
const options: RoomOptions = {
  adaptiveStream: true, dynacast: true,
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
};
function Person({ participant }: { participant: Participant }) {
  const speaking = useIsSpeaking(participant);
  return <div className={`person-tile ${speaking ? 'speaking' : ''}`}><Avatar name={participant.name || participant.identity} size="large" /><span className="person-name">{participant.name || 'Участник'}{participant.isLocal && <small>вы</small>}</span><span className="mic-state">{participant.isMicrophoneEnabled ? <Mic size={15} /> : <MicOff size={15} />}</span>{speaking && <span className="speaking-label">Говорит</span>}</div>;
}
function CallContent({ onLeave, notify }: { onLeave: () => void; notify: (message: string) => void }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.Camera], { onlySubscribed: true });
  const state = useConnectionState();
  const [deafened, setDeafened] = useState(false);
  const [devices, setDevices] = useState(false);
  const closeDevices = useCallback(() => setDevices(false), []);
  const screens = tracks.filter(t => t.source === Track.Source.ScreenShare);
  const cameras = tracks.filter(t => t.source === Track.Source.Camera);
  return <div className="call-content">
    <RoomAudioRenderer muted={deafened} />
    <div className="call-overline"><span className={`connection-label ${state === ConnectionState.Connected ? 'good' : ''}`}><span className="live-dot" />{state === ConnectionState.Connected ? 'Подключено' : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? 'Восстанавливаем связь…' : 'Подключаемся…'}</span><span>{participants.length} в комнате</span></div>
    <div className="call-stage">
      {screens.map(track => <div className="screen-tile" key={track.publication.trackSid}><VideoTrack trackRef={track} /><div className="screen-caption"><MonitorUp size={15} /><span>Экран · {track.participant.name}</span><button className="icon-button" aria-label="На весь экран" onClick={e => void e.currentTarget.closest('.screen-tile')?.requestFullscreen().catch(() => notify('Полноэкранный режим недоступен.'))}><Maximize2 size={16} /></button></div></div>)}
      <div className={`people-grid ${screens.length ? 'with-screen' : ''}`}>{participants.map(p => {
        const camera = cameras.find(t => t.participant.identity === p.identity);
        return camera ? <div className="camera-tile" key={p.identity}><VideoTrack trackRef={camera} /><span>{p.name}{p.isLocal ? ' · вы' : ''}</span></div> : <Person participant={p} key={p.identity} />;
      })}</div>
      {participants.length === 1 && !screens.length && <div className="waiting-note"><Radio size={18} /><span>В комнате пока только вы.</span></div>}
    </div>
    <div className="call-controls"><div className="control-group">
      <TrackToggle source={Track.Source.Microphone} showIcon={false} aria-label="Включить или выключить микрофон" title="Микрофон" onDeviceError={() => notify('Нет доступа к микрофону. Проверьте разрешения браузера.')}><Mic size={21} /></TrackToggle>
      <button className={deafened ? 'control-off' : ''} title={deafened ? 'Включить звук' : 'Выключить входящий звук'} aria-label={deafened ? 'Включить звук' : 'Выключить входящий звук'} aria-pressed={deafened} onClick={() => setDeafened(!deafened)}>{deafened ? <HeadphoneOff size={21} /> : <Headphones size={21} />}</button>
      <TrackToggle source={Track.Source.Camera} showIcon={false} aria-label="Включить или выключить камеру" title="Камера" onDeviceError={() => notify('Нет доступа к камере. Проверьте разрешения браузера.')}><Video size={21} /></TrackToggle>
      <TrackToggle source={Track.Source.ScreenShare} showIcon={false} aria-label="Демонстрация экрана" title="Демонстрация экрана" captureOptions={{ audio: true, resolution: { width: 1920, height: 1080, frameRate: 30 } }} onDeviceError={() => notify('Демонстрация не началась. Выберите экран или окно в диалоге браузера.')}><MonitorUp size={21} /><span>Поделиться</span></TrackToggle>
      <button title="Устройства" aria-label="Настроить устройства" onClick={() => setDevices(true)}><Settings2 size={20} /></button>
      <button className="hangup" title="Выйти из звонка" aria-label="Выйти из звонка" onClick={onLeave}><PhoneOff size={21} /></button>
    </div><StartAudio label="Нажмите, чтобы включить звук" /></div>
    {devices && <DeviceSettings onClose={closeDevices} notify={notify} />}
  </div>;
}
export function Voice({ call, onLeave, notify }: { call: Call; onLeave: () => void; notify: (s: string) => void }) {
  const onError = useCallback(() => notify('Не удалось подключиться к медиасерверу. Проверьте соединение и попробуйте снова.'), [notify]);
  const onMediaDeviceFailure = useCallback(() => notify('Браузер не дал доступ к устройству. Можно остаться слушателем и включить микрофон позже.'), [notify]);
  return <LiveKitRoom token={call.token} serverUrl={call.url} options={options} connect audio={false} video={false} onDisconnected={onLeave} onError={onError} onMediaDeviceFailure={onMediaDeviceFailure}><CallContent onLeave={onLeave} notify={notify} /></LiveKitRoom>;
}
