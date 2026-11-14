import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { VideoTrack, type TrackReference } from '@livekit/components-react';
import { ArrowLeft, ArrowRight, GripVertical, Maximize2, Minimize2, Minus, MonitorUp, Pin, Volume2, VolumeX } from 'lucide-react';
import { VolumeSlider } from './AudioControls';
import { Modal } from './ui';
import './screen-shares.css';

export type ScreenAudio = { available: boolean; volume: number; deafened: boolean; onVolume: (value: number) => void };
type TileLayout = {
  active: boolean; hidden: boolean; first: boolean; last: boolean; dragging: boolean; dropTarget: boolean;
  focus: () => void; hide: () => void; shift: (direction: number) => void;
  dragStart: (event: DragEvent) => void; dragEnd: () => void; dragOver: (event: DragEvent) => void; drop: (event: DragEvent) => void;
};
export function ScreenShareTile({ track, notify, audio, layout }: { track: TrackReference; notify: (message: string) => void; audio: ScreenAudio; layout?: TileLayout }) {
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
  return <div className={`screen-tile ${layout?.active ? 'is-main' : ''} ${layout?.dragging ? 'is-dragging' : ''} ${layout?.dropTarget ? 'is-drop-target' : ''}`} ref={tile} hidden={layout?.hidden} onDragOver={layout?.dragOver} onDrop={layout?.drop} data-screen-id={track.publication.trackSid}>
    <div className="screen-titlebar">
      {layout && <button className="icon-button screen-grip screen-layout-action" draggable onDragStart={layout.dragStart} onDragEnd={layout.dragEnd} aria-label={`Переместить экран: ${track.participant.name}. Используйте стрелки влево и вправо`} title="Перетащить экран · клавиши ← / →" onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); layout.shift(event.key === 'ArrowLeft' ? -1 : 1); } }}><GripVertical size={15} /></button>}
      <MonitorUp size={14} /><span className="screen-name">{track.participant.name || 'Участник'}{track.participant.isLocal && <small> · ваш экран</small>}</span>
      {layout && <div className="screen-order screen-layout-action"><button className="icon-button" title="Переместить левее" aria-label="Переместить левее" disabled={layout.first} onClick={() => layout.shift(-1)}><ArrowLeft size={14} /></button><button className="icon-button" title="Переместить правее" aria-label="Переместить правее" disabled={layout.last} onClick={() => layout.shift(1)}><ArrowRight size={14} /></button></div>}
    </div>
    <VideoTrack trackRef={track} onDoubleClick={() => void toggleFullscreen()} />
    <div className="screen-caption">
      <button className="screen-audio" title="Звук демонстрации" aria-label={`Звук демонстрации: ${track.participant.name}`} onClick={() => setAudioOpen(true)}>
          {audio.volume === 0 || !canListen ? <VolumeX size={16} /> : <Volume2 size={16} />}<span>{canListen ? `${Math.round(audio.volume * 1000) / 10}%` : '—'}</span>
      </button>
      {layout && <div className="screen-layout-buttons screen-layout-action"><button className="icon-button" title="Сделать главным экраном" aria-label={`Главный экран: ${track.participant.name}`} aria-pressed={layout.active} onClick={layout.focus}><Pin size={16} /></button><button className="icon-button" title="Скрыть экран у себя" aria-label={`Скрыть экран: ${track.participant.name}`} onClick={layout.hide}><Minus size={16} /></button></div>}
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
