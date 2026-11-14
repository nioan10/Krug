import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { TrackReference } from '@livekit/components-react';
import { Grid2X2, PanelsTopLeft, RectangleHorizontal, Users, MonitorUp, RotateCcw, Eye } from 'lucide-react';
import { ScreenShareTile, type ScreenAudio } from './ScreenShareTile';
import { defaultScreenPreferences, loadScreenPreferences, saveScreenPreferences, reconcileScreenOrder, moveScreen, type ScreenLayout } from './screen-layout';

const views = [
  { id: 'focus', label: 'Фокус', icon: PanelsTopLeft },
  { id: 'grid', label: 'Сетка', icon: Grid2X2 },
  { id: 'single', label: 'Один экран', icon: RectangleHorizontal },
] as const;

export function ScreenShares({ screens, audioFor, notify, children }: {
  screens: TrackReference[]; audioFor: (track: TrackReference) => ScreenAudio;
  notify: (message: string) => void; children: ReactNode;
}) {
  const [preferences, setPreferences] = useState(loadScreenPreferences);
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const signature = JSON.stringify(screens.map(track => track.publication.trackSid));
  useEffect(() => { saveScreenPreferences(preferences); }, [preferences]);
  useEffect(() => {
    const ids: string[] = JSON.parse(signature);
    setOrder(previous => reconcileScreenOrder(previous, ids));
    setHidden(previous => previous.filter(id => ids.includes(id)));
    setSelected(previous => previous && ids.includes(previous) ? previous : null);
  }, [signature]);
  const ordered = reconcileScreenOrder(order, screens.map(track => track.publication.trackSid))
    .map(id => screens.find(track => track.publication.trackSid === id)!);
  const visible = ordered.filter(track => !hidden.includes(track.publication.trackSid));
  const active = visible.find(track => track.publication.trackSid === selected)?.publication.trackSid ?? visible[0]?.publication.trackSid;
  function focus(id: string) {
    setSelected(id);
    setPreferences(previous => ({ ...previous, layout: previous.layout === 'grid' ? 'focus' : previous.layout }));
  }
  function move(id: string, target: string) {
    setOrder(moveScreen(ordered.map(track => track.publication.trackSid), id, target));
  }
  function shift(id: string, direction: number) {
    const index = visible.findIndex(track => track.publication.trackSid === id);
    const neighbor = visible[index + direction];
    if (neighbor) move(id, neighbor.publication.trackSid);
  }
  function reset() { setPreferences({ ...defaultScreenPreferences }); setOrder([]); setSelected(null); setHidden([]); }
  if (!screens.length) return <>{children}</>;
  return <>
    <section className="voice-shares" aria-label="Демонстрации в голосовом канале" style={{
      '--share-width': `${240 + preferences.size * 2.8}px`,
      '--share-height': `${30 + preferences.size * 0.4}dvh`,
      '--share-columns': Math.max(1, Math.min(3, visible.length - 1)),
      '--share-mobile-height': `${30 + preferences.size * 0.525}cqw`,
    } as CSSProperties}>
      <div className="share-toolbar">
        <div className="share-heading"><MonitorUp size={16} /><strong>Демонстрации</strong><span>{screens.length}</span></div>
        <div className="share-layouts" role="group" aria-label="Раскладка демонстраций">{views.map(({ id, label, icon: Icon }) =>
          <button key={id} title={label} aria-label={label} aria-pressed={preferences.layout === id} onClick={() => setPreferences(previous => ({ ...previous, layout: id as ScreenLayout }))}><Icon size={16} /><span>{label}</span></button>,
        )}</div>
        <div className="share-tools">
          <label className="share-size"><span>Размер</span><input type="range" min="0" max="100" step="1" value={preferences.size} aria-label="Размер демонстраций" onChange={event => setPreferences(previous => ({ ...previous, size: Number(event.target.value) }))} /></label>
          <button className="icon-button" title={preferences.people ? 'Скрыть участников' : 'Показать участников'} aria-label={preferences.people ? 'Скрыть участников' : 'Показать участников'} aria-pressed={preferences.people} onClick={() => setPreferences(previous => ({ ...previous, people: !previous.people }))}><Users size={17} /></button>
          <button className="icon-button" title="Сбросить раскладку" aria-label="Сбросить раскладку" onClick={reset}><RotateCcw size={15} /></button>
        </div>
      </div>
      {preferences.layout === 'single' && visible.length > 1 && <div className="share-switcher" role="group" aria-label="Выбрать демонстрацию">{visible.map(track => <button key={track.publication.trackSid} aria-pressed={active === track.publication.trackSid} onClick={() => focus(track.publication.trackSid)}><MonitorUp size={14} />{track.participant.name || 'Участник'}</button>)}</div>}
      <div className={`share-board share-layout-${preferences.layout}`}>
        {ordered.map(track => {
          const id = track.publication.trackSid;
          return <ScreenShareTile key={id} track={track} notify={notify} audio={audioFor(track)}
            layout={{ active: active === id && preferences.layout !== 'grid', hidden: hidden.includes(id) || (preferences.layout === 'single' && id !== active),
              focus: () => focus(id), hide: () => setHidden(previous => [...previous, id]), shift: direction => shift(id, direction),
              first: id === visible[0]?.publication.trackSid, last: id === visible.at(-1)?.publication.trackSid,
              dragging: dragged === id, dropTarget: dropTarget === id,
              dragStart: event => { setDragged(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-krug-screen', id); },
              dragEnd: () => { setDragged(null); setDropTarget(null); },
              dragOver: event => { if (dragged && dragged !== id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id); } },
              drop: event => { event.preventDefault(); if (dragged === event.dataTransfer.getData('application/x-krug-screen')) move(dragged, id); setDragged(null); setDropTarget(null); },
            }} />;
        })}
      </div>
      {hidden.length > 0 && <div className="share-hidden"><span>Скрытые экраны · звук продолжается</span><div>{ordered.filter(track => hidden.includes(track.publication.trackSid)).map(track => <button key={track.publication.trackSid} title="Показать демонстрацию" onClick={() => { setHidden(previous => previous.filter(id => id !== track.publication.trackSid)); setSelected(track.publication.trackSid); }}><Eye size={14} />{track.participant.name || 'Участник'}</button>)}</div></div>}
    </section>
    <div className="share-people" hidden={!preferences.people}>{children}</div>
  </>;
}
