import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ImagePlus, RotateCcw, Smile } from 'lucide-react';
import { api, errorText, type AvatarStyle, type User } from './api';
import { useAvatars } from './avatars';
import { Avatar } from './ui';

export function AvatarSettings({ user, notify }: { user: User; notify: (message: string) => void }) {
  const { avatars, setAvatar } = useAvatars();
  const current = avatars[user.id];
  const [mode, setMode] = useState<'image' | 'text'>(current?.kind === 'text' ? 'text' : 'image');
  const [face, setFace] = useState(current?.kind === 'text' ? current.text : ':)');
  const [rotation, setRotation] = useState(current?.kind === 'text' ? current.rotation : 90);
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState('');
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const drag = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  useEffect(() => () => { selection.current++; }, []);
  useEffect(() => {
    if (!source) { setCrop(''); return; }
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const side = Math.min(source.naturalWidth, source.naturalHeight) / zoom;
    const left = (source.naturalWidth - side) * x / 100, top = (source.naturalHeight - side) * y / 100;
    ctx.drawImage(source, left, top, side, side, 0, 0, 256, 256);
    setCrop(canvas.toDataURL('image/png'));
  }, [source, zoom, x, y]);
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 12 * 1024 * 1024) { setStatus('Выберите картинку PNG, JPEG, WebP или GIF до 12 МБ.'); return; }
    const serial = ++selection.current, url = URL.createObjectURL(file), image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); if (serial !== selection.current) return; setZoom(1); setX(50); setY(50); setSource(image); };
    image.onerror = () => { URL.revokeObjectURL(url); if (serial === selection.current) setStatus('Не удалось открыть картинку.'); };
    image.src = url;
  }
  async function save(kind: 'default' | 'image' | 'text') {
    setBusy(true); setStatus('');
    try {
      const payload = kind === 'image' ? { kind, image: crop.split(',')[1] } : kind === 'text' ? { kind, text: face.trim(), rotation } : { kind };
      const result = await api<{ avatar: AvatarStyle | null }>('/me/avatar', 'PUT', payload);
      setAvatar(user.id, result.avatar); setStatus(kind === 'default' ? 'Исходная аватарка возвращена.' : 'Аватарка обновлена.');
    } catch (error) { setStatus(errorText(error)); } finally { setBusy(false); }
  }
  return <section className="avatar-settings"><div className="avatar-settings-heading"><Avatar name={user.displayName} userId={user.id} size="large" /><div><h3>Аватарка</h3><p>Выбери картинку или придумай своё настроение.</p></div></div>
    <div className="avatar-tabs" role="tablist" aria-label="Вид аватарки"><button type="button" role="tab" aria-selected={mode === 'image'} onClick={() => setMode('image')}><ImagePlus size={16} /> Картинка</button><button type="button" role="tab" aria-selected={mode === 'text'} onClick={() => setMode('text')}><Smile size={16} /> Смайлик</button></div>
    {mode === 'image' ? <div className="avatar-editor"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={choose} /><button type="button" className="secondary avatar-choose" onClick={() => fileInput.current?.click()}><ImagePlus size={16} />{source ? 'Выбрать другую картинку' : 'Выбрать картинку'}</button>{crop && <><div className="avatar-crop-preview" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { startX: event.clientX, startY: event.clientY, x, y }; }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onPointerMove={event => { if (!drag.current || !source) return; const side = Math.min(source.naturalWidth, source.naturalHeight) / zoom; const length = event.currentTarget.clientWidth; const dx = source.naturalWidth - side, dy = source.naturalHeight - side; if (dx) setX(Math.max(0, Math.min(100, drag.current.x - (event.clientX - drag.current.startX) / length * side / dx * 100))); if (dy) setY(Math.max(0, Math.min(100, drag.current.y - (event.clientY - drag.current.startY) / length * side / dy * 100))); }}><img src={crop} alt="Выбранная область аватарки" draggable={false} /></div><p className="tiny">Перетащи картинку, чтобы выбрать область, или настрой её ползунками.</p><label>Приближение <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label><label>Горизонталь <input type="range" min="0" max="100" value={x} onChange={e => setX(Number(e.target.value))} /></label><label>Вертикаль <input type="range" min="0" max="100" value={y} onChange={e => setY(Number(e.target.value))} /></label><button type="button" className="primary" disabled={busy} onClick={() => void save('image')}>Сохранить картинку</button></>}</div> : <div className="avatar-editor"><div className="avatar-face-preview"><span style={{ transform: `rotate(${rotation}deg)`, fontSize: `${Math.min(52, 180 / Math.max(2, face.length))}px` }}>{face || ':)'}</span></div><label>Текст смайлика<input value={face} maxLength={12} onChange={e => setFace(e.target.value)} placeholder=":)" /></label><label>Поворот <small>{rotation}°</small><input type="range" min="-180" max="180" step="1" value={rotation} onChange={e => setRotation(Number(e.target.value))} /></label><div className="avatar-angles">{[-90, 0, 90, 180].map(angle => <button type="button" key={angle} aria-pressed={rotation === angle} onClick={() => setRotation(angle)}>{angle}°</button>)}</div><button type="button" className="primary" disabled={busy || !face.trim()} onClick={() => void save('text')}>Сохранить смайлик</button></div>}
    {status && <p className="avatar-save-status" role="status">{status}</p>}
    {current && <button type="button" className="avatar-reset" disabled={busy} onClick={() => void save('default')}><RotateCcw size={15} /> Вернуть исходную аватарку</button>}
  </section>;
}
