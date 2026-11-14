import { participantUserId } from './participant-user';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { useEncryption } from './EncryptionSettings';
import { subscribe } from './events';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveKitRoom, TrackToggle, useParticipants, useTracks, VideoTrack, useIsSpeaking, useIsMuted, useConnectionState, StartAudio, type TrackReference } from '@livekit/components-react';
import { Room, RoomEvent, ExternalE2EEKeyProvider, isE2EESupported, Track, ConnectionState, ParticipantEvent, LocalAudioTrack, type Participant, type RoomOptions } from 'livekit-client';
import { Coffee, Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Settings2, Video, Maximize2, Radio, Volume2 } from 'lucide-react';
import { Avatar, Modal } from './ui';
import { IncomingAudio, MicrophoneToggle, VolumeSlider } from './AudioControls';
import { loadAudioLevels, saveAudioLevels } from './audio-levels';
import { DeviceSettings } from './DeviceSettings';
import { RestoreAudioOutput } from './AudioOutput';
import { api, type Channel, type VoiceOccupant } from './api';
import { DesktopShare } from './DesktopShare';
import { hasVisibleCamera } from './camera-state';

export type Call = { channel: Channel; token: string; url: string; e2ee?: { key: ArrayBuffer; roster: string } };
const options: RoomOptions = {
  adaptiveStream: true, dynacast: true,
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
};
function VoiceStatus({ participant, deafened }: { participant: Participant; deafened: boolean | null }) {
  const [microphoneEnabled, setMicrophoneEnabled] = useState(participant.isMicrophoneEnabled);
  useEffect(() => {
    const update = () => setMicrophoneEnabled(participant.isMicrophoneEnabled);
    const events = [ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted, ParticipantEvent.TrackPublished, ParticipantEvent.TrackUnpublished, ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished] as const;
    for (const event of events) participant.on(event, update);
    update(); return () => { for (const event of events) participant.off(event, update); };
  }, [participant]);
  const micLabel = microphoneEnabled ? 'Микрофон включён' : 'Микрофон выключен';
  const audioLabel = deafened === null ? 'Состояние звука неизвестно' : deafened ? 'Входящий звук выключен' : 'Входящий звук включён';
  return <div className="person-states"><span role="img" className={microphoneEnabled ? 'voice-state-on' : 'voice-state-off'} title={micLabel} aria-label={micLabel}>{microphoneEnabled ? <Mic size={15} /> : <MicOff size={15} />}</span><span role="img" className={deafened === null ? 'voice-state-unknown' : deafened ? 'voice-state-off' : 'voice-state-on'} title={audioLabel} aria-label={audioLabel}>{deafened ? <HeadphoneOff size={15} /> : <Headphones size={15} />}</span></div>;
}
function AfkBadge({ active }: { active: boolean }) {
  const [shown, setShown] = useState(active);
  useEffect(() => {
    if (active) { setShown(true); return; }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700;
    const timer = window.setTimeout(() => setShown(false), delay);
    return () => window.clearTimeout(timer);
  }, [active]);
  if (!shown && !active) return null;
  return <div className={`afk-badge ${active ? '' : 'afk-exiting'}`} aria-label="Отошёл" aria-hidden={!active}><span className="afk-orbit" aria-hidden="true">✦</span><Coffee size={13} /> АФК</div>;
}
function Person({ participant, onVolume, deafened, afk }: { participant: Participant; onVolume: () => void; deafened: boolean | null; afk: boolean }) {
  const speaking = useIsSpeaking(participant);
  return <div className={`person-tile ${speaking ? 'speaking' : ''}`}><AfkBadge active={afk} /><Avatar name={participant.name || participant.identity} userId={participantUserId(participant)} size="large" /><span className="person-name">{participant.name || 'Участник'}{participant.isLocal && <small>вы</small>}</span><VoiceStatus participant={participant} deafened={deafened} /><button className="participant-volume icon-button" title={participant.isLocal ? 'Громкость микрофона' : `Громкость: ${participant.name || participant.identity}`} aria-label={participant.isLocal ? 'Громкость микрофона' : `Громкость: ${participant.name || participant.identity}`} onClick={onVolume}><Volume2 size={16} /></button>{speaking && !afk && <span className="speaking-label">Говорит</span>}</div>;
}
function ParticipantTile({ participant, camera, onVolume, deafened, afk }: { participant: Participant; camera?: TrackReference; onVolume: () => void; deafened: boolean | null; afk: boolean }) {
  const muted = useIsMuted(camera ?? { participant, source: Track.Source.Camera });
  const speaking = useIsSpeaking(participant);
  if (!camera || !hasVisibleCamera(camera.publication, muted)) return <Person participant={participant} onVolume={onVolume} deafened={deafened} afk={afk} />;
  return <div className={`camera-tile ${speaking ? 'speaking' : ''}`}><VideoTrack trackRef={camera} /><AfkBadge active={afk} /><span>{participant.name}{participant.isLocal ? ' · вы' : ''}</span><VoiceStatus participant={participant} deafened={deafened} /><button className="participant-volume icon-button" title={`Громкость: ${participant.name || participant.identity}`} aria-label={`Громкость: ${participant.name || participant.identity}`} onClick={onVolume}><Volume2 size={16} /></button>{speaking && !afk && <div className="speaking-label">Говорит</div>}</div>;
}
function CallContent({ room, onLeave, notify, channelId, presence }: { room: Room; onLeave: () => void; notify: (message: string) => void; channelId: string; presence: VoiceOccupant[] }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.Camera], { onlySubscribed: true });
  const state = useConnectionState();
  const [ping, setPing] = useState<number | null>(null);
  useEffect(() => {
    if (state !== ConnectionState.Connected) { setPing(null); return; }
    let cancelled = false;
    const measure = async () => {
      try {
        const manager = room.engine.pcManager;
        const reports = await Promise.all([manager?.subscriber?.getStats(), manager?.publisher.getStats()]);
        let latency: number | null = null;
        for (const report of reports) {
          if (!report) continue;
          const selected = [...report.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId)?.selectedCandidatePairId;
          const pair = selected ? report.get(selected) : [...report.values()].find(s => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated);
          if (typeof pair?.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime)) { latency = Math.round(pair.currentRoundTripTime * 1000); break; }
        }
        if (!cancelled) setPing(latency);
      } catch { if (!cancelled) setPing(null); }
    };
    void measure(); const timer = setInterval(measure, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [room, state]);
  const [deafened, setDeafened] = useState(false);
  const [afk, setAfk] = useState(false);
  const [noiseSuppression, setNoiseSuppression] = useState(() => { try { return localStorage.getItem('krug-noise-suppression') !== 'off'; } catch { return true; } });
  const [changingNoise, setChangingNoise] = useState(false);
  useEffect(() => { room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, noiseSuppression }; }, [room, noiseSuppression]);
  async function changeNoiseSuppression(enabled: boolean) {
    if (changingNoise) return;
    setChangingNoise(true);
    try {
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (track instanceof LocalAudioTrack) await track.applyConstraints({ noiseSuppression: enabled, echoCancellation: true, autoGainControl: true });
      room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, noiseSuppression: enabled };
      setNoiseSuppression(enabled);
      try { localStorage.setItem('krug-noise-suppression', enabled ? 'on' : 'off'); } catch { /* Keep the current setting for this session. */ }
    } catch { notify('Не удалось изменить шумоподавление для этого микрофона.'); }
    finally { setChangingNoise(false); }
  }
  const stateRequests = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (state !== ConnectionState.Connected) return;
    const report = () => { stateRequests.current = stateRequests.current.catch(() => {}).then(() => api('/voice-state', 'POST', { channelId, deafened, afk })).then(() => {}).catch(() => {}); };
    report(); const interval = setInterval(report, 12_000);
    return () => clearInterval(interval);
  }, [channelId, state, deafened, afk]);
  const [devices, setDevices] = useState(false);
  const [levels, setLevels] = useState(loadAudioLevels);
  const [volumeTarget, setVolumeTarget] = useState<string | null>(null);
  const closeVolume = useCallback(() => setVolumeTarget(null), []);
  useEffect(() => { saveAudioLevels(levels); }, [levels]);
  const target = participants.find(p => participantUserId(p) === volumeTarget);
  function openVolume(participant: Participant) { if (participant.isLocal) setDevices(true); else setVolumeTarget(participantUserId(participant)); }
  const closeDevices = useCallback(() => setDevices(false), []);
  const screens = tracks.filter(t => t.source === Track.Source.ScreenShare);
  const cameras = tracks.filter(t => t.source === Track.Source.Camera);
  return <div className="call-content">
    <RestoreAudioOutput notify={notify} />
    <IncomingAudio levels={levels} muted={deafened} />
    <div className="call-overline"><span className={`connection-label ${state === ConnectionState.Connected ? 'good' : ''}`}><span className="live-dot" />{state === ConnectionState.Connected ? 'Подключено' : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? 'Восстанавливаем связь…' : 'Подключаемся…'}{state === ConnectionState.Connected && <span className="call-ping" title="Задержка до голосового сервера">{ping === null ? 'Пинг —' : `${ping} мс`}</span>}</span><span>{room.options.encryption ? '🔒 Сквозное шифрование · ' : ''}{participants.length} в комнате</span></div>
    <div className="call-stage">
      {screens.map(track => <div className="screen-tile" key={track.publication.trackSid}><VideoTrack trackRef={track} /><div className="screen-caption"><MonitorUp size={15} /><span>Экран · {track.participant.name}</span><button className="icon-button" aria-label="На весь экран" onClick={e => void e.currentTarget.closest('.screen-tile')?.requestFullscreen().catch(() => notify('Полноэкранный режим недоступен.'))}><Maximize2 size={16} /></button></div></div>)}
      <div className={`people-grid ${screens.length ? 'with-screen' : ''}`}>{participants.map(p => {
        const camera = cameras.find(t => t.participant.identity === p.identity);
        const audioState = p.isLocal ? deafened : presence.find(person => (person.identity ?? person.id) === p.identity)?.deafened ?? null;
        return <ParticipantTile participant={p} camera={camera} key={p.identity} onVolume={() => openVolume(p)} deafened={audioState} afk={p.isLocal ? afk : Boolean(presence.find(person => (person.identity ?? person.id) === p.identity)?.afk)} />;
      })}</div>
      {participants.length === 1 && !screens.length && <div className="waiting-note"><Radio size={18} /><span>В комнате пока только вы.</span></div>}
    </div>
    <div className="call-controls"><div className="control-group">
      <MicrophoneToggle volume={levels.microphone} notify={notify} />
      <button className={deafened ? 'control-off' : ''} title={deafened ? 'Включить звук' : 'Выключить входящий звук'} aria-label={deafened ? 'Включить звук' : 'Выключить входящий звук'} aria-pressed={deafened} onClick={() => setDeafened(!deafened)}>{deafened ? <HeadphoneOff size={21} /> : <Headphones size={21} />}</button>
      <TrackToggle source={Track.Source.Camera} showIcon={false} aria-label="Включить или выключить камеру" title="Камера" onDeviceError={() => notify('Нет доступа к камере. Проверьте разрешения браузера.')}><Video size={21} /></TrackToggle>
      {window.krugDesktop ? <DesktopShare notify={notify} /> : <TrackToggle source={Track.Source.ScreenShare} showIcon={false} aria-label="Демонстрация экрана" title="Демонстрация экрана" captureOptions={{ audio: true, resolution: { width: 1920, height: 1080, frameRate: 30 } }} onDeviceError={() => notify('Демонстрация не началась. Выберите экран или окно в диалоге браузера.')}><MonitorUp size={21} /><span>Поделиться</span></TrackToggle>}
      <button className={afk ? 'afk-active' : ''} aria-label={afk ? 'Я вернулся' : 'Я отошёл'} aria-pressed={afk} title={afk ? 'Вернуться' : 'Показать, что вы отошли'} onClick={() => setAfk(!afk)}><Coffee size={20} /><span>{afk ? 'Вернулся' : 'АФК'}</span></button>
      <button title="Устройства" aria-label="Настроить устройства" onClick={() => setDevices(true)}><Settings2 size={20} /></button>
      <button className="hangup" title="Выйти из звонка" aria-label="Выйти из звонка" onClick={onLeave}><PhoneOff size={21} /></button>
    </div><StartAudio label="Нажмите, чтобы включить звук" /></div>
    {devices && <DeviceSettings onClose={closeDevices} notify={notify}><label className="noise-setting"><span><strong>Шумоподавление</strong><small>Уменьшает фоновый шум микрофона средствами устройства</small></span><input type="checkbox" checked={noiseSuppression} disabled={changingNoise} onChange={event => void changeNoiseSuppression(event.target.checked)} /></label><VolumeSlider label="Входящий звук" value={levels.master} onChange={master => setLevels(old => ({ ...old, master }))} /><VolumeSlider label="Громкость микрофона" value={levels.microphone} max={2} onChange={microphone => setLevels(old => ({ ...old, microphone }))} /><p className="tiny">Уровень микрофона меняет то, как вас слышат другие. Выше 100% — усиление; если голос искажается, уменьшите уровень.</p></DeviceSettings>}
    {volumeTarget && <Modal title="Громкость участника" onClose={closeVolume}><div className="form-stack"><VolumeSlider label={target?.name || 'Участник'} value={levels.participants[volumeTarget] ?? 1} onChange={value => setLevels(old => ({ ...old, participants: { ...old.participants, [volumeTarget]: value } }))} /><p className="muted">Меняет только то, как вы слышите этого участника, включая звук его демонстрации экрана.</p>{!target && <p className="tiny">Участник вышел из комнаты. Настройка сохранена.</p>}<button className="secondary" onClick={() => setLevels(old => ({ ...old, participants: { ...old.participants, [volumeTarget]: 1 } }))}>Сбросить до 100%</button></div></Modal>}
  </div>;
}
export function Voice({ call, presence, onLeave, notify }: { call: Call; presence: VoiceOccupant[]; onLeave: () => void; notify: (s: string) => void }) {
  const { manager } = useEncryption();
  const [room, setRoom] = useState<Room>();
  const active = useRef(false);
  useEffect(() => {
    let disposed = false;
    active.current = true;
    const audioContext = new AudioContext({ latencyHint: 'interactive' });
    let nextRoom: Room | undefined; let worker: Worker | undefined;
    async function prepare() {
      let encryption;
      if (call.e2ee) {
        if (!isE2EESupported()) throw Error('Этот браузер не поддерживает сквозное шифрование звонков. Обновите приложение или браузер.');
        worker = new E2EEWorker();
        const keyProvider = new ExternalE2EEKeyProvider();
        await keyProvider.setKey(call.e2ee.key);
        encryption = { keyProvider, worker };
      }
      if (disposed) { worker?.terminate(); return; }
      nextRoom = new Room({ ...options, encryption, webAudioMix: { audioContext } });
      if (call.e2ee) {
        await nextRoom.setE2EEEnabled(true);
        nextRoom.on(RoomEvent.EncryptionError, () => { if (!disposed) { notify('Ошибка шифрования. Звонок остановлен.'); onLeave(); } });
        nextRoom.on(RoomEvent.TrackSubscribed, (_track, publication) => {
          if (!publication.isEncrypted && !disposed) { publication.setSubscribed(false); notify('Получен незашифрованный поток. Звонок остановлен.'); onLeave(); }
        });
      }
      if (!disposed) setRoom(nextRoom);
    }
    void prepare().catch(error => { if (!disposed) { notify(error instanceof Error ? error.message : 'Не удалось включить шифрование звонка.'); onLeave(); } });
    let checking = false;
    async function checkAccess() {
      if (checking || disposed || !manager) return;
      checking = true;
      const deadline = setTimeout(() => { if (!disposed) { notify('Не удалось проверить доступ к звонку. Подключитесь снова.'); onLeave(); } }, 5000);
      try {
        const state = await manager.refresh();
        if (state.enabled !== Boolean(call.e2ee) || (call.e2ee && state.roster !== call.e2ee.roster)) {
          if (!disposed) { notify('Состав устройств изменился. Подключитесь к звонку с новым ключом.'); onLeave(); }
        }
      } catch { if (!disposed) { notify('Не удалось подтвердить доступ. Звонок остановлен.'); onLeave(); } }
      finally { clearTimeout(deadline); checking = false; }
    }
    const off = subscribe(event => { if (event.type === 'encryption-changed' || event.type === 'ready') void checkAccess(); });
    const timer = setInterval(() => void checkAccess(), 3000);
    return () => {
      disposed = true; active.current = false; clearInterval(timer); off();
      void (nextRoom?.disconnect() ?? Promise.resolve()).finally(() => { worker?.terminate(); return audioContext.close(); }).catch(() => {});
    };
  }, []);
  const onDisconnected = useCallback(() => { if (active.current) onLeave(); }, [onLeave]);
  const onError = useCallback(() => notify('Не удалось подключиться к медиасерверу. Проверьте соединение и попробуйте снова.'), [notify]);
  const onMediaDeviceFailure = useCallback(() => notify('Браузер не дал доступ к устройству. Можно остаться слушателем и включить микрофон позже.'), [notify]);
  if (!room) return <div className="call-content">Подключаемся…</div>;
  return <LiveKitRoom room={room} token={call.token} serverUrl={call.url} connect audio={false} video={false} onDisconnected={onDisconnected} onError={onError} onMediaDeviceFailure={onMediaDeviceFailure}><CallContent room={room} onLeave={onLeave} notify={notify} channelId={call.channel.id} presence={presence} /></LiveKitRoom>;
}
