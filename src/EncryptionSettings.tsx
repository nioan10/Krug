import { createContext, useContext, useEffect, useState } from 'react';
import { api, errorText, type Channel, type User } from './api';
import { EncryptionManager, initializeEncryption } from './encryption';
import { subscribe } from './events';

type EncryptionView = { manager?: EncryptionManager; error: string; revision: number };
export const EncryptionContext = createContext<EncryptionView>({ error: '', revision: 0 });
export const useEncryption = () => useContext(EncryptionContext);
export function useEncryptionController(user: User | null): EncryptionView {
  const [view, setView] = useState<EncryptionView>({ error: '', revision: 0 });
  useEffect(() => {
    setView({ error: '', revision: 0 });
    if (!user) return;
    let cancelled = false; let manager: EncryptionManager | undefined;
    const changed = () => { if (!cancelled) setView(old => ({ manager, error: '', revision: old.revision + 1 })); };
    const refresh = async () => {
      if (!manager || cancelled) return;
      try { await manager.refresh(); if (!cancelled) setView(old => old.error ? { ...old, error: '' } : old); }
      catch (e) { if (!cancelled) setView(old => ({ ...old, error: errorText(e) })); }
    };
    void initializeEncryption(user).then(value => { if (cancelled) return; manager = value; manager.addEventListener('change', changed); changed(); }).catch(e => { if (!cancelled) setView({ error: errorText(e), revision: 0 }); });
    const off = subscribe(event => { if (event.type === 'history-keys') manager?.historyChanged(); if (event.type === 'encryption-changed' || event.type === 'ready') void refresh(); });
    const timer = setInterval(() => { void refresh(); void manager?.shareHistory(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); off(); manager?.removeEventListener('change', changed); };
  }, [user?.id]);
  return view;
}
export function EncryptionSettings({ user, channel, notify }: { user: User; channel?: Channel; notify: (s: string) => void }) {
  const { manager, error, revision } = useEncryption();
  const [busy, setBusy] = useState(false), [input, setInput] = useState<Record<string, string>>({}), [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null), [confirm, setConfirm] = useState(''), [progress, setProgress] = useState<number | null>(null);
  const [backupText, setBackupText] = useState(''), [restoreText, setRestoreText] = useState('');
  const [legacy, setLegacy] = useState<number | null>(null);
  useEffect(() => { if (!channel || user.role !== 'admin') return; let cancelled = false; void api<{ count: number }>(`/channels/${channel.id}/encryption-status`).then(v => { if (!cancelled) setLegacy(v.count); }).catch(() => {}); return () => { cancelled = true; }; }, [channel?.id, revision, progress]);
  async function action(work: () => Promise<void>) { setBusy(true); try { await work(); } catch (e) { notify(errorText(e)); } finally { setBusy(false); } }
  function download(text: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/pgp-encrypted' })); const a = document.createElement('a'); a.href = url; a.download = `krug-keys-${user.username}-${new Date().toISOString().slice(0, 10)}.asc`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section className="form-stack encryption-settings"><h3>Сквозное шифрование</h3>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!manager ? <p className="muted">{error ? 'Шифрование недоступно. Отправка защищённых сообщений и подключение к защищённым звонкам остановлены.' : 'Подготавливаем ключ этого устройства…'}</p> : <>
      <p>{manager.state.enabled ? 'Новые сообщения, изображения и приватные звонки шифруются на устройствах.' : 'Владелец ещё не включил шифрование. Сообщения и звонки пока доступны серверу.'}</p>
      {!manager.state.enabled && user.role === 'admin' && <><p className="tiny">После включения всем участникам потребуется обновить клиент и подтвердить ключи устройств. Текущие звонки будут завершены. Старую историю можно зашифровать отдельно.</p><button type="button" className="primary" disabled={busy || Boolean(error)} onClick={() => void action(async () => { await manager.enable(); notify('Сквозное шифрование включено. Подтвердите ключи участников.'); })}>Включить сквозное шифрование</button></>}
      <p className="tiny">Ваш отпечаток. Передайте его друзьям через другой доверенный канал для сверки.</p><input readOnly value={manager.current.device.fingerprint.toUpperCase()} onFocus={e => e.currentTarget.select()} aria-label="Отпечаток моего ключа" />
      <h4>Ключи устройств</h4><p className="tiny">Новый ключ не получает ваши новые сообщения до подтверждения. Сверьте полный отпечаток непосредственно с владельцем устройства. Не подтверждайте неизвестные устройства.</p>
      {manager.state.devices.map(d => <div className="encryption-device" key={d.id}><strong>{d.name} · {d.label}{d.current ? ' · это устройство' : ''}</strong><code>{d.fingerprint.toUpperCase()}</code>{manager.trusted(d) ? <small>Ключ подтверждён на этом устройстве</small> : <div className="form-stack"><input aria-label={`Отпечаток ${d.name}`} placeholder="Вставьте отпечаток, полученный от владельца" value={input[d.id] || ''} onChange={e => setInput(old => ({ ...old, [d.id]: e.target.value }))} /><button className="secondary" type="button" disabled={busy || !input[d.id]} onClick={() => void action(async () => { await manager.trust(d.id, input[d.id]); notify('Ключ подтверждён.'); })}>Подтвердить совпадение</button></div>}</div>)}
      <p className="tiny">После подтверждения нового устройства ему передаются ключи всей доступной истории. Передано этим устройством: {manager.historyShared}.</p><button type="button" className="secondary" disabled={busy || !manager.state.enabled || Boolean(manager.pending.length)} onClick={() => void action(async () => { await manager.shareHistory(true); notify('Повторная передача доступных ключей истории завершена.'); })}>Повторить передачу истории</button><h4>Резервная копия ключей</h4><p className="tiny">Сохраняет доступ к вашей истории после очистки приложения или на другом устройстве. Копия шифруется отдельным паролем. Сервер не сможет восстановить её за вас. Обновляйте копию после нового входа.</p>
      <label>Отдельный пароль резервной копии<input type="password" autoComplete="new-password" value={password} minLength={16} onChange={e => setPassword(e.target.value)} placeholder="Не менее 16 символов" /></label>
      <button type="button" className="secondary" disabled={busy || password.length < 16} onClick={() => void action(async () => { const text = await manager.backup(password); setBackupText(text); download(text); setPassword(''); })}>Скачать зашифрованную копию ключей</button>
      {backupText && <label>Зашифрованная копия текстом — можно сохранить, если скачивание недоступно<textarea readOnly rows={4} value={backupText} onFocus={e => e.currentTarget.select()} /></label>}
      <label>Импортировать ранее сохранённую копию<input type="file" accept=".asc" onChange={e => setFile(e.target.files?.[0] || null)} /></label><label>Или вставьте текст зашифрованной копии<textarea rows={3} value={restoreText} onChange={e => setRestoreText(e.target.value.slice(0, 2_000_000))} autoComplete="off" spellCheck={false} /></label><button type="button" className="secondary" disabled={busy || (!file && !restoreText) || !password} onClick={() => void action(async () => { if (file && file.size > 2_000_000) throw Error('Некорректный файл копии.'); await manager.restore(file ? await file.text() : restoreText, password); setPassword(''); setRestoreText(''); notify('Ключи истории восстановлены. Новый ключ устройства нужно подтвердить у собеседников.'); })}>Восстановить ключи истории</button>
      {manager.state.enabled && user.role === 'admin' && channel && <><h4>Старая история «{channel.name}»</h4><p className="tiny">Незашифрованных сообщений: {legacy ?? '…'}. История останется бессрочной. Содержимое будет зашифровано для текущих подтверждённых устройств. Старые резервные копии и следы SQLite это действие не стирает.</p><label>Для шифрования старой истории введите название канала<input value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" /></label><button type="button" className="secondary" disabled={busy || confirm !== channel.name || legacy === 0} onClick={() => void action(async () => { setProgress(0); const count = await manager.migrate(channel.id, setProgress); setConfirm(''); notify(`Зашифровано сообщений: ${count}.`); })}>Зашифровать старую историю</button>{progress !== null && <small>Обработано: {progress}</small>}</>}
      <p className="tiny">Публичные эфиры по ссылке остаются публичными. Код веб-клиента загружается с сервера: защита от его подмены требует отдельной поставки и проверки подписи приложения.</p>
    </>}
  </section>;
}
