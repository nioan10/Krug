import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Logo({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-mark" aria-hidden="true" />{!small && <span>круг<span className="brand-period">.</span></span>}</div>;
}
export function Avatar({ name, size = '' }: { name: string; size?: string }) {
  const color = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  return <span className={`avatar color-${color} ${size}`} aria-hidden="true">{name.trim().slice(0, 2).toUpperCase()}</span>;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="modal" aria-label={title} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={20} /></button></div>{children}
  </dialog>;
}
