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
    const changed = () => { if (!cancelled) setView(old => ({ ...old, manager, revision: old.revision + 1 })); };
    const refresh = async () => {
      if (!manager || cancelled) return;
      try { await manager.refresh(); if (!cancelled) setView(old => old.error ? { ...old, error: '' } : old); void manager.maintainHistory(); }
      catch (e) { if (!cancelled) setView(old => ({ ...old, error: errorText(e) })); }
    };
    void initializeEncryption(user).then(value => { if (cancelled) return; manager = value; manager.addEventListener('change', changed); changed(); }).catch(e => { if (!cancelled) setView({ error: errorText(e), revision: 0 }); });
    const off = subscribe(event => { if (event.type === 'history-keys') manager?.historyChanged(); if (event.type === 'encryption-changed' || event.type === 'ready') void refresh(); });
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); off(); manager?.removeEventListener('change', changed); };
  }, [user?.id]);
  return view;
}
export function EncryptionSettings({ user, channel, notify }: { user: User; channel?: Channel; notify: (s: string) => void }) {
  const { manager, error, revision } = useEncryption();
  const [busy, setBusy] = useState(false), [input, setInput] = useState<Record<string, string>>({}), [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null), [confirm, setConfirm] = useState(''), [progress, setProgress] = useState<number | null>(null);
  const [backupText, setBackupText] = useState(''), [restoreText, setRestoreText] = useState('');
  const [legacy, setLegacy] = useState<number | null>(null);
  useEffect(() => { if (!channel || user.role !== 'admin' || manager?.state.automatic) return; let cancelled = false; void api<{ count: number }>(`/channels/${channel.id}/encryption-status`).then(v => { if (!cancelled) setLegacy(v.count); }).catch(() => {}); return () => { cancelled = true; }; }, [channel?.id, revision, progress]);
  async function action(work: () => Promise<void>) { setBusy(true); try { await work(); } catch (e) { notify(errorText(e)); } finally { setBusy(false); } }
  function download(text: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/pgp-encrypted' })); const a = document.createElement('a'); a.href = url; a.download = `krug-keys-${user.username}-${new Date().toISOString().slice(0, 10)}.asc`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section className="form-stack encryption-settings"><h3>Сквозное шифрование</h3>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!manager ? <p className="muted">{error ? 'Шифрование недоступно. Отправка защищённых сообщений и подключение к защищённым звонкам остановлены.' : 'Подготавливаем ключ этого устройства…'}</p> : <>
      <p>{manager.state.enabled ? 'Новые сообщения, изображения и приватные звонки шифруются автоматически на устройствах.' : 'На сервере используется прежний режим. Новые сообщения и звонки пока доступны серверу.'}</p>
      <p className="tiny">Новые ключи принимаются автоматически и запоминаются на этом устройстве. При первом получении доверяем серверу; замена уже сохранённого ключа остановит отправку. Ручная сверка — дополнительная проверка.</p>
      {!manager.state.enabled && user.role === 'admin' && <><p className="tiny">После включения всем участникам потребуется обновить клиент. Текущие звонки будут завершены.</p><button type="button" className="primary" disabled={busy || Boolean(error)} onClick={() => void action(async () => { await manager.enable(); notify('Сквозное шифрование включено.'); })}>Включить сквозное шифрование</button></>}
      <details className="encryption-verification"><summary>Сверить ключи вручную (необязательно)</summary><div className="form-stack">
      <p className="tiny">Ваш отпечаток. Передайте его друзьям через другой доверенный канал для сверки.</p><input readOnly value={manager.current.device.fingerprint.toUpperCase()} onFocus={e => e.currentTarget.select()} aria-label="Отпечаток моего ключа" />
      <h4>Ключи устройств</h4><p className="tiny">Для дополнительной проверки сверьте полный отпечаток непосредственно с владельцем через другой доверенный канал.</p>
      {manager.state.devices.map(d => <div className="encryption-device" key={d.id}><strong>{d.name} · {d.label}{d.current ? ' · это устройство' : ''}</strong><code>{d.fingerprint.toUpperCase()}</code>{manager.verified(d) ? <small>{d.current ? 'Ключ этого устройства' : 'Отпечаток сверен вручную'}</small> : <div className="form-stack"><small>Принят автоматически при первом получении</small><input aria-label={`Отпечаток ${d.name}`} placeholder="Вставьте отпечаток, полученный от владельца" value={input[d.id] || ''} onChange={e => setInput(old => ({ ...old, [d.id]: e.target.value }))} /><button className="secondary" type="button" disabled={busy || !input[d.id]} onClick={() => void action(async () => { await manager.trust(d.id, input[d.id]); notify('Отпечаток сверен.'); })}>Подтвердить совпадение</button></div>}</div>)}
      </div></details>
      {manager.state.automatic && user.role === 'admin' && <section className="form-stack"><h4>Шифрование старой истории</h4><p className="tiny">Все каналы обрабатываются автоматически, пока приложение открыто у владельца. История и изображения сохраняются без срока удаления. Старые резервные копии это действие не стирает.</p><p className="tiny" role="status">{manager.historyMigration.remaining === null ? 'Проверяем старые записи…' : manager.historyMigration.remaining === 0 ? 'В сохранённой истории нет открытых сообщений.' : `Осталось открытых сообщений: ${manager.historyMigration.remaining}. Зашифровано этим устройством: ${manager.historyMigration.processed}.`}</p>{manager.historyMigration.error && <><p className="form-error" role="alert">{manager.historyMigration.error} Перенос продолжится при следующей проверке.</p><button type="button" className="secondary" disabled={busy || manager.historyMigration.running} onClick={() => void action(() => manager.maintainHistory())}>Повторить перенос</button></>}</section>}
      <p className="tiny">Новым устройствам автоматически передаются ключи всей доступной истории. Передано этим устройством: {manager.historyShared}.</p><button type="button" className="secondary" disabled={busy || !manager.state.enabled || Boolean(manager.pending.length) || manager.historyMigration.running} onClick={() => void action(async () => { await manager.shareHistory(true); notify('Повторная передача доступных ключей истории завершена.'); })}>Повторить передачу истории</button><h4>Резервная копия ключей</h4><p className="tiny">Сохраняет доступ к вашей истории после очистки приложения или на другом устройстве. Копия шифруется отдельным паролем. Сервер не сможет восстановить её за вас. Обновляйте копию после нового входа.</p>
      <label>Отдельный пароль резервной копии<input type="password" autoComplete="new-password" value={password} minLength={16} onChange={e => setPassword(e.target.value)} placeholder="Не менее 16 символов" /></label>
      <button type="button" className="secondary" disabled={busy || password.length < 16} onClick={() => void action(async () => { const text = await manager.backup(password); setBackupText(text); download(text); setPassword(''); })}>Скачать зашифрованную копию ключей</button>
      {backupText && <label>Зашифрованная копия текстом — можно сохранить, если скачивание недоступно<textarea readOnly rows={4} value={backupText} onFocus={e => e.currentTarget.select()} /></label>}
      <label>Импортировать ранее сохранённую копию<input type="file" accept=".asc" onChange={e => setFile(e.target.files?.[0] || null)} /></label><label>Или вставьте текст зашифрованной копии<textarea rows={3} value={restoreText} onChange={e => setRestoreText(e.target.value.slice(0, 2_000_000))} autoComplete="off" spellCheck={false} /></label><button type="button" className="secondary" disabled={busy || (!file && !restoreText) || !password} onClick={() => void action(async () => { if (file && file.size > 2_000_000) throw Error('Некорректный файл копии.'); await manager.restore(file ? await file.text() : restoreText, password); setPassword(''); setRestoreText(''); notify('Ключи истории восстановлены.'); })}>Восстановить ключи истории</button>
      {!manager.state.automatic && manager.state.enabled && user.role === 'admin' && channel && <><h4>Старая история «{channel.name}»</h4><p className="tiny">Незашифрованных сообщений: {legacy ?? '…'}. История останется бессрочной. Старые резервные копии и следы SQLite это действие не стирает.</p><label>Для шифрования старой истории введите название канала<input value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" /></label><button type="button" className="secondary" disabled={busy || confirm !== channel.name || legacy === 0} onClick={() => void action(async () => { setProgress(0); const count = await manager.migrate(channel.id, setProgress); setConfirm(''); notify(`Зашифровано сообщений: ${count}.`); })}>Зашифровать старую историю</button>{progress !== null && <small>Обработано: {progress}</small>}</>}
      <p className="tiny">Публичные эфиры по ссылке остаются публичными. Код веб-клиента загружается с сервера: защита от его подмены требует отдельной поставки и проверки подписи приложения.</p>
    </>}
  </section>;
}
