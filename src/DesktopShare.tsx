import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { MonitorUp } from 'lucide-react';
import { DesktopAudioBuffer } from './desktop-audio-buffer';

type DesktopBridge = {
  startAudio(): Promise<boolean>;
  stopAudio(): Promise<void>;
  onAudio(callback: (data: Uint8Array) => void): () => void;
  onAudioEnded(callback: () => void): () => void;
};
declare global { interface Window { krugDesktop?: DesktopBridge } }

// Bounded buffer: a slow renderer drops old samples instead of building latency.
function createAudio(bridge: DesktopBridge) {
  const context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const node = context.createScriptProcessor(1024, 0, 2);
  const buffer = new DesktopAudioBuffer();
  const unsubscribe = bridge.onAudio(bytes => buffer.push(bytes));
  node.onaudioprocess = event => {
    const l = event.outputBuffer.getChannelData(0), r = event.outputBuffer.getChannelData(1);
    buffer.pull(l, r);
  };
  node.connect(destination);
  return { context, track: destination.stream.getAudioTracks()[0], close: () => { unsubscribe(); node.disconnect(); destination.stream.getTracks().forEach(t => t.stop()); void context.close(); } };
}

export function DesktopShare({ notify }: { notify: (message: string) => void }) {
  const room = useRoomContext();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => { active.current = true; return () => { active.current = false; cleanup.current(); }; }, []);

  async function toggle() {
    if (busy) return;
    if (sharing) { cleanup.current(); setSharing(false); return; }
    const bridge = window.krugDesktop;
    if (!bridge) return;
    setBusy(true);
    let video: MediaStreamTrack | undefined;
    let audio: ReturnType<typeof createAudio> | undefined;
    let removeEnded = () => {};
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true; removeEnded(); void bridge.stopAudio().catch(() => {});
      if (video) { void room.localParticipant.unpublishTrack(video, true).catch(() => {}); video.stop(); }
      if (audio) { void room.localParticipant.unpublishTrack(audio.track, true).catch(() => {}); audio.close(); }
      if (active.current) setSharing(false);
    };
    cleanup.current = stop;
    try {
      audio = createAudio(bridge);
      // Request the picker synchronously in the click handler while user activation is present.
      const streamPromise = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      void audio.context.resume().catch(() => {});
      const stream = await streamPromise;
      video = stream.getVideoTracks()[0];
      if (!video || stopped || !active.current) { stream.getTracks().forEach(t => t.stop()); stop(); return; }
      video.addEventListener('ended', stop, { once: true });
      await room.localParticipant.publishTrack(video, { source: Track.Source.ScreenShare });
      if (stopped || !active.current) { await room.localParticipant.unpublishTrack(video, true); return; }
      removeEnded = bridge.onAudioEnded(() => { notify('Приложение завершилось или его звук недоступен. Демонстрация остановлена.'); stop(); });
      const hasAudio = await bridge.startAudio();
      if (stopped || !active.current) { await bridge.stopAudio(); return; }
      if (hasAudio) {
        await room.localParticipant.publishTrack(audio.track, { source: Track.Source.ScreenShareAudio, dtx: false });
        if (stopped || !active.current) { await room.localParticipant.unpublishTrack(audio.track, true); return; }
      } else { audio.close(); audio = undefined; }
      if (stopped || !active.current) { stop(); return; }
      setSharing(true);
    } catch (error) {
      stop();
      if (active.current && !(error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name))) notify('Не удалось начать демонстрацию или захват звука приложения. Попробуйте ещё раз.');
    } finally { if (active.current) setBusy(false); }
  }
  return <button disabled={busy} data-lk-enabled={sharing} aria-label="Демонстрация экрана" title="Демонстрация экрана" onClick={() => void toggle()}><MonitorUp size={21} /><span>{sharing ? 'Остановить' : 'Поделиться'}</span></button>;
}
