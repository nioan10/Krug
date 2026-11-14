import { DesktopAudioBuffer } from './desktop-audio-buffer';
import type { DesktopBridge } from './DesktopShare';

let captureOwner: symbol | undefined;
export function acquireDesktopCapture() {
  if (captureOwner) throw new Error('Сначала остановите текущую демонстрацию или предпросмотр.');
  const owner = Symbol(); captureOwner = owner;
  return () => { if (captureOwner === owner) captureOwner = undefined; };
}
export function createDesktopAudio(bridge: DesktopBridge) {
  const context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const node = context.createScriptProcessor(1024, 0, 2);
  const buffer = new DesktopAudioBuffer();
  const unsubscribe = bridge.onAudio(bytes => buffer.push(bytes));
  node.onaudioprocess = event => buffer.pull(event.outputBuffer.getChannelData(0), event.outputBuffer.getChannelData(1));
  node.connect(destination);
  return { context, track: destination.stream.getAudioTracks()[0], close: () => { unsubscribe(); node.disconnect(); destination.stream.getTracks().forEach(t => t.stop()); void context.close(); } };
}
export type WindowCapture = { video: MediaStreamTrack; audio?: MediaStreamTrack; preview: MediaStream; stop: () => Promise<void> };
export async function captureWindow(quality: '720p60' | '1080p60', withAudio: boolean, signal: AbortSignal, onEnded: () => void): Promise<WindowCapture> {
  const bridge = window.krugDesktop;
  if (!bridge) throw new Error('Для трансляции окна со звуком приложения откройте Округ для Windows.');
  const release = acquireDesktopCapture();
  let video: MediaStreamTrack | undefined;
  let audio: ReturnType<typeof createDesktopAudio> | undefined;
  let stopPromise: Promise<void> | undefined;
  let setupFinished = false;
  let removeEnded = () => {};
  const ended = () => { if (!stopPromise) { void stop(); onEnded(); } };
  const stop = () => {
    if (stopPromise) return stopPromise;
    removeEnded(); signal.removeEventListener('abort', abort);
    video?.removeEventListener('ended', ended); video?.stop(); audio?.close();
    stopPromise = bridge.stopAudio().catch(() => {}).finally(() => { if (setupFinished) release(); });
    return stopPromise;
  };
  const abort = () => { void stop(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (withAudio) audio = createDesktopAudio(bridge);
    const streamPromise = navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', width: { ideal: quality === '720p60' ? 1280 : 1920 }, height: { ideal: quality === '720p60' ? 720 : 1080 }, frameRate: { ideal: 60, max: 60 } }, audio: false });
    void audio?.context.resume().catch(() => {});
    const stream = await streamPromise;
    video = stream.getVideoTracks()[0];
    if (signal.aborted || stopPromise) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Cancelled', 'AbortError'); }
    if (!video || video.getSettings().displaySurface !== 'window') throw new Error('Выберите отдельное окно. Рабочий стол и вкладки в публичный эфир не передаются.');
    video.contentHint = 'motion'; video.addEventListener('ended', ended, { once: true });
    removeEnded = bridge.onAudioEnded(ended);
    if (withAudio) {
      const started = await bridge.startAudio();
      if (signal.aborted || stopPromise) { await bridge.stopAudio().catch(() => {}); throw new DOMException('Cancelled', 'AbortError'); }
      if (!started) throw new Error('Звук приложения не выбран. Повторите выбор или включите «Без звука».');
    }
    if (signal.aborted || stopPromise || video.readyState === 'ended') throw new DOMException('Cancelled', 'AbortError');
    return { video, audio: audio?.track, preview: new MediaStream([video, ...(audio ? [audio.track] : [])]), stop };
  } catch (error) { await stop(); throw error; }
  finally { setupFinished = true; if (stopPromise) { await stopPromise; release(); } }
}
