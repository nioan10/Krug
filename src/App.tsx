import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, AudioLines, ChevronDown, Hash, Headphones, LockKeyhole, LogOut, Menu, MessageSquare, Mic, MonitorUp, PhoneOff, Plus, Radio, Settings2, ShieldCheck, Signal, UserPlus, Users, Volume2, X } from 'lucide-react';
import { api, errorText, HttpError, type Channel, type User } from './api';
import { emit, type ServerEvent } from './events';
import { Auth } from './Auth';
import { InstallApp, AppUpdate } from './Pwa';
import { Chat } from './Chat';
import { Voice, type Call } from './Voice';
import { Avatar, Logo } from './ui';
import { CreateChannel, InviteModal, Settings } from './Settings';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState('lounge');
  const [online, setOnline] = useState<User[]>([]);
  const [connected, setConnected] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [joining, setJoining] = useState(false);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<'invite' | 'channel' | 'settings' | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const notify = useCallback((message: string) => setToast(message), []);
  const leave = useCallback(() => setCall(null), []);
  const signedOut = useCallback(() => { setUser(null); setCall(null); setModal(null); setChannels([]); setOnline([]); }, []);
  async function boot() {
    setBooting(true); setBootError('');
    try { setUser((await api<{ user: User }>('/me')).user); }
    catch (e) { if (!(e instanceof HttpError && e.status === 401)) setBootError('Сервер пока не отвечает. Проверьте, запущено ли приложение.'); }
    finally { setBooting(false); }
  }
  useEffect(() => { void boot(); }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 7000); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (!user) return;
    let stopped = false; let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout>; let attempts = 0;
    async function loadChannels() {
      try { const result = await api<{ channels: Channel[] }>('/channels'); if (!stopped) setChannels(result.channels); }
      catch (e) { if (!stopped) notify(errorText(e)); }
    }
    void loadChannels();
    function connect() {
      if (stopped) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events`);
      socket.onopen = () => { attempts = 0; setConnected(true); };
      socket.onmessage = event => {
        const data = JSON.parse(event.data) as ServerEvent;
        if (data.type === 'presence') setOnline(data.users);
        if (data.type === 'channels') setChannels(data.channels);
        if (data.type === 'ready') void loadChannels();
        emit(data);
      };
      socket.onclose = event => {
        if (stopped) return;
        setConnected(false); setOnline([]);
        if (event.code === 1008) {
          if (['Session expired', 'Logged out', 'Password changed'].includes(event.reason)) { signedOut(); notify('Сессия завершилась. Войдите снова.'); }
          else notify('Слишком много открытых вкладок. Закройте лишние и обновите страницу.');
          return;
        }
        void api('/me').catch(e => { if (!stopped && e instanceof HttpError && e.status === 401) signedOut(); });
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++) + Math.random() * 500);
      };
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); setConnected(false); };
  }, [user?.id, notify, signedOut]);
  async function logout() { try { await api('/auth/logout', 'POST'); signedOut(); } catch (e) { notify(errorText(e)); } }
  async function join(channel: Channel) {
    if (joining) return;
    setJoining(true);
    try { const result = await api<{ token: string; url: string }>(`/channels/${channel.id}/voice-token`, 'POST'); setCall({ channel, ...result }); }
    catch (e) { notify(errorText(e)); } finally { setJoining(false); }
  }
  const current = channels.find(c => c.id === selected) || channels[0];
  const toastView = toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="Закрыть уведомление" onClick={() => setToast('')}><X size={16} /></button></div>;
  if (booting) return <div className="loading-page"><Logo /><span>Загрузка…</span></div>;
  if (bootError) return <div className="loading-page"><Logo /><p>{bootError}</p><button className="primary" onClick={() => void boot()}>Попробовать снова</button></div>;
  if (!user) return <><Auth onLogin={setUser} />{toastView}</>;
  return <div className="app-shell">
    {mobileNav && <button className="nav-scrim" aria-label="Закрыть меню" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}><div className="sidebar-brand"><Logo /><span className="version">BETA</span></div>
      <div className="server-label"><div className="server-icon"><AudioLines size={23} /></div><div><strong>Наш круг</strong><span>Частный сервер</span></div><ChevronDown size={16} /></div>
      <div className="sidebar-scroll"><div className="channel-section-label">ОБЩЕНИЕ{user.role === 'admin' && <button title="Создать канал" aria-label="Создать канал" onClick={() => setModal('channel')}><Plus size={15} /></button>}</div>
        <nav aria-label="Текстовые каналы">{channels.filter(c => c.kind === 'text').map(c => <button key={c.id} className={`channel-link ${current?.id === c.id ? 'selected' : ''}`} onClick={() => { setSelected(c.id); setMobileNav(false); }}><Hash size={19} /><span>{c.name}</span></button>)}</nav>
        <div className="channel-section-label voice-label">ГОЛОСОВЫЕ КОМНАТЫ<span>{channels.filter(c => c.kind === 'voice').length.toString().padStart(2, '0')}</span></div>
        <nav aria-label="Голосовые комнаты">{channels.filter(c => c.kind === 'voice').map(c => <button key={c.id} className={`channel-link voice-link ${current?.id === c.id ? 'selected' : ''}`} onClick={() => { setSelected(c.id); setMobileNav(false); }}><Volume2 size={19} /><span>{c.name}</span>{call?.channel.id === c.id && <span className="live-dot" />}</button>)}</nav>

      </div>
      <InstallApp compact />
      {user.role === 'admin' && <button className="invite-button" onClick={() => setModal('invite')}><UserPlus size={17} />Пригласить друзей<ArrowUpRight size={15} /></button>}
      {call && <div className="voice-dock"><button onClick={() => setSelected(call.channel.id)}><Signal size={17} /><span>В голосовой комнате<small>{call.channel.name}</small></span></button><button aria-label="Отключиться от звонка" title="Отключиться" onClick={leave}><PhoneOff size={18} /></button></div>}
      <div className="profile"><Avatar name={user.displayName} /><div className="profile-name"><strong>{user.displayName}</strong><span><i className={connected ? 'online-dot' : 'offline-dot'} />{connected ? 'На связи' : 'Переподключение…'}</span></div><button className="icon-button" title="Настройки" aria-label="Настройки" onClick={() => setModal('settings')}><Settings2 size={18} /></button><button className="icon-button" title="Выйти из аккаунта" aria-label="Выйти из аккаунта" onClick={() => void logout()}><LogOut size={17} /></button></div>
    </aside>
    <main className="main-app">
      <header className="topbar"><button className="mobile-menu icon-button" aria-label="Открыть меню" onClick={() => setMobileNav(true)}><Menu size={22} /></button><span className="header-channel-icon">{current?.kind === 'voice' ? <Volume2 size={22} /> : <Hash size={22} />}</span><h1>{current?.name || 'Ваши каналы'}</h1><span className="header-divider" /><p>{current?.description}</p><div className="header-actions"><span className="private-badge"><LockKeyhole size={13} />По приглашению</span>{current?.kind === 'voice' && <button className={`icon-button ${showChat ? 'active' : ''}`} title="Чат комнаты" aria-label="Показать или скрыть чат" aria-pressed={showChat} onClick={() => setShowChat(!showChat)}><MessageSquare size={19} /></button>}</div></header>
      <AppUpdate inCall={Boolean(call)} />
      {!connected && <div className="reconnect-banner">Восстанавливаем связь с чатом. Новые сообщения появятся после подключения.</div>}
      {current ? <div className={`workspace ${current.kind === 'text' ? 'text-workspace' : ''}`}>
        <div className="center-pane">
          {call && <div className="voice-container" hidden={current.id !== call.channel.id}><Voice key={call.channel.id + call.token} call={call} onLeave={leave} notify={notify} /></div>}
          {current.kind === 'voice' && current.id !== call?.channel.id && <div className="voice-welcome"><div className="welcome-top"><span className="eyebrow"><span className="live-dot muted-dot" /> ГОЛОСОВАЯ КОМНАТА</span><span className="room-number">КОМНАТА / {String(channels.filter(c => c.kind === 'voice').findIndex(c => c.id === current.id) + 1).padStart(2, '0')}</span></div><div className="welcome-body"><div className="room-art" aria-hidden="true"><div className="room-ring r1" /><div className="room-ring r2" /><div className="room-ring r3" /><div className="room-art-center"><Headphones size={52} strokeWidth={1.5} /></div><span className="sound-bar b1" /><span className="sound-bar b2" /><span className="sound-bar b3" /></div><h2>{current.name}</h2><p>{current.description}</p><button className="primary join-button" disabled={joining} onClick={() => void join(current)}><Mic size={19} />{joining ? 'Подключаем…' : call ? 'Перейти в эту комнату' : 'Войти в комнату'}<ArrowUpRight size={18} /></button><span className="join-hint">Микрофон и камера выключены при входе</span></div><div className="room-features"><span><AudioLines size={17} />Голос</span><span><MonitorUp size={17} />Демонстрация экрана</span><span><ShieldCheck size={17} />По приглашению</span></div></div>}
          {current.kind === 'text' && <Chat key={current.id} channel={current} user={user} notify={notify} />}
        </div>
        {current.kind === 'voice' && showChat && <Chat key={current.id} channel={current} user={user} compact notify={notify} />}
        {current.kind === 'text' && <aside className="members"><div className="members-heading"><Users size={16} />НА СВЯЗИ <span>{online.length}</span></div>{online.map(person => <div className="member" key={person.id}><Avatar name={person.displayName} /><div><strong>{person.displayName}{person.id === user.id && <small>вы</small>}</strong><span>{person.role === 'admin' ? 'Владелец' : 'Участник'}</span></div><i className="online-dot" /></div>)}</aside>}
      </div> : <div className="loading-page"><p>Загружаем каналы…</p><button className="secondary" onClick={() => location.reload()}>Обновить</button></div>}
    </main>
    {modal === 'invite' && <InviteModal onClose={() => setModal(null)} notify={notify} />}
    {modal === 'channel' && <CreateChannel onClose={() => setModal(null)} notify={notify} onCreated={channel => { setChannels(old => [...old.filter(c => c.id !== channel.id), channel]); setSelected(channel.id); }} />}
    {modal === 'settings' && current && <Settings user={user} channel={current} onClose={() => setModal(null)} notify={notify} onLogout={signedOut} />}
    {toastView}
  </div>;
}
