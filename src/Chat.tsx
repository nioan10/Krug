import { useEncryption } from './EncryptionSettings';
import { EncryptedImage } from './EncryptedImage';
import { base64ToBytes, type SecretPayload } from './e2ee-crypto';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Hash, ImagePlus, MessageCircle, Smile, Trash2, X } from 'lucide-react';
import { api, errorText, type Channel, type Message, type User } from './api';
import { subscribe, type ServerEvent } from './events';
import { Avatar, Modal } from './ui';
import { isTrustedService, splitLinks } from './chat-links';
import { isEmojiOnly } from './emoji-only';

const emojiGroups = [
  { name: 'Эмоции', items: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 🙂 🙃 😉 😍 🥰 😘 😎 🤔 🫡 🤗 🤩 😏 😴 😭 🥲 😢 😤 😡 🥳 😇 🤯 😳 🫠'.split(' ') },
  { name: 'Жесты', items: '👍 👎 👏 🙌 🤝 🫶 👋 🤙 ✌️ 🤞 👌 🤌 🤟 🤘 💪 🙏 🫂 👀 💀 🔥 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 ✨ 🎉'.split(' ') },
  { name: 'Разное', items: '🐱 🐶 🐼 🦊 🐸 🐻 🐧 🐙 🌸 🌈 ☀️ 🌙 ⭐ ⚡ 🍕 🍔 🍟 🍿 🍰 ☕ 🍵 🎮 🎲 🎧 🎵 🎬 🚀 💻 💡 ✅ ❌ ❓'.split(' ') },
];

function applyEvent(messages: Message[], event: ServerEvent, id: string): Message[] {
  if (event.type === 'message' && event.message.channelId === id) return [...messages.filter(m => m.id !== event.message.id), event.message].sort((a, b) => a.id - b.id);
  if (event.type === 'message-deleted' && event.channelId === id) return messages.filter(m => m.id !== event.id);
  if (event.type === 'history-cleared' && event.channelId === id) return [];
  return messages;
}
export function Chat({ channel, user, compact = false, notify }: { channel: Channel; user: User; compact?: boolean; notify: (s: string) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const { manager, error: encryptionError, revision } = useEncryption();
  const [decoded, setDecoded] = useState<Record<number, { payload?: SecretPayload; error?: string }>>({});
  useEffect(() => {
    let stopped = false;
    if (!manager) return;
    void Promise.all(messages.filter(m => m.encrypted).map(async message => {
      try { return [message.id, { payload: await manager.decryptMessage(message) }] as const; }
      catch (e) { return [message.id, { error: errorText(e) }] as const; }
    })).then(values => { if (!stopped) setDecoded(Object.fromEntries(values)); });
    return () => { stopped = true; };
  }, [messages, manager, revision]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [openedImage, setOpenedImage] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!imageFile) { setImagePreview(null); return; }
    const url = URL.createObjectURL(imageFile); setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);
  function attachImage(file: File | undefined) {
    if (!file || busy) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { notify('Поддерживаются PNG, JPEG, GIF и WebP.'); return; }
    if (!file.size || file.size > 5 * 1024 * 1024) { notify('Размер изображения не должен превышать 5 МБ.'); return; }
    setImageFile(file);
  }
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  function openLink(href: string) {
    if (!isTrustedService(new URL(href), location.origin)) { setExternalUrl(href); return; }
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  function renderMessage(body: string) {
    return splitLinks(body).map((part, index) => part.href ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openLink(part.href!); }} onAuxClick={event => { event.preventDefault(); openLink(part.href!); }}>{part.text}</a> : <span key={index}>{part.text.split(/((?:^|[^\p{L}\p{N}_@])@[a-z0-9_]{3,24}(?![a-z0-9_]))/giu).map((segment, i) => { const match = segment.match(/^([^@]*)@([a-z0-9_]+)$/i); return match && people.some(person => person.username === match[2].toLowerCase()) ? <span key={i}>{match[1]}<span className={`message-mention ${match[2].toLowerCase() === user.username ? 'own-mention' : ''}`}>@{match[2]}</span></span> : segment; })}</span>);
  }
  const [people, setPeople] = useState<User[]>([]);
  const [caret, setCaret] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiGroup, setEmojiGroup] = useState(0);
  const emojiContainer = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!emojiOpen) return;
    const outside = (event: PointerEvent) => { if (!emojiContainer.current?.contains(event.target as Node)) setEmojiOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setEmojiOpen(false); input.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [emojiOpen]);
  function insertEmoji(emoji: string) {
    const start = input.current?.selectionStart ?? draft.length;
    const end = input.current?.selectionEnd ?? start;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    if (next.length > 4000) return;
    setDraft(next); setCaret(start + emoji.length); setMentionClosed(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + emoji.length, start + emoji.length); });
  }
  const mention = !mentionClosed && draft.slice(0, caret).match(/(?:^|[\s(])@([^\s@]*)$/u);
  const suggestions = mention ? people.filter(person => person.id !== user.id && (person.username.includes(mention[1].toLowerCase()) || person.displayName.toLowerCase().includes(mention[1].toLowerCase()))).slice(0, 8) : [];
  useEffect(() => { let live = true; const load = () => { void api<{ users: User[] }>('/users').then(result => { if (live) setPeople(result.users); }).catch(() => {}); }; load(); const off = subscribe(event => { if (event.type === 'members-updated') load(); }); return () => { live = false; off(); }; }, []);
  function chooseMention(person: User) {
    if (!mention) return;
    const start = caret - mention[1].length - 1;
    const insertion = `@${person.username} `;
    setDraft(draft.slice(0, start) + insertion + draft.slice(caret));
    setMentionClosed(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + insertion.length, start + insertion.length); setCaret(start + insertion.length); });
  }
  const [error, setError] = useState('');
  const [newBelow, setNewBelow] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pending = useRef<ServerEvent[] | null>(null);
  const requestId = useRef(0);
  const acknowledged = useRef(0);
  const lastReadAttempt = useRef(0);
  async function refresh() {
    const current = ++requestId.current;
    pending.current = []; setError('');
    try {
      const result = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${channel.id}/messages`);
      if (current !== requestId.current) return;
      setMessages((pending.current || []).reduce((all, e) => applyEvent(all, e, channel.id), result.messages));
      pending.current = null; setHasMore(result.hasMore);
    } catch (e) { if (current === requestId.current) { pending.current = null; setError(errorText(e)); } }
    finally { if (current === requestId.current) setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    const off = subscribe(event => {
      if (event.type === 'ready' || event.type === 'members-updated') { void refresh(); return; }
      pending.current?.push(event);
      setMessages(old => applyEvent(old, event, channel.id));
      if (event.type === 'message' && event.message.channelId === channel.id && !stick.current) setNewBelow(true);
      if (event.type === 'history-cleared' && event.channelId === channel.id) setHasMore(false);
    });
    return () => { requestId.current++; off(); };
  }, [channel.id]);
  useEffect(() => {
    if (stick.current) { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); setNewBelow(false); }
  }, [messages]);
  const latestMessageId = messages.at(-1)?.id ?? 0;
  useEffect(() => {
    const element = scroll.current;
    if (!element || loading || error || !latestMessageId) return;
    let stopped = false; let pendingRead = false;
    function markVisibleMessages() {
      if (stopped || pendingRead || latestMessageId <= acknowledged.current || Date.now() - lastReadAttempt.current < 1000 || document.visibilityState !== 'visible' || document.querySelector('dialog[open]') || !element!.clientHeight) return;
      // Reading older history, a hidden voice chat or a background tab must not clear the marker.
      if (!stick.current || element!.scrollHeight - element!.scrollTop - element!.clientHeight > 4) return;
      pendingRead = true;
      lastReadAttempt.current = Date.now();
      void api(`/channels/${channel.id}/read`, 'POST', { messageId: latestMessageId })
        .then(() => { acknowledged.current = Math.max(acknowledged.current, latestMessageId); })
        .catch(() => { /* Retry after reconnect without hiding unread messages locally. */ })
        .finally(() => { pendingRead = false; });
    }
    markVisibleMessages();
    element.addEventListener('scroll', markVisibleMessages);
    document.addEventListener('visibilitychange', markVisibleMessages);
    window.addEventListener('focus', markVisibleMessages);
    const retry = setInterval(markVisibleMessages, 2000);
    return () => { stopped = true; clearInterval(retry); element.removeEventListener('scroll', markVisibleMessages); document.removeEventListener('visibilitychange', markVisibleMessages); window.removeEventListener('focus', markVisibleMessages); };
  }, [channel.id, latestMessageId, loading, error]);
  async function older() {
    if (!messages[0] || loading) return;
    setLoading(true); const height = scroll.current?.scrollHeight || 0; const top = scroll.current?.scrollTop || 0;
    try {
      const result = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${channel.id}/messages?before=${messages[0].id}`);
      stick.current = false;
      setMessages(old => [...new Map([...result.messages, ...old].map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id));
      setHasMore(result.hasMore);
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = top + scroll.current.scrollHeight - height; });
    } catch (e) { notify(errorText(e)); } finally { setLoading(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); const body = draft.trim(); if ((!body && !imageFile) || busy) return;
    setBusy(true);
    try {
      const image = imageFile ? await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Не удалось прочитать изображение.')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(imageFile); }) : undefined;
      if (!manager) throw Error(encryptionError || 'Подготавливаем ключи. Повторите отправку через несколько секунд.');
      await manager.refresh();
      const data = manager.state.enabled ? await manager.encryptMessage(channel.id, body, image && imageFile ? { bytes: base64ToBytes(image), mime: imageFile.type } : undefined) : { body, image };
      const result = await api<{ message: Message }>(`/channels/${channel.id}/messages`, 'POST', data);
      stick.current = true;
      setMessages(old => applyEvent(old, { type: 'message', message: result.message }, channel.id));
      setDraft('');
      setImageFile(null);
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    if (!confirm('Удалить это сообщение?')) return;
    try { await api(`/messages/${id}`, 'DELETE'); setMessages(old => old.filter(m => m.id !== id)); }
    catch (e) { notify(errorText(e)); }
  }
  return <section className={`chat ${compact ? 'compact-chat' : ''}`} aria-label={`Чат ${channel.name}`}>
    {compact && <div className="chat-heading"><MessageCircle size={17} /><strong>Чат комнаты</strong></div>}
    <div className="chat-scroll" ref={scroll} onScroll={() => { const el = scroll.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; if (stick.current) setNewBelow(false); }}>
      {hasMore && <button className="load-older" disabled={loading} onClick={older}>{loading ? 'Загрузка…' : 'Ранние сообщения'}</button>}
      {!hasMore && <div className="chat-intro"><span className="channel-symbol">{compact ? <MessageCircle size={24} /> : <Hash size={36} />}</span><h2>{compact ? 'Чат комнаты' : `#${channel.name}`}</h2><p>{compact ? 'Сообщения видны всем участникам сервера.' : channel.description}</p><span className="tiny">История хранится, пока вы не решите её удалить.</span></div>}
      {error && <div className="form-error" role="alert">{error} <button className="text-button" onClick={() => void refresh()}>Повторить</button></div>}
      {loading && messages.length === 0 && <p className="muted loading-line">Загружаем сообщения…</p>}
      {messages.map((message, i) => {
        const plain = decoded[message.id]?.payload;
        const body = message.encrypted ? plain ? plain.body : (decoded[message.id]?.error ? 'Не удалось расшифровать. Проверьте ключи или восстановите резервную копию.' : 'Расшифровываем…') : message.body;
        const day = new Date(message.createdAt).toLocaleDateString('ru', { day: 'numeric', month: 'long' });
        const previous = messages[i - 1];
        const sameDay = previous && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
        return <div key={message.id}>{!sameDay && <div className="day-divider"><span>{day}</span></div>}<article className="message">
          <Avatar name={message.user.displayName} userId={message.user.id} /><div className="message-main"><div className="message-meta"><strong>{message.user.displayName}</strong>{message.user.role === 'admin' && <span className="owner-tag">владелец</span>}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time>{message.encrypted ? <small title="Сквозное шифрование">🔒</small> : manager?.state.enabled && <small className="tiny">старая открытая запись</small>}</div>{body && <p className={isEmojiOnly(body) ? 'emoji-only' : undefined}>{renderMessage(body)}</p>}{message.image && <button className="chat-image" type="button" onClick={() => setOpenedImage(message.id)} aria-label="Открыть изображение"><EncryptedImage message={message} payload={plain} /></button>}</div>
          {(user.id === message.user.id || user.role === 'admin') && <button className="delete-message icon-button" title="Удалить сообщение" aria-label="Удалить сообщение" onClick={() => void remove(message.id)}><Trash2 size={14} /></button>}
        </article></div>;
      })}
    </div>
    {newBelow && <button className="new-messages" onClick={() => { stick.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); setNewBelow(false); }}>Новые сообщения <ArrowDown size={14} /></button>}
    {imagePreview && <div className="attachment-preview"><img src={imagePreview} alt="Прикреплённое изображение" /><span>{imageFile?.name}<small>Изображение готово к отправке</small></span><button type="button" className="icon-button" aria-label="Убрать изображение" onClick={() => setImageFile(null)}><X size={16} /></button></div>}
    <form className="composer" onSubmit={send}>{suggestions.length > 0 && <div className="mention-menu" role="listbox" aria-label="Упомянуть участника">{suggestions.map((person, index) => <button type="button" role="option" aria-selected={index === mentionIndex % suggestions.length} key={person.id} onMouseDown={e => e.preventDefault()} onClick={() => chooseMention(person)}><Avatar name={person.displayName} userId={person.id} /><span><strong>{person.displayName}</strong><small>@{person.username}</small></span></button>)}</div>}<textarea ref={input} onPaste={event => { const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/')); if (file) { event.preventDefault(); attachImage(file); } }} aria-label={`Сообщение в ${channel.name}`} value={draft} onChange={e => { setDraft(e.target.value); setCaret(e.target.selectionStart); setMentionClosed(false); setMentionIndex(0); }} onSelect={e => setCaret(e.currentTarget.selectionStart)} placeholder={compact ? 'Написать в комнату…' : `Сообщение в #${channel.name}`} maxLength={4000} rows={1} onKeyDown={e => { if (suggestions.length && !(e.key === 'Enter' && e.shiftKey) && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !e.nativeEvent.isComposing) { e.preventDefault(); if (e.key === 'Escape') setMentionClosed(true); else if (e.key === 'ArrowDown') setMentionIndex(i => (i + 1) % suggestions.length); else if (e.key === 'ArrowUp') setMentionIndex(i => (i + suggestions.length - 1) % suggestions.length); else chooseMention(suggestions[mentionIndex % suggestions.length]); return; } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(e); } }} /><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={event => { attachImage(event.target.files?.[0]); event.target.value = ''; }} /><button type="button" className="attach-button" aria-label="Прикрепить изображение" title="Прикрепить изображение" disabled={busy} onClick={() => fileInput.current?.click()}><ImagePlus size={19} /></button><div className="emoji-wrap" ref={emojiContainer}><button type="button" className={`emoji-toggle ${emojiOpen ? 'active' : ''}`} aria-label="Смайлики" title="Смайлики" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen(open => !open); setMentionClosed(true); }}><Smile size={19} /></button>{emojiOpen && <div className="emoji-panel" role="dialog" aria-label="Выбор смайлика"><div className="emoji-title">Смайлики <span>Выберите настроение</span></div><div className="emoji-tabs" role="tablist" aria-label="Категории смайликов">{emojiGroups.map((group, index) => <button type="button" role="tab" aria-selected={index === emojiGroup} key={group.name} onClick={() => setEmojiGroup(index)}>{group.name}</button>)}</div><div className="emoji-grid">{emojiGroups[emojiGroup].items.map(emoji => <button type="button" key={emoji} title={emoji} aria-label={`Добавить ${emoji}`} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}</div></div>}</div><button type="submit" disabled={busy || (!draft.trim() && !imageFile)} aria-label="Отправить сообщение"><ArrowUp size={20} /></button></form>
    {openedImage !== null && <Modal title="Изображение" onClose={() => setOpenedImage(null)}><div className="image-viewer">{messages.find(m => m.id === openedImage) && <EncryptedImage message={messages.find(m => m.id === openedImage)!} payload={decoded[openedImage]?.payload} />}</div></Modal>}
    {externalUrl && <Modal title="Переход на сторонний сайт" onClose={() => setExternalUrl(null)}><div className="external-link-warning"><p>Вы переходите на сторонний сайт:</p><strong>{new URL(externalUrl).hostname}</strong><span>{externalUrl}</span><div><button className="secondary" onClick={() => setExternalUrl(null)}>Отмена</button><button className="primary" onClick={() => { window.open(externalUrl, '_blank', 'noopener,noreferrer'); setExternalUrl(null); }}>Перейти</button></div></div></Modal>}
    <div className="composer-hint">{draft.length > 3500 ? `${draft.length} / 4000` : 'Enter — отправить · Shift + Enter — новая строка'}</div>
  </section>;
}
