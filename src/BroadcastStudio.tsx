import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { Radio, MonitorUp, Copy, Square, Eye, Users, RefreshCw } from 'lucide-react';
import { api, errorText } from './api';
import { captureWindow, type WindowCapture } from './desktop-capture';
import { StreamChat } from './StreamChat';
import type { StreamInfo } from './stream-api';
import './streams.css';

type OwnStream = StreamInfo & { url: string };
type Phase = 'idle' | 'choosing' | 'preview' | 'connecting' | 'live' | 'stopping';
export function BroadcastStudio({ origin, onActive, notify }: { origin: string; onActive: (active: boolean) => void; notify: (message: string) => void }) {
  const [title, setTitle] = useState('Вечерний эфир'), [quality, setQuality] = useState<'720p60' | '1080p60'>('720p60'), [silent, setSilent] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle'), [capture, setCapture] = useState<WindowCapture>(), [stream, setStream] = useState<OwnStream>(), [orphan, setOrphan] = useState<OwnStream>();
  const [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const video = useRef<HTMLVideoElement>(null), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const currentCapture = useRef<WindowCapture | undefined>(undefined), currentRoom = useRef<Room | undefined>(undefined), currentStream = useRef<OwnStream | undefined>(undefined), heartbeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined), stopping = useRef<Promise<void> | undefined>(undefined);
  const stop = useCallback(() => {
    if (stopping.current) return stopping.current;
    controller.current?.abort(); clearInterval(heartbeat.current);
    const captured = currentCapture.current, room = currentRoom.current, activeStream = currentStream.current;
    currentCapture.current = undefined; currentRoom.current = undefined; currentStream.current = undefined;
    if (mounted.current) setPhase('stopping');
    stopping.current = (async () => {
      await captured?.stop(); await room?.disconnect().catch(() => {});
      if (activeStream) {
        try { await api(`/broadcasts/${activeStream.id}/end`, 'POST'); }
        catch { if (mounted.current) setError('Передача остановлена. Сервер закроет эфир после восстановления связи или в течение минуты.'); }
      }
      if (mounted.current) { setCapture(undefined); setPhase('idle'); if (activeStream) setStream({ ...activeStream, state: 'ended', publishing: false, viewers: 0 }); }
    })().finally(() => { stopping.current = undefined; });
    return stopping.current;
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void stop(); onActive(false); }; }, [stop, onActive]);
  useEffect(() => { onActive(phase !== 'idle'); }, [phase, onActive]);
  useEffect(() => {
    let cancelled = false;
    void api<{ streams: OwnStream[] }>('/broadcasts').then(result => { if (!cancelled) setOrphan(result.streams.find(s => s.state !== 'ended')); }).catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (video.current) { video.current.srcObject = capture?.preview ?? null; if (capture) void video.current.play().catch(() => {}); } }, [capture]);
  async function preview() {
    if (phase !== 'idle') return;
    setError(''); setCopied(false); setPhase('choosing'); const operation = new AbortController(); controller.current = operation;
    try {
      const result = await captureWindow(quality, !silent, operation.signal, () => { notify('Захват окна завершён. Эфир остановлен.'); void stop(); });
      if (!mounted.current || operation.signal.aborted) { await result.stop(); return; }
      currentCapture.current = result; setCapture(result); setPhase('preview');
    } catch (e) { if (mounted.current && controller.current === operation) { setPhase('idle'); if (!(e instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(e.name))) setError(errorText(e)); } }
  }
  async function goLive() {
    const source = currentCapture.current; if (phase !== 'preview' || !source) return;
    const signal = controller.current!.signal;
    setPhase('connecting'); setError('');
    try {
      const result = await api<{ stream: OwnStream; token: string; url: string }>('/broadcasts', 'POST', { title: title.trim(), quality });
      if (!mounted.current || signal.aborted) { await api(`/broadcasts/${result.stream.id}/end`, 'POST'); return; }
      currentStream.current = result.stream; setStream(result.stream);
      const room = new Room({ adaptiveStream: false, dynacast: true, disconnectOnPageLeave: true }); currentRoom.current = room;
      room.on(RoomEvent.Disconnected, () => { if (currentRoom.current === room) { setError('Соединение со стрим-сервером потеряно. Запустите эфир снова.'); void stop(); } });
      await room.connect(result.url, result.token, { autoSubscribe: false });
      if (currentRoom.current !== room || signal.aborted) { await room.disconnect(); return; }
      await room.localParticipant.publishTrack(source.video, { source: Track.Source.ScreenShare, simulcast: false, videoCodec: 'h264', screenShareEncoding: { maxBitrate: quality === '720p60' ? 4_000_000 : 8_000_000, maxFramerate: 60 }, degradationPreference: 'maintain-framerate' });
      if (currentRoom.current !== room || signal.aborted) return;
      if (source.audio) await room.localParticipant.publishTrack(source.audio, { source: Track.Source.ScreenShareAudio, dtx: false, forceStereo: true, audioPreset: { maxBitrate: 128_000 } });
      if (currentRoom.current !== room || signal.aborted) return;
      const live = await api<{ stream: OwnStream }>(`/broadcasts/${result.stream.id}/live`, 'POST');
      if (currentRoom.current !== room || signal.aborted) return;
      currentStream.current = live.stream; setStream(live.stream); setPhase('live');
      let failures = 0, pending = false;
      heartbeat.current = setInterval(() => {
        if (pending) return; pending = true;
        void api(`/broadcasts/${result.stream.id}/heartbeat`, 'POST').then(() => { failures = 0; }).catch(() => { if (++failures >= 3) { setError('Нет связи с сервером. Передача остановлена.'); void stop(); } }).finally(() => { pending = false; });
      }, 12_000);
    } catch (e) { if (signal.aborted) return; if (mounted.current) setError(errorText(e)); await stop(); }
  }
  async function endOrphan() { if (!orphan) return; try { await api(`/broadcasts/${orphan.id}/end`, 'POST'); setOrphan(undefined); setError(''); } catch (e) { setError(errorText(e)); } }
  async function copy() { if (!stream) return; try { await navigator.clipboard.writeText(stream.url); setCopied(true); } catch { setError('Выделите и скопируйте ссылку из поля ниже.'); } }
  return <div className="broadcast-layout studio-layout"><section className="broadcast-main">
    <div className="studio-heading"><div><span className="eyebrow">ПРЯМОЙ ЭФИР</span><h2>Транслировать</h2></div><span className={`stream-status ${phase === 'live' ? 'live' : ''}`}><i />{phase === 'live' ? 'В ЭФИРЕ' : phase === 'preview' ? 'ПРЕДПРОСМОТР' : 'НЕ В ЭФИРЕ'}</span></div>
    <div className="stream-player studio-preview"><video ref={video} autoPlay playsInline muted aria-label="Предпросмотр выбранного окна" />{!capture && <div className="stream-player-cover"><MonitorUp size={42} /><h3>{phase === 'choosing' ? 'Выберите окно и его звук' : 'Выберите окно для трансляции'}</h3><p>В эфир попадёт выбранное окно и звук приложения.<br />Микрофон и разговор в Округе не передаются.</p></div>}{phase === 'preview' && <span className="preview-badge"><Eye size={14} />Видно только вам</span>}</div>
    {error && <p className="stream-error" role="alert">{error}</p>}
    {!window.krugDesktop && <div className="studio-desktop-note"><strong>Запускайте эфир из Округа для Windows</strong><p>В приложении доступен отдельный захват звука игры.</p><a className="secondary" href="/api/desktop-installer" download>Скачать приложение</a></div>}
    {orphan && <div className="studio-desktop-note"><strong>У вас остался активный эфир «{orphan.title}»</strong><p>Завершите его перед запуском нового.</p><button className="secondary" onClick={() => void endOrphan()}>Завершить предыдущий эфир</button></div>}
    <div className="studio-settings"><label>Название эфира<input maxLength={100} value={title} disabled={phase === 'live' || phase === 'connecting'} onChange={e => setTitle(e.target.value)} /></label><label>Качество<select value={quality} disabled={phase !== 'idle'} onChange={e => setQuality(e.target.value as typeof quality)}><option value="720p60">720p · 60 FPS · 4 Мбит/с</option><option value="1080p60">1080p · 60 FPS · 8 Мбит/с</option></select></label><label className="studio-checkbox"><input type="checkbox" checked={silent} disabled={phase !== 'idle'} onChange={e => setSilent(e.target.checked)} />Без звука</label></div>
    <div className="studio-actions">{phase === 'idle' ? <button className="primary" disabled={!window.krugDesktop || Boolean(orphan)} onClick={() => void preview()}><MonitorUp size={18} />Выбрать окно</button> : <>{phase === 'preview' && <button className="primary" disabled={!title.trim()} onClick={() => void goLive()}><Radio size={18} />Начать эфир</button>}<button className={phase === 'live' ? 'stream-stop' : 'secondary'} disabled={phase === 'stopping'} onClick={() => void stop()}>{phase === 'connecting' || phase === 'stopping' ? <RefreshCw size={17} /> : <Square size={16} />}{phase === 'live' ? 'Завершить эфир' : phase === 'stopping' ? 'Останавливаем…' : 'Отменить'}</button></>}</div>
    {stream && <div className="stream-share-card"><div><strong>Ссылка на эфир</strong><span><Users size={15} />{stream.viewers} зрителей</span></div><p>Отправьте её друзьям. Они смогут смотреть и писать без аккаунта.</p><div className="stream-share-input"><input aria-label="Ссылка на эфир" value={stream.url} readOnly onFocus={e => e.currentTarget.select()} /><button className="secondary" onClick={() => void copy()}><Copy size={16} />{copied ? 'Скопировано' : 'Скопировать'}</button></div>{stream.state === 'ended' && <small>Этот эфир завершён. Новому эфиру будет выдана новая ссылка.</small>}</div>}
    <p className="studio-footnote">Сначала проверьте предпросмотр. Для звука выберите то же приложение в системном окне выбора. Во время эфира можно продолжать разговор в Округе.</p>
  </section>{stream ? <StreamChat key={stream.id} origin={origin} id={stream.id} moderator onStream={data => { setStream(previous => previous?.id === data.id ? { ...data, url: previous.url } : previous); if (data.state === 'ended' && currentStream.current?.id === data.id) { notify('Эфир завершён на сервере.'); void stop(); } }} /> : <aside className="stream-chat studio-chat-placeholder"><MessagePlaceholder /></aside>}</div>;
}
function MessagePlaceholder() { return <><Radio size={30} /><h3>Чат появится после запуска</h3><p>У всех участников будут случайные ID — в том числе у вас.</p></>; }
