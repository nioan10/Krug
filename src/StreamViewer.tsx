import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { Radio, Play, Volume2, VolumeX, Maximize2, Users, Copy, ArrowUpRight } from 'lucide-react';
import { StreamChat } from './StreamChat';
import { streamApi, type StreamInfo } from './stream-api';
import { errorText } from './api';

export function StreamViewer() {
  const id = /^\/s\/([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1];
  const [stream, setStream] = useState<StreamInfo>(), [error, setError] = useState('');
  const [guestReady, setGuestReady] = useState(false);
  const [watch, setWatch] = useState(false), [hasVideo, setHasVideo] = useState(false), [connecting, setConnecting] = useState(false), [audioBlocked, setAudioBlocked] = useState(false);
  const [volume, setVolume] = useState(0.8), [muted, setMuted] = useState(false), [copied, setCopied] = useState(false);
  const video = useRef<HTMLVideoElement>(null), audio = useRef<HTMLDivElement>(null), player = useRef<HTMLDivElement>(null), roomRef = useRef<Room | undefined>(undefined);
  const sound = useRef({ volume, muted }); sound.current = { volume, muted };
  useEffect(() => { if (stream?.state === 'ended') { setWatch(false); setError(''); } }, [stream?.state]);
  useEffect(() => {
    if (!id) return; let stopped = false;
    void fetch(`/api/streams/${id}`).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.message || 'Эфир не найден.'); if (!stopped) { setStream(result.stream); document.title = `${result.stream.title} · Округ`; } }).catch(e => { if (!stopped) setError(errorText(e)); });
    return () => { stopped = true; };
  }, [id]);
  useEffect(() => {
    if (!id || !watch || stream?.state !== 'live') return;
    let stopped = false;
    const room = new Room({ adaptiveStream: true, dynacast: true }); roomRef.current = room;
    const attached = new Map<RemoteTrack, HTMLMediaElement[]>();
    const detach = (track: RemoteTrack) => { for (const element of attached.get(track) ?? []) { track.detach(element); if (element.tagName === 'AUDIO') element.remove(); } attached.delete(track); if (track.source === Track.Source.ScreenShare) setHasVideo(false); };
    room.on(RoomEvent.TrackSubscribed, track => {
      if (track.source === Track.Source.ScreenShare && video.current) { track.attach(video.current); attached.set(track, [video.current]); setHasVideo(true); }
      else if (track.source === Track.Source.ScreenShareAudio && audio.current) { const element = track.attach(); element.volume = sound.current.volume; element.muted = sound.current.muted; audio.current.append(element); attached.set(track, [element]); }
    });
    room.on(RoomEvent.TrackUnsubscribed, detach);
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => setConnecting(true));
    room.on(RoomEvent.Reconnected, () => setConnecting(false));
    room.on(RoomEvent.Disconnected, () => { if (!stopped) { setWatch(false); setHasVideo(false); setError('Соединение с эфиром прервалось. Нажмите «Смотреть эфир», чтобы подключиться снова.'); } });
    setConnecting(true); setError('');
    void streamApi<{ token: string; url: string }>(location.origin, id, '/token').then(async access => {
      if (stopped) return; await room.connect(access.url, access.token, { autoSubscribe: true });
      if (stopped) { await room.disconnect(); return; } setConnecting(false);
      await room.startAudio().catch(() => setAudioBlocked(true));
    }).catch(e => { if (!stopped) { setError(errorText(e)); setWatch(false); setConnecting(false); } });
    return () => { stopped = true; for (const track of attached.keys()) detach(track); room.removeAllListeners(); void room.disconnect(); if (roomRef.current === room) roomRef.current = undefined; setHasVideo(false); };
  }, [id, watch, stream?.state]);
  useEffect(() => { for (const element of audio.current?.querySelectorAll('audio') ?? []) { element.volume = volume; element.muted = muted; } }, [volume, muted]);
  async function copy() { try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { setError('Скопируйте адрес эфира из адресной строки.'); } }
  async function fullscreen() {
    try {
      if (player.current?.requestFullscreen) await player.current.requestFullscreen();
      else {
        const mobileVideo = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        if (mobileVideo?.webkitEnterFullscreen) mobileVideo.webkitEnterFullscreen();
        else throw new Error('Fullscreen unavailable');
      }
    } catch { setError('Полный экран недоступен в этом браузере.'); }
  }
  if (!id) return <main className="stream-landing"><div className="stream-wordmark"><Radio size={24} />Округ <span>/ эфиры</span></div><h1>Прямые эфиры</h1><p>Откройте ссылку, которую прислал автор трансляции.</p><p className="muted">Для просмотра и чата аккаунт не нужен.</p></main>;
  if (!stream) return <main className="stream-landing"><Radio size={32} /><h1>{error || 'Открываем эфир…'}</h1><button className="secondary" onClick={() => location.reload()}>Повторить</button></main>;
  return <main className="stream-page">
    <header className="stream-page-header"><a href="/" className="stream-wordmark"><Radio size={23} />Округ <span>/ эфиры</span></a><span className="stream-public-note"><ArrowUpRight size={14} />Доступ по ссылке</span></header>
    <div className="broadcast-layout public-broadcast"><section className="broadcast-main">
      <div className="stream-player" ref={player}><video ref={video} autoPlay playsInline muted aria-label="Видео трансляции" /><div ref={audio} hidden />
        {(!watch || !hasVideo || connecting || stream.state !== 'live' || !stream.publishing) && <div className="stream-player-cover"><Radio size={38} /><h2>{stream.state === 'ended' ? 'Эфир завершён' : stream.state === 'starting' ? 'Автор готовится к эфиру' : connecting ? 'Подключаемся…' : watch ? 'Ждём изображение от автора' : 'Эфир идёт'}</h2>{stream.state === 'live' && !watch && <button className="primary" disabled={!guestReady} onClick={() => setWatch(true)}><Play size={18} />Смотреть эфир</button>}</div>}
        {audioBlocked && watch && <button className="stream-enable-audio primary" onClick={() => void roomRef.current?.startAudio().then(() => setAudioBlocked(false)).catch(() => setError('Браузер пока не разрешил звук. Повторите нажатие.'))}><Volume2 size={17} />Включить звук</button>}
        <div className="stream-player-controls"><button className="icon-button" aria-label={muted ? 'Включить звук' : 'Выключить звук'} onClick={() => setMuted(!muted)}>{muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}</button><input aria-label="Громкость эфира" type="range" min="0" max="1" step="0.01" value={volume} onChange={e => setVolume(Number(e.target.value))} /><span>{stream.quality === '720p60' ? '720p · 60 FPS' : '1080p · 60 FPS'}</span><button className="icon-button" aria-label="На весь экран" onClick={() => void fullscreen()}><Maximize2 size={20} /></button></div>
      </div>
      <div className="stream-details"><div><span className={`stream-status ${stream.state === 'live' ? 'live' : ''}`}><i />{stream.state === 'live' ? 'В ЭФИРЕ' : stream.state === 'starting' ? 'СКОРО НАЧАЛО' : 'ЗАВЕРШЁН'}</span><h1>{stream.title}</h1></div><div className="stream-detail-actions"><span><Users size={17} />{stream.viewers}</span><button className="secondary" onClick={() => void copy()}><Copy size={15} />{copied ? 'Скопировано' : 'Поделиться'}</button></div></div>
      {error && <p role="alert" className="stream-error">{error}</p>}
      <p className="stream-viewer-note">В чате — только случайные ID. Микрофон и камера зрителей не используются.</p>
    </section><StreamChat origin={location.origin} id={id} onStream={setStream} onReady={setGuestReady} /></div>
  </main>;
}
