import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Download, RefreshCw } from 'lucide-react';
import { Modal } from './ui';
import { createUpdateManager, type UpdateState } from './pwa-updates';
import type { DesktopUpdateStatus } from './DesktopShare';

interface InstallPrompt extends Event { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }> }
const androidApp = /\bKrugAndroid\/1\b/.test(navigator.userAgent);
let prompt: InstallPrompt | null = null;
let snapshot = { installed: Boolean(window.krugDesktop) || window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone), ready: false };
const listeners = new Set<() => void>();
function update(next: Partial<typeof snapshot>) { snapshot = { ...snapshot, ...next }; listeners.forEach(fn => fn()); }
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event as InstallPrompt; update({ ready: true }); });
window.addEventListener('appinstalled', () => { prompt = null; update({ installed: true, ready: false }); });
const updates = import.meta.env.PROD && 'serviceWorker' in navigator ? createUpdateManager({ serviceWorker: navigator.serviceWorker, page: document, events: window, online: () => navigator.onLine, reload: () => location.reload() }) : undefined;
updates?.start();
export const checkForAppUpdate = () => { void updates?.check(); };
const noUpdate: UpdateState = { available: false, queued: false, applying: false, error: '' };
const noSubscription = () => () => {};
const getNoUpdate = () => noUpdate;
export function InstallApp({ compact = false, authenticated = false }: { compact?: boolean; authenticated?: boolean }) {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  const [help, setHelp] = useState(false);
  async function installPwa() {
    if (!prompt) return;
    const event = prompt; prompt = null;
    try { const result = await event.prompt(); if (result.outcome === 'accepted') update({ installed: true }); }
    catch { setHelp(true); }
    finally { update({ ready: false }); }
  }
  return <>
    {!window.krugDesktop && !androidApp && <button className={compact ? 'install-sidebar' : 'install-auth'} onClick={() => setHelp(true)}><Download size={16} />Установить приложение</button>}
    {help && <Modal title="Установить Округ" onClose={() => setHelp(false)}><div className="install-help"><p>Приложение открывается в отдельном окне. Для звонков и переписки нужен интернет.</p>
      <h3>Windows</h3><p>Установите приложение для компьютера: в нём можно передавать звук выбранной программы вместе с демонстрацией.</p>
      {authenticated ? <a className="primary install-download" href="/api/desktop-installer" download><Download size={16} />Скачать Округ для Windows</a> : <p className="tiny">Войдите в аккаунт, чтобы скачать приложение для Windows.</p>}
      <h3>Android</h3><p>Установите приложение для телефона. Чаты и голосовые комнаты используют тот же аккаунт.</p>
      {authenticated ? <a className="primary install-download" href="/api/android-installer"><Download size={16} />Скачать Округ для Android</a> : <p className="tiny">Войдите в аккаунт, чтобы скачать APK.</p>}
      <h3>Установка через браузер</h3><p>На Windows, Linux и Android откройте этот адрес в Chrome или Edge и выберите «Установить приложение» в меню браузера.</p>
      {state.ready && <button className="secondary install-pwa-button" onClick={() => void installPwa()}><Download size={16} />Установить из браузера</button>}
      <h3>iPhone и iPad</h3><p>Откройте адрес в Safari → «Поделиться» → «На экран Домой».</p>
      <h3>Mac</h3><p>В Safari: «Файл» → «Добавить в Dock». Также можно установить через Chrome.</p>
      <p className="muted">Если вы открыли Округ внутри другого приложения, скопируйте адрес в обычный браузер. Установка через браузер доступна по HTTPS или на localhost.</p>
    </div></Modal>}
  </>;
}
export function AppUpdate({ inCall }: { inCall: boolean }) {
  const state = useSyncExternalStore(updates?.subscribe ?? noSubscription, updates?.getSnapshot ?? getNoUpdate);
  useEffect(() => { updates?.setInCall(inCall); }, [inCall]);
  useEffect(() => () => { updates?.setInCall(false); }, []);
  if (!state.available && !state.error) return null;
  const message = state.error || (state.queued ? 'Обновление установится, когда вы выйдете из комнаты.' : inCall ? 'Доступно обновление. Можно установить его после звонка.' : 'Доступна новая версия Круга.');
  const label = state.applying ? 'Устанавливаем…' : state.queued ? 'Отменить' : inCall ? 'Обновить после звонка' : 'Обновить';
  return <div className="update-banner" role="status"><Check size={15} /><span>{message}</span><button disabled={state.applying} onClick={() => { if (state.queued) updates?.cancel(); else void updates?.request(inCall); }}><RefreshCw size={13} />{label}</button></div>;
}

type NativeState = 'idle' | 'available' | 'downloading' | 'ready' | 'queued' | 'installing' | 'error';
function LegacyUpdate({ kind }: { kind: 'desktop' | 'android' }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let stopped = false;
    const check = () => { void fetch('/api/manual-update-options', { credentials: 'same-origin' }).then(response => response.ok ? response.json() as Promise<Partial<Record<'desktop' | 'android', boolean>>> : {} as Partial<Record<'desktop' | 'android', boolean>>).then(result => { if (!stopped) setAvailable(Boolean(result[kind])); }).catch(() => {}); };
    check(); window.addEventListener('focus', check); const timer = setInterval(check, 60_000);
    return () => { stopped = true; window.removeEventListener('focus', check); clearInterval(timer); };
  }, [kind]);
  if (!available) return null;
  return <div className="update-banner" role="status"><RefreshCw size={15} /><span>Доступна новая версия приложения. Для перехода на обновления по кнопке скачайте её вручную.</span><a href={kind === 'desktop' ? '/api/desktop-installer' : '/api/android-installer'} {...(kind === 'android' ? { target: '_blank', rel: 'noopener noreferrer' } : { download: true })}>Скачать</a></div>;
}
function WindowsUpdate() {
  const [status, setStatus] = useState<DesktopUpdateStatus>({ state: 'idle' });
  const bridge = window.krugDesktop;
  useEffect(() => {
    if (!bridge) return;
    let received = false;
    const unsubscribe = bridge.onUpdate(next => { received = true; setStatus(next); });
    void bridge.getUpdateState().then(next => { if (!received) setStatus(next); }).catch(() => {});
    return unsubscribe;
  }, [bridge]);
  if (!bridge) return null;
  if (!bridge.requestUpdate) return <LegacyUpdate kind="desktop" />;
  if (status.state === 'idle') return null;
  const message = status.state === 'available' || status.state === 'ready' ? 'Доступна новая версия приложения.' : status.state === 'downloading' ? `Загружаем обновление: ${status.percent ?? 0}%` : status.state === 'queued' ? 'Обновление установится после выхода из звонка.' : status.state === 'error' ? 'Не удалось загрузить обновление. Попробуйте ещё раз.' : 'Устанавливаем обновление приложения…';
  return <div className="update-banner" role="status"><RefreshCw size={15} /><span>{message}</span>{['available', 'ready', 'queued', 'error'].includes(status.state) && <button onClick={() => { const operation = status.state === 'queued' ? bridge.cancelUpdate?.() : bridge.requestUpdate?.(); void operation?.catch(() => setStatus({ state: 'error' })); }}>{status.state === 'queued' ? 'Отменить' : status.state === 'error' ? 'Повторить' : 'Обновить'}</button>}</div>;
}
function AndroidUpdate() {
  const bridge = window.KrugAndroidNative;
  const [state, setState] = useState<NativeState>('idle');
  useEffect(() => {
    if (!bridge?.getUpdateState) return;
    const known = ['idle', 'available', 'downloading', 'ready', 'queued', 'installing', 'error'];
    const update = (value: unknown) => { if (typeof value === 'string' && known.includes(value)) setState(value as NativeState); };
    const handler = (event: Event) => update((event as CustomEvent).detail);
    window.addEventListener('krug-android-update', handler); update(bridge.getUpdateState());
    return () => window.removeEventListener('krug-android-update', handler);
  }, [bridge]);
  if (!bridge) return null;
  if (!bridge.requestUpdate) return <LegacyUpdate kind="android" />;
  if (state === 'idle') return null;
  const message = state === 'available' || state === 'ready' ? 'Доступна новая версия приложения.' : state === 'downloading' ? 'Загружаем обновление приложения…' : state === 'queued' ? 'Обновление установится после выхода из звонка.' : state === 'error' ? 'Не удалось загрузить обновление. Попробуйте ещё раз.' : 'Открываем установку приложения…';
  return <div className="update-banner" role="status"><RefreshCw size={15} /><span>{message}</span>{['available', 'ready', 'queued', 'error'].includes(state) && <button onClick={() => { if (state === 'queued') bridge.cancelUpdate?.(); else bridge.requestUpdate?.(); }}>{state === 'queued' ? 'Отменить' : state === 'error' ? 'Повторить' : 'Обновить'}</button>}</div>;
}
export function DesktopUpdate() { return <><WindowsUpdate /><AndroidUpdate /></>; }
