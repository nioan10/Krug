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

export function DesktopUpdate() {
  const [status, setStatus] = useState<DesktopUpdateStatus>({ state: 'idle' });
  useEffect(() => {
    const bridge = window.krugDesktop;
    if (!bridge) return;
    let received = false;
    const unsubscribe = bridge.onUpdate(next => { received = true; setStatus(next); });
    void bridge.getUpdateState().then(next => { if (!received) setStatus(next); }).catch(() => {});
    return unsubscribe;
  }, []);
  if (status.state === 'idle') return null;
  const message = status.state === 'downloading' ? `Загружаем обновление приложения: ${status.percent ?? 0}%` : status.state === 'queued' ? 'Обновление приложения установится после выхода из звонка.' : status.state === 'error' ? 'Не удалось загрузить обновление приложения. Повторим попытку позже.' : 'Устанавливаем обновление приложения…';
  return <div className="update-banner" role="status"><RefreshCw size={15} /><span>{message}</span></div>;
}
