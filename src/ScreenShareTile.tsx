import { useCallback, useEffect, useRef, useState } from 'react';
import { VideoTrack, type TrackReference } from '@livekit/components-react';
import { Maximize2, Minimize2, MonitorUp, Volume2, VolumeX } from 'lucide-react';
import { VolumeSlider } from './AudioControls';
import { Modal } from './ui';
import './screen-shares.css';

export type ScreenAudio = { available: boolean; volume: number; deafened: boolean; onVolume: (value: number) => void };
export function ScreenShareTile({ track, notify, audio }: { track: TrackReference; notify: (message: string) => void; audio: ScreenAudio }) {
  const tile = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [changingFullscreen, setChangingFullscreen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const closeAudio = useCallback(() => setAudioOpen(false), []);
  const lastVolume = useRef(1);
  if (audio.volume > 0) lastVolume.current = audio.volume;
  const canListen = audio.available && !track.participant.isLocal;
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === tile.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  async function toggleFullscreen() {
    if (changingFullscreen || !tile.current) return;
    setChangingFullscreen(true);
    try {
      if (document.fullscreenElement === tile.current) await document.exitFullscreen();
      else await tile.current.requestFullscreen();
    } catch { notify('Не удалось переключить полноэкранный режим.'); }
    finally { setChangingFullscreen(false); }
  }
  return <div className="screen-tile" ref={tile}>
    <VideoTrack trackRef={track} />
    <div className="screen-caption"><MonitorUp size={15} /><span className="screen-name">Экран · {track.participant.name}</span>
      <button className="screen-audio" title="Звук демонстрации" aria-label={`Звук демонстрации: ${track.participant.name}`} onClick={() => setAudioOpen(true)}>
          {audio.volume === 0 || !canListen ? <VolumeX size={16} /> : <Volume2 size={16} />}<span>{canListen ? `${Math.round(audio.volume * 1000) / 10}%` : '—'}</span>
      </button>
      <button className="icon-button" title={fullscreen ? 'Свернуть экран' : 'На весь экран'} aria-label={fullscreen ? 'Свернуть экран' : 'На весь экран'} aria-pressed={fullscreen} disabled={changingFullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </div>
    {audioOpen && <Modal title={`Звук экрана · ${track.participant.name || 'Участник'}`} onClose={closeAudio}>
        <div className="screen-audio-panel form-stack">
          {canListen ? <>
            <VolumeSlider label="Звук демонстрации" value={audio.volume} onChange={audio.onVolume} />
            <div className="screen-audio-actions"><button onClick={() => audio.onVolume(audio.volume === 0 ? lastVolume.current : 0)}>{audio.volume === 0 ? 'Включить звук' : 'Без звука'}</button><button onClick={() => audio.onVolume(1)}>Сбросить</button></div>
            <p>{audio.deafened ? 'Входящий звук выключен. Включите его в панели звонка.' : 'Только для вас. Громкость голоса не меняется.'}</p>
          </> : <p>{track.participant.isLocal ? 'Вы не слышите свою демонстрацию, чтобы не было эха.' : 'Автор не передаёт звук демонстрации.'}</p>}
        </div>
    </Modal>}
  </div>;
}
