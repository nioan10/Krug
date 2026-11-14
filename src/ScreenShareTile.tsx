import { useEffect, useRef, useState } from 'react';
import { VideoTrack, type TrackReference } from '@livekit/components-react';
import { Maximize2, Minimize2, MonitorUp } from 'lucide-react';

export function ScreenShareTile({ track, notify }: { track: TrackReference; notify: (message: string) => void }) {
  const tile = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [changingFullscreen, setChangingFullscreen] = useState(false);
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
    <div className="screen-caption"><MonitorUp size={15} /><span>Экран · {track.participant.name}</span>
      <button className="icon-button" title={fullscreen ? 'Свернуть экран' : 'На весь экран'} aria-label={fullscreen ? 'Свернуть экран' : 'На весь экран'} aria-pressed={fullscreen} disabled={changingFullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </div>
  </div>;
}
