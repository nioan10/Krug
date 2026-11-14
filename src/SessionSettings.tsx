import { useEffect, useState } from 'react';
import { api, errorText } from './api';
type Session = { id: string; label: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: number };
export function SessionSettings({ notify, onLogout }: { notify: (s: string) => void; onLogout: () => void }) {
  const [items, setItems] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() { try { setItems((await api<{ sessions: Session[] }>('/sessions')).sessions); setError(''); } catch (e) { setError(errorText(e)); } }
  useEffect(() => { void load(); }, []);
  async function revoke(id: string, current = false) {
    setBusy(true);
    try {
      const result = await api<{ disconnected: boolean }>(`/sessions/${id}`, 'DELETE');
      if (current) onLogout(); else await load();
      notify(result.disconnected ? 'Сессия завершена.' : 'Сессия закрыта. Отключение звонка повторится автоматически.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <section className="form-stack session-settings"><h3>Устройства и сессии</h3><p className="tiny">Завершение сессии закрывает доступ к чату и отключает её звонок. Название устройства сообщает его браузер.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {items.map(item => <div className="session-row" key={item.id}><div><strong>{item.current ? 'Это устройство' : 'Другое устройство'}</strong><small>{item.label}</small><small>Последняя активность: {new Date(item.lastSeenAt).toLocaleString('ru')}</small><small>Вход: {new Date(item.createdAt).toLocaleString('ru')}</small></div><button type="button" className="secondary" disabled={busy} onClick={() => void revoke(item.id, Boolean(item.current))}>Выйти</button></div>)}
    <button type="button" className="secondary" disabled={busy || !items.some(item => !item.current)} onClick={() => void revoke('others')}>Завершить остальные сессии</button>
  </section>;
}
