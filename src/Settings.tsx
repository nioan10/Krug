import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Link, Plus, RotateCcw, ShieldCheck, Trash2, UserX, Users } from 'lucide-react';
import { api, errorText, type Channel, type Invite, type Member, type User } from './api';
import { Avatar, Modal } from './ui';

type AccessAction = { kind: 'revoke'; invite: Invite } | { kind: 'disable' | 'delete'; member: Member };
export function InviteModal({ onClose, notify }: { onClose: () => void; notify: (s: string) => void }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [tab, setTab] = useState<'invites' | 'members'>('members');
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [action, setAction] = useState<AccessAction | null>(null);
  const [confirmation, setConfirmation] = useState('');
  async function load() {
    try { const [invitations, people] = await Promise.all([api<{ invites: Invite[] }>('/invites'), api<{ members: Member[] }>('/members')]); setInvites(invitations.invites); setMembers(people.members); }
    catch (e) { notify(errorText(e)); }
  }
  useEffect(() => { void load(); }, []);
  async function create() {
    setBusy(true);
    try { const result = await api<{ id: string; url: string }>('/invites', 'POST'); setLink(result); setCopied(false); await load(); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function copy() { if (!link) return; try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { notify('Выделите и скопируйте ссылку вручную.'); } }
  async function restore(person: Member) {
    setBusy(true);
    try { await api(`/members/${person.id}/access`, 'PATCH', { enabled: true }); await load(); notify(`Доступ для ${person.displayName} восстановлен.`); }
    catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function applyAction() {
    if (!action || busy) return;
    setBusy(true);
    try {
      const result = action.kind === 'revoke' ? await api<{ disconnected: boolean; accountUnknown?: boolean }>(`/invites/${action.invite.id}`, 'DELETE') : action.kind === 'disable' ? await api<{ disconnected: boolean }>(`/members/${action.member.id}/access`, 'PATCH', { enabled: false }) : await api<{ disconnected: boolean }>(`/members/${action.member.id}`, 'DELETE', { confirmation });
      if (action.kind === 'revoke' && link?.id === action.invite.id) setLink(null);
      setAction(null); setConfirmation(''); await load();
      notify(!result.disconnected ? 'Доступ закрыт. Отключение от медиасервера будет повторено.' : action.kind === 'delete' ? 'Аккаунт удалён, сообщения обезличены.' : action.kind === 'disable' ? 'Доступ участника отключён.' : 'Приглашение отозвано.');
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return <Modal title="Управление доступом" onClose={onClose}>
    <div className="access-tabs" role="tablist" aria-label="Управление доступом"><button type="button" role="tab" aria-selected={tab === 'members'} onClick={() => { setTab('members'); setAction(null); }}><Users size={16} />Участники <span>{members.length}</span></button><button type="button" role="tab" aria-selected={tab === 'invites'} onClick={() => { setTab('invites'); setAction(null); }}><Link size={16} />Приглашения</button></div>
    {action && <div className="access-confirm" role="group" aria-label="Подтверждение действия"><strong>{action.kind === 'revoke' ? 'Отозвать приглашение?' : action.kind === 'disable' ? 'Отключить участника?' : 'Удалить аккаунт?'}</strong><p>{action.kind === 'revoke' ? action.invite.usedByName ? `Доступ ${action.invite.usedByName} будет отключён, а открытые сеансы завершатся. Вернуть доступ можно во вкладке «Участники».` : action.invite.usedAt ? 'Приглашение старое: связь с аккаунтом не сохранилась. Чтобы отключить человека, выберите его во вкладке «Участники».' : 'По этой ссылке больше нельзя будет зарегистрироваться.' : action.kind === 'disable' ? `Для ${action.member.displayName} будут закрыты сеансы и доступ к серверу. Позже доступ можно восстановить.` : `Аккаунт @${action.member.username} будет удалён. Его сообщения и картинки останутся в истории без имени автора. Резервные копии сохранятся.`}</p>{action.kind === 'delete' && <label>Введите логин @{action.member.username}<input autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}<div className="access-confirm-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { setAction(null); setConfirmation(''); }}>Отмена</button><button type="button" className="danger" disabled={busy || (action.kind === 'delete' && confirmation !== action.member.username)} onClick={() => void applyAction()}>{busy ? 'Выполняем…' : action.kind === 'delete' ? 'Удалить аккаунт' : action.kind === 'disable' ? 'Отключить доступ' : 'Отозвать'}</button></div></div>}
    {tab === 'members' ? <div className="access-list"><p className="muted">Управляйте доступом зарегистрированных участников. Отключённый участник сможет вернуться только после восстановления доступа.</p>{members.map(person => <div className="access-row" key={person.id}><Avatar name={person.displayName} /><div className="access-person"><strong>{person.displayName}</strong><small>@{person.username} · {person.role === 'admin' ? 'Владелец' : person.disabledAt ? 'Доступ отключён' : 'Доступ открыт'}</small></div>{person.role === 'member' && <div className="access-row-actions">{person.disabledAt ? <button type="button" className="icon-button" disabled={busy} aria-label={`Восстановить доступ ${person.displayName}`} title="Восстановить доступ" onClick={() => void restore(person)}><RotateCcw size={16} /></button> : <button type="button" className="icon-button" disabled={busy} aria-label={`Отключить доступ ${person.displayName}`} title="Отключить доступ" onClick={() => { setAction({ kind: 'disable', member: person }); setConfirmation(''); }}><UserX size={16} /></button>}<button type="button" className="icon-button access-delete" disabled={busy} aria-label={`Удалить аккаунт ${person.displayName}`} title="Удалить аккаунт" onClick={() => { setAction({ kind: 'delete', member: person }); setConfirmation(''); }}><Trash2 size={16} /></button></div>}</div>)}</div> : <div className="access-list"><p className="muted">Одно приглашение — один человек. Ссылка действует 7 дней. При отзыве использованной ссылки доступ связанного участника отключится.</p><button className="primary" onClick={() => void create()} disabled={busy}><Plus size={18} />{busy ? 'Создаём…' : 'Создать приглашение'}</button>{link && <div className="invite-link"><label>Сохраните ссылку — она показывается один раз<input value={link.url} readOnly onFocus={e => e.currentTarget.select()} /></label><button className="secondary" onClick={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Скопировано' : 'Скопировать'}</button></div>}<div className="invite-list"><h3>Приглашения</h3>{invites.length === 0 && <p className="muted">Приглашений пока нет.</p>}{invites.map((invite, i) => <div className="invite-row" key={invite.id}><Link size={16} /><div><strong>{invite.usedByName ? `${invite.usedByName} · @${invite.usedByUsername}` : `Приглашение ${invites.length - i}`}</strong><small>{invite.revokedAt ? 'Отозвано' : invite.usedAt ? 'Использовано' : invite.expiresAt < Date.now() ? 'Истекло' : `До ${new Date(invite.expiresAt).toLocaleDateString('ru')}`}{invite.usedAt && !invite.usedBy ? ' · связь с участником не сохранилась' : ''}{invite.usedBy && invite.usedByDisabledAt ? ' · доступ отключён' : ''}</small></div>{!invite.revokedAt && <button className="icon-button access-delete" disabled={busy} aria-label="Отозвать приглашение" title="Отозвать приглашение" onClick={() => setAction({ kind: 'revoke', invite })}><Trash2 size={16} /></button>}</div>)}</div></div>}
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
