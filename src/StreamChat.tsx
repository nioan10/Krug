import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Send, ShieldBan, Trash2, MessageSquare } from 'lucide-react';
import { streamApi, type StreamInfo, type StreamSnapshot } from './stream-api';
import { api, errorText } from './api';

export function StreamChat({ origin, id, moderator = false, onStream, onReady }: { origin: string; id: string; moderator?: boolean; onStream?: (stream: StreamInfo) => void; onReady?: (ready: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<StreamSnapshot>();
  const [connected, setConnected] = useState(false), [error, setError] = useState(''), [text, setText] = useState(''), [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null); const nearBottom = useRef(true); const onStreamRef = useRef(onStream); onStreamRef.current = onStream;
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  useEffect(() => {
    let stopped = false, socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout>, failures = 0;
    const receive = (data: StreamSnapshot) => { setSnapshot(data); onStreamRef.current?.(data.stream); };
    async function connect() {
      try {
        const data = await streamApi<StreamSnapshot>(origin, id, '/guest'); if (stopped) return;
        receive(data); onReadyRef.current?.(true);
        socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/streams/${id}/events`);
        socket.onopen = () => { failures = 0; setConnected(true); setError(''); };
        socket.onmessage = event => { try { const next = JSON.parse(event.data); if (next.type === 'snapshot') receive(next); } catch {} };
        socket.onclose = event => {
          if (stopped) return; setConnected(false);
          if (event.code === 1008) { setError('Закройте лишние вкладки эфира и обновите страницу.'); return; }
          timer = setTimeout(() => void connect(), Math.min(15_000, 1000 * 2 ** failures++));
        };
      } catch (e) { if (!stopped) { setError(errorText(e)); timer = setTimeout(() => void connect(), 5000); } }
    }
    void connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, [origin, id]);
  useEffect(() => { if (nearBottom.current) bottom.current?.scrollIntoView({ block: 'nearest' }); }, [snapshot?.messages]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!text.trim() || sending) return;
    setSending(true); setError('');
    try { await streamApi(origin, id, '/messages', { body: text.trim() }); setText(''); nearBottom.current = true; }
    catch (e) { setError(errorText(e)); } finally { setSending(false); }
  }
  async function moderate(path: string, method: string, body?: unknown) {
    try { await api(`/broadcasts/${id}${path}`, method, body); setError(''); } catch (e) { setError(errorText(e)); }
  }
  const writable = connected && snapshot?.stream.state === 'live' && !snapshot.guest.banned;
  return <section className="stream-chat" aria-label="Анонимный чат эфира">
    <div className="stream-chat-head"><MessageSquare size={18} /><h2>Чат эфира</h2><span className={connected ? 'online-dot' : 'offline-dot'} title={connected ? 'Чат подключён' : 'Подключение к чату'} /></div>
    <div className="stream-chat-identity">{snapshot ? <>Вы — <strong>{snapshot.guest.label}</strong></> : 'Выдаём анонимный ID…'}<small>Ник из Округа здесь не виден</small></div>
    <div className="stream-chat-messages" role="log" aria-live="polite" onScroll={event => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      {snapshot && !snapshot.messages.length && <p className="stream-chat-empty">Пока тихо. Напишите первым.</p>}
      {snapshot?.messages.map(message => <article className="stream-message" key={message.id}><div className="stream-message-meta"><strong className={message.authorId === snapshot.guest.id ? 'is-me' : ''}>{message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</time>{moderator && <span className="stream-mod-actions"><button className="icon-button" aria-label={`Удалить сообщение ${message.id}`} title="Удалить сообщение" onClick={() => void moderate(`/messages/${message.id}`, 'DELETE')}><Trash2 size={13} /></button><button className="icon-button" aria-label={`Запретить писать ${message.author}`} title="Запретить писать в этом эфире" onClick={() => void moderate('/ban', 'POST', { guestId: message.authorId })}><ShieldBan size={13} /></button></span>}</div><p>{message.body}</p></article>)}
      <div ref={bottom} />
    </div>
    <form className="stream-chat-form" onSubmit={send}>
      {error && <p className="stream-error" role="alert">{error}</p>}
      <div><input aria-label="Сообщение в эфир" placeholder={snapshot?.guest.banned ? 'Отправка сообщений ограничена' : snapshot?.stream.state === 'ended' ? 'Эфир завершён' : 'Написать анонимно…'} value={text} onChange={e => setText(e.target.value)} maxLength={1000} disabled={!writable} /><button className="primary" type="submit" aria-label="Отправить сообщение" disabled={!writable || !text.trim() || sending}><Send size={18} /></button></div>
    </form>
  </section>;
}
