import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Download, RefreshCw } from 'lucide-react';
import { Modal } from './ui';
import { createUpdateManager, type UpdateState } from './pwa-updates';

interface InstallPrompt extends Event { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }> }
let prompt: InstallPrompt | null = null;
let snapshot = { installed: window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone), ready: false };
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
export function InstallApp({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  const [help, setHelp] = useState(false);
  async function install() {
    if (!prompt) { setHelp(true); return; }
    const event = prompt; prompt = null;
    try { const result = await event.prompt(); if (result.outcome === 'accepted') update({ installed: true }); }
    catch { setHelp(true); }
    finally { update({ ready: false }); }
  }
  return <>
    {!state.installed && <button className={compact ? 'install-sidebar' : 'install-auth'} onClick={() => void install()}><Download size={16} />Установить приложение</button>}
    {help && <Modal title="Установить Круг" onClose={() => setHelp(false)}><div className="install-help"><p>Приложение открывается в отдельном окне. Для звонков и переписки нужен интернет.</p>
      <h3>Windows, Linux, Android</h3><p>Откройте этот адрес в Chrome или Edge. Нажмите значок установки в адресной строке или выберите «Установить приложение» в меню браузера.</p>
      <h3>iPhone и iPad</h3><p>Откройте адрес в Safari → «Поделиться» → «На экран Домой».</p>
      <h3>Mac</h3><p>В Safari: «Файл» → «Добавить в Dock». Также можно установить через Chrome.</p>
      <p className="muted">Если вы открыли Круг внутри другого приложения, скопируйте адрес в обычный браузер. Установка доступна по HTTPS или на localhost.</p>
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
