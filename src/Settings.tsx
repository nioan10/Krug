import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Link, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errorText, type Channel, type Invite, type User } from './api';
import { Modal } from './ui';

export function InviteModal({ onClose, notify }: { onClose: () => void; notify: (s: string) => void }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function load() { try { setInvites((await api<{ invites: Invite[] }>('/invites')).invites); } catch (e) { notify(errorText(e)); } }
  useEffect(() => { void load(); }, []);
  async function create() {
    setBusy(true);
    try { const result = await api<{ url: string }>('/invites', 'POST'); setLink(result.url); setCopied(false); await load(); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { notify('Выделите и скопируйте ссылку вручную.'); } }
  async function revoke(id: string) { try { await api(`/invites/${id}`, 'DELETE'); await load(); setLink(''); } catch (e) { notify(errorText(e)); } }
  return <Modal title="Приглашения" onClose={onClose}><p className="muted modal-intro">Одно приглашение — один человек. Ссылка действует 7 дней. После регистрации участник входит по своему паролю.</p>
    <button className="primary" onClick={() => void create()} disabled={busy}><Plus size={18} />{busy ? 'Создаём…' : 'Создать приглашение'}</button>
    {link && <div className="invite-link"><label>Сохраните ссылку — она показывается один раз<input value={link} readOnly onFocus={e => e.currentTarget.select()} /></label><button className="secondary" onClick={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Скопировано' : 'Скопировать'}</button></div>}
    <div className="invite-list"><h3>Последние приглашения</h3>{invites.length === 0 && <p className="muted">Приглашений пока нет.</p>}{invites.map((invite, i) => <div className="invite-row" key={invite.id}><Link size={16} /><div><strong>Приглашение {invites.length - i}</strong><small>{invite.usedAt ? 'Использовано' : invite.expiresAt < Date.now() ? 'Истекло' : `До ${new Date(invite.expiresAt).toLocaleDateString('ru')}`}</small></div>{!invite.usedAt && <button className="icon-button" aria-label="Отозвать приглашение" title="Отозвать" onClick={() => void revoke(invite.id)}><Trash2 size={16} /></button>}</div>)}</div>
  </Modal>;
}
export function CreateChannel({ onClose, notify, onCreated }: { onClose: () => void; notify: (s: string) => void; onCreated: (c: Channel) => void }) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try { const { channel } = await api<{ channel: Channel }>('/channels', 'POST', Object.fromEntries(new FormData(event.currentTarget))); onCreated(channel); onClose(); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return <Modal title="Создать канал" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Название<input name="name" required maxLength={32} autoFocus placeholder="Например, Кино по пятницам" /></label><label>Тип<select name="kind"><option value="voice">Голосовая комната</option><option value="text">Текстовый канал</option></select></label><label>Описание<input name="description" maxLength={120} placeholder="Описание канала" /></label><button className="primary" disabled={busy}>{busy ? 'Создаём…' : 'Создать канал'}</button></form></Modal>;
}
export function Settings({ user, channel, onClose, notify, onLogout, onDeleted }: { user: User; channel?: Channel; onClose: () => void; notify: (s: string) => void; onLogout: () => void; onDeleted: (channels: Channel[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  async function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try { await api('/auth/password', 'POST', Object.fromEntries(new FormData(event.currentTarget))); onLogout(); notify('Пароль обновлён. Войдите заново.'); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function clear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel) return; setBusy(true);
    try { await api(`/channels/${channel.id}/messages`, 'DELETE', Object.fromEntries(new FormData(event.currentTarget))); notify('История канала удалена.'); onClose(); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function removeChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!channel) return; setBusy(true);
    try { const result = await api<{ channels: Channel[] }>(`/channels/${channel.id}`, 'DELETE', Object.fromEntries(new FormData(event.currentTarget))); onDeleted(result.channels); notify(`Канал «${channel.name}» удалён.`); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return <Modal title="Настройки" onClose={onClose}><div className="settings-identity"><ShieldCheck size={21} /><div><strong>{user.displayName}</strong><span>@{user.username} · {user.role === 'admin' ? 'Владелец' : 'Участник'}</span></div></div>
    <form className="form-stack" onSubmit={password}><h3>Сменить пароль</h3><label>Текущий пароль<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label><label>Новый пароль<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} placeholder="Не менее 12 символов" /></label><p className="tiny">После смены пароля потребуется заново войти на всех устройствах.</p><button className="secondary" disabled={busy}>Обновить пароль</button></form>
    <div className="security-note"><h3>Как устроена приватность</h3><p>На сервере используется шифрование соединений. Сквозного шифрования пока нет: владельцу сервера доступны история и медиатрафик. Запись звонков не ведётся.</p><p>История чата хранится бессрочно. Удалить свои сообщения можно в чате; владелец может очистить канал целиком.</p></div>
    {user.role === 'admin' && channel && <div className="danger-zone"><h3>Канал «{channel.name}»</h3>{deleting ? <form className="form-stack" onSubmit={removeChannel}><p>Канал и все его сообщения будут удалены. {channel.kind === 'voice' && 'Участники будут отключены от звонка. '}Резервные копии сохранятся.</p><label>Для подтверждения введите: {channel.name}<input name="confirmation" required autoComplete="off" /></label><button className="danger" disabled={busy}>{busy ? 'Удаляем…' : 'Удалить канал и сообщения'}</button><button className="secondary" type="button" disabled={busy} onClick={() => setDeleting(false)}>Отмена</button></form> : confirming ? <form className="form-stack" onSubmit={clear}><p>Все сообщения этого канала будут удалены без возможности восстановления из приложения. Резервные копии это действие не затрагивает.</p><label>Для подтверждения введите: {channel.name}<input name="confirmation" required autoComplete="off" /></label><button className="danger" disabled={busy}>Удалить всю историю канала</button><button className="secondary" type="button" disabled={busy} onClick={() => setConfirming(false)}>Отмена</button></form> : <div className="form-stack"><button className="danger-text" onClick={() => setConfirming(true)}><Trash2 size={16} />Очистить историю канала</button><button className="danger-text" onClick={() => setDeleting(true)}><Trash2 size={16} />Удалить канал</button></div>}</div>}
  </Modal>;
}
