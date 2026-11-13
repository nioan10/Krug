import { useState, type FormEvent } from 'react';
import { ArrowUpRight, AudioLines, LockKeyhole, Monitor, Radio } from 'lucide-react';
import { api, errorText, type User } from './api';
import { Logo } from './ui';
import { InstallApp } from './Pwa';

export function Auth({ onLogin }: { onLogin: (user: User) => void }) {
  const [invite, setInvite] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
    if (value) history.replaceState(null, '', location.pathname);
    return value;
  });
  const [register, setRegister] = useState(Boolean(invite));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const { user } = await api<{ user: User }>(register ? '/auth/register' : '/auth/login', 'POST', { ...data, invite });
      onLogin(user);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <div className="auth-page">
    <div className="auth-story"><Logo /><span className="eyebrow auth-eyebrow"><span className="live-dot" /> ГОЛОСОВОЙ ЧАТ</span>
      <h1>Голос.<br />Чат.<br /><em>Экран.</em></h1>
      <p className="auth-description">Комнаты для звонков и переписки.<br />На вашем сервере.</p>
      <div className="orbit-art" aria-hidden="true"><div className="orbit o1" /><div className="orbit o2" /><div className="orbit-core"><AudioLines size={52} strokeWidth={1.4} /></div><span className="orbit-node n1"><Monitor /></span><span className="orbit-node n2"><Radio /></span><span className="orbit-tiny" /></div>
      <footer>Круг · 0.1.0</footer>
    </div>
    <section className="auth-form-side"><div className="auth-top"><LockKeyhole size={15} /> Частное пространство</div>
      <div className="auth-form-wrap"><h2>{register ? 'Регистрация' : 'Вход'}</h2><p className="muted">{register ? 'Нужен действующий код приглашения.' : 'Введите логин и пароль.'}</p>
        <form onSubmit={submit} className="form-stack">
          {register && <label>Как вас называть<input name="displayName" placeholder="Ваше имя" maxLength={32} required autoComplete="nickname" /></label>}
          <label>Логин<input name="username" placeholder="your_name" pattern="[a-zA-Z0-9_]{3,24}" minLength={3} maxLength={24} required autoComplete="username" spellCheck={false} /><small>3–24 символа: латиница, цифры и _</small></label>
          <label>Пароль<input name="password" type="password" placeholder="Не менее 12 символов" minLength={12} maxLength={128} required autoComplete={register ? 'new-password' : 'current-password'} /></label>
          {register && <label>Код приглашения<input value={invite} onChange={e => setInvite(e.target.value)} placeholder="Из ссылки от владельца" minLength={32} maxLength={128} required autoComplete="off" /></label>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary auth-submit" disabled={busy}>{busy ? 'Секунду…' : register ? 'Присоединиться' : 'Войти в Круг'}<ArrowUpRight size={19} /></button>
        </form>
        <p className="auth-switch">{register ? 'Уже есть аккаунт?' : 'Вы здесь впервые?'} <button className="text-button" onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Войти' : 'У меня приглашение'}</button></p>
        <div className="privacy-note"><LockKeyhole size={17} /><span>Регистрация по приглашению от владельца сервера.</span></div>
        <InstallApp />
      </div><span className="auth-bottom">КРУГ · 0.1.0</span>
    </section>
  </div>;
}
