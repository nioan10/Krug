import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Hash, MessageCircle, Smile, Trash2 } from 'lucide-react';
import { api, errorText, type Channel, type Message, type User } from './api';
import { subscribe, type ServerEvent } from './events';
import { Avatar } from './ui';

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
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
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
  useEffect(() => { let live = true; void api<{ users: User[] }>('/users').then(result => { if (live) setPeople(result.users); }).catch(() => {}); return () => { live = false; }; }, []);
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
      if (event.type === 'ready') { void refresh(); return; }
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
    event.preventDefault(); const body = draft.trim(); if (!body || busy) return;
    setBusy(true);
    try {
      const result = await api<{ message: Message }>(`/channels/${channel.id}/messages`, 'POST', { body });
      stick.current = true;
      setMessages(old => applyEvent(old, { type: 'message', message: result.message }, channel.id));
      setDraft('');
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
        const day = new Date(message.createdAt).toLocaleDateString('ru', { day: 'numeric', month: 'long' });
        const previous = messages[i - 1];
        const sameDay = previous && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString();
        return <div key={message.id}>{!sameDay && <div className="day-divider"><span>{day}</span></div>}<article className="message">
          <Avatar name={message.user.displayName} /><div className="message-main"><div className="message-meta"><strong>{message.user.displayName}</strong>{message.user.role === 'admin' && <span className="owner-tag">владелец</span>}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.body.split(/((?:^|[^\p{L}\p{N}_@])@[a-z0-9_]{3,24}(?![a-z0-9_]))/giu).map((part, index) => { const match = part.match(/^([^@]*)@([a-z0-9_]+)$/i); return match && people.some(person => person.username === match[2].toLowerCase()) ? <span key={index}>{match[1]}<span className={`message-mention ${match[2].toLowerCase() === user.username ? 'own-mention' : ''}`}>@{match[2]}</span></span> : part; })}</p></div>
          {(user.id === message.user.id || user.role === 'admin') && <button className="delete-message icon-button" title="Удалить сообщение" aria-label="Удалить сообщение" onClick={() => void remove(message.id)}><Trash2 size={14} /></button>}
        </article></div>;
      })}
    </div>
    {newBelow && <button className="new-messages" onClick={() => { stick.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); setNewBelow(false); }}>Новые сообщения <ArrowDown size={14} /></button>}
    <form className="composer" onSubmit={send}>{suggestions.length > 0 && <div className="mention-menu" role="listbox" aria-label="Упомянуть участника">{suggestions.map((person, index) => <button type="button" role="option" aria-selected={index === mentionIndex % suggestions.length} key={person.id} onMouseDown={e => e.preventDefault()} onClick={() => chooseMention(person)}><Avatar name={person.displayName} /><span><strong>{person.displayName}</strong><small>@{person.username}</small></span></button>)}</div>}<textarea ref={input} aria-label={`Сообщение в ${channel.name}`} value={draft} onChange={e => { setDraft(e.target.value); setCaret(e.target.selectionStart); setMentionClosed(false); setMentionIndex(0); }} onSelect={e => setCaret(e.currentTarget.selectionStart)} placeholder={compact ? 'Написать в комнату…' : `Сообщение в #${channel.name}`} maxLength={4000} rows={1} onKeyDown={e => { if (suggestions.length && !(e.key === 'Enter' && e.shiftKey) && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !e.nativeEvent.isComposing) { e.preventDefault(); if (e.key === 'Escape') setMentionClosed(true); else if (e.key === 'ArrowDown') setMentionIndex(i => (i + 1) % suggestions.length); else if (e.key === 'ArrowUp') setMentionIndex(i => (i + suggestions.length - 1) % suggestions.length); else chooseMention(suggestions[mentionIndex % suggestions.length]); return; } if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(e); } }} /><div className="emoji-wrap" ref={emojiContainer}><button type="button" className={`emoji-toggle ${emojiOpen ? 'active' : ''}`} aria-label="Смайлики" title="Смайлики" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen(open => !open); setMentionClosed(true); }}><Smile size={19} /></button>{emojiOpen && <div className="emoji-panel" role="dialog" aria-label="Выбор смайлика"><div className="emoji-title">Смайлики <span>Выберите настроение</span></div><div className="emoji-tabs" role="tablist" aria-label="Категории смайликов">{emojiGroups.map((group, index) => <button type="button" role="tab" aria-selected={index === emojiGroup} key={group.name} onClick={() => setEmojiGroup(index)}>{group.name}</button>)}</div><div className="emoji-grid">{emojiGroups[emojiGroup].items.map(emoji => <button type="button" key={emoji} title={emoji} aria-label={`Добавить ${emoji}`} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}</div></div>}</div><button type="submit" disabled={busy || !draft.trim()} aria-label="Отправить сообщение"><ArrowUp size={20} /></button></form>
    <div className="composer-hint">{draft.length > 3500 ? `${draft.length} / 4000` : 'Enter — отправить · Shift + Enter — новая строка'}</div>
  </section>;
}
